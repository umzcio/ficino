"""Preference aggregation — compute learned weights from user likes.

Phase 2 of Like as Training Signal. Queries user_likes, computes
per-persona hit rate, per-post-type affinity, and per-category weighting.
Annotated likes are weighted higher. Stores result in user_settings.preferences.
"""

import json
from collections import defaultdict

import structlog

from celery_app import app
from lib.db import fetch, execute
from lib.settings import STUB_USER_ID

logger = structlog.get_logger(__name__)

# Minimum likes before preferences kick in — below this we don't have enough signal
MIN_LIKES_THRESHOLD = 5

# How much extra weight an annotated like gets (like + annotation = stronger signal)
ANNOTATION_BOOST = 2.0

# Blend ratio: how much learned preferences influence vs manual settings
# 0.0 = only manual, 1.0 = only learned. 0.4 means 40% learned, 60% manual.
PREFERENCE_BLEND = 0.4


@app.task(name="tasks.preference_tasks.compute_preferences")
def compute_preferences(user_id: str | None = None) -> dict:
    """Compute preference profile from user likes data.

    Produces:
      - persona_weights: {persona_key: float} — relative preference per persona
      - post_type_weights: {post_type: float} — relative preference per post type
      - category_weights: {category: float} — relative preference per category
      - liked_paper_titles: [str] — paper titles from liked posts (for retrieval boost)
      - total_likes: int
      - has_signal: bool — whether we have enough data to influence generation
    """
    uid = user_id or STUB_USER_ID
    log = logger.bind(user_id=uid)

    # Get all likes with their metadata
    likes = fetch(
        """SELECT ul.feed_id, ul.post_index, ul.persona_key, ul.post_type, ul.category, ul.liked_at
           FROM user_likes ul
           WHERE ul.user_id = $1""",
        uid,
    )

    total = len(likes)
    if total < MIN_LIKES_THRESHOLD:
        preferences = {
            "persona_weights": {},
            "post_type_weights": {},
            "category_weights": {},
            "liked_paper_titles": [],
            "total_likes": total,
            "has_signal": False,
        }
        _store_preferences(uid, preferences)
        log.info("preferences_computed", total_likes=total, has_signal=False)
        return preferences

    # Check which liked posts also have annotations (stronger signal)
    annotated = set()
    if likes:
        annotation_rows = fetch(
            """SELECT DISTINCT feed_id, post_index FROM annotations
               WHERE user_id = $1""",
            uid,
        )
        for row in annotation_rows:
            annotated.add((str(row["feed_id"]), row["post_index"]))

    # Count weighted occurrences
    persona_counts: dict[str, float] = defaultdict(float)
    type_counts: dict[str, float] = defaultdict(float)
    category_counts: dict[str, float] = defaultdict(float)
    total_weight = 0.0

    for like in likes:
        weight = 1.0
        if (str(like["feed_id"]), like["post_index"]) in annotated:
            weight = ANNOTATION_BOOST

        if like["persona_key"]:
            persona_counts[like["persona_key"]] += weight
        if like["post_type"]:
            type_counts[like["post_type"]] += weight
        if like["category"]:
            category_counts[like["category"]] += weight
        total_weight += weight

    # Normalize to relative weights (sum to 1.0)
    persona_weights = _normalize(persona_counts)
    post_type_weights = _normalize(type_counts)
    category_weights = _normalize(category_counts)

    # Extract paper titles from liked posts' sources for retrieval boost
    liked_paper_titles = _get_liked_paper_titles(uid)

    preferences = {
        "persona_weights": persona_weights,
        "post_type_weights": post_type_weights,
        "category_weights": category_weights,
        "liked_paper_titles": liked_paper_titles,
        "total_likes": total,
        "has_signal": True,
    }

    _store_preferences(uid, preferences)
    log.info("preferences_computed",
             total_likes=total,
             personas=persona_weights,
             types=post_type_weights,
             categories=category_weights,
             liked_papers=len(liked_paper_titles))

    return preferences


def _normalize(counts: dict[str, float]) -> dict[str, float]:
    """Normalize counts to weights summing to 1.0."""
    total = sum(counts.values())
    if total == 0:
        return {}
    return {k: round(v / total, 4) for k, v in counts.items()}


def _get_liked_paper_titles(user_id: str) -> list[str]:
    """Extract unique paper titles from the source chunks of liked posts."""
    # Single query — extract paper_ref and every sources[*].paper_title
    # for each liked post directly in SQL, bypassing the per-feed
    # fetchrow + full posts JSONB pull loop. For 30 liked posts across
    # ~20 feeds the old path did 20 round-trips and hauled ~600KB of
    # JSONB just to read two fields per post (Round 9 #19).
    rows = fetch(
        """WITH liked_posts AS (
             SELECT f.posts->ul.post_index AS post
             FROM user_likes ul
             JOIN feeds f ON f.id = ul.feed_id
             WHERE ul.user_id = $1
               AND ul.post_index >= 0
               AND ul.post_index < jsonb_array_length(f.posts)
           )
           SELECT post->>'paper_ref' AS ref,
                  src->>'paper_title' AS title
           FROM liked_posts
           LEFT JOIN LATERAL jsonb_array_elements(
             COALESCE(post->'sources', '[]'::jsonb)
           ) AS src ON true""",
        user_id,
    )
    paper_titles: set[str] = set()
    for row in rows:
        if row["ref"]:
            paper_titles.add(row["ref"])
        if row["title"]:
            paper_titles.add(row["title"])

    return list(paper_titles)


def _store_preferences(user_id: str, preferences: dict) -> None:
    """Store computed preferences in user_settings JSONB.

    Uses `jsonb_set` to write only the `preferences` key rather than
    read-modify-write on the whole settings blob. A concurrent PUT /settings
    from the API would otherwise clobber the preferences this task just wrote,
    or vice versa (the router's last-read theme/persona toggle would be lost
    when this task commits).
    """
    prefs_json = json.dumps(preferences)

    # First INSERT so the row exists (NO-OP if it already does), then
    # atomically merge the preferences key. We can't do this in a single
    # statement because jsonb_set on INSERT requires a base document.
    execute(
        """INSERT INTO user_settings (user_id, settings, updated_at)
           VALUES ($1, jsonb_build_object('preferences', $2::jsonb), NOW())
           ON CONFLICT (user_id) DO UPDATE
             SET settings = jsonb_set(
                   COALESCE(user_settings.settings, '{}'::jsonb),
                   ARRAY['preferences'],
                   $2::jsonb,
                   true
                 ),
                 updated_at = NOW()""",
        user_id, prefs_json,
    )

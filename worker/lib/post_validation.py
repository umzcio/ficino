"""Shape validation for generated feed posts before they hit the DB.

The LLM output is coerced through `_parse_post_json` in claude_client, which
is lenient by design — it falls back to wrapping raw text when the JSON is
malformed. That's fine for resilience, but it means a dict missing required
fields (persona, content) could slip through into `feeds.posts` JSONB and
surface later as a rendering error in the frontend.

This helper does a minimal *soft* validation: log warn + repair defaults if a
required field is missing, rather than raise (which would drop the post and
leave a gap). Mirrors the Literal contract at `api/models/feed.py` but in a
container-local fashion (worker doesn't import from api/).
"""
from __future__ import annotations

import structlog

logger = structlog.get_logger(__name__)

VALID_POST_TYPES = {"post", "thread", "quote", "reply", "figure"}
REQUIRED_FIELDS = ("persona", "post_type", "content")

# Upper bound on post content length — the frontend renders single posts at
# 280-500 chars and thread items at ~280 chars each. Anything past 2000 is
# almost certainly the model dumping reasoning or blockquoting a whole chunk;
# trim it here so feeds.posts (JSONB) and feed_posts (search index) agree.
# The old _write_feed_posts_index silently capped at 10000 which let the
# two sources drift for outliers.
MAX_CONTENT_CHARS = 2000


def validate_post_shape(post_data: dict, *, persona_key: str) -> dict:
    """Ensure post_data has the minimum fields to render and a valid post_type.

    Mutates + returns the same dict. Missing required fields get a placeholder +
    warn log so the operator sees the drift. An invalid post_type is coerced
    to "post".
    """
    # Required fields. `persona` and `post_type` default to sensible values;
    # `content` is load-bearing — without it the post is nothing but a
    # placeholder, which has no place in a research feed. Missing content
    # now raises so the caller drops the slot instead of persisting an
    # apology string that looks like a broken product.
    for field in REQUIRED_FIELDS:
        if not post_data.get(field):
            logger.warn(
                "post_shape_missing_required_field",
                persona=persona_key,
                field=field,
                have=list(post_data.keys()),
            )
            if field == "persona":
                post_data["persona"] = persona_key
            elif field == "post_type":
                post_data["post_type"] = "post"
            elif field == "content":
                raise ValueError("persona_post_missing_content")

    # post_type must match the frontend's Literal union
    pt = post_data.get("post_type")
    if pt not in VALID_POST_TYPES:
        logger.warn(
            "post_shape_invalid_post_type",
            persona=persona_key,
            invalid_post_type=pt,
        )
        post_data["post_type"] = "post"
        pt = "post"

    # MED-18: thread-specific shape check. If the LLM claims post_type="thread"
    # but didn't emit a non-empty list of string thread_posts, the frontend
    # would render an empty thread card. Safer to coerce back to "post" and
    # drop the thread-specific fields so the single `content` field renders
    # normally.
    if pt == "thread":
        thread_posts = post_data.get("thread_posts")
        valid_thread = (
            isinstance(thread_posts, list)
            and len(thread_posts) > 0
            and all(isinstance(tp, str) and tp.strip() for tp in thread_posts)
        )
        if not valid_thread:
            logger.warn(
                "post_shape_invalid_thread_posts",
                persona=persona_key,
                thread_posts_type=type(thread_posts).__name__,
                thread_posts_len=len(thread_posts) if isinstance(thread_posts, list) else None,
            )
            post_data["post_type"] = "post"
            post_data.pop("thread_posts", None)
            post_data.pop("thread_count", None)

    # MED-23: trim over-long content so feeds.posts JSONB and the feed_posts
    # search index can't disagree on what text belongs to the post. The
    # downstream _write_feed_posts_index used to cap at 10000 independently,
    # which meant a 5000-char LLM dump was stored in full in feeds.posts but
    # only the first 10000 (effectively full) made it to the search index —
    # search queries and feed reads diverged for outlier rows.
    content = post_data.get("content")
    if isinstance(content, str) and len(content) > MAX_CONTENT_CHARS:
        logger.warn(
            "post_shape_content_truncated",
            persona=persona_key,
            original_length=len(content),
            max_length=MAX_CONTENT_CHARS,
        )
        post_data["content"] = content[:MAX_CONTENT_CHARS] + "…"

    return post_data

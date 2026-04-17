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


def validate_post_shape(post_data: dict, *, persona_key: str) -> dict:
    """Ensure post_data has the minimum fields to render and a valid post_type.

    Mutates + returns the same dict. Missing required fields get a placeholder +
    warn log so the operator sees the drift. An invalid post_type is coerced
    to "post".
    """
    # Required fields
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
                # Keep the post but mark it so the UI can surface a placeholder
                post_data["content"] = "[generation produced no text]"

    # post_type must match the frontend's Literal union
    pt = post_data.get("post_type")
    if pt not in VALID_POST_TYPES:
        logger.warn(
            "post_shape_invalid_post_type",
            persona=persona_key,
            invalid_post_type=pt,
        )
        post_data["post_type"] = "post"

    return post_data

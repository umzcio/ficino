"""Feed and Post data models."""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


# NOTE: posts are NOT validated against a typed post-shape model — `Feed.posts`
# below is `list[dict[str, object]]`. The worker builds posts as plain dicts
# and nothing in this file enforces per-post-type fields (see R10 API-7/BP-4:
# the previous typed post hierarchy here was dead code, imported only by its
# own test file, and has been removed).


class FeedGenerateRequest(BaseModel):
    corpus_id: UUID | None = None
    tag_filter: list[str] | None = None
    append_to_feed_id: str | None = None
    tab_focus: str | None = None  # "debates", "methods", "findings" — generates tab-specific posts
    persona_key: str | None = None  # when set, generate posts only from this persona
    num_posts: int | None = None  # override default post count (used with persona_key for profile "get their take")


class Feed(BaseModel):
    id: UUID
    user_id: UUID | None = None
    corpus_id: UUID | None = None
    tag_filter: list[str] | None = None
    posts: list[dict[str, object]] = Field(default_factory=list)
    generated_at: datetime | None = None
    generation_duration_ms: int | None = None
    paper_count: int | None = None
    post_count: int | None = None
    audio_status: str | None = None
    audio_generated_at: datetime | None = None
    podcast_status: str | None = None
    podcast_generated_at: datetime | None = None
    # podcast_segments: [{index, speaker, text, voice_id}] — transcript metadata.
    # The actual audio is ONE continuous mp3 rendered via v3 Dialogue Mode;
    # its signed URL is hydrated as podcast_audio_url at GET time.
    podcast_segments: list[dict[str, object]] | None = None
    podcast_audio_url: str | None = None

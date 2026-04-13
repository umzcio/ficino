"""Feed and Post data models."""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


class PostBase(BaseModel):
    persona: str
    post_type: str  # post, thread, quote, reply, figure
    content: str
    paper_ref: str | None = None
    likes: int = 0
    retweets: int = 0
    replies: int = 0
    bookmarks: int = 0


class ThreadPost(PostBase):
    post_type: str = "thread"
    thread_count: int = 1


class QuotePost(PostBase):
    post_type: str = "quote"
    quoting_handle: str | None = None
    quoting_content: str | None = None


class ReplyPost(PostBase):
    post_type: str = "reply"
    replying_to: str | None = None


class FigurePost(PostBase):
    post_type: str = "figure"
    figure_id: UUID | None = None
    figure_caption: str | None = None


class FeedGenerateRequest(BaseModel):
    corpus_id: UUID | None = None
    tag_filter: list[str] | None = None
    append_to_feed_id: str | None = None
    tab_focus: str | None = None  # "debates", "methods", "findings" — generates tab-specific posts


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

"""Request body models for routers that previously defined them inline.

Promoted from ~11 routers (R10 BP-4 promote half): pure moves, no field
changes. One file because each model is 2-5 lines — splitting per-router
would just re-create the fragmentation this consolidates. Grouped by the
router that consumes each model; routers import back from here.
"""

from pydantic import BaseModel, Field


# --- annotations.py ---

class AnnotationUpsert(BaseModel):
    body: str


# --- tags.py ---

class TagCreate(BaseModel):
    name: str


class PaperTagRequest(BaseModel):
    paper_id: str
    tag_name: str


# --- personas.py ---

class PersonaDmRequest(BaseModel):
    # Bound LLM input so a misbehaving client can't pump unbounded text into
    # the persona prompt. Matches ReplyRequest.user_message.
    message: str = Field(max_length=2000)


# --- workspaces.py ---

class WorkspaceCreate(BaseModel):
    name: str


class WorkspaceUpdate(BaseModel):
    name: str


# --- likes.py ---

class LikeCreate(BaseModel):
    feed_id: str
    post_index: int
    message_index: int = -1  # -1 = post-level, 0+ = reply message index
    persona_key: str | None = None
    post_type: str | None = None
    category: str | None = None


# --- user_posts.py ---

class UserPostCreate(BaseModel):
    # Matches the max_length used for ReplyRequest / ZapRequest in replies.py
    # so every body string shipped to a paid LLM has a per-request size cap.
    # Without this, 30 multi-MB posts/day (the existing rate limit) can still
    # burn arbitrarily large input-token bills on Claude.
    content: str = Field(max_length=4000)
    corpus_id: str | None = None


class UserPostFollowUp(BaseModel):
    content: str = Field(max_length=4000)


# --- bookmarks.py ---

class BookmarkCreate(BaseModel):
    feed_id: str
    post_index: int
    message_index: int = -1  # -1 = post-level, 0+ = reply message index
    post_snapshot: dict


# --- messages.py ---

class SynthesisCreateRequest(BaseModel):
    name: str
    paper_ids: list[str]


# --- settings.py ---

class SettingsUpdate(BaseModel):
    settings: dict


# --- reading_lists.py ---

class ReadingListCreate(BaseModel):
    name: str
    corpus_id: str | None = None
    paper_ids: list[str] | None = None  # if None, use all papers in corpus


class ReadingListReorder(BaseModel):
    paper_sequence: list[str]


class OrderedPaper(BaseModel):
    paper_id: str


class ApplyOrderingRequest(BaseModel):
    ordered_papers: list[OrderedPaper]


# --- replies.py ---

class ReplyRequest(BaseModel):
    feed_id: str
    post_index: int
    persona_key: str
    # Bound body length so a misbehaving/malicious client can't pump
    # unbounded text through the LLM path. Matches ZapRequest constraints.
    user_message: str = Field(max_length=2000)
    post_content: str = Field(max_length=4000)
    paper_ref: str | None = Field(default=None, max_length=500)


class ZapRequest(BaseModel):
    feed_id: str
    post_index: int
    target_persona_key: str  # persona to generate response
    source_persona_key: str  # persona who wrote the message being zapped
    # Bound source_message + post_content length so a misbehaving client
    # (or a malicious one) can't jam a 100MB payload through the LLM path.
    source_message: str = Field(max_length=2000)
    post_content: str = Field(max_length=4000)
    paper_ref: str | None = Field(default=None, max_length=500)

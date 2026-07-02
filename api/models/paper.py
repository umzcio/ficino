"""Paper data models."""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


class PaperTag(BaseModel):
    id: str
    name: str


class Paper(BaseModel):
    id: UUID
    user_id: UUID | None = None
    corpus_id: UUID | None = None
    title: str | None = None
    authors: list[str] = Field(default_factory=list)
    year: int | None = None
    doi: str | None = None
    filename: str
    status: str = "pending"
    extraction_path: str | None = None
    error_message: str | None = None
    chunk_count: int = 0
    figure_count: int = 0
    tags: list[PaperTag] = Field(default_factory=list)
    uploaded_at: datetime | None = None
    processed_at: datetime | None = None

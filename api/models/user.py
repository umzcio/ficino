"""User and Corpus data models."""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


class Corpus(BaseModel):
    id: UUID
    user_id: UUID
    name: str = "Default"
    created_at: datetime | None = None


class User(BaseModel):
    id: UUID
    clerk_id: str | None = None
    email: str
    display_name: str | None = None
    default_corpus_id: UUID | None = None
    corpora: list[Corpus] = Field(default_factory=list)
    generation_count_today: int = 0
    created_at: datetime | None = None


class UserUpdate(BaseModel):
    display_name: str | None = None
    default_corpus_id: UUID | None = None

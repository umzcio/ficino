"""User data models."""

from uuid import UUID

from pydantic import BaseModel


class UserUpdate(BaseModel):
    display_name: str | None = None
    default_corpus_id: UUID | None = None

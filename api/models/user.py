"""User data models."""

from pydantic import BaseModel


class UserUpdate(BaseModel):
    # R10 API-4: `default_corpus_id` was accepted here but silently ignored
    # by update_user_profile (no `users` column, no read path) — dropped
    # rather than implemented. The frontend already persists the active
    # workspace client-side (useWorkspaces.ts's `ACTIVE_WORKSPACE_KEY` in
    # localStorage); a server-persisted default would be a second, easily
    # divergent source of truth for a preference nothing currently reads.
    # If a real cross-device "default workspace" need shows up later, add
    # the column + migration then, backed by an actual consumer.
    display_name: str | None = None

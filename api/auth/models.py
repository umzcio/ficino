"""Auth user model — the identity contract between auth providers and app code."""

from pydantic import BaseModel


class AuthUser(BaseModel):
    """Minimal identity returned by all auth providers.

    Routes receive this via Depends(get_current_user). The id field
    is always the local DB users.id UUID (as string), never an external
    provider's ID.
    """
    id: str
    email: str
    display_name: str | None = None

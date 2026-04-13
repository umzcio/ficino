"""Pluggable authentication module.

Exports get_current_user — a FastAPI dependency that returns AuthUser.
The implementation is selected at import time based on AUTH_PROVIDER env var.

Usage in routes:
    from auth import AuthUser, get_current_user

    @router.get("/something")
    async def endpoint(user: AuthUser = Depends(get_current_user), db = Depends(get_db)):
        # user.id is always the local DB UUID
        ...
"""

from auth.models import AuthUser
from auth.providers import get_user_none, get_user_basic, get_user_supabase
from config import settings

_PROVIDERS = {
    "none": get_user_none,
    "basic": get_user_basic,
    "supabase": get_user_supabase,
}

provider_name = settings.auth_provider
if provider_name not in _PROVIDERS:
    raise ValueError(f"Unknown AUTH_PROVIDER: {provider_name}. Must be one of: {list(_PROVIDERS.keys())}")

get_current_user = _PROVIDERS[provider_name]

__all__ = ["AuthUser", "get_current_user"]

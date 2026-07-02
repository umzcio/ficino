from .base import StorageBackend
from .local import LocalStorage


def build_backend(
    provider: str,
    *,
    upload_dir: str,
    figures_dir: str,
    supabase_url: str = "",
    supabase_service_role_key: str = "",
    supabase_bucket: str = "papers",
) -> StorageBackend:
    provider = (provider or "local").lower()
    if provider == "local":
        return LocalStorage(upload_dir, figures_dir)
    if provider == "supabase":
        from .supabase import SupabaseStorage
        if not supabase_url or not supabase_service_role_key:
            raise RuntimeError(
                "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set "
                "when STORAGE_PROVIDER=supabase"
            )
        return SupabaseStorage(supabase_url, supabase_service_role_key, supabase_bucket)
    raise ValueError(f"Unknown STORAGE_PROVIDER: {provider}. Must be 'local' or 'supabase'.")


__all__ = ["StorageBackend", "build_backend"]

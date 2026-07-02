"""Shim — backends live in ficino_shared.storage (R10 DUP-2).

Wiring stays here: the api reads config.settings; the worker reads env.
"""
from config import settings
from ficino_shared.storage import StorageBackend, build_backend  # noqa: F401

storage: StorageBackend = build_backend(
    settings.storage_provider or "local",
    upload_dir=settings.upload_dir,
    figures_dir=settings.figures_dir,
    supabase_url=settings.supabase_url or "",
    supabase_service_role_key=settings.supabase_service_role_key or "",
    supabase_bucket=settings.supabase_storage_bucket or "papers",
)

__all__ = ["StorageBackend", "storage"]

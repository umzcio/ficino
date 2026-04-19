"""Pluggable storage backend for uploaded PDFs and extracted figure crops.

The backend is selected at import time based on settings.storage_provider:
  - "local"    — filesystem under settings.upload_dir and settings.figures_dir
                 (default; used for self-host)
  - "supabase" — Supabase Storage (single bucket, path-keyed by
                 {user_id}/{paper_id}[...])

Usage:
    from storage import storage
    ref = storage.save_pdf(user_id, paper_id, content_bytes)
    url = storage.figure_image_url(user_id, paper_id, figure_id, image_path)
"""

from config import settings
from .base import StorageBackend
from .local import LocalStorage


def _build_backend() -> StorageBackend:
    provider = (settings.storage_provider or "local").lower()
    if provider == "local":
        return LocalStorage()
    if provider == "supabase":
        from .supabase import SupabaseStorage
        return SupabaseStorage()
    raise ValueError(
        f"Unknown STORAGE_PROVIDER: {provider}. Must be 'local' or 'supabase'."
    )


storage: StorageBackend = _build_backend()

__all__ = ["StorageBackend", "storage"]

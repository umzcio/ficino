"""Shim — backends live in ficino_shared.storage (R10 DUP-2). Env-wired."""
import os

from ficino_shared.storage import StorageBackend, build_backend  # noqa: F401

storage: StorageBackend = build_backend(
    os.getenv("STORAGE_PROVIDER", "local"),
    upload_dir=os.getenv("UPLOAD_DIR", "/app/uploads"),
    figures_dir=os.getenv("FIGURES_DIR", "/app/figures"),
    supabase_url=os.getenv("SUPABASE_URL", "").strip(),
    supabase_service_role_key=os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip(),
    supabase_bucket=os.getenv("SUPABASE_STORAGE_BUCKET", "papers"),
)

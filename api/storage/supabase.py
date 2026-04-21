"""Supabase Storage backend.

Single bucket (default: "papers"), path-keyed so RLS policies can scope by
path prefix if you ever want per-user policies beyond the API layer:

  {user_id}/{paper_id}.pdf                     — original upload
  {user_id}/{paper_id}/figures/{filename}.png  — extracted crop

The backend uses the Supabase *service role* key so it can read/write on
behalf of any user. Figure images are exposed to the browser via
short-lived signed URLs issued by Supabase directly — no round-trip
through our API, so `/figures/...` is not mounted when this backend is
active.
"""

from __future__ import annotations

import os
import tempfile

from config import settings

from .base import StorageBackend


class SupabaseStorage(StorageBackend):
    def __init__(self) -> None:
        url = settings.supabase_url
        key = settings.supabase_service_role_key
        if not url or not key:
            raise RuntimeError(
                "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set "
                "when STORAGE_PROVIDER=supabase"
            )
        from supabase import create_client
        self._client = create_client(url, key)
        self._bucket = settings.supabase_storage_bucket or "papers"

    # -- Key helpers --

    @staticmethod
    def _pdf_key(user_id: str, paper_id: str) -> str:
        return f"{user_id}/{paper_id}.pdf"

    @staticmethod
    def _figure_key(user_id: str, paper_id: str, filename: str) -> str:
        safe = os.path.basename(filename)
        if not safe or safe.startswith(".") or safe != filename:
            raise ValueError(f"invalid figure filename: {filename!r}")
        return f"{user_id}/{paper_id}/figures/{safe}"

    @staticmethod
    def _audio_key(user_id: str, feed_id: str, post_index: int) -> str:
        return f"{user_id}/feeds/{feed_id}/audio/post_{post_index}.mp3"

    # -- PDFs --

    def save_pdf(self, user_id: str, paper_id: str, content: bytes) -> str:
        key = self._pdf_key(user_id, paper_id)
        self._client.storage.from_(self._bucket).upload(
            path=key,
            file=content,
            file_options={
                "content-type": "application/pdf",
                "upsert": "true",
            },
        )
        return key

    def localize_pdf(self, user_id: str, paper_id: str) -> str:
        data = self._client.storage.from_(self._bucket).download(
            self._pdf_key(user_id, paper_id)
        )
        # NamedTemporaryFile with delete=False so the caller keeps control
        # over lifetime — extraction libs (fitz, marker) hold the path for
        # the full pipeline duration, then release_local wipes it.
        fd, tmp_path = tempfile.mkstemp(
            suffix=".pdf", prefix=f"{paper_id}_"
        )
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        return tmp_path

    def release_local(self, local_path: str) -> None:
        try:
            os.remove(local_path)
        except OSError:
            pass

    def delete_pdf(self, user_id: str, paper_id: str) -> None:
        try:
            self._client.storage.from_(self._bucket).remove(
                [self._pdf_key(user_id, paper_id)]
            )
        except Exception:
            # Swallow to stay idempotent — parity with LocalStorage
            pass

    # -- Figures --

    def save_figure(
        self, user_id: str, paper_id: str, filename: str, content: bytes
    ) -> str:
        key = self._figure_key(user_id, paper_id, filename)
        self._client.storage.from_(self._bucket).upload(
            path=key,
            file=content,
            file_options={
                "content-type": "image/png",
                "upsert": "true",
            },
        )
        return key

    def read_figure_bytes(
        self, user_id: str, paper_id: str, filename: str
    ) -> bytes:
        return self._client.storage.from_(self._bucket).download(
            self._figure_key(user_id, paper_id, filename)
        )

    # -- Bulk --

    def delete_paper_artifacts(self, user_id: str, paper_id: str) -> None:
        # Supabase Storage has no recursive delete — we have to enumerate
        # the prefix, then call remove with the full list.
        bucket = self._client.storage.from_(self._bucket)
        keys_to_remove: list[str] = [self._pdf_key(user_id, paper_id)]
        try:
            listed = bucket.list(f"{user_id}/{paper_id}/figures")
            if listed:
                keys_to_remove.extend(
                    f"{user_id}/{paper_id}/figures/{item['name']}"
                    for item in listed
                    if item.get("name")
                )
        except Exception:
            # If listing fails, still try to remove the PDF — better to do
            # something than nothing.
            pass
        try:
            bucket.remove(keys_to_remove)
        except Exception:
            pass

    # -- Feed audio --

    def save_audio(
        self, user_id: str, feed_id: str, post_index: int, content: bytes
    ) -> str:
        key = self._audio_key(user_id, feed_id, post_index)
        self._client.storage.from_(self._bucket).upload(
            path=key,
            file=content,
            file_options={
                "content-type": "audio/mpeg",
                "upsert": "true",
            },
        )
        return key

    def audio_url(
        self, user_id: str, feed_id: str, post_index: int, ttl: int = 86400
    ) -> str:
        key = self._audio_key(user_id, feed_id, post_index)
        resp = self._client.storage.from_(self._bucket).create_signed_url(
            path=key, expires_in=ttl,
        )
        return resp.get("signedURL") or resp.get("signedUrl") or ""

    # -- URLs --

    def figure_image_url(
        self,
        user_id: str,
        paper_id: str,
        figure_id: str,
        image_path: str,
        ttl: int = 600,
    ) -> str:
        # image_path was persisted by save_figure as the storage key.
        # Hand it straight to Supabase's signed-URL API.
        resp = self._client.storage.from_(self._bucket).create_signed_url(
            path=image_path, expires_in=ttl,
        )
        # supabase-py returns {"signedURL": "..."} (or "signedUrl" on
        # some versions — tolerate both).
        return resp.get("signedURL") or resp.get("signedUrl") or ""

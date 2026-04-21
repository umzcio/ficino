"""Worker-side storage adapter. Mirror of api/storage/ — identical interface,
different wiring.

The worker can't import api.config (different container, different package
layout), so we read config from env vars directly. Both containers see the
same env (docker-compose shares the .env file), so STORAGE_PROVIDER + paths
stay in sync automatically.

Usage in a Celery task:
    from lib.storage import storage
    local_path = storage.localize_pdf(user_id, paper_id)
    try:
        # hand local_path to fitz / marker / etc.
        ...
    finally:
        storage.release_local(local_path)

Methods mirror api/storage/base.py — see that file for documentation.
"""

from __future__ import annotations

import os
import shutil
import tempfile
from abc import ABC, abstractmethod


UPLOAD_DIR = os.getenv("UPLOAD_DIR", "/app/uploads")
FIGURES_DIR = os.getenv("FIGURES_DIR", "/app/figures")
STORAGE_PROVIDER = os.getenv("STORAGE_PROVIDER", "local").lower()


class StorageBackend(ABC):
    @abstractmethod
    def save_pdf(self, user_id: str, paper_id: str, content: bytes) -> str: ...

    @abstractmethod
    def localize_pdf(self, user_id: str, paper_id: str) -> str: ...

    @abstractmethod
    def release_local(self, local_path: str) -> None: ...

    @abstractmethod
    def delete_pdf(self, user_id: str, paper_id: str) -> None: ...

    @abstractmethod
    def save_figure(
        self, user_id: str, paper_id: str, filename: str, content: bytes
    ) -> str: ...

    @abstractmethod
    def read_figure_bytes(
        self, user_id: str, paper_id: str, filename: str
    ) -> bytes: ...

    @abstractmethod
    def delete_paper_artifacts(self, user_id: str, paper_id: str) -> None: ...

    @abstractmethod
    def figure_image_url(
        self,
        user_id: str,
        paper_id: str,
        figure_id: str,
        image_path: str,
        ttl: int = 600,
    ) -> str: ...

    @abstractmethod
    def save_audio(
        self, user_id: str, feed_id: str, post_index: int, content: bytes
    ) -> str: ...

    @abstractmethod
    def audio_url(
        self, user_id: str, feed_id: str, post_index: int, ttl: int = 86400
    ) -> str: ...


class _LocalStorage(StorageBackend):
    def __init__(self) -> None:
        self.upload_dir = UPLOAD_DIR
        self.figures_dir = FIGURES_DIR

    def _pdf_path(self, paper_id: str) -> str:
        return os.path.join(self.upload_dir, f"{paper_id}.pdf")

    def _figure_dir(self, paper_id: str) -> str:
        return os.path.join(self.figures_dir, paper_id)

    def save_pdf(self, user_id: str, paper_id: str, content: bytes) -> str:
        os.makedirs(self.upload_dir, exist_ok=True)
        path = self._pdf_path(paper_id)
        with open(path, "wb") as f:
            f.write(content)
        return path

    def localize_pdf(self, user_id: str, paper_id: str) -> str:
        return self._pdf_path(paper_id)

    def release_local(self, local_path: str) -> None:
        return None

    def delete_pdf(self, user_id: str, paper_id: str) -> None:
        try:
            os.remove(self._pdf_path(paper_id))
        except OSError:
            pass

    def save_figure(
        self, user_id: str, paper_id: str, filename: str, content: bytes
    ) -> str:
        safe = os.path.basename(filename)
        if not safe or safe.startswith(".") or safe != filename:
            raise ValueError(f"invalid figure filename: {filename!r}")
        paper_dir = self._figure_dir(paper_id)
        os.makedirs(paper_dir, exist_ok=True)
        path = os.path.join(paper_dir, safe)
        with open(path, "wb") as f:
            f.write(content)
        return path

    def read_figure_bytes(
        self, user_id: str, paper_id: str, filename: str
    ) -> bytes:
        safe = os.path.basename(filename)
        with open(os.path.join(self._figure_dir(paper_id), safe), "rb") as f:
            return f.read()

    def delete_paper_artifacts(self, user_id: str, paper_id: str) -> None:
        self.delete_pdf(user_id, paper_id)
        fig_dir = self._figure_dir(paper_id)
        if os.path.isdir(fig_dir):
            try:
                shutil.rmtree(fig_dir)
            except OSError:
                pass

    def figure_image_url(
        self,
        user_id: str,
        paper_id: str,
        figure_id: str,
        image_path: str,
        ttl: int = 600,
    ) -> str:
        # Deferred import — signed_url pulls in module-load-time env reads
        # and we want this file to be importable in test harnesses that
        # don't set SIGNED_URL_KEY.
        from lib.signed_url import sign_resource
        return (
            f"/figures/{paper_id}/{figure_id}"
            f"?token={sign_resource(figure_id, ttl)}"
        )

    def save_audio(
        self, user_id: str, feed_id: str, post_index: int, content: bytes
    ) -> str:
        raise NotImplementedError(
            "Feed audio requires STORAGE_PROVIDER=supabase"
        )

    def audio_url(
        self, user_id: str, feed_id: str, post_index: int, ttl: int = 86400
    ) -> str:
        raise NotImplementedError(
            "Feed audio requires STORAGE_PROVIDER=supabase"
        )


class _SupabaseStorage(StorageBackend):
    def __init__(self) -> None:
        url = os.getenv("SUPABASE_URL", "").strip()
        key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
        if not url or not key:
            raise RuntimeError(
                "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set "
                "when STORAGE_PROVIDER=supabase"
            )
        from supabase import create_client
        self._client = create_client(url, key)
        self._bucket = os.getenv("SUPABASE_STORAGE_BUCKET", "papers")

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

    def save_pdf(self, user_id: str, paper_id: str, content: bytes) -> str:
        key = self._pdf_key(user_id, paper_id)
        self._client.storage.from_(self._bucket).upload(
            path=key,
            file=content,
            file_options={"content-type": "application/pdf", "upsert": "true"},
        )
        return key

    def localize_pdf(self, user_id: str, paper_id: str) -> str:
        data = self._client.storage.from_(self._bucket).download(
            self._pdf_key(user_id, paper_id)
        )
        fd, tmp_path = tempfile.mkstemp(suffix=".pdf", prefix=f"{paper_id}_")
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
            pass

    def save_figure(
        self, user_id: str, paper_id: str, filename: str, content: bytes
    ) -> str:
        key = self._figure_key(user_id, paper_id, filename)
        self._client.storage.from_(self._bucket).upload(
            path=key,
            file=content,
            file_options={"content-type": "image/png", "upsert": "true"},
        )
        return key

    def read_figure_bytes(
        self, user_id: str, paper_id: str, filename: str
    ) -> bytes:
        return self._client.storage.from_(self._bucket).download(
            self._figure_key(user_id, paper_id, filename)
        )

    def delete_paper_artifacts(self, user_id: str, paper_id: str) -> None:
        bucket = self._client.storage.from_(self._bucket)
        keys: list[str] = [self._pdf_key(user_id, paper_id)]
        try:
            listed = bucket.list(f"{user_id}/{paper_id}/figures")
            if listed:
                keys.extend(
                    f"{user_id}/{paper_id}/figures/{item['name']}"
                    for item in listed
                    if item.get("name")
                )
        except Exception:
            pass
        try:
            bucket.remove(keys)
        except Exception:
            pass

    def figure_image_url(
        self,
        user_id: str,
        paper_id: str,
        figure_id: str,
        image_path: str,
        ttl: int = 600,
    ) -> str:
        resp = self._client.storage.from_(self._bucket).create_signed_url(
            path=image_path, expires_in=ttl,
        )
        return resp.get("signedURL") or resp.get("signedUrl") or ""

    def save_audio(
        self, user_id: str, feed_id: str, post_index: int, content: bytes
    ) -> str:
        key = self._audio_key(user_id, feed_id, post_index)
        self._client.storage.from_(self._bucket).upload(
            path=key,
            file=content,
            file_options={"content-type": "audio/mpeg", "upsert": "true"},
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


def _build() -> StorageBackend:
    if STORAGE_PROVIDER == "local":
        return _LocalStorage()
    if STORAGE_PROVIDER == "supabase":
        return _SupabaseStorage()
    raise ValueError(
        f"Unknown STORAGE_PROVIDER: {STORAGE_PROVIDER}. "
        "Must be 'local' or 'supabase'."
    )


storage: StorageBackend = _build()

__all__ = ["storage", "StorageBackend"]

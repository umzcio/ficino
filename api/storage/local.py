"""Filesystem-backed storage. Default backend and the only one used for
self-host installs.

Layout:
  {upload_dir}/{paper_id}.pdf
  {figures_dir}/{paper_id}/{filename}.png

`user_id` is accepted by every method for interface parity with cloud
backends but ignored here — the filesystem layout is flat per-paper.
Multi-tenant isolation is enforced at the database layer (papers are
user-scoped; any caller reaching the filesystem has already passed the
DB ownership check).
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

from config import settings
from signed_url import sign_resource

from .base import StorageBackend


class LocalStorage(StorageBackend):
    def __init__(self) -> None:
        self.upload_dir = settings.upload_dir
        self.figures_dir = settings.figures_dir

    # -- PDFs --

    def _pdf_path(self, paper_id: str) -> str:
        return os.path.join(self.upload_dir, f"{paper_id}.pdf")

    def save_pdf(self, user_id: str, paper_id: str, content: bytes) -> str:
        os.makedirs(self.upload_dir, exist_ok=True)
        path = self._pdf_path(paper_id)
        with open(path, "wb") as f:
            f.write(content)
        return path

    def localize_pdf(self, user_id: str, paper_id: str) -> str:
        return self._pdf_path(paper_id)

    def release_local(self, local_path: str) -> None:
        # File is the canonical copy — don't delete it.
        return None

    def delete_pdf(self, user_id: str, paper_id: str) -> None:
        path = self._pdf_path(paper_id)
        try:
            os.remove(path)
        except OSError:
            pass

    # -- Figures --

    def _figure_dir(self, paper_id: str) -> str:
        return os.path.join(self.figures_dir, paper_id)

    def save_figure(
        self, user_id: str, paper_id: str, filename: str, content: bytes
    ) -> str:
        # Filename must be a bare basename — reject anything with a
        # separator so a malicious upstream can't escape the paper dir.
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
        base = Path(self.figures_dir).resolve()
        full = (base / paper_id / safe).resolve()
        # Defence in depth: even though callers check this too, make sure
        # the storage layer can never be coerced into reading outside the
        # figures tree.
        full.relative_to(base)
        with open(full, "rb") as f:
            return f.read()

    # -- Bulk --

    def delete_paper_artifacts(self, user_id: str, paper_id: str) -> None:
        self.delete_pdf(user_id, paper_id)
        fig_dir = self._figure_dir(paper_id)
        if os.path.isdir(fig_dir):
            try:
                shutil.rmtree(fig_dir)
            except OSError:
                pass

    # -- Feed audio --

    def save_audio(
        self, user_id: str, feed_id: str, post_index: int, content: bytes
    ) -> str:
        # Local audio support is out of scope for MVP — ElevenLabs
        # requires a network key anyway, so the feature is effectively
        # cloud-only. Self-hosters who want audio should switch to the
        # Supabase storage backend.
        raise NotImplementedError(
            "Feed audio requires STORAGE_PROVIDER=supabase"
        )

    def audio_url(
        self, user_id: str, feed_id: str, post_index: int, ttl: int = 86400
    ) -> str:
        raise NotImplementedError(
            "Feed audio requires STORAGE_PROVIDER=supabase"
        )

    # -- Podcast --

    def save_podcast_segment(
        self, user_id: str, feed_id: str, segment_index: int, content: bytes
    ) -> str:
        raise NotImplementedError(
            "Feed podcast requires STORAGE_PROVIDER=supabase"
        )

    def podcast_segment_url(
        self, user_id: str, feed_id: str, segment_index: int, ttl: int = 86400
    ) -> str:
        raise NotImplementedError(
            "Feed podcast requires STORAGE_PROVIDER=supabase"
        )

    # -- URLs --

    def figure_image_url(
        self,
        user_id: str,
        paper_id: str,
        figure_id: str,
        image_path: str,
        ttl: int = 600,
    ) -> str:
        # Our API serves figures at /figures/{paper_id}/{figure_id} and
        # validates an HMAC token keyed on the figure_id. image_path is
        # unused here — LocalStorage resolves the file by (paper_id,
        # figure_id → figures.image_path) server-side.
        return (
            f"/figures/{paper_id}/{figure_id}"
            f"?token={sign_resource(figure_id, ttl)}"
        )

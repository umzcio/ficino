"""Abstract storage backend interface.

Backends translate (user_id, paper_id, filename) triples into their own
physical layout — a filesystem path for LocalStorage, a bucket key for
SupabaseStorage — and the rest of the app never has to care which one
is in use.

Method naming follows the bytes-in / bytes-out convention. Any method
that needs a filesystem path for third-party libraries (fitz, marker,
PIL) goes through `localize_pdf` + `release_local` so cloud backends
can stage a temp file and clean it up.
"""

from abc import ABC, abstractmethod


class StorageBackend(ABC):
    # -- PDFs --

    @abstractmethod
    def save_pdf(self, user_id: str, paper_id: str, content: bytes) -> str:
        """Persist the PDF bytes. Return a backend-specific reference
        (suitable for storing in papers.file_path)."""

    @abstractmethod
    def localize_pdf(self, user_id: str, paper_id: str) -> str:
        """Return a filesystem path the worker can hand to fitz/marker/etc.

        Local backend returns the existing path. Cloud backends download
        to a tempfile; pair with `release_local()` to clean it up.
        """

    @abstractmethod
    def release_local(self, local_path: str) -> None:
        """Release a path returned by `localize_pdf`. No-op for local
        backend; removes the tempfile for cloud backends."""

    @abstractmethod
    def delete_pdf(self, user_id: str, paper_id: str) -> None:
        """Delete the PDF. Idempotent."""

    # -- Figures --

    @abstractmethod
    def save_figure(
        self, user_id: str, paper_id: str, filename: str, content: bytes
    ) -> str:
        """Persist a figure crop (basename like 'fig_p1_0.png'). Return a
        backend reference suitable for storing in figures.image_path."""

    # -- Bulk --

    @abstractmethod
    def delete_paper_artifacts(self, user_id: str, paper_id: str) -> None:
        """Delete the PDF and every figure under this paper. Idempotent."""

    # -- URLs --

    @abstractmethod
    def figure_image_url(
        self,
        user_id: str,
        paper_id: str,
        figure_id: str,
        image_path: str,
        ttl: int = 600,
    ) -> str:
        """Return a URL the browser can fetch directly.

        `image_path` is whatever was stored in figures.image_path when the
        crop was saved — each backend uses it according to its own layout.
        Local returns a relative `/figures/...?token=...` URL served by our
        API; cloud backends return a provider-issued signed URL.
        """

    # -- Feed audio (TTS) --

    @abstractmethod
    def save_audio(
        self, user_id: str, feed_id: str, post_index: int, content: bytes
    ) -> str:
        """Persist an mp3 rendered from a feed post. Returns a backend
        reference suitable for storing in posts[*].audio_key."""

    @abstractmethod
    def audio_url(
        self, user_id: str, feed_id: str, post_index: int, ttl: int = 86400
    ) -> str:
        """Return a URL the browser can fetch directly. Default TTL is
        24h — feeds are playable for a day after generation; re-trigger
        TTS to refresh."""

    # -- Podcast (NotebookLM-style two-host episodes) --

    @abstractmethod
    def save_podcast_episode(
        self, user_id: str, feed_id: str, content: bytes
    ) -> str:
        """Persist the full podcast episode mp3 — one continuous file
        produced by Eleven v3 Dialogue Mode. Returns a backend reference
        that `podcast_episode_url` can turn back into a signed URL."""

    @abstractmethod
    def podcast_episode_url(
        self, user_id: str, feed_id: str, ttl: int = 86400
    ) -> str:
        """Signed URL for the single-file podcast episode mp3."""

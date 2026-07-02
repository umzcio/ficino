"""SupabaseStorage tests, ported from the old api/tests/test_storage.py.

That file monkeypatched `config.settings` and imported `storage.supabase`
directly — both of which stopped existing once the class moved here
(R10 DUP-2). Config is now injected via the constructor, so these tests
construct SupabaseStorage(url, key, bucket) directly against a fake
client — no live Supabase project required.
"""
from __future__ import annotations

import sys
from unittest.mock import MagicMock

import pytest


@pytest.fixture
def fake_supabase_storage(monkeypatch):
    fake_client = MagicMock()
    fake_bucket = MagicMock()
    fake_client.storage.from_.return_value = fake_bucket

    fake_supabase_module = MagicMock()
    fake_supabase_module.create_client = lambda *_a, **_k: fake_client
    monkeypatch.setitem(sys.modules, "supabase", fake_supabase_module)

    from ficino_shared.storage.supabase import SupabaseStorage
    inst = SupabaseStorage("https://example.supabase.co", "fake-key", "papers")
    return inst, fake_bucket


def test_supabase_requires_url_and_key():
    from ficino_shared.storage.supabase import SupabaseStorage
    with pytest.raises(RuntimeError):
        SupabaseStorage("", "", "papers")


def test_supabase_save_pdf_uploads_with_expected_key(fake_supabase_storage):
    inst, bucket = fake_supabase_storage
    ref = inst.save_pdf("user-123", "paper-abc", b"%PDF...")
    assert ref == "user-123/paper-abc.pdf"
    bucket.upload.assert_called_once()
    kwargs = bucket.upload.call_args.kwargs
    assert kwargs["path"] == "user-123/paper-abc.pdf"
    assert kwargs["file"] == b"%PDF..."
    assert kwargs["file_options"]["content-type"] == "application/pdf"


def test_supabase_save_figure_uploads_png(fake_supabase_storage):
    inst, bucket = fake_supabase_storage
    ref = inst.save_figure("u", "p", "fig_p1_0.png", b"png")
    assert ref == "u/p/figures/fig_p1_0.png"
    kwargs = bucket.upload.call_args.kwargs
    assert kwargs["file_options"]["content-type"] == "image/png"


def test_supabase_save_figure_rejects_traversal(fake_supabase_storage):
    inst, _ = fake_supabase_storage
    with pytest.raises(ValueError):
        inst.save_figure("u", "p", "../evil.png", b"x")


def test_supabase_figure_image_url_uses_signed_url(fake_supabase_storage):
    inst, bucket = fake_supabase_storage
    bucket.create_signed_url.return_value = {"signedURL": "https://example.supabase.co/signed/abc"}
    url = inst.figure_image_url(
        "u", "p", "fig-id", image_path="u/p/figures/fig_p1_0.png", ttl=3600,
    )
    assert url == "https://example.supabase.co/signed/abc"
    bucket.create_signed_url.assert_called_once()
    kwargs = bucket.create_signed_url.call_args.kwargs
    assert kwargs["path"] == "u/p/figures/fig_p1_0.png"
    assert kwargs["expires_in"] == 3600


def test_supabase_delete_paper_artifacts_enumerates_figures(fake_supabase_storage):
    inst, bucket = fake_supabase_storage
    bucket.list.return_value = [{"name": "a.png"}, {"name": "b.png"}]
    inst.delete_paper_artifacts("u", "p")

    bucket.remove.assert_called_once()
    keys = bucket.remove.call_args.args[0]
    assert "u/p.pdf" in keys
    assert "u/p/figures/a.png" in keys
    assert "u/p/figures/b.png" in keys


def test_supabase_podcast_episode_roundtrip_keys(fake_supabase_storage):
    """Coverage for the audio/podcast-episode methods (WORK-13: the
    per-segment methods are dropped as dead; the episode methods are not)."""
    inst, bucket = fake_supabase_storage
    ref = inst.save_podcast_episode("u", "feed-1", b"mp3-bytes")
    assert ref == "u/feeds/feed-1/podcast/episode.mp3"

    bucket.create_signed_url.return_value = {"signedURL": "https://example.supabase.co/signed/ep"}
    url = inst.podcast_episode_url("u", "feed-1", ttl=86400)
    assert url == "https://example.supabase.co/signed/ep"


def test_supabase_no_longer_has_dead_segment_methods(fake_supabase_storage):
    """WORK-13: save_podcast_segment / podcast_segment_url had zero callers
    and are not ported."""
    inst, _ = fake_supabase_storage
    assert not hasattr(inst, "save_podcast_segment")
    assert not hasattr(inst, "podcast_segment_url")

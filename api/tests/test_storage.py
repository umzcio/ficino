"""Unit tests for the storage adapter.

LocalStorage is exercised directly (real filesystem, under tmp_path).
SupabaseStorage is exercised through a fake client — we don't require
a live Supabase project in CI, just that the adapter calls the
expected client methods with the expected arguments.
"""
from __future__ import annotations

import os
from unittest.mock import MagicMock

import pytest

from storage.local import LocalStorage


# --- LocalStorage -----------------------------------------------------------


@pytest.fixture
def local_storage(tmp_path, monkeypatch):
    """Return a LocalStorage wired to a tmp upload/figures tree."""
    upload_dir = tmp_path / "uploads"
    figures_dir = tmp_path / "figures"
    # LocalStorage reads `settings.upload_dir` / `settings.figures_dir`
    # at __init__ time, so swap them before constructing.
    from config import settings
    monkeypatch.setattr(settings, "upload_dir", str(upload_dir))
    monkeypatch.setattr(settings, "figures_dir", str(figures_dir))
    return LocalStorage()


def test_local_save_and_localize_pdf(local_storage, tmp_path):
    ref = local_storage.save_pdf("uid", "pid", b"%PDF-1.4 data")
    assert ref.endswith("pid.pdf")
    assert os.path.exists(ref)
    # localize_pdf returns the same path (no-op for local backend)
    assert local_storage.localize_pdf("uid", "pid") == ref


def test_local_release_local_is_noop(local_storage):
    ref = local_storage.save_pdf("uid", "pid", b"bytes")
    local_storage.release_local(ref)
    # Canonical copy is preserved — release is a no-op for local
    assert os.path.exists(ref)


def test_local_delete_pdf_idempotent(local_storage):
    local_storage.save_pdf("uid", "pid", b"x")
    local_storage.delete_pdf("uid", "pid")
    # Second call must not raise even though the file is gone
    local_storage.delete_pdf("uid", "pid")


def test_local_save_and_read_figure(local_storage):
    ref = local_storage.save_figure("uid", "pid", "fig_p1_0.png", b"PNG-bytes")
    assert ref.endswith(os.path.join("pid", "fig_p1_0.png"))
    assert local_storage.read_figure_bytes("uid", "pid", "fig_p1_0.png") == b"PNG-bytes"


def test_local_save_figure_rejects_traversal(local_storage):
    with pytest.raises(ValueError):
        local_storage.save_figure("uid", "pid", "../evil.png", b"x")
    with pytest.raises(ValueError):
        local_storage.save_figure("uid", "pid", "sub/file.png", b"x")
    with pytest.raises(ValueError):
        local_storage.save_figure("uid", "pid", ".hidden", b"x")


def test_local_delete_paper_artifacts_removes_all(local_storage):
    local_storage.save_pdf("uid", "pid", b"pdf")
    local_storage.save_figure("uid", "pid", "a.png", b"a")
    local_storage.save_figure("uid", "pid", "b.png", b"b")

    local_storage.delete_paper_artifacts("uid", "pid")

    # Every trace is gone; idempotent second call
    assert not os.path.exists(local_storage._pdf_path("pid"))
    assert not os.path.isdir(local_storage._figure_dir("pid"))
    local_storage.delete_paper_artifacts("uid", "pid")


def test_local_figure_image_url_is_signed(local_storage):
    url = local_storage.figure_image_url(
        "uid", "paper-1", "fig-2", image_path="ignored", ttl=600,
    )
    assert url.startswith("/figures/paper-1/fig-2?token=")


# --- SupabaseStorage (fake client) -----------------------------------------


@pytest.fixture
def fake_supabase_storage(monkeypatch):
    """Construct SupabaseStorage with its Supabase client replaced by a mock.

    The real supabase-py isn't needed — every method we call is simple
    enough to mock at the client level.
    """
    from config import settings
    monkeypatch.setattr(settings, "supabase_url", "https://example.supabase.co")
    monkeypatch.setattr(settings, "supabase_service_role_key", "fake-key")
    monkeypatch.setattr(settings, "supabase_storage_bucket", "papers")

    fake_client = MagicMock()
    fake_bucket = MagicMock()
    fake_client.storage.from_.return_value = fake_bucket

    import storage.supabase as sup_mod
    monkeypatch.setattr(sup_mod, "create_client", lambda *_a, **_k: fake_client, raising=False)

    # create_client is imported inside __init__, so patch the `supabase` module's create_client
    import sys
    fake_supabase = MagicMock()
    fake_supabase.create_client = lambda *_a, **_k: fake_client
    monkeypatch.setitem(sys.modules, "supabase", fake_supabase)

    from storage.supabase import SupabaseStorage
    inst = SupabaseStorage()
    return inst, fake_bucket


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

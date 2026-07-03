import os

import pytest
from ficino_shared.storage import build_backend
from ficino_shared.storage.local import LocalStorage


@pytest.fixture
def local(tmp_path):
    return build_backend(
        "local",
        upload_dir=str(tmp_path / "uploads"),
        figures_dir=str(tmp_path / "figures"),
    )


def test_pdf_roundtrip(local):
    ref = local.save_pdf("u1", "paper-1", b"%PDF-fake")
    assert local.localize_pdf("u1", "paper-1") == ref
    local.delete_pdf("u1", "paper-1")


def test_unknown_provider_raises():
    with pytest.raises(ValueError):
        build_backend("s3", upload_dir="/tmp/x", figures_dir="/tmp/y")


# --- Coverage carried over from the old api/tests/test_storage.py, whose
# target module (api.storage.local) no longer exists post-DUP-2 — the
# class now lives here, so the behavioral coverage moves with it.


def test_local_release_local_is_noop(local):
    ref = local.save_pdf("uid", "pid", b"bytes")
    local.release_local(ref)
    assert os.path.exists(ref)


def test_local_delete_pdf_idempotent(local):
    local.save_pdf("uid", "pid", b"x")
    local.delete_pdf("uid", "pid")
    # Second call must not raise even though the file is gone
    local.delete_pdf("uid", "pid")


def test_local_save_figure_rejects_traversal(local):
    with pytest.raises(ValueError):
        local.save_figure("uid", "pid", "../evil.png", b"x")
    with pytest.raises(ValueError):
        local.save_figure("uid", "pid", "sub/file.png", b"x")
    with pytest.raises(ValueError):
        local.save_figure("uid", "pid", ".hidden", b"x")


def test_local_delete_paper_artifacts_removes_all(local):
    local.save_pdf("uid", "pid", b"pdf")
    local.save_figure("uid", "pid", "a.png", b"a")
    local.save_figure("uid", "pid", "b.png", b"b")

    local.delete_paper_artifacts("uid", "pid")

    assert not os.path.exists(local._pdf_path("pid"))
    assert not os.path.isdir(local._figure_dir("pid"))
    # Idempotent second call
    local.delete_paper_artifacts("uid", "pid")


def test_local_figure_image_url_is_signed(local):
    url = local.figure_image_url(
        "uid", "paper-1", "fig-2", image_path="ignored", ttl=600,
    )
    assert url.startswith("/figures/paper-1/fig-2?token=")


def test_local_storage_takes_injected_dirs_not_settings(tmp_path):
    """Config is injected — construct directly, no `config.settings` involved."""
    inst = LocalStorage(str(tmp_path / "up"), str(tmp_path / "fig"))
    ref = inst.save_pdf("u", "p", b"x")
    assert ref.endswith("p.pdf")

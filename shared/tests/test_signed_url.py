import pytest

from ficino_shared import signed_url


def test_sign_verify_roundtrip():
    token = signed_url.sign_resource("figure-123", ttl=60)
    assert signed_url.verify_token("figure-123", token)


def test_verify_rejects_wrong_resource():
    token = signed_url.sign_resource("figure-123", ttl=60)
    assert not signed_url.verify_token("figure-456", token)


def test_expired_token_rejected():
    token = signed_url.sign_resource("figure-123", ttl=-1)
    assert not signed_url.verify_token("figure-123", token)


def test_fail_closed_in_production(monkeypatch):
    """`sign_resource`/`verify_token` use a key cached at module import time
    (`_SIGNING_KEY = _resolve_signing_key()`), so monkeypatching env vars and
    then calling `sign_resource` would exercise the cached key, not the
    fail-closed branch -- it wouldn't actually test anything. `_resolve_signing_key`
    itself has no cached state (it reads os.getenv fresh on every call), so we
    call it directly to exercise the fail-closed guarantee: production with no
    SIGNED_URL_KEY must refuse to resolve a (forgeable) fallback key.
    """
    monkeypatch.delenv("SIGNED_URL_KEY", raising=False)
    monkeypatch.setenv("ENVIRONMENT", "production")
    with pytest.raises(RuntimeError):
        signed_url._resolve_signing_key()

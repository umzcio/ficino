"""R10 WORK-3: apply_provider_settings wrote os.environ only for truthy
values and never reverted, so user A's ANTHROPIC_API_KEY survived into
user B's task and get_active's env fallback returned it."""
import json
import os


def _install_fake_rows(monkeypatch, rows: dict[str, dict]):
    from lib import settings as ws

    def fake_fetchrow(query, uid):
        if uid in rows:
            return {"settings": json.dumps(rows[uid])}
        return None

    monkeypatch.setattr(ws, "fetchrow", fake_fetchrow)


def _reset_module_state():
    from lib import settings as ws
    ws._active_settings.clear()
    ws._baseline_env.clear()


def test_no_key_leak_between_users(monkeypatch):
    from lib import settings as ws

    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("PUBLIC_DEPLOYMENT", raising=False)
    _reset_module_state()
    _install_fake_rows(monkeypatch, {
        "user-a": {"anthropic_api_key": "sk-user-a"},
        "user-b": {"llm_provider": "api"},  # paid provider, no key of their own
    })

    ws.apply_provider_settings("user-a")
    assert os.environ.get("ANTHROPIC_API_KEY") == "sk-user-a"

    ws.apply_provider_settings("user-b")
    assert ws.get_active("anthropic_api_key", "ANTHROPIC_API_KEY", "") == "", (
        "user B must NOT resolve user A's key via the env fallback (R10 WORK-3)"
    )
    assert os.environ.get("ANTHROPIC_API_KEY") is None


def test_operator_baseline_is_restored(monkeypatch):
    from lib import settings as ws

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-operator")
    monkeypatch.delenv("PUBLIC_DEPLOYMENT", raising=False)
    _reset_module_state()
    _install_fake_rows(monkeypatch, {
        "user-a": {"anthropic_api_key": "sk-user-a"},
        "user-b": {},
    })

    ws.apply_provider_settings("user-a")
    assert os.environ.get("ANTHROPIC_API_KEY") == "sk-user-a"

    ws.apply_provider_settings("user-b")
    assert os.environ.get("ANTHROPIC_API_KEY") == "sk-operator", (
        "empty user value restores the operator baseline, not user A's key"
    )


def test_public_deployment_reassert_wins_over_stale_user_value(monkeypatch):
    from lib import settings as ws

    monkeypatch.setenv("PUBLIC_DEPLOYMENT", "true")
    monkeypatch.setenv("LLM_PROVIDER", "api")
    _reset_module_state()
    _install_fake_rows(monkeypatch, {
        "user-a": {"llm_provider": "ollama"},  # stale self-host value
    })

    ws.apply_provider_settings("user-a")
    assert os.environ.get("LLM_PROVIDER") == "api", (
        "under PUBLIC_DEPLOYMENT the operator env must win in os.environ too, "
        "not just in _active_settings"
    )
    assert ws.get_active("llm_provider", "LLM_PROVIDER", "") == "api"

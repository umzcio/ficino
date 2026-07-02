import os
from ficino_shared import settings_schema as sch


def test_defaults_cover_every_env_mapped_key():
    missing = set(sch.SETTINGS_TO_ENV) - set(sch.DEFAULTS)
    assert not missing, f"env-mapped keys absent from DEFAULTS: {missing}"


def test_new_provider_keys_present_and_protected():
    for key in ("figure_detect_provider", "figure_detect_ollama_model",
                "figure_detect_anthropic_model", "openai_embed_model"):
        assert key in sch.DEFAULTS
        assert key in sch.SETTINGS_TO_ENV
        assert key in sch.PROVIDER_OVERRIDE_KEYS, (
            f"{key} affects billing/provider routing — must be operator-locked "
            "under PUBLIC_DEPLOYMENT"
        )


def test_secret_keys_subset_of_defaults():
    assert sch.SECRET_KEYS <= set(sch.DEFAULTS)


def test_merge_is_dict_aware():
    merged = sch.merge_settings({"personas_enabled": {"skeptic": False}})
    assert merged["personas_enabled"]["skeptic"] is False
    assert merged["personas_enabled"]["hype"] is True  # default preserved


def test_reassert_reads_baseline_not_live_env(monkeypatch):
    monkeypatch.setenv("PUBLIC_DEPLOYMENT", "true")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    sch.reset_baseline_for_tests()
    # Simulate a previous apply poisoning live env:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-poisoned")
    merged = sch.reassert_public_deployment(sch.merge_settings({}))
    assert merged.get("anthropic_api_key") != "sk-poisoned", (
        "reassert must read the operator baseline, not live env "
        "(wave-1 final-review fix, must survive the move)"
    )

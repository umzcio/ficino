"""R10 WORK-2: generate_podcast_for_feed ran retrieval embeddings and an
LLM script call under whatever provider settings the previous task left
in this process — the Round 9 C1-C4 bug class, shipped post-remediation."""


def test_podcast_task_applies_owner_settings(monkeypatch):
    import tasks.audio_tasks as at

    applied: list[str] = []
    claimed_row = {"user_id": "aaaaaaaa-0000-0000-0000-000000000001", "corpus_id": None, "posts": []}

    monkeypatch.setattr(at, "fetchrow", lambda *a: claimed_row, raising=True)
    monkeypatch.setattr(at, "execute", lambda *a: None, raising=True)
    # raising=False: before the fix the name doesn't exist on the module.
    monkeypatch.setattr(
        at, "apply_provider_settings",
        lambda uid: applied.append(uid) or {}, raising=False,
    )

    def _boom(**kwargs):
        raise RuntimeError("stop before real work")
    monkeypatch.setattr(at, "build_podcast_script", _boom, raising=True)

    # .apply() runs the bound task eagerly, no broker needed.
    result = at.generate_podcast_for_feed.apply(args=["feed-1"])
    assert result.state == "FAILURE"  # our sentinel stopped it after the claim

    assert applied == [claimed_row["user_id"]], (
        "apply_provider_settings(owner_user_id) must run after the claim, "
        "before any retrieval/LLM work (R10 WORK-2)"
    )

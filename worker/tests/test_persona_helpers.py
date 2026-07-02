"""R10 Wave-3 Task 6: DUP-6 / DUP-12 shared helpers.

  - DUP-6:  persona_lib.build_post_sources collapses 4 byte-identical
            dict-comprehension copies (persona_tasks x2, reading_list_tasks,
            archivist_tasks) into one canonical helper.
  - DUP-12: persona_lib.resolve_enabled_personas collapses the opt-out
            enablement block copied between persona_tasks.generate_feed and
            reading_list_tasks.generate_chapter; archivist_tasks._get_paper_ids
            collapses the byte-identical paper-scoping query pair used by
            respond_to_user_post / respond_to_user_post_followup.
"""


def test_build_post_sources_key_shape_and_truncation():
    from lib import persona as persona_lib

    chunks = [
        {
            "id": f"chunk-{i}",
            "paper_id": f"paper-{i}",
            "paper_title": f"Title {i}",
            "section": "results",
            "content": "x" * 400,
            "score": 0.123456,
        }
        for i in range(8)
    ]

    sources = persona_lib.build_post_sources(chunks)

    assert len(sources) == 5, "default top_n must cap at 5"
    for src in sources:
        assert set(src.keys()) == {
            "chunk_id", "paper_id", "paper_title", "section", "content", "score",
        }
        assert len(src["content"]) == 300, "content must truncate to 300 chars"
    assert sources[0]["score"] == 0.123
    assert [s["chunk_id"] for s in sources] == [f"chunk-{i}" for i in range(5)]


def test_build_post_sources_respects_top_n():
    from lib import persona as persona_lib

    chunks = [{"id": f"c{i}", "content": "y"} for i in range(4)]

    sources = persona_lib.build_post_sources(chunks, top_n=2)

    assert len(sources) == 2
    assert [s["chunk_id"] for s in sources] == ["c0", "c1"]


def test_build_post_sources_falls_back_to_paper_filename():
    from lib import persona as persona_lib

    chunks = [{"id": "c0", "paper_filename": "raw.pdf", "content": "z"}]

    sources = persona_lib.build_post_sources(chunks)

    assert sources[0]["paper_title"] == "raw.pdf"


def test_resolve_enabled_personas_is_opt_out(monkeypatch):
    """Personas default to enabled unless explicitly set False — a persona
    absent from personas_enabled (e.g. added via migration after a user's
    dict was seeded) must still generate (R10 DUP-12)."""
    from lib import persona as persona_lib

    monkeypatch.setattr(persona_lib, "get_personas", lambda: {
        "skeptic": {"feed_eligible": True},
        "practitioner": {"feed_eligible": True},
        "amplifier": {"feed_eligible": True},  # not in personas_enabled below
        "archivist": {"feed_eligible": False},  # reply-only, never in the set
    })

    enabled = persona_lib.resolve_enabled_personas(
        {"personas_enabled": {"skeptic": True, "practitioner": False}}
    )

    assert enabled == {"skeptic", "amplifier"}


def test_resolve_enabled_personas_handles_missing_settings(monkeypatch):
    """No personas_enabled key at all (missing settings dict key, not an
    empty dict) — opt-out semantics mean everything feed-eligible stays on."""
    from lib import persona as persona_lib

    monkeypatch.setattr(persona_lib, "get_personas", lambda: {
        "skeptic": {"feed_eligible": True},
        "archivist": {"feed_eligible": False},
    })

    assert persona_lib.resolve_enabled_personas({}) == {"skeptic"}


def test_archivist_get_paper_ids_scopes_by_corpus(monkeypatch):
    from tasks import archivist_tasks as at

    calls = []

    def _fake_fetchrow(query, *args):
        calls.append((query, args))
        return {"ids": ["p1", "p2"]}

    monkeypatch.setattr(at, "fetchrow", _fake_fetchrow, raising=True)

    ids = at._get_paper_ids("user-1", "corpus-1")

    assert ids == ["p1", "p2"]
    assert len(calls) == 1
    query, args = calls[0]
    assert "corpus_id = $1 AND user_id = $2" in query
    assert args == ("corpus-1", "user-1")


def test_archivist_get_paper_ids_no_corpus_scopes_by_user_only(monkeypatch):
    from tasks import archivist_tasks as at

    calls = []

    def _fake_fetchrow(query, *args):
        calls.append((query, args))
        return {"ids": ["p3"]}

    monkeypatch.setattr(at, "fetchrow", _fake_fetchrow, raising=True)

    ids = at._get_paper_ids("user-1", None)

    assert ids == ["p3"]
    query, args = calls[0]
    assert "corpus_id" not in query
    assert "WHERE user_id = $1" in query
    assert args == ("user-1",)


def test_archivist_get_paper_ids_empty_when_no_rows(monkeypatch):
    from tasks import archivist_tasks as at

    monkeypatch.setattr(at, "fetchrow", lambda *a: {"ids": None}, raising=True)

    assert at._get_paper_ids("user-1", None) == []

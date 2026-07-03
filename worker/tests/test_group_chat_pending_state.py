"""Wave-5 Task 4 (completing W4's ticket): generate_corpus_synthesis must
mirror generate_paper_summary's retry-exhaustion pattern — mark the
placeholder row status='error' (task_id cleared) instead of leaving it
stuck at 'generating' forever with a dead task_id, once the API's
create_group_chat inserts that placeholder at dispatch time.
"""
from __future__ import annotations


def test_generate_corpus_synthesis_marks_error_on_retry_exhaustion(monkeypatch):
    import tasks.summary_tasks as st

    updates: list[tuple[str, tuple]] = []

    # No existing row short-circuits the idempotency guard (falsy => proceed).
    monkeypatch.setattr(st, "fetchrow", lambda *a, **kw: None, raising=True)
    # No chunks for any paper -> `if not paper_sections: raise ValueError(...)`
    # inside the try block, without needing to reach the LLM call at all.
    monkeypatch.setattr(st, "fetch", lambda *a, **kw: [], raising=True)
    monkeypatch.setattr(st, "apply_provider_settings", lambda uid: {}, raising=True)

    def _record_execute(query, *args):
        updates.append((query, args))
        return "UPDATE 1"
    monkeypatch.setattr(st, "execute", _record_execute, raising=True)

    synthesis_id = "11111111-2222-3333-4444-555555555555"

    # .apply(retries=2) runs the bound task eagerly with
    # self.request.retries == 2 == max_retries, so the except block's
    # "if self.request.retries < self.max_retries: raise self.retry(...)"
    # is False on the first (and only) attempt — exercising the
    # exhaustion path directly instead of looping through real retries.
    result = st.generate_corpus_synthesis.apply(
        args=[synthesis_id, ["paper-a", "paper-b"], "Test synth", "user-1"],
        retries=2,
    )
    assert result.state == "FAILURE"

    error_updates = [u for u in updates if "status = 'error'" in u[0]]
    assert error_updates, (
        "retry exhaustion must UPDATE corpus_syntheses SET status='error', "
        "task_id=NULL — mirrors generate_paper_summary's wave-1-era pattern "
        "(Wave-5 Task 4)"
    )
    query, args = error_updates[0]
    assert args == (synthesis_id,)

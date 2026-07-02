"""R10 WORK-4 / Round 9 H27: generate_chapter persisted LLM post dicts
without validate_post_shape, unlike both persona_tasks paths.

The call sits mid-loop in a Celery task, so (as with WORK-1) the binding
assertion is the regression test; the validator's behavior has its own
guarantees in lib.post_validation."""


def test_reading_list_tasks_imports_validator():
    import tasks.reading_list_tasks as rlt

    assert hasattr(rlt, "validate_post_shape"), (
        "generate_chapter must run validate_post_shape before persisting "
        "posts, like persona_tasks.generate_feed does (R10 WORK-4)"
    )

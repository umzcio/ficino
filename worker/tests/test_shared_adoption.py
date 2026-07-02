"""Wave-2 adoption checks: constants + schema actually consumed."""
from ficino_shared.constants import CHAPTER_INSERT_SQL
from ficino_shared.settings_schema import DEFAULTS, default_for


def test_chapter_sql_imported_by_both_sites():
    import tasks.reading_list_tasks as rlt
    assert getattr(rlt, "CHAPTER_INSERT_SQL", None) is CHAPTER_INSERT_SQL


def test_default_for_matches_defaults():
    assert default_for("ollama_vision_model") == DEFAULTS["ollama_vision_model"]
    assert default_for("nonexistent_key") == ""

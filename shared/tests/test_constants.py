"""The sentinel IDs are load-bearing across three codebases — pin them."""
from ficino_shared import constants


def test_sentinel_ids_are_stable():
    assert constants.STUB_USER_ID == "00000000-0000-0000-0000-000000000000"
    assert constants.DEFAULT_WORKSPACE_ID == "00000000-0000-0000-0000-000000000001"


def test_chapter_sql_encodes_first_unlocked():
    assert "'unlocked'" in constants.CHAPTER_INSERT_SQL
    assert "'locked'" in constants.CHAPTER_INSERT_SQL
    assert "WITH ORDINALITY" in constants.CHAPTER_INSERT_SQL

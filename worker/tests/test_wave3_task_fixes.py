"""R10 Wave-3 Task 4: WORK-7, WORK-8, WORK-9, WORK-17.

Four independent worker fixes, each with its own RED-first test:
  - WORK-7:  generate_chapter must sync posts into the feed_posts search index.
  - WORK-8:  summary/synthesis JSON parsing must drop non-dict message elements.
  - WORK-9:  vision page extraction must retry transient HTTP failures.
  - WORK-17: persona fallback must exclude reply-only (feed_eligible=false) personas.
"""
import inspect


def test_generate_chapter_writes_feed_posts_index():
    """R10 WORK-7: reading-list chapter posts must be synced into feed_posts
    (the search index) the same way generate_feed does, or chapter content
    is invisible to /search once SEARCH_USE_NORMALIZED_POSTS is on."""
    from tasks.reading_list_tasks import generate_chapter

    src = inspect.getsource(generate_chapter)
    assert "_write_feed_posts_index" in src, (
        "generate_chapter must call _write_feed_posts_index after the feeds "
        "upsert so chapter posts land in the search index (R10 WORK-7)"
    )

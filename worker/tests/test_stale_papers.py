"""R10 WORK-6: the stale-paper query treated papers as 'never in a feed'
even when they were debated in all-papers feeds (feeds.corpus_id IS NULL),
because the NOT EXISTS only matched corpus-scoped feeds."""


def test_stale_query_counts_null_corpus_feeds():
    import tasks.alert_tasks as at
    import inspect
    src = inspect.getsource(at.check_stale_papers)
    assert "corpus_id IS NULL" in src, (
        "the NOT EXISTS must also match all-papers feeds (feeds.corpus_id "
        "IS NULL) owned by the same user (R10 WORK-6)"
    )
    assert "f.user_id = p.user_id" in src, (
        "feed ownership must scope the existence check — another user's "
        "all-papers feed must not mark this user's paper as used"
    )

"""Shared text-handling helpers used across routers (R10 BP-14).

Previously `escape_like` lived as a private `_escape_like` inside
`routers/replies.py` and was imported cross-router by `routers/search.py`
— an underscore-private function imported outside its defining module,
which breaks the underscore contract and silently couples the two routers
(a rename/move inside replies.py would break search.py with no local
signal). Public and shared here instead.
"""


def escape_like(s: str) -> str:
    """Escape LIKE/ILIKE metacharacters so user input is matched literally.

    Without this, a value containing `%` or `_` would wildcard-match
    across the caller's data — e.g. a search term of `"%"` would grab
    everything the DB happened to return first. Backslashes must be
    escaped first (otherwise we double-escape the escape char). Postgres
    honors `\\` as the default LIKE escape char.
    """
    return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")

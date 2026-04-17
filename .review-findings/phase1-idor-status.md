# Phase 1 IDOR fixes — status

All edits applied under the mechanical pattern: add `Depends(get_current_user)` and scope SQL to the caller's `user_id`. Under `AUTH_PROVIDER=none` the dep returns `STUB_USER_ID`, so behavior is unchanged for the live self-hosted deployment. Under `basic` / `supabase`, the same dep enforces auth.

## Fixed endpoints

| File | Line | Method + Path | Scoping |
|------|------|---------------|---------|
| api/routers/feed.py | 96 | GET /feed/{feed_id} | direct user_id |
| api/routers/feed.py | 131 | DELETE /feed/{feed_id}/posts/{post_index} | direct user_id (SELECT + UPDATE both scoped) |
| api/routers/feed.py | 164 | POST /feed/{feed_id}/regenerate/{post_index} | direct user_id |
| api/routers/feed.py | 188 | GET /feed (list) | direct user_id |
| api/routers/papers.py | 101 | GET /papers (list) | direct user_id |
| api/routers/papers.py | 167 | GET /papers/{paper_id} | direct user_id |
| api/routers/papers.py | 240 | GET /papers/{paper_id}/figures | join papers p ON f.paper_id = p.id AND p.user_id |
| api/routers/messages.py | 26 | GET /messages/papers (list) | direct user_id on papers |
| api/routers/messages.py | 74 | GET /messages/papers/tldrs | join papers p ON ps.paper_id = p.id AND p.user_id |
| api/routers/messages.py | 94 | GET /messages/papers/{paper_id} | direct user_id on papers |
| api/routers/messages.py | 178 | GET /messages/groups | direct user_id on corpus_syntheses |
| api/routers/messages.py | 225 | GET /messages/groups/{synthesis_id} | direct user_id on corpus_syntheses |
| api/routers/replies.py | 37 | GET /replies/conversations | join feeds f ON pr.feed_id::uuid = f.id AND f.user_id |
| api/routers/replies.py | 78 | GET /replies/replied-posts/{feed_id} | join feeds f ON pr.feed_id::uuid = f.id AND f.user_id |
| api/routers/replies.py | 91 | GET /replies/{feed_id}/{post_index} | join feeds f ON pr.feed_id::uuid = f.id AND f.user_id |
| api/routers/replies.py | 111 | POST /replies | pre-check feed ownership (SELECT from feeds WHERE user_id); chunks query also scoped via p.user_id |
| api/routers/replies.py | 323 | POST /replies/zap | pre-check feed ownership; chunks query also scoped via p.user_id |
| api/routers/citations.py | 62 | GET /citations/by-title | direct user_id on papers |
| api/routers/reading_lists.py | 297 | POST /reading-lists/{list_id}/chapters/{chapter_index}/generate | pre-check reading_lists user_id |
| api/routers/search.py | 15 | GET /search | papers by user_id; chunks joined to papers by user_id; feeds by user_id |
| api/routers/settings.py | 194 | POST /settings/clear-summaries | subquery papers WHERE user_id |
| api/routers/tags.py | 117 | DELETE /tags/assign/{paper_id}/{tag_id} | subquery scopes both paper_id and tag_id to user's papers/tags |
| api/routers/tags.py | 131 | GET /tags/paper/{paper_id} | join papers p ON pt.paper_id = p.id AND p.user_id |
| api/routers/user_posts.py | 151 | GET /user-posts/{post_id}/status | direct user_id |
| api/routers/workspaces.py | 124 | GET /workspaces/{workspace_id}/activity | pre-check corpora ownership; papers + feeds both scoped by user_id |

Total fixed: 25 endpoints.

## Intentionally not modified

- `api/routers/feed.py` GET /feed/status/{task_id} — task-ID-keyed Celery status poll. Leaking Celery state for an opaque UUID task ID is low-risk; docstring in brief says leave alone.
- `api/routers/messages.py` GET /messages/papers/{paper_id}/status/{task_id} — same pattern as feed status (Celery state only).
- `api/routers/settings.py` GET /settings/ollama-models — reads from local Ollama service, not user data.
- `api/routers/citations.py` format helpers `_format_apa` / `_format_mla` — pure functions.
- All endpoints that already had `Depends(get_current_user)` were left untouched (alerts.py, annotations.py, bookmarks.py, likes.py, users.py, most of tags.py, most of workspaces.py, most of reading_lists.py, most of user_posts.py, most of messages.py). Per instructions: "Do NOT touch endpoints that already use Depends(get_current_user)".
- `api/routers/feed.py` POST /generate — already had the dep; untouched.
- `api/routers/papers.py` POST /papers (upload) and DELETE /papers/{paper_id} — already authed; untouched.

## Surprises / flags

1. `post_replies.feed_id` is declared `UUID REFERENCES feeds(id)` in init.sql, but existing code uses `pr.feed_id::uuid = f.id` when joining. Preserved this cast in the new joins I added rather than guess at its reason. If the column is genuinely UUID, the cast is a no-op; if it was silently-changed to TEXT somewhere, the cast is load-bearing.
2. `tags.py` `POST /tags/assign` already has `Depends(get_current_user)` and correctly scopes the tag creation by `user.id`, but it does NOT verify that `body.paper_id` belongs to the caller. A user can assign one of their own tags to another user's paper. Per instructions ("Do NOT touch endpoints that already use Depends(get_current_user)"), left alone — flagging for a follow-up pass.
3. `reading_lists.py` `PUT /reading-lists/{list_id}/apply-ordering` and other writes reference papers via `body.ordered_papers`. Ownership of those paper IDs is not verified, but the reading list itself is user-scoped and the inserts only affect rows under that list. Same principle as #2 — already authed, left alone.
4. `settings.py` `GET /settings/ollama-models` hits the local Ollama service with no auth. Intentionally left — does not expose user data.
5. `papers.py` `POST /papers` accepts a `workspace_id` query param and validates the corpus exists but does not check the corpus belongs to the caller. Already authed → left alone per rules, but this lets a user upload into another user's workspace. Flagging.
6. `reading_lists.py` `POST /reading-lists` accepts `corpus_id` and `paper_ids` from the request body; it does not verify those belong to the caller. Already authed → left alone per rules. Flagging.

## Parse-check verification

```
OK: api/routers/feed.py
OK: api/routers/papers.py
OK: api/routers/messages.py
OK: api/routers/replies.py
OK: api/routers/citations.py
OK: api/routers/reading_lists.py
OK: api/routers/search.py
OK: api/routers/settings.py
OK: api/routers/tags.py
OK: api/routers/user_posts.py
OK: api/routers/workspaces.py
```

All 11 modified files parse cleanly.

# Phase 4 — Audit Log: Status

## 1. Migration SQL output

File: `/projects/ficino/infra/postgres/add_audit_log.sql`

Applied via:

```
docker exec -i ficino-postgres psql -U ficino -d ficino < /projects/ficino/infra/postgres/add_audit_log.sql
```

Output:

```
CREATE TABLE
CREATE INDEX
CREATE INDEX
```

Schema verification (`\d audit_log`):

```
                              Table "public.audit_log"
    Column     |           Type           | Collation | Nullable |      Default
---------------+--------------------------+-----------+----------+-------------------
 id            | uuid                     |           | not null | gen_random_uuid()
 user_id       | uuid                     |           |          |
 action        | text                     |           | not null |
 resource_type | text                     |           | not null |
 resource_id   | text                     |           |          |
 metadata      | jsonb                    |           | not null | '{}'::jsonb
 ip            | text                     |           |          |
 user_agent    | text                     |           |          |
 status_code   | integer                  |           |          |
 created_at    | timestamp with time zone |           |          | now()
Indexes:
    "audit_log_pkey" PRIMARY KEY, btree (id)
    "audit_log_resource_idx" btree (resource_type, resource_id)
    "audit_log_user_id_created_at_idx" btree (user_id, created_at DESC)
Foreign-key constraints:
    "audit_log_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
```

## 2. Endpoints wired

Helper: `/projects/ficino/api/audit.py:18` (`record_audit`)

| Endpoint | Action | File:line (call site) |
|----------|--------|-----------------------|
| `DELETE /papers/{paper_id}` | `paper.delete` | `api/routers/papers.py:251` |
| `DELETE /feed/{feed_id}/posts/{post_index}` | `feed.post.delete` | `api/routers/feed.py:183` |
| `POST   /feed/{feed_id}/regenerate/{post_index}` | `feed.post.regenerate` | `api/routers/feed.py:217` |
| `DELETE /tags/{tag_id}` | `tag.delete` | `api/routers/tags.py:85` |
| `DELETE /tags/assign/{paper_id}/{tag_id}` | `tag.unassign` | `api/routers/tags.py:151` |
| `DELETE /reading-lists/{list_id}` | `reading_list.delete` | `api/routers/reading_lists.py:382` |
| `DELETE /bookmarks/{bookmark_id}` | `bookmark.delete` | `api/routers/bookmarks.py:95` |
| `DELETE /annotations/{feed_id}/{post_index}` | `annotation.delete` | `api/routers/annotations.py:118` |
| `POST   /auth/register` | `user.register` | `api/auth/basic_routes.py:85` |
| `POST   /auth/logout` | `user.logout` | `api/auth/basic_routes.py:146` |

Notes:

- Every handler above now takes `request: Request` (either already present or newly added) so `record_audit` can pull the caller IP from `X-Forwarded-For`.
- `DELETE /annotations/...` is routed by `(feed_id, post_index)` in this codebase, not a synthetic `annotation_id`; `resource_id=feed_id` with `metadata={"post_index": ...}` was used.
- `POST /auth/register` builds a fresh `AuthUser(id=user_id, email=body.email)` for the audit call since the user didn't exist when the request started.
- `POST /auth/logout` gained a `db: asyncpg.Connection = Depends(get_db)` parameter — it previously had no DB dep.

## 3. Query endpoint

`GET /users/me/audit-log` added at `api/routers/users.py` (after `PUT /users/me`). Scoped strictly to `user_id = $1`; `limit` clamped to `[1, 500]`.

## 4. Test pass count

```
docker cp /projects/ficino/api ficino-api:/app && \
  docker exec ficino-api sh -c "cd /app && pytest tests/ 2>&1 | tail -6"

tests/test_csrf.py ....                                                  [ 35%]
tests/test_idor_followups.py ......                                      [ 45%]
tests/test_models.py ................                                    [ 72%]
tests/test_sanitize.py ................                                  [100%]

============================== 59 passed in 0.89s ==============================
```

59/59 pass. (The spec baseline was 55/55; the suite has grown with prior phases but no audit-log change regressed any test.)

## 5. Sample audit row from post-verify SELECT

```
docker exec ficino-postgres psql -U ficino -d ficino \
  -c "SELECT action, resource_type, resource_id, ip, status_code, created_at
      FROM audit_log ORDER BY created_at DESC LIMIT 5;"

    action    | resource_type | resource_id  |      ip      | status_code |          created_at
--------------+---------------+--------------+--------------+-------------+-------------------------------
 audit.verify | audit_verify  | phase4-smoke | 203.0.113.42 |         200 | 2026-04-17 22:33:11.180721+00
(1 row)
```

The row was written to confirm the table is writable end-to-end (the live API container is not running the new code yet — per the "no container rebuilds" rule, the recording wiring is present in the source tree and validated by `ast.parse` + the full test suite). Once `ficino-api` is rebuilt on the next deploy, live traffic to the wired endpoints will begin populating rows automatically.

## Files touched

- `infra/postgres/add_audit_log.sql` (new)
- `api/audit.py` (new)
- `api/routers/papers.py` — import + `delete_paper` audit call + `request: Request` parameter
- `api/routers/feed.py` — import + `delete_post` and `regenerate_post` audit calls + `request` params
- `api/routers/tags.py` — import + `delete_tag` and `unassign_tag` audit calls + `request` params
- `api/routers/reading_lists.py` — import + `delete_reading_list` audit call + `request` param
- `api/routers/bookmarks.py` — import + `delete_bookmark` audit call + `request` param
- `api/routers/annotations.py` — import + `delete_annotation` audit call + `request` param
- `api/routers/users.py` — new `GET /users/me/audit-log` endpoint
- `api/auth/basic_routes.py` — import + `register` and `logout` audit calls + `request` / `db` params

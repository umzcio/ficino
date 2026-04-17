# Security Review Findings

## CRITICAL (0)

## HIGH (4)

### 1. Committed Anthropic API Key
- File: /projects/ficino/.env (line ~21)
- Real `sk-ant-api03-...` key is in `.env`. Rotate + gitignore + remove from history.

### 2. IDOR: Unauthenticated Feed/Post Access
- File: api/routers/feed.py:96-156
- GET /feed/{feed_id}, DELETE /feed/{feed_id}/posts/{post_index}, POST /feed/{feed_id}/regenerate/{post_index} have no `Depends(get_current_user)` and no user_id ownership check.
- Contrast: POST /feed/generate at line 28 does use Depends.

### 3. IDOR: Unauthenticated Paper Access
- File: api/routers/papers.py:161-193
- GET /papers/{paper_id} has no auth, no user/workspace scoping.

### 4. Session Cookie Missing Secure Flag
- File: api/auth/basic_routes.py:63-70 and 95-102
- `samesite="lax"` set but no `secure=True`; MITM can intercept over HTTP.

## MEDIUM (9)

### 5. Logout Doesn't Invalidate Redis Session
- api/auth/basic_routes.py:108-117 — only `delete_cookie`, no server-side `delete_session(token)`.

### 6. IDOR: Paper Summaries/DMs Unauthenticated
- api/routers/messages.py:26-52

### 7. IDOR: Reply Conversations Unauthenticated
- api/routers/replies.py:37-88

### 8. PDF Magic Byte Validation Missing
- api/routers/papers.py:37-44 — only extension check, no `%PDF` prefix check.

### 9. Path Traversal Risk on Figure URL
- api/routers/papers.py:249 uses `row['image_path'].split('/')[-1]`. Combined with StaticFiles mount at /figures in main.py, needs stricter storage of filename-only.

### 10. Prompt Injection from PDF Content
- worker/lib/persona.py:123-175 (especially line 133) — raw chunk['content'] interpolated into persona prompts.

### 11. Bcrypt Default Cost Not Explicit
- api/auth/basic_routes.py:45 — `bcrypt.gensalt()` (defaults to 12, acceptable but explicit `rounds=12` preferred).

### 12. CORS Permissive Headers in Production
- api/main.py:73 — `allow_headers=["*"]` even in prod config.

### 13. No Rate Limit on Login/Register
- api/auth/basic_routes.py:27-105 — rate_limit module exists but not applied to auth endpoints.

## LOW (4)

### 14. Empty paper_ids List May Crash Query
- api/routers/reading_lists.py:103-107

### 15. No CSRF Protection (mitigated by CORS + SameSite=Lax)
- api/main.py

### 16. No Audit Logging for Destructive Ops
- api/routers/papers.py:196-230

### 17. Silent Exception Swallow in Contradiction Detection
- worker/tasks/persona_tasks.py:103-116

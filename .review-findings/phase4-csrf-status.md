# Phase 4 — CSRF Double-Submit Cookie Protection

Status: **DONE**. 59/59 pytest passing.

## What changed

Double-submit cookie CSRF protection added across API + frontend, with the
middleware short-circuiting under `AUTH_PROVIDER=none` so the self-hosted
single-user mode is unaffected.

### File diffs summary

| File | Change | Lines |
|---|---|---|
| `api/csrf.py` | **new** — `CsrfMiddleware` (double-submit, exempt list, bypass when auth=none, issue cookie on GET/HEAD when absent) | +77 |
| `api/main.py` | import `CsrfMiddleware`, add `"X-CSRF-Token"` to prod `allow_headers`, register middleware between CORS and SecurityHeaders | +6 |
| `frontend/src/lib/api.ts` | add `getCsrfToken()` reader, attach `X-CSRF-Token` header on POST/PUT/DELETE/PATCH inside the shared `request<T>()` wrapper | +17 |
| `api/tests/test_csrf.py` | **new** — 4 tests: bypass under auth=none, 403 when missing under basic, exempt login path, accept matching cookie+header | +59 |

### Middleware contract

- Cookie `ficino_csrf`: 32-byte URL-safe random token, SameSite=Lax, HttpOnly=false
  (JS needs to read it for the double-submit), Secure when `environment !=
  "development"`, 7-day max-age, path `/`.
- Issued on GET/HEAD responses only when the request didn't already carry the
  cookie. Prevents token churn on every request.
- Enforced on POST/PUT/DELETE/PATCH; `secrets.compare_digest(cookie, header)`
  constant-time comparison; 403 JSON on mismatch.
- Exempt paths: `POST /auth/login`, `POST /auth/register` — client may not
  have a cookie yet on brand-new sessions.
- Complete bypass when `settings.auth_provider == "none"` (documented).

### Middleware ordering

`main.py` registers `CORSMiddleware` → `CsrfMiddleware` → `SecurityHeadersMiddleware`
via `app.add_middleware` in that order. Starlette wraps each newly added
middleware around the previous ones (`user_middleware.insert(0, …)`), so the
runtime order on the way in is: SecurityHeaders → CSRF → CORS → route. The
request-side effect is that CORS still gets to answer preflights, CSRF still
sees cookies/headers, and SecurityHeaders decorates the final response on the
way out. Preflights (`OPTIONS`) are never in `CSRF_PROTECTED_METHODS`, so they
pass through.

### Frontend

`request<T>()` computes the effective method (`init.method`, else `'POST'`
when `init.body` is present, else `'GET'`) and attaches `X-CSRF-Token` only
for state-changing methods when the cookie is readable. `getCsrfToken()`
returning null means the header is simply not attached — safe under
`AUTH_PROVIDER=none` because the middleware skips validation entirely.

## Test results

```
============================== 59 passed in 0.90s ==============================
```

New tests:
- `test_csrf_bypassed_in_auth_none` — GET /health under auth=none, no header required.
- `test_csrf_required_when_auth_basic` — POST /feed/generate without header → 403.
- `test_csrf_exempt_login` — POST /auth/login → not 403 (exempt).
- `test_csrf_accepts_matching_cookie_and_header` — matching cookie+header → not 403.

## Smoke test

`curl -sk https://ficino.local/ficino/api/health` → 200 OK, no
`Set-Cookie: ficino_csrf` header (expected under `AUTH_PROVIDER=none`).

## Surprises / notes

- No routes in the codebase use POST for idempotent reads, so no additional
  entries needed in `CSRF_EXEMPT_PATHS` beyond login/register.
- `auth/basic_routes.py` is only mounted when `settings.auth_provider ==
  "basic"` (checked at startup). Tests monkeypatch `settings.auth_provider`
  to "basic" *after* startup; `/auth/login` therefore 404s in test, but
  the CSRF middleware still treats the path as exempt and returns !=403,
  which is what the test asserts.
- Prod CORS `allow_headers` needed `X-CSRF-Token` added (dev uses `*`). Done.
- Secure-cookie-in-prod relies on `settings.environment != "development"`.
  The test suite sets `ENVIRONMENT=test`, so tests exercise the Secure=True
  branch, and prod (`environment=production` or similar) likewise.
- The cookie is refreshed **only** when absent; preserves a token across its
  7-day life without being overwritten every GET.

## Deliverables

No commits. Files written:
- `/projects/ficino/api/csrf.py`
- `/projects/ficino/api/tests/test_csrf.py`
- `/projects/ficino/.review-findings/phase4-csrf-status.md`

Files edited:
- `/projects/ficino/api/main.py`
- `/projects/ficino/frontend/src/lib/api.ts`

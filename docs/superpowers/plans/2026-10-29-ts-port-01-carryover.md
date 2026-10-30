# TS Port 01: decisions and carry-forward

Plan 01 (foundation) is complete on `ts-port/01-foundation`: 416 tests pass, the typecheck is clean, and the final review is done.

## Decisions made during execution

These are the controller's rulings, each with its cost if wrong. They go beyond what the plan specified, so treat them as reviewable.

1. **The test harness uses the docker CLI, not testcontainers.** It runs Postgres on `127.0.0.1::5432`, because testcontainers publishes on 0.0.0.0, which this host forbids. Cost if wrong: a little more harness code.
2. **The `CHAPTER_INSERT_SQL` constant moved to plan 05**, together with its test. Cost: none.
3. **The prompt-injection role-marker regex strips a superset of what Python strips.** Exact parity isn't required. Cost: rare extra stripping of a leading BOM-like character.
4. **No 307 redirect for trailing slashes.** `/papers/` returns 404, but the frontend never sends trailing slashes. Cost: an external client that adds trailing slashes gets 404.
5. **500 responses carry CORS and security headers. CSRF 403s carry CORS headers only**, the same as Python. Cost: none known.
6. **Register rejects passwords longer than 72 bytes with a 422.** Without this, a multibyte password could register but never log in. Cost: rare 422s where Python would have accepted.
7. **Register runs in a single transaction**, and a unique-violation race maps to 409. Cost: none.
8. **`requireUser` is applied per router.** A test sweeps every route to prove that each non-public route returns 401. Under `basic`, unknown sub-paths and wrong methods inside a protected prefix return 401 rather than FastAPI's 404/405. Cost: API clients probing paths see 401.
9. **The clear-all audit follows the Python source**: `paper_count` goes in the metadata. Cost: none.
10. **A float setting of `"nan"` returns 422.** Python would have produced a 500. Cost: none.
11. **`API_HOST` defaults to `127.0.0.1`**, and the Dockerfile sets `0.0.0.0` inside the container. The plan said 0.0.0.0, but the host exposure rules take precedence. Cost: a non-Docker run must set `API_HOST` to expose the server.
12. **The image defaults to `ENVIRONMENT=production`**, so it fails closed: Secure cookies, HSTS/CSP, production CORS, and the `userOverride` guard. Cost: a local `docker run` needs `ENVIRONMENT=development` to get dev CORS.

## Carry into plan 02

- **`errors.ts` 22P02 log.** The `msg:` key is overridden by pino's message argument, so the database error text is lost. Rename it to `pg_message` and assert it in a test.
- **Cron pruning.** Prune expired `rate_limits` and `sessions` rows on the cron.
- **`AppDeps` instead of singletons.** Extend `AppDeps` with storage, queue, and a signing key resolved once at boot, so production fails closed without `SIGNED_URL_KEY`. Don't add module-level singletons.
- **Test harness.** It must also reset the pg-boss schema.
- **Router mounting.** Never mount a router at `/` with `use('*', requireUser)`, because that would gate `/health` and `/auth/login`.
- **Concurrent-migrator test.** The worker also migrates at boot, so add a test with two concurrent migrators. Also make the advisory-unlock error stop masking the original error.
- **Pool connection type.** Consider one `env`→`config` source for the worker. `loadStoredSettings` takes a `tx` cast; tighten that type.
- **`HTTPException` headers.** The `HTTPException` branch drops custom response headers. This matters for uploads and 413s.
- **Python defaults to revisit.** The `figure_detect_anthropic_model` default is still `claude-sonnet-4-6`. Ask whether to bump it.
- **New int params.** New int-valued route params must use `pyInt` and must match the param-fill regex in `test/api/routes-auth.test.ts`.

## Carry into plan 04

- `close()` has no force-close timeout. LLM requests can run for 120 s.

## Carry into plan 06 (cutover)

- **Compose environment.** Set `ENVIRONMENT`, `CORS_ORIGINS` and `SIGNED_URL_KEY`. Fix the healthcheck port and start-period.
- **Auth provider vs the restore.** The restored data is re-keyed to the stub user, who can't log in under `basic`. Decide the provider against the tailnet ACLs.
- **IP rate limits.** Behind `tailscale serve`, every client arrives as 127.0.0.1, so the limits become one global bucket.
- **Schema migrations on restore.** The restore must be data-only, or it must stamp `schema_migrations`.
- **Process leftovers.** Close/SIGTERM tests; a first-user registration race; CSRF failure logging; `parseBool` silently falling back.

## Deferred minors

These are small test-tightening and parity notes. None blocks anything. They're listed in the plan-01 review history, and the final review triaged each one as "any plan". Pick them up opportunistically.

# Plan 016: Disable interactive API docs outside development

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 31fef3a..HEAD -- api/main.py api/tests/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `31fef3a`, 2026-08-03

## Why this matters

The FastAPI app is constructed with no `docs_url`/`redoc_url`/`openapi_url` gating, so `/docs`, `/redoc`, and `/openapi.json` are served unauthenticated in every environment, including the hosted SaaS. That's a complete unauthenticated route inventory plus request/response models and rate-limit-tunable parameter names — a reconnaissance handout that contradicts the app's otherwise deliberate hardening posture (even `/settings/ollama-models` is auth-gated). The rest of `main.py` already branches on `settings.environment` for exactly this class of thing (HSTS/CSP at `api/main.py:93-95`).

## Current state

- `api/main.py:61-66`:

```python
app = FastAPI(
    title="Ficino API",
    description="AI-powered academic discourse engine",
    version="0.1.0",
    lifespan=lifespan,
)
```

- `api/main.py:93-95` — the existing environment-branching convention to match:

```python
        if settings.environment != "development":
            response.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains"
            response.headers["Content-Security-Policy"] = "default-src 'self'; ..."
```

- `settings.environment` comes from `api/config.py` (pydantic-settings, env var `ENVIRONMENT`, default is development-flavored — read `api/config.py` to confirm the default before writing the test).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Lint | `ruff check api/` | exit 0 |
| API tests | `docker exec ficino-api sh -c "pip install -q -r requirements-dev.txt && pytest tests/ -q"` | all pass |

(If the docker stack is not running, `docker compose up -d` from the repo root first.)

## Scope

**In scope**:
- `api/main.py`
- `api/tests/` — one test (new file `api/tests/test_docs_gating.py` or an existing main/app-level test file if one exists — check with `ls api/tests/ | grep -i "main\|app\|docs"`)

**Out of scope**:
- Any other middleware or header logic in `api/main.py`.
- Frontend — nothing references `/docs`.
- Do not gate `/docs` behind auth instead of disabling it — disabling outside development is the whole point (nothing in production should need the interactive schema; developers run `ENVIRONMENT=development`).

## Git workflow

- Branch: `advisor/016-disable-api-docs-outside-dev` if working standalone. If dispatched by the improve orchestrator, work in the checkout you are given and do not commit — the reviewer commits.
- Commit style (standalone): conventional commits with scope, e.g. `fix(api): disable interactive docs outside development`.

## Steps

### Step 1: Gate the docs URLs

Replace the `FastAPI(...)` constructor at `api/main.py:61-66` with:

```python
# Interactive docs are a dev-only convenience — in every other environment
# /docs, /redoc and /openapi.json would be an unauthenticated inventory of
# every route, model, and tunable parameter. Same fail-closed posture as
# the HSTS/CSP branch below.
_is_dev = settings.environment == "development"
app = FastAPI(
    title="Ficino API",
    description="AI-powered academic discourse engine",
    version="0.1.0",
    lifespan=lifespan,
    docs_url="/docs" if _is_dev else None,
    redoc_url="/redoc" if _is_dev else None,
    openapi_url="/openapi.json" if _is_dev else None,
)
```

Check that `settings` is imported in `main.py` before the constructor (it is — the middleware at line 93 uses it).

**Verify**: `ruff check api/main.py` → exit 0.

### Step 2: Test

Add `api/tests/test_docs_gating.py` (or extend an existing app-level test file). Look at how other tests construct the app/client first (`grep -rln "TestClient\|httpx" api/tests/ | head -5`) and match that pattern. Assert:

- With `ENVIRONMENT=development` (or whatever the test settings fixture provides): `GET /docs` → 200, `GET /openapi.json` → 200.
- With the settings object patched/overridden to `environment="production"`: `GET /docs` → 404, `GET /redoc` → 404, `GET /openapi.json` → 404.

Note the app is constructed at import time, so the production case likely needs a fixture that patches config and re-imports/rebuilds the app — follow whatever environment-override pattern the existing settings tests use (`grep -rln "environment" api/tests/ | head`). If the existing settings fixtures make per-test environment overrides awkward, a module-level test that builds a *second* `FastAPI` app instance with the same kwargs under a patched settings object is acceptable.

**Verify**: `docker exec ficino-api sh -c "pytest tests/test_docs_gating.py -q"` → all pass.

### Step 3: Full suite

**Verify**: `docker exec ficino-api sh -c "pytest tests/ -q"` → all pass.

## Test plan

Covered in Step 2. Model after the existing environment/settings test pattern found in `api/tests/`.

## Done criteria

- [ ] `ruff check api/` exits 0
- [ ] `docker exec ficino-api sh -c "pytest tests/ -q"` exits 0; the new gating test exists and passes
- [ ] With `ENVIRONMENT` unset or `development`, `/docs` still works (test asserts)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated (unless a reviewer maintains the index)

## STOP conditions

Stop and report back (do not improvise) if:

- The constructor at `api/main.py:61-66` doesn't match the excerpt (drift).
- `settings.environment` doesn't exist or has a surprising default (report what `api/config.py` actually defines).
- Any existing test or tooling turns out to depend on `/docs` or `/openapi.json` in a non-development environment — report what depends on it instead of working around it.
- A verification step fails twice after a reasonable fix attempt.

## Maintenance notes

- Developers hitting a 404 on `/docs` against a deployed instance is now expected; run locally with `ENVIRONMENT=development`.
- If a future tool needs the OpenAPI schema in CI, generate it from a development-mode app instance, not by re-enabling the route.

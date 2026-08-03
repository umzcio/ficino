# Plan 023: Lock Python dependencies and pin CI tooling

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 31fef3a..HEAD -- api/requirements.txt worker/requirements.txt api/Dockerfile worker/Dockerfile .github/workflows/ci.yml`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: plans/021-non-root-containers.md (both edit the Dockerfiles — land 021 first)
- **Category**: tech-debt
- **Planned at**: commit `31fef3a`, 2026-08-03

## Why this matters

Every Python dependency in `api/requirements.txt` and `worker/requirements.txt` is an unpinned `>=` floor with no lockfile, and the production Docker images build from those floors — so every SaaS/Railway deploy and every image build resolves FRESH versions. An upstream release can break production deploys or CI without any repo change, and "green CI today" says nothing about last month's deploy. The CI lint gate installs unpinned `ruff` (line 16: `pip install ruff`), so the gate itself can start failing on `main` spontaneously. Lockfiles make builds reproducible; floors stay as the supported-range statement.

## Current state

- `api/requirements.txt` — 17 entries, all `>=` floors (fastapi, uvicorn, asyncpg, pydantic, pydantic-settings, python-multipart, redis, httpx, anthropic, structlog, celery, PyJWT, cryptography, bcrypt, supabase, ...).
- `worker/requirements.txt` — same pattern (celery, redis, asyncpg, anthropic, openai, pymupdf, structlog, Pillow, tiktoken, pydantic, httpx, ...). NOTE: it documents that the local reranker's heavy deps are deliberately kept OUT of the base install — do not pull them into the lock.
- `api/Dockerfile:13` / `worker/Dockerfile:13` — `RUN pip install --no-cache-dir -r requirements.txt`.
- `.github/workflows/ci.yml:16` — `pip install ruff` (unpinned). The 4 Python jobs use `actions/setup-python@v5` with no `cache: pip`.
- `shared/` is a local editable package (`pip install ./shared`) — NOT locked (it's this repo's own code; correct to leave out).
- `requirements-dev.txt` files exist per service — leave them FLOORED (dev tooling freshness is fine; only runtime images and the lint gate need reproducibility).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Compile locks | `uv pip compile api/requirements.txt -o api/requirements.lock --python-version 3.11` (if `uv` is unavailable: `python -m venv /tmp/lockvenv && /tmp/lockvenv/bin/pip install -q pip-tools && /tmp/lockvenv/bin/pip-compile api/requirements.txt -o api/requirements.lock`) | exit 0, lock file written |
| Build images | `docker compose build api worker` | exit 0 |
| API tests | `docker exec ficino-api sh -c "pip install -q -r requirements-dev.txt && pytest tests/ -q"` | all pass |
| Worker tests | `docker exec ficino-worker sh -c "pip install -q -r requirements-dev.txt && pytest tests/ -q"` | all pass |
| Lint | `ruff check api/ worker/ shared/` | exit 0 |

## Scope

**In scope**:
- `api/requirements.lock` (create)
- `worker/requirements.lock` (create)
- `api/Dockerfile`, `worker/Dockerfile` — install from the lock
- `.github/workflows/ci.yml` — pin ruff, add pip caching, install from locks
- `README.md` or `AGENTS.md` — one short note on how to update the locks (only if such a section already exists after plan 031; otherwise put the note as a header comment INSIDE each requirements.txt)

**Out of scope**:
- `api/requirements.txt` / `worker/requirements.txt` floors themselves — do not re-pin, restructure, or remove entries.
- `requirements-dev.txt` files — stay floored.
- `frontend/package-lock.json` — the JS side already has a lockfile.
- `shared/pyproject.toml`.

## Git workflow

- Branch: `advisor/023-python-dep-lockfiles` if working standalone. If dispatched by the improve orchestrator, work in the checkout you are given and do not commit — the reviewer commits.
- Commit style (standalone): conventional commits with scope, e.g. `build(deps): lock python runtime dependencies and pin ci ruff`.

## Steps

### Step 1: Generate the locks

Compile `api/requirements.lock` and `worker/requirements.lock` from the current floors (command table). Use the SAME tool for both. Inspect each lock: it must contain pinned `==` versions for the direct floors plus their transitive closure, and must NOT contain the local-reranker heavy deps (torch etc.) that worker/requirements.txt deliberately excludes. If the compiler's output includes a comment header naming the tool/version/command, keep it.

### Step 2: Install from locks in the Dockerfiles

In both Dockerfiles, change the requirements COPY/install to:

```dockerfile
COPY <service>/requirements.txt <service>/requirements.lock ./
# Install from the lock (reproducible deploys); requirements.txt remains
# the human-edited supported-range statement — regenerate the lock when it
# changes (see header of requirements.lock).
RUN pip install --no-cache-dir -r requirements.lock
```

**Verify**: `docker compose build api worker` → exit 0.

### Step 3: Pin ruff and add caching in CI

In `.github/workflows/ci.yml`:

1. Determine the ruff version to pin: run `ruff --version` locally if installed, else `docker run --rm python:3.11-slim sh -c "pip install -q ruff && ruff --version"`. Pin exactly that: `pip install ruff==<version>` on line 16.
2. Add `cache: pip` with `cache-dependency-path` covering the locks to each `actions/setup-python@v5` step in the python-lint, api-tests, worker-tests, and shared-tests jobs:
```yaml
      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
          cache: pip
          cache-dependency-path: |
            api/requirements.lock
            worker/requirements.lock
```
   (For jobs that only install dev requirements, the lock paths still give a stable cache key; that's fine.)
3. In the api-tests and worker-tests jobs, install runtime deps from the lock (`pip install -r api/requirements.lock` / `worker/requirements.lock`) BEFORE the dev requirements, replacing the current `-r api/requirements.txt` install if present. Keep `pip install ./shared` as is.

**Verify**: `ruff check api/ worker/ shared/` → exit 0 with the pinned version locally.

### Step 4: Full verification

`docker compose up -d`, then both pytest suites (command table) inside the freshly built containers.

### Step 5: Update note

Add the lock-regeneration note: if `AGENTS.md` exists (plan 031), append a 2-line "Dependency locks" entry to its commands section; otherwise add a header comment to both `requirements.txt` files: `# Floors = supported range. Runtime images/CI install from requirements.lock — regenerate with: uv pip compile <this file> -o <lock> --python-version 3.11`.

## Test plan

- No new tests — the existing api + worker suites running against lock-built images is the verification (any resolution breakage surfaces at build or test time).
- CI on push validates the pinned ruff and cached installs end-to-end.

## Done criteria

- [ ] Both `.lock` files exist with fully pinned transitive closures and no reranker heavy deps
- [ ] `docker compose build api worker` exits 0 and both pytest suites pass in the rebuilt containers
- [ ] CI installs ruff pinned (`grep "ruff==" .github/workflows/ci.yml`)
- [ ] All four Python CI jobs have `cache: pip`
- [ ] No change to any floor entry in `requirements.txt` files (`git diff api/requirements.txt worker/requirements.txt` empty except possibly the header comment from Step 5)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated (unless a reviewer maintains the index)

## STOP conditions

Stop and report back (do not improvise) if:

- Lock compilation surfaces an unresolvable conflict (the floors don't currently co-resolve) — report the conflict; do not change floors to force it.
- The built images fail tests that pass on the pre-lock images (a transitive pin changed behavior) — report the diff in resolved versions; do not hand-tune pins beyond reverting the specific offender to the previously-resolved version, and document it.
- `uv`/`pip-tools` behaves differently than the command table assumes.
- Plan 021 hasn't landed and the Dockerfiles differ from what Step 2 expects — land 021 first or report.

## Maintenance notes

- Updating a dependency = edit the floor (if the range changes) + recompile the lock + rebuild. The lock header documents the exact command.
- Renovate/Dependabot for the locks is a possible follow-up, deliberately not included.
- First-lock side effect to expect: resolved versions may differ from what some past deploy ran — that's the point (now it's visible and pinned), but watch the first post-lock deploy.

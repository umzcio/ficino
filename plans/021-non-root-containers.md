# Plan 021: Run api and worker containers as a non-root user

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 31fef3a..HEAD -- api/Dockerfile worker/Dockerfile docker-compose.yml`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `31fef3a`, 2026-08-03

## Why this matters

Neither the api nor the worker Dockerfile declares `USER`, so uvicorn and celery run as root inside their containers. The worker parses attacker-supplied PDFs (PyMuPDF/marker/PIL pipeline) — the classic parser-bug attack surface. A parser RCE or dependency vulnerability lands as root in the container, easing pivot to the shared `ficino-network` (Postgres/Redis) and the bind-mounted upload/figure volumes. Standard hardening gap with a standard fix; the only real risk is volume ownership on pre-existing deployments, which this plan handles explicitly.

## Current state

- `api/Dockerfile` (full):

```dockerfile
FROM python:3.11-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends build-essential && rm -rf /var/lib/apt/lists/*
COPY api/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY shared/ ./shared/
RUN pip install --no-cache-dir ./shared
COPY api/ .
EXPOSE 8000
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
```

- `worker/Dockerfile` — identical shape; CMD is `celery -A celery_app worker -B ...` (note the `-B`: embedded beat writes a `celerybeat-schedule` file in the working directory, so `/app` must be writable by the runtime user).
- `docker-compose.yml:34-36,56-58` — both services mount named volumes `paper_uploads:/app/uploads` and `figure_images:/app/figures`. On EXISTING deployments these volumes contain root-owned files; a fresh non-root container can't write them until ownership is fixed (one-time operation, Step 3). On FRESH deployments, Docker initializes named volumes from the image directory's ownership, so chown-ing in the Dockerfile before switching user covers new installs automatically.
- Railway (SaaS) has no volumes — nothing to do there.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Build | `docker compose build api worker` | exit 0 |
| Up | `docker compose up -d` | all services healthy |
| Non-root | `docker exec ficino-api whoami` / `docker exec ficino-worker whoami` | `ficino` |
| API tests | `docker exec ficino-api sh -c "pip install -q -r requirements-dev.txt && pytest tests/ -q"` | all pass |
| Worker tests | `docker exec ficino-worker sh -c "pip install -q -r requirements-dev.txt && pytest tests/ -q"` | all pass |
| Beat file | `docker exec ficino-worker sh -c "ls -la /app/celerybeat-schedule* 2>/dev/null; touch /app/.write-test && rm /app/.write-test"` | no permission error |

(Note: `pip install` inside a non-root container needs `--user` or a writable target — if the test command fails on permissions, use `docker exec --user root ... pip install` for the INSTALL ONLY, then run pytest as the normal user. Document which you did.)

## Scope

**In scope**:
- `api/Dockerfile`
- `worker/Dockerfile`
- `docs/saas-deploy.md` — one short operator note (Step 4)

**Out of scope**:
- `frontend/Dockerfile` — nginx has its own user model; separate concern, do not touch.
- `docker-compose.yml` — no changes needed (the one-time chown is a runtime command, not a compose edit).
- Postgres/redis services — official images handle their own users.

## Git workflow

- Branch: `advisor/021-non-root-containers` if working standalone. If dispatched by the improve orchestrator, work in the checkout you are given and do not commit — the reviewer commits.
- Commit style (standalone): conventional commits with scope, e.g. `fix(infra): run api and worker containers as non-root user`.

## Steps

### Step 1: Add the user to both Dockerfiles

In BOTH `api/Dockerfile` and `worker/Dockerfile`, insert after the `COPY <service>/ .` line (and before `EXPOSE`/`CMD`):

```dockerfile
# Run as non-root: the worker parses untrusted PDFs; a parser exploit
# shouldn't land as root. /app must be writable — celery -B (embedded
# beat) writes celerybeat-schedule in the workdir, and the app writes
# /app/uploads + /app/figures (named volumes, initialized from image
# ownership on fresh deploys).
RUN useradd --create-home --uid 10001 ficino && chown -R ficino:ficino /app
USER ficino
```

**Verify**: `docker compose build api worker` → exit 0.

### Step 2: Bring the stack up

`docker compose up -d` → all healthy. Then the `whoami` and beat-file checks from the Commands table.

### Step 3: Fix ownership on the pre-existing dev volumes (local, reversible)

If (and only if) the api/worker fail to write `/app/uploads` or `/app/figures` (check `docker compose logs api worker` for PermissionError, or run `docker exec ficino-worker sh -c "touch /app/uploads/.t && rm /app/uploads/.t"`):

```bash
docker compose run --rm --user root --entrypoint sh api -c "chown -R 10001:10001 /app/uploads /app/figures"
docker compose up -d
```

Record in your report whether this was needed. Fresh deployments never need it (image-dir ownership seeds the volume).

### Step 4: Operator note in the runbook

Add a short section to `docs/saas-deploy.md` (find the deploy/upgrade area; keep it ~5 lines): existing self-host deployments upgrading to images ≥ this change must run the one-time chown command from Step 3 against their named volumes; fresh installs need nothing.

### Step 5: Test suites

Run both in-container pytest suites (Commands table). Upload-path coverage in the worker suite exercises the volume writability.

**Verify**: both suites pass.

## Test plan

- No new tests — the existing api + worker suites running inside the non-root containers IS the test (they exercise DB, storage writes, and task dispatch).
- Manual assertions: `whoami` = `ficino`, `/app` writable (beat file), volumes writable (Step 3 check).

## Done criteria

- [ ] `docker compose build api worker` exits 0
- [ ] `docker exec ficino-api whoami` and `docker exec ficino-worker whoami` print `ficino`
- [ ] Both pytest suites pass inside the containers
- [ ] Volume write check passes (after Step 3 if needed)
- [ ] `docs/saas-deploy.md` has the operator note
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated (unless a reviewer maintains the index)

## STOP conditions

Stop and report back (do not improvise) if:

- Either Dockerfile has drifted from the described shape.
- Something in the container genuinely requires root (e.g. a runtime `apt-get`, a port < 1024 bind, writing outside /app) — report what and why; do not work around it by widening permissions.
- The volume chown doesn't resolve write failures (e.g. SELinux-style labeling issues on the host) — report the host environment and error.
- A verification step fails twice after a reasonable fix attempt.

## Maintenance notes

- Future image changes must not re-introduce root-only assumptions (installing packages at runtime, writing outside `/app` or `/tmp`). Reviewers: check for `USER` still present on any Dockerfile edit.
- The `10001` uid is arbitrary but now load-bearing for the volume-chown runbook note — don't change it casually.
- `pip install -q -r requirements-dev.txt` inside the running container now installs as non-root (into the user site); that's dev-only convenience, production images are unaffected.

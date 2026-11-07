# TS Port 06: Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the TypeScript server the only backend: a tracked compose stack for it, the files that put it on its own tailnet node, a repeatable loopback e2e stack and CI for the acceptance gate, a tested restore of the archived SaaS data (re-keyed, files copied, re-embedded), the plan-01 process fixes, and the deletion of the Python services.

**Architecture:** The tracked `docker-compose.yml` is generic and publishes nothing (postgres, api, worker, web). A host-only, gitignored `docker-compose.override.yml` (built from the tracked `deploy/tailnet/docker-compose.override.example.yml`) adds the Tailscale sidecar, moves `web` into its network namespace with the tailnet nginx template and points at the host's env files. A separate compose project (`docker-compose.e2e.yml`, project `ficino-e2e`) runs the Playwright gate on a loopback port and is torn down after each run. The restore is a server CLI (`db`, `files`, `verify`) plus a re-embed CLI; both run in the server image before the api and worker first start. Host steps (registration, proxy, auth key, the real restore) are the controller's, in its private runbook; no task here touches the host.

**Tech Stack:** Node 24 (image) / Node ≥22.18 (host), TypeScript strict ESM, Hono, postgres.js, pg-boss, Vitest against `pgvector/pgvector:pg18`, Docker Compose v2, nginx:alpine, Playwright 1.59, `node --test` for deploy checks.

**Spec:** `docs/superpowers/specs/2026-10-29-typescript-port-design.md` (roadmap item 6; Goals incl. the e2e acceptance gate; Anti-goals; Constraints). Carry items: every "Carry into plan 06" section in `docs/superpowers/plans/2026-1*-ts-port-0*-carryover.md`. Restore mapping: `docs/superpowers/specs/ts-port-reference/schema-tests-data.md` §2 and `rekey-test.sql`.

## Global Constraints

- **Public repo.** No tracked file, commit message or test may contain a host name, tailnet domain, private path, real user, corpus, paper, feed, reading-list or post id (an 8-character prefix of one counts), workspace (corpus) name other than `Default`, paper title or filename from the archive, login, email or secret. Use `<host>`, `<tailnet>`, `<archive>`, `owner@example.com`. Host-specific values live only in the untracked override, the untracked `.env` and files outside the repo.
- **Implementers never touch the host.** No `docker compose up` of `docker-compose.yml` or `docker-compose.e2e.yml`, no published port, no edit outside the worktree. Tests may start throwaway containers with no published port, or published on `127.0.0.1` only (the existing server test harness pattern), and must remove them.
- **Test runs stay inside the controller's windows.** The host audits running containers on a schedule, and the throwaway test containers (`npm test`, `npm run test:deploy`, the audio smoke) are unregistered there. Run suites only when the controller says the window is open, and never leave one running.
- Postgres image: `pgvector/pgvector:pg18` everywhere (compose, e2e, tests). Never a `-trixie` tag (a glibc collation change needs a REINDEX).
- Container names `ficino-postgres` and `ficino-api` stay (the host's nightly dump finds `ficino-postgres` by name). The e2e harness no longer defaults to them: its defaults become the e2e stack's containers (Task 3), so a bare Playwright run can never seed fixtures into production.
- Every built service names its image: prod `ficino-server:local`, `ficino-web:local`; e2e `ficino-server:e2e`, `ficino-web:e2e`. Compose must never default-name an image in project `ficino` (that would overwrite the old `ficino-api`/`ficino-worker` images).
- `${VAR:?}`: none in `docker-compose.yml` or `docker-compose.e2e.yml`. The one exception is the override example's `FICINO_OWNER_LOGIN` (Task 2), a non-secret value that must live in the project `.env`, which is compose's default interpolation file and the only one the host's weekly sidecar updater reads (it runs `docker compose config` with no `--env-file`). Secrets reach containers through `env_file`, never interpolation.
- No `0.0.0.0` publish anywhere. The only tracked publishes are on `127.0.0.1`: the e2e web (Task 3) and the self-host loopback override example (Task 2).
- `frontend/` app code stays byte-identical (the gate runs the unchanged frontend). The only frontend changes are the new `frontend/.dockerignore` (build-context hygiene) and, if the controller's scan lists it, a comment-only rewording in a frontend *test* file (Task 14 Step 2).
- New scripts are committed executable (`chmod +x` and mode `100755` in the index): CI and the runbook call them directly.
- Schema stays restore-compatible: no CHECK or enum constraints on status columns; `vector(1024)`; no new migration in this plan.
- jsonb writes go through `sql.json` (postgres.js double-encodes `JSON.stringify`). New int route params use `pyInt`. Never mount a router at `/` with `use('*', requireUser)`.
- Anti-goal 1: the re-embed resolves settings per user with `loadJobSettings`; nothing mutates `process.env`.
- Anti-goal 2: a chunk's `metadata.embed_model` changes only in the same `UPDATE` that writes its new vector.
- Restore tests use synthetic fixtures built in `server/test/helpers/syntheticArchive.ts`, never real data.
- Never `docker compose down -v` without `-p ficino-e2e -f docker-compose.e2e.yml`.
- Gates: `cd server && npm run typecheck && npm test && npm run build`; from the repo root `npm run test:deploy`.
- Commits: conventional with scope (`feat(server): …`, `chore(deploy): …`), ending with the attribution trailer the session gives.

## Review Focus

1. **Restore re-run or early API boot.** A second `restore db`, or one after the API already created the stub user and an empty Default workspace, must either abort before writing anything or (only for the untouched stub/Default) replace them and proceed. Tests: Task 8 `aborts on a second run without writing`, `replaces an untouched stub user and Default workspace`, `aborts when the stub owns data`.
2. **Double-encoded jsonb in restored rows.** A `messages`/`posts` value stored as a JSON string must end up a real array, or the restore aborts naming the column; never left as a string the TS spreads char by char. Tests: Task 7 `decodes double-encoded jsonb arrays`, `a jsonb value that is neither an array nor an encoded array aborts`.
3. **Re-embed interrupted.** An abort or provider failure after batch k leaves batches 1..k fully re-embedded and tagged and the rest untouched; a rerun finishes; no row ever carries a new tag with an old vector. Tests: Task 5 `abort after the first batch leaves a consistent partial`, `an embedding failure mid-run keeps committed batches`.
4. **Owner gate misconfigured or bypassed.** An empty or unset owner login, a missing header, a wrong login, or a request to the container's non-loopback address must never get a 200. Tests: Task 2 `rejects requests without the owner login`, `an empty owner login never admits anonymous requests`, `listens on loopback only`.
5. **Archive objects with no matching row.** An orphan PDF, a legacy `seg_*.mp3`, a figure with no row, or a key that escapes the bucket is skipped with a reason and never copied; a checksum mismatch aborts before any copy. Tests: Task 9 `skips objects with no row`, `aborts on a checksum mismatch before copying anything`, `rejects a key that escapes the bucket`.
6. **Ids left behind by the re-key.** Data loads with foreign keys off, and ids also live outside id columns (`audit_log.metadata`, `resource_id`). Every real foreign key must be checked from the catalog, and no restored row may still contain the owner, orphan or source Default id; either failure aborts the transaction. Tests: Task 8 `aborts on an orphan reference`, the `to_jsonb` sweep in `restores the synthetic dump …`.

---

## File Structure

| Path | Responsibility | Task |
|---|---|---|
| `server/Dockerfile` | `HEALTHCHECK` interval/start-period flags | 1 |
| `docker-compose.yml` | Generic TS stack, no published ports | 1 |
| `.env.example` (rewrite), `.env.secrets.example` (delete) | One documented env file for the generic stack | 1 |
| `frontend/.dockerignore` | Keep host `node_modules`/`dist` out of the web build context | 1 |
| `.gitignore` | Ignore the host override and local env files | 1 |
| `package.json` (root) | `test:deploy` script | 1 |
| `deploy/test/helpers.mjs` | `composeConfig()` and docker helpers for deploy tests | 1 |
| `deploy/test/compose.test.mjs` | Base compose invariants | 1 |
| `deploy/tailnet/serve.json` | Tailscale Serve config (generic) | 2 |
| `deploy/tailnet/docker-compose.override.example.yml` | Sidecar + web-in-netns + env_file layout, generic | 2 |
| `.pre-commit-config.yaml` | `check-yaml` skips the override example (compose's `!reset` tag) | 2 (infra part dropped in 13) |
| `deploy/loopback/docker-compose.override.example.yml` | Self-host override: web on `127.0.0.1:8080` only | 2 |
| `deploy/web/tailnet/default.conf.template` | Web nginx for the sidecar (loopback, owner gate, realip, timeouts, `/` redirect) | 2 |
| `deploy/README.md` | How the files layer (generic) | 2 |
| `deploy/test/web-nginx.test.mjs`, `deploy/test/tailnet-compose.test.mjs`, `deploy/test/loopback-compose.test.mjs` | Template behaviour in a container; override invariants | 2 |
| `docker-compose.e2e.yml` | Loopback e2e stack, project `ficino-e2e` | 3 |
| `.env.ci` (rewrite) | Dummy env for the e2e stack | 3 |
| `scripts/e2e-stack.sh` (mode 755) | `up [--ollama] | ci | full | down | logs`; JSON report per run | 3 |
| `tests/e2e/helpers/seedSamplePaper.ts`, `tests/e2e/helpers/globalSetup.ts` | Optional real-paper seed for the full suite | 3 |
| `tests/e2e/helpers/ensureFeed.ts` | Container defaults point at the e2e stack | 3 |
| `playwright.config.ts` | Stale SSE comment; `baseURL` default on the e2e port | 3 |
| `tests/e2e/**/*.spec.ts` (10 files) | `E2E_BASE_URL` fallback on the e2e port | 3 |
| `deploy/test/e2e-compose.test.mjs` | e2e compose invariants | 3 |
| `.github/workflows/ci.yml` | e2e job on the TS stack (ubuntu-24.04), deploy job | 4 (Python jobs removed in 13) |
| `server/src/ingest/embedText.ts` | `chunkEmbedText` shared by ingestion and re-embed | 5 |
| `server/src/tasks/ingestion.ts` | Use `chunkEmbedText` | 5 |
| `server/src/tasks/reembed.ts` | `reembedUserChunks`, `embedModelCounts` | 5 |
| `server/src/db/reembed-cli.ts` | Re-embed CLI | 5 |
| `server/src/restore/errors.ts` | `RestoreError` | 6 |
| `server/src/restore/dump.ts` | pg_dump COPY-block parser | 6 |
| `server/test/helpers/syntheticArchive.ts` | Synthetic dump + storage tree + manifest builders | 6 (storage part 9) |
| `server/src/restore/cleanup.ts` | Post-load cleanup, sweeps, provenance, feed_posts rebuild; `RestoreDb` type | 7 |
| `server/src/tasks/feed.ts` | `writeFeedPostsIndex` accepts a transaction (parameter type only) | 7 |
| `server/src/db/migrate.ts` | Export `migrationVersions` | 8 |
| `server/src/restore/database.ts` | Preconditions, load, discovery, re-key, integrity checks | 8 |
| `server/src/restore/files.ts` | Archive storage → TS layout | 9 |
| `server/src/restore/verify.ts`, `server/src/restore/cli.ts` | `verify` checks; `db`/`files`/`verify` CLI | 10 |
| `server/src/config.ts`, `server/src/http/csrf.ts`, `server/src/app.ts`, `server/src/auth/basicRoutes.ts` | parseBool throws; CSRF reject log; registration lock | 11 |
| `server/test/api/signals.test.ts`, `server/test/worker/signals.test.ts`, `server/test/PORTING.md` | Signal wiring; ledger closed | 12 |
| `api/`, `worker/`, `shared/`, `infra/`, goldens `gen/*.py`, `ruff.toml`, `.dockerignore`, `docs/saas-deploy.md` | Deleted | 13 |
| `server/test/fixtures/goldens/README.md` | Golden provenance (replaces `gen/README.md`) | 13 |
| `README.md`, `AGENTS.md`, `FEATURES.md`, `server/README.md`, `tests/e2e/SKIPS.md` | Docs for the TS-only stack | 14 |
| `docs/superpowers/plans/2026-11-06-ts-port-06-carryover.md` | Plan 06 record | 14 |

---

### Task 1: Server image healthcheck, tracked base compose, env example, deploy test harness

**Files:**
- Modify: `server/Dockerfile` (the `HEALTHCHECK` line)
- Rewrite: `docker-compose.yml`, `.env.example`
- Delete: `.env.secrets.example`
- Create: `frontend/.dockerignore`, `deploy/test/helpers.mjs`, `deploy/test/compose.test.mjs`
- Modify: `.gitignore`, root `package.json`

**Interfaces:**
- Produces: compose services `postgres` (`ficino-postgres`), `api` (`ficino-api`), `worker` (`ficino-worker`), `web` (`ficino-web`) on network key `ficino-network` (`name: ficino-network`); volume keys `pgdata`, `uploads`, `figures`, `media`; images `ficino-server:local`, `ficino-web:local`. `postgres`, `api` and `worker` read `env_file: [{path: .env, required: false}]`; `web` has no `env_file` (it needs none of the database, server or provider values, and its nginx envsubst step would see them). `api` and `worker` have `depends_on: {postgres: {condition: service_healthy}}` (both run `migrate()` at boot and exit if Postgres is not ready).
- Produces (`deploy/test/helpers.mjs`): `composeConfig(files: string[], env?: Record<string,string>): Promise<object>` (runs `docker compose --project-directory <repo> -f … config --no-env-resolution --format json` with the given extra env, throws with stderr on non-zero exit); `composeConfigFails(files, env?): Promise<string>` (same command; resolves stderr when it fails, rejects if it succeeds); `docker(...args): string`; `REPO` (absolute repo root). `--no-env-resolution` is required: without it compose reads each env file, copies its values into `environment` and drops the `env_file` key (a missing optional file just vanishes), so env_file assertions cannot pass and a checkout's real `.env` values would land in the JSON a failing test prints. With it, `env_file` renders as `[{path: <absolute>, required: false}, …]`, and an override's entries are appended to the base's. Variable interpolation (`${VAR}`) still happens. Compose renders `extra_hosts` as an array of `name=value` strings (`host.docker.internal=host-gateway`, not `:`).

- [ ] **Step 1: Write the failing tests** in `deploy/test/compose.test.mjs` (`node:test`, `node:assert/strict`):

```js
test('base compose has the four services under their kept names', async () => {
  const c = await composeConfig(['docker-compose.yml']);
  assert.deepEqual(Object.keys(c.services).sort(), ['api', 'postgres', 'web', 'worker']);
  assert.equal(c.services.postgres.container_name, 'ficino-postgres');
  assert.equal(c.services.api.container_name, 'ficino-api');
  assert.equal(c.services.worker.container_name, 'ficino-worker');
  assert.equal(c.services.web.container_name, 'ficino-web');
  assert.equal(c.networks['ficino-network'].name, 'ficino-network');
});
test('no service publishes a port', async () => {
  const c = await composeConfig(['docker-compose.yml']);
  for (const [n, s] of Object.entries(c.services)) assert.equal(s.ports, undefined, n);
});
test('postgres is pgvector pg18 with the volume on /var/lib/postgresql', …)
  // image === 'pgvector/pgvector:pg18'; one volume with target '/var/lib/postgresql' and source 'pgdata';
  // healthcheck.test joined includes 'pg_isready'; no bind mount of any .sql file
test('api and worker share one image and the three data volumes', …)
  // both image 'ficino-server:local'; volume targets ['/app/figures','/app/media','/app/uploads'] with
  // sources figures/media/uploads on both; api has build.context ending '/server'; worker has no build and pull_policy 'never'
test('worker runs its own entry without the image healthcheck', …)
  // command deepEqual ['node','dist/worker/main.js']; healthcheck.disable === true; stop_grace_period === '45s'
test('api healthcheck probes /health with a start period', …)
  // healthcheck.test joined includes 'http://127.0.0.1:8000/health'; start_period '30s'; interval '10s'; stop_grace_period '20s'
test('api and worker map host.docker.internal to the host gateway', …)
  // assert.ok(s.extra_hosts.includes('host.docker.internal=host-gateway')) on both (compose renders `=`, not `:`)
test('web is the stock frontend build and waits for a healthy api', …)
  // build.context ends '/frontend'; image 'ficino-web:local'; depends_on.api.condition 'service_healthy'
test('only postgres, api and worker read the env file', …)
  // web.env_file undefined; postgres/api/worker env_file each has exactly one entry: path ending '/.env', required false
  // (needs --no-env-resolution in composeConfig; without it compose inlines the file and drops env_file)
test('api and worker wait for a healthy postgres', …)
  // depends_on.postgres.condition === 'service_healthy' on both
test('every built service names its image, never a legacy name', …)
  // for each service with build: image matches /^ficino-(server|web):/
test('the tracked compose interpolates no required variable', () => {
  const raw = readFileSync(join(REPO, 'docker-compose.yml'), 'utf8');
  assert.doesNotMatch(raw, /\$\{[A-Z0-9_]+:\?/);
});
test('the server image healthcheck has interval and start period', () => {
  const df = readFileSync(join(REPO, 'server/Dockerfile'), 'utf8');
  assert.match(df, /HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5 CMD wget -qO- http:\/\/127\.0\.0\.1:8000\/health/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test:deploy` (after adding the script `"test:deploy": "node --test \"deploy/test/*.test.mjs\""` to the root `package.json`)
Expected: FAIL (services are frontend/api/worker/postgres/redis; Dockerfile has no flags).

- [ ] **Step 3: Implement**
  - `server/Dockerfile`: `HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5 CMD wget -qO- http://127.0.0.1:8000/health || exit 1`.
  - `docker-compose.yml`: `name: ficino`; the four services as the tests pin; `restart: unless-stopped`; postgres `environment: {POSTGRES_USER: ficino, POSTGRES_DB: ficino}` (password only from `env_file`); api/worker share a YAML anchor (`x-server: &server`) for image, env_file, extra_hosts, volumes, network and `depends_on` (postgres `service_healthy`); worker `pull_policy: never`; web `build: ./frontend`, no `env_file`. Header comment: generic, publishes nothing; reach it with an override (see `deploy/README.md`); the image fails closed in production without `SIGNED_URL_KEY`.
  - `.env.example`: one file grouped as *Database* (`POSTGRES_PASSWORD`, `DATABASE_URL=postgresql://ficino:<password>@postgres:5432/ficino`), *Server* (`ENVIRONMENT=production`, `SIGNED_URL_KEY` with the generate hint `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`, `CORS_ORIGINS=https://ficino.example`, `AUTH_PROVIDER=none`, `PUBLIC_API_BASE=/ficino/api`), *Providers* (the `settings/schema.ts` defaults: `LLM_PROVIDER=ollama`, `OLLAMA_BASE_URL=http://host.docker.internal:11434`, `OLLAMA_LLM_MODEL=qwen3.8:27b`, `OLLAMA_EMBED_MODEL=qwen3-embedding:latest`, `OLLAMA_VISION_MODEL=qwen3-vl:32b`, `EMBED_DIM=1024`, `FIGURE_DETECT_PROVIDER=ollama`, empty `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `OPENAI_API_KEY`, `COHERE_API_KEY`), *Audio* (`ELEVENLABS_API_KEY`, `ELEVENLABS_MODEL_ID=eleven_turbo_v2_5`, `ELEVENLABS_DIALOGUE_MODEL_ID=eleven_v3`), *Jobs* (`JOB_TIME_LIMIT_SEC=600`, `WORKER_INGESTION_CONCURRENCY=1`). Every server variable must exist in `server/src/config.ts` or `settings/schema.ts`; the one other name is `POSTGRES_PASSWORD`, the postgres image's own variable, which is required (without it the generic stack's postgres refuses to initialise). No Redis, Celery, Supabase, Railway, `*_POOL_MIN_SIZE` or SaaS domains. Note at the top: changing the embedding model makes existing chunks invisible until they are re-embedded (Task 5): `docker compose run --rm --no-deps worker node dist/db/reembed-cli.js` in the compose stack, or `npm run reembed` in a source checkout (`tsx` is a dev dependency, pruned from the image).
  - `frontend/.dockerignore`: `node_modules`, `dist`, `.vite`.
  - `.env.secrets.example`: `git rm .env.secrets.example` (the deletion is staged by `git rm`, so Step 5 does not name it).
  - `.gitignore`: add `docker-compose.override.yml`, `/secrets.env`, `/postgres.env`, `/tailscale.env`.
  - `deploy/test/helpers.mjs`: before the first compose call, check once that `docker compose config --help` lists `--no-env-resolution` and fail with "Docker Compose too old for the deploy tests: needs config --no-env-resolution" otherwise (Task 4's CI job relies on the same check).

- [ ] **Step 4: Run to verify they pass**

Run: `npm run test:deploy`
Expected: PASS (all base-compose tests).

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml .env.example frontend/.dockerignore .gitignore package.json server/Dockerfile deploy/test
git status --short .env.secrets.example        # 'D  .env.secrets.example' (staged by git rm in Step 3)
git commit -m "feat(deploy): compose the TS stack (pg18, api, worker, web) with no published ports"
```

---

### Task 2: Tailnet node files: Serve config, override example, web nginx template

**Files:**
- Create: `deploy/tailnet/serve.json`, `deploy/tailnet/docker-compose.override.example.yml`, `deploy/web/tailnet/default.conf.template`, `deploy/loopback/docker-compose.override.example.yml`, `deploy/README.md`
- Modify: `.pre-commit-config.yaml` (the `check-yaml` `exclude` only)
- Test: `deploy/test/web-nginx.test.mjs`, `deploy/test/tailnet-compose.test.mjs`, `deploy/test/loopback-compose.test.mjs`

**Interfaces:**
- Consumes: Task 1's services, `composeConfig`, `composeConfigFails`, `docker`.
- Produces: the override adds service `ts` (`ficino-ts`, `hostname: ficino`, image `tailscale/tailscale:stable`, volume key `ts-state`, `./deploy/tailnet:/config:ro`), and changes `web` to `network_mode: service:ts`, no `networks`, env `FICINO_OWNER_LOGIN: ${FICINO_OWNER_LOGIN:?set FICINO_OWNER_LOGIN in .env}`, volume `./deploy/web/tailnet:/etc/nginx/templates:ro`. It adds `env_file` entries `./postgres.env` (postgres), `./secrets.env` (api, worker), `./tailscale.env` (ts, `required: false`), all `required: false` in the example. The template renders over the image's baked `conf.d/default.conf` via the nginx image's envsubst step, so the web image stays the stock frontend build.
- Produces: `deploy/loopback/docker-compose.override.example.yml`, the self-host override for anyone without a tailnet: only `services: {web: {ports: ["127.0.0.1:8080:80"]}}`, with a header saying to copy it to `docker-compose.override.yml` and browse `http://localhost:8080/ficino/` (`localhost`, not `127.0.0.1`: production cookies are `Secure`, which Chromium accepts over plain http on `localhost` only).

- [ ] **Step 1: Write the failing tests**

`deploy/test/tailnet-compose.test.mjs`:
```js
const FILES = ['docker-compose.yml', 'deploy/tailnet/docker-compose.override.example.yml'];
const ENV = { FICINO_OWNER_LOGIN: 'owner@example.com' };
test('the sidecar is kernel-mode, unpinned and publishes nothing', …)
  // ts.image 'tailscale/tailscale:stable'; ts.ports undefined; environment TS_USERSPACE 'false', TS_AUTH_ONCE 'true',
  // TS_HOSTNAME 'ficino', TS_STATE_DIR '/var/lib/tailscale', TS_SERVE_CONFIG '/config/serve.json';
  // cap_add includes NET_ADMIN and NET_RAW; devices has an entry whose source (or string form) is '/dev/net/tun';
  // a volume with target '/config', read_only true, source ending '/deploy/tailnet';
  // a volume with source 'ts-state' and target '/var/lib/tailscale'; Object.keys(ts.networks) includes 'ficino-network'
  // (web shares ts's namespace and its `resolver 127.0.0.11` must find ficino-api there); restart 'unless-stopped'
test('the override appends the host env files to the base env file', …)
  // env_file paths (basename): postgres ['.env', 'postgres.env']; api and worker ['.env', 'secrets.env'];
  // ts ['tailscale.env']; web undefined; every entry required false (a required file that is missing would make
  // `docker compose config` fail, which a host's sidecar auto-updater runs for every sidecar)
test('web lives in the sidecar namespace with the tailnet template', …)
  // web.network_mode 'service:ts'; web.networks undefined; web.ports undefined;
  // a volume target '/etc/nginx/templates' read_only, source ending '/deploy/web/tailnet';
  // web.environment.FICINO_OWNER_LOGIN 'owner@example.com'; web.image 'ficino-web:local'
test('config refuses to render without an owner login', async () => {
  const err = await composeConfigFails(FILES, { FICINO_OWNER_LOGIN: '' });
  assert.match(err, /FICINO_OWNER_LOGIN/);
});
test('serve.json proxies / to loopback 80 and never enables Funnel', …)
  // JSON.parse(readFileSync('deploy/tailnet/serve.json')); TCP['443'].HTTPS true;
  // Web['${TS_CERT_DOMAIN}:443'].Handlers['/'].Proxy === 'http://127.0.0.1:80';
  // every AllowFunnel value === false; assert.doesNotMatch(raw, /[a-z0-9-]+\.[a-z0-9-]+\.ts\.net/) (no tailnet name)
test('pre-commit check-yaml skips the override example', () => {
  // the example needs compose's `!reset` tag, which check-yaml's safe loader rejects
  const pc = readFileSync(join(REPO, '.pre-commit-config.yaml'), 'utf8');
  const block = pc.slice(pc.indexOf('id: check-yaml'), pc.indexOf('id: check-json'));
  assert.match(block, /exclude: .*deploy\/tailnet\/docker-compose\\\.override\\\.example\\\.yml/);
});
```

`deploy/test/web-nginx.test.mjs` (docker; one `before()` builds the fixture, `after()` removes everything). Fixture: an `--internal` network `ficino-deploytest-<hex>`, and every container named `ficino-deploytest-<hex>-<role>` (so the controller can find a leftover by name); a stub API container `node:24-alpine` with `--network-alias ficino-api` running an inline `http.createServer` on `0.0.0.0:8000` that answers JSON `{path, xRealIp, xForwardedProto}`; an `nginx:alpine` container with `-v <repo>/deploy/web/tailnet:/etc/nginx/templates:ro`, `-v <repo>/frontend/nginx-security-headers.conf:/etc/nginx/conf.d/security-headers.conf:ro`, `-e FICINO_OWNER_LOGIN=owner@example.com`; requests come from `curlimages/curl:8.11.1` run with `--network container:<nginx>` (the sidecar's view: loopback). Helper `req(path, headers) -> {status, location, body}`.
```js
const OWNER = { 'Tailscale-User-Login': 'owner@example.com' };
test('/ redirects to /ficino/ with a relative Location', async () => {
  const r = await req('/', OWNER); assert.equal(r.status, 302); assert.equal(r.location, '/ficino/');
});
test('/ficino redirects to /ficino/', …)                // 301, Location '/ficino/'
test('the API prefix is stripped and the tailnet peer becomes X-Real-IP', async () => {
  const r = await req('/ficino/api/health', { ...OWNER, 'X-Forwarded-For': '100.64.1.2' });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { path: '/health', xRealIp: '100.64.1.2', xForwardedProto: 'https' });
});
test('rejects requests without the owner login', …)    // no header -> 403; 'someone@example.com' -> 403; on /, /ficino/ and /ficino/api/health
test('listens on loopback only', …)
  // `docker exec <nginx> netstat -tln`: every :80 line is 127.0.0.1:80;
  // from the stub container, WITH the owner header, `wget -S -O- -T 3 --header 'Tailscale-User-Login: owner@example.com'
  // http://<nginx-ip>:80/` fails at the connection: its output matches /Connection refused|can't connect/ and contains
  // no 'HTTP/1' status line. A bare non-zero exit is not enough: the owner gate's 403 also exits non-zero, so a
  // 0.0.0.0 listener would pass that check.
test('long LLM calls are not cut at 60 s', …)          // `nginx -T` output includes 'proxy_read_timeout 300s' and 'proxy_send_timeout 300s' and 'absolute_redirect off'
test('an empty owner login never admits anonymous requests', …)
  // second nginx with -e FICINO_OWNER_LOGIN= : either the container exits non-zero within 10 s,
  // or GET / and GET /ficino/api/health without the header answer 403. Never 200 or 302.
test('an unset owner login admits nobody', …)          // nginx without the variable: GET / with OWNER -> 403
```

`deploy/test/loopback-compose.test.mjs`:
```js
test('the self-host override publishes only web, only on loopback', …)
  // composeConfig(['docker-compose.yml', 'deploy/loopback/docker-compose.override.example.yml']):
  // web.ports deepEqual-by-fields [{host_ip: '127.0.0.1', published: '8080', target: 80}]; every other service has no ports;
  // web.network_mode undefined (it stays on ficino-network)
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test:deploy`
Expected: FAIL (files missing).

- [ ] **Step 3: Implement**
  - `deploy/tailnet/serve.json`: the generic Serve config (`TCP 443 HTTPS`, one `/` handler proxying `http://127.0.0.1:80` under `${TS_CERT_DOMAIN}:443`, `AllowFunnel` false).
  - `deploy/tailnet/docker-compose.override.example.yml`: as in Interfaces. `ts` also gets `devices: [/dev/net/tun:/dev/net/tun]`, `cap_add: [NET_ADMIN, NET_RAW]`, `restart: unless-stopped`, `networks: [ficino-network]`, a comment "never any `ports:`" and a comment on why `TS_USERSPACE: "false"` and the 127.0.0.1 listen are both required (Serve must be the only way in, or a caller can forge `Tailscale-User-Login`). `web.networks` is cleared with compose's `!reset` tag. `volumes: {ts-state: {}}`. Header: copy to `docker-compose.override.yml` (gitignored), replace the env_file paths with files outside the repo, set `FICINO_OWNER_LOGIN` in `.env`; if `ficino-ts` is recreated alone, recreate `web` too.
  - `deploy/web/tailnet/default.conf.template` (exact content; the image's envsubst only replaces defined variables, so nginx's `$…` stay):

```nginx
# Ficino web on its own tailnet node. Rendered over conf.d/default.conf by the nginx
# image (envsubst). Serve is the only way in: listen on loopback, sidecar in kernel mode.
map $http_tailscale_user_login $ficino_owner_ok {
    default 0;
    ""      0;
    "${FICINO_OWNER_LOGIN}" 1;
}

server {
    listen 127.0.0.1:80;
    root /usr/share/nginx/html;
    index index.html;
    absolute_redirect off;

    # Serve proxies from 127.0.0.1 and puts the tailnet peer in X-Forwarded-For.
    set_real_ip_from 127.0.0.1;
    real_ip_header X-Forwarded-For;

    include /etc/nginx/conf.d/security-headers.conf;

    if ($ficino_owner_ok = 0) { return 403; }

    location = / { return 302 /ficino/; }
    location = /ficino { return 301 /ficino/; }

    location /ficino/ {
        alias /usr/share/nginx/html/;
        try_files $uri $uri/ /ficino/index.html;
        location ~ sw\.js$ {
            add_header Cache-Control "no-cache, no-store, must-revalidate";
            add_header Service-Worker-Allowed "/ficino/";
            include /etc/nginx/conf.d/security-headers.conf;
        }
    }

    location /ficino/api/ {
        resolver 127.0.0.11 valid=10s ipv6=off;
        set $ficino_api ficino-api:8000;
        rewrite ^/ficino/api(/.*)$ $1 break;
        proxy_pass http://$ficino_api;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        client_max_body_size 50M;
    }
}
```
  The `"" 0;` line is the fail-closed guard for an empty login: nginx either refuses the duplicate key (the container exits) or keeps the first entry (anonymous → 403). If the empty-login test still sees a 200 or 302, add `if ($http_tailscale_user_login = "") { return 403; }` before the owner check and rerun; no other fallback is acceptable.
  - `deploy/loopback/docker-compose.override.example.yml`: as in Interfaces.
  - `.pre-commit-config.yaml`: the `check-yaml` hook's `exclude` becomes `^(infra/postgres/.*\.sql|deploy/tailnet/docker-compose\.override\.example\.yml)$` (the hook's safe YAML loader rejects compose's `!reset` tag; `docker compose config` in the deploy tests checks that file instead). No other change; Task 13 drops the `infra/` alternative.
  - `deploy/README.md`: the three layers (tracked base, tracked e2e project, untracked host override from one of the two examples: `deploy/loopback/` for a single machine, `deploy/tailnet/` for a tailnet node), the env-file split (project `.env` for non-secret values and interpolation, secrets in files outside the repo via `env_file`), that `FICINO_OWNER_LOGIN` must be in the project `.env` (the override's only required variable; any tool that renders the config without `--env-file`, such as a sidecar auto-updater, fails otherwise), why the sidecar must run kernel mode with the 127.0.0.1 listen, the `/` → `/ficino/` redirect, `PUBLIC_API_BASE` must equal the stripped prefix, and the restore order (pointer to `server/README.md`). Generic placeholders only.

- [ ] **Step 4: Run to verify they pass**

Run: `npm run test:deploy`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add deploy .pre-commit-config.yaml
git commit -m "feat(deploy): tailnet node files (Serve config, override example, owner-gated web nginx)"
```

---

### Task 3: Loopback e2e stack and harness

**Files:**
- Create: `docker-compose.e2e.yml`, `scripts/e2e-stack.sh` (executable), `tests/e2e/helpers/seedSamplePaper.ts`, `deploy/test/e2e-compose.test.mjs`
- Rewrite: `.env.ci`
- Modify: `tests/e2e/helpers/globalSetup.ts`, `tests/e2e/helpers/ensureFeed.ts` (container defaults and their doc comment only), `playwright.config.ts` (the SSE comment and the `baseURL` default only), the 10 spec files that define their own base URL (`tests/e2e/r2_sections_{1_3,4_7,8_10,11_13,14_16,17_18}.spec.ts`, `review.spec.ts`, `round9_core_flows.spec.ts`, `wave4_group_chat.spec.ts`, `aug/augment.spec.ts`; the `E2E_BASE_URL` fallback string only)

**Interfaces:**
- Consumes: Task 1 helpers.
- Produces: compose project `ficino-e2e` with containers `ficino-e2e-postgres`, `ficino-e2e-api` (network alias `ficino-api`), `ficino-e2e-worker`, `ficino-e2e-web` (`127.0.0.1:${FICINO_E2E_PORT:-3070}:80`); knobs `FICINO_E2E_PORT` (default `3070`) and `E2E_OLLAMA_BASE_URL` (default `http://127.0.0.1:9`: the container's own loopback, where nothing listens, so every provider call is refused at once. A closed port on the host gateway is not equivalent: a host firewall with a default-drop input policy silently drops it, and each call then waits out its own timeout, 300 s for the LLM, instead of failing as it does on a CI runner).
- Produces: `scripts/e2e-stack.sh up [--ollama] | ci | full | down | logs`. `ci` and `full` export `E2E_BASE_URL=http://localhost:$PORT/ficino/`, `E2E_PSQL_CONTAINER=ficino-e2e-postgres`, `E2E_API_CONTAINER=ficino-e2e-api`, and run with `--reporter=line,json` and `PLAYWRIGHT_JSON_OUTPUT_NAME=tests/results/e2e-<ci|full>.json` (the gate compares totals and the skipped tests against `tests/e2e/SKIPS.md`); `full` also exports `E2E_SEED_SAMPLE_PDF=1` and runs `--project=desktop --project=mobile`.
- Produces: the harness defaults (`ensureFeed.ts`) become `E2E_PSQL_CONTAINER || 'ficino-e2e-postgres'` and `E2E_API_CONTAINER || 'ficino-e2e-api'`, and every base-URL fallback becomes `http://localhost:3070/ficino/`: `playwright.config.ts`'s `baseURL` and the 10 specs' own `BASE`/`APP_URL` constants (the specs navigate with those, not with `baseURL`, so changing only the config would leave a bare run seeding the e2e containers while browsing port 3000). A bare `npx playwright test` then targets the e2e stack or fails; it can never reach the production containers, which keep the old default names. `scripts/e2e-stack.sh` remains the supported way to run the suite (it always exports `E2E_BASE_URL`).
- Produces: `seedSamplePaper(baseUrl: string, opts?: { pdfPath?: string; timeoutMs?: number }): Promise<string>` (paper id).

- [ ] **Step 1: Write the failing tests** (`deploy/test/e2e-compose.test.mjs`):

```js
const E2E = ['docker-compose.e2e.yml'];
test('the e2e project never collides with the production names', …)
  // c.name === 'ficino-e2e'; every container_name starts 'ficino-e2e-'; no network has name 'ficino-network';
  // images: api/worker 'ficino-server:e2e', web 'ficino-web:e2e'
test('only the web publishes, on loopback', …)
  // web.ports deepEqual [{host_ip:'127.0.0.1', published:'3070', target:80, …}] (compare host_ip/published/target);
  // every other service has no ports
test('the port follows FICINO_E2E_PORT', …)            // env {FICINO_E2E_PORT:'3999'} -> published '3999'
test('the stock frontend nginx finds the API by its alias', …)
  // api.networks.default.aliases includes 'ficino-api'
test('providers default to a dead Ollama and can point at a real one', …)
  // api.environment.OLLAMA_BASE_URL === 'http://127.0.0.1:9' (and the same on worker);
  // with {E2E_OLLAMA_BASE_URL:'http://host.docker.internal:11434'} both api and worker get it
test('the worker mirrors production', …)
  // command ['node','dist/worker/main.js']; healthcheck.disable; stop_grace_period '45s'; volume sources equal api's
test('postgres matches .env.ci and the harness psql defaults', …)
  // postgres.environment deepEqual-includes {POSTGRES_USER:'ficino', POSTGRES_PASSWORD:'ficino', POSTGRES_DB:'ficino'};
  // api and worker depends_on.postgres.condition === 'service_healthy'
test('the harness defaults point at the e2e stack, never production', () => {
  const ef = readFileSync(join(REPO, 'tests/e2e/helpers/ensureFeed.ts'), 'utf8');
  assert.match(ef, /E2E_PSQL_CONTAINER \|\| 'ficino-e2e-postgres'/);
  assert.match(ef, /E2E_API_CONTAINER \|\| 'ficino-e2e-api'/);
  assert.doesNotMatch(ef, /\|\| 'ficino-(postgres|api)'/);
  assert.match(readFileSync(join(REPO, 'playwright.config.ts'), 'utf8'), /E2E_BASE_URL \|\| 'http:\/\/localhost:3070\/ficino\/'/);
  const files = execFileSync('git', ['ls-files', 'tests/e2e', 'playwright.config.ts'], { cwd: REPO, encoding: 'utf8' }).trim().split('\n');
  for (const f of files.filter((f) => /\.(ts|mjs|js)$/.test(f)))
    assert.doesNotMatch(readFileSync(join(REPO, f), 'utf8'), /localhost:3000/, f);
});
test('the stack script is executable on disk and in the index', () => {
  assert.ok(statSync(join(REPO, 'scripts/e2e-stack.sh')).mode & 0o111);
  assert.match(execFileSync('git', ['ls-files', '-s', 'scripts/e2e-stack.sh'], { cwd: REPO, encoding: 'utf8' }), /^100755 /);
});
test('.env.ci carries no secret and no legacy variable', () => {
  const env = readFileSync(join(REPO, '.env.ci'), 'utf8');
  assert.doesNotMatch(env, /REDIS|CELERY|SUPABASE|_API_KEY=(?!$)/m);
  assert.match(env, /^AUTH_PROVIDER=none$/m); assert.match(env, /^ENVIRONMENT=test$/m); assert.match(env, /^EMBED_DIM=1024$/m);
});
test('the stack script always targets the e2e project', () => {
  const sh = readFileSync(join(REPO, 'scripts/e2e-stack.sh'), 'utf8');
  for (const line of sh.split('\n').filter((l) => /docker compose/.test(l)))
    assert.match(line, /-p ficino-e2e -f docker-compose\.e2e\.yml/);
  execFileSync('bash', ['-n', join(REPO, 'scripts/e2e-stack.sh')]);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test:deploy`
Expected: FAIL (files missing).

- [ ] **Step 3: Implement**
  - `docker-compose.e2e.yml`: `name: ficino-e2e`; postgres `pgvector/pgvector:pg18` with `environment: {POSTGRES_USER: ficino, POSTGRES_PASSWORD: ficino, POSTGRES_DB: ficino}` (throwaway; matches `.env.ci` and the harness psql defaults), volume `pgdata:/var/lib/postgresql`, healthcheck; api and worker `depends_on: {postgres: {condition: service_healthy}}` (with `restart: "no"`, a boot race would kill the api and fail `up --wait`); api `build: ./server`, `image: ficino-server:e2e`, `env_file: [.env.ci]`, `environment: {OLLAMA_BASE_URL: "${E2E_OLLAMA_BASE_URL:-http://127.0.0.1:9}", CORS_ORIGINS: "http://localhost:${FICINO_E2E_PORT:-3070}"}`, `extra_hosts`, healthcheck as Task 1, `networks: {default: {aliases: [ficino-api]}}`, the three data volumes; worker as Task 1's worker with the e2e image and env; web `build: ./frontend`, `image: ficino-web:e2e`, the loopback publish, `depends_on: {api: {condition: service_healthy}}`; `restart: "no"` everywhere. Header: throwaway; always torn down with `scripts/e2e-stack.sh down`; never point it at real data.
  - `.env.ci`: `DATABASE_URL=postgresql://ficino:ficino@postgres:5432/ficino`, `LLM_PROVIDER`/`EMBED_PROVIDER`/`VISION_PROVIDER`/`FIGURE_DETECT_PROVIDER=ollama`, `EMBED_DIM=1024`, `AUTH_PROVIDER=none`, `PUBLIC_DEPLOYMENT=false`, `ENVIRONMENT=test`, `MAX_UPLOAD_SIZE_MB=50`. No model names (the full suite uses the server defaults), no keys. Comment: `ENVIRONMENT=test` keeps `Secure` cookies, which Chromium accepts on `http://localhost` only, so always use `localhost`, not `127.0.0.1`.
  - `scripts/e2e-stack.sh`: `set -euo pipefail`; `cd` to the repo root; `PORT=${FICINO_E2E_PORT:-3070}`; `up` runs `docker compose -p ficino-e2e -f docker-compose.e2e.yml up -d --build --wait` (with `--ollama`, first exports `E2E_OLLAMA_BASE_URL=http://host.docker.internal:11434`), then polls `http://localhost:$PORT/ficino/` for up to 60 s; `ci`/`full` as in Interfaces (`mkdir -p tests/results` first); `down` runs `… down -v --remove-orphans`; `logs` prints `… logs --no-color`. Unknown command → usage, exit 2. Make it executable: `chmod +x scripts/e2e-stack.sh && git add --chmod=+x scripts/e2e-stack.sh` (the new directory has no index entry yet; CI and the runbook call the script directly).
  - `tests/e2e/helpers/ensureFeed.ts`: the two container defaults become `'ficino-e2e-postgres'` and `'ficino-e2e-api'`; update the doc comment's defaults to match. No other change.
  - `tests/e2e/helpers/seedSamplePaper.ts`: GET `${baseUrl}api/papers` to obtain the `ficino_csrf` cookie; if a paper with `filename === 'e2e-sample.pdf'` is already `complete`, return its id; otherwise POST multipart `file` (`server/test/fixtures/sample.pdf`, sent as `e2e-sample.pdf`) to `${baseUrl}api/papers` with `X-CSRF-Token`, then poll `${baseUrl}api/papers/<id>` every 2 s until `complete` (resolve) or `error` (throw with the paper's `error_message`) or the timeout (default 300 000 ms; throw). Uses Playwright's `request.newContext` so cookies persist.
  - `globalSetup.ts`: becomes `async`; after `ensureFeedFixtures()`, `if (process.env.E2E_SEED_SAMPLE_PDF === '1') await seedSamplePaper(baseURL)` where `baseURL` comes from the config (`config.projects[0].use.baseURL`). Header comment: the full suite's R9-02 needs at least one real chunk in the corpus.
  - `playwright.config.ts`: replace the "SSE connection open for ~28s" sentence with "the Generate flow polls for a long time", and change the `baseURL` default to `'http://localhost:3070/ficino/'`; nothing else changes.
  - The 10 spec files: replace the fallback `'http://localhost:3000/ficino'` with `'http://localhost:3070/ficino/'` (trailing slash, as `E2E_BASE_URL` always has it); nothing else changes. These are test files, outside the byte-identical `frontend/` rule.

- [ ] **Step 4: Run to verify they pass**

Run: `npm ci && npm run test:deploy && npx playwright test --list --project=ci | tail -1` (from the repo root; the worktree has no root `node_modules` until `npm ci`)
Expected: PASS; the list ends with `Total: 124 tests in 8 files`.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.e2e.yml .env.ci tests/e2e playwright.config.ts deploy/test/e2e-compose.test.mjs
git add --chmod=+x scripts/e2e-stack.sh
git ls-files -s scripts/e2e-stack.sh            # starts with 100755
git commit -m "feat(e2e): loopback e2e stack for the TS server, with an optional real-paper seed"
```

---

### Task 4: CI on the TS stack

**Files:**
- Modify: `.github/workflows/ci.yml` (the `e2e` job; add a `deploy` job; leave the Python jobs for Task 13)
- Test: `deploy/test/ci.test.mjs`

**Interfaces:**
- Consumes: `scripts/e2e-stack.sh` (Task 3), `npm run test:deploy` (Task 1).

- [ ] **Step 1: Write the failing check** (`deploy/test/ci.test.mjs`):

```js
const ci = readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8');
// job keys may contain digits (`e2e`): the class must include 0-9, or job('e2e') is '' and its block stays inside the previous job
const job = (name) => ci.split(/\n  (?=[a-z0-9-]+:\n)/).find((b) => b.startsWith(`${name}:`)) ?? '';
test('the job splitter finds every job', () => {
  for (const n of ['e2e', 'deploy']) assert.ok(job(n).length > 0, n);
  assert.doesNotMatch(job('frontend'), /\n  e2e:\n/);
});
test('e2e runs on a runner Playwright supports and boots the TS stack', () => {
  const e2e = job('e2e');
  assert.match(e2e, /runs-on: ubuntu-24\.04/);
  assert.match(e2e, /scripts\/e2e-stack\.sh up/);
  assert.match(e2e, /scripts\/e2e-stack\.sh ci/);
  assert.match(e2e, /scripts\/e2e-stack\.sh down/);
  assert.doesNotMatch(e2e, /ficino-e2e-fe|\.env\.secrets|chown|docker compose up/);
});
test('deploy checks run in CI', () => assert.match(job('deploy'), /npm run test:deploy/));
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:deploy`
Expected: FAIL.

- [ ] **Step 3: Implement**
  - `e2e`: `runs-on: ubuntu-24.04` with a comment (Playwright 1.59 has no chromium for ubuntu-26.04); checkout; setup-node 22 with the root lockfile cache; `npm ci`; `mkdir -p tests/screenshots tests/results`; `scripts/e2e-stack.sh up`; `npx playwright install --with-deps chromium`; `scripts/e2e-stack.sh ci`; on `failure()` `scripts/e2e-stack.sh logs > tests/results/stack.log`; upload `tests/results/` and `tests/screenshots/` on failure; `if: always()` `scripts/e2e-stack.sh down`.
  - `deploy`: `runs-on: ubuntu-24.04`; checkout; setup-node 24; `docker compose version`; `npm run test:deploy`. The helpers need `docker compose config --no-env-resolution` (Task 1) and fail with a clear message on an older Compose; the implementer checks the ubuntu-24.04 runner image's published software list (its Docker Compose version must support the flag) and, only if it does not, adds a step that installs a pinned current Compose plugin before the tests; the result goes in the commit message. Never drop the flag.

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:deploy && docker run --rm -v "$PWD:/repo:ro" -w /repo rhysd/actionlint:1.7.7 -color .github/workflows/ci.yml`
Expected: PASS; actionlint prints nothing and exits 0.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml deploy/test/ci.test.mjs
git commit -m "ci: run the e2e gate on the TS stack on ubuntu-24.04 and add deploy checks"
```

---

### Task 5: Re-embed: shared embed text, `reembedUserChunks`, CLI

**Files:**
- Create: `server/src/ingest/embedText.ts`, `server/src/tasks/reembed.ts`, `server/src/db/reembed-cli.ts`
- Modify: `server/src/tasks/ingestion.ts` (Step 4 embed text), `server/package.json` (`"reembed": "tsx src/db/reembed-cli.ts"`)
- Test: `server/test/ingest/embedText.test.ts`, `server/test/tasks/reembed.test.ts`, `server/test/db/reembed-cli.test.ts`

**Interfaces:**
- Consumes: `embedTexts(p, deps, texts, {inputType, signal})`, `embedModelId(p)`, `EmbeddingUnavailableError` (`providers/embed.ts`); `loadJobSettings(sql, userId, env, config)` (`providers/config.ts`); `defaultProviderDeps()`; `STUB_USER_ID`; `pyStrip`.
- Produces:
  - `chunkEmbedText(c: { content: string; contextual_prefix?: string | null }): string` = `c.contextual_prefix ? pyStrip(`${prefix}\n\n${content}`) : c.content`.
  - `type ReembedResult = { target: string; updated: number; remaining: number }`
  - `reembedUserChunks(sql: Sql, providers: ProviderConfig, deps: ProviderDeps, opts: { userId: string; signal?: AbortSignal; log?: Logger; batchSize?: number /* default 64 */ }): Promise<ReembedResult>`
  - `embedModelCounts(sql: Sql, userId: string): Promise<Record<string, number>>` (key `'(none)'` for chunks without `embed_model`).
  - CLI `node dist/db/reembed-cli.js [--user <uuid>]` (default `STUB_USER_ID`): prints one JSON line `{ target, before, after, updated }`; exit 0 when `remaining === 0`, 1 otherwise or on any error (message on stderr). **stdout carries only that JSON line.** The shared `src/logger.ts` writes to stdout, so the CLI builds its own `pino({ level: process.env.LOG_LEVEL ?? 'info' }, pino.destination(2))` and passes it to `loadConfig(process.env, log)` and `reembedUserChunks({ log })`; nothing on the CLI path may log through the stdout logger (`loadConfig`'s default argument is that logger, so the explicit argument is required).

- [ ] **Step 1: Write the failing tests**

```ts
// test/ingest/embedText.test.ts
it('is the content when there is no prefix', () => expect(chunkEmbedText({ content: ' Body ', contextual_prefix: '' })).toBe(' Body '));
it('joins prefix and content and strips like Python', () =>
  expect(chunkEmbedText({ content: 'Body \n', contextual_prefix: ' Ctx' })).toBe('Ctx\n\nBody'));

// test/tasks/reembed.test.ts (fake embed provider from test/helpers/fakeProviders.ts records its inputs)
it('re-embeds only chunks whose embed_model differs and tags them in the same write', …)
  // user A paper: chunks c0 metadata {} , c1 metadata {} , c2 {embed_model: target, keep: 1} with vector V2
  // -> result { target, updated: 2, remaining: 0 }; fake saw exactly [text(c0), text(c1)];
  // all three rows have embed_model === target; c2 embedding still V2 and metadata.keep still 1
it('embeds the same text ingestion embeds', …)          // fake inputs equal chunkEmbedText(row) for a prefixed chunk
it('a second run is a no-op', …)                        // updated 0, fake not called
it('never touches another user', …)                     // user B chunks keep metadata {} and their vectors
it('abort after the first batch leaves a consistent partial', …)
  // batchSize 2, 5 mismatched chunks, the fake aborts the controller during its 2nd call (no delayMs: the fake still
  // answers that call with vectors, so only the check after embedTexts keeps batch 2 from being written)
  // -> rejects with an AbortError; exactly 2 rows tagged with the fake's vectors; 3 rows unchanged (metadata {}, old vectors);
  // a rerun returns { updated: 3, remaining: 0 }
it('tags a chunk whose metadata is NULL', …)
  // c0 metadata NULL (the column is nullable) -> { updated: 1, remaining: 0 }; c0.metadata = {embed_model: target};
  // a second run is a no-op (the fake not called again)
it('an embedding failure mid-run keeps committed batches', …)   // fake throws on call 2 -> rejects; first batch tagged, rest untouched
it('an unavailable provider stops before writing', …)  // EmbeddingUnavailableError -> rejects; no row changed
it('counts chunks per embed_model', …)                  // embedModelCounts -> { '(none)': 2, [target]: 1 }

// test/db/reembed-cli.test.ts: a scratch DB (createScratchDb + migrate) seeded with 3 untagged chunks for STUB_USER_ID,
// and an in-test HTTP server on 127.0.0.1:0 answering POST /api/embed with 1024-d vectors.
// Both tests spawn a process, so each `it` gets an explicit timeout of 30_000 (vitest's default is 5 s).
it('re-embeds the stub user and reports before and after', …)
  // spawn `node --import tsx src/db/reembed-cli.ts` with DATABASE_URL, OLLAMA_BASE_URL=http://127.0.0.1:<port>,
  // LOG_LEVEL: 'info' (the suite's setup sets 'silent', which would hide a log line on stdout);
  // exit 0; JSON.parse(stdout) of the WHOLE stdout succeeds and equals
  // { target: 'ollama:qwen3-embedding:latest@1024', before: {'(none)': 3}, after: {[target]: 3}, updated: 3 };
  // stderr contains a 'reembed_batch' log line (the logs went to stderr)
it('exits 1 when the provider fails', …)
  // the in-test server answers POST /api/embed with 400 (a 4xx is not retried, so this fails fast;
  // an unreachable port would sit through embedTexts' 2 s + 6 s retries) -> exit 1, rows unchanged
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx vitest run test/ingest/embedText.test.ts test/tasks/reembed.test.ts test/db/reembed-cli.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**
  - `ingestion.ts` Step 4 builds `texts` with `chunkEmbedText`.
  - `reembedUserChunks`: target = `embedModelId(providers)`. Loop: select up to `batchSize` rows `SELECT c.id, c.content, c.contextual_prefix FROM chunks c JOIN papers p ON p.id = c.paper_id WHERE p.user_id = $user AND c.metadata->>'embed_model' IS DISTINCT FROM $target ORDER BY c.paper_id, c.chunk_index LIMIT $batch`; `embedTexts(..., { inputType: 'document', signal })`; `signal?.throwIfAborted()` again after `embedTexts` returns (an abort during the call discards that batch: an embed call does not always reject on abort); one `UPDATE chunks c SET embedding = v.e::vector, metadata = COALESCE(c.metadata, '{}'::jsonb) || jsonb_build_object('embed_model', $target::text) FROM unnest($ids::uuid[], $vecs::text[]) AS v(id, e) WHERE c.id = v.id AND c.metadata->>'embed_model' IS DISTINCT FROM $target` (vectors sent as pgvector text `[x,y,…]`; `chunks.metadata` is nullable and jsonb `||` with NULL is NULL, so without the `COALESCE` a NULL-metadata row would keep matching the select forever); `signal?.throwIfAborted()` before each batch; log `reembed_batch {updated, total}`. A batch whose `UPDATE` changes no row throws `Error('reembed made no progress on <n> chunks')`, so the loop can never spin on rows it cannot tag (fewer rows than selected is allowed: a paper deleted meanwhile). Ends when a select returns no rows; `remaining` from a final count. No pg-boss, no `process.env` writes.
  - CLI: `loadConfig()`, `createSql(config.databaseUrl, { max: 2 })`, `loadJobSettings(sql, user, process.env, config)`, `defaultProviderDeps()`; validate `--user` with `isUuid`; `sql.end()` in `finally`.

- [ ] **Step 4: Run to verify they pass**

Run: `cd server && npx vitest run test/ingest test/tasks/reembed.test.ts test/db/reembed-cli.test.ts test/tasks/ingestion.test.ts`
Expected: PASS (the ingestion tests and goldens unchanged).

- [ ] **Step 5: Commit**

```bash
git add server/src/ingest/embedText.ts server/src/tasks/reembed.ts server/src/db/reembed-cli.ts server/src/tasks/ingestion.ts server/package.json server/test
git commit -m "feat(server): re-embed CLI that rewrites vectors and embed_model together"
```

---

### Task 6: pg_dump COPY-block parser and the synthetic archive builder

**Files:**
- Create: `server/src/restore/errors.ts`, `server/src/restore/dump.ts`, `server/test/helpers/syntheticArchive.ts`
- Test: `server/test/restore/dump.test.ts`

**Interfaces:**
- Produces (`errors.ts`): `class RestoreError extends Error {}`.
- Produces (`dump.ts`):
  - `type CopyBlock = { schema: string; table: string; columns: string[]; rows: string[] }` (rows are the raw COPY text lines, without the `\.` terminator).
  - `parseDump(text: string): CopyBlock[]`: every `COPY <schema>.<table> (<cols>) FROM stdin;` block, quoted or unquoted identifiers; every other line (SET, `\restrict`, comments, DDL) ignored. An unterminated block throws `RestoreError('COPY block for <schema>.<table> is not terminated')`.
  - `publicBlocks(blocks: CopyBlock[], skip?: ReadonlySet<string>): CopyBlock[]`: `schema === 'public'` and table not in `skip` (default `new Set(['personas', 'schema_migrations'])`).
- Produces (`syntheticArchive.ts`):
  - `SYN` ids: `owner`, `orphan`, `defaultCorpus`, `otherCorpus`, `orphanCorpus`, `paperDefault`, `paperOther`, `feedPlain`, `feedLegacyPodcast`, `feedEpisode`, `figure`, `summary`, `synthesisWithMessages`, `synthesisEmpty`, `userPost`, `readingList`; `SECRET_MARKER = 'SYNTHETIC-SECRET-MARKER'`.
  - `buildSyntheticDump(opts?: { secondOwner?: boolean; extraColumn?: boolean; omitDefaultCorpus?: boolean; orphanChapter?: boolean }): string`: a pg_dump-shaped text with `\restrict`/`\unrestrict` lines, `SET` lines, an `auth.users` and `auth.refresh_tokens` block containing `SECRET_MARKER`, a `storage.objects` block, and public blocks: users (owner, orphan), corpora (owner `Default`, owner `Other`, orphan `Default`), papers (one per owner corpus, `file_path` `<owner>/<paper>.pdf`), chunks (2 + 1, `metadata {}`, 1024-d vectors), figures (one: id `SYN.figure`, `paper_id` `SYN.paperDefault`, `image_path` `<owner>/<paperDefault>/figures/fig_p1_1.png`), feeds (`feedPlain` with a `figure_url` on post 0 and `audio_key` `<owner>/feeds/<feed>/audio/post_0.mp3`; `feedLegacyPodcast` with `podcast_status ready` and segments carrying `audio_key` `…/podcast/seg_0.mp3`; `feedEpisode` with `podcast_status ready` and segments without `audio_key`), feed_posts covering only post 0 of `feedPlain` (drift), personas (one row with `avatar_url '/personas/x.png'`), paper_summaries (`generating`, a legacy task id), corpus_syntheses (`generating` with two messages; `generating` with `[]`), user_posts (`pending`), post_replies (messages double-encoded as a JSON string), user_settings, tags/paper_tags, reading_lists + one chapter, alerts, audit_log (one `paper.delete` row whose `metadata` is `{filename, corpus_id: SYN.defaultCorpus}`, and one row with `resource_type 'corpus'`, `resource_id` = `SYN.defaultCorpus`), user_likes. Column lists are subsets of the baseline columns, in the order written. `extraColumn` adds a column `legacy_col` to the users block; `secondOwner` gives the orphan a paper; `orphanChapter` adds a second `reading_list_chapters` row whose `reading_list_id` matches no reading list.
  - `SYNTHETIC_POST_COUNT` (sum of `jsonb_array_length(posts)` over the feeds).

- [ ] **Step 1: Write the failing tests**

```ts
it('parses every COPY block with its columns and rows', () => {
  const blocks = parseDump(buildSyntheticDump());
  const users = blocks.find((b) => b.schema === 'public' && b.table === 'users')!;
  expect(users.columns).toContain('id');
  expect(users.rows).toHaveLength(2);
  expect(blocks.some((b) => b.schema === 'auth')).toBe(true);
});
it('keeps only public data and skips personas', () => {
  const tables = publicBlocks(parseDump(buildSyntheticDump())).map((b) => b.table);
  expect(tables).not.toContain('personas');
  expect(tables).toContain('feed_posts');
  expect(JSON.stringify(publicBlocks(parseDump(buildSyntheticDump())))).not.toContain(SECRET_MARKER);
});
it('accepts unquoted identifiers', () =>
  expect(parseDump('COPY public.tags (id, name) FROM stdin;\na\tb\n\\.\n')[0]).toMatchObject({ schema: 'public', table: 'tags', columns: ['id', 'name'], rows: ['a\tb'] }));
it('treats an escaped backslash-dot inside data as data', () =>
  expect(parseDump('COPY "public"."tags" ("id") FROM stdin;\n\\\\.\n\\.\n')[0]!.rows).toEqual(['\\\\.']));
it('rejects an unterminated block', () =>
  expect(() => parseDump('COPY "public"."tags" ("id") FROM stdin;\nx\n')).toThrow(/public\.tags is not terminated/));
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx vitest run test/restore/dump.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `parseDump`, `publicBlocks`, `RestoreError` and the builder (the builder's COPY text escaping: `\N` for null, backslash, tab, newline and carriage return escaped as COPY text format requires).

- [ ] **Step 4: Run to verify they pass**

Run: `cd server && npx vitest run test/restore/dump.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/restore server/test/helpers/syntheticArchive.ts server/test/restore/dump.test.ts
git commit -m "feat(server): parse pg_dump COPY blocks for the archive restore"
```

---

### Task 7: Restored-data cleanup

**Files:**
- Create: `server/src/restore/cleanup.ts`
- Modify: `server/src/tasks/feed.ts` (`writeFeedPostsIndex`'s first parameter type only)
- Test: `server/test/restore/cleanup.test.ts`

**Interfaces:**
- Consumes: `writeFeedPostsIndex(sql, feedId, posts, 0, userId)` (`tasks/feed.ts`); `RestoreError`.
- Modifies: `writeFeedPostsIndex`'s first parameter becomes `Sql | postgres.TransactionSql | postgres.ReservedSql` (the repo's pattern for tx-capable helpers, as `settings/stored.ts`); its body and existing callers (which pass the pool) are unchanged. A postgres.js `TransactionSql` or `ReservedSql` is not assignable to `Sql`, so without this `npm run typecheck` fails.
- Produces:
  - `type RestoreDb = Sql | postgres.TransactionSql | postgres.ReservedSql` (exported from `cleanup.ts`; Task 8 imports it). Every restore helper that can run inside the restore transaction takes a `RestoreDb`, never a bare `Sql`.
  - `JSONB_ARRAY_COLUMNS: ReadonlyArray<readonly [table: string, column: string]>` = `feeds.posts`, `feeds.podcast_segments`, `post_replies.messages`, `persona_dms.messages`, `paper_summaries.messages`, `corpus_syntheses.messages`, `user_posts.replies`, `user_posts.sources`, `reading_lists.rationale`.
  - `jsonbShapeViolations(sql: RestoreDb): Promise<Record<string, number>>`: per `table.column`, the count of rows where the value is not NULL and `jsonb_typeof <> 'array'`.
  - `type CleanupReport = { paths: { papers: number; figures: number }; jsonbDecoded: Record<string, number>; figureUrlsStripped: number; audioKeysRekeyed: number; legacyPodcastsCleared: number; userPostsErrored: number; synthesesHealed: number; synthesesErrored: number; summariesGenerating: number; chunksTagged: number; feedPosts: number }`. Units: `figureUrlsStripped` and `audioKeysRekeyed` count **posts** changed (array elements in `feeds.posts`), not feed rows, so a set-based `UPDATE feeds` must count the changed elements (e.g. a CTE over `jsonb_array_elements … WITH ORDINALITY` that sums the matching posts) rather than report its affected-row count; segment `audio_key`s cleared with a legacy podcast are not in `audioKeysRekeyed`. `legacyPodcastsCleared`, `userPostsErrored`, `syntheses*`, `summariesGenerating`, `chunksTagged` count rows; `feedPosts` counts rebuilt `feed_posts` rows; `jsonbDecoded` counts rows per `table.column`.
  - `cleanupRestoredData(tx: RestoreDb, opts: { sourceEmbedModel: string; log?: Logger }): Promise<CleanupReport>`, steps in this order:
    1. `papers.file_path = '/app/uploads/' || id || '.pdf'`; `figures.image_path = '/app/figures/' || paper_id || '/' || <basename>`.
    2. For every `JSONB_ARRAY_COLUMNS` entry: a string value whose `#>> '{}'` parses to a JSON array is replaced by that array (`jsonbDecoded` counts).
    3. `feeds.posts`: drop `figure_url` from every post; strip a leading `<uuid>/` from `audio_key`; order kept.
    4. Legacy stitched podcast: `podcast_status`, `podcast_generated_at`, `podcast_segments`, `podcast_claimed_at` set NULL where `podcast_segments` is an array with any element carrying `audio_key`.
    5. Stuck rows: `user_posts` `pending` → `error`; `corpus_syntheses` `pending`/`generating` with a non-empty array `messages` → `complete`, `task_id = NULL`; the remaining `pending`/`generating` → `error`, `task_id = NULL`; `paper_summaries` `generating` only counted (an `error` row re-dispatches on view anyway).
    6. Chunks without `metadata.embed_model` get `{"embed_model": sourceEmbedModel}` (provenance; the re-embed replaces it): `SET metadata = COALESCE(metadata, '{}'::jsonb) || … WHERE NOT COALESCE(metadata, '{}'::jsonb) ? 'embed_model'` (`metadata` is nullable; `||` and `?` on NULL give NULL, which would skip the row).
    7. `DELETE FROM feed_posts`, then `writeFeedPostsIndex` for every feed whose `posts` is an array (with the feed's `user_id`).
    8. `jsonbShapeViolations` must be all zero, else `RestoreError('jsonb shape: post_replies.messages=1, …')` (non-zero entries only).

- [ ] **Step 1: Write the failing tests** (rows seeded directly with `STUB_USER_ID` after `resetDb`; one `sql.begin` per test, passing the tx):

```ts
it('rewrites file paths to the TS layout', …)
  // paper.file_path '<uid>/<paper>.pdf' -> '/app/uploads/<paper>.pdf'; figure '<uid>/<paper>/figures/fig_p1_1.png' -> '/app/figures/<paper>/fig_p1_1.png'
it('strips figure_url and the user prefix from audio_key, keeping order', …)
  // posts [{content:'a', figure_url:'https://x.supabase.co/s?t=1', audio_key:'<uuid>/feeds/<f>/audio/post_0.mp3'}, {content:'b'}]
  // -> [{content:'a', audio_key:'feeds/<f>/audio/post_0.mp3'}, {content:'b'}]; report figureUrlsStripped 1, audioKeysRekeyed 1
it('counts posts, not feeds', …)
  // one feed, three posts: posts 0 and 1 each have a figure_url and a user-prefixed audio_key, post 2 neither;
  // plus a second feed with one such post -> figureUrlsStripped 3, audioKeysRekeyed 3
it('clears a legacy stitched podcast and keeps a single-episode one', …)
  // segments [{speaker:'host_a', audio_key:'…/seg_0.mp3'}] -> all four podcast columns NULL; segments [{speaker:'host_a'}] untouched, status 'ready'
it('decodes double-encoded jsonb arrays', …)
  // post_replies.messages = to_jsonb('[{"role":"user","content":"hi"}]'::text) -> jsonb_typeof 'array', length 1; jsonbDecoded['post_replies.messages'] 1;
  // a double-encoded feeds.posts is decoded and then cleaned (no figure_url)
it('a jsonb value that is neither an array nor an encoded array aborts', …)
  // persona_dms.messages = '{"a":1}' -> rejects RestoreError /persona_dms\.messages=1/
it('sweeps stuck rows', …)
  // user_posts pending -> error; synthesis with 2 messages -> complete, task_id null; synthesis [] -> error, task_id null;
  // summary generating unchanged; report { userPostsErrored:1, synthesesHealed:1, synthesesErrored:1, summariesGenerating:1 }
it('tags only untagged chunks with the source model', …)
  // {} -> {embed_model:'voyage:voyage-4-large@1024'}; NULL -> the same; {embed_model:'x', k:1} unchanged; chunksTagged 2
it('rebuilds feed_posts from the cleaned posts', …)
  // feed with 3 posts (post 1 has figure_url) and one stale feed_posts row -> 3 rows, post_index [0,1,2],
  // data of row 1 has no figure_url, content_text equals each post's content; report feedPosts 3
it('is idempotent', …)
  // a second call reports 0 for every transform and the same feedPosts; rows identical to after the first call
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx vitest run test/restore/cleanup.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `cleanupRestoredData` and `jsonbShapeViolations` as specified (set-based SQL per step; JSON edits with `jsonb_agg(… ORDER BY ordinality)`; table and column names from the constant list via `sql(identifier)`).

- [ ] **Step 4: Run to verify they pass**

Run: `cd server && npm run typecheck && npx vitest run test/restore/cleanup.test.ts test/tasks/feed.test.ts`
Expected: PASS (typecheck proves the tx is accepted everywhere it is passed).

- [ ] **Step 5: Commit**

```bash
git add server/src/restore/cleanup.ts server/src/tasks/feed.ts server/test/restore/cleanup.test.ts
git commit -m "feat(server): clean restored data (paths, legacy media, stuck rows, jsonb shapes, feed_posts)"
```

---

### Task 8: Database restore: preconditions, load, discovery, re-key, integrity

**Files:**
- Create: `server/src/restore/database.ts`
- Modify: `server/src/db/migrate.ts` (export `migrationVersions`)
- Test: `server/test/restore/database.test.ts`

**Interfaces:**
- Consumes: `parseDump`, `publicBlocks` (Task 6); `cleanupRestoredData`, `CleanupReport`, `RestoreDb` (Task 7); `migrate`; `STUB_USER_ID`, `DEFAULT_WORKSPACE_ID`; `createScratchDb` (test helper).
- Produces:
  - `migrationVersions(dir?: string): Promise<string[]>` in `migrate.ts` (the sorted 4-char versions `migrate()` would record; `migrate()` uses it).
  - `type RestoreIds = { owner: string; orphans: string[]; sourceDefaultCorpus: string }`
  - `type RestoreReport = { dryRun: boolean; loaded: Record<string, number>; skippedSchemas: string[]; ids: RestoreIds; cleanup: CleanupReport; counts: Record<string, number> }`
  - `assertRestorable(sql: Sql, migrationsDir?: string): Promise<{ stubToReplace: boolean }>`: throws `RestoreError` (`'schema_migrations does not match the migrations: …'` or `'target database is not empty: <table>=<n>, …'`) unless `schema_migrations` equals `migrationVersions()` and every table in `RESTORED_TABLES` is empty, except a stub user (`STUB_USER_ID`) whose only row anywhere is an empty `DEFAULT_WORKSPACE_ID` corpus (then `stubToReplace: true`).
  - `discoverIds(tx: RestoreDb): Promise<RestoreIds>`: owner = the single user owning any `papers` or `feeds` row (else `RestoreError('expected exactly one owner, found N')`); orphans = every other user, each owning only corpora with no papers, feeds, reading_lists or user_posts (else `RestoreError('user <id> owns data')`); source Default = the owner's corpus named `Default` (exactly one, else `RestoreError`).
  - `orphanReferenceCounts(sql: RestoreDb): Promise<Record<string, number>>`: built from the catalog, not a name list: for every foreign key in `pg_constraint` (`contype = 'f'`) on a `public` table, the child rows whose non-null key has no parent row; plus the two reference columns the baseline leaves without a foreign key, `post_replies.persona_key` and `user_likes.persona_key` (→ `personas.key`). Keys are `<table>.<column>`; every entry is present, zero or not. The load runs with `session_replication_role = replica`, so this check is what stands in for the foreign keys.
  - `sourceIdCounts(sql: RestoreDb, ids: RestoreIds): Promise<Record<string, number>>`: per `public` table, the rows whose `to_jsonb(t)::text` contains the owner id, an orphan id or the source Default corpus id (non-zero tables only).
  - `restoreDatabase(sql: Sql, dumpText: string, opts: { sourceEmbedModel: string; dryRun?: boolean; migrationsDir?: string; log?: Logger }): Promise<RestoreReport>`.

Flow of `restoreDatabase`: `assertRestorable` → `parseDump` → `publicBlocks` → every block's table and columns must exist in `information_schema.columns` (else `RestoreError` naming each missing `table.column` or table) → one `sql.begin`: `SET LOCAL session_replication_role = replica`; delete the stub/Default when `stubToReplace`; stream each block through `COPY "public"."<t>" (<cols>) FROM STDIN` (postgres.js `.writable()`); `discoverIds`; delete orphans' corpora and users; for every `public` column named `user_id` set owner → `STUB_USER_ID`, every `corpus_id` set source Default → `DEFAULT_WORKSPACE_ID` (catalog-driven loop, as `rekey-test.sql`); `UPDATE corpora SET id = DEFAULT_WORKSPACE_ID WHERE id = <source Default>`; `UPDATE users SET id = STUB_USER_ID, clerk_id = 'stub' WHERE id = <owner>`; `audit_log`, whose ids also live outside id columns: `metadata->>'corpus_id'` equal to the source Default → `DEFAULT_WORKSPACE_ID` (`jsonb_set`), `resource_id` equal to the source Default → `DEFAULT_WORKSPACE_ID`, `resource_id` equal to the owner → `STUB_USER_ID`; `cleanupRestoredData`; `orphanReferenceCounts` all zero (else `RestoreError` listing the non-zero ones); `sourceIdCounts` empty (else `RestoreError('source ids remain: <table>=<n>, …')`; a real archive with an id in a place this flow does not know stops the restore rather than leaving a dangling id); `counts` per restored table; `dryRun` rolls back after building the report. Logs counts only, never row content.

- [ ] **Step 1: Write the failing tests** (each test: `createScratchDb()`, `migrate()`, drop in `afterEach`):

```ts
it('restores the synthetic dump re-keyed to the stub user and the default workspace', …)
  // users: one row, id STUB_USER_ID, clerk_id 'stub'; corpora ids sorted = [DEFAULT_WORKSPACE_ID, SYN.otherCorpus];
  // papers/feeds/chunks/user_settings user_id all STUB_USER_ID; SYN.paperDefault.corpus_id === DEFAULT_WORKSPACE_ID;
  // for every public table, `SELECT count(*) FROM t WHERE to_jsonb(t)::text ~ <SYN.owner|SYN.orphan|SYN.defaultCorpus|SYN.orphanCorpus>` is 0;
  // (this covers the audit_log metadata.corpus_id and resource_id rows); orphanReferenceCounts all 0 and has a
  // 'reading_list_chapters.reading_list_id' key; counts.feed_posts === SYNTHETIC_POST_COUNT
it('aborts on an orphan reference', …)                    // {orphanChapter:true} -> rejects /reading_list_chapters\.reading_list_id=1/; DB empty
it('never loads auth, storage or personas', …)
  // personas rows equal the baseline seed (every avatar_url starts '/ficino/personas/'); no public row contains SECRET_MARKER;
  // JSON.stringify(report) has no SECRET_MARKER; report.skippedSchemas includes 'auth' and 'storage'; no schema 'auth' exists
it('leaves schema_migrations as the runner wrote it', …)   // rows before === rows after
it('aborts on a second run without writing', …)           // second call rejects /not empty/; every table count unchanged
it('replaces an untouched stub user and Default workspace from an early API boot', …) // ensureStubUser first -> succeeds, as above
it('aborts when the stub owns data', …)                   // ensureStubUser + a paper for the stub -> rejects; that paper still the only paper
it('aborts when migrations are not all applied', …)       // scratch DB without migrate -> rejects /schema_migrations/
it('aborts on two candidate owners', …)                   // buildSyntheticDump({secondOwner:true}) -> rejects /exactly one owner, found 2/; DB empty
it('aborts on a dump column the schema lacks', …)         // {extraColumn:true} -> rejects /users\.legacy_col/; DB empty
it('aborts without a Default corpus for the owner', …)    // {omitDefaultCorpus:true} -> rejects /Default/; DB empty
it('a dry run reports and rolls back', …)                 // dryRun -> report.counts.papers 2, report.dryRun true; afterwards users count 0
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx vitest run test/restore/database.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `migrationVersions`, `assertRestorable`, `discoverIds`, `orphanReferenceCounts`, `restoreDatabase` as specified. `RESTORED_TABLES` = every public table except `personas`, `schema_migrations` and the TS-only `sessions`, `rate_limits`, `job_progress`. If `.writable()` cannot run inside `sql.begin`, stream through a reserved connection (`sql.reserve()`) with explicit `BEGIN`/`COMMIT`/`ROLLBACK`; the tests decide. Either way the helpers receive the tx or reserved connection typed as `RestoreDb` (Task 7); `npm run typecheck` is part of Step 4.

- [ ] **Step 4: Run to verify they pass**

Run: `cd server && npm run typecheck && npx vitest run test/restore test/db`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/restore/database.ts server/src/db/migrate.ts server/test/restore/database.test.ts
git commit -m "feat(server): data-only archive restore re-keyed to the stub user"
```

---

### Task 9: Archive storage copy into the TS layout

**Files:**
- Create: `server/src/restore/files.ts`
- Modify: `server/test/helpers/syntheticArchive.ts` (add the storage builder)
- Test: `server/test/restore/files.test.ts`

**Interfaces:**
- Consumes: `restoreDatabase` (Task 8, to set up the DB in tests); `StorageDirs` (`storage/local.ts`); `RestoreError`.
- Produces:
  - `type ManifestEntry = { name: string; size: number; etag: string }` (archive manifest: `name` relative to the bucket root, `<user>/<…>`; `etag` quoted md5, or `"<hex>-<n>"` for a multipart upload).
  - `type PlannedCopy = { key: string; from: string; to: string; kind: 'pdf' | 'figure' | 'audio' | 'episode'; md5: string | null }`
  - `type FileCopyPlan = { copies: PlannedCopy[]; skipped: { key: string; reason: string }[]; missing: { kind: string; id: string; expected: string }[] }`
  - `planStorageCopy(sql: Sql, bucketRoot: string, manifest: ManifestEntry[], dirs: StorageDirs): Promise<FileCopyPlan>`. Mapping on the key with its leading `<uuid>/` removed:
    - `<paper>.pdf` → `uploadDir/<paper>.pdf` when the `papers` row exists, else skip `no papers row`;
    - `<paper>/figures/<file>` → `figuresDir/<paper>/<file>` when a `figures` row has that `paper_id` and basename, else skip `no figures row`;
    - `feeds/<feed>/audio/post_<i>.mp3` → `mediaDir/feeds/<feed>/audio/post_<i>.mp3` when post `i` of that feed has exactly that `audio_key`, else skip `no matching audio_key`;
    - `feeds/<feed>/podcast/episode.mp3` → `mediaDir/…` when the feed's `podcast_status` is `ready`, else skip `podcast not ready`;
    - any other key → skip `not a TS media key`; a key with `..`, a leading `/`, or a target outside its dir → skip `unsafe key`.
    Each planned source is checksummed (md5 against the etag; size only for multipart etags); any mismatch or absent source throws `RestoreError('checksum mismatch: <key>')` / `('source missing: <key>')` before anything is copied. `missing` lists DB rows (papers, figures, each `audio_key`, each `ready` episode) with no planned copy and no existing target file.
  - `copyStorage(plan: FileCopyPlan, dirs: StorageDirs, opts?: { chown?: { uid: number; gid: number }; chownImpl?: (path: string, uid: number, gid: number) => Promise<void> }): Promise<{ copied: number }>`: `mkdir -p` (0755), copy, chmod 0644, re-checksum the target; then, when `chown` is given, `chown -R` semantics over `dirs.uploadDir`, `dirs.figuresDir` and `dirs.mediaDir`: the three roots themselves and every directory and file below them, so every intermediate level the copy created (`feeds`, `feeds/<id>`, `feeds/<id>/audio|podcast`, `<paper>`) ends up owned by the app user. Chowning only the files is not enough: the api and worker (non-root) write a temp file and rename it inside the target dir (`storage/local.ts` `atomicWrite`) and remove `feeds/<id>` recursively, so a root-owned directory breaks new audio, re-renders and deletes for restored feeds and papers. `chownImpl` (default `fs.promises.chown`) is the test seam; `lchown` semantics are not needed (the copy creates no links).
- Produces (builder): `buildSyntheticStorage(root: string): Promise<ManifestEntry[]>` writing `<root>/<SYN.owner>/…`: both paper PDFs, an orphan PDF, the figure, a figure with no row, `feeds/<feedPlain>/audio/post_0.mp3`, `feeds/<feedLegacyPodcast>/podcast/seg_0.mp3`, `feeds/<feedEpisode>/podcast/episode.mp3`; returns the manifest with real md5 etags.

- [ ] **Step 1: Write the failing tests** (scratch DB restored from `buildSyntheticDump()`; temp bucket and temp `uploadDir/figuresDir/mediaDir`):

```ts
it('maps PDFs, figures, audio and the episode into the TS layout', …)
  // copies' `to` values (relative to their dir) = ['<paperDefault>.pdf','<paperOther>.pdf','<paperDefault>/fig_p1_1.png',
  //   'feeds/<feedPlain>/audio/post_0.mp3','feeds/<feedEpisode>/podcast/episode.mp3'] (sorted); after copyStorage each file's md5 equals the source
it('skips objects with no row', …)
  // skipped reasons: orphan PDF 'no papers row', stray figure 'no figures row', seg_0.mp3 'not a TS media key'
it('aborts on a checksum mismatch before copying anything', …)   // tamper one PDF -> planStorageCopy rejects /checksum mismatch/; all target dirs empty
it('rejects a key that escapes the bucket', …)                   // manifest entry '<owner>/../x.pdf' -> skipped 'unsafe key'; nothing written outside
it('reports DB rows whose file is absent', …)                    // remove the figure from bucket and manifest -> missing contains {kind:'figure', id: SYN.figure}
it('copying twice is harmless and files are 0644', …)            // second copyStorage succeeds; every file mode & 0o777 === 0o644
it('chowns the roots, every created directory and every file', …)
  // chownImpl records paths; chown {uid: 4242, gid: 4242} -> the recorded set equals every path under the three roots
  // (walked after the copy) plus the roots: it includes mediaDir/feeds, feeds/<feedPlain>, feeds/<feedPlain>/audio,
  // feeds/<feedEpisode>/podcast, figuresDir/<paperDefault> and every copied file; every call had uid 4242, gid 4242
it('chowns for real when root', …)                               // it.skipIf(process.getuid?.() !== 0): chown 4242:4242 with
  // the default chownImpl -> lstat of each of those directories and files has uid 4242 and gid 4242 (a uid the process does not own)
it('does not chown without the option', …)                       // chownImpl never called
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx vitest run test/restore/files.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `planStorageCopy` and `copyStorage` as specified.

- [ ] **Step 4: Run to verify they pass**

Run: `cd server && npx vitest run test/restore/files.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/restore/files.ts server/test/helpers/syntheticArchive.ts server/test/restore/files.test.ts
git commit -m "feat(server): copy archived storage objects into the TS storage layout"
```

---

### Task 10: Restore CLI and `verify`

**Files:**
- Create: `server/src/restore/verify.ts`, `server/src/restore/cli.ts`
- Modify: `server/package.json` (`"restore": "tsx src/restore/cli.ts"`)
- Test: `server/test/restore/verify.test.ts`, `server/test/restore/cli.test.ts`

**Interfaces:**
- Consumes: Tasks 7-9; `embedModelCounts` (Task 5); `loadConfig`, `createSql`.
- Produces:
  - `type VerifyCheck = { name: string; ok: boolean; detail: unknown }`; `type VerifyResult = { ok: boolean; checks: VerifyCheck[] }`
  - `verifyRestore(sql: Sql, dirs: StorageDirs, opts?: { embedModel?: string; owner?: { uid: number; gid: number } }): Promise<VerifyResult>` with checks named exactly: `single stub user`, `default workspace`, `orphan references`, `jsonb shapes`, `no supabase urls` (`feeds.posts` and `feed_posts.data` text contain no `supabase.co`), `no user-prefixed audio keys`, `feed_posts match posts` (row count per feed = `jsonb_array_length(posts)`), `embed model` (one group equal to `opts.embedModel` when given; otherwise ok with the counts as detail), `files present` (every paper PDF, figure, `audio_key` and `ready` episode exists), `file owner` (only with `opts.owner`: the three storage roots and every directory and file below them have that uid and gid; detail lists up to 20 offending paths and the total).
  - CLI (`node dist/restore/cli.js`), one JSON object on stdout, exit 0 on success, 1 on any `RestoreError` or failed check (message only on stderr, no stack, no row content):
    - `db --dump <file> --source-embed-model <id> [--dry-run]` → `RestoreReport`
    - `files --bucket <dir> --manifest <file> [--chown <uid>:<gid>] [--dry-run]` → `{ copies, skipped, missing, copied }` (`--dry-run` stops after the plan and chowns nothing; `missing` non-empty → exit 1; `copyStorage` gets the dirs from `loadConfig()`)
    - `verify [--embed-model <id>] [--owner <uid>:<gid>]` → `VerifyResult`
    `--source-embed-model` is required: the restore never guesses the archive's model. Logs (pino JSON, counts only) go to stderr; stdout is exactly the one JSON object, so `cli.js … > report.json` is parseable.

- [ ] **Step 1: Write the failing tests**

```ts
// verify.test.ts (scratch DB restored + storage copied, as Task 9)
it('passes on a complete restore', …)                    // ok true; 'embed model' detail { 'voyage:voyage-4-large@1024': 3 }
it('fails embed model until the chunks match', …)        // { embedModel: 'ollama:qwen3-embedding:latest@1024' } -> that check false
it('fails files present when a file is gone', …)         // unlink a copied figure -> 'files present' false, detail lists the figure id
it('fails no supabase urls on a stale signed URL', …)    // add figure_url 'https://x.supabase.co/…' to a post -> false
it('checks file owner on directories as well as files', …)
  // owner = the process uid/gid -> 'file owner' ok; owner uid + 1 -> false and the detail's paths include the
  // mediaDir/feeds directory and the figuresDir/<paperDefault> directory, not only files

// cli.test.ts (spawn `node --import tsx src/restore/cli.ts` with DATABASE_URL, UPLOAD_DIR, FIGURES_DIR, MEDIA_DIR and
// LOG_LEVEL: 'info'; several spawns per test, so each `it` gets an explicit timeout of 30_000)
it('db, files and verify succeed end to end on the synthetic archive', …)
  // three exit 0s; for each, JSON.parse(stdout) of the WHOLE stdout succeeds (logs went to stderr); verify ok true
it('db --dry-run leaves the database empty', …)          // exit 0, users count 0 afterwards
it('db requires --source-embed-model', …)                // exit 1, stderr /--source-embed-model/
it('a second db run exits 1 and changes nothing', …)
it('never prints the archive secrets', …)                // stdout + stderr of all commands contain no SECRET_MARKER
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx vitest run test/restore/verify.test.ts test/restore/cli.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `verifyRestore` and the CLI (`node:util` `parseArgs`; dirs from `loadConfig()`; `sql.end()` in `finally`). Logging as Task 5's CLI: its own `pino(…, pino.destination(2))` passed to `loadConfig`, `restoreDatabase({ log })` and the files/verify paths, so stdout carries only the final JSON object.

- [ ] **Step 4: Run to verify they pass**

Run: `cd server && npm run typecheck && npx vitest run test/restore && npm run build && test -f dist/restore/cli.js && test -f dist/db/reembed-cli.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/restore server/package.json server/test/restore
git commit -m "feat(server): restore CLI (db, files, verify)"
```

---

### Task 11: Plan-01 process fixes: `parseBool` throws, CSRF rejects are logged, first registration is serialized

**Files:**
- Modify: `server/src/config.ts`, `server/src/http/csrf.ts`, `server/src/app.ts` (csrf wiring), `server/src/auth/basicRoutes.ts`
- Test: `server/test/config.test.ts`, `server/test/http/csrf.test.ts`, `server/test/auth/register-race.test.ts`

**Interfaces:**
- Produces: `parseBool(name: string, v: string | undefined, fallback: boolean): boolean`: unset or `''` (after trim) → fallback; an unrecognised value throws `Error(\`${name} must be a boolean, got: ${v}\`)`. `csrf(config: Config, logger: Logger): MiddlewareHandler`. `REGISTER_LOCK_KEY = 727275` (exported from `basicRoutes.ts`; `migrate.ts` uses 727274).

- [ ] **Step 1: Write the failing tests**

```ts
// config.test.ts
it('rejects a misspelled boolean', () =>
  expect(() => loadConfig({ ALLOW_REGISTRATION: 'ture' })).toThrow('ALLOW_REGISTRATION must be a boolean, got: ture'));
it('an empty boolean uses the default', () => expect(loadConfig({ PUBLIC_DEPLOYMENT: '' }).publicDeployment).toBe(false));
it('parseBool names the variable it rejects', () => expect(() => parseBool('X', 'maybe', false)).toThrow('X must be a boolean, got: maybe'));
// the existing 'parseBool accepts pydantic truthy/falsy spellings' test moves to the 3-argument form:
// parseBool('X', t, false), parseBool('X', f, true), parseBool('X', undefined, true); same assertions

// csrf.test.ts
it('logs a rejected request without the token values', async () => {
  // POST with cookie 'ficino_csrf=COOKIEVAL' and header X-CSRF-Token 'HEADERVAL' -> 403
  // the captured logger got one warn: ({ method: 'POST', path: '/papers', has_cookie: true, has_header: true }, 'csrf_rejected')
  // and JSON.stringify of every log call contains neither 'COOKIEVAL' nor 'HEADERVAL'
});

// register-race.test.ts (AUTH_PROVIDER=basic, ALLOW_REGISTRATION=false, empty users)
it('two simultaneous first registrations create one account', async () => {
  const [a, b] = await Promise.all([register('a@example.com'), register('b@example.com')]);
  expect([a.status, b.status].sort()).toEqual([201, 403]);   // use the route's real success status
  expect((await sql`SELECT count(*)::int AS n FROM users`)[0].n).toBe(1);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx vitest run test/config.test.ts test/http/csrf.test.ts test/auth/register-race.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**
  - `parseBool` as specified; its three callers pass the env var name; the existing spelling test in `server/test/config.test.ts` uses the new signature (Step 1).
  - `csrf` logs `csrf_rejected` with `{ method, path, has_cookie, has_header }`; `app.ts` passes `deps.logger`.
  - `/auth/register`: the count, the email check and both inserts run in one `sql.begin` that first takes `pg_advisory_xact_lock(REGISTER_LOCK_KEY)`; the existing 403/409/422 answers and the unique-violation → 409 mapping are unchanged.

- [ ] **Step 4: Run to verify they pass**

Run: `cd server && npx vitest run test/config.test.ts test/http test/auth`
Expected: PASS.

- [ ] **Step 5: Commit** (one commit per fix)

```bash
git add server/src/config.ts server/test/config.test.ts && git commit -m "fix(server): reject unrecognised boolean env values"
git add server/src/http/csrf.ts server/src/app.ts server/test/http/csrf.test.ts && git commit -m "fix(server): log CSRF rejections"
git add server/src/auth/basicRoutes.ts server/test/auth/register-race.test.ts && git commit -m "fix(server): serialize first-user registration"
```

---

### Task 12: Signal-wiring tests and the closed PORTING ledger

**Files:**
- Create: `server/test/api/signals.test.ts`, `server/test/worker/signals.test.ts`
- Modify: `server/test/PORTING.md` (line for `worker/tests/test_shared_adoption.py::test_default_for_matches_defaults`)

**Interfaces:**
- Consumes: the entry points `src/api/main.ts` and `src/worker/main.ts` (their `process.on('SIGTERM'|'SIGINT')` blocks); `createScratchDb`.

- [ ] **Step 1: Write the tests**

```ts
// each test: scratch DB; spawn(process.execPath, ['--import', 'tsx', 'src/<api|worker>/main.ts'], { env: { ...process.env, DATABASE_URL, PORT: '0', API_HOST: '127.0.0.1', ENVIRONMENT: 'development', LOG_LEVEL: 'info' } });
// wait for the entry's startup log line on stdout (pino JSON), then signal.
// Explicit per-test timeouts (vitest's default is 5 s): 30_000 for the api tests, 60_000 for the worker test.
it('api exits 0 on SIGTERM within its grace', …)          // exit code 0 within 20 s; stdout has no 'shutdown failed'
it('api exits 0 on SIGINT', …)
it('api survives a second SIGTERM during shutdown', …)    // two signals 50 ms apart -> one exit, code 0
it('worker exits 0 on SIGTERM within its grace', …)       // within 45 s; pool ended (no 'ending pool with job handlers still running')
```

- [ ] **Step 2: Run them**

Run: `cd server && npx vitest run test/api/signals.test.ts test/worker/signals.test.ts`
Expected: PASS if the wiring is right (these pin existing behaviour). If one fails, fix the entry point in the same task and record it as a deliberate change.

- [ ] **Step 3: Close the ledger line.** Find the TS test that pins the settings defaults against `buildDefaults` (`test/settings/`) and tick the line in the ledger's own format: append ` — plan06/T12 (<file>: <test name>)`, or ` — n/a: <reason>` if the Python test checked a Python-only adapter.

- [ ] **Step 4: Verify**

Run: `grep -c '^- \[ \]' server/test/PORTING.md`
Expected: `0`.

- [ ] **Step 5: Commit**

```bash
git add server/test/api/signals.test.ts server/test/worker/signals.test.ts server/test/PORTING.md
git commit -m "test(server): pin SIGTERM/SIGINT shutdown of the api and worker; close the PORTING ledger"
```

---

### Task 13: Delete the Python services

**Files:**
- Delete: `api/`, `worker/`, `shared/`, `infra/`, `server/test/fixtures/goldens/gen/*.py`, `server/test/fixtures/goldens/gen/README.md`, `ruff.toml`, `.dockerignore`, `docs/saas-deploy.md`
- Create: `server/test/fixtures/goldens/README.md`
- Modify: `.github/workflows/ci.yml` (remove `python-lint`, `api-tests`, `worker-tests`, `shared-tests`), `.gitignore` (drop `__pycache__/`, `*.pyc`, `*.pyo`, `.pytest_cache/`, `*.egg-info/`, `postgres_data/`, `redis_data/`), `.pre-commit-config.yaml` (the `check-yaml` `exclude` becomes `^deploy/tailnet/docker-compose\.override\.example\.yml$`: drop only the `infra/` alternative Task 2 kept), `server/test/PORTING.md` (header line), comments in `server/test/fixtures/build-sample-pdf.ts`, `server/test/ingest/chunker.test.ts`, `server/test/ingest/pdf.test.ts`, `server/test/ingest/qualityCheck.test.ts`, `server/test/audio/feedAudio.test.ts` (`gen/feed_audio.py`), `server/test/audio/podcast.test.ts` (`gen/podcast_script.py`), `server/test/readingLists/chapter.test.ts` (`gen/chapter_tasks.py`), `server/test/shared/pystr.test.ts` (`gen/feed_audio.py`), `server/scripts/compare-extraction.ts` (header, which also names `gen/pdf_text.py`). (`server/README.md`'s goldens paragraph is rewritten in Task 14.)

**Interfaces:**
- Produces: local annotated tag `python-final` on the last commit that still has `api/`, `worker/`, `shared/` (the controller pushes it with `main`).

- [ ] **Step 1: Preconditions**

Run: `grep -c '^- \[ \]' server/test/PORTING.md; git ls-files 'server/test/fixtures/goldens/gen/*.py' | wc -l; grep -c 'e2e-stack.sh' .github/workflows/ci.yml`
Expected: `0`, `15`, a number ≥ 1 (Task 4 landed first).

- [ ] **Step 2: Tag and delete**

```bash
git tag -a python-final -m "Last commit with the Python api, worker and shared services"
git rm -r -q api worker shared infra ruff.toml .dockerignore docs/saas-deploy.md server/test/fixtures/goldens/gen
find . -path ./node_modules -prune -o \( -name __pycache__ -o -name .ruff_cache -o -name .pytest_cache \) -type d -print -exec rm -rf {} +
```

- [ ] **Step 3: Rewrite the leftovers**
  - `server/test/fixtures/goldens/README.md` (about 10 lines): the goldens were produced by the Python implementation, with the generators under `server/test/fixtures/goldens/gen/` at tag `python-final`; recover them with `git checkout python-final -- api worker shared server/test/fixtures/goldens/gen`; the files are frozen, and a changed golden is a deliberate behaviour change listed in that plan's deliberate-changes section.
  - Point the listed comments at that README instead of `gen/README.md`, its regenerate commands or a `gen/<name>.py` path (for a named generator: "generated by the Python implementation, see `test/fixtures/goldens/README.md` (tag `python-final`)"); reword `compare-extraction.ts` line 5 to "compare against another extractor's output".
  - `PORTING.md` first line after the title: "The Python sources named here were removed at tag `python-final`."
  - CI: delete the four Python jobs.

- [ ] **Step 4: Verify**

Run:
```bash
git ls-files '*.py' | wc -l
git grep -n -i -E 'celery|\bredis\b|uvicorn|fastapi|asyncpg|requirements\.(txt|lock)' -- . ':!docs/superpowers' ':!server/test/PORTING.md' ':!plans' ':!review' ':!FICINO_REVIEW*' ':!README.md' ':!AGENTS.md' ':!FEATURES.md' ':!server/README.md' ':!LICENSE' ':!frontend' ':!server/test'
git grep -n -E 'goldens/gen|gen/README|gen/[a-z_]+\.py' -- server ':!server/test/PORTING.md' ':!server/test/fixtures/goldens/README.md' ':!server/README.md'
cd server && npm run typecheck && npm test && npm run build && cd .. && npm run test:deploy
```
Expected: `0`; the first grep prints only historical `Port of …`/`Celery …` comments in `server/src` (kept on purpose, resolvable at the tag); the second prints nothing; all suites PASS. Out of scope for the first grep, and never to be edited for it: `frontend/` (FastAPI/Celery wording in comments; byte-identical rule), `server/test` (the `celery-abc` legacy task-id fixtures in the route tests pin real behaviour), `LICENSE`.

- [ ] **Step 5: Commit**

`git rm` in Step 2 already staged the deletions (naming a deleted path in `git add` aborts with "pathspec did not match"), so stage only the edited paths:

```bash
git add -A server .github .gitignore .pre-commit-config.yaml
git status --short | grep -v '^[DMAR] ' || echo STAGED_ALL    # nothing unstaged or untracked
git commit -m "chore: remove the Python services (recoverable at tag python-final)"
```

---

### Task 14: Docs and the plan-06 carryover

**Files:**
- Rewrite: `README.md`, `AGENTS.md`, `FEATURES.md`, `server/README.md`
- Modify: `tests/e2e/SKIPS.md` (how to run; the skip inventory is unchanged)
- Create: `docs/superpowers/plans/2026-11-06-ts-port-06-carryover.md`

**Interfaces:**
- Consumes: every earlier task's names (scripts, CLIs, files).

- [ ] **Step 1: Rewrite the docs**
  - `README.md`: stack badge and Tech Stack table (React, Node/Hono, pg-boss, Postgres + pgvector, Ollama or Anthropic, ElevenLabs optional); Auth section (`none` and `basic`, sessions in Postgres); Architecture diagram (web nginx → api; worker; Postgres holds data, jobs, sessions and rate limits; providers); Quick Start (self-host only: `cp .env.example .env`, fill it, `cp deploy/loopback/docker-compose.override.example.yml docker-compose.override.yml`, `docker compose up -d --build`, browse `http://localhost:8080/ficino/`; the tailnet override in `deploy/tailnet/` is the alternative, see `deploy/README.md`); Project Structure (`frontend/`, `server/`, `deploy/`, `tests/e2e/`, `scripts/`); Development (`cd server && npm ci && npm run typecheck && npm test`, `npm run test:deploy`, e2e via `scripts/e2e-stack.sh`). One sentence: the hosted service was shut down in October 2026. No host names.
  - `AGENTS.md`: Project (self-host only); Layout; Verification gates (server, frontend, deploy, e2e with `scripts/e2e-stack.sh`); Schema & migrations (numbered files in `server/migrations/`, the runner, data-only restore); Dependencies (`server/package-lock.json`); standing rules (jsonb via `sql.json`, `pyInt` for int params, never mount a router at `/` with `requireUser`, never `down -v` without the e2e project flags, compose images always named); Settled scope without the Python-only items; Git policy unchanged.
  - `FEATURES.md`: replace Celery beat, Railway, Supabase provider/storage, Redis sessions and rate limits, Turnstile, SaaS rows with their TS equivalents (pg-boss crons, Postgres sessions and limits, local storage with signed URLs including audio) or remove them; "first user auto-allowed" now notes the serialized first registration.
  - `server/README.md`: the main backend doc: layout, env (pointer to `.env.example`), commands, migrations, the restore runbook in generic form (postgres up → `node dist/db/migrate-cli.js` → `restore db --dump <archive>/db/data.sql --source-embed-model <id>` → `restore files --bucket <archive>/storage/<bucket> --manifest <archive>/storage-manifest.json --chown 10001:10001` → `reembed` → `restore verify --embed-model <id> --owner 10001:10001` → start api and worker); re-embedding after an embedding-model change (in the compose stack `docker compose run --rm --no-deps worker node dist/db/reembed-cli.js`; in a source checkout `npm run reembed`; the image has no `tsx`, so `npm run` scripts do not work there); the goldens paragraph points at `test/fixtures/goldens/README.md`; remove "the Python services remain".
  - `tests/e2e/SKIPS.md`: how to run (`scripts/e2e-stack.sh up && scripts/e2e-stack.sh ci`; `up --ollama` + `full` for the full suite, a fresh `up` per acceptance run; the JSON report in `tests/results/` lists the skipped tests, and any skip not listed in this file is a failure to investigate); everything else unchanged.

- [ ] **Step 2: Scrub pre-existing private values.** Some files already on `main` name the old host or private paths (historic plan and review docs, one frontend test comment). The controller gives you a list of `file:line` hits from its private whole-tree scan; do not search for them yourself. Replace each private value with a placeholder (`<host>`, `<repo>`, `<worktree>`, `<docker-volumes>`, `<host notes>`; for archive ids `<feed-a>`, `<feed-b>`, `<orphan-pdf>`, `<paper-id>`) and change nothing else on the line. Under `frontend/`, only a comment in a test file may change (the exception in Global Constraints). Commit separately: `docs: replace host-specific paths and names with placeholders`. Git history keeps the old text; that is already public and accepted.

- [ ] **Step 3: Write the carryover** with these sections:
  1. What plan 06 delivered (one paragraph per task group).
  2. Deliberate changes: `parseBool` throws; CSRF rejections logged; first registration serialized; image healthcheck flags; deploy nginx (owner gate, realip from Serve's `X-Forwarded-For`, 300 s proxy timeouts, `/` → `/ficino/`); restore cleanup rules (Task 7 list).
  3. Rulings made during execution (filled by the implementer/controller).
  4. **Carry-item dispositions** (copy this table and keep it current):

| From | Item | Disposition |
|---|---|---|
| 01 | Compose env (`ENVIRONMENT`, `CORS_ORIGINS`, `SIGNED_URL_KEY`), healthcheck port and start period | Fixed: Task 1 (image + compose); host env in the private runbook |
| 01 | Auth provider vs the restore | Kept `none`; data re-keyed to the stub user (Task 8); owner-login gate in the web nginx (Task 2). `basic` would need a set-password CLI: carried to whenever a second user is added |
| 01 | IP rate limits behind Serve | Fixed in the deploy nginx (realip from `X-Forwarded-For`, Task 2); `clientIp` unchanged |
| 01 | Restore data-only or stamp `schema_migrations` | Data-only into a schema the runner migrated (Task 8) |
| 01 | Close/SIGTERM tests | Fixed: Task 12 |
| 01 | First-user registration race | Fixed: Task 11 |
| 01 | CSRF failure logging | Fixed: Task 11 |
| 01 | `parseBool` silent fallback | Fixed: Task 11 (deliberate change) |
| 02 | Delete the golden generators with `worker/` | Done: Task 13 (tag `python-final`) |
| 02 | Worker command, shared volumes, same key, no inherited healthcheck, `stop_grace_period` ≥ 40 s | Fixed: Task 1 (45 s) |
| 02 | Synchronous extraction has no hard limit (`worker_thread`) | Kept: the feed rework replaces the extractor behind the same interface |
| 02/05 | Reprocess endpoint (empty re-run keeps stale chunks) | Kept out of scope; the re-embed does not re-extract |
| 03 | Re-embed on an embed-setting change | Kept as CLI only (Task 5): after switching the embedding model, run `reembed`; no settings hook, no new route |
| 03 | Restore re-embed writes `embed_model` | Fixed: Task 5, run by the restore runbook |
| 03 | `embed_model` backfill for Python-written chunks | Fixed: provenance tag (Task 7), then the re-embed |
| 03 | Soft-limit abort discards the partial feed slice | Kept: far from the limit with the default model |
| 04 | Restored `paper_summaries` stuck in `generating` | Kept: counted by the restore; first view re-dispatches (an `error` row would too) |
| 04/05 | Restored `user_posts` stuck in `pending` | Swept to `error` (Task 7); plan 05's status heal also covers it |
| 04 | Double-encoded legacy `messages` / jsonb shape sweep | Fixed: decoded or aborted (Task 7); `verify` re-checks (Task 10) |
| 04 | Final-attempt crash leaves summaries, syntheses, Archivist rows stuck | Closed by plan 05 (group-chat stuck check, Archivist status heal) |
| 05 | Legacy stitched podcast | Fixed: Task 7 clears it; files not copied (Task 9) |
| 05 | Legacy media keys `{user}/feeds/{feed}/…` | Fixed: keys re-keyed (Task 7), files copied to `MEDIA_DIR/feeds/…` (Task 9) |
| 05 | `MEDIA_DIR`, `SIGNED_URL_KEY`, `PUBLIC_API_BASE`, `ELEVENLABS_*` on api and worker | Fixed: Task 1 shared env file and volumes; values in host env |
| 05 | Media needs a same-origin API | Kept `/ficino/` base, same origin on the node (Task 2) |
| 05 | Restored `corpus_syntheses` stuck in `generating` | Fixed: healed or set `error` (Task 7) |
| 05 | ElevenLabs voices risk and the unrun smoke | Run by the controller with the owner's new key; results below |
| spec | PG19 re-check | pgvector has no pg19 image: stays on `pgvector/pgvector:pg18`; a later major is a dump/restore |
| spec | Frontend dead Supabase/Turnstile/Railway code | Skipped: recorded for the frontend redo |
| all | Deferred minors in carryovers 01-05 | Kept as listed there; none blocks. Named: the broken eslint config, `startApi`'s `undefined` spread, the SaaS `CORS_ORIGINS` code default (compose sets it), the frontend's Node 20 build image |

  5. Acceptance gate results (the controller fills these; public-safe wording, no host names): `ci` project before the restore; full suite (desktop + mobile, real local models) three consecutive runs before the restore, each on a fresh stack; both again after the cutover. Columns: run, total, passed, skipped, failed, flaky, unlisted skips, duration. Expected totals: `ci` 124, full 256; failed 0; every skipped test traceable to a `tests/e2e/SKIPS.md` entry (unlisted skips 0). A total that differs or an unlisted skip fails the gate, the same as a failed test. The first CI run on the pushed `main` is not recorded here: `main` is pushed once, with this file in it, so the controller records that run outside the repo.
  6. ElevenLabs smoke (the controller fills): the plan 05 table (ordering, chapter, podcast, voices `host_a`, `host_b`).
  7. Carry into the feed rework and the frontend redo: root base path (`/` instead of `/ficino/`, avatar URLs need a migration), frontend dead code and CSP tightening, Node 24 frontend build, the floating `qwen3-embedding:latest` tag (re-embed after a pull that changes weights), re-embed trigger in Settings, `worker_thread` extraction, the soft-limit slice, and plan 05's frontend-redo list.

- [ ] **Step 4: Verify**

Run:
```bash
git grep -n -i -E 'celery|\bredis\b|uvicorn|fastapi|asyncpg|supabase|railway' -- README.md AGENTS.md FEATURES.md server/README.md
git grep -n -I -E '[a-z0-9-]+\.[a-z0-9-]+\.ts\.net|(^|[[:space:]`"'"'"'(=:])/(root|home|srv|mnt|opt)/[A-Za-z.]' -- . ':!LICENSE'
```
Expected: the first prints only lines that say the SaaS was shut down (if any); the second, a generic whole-tree check for tailnet names and absolute paths outside a repo, prints nothing. The controller then runs its private pattern list over the whole tree before merging.

- [ ] **Step 5: Commit**

```bash
git add README.md AGENTS.md FEATURES.md server/README.md tests/e2e/SKIPS.md docs/superpowers/plans/2026-11-06-ts-port-06-carryover.md
git commit -m "docs: TS-only stack, deploy layering, restore runbook (generic), plan 06 carryover"
```

# TS Port 01 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `server/` TypeScript package with config, DB and migrations, a test harness,
shared modules, auth, CSRF and rate limits, and every API route that doesn't need a background job. Each
route must behave the same as the Python API.

**Architecture:** One Hono app built by `createApp(deps)`, so tests can inject the DB, config and a fake
user (replacing FastAPI `dependency_overrides`). postgres.js runs raw SQL ported from the asyncpg code;
timestamps come back as raw strings and get formatted the way pydantic does. Sessions and rate-limit
counters move from Redis into Postgres tables. The Python services keep running untouched until the cutover
plan.

**Tech Stack:** Node 24 (image) / Node ≥22.18 (host), TypeScript strict ESM, Hono + `@hono/node-server`,
Zod, `postgres`, `bcryptjs`, pino, Vitest + `@testcontainers/postgresql` with `pgvector/pgvector:pg18`.

**Spec:** `docs/superpowers/specs/2026-10-29-typescript-port-design.md`. The wire contract is
`docs/superpowers/specs/ts-port-reference/api-contract.md` (cited below as **C §x**), and the schema/test
facts are in `ts-port-reference/schema-tests-data.md` (cited as **S §x**). Read both before starting.

## Global Constraints

- Work on branch `ts-port/01-foundation`; never touch `api/`, `worker/`, `shared/`, `frontend/` or `tests/e2e/` in this plan.
- All code lives in `server/` (its own `package.json`; not an npm workspace of the root).
- ESM only (`"type": "module"`), `tsconfig` `strict: true`, `module`/`moduleResolution` `NodeNext`, target `ES2023`.
- `engines.node` is `">=22.18"`; the runtime image is `node:24-alpine`.
- No Redis, no ORM, no Celery-compat shims.
- Every SQL value is passed as a postgres.js parameter (tagged template); `sql.unsafe` only for migration files.
- The API serves at root (`/health`, `/workspaces`, …). The `/ficino/api` prefix is stripped by nginx, never by the app.
- Wire literals (paths, status codes, `detail` strings, JSON keys, cookie and header names) are copied from C exactly. Where this plan says **"my call"**, it is a deliberate, documented divergence.
- `STUB_USER_ID = "00000000-0000-0000-0000-000000000000"` and `DEFAULT_WORKSPACE_ID = "00000000-0000-0000-0000-000000000001"`.
- Postgres status columns stay free `text`. No CHECK constraints and no enums (the restored data depends on this).
- Commits use the identity `umzcio <umzcio@users.noreply.github.com>` and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Timestamps when the DB time zone isn't UTC.** Every `...Z` timestamp must stay byte-identical to pydantic's format (no fraction when µs = 0, six digits otherwise), even if the database default `TimeZone` is `America/Denver`. Pinned in Task 2.
2. **The first request a browser makes fails.** A GET with no `ficino_csrf` cookie that gets a 404, 401 or 500 must still set the cookie, or the frontend's next POST gets a 403. Pinned in Task 5.
3. **Concurrent hits on one rate-limit key.** 20 simultaneous charges must count exactly 1..20. No lost increments, no double window. Pinned in Task 7.
4. **Stale sessions.** An expired session, or one whose user was deleted, must give the exact 401 `detail` and delete the expired row. A good session's expiry slides. Pinned in Task 6.
5. **Non-UUID path ids.** `DELETE /alerts/not-a-uuid` must give a JSON 404, not Python's plain-text 500 (my call). Pinned in Task 5 (handler) and Task 10 (route).

---

### Task 1: Scaffold the `server/` package and typed config

**Files:**
- Create: `server/package.json`, `server/tsconfig.json` (src + test, `noEmit`), `server/tsconfig.build.json` (src only, `rootDir src`, `outDir dist`), `server/vitest.config.ts`, `server/.gitignore` (`node_modules`, `dist`)
- Create: `server/src/config.ts`
- Create: `server/test/PORTING.md`
- Test: `server/test/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(env?: Record<string, string | undefined>): Config`, plus `type Config`:
  `{ databaseUrl: string; environment: string; authProvider: 'none' | 'basic'; allowRegistration: boolean; publicDeployment: boolean; corsOrigins: string[]; cookieDomain: string; uploadDir: string; figuresDir: string; mediaDir: string; maxUploadSizeMb: number; ollamaBaseUrl: string; elevenlabsApiKey: string; signedUrlKey: string; searchUseNormalizedPosts: boolean; dbPoolMax: number; port: number; rateLimits: { paper_upload: number; feed_generation: number; user_post: number; summary: number; reply: number; persona_dm: number; audio: number } }`
- Produces: `parseBool(v: string | undefined, fallback: boolean): boolean`

- [ ] **Step 1: Create the package.** `npm init -y` in `server/`. Then:
  - `npm i hono @hono/node-server zod postgres pino bcryptjs`
  - `npm i -D typescript @types/node vitest tsx @testcontainers/postgresql`
  - Scripts:

    | Script | Command |
    |---|---|
    | `build` | `tsc -p tsconfig.build.json` |
    | `typecheck` | `tsc -p . --noEmit` |
    | `test` | `vitest run` |
    | `dev:api` | `tsx watch src/api/main.ts` |
    | `migrate` | `tsx src/db/migrate-cli.ts` |
  - `tsconfig.json` (src + test, `noEmit`) is for typechecking. `tsconfig.build.json` emits `src` only to `dist/`, so the entry point is `dist/api/main.js`.

- [ ] **Step 2: Write the failing test** `server/test/config.test.ts`:

```ts
it('defaults match api/config.py', () => {
  const c = loadConfig({});
  expect(c.databaseUrl).toBe('postgresql://ficino:ficino@postgres:5432/ficino');
  expect(c.environment).toBe('development');
  expect(c.authProvider).toBe('none');
  expect(c.corsOrigins).toEqual(['https://ficino.app', 'https://ficino.ai']);
  expect([c.uploadDir, c.figuresDir, c.mediaDir]).toEqual(['/app/uploads', '/app/figures', '/app/media']);
  expect(c.maxUploadSizeMb).toBe(50);
  expect(c.ollamaBaseUrl).toBe('http://host.docker.internal:11434');
  expect(c.rateLimits).toEqual({ paper_upload: 50, feed_generation: 20, user_post: 30, summary: 30, reply: 60, persona_dm: 60, audio: 20 });
  expect(c.dbPoolMax).toBe(20);
  expect(c.port).toBe(8000);
});
it('AUTH_PROVIDER=supabase is rejected', () => {
  expect(() => loadConfig({ AUTH_PROVIDER: 'supabase' })).toThrow('AUTH_PROVIDER=supabase is no longer supported');
});
it('parseBool accepts pydantic truthy/falsy spellings', () => {
  for (const t of ['1', 'true', 'TRUE', 'yes', 'on', 'y', 't']) expect(parseBool(t, false)).toBe(true);
  for (const f of ['0', 'false', 'no', 'off', 'n', 'f']) expect(parseBool(f, true)).toBe(false);
  expect(parseBool(undefined, true)).toBe(true);
});
it('CORS_ORIGINS splits on commas and drops blanks', () => {
  expect(loadConfig({ CORS_ORIGINS: 'https://a, ,https://b' }).corsOrigins).toEqual(['https://a', 'https://b']);
});
```

- [ ] **Step 3: Run it.** `cd server && npx vitest run test/config.test.ts` should FAIL (module not found).

- [ ] **Step 4: Implement `server/src/config.ts`.**
  - Env names and defaults come from C §2.10. `RATE_LIMIT_*` names come from C §2.6.
  - New in this port: `MEDIA_DIR`, with default `/app/media`.
  - The pool size reads `API_DB_POOL_MAX_SIZE`, falling back to `DB_POOL_MAX_SIZE`.
  - An unknown `AUTH_PROVIDER` throws `Unknown AUTH_PROVIDER: <v>`.

- [ ] **Step 5: Run the tests again.** They should PASS.

- [ ] **Step 6: Generate the porting ledger** `server/test/PORTING.md`.
  - Run `grep -n "def test_" ../api/tests/*.py ../shared/tests/*.py`.
  - Write one checkbox line per test: `- [ ] api/tests/test_x.py::test_name — (plan/task when ported, or "n/a: <reason>")`.
  - Every later task ticks its lines.

- [ ] **Step 7: Commit.** `git add server && git commit -m "feat(server): scaffold TS package and typed config"`

---

### Task 2: Postgres client, timestamp formatting, migrations and the test harness

**Files:**
- Create: `server/src/db/sql.ts`, `server/src/db/time.ts`, `server/src/db/migrate.ts`, `server/src/db/migrate-cli.ts`
- Create: `server/migrations/0001_baseline.sql`
- Create: `server/test/globalSetup.ts`, `server/test/setup.ts`, `server/test/helpers/db.ts`
- Modify: `server/vitest.config.ts` (`globalSetup`, `setupFiles: ['test/setup.ts']`, `fileParallelism: false`)
- Test: `server/test/db/time.test.ts`, `server/test/db/migrate.test.ts`

**Interfaces:**
- Produces: `createSql(url: string, opts?: { max?: number }): Sql` (`type Sql = postgres.Sql`). Each connection runs with `TimeZone=UTC`. OIDs 1184 (timestamptz) and 1114 (timestamp) are returned as raw strings. jsonb is parsed to objects (the postgres.js default).
- Produces: `toPydanticIso(pg: string | null): string | null` and `toIsoformat(pg: string | null): string | null`
- Produces: `migrate(sql: Sql, dir?: string): Promise<string[]>`, which returns the versions it applied.
- Produces (test-only): `testSql(): Sql`, `dbName(): string`, `createScratchDb(): Promise<{ url: string; drop(): Promise<void> }>`, `resetDb(sql: Sql): Promise<void>`, `seedUsers(sql: Sql): Promise<Seeded>` where `Seeded = { user_a, user_b, workspace_a, workspace_b, feed_a, feed_b, paper_a, paper_b: string }`, and the constants `USER_A_ID` / `USER_B_ID` (copy them from `api/tests/conftest.py`).

- [ ] **Step 1: Build `0001_baseline.sql` from init.sql** (do it this way, don't hand-edit DDL).
  1. Start a throwaway database: `docker run --rm -d --name ficino-baseline --network none -e POSTGRES_PASSWORD=x pgvector/pgvector:pg18`.
  2. Load `infra/postgres/init.sql` into it with `psql -v ON_ERROR_STOP=1`.
  3. Dump the schema: `pg_dump --schema-only --no-owner --no-privileges -U postgres`.
  4. Append the persona seed: `pg_dump --data-only --inserts --table=personas -U postgres`.
  5. Remove the `SET …` and `SELECT pg_catalog.set_config(…)` header lines.
  6. Remove the four duplicate indexes listed in S §1 ("Present in I only").
  7. Stop the container.
  8. Put a header comment on the file naming the source commit (`dfedb2b`) and the steps above.

- [ ] **Step 2: Write the failing tests.**

`server/test/db/time.test.ts`:

```ts
it.each([
  ['2026-01-01 01:02:03+00', '2026-01-01T01:02:03Z', '2026-01-01T01:02:03+00:00'],
  ['2026-01-01 01:02:03.000005+00', '2026-01-01T01:02:03.000005Z', '2026-01-01T01:02:03.000005+00:00'],
  ['2026-01-01 01:02:03.12+00', '2026-01-01T01:02:03.120000Z', '2026-01-01T01:02:03.120000+00:00'],
])('%s', (pg, pyd, iso) => {
  expect(toPydanticIso(pg)).toBe(pyd);
  expect(toIsoformat(pg)).toBe(iso);
});
it('null passes through', () => expect(toPydanticIso(null)).toBeNull());
it('non-UTC database default still yields Z', async () => {
  const sql = testSql();
  await sql`ALTER DATABASE ${sql(dbName())} SET timezone TO 'America/Denver'`;
  const fresh = createSql(process.env.DATABASE_URL!);
  const [r] = await fresh`SELECT '2026-01-01T01:02:03Z'::timestamptz AS t`;
  expect(toPydanticIso(r.t)).toBe('2026-01-01T01:02:03Z');
  await fresh.end();
  await sql`ALTER DATABASE ${sql(dbName())} RESET timezone`;
});
```

`server/test/db/migrate.test.ts`:
- It runs against a second database created in the test, so it starts empty.
- First run: applies `['0001']`. Second run: applies `[]`.
- Afterwards it asserts:
  - the 23 public tables from S §1 exist;
  - `SELECT count(*) FROM personas` is 7;
  - `chunks` has exactly one unique index on `(paper_id, chunk_index)`;
  - inserting a chunk fills in `search_vector`;
  - `chunks_embedding_hnsw` exists.

- [ ] **Step 3: Run them.** They should FAIL.

- [ ] **Step 4: Implement the four modules.**
  - `migrate.ts`:
    - Creates `schema_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())` if it's missing.
    - Applies files matching `^\d{4}_.*\.sql$` in name order. Each file runs in one `sql.begin` transaction with `sql.unsafe`, then its 4-digit prefix is recorded.
    - Takes `pg_advisory_lock(727274)` around the run, so the api and worker can both call it at boot.
    - The default `dir` is `fileURLToPath(new URL('../../migrations', import.meta.url))`. That resolves to `server/migrations` from `src/db/` and to `/app/migrations` from `dist/db/`.
  - `migrate-cli.ts` reads `DATABASE_URL`.
  - `time.ts` parses the PG text format (`YYYY-MM-DD HH:MM:SS[.ffffff]+00`) with string operations, not `Date`. `Date` would lose the microseconds.

- [ ] **Step 5: Implement the harness.**
  - `globalSetup.ts`:
    - Starts `new PostgreSqlContainer('pgvector/pgvector:pg18')` and runs `migrate`.
    - Calls `provide('databaseUrl', url)` and stops the container in teardown.
  - `setup.ts`: sets `process.env.DATABASE_URL = inject('databaseUrl')`.
  - Every DB-backed test file calls `resetDb(testSql())` in `beforeEach`.
  - `resetDb`: `TRUNCATE` every public table except `personas` and `schema_migrations`, with `RESTART IDENTITY CASCADE`.
  - `seedUsers`: copies `seeded_users` from `api/tests/conftest.py:73-120`. Use the same rows and fresh uuids.

- [ ] **Step 6: Run** `npx vitest run test/db`. It should PASS.
- [ ] **Step 7: Commit.** `git commit -m "feat(server): postgres client, baseline migration, test harness"`

---

### Task 3: Shared pure modules (constants, sanitize, LIKE escape, signed URLs)

**Files:**
- Create: `server/src/shared/constants.ts`, `server/src/shared/sanitize.ts`, `server/src/shared/textutil.ts`, `server/src/shared/signedUrl.ts`
- Test: `server/test/shared/{constants,sanitize,textutil,signedUrl}.test.ts`

**Interfaces:**
- Produces from `constants.ts`, values copied from `shared/ficino_shared/constants.py`:
  - `STUB_USER_ID`, `DEFAULT_WORKSPACE_ID`, `SIGNED_URL_DEFAULT_TTL = 600`, `MEDIA_URL_TTL = 86400`
  - `LIMITS`, the list caps from C §2.11: `{ FEEDS: 20, CONTENT: 50, ALERTS: 50, ACTIVITY: 100, PAPER_SUMMARIES: 200, LIBRARY: 500, ANNOTATIONS: 1000, SEARCH: 10, SEARCH_CHUNKS: 15 }`
- Produces from `sanitize.ts`: `stripRoleMarkers(text: string): string`, `fenceUntrusted(text: string, maxLen = 8000): string`, `sanitizeInline(text: string | null | undefined, maxLen = 200): string`
- Produces from `textutil.ts`: `escapeLike(s: string): string`
- Produces from `signedUrl.ts`:
  - `resolveSigningKey(env: { SIGNED_URL_KEY?: string; ENVIRONMENT?: string; DATABASE_URL?: string }): Buffer`
  - `signWithExpiry(key: Buffer, resourceId: string, expires: number): string`
  - `signResource(key: Buffer, resourceId: string, ttl = 600, nowSec = () => Math.floor(Date.now() / 1000)): string`
  - `verifyToken(key: Buffer, resourceId: string, token: string, nowSec = …): boolean`

- [ ] **Step 1: Port the Python tests.** `shared/tests/test_sanitize.py`, `test_constants.py` and `test_signed_url.py` become Vitest files, one `it` per Python test with the same name and assertions. Tick them in PORTING.md. Mark `test_storage_*.py` "plan 02".

- [ ] **Step 2: Add the golden vectors.** These were generated from the Python implementation on 2026-10-29:

```ts
it('token is byte-identical to Python', () => {
  expect(signWithExpiry(Buffer.from('test-key'), 'fig-1', 2000000000))
    .toBe('2000000000.AFF06qp-_kWq9M6fI43du8jwGsZU9hm9K6-VvkruPKY');
});
it('derived dev key is the sha256 HEX string of DATABASE_URL + salt', () => {
  expect(resolveSigningKey({ DATABASE_URL: 'postgresql://ficino:ficino@postgres:5432/ficino' }).toString())
    .toBe('c27b48c7063ad7df644530ed189b3dff81db07b2a66982173dfd3287f5160193');
});
it('production without SIGNED_URL_KEY throws', () => {
  expect(() => resolveSigningKey({ ENVIRONMENT: 'production' })).toThrow();
});
it('expiry equal to now is still valid', () => {
  const k = Buffer.from('k'); const t = signWithExpiry(k, 'r', 100);
  expect(verifyToken(k, 'r', t, () => 100)).toBe(true);
  expect(verifyToken(k, 'r', t, () => 101)).toBe(false);
});
```

  Also add `escapeLike('a\\b%c_d')` → `'a\\\\b\\%c\\_d'` (the replacement order is `\`, then `%`, then `_`).

- [ ] **Step 3: Run them.** They should FAIL.
- [ ] **Step 4: Implement the modules.**
  - Port `shared/ficino_shared/sanitize.py` and `signed_url.py` line for line.
  - Use `crypto.timingSafeEqual` on equal-length buffers; a length mismatch returns false.
  - Base64url has no padding.
- [ ] **Step 5: Run them.** They should PASS.
- [ ] **Step 6: Commit.** `git commit -m "feat(server): shared constants, sanitize, signed URLs"`

---

### Task 4: Settings schema and per-job resolved settings

**Files:**
- Create: `server/src/settings/schema.ts`, `server/src/settings/resolve.ts`
- Test: `server/test/settings/schema.test.ts`, `server/test/settings/resolve.test.ts`

**Interfaces:**
- Produces from `schema.ts`, ported from `shared/ficino_shared/settings_schema.py`:
  - `buildDefaults(env): Settings`
  - `UI_ONLY_KEYS`, `SETTINGS_TO_ENV`, `NUMERIC_BOUNDS: Record<string, ['int' | 'float', number, number]>`, `SECRET_KEYS`, `PROVIDER_OVERRIDE_KEYS`
  - `mergeSettings(defaults: Settings, user: Record<string, unknown>): Settings`
  - `reassertPublicDeployment(merged: Settings, env): Settings`
  - `isPublicDeployment(env): boolean`
  - `type Settings = Record<string, unknown>`
- Produces from `resolve.ts`: `resolveUserSettings(sql: Sql, userId: string, env: Record<string, string | undefined>): Promise<Readonly<Settings>>`.
  - It returns the merged, public-deployment-reasserted settings, deep-frozen.
  - **This object is how later plans pass provider config to each job. Nothing ever writes `process.env`.**
  - Python's `_baseline_env` snapshot machinery is not ported: the env passed in *is* the baseline.

- [ ] **Step 1: Port the tests.** `shared/tests/test_settings_schema.py`, plus the DEFAULTS-contract tests in `api/tests/test_settings_contract.py` that don't need HTTP. Tick them in PORTING.md.
- [ ] **Step 2: Add the tests for the new defaults.** These are deliberate changes the spec approved:

```ts
it('model defaults updated for the port', () => {
  const d = buildDefaults({});
  expect(d.ollama_llm_model).toBe('qwen3.8:27b');
  expect(d.ollama_embed_model).toBe('qwen3-embedding:latest');
  expect(d.claude_model).toBe('claude-sonnet-5-5');
  expect(d.context_anthropic_model).toBe('claude-haiku-5-5');
  expect(d.context_ollama_model).toBe('qwen3.8:27b');
  expect(d.figure_detect_provider).toBe('ollama');
});
it('env still overrides defaults', () => {
  expect(buildDefaults({ OLLAMA_LLM_MODEL: 'x' }).ollama_llm_model).toBe('x');
});
it('resolveUserSettings never mutates the env object', async () => {
  const env = Object.freeze({ LLM_PROVIDER: 'ollama' });
  await expect(resolveUserSettings(testSql(), USER_A_ID, env)).resolves.toBeTruthy();
});
it('two users resolve independently', async () => {
  // seed user_settings: A {anthropic_api_key:'ka'}, B {anthropic_api_key:'kb'}
  const [a, b] = await Promise.all([resolveUserSettings(sql, USER_A_ID, {}), resolveUserSettings(sql, USER_B_ID, {})]);
  expect([a.anthropic_api_key, b.anthropic_api_key]).toEqual(['ka', 'kb']);
});
```

  Every other DEFAULTS key keeps its Python default. Copy those values verbatim and port the Python test that pins them.

  **My call:** also set `figure_detect_ollama_model` and `ollama_vision_model` to `qwen3-vl:32b`. The old default `qwen2.5vl` isn't installed on <host> and `qwen3-vl:32b` is. Record both in the test.

- [ ] **Step 3: Run them.** They should FAIL.
- [ ] **Step 4: Implement.** `mergeSettings` does a one-level dict merge, and user keys that aren't in the defaults pass through (C §6.17).
- [ ] **Step 5: Run them.** They should PASS.
- [ ] **Step 6: Commit.** `git commit -m "feat(server): settings schema and immutable per-job settings"`

---

### Task 5: App factory, error contract, middleware, health and `/auth/provider`

**Files:**
- Create: `server/src/app.ts`, `server/src/http/errors.ts`, `server/src/http/validate.ts`, `server/src/http/securityHeaders.ts`, `server/src/http/csrf.ts`, `server/src/routes/health.ts`
- Create: `server/test/helpers/client.ts`
- Test: `server/test/http/{errors,csrf,headers,health}.test.ts`

**Interfaces:**
- Produces from `app.ts`:
  - `createApp(deps: AppDeps): Hono<AppEnv>`
  - `AppDeps = { sql: Sql; config: Config; logger: pino.Logger; env: Record<string, string | undefined>; fetch?: typeof fetch; userOverride?: AuthUser }`
  - `AppEnv = { Variables: { user: AuthUser; deps: AppDeps } }`
  - `AuthUser = { id: string; email: string; display_name: string | null }` lives in `server/src/auth/types.ts`. Create it here.
- Produces from `errors.ts`: `class HttpError extends Error { constructor(status: number, detail: string) }`, which renders as `{"detail": detail}`.
- Produces from `validate.ts`: `body<T>(schema: z.ZodType<T>)`, `query<T>(schema)`, `params<T>(schema)`. They are built on `hono/validator`, and handlers read `c.req.valid('json' | 'query' | 'param')`. Path ints like `post_index` use `z.coerce.number().int()` in `params`. On failure they return 422 `{"detail":[{"type","loc","msg","input"}]}`, where `loc[0]` is `"body" | "query" | "path"`.
- Produces (test-only) from `client.ts`: `client(app, opts?: { csrf?: boolean })`, returning `{ get, post, put, delete, cookies }`.
  - It keeps a cookie jar.
  - It pre-seeds `ficino_csrf=test-csrf-token-fixture` and sends the matching `X-CSRF-Token` on POST/PUT/DELETE/PATCH. `client(app, { csrf: false })` turns this off.
  - Each method returns `{ status, headers, json(), text() }` and calls `app.request(...)`.
- Produces: `testApp(opts?: { user?: AuthUser; config?: Partial<Config> }): Hono<AppEnv>` in `server/test/helpers/client.ts`.

- [ ] **Step 1: Port the tests.**
  - Port all of `api/tests/test_csrf.py`.
  - Port the cases in `test_error_contracts.py` that hit only `/health`, unknown routes or CSRF. Leave the rest for their router tasks and note them in PORTING.md.
  - Replace `test_docs_gating.py` with one test: `/docs`, `/redoc` and `/openapi.json` return 404 in **every** environment. **My call:** no docs are served in this slice.

- [ ] **Step 2: Add the contract tests for C §0, §2.1 and §2.2.**

```ts
it('unknown route → 404 {"detail":"Not Found"}', …);
it('wrong method on a real route → 405 {"detail":"Method Not Allowed"}', …); // e.g. DELETE /health
it('unhandled exception → 500 text/plain "Internal Server Error"', …);      // via a test-only route
it('PG invalid_text_representation (22P02) → 404 {"detail":"Not Found"}', …); // my call; test-only route runs SELECT $1::uuid with 'abc'
it('first GET without cookie mints ficino_csrf even on 404', async () => {
  const r = await client(testApp(), { csrf: false }).get('/nope');
  expect(r.status).toBe(404);
  expect(r.headers.get('set-cookie')).toMatch(/ficino_csrf=[\w-]{43}; Max-Age=604800; Path=\/; SameSite=Lax/);
});
it('CSRF 403 body is exact and still carries CORS headers', …); // Origin http://localhost:5173 in development
it('security headers on normal responses; HSTS+CSP only outside development', …);
it('CSP connect-src no longer lists supabase', …); // deliberate: 'self' only
it('GET /auth/provider → {"provider":"none","public_deployment":false}', …);
it('GET /health and /healthz → {"status":"ok","service":"ficino-api"}', …);
```

- [ ] **Step 3: Run them.** They should FAIL.
- [ ] **Step 4: Implement.**
  - **Middleware order.** It must match C §2.1, outermost first: CORS (`hono/cors` with the dev/prod option sets from C §2.1), then CSRF, then security headers, then the routes.
  - **Error handler (`app.onError`).**
    - `HttpError` renders as `{detail}`.
    - Postgres error code `22P02` renders as 404 `{"detail":"Not Found"}`.
    - Anything else logs and returns 500 `text/plain` `Internal Server Error`.
  - **`app.notFound`.** It returns 405 when the path matches a registered route for some other method, and 404 otherwise. Keep a second router of real routes only (no middleware) for this check.
  - **CSRF cookie flags.** They're in C §2.2. `Secure` is set when `environment !== 'development'`. `Domain` is `COOKIE_DOMAIN` when it's set.
- [ ] **Step 5: Run them.** They should PASS.
- [ ] **Step 6: Commit.** `git commit -m "feat(server): app factory, error contract, CSRF, headers, health"`

---

### Task 6: Auth providers (none, basic), Postgres sessions and the stub-user bootstrap

**Files:**
- Create: `server/migrations/0002_sessions.sql`
- Create: `server/src/auth/{types.ts (exists), passwords.ts, sessions.ts, currentUser.ts, basicRoutes.ts, bootstrap.ts}`
- Modify: `server/src/app.ts` (mount `currentUser` on all non-public routes; mount `basicRoutes` at `/auth` only when `authProvider === 'basic'`)
- Test: `server/test/auth/{passwords,sessions,basic,none}.test.ts`

**Interfaces:**
- Produces from `passwords.ts`: `hashPassword(pw: string): Promise<string>` (bcryptjs, cost 12, `$2b$`) and `verifyPassword(pw: string, hash: string | null): Promise<boolean>`.
- Produces from `sessions.ts`:
  - `createSession(sql, userId): Promise<string>`, which returns a 43-character base64url token. Only `sha256(token)` hex is stored.
  - `lookupSession(sql, token): Promise<{ userId: string } | 'expired' | null>`, which slides `expires_at` to now + 7 days on a hit and deletes the row when it has expired.
  - `deleteSession(sql, token)`
  - `SESSION_TTL_SECONDS = 604800`
- Produces from `currentUser.ts`: `currentUser()`, middleware that sets `c.var.user`. It uses `deps.userOverride` when present (tests), otherwise the configured provider.
- Produces from `bootstrap.ts`: `ensureStubUser(sql)`, which inserts the stub user and Default workspace exactly as in C §1.0.
- Migration `0002_sessions.sql`:

```sql
CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);
```

- [ ] **Step 1: Port the tests.** Port `api/tests/test_auth_gates.py`. Mark `test_supabase_bootstrap.py` "n/a: supabase removed".

- [ ] **Step 2: Add the contract tests for C §1.1 and §3.**

```ts
it('none: every protected route sees the stub user; no rate limit; no 401', …);
it('ensureStubUser is idempotent and creates workspace …0001 named Default', …);
it('basic: /auth/* returns 404 when AUTH_PROVIDER=none', …);
it('register → 201 {"status":"registered","user_id"} + HttpOnly ficino_session cookie (Max-Age=604800; Path=/; SameSite=Lax)', …);
it('register when users exist and !ALLOW_REGISTRATION → 403 "Registration is disabled"', …);
it('register duplicate email → 409 "Email already registered"; password <12 or >72 chars → 422', …);
it('login wrong password / unknown email / NULL hash → 401 "Invalid email or password"', …);
it('login with a >72-byte password → 401 "Invalid email or password"', …); // my call: Python 500s
it('logout requires CSRF, deletes session, clears cookie; then /auth/me → 401 "Session expired"', …);
it('missing cookie → 401 "Not authenticated"; expired session → 401 "Session expired" and row deleted', …);
it('session whose user was deleted → 401 (cascade removes row → "Session expired")', …);
it('authenticated request slides expires_at forward', …);
it('hash is $2b$12$ and verifies a Python-bcrypt hash of the same password', …);
// generate the fixture hash with: python3 -c "import bcrypt;print(bcrypt.hashpw(b'correct horse battery', bcrypt.gensalt(12)).decode())"
```

- [ ] **Step 3: Run them.** They should FAIL.
- [ ] **Step 4: Implement.**
  - Port the register/login/logout/me logic and audit calls from `api/auth/basic_routes.py`.
  - `/auth/register` and `/auth/login` are the only CSRF-exempt paths.
  - `/auth/me` uses the basic lookup.
  - The rate-limit and audit dependencies land in Task 7. Leave a `// Task 7` hook and ensure that task's tests cover these routes.
- [ ] **Step 5: Run them.** They should PASS.
- [ ] **Step 6: Commit.** `git commit -m "feat(server): none/basic auth with Postgres sessions"`

---

### Task 7: Rate limits in Postgres, and the audit helper

**Files:**
- Create: `server/migrations/0003_rate_limits.sql`
- Create: `server/src/http/rateLimit.ts`, `server/src/audit.ts`
- Modify: `server/src/auth/basicRoutes.ts` (IP limits on login/register; `user.register` / `user.logout` audit)
- Test: `server/test/http/rateLimit.test.ts`, `server/test/audit.test.ts`

**Interfaces:**
- Produces from `rateLimit.ts`:
  - `hitRateLimit(sql, key: string, windowSec: number): Promise<number>`, which returns the count after this hit.
  - `userRateLimit(prefix: keyof Config['rateLimits'])`, which is middleware.
  - `chargeUserRateLimit(c, prefix)`, the imperative form used later by summary and audio.
  - `ipRateLimit(prefix: 'login' | 'register', max: number, windowSec: number)`, which is middleware.
- Produces from `audit.ts`: `recordAudit(c, { action: string; resourceType: string; resourceId?: string | null; metadata?: Record<string, unknown>; statusCode?: number }): Promise<void>`. It never throws.
- Migration: `CREATE TABLE rate_limits (key text PRIMARY KEY, count int NOT NULL, window_ends_at timestamptz NOT NULL);`
- The algorithm is a single statement, so concurrent hits can't lose increments:

```sql
INSERT INTO rate_limits AS r (key, count, window_ends_at)
VALUES (${key}, 1, now() + make_interval(secs => ${windowSec}))
ON CONFLICT (key) DO UPDATE SET
  count = CASE WHEN r.window_ends_at <= now() THEN 1 ELSE r.count + 1 END,
  window_ends_at = CASE WHEN r.window_ends_at <= now() THEN now() + make_interval(secs => ${windowSec}) ELSE r.window_ends_at END
RETURNING count
```

- [ ] **Step 1: Port the tests.** Port `api/tests/test_rate_limit_config.py`. Port the parts of `test_audit_coverage.py` that cover the basic auth routes; the rest belongs to the router tasks, so note that in PORTING.md.

- [ ] **Step 2: Add the contract tests for C §2.6 and §2.7.**

```ts
it('20 concurrent hits on one key count exactly 1..20', async () => {
  const counts = await Promise.all(Array.from({ length: 20 }, () => hitRateLimit(testSql(), 'k', 60)));
  expect([...counts].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
});
it('window is fixed from the first hit and resets after expiry', …); // window 1s, wait 1.1s
it('user limit → 429 "Rate limit exceeded: 20 feed_generation per 24h. Try again later."', …); // via a test-only route
it('user limits are skipped under AUTH_PROVIDER=none', …);
it('IP key uses X-Real-IP; login 6th attempt in 900s → 429 "Too many login attempts. Try again later."', …);
it('a 422-invalid request still consumes a slot (rate limit runs before validation)', …);
it('recordAudit writes ip from X-Real-IP, user_agent truncated to 500, never throws on DB error', …);
```

- [ ] **Step 3: Run them.** They should FAIL.
- [ ] **Step 4: Implement.**
  - **Keys.** Users: `ratelimit:{prefix}:{user_id}`. IPs: `ratelimit:{prefix}:ip:{ip}`.
  - **429 detail.** The exact strings are in C §2.6. `{window//3600}h` uses integer division.
  - **Ordering.** Every route that uses a limit composes its middleware as `currentUser → userRateLimit → validators → handler`.
- [ ] **Step 5: Run them.** They should PASS.
- [ ] **Step 6: Commit.** `git commit -m "feat(server): Postgres fixed-window rate limits and audit log"`

---

### Task 8: `/users` and `/workspaces` routes

**Files:**
- Create: `server/src/routes/users.ts`, `server/src/routes/workspaces.ts`
- Modify: `server/src/app.ts` (mount at `/users`, `/workspaces`)
- Test: `server/test/routes/users.test.ts`, `server/test/routes/workspaces.test.ts`

**Interfaces:**
- Consumes: `createApp`, `currentUser`, `HttpError`, `body`, `recordAudit`, `toPydanticIso`, `seedUsers`, `client`, `testApp`.
- Produces: `usersRoutes(): Hono<AppEnv>` and `workspacesRoutes(): Hono<AppEnv>`.

- [ ] **Step 1: Port the tests.** Port `api/tests/test_workspaces.py`, plus every case in `test_auth_scoping.py`, `test_idor_followups.py`, `test_wave3_correctness.py`, `test_error_contracts.py` and `test_audit_coverage.py` that hits `/users` or `/workspaces`. Tick them in PORTING.md.
- [ ] **Step 2: Add the contract tests for C §1.18 and §1.19 that the ported tests miss.**
  - `audit-log` `limit` is clamped to [1, 500].
  - `metadata` comes back as a **JSON string** (reproduced on purpose; C §6.18).
  - `DELETE /workspaces/{id}` returns 204 for a missing id once the guards pass.
  - Deleting the workspace `…0001` gives 400 `Cannot delete the default workspace`.
  - Deleting your only workspace gives 400 `Cannot delete your only workspace`.
  - The activity `detail` strings use the exact `"N chunks · status"` / `"N posts · M papers[ · Ss]"` formats, sorted DESC, at most 20.
- [ ] **Step 3: Run them.** They should FAIL.
- [ ] **Step 4: Implement.** Port `api/routers/users.py` and `api/routers/workspaces.py`, keeping the SQL verbatim. Timestamps go through `toPydanticIso`.
- [ ] **Step 5: Run them.** They should PASS.
- [ ] **Step 6: Commit.** `git commit -m "feat(server): users and workspaces routes"`

---

### Task 9: `/settings` routes, plus local storage's delete path

**Files:**
- Create: `server/src/routes/settings.ts`, `server/src/storage/local.ts`
- Test: `server/test/routes/settings.test.ts`, `server/test/storage/local.test.ts`

**Interfaces:**
- Consumes: Task 4's schema exports, and `deps.fetch` (falling back to global `fetch`).
- Produces: `settingsRoutes(): Hono<AppEnv>`.
- Produces from `storage/local.ts`: `deletePaperArtifacts(config: Pick<Config, 'uploadDir' | 'figuresDir'>, paperId: string): Promise<void>`. It removes `{uploadDir}/{paperId}.pdf` and recursively removes `{figuresDir}/{paperId}`, swallowing errors. Plan 02 extends this file.
- Produces: `coercePy(kind: 'int' | 'float', v: unknown): number`, which throws on failure and follows Python `int()`/`float()` semantics.

- [ ] **Step 1: Port the tests.** Port `api/tests/test_settings_contract.py` (the HTTP parts) and `test_public_deployment.py`, plus the `/settings` cases in the scoping and audit test files.
- [ ] **Step 2: Add the tests.**

```ts
it.each([
  ['int', 5, 5], ['int', 5.9, 5], ['int', '5', 5], ['int', true, 1],
  ['float', '0.5', 0.5], ['float', true, 1], ['float', 2, 2],
])('coercePy(%s, %j) = %j', (k, v, out) => expect(coercePy(k as 'int', v)).toBe(out));
it.each([['int', '5.9'], ['int', 'x'], ['float', 'x'], ['int', null]])('coercePy(%s, %j) throws', …);
it('PUT out of bounds → 422 "posts_per_generation must be between 1 and 50"', …);
it('PUT bad type → 422 "posts_per_generation must be a int"', …);
it('GET redacts secrets to "set"/"" and echoes unknown stored keys (preferences)', …);
it('PUT drops unknown keys silently; PUBLIC_DEPLOYMENT drops provider keys silently', …);
it('PUT with "set" stores it literally (reproduced)', …);
it('ollama-models buckets names: embed/bge/nomic → embed; "vision" family → vision too; size "X.YGB"', …); // fake fetch
it('ollama-models upstream error → all-empty lists with 200', …);
it('clear-everything deletes the listed tables, keeps corpora + user_settings, calls deletePaperArtifacts per paper, audits account.clear_all', …);
```

- [ ] **Step 3: Run them.** They should FAIL.
- [ ] **Step 4: Implement.** Port `api/routers/settings.py`, including `SELECT … FOR UPDATE` in a transaction for PUT and the per-route audit actions from C §1.15.
- [ ] **Step 5: Run them.** They should PASS.
- [ ] **Step 6: Commit.** `git commit -m "feat(server): settings routes and local artifact cleanup"`

---

### Task 10: `/alerts`, `/annotations`, `/bookmarks` and `/likes` routes

**Files:**
- Create: `server/src/routes/{alerts,annotations,bookmarks,likes}.ts`
- Test: `server/test/routes/{alerts,annotations,bookmarks,likes}.test.ts`

**Interfaces:**
- Produces: `alertsRoutes()`, `annotationsRoutes()`, `bookmarksRoutes()`, `likesRoutes()`, each `Hono<AppEnv>`.

- [ ] **Step 1: Port the tests.** Port `api/tests/test_annotations.py`, `test_bookmarks.py` and `test_likes.py`, plus the cases for these four prefixes in the scoping, IDOR, wave3, error-contract and audit files.
- [ ] **Step 2: Add the contract tests from C §1.2–1.4 and §1.8.**
  - Annotation timestamps use `toIsoformat` (`+00:00`); alerts use `toPydanticIso`.
  - `POST /bookmarks` and `POST /likes` return **201** for both `created` and `already_*`.
  - `DELETE /bookmarks/post/...` never 404s.
  - `DELETE /alerts/{id}` 404s once the alert is already dismissed.
  - `PUT /alerts/{id}/read` never 404s.
  - `DELETE /alerts/not-a-uuid` returns 404 JSON (Review Focus 5).
  - `GET /likes/feed/{id}` returns `{"posts":[…],"replies":{"p:m":true}}`, and message_index `-1` counts at post level.
- [ ] **Step 3: Run them.** They should FAIL.
- [ ] **Step 4: Implement.** Port the four router files with their SQL verbatim. `post_snapshot` is stored as given.
- [ ] **Step 5: Run them.** They should PASS.
- [ ] **Step 6: Commit.** `git commit -m "feat(server): alerts, annotations, bookmarks, likes routes"`

---

### Task 11: `/tags` and `/citations` routes

**Files:**
- Create: `server/src/routes/tags.ts`, `server/src/routes/citations.ts`, `server/src/citations/format.ts`
- Test: `server/test/routes/{tags,citations}.test.ts`, `server/test/citations/format.test.ts`

**Interfaces:**
- Produces: `formatApa(title: string, authors: string[], year: number | null, doi: string | null): string` and `formatMla(...same): string`, plus `tagsRoutes()` and `citationsRoutes()`.

- [ ] **Step 1: Port the tests.** Port `api/tests/test_tags.py`, plus the tags/citations cases in the cross-cutting files.
- [ ] **Step 2: Add the golden tests.** These were generated from `api/routers/citations.py` on 2026-10-29. Python's quirks are reproduced, such as `et al..` and the `" ."` that appears when the year is missing:

```ts
const A21 = Array.from({ length: 21 }, (_, i) => `First${i} Last${i}`);
it.each([
  [['Deep Nets', [], 2020, null], 'Unknown Author (2020). Deep Nets.', '"Deep Nets." 2020.'],
  [['Deep Nets', ['Ada Lovelace'], 2020, '10.1/x'], 'Lovelace, A. (2020). Deep Nets. https://doi.org/10.1/x', 'Lovelace, Ada. "Deep Nets." 2020. https://doi.org/10.1/x.'],
  [['Deep Nets', ['Ada Lovelace', 'Alan Turing'], null, null], 'Lovelace, A., & Turing, A. (n.d.). Deep Nets.', 'Lovelace, Ada, and Alan Turing. "Deep Nets." .'],
  [['Deep Nets', ['Ada B Lovelace', 'Turing', 'Grace Hopper'], 2021, '10.2/y'], 'Lovelace, A. B., Turing, & Hopper, G. (2021). Deep Nets. https://doi.org/10.2/y', 'Lovelace, Ada B, et al.. "Deep Nets." 2021. https://doi.org/10.2/y.'],
  [['T', A21, 1999, null], 'Last0, F., Last1, F., Last2, F., Last3, F., Last4, F., Last5, F., Last6, F., Last7, F., Last8, F., Last9, F., Last10, F., Last11, F., Last12, F., Last13, F., Last14, F., Last15, F., Last16, F., Last17, F., Last18, F., ... Last20, F. (1999). T.', 'Last0, First0, et al.. "T." 1999.'],
])('%j', ([t, a, y, d], apa, mla) => {
  expect(formatApa(t as string, a as string[], y as number | null, d as string | null)).toBe(apa);
  expect(formatMla(t as string, a as string[], y as number | null, d as string | null)).toBe(mla);
});
```

  Route tests:
  - `format` is echoed verbatim even when it isn't recognized.
  - The ILIKE runs **unescaped** on `title[:80]`.
  - A missing title gives 422; no match gives 404 `Paper not found`.
  - Tag-name tests: an empty name gives 400 `Tag name cannot be empty`, `POST /tags` returns the existing tag with 201, and `DELETE /tags/assign/...` is idempotent.
- [ ] **Step 3: Run them.** They should FAIL.
- [ ] **Step 4: Implement.** Port `api/routers/tags.py` (all six routes, including the four the frontend never calls) and `api/routers/citations.py`. Python `str.split()` splits on runs of whitespace and drops empty strings; `.split(/\s+/).filter(Boolean)` matches that.
- [ ] **Step 5: Run them.** They should PASS.
- [ ] **Step 6: Commit.** `git commit -m "feat(server): tags and citations routes"`

---

### Task 12: API entry point, container image and CI job

**Files:**
- Create: `server/src/api/main.ts`, `server/src/logger.ts`, `server/Dockerfile`, `server/.dockerignore`
- Modify: `.github/workflows/ci.yml` (add a `server` job; leave the Python jobs alone)
- Create: `server/README.md` (how to run, test, migrate; the PORTING.md workflow)
- Test: `server/test/api/main.test.ts`

**Interfaces:**
- Produces: `startApi(env = process.env): Promise<{ close(): Promise<void>; port: number }>`. It runs `loadConfig`, then `createSql`, then `migrate`, then `ensureStubUser` (when `authProvider === 'none'`), then `createApp`, then `serve` on `0.0.0.0:${port}`. It shuts down cleanly on SIGTERM.
- Produces: `logger`, a pino instance at level `LOG_LEVEL` (default `info`).

- [ ] **Step 1: Write the failing test** `server/test/api/main.test.ts`. It calls `startApi({ DATABASE_URL: <container url>, PORT: '0' })`, then fetches `/health` and `/auth/provider` over real HTTP, checks the stub user row exists, and calls `close()`.
- [ ] **Step 2: Run it.** It should FAIL.
- [ ] **Step 3: Implement `main.ts`.** It runs `startApi()` when executed directly.
- [ ] **Step 4: Write the Dockerfile.**
  - Build stage: `node:24-alpine`, `npm ci`, `npm run build`, `npm prune --omit=dev`.
  - Runtime stage: `node:24-alpine`. Add user `ficino` uid/gid 10001, create `/app/uploads`, `/app/figures` and `/app/media` owned by it, copy `dist`, `migrations`, `node_modules` and `package.json`, set `USER ficino`, `EXPOSE 8000`, and `CMD ["node","dist/api/main.js"]`.
  - Healthcheck: `HEALTHCHECK CMD wget -qO- http://127.0.0.1:8000/health || exit 1`. busybox `wget` and `sh`/`base64` are present in alpine, and the e2e harness needs them.
- [ ] **Step 5: Smoke-test the image** (with nothing bound to host ports):

```bash
docker network create ficino-ts-smoke
docker run -d --rm --name ts-smoke-pg --network ficino-ts-smoke -e POSTGRES_USER=ficino -e POSTGRES_PASSWORD=ficino -e POSTGRES_DB=ficino pgvector/pgvector:pg18
docker build -t ficino-server:smoke server/
docker run -d --rm --name ts-smoke-api --network ficino-ts-smoke -e DATABASE_URL=postgresql://ficino:ficino@ts-smoke-pg:5432/ficino ficino-server:smoke
sleep 8; docker exec ts-smoke-api wget -qO- http://127.0.0.1:8000/auth/provider
docker rm -f ts-smoke-api ts-smoke-pg; docker network rm ficino-ts-smoke
```

  Expected output: `{"provider":"none","public_deployment":false}`.
- [ ] **Step 6: Add the CI job.** It runs on `ubuntu-latest` with `actions/setup-node@v4` `node-version: 24`, then `cd server && npm ci && npm run typecheck && npm test`.
- [ ] **Step 7: Run the whole suite.** `cd server && npm run typecheck && npm test` should PASS. In PORTING.md every line for this plan's routers is ticked, and the rest name their plan.
- [ ] **Step 8: Commit.** `git commit -m "feat(server): API entry, container image, CI job"`

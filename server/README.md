# ficino-server

The TypeScript port of Ficino's backend (Hono + postgres.js + zod). It serves the same wire contract as the
Python FastAPI service, so the React frontend works unchanged. The Python `api/` and `worker/` services remain
in place and keep running until the cutover plan; nothing here replaces them yet.

## Commands

Run from `server/` (Node >= 22.18; the image uses Node 24).

| Command | What it does |
| --- | --- |
| `npm run dev:api` | Starts the API with file watching (`DATABASE_URL` required; `PORT`, default 8000; binds to 127.0.0.1 unless `API_HOST` is set) |
| `npm test` | Runs the vitest suite against a throwaway Postgres |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | Emits `dist/` (entry: `dist/api/main.js`) |
| `npm run migrate` | Applies `migrations/NNNN_*.sql` to `DATABASE_URL` (the API also migrates on startup) |

The container image is built from `server/Dockerfile` and listens on 8000 inside the container (`API_HOST=0.0.0.0` is set in the image only).
The image also sets `ENVIRONMENT=production` so a bare `docker run` fails closed (no dev CORS; `SIGNED_URL_KEY` required). For a local `docker run`, pass `-e ENVIRONMENT=development` to get dev CORS.

## Tests

Docker must be available. `test/globalSetup.ts` starts `pgvector/pgvector:pg18` with the docker CLI, published
on 127.0.0.1 only (never 0.0.0.0), migrates it, and removes it afterwards. Each DB test file calls
`resetDb(testSql())` in `beforeEach`. If a run is killed, clean up with `docker ps --filter name=ficino-ts-test`.

## Porting convention

`test/PORTING.md` lists every Python test in `api/tests` and `shared/tests`, one line each.

- Ported: tick the box and append ` — plan01/T<N>`.
- Not applicable: tick it and append ` — n/a: <reason>`.
- Owned by a later plan: leave unticked and append ` — plan0X`.

Wire literals (paths, status codes, `detail` strings) are copied exactly from the contract in
`docs/superpowers/specs/ts-port-reference/api-contract.md`.

# Phase 0 — Status

Date: 2026-04-17 (all items closed)

## Done

- **0.2 python-multipart** — bumped floor to `>=0.0.18` in `api/requirements.txt`.
- **0.3 Pillow** — bumped floor to `>=10.3.0` in `worker/requirements.txt`.
- **0.4 pymupdf** — bumped floor to `>=1.24.10` in `worker/requirements.txt`.
- **0.5 fastapi** — bumped floor to `>=0.115.0` in `api/requirements.txt`.
- **0.6 general floor bumps** — moved every `>=` floor up to a post-CVE version (uvicorn, pydantic, asyncpg OK, redis, httpx, anthropic, structlog, celery, PyJWT, bcrypt, tiktoken). Not converted to `~=` / `==` yet — that needs a pip-tools lockfile workflow which isn't set up. Follow-up ticket below.
- **0.7 pip-audit + npm audit** — ran both live. Results:
  - `pip-audit -r api/requirements.txt` → **No known vulnerabilities found.**
  - `pip-audit -r worker/requirements.txt` → **No known vulnerabilities found.**
  - `npm audit` (frontend) → **4 high severity** in `serialize-javascript` (transitive via `workbox-build` ← `vite-plugin-pwa@1.2.0`). Build-time only, not runtime. `npm audit fix --force` would downgrade `vite-plugin-pwa` to `0.19.8` — breaking. See "Needs user decision" below.
- **0.8 pre-commit hook** — added `.pre-commit-config.yaml` with `detect-private-key`, `check-added-large-files`, and two local hooks that block committing `.env` files or common API-key patterns. User needs to run `pre-commit install` once per clone.

## Resolved (were "needs user decision")

### 0.1 Anthropic API key — split into `.env.secrets` (option B)

Picked the split-file pattern: non-sensitive config in `.env`, sensitive keys in `.env.secrets` at 0600.

Changes:
- New `/projects/ficino/.env.secrets` — holds `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `VOYAGE_API_KEY`. File mode `-rw-------`.
- `/projects/ficino/.env` — secrets stripped, keeps config only, carries a comment pointing to `.env.secrets`.
- `/projects/ficino/.env.secrets.example` — committed template with placeholders.
- `/projects/ficino/.gitignore` — added `.env.secrets` and `.env.*.local`. Confirmed via `git check-ignore`.
- `/projects/ficino/docker-compose.yml` — api + worker both use list form: `env_file: [.env, .env.secrets]`.
- Containers force-recreated (`docker compose up -d --force-recreate api worker`). Verified env loading: Anthropic key 108 chars, Voyage 46 chars, DATABASE_URL from `.env`. API health 200.

**Caveat flagged for production:** `DATABASE_URL` still lives in `.env` because the dev Postgres credential is `ficino:ficino` (no real secret). When you set a real password for ficino.ai, either inline the full URL into `.env.secrets` or split `POSTGRES_PASSWORD` out and build the URL from pieces. Noted inline in the new `.env`.

### npm audit 4 highs — `"overrides"` applied (option B)

Added to `frontend/package.json`:
```json
"overrides": {
  "serialize-javascript": "^7.0.5"
}
```

(Not `^6.0.2` — `6.x` is still in the vulnerable range per the audit's `<=7.0.4` / `<7.0.5` bounds. 7.0.5 clears both the RCE and the ReDoS CVEs.)

Verified after override:
- `npm install`: removed 2 packages, no errors
- `npm audit`: **0 vulnerabilities**
- `npm run build`: sw.js + manifest + 23 precache entries generated, no errors
- `docker compose build frontend` + `up -d`: healthy
- `/ficino/sw.js` + `/ficino/manifest.webmanifest` over the proxy: 200 OK
- Playwright `AUG-17` / `AUG-18` / `AUG-19` PWA tests: 3/3 pass (manifest + SW activated + offline paint)

## Container rebuilds done

- api + worker: rebuilt twice during Phase 1 (first after non-IDOR edits, then after IDOR sweep). Third recreate (no rebuild) for the env-split.
- frontend: rebuilt once for the serialize-javascript override.

## Follow-up ticket

- **Pip-tools lockfile:** set up `pip-compile` so both `requirements.txt` files are generated from `requirements.in` with exact pinned versions + hashes. Blocks full completion of 0.6. ~2h.

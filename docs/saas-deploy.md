# SaaS Deploy Runbook — Ficino on Railway + Supabase

This is the end-to-end guide for standing up the hosted version of Ficino
at `https://ficino.app`. Self-hosters don't need any of this — `docker
compose up` remains the supported path.

The target stack:

| Layer | Service |
|---|---|
| Postgres + pgvector, Auth, Storage | Supabase |
| API, Worker, Redis, Frontend | Railway |
| DNS / SSL / WAF | Cloudflare |

---

## 1. Supabase project

### 1a. Create the project
1. Go to <https://supabase.com/dashboard> → **New project**
2. Pick a strong DB password (save it — it's in the connection string)
3. Region: closest to your Railway deploy
4. Wait for the project to finish provisioning (~2 min)

### 1b. Enable extensions
SQL Editor → run:
```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

### 1c. Load the schema
Supabase's connection string is under **Project Settings → Database → Connection string → URI**.

```bash
# From your local checkout. init.sql is the FULL schema — every add_*.sql /
# update_*.sql migration is folded into it, so a fresh database needs just
# this one file:
psql "<SUPABASE_CONNECTION_STRING>" -v ON_ERROR_STOP=1 -f infra/postgres/init.sql
```

Only databases created BEFORE the migrations were folded into init.sql
(2026-08-03) need the standalone files: apply any `add_*.sql` /
`update_*.sql` migrations not yet applied, in this order (alphabetical,
except that `add_feed_posts_table.sql` must precede
`add_feed_posts_search_partial.sql`):
`add_alerts_dedupe`, `add_amplifier_persona`, `add_audit_log`,
`add_chunks_contextual_prefix`, `add_chunks_unique_paper_chunk_idx`,
`add_corpus_synthesis_status`, `add_feed_audio_status`,
`add_feed_media_claimed_at`, `add_feed_podcast`, `add_feed_posts_table`,
`add_feed_posts_search_partial`, `add_figures_unique_paper_figure_idx`,
`add_fk_indexes`, `add_hnsw_index`, `add_papers_feeds_indexes`,
`add_persona_dms_table`, `add_personas_feed_eligible`,
`add_persona_temperature`, `add_post_replies_unique`, `add_typed_figures`,
`add_user_id_to_chunks_feed_posts`, `update_amplifier_prompt`
(all in `infra/postgres/`, `.sql` suffix). Going forward, every new
migration must be folded into `init.sql` in the same PR that adds it.

The `migrate_personas_v3.py` script loads the full persona prompts — run it
against the Supabase DB the same way you would a local one:
```bash
DATABASE_URL="<SUPABASE_CONNECTION_STRING>" python infra/postgres/migrate_personas_v3.py
```

### 1d. Configure Auth
**Authentication → Providers → Email**:
- Enable email provider ✓
- Enable email confirmations ✓ (or toggle off for beta if you want fewer friction points)
- Set **Site URL** to `https://ficino.app`
- Add **Redirect URLs**: `https://ficino.app/**`, `http://localhost:5173/**` (for local dev against the hosted Supabase project)

**Authentication → URL Configuration**: set the default redirect to `https://ficino.app`.

Copy the **JWT secret** (Settings → API → JWT Settings) — this is `SUPABASE_JWT_SECRET` on the API service.

### 1e. Create the storage bucket
**Storage → New bucket**:
- Name: `papers`
- Public: **no** (private — we issue signed URLs)
- File size limit: 50 MB (matches `MAX_UPLOAD_SIZE_MB`)
- Allowed MIME types: `application/pdf, image/png`

### 1f. Collect the keys (you'll paste these into Railway)
From **Project Settings → API**:
- `SUPABASE_URL` — the project URL, e.g. `https://abcd1234.supabase.co`
- `SUPABASE_ANON_KEY` — safe to expose to the browser
- `SUPABASE_SERVICE_ROLE_KEY` — **secret**; used by API + worker for storage + user upserts
- `SUPABASE_JWT_SECRET` — from Settings → API → JWT Settings

---

## 2. Railway project

Create a single Railway project with **four services** pointing at the
same GitHub repo, each with a different Root Directory:

| Service | Root Directory | Config |
|---|---|---|
| `api` | `/api` | `api/railway.json` |
| `worker` | `/worker` | `worker/railway.json` |
| `frontend` | `/frontend` | `frontend/railway.json` |
| `redis` | — | Railway's managed Redis plugin |

For each code service: **New Service → GitHub Repo → set the Root Directory**.
Railway picks up the service's `railway.json` automatically.

### 2a. API service variables
Under **Variables**, paste:

```
DATABASE_URL=<supabase connection string — use the transaction pooler URL>
REDIS_URL=${{Redis.REDIS_URL}}
ENVIRONMENT=production
AUTH_PROVIDER=supabase
SUPABASE_URL=<from 1f>
SUPABASE_ANON_KEY=<from 1f>
SUPABASE_JWT_SECRET=<from 1f>
STORAGE_PROVIDER=supabase
SUPABASE_SERVICE_ROLE_KEY=<from 1f>
SUPABASE_STORAGE_BUCKET=papers
PUBLIC_DEPLOYMENT=true
LLM_PROVIDER=api
EMBED_PROVIDER=voyage
VISION_PROVIDER=api
ANTHROPIC_API_KEY=<your key>
VOYAGE_API_KEY=<your key>
CLAUDE_MODEL=claude-sonnet-4-6
CORS_ORIGINS=https://ficino.app
SIGNED_URL_KEY=<generate: python -c "import secrets; print(secrets.token_hex(32))">
ALLOW_REGISTRATION=true
```

### 2b. Worker service variables
Same provider + storage vars as the API. The worker doesn't need
Supabase Auth vars (it never validates JWTs), but it does need the
service-role key to write to Storage.

```
DATABASE_URL=<same as api>
REDIS_URL=${{Redis.REDIS_URL}}
ENVIRONMENT=production
STORAGE_PROVIDER=supabase
SUPABASE_URL=<from 1f>
SUPABASE_SERVICE_ROLE_KEY=<from 1f>
SUPABASE_STORAGE_BUCKET=papers
LLM_PROVIDER=api
EMBED_PROVIDER=voyage
VISION_PROVIDER=api
ANTHROPIC_API_KEY=<your key>
VOYAGE_API_KEY=<your key>
CLAUDE_MODEL=claude-sonnet-4-6
SIGNED_URL_KEY=<same as api>
CELERY_WORKER_CONCURRENCY=2
```

### 2c. Frontend service variables (BUILD-TIME)
Vite inlines `VITE_*` at build time — these MUST be set as
**build-time** variables (Railway calls these "Build Variables"):

```
VITE_API_BASE=https://api.ficino.app
VITE_SUPABASE_URL=<from 1f>
VITE_SUPABASE_ANON_KEY=<from 1f>
```

### 2d. Redis
Click **New** → **Database** → **Add Redis**. Railway auto-injects
`REDIS_URL` into any service that references it (the template var
`${{Redis.REDIS_URL}}` above).

---

## 3. Domains

### 3a. Generate public domains
On each service → **Settings → Networking → Generate Domain**:
- `api`: note the `xxxxx.up.railway.app` URL
- `frontend`: note the URL

### 3b. Custom domains
**frontend** service → Custom Domain → add `ficino.app`. Railway gives
you a CNAME target; add that record in Cloudflare (DNS-only, not proxied
— Railway handles SSL end-to-end).

**api** service → Custom Domain → add `api.ficino.app`. Same CNAME
wiring.

### 3c. Cloudflare DNS
For `ficino.app`:
- `@` CNAME → Railway frontend target (DNS only, grey cloud)
- `api` CNAME → Railway api target (DNS only, grey cloud)
- `www` CNAME → `ficino.app` (or redirect rule)

If you want WAF / DDoS / rate limiting, switch the proxy (orange cloud)
back on after domains verify. Railway tolerates Cloudflare proxying once
SSL is issued.

---

## 4. First deploy checklist

1. Push to the branch Railway watches (typically `main`)
2. Each service builds its Dockerfile and deploys. Tail logs; the API's
   `/healthz` should return 200 within ~30s of boot
3. Load `https://ficino.app` → LoginPage shows → click **Create account**
4. Sign up with a real email → Supabase confirmation mail lands
5. After confirming, you should land in the app with an empty Default
   workspace
6. Upload a small PDF → worker picks it up → ingestion runs → figures appear
7. Check Supabase **Storage → papers → {your-user-id}/** — PDF + figure
   crops should be present
8. Generate a feed → posts render → figure posts load images from the
   Supabase signed URLs

---

## 5. Ongoing operations

### 5a. Migrations
Each new `infra/postgres/add_*.sql` runs manually:
```bash
psql "<SUPABASE_CONNECTION_STRING>" -f infra/postgres/add_whatever.sql
```

### 5b. Log review
Railway keeps the last ~7 days of logs per service. Anything longer-term
should go through a forwarder to Better Stack / Axiom / Datadog — out of
scope for this doc.

### 5c. Cost
At beta traffic (~20 users, a few uploads/day): Supabase Free tier + ~$10/mo
Railway. Once you cross Supabase's free DB (500MB), jump to Pro ($25/mo).

### 5d. Rotating a compromised key
- `SIGNED_URL_KEY` rotation: generate a new one, update on both API and
  worker, redeploy both simultaneously. Any previously-issued figure
  URLs will 403 until regenerated.
- Supabase keys: rotate in the Supabase dashboard → paste into Railway
  → redeploy.
- API keys (Anthropic/Voyage): rotate at the provider → paste into
  Railway → redeploy.

### 5e. Upgrading self-host deployments to non-root images
The api/worker images now run as user `ficino` (uid 10001) instead of
root. **Existing docker-compose deployments** must fix ownership of the
named volumes once, after pulling the new images:
```bash
docker compose run --rm --user root --entrypoint sh api -c "chown -R 10001:10001 /app/uploads /app/figures"
docker compose up -d
```
Fresh installs need nothing — Docker seeds named volumes from the
image's directory ownership. Railway is unaffected (no volumes).

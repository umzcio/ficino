# Ficino TS port: schema, data restore, tests, deploy

Research date 2026-10-29. Read-only on `<repo>` and `<archive-root>`.
**Verified, not just read:** I loaded `init.sql` into a throwaway `pgvector/pgvector:pg16` container
(`--network none`, tmpfs, removed afterwards). I loaded the prod `schema.sql` into a second DB in
the same container and diffed the two catalogs. I restored the prod public COPY data into the
init.sql schema and test-ran a re-key to the stub user. Scratch artifacts are in
`<scratch>/ficino-port/work/`: `init.cat` and `prod.cat` (the catalog dumps) and
`rekey-test.sql`. None of them contain secrets.

Abbreviations: **I** = `<repo>/infra/postgres/init.sql`.
**P** = `<archive>/db/schema.sql`.
**D** = `.../db/data.sql`. **A** = `<archive>/`.

---

## 1. Schema

### Extensions
| | I | P |
|---|---|---|
| vector | `CREATE EXTENSION vector` I:13. Resolves to 0.8.2 on pg16 | `public` P:55 |
| pg_trgm | I:14. **No trgm index or `%`/`similarity()` use anywhere** (dead) | `public` P:27 |
| pgcrypto, uuid-ossp, pg_stat_statements, supabase_vault | none | `extensions`/`vault` schemas (Supabase only) |

`gen_random_uuid()` is core in PG13+, so pgcrypto is not needed.

### Tables (23). All PKs are `uuid DEFAULT gen_random_uuid()` unless noted. Timestamps are `timestamptz DEFAULT now()`.

There are **no CHECK constraints and no enum types**. Every status is free `TEXT`, and the value sets live in code (see the end of this section).

| table (I line) | columns (type, default, NOT NULL marked `!`) | constraints / FKs | indexes |
|---|---|---|---|
| users (17) | clerk_id text UNIQUE, email text! UNIQUE, password_hash text, display_name text, created_at, generation_count_today int=0, generation_reset_at tstz=now() | — | pkey, users_clerk_id_key, users_email_key |
| corpora (32) ("workspaces") | user_id→users CASCADE, name text!='Default', created_at | | pkey only |
| papers (42) | user_id→users CASCADE, corpus_id→corpora SET NULL, title, authors text[], year int, doi, filename text!, file_path text!, status text!='pending', extraction_path text, error_message, chunk_count int=0, figure_count int=0, uploaded_at, processed_at | | papers_user_corpus_status_idx (user_id,corpus_id,status) I:815; papers_user_uploaded_idx (user_id, uploaded_at DESC) I:818 |
| tags (62) | user_id→users CASCADE, name text! | UNIQUE(user_id,name) | |
| paper_tags (69) | paper_id→papers CASCADE, tag_id→tags CASCADE | PK(paper_id,tag_id) | |
| chunks (76) | paper_id→papers CASCADE, user_id uuid!→users CASCADE, section text!, content text!, chunk_type text!='text', chunk_index int!, token_count int, embedding **vector(1024)**, search_vector tsvector, contextual_prefix text, metadata jsonb='{}' | UNIQUE(paper_id,chunk_index) **twice** (see diff) | chunks_user_id_idx I:95; GIN(search_vector) I:101; chunks_paper_id_idx I:751; **chunks_embedding_hnsw `hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=64)`** I:789 |
| figures (115) | paper_id→papers CASCADE, page_number int!, image_path text!, extraction_type text!, description, claim_summary, figure_index int!, processed_at, figure_type, caption, figure_number text, data_claim, referenced_paragraph, bbox jsonb, detector_confidence real | UNIQUE(paper_id,figure_index) **twice** | figures_paper_id_idx I:754 |
| feeds (136) | user_id→users CASCADE, corpus_id→corpora SET NULL, tag_filter text[], **posts jsonb!='[]'** (source of truth), generated_at, generation_duration_ms, paper_count, post_count int; folded I:578-606: audio_status text, audio_generated_at, audio_claimed_at, podcast_claimed_at, podcast_status text, podcast_generated_at, podcast_segments jsonb | | feeds_user_corpus_generated_idx (user_id,corpus_id,generated_at DESC) I:821 |
| bookmarks (150) | user_id→users, feed_id→feeds CASCADE, post_index int!, message_index int!=-1 (-1 = post level), post_snapshot jsonb!, bookmarked_at | UNIQUE(user_id,feed_id,post_index,message_index) | bookmarks_user_id_idx I:757 |
| annotations (162) | user_id, feed_id→feeds CASCADE, post_index int!, body text!, created_at, updated_at | UNIQUE(user_id,feed_id,post_index) | (user_id,feed_id) I:173 |
| paper_summaries (181) ("DMs") | paper_id→papers CASCADE **UNIQUE**, messages jsonb!='[]', status text!='complete', task_id text, generated_at | | |
| corpus_syntheses (191) ("group chats") | user_id, name text!, paper_ids uuid[]!, messages jsonb!='[]', generated_at, status text!='complete' + task_id text (I:565) | | |
| post_replies (201) | feed_id→feeds CASCADE, post_index int!, persona_key text! (**no FK**), messages jsonb!='[]', created_at, updated_at | UNIQUE(feed_id,post_index) **twice** | (feed_id,post_index) I:212; post_replies_updated_at_idx I:827 |
| alerts (215) | user_id, alert_type text!, title text!, body text!, metadata jsonb='{}', read bool=false, dismissed bool=false, dedupe_hash text, created_at | | (user_id,read,dismissed,created_at DESC) I:230; **alerts_dedupe_idx UNIQUE (user_id,alert_type,dedupe_hash) WHERE dedupe_hash IS NOT NULL** I:231 |
| user_likes (237) | user_id, feed_id→feeds CASCADE, post_index int!, message_index int!=-1, persona_key, post_type, category text, liked_at | UNIQUE(user_id,feed_id,post_index,message_index) | (user_id,feed_id) I:250 |
| reading_lists (253) | user_id, corpus_id SET NULL, name text!, paper_sequence uuid[]!='{}', rationale jsonb!='[]', created_at | | (user_id,corpus_id) I:263 |
| reading_list_chapters (266) | reading_list_id→reading_lists CASCADE, chapter_index int!, paper_ids uuid[]!, feed_id→feeds SET NULL, status text!='locked', created_at | UNIQUE(reading_list_id,chapter_index) | duplicate plain idx on same cols I:277 |
| user_posts (280) | user_id, corpus_id SET NULL, content text!, replies jsonb!='[]', sources jsonb!='[]', status text!='pending', task_id text, created_at | | (user_id,corpus_id,created_at DESC) I:292 |
| user_settings (295) | **PK user_id**→users CASCADE, settings jsonb!='{}', updated_at | | |
| personas (302) | **PK key text**, handle!, name!, initials!, color!, retrieval_query!, system_prompt! (all text), avatar_url, bio, is_active bool=true, feed_eligible bool!=true, sort_order int!=0, allowed_figure_types text[], created_at, updated_at, temperature real (I:889) | | |
| persona_dms (352) | user_id→users CASCADE, persona_key text!→**personas(key) CASCADE**, messages jsonb!='[]', created_at, updated_at | UNIQUE(user_id,persona_key) | 2 extra plain idx on same cols (I:362, I:847) |
| audit_log (484) | user_id→users **SET NULL**, action text!, resource_type text!, resource_id text, metadata jsonb!='{}', ip text, user_agent text, status_code int, created_at | | (user_id,created_at DESC) I:497; (resource_type,resource_id) I:499 |
| feed_posts (632) (search index over feeds.posts) | feed_id uuid!→feeds CASCADE, user_id uuid!→users CASCADE, post_index int!, content_text text!, persona, post_type, category, paper_ref text, data jsonb!='{}', **search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(content_text,'')\|\|' '\|\|coalesce(paper_ref,''))) STORED**, deleted bool!=false, created_at | UNIQUE(feed_id,post_index) | **GIN(search_vector) WHERE NOT deleted** I:704 (the full index from I:669 is dropped at I:701); feed_id I:673; (feed_id,category) WHERE NOT deleted I:677; user_id I:1093 |

**Function and trigger** (I:103-112, identical in P:62): `chunks_search_vector_trigger()` is plpgsql, `NEW.search_vector := to_tsvector('english', NEW.content)`. It fires `BEFORE INSERT OR UPDATE ON chunks FOR EACH ROW`. It indexes `content` only, not `contextual_prefix`.

**Seeds in I:** 6 personas (I:323-347: skeptic, hype, practitioner, methodologist, gradstudent, archivist) plus amplifier (I:400). The folded UPDATEs then set `feed_eligible=false` for archivist (I:879), set temperatures (I:892-899), set `allowed_figure_types` (I:999-1034) and replace the amplifier prompt (I:1100). `avatar_url` is hard-coded as `/ficino/personas/*.png`. No users are seeded: the API creates the stub user and Default corpus at startup (`api/main.py:40-54`).

**Query usage that the schema exists for:**
- Vector search uses `ORDER BY c.embedding <=> $1::vector` and hybrid `1-(embedding<=>q)` (`worker/lib/retrieval.py:126,155`). Nothing sets `hnsw.ef_search`.
- Full-text search uses `plainto_tsquery('english',…)` plus `ts_rank` on `chunks.search_vector` and `feed_posts.search_vector` (`api/routers/search.py:73,100`, `replies.py:128`, `personas.py:196`).

**Status value sets (from code; the DB does not enforce them):**
- papers.status: `pending → extracting → chunking → embedding → complete | error` (`worker/tasks/ingestion_tasks.py:114,227,264,287,406`).
- papers.extraction_path: holds the **method name** (`pymupdf_clean`, `vision_forced`, …; `ingestion_tasks.py:118,125`), not a path.
- paper_summaries, corpus_syntheses and user_posts status: `pending | generating | complete | error`.
- feeds.audio_status and podcast_status: `generating | ready | failed`.
- reading_list_chapters.status: `locked | unlocked | complete`.
- figures.extraction_type: `vlm_detected` (prod data), `typed` (e2e fixture).
- `task_id` columns hold Celery task ids. `GET /feed/status/{task_id}` is backed by `celery_app.AsyncResult` (`api/routers/feed.py:127-157`).

### init.sql vs prod (Supabase) public schema: catalog diff

**Columns are identical**: same names, types, nullability, defaults and the generated expression. Only the ordinal order differs:
- alerts: `dedupe_hash` comes before `created_at` in I and after it in P.
- feeds: the `*_claimed_at` columns come before the podcast columns in I and after them in P.

This only matters for column-less `INSERT … VALUES`/`SELECT *`. D's COPY statements list their columns explicitly.

Present in **I only** (redundant duplicates, created because folded migrations re-add constraints that already exist inline):
- `chunks_paper_chunk_idx_uq` UNIQUE(paper_id,chunk_index) (I:550) on top of inline `chunks_paper_id_chunk_index_key`
- `figures_paper_figure_idx_uq` UNIQUE(paper_id,figure_index) (I:728) on top of `figures_paper_id_figure_index_key`
- `post_replies_feed_post_uq` UNIQUE(feed_id,post_index) (I:926) on top of `post_replies_feed_id_post_index_key`
- `persona_dms_user_persona_idx` btree (I:847) on top of `persona_dms_user_id_persona_key_idx` (I:362) and the UNIQUE

Present in **P only**:
- RLS is **ENABLED on all 23 tables** (P:923-989) with **zero `CREATE POLICY`**. Only service_role/postgres could read, and the app always used service-role or a direct DSN. Drop RLS on self-host (I already has none).
- `public.rls_auto_enable()` event-trigger function (P:75). The event trigger itself is not in the dump.
- Supabase GRANTs to anon/authenticated/service_role (P:996-2423) and `ALTER PUBLICATION supabase_realtime` (P:994).
- Extensions in `extensions`/`vault`.

**There are no public FKs to `auth.*`** (grep: 0 references). `users.clerk_id` is just a text column holding the Supabase `sub`.

### Migrations in infra/postgres

All 21 `add_*.sql` files and `update_amplifier_prompt.sql` are **folded into I** (I:371-1167, "folded from X" markers; I checked every file name and none is missing). Fold order:
1. alerts_dedupe, amplifier_persona, audit_log, chunks_contextual_prefix
2. chunks_unique_paper_chunk_idx, corpus_synthesis_status
3. feed_audio_status, feed_media_claimed_at, feed_podcast
4. feed_posts_table, feed_posts_search_partial
5. figures_unique_paper_figure_idx, fk_indexes, hnsw_index, papers_feeds_indexes
6. persona_dms_table, personas_feed_eligible, persona_temperature
7. post_replies_unique, typed_figures, user_id_to_chunks_feed_posts, update_amplifier_prompt

On a fresh DB most folded statements are NOTICE no-ops (the columns already exist).

| .py script | what it does | in I? |
|---|---|---|
| `backfill_feed_posts.py` | rebuilds `feed_posts` from `feeds.posts` JSONB with `ON CONFLICT (feed_id,post_index) DO UPDATE`. Honors `DATABASE_URL` (:26) | **No** (data script). **Needed after the restore** (see §2) |
| `migrate_personas_v3.py` | UPDATEs the long v3 `system_prompt`/`retrieval_query` for skeptic/hype/practitioner/methodologist/gradstudent (:17-164, :209) | **No**. I carries shortened prompts (I:321 comment). **Prod never ran it either**: prod prompt lengths 560/442/373/409/342/591/8307 equal I's. **It ignores env: `DATABASE_URL = DEFAULT_DATABASE_URL` (:14)** |

---

## 2. Data restore (A → self-hosted pgvector)

### What's in the archive
- A/README.md: `supabase db dump` of Postgres **17.6**. 23 public tables, **535 rows**.
- `storage/papers/` holds 93 objects (39 MB). `storage-manifest.json` lists name/size/md5-etag/mime for each.
- `railway/vars-*.json` and `supabase-api-keys.json` contain secrets. Never copy them.

Row counts per public table (counted with awk over the D COPY blocks; the sum is 535, matching the README):

| rows | tables |
|---|---|
| 312 | chunks (all with 1024-d embeddings, no NULL search_vector) |
| 108 | feed_posts |
| 31 | figures |
| 15 | paper_tags |
| 14 | tags |
| 12 | feeds |
| 7 | personas |
| 6 | papers, paper_summaries |
| 5 | post_replies |
| 3 | alerts, corpora, reading_list_chapters |
| 2 | users, audit_log, user_likes |
| 1 | persona_dms, reading_lists, user_posts, user_settings |
| 0 | annotations, bookmarks, corpus_syntheses |

The auth.* blocks (users 1, identities 1, sessions 3, refresh_tokens 5, mfa_amr_claims 3) and storage.* blocks (buckets 1, objects 93) are skipped.

**Users** (public.users; **both `password_hash` are NULL**, `display_name` NULL):

| public id | clerk_id (= Supabase sub) | owns |
|---|---|---|
| `<prod-user-id>` | `<prod-auth-id>-…` (matches the single auth.users row) | **everything**: 2 corpora (`<prod-default-corpus-id>` "Default", `<prod-corpus-2-id>` "<corpus-name>"), 6 papers, 12 feeds, 312 chunks, 108 feed_posts, 14 tags, 3 alerts, 2 audit, 1 each of persona_dms, reading_lists, user_posts, user_settings, 2 likes |
| `<orphan-user-id>` | `<orphan-auth-id>-…` (**no auth.users row**) | only an empty "Default" corpus `<orphan-corpus-id>` |

`user_settings` holds only `{"preferences": {…like stats…}}`, with no API keys in it.

**Embeddings were produced by Voyage**: Railway `EMBED_PROVIDER=voyage`, and `VOYAGE_EMBED_MODEL` is unset, so it defaulted to `voyage-4-large` (`worker/lib/embedder.py:31`). The LLM was `api` (claude-sonnet-4-6). The self-host default is `ollama` + `bge-m3` (also 1024-d). **The dimensions match but the vector spaces do not.** A restore must either keep Voyage for query embeddings or re-embed all 312 chunks.

### How storage objects are referenced
| ref | prod value format | archive file |
|---|---|---|
| papers.file_path | `<uid>/<paper_id>.pdf` (Supabase key) | `storage/papers/<uid>/<paper_id>.pdf` |
| figures.image_path | `<uid>/<paper_id>/figures/fig_p<page>_<n>.png` | `storage/papers/<uid>/<paper_id>/figures/fig_p…png` (31) |
| feeds.posts[*].audio_key | `<uid>/feeds/<feed_id>/audio/post_<i>.mp3` | 38 files under `feeds/{<feed-a>,<feed-b>}/audio/` |
| feeds.podcast_segments[*].audio_key | `<uid>/feeds/<feed-a>…/podcast/seg_<n>.mp3` (legacy stitched segments) | 16 seg files; `<feed-b>…/podcast/episode.mp3` (1, single-file episode) |
| feeds.posts / feed_posts.data `figure_url` | **stale Supabase signed URLs with tokens** (6 rows in feeds, 9 in feed_posts) | — |

File counts: 7 PDFs (**one orphan**, `<orphan-pdf>….pdf`, with no papers row), 31 PNGs and 55 MP3s, 93 in total.
Supabase key builders are in `shared/ficino_shared/storage/supabase.py:45-61`.

### What the self-host local provider expects
`shared/ficino_shared/storage/local.py` (`build_backend` in `storage/__init__.py:14`; api wiring in `api/storage/__init__.py`; worker wiring in `worker/lib/storage.py:7-9`):
- Env vars: `STORAGE_PROVIDER=local`, `UPLOAD_DIR` (default `/app/uploads`) and **`FIGURES_DIR`** (default `/app/figures`). The env var is FIGURES_DIR, not FIGURE_DIR (`api/config.py:71-72`).
- PDF: `{UPLOAD_DIR}/{paper_id}.pdf` (local.py:36). **user_id is ignored.** The worker re-derives the path from paper_id (`localize_pdf`, used by `ingestion_tasks.py:109`), so `papers.file_path` is write-only metadata.
- Figure: `{FIGURES_DIR}/{paper_id}/{basename}`. `GET /figures/{paper_id}/{figure_id}?token=` re-joins **`basename(figures.image_path)`** under `FIGURES_DIR/paper_id` (`api/routers/figures.py:48-60`). The prod value works unmodified as long as the file is at the right place.
- The URL is a relative `/figures/{paper_id}/{figure_id}?token=HMAC` (local.py:140). The HMAC key is `SIGNED_URL_KEY`, which is required when `ENVIRONMENT=production` (`shared/ficino_shared/signed_url.py:33-45`).
- Every feed GET re-signs `figure_url` by `figure_id` (`api/routers/feed.py:200-262`), so the stale Supabase URLs get overwritten. Posts whose figure does not resolve keep the stale URL.
- **Audio/podcast: `LocalStorage.save_audio`, `audio_url` and `podcast_*` raise `NotImplementedError`** (local.py:95-125). `_hydrate_audio_urls` swallows the error and sets `audio_url=None` (feed.py:184-192). The 55 MP3s have no local home today. If the port wants them, it needs a new layout such as `{MEDIA_DIR}/feeds/{feed_id}/audio/post_{i}.mp3`.
- Files must be owned by uid 10001 (`ficino`, `api/Dockerfile:29`). The old volumes still exist: `ficino_paper_uploads`, `ficino_figure_images`, `ficino_postgres_data`, `ficino_redis_data`. They hold old dev data and were not inspected.

### Auth interaction
- **AUTH_PROVIDER=none**: every request is `STUB_USER_ID=00000000-0000-0000-0000-000000000000` (`api/auth/providers.py:25-30`, `shared/ficino_shared/constants.py:7`). At startup the API upserts `users(id=stub, clerk_id='stub', email='stub@ficino.dev')` and `corpora(id=00000000-…-0001, 'Default')` with `ON CONFLICT (id) DO NOTHING` (`api/main.py:40-54`). The frontend falls back to workspace `…0001` (`frontend/src/hooks/useWorkspaces.ts:8`). **The restored data is owned by <prod-user-id>, so it is invisible** until it is re-keyed to the stub id.
- **AUTH_PROVIDER=basic**: Redis session cookie `ficino_session` (`providers.py:49-92`) with bcrypt rounds 12 (`api/auth/basic_routes.py:65`). Restored users have **NULL `password_hash`**, so login returns 401 (`basic_routes.py:122`). `/register` is refused once `COUNT(users) > 0` unless `ALLOW_REGISTRATION=true` (`basic_routes.py:54-56`), and it returns 409 for an existing email. A restore therefore has to set a bcrypt hash out of band, for example with a small CLI.
- **AUTH_PROVIDER=supabase**: upserts by `clerk_id = sub` (`providers.py:178-184`). With basic or none, `clerk_id` is just a unique tag. Setting it to `'stub'` (none) or keeping the sub is harmless. It must stay UNIQUE and non-colliding with `'stub'`.

### Mapping a restore script must do (tested end-to-end in scratch pg16)
1. Choose the Postgres version. **D is a PG17 dump: `SET transaction_timeout = 0;` (D:15) is a hard ERROR on pg16.** Either use `pgvector/pgvector:pg17` (already pulled locally) or strip that line.
2. Load the schema from **I**, not P. P's RLS, grants and Supabase roles are noise.
3. Extract **only `COPY "public".…` blocks** plus the leading SETs. D:1 already does `SET session_replication_role = replica`, which disables FK triggers and the chunks trigger during the load. It needs a superuser; the image's `POSTGRES_USER` is one. Skip the auth.* and storage.* blocks.
4. **Personas: skip P's COPY** (or TRUNCATE I's seed first; `persona_dms` cascades). The prompts are identical, but prod `avatar_url` is `/personas/*.png` (SaaS root base) and I has `/ficino/personas/*.png`.
5. Drop orphan user `<orphan-user-id>` and its empty corpus.
6. If using `none`, re-key `<prod-user-id> → 00000000-…-0000` across every `user_id` column, and optionally the "Default" corpus `<prod-default-corpus-id> → 00000000-…-0001` across every `corpus_id`. Do this before the API's first boot, or delete its auto-created stub/Default rows first. The FKs have **no ON UPDATE CASCADE**, so do it under `session_replication_role=replica`; the tested script is `work/rekey-test.sql`. Afterwards the orphan-FK checks returned 0.
   - The user id also appears inside JSON (`audio_key`, stale `figure_url`): 63 occurrences in feeds and 9 in feed_posts. Local storage does not need them rewritten.
   - Strip `figure_url` from JSON if you want no stale Supabase URLs.
7. Optional cosmetic step: `papers.file_path = '/app/uploads/'||id||'.pdf'` and `figures.image_path = '/app/figures/'||paper_id||'/'||basename`.
8. Copy files:
   - `storage/papers/<uid>/<pid>.pdf → $UPLOAD_DIR/<pid>.pdf` (6 files; skip `<orphan-pdf>`)
   - `storage/papers/<uid>/<pid>/figures/*.png → $FIGURES_DIR/<pid>/` (31 files)
   - chown to 10001
   - Verify md5 against `storage-manifest.json`.
9. **Run `backfill_feed_posts.py`** (or its TS equivalent). The prod index had drifted: `feeds.posts` holds **156** posts but `feed_posts` has only **108** rows. Feeds `<feed-c>`, `<feed-d>` and `<feed-e>` are missing entirely (12 each) and `<feed-f>` has 3 of 15. Search under `SEARCH_USE_NORMALIZED_POSTS=true` (the default) misses those 48 posts.
10. Embeddings: keep `EMBED_PROVIDER=voyage`, `VOYAGE_EMBED_MODEL=voyage-4-large`, or re-embed every chunk with the new provider (see above).
11. Audio: either implement local audio storage and copy the 55 MP3s, or NULL out `audio_status`/`podcast_status` on feeds `<feed-a>` and `<feed-b>`.

---

## 3. Tests

### pytest
| suite | files / `def test_` | needs | how |
|---|---|---|---|
| `api/tests` | 30 / 201 | **real Postgres with I loaded + Redis** (CI services, `.github/workflows/ci.yml:23-70`) | `conftest.py`: session-scoped autouse fixture creates the app's asyncpg pool directly (ASGITransport skips lifespan; conftest.py:44-55). `db_conn` is a raw non-transactional asyncpg connection. `seeded_users` inserts users `1111…`/`2222…`, a corpus, a feed and a paper each; teardown is `DELETE FROM users` (cascade) (:73-120). `client_as_user_a/_b` override `get_current_user` via `app.dependency_overrides` (:144+). `_CsrfAutoClient` auto-attaches the double-submit pair `ficino_csrf` cookie + `X-CSRF-Token` (:123-141). Env defaults: `AUTH_PROVIDER=none`, `ENVIRONMENT=test`. `pytest.ini`: asyncio auto, session loop |
| `worker/tests` | 14 / 45 | mostly pure; DB/providers are monkeypatched at the importing module (conftest.py:1-20). `test_media_claim_reclaim.py` uses real `lib.db` (`ci.yml:74-78`) | conftest sets UPLOAD_DIR/FIGURES_DIR to /tmp before imports |
| `shared/tests` | 6 / 31 | none | constants, sanitize, settings_schema, signed_url, storage_local, storage_supabase |

What the api tests pin (from the file docstrings):
- **IDOR/tenant scoping**: `test_auth_scoping` 17, `test_idor_followups` 6, `test_wave3_correctness` 17. Cross-user GETs return 404 and list endpoints are scoped.
- **CRUD contracts**: annotations 10, bookmarks 8, likes 7, tags 12, reading_lists 9, workspaces 12.
- **CSRF** double-submit, including under `none` (`test_csrf` 5).
- **Docs gating**: /docs, /redoc and /openapi.json are served only when `ENVIRONMENT=development`.
- **Error contract shape** (`test_error_contracts` 15).
- **Audit log coverage** of destructive endpoints.
- **Rate limits**: config knobs and audio/podcast dispatch.
- **Signed figure route**, end to end; writes real files under FIGURES_DIR (`test_signed_figures` 7).
- **Feed figure-URL re-sign**, and that hydration runs off the event loop.
- **feed_posts tsvector search** (`test_feed_posts_search` 7).
- Group-chat pending row; summary re-dispatch on `status='error'`.
- **Supabase first-login bootstrap** of a Default corpus.
- `PUBLIC_DEPLOYMENT` drops provider-key settings.
- Settings DEFAULTS contract with the worker; upload size precheck; sanitize/fence_untrusted; LLM retry.

What the worker tests pin:
- generate_feed idempotency under redelivery.
- Stale "generating" claim reclaim, using `*_claimed_at`.
- Chapter post validation, reading-list atomic persist, auto-tagging, stale-paper query.
- Podcast settings, LLM empty-response guard, env hygiene, persona helpers, event-loop helper.

### Playwright e2e (`<repo>/tests/e2e`)
- Specs: r2_sections_{1_3,4_7,8_10,11_13,14_16,17_18}, review, round9_core_flows, wave4_group_chat, aug/augment. About 135 `test(` calls in total. `SKIPS.md` is the skip inventory.
- `playwright.config.ts`: `baseURL = E2E_BASE_URL || 'http://localhost:3000/ficino'` (:15), workers 1, timeout 60s, globalSetup `helpers/globalSetup.ts`. Projects are desktop 1280x800, mobile 390x844, and **`ci`**: desktop, minus `round9_core_flows` and `wave4_group_chat` (`testIgnore`), minus `grepInvert /R2-S16-09/` (:45-49). These need a real LLM or embeddings.
- `globalSetup.ts`: mkdirs `tests/screenshots`, then calls `ensureFeedFixtures()`.
- `ensureFeed.ts` seeds by **direct SQL via `docker exec -i ficino-postgres psql -U ficino -d ficino -v ON_ERROR_STOP=1`** (:222-226) and writes a 1x1 PNG with **`docker exec ficino-api sh -c 'mkdir -p /app/figures/<paper> && base64 -d > …/e2e-fixture.png'`** (:228-231). Overrides: `E2E_PSQL_CONTAINER`, `E2E_PSQL_USER`, `E2E_PSQL_DB`, `E2E_API_CONTAINER`, `E2E_FIGURES_DIR`. Seeded rows, all upserted with `ON CONFLICT (id) DO UPDATE`:
  - papers `e2e00000-…0001` (stub user, corpus `…0001`, status complete).
  - figures `e2e00000-…0002` with **`image_path='e2e-fixture.png'`** (a bare basename).
  - feeds `…0011` (`generated_at=now()`) and `…0012` (now − 1h) with hand-written **`feeds.posts` JSONB**: `{id, persona, post_type: post|thread|figure, content, paper_ref, time, likes…, category, sources[{paper_title,section,content,score}], thread_posts[], figure_id, figure_caption}`.
  - **It assumes the stub user and the Default corpus already exist** (created by API startup). `feed_posts` is not seeded.
- API calls in specs: `GET /ficino/api/feed`, `/papers`, `/workspaces`, `/papers/{id}`, `POST /user-posts`, `GET /user-posts/{id}/status`, `POST /messages/groups`, `GET /messages/groups/{id}`, `DELETE /papers/{id}`. aug/augment stubs `**/ficino/api/feed/generate` and `**/feed/status/**` with `page.route` (augment.spec.ts:428-435).

### CI (`.github/workflows/ci.yml`)
- Jobs: `python-lint` (ruff 0.15.20), `api-tests` (pg16 + redis services, `psql -f init.sql`, pytest), `worker-tests` (pg16, init.sql), `shared-tests`, `frontend` (Node 22: `tsc -b`, lint, vitest, build), and `e2e`.
- The `e2e` job (:142-207):
  1. `cp .env.ci .env; touch .env.secrets`
  2. `docker compose up -d --build --wait`. init.sql auto-loads through initdb.
  3. `docker exec -u root ficino-api chown ficino:ficino /app/uploads /app/figures`
  4. A throwaway `ficino-e2e-fe` from the frontend image on `ficino-network` with `-p 3000:80`
  5. `npx playwright test --project=ci` with `E2E_BASE_URL=http://localhost:3000/ficino/` (trailing slash required)
- `.env.ci` sets `AUTH_PROVIDER=none`, `STORAGE_PROVIDER=local`, `ENVIRONMENT=test`, `OLLAMA_BASE_URL=http://host.docker.internal:9` (deliberately dead).

---

## 4. Dev / deploy

- **docker-compose.yml**:
  - Services: `frontend` (build ./frontend, **no ports**), `api`, `worker`, `postgres` and `redis`.
  - `api` and `worker` build with context `.` from `api|worker/Dockerfile`, use `env_file: .env, .env.secrets`, set `extra_hosts host.docker.internal:host-gateway` and mount volumes `paper_uploads:/app/uploads` and `figure_images:/app/figures`.
  - **The api healthcheck runs `python -c urllib…/health`** (:29).
  - `postgres` is `pgvector/pgvector:pg16`, user/db `ficino`, `POSTGRES_PASSWORD` defaults to `ficino`, and init.sql is bind-mounted into `docker-entrypoint-initdb.d` (:84).
  - `redis:7-alpine` runs with `--requirepass $REDIS_PASSWORD`.
  - The network has the fixed name **`ficino-network`** (:115-117), and the shared proxy joins it.
  - Container names: ficino-frontend, ficino-api, ficino-worker, ficino-postgres and ficino-redis.
- **api/Dockerfile**: python:3.11-slim. pip installs from `requirements.lock`, then `./shared`. User `ficino` uid 10001 with `/app/uploads` and `/app/figures` pre-created. `uvicorn main:app --port ${PORT:-8000}`.
- **worker/Dockerfile**: same base. `celery -A celery_app worker -B --queues=ingestion,persona --concurrency=${CELERY_WORKER_CONCURRENCY:-2}`. There is one embedded-beat job: `check_stale_papers` at crontab 03:00 (`worker/celery_app.py:52-63`).
- **frontend/Dockerfile**: node:20-alpine build (`.npmrc` sets `legacy-peer-deps` for vite-plugin-pwa on vite 8), then nginx:alpine.
  - `frontend/nginx.conf`: `location /ficino/` aliases dist with SPA fallback `/ficino/index.html`; sw.js is served no-cache with `Service-Worker-Allowed: /ficino/`.
  - **`location /ficino/api/ { proxy_pass http://ficino-api:8000/; }`** strips the prefix via the trailing slash, sets `client_max_body_size 50M` and sends the Upgrade headers (:18-28).
  - Vite `base = VITE_BASE_PATH || '/ficino/'` (`vite.config.ts:10`). Dev proxy `/ficino/api → http://ficino-api:8000` with the prefix stripped (:100-104).
  - The frontend calls `${VITE_API_BASE || '/ficino/api'}${path}` (`src/lib/api.ts:3`). It discovers the auth mode via `GET /auth/provider`, then `/auth/me`. **If /auth/provider fails and `VITE_API_BASE` is unset, it silently becomes the stub user** (`src/auth/AuthContext.tsx:194-203`).
- **.env.example** (root): DATABASE_URL, REDIS_URL, LLM/EMBED/VISION_PROVIDER=ollama, OLLAMA_* (qwen3.5, bge-m3, gemma4), `EMBED_DIM=1024`, ANTHROPIC/OPENAI/VOYAGE keys, `AUTH_PROVIDER=none`, `PUBLIC_DEPLOYMENT=false`, `STORAGE_PROVIDER=local`, CORS_ORIGINS, ENVIRONMENT, MAX_UPLOAD_SIZE_MB=50, CELERY_WORKER_CONCURRENCY.
  - `.env.secrets.example`: the three API keys.
  - `frontend/.env.example`: VITE_API_BASE, VITE_SUPABASE_URL/ANON_KEY, VITE_TURNSTILE_SITE_KEY.
  - Other settings are only in `api/config.py`: SUPABASE_JWT_SECRET, ALLOW_REGISTRATION, RATE_LIMIT_*, COOKIE_DOMAIN, UPLOAD_DIR, FIGURES_DIR, ELEVENLABS_API_KEY, SEARCH_USE_NORMALIZED_POSTS, SIGNED_URL_KEY.
- **The old self-host on this server**: `.env` has no `AUTH_PROVIDER`, so it was **`none`**, with `ENVIRONMENT=production` and ollama.
  - Proxy routes are in **`<proxy>/nginx/tailnet-only.conf:32-62`**: `/ficino/api/ → ficino-api:8000` (rewrite strips the prefix, 50M) and `/ficino/ → ficino-frontend:80`. The comment there: tailnet-only since 2026-09-09 because the API served papers unauthenticated to campus.
  - The campus vhost 404s `^~ /ficino` (`nginx.conf:88,103`). `apps.conf:62` says "MOVED". The proxy compose joins `ficino-network` (`<proxy>/docker-compose.yml:27,47-49`).
  - Registry: `<infra>/services.yaml:333-340` (`id: ficino, exposure: tailnet, status: stopped, routes nginx-tailnet /ficino, listen 127.0.0.1:8080 # ficino-e2e-fe; collides with zauthor-web 8080`, `notes: API had no auth`) and `<infra>/INVENTORY.md:31`.
- **Running containers**: none. `docker ps -a` shows them all Exited: ficino-api (137) and ficino-worker (137) 7 weeks ago; ficino-frontend, ficino-postgres and ficino-redis (0) 7 weeks ago; `ficino-e2e-fe` (255, `127.0.0.1:8080->80`) 2 months ago.

---

## Surprises / things a porter would likely get wrong

1. **init.sql is a psql script, not a migration.**
   - It has `\d persona_dms` (I:850), bare `SELECT`s (I:473, I:1167), explicit `BEGIN/COMMIT` blocks, and **`CREATE INDEX CONCURRENTLY`** (I:701-1093). CONCURRENTLY cannot run inside a transaction, and Kysely/postgres.js migrators wrap migrations in one.
   - It is not re-runnable: bare `CREATE TABLE`, plus `ADD CONSTRAINT` without a guard at I:550/I:926.
   - Either keep running it with `psql` (initdb does) or write a clean TS baseline migration.
2. **Duplicate uniques/indexes** in I (chunks, figures, post_replies, persona_dms) are absent in prod. A "clean" baseline should drop them, and should match prod's names (`*_key`, `*_idx`).
3. **There are no CHECK/enum constraints.** Status strings are code-only, and `papers.extraction_path` is a method name. Don't invent a pg enum that rejects restored values.
4. **The PG17 dump fails on pg16** (`transaction_timeout`). Use the pg17 image or strip the line. Load **only public COPY blocks**; auth.* COPY breaks on a stock image.
5. **The restored owner is not the stub user.** With `AUTH_PROVIDER=none`, nothing shows until it is re-keyed. FKs lack ON UPDATE CASCADE, so use replica mode. With `basic`, the users have no password hashes and registration is closed once rows exist.
6. **The startup side effect is load-bearing.** The API must insert the stub user and the `…0001` Default corpus on boot under `none`. The e2e seeding FKs depend on it, and the frontend hard-codes the `…0001` id.
7. **The embedding space differs.** Prod chunks are voyage-4-large while the self-host default is bge-m3. Both are 1024-d, so nothing errors, but retrieval silently returns garbage. `vector(1024)` is fixed in the schema, so `EMBED_DIM` must stay 1024.
8. **The feed_posts search index drifted in prod** (108 of 156 posts). JSONB `feeds.posts` is the source of truth, and the backfill must run after the restore. The e2e fixtures seed `feeds.posts` only.
9. **Local storage ignores user_id** and keys PDFs only by paper_id. The figure route uses only `basename(image_path)`. Don't "fix" the paths to include user_id, or you will break both the restore and the e2e fixture (`image_path='e2e-fixture.png'`).
10. **Local storage has no audio/podcast support.** 55 MP3s would be stranded, and the Python code swallows the error. Decide on a layout before you port `_hydrate_audio_urls`, which also signs by enumerate index rather than post_index (feed.py:186-188).
11. **Personas `avatar_url` embeds the deploy base path** (`/ficino/personas/…` in I, `/personas/…` in prod). If the port moves to its own tailnet node at base `/` (CLAUDE.md says tailnet apps must use the per-app sidecar and that `tailnet-only.conf` is being retired), the seed URLs break.
12. **`migrate_personas_v3.py` ignores DATABASE_URL** and was never applied in prod. The "full prompts" exist only in that script.
13. **Dead columns**: `users.generation_count_today` and `generation_reset_at` have no code references (rate limits live in Redis, `api/auth/rate_limit.py`). `pg_trgm` is enabled but unused.
14. **Redis does more than Celery**: basic-auth sessions (`session:<token>`, 7-day sliding), all rate limits, and Celery results for `/feed/status/{task_id}`. Switching to pg-boss without Redis means replacing all three. The `task_id` TEXT columns will then hold pg-boss job ids.
15. **The compose healthcheck shells out to `python`** (docker-compose.yml:29). A Node image needs a new healthcheck or `compose up --wait` (CI) hangs or fails.
16. **The e2e harness is coupled to container names and tools.** It runs `docker exec ficino-postgres psql` and `docker exec ficino-api sh -c … base64 -d`, and CI runs `docker exec -u root ficino-api chown ficino:ficino`. The TS image needs `sh`, `base64`, a `ficino` user, `/app/figures`, and the same container names (or the `E2E_*` overrides).
17. **The prefix strip happens twice.** Both the shared nginx (`tailnet-only.conf:40`) and the frontend nginx (`nginx.conf:19`) strip `/ficino/api`. The API itself serves at root (`/health`, `/figures/...`), and the local `figure_url` is relative (`/figures/...`) with the frontend prefixing `API_BASE`.
18. **CSRF is enforced even under `none`.** `ficino_csrf` cookie plus `X-CSRF-Token` header (api conftest.py:123-141). Ports often drop this for no-auth mode, which breaks the tests and the e2e DELETE calls that send `csrfHeaders`.
19. **`SIGNED_URL_KEY` is mandatory when `ENVIRONMENT=production`.** Otherwise the key is derived from DATABASE_URL. Figure tokens are HMAC over `figure_id` and are re-minted on every feed GET.
20. **Prod RLS gives false comfort.** It was enabled with no policies, so it did nothing for the service-role app. Tenant isolation is entirely app-side (`JOIN papers p ON p.user_id=$1`). Port every ownership JOIN faithfully; the IDOR tests are the spec.

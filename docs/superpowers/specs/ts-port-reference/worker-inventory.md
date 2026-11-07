# Ficino worker inventory (for the TypeScript / pg-boss port)

Snapshot: `<repo>` @ `dfedb2b` (2026-10-29). Scope: `worker/` (celery_app, tasks/, lib/, tests/, Dockerfile, requirements*) and `shared/ficino_shared/`. All refs are `path:line`. I only read files here; nothing in the repo was modified.

Size: about 11.5k lines total. Tasks are about 3.9k lines, lib about 4.3k, shared about 1k, tests about 1.4k.

---

## 0. Runtime shape at a glance

| Item | Value | Ref |
|---|---|---|
| Image | `python:3.11-slim`, non-root uid 10001, `/app/uploads` + `/app/figures` volumes | `worker/Dockerfile:4,29-30` |
| Entrypoint | `celery -A celery_app worker -B --loglevel=info --queues=ingestion,persona --concurrency=${CELERY_WORKER_CONCURRENCY:-2}` | `worker/Dockerfile:32` |
| Pool | prefork (default). 2 processes, each runs one task at a time. Module globals are per-process. | `celery_app.py:28` |
| Broker / result backend | Redis (`REDIS_URL`, default `redis://redis:6379/0`), used for both | `celery_app.py:8-12` |
| Locked deps | celery 5.6.3, asyncpg 0.31, anthropic 0.120.2, openai 2.52, pymupdf 1.28, pillow 12.3, tiktoken 0.13, httpx 0.28.1, supabase 2.31, structlog 26.1 | `worker/requirements.lock` |
| NOT installed | `marker-pdf`, `sentence-transformers` (missing from requirements.lock). Their code paths are dead in the shipped image. | `requirements.txt:17-22`, `requirements-rerank.txt` |
| Compose | `worker` service depends on postgres + redis, `extra_hosts host.docker.internal` (for Ollama), shares the upload/figure volumes with api | `docker-compose.yml:40-61` |

---

## 1. `worker/celery_app.py`

| Setting | Value | Line |
|---|---|---|
| serializer | json in/out, `accept_content=["json"]` | 15-17 |
| timezone | UTC, `enable_utc=True` | 18-19 |
| `task_track_started` | True. The STARTED state is visible to `AsyncResult`. | 20 |
| `task_acks_late` | True. Ack happens after the task finishes. If the worker process dies, Redis redelivers the message with the **same task id** after the visibility timeout (Celery's Redis default is 1h; it is not overridden here). | 21 |
| `worker_prefetch_multiplier` | 1 | 22 |
| `worker_concurrency` | `CELERY_WORKER_CONCURRENCY` (default `"2"`) | 28 |
| `worker_max_tasks_per_child` | 100. The process recycles, which resets the persona cache, the reranker model and the LoopRunner threads. | 29 |
| `broker_pool_limit` | 10 | 30 |
| `task_soft_time_limit` | `CELERY_SOFT_TIME_LIMIT` = 540s. It raises `SoftTimeLimitExceeded` (an `Exception` subclass), which every task's generic `except Exception` catches, so it goes through the error/retry path. | 36 |
| `task_time_limit` | `CELERY_TIME_LIMIT` = 600s. SIGKILL. With acks_late and `task_reject_on_worker_lost=False` (the default), a time-limit kill is acked and marked failed, **not redelivered**. | 37 |
| routes | `tasks.ingestion_tasks.*` goes to queue **ingestion**. Every other module (persona, summary, alert, preference, archivist, reading_list, audio) goes to **persona**. One worker consumes both queues from one 2-slot pool, so a long ingestion can starve persona work. | 38-47 |
| beat | **Embedded** (`-B`). Only one entry: `check-stale-papers-daily` runs `tasks.alert_tasks.check_stale_papers` at `crontab(hour=3, minute=0)` (03:00 UTC daily), queue `persona`, no args. | 52-62 |
| beat state | `beat_schedule_filename="/tmp/celerybeat-schedule"` (ephemeral). The Dockerfile comment says the workdir; the config wins. | 63 |
| includes | the 8 task modules | 66-68 |
| retries | No global retry policy. Each task sets its own (section 2). | — |

Embedded beat is only correct with a single replica (comment at `celery_app.py:48-51`). pg-boss `schedule()` is cluster-safe, so that constraint goes away.

Celery defaults the code relies on implicitly:
- `default_retry_delay` is **180s** for tasks that set `max_retries` but no delay (archivist ×2, reading_list ×2).
- `self.retry(exc=…)` re-enqueues with the **same task id**. `self.request.retries` counts from 0, and `max_retries=N` means N+1 attempts in total.
- Result expiry is 1 day (`result_expires` default). The api polls `AsyncResult`.

### Who dispatches what (the producer side the port must also change)
All of these use `send_task(name, args|kwargs, queue=…)`:

| Task | Producer | Args sent | Ref |
|---|---|---|---|
| `process_paper` | api upload | `args=[paper_id]` (queue ingestion) | `api/routers/papers.py:169-173` |
| `generate_feed` | api POST /feed/generate | kwargs `corpus_id, tag_filter, user_id` plus optional `append_to_feed_id, tab_focus, persona_key, num_posts` | `api/routers/feed.py:94-122` |
| `generate_feed` | worker `process_paper` (auto_generate_on_upload) | kwargs `corpus_id, user_id` | `ingestion_tasks.py:440-447` |
| `regenerate_post` | api | `args=[feed_id, post_index]`, kwargs `user_id` | `api/routers/feed.py:511-516` |
| `generate_audio_for_feed` / `generate_podcast_for_feed` | api | `args=[feed_id]` | `api/routers/feed.py:363-367, 403-407` |
| `respond_to_user_post` | api | `args=[post_id, corpus_id]`. The api then writes `user_posts.task_id`. | `api/routers/user_posts.py:131-145` |
| `respond_to_user_post_followup` | api | `args=[post_id]`, then sets `task_id` | `api/routers/user_posts.py:195-203` |
| `generate_paper_summary` | api | `args=[paper_id]`, then upserts a `paper_summaries` placeholder `status='generating', task_id=<celery id>` | `api/routers/messages.py:185-197` |
| `generate_corpus_synthesis` | api | `args=[synthesis_id, paper_ids, name, user_id]`, plus a placeholder row | `api/routers/messages.py:294-…` |
| `propose_ordering` | api | `args=[paper_ids, list_id]`, kwargs `user_id` | `api/routers/reading_lists.py:242-247` |
| `generate_chapter` | api | `args=[list_id, chapter_index]`, kwargs `user_id` | `api/routers/reading_lists.py:436-441` |
| `check_contradictions` | worker `process_paper` | `args=[paper_id]` | `ingestion_tasks.py:419-423` |
| `check_post_feed` | worker `generate_feed` | `args=[feed_id]` | `persona_tasks.py:907-911` |
| `compute_preferences` | worker `generate_feed` | kwargs `user_id` | `persona_tasks.py:919-923` |
| `check_stale_papers` | beat | none | `celery_app.py:53-61` |

**Result-backend consumers on the api side (these must be re-implemented on pg-boss state):**
- `GET /feed/status/{task_id}` reads `AsyncResult.state` (`PENDING`, `PROGRESS` with `meta = result.info`, `SUCCESS` with `result.result.feed_id/post_count/duration_ms`, `FAILURE` with `str(result.result)`). Ref `api/routers/feed.py:127-157`. The frontend reads `meta.step` and `meta.post_progress` (`frontend/src/hooks/useFeed.ts:98-99`, `frontend/src/lib/api.ts:132`). **pg-boss has no progress API**, so progress needs its own table or column.
- `GET /messages/papers/{paper_id}` treats a summary as stuck when `AsyncResult(task_id).state ∈ {FAILURE, REVOKED, UNKNOWN}` and re-dispatches. Ref `api/routers/messages.py:147-160`.
- `GET /messages/papers/{paper_id}/status/{task_id}` maps SUCCESS to complete, FAILURE to error, anything else to generating. Ref `api/routers/messages.py:209-228`.
- Task ids are persisted in `user_posts.task_id`, `paper_summaries.task_id`, `corpus_syntheses.task_id` and in audit metadata. The summary task compares `paper_summaries.task_id` with its own `self.request.id`.

---

## 2. Tasks (`worker/tasks/*.py`)

Common pattern: tasks call `apply_provider_settings(owner_user_id)` before any LLM or embedding call (section 3, settings). Tasks bind structlog context. Celery `update_state(state="PROGRESS", meta={...})` calls are listed per task.

### 2.1 `tasks.ingestion_tasks.process_paper` (queue **ingestion**)
`ingestion_tasks.py:63-480`. `bind=True, max_retries=2, default_retry_delay=30`. Args: `(paper_id, _legacy_file_path=None)`. The legacy arg is ignored.

Flow:
1. `SELECT user_id FROM papers WHERE id=$1`. If NULL, use STUB_USER_ID (`:99-100`). Then `apply_provider_settings(owner)` (`:103`).
2. `storage.localize_pdf(owner, paper_id)` returns a path (local: canonical path; supabase: download to a tempfile). The `finally` calls `storage.release_local` (`:109, 473-480`).
3. `papers.status='extracting'` (`:114`). PROGRESS `{"step":"extracting","paper_id"}`.
4. Extraction by `user_settings.extraction_mode` (`:117-145`):
   - `vision`: if `vision_extractor.is_available()`, run vision extraction (`extraction_path="vision_forced"`); otherwise PyMuPDF (path stays `"pymupdf_clean"`).
   - `pymupdf`: PyMuPDF, `"pymupdf_forced"`.
   - `auto` (default): Marker if installed (`"marker_clean"`, never in the shipped image), else PyMuPDF (`"pymupdf_clean"`).
5. PROGRESS `quality_checking`. Only in `auto` mode: `quality_check.check_extraction_quality(md)`. If it fails and vision is available, re-extract with vision (`"vision_fallback"`); otherwise keep the raw text (`:151-161`).
6. PROGRESS `metadata`. `metadata_extractor.extract_metadata_sync(md)` makes one LLM call on the first 2000 chars. Non-null fields go into `UPDATE papers SET title/authors/year/doi` through a dynamically built SET list (`:167-193`).
7. Auto-tags (≤3): `INSERT INTO tags (user_id,name) SELECT $1::uuid, t FROM unnest($2::text[]) ON CONFLICT (user_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id`, then `INSERT INTO paper_tags (paper_id, tag_id) SELECT … unnest($2::uuid[]) ON CONFLICT DO NOTHING`. Failures are logged as error and swallowed (`:201-223`).
8. `status='chunking'`. `chunker.chunk_markdown(md, max_tokens=chunk_max_tokens (800))` (`:226-232`).
9. PROGRESS `contextualizing`. `contextualizer.generate_contexts_for_paper_sync(md, chunks)`. Any exception falls back to all-"" prefixes. Each prefix is attached as `chunk["contextual_prefix"]` (`:241-260`).
10. `status='embedding'`. The embed text is `f"{prefix}\n\n{content}".strip()` when there is a prefix, else the content. Then `embedder.embed_texts_sync(texts)` with input_type `"document"`. A **`RuntimeError`** (no provider, length/dim mismatch) sets `status='error', error_message="No embedding provider available: …"` and **returns without retrying** (`:263-292`). Other exceptions go to the generic retry.
11. `store_chunks_batch(paper_id, chunks, embeddings, owner)` runs in one transaction: `DELETE FROM chunks WHERE paper_id`, then an upsert per chunk (section 4) (`:297`).
12. PROGRESS `extracting_figures`. `pdf_extractor.extract_figures(path)` (VLM per page, section 3). For each figure: `storage.save_figure(owner, paper_id, filename, png_bytes)` returns a ref, then `store_figure(...)` upserts on `(paper_id, figure_index)`. Legacy columns are derived: `description = data_claim or caption`, `claim_summary = first sentence of data_claim (split on ". ")[:400] or caption[:400]`. Per-figure failures are counted by exception type and swallowed (`:308-374`). A summary log follows, plus `figure_extraction_total_failure` when attempted ≥ 3 and stored == 0 (`:379-400`).
13. `status='complete'`, `extraction_path`, `chunk_count=len(chunks)`, `figure_count=figures_stored`, `processed_at=NOW()` (`:406-411`).
14. Fan-out: always `send_task check_contradictions [paper_id]`. If the owner has `auto_generate_on_upload` and the paper has a `corpus_id`, also `send_task generate_feed {corpus_id, user_id}`. Dispatch failures are swallowed (`:418-454`).
15. Returns `{status, paper_id, extraction_path, chunk_count, figure_count: len(figures)}`. Note that the return value uses **len(figures)**, while the DB gets figures_stored.

Failure (`:464-472`): `status='error', error_message=str(exc)`, then `self.retry` if retries remain. A retry re-runs **the whole pipeline**: re-extraction, re-billed LLM/VLM calls, and the chunk DELETE+upsert. Figures are idempotent through ON CONFLICT. During the 30s retry delay the paper briefly shows `error`.

`papers.status` transitions: `pending` (api insert) → `extracting` → `chunking` → `embedding` → `complete` | `error`. There is no distinct status for metadata, contextualizing or figures. Figure extraction runs while status is `embedding`.

Tables: R `papers(user_id, corpus_id)`, `user_settings`. W `papers(status, extraction_path, error_message, chunk_count, figure_count, processed_at, title, authors, year, doi)`, `tags`, `paper_tags`, `chunks`, `figures`. Storage: PDF read, figure PNG write.

### 2.2 `tasks.persona_tasks.generate_feed` (queue persona): "the feed generator"
`persona_tasks.py:234-939`. `bind=True, max_retries=2, default_retry_delay=30`. Kwargs: `corpus_id=None, tag_filter=None, user_id=None, num_posts=12, append_to_feed_id=None, tab_focus=None, persona_key=None`. The full pipeline is in section 6.

Idempotency guards:
- Append mode: load `feeds.posts WHERE id AND user_id`. If any existing post has `_task_id == self.request.id`, return `{feed_id, post_count, duration_ms:0, idempotent:True}` (`:266-292`).
- Fresh mode: `feed_id = uuid5(NAMESPACE_DNS, f"ficino:feed:{task_id}")` (`:299`). If a row exists with `post_count > 0`, skip the same way (`:303-316`). A row with `post_count = 0` is regenerated.
- Fresh INSERT uses `ON CONFLICT (id) DO UPDATE` and replaces the content. The empty-feed INSERT uses `ON CONFLICT DO NOTHING`.
- Append UPDATE: `posts = posts || $1::jsonb, post_count = jsonb_array_length(posts || $1::jsonb), generation_duration_ms = generation_duration_ms + $2 WHERE id AND user_id`. Postgres does the concat, so concurrent appends don't clobber each other.

PROGRESS steps: `scoping`, `retrieving`, `classifying`, `generating`, then per slot `{"step":"generating","feed_id","post_progress":f"{i+1}/{num_posts}"}`.

Writes: `feeds(id, user_id, corpus_id, tag_filter, posts, paper_count, post_count, generation_duration_ms)` and `feed_posts` (secondary index, upsert on `(feed_id, post_index)`; failure is non-fatal, `:52-101, 888-897`). Fan-out: `check_post_feed [feed_id]`, `compute_preferences {user_id}` (`:905-925`). Returns `{status, feed_id, post_count: len(all_posts), paper_count, duration_ms}`. That return value is **read by the api status endpoint**.

Failure: any exception raised outside the per-slot try triggers a retry (`:935-939`). Per-slot LLM, parse or validation failures are logged and the slot is skipped (`:832-834`).

### 2.3 `tasks.persona_tasks.regenerate_post` (persona)
`persona_tasks.py:942-1070`. `bind=True`, **no retries**. Args `(feed_id, post_index, user_id=None)`.
- `apply_provider_settings(owner)`, load `feeds.posts, corpus_id WHERE id AND user_id` (`:966-975`). A missing feed, an out-of-range index, or a post without `persona` raises `ValueError`.
- `_get_paper_ids_for_corpus(corpus_id, None, user)`, then `retrieve_for_persona(persona, paper_ids, top_k=10)`. There is no liked boost, no exclusion and no precomputed embedding (`:1001-1008`).
- `build_post_prompt(persona, post_type if in (post,thread,figure) else "post", chunks)`. Quote/reply posts are regenerated as `post`. **A `figure` post passes `figure=None`, so `build_post_prompt` raises ValueError: regenerating a figure post always fails** (`persona.py:637-640`).
- Temperature is the persona's DB temperature, else the user's `persona_temperature`. Keeps the old `id` and `time`. `paper_ref = _build_short_cite(chunks[0])`, `sources`, `category`, engagement numbers, `validate_post_shape`, `regenerated=True`. It does **not** set `_task_id`.
- Write: `UPDATE feeds SET posts = jsonb_set(posts, ARRAY[$1::text], $2::jsonb, false) WHERE id AND user_id`, then upsert the `feed_posts` row at `post_index` (non-fatal).

### 2.4 `tasks.alert_tasks.*` (persona)
`_create_alert` (`alert_tasks.py:34-65`): `INSERT INTO alerts (user_id, alert_type, title, body, metadata, dedupe_hash) … ON CONFLICT (user_id, alert_type, dedupe_hash) WHERE dedupe_hash IS NOT NULL DO NOTHING`. `dedupe_hash = sha256("|".join(sorted(parts)))[:32]` (`:24-31`). Every caller passes a hash.

| Task | Decorator | Args | Behavior | Ref |
|---|---|---|---|---|
| `check_contradictions` | `bind, max_retries=1`, but it never calls `self.retry`, so the setting is **inert** | `(paper_id)` | Load the paper (`id, title, filename, corpus_id, user_id`) and apply the owner's settings. Pick up to 8 other `complete` papers in the same corpus `ORDER BY random()`. Take ≤8 chunks of the new paper (section NOT IN references/bibliography/acknowledgments/funding, ORDER BY chunk_index) and batch-fetch the others' chunks (capped at 8 per paper in Python). Build 3 random pairs per other paper. `classify_contradictions_batch_sync(pairs, concurrency=5)`. At most one `contradiction` alert per other paper, with metadata `{new_paper_id, other_paper_id, titles, chunk_a/b_preview[:200]}` and hash `("contradiction", paper_id, other_id)`. Returns early with `skipped` on not-found, no other papers, or no chunks. **Note:** other papers are not filtered by user_id, only by `corpus_id`. | `:68-203` |
| `check_post_feed` | `bind, max_retries=1` (inert) | `(feed_id)` | Load `feeds.user_id, posts`, apply the owner's settings (no LLM is used). If `(quote+reply)/total > 0.5`, create a `disagreement_spike` alert, hash `(…, feed_id)`. Reading gaps: for each of the owner's `complete` papers with no `paper_summaries` row, if `title in ref` (substring) for any post's `paper_ref`, create a `reading_gap` alert, hash `(…, paper_id)`. | `:206-279` |
| `check_stale_papers` | `bind, max_retries=1` (inert). **Beat 03:00 UTC.** | none | Cross-tenant scan: `complete` papers uploaded more than 7 days ago with `NOT EXISTS feeds f WHERE f.user_id=p.user_id AND (f.corpus_id=p.corpus_id OR f.corpus_id IS NULL)`. One `stale_paper` alert per paper for the paper's owner, hash `(…, paper_id)`. Does not apply provider settings. | `:282-325` |

### 2.5 `tasks.preference_tasks.compute_preferences` (persona)
`preference_tasks.py:30-122` (decorator at `:30`). Not bound, no retries. Kwarg `user_id=None`, defaulting to STUB.
- `SELECT feed_id, post_index, persona_key, post_type, category, liked_at FROM user_likes WHERE user_id`.
- With fewer than `MIN_LIKES_THRESHOLD=5` likes, store empty weights with `has_signal:false`.
- Otherwise read annotated `(feed_id, post_index)` pairs from `annotations WHERE user_id`. Each like weighs 1.0, or `ANNOTATION_BOOST=2.0` when annotated. Sum per persona_key, post_type and category, then `_normalize` (`round(v/total, 4)`).
- `liked_paper_titles` come from one SQL query: `f.posts->ul.post_index` joined with `jsonb_array_elements(post->'sources')` gives `post->>'paper_ref'` and `src->>'paper_title'` as a set (`:133-164`).
- Store: `INSERT … user_settings (user_id, settings=jsonb_build_object('preferences',$2), updated_at) ON CONFLICT (user_id) DO UPDATE SET settings = jsonb_set(COALESCE(settings,'{}'), '{preferences}', $2, true), updated_at=NOW()` (`:167-193`).
- `PREFERENCE_BLEND=0.4` (`:27`) is imported by `persona.plan_feed_posts`.
- Output shape: `{persona_weights, post_type_weights, category_weights, liked_paper_titles, total_likes, has_signal}`. `category_weights` is computed but no generator reads it.

### 2.6 `tasks.archivist_tasks.*` (persona)
| Task | Decorator | Args | Ref |
|---|---|---|---|
| `respond_to_user_post` | `bind, max_retries=2`, **default 180s delay** | `(user_post_id, corpus_id=None)` | `archivist_tasks.py:157-274` |
| `respond_to_user_post_followup` | `bind, max_retries=2`, 180s | `(user_post_id)` | `:302-422` |

- Initial: load `user_posts.content, corpus_id, user_id`. The row's corpus_id wins over the arg. Apply the owner's settings; `temperature = persona_temperature`. `_get_paper_ids(user, corpus)` runs `array_agg(id::text)` over the owner's `complete` papers (`:31-52`). With no papers, store a canned "Your corpus is empty…" reply. Otherwise `retrieve_chunks(query=user_content, paper_ids, top_k=15)`, build `chunks_text` (`[title — section]\n<fenced content>` joined by `\n\n`, or "No relevant passages found in the corpus."). `system = (_get_archivist_system_prompt()).format(chunks=chunks_text)` (DB `personas.archivist.system_prompt` or the fallback, plus a suffix). `generate_text_sync(system, user_content, temperature, max_tokens=1024)`. `_validate_citations` removes `Author[ et al.] (YYYY)` matches whose `(lastname_lower, year)` is not among the retrieved chunks' first authors (`:26-28, 55-100`). `_store_reply`: `UPDATE user_posts SET replies=[reply], sources=build_post_sources(chunks), status='complete'` (`:277-284`).
- Follow-up: load `content, replies, corpus_id, user_id`. It requires `replies[-1].role == "user"` (the api appended it). Retrieval uses the latest user message. The user prompt is a transcript (`USER: original`, prior turns as `USER:` or `ARCHIVIST:`, then the latest `USER:`) plus an instruction. `_append_reply`: `replies = replies || [reply]::jsonb, status='complete'` (`:287-299`). Sources are not touched.
- Failure on either task: `UPDATE user_posts SET status='error'`, then retry. A successful retry flips it back to `complete`.
- `user_posts.status`: `pending` (api) → `complete` | `error`.
- Reply object: `{role:"archivist", persona:"archivist", content}`.

### 2.7 `tasks.audio_tasks.*` (persona)
| Task | Decorator | Args | Ref |
|---|---|---|---|
| `generate_audio_for_feed` | `bind, max_retries=0` | `(feed_id)` | `audio_tasks.py:190-349` |
| `generate_podcast_for_feed` | `bind, max_retries=0` | `(feed_id)` | `:352-498` |

- Claim (an atomic `UPDATE … RETURNING`, the only idempotency guard): `SET audio_status='generating', audio_claimed_at=NOW() WHERE id=$1 AND (audio_status IS NULL OR ='failed' OR (='generating' AND (audio_claimed_at IS NULL OR audio_claimed_at < NOW() - make_interval(mins => $2)))) RETURNING user_id, posts`. `$2 = _reclaim_minutes() = max(15, CELERY_TIME_LIMIT*2//60)`, which is 20 by default (`:57-71, 208-219`). Not claimed returns `{status:"skipped"}`. `ready` is never re-claimed. The podcast claim is identical on `podcast_status/podcast_claimed_at` and returns `user_id, corpus_id, posts` (`:378-389`).
- Feed audio: **does not call apply_provider_settings**. TTS uses the env `ELEVENLABS_API_KEY` only. For each post: `_post_to_speech_text` builds `"{display_name} says: " + content + thread_posts joined by \n\n`, capped at 4000 chars with an `rsplit(" ",1)[0] + "…"` cut. Deleted or empty posts are skipped (`:74-105`). `voice_id_for(persona)`. `_synthesize_with_fallback` (`:108-187`): on **any** `HTTPStatusError` it records the error and retries once with the default voice (Rachel). `TTSUnavailable` propagates. Other exceptions record and skip. `storage.save_audio(user, feed, idx, mp3)` (local backend raises `NotImplementedError`, which propagates). Then `jsonb_set(posts, '{idx,audio_key}', key, true)` and `posts #- '{idx,audio_error}'`. Per-post errors go into `posts[idx].audio_error = "stage: detail[:300]"` (`:229-243`). End state: `audio_status='ready', audio_generated_at=NOW()`. Any exception sets `audio_status='failed'` and re-raises.
- Podcast: `apply_provider_settings(owner)`. `build_podcast_script(...)` (lib/podcast). Write `feeds.podcast_segments = [{index, speaker, text, voice_id}]` **before** synthesis. `synthesize_dialogue(inputs)` makes one Eleven v3 call. `storage.save_podcast_episode`. Then `podcast_status='ready', podcast_generated_at=NOW()`. On exception, `'failed'` and re-raise.
- Status columns: `feeds.audio_status` and `feeds.podcast_status` move NULL/failed/stale-generating → `generating` → `ready` | `failed`. The api returns early if the status is already generating or ready (`api/routers/feed.py:~350, 393-395`).

### 2.8 `tasks.reading_list_tasks.*` (persona)
| Task | Decorator | Args | Ref |
|---|---|---|---|
| `propose_ordering` | `bind, max_retries=2`, 180s default | `(paper_ids, list_id=None, user_id=None)` | `reading_list_tasks.py:49-218` |
| `generate_chapter` | `bind, max_retries=2`, 180s | `(reading_list_id, chapter_index, user_id=None)` | `:221-444` |

- `propose_ordering`: apply settings. One LATERAL query gives `p.id, title, authors, year, filename` plus the first 5 chunk contents per paper (`:81-96`). Build context: preview = join of `c[:200]`, then `[:500]`. Fence the title, authors and preview. `ORDERING_SYSTEM.format(papers=…)`. `generate_text_sync(temp=0.3, max_tokens=2048)`. `_parse_ordering_json` accepts a bare array, a fenced block, `{ordering|papers|result|data:[…]}`, or the greedy `\[.*\]` (`:447-490`). If the set of returned ids is not exactly the input set, fall back to **input order with empty rationale** (positions 0-based). Otherwise sort by `position`. If `list_id` is set, run one transaction: `UPDATE reading_lists SET paper_sequence=$1::uuid[], rationale=$2::jsonb`, then `DELETE FROM reading_list_chapters WHERE reading_list_id`, then `CHAPTER_INSERT_SQL(list_id, seq)` (`:193-209`). The first chapter is `unlocked`, the rest `locked`, one paper per chapter (`shared/ficino_shared/constants.py:32-38`).
- `generate_chapter`: load `reading_lists.paper_sequence, corpus_id, user_id`. `effective_user_id = user_id or str(rl.user_id) or STUB`. Load the chapter (`id, paper_ids, status, feed_id`). **Idempotency:** if `chapter.feed_id` is set and that feed has `post_count > 0`, skip (`:262-278`). The cumulative scope is `paper_sequence[:index_of(last chapter paper)+1]`. `feed_id = uuid5(NAMESPACE_DNS, f"ficino:chapter:{list_id}:{chapter_index}")` (`:300-302`). Settings give `num_posts=posts_per_generation`, enabled personas, temperature, weights, preferences. Retrieval is per persona `top_k=10` with no precomputed embeddings, no liked boost and no exclusion. `plan_feed_posts`. For each slot: the system prompt gets a chapter-context sentence appended (`:340-343`). The prompt uses `post_type if in (post,thread,figure) else "post"`, so quote/reply slots become plain posts and `reference_posts` is effectively unused. **The `build_post_prompt` call (`:349-354`) sits outside the per-slot try. A planned `figure` slot raises ValueError there and fails the whole task, which then retries. With the default weights about 60% of 12-post chapters hit this.** The temperature is the user's, without the persona override. `id=i+1` and `time=f"{(i+1)*2}m"` use the **loop index**, so ids have gaps when a slot fails. No `_task_id`. Upsert `feeds (id, user_id, corpus_id, posts, paper_count, post_count, generation_duration_ms=0) ON CONFLICT DO UPDATE posts, paper_count, post_count, generated_at=NOW()`, then the feed_posts index (non-fatal), then `UPDATE reading_list_chapters SET feed_id, status='complete' WHERE id`, then `SET status='unlocked' WHERE list AND chapter_index=i+1 AND status='locked'` (`:396-435`).
- `reading_list_chapters.status`: `locked` → `unlocked` (previous chapter finished) → `complete`.

### 2.9 `tasks.summary_tasks.*` (persona)
| Task | Decorator | Args | Ref |
|---|---|---|---|
| `generate_paper_summary` | `bind, max_retries=2, default_retry_delay=30` | `(paper_id)` | `summary_tasks.py:110-242` |
| `generate_corpus_synthesis` | same | `(synthesis_id, paper_ids, name, user_id)` | `:245-399` |

- Summary guard: read `paper_summaries.id, status, task_id WHERE paper_id`. `complete` returns `{status:"exists"}`. `generating` with a `task_id` other than its own `self.request.id` returns `already_generating`. `error`, NULL, or its own id continue (`:130-145`). Load the paper (`title, filename, authors, user_id`), apply the owner's settings, take the first 30 chunks by chunk_index (none raises ValueError). `chunks_text = "[SECTION]\n<fenced>"` joined by `\n\n`, truncated to **[:8000] after fencing**. `PAPER_SUMMARY_PROMPT.format(title=fenced, chunks=…)`. `generate_text_sync(SYSTEM, prompt, max_tokens=1536)` at the default temperature of 0.7. Strip `<think>`, take the greedy `\[.*\]`, `_coerce_messages` (dicts with a non-empty str `content`). On a JSON error or an empty result, fall back to `[{"role":"paper","type":"summary","content":cleaned}]`. Upsert `paper_summaries (paper_id, messages, status='complete', task_id=NULL)`, `ON CONFLICT (paper_id) DO UPDATE … generated_at=NOW()`. On final failure, `status='error', task_id=NULL`.
- Synthesis guard: if `corpus_syntheses.messages` is non-empty, skip (`:264-279`). Apply settings. One LATERAL query takes the first 10 chunk sections and contents per paper. Each paper becomes `=== <fenced title> ===\n[section]\n<fenced content[:300]>`. `combined[:10000]`. `generate_text_sync(SYNTHESIS_SYSTEM, prompt)` with temp 0.7 and max_tokens 1024. Same parsing, with fallback role `synthesis`. Upsert `corpus_syntheses (id, user_id, name, paper_ids, messages, 'complete', NULL) ON CONFLICT (id) DO UPDATE messages, status, task_id, generated_at`. On final failure, `status='error'`.
- `paper_summaries.status` and `corpus_syntheses.status`: `generating` (api placeholder) → `complete` | `error`.

---

## 3. `worker/lib/*.py` and shared modules

### 3.1 Module table
| Module | Purpose | Public API (signatures) | External deps | TS equivalent |
|---|---|---|---|---|
| `lib/db.py` | asyncpg pool plus sync wrappers | `execute(q,*a)->str`, `executemany(q, rows)`, `fetchrow(q,*a)`, `fetch(q,*a)`, `execute_in_transaction([(q,args),…])`, `store_chunks_batch(paper_id, chunks, embeddings, user_id)->int`, `store_figure(paper_id, page_number, image_path, extraction_type, description, claim_summary, figure_index, *, figure_type, caption, figure_number, data_claim, referenced_paragraph, bbox, detector_confidence)` | asyncpg, Postgres+pgvector | `pg` or `postgres` (porsager). There is no `executemany`; use an `unnest` bulk insert or a loop inside a tx. |
| `lib/event_loop.py` | LoopRunner (section 4) | `LoopRunner(name).run(coro)` | stdlib | **Disappears** |
| `lib/settings.py` | per-user provider config | `get_active(setting_key, env_key, default="")`, `ollama_base_url()`, `get_user_settings(user_id=None)`, `apply_provider_settings(user_id=None)->dict`; re-exports `STUB_USER_ID`, `DEFAULTS` | DB | rewrite as a per-job config object |
| `lib/claude_client.py` | LLM routing (Ollama or Anthropic), JSON salvage, contradiction classifier | async `_generate(sys, user, temperature=0.8, max_tokens=1024)->str`, `generate_persona_post(...)`, `classify_contradiction(a,b)`; sync `generate_persona_post_sync(sys,user,temperature=0.8)`, `generate_text_sync(sys,user,temperature=0.7,max_tokens=1024)`, `classify_contradiction_sync(a,b)`, `classify_contradictions_batch_sync(pairs, concurrency=5)`; helpers `_parse_post_json(text)`, `_find_balanced_json_object(text)` | httpx (Ollama `/api/chat`), anthropic `AsyncAnthropic.messages.create` | `@anthropic-ai/sdk`; Ollama via `fetch` |
| `lib/embedder.py` | embeddings | async `embed_texts(texts, *, input_type="document")`, `embed_single(text, *, input_type="document")`; sync `embed_texts_sync(texts, *, input_type="document")`, `embed_single_sync(text, *, input_type="query")` (note the different default) | httpx (Ollama `/api/embeddings`, Voyage `/v1/embeddings`), `openai.AsyncOpenAI.embeddings.create` | `fetch`, `openai` npm |
| `lib/chunker.py` | section-aware markdown chunking | `chunk_markdown(markdown, max_tokens=800) -> [{section, content, chunk_index, token_count}]` | `tiktoken.encoding_for_model("gpt-3.5-turbo")` (= cl100k_base) | `js-tiktoken` or `tiktoken` (WASM), with identical counts |
| `lib/contextualizer.py` | contextual-retrieval prefixes | `generate_contexts_for_paper(paper_text, chunks)->list[str]`, `_sync` | httpx (Ollama), anthropic with `cache_control: ephemeral` | `@anthropic-ai/sdk` (supports cache_control) |
| `lib/metadata_extractor.py` | title/authors/year/doi/tags via LLM | `extract_metadata(text)`, `extract_metadata_sync(text) -> {title, authors[], year, doi, tags[≤3]}` | claude_client._generate | trivial |
| `lib/quality_check.py` | gibberish heuristics | `check_extraction_quality(text)->(bool, reason)` | stdlib re (Unicode `\w`) | trivial, watch the regex semantics |
| `lib/pdf_extractor.py` | PyMuPDF text, figure orchestration, rasterize | `get_page_count(path)`, `extract_pages_text(path)->list[str]` (`page.get_text()`), `extract_text_pymupdf(path)->markdown` (`page.get_text("dict")` spans: `text, size, flags, font`; block `type`), `extract_figures(path)->list[dict]`, `rasterize_pages(path, page_nums, dpi=300)->Iterator[png bytes]` (`page.get_pixmap(matrix=Matrix(dpi/72))`, `tobytes("png")`) | **PyMuPDF** (text dict/plain, page render), **Pillow** (crop + PNG encode) | `mupdf` npm (official MuPDF.js WASM): `StructuredText.asJSON()` for spans/fonts, `Page.toPixmap(Matrix.scale)`, `Pixmap.asPNG()`. Crop with `sharp` `.extract()`, or `mupdf` pixmap sub-rect. **No bbox from PyMuPDF is used**: bboxes come from the VLM. |
| `lib/figure_detector.py` | per-page VLM figure detection | async `detect_figures_on_page(png, page_number, page_text)`, `detect_figures_for_paper(page_images, page_texts)->list[list[dict]]` (sem 4), `detect_figures_for_paper_sync`, `is_available()`; constant `FIGURE_TYPES` | anthropic (image block), httpx Ollama (`images:[b64]`) | `@anthropic-ai/sdk`, `fetch` |
| `lib/vision_extractor.py` | page-image to markdown fallback | `is_available()`, async `extract_page(png, page_num)`, `extract_with_vision(path)`, `extract_with_vision_sync(path)` | anthropic (`max_retries=0` plus its own 3×), httpx Ollama, pdf_extractor.rasterize_pages(dpi=200) | same |
| `lib/marker_extractor.py` | Marker PDF to markdown | `is_available()`, `extract_with_marker(path)` | `marker-pdf` (torch). **Not installed, so always unavailable.** | **Python-only.** Gated by an import try/except (`:16-22`). Drop it, or stub as unavailable. |
| `lib/retrieval.py` | hybrid pgvector + tsvector retrieval | `retrieve_chunks(query, paper_ids=None, top_k=20, query_embedding=None, exclude_chunk_ids=None)`, `retrieve_for_persona(persona_key, paper_ids=None, top_k=10, liked_paper_titles=None, query_embedding=None, exclude_chunk_ids=None)`, `_get_retrieval_queries()`; consts `LIKED_PAPER_BOOST=1.25` | DB, embedder, reranker | trivial (SQL copied verbatim) |
| `lib/reranker.py` | cross-encoder rerank | `rerank(query, chunks, top_k=None)` | local `sentence_transformers.CrossEncoder` (**not installed**), Voyage `/v1/rerank`, Cohere `/v2/rerank` (httpx sync) | Voyage/Cohere via `fetch`. Local: **Python-only in practice.** `@huggingface/transformers` with an ONNX bge-reranker-v2-m3 is possible but scores will differ. Gated by `RERANK_PROVIDER` (default `none`); an ImportError is caught and passed through (`:146-184`). |
| `lib/persona.py` | persona cache, prompt building, plan | section 6 | DB | trivial |
| `lib/post_validation.py` | soft post-shape validation | `validate_post_shape(post_data, *, persona_key)->dict`; `VALID_POST_TYPES`, `MAX_CONTENT_CHARS=2000` | none | trivial |
| `lib/podcast.py` | two-host script builder | `build_podcast_script(feed_id, posts, corpus_id, user_id)->[{speaker,text}]` | claude_client, retrieval, DB | trivial |
| `lib/tts.py` | ElevenLabs | `voice_id_for(key)`, `synthesize(text, voice_id, *, timeout=30.0)->bytes` (POST `/v1/text-to-speech/{voice}`), `synthesize_dialogue(inputs, *, model_id=None, stability=0.5, timeout=180.0)->bytes` (POST `/v1/text-to-dialogue`); `VOICE_MAP`, `_DEFAULT_VOICE`, `TTSUnavailable`, `DialogueTooLong` | httpx sync | `fetch` (or `@elevenlabs/elevenlabs-js`, but raw keeps parity) |
| `lib/storage.py` | shim building the backend from env | `storage: StorageBackend` | shared | — |
| `lib/sanitize.py`, `lib/signed_url.py` | shims to shared | — | — | — |
| `shared/.../sanitize.py` | prompt-injection fencing | `strip_role_markers(text)`, `fence_untrusted(text, *, max_len=8000)`, `sanitize_inline(text, *, max_len=200)` | re | trivial (watch the regex flags, section 9) |
| `shared/.../signed_url.py` | HMAC tokens | `sign_resource(resource_id, ttl=600)->"{expires}.{b64url-nopad(hmac_sha256(key, f'{id}:{exp}'))}"`, `verify_token`. Key = `SIGNED_URL_KEY`; `ENVIRONMENT=production` without a key raises **at import**; the dev fallback is `sha256(DATABASE_URL+"::ficino-figure-salt").hexdigest()` (the hex string is the key) | hmac | `node:crypto`. The api verifies these tokens, so they must be byte-compatible. |
| `shared/.../storage/` | `build_backend(provider, *, upload_dir, figures_dir, supabase_url, supabase_service_role_key, supabase_bucket)`. **Local:** `{upload}/{paper}.pdf`, `{figures}/{paper}/{file}`, figure URL `/figures/{paper}/{figure_id}?token=…`, audio/podcast raise NotImplementedError. **Supabase:** keys `{user}/{paper}.pdf`, `{user}/{paper}/figures/{file}`, `{user}/feeds/{feed}/audio/post_{i}.mp3`, `{user}/feeds/{feed}/podcast/episode.mp3`; upload with `upsert:"true"`; signed URL from `create_signed_url(path, expires_in)` reading `signedURL` or `signedUrl`. Filenames must be bare basenames, not starting with `.` | `supabase` py | `@supabase/supabase-js` storage API |
| `shared/.../constants.py` | `STUB_USER_ID=000…000`, `DEFAULT_WORKSPACE_ID=000…001`, `DEFAULT_DATABASE_URL`, `SIGNED_URL_DEFAULT_TTL=600`, `MEDIA_URL_TTL=86400`, `CHAPTER_INSERT_SQL` | — | copy |

### 3.2 Provider routing values (they are *not* uniform)
| Knob | Values that do something | Ref |
|---|---|---|
| `llm_provider` | `"ollama"`, or `"api"` (Anthropic, **requires a key**); anything else raises RuntimeError | `claude_client.py:118-128` |
| `embed_provider` | `"ollama"`, `"openai"`, `"voyage"` (the latter two require a key); otherwise RuntimeError | `embedder.py:193-209` |
| `vision_provider` | `"api"` (Anthropic) or `"ollama"`. The env fallback default is `llm_provider`. | `vision_extractor.py:33-55, 171-179` |
| `figure_detect_provider` | `"anthropic"` (note: not `"api"`), `"ollama"`, `"none"`. Default `anthropic`; with no key, `is_available()` is false and no figures are extracted. | `figure_detector.py:55-67, 298-317, 363-369` |
| `context_provider` | `"none"` (default), `"ollama"`, `"anthropic"` | `contextualizer.py:192-214` |
| `rerank_provider` | `"none"` (default), `"local"`, `"voyage"`, `"cohere"` | `reranker.py:146-184` |

### 3.3 Retry, timeout and concurrency details per provider call
| Call | Timeout | Retries | Concurrency | Notes |
|---|---|---|---|---|
| Ollama chat (`_generate_ollama`) | 300s | 3 attempts, sleeping 2s then 6s, on ConnectError, ReadTimeout or 5xx. A 4xx raises immediately. | — | payload `stream:false, think:false, options{temperature, num_predict:max_tokens}`. Empty `content` falls back to `msg.thinking`; empty or whitespace raises RuntimeError (`claude_client.py:37-98`). |
| Anthropic text (`_generate_claude`) | SDK default (600s) | SDK default 2 | — | returns `content[0].text` only (`:101-115`) |
| Ollama embeddings | 120s, one shared client | 3× (2s, 6s) per text | **sem 8**, one POST per text, `{"model", "prompt"}` | an empty embedding raises (`embedder.py:38-97`) |
| OpenAI embeddings | SDK default | SDK default | batches of 100 with a 1.0s sleep between | `:100-117` |
| Voyage embeddings | 120s | up to 5 tries, **only on 429**, waiting 20·(attempt+1)s; other statuses raise | batches of 128 with a 0.5s sleep | sends `output_dimension=EMBED_DIM` and `input_type`; sorts by `index`; a count mismatch raises (`:120-177`) |
| Embedding post-checks | — | — | — | length == len(texts) and each dim == `EMBED_DIM`, else RuntimeError (`:215-226`) |
| Contextualizer Ollama | 300s | none (per-chunk failure gives "") | **serial** | temp 0.2, num_predict 150 (`contextualizer.py:76-112`) |
| Contextualizer Anthropic | SDK default | SDK default | **sem 8** | system = [plain block, paper block with `cache_control:{type:"ephemeral"}`], temp 0.2, max_tokens 150; concatenates text blocks; per-chunk failure gives "" (`:115-171`) |
| Figure detect Anthropic | SDK default | SDK default | **sem 4** across pages | temp 0, max_tokens 2048, content `[image(base64 png), text]` (`figure_detector.py:234-258`) |
| Figure detect Ollama | 300s | none | sem 4 | temp 0, `images:[b64]` on the user message (`:261-286`) |
| Figure detect, any error | — | page result is `[]`, never raises | — | `:304-317` |
| Vision Anthropic | SDK default, **`max_retries=0`** | 3× (2s, 6s) on APIConnectionError, RateLimitError, InternalServerError | **serial pages** | max_tokens 2048, system prompt plus text `"Extract all text from page {n} as structured markdown."` (`vision_extractor.py:58-108`) |
| Vision Ollama | 300s | 3× (2s, 6s) on Connect, ReadTimeout or 5xx | serial | no `think:false`, no options; empty content raises RuntimeError (`:111-168`) |
| Vision page cap | — | — | — | `MAX_VISION_PAGES` (100), rasterized at **200 dpi** (`:182-219`) |
| Voyage/Cohere rerank | 30s sync | none; any error passes through the input order | — | Voyage `top_k=len(docs)`, Cohere `top_n=len(docs)`; results map by `index` onto `rerank_score` |
| ElevenLabs TTS | 30s | none (task-level default-voice fallback) | serial posts | `model_id=ELEVENLABS_MODEL_ID (eleven_turbo_v2_5)`, `voice_settings{stability:0.5, similarity_boost:0.75}`, header `xi-api-key`, `accept: audio/mpeg` (`tts.py:73-104`) |
| ElevenLabs dialogue | 180s | none | single call | `{inputs:[{text,voice_id}], model_id: ELEVENLABS_DIALOGUE_MODEL_ID (eleven_v3), settings:{stability:0.5}}`; total chars over 2000 raises DialogueTooLong (`tts.py:111-156`) |
| Contradiction batch | — | per-pair errors become `"error"` | **sem 5** | `claude_client.py:336-366` |

### 3.4 Config / env vars
**User-overridable settings** (`shared/ficino_shared/settings_schema.py:20-86`). DEFAULTS read the env **once, at import**:

| Setting key | Env | Default |
|---|---|---|
| llm_provider | LLM_PROVIDER | `ollama` |
| embed_provider | EMBED_PROVIDER | `ollama` |
| vision_provider | VISION_PROVIDER | `ollama` |
| claude_model | CLAUDE_MODEL | `claude-sonnet-4-6` |
| ollama_llm_model | OLLAMA_LLM_MODEL | `qwen3.5:latest` |
| ollama_embed_model | OLLAMA_EMBED_MODEL | `bge-m3:latest` |
| ollama_vision_model | OLLAMA_VISION_MODEL | `gemma4:latest` |
| voyage_embed_model | VOYAGE_EMBED_MODEL | `voyage-4-large` |
| anthropic/openai/voyage/cohere_api_key | ANTHROPIC/OPENAI/VOYAGE/COHERE_API_KEY | `""` |
| rerank_provider | RERANK_PROVIDER | `none` |
| rerank_local_model / rerank_voyage_model / rerank_cohere_model | RERANK_LOCAL_MODEL / RERANK_VOYAGE_MODEL / RERANK_COHERE_MODEL | `BAAI/bge-reranker-v2-m3` / `rerank-2-lite` / `rerank-v3.5` |
| context_provider | CONTEXT_PROVIDER | `none` |
| context_anthropic_model / context_ollama_model | CONTEXT_ANTHROPIC_MODEL / CONTEXT_OLLAMA_MODEL | `claude-haiku-4-5` / `qwen3.5:latest` |
| figure_detect_provider | FIGURE_DETECT_PROVIDER | `anthropic` |
| figure_detect_ollama_model / figure_detect_anthropic_model | FIGURE_DETECT_OLLAMA_MODEL / FIGURE_DETECT_ANTHROPIC_MODEL | `qwen2.5vl:latest` / `claude-sonnet-4-6` |
| openai_embed_model | OPENAI_EMBED_MODEL | `text-embedding-3-small` |
| personas_enabled | — | `{skeptic, hype, practitioner, methodologist, gradstudent: true}`. Opt-out, so `amplifier` is on by default. |
| persona_temperature | — | 0.8 (api bounds 0.0–1.5) |
| posts_per_generation | — | 12 (api bounds 1–50) |
| post_type_weights | — | `{post .35, thread .10, quote .20, reply .25, figure .10}` |
| auto_generate_on_upload | — | False |
| extraction_mode | — | `auto` (`auto` / `pymupdf` / `vision`) |
| chunk_max_tokens | — | 800 (api bounds 100–4000) |
| preferences | — | written by compute_preferences, stored inside `user_settings.settings` |
| (UI only) user_display_name, user_handle, user_avatar_url, show_extraction_badge, theme, font_size, post_spacing | — | worker ignores |

`apply_provider_settings` semantics (`worker/lib/settings.py:91-151`): fetch the raw row, `merge_settings` (a dict-aware shallow merge, `settings_schema.py:226-234`), reassert the operator baseline env when `PUBLIC_DEPLOYMENT ∈ {1,true,yes}`, then `_active_settings = merged`. For every SETTINGS_TO_ENV key: if the user explicitly set it (or, under PUBLIC_DEPLOYMENT, the baseline has it), also write `os.environ`. Otherwise **pop it from `_active_settings`** and restore the baseline env. The baseline is captured at import (`settings_schema.py:271`). `get_active(key, env, default)` returns `_active_settings[key]` if truthy, else `os.getenv(env, default)` (`settings.py:42-52`). Net effect: a setting the user didn't set falls back to the *live env* (the operator baseline), not to DEFAULTS. Keys outside SETTINGS_TO_ENV (personas_enabled, preferences, …) stay in `_active_settings`.

**Worker-only env vars:**

| Env | Default | Read | Ref |
|---|---|---|---|
| REDIS_URL | `redis://redis:6379/0` | import | `celery_app.py:10` |
| CELERY_WORKER_CONCURRENCY | 2 | import | `celery_app.py:28` |
| CELERY_SOFT_TIME_LIMIT / CELERY_TIME_LIMIT | 540 / 600 | import / **per call** (reclaim window) | `celery_app.py:36-37`, `audio_tasks.py:71` |
| DATABASE_URL | `postgresql://ficino:ficino@postgres:5432/ficino` | import | `db.py:18` |
| WORKER_DB_POOL_MIN_SIZE (falls back to DB_POOL_MIN_SIZE) | 2 | first use | `db.py:40` |
| WORKER_DB_POOL_MAX_SIZE (falls back to DB_POOL_MAX_SIZE) | 10 | first use | `db.py:41` |
| OLLAMA_BASE_URL | `http://host.docker.internal:11434`. **Env only** (SSRF defense), never user-set. | per call | `settings.py:55-64` |
| EMBED_DIM | 1024 | per call (embedder); `ingestion_tasks.EMBED_DIM` is unused | `embedder.py:149,220` |
| RETRIEVAL_VECTOR_WEIGHT / RETRIEVAL_KEYWORD_WEIGHT / RETRIEVAL_MAX_VECTOR_DISTANCE | 0.7 / 0.3 / 0.8, clamped to [0,1] | import | `retrieval.py:25-39` |
| RETRIEVAL_CANDIDATE_POOL / RETRIEVAL_RERANK_MULTIPLIER | 100 / 5 | import | `retrieval.py:50,55` |
| RERANK_PROVIDER (**raw `os.getenv`**, for SQL widening) | none | per call | `retrieval.py:87` |
| CONTEXT_MAX_PAPER_CHARS / CONTEXT_MAX_TOKENS | 200000 / 150 | import | `contextualizer.py:50,53` |
| MAX_VISION_PAGES | 100 | per call | `vision_extractor.py:195` |
| ELEVENLABS_API_KEY / ELEVENLABS_MODEL_ID / ELEVENLABS_DIALOGUE_MODEL_ID | — / `eleven_turbo_v2_5` / `eleven_v3` | per call | `tts.py:82,86,142` |
| STORAGE_PROVIDER, UPLOAD_DIR, FIGURES_DIR, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_STORAGE_BUCKET | `local`, `/app/uploads`, `/app/figures`, —, —, `papers` | import | `lib/storage.py:5-12` |
| SIGNED_URL_KEY, ENVIRONMENT | —, `development` | import | `signed_url.py:25-46` |
| PUBLIC_DEPLOYMENT | off | per call | `settings_schema.py:222-223` |

---

## 4. LoopRunner and `lib/db.py`: what disappears

**`LoopRunner`** (`lib/event_loop.py:11-43`): one named daemon thread per subsystem runs `asyncio.new_event_loop().run_forever()`. `run(coro)` is `run_coroutine_threadsafe(coro, loop).result()`, which blocks the Celery thread. It rebuilds the loop if it is closed or the thread has died. There are seven instances: `db-loop`, `llm-loop`, `embed-loop`, `context-loop`, `meta-loop`, `figure-detect-loop`, `vision-loop`. Its only job is to let synchronous Celery task code call async asyncpg, httpx and the anthropic SDK without `asyncio.run()` per call.

In a native-async port **all of this goes away**: every `*_sync` wrapper, LoopRunner, the thread locks (`settings._env_lock`, `reranker._local_model_lock`), and `test_event_loop.py`. Tasks just `await`. Concurrency inside a task (gather plus semaphores of 8/8/4/5) maps to `p-limit` or similar.

**`lib/db.py`:**
- A lazy global asyncpg pool (min 2, max 10) on the db-loop (`:24-48`).
- `_execute/_fetchrow/_fetch/_executemany`: if the error is a pool-closed error (`InterfaceError`, or RuntimeError "pool is closed"), reset the pool and **retry once** (`:57-135`). That disappears: node-pg's Pool reconnects on its own, but you need a `pool.on('error')` handler.
- `execute_in_transaction(statements)`: one connection, one tx, **no retry** by design (`:162-176`). Keep this.
- `store_chunks_batch` (`:179-250`): one tx, `DELETE FROM chunks WHERE paper_id`, then `executemany INSERT INTO chunks (paper_id, user_id, section, content, chunk_type='text', chunk_index, token_count, embedding=str(list), metadata='{}', contextual_prefix or NULL) ON CONFLICT (paper_id, chunk_index) DO UPDATE …`. The embedding goes in as the text `"[0.1, 0.2, …]"`, which pgvector parses. `chunks.search_vector` is filled by a **DB trigger** `to_tsvector('english', content)` (`infra/postgres/init.sql:103-111`), not by the worker.
- `store_figure` (`:253-326`): `INSERT INTO figures (… processed_at=NOW(), bbox=$13::jsonb …) ON CONFLICT (paper_id, figure_index) DO UPDATE` sets every column. `bbox` is `json.dumps` text or NULL.
- asyncpg type behavior the code depends on (and which node-pg differs on):
  - jsonb/json columns come back as **str**, because no codec is registered. That's why `isinstance(x, str) → json.loads` appears everywhere. node-pg auto-parses them.
  - uuid comes back as `uuid.UUID` (the code `str()`s it). node-pg gives strings.
  - `uuid[]` and `text[]` come back as lists.
  - `execute` returns the status string.
  - `Record.get()` is used (`summary_tasks.py:132,137`).

---

## 5. Prompt inventory (copy verbatim; watch the `{{ }}` escaping, see section 9)

| # | Prompt | Location | Kind |
|---|---|---|---|
| 1 | `SYSTEM_PREAMBLE`, prepended to every persona system prompt | `worker/lib/persona.py:20-37` | constant |
| 2 | Persona system prompts, `retrieval_query`, `name`, `handle`, `temperature`, `allowed_figure_types`, `feed_eligible` | **DB `personas` table**: seeds in `infra/postgres/init.sql:302+` (shortened); full prompts in `infra/postgres/migrate_personas_v3.py`, `add_amplifier_persona.sql`, `update_amplifier_prompt.sql`, `add_typed_figures.sql` (allowed types), `add_personas_feed_eligible.sql`, `add_persona_temperature.sql` | data |
| 3 | Chunk context block: `[Source {i}: {paper_ref} (cite as: {cite}) — Section: {section}]\n<untrusted>…</untrusted>\n`, joined by `\n---\n` | `persona.py:241-254` | template |
| 4 | Contradictions block header plus per-pair format | `persona.py:270-287` | template |
| 5 | Parent-anchor ("PARENT POST'S GROUNDING …") header plus `[Parent Source i: …]` | `persona.py:302-322` | template |
| 6 | "PRIOR POSTS IN THIS FEED …" block | `persona.py:439-447` | template |
| 7 | `build_post_prompt` base, plus branches for post / thread (random 4-6) / quote (+fallback) / reply (+fallback) / figure | `persona.py:449-640` | f-strings (the thread/quote/reply/figure branches use `{{`) |
| 8 | Prior-post summary line `"{handle} on {paper_ref}: {content[:90]}…"` | `persona_tasks.py:724-730` | template |
| 9 | Contradiction classifier prompt plus system `"You are a precise academic text classifier. Respond with exactly one word."` | `worker/lib/claude_client.py:271-285` | f-string |
| 10 | `METADATA_PROMPT` plus system `"You are a precise metadata extractor. Respond with only valid JSON."` | `worker/lib/metadata_extractor.py:19-40, 62` | `.format` (`{{`) |
| 11 | Contextualizer `SYSTEM_PROMPT`, `_build_user_prompt`, Anthropic user text | `worker/lib/contextualizer.py:56-73, 150-153` | constants |
| 12 | Figure detector `SYSTEM_PROMPT` plus `_build_user_prompt` (page_text[:8000]) | `worker/lib/figure_detector.py:78-126` | constants |
| 13 | `VISION_SYSTEM_PROMPT` plus per-page user text | `worker/lib/vision_extractor.py:21-29, 92, 125` | constants |
| 14 | `_ARCHIVIST_SYSTEM_FALLBACK`, `_ARCHIVIST_CONTEXT_SUFFIX` (`{chunks}` placeholder), chunk format, follow-up transcript prompt | `worker/tasks/archivist_tasks.py:107-132, 217-223, 372-386` | `.format` |
| 15 | `ORDERING_SYSTEM`, user prompt `"Analyze these papers and propose the optimal reading order. Return JSON only."`, paper block format | `worker/tasks/reading_list_tasks.py:27-46, 119-132` | `.format` (`{{`) |
| 16 | Chapter-context suffix on the system prompt | `reading_list_tasks.py:340-343` | f-string |
| 17 | `PAPER_SUMMARY_SYSTEM`, `PAPER_SUMMARY_PROMPT` | `worker/tasks/summary_tasks.py:37-81` | `.format` (`{{`) |
| 18 | `SYNTHESIS_SYSTEM`, `SYNTHESIS_PROMPT` | `summary_tasks.py:83-107` | `.format` (`{{`) |
| 19 | `_PODCAST_SYSTEM_PROMPT`, podcast user prompt, feed and chunk block formats, fallback script lines | `worker/lib/podcast.py:46-72, 108-159, 202-265, 323-333` | constants / f-strings |
| 20 | Speech text `"{display_name} says: …"` | `worker/tasks/audio_tasks.py:74-105` | f-string |
| 21 | Fencing helpers that wrap untrusted text in `<untrusted>` (part of every prompt) | `shared/ficino_shared/sanitize.py:25-95` | code |

---

## 6. The feed generator, end to end (`generate_feed`)

Files: `tasks/persona_tasks.py`, `lib/persona.py`, `lib/retrieval.py`, `lib/reranker.py`, `lib/embedder.py`, `lib/claude_client.py`, `lib/post_validation.py`, `shared/sanitize.py`. (`lib/quality_check.py` is an *ingestion* gate, section 2.1 step 5, and is not used during feed generation.)

**Step 0: idempotency and feed id** (`persona_tasks.py:263-316`). Covered in section 2.2.

**Step 1: settings** (`:325-363`)
- `apply_provider_settings(user)`.
- `num_posts = settings.posts_per_generation`. This **overrides the api's `num_posts` unless `persona_key`** is set.
- `enabled = resolve_enabled_personas(settings)` (`persona.py:164-186`): every `feed_eligible` active DB persona except those with an explicit `personas_enabled[k] is False`.
- `temperature = persona_temperature`. `post_weights = settings.post_type_weights`. `preferences = settings.preferences`.
- With `persona_key` ("Get their take"): `enabled = {persona_key}` and weights become `{thread .60, quote .25, post .15, reply 0, figure 0}`.
- With `tab_focus` (`_get_tab_overrides`, `:148-171`):
  - `debates`: all personas, weights `{post .10, thread .05, quote .40, reply .40, figure .05}`.
  - `methods`: `{skeptic, methodologist} ∩ enabled` (or all if the intersection is empty), weights `{.40, .35, .10, .10, .05}`.
  - `findings`: `{hype, practitioner} ∩ enabled`, weights `{.35, .15, .15, .10, .25}`.
  - An unknown tab changes nothing, but the tab is still used as the category later.

**Step 2: scope papers** (`_get_paper_ids_for_corpus`, `:104-145`)
- With `tag_filter`: DISTINCT papers joined to tags by name `IN (…)`, `status='complete'`, both `p.user_id` and `t.user_id` equal to the user.
- Else with `corpus_id`: papers in the corpus that are complete and owned by the user.
- Else: all of the user's complete papers.
- If there are none: insert an empty feed (`posts '[]'`, counts 0, `ON CONFLICT DO NOTHING`) and return `{status:"complete", feed_id, post_count:0}`. No fan-out happens.

**Step 3: retrieval** (`:394-433`)
- `liked_paper_titles = preferences.liked_paper_titles` if `has_signal`.
- `active_personas` = DB personas in `enabled`.
- Batch-embed every active persona's `retrieval_query` (DB, default `"key findings and methodology"`) with `input_type="query"`. If that fails, each persona embeds its own query inside retrieval.
- For each persona, `retrieve_for_persona(k, paper_ids, top_k=10, liked_paper_titles, query_embedding)`:
  - `retrieve_chunks(query, paper_ids, top_k = 20 if liked else 10, …)` (`retrieval.py:58-208`).
    - `sql_top_k = top_k`, or `min(CANDIDATE_POOL, top_k*RERANK_MULTIPLIER)` if `RERANK_PROVIDER != none`.
    - One SQL statement: CTE `candidates` (≤100 nearest by `embedding <=> $1::vector`, paper filter `IN ($4…)`, exclusion `c.id <> ALL($n::uuid[])`), plus `keyword_hits` (≤100 by `ts_rank` where `search_vector @@ plainto_tsquery('english',$2)`, same filters), then the union re-ranked by `score = (1 - dist)*VECTOR_WEIGHT + COALESCE(ts_rank,0)*KEYWORD_WEIGHT` (weights interpolated into the SQL text) and `match_type ∈ hybrid|keyword|vector` (hybrid = keyword hit and dist < MAX_VECTOR_DISTANCE), `ORDER BY score DESC LIMIT sql_top_k`. It joins papers to get `title, authors, year, filename`.
    - Then, if the provider is not none, `reranker.rerank(query, results, top_k)`, sorted by `rerank_score` (missing scores sort as -inf).
  - Liked boost: `score *= 1.25` where `paper_title.strip().lower()` is in the liked set, then **re-sort by `score`** and slice to top_k (`retrieval.py:262-276`).
- `flat_chunks` = all personas' chunks, deduplicated by id.

**Step 4: figures** (`:440-488`)
- All figures for the paper_ids, joined to papers. `image_url = storage.figure_image_url(owner, paper, figure_id, image_path, ttl=3600)`; the api re-signs on read.
- Kept fields: id, paper_id, page_number, description, claim_summary, figure_index, paper_ref (title or filename), figure_type, caption, figure_number, data_claim, referenced_paragraph, detector_confidence.

**Step 5: contradictions** (`_detect_contradictions`, `:174-231`). Only when there are more than 1 paper.
- Group `flat_chunks` by paper. Fewer than 2 papers in the group gives `[]`.
- Take up to 5 random cross-paper pairs (15 attempts, so duplicates are possible).
- **Classify each pair serially** with `classify_contradiction_sync` (LLM, one word; anything unexpected becomes `extends`). Failures are skipped.
- Keep the pairs that are `contradicts` or `supports`. If there are none, keep the first 2 of any.

**Step 6: plan** (`persona.plan_feed_posts`, `persona.py:664-728`)
- `persona_keys = eligible_persona_keys(enabled)`: DB-order keys in `enabled`, or every feed-eligible key if `enabled` is empty, or every key if no persona is eligible.
- Weights are the custom ones or POST_TYPE_WEIGHTS. If `preferences.has_signal`, the type weights are `_blend_weights(manual, learned.post_type_weights, 0.4)` (union of keys, normalized, rounded to 4) and the persona weights are `blend(uniform, learned.persona_weights, 0.4)` restricted to persona_keys (missing keys get 0.01).
- Openers: `random.sample(persona_keys, min(3, n))`, each as type `post`.
- The remaining `num_posts - len(openers)` slots draw persona and type independently with `random.choices`.
- **If `num_posts < len(openers)`, the plan is longer than num_posts** (for example `num_posts=1` with 5 personas gives 3 posts).

**Step 7: per-slot loop** (`:565-834`). State: `posts` (new), `all_feed_posts` (existing, in append mode), `id_offset = len(existing)`, `time_offset = len(existing)*2`. Also `used_chunk_ids` and `paper_post_counts`, both seeded from existing posts' `sources[].chunk_id/paper_id`. `paper_cap = max(2, ceil(num_posts / max(1, distinct papers across all retrieved chunks)) + 1)`.

For each `{persona, post_type}`:
1. Emit PROGRESS `post_progress`. `system_prompt = SYSTEM_PREAMBLE + db.system_prompt` (or `"You are {key}"`). `chunks = all_chunks[persona]`. If empty, skip the slot.
2. **Window rotation**: if the persona has more than 1 slot and at least 3 chunks, `window = max(3, len//slots)`, `max_start = len - window`, `start = (slot_idx*window) % (max_start+1)` (0 if max_start is 0), and the chunks become `chunks[start:start+window]`.
3. **Chunk budget**: drop used chunk ids and chunks from papers with `count >= paper_cap`. If fewer than 3 remain, drop only the used ids. If fewer than 5 remain **and** `used_chunk_ids` is non-empty, re-run `retrieve_for_persona(…, exclude_chunk_ids=used)`, apply the paper cap (relaxing it below 3), and use the result if it is at least as large as the filtered set. If no chunks remain, skip the slot.
4. **Figure slot**: if there are no figures, skip. Otherwise the eligible figures are those whose `figure_type ∈ persona.allowed_figure_types` (NULL means none). If none are eligible, skip. Else `random.choice`.
5. `reference_posts` (quote and reply only) = non-deleted existing and new posts. `prior_posts_summary` = one line per non-deleted prior post.
6. `build_post_prompt(persona, type, chunks, contradictions (quote/reply only), existing_posts=reference_posts, figure, prior_posts_summary)` (`persona.py:371-642`).
   - For quote/reply: `random.choice(existing_posts)` is the parent. Its `sources[].chunk_id`s are loaded through `_fetch_chunks_by_ids`, minus any already in the responder's chunks, and rendered as the parent-anchor block. They are **not** merged into the responder's chunks.
   - The context and contradictions are formatted with fencing.
   - `PERSONAS[persona]` (`name`, `handle`) **raises KeyError** if the persona isn't in the DB cache.
   - Type branches: `post`; `thread` (random 4–6 `thread_count`, `thread_posts[]`); `quote` (fenced parent `content[:500]`, `quoting_handle` / `quoting_content` = `json.dumps(content[:150]+"...")`; falls back to a standalone post when there is no parent); `reply` (`replying_to`); `figure` (fenced caption, data_claim, referenced_paragraph and description, `Fig. {number or index+1}`, raises without a figure).
7. LLM: temperature is the persona's DB value, else the user's. `generate_persona_post_sync(system, user, temperature)` calls `_generate` (max_tokens 1024), then `_parse_post_json`:
   - strip `<think>…</think>`;
   - for the cleaned text, then the raw text, try `json.loads`, then the first fenced block, then the first balanced `{…}`;
   - else treat it as plaintext: strip fences and role markers. Empty raises `ValueError`; more than 4000 chars raises; otherwise wrap as `{"post_type":"post","content":text}` (`claude_client.py:131-244`).
8. Post-process:
   - `persona = key`, `setdefault post_type`, `id = id_offset + len(posts) + 1`, `time = f"{time_offset + (len(posts)+1)*2}m"`, `_task_id = request.id`.
   - `paper_ref = _build_short_cite(chunks[0])`: `"{last name of first author}{' et al.' if >1} {year}"`, else `"{title} ({year})"` or the title (`persona.py:209-223`). This overrides the LLM's value.
   - Figure posts: `figure_url`, `figure_id`, `figure_caption = "{Fig. label}, p.{page} — {(caption or description)[:200]}. {paper_ref}"`.
   - `sources = build_post_sources(chunks)`: the first 5 as `{chunk_id, paper_id, paper_title (or filename or "Unknown"), section, content[:300], score round 3}` (`persona.py:140-161`).
   - `category = assign_post_category(persona, type)`: quote/reply → debates; skeptic/methodologist → methods; hype/practitioner or figure → findings; gradstudent → debates; otherwise findings (`persona.py:189-206`). With `tab_focus`, the tab name replaces it.
   - Engagement: `setdefault` random ints for likes (100–5000), retweets (20–1000), replies (10–500) and bookmarks (10–900) (`:38-49`).
   - `validate_post_shape` (`post_validation.py:33-110`): a missing `persona` or `post_type` is filled in; a missing `content` **raises**, so the slot is dropped; an invalid type becomes `post`; a `thread` without a non-empty list of non-blank strings becomes `post` and drops `thread_posts`/`thread_count`; content over 2000 chars becomes `[:2000] + "…"`. *TS deviation (plan 06):* a `thread` with a usable `thread_posts` list and no `content` gets the joined thread as `content` instead of raising, since the thread prompt never asks for `content`; feed audio then speaks the parts once.
   - Append the post, then add its sources' chunk_ids to `used_chunk_ids` and increment `paper_post_counts` once per distinct paper.
9. Any exception in steps 7–8 is logged and the slot is skipped.

**Step 8: persist and fan out**
- Fresh mode upserts `feeds` with `paper_count = len(paper_ids)`. Append mode does the jsonb concat.
- `_write_feed_posts_index(feed_id, new_posts, base_index = len(existing) if append else 0, user)` upserts `feed_posts(feed_id, user_id, post_index, content_text, persona, post_type, category, paper_ref, data jsonb, deleted)`.
- `send_task check_post_feed`, `send_task compute_preferences`.

**Stored post shape** (the frontend contract): `id, time, persona, post_type, content, paper_ref, category, likes, retweets, replies, bookmarks, sources[], _task_id`, plus optional `thread_posts, thread_count, quoting_handle, quoting_content, replying_to, figure_url, figure_id, figure_caption`, **plus whatever extra keys the LLM's JSON contained** (passed through untouched). Later the api adds `deleted`, and audio adds `audio_key` / `audio_error`.

LLM calls per feed: 1 batched embedding, up to 5 serial classifications, up to N post generations (serial), and possibly some re-retrieval embeddings.

---

## 7. Worker tests (`worker/tests`)

There are 15 files and **45 test functions**, about 47 collected (one test is parametrized ×3). Run with `cd worker && pytest tests/ -q` (`pytest.ini: testpaths=tests`). CI job `worker-tests` uses a `pgvector/pgvector:pg16` service, loads `infra/postgres/init.sql`, and sets `DATABASE_URL=…@localhost` (`.github/workflows/ci.yml:72-111`). `conftest.py` only sets defaults for UPLOAD_DIR, FIGURES_DIR, DATABASE_URL and REDIS_URL before imports. There are no pytest fixtures there. The convention is to monkeypatch at the *importing* module's namespace.

| File | # | Covers | Style / real services |
|---|---|---|---|
| `test_auto_tagging.py` | 1 | ingestion_tasks binds `fetch`/`execute` (R10 WORK-1 NameError) | name-binding check |
| `test_chapter_post_validation.py` | 1 | reading_list_tasks imports `validate_post_shape` | name-binding check |
| `test_event_loop.py` | 2 | LoopRunner recovers from a dead loop thread; concurrent submits don't serialize | pure; **delete in the port** |
| `test_generate_feed_idempotency.py` | 4 | fresh-path uuid5 idempotency: redelivery skip, a new dispatch gets a new id, empty-feed redelivery, empty-then-success recovery | in-memory `_FakeFeedsTable`, with the whole pipeline monkeypatched (fixture `stubbed_pipeline`) |
| `test_group_chat_pending_state.py` | 1 | synthesis marks `status='error'` when retries are exhausted | monkeypatched DB |
| `test_llm_hardening.py` | 5 | Ollama: empty or whitespace response raises; non-empty passes; empty content with `thinking` falls back; 4xx is not retried | fake `httpx.AsyncClient`, fast sleep |
| `test_media_claim_reclaim.py` | 7 (with ×3 param) | audio claim SQL: stale (21/30/90 min) is reclaimable; fresh is not; NULL claimed_at is reclaimable; `_reclaim_minutes()==20` by default, 60 when CELERY_TIME_LIMIT=1800 | **REAL Postgres**: inserts into `users` and `feeds`. Its `_claim` is a hand-copied mirror of the task SQL. |
| `test_persona_helpers.py` | 8 | `build_post_sources` shape, truncation, top_n and filename fallback; `resolve_enabled_personas` opt-out and missing settings; archivist `_get_paper_ids` scoping | pure plus monkeypatch |
| `test_podcast_settings.py` | 1 | the podcast task applies the owner's settings | monkeypatch |
| `test_reading_list_persist.py` | 4 | `execute_in_transaction` commits and rolls back (fake asyncpg pool/conn/tx); propose_ordering persists in one tx; a persist failure propagates to retry | fake pool |
| `test_settings_env_hygiene.py` | 4 | no key leak between users; operator baseline restored; PUBLIC_DEPLOYMENT reassert wins; no laundering of a previous user's key | monkeypatched fetchrow plus env |
| `test_shared_adoption.py` | 2 | CHAPTER_INSERT_SQL identity; `default_for` | pure |
| `test_stale_papers.py` | 1 | the stale query source contains `corpus_id IS NULL` and `f.user_id = p.user_id` | `inspect.getsource` |
| `test_wave3_task_fixes.py` | 7 | chapter writes feed_posts (source check); `_coerce_messages`; vision Ollama and Claude retries; Claude vision `max_retries=0`; eligible-persona fallback excludes the archivist | mixed fakes |

Real external services: **none** (no LLM, embedding, TTS or storage calls). Only `test_media_claim_reclaim.py` touches a real DB. There are separate shared tests in `shared/tests/` (constants, sanitize, settings_schema, signed_url, storage_local, storage_supabase). There is **no test coverage** of: chunker, quality_check, pdf_extractor, figure_detector parsing, retrieval SQL, reranker, plan_feed_posts, build_post_prompt, `_parse_post_json`, citation validation, the podcast script, or the ingestion pipeline as a whole.

---

## 8. Mapping notes for pg-boss (behavior to preserve)

- Queues: keep `ingestion` and `persona` as separate pg-boss queues. Today both share one 2-slot pool. Per-task retry policy: process_paper / generate_feed / summary / synthesis use 2 retries with 30s delay; archivist / reading_list use 2 retries with **180s**; regenerate_post, audio, preferences use 0; alerts also use 0 in practice (their `max_retries` is inert).
- "Same id on retry" is load-bearing: uuid5 feed ids, the `_task_id` markers, and the summary `task_id` comparison. pg-boss keeps the job id across retries, so use the job id as `request.id`.
- Time limits: pg-boss `expireInSeconds` marks a job failed but **does not stop the JS handler**. The 540s graceful / 600s hard behavior needs an AbortSignal (or worker restart) to stop LLM spend. The audio reclaim window is derived from CELERY_TIME_LIMIT, so rename it carefully.
- Progress: replace `update_state(PROGRESS, meta)` and the api's `AsyncResult` reads with something pg-boss can serve (a progress table or column). Also map Celery states to pg-boss states for `/feed/status`, `/messages/papers/*`, and stuck-summary detection.
- Beat: `boss.schedule('check_stale_papers', '0 3 * * *', …, { tz: 'UTC' })`.
- Fan-out stays fire-and-forget `boss.send` (there are no chains, groups or chords). Dispatch failures must stay swallowed.

---

## 9. Surprises and things a porter is likely to get wrong

1. **Per-task provider config is a process global.** `_active_settings` plus `os.environ` mutation only work because a prefork child runs one task at a time (`settings.py:31-38`). A Node worker running concurrent jobs in one process **will bill user A's job to user B's key**. Pass a resolved config object through every call (or use AsyncLocalStorage). Keep the "unset key falls back to operator env, not DEFAULTS" rule, and the PUBLIC_DEPLOYMENT reassert.
2. **`retrieval.py:87` reads `RERANK_PROVIDER` with raw `os.getenv`**, while `reranker` uses `get_active`. They agree today only because apply_provider_settings writes os.environ. In the port, both must read the same resolved value.
3. **Provider value spellings differ:** LLM and vision use `"api"` for Anthropic, but figure_detect and context use `"anthropic"`. The vision provider env fallback is `llm_provider`.
4. **Python `str.format` / f-string brace escaping.** Templates written with `{{ }}` render as `{ }` (PAPER_SUMMARY_PROMPT, SYNTHESIS_PROMPT, ORDERING_SYSTEM, METADATA_PROMPT, and the thread/quote/reply/figure branches of build_post_prompt). The `post` branch and the standalone fallbacks in build_post_prompt are *not* f-strings and use single braces. When copying "verbatim", copy the rendered text, not the source.
5. **`json.dumps` defaults to `ensure_ascii=True`.** `quoting_handle`, `quoting_content`, `replying_to` and the figure `paper_ref` are interpolated into prompts with non-ASCII characters escaped as `\uXXXX` (`persona.py:508-509, 548, 602`). `JSON.stringify` does not escape them, so the prompt text changes.
6. **The archivist system prompt runs through `.format(chunks=…)`** (`archivist_tasks.py:223,365`). A DB prompt containing `{` or `}` raises, and the task errors. A JS `.replace` would silently succeed.
7. **`_parse_post_json` can return a non-dict.** `json.loads` of `"str"`, `42` or `[…]` returns it, and the caller's `post_data["persona"]=…` raises TypeError, which drops the slot. In JS, assigning a property to an array or string silently "works" and would persist garbage. Require a plain object.
8. **The SYSTEM_PREAMBLE asks for `{"posts":[{"text","type"}]}`, while the user prompt asks for `{"post_type","content",…}`.** If the model follows the preamble there is no `content`, the validator raises, and the slot is dropped. Extra LLM keys are persisted into posts as-is. Reproduce this; don't "fix" it during the port.
9. **`generate_chapter` figure slots crash the task.** `build_post_prompt(..., "figure")` without a figure raises *outside* the per-slot try (`reading_list_tasks.py:349-354`), so the whole task fails and retries. With default weights about 60% of 12-post chapters are affected. **`regenerate_post` on a figure post always fails** the same way (`persona_tasks.py:1015-1019`). Decide explicitly whether the port reproduces these bugs or fixes them (and tell the owner).
10. **The liked-paper boost undoes the rerank.** It re-sorts by the hybrid `score`, not `rerank_score` (`retrieval.py:262-276`). Also, `liked_paper_titles` contains short cites ("Smith et al. 2024") that never match a `paper_title`.
11. **The plan can exceed `num_posts`.** Openers are `min(3, n_personas)` regardless of num_posts (`persona.py:714-726`). PROGRESS `post_progress` uses `num_posts` as the denominator. In normal mode the api's `num_posts` is ignored (`posts_per_generation` overrides it).
12. **Variable shadowing in generate_feed.** The `persona_key` kwarg is overwritten by the retrieval loop variable (`persona_tasks.py:417`) and the plan loop (`:566`). It is harmless only because the kwarg is read solely before line 417. Copy it with care.
13. **Inert `max_retries`.** Alert tasks declare `max_retries=1` but never call `self.retry` (`alert_tasks.py:68-72, 206-210, 282-286`), so they get zero retries. Celery's implicit 180s delay applies to the archivist and reading_list tasks.
14. **Ingestion retry re-bills everything.** It re-extracts, re-runs metadata, contextualizer and VLM figure detection, and re-embeds. Status is set to `error` before the retry, then back to `extracting`. Embedding `RuntimeError` is the one path that deliberately does not retry. The return value's `figure_count` uses len(figures), while the DB uses stored.
15. **Chunk ids change on every re-ingest.** `store_chunks_batch` deletes then upserts, so old `posts[].sources[].chunk_id` references go stale. The worker tolerates missing anchors.
16. **asyncpg vs node-pg types.** asyncpg returns jsonb as *strings* (no codec), hence the `isinstance(str)` branches. node-pg parses them, so do not double-parse, and pass `JSON.stringify` strings with `::jsonb` casts the way the Python does. UUIDs come back as objects in Python and get `str()`d; `str(None)` becomes `"None"` in a few places (for example `generate_chapter` `effective_user_id`, `archivist post_user_id`). There's no `executemany`.
17. **The `chunks.search_vector` trigger** is in the DB, so don't compute tsvectors in TS. pgvector accepts the `"[a, b, …]"` text format the code sends.
18. **Regex and string semantics:**
    - Python `\w` and `\s` are Unicode by default (`quality_check.SYMBOL_PATTERN`, `pdf_extractor.NUMBERED_HEADING`, chunker heading patterns). JS needs the `u` flag plus `\p{L}\p{N}_`, otherwise non-English papers fail the quality check differently.
    - `str.isupper()`, `str.title()`, `str.split()` (no-arg) and `rsplit` all differ from naive JS equivalents.
    - `len()` and slicing count code points; JS `.length` counts UTF-16 units. That affects every `[:N]` cap: 2000, 4000, 8000, 280, 300, 200000.
    - `round()` is banker's rounding (weights, scores).
    - `re.match` anchors at the start only, so chunker section names come from prefix matches: `"## Methods and Materials"` becomes `methods`, and `"## 3 Results"` falls to the generic pattern and becomes `"3 results"`.
    - The chunker sentence split uses the lookbehind `(?<=[.!?])\s+`.
19. **PyMuPDF to mupdf.js fidelity.**
    - The heading detector depends on `get_text("dict")` span `size`, `flags & 16` (bold) and the `font` name, plus a body size computed as the char-weighted mode of `round(size, 1)` over the first 10 pages.
    - MuPDF.js `StructuredText.asJSON()` exposes the font name, size and weight differently, and its default extraction flags (ligatures, whitespace, dehyphenation) may differ from PyMuPDF's.
    - Expect different markdown, and therefore different chunks and embeddings. Build a golden-file comparison on real papers.
    - Pages render at 150 dpi (figures) and 200 dpi (vision) via `Matrix(dpi/72)`.
    - The crop uses `int()` truncation after a ±4% padding clamp (`pdf_extractor.py:328-336`).
    - **All pages are rasterized into memory up front** for figure detection, and the 50-figure cap applies *after* every page has gone through detection.
20. **Figure detector.** The area threshold is `0.005` (0.5% of the page), not the 5% the comment claims (`figure_detector.py:171-174`). Unknown types become `other`. Page errors become `[]`. `is_available()` is false for the default `anthropic` provider without a key, so self-host with Ollama gets **no figures** unless FIGURE_DETECT_PROVIDER=ollama.
21. **The Voyage embed retry covers only 429.** The Ollama embed uses the legacy `/api/embeddings` endpoint with `prompt`, one request per text, 8 concurrent. Dim and length checks against `EMBED_DIM` are hard failures.
22. **SDK retry stacking.** Only the vision Anthropic client pins `max_retries=0`. Every other Anthropic client keeps the SDK default (2 retries). The TS SDK default `maxRetries` is also 2; keep it the same to match.
23. **Audio specifics.**
    - Feed audio never calls apply_provider_settings (operator ElevenLabs key only).
    - The default-voice fallback triggers on *any* HTTP error, not just 401.
    - The local storage backend raises NotImplementedError, so `audio_status='failed'`.
    - The podcast `_fit_total_chars` always keeps at least 2 segments even if they are over the cap, which can raise DialogueTooLong, and can cut below 4 segments, which switches to the deterministic fallback script.
    - `podcast_segments` is written before synthesis.
24. **Signed URL dev key.** The dev fallback key is the sha256 **hex string** (as bytes), not the raw digest. `ENVIRONMENT=production` without `SIGNED_URL_KEY` crashes at import. The api verifies worker-signed figure tokens, so they must be byte-identical.
25. **uuid5 namespace.** Feed and chapter ids use `uuid5(NAMESPACE_DNS, "ficino:feed:{task_id}")` and `"ficino:chapter:{list}:{idx}"`. The npm `uuid` `v5(name, v5.DNS)` produces the same ids. The chapter id must match so regenerating an existing chapter upserts the same row.
26. **`check_contradictions` scope.** It compares against papers by `corpus_id` only, not user_id. That is safe only if corpora are per-user. NULL `corpus_id` matches nothing (`= NULL`).
27. **Persona cache.** It has a 1h TTL, per process, recycled every 100 tasks. Feed eligibility and the archivist (`feed_eligible=false`) come from the DB. The preamble says "one of five personas" but the DB has 7 (including amplifier and archivist).
28. **`compute_preferences` runs after every feed.** It writes `user_settings.settings.preferences` through `jsonb_set`. That key lives inside the same JSON the api PUTs, so keep it atomic.

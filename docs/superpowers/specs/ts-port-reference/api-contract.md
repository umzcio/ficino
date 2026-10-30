# Ficino API contract inventory (Python FastAPI -> TS/Hono port)

Source: `/projects/ficino/api` + `/projects/ficino/shared/ficino_shared` at `main@dfedb2b` (2026-10-29).
All refs are `file:line`, relative to `api/` unless prefixed. Read-only survey; nothing in the repo was changed.

---

## 0. Global conventions (apply to every route)

| Topic | Behavior | Ref |
|---|---|---|
| Mount path | The API serves at root (`/papers`, `/feed`, ...). The frontend calls `${VITE_API_BASE or '/ficino/api'}${path}`. nginx (`frontend/nginx.conf:18`) and the Vite dev proxy (`frontend/vite.config.ts:101`) strip `/ficino/api`, so the backend never sees the prefix. CSRF exempt paths and figure URLs assume it's stripped. | |
| Server | `uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}` | `Dockerfile` |
| JSON errors | `HTTPException` -> `{"detail": "<string>"}` with that status. The frontend reads `body.detail` only when it's a string (`frontend/src/lib/api.ts:45`). | |
| Validation errors | 422 `{"detail":[{"type","loc","msg","input",...}]}` (pydantic v2 shape; `detail` is an array, so the frontend shows its fallback text). Path ints (`post_index` etc.), query ints, pydantic bodies, `Query(min_length...)`. | |
| Unknown route / method | 404 `{"detail":"Not Found"}` / 405 `{"detail":"Method Not Allowed"}` | |
| Trailing slash | Starlette `redirect_slashes=True`: `/papers/` gets a 307 redirect to `/papers`. The frontend never sends trailing slashes. | |
| Unhandled exception | 500 `text/plain` `Internal Server Error` (ServerErrorMiddleware sits outside CORS/CSRF/headers middleware, so the response has no CORS or security headers). Includes asyncpg `DataError` when a non-UUID string reaches a `uuid` column: most `{id}` path params are typed `str`, so `GET /papers/abc` returns 500, not 404. | |
| Datetime serialization | Return annotations (`-> dict[str, object]`, `list[dict]`, `Paper`, `Feed`) act as response models, so pydantic v2 JSON mode applies. UTC timestamptz becomes `"2026-01-01T01:02:03.000005Z"`, with no fraction when microseconds are 0 and `Z` rather than `+00:00`. Exceptions: `annotations.py` and `replies.py:335` call `.isoformat()` explicitly, which gives `+00:00`. Verified locally with pydantic 2.13.4. | |
| UUID / inet | Serialized as strings. | |
| JSONB columns | No asyncpg JSON codec is registered (`db/connection.py:29`), so JSONB arrives as a **string**. Each handler `json.loads` it by hand, except `GET /users/me/audit-log`, which returns `metadata` as a raw JSON **string** (see Surprises). | |
| DB pool | `API_DB_POOL_MIN_SIZE`/`API_DB_POOL_MAX_SIZE` (fallback `DB_POOL_MIN_SIZE`/`DB_POOL_MAX_SIZE`), defaults 5/20. | `db/connection.py:27` |
| Dependency order | Within a route: `get_current_user` (auth) runs, then `RateLimit` deps (INCR happens here), then path/query/body validation. **So a 422-invalid request still consumes a rate-limit slot**, and an invalid upload (non-PDF, too big) still burns the upload quota. Auth failure (401) comes before the rate limit. | FastAPI `solve_dependencies` |
| Default status codes | POST/PUT without `status_code` return 200 (e.g. `POST /replies`, `POST /auth/login`, PUTs). 204 routes return an empty body. | |
| Interactive docs | `/docs`, `/redoc`, `/openapi.json` only when `ENVIRONMENT=development`. | `main.py:65-74` |
| Streaming / SSE | **None.** No `StreamingResponse`, EventSource, or WebSocket anywhere in api/ or the frontend. All async work is enqueue-then-poll. | grep |
| Tables written by the API | users, corpora, papers, feeds, feed_posts, paper_summaries, corpus_syntheses, user_posts, post_replies, persona_dms, user_settings, alerts, bookmarks, annotations, user_likes, tags, paper_tags, reading_lists, reading_list_chapters, audit_log. Read-only: chunks, figures, personas. | |

---

## 1. Routes

Legend: **Auth** U = `Depends(get_current_user)` (provider chosen at import, see sec. 3); B = `get_user_basic` hard-wired; - = none.
**RL** = rate-limit key (sec. 2.6). **Celery** = `send_task(name, args/kwargs, queue)`. **Audit** = `record_audit(action, resource_type, resource_id, metadata, status_code)`.

### 1.0 main.py (app-level)

| Method Path | Auth | Response | Notes |
|---|---|---|---|
| GET `/auth/provider` (`main.py:141`) | - | `{"provider": "none"\|"basic"\|"supabase", "public_deployment": bool}` | The frontend calls this at boot. The GET also seeds the CSRF cookie. |
| GET `/health`, `/healthz` (`main.py:172`) | - | `{"status":"ok","service":"ficino-api"}` | Used by the compose healthcheck. |

Startup (`main.py:24-58`):
- If `AUTH_PROVIDER=supabase` and `SUPABASE_JWT_SECRET` is empty: RuntimeError (fail closed).
- If `AUTH_PROVIDER=none`: upsert stub user `(STUB_USER_ID,'stub','stub@ficino.dev')` into `users(id,clerk_id,email)` and `corpora(DEFAULT_WORKSPACE_ID, STUB_USER_ID,'Default')`, both `ON CONFLICT (id) DO NOTHING`.
- `auth/basic_routes` router is mounted **only** when `AUTH_PROVIDER=basic` (`main.py:149`). Otherwise `/auth/login|register|logout|me` return 404.

### 1.1 auth/basic_routes.py (prefix `/auth`, basic provider only)

| Method Path | Auth / RL | Body | Response | Errors / side effects |
|---|---|---|---|---|
| POST `/auth/register` :44 (201) | - ; IPRateLimit `register` 3/3600s | `RegisterRequest{email:str, password:str(min 12,max 72)}` (no email validation or normalization) | `{"status":"registered","user_id":str}` + Set-Cookie `ficino_session` | 403 `Registration is disabled` (user_count>0 and !ALLOW_REGISTRATION; the count includes any stub user). 409 `Email already registered`. 429 `Too many register attempts. Try again later.` Writes users(email,password_hash), corpora(user_id,'Default') with a random id, Redis session. Audit `user.register`/user/{id}/{email}/201. CSRF-exempt. |
| POST `/auth/login` :110 (200) | - ; IPRateLimit `login` 5/900s | `AuthRequest{email:str,password:str}` (unbounded) | `{"status":"logged_in","user_id":str}` + Set-Cookie | 401 `Invalid email or password` (no row, null hash, or bad pw). 429 `Too many login attempts. Try again later.` CSRF-exempt. No audit. |
| POST `/auth/logout` :144 | B | - | `{"status":"logged_out"}` + delete-cookie `ficino_session` Path=/ | 401s from get_user_basic. Deletes Redis `session:{token}`. Audit `user.logout`. **CSRF-protected.** |
| GET `/auth/me` :170 | B | - | `{"id","email","display_name"}` | 401 `Not authenticated` / `Session expired` / `User not found` |

### 1.2 routers/alerts.py (prefix `/alerts`)

| Method Path | Auth | Response | Errors / side effects |
|---|---|---|---|
| GET `/alerts` :17 | U | `[{id, type (alert_type col), title, body, metadata (obj, json-decoded), read:bool, created_at}]`, `dismissed=false`, `created_at DESC`, LIMIT 50 | - |
| GET `/alerts/unread-count` :48 | U | `{"count": int}` | - |
| PUT `/alerts/{alert_id}/read` :61 | U | `{"status":"ok"}` | No existence check (always 200). UPDATE alerts.read |
| PUT `/alerts/read-all` :75 | U | `{"status":"ok"}` | UPDATE all non-dismissed |
| DELETE `/alerts/{alert_id}` :88 (204) | U | empty | 404 `Alert not found` (also when already dismissed). Soft-delete `dismissed=true`. No audit. |

### 1.3 routers/annotations.py (prefix `/annotations`)

| Method Path | Auth | Params/Body | Response | Errors / side effects |
|---|---|---|---|---|
| GET `/annotations` :17 | U | - | `[{id, feed_id, post_index, body, created_at, updated_at}]` (timestamps `.isoformat()`, i.e. `+00:00`), `updated_at DESC` LIMIT 1000 | - |
| GET `/annotations/{feed_id}/{post_index:int}` :47 | U | - | same single object | 404 `No annotation` |
| PUT `/annotations/{feed_id}/{post_index:int}` :71 | U | `AnnotationUpsert{body:str}` (trimmed) | same object (body = trimmed) | 400 `Annotation body cannot be empty`. Upsert ON CONFLICT (user_id,feed_id,post_index). **No feed-ownership check.** |
| DELETE `/annotations/{feed_id}/{post_index:int}` :103 (204) | U | - | empty | 404 `Annotation not found`. Audit `annotation.delete`/annotation/{feed_id}/{post_index}/204 |

### 1.4 routers/bookmarks.py (prefix `/bookmarks`)

| Method Path | Auth | Params/Body | Response | Errors / side effects |
|---|---|---|---|---|
| GET `/bookmarks` :19 | U | - | `[{id, feed_id, post_index, message_index, post (snapshot obj), bookmarked_at}]` DESC LIMIT 500 | - |
| POST `/bookmarks` :53 (201) | U | `BookmarkCreate{feed_id:str, post_index:int, message_index:int=-1, post_snapshot:dict}` | `{"id","status":"created"}`, or `{"id","status":"already_bookmarked"}` (**still 201**) | 404 `Feed not found` (feed not owned). INSERT ... ON CONFLICT (user_id,feed_id,post_index,message_index) DO NOTHING. Snapshot `json.dumps(default=str)`. |
| DELETE `/bookmarks/{bookmark_id}` :97 (204) | U | - | empty | 404 `Bookmark not found`. Audit `bookmark.delete`/bookmark/{id}/204 |
| DELETE `/bookmarks/post/{feed_id}/{post_index:int}?message_index=int(-1)` :120 (204) | U | - | empty | **Idempotent, never 404.** Audit `bookmark.delete` (no resource_id; metadata {feed_id,post_index,message_index}) |

### 1.5 routers/citations.py (prefix `/citations`)

| Method Path | Auth | Params | Response | Errors |
|---|---|---|---|---|
| GET `/citations/by-title` :71 | U | `title:str` (required), `format:str="apa"` (`"mla"`, else APA) | `{"citation","format" (echoes input, even if unknown),"title"}` | 404 `Paper not found`. Match: `title ILIKE '%'+title[:80]+'%'` **without escape_like**, LIMIT 1, no ORDER BY. Formatters: `_format_apa` :14 (APA7, 20-author rule), `_format_mla` :50. Port the string logic exactly. |

### 1.6 routers/feed.py (prefix `/feed`)

`Feed` model (`models/feed.py:25`), emitted with **all keys present** (nulls included): `id, user_id, corpus_id, tag_filter, posts (list of raw post dicts), generated_at, generation_duration_ms, paper_count, post_count, audio_status, audio_generated_at, podcast_status, podcast_generated_at, podcast_segments, podcast_audio_url`.

| Method Path | Auth / RL | Params/Body | Response | Errors / side effects |
|---|---|---|---|---|
| POST `/feed/generate` :65 (202) | U ; `feed_generation` | `FeedGenerateRequest{corpus_id:UUID\|null, tag_filter:list[str]\|null, append_to_feed_id:str\|null, tab_focus:str\|null, persona_key:str\|null, num_posts:int\|null}` (422 if corpus_id isn't a UUID) | `{"task_id","status":"queued"}` | 400 `No processed papers available. Upload and wait for processing to complete.` (no `status='complete'` papers in scope). 404 `Feed not found` (append target not owned). **Celery** `tasks.persona_tasks.generate_feed` kwargs `{corpus_id:str\|None, tag_filter, user_id}` plus, only if truthy, `append_to_feed_id, tab_focus, persona_key, num_posts`; queue `persona`. |
| GET `/feed/status/{task_id}` :127 | U | - | see sec. 5 | No ownership check on task_id. Reads Celery AsyncResult. |
| GET `/feed/{feed_id}` :290 | U | - | `Feed` with hydration | 404 `Feed not found`. Hydration: if `audio_status=='ready'`, each post with `audio_key` gets `audio_url` = storage.audio_url(user, feed, idx) (24h; local storage raises, so None). **Always** re-signs `figure_url` for posts with `figure_id` (one ownership-scoped query on figures JOIN papers, TTL 600; on failure the stale persisted URL stays). If `podcast_status=='ready'`, `podcast_audio_url` = signed episode URL (or None). |
| POST `/feed/{feed_id}/audio` :327 (202) | U ; imperative `audio` | - | `{"status":"generating"\|"ready"}` (idempotent short-circuit, no task_id) or `{"status":"generating","task_id"}` | **501 `Audio TTS not configured`** when ELEVENLABS_API_KEY is empty (the frontend hides the UI on 501). 404 `Feed not found`. RL charged only on dispatch. **Celery** `tasks.audio_tasks.generate_audio_for_feed` args `[feed_id]` queue persona. The API does NOT set audio_status; the worker claims it. |
| POST `/feed/{feed_id}/podcast` :372 (202) | U ; imperative `audio` (shared) | - | same as audio, keyed on `podcast_status` | Same 501/404. **Celery** `tasks.audio_tasks.generate_podcast_for_feed` args `[feed_id]`. |
| DELETE `/feed/{feed_id}/posts/{post_index:int}` :412 (204) | U | - | empty | Single `jsonb_set(posts, ARRAY[idx,'deleted'], true, true)` with ownership + `0<=idx<jsonb_array_length` in the WHERE. 404 `Feed not found`, 404 `Post not found` (out of range). Best-effort `UPDATE feed_posts SET deleted=true`. Audit `feed.post.delete`/feed/{feed_id}/{post_index}/204 |
| POST `/feed/{feed_id}/regenerate/{post_index:int}` :486 (202) | U ; `feed_generation` | - | `{"task_id","status":"queued"}` | 404 `Feed not found`; 404 `Post not found` (bounds checked against the `post_count` column, not array length). **Celery** `tasks.persona_tasks.regenerate_post` args `[feed_id, post_index]` kwargs `{user_id}`. Audit `feed.post.regenerate`/feed/{id}/{post_index, task_id}/202. Frontend doesn't poll; it refetches after 4s. |
| GET `/feed?workspace_id=str&summary=bool(false)` :529 | U | - | `list[Feed]` `generated_at DESC` LIMIT 20. With `summary=true`, `posts: []`. **Media fields are always null in the list** (include_media=False, but the model still emits the keys). No URL hydration. | `workspace_id` filters on corpus_id. |

### 1.7 routers/figures.py (prefix `/figures`)

| Method Path | Auth | Params | Response | Errors |
|---|---|---|---|---|
| GET `/figures/{paper_id}/{figure_id}?token=` :21 | U (cookie, or the bearer that `<img>` can't send) | `token:str` required, len 10..200 (else 422) | `FileResponse` `image/png` from `{FIGURES_DIR}/{paper_id}/{basename(figures.image_path)}` | 403 `Invalid or expired figure token` (checked **first**, before DB). 404 `Figure not found` (no row joined to papers.user_id). 400 `Invalid image path` / `Invalid paper id` (contains `/` or `..`) / `Path escape detected`. 404 `Figure file missing`. |

### 1.8 routers/likes.py (prefix `/likes`)

| Method Path | Auth | Body/Params | Response | Errors / side effects |
|---|---|---|---|---|
| GET `/likes/feed/{feed_id}` :16 | U | - | `{"posts":[post_index...], "replies":{"<post>:<msg>": true}}` (message_index -1 counts as a post-level like) | No feed ownership check (scoped by user_id). |
| POST `/likes` :42 (201) | U | `LikeCreate{feed_id:str, post_index:int, message_index:int=-1, persona_key?, post_type?, category?}` | `{"id","status":"created"\|"already_liked"}` (201 both) | 404 `Feed not found`. ON CONFLICT DO NOTHING on user_likes. |
| DELETE `/likes/feed/{feed_id}/{post_index:int}?message_index=int(-1)` :87 (204) | U | - | empty | 404 `Like not found`. Audit `like.delete`/like/-/{feed_id,post_index,message_index}/204 |

### 1.9 routers/messages.py (prefix `/messages`). Route order matters: `/papers/tldrs` is declared before `/papers/{paper_id}`.

| Method Path | Auth / RL | Response | Errors / side effects |
|---|---|---|---|
| GET `/messages/papers?workspace_id=` :24 | U | `[{paper_id, title (title or filename), authors[], chunk_count, has_summary:bool, summary_generated_at, last_message_preview (<=80 chars or null), message_count, uploaded_at}]`; only `papers.status='complete'`; `uploaded_at DESC` LIMIT 200 | - |
| GET `/messages/papers/tldrs` :81 | U | `{paper_id: first-message content[:200]}` for summaries with `status='complete'` and non-empty messages | - |
| GET `/messages/papers/{paper_id}` :103 | U ; imperative `summary` (dispatch branch only) | Cached: `{paper_id, title, authors, messages[], generated_at, status ("complete"\|"generating"\|...), task_id? (only if generating)}`. Dispatch: `{paper_id,title,authors,messages:[],status:"generating",task_id}` (no `generated_at` key) | 404 `Paper not found or not processed`. **A GET with side effects:** if there's no summary row, OR the row's `status='error'`, OR it's `status='generating'` and AsyncResult(task_id).state is in FAILURE/REVOKED (or raises): charge RL, **Celery** `tasks.summary_tasks.generate_paper_summary` args `[paper_id]` queue persona, then upsert `paper_summaries(paper_id,'[]','generating',task_id)` ON CONFLICT (paper_id) SET status/task_id. 429 possible on a GET. |
| GET `/messages/papers/{paper_id}/status/{task_id}` :209 | U | SUCCESS: `{"status":"complete","paper_id"}`; FAILURE: `{"status":"error","error":str(exc)}`; anything else: `{"status":"generating"}` | No ownership check on either id. |
| GET `/messages/groups` :233 | U | `[{id,name,paper_count,message_count,last_message_preview(<=80 or null),generated_at}]` DESC LIMIT 50 | - |
| POST `/messages/groups` :269 (202) | U ; `summary` (dependency) | `SynthesisCreateRequest{name:str, paper_ids:list[str]}` -> `{"synthesis_id","task_id","status":"generating"}` | 400 `Need at least 2 papers for a group chat`. 404 `One or more papers not found` (count of owned != len, so **duplicates in paper_ids 404**). synthesis_id = uuid4 generated by the API. **Celery** `tasks.summary_tasks.generate_corpus_synthesis` args `[synthesis_id, paper_ids, name, user_id]`, then INSERT corpus_syntheses placeholder (`messages '[]'`, status generating, task_id) ON CONFLICT (id). |
| GET `/messages/groups/{synthesis_id}` :317 | U | `{id,name,papers:{paper_id:title-or-filename},messages[],generated_at,status,task_id? (if generating)}` | 404 `Group chat not found`. Paper titles are looked up **without** a user_id scope (:347). |

### 1.10 routers/papers.py (prefix `/papers`)

`Paper` model (`models/paper.py:14`), all keys present: `id, user_id, corpus_id, title, authors[], year, doi, filename, status ("pending"\|"extracting"\|"chunking"\|"embedding"\|"complete"\|"error"), extraction_path, error_message, chunk_count, figure_count, tags[{id,name}], uploaded_at, processed_at`.

| Method Path | Auth / RL | Params | Response | Errors / side effects |
|---|---|---|---|---|
| POST `/papers?workspace_id=` :57 (201) | U ; `paper_upload` | multipart field **`file`** (UploadFile, required) | `Paper` (synthetic: id, user_id, filename, status pending, uploaded_at; **corpus_id null** even though one was set) | 400 `Only PDF files are accepted` (filename must end in `.pdf`, case-insensitive). 413 `File exceeds {MAX_UPLOAD_SIZE_MB}MB limit` (Content-Length > max+16384 pre-check, then actual bytes > max). 400 `File is not a valid PDF (magic bytes missing)` (doesn't start with `%PDF-`). 404 `Workspace not found` (workspace_id, **defaulting to DEFAULT_WORKSPACE_ID**, must be owned). 400 `Invalid workspace` (FK). 500 `Failed to store uploaded file` (row deleted, partial file removed). Order: INSERT papers (file_path '') -> storage.save_pdf -> UPDATE file_path -> **Celery** `tasks.ingestion_tasks.process_paper` args `[paper_id]` queue **`ingestion`**. |
| GET `/papers?workspace_id=` :185 | U | - | `list[Paper]` with tags aggregated, `uploaded_at DESC` LIMIT 500 | - |
| GET `/papers/{paper_id}` :217 | U | - | `Paper` (tags always `[]`) | 404 `Paper not found` |
| DELETE `/papers/{paper_id}` :237 (204) | U | - | empty | 404 `Paper not found`. DELETE ... RETURNING; if no papers remain in that corpus, DELETE feeds for the corpus. storage.delete_paper_artifacts. Audit `paper.delete`/paper/{id}/{filename,corpus_id}/204 |
| GET `/papers/{paper_id}/figures` :289 | U | - | `[{id,page_number,image_url,extraction_type,description,claim_summary,figure_index}]` ordered by figure_index; `image_url` = storage.figure_image_url (local: `/figures/{pid}/{fid}?token=...`, TTL 600) | Empty list if not owned (no 404). |

### 1.11 routers/personas.py (prefix `/personas`)

| Method Path | Auth / RL | Body | Response | Errors / side effects |
|---|---|---|---|---|
| GET `/personas` :22 | U | - | `[{key,handle,name,initials,color,avatar_url,bio}]` where `is_active` ORDER BY sort_order | - |
| GET `/personas/{key}/stats` :40 | U | - | `{"persona_key","reply_threads":int}` | - |
| GET `/personas/{key}/replies` :64 | U | - | `[{feed_id,post_index,message_index (0-based),content,thread_generated_at,parent_post (full post obj or {})}]` (interjections by this persona) LIMIT 100 | - |
| GET `/personas/{key}/dm` :132 | U | - | no row: `{"messages":[],"persona_key"}`; else `{"id","messages":[{role:"user"\|"persona",content}],"persona_key"}` | - |
| POST `/personas/{key}/dm` :151 (200) | U ; `persona_dm` | `PersonaDmRequest{message:str(max 2000)}` | `{"id","messages" (the request-local snapshot plus 2 new turns, NOT re-read from DB),"latest_response"}` | 404 `Persona not found`. **Synchronous API-side LLM call** (sec. 2.9), max_tokens 512, temp 0.7. RAG: top 10 chunks by `plainto_tsquery(message)`, fallback to the 10 latest chunks; each fenced and capped at 300 chars. Upsert persona_dms ON CONFLICT (user_id,persona_key) appending `[user_turn, persona_turn]`. LLM errors are graded via `llm_error_to_http` (sec. 2.9). |
| DELETE `/personas/{key}/dm/{message_index:int}` :274 (**200**) | U | - | `{"messages":[...remaining]}` | 404 `No DM thread with this persona`; 404 `Message index out of range`. `messages - idx`. Audit `persona_dm.delete_message`/persona_dm/-/{persona_key,message_index}/200 |
| DELETE `/personas/{key}/dm` :325 (**200**) | U | - | `{"messages":[]}` | 404 `No DM thread with this persona`. Audit `persona_dm.clear`. |

### 1.12 routers/reading_lists.py (prefix `/reading-lists`)

| Method Path | Auth / RL | Body | Response | Errors / side effects |
|---|---|---|---|---|
| GET `/reading-lists?workspace_id=` :49 | U | - | `[{id,name,paper_count (len paper_sequence),chapter_count,completed_chapters,rationale (array),created_at}]` DESC, **no LIMIT** | - |
| GET `/reading-lists/{list_id}` :97 | U | - | `{id,name,corpus_id,papers:[{id,title,authors,year,rationale (str, "" if none)}] in sequence order (owned only),chapters:[{id,chapter_index,paper_ids[],feed_id\|null,status "locked"\|"unlocked"\|"complete"}],created_at}` | 404 `Reading list not found` |
| POST `/reading-lists` :176 (201) | U ; `feed_generation` | `ReadingListCreate{name:str, corpus_id:str\|null, paper_ids:list[str]\|null}` | `{"id","task_id","paper_count"}` | 404 `Workspace not found`; 404 `One or more papers not found`; 400 `Provide paper_ids or corpus_id`; 400 `Need at least 2 papers for a reading list`. Txn: INSERT reading_lists + `CHAPTER_INSERT_SQL` (`shared/ficino_shared/constants.py:32`; chapter 0 unlocked, rest locked). **Celery** `tasks.reading_list_tasks.propose_ordering` args `[paper_ids, list_id]` kwargs `{user_id}`. The worker writes rationale/paper_sequence; the frontend polls GET detail until some paper has a `rationale`. |
| PUT `/reading-lists/{list_id}/reorder` :253 | U | `ReadingListReorder{paper_sequence:list[str]}` | `{"status":"reordered"}` | 404 list; 422 `Duplicate paper IDs in sequence`; 404 `One or more papers not found`. Txn: UPDATE sequence; DELETE chapters where `feed_id IS NULL`; `max_complete` = MAX(chapter_index where complete) or -1; insert `paper_sequence[max_complete+1:]` via `REORDER_CHAPTER_INSERT_SQL` (:40; index = max_complete + row_num, first one unlocked). |
| PUT `/reading-lists/{list_id}/apply-ordering` :333 | U | `ApplyOrderingRequest{ordered_papers:[{paper_id:str}]}` (extra keys ignored) | `{"status":"applied"}` | 404; 400 `No ordering data`; 422 `Duplicate paper IDs in ordering`; 400 `Ordering must be a permutation of the existing paper list`. Writes `rationale = [{paper_id}]` (model_dump **drops any rationale text the client sent**), wipes all chapters, then CHAPTER_INSERT_SQL. **Frontend never calls this.** |
| POST `/reading-lists/{list_id}/chapters/{chapter_index:int}/generate` :405 (202) | U ; `feed_generation` | - | `{"task_id","status":"queued"}` | 404 `Chapter not found` (both list-not-owned and no chapter); 400 `Chapter is locked. Complete prior chapters first.` **Celery** `tasks.reading_list_tasks.generate_chapter` args `[list_id, chapter_index]` kwargs `{user_id}`. The frontend polls **`GET /feed/status/{task_id}`** for it. |
| DELETE `/reading-lists/{list_id}` :447 (204) | U | - | empty | 404 `Reading list not found`. Audit `reading_list.delete`. |

### 1.13 routers/replies.py (prefix `/replies`). Order: `/conversations` and `/replied-posts/{feed_id}` are declared before `/{feed_id}/{post_index}`.

| Method Path | Auth / RL | Body | Response | Errors / side effects |
|---|---|---|---|---|
| GET `/replies/conversations` :288 | U | - | `[{id,feed_id,post_index,persona_key,message_count,last_user_message (<=100),last_persona_message (<=100),updated_at (isoformat +00:00)}]` `updated_at DESC` LIMIT 100 | - |
| GET `/replies/replied-posts/{feed_id}` :341 | U | - | `[post_index:int]` | - |
| GET `/replies/{feed_id}/{post_index:int}` :357 | U | - | none: `{"messages":[],"persona_key":null}`; else `{"id","messages":[{role:"user"\|"persona"\|"interjection",content,persona?}],"persona_key"}` | - |
| POST `/replies` :380 (200) | U ; `reply` | `ReplyRequest{feed_id:str, post_index:int, persona_key:str, user_message:str(max 2000), post_content:str(max 4000), paper_ref:str\|null(max 500)}` | `{"id","messages" (canonical merged list RETURNING from DB),"latest_response", "interjections":[{persona_key,name,handle,content}]? OR "interjection":{...}?}` (`interjections` when there were @mention hits, else `interjection` if an organic one fired) | 404 `Feed not found`. Grounding (`_load_reply_context_chunks` :25): anchor chunks by `post.sources[*].chunk_id`, drift tsquery on `user_message + post_content[:300]` (<=5), legacy ILIKE on paper_ref, first 5 chunks. **Concurrent LLM calls**: main (512 tok, t 0.7) + up to 3 unique `@handle` mentions (personas.handle = `@x`, excluding persona_key; 256 tok, t 0.8) + an organic interjection only if no mentions and >=2 user turns (`_prepare_interjection` :893: >=2 retrieval_query term hits, then `random()>0.7` means skip, so it fires about 70% of the time). Each call takes its own pool connection. A main-call failure is graded by `llm_error_to_http`; mention/organic failures are dropped. Single upsert `post_replies` ON CONFLICT (feed_id,post_index) appending only new turns. No audit. |
| DELETE `/replies/{feed_id}/{post_index:int}/message/{message_index:int}` :678 (204) | U | - | empty | 404 `Feed not found` / `Reply thread not found` / `Message not found`. `messages - idx`. Audit `reply.delete_message`. |
| POST `/replies/zap` :737 (200) | U ; `reply` (shared) | `ZapRequest{feed_id, post_index:int, target_persona_key, source_persona_key, source_message:str(max 2000), post_content:str(max 4000), paper_ref:str\|null(max 500)}` | `{"id","messages","persona_key" (target),"content"}` | 404 `Feed not found`; 404 `Target persona not found`. One LLM call (256, 0.8), graded errors. Appends `{role:"interjection",persona:target,content}`; a new row uses **source_persona_key** as the thread's persona_key. |

### 1.14 routers/search.py (prefix `/search`)

| Method Path | Auth | Params | Response |
|---|---|---|---|
| GET `/search?q=` :19 | U | `q:str` min_length 1 (422 if missing or empty) | Whitespace-only q returns `{"papers":[],"chunks":[],"posts":[]}` (**no `query` key**). Otherwise `{"query", "papers":[{id,title,authors,year,chunk_count}] (ILIKE escaped on title/filename/authors, complete only, LIMIT 10), "chunks":[{id,paper_id,paper_title,section,content[:300],rank (4dp)}] (tsvector, LIMIT 15), "posts":[{feed_id,post_index,persona,post_type,content[:200],paper_ref,generated_at,rank}] LIMIT 10}`. `SEARCH_USE_NORMALIZED_POSTS=true` (default) uses `feed_posts` tsvector; false falls back to a JSONB scan of the last 20 feeds (no `rank` key). |

### 1.15 routers/settings.py (prefix `/settings`)

| Method Path | Auth | Body | Response | Errors / side effects |
|---|---|---|---|---|
| GET `/settings` :66 | U | - | `merge_settings(user_row)` (DEFAULTS from `shared/.../settings_schema.py:20` with the user dict deep-merged one level for dict values; **user keys not in DEFAULTS pass through, e.g. a worker-written `preferences`**). Under PUBLIC_DEPLOYMENT, baseline env overrides SETTINGS_TO_ENV keys. Secrets (`anthropic_api_key, openai_api_key, voyage_api_key, cohere_api_key`) become `"set"` or `""`. | - |
| PUT `/settings` :93 | U | `SettingsUpdate{settings:dict}` | Same shape as GET (merged, redacted) | Unknown keys (not in DEFAULTS) dropped silently. If `public_deployment` (config bool): PROVIDER_OVERRIDE_KEYS dropped silently. NUMERIC_BOUNDS: `posts_per_generation` int 1..50, `persona_temperature` float 0..1.5, `chunk_max_tokens` int 100..4000 give 422 `"{key} must be a int"` / `"{key} must be between {lo} and {hi}"` (Python `int("5.5")` fails, `int(5.5)` = 5, `float(True)` = 1.0). Txn SELECT FOR UPDATE, then one-level dict merge, then upsert user_settings. **A secret value of "set" sent back gets stored literally** (no guard). |
| GET `/settings/ollama-models` :191 | U | - | `{"llm":[{name,size:"X.YGB",family}], "embed":[...], "vision":[...]}` from `GET {OLLAMA_BASE_URL}/api/tags` (10s). Name containing embed/bge/nomic goes to embed; otherwise llm, and also vision if families or name contain "vision". Any error returns all-empty lists (200). | - |
| POST `/settings/clear-feeds` :233 | U | - | `{"status":"cleared"}` | DELETE feeds (cascades). Audit `feed.clear_all`/feed (status 200 default) |
| POST `/settings/clear-summaries` :248 | U | - | `{"status":"cleared"}` | Audit `summary.clear_all`/paper_summary |
| POST `/settings/clear-user-posts` :266 | U | - | `{"status":"cleared"}` | Audit `user_post.clear_all` |
| POST `/settings/clear-everything` :281 | U | - | `{"status":"cleared","paper_count":int}` | Txn deletes alerts, persona_dms, user_posts, corpus_syntheses, reading_lists, feeds, papers, tags (keeps corpora, user_settings). Then storage cleanup per paper. Audit `account.clear_all`/account/{paper_count} |
| POST `/settings/clear-papers` :342 | U | - | `{"status":"cleared","paper_count":int}` | Txn deletes papers + feeds; storage cleanup. Audit `paper.clear_all` |

### 1.16 routers/tags.py (prefix `/tags`). Only `assign` and `unassign` are used by the frontend.

| Method Path | Auth | Body | Response | Errors / side effects |
|---|---|---|---|---|
| GET `/tags` :16 | U | - | `[{id,name,paper_count}]` ORDER BY name | **unused by frontend** |
| POST `/tags` :37 (201) | U | `TagCreate{name}` | `{"id","name"}` (existing returned, still 201) | 400 `Tag name cannot be empty`. **unused** |
| DELETE `/tags/{tag_id}` :63 (204) | U | - | empty | 404 `Tag not found`; audit `tag.delete`. **unused** |
| POST `/tags/assign` :83 (201) | U | `PaperTagRequest{paper_id,tag_name}` | `{"paper_id","tag_id","tag_name"}` | 400 empty name; 404 `Paper not found`. Get-or-create tag; paper_tags ON CONFLICT DO NOTHING |
| DELETE `/tags/assign/{paper_id}/{tag_id}` :124 (204) | U | - | empty | Idempotent. Audit `tag.unassign`/paper/{paper_id}/{tag_id} |
| GET `/tags/paper/{paper_id}` :154 | U | - | `[{id,name}]` | **unused** |

### 1.17 routers/user_posts.py (prefix `/user-posts`)

UserPost shape: `{id, content, replies (array of {role:"user"\|"archivist"...,content,persona?}), sources (array), status "pending"\|"complete"\|"error", created_at}`.

| Method Path | Auth / RL | Body | Response | Errors / side effects |
|---|---|---|---|---|
| GET `/user-posts?workspace_id=` :22 | U | - | `[UserPost]` DESC LIMIT 50 | - |
| GET `/user-posts/{post_id}` :65 | U | - | `UserPost` | 404 `Post not found` |
| POST `/user-posts` :97 (201) | U ; `user_post` | `UserPostCreate{content:str(max 4000), corpus_id:str\|null}` | `{"id","task_id","status":"pending"}` | 404 `Workspace not found`. INSERT status pending; **Celery** `tasks.archivist_tasks.respond_to_user_post` args `[post_id, corpus_id]` queue persona; on dispatch exception set status 'error' and return **503 `Failed to dispatch Archivist response. Try again.`**; then UPDATE task_id. |
| POST `/user-posts/{post_id}/replies` :153 (202) | U ; `user_post` (shared) | `UserPostFollowUp{content:str(max 4000)}` | `{"id","task_id","status":"pending"}` | 404 `Post not found`; **409 `Previous reply not ready yet`** (atomic append + flip to pending only when status='complete'). **Celery** `tasks.archivist_tasks.respond_to_user_post_followup` args `[post_id]`. No 503 handling here (dispatch failure is a 500, row stuck pending). |
| DELETE `/user-posts/{post_id}` :209 (204) | U | - | empty | 404; audit `user_post.delete` |
| GET `/user-posts/{post_id}/status` :231 | U | - | `{"status": <db column>, "task_id": str or ""}` | 404. **DB-backed, not Celery.** |

### 1.18 routers/users.py (prefix `/users`)

| Method Path | Auth | Params | Response | Errors |
|---|---|---|---|---|
| GET `/users/me` :15 | U | - | `{id,email,display_name,created_at}` | 404 `User not found` |
| GET `/users/me/audit-log?limit=int(100)` :35 | U | limit clamped to [1,500] | `[{id,action,resource_type,resource_id,metadata (**JSON string**),ip,status_code,created_at}]` DESC | - |

### 1.19 routers/workspaces.py (prefix `/workspaces`)

| Method Path | Auth | Body | Response | Errors / side effects |
|---|---|---|---|---|
| GET `/workspaces` :56 | U | - | `[{id,name,paper_count,feed_count,last_activity (max of feed generated_at and paper uploaded_at),created_at}]` `last_activity DESC NULLS LAST` | - |
| POST `/workspaces` :93 (201) | U | `WorkspaceCreate{name}` | `{"id","name"}` | 400 `Workspace name cannot be empty` |
| PUT `/workspaces/{id}` :112 | U | `WorkspaceUpdate{name}` | `{"id","name"}` | 400 empty; 404 `Workspace not found` |
| DELETE `/workspaces/{id}` :133 (204) | U | - | empty | 400 `Cannot delete the default workspace` (id == DEFAULT_WORKSPACE_ID literal); 400 `Cannot delete your only workspace`. Moves papers to the user's earliest corpus (created if none); DELETE is idempotent (a missing id still returns 204 after the guards). Feeds/reading_lists of the deleted corpus follow FK behavior. Audit `workspace.delete`/{moved_papers_to} |
| GET `/workspaces/{id}/activity` :193 | U | - | `[{type:"paper_upload"\|"feed_generation", title, detail ("N chunks · status" / "N posts · M papers[ · Ss]"), timestamp}]` merged, sorted DESC (nulls last), max 20 | 404 `Workspace not found` |

---

## 2. Cross-cutting

### 2.1 Middleware stack (`main.py:76-136`)
Outermost to innermost: **CORS, then CSRF, then SecurityHeaders, then the route.**
- **SecurityHeaders** (`main.py:94`), on every response that reaches it: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`. When `ENVIRONMENT != development`, also `Strict-Transport-Security: max-age=63072000; includeSubDomains` and `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://*.supabase.co`. (CSRF 403s skip these because SecurityHeaders is inner.)
- **CORS**: in dev, origins `http://localhost:3000, :5173, :8000`, credentials, methods/headers `*`. Otherwise origins = `CORS_ORIGINS` split on `,` (default `https://ficino.app,https://ficino.ai`), credentials, methods `GET,POST,PUT,DELETE` (no PATCH), headers `Authorization, Content-Type, X-Requested-With, Accept, X-CSRF-Token`. Same-origin through nginx in practice.

### 2.2 CSRF (`csrf.py`)
- Double-submit. Cookie **`ficino_csrf`**; header **`X-CSRF-Token`** (`x-csrf-token`).
- **Disabled entirely when AUTH_PROVIDER=supabase** (:53). **Enforced for none AND basic.** The frontend comment in `api.ts:73` saying it's skipped under none is wrong.
- Protected methods: POST, PUT, DELETE, PATCH. Exempt (exact path match): `/auth/login`, `/auth/register`.
- Check: cookie and header present and `secrets.compare_digest`. Failure returns 403 body exactly `{"detail":"CSRF validation failed"}` (application/json), before routing (so it applies even to 404 paths).
- Issue: on **GET/HEAD** responses (any status) when the request had no `ficino_csrf` cookie: `token_urlsafe(32)`, `HttpOnly=false`, `SameSite=Lax`, `Secure` iff `ENVIRONMENT != development`, `Max-Age=604800`, `Path=/`, `Domain=COOKIE_DOMAIN` if set. Never rotated while present.
- Frontend: `getCsrfToken()` reads `document.cookie` `ficino_csrf` and adds `X-CSRF-Token` on POST/PUT/DELETE/PATCH (`api.ts:15,76-82`). All requests use `credentials:'include'`.

### 2.3 sanitize.py (shim to `shared/ficino_shared/sanitize.py`)
Prompt-injection hygiene only (no HTML sanitizing of stored data):
- `strip_role_markers(text)`: regex `^[\s>*_#-]*(system|assistant|human|user|ai|instruction)\s*:[ \t]*` (IGNORECASE, MULTILINE) replaced with "".
- `fence_untrusted(text, max_len=8000)`: strip role markers, replace `<untrusted>` with `&lt;untrusted&gt;` and `</untrusted>` likewise, truncate to max_len + `"… [truncated]"`, wrap in `<untrusted>...</untrusted>`; empty input gives `<untrusted></untrusted>`.
- `sanitize_inline(text, max_len=200)`: None gives ""; strip markers, neutralize fences, collapse `\s+` to a space, trim, truncate + `"…"`.
- API use sites: personas DM (chunk content fenced at [:300]; title/section via sanitize_inline), replies (chunks fenced, post_content fenced, mention thread/post, zap convo/post/source msg, interjection convo/post). The worker uses them heavily too.

### 2.4 signed_url.py (shim to `shared/ficino_shared/signed_url.py`)
- Key, resolved **at import**: `SIGNED_URL_KEY` (stripped, utf-8 bytes). If unset and `ENVIRONMENT == "production"` (exact string), RuntimeError. Otherwise key = ASCII bytes of `sha256(DATABASE_URL + "::ficino-figure-salt").hexdigest()` (the 64-char hex string, not the raw digest). Staging-like envs silently use the derived key.
- `sign_resource(resource_id, ttl=600)`: `expires = int(time()) + ttl`; `mac = HMAC-SHA256(key, f"{resource_id}:{expires}")`; token = `f"{expires}.{base64url(mac) with '=' stripped}"`.
- `verify_token(resource_id, token)`: split on the first `.`; int parse; invalid if `expires < now` (equal counts as valid); constant-time compare of the b64 strings.
- resource_id = **figure_id**. URL (local storage) = `/figures/{paper_id}/{figure_id}?token={token}` (relative; the frontend prefixes API_BASE when it's not `^https?://`, `PostCard.tsx:337`, `workspace-download.ts:110`).
- TTLs: `SIGNED_URL_DEFAULT_TTL=600`, `MEDIA_URL_TTL=86400` (`shared/.../constants.py:23`). The worker persists figure URLs with `FIGURE_URL_TTL_SECONDS=3600` (`worker/tasks/persona_tasks.py:28`); the API re-signs at 600 on every `GET /feed/{id}`. The TS signer must be byte-identical if the Python worker keeps signing.

### 2.5 Storage (`storage/__init__.py`, `shared/ficino_shared/storage/*`)
- `STORAGE_PROVIDER` `local` (default) or `supabase` (legacy). Built at import.
- **Local** (`local.py`): PDF at `{UPLOAD_DIR=/app/uploads}/{paper_id}.pdf` (`papers.file_path` = that absolute path). Figures at `{FIGURES_DIR=/app/figures}/{paper_id}/{basename}` (written by the worker; `figures.image_path` = path). `user_id` is ignored. `delete_paper_artifacts` removes the PDF and rmtrees the figure dir (errors swallowed). **`save_audio`/`audio_url`/`save_podcast_episode`/`podcast_episode_url` raise NotImplementedError**, so with local storage feed audio and podcast URLs are always `null`.
- Figures are served only via `GET /figures/...` (sec. 1.7) as `FileResponse image/png`. No static mount for PDFs; PDFs are never served back.
- **Supabase** (`supabase.py`, legacy): bucket `SUPABASE_STORAGE_BUCKET=papers`, keys `{user}/{paper}.pdf`, `{user}/{paper}/figures/{file}`, `{user}/feeds/{feed}/audio/post_{i}.mp3`, `{user}/feeds/{feed}/podcast/episode.mp3`; URLs are absolute Supabase signed URLs (`signedURL`/`signedUrl`).
- The API wraps all storage calls in `asyncio.to_thread`, batched per response.

### 2.6 Rate limiting (`auth/rate_limit.py`)
- Redis `INCR` key, then `EXPIRE window` only when count==1 (a **fixed window from the first hit**, not sliding). The counter keeps climbing while blocked. No decrement on failure.
- Per-user: key `ratelimit:{prefix}:{user_id}`, **skipped entirely when AUTH_PROVIDER=none**. 429 detail: `f"Rate limit exceeded: {max} {prefix} per {window//3600}h. Try again later."` (e.g. `Rate limit exceeded: 20 feed_generation per 24h. Try again later.`).
- Per-IP (`IPRateLimit`): key `ratelimit:{prefix}:ip:{ip}`, ip = `X-Real-IP` (stripped) else socket peer else "unknown". **Always active** (but only mounted on basic routes). 429 `Too many {prefix} attempts. Try again later.`

| Key | Limit (env, default) | Window | Charged by |
|---|---|---|---|
| `paper_upload` | RATE_LIMIT_UPLOADS_PER_DAY 50 | 86400 | POST /papers (dep) |
| `feed_generation` | RATE_LIMIT_GENERATIONS_PER_DAY 20 | 86400 | POST /feed/generate, POST /feed/{id}/regenerate/{i}, POST /reading-lists, POST /reading-lists/{id}/chapters/{i}/generate (all dep, **shared bucket**) |
| `user_post` | RATE_LIMIT_USER_POSTS_PER_DAY 30 | 86400 | POST /user-posts, POST /user-posts/{id}/replies |
| `summary` | RATE_LIMIT_SUMMARY_PER_DAY 30 | 86400 | GET /messages/papers/{id} (imperative, dispatch only), POST /messages/groups (dep) |
| `reply` | RATE_LIMIT_REPLIES_PER_DAY 60 | 86400 | POST /replies, POST /replies/zap |
| `persona_dm` | RATE_LIMIT_PERSONA_DM_PER_DAY 60 | 86400 | POST /personas/{k}/dm |
| `audio` | RATE_LIMIT_AUDIO_PER_DAY 20 | 86400 | POST /feed/{id}/audio, /podcast (imperative, after idempotent short-circuit) |
| `login` (IP) | 5 | 900 | POST /auth/login |
| `register` (IP) | 3 | 3600 | POST /auth/register |

### 2.7 audit.py
`record_audit(db, request, user, *, action, resource_type, resource_id=None, metadata=None, status_code=200)`: INSERT `audit_log(user_id, action, resource_type, resource_id, metadata::jsonb, ip, user_agent[:500], status_code)`. ip = `X-Real-IP` else client host. **Never raises** (logs a warning). Called after the main write (never inside a txn). Actions used: `user.register, user.logout, like.delete, annotation.delete, bookmark.delete (x2 routes), tag.delete, tag.unassign, paper.delete, paper.clear_all, feed.post.delete, feed.post.regenerate, feed.clear_all, summary.clear_all, user_post.delete, user_post.clear_all, account.clear_all, persona_dm.delete_message, persona_dm.clear, reply.delete_message, reading_list.delete, workspace.delete`. Exposed via `GET /users/me/audit-log`.

### 2.8 textutil.py
`escape_like(s)`: `\` to `\\`, `%` to `\%`, `_` to `\_` (in that order). Used in search.py (papers ILIKE) and replies paper_ref fallback. **Not** used in citations.

### 2.9 services/llm.py (API-side LLM; everything else is worker-side)
- API-side LLM endpoints only: `POST /replies` (1 to 5 concurrent calls), `POST /replies/zap`, `POST /personas/{k}/dm`. All other generation (feeds, summaries, syntheses, archivist, reading lists, audio, ingestion, embeddings, rerank, vision, alerts, preferences) runs in Celery workers.
- `get_llm_config(db, user_id)` (:62): base = `settings_schema.DEFAULTS` (env read at import: `LLM_PROVIDER` default `ollama`, `OLLAMA_LLM_MODEL` `qwen3.5:latest`, `ANTHROPIC_API_KEY`, `CLAUDE_MODEL` `claude-sonnet-4-6`), plus `ollama_base_url` from config `OLLAMA_BASE_URL` (default `http://host.docker.internal:11434`, never user-overridable). Then **truthy** `user_settings.settings` values override `llm_provider, ollama_llm_model, anthropic_api_key, claude_model` (lookup `user_id or STUB_USER_ID`). **No PUBLIC_DEPLOYMENT reassert here.**
- Provider: `llm_provider == "ollama"` means Ollama; **anything else means Anthropic**.
- Ollama: `POST {base}/api/chat` `{"model","messages":[{"role":"system","content":system},...],"stream":false,"think":false,"options":{"temperature","num_predict":max_tokens}}`, timeout 120s, 3 attempts with sleeps 2s then 6s, retrying only on `ConnectError`, `ReadTimeout`, 5xx (not ConnectTimeout, not 4xx). Content = `message.content`, or `message.thinking` if content is empty; empty or whitespace raises RuntimeError("LLM returned empty response").
- Anthropic: `AsyncAnthropic(api_key, timeout=120, max_retries=0).messages.create(model, max_tokens, system, messages, temperature)`, returns `content[0].text`.
- `llm_error_to_http` (:22): asyncio.TimeoutError 504 `LLM request timed out. Try again.`; httpx ConnectError/ReadTimeout/ConnectTimeout 503 `LLM provider unreachable. Try again in a moment.`; httpx.HTTPStatusError upstream 4xx 502 `LLM provider rejected our request.`, 5xx 503 `LLM provider error. Try again in a moment.`; ValueError/KeyError/TypeError 400 `Invalid input: {str(exc)[:200]}`; else 500 `Internal error. See server logs.` (Anthropic SDK errors are not httpx errors, so they fall to 500, as does the empty-response RuntimeError.)

### 2.10 config.py env vars (`config.py:8-104`, pydantic-settings, also reads `.env`, extra ignored)
| Env | Default | Used for |
|---|---|---|
| DATABASE_URL | `postgresql://ficino:ficino@postgres:5432/ficino` | pool |
| REDIS_URL | `redis://redis:6379/0` | Celery broker+backend, sessions, rate limits |
| LLM_PROVIDER / OLLAMA_LLM_MODEL / ANTHROPIC_API_KEY / CLAUDE_MODEL | ollama / qwen3.5:latest / "" / claude-sonnet-4-6 | **Settings fields unused by the API** (llm.py reads the same env vars via settings_schema.DEFAULTS) |
| OLLAMA_BASE_URL | `http://host.docker.internal:11434` | llm.py, ollama-models |
| AUTH_PROVIDER | `none` | none/basic/supabase |
| SUPABASE_URL / SUPABASE_JWT_SECRET / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_STORAGE_BUCKET | "" / "" / "" / papers | legacy |
| ALLOW_REGISTRATION | false | basic register |
| RATE_LIMIT_* | see 2.6 | |
| ENVIRONMENT | `development` | docs, CORS, HSTS/CSP, cookie Secure |
| MAX_UPLOAD_SIZE_MB | 50 | upload |
| CORS_ORIGINS | `https://ficino.app,https://ficino.ai` | non-dev CORS |
| COOKIE_DOMAIN | "" | CSRF cookie only (not the session cookie) |
| UPLOAD_DIR / FIGURES_DIR | `/app/uploads` / `/app/figures` | storage, figures route |
| STORAGE_PROVIDER | local | |
| ELEVENLABS_API_KEY | "" | 501 gate on audio/podcast |
| SEARCH_USE_NORMALIZED_POSTS | true | search posts path |
| PUBLIC_DEPLOYMENT | false | `/auth/provider`, PUT /settings lock. GET /settings uses `os.getenv("PUBLIC_DEPLOYMENT") in ("1","true","yes")` instead (pydantic bool also accepts "on"/"y" etc.; minor divergence) |
| Outside Settings | SIGNED_URL_KEY, API_DB_POOL_MIN/MAX_SIZE (or DB_POOL_*), all settings_schema env (EMBED_PROVIDER, VISION_PROVIDER, OLLAMA_EMBED_MODEL `bge-m3:latest`, OLLAMA_VISION_MODEL `gemma4:latest`, VOYAGE_*, COHERE_API_KEY, OPENAI_*, RERANK_*, CONTEXT_*, FIGURE_DETECT_*), PORT | |

### 2.11 Constants
- `STUB_USER_ID = "00000000-0000-0000-0000-000000000000"`, `DEFAULT_WORKSPACE_ID = "00000000-0000-0000-0000-000000000001"` (`shared/.../constants.py:7`; mirrored in `frontend/src/hooks/useWorkspaces.ts:7` and the AuthContext stub user).
- List caps (`constants.py:15-23`): FEEDS 20, CONTENT 50 (user_posts, groups), ALERTS 50, ACTIVITY 100 (conversations, persona replies), PAPER_SUMMARIES 200, LIBRARY 500 (papers, bookmarks), ANNOTATIONS 1000, SEARCH 10, SEARCH_CHUNKS 15.
- `CHAPTER_INSERT_SQL` (`shared/.../constants.py:32`), `REORDER_CHAPTER_INSERT_SQL` (`routers/reading_lists.py:40`).
- Settings schema: `DEFAULTS`, `UI_ONLY_KEYS`, `SETTINGS_TO_ENV`, `NUMERIC_BOUNDS`, `SECRET_KEYS`, `PROVIDER_OVERRIDE_KEYS` (`shared/.../settings_schema.py`). Port it verbatim (the worker shares it).
- **Pagination**: there is none. No cursors or offsets anywhere; every list is a hard LIMIT (above) with fixed ordering. `audit-log` has a `limit` param only.

---

## 3. Auth

Selection (`auth/__init__.py:19-29`): `get_current_user = {none: get_user_none, basic: get_user_basic, supabase: get_user_supabase}[AUTH_PROVIDER]`, fixed at import (ValueError on an unknown value). All routes use `get_current_user` except basic_routes `logout`/`me`, which hard-wire `get_user_basic`. `AuthUser{id:str (local users.id), email:str, display_name:str|None}` (`auth/models.py`).

| Provider | Credential | Behavior |
|---|---|---|
| **none** (`providers.py:25`) | none | Always `AuthUser(STUB_USER_ID, "stub@ficino.dev", "You")`. No 401 path. Rate limits skipped. CSRF still enforced. |
| **basic** (`providers.py:49`) | Cookie **`ficino_session`** | 401 `Not authenticated` if missing; Redis `GET session:{token}`, 401 `Session expired` if absent; **sliding refresh** `EXPIRE session:{token} 604800` on every authenticated request; DB lookup, 401 `User not found`. |
| **supabase** (legacy, `providers.py:124`) | `Authorization: Bearer <jwt>` | 401 `Missing authorization header`; unverified header: if `kid` and alg != HS256, JWKS `{SUPABASE_URL}/auth/v1/.well-known/jwks.json` (1h cache), else HS256 with SUPABASE_JWT_SECRET; `audience="authenticated"`; any failure 401 `Invalid token`; no `sub` 401 `Invalid token: missing sub`. Upsert `users(clerk_id=sub,email)` ON CONFLICT (clerk_id) SET email; if inserted (`xmax=0`), INSERT corpora 'Default'. |

Sessions (basic): token `secrets.token_urlsafe(32)` (43 chars). Redis `SET session:{token} {user_id} EX 604800`. Cookie: `ficino_session`, HttpOnly, SameSite=Lax, Secure iff ENVIRONMENT != development, Max-Age=604800, Path=/, **no Domain** (ignores COOKIE_DOMAIN). The cookie's Max-Age is never refreshed (the server TTL slides, so the browser drops the cookie 7 days after login). Logout deletes the Redis key and `delete_cookie("ficino_session", path="/")`.

Password hashing: `bcrypt.hashpw(pw.encode(), bcrypt.gensalt(rounds=12))`, giving `$2b$12$...` (python bcrypt 5.0.0). Verify `bcrypt.checkpw`. Register enforces 12..72 chars (pydantic counts **characters**, bcrypt's limit is **bytes**). Login is unbounded: python bcrypt 5.x **raises ValueError for >72-byte passwords**, so a long login password is a 500, while node `bcryptjs` truncates. Rows with NULL password_hash (stub/supabase users) give 401.

Endpoints: see sec. 1.1. `/auth/me` (basic) returns `{id,email,display_name}`; `/users/me` (any provider) returns `{id,email,display_name,created_at}`.

**Supabase = legacy-to-drop.** What the frontend still depends on from it:
- `GET /auth/provider` must keep returning `provider` (frontend branches on `'none'|'basic'|'supabase'`) and `public_deployment`.
- If supabase is dropped, the frontend's supabase branch (`AuthContext.tsx:148-190`, OTP/reset flows, `setAuthTokenGetter`, `Authorization` header in `api.ts:68`) becomes dead but harmless.
- **Feed audio + podcast only work with Supabase storage** (local storage raises NotImplementedError). Dropping supabase storage without a local audio implementation (and a route to serve it) permanently nulls `audio_url`/`podcast_audio_url`. ListenView then shows "no audio" once `audio_status='ready'`.
- CSP `connect-src` includes `https://*.supabase.co` (can drop).
- CSRF is skipped under supabase; nothing else differs.

---

## 4. Frontend usage (`frontend/src/lib/api.ts`, plus `auth/AuthContext.tsx`, `lib/workspace-download.ts`, `PostCard.tsx`)

Transport: `fetch(API_BASE + path, {credentials:'include', headers})`. Headers sent: `Content-Type: application/json` on JSON bodies (multipart for upload, set by the browser), `X-CSRF-Token` on mutating methods when the cookie exists, `Authorization: Bearer` under supabase. Non-2xx throws `ApiError(status, "API error {status}: {text}", parsedJson)`; **204 resolves undefined; every other 2xx is `res.json()`**, so a 200/201/202 with an empty body would throw. No EventSource/WebSocket. Only other raw `fetch`: `workspace-download.ts:96` warms figure URLs.

All 79 `export async function`s in api.ts are referenced somewhere in the frontend. Endpoint to caller:

| Endpoint | api.ts fn |
|---|---|
| GET /auth/provider, GET /auth/me, POST /auth/login, /auth/register, /auth/logout | AuthContext.tsx:115,128,217,246,424 |
| POST /papers?workspace_id, GET /papers?workspace_id, DELETE /papers/{id} | uploadPaper, listPapers, deletePaper |
| POST /feed/generate, GET /feed/status/{tid}, GET /feed/{id}, POST /feed/{id}/audio, POST /feed/{id}/podcast, GET /feed?workspace_id, GET /feed?summary=true&workspace_id, POST /feed/{id}/regenerate/{i}, DELETE /feed/{id}/posts/{i} | generateFeed, getFeedStatus, getFeed, requestFeedAudio, requestFeedPodcast, listFeeds, listFeedSummaries, regeneratePost, deletePost |
| GET /replies/conversations, GET /replies/replied-posts/{fid}, GET /replies/{fid}/{i}, POST /replies, DELETE /replies/{fid}/{i}/message/{m}, POST /replies/zap | listReplyConversations, getRepliedPostIndices, getPostReplies, sendReply, deleteReplyMessage, sendZap |
| GET /alerts, /alerts/unread-count, PUT /alerts/{id}/read, PUT /alerts/read-all, DELETE /alerts/{id} | listAlerts, getUnreadCount, markAlertRead, markAllAlertsRead, dismissAlert |
| GET /personas, /personas/{k}/replies, /stats, /dm, POST /dm, DELETE /dm/{m}, DELETE /dm | listPersonas, getPersonaReplies, getPersonaStats, getPersonaDm, sendPersonaDm, deletePersonaDmMessage, clearPersonaDm |
| GET /citations/by-title?title&format | getCitation |
| GET /annotations, PUT/DELETE /annotations/{fid}/{i} | listAnnotations, upsertAnnotation, deleteAnnotation |
| GET /users/me, GET /users/me/audit-log?limit | getMe, listAuditLog |
| GET/PUT /settings, GET /settings/ollama-models, POST /settings/clear-{feeds,summaries,user-posts,papers,everything} | getSettings, updateSettings, getOllamaModels, clearAll* , clearEverything |
| GET /reading-lists?workspace_id, GET /reading-lists/{id}, POST /reading-lists, PUT /reading-lists/{id}/reorder, POST /reading-lists/{id}/chapters/{i}/generate, DELETE /reading-lists/{id} | listReadingLists, getReadingList, createReadingList, reorderReadingList, generateChapter, deleteReadingList |
| GET /user-posts?workspace_id, POST /user-posts, GET /user-posts/{id}, GET /user-posts/{id}/status, DELETE /user-posts/{id}, POST /user-posts/{id}/replies | listUserPosts, createUserPost, getUserPost, getUserPostStatus, deleteUserPost, replyToUserPost |
| GET /search?q | searchCorpus |
| GET/POST /workspaces, PUT/DELETE /workspaces/{id}, GET /workspaces/{id}/activity | listWorkspaces, createWorkspace, renameWorkspace, deleteWorkspace, getWorkspaceActivity |
| GET/POST /bookmarks, DELETE /bookmarks/post/{fid}/{i}?message_index, DELETE /bookmarks/{id} | listBookmarks, createBookmark, deleteBookmarkByPost, deleteBookmark |
| GET /likes/feed/{fid}, POST /likes, DELETE /likes/feed/{fid}/{i}?message_index | listLikesForFeed, createLike, deleteLike |
| POST /tags/assign, DELETE /tags/assign/{pid}/{tid} | assignTag, unassignTag |
| GET /messages/papers/tldrs, GET /messages/papers?workspace_id, GET /messages/papers/{pid}, GET /messages/papers/{pid}/status/{tid}, GET /messages/groups, POST /messages/groups, GET /messages/groups/{id} | getPaperTldrs, listPaperConversations, getPaperSummary, getPaperSummaryStatus, listGroupChats, createGroupChat, getGroupChat |
| GET /figures/{pid}/{fid}?token | `<img src>` built from `post.figure_url` (`PostCard.tsx:337-347`) plus the workspace-download warm fetch |

**Backend endpoints the frontend never calls (possibly dead):**
- `GET /papers/{paper_id}` (papers.py:217)
- `GET /papers/{paper_id}/figures` (papers.py:289). Figure URLs reach the UI only through feed posts.
- `GET /tags`, `POST /tags`, `DELETE /tags/{tag_id}`, `GET /tags/paper/{paper_id}` (tags.py:16,37,63,154). Tags arrive embedded in `GET /papers`.
- `PUT /reading-lists/{list_id}/apply-ordering` (reading_lists.py:333). The worker applies the ordering itself.
- `GET /health`, `/healthz` (infra only, keep). `/docs` and friends (dev only).

Frontend status literals it branches on: feed `status` in `generating|started|complete|error` (`useFeed.ts:96,104`); summary status `complete|error|unknown` (`PaperChat.tsx:120`); group chat `status !== 'generating'`, `'error'` (`GroupChatView.tsx:72,175`); user post `pending|complete|error` (`UserPostCard.tsx:69,194-217`, `useUserPosts.ts:49`); paper `complete|error` (else "processing") (`CorpusPanel.tsx:123`); feed `audio_status`/`podcast_status` `ready|failed` (`ListenView.tsx:306,329,357,363`); POST audio/podcast response `status === 'ready'` (`ListenView.tsx:414,452`); 501 means unavailable; reading-list chapter `locked|unlocked|complete`; reading-list ordering done when any `papers[].rationale` is truthy (`ReadingListDetail.tsx:31`).

---

## 5. Celery task state read by the API (the part pg-boss replaces)

Client: `celery_client.py:10`, `Celery(broker=REDIS_URL, backend=REDIS_URL)`. Worker config (`worker/celery_app.py`): json serializer, **`task_track_started=True`** (so `STARTED` state exists), `acks_late`, prefetch 1, soft/hard time limits 540/600s, default result expiry (Celery default 1 day; after that the state reads back as `PENDING`). Task ids are uuid4 strings returned to the client and sometimes persisted (`user_posts.task_id`, `paper_summaries.task_id`, `corpus_syntheses.task_id`). The worker also uses `self.request.id` for **idempotency** (`uuid5(NAMESPACE_DNS, "ficino:feed:{task_id}")` as feed_id; `_task_id` tags on appended posts; generate_chapter similarly). pg-boss job ids must be stable across retries for the same job.

### 5.1 Every enqueue site
| Route | Task name | args / kwargs | queue | Status surfaced via |
|---|---|---|---|---|
| POST /papers | `tasks.ingestion_tasks.process_paper` | `[paper_id]` | ingestion | **DB** `papers.status` via `GET /papers` (frontend polls the list) |
| POST /feed/generate | `tasks.persona_tasks.generate_feed` | kwargs `{corpus_id, tag_filter, user_id, [append_to_feed_id, tab_focus, persona_key, num_posts]}` | persona | **Celery** `GET /feed/status/{tid}` |
| POST /feed/{id}/regenerate/{i} | `tasks.persona_tasks.regenerate_post` | `[feed_id, post_index]`, `{user_id}` | persona | none (frontend refetches after 4s) |
| POST /feed/{id}/audio | `tasks.audio_tasks.generate_audio_for_feed` | `[feed_id]` | persona | **DB** `feeds.audio_status` via `GET /feed/{id}` |
| POST /feed/{id}/podcast | `tasks.audio_tasks.generate_podcast_for_feed` | `[feed_id]` | persona | **DB** `feeds.podcast_status` via `GET /feed/{id}` |
| GET /messages/papers/{pid} | `tasks.summary_tasks.generate_paper_summary` | `[paper_id]` | persona | **Celery** `GET /messages/papers/{pid}/status/{tid}` + DB row status; **Celery state also used for stuck detection** |
| POST /messages/groups | `tasks.summary_tasks.generate_corpus_synthesis` | `[synthesis_id, paper_ids, name, user_id]` | persona | **DB** `corpus_syntheses.status` via `GET /messages/groups/{id}` |
| POST /user-posts | `tasks.archivist_tasks.respond_to_user_post` | `[post_id, corpus_id]` | persona | **DB** `user_posts.status` via `/user-posts/{id}/status` |
| POST /user-posts/{id}/replies | `tasks.archivist_tasks.respond_to_user_post_followup` | `[post_id]` | persona | DB, same |
| POST /reading-lists | `tasks.reading_list_tasks.propose_ordering` | `[paper_ids, list_id]`, `{user_id}` | persona | **DB** `reading_lists.rationale` via GET detail |
| POST /reading-lists/{id}/chapters/{i}/generate | `tasks.reading_list_tasks.generate_chapter` | `[list_id, chapter_index]`, `{user_id}` | persona | **Celery** via `GET /feed/status/{tid}` (then GET detail for chapter.feed_id) |

(Worker-internal enqueues not from the API: alert_tasks.*, preference_tasks.compute_preferences, beat `check_stale_papers` daily 03:00 UTC.)

### 5.2 `GET /feed/status/{task_id}` (feed.py:127): mapping to reproduce
| Celery state | Response |
|---|---|
| PENDING (also unknown or expired ids) | `{"status":"pending","task_id"}` |
| PROGRESS | `{"status":"generating","task_id","meta": result.info}`, meta = `{"step": "scoping"\|"retrieving"\|"classifying"\|"generating", "feed_id", "post_progress"?: "i/N"}` (`persona_tasks.py:366-573`). Frontend reads `meta.step`, `meta.post_progress`. |
| SUCCESS | `{"status":"complete","task_id","feed_id","post_count","duration_ms"}` from the return dict (generate_feed returns `{status,feed_id,post_count,paper_count,duration_ms}` or `{feed_id,post_count,duration_ms:0,idempotent:true}`; generate_chapter returns `{status,feed_id,post_count}`, so `duration_ms` is null). |
| FAILURE | `{"status":"error","task_id","error": str(exception)}` (frontend shows `error`) |
| other (STARTED, RETRY, REVOKED) | `{"status": state.lower(), "task_id"}`, i.e. `started` (frontend treats it like generating, no meta), `retry` (keeps polling), `revoked` (**frontend polls forever**) |

The frontend stops only on `complete` with a feed_id, or `error` (`useFeed.ts:104`; chapter: `complete|error`, `ReadingListDetail.tsx:147`). Poll cadence 2s after a 1s initial delay, 3s retry on error. generate_feed has `max_retries=2, default_retry_delay=30`, so expect `retry` windows of 30s or more.

### 5.3 `GET /messages/papers/{pid}/status/{tid}` (messages.py:209)
SUCCESS gives `{"status":"complete","paper_id"}`; FAILURE gives `{"status":"error","error":str}`; **everything else (PENDING/STARTED/PROGRESS/RETRY/REVOKED/expired) gives `{"status":"generating"}`**. Frontend terminal: `complete|error|unknown` (`unknown` is never emitted). Note: generate_paper_summary returning `{"status":"exists"}` / `"already_generating"` is still a Celery SUCCESS, so `complete`.

### 5.4 Stuck-task detection in `GET /messages/papers/{pid}` (messages.py:147-160)
If `paper_summaries.status='generating'` and `task_id` is set, read `AsyncResult(task_id).state`; if `FAILURE`, `REVOKED`, or the lookup throws, treat it as no summary and re-dispatch (charging `summary` RL). Celery never reports `UNKNOWN`, and expired or lost results read as PENDING, so **a worker that died before writing a FAILURE result leaves the row "generating" forever** under Celery. The pg-boss equivalent: job state `failed`/`cancelled`, or job missing/archived, should trigger re-dispatch (and arguably `expired` too).

### 5.5 What the TS port must provide instead of AsyncResult
- `getJobState(id)` returning one of: pending (created/retry-scheduled/not found), started (active), progress meta (needs a job-progress store; pg-boss has no `update_state`, so persist `{step, post_progress}` in a table or job `output` while active), completed + result JSON (`feed_id, post_count, duration_ms`), failed + error message string, cancelled.
- Keep the wire literals above exactly (`pending`, `generating`, `started`, `complete`, `error`, plus any passthrough), the `meta` object shape, and `task_id` echoed back.
- Status is read **only** on `/feed/status` (feed + chapter jobs), `/messages/papers/{pid}/status/{tid}`, and the stuck check in `/messages/papers/{pid}`. Every other async flow is DB-column driven, and those columns are written by the worker.

---

## 6. Surprises / things a porter would likely get wrong

1. **CSRF is enforced under AUTH_PROVIDER=none** (only supabase skips it). The cookie is minted on any GET without one; `/auth/login` and `/auth/register` are the only exemptions, so `/auth/logout` needs the header. 403 body is the literal `{"detail":"CSRF validation failed"}`, emitted before routing.
2. **Datetime format differs by endpoint**: pydantic gives `...Z` (no fraction when µs=0) almost everywhere, but `annotations.*` and `replies/conversations.updated_at` use `.isoformat()`, giving `+00:00`. Snapshot-test a few responses.
3. **Feed list returns all media keys as null** (model emits them), and `summary=true` returns `posts: []`, not an omitted field. `GET /feed/{id}` re-signs `figure_url` on every call and adds `audio_url` per post only when `audio_status='ready'`.
4. **`POST /papers` returns `corpus_id: null`** in the synthetic Paper even though the row has one, and defaults workspace to the literal `DEFAULT_WORKSPACE_ID`. Under basic auth that corpus belongs to the stub user, so uploads without `workspace_id` 404.
5. **GET with side effects**: `GET /messages/papers/{id}` enqueues jobs, inserts rows, and can 429.
6. **Rate limits are fixed-window INCR+EXPIRE(first hit)**, shared buckets (`feed_generation` covers 4 routes; `reply` covers 2; `audio` covers 2; `summary` covers 2), skipped under `none`, and charged **before** body validation. Imperative charges (`summary` on GET, `audio`) fire only on the dispatch branch.
7. **Status mapping on `/feed/status` passes unknown Celery states through lowercased** (`started`, `retry`, `revoked`); `pending` covers unknown and expired ids. Summary status collapses everything non-terminal to `generating`. pg-boss state names (`created`, `active`, `completed`, `failed`, `cancelled`, `retry`) must be translated, not passed through.
8. **Progress meta** (`meta.step`, `meta.post_progress`) comes from Celery `update_state`; pg-boss has no equivalent, so it needs an explicit progress store.
9. **Worker idempotency depends on task id stability across retries** (feed_id = uuid5 of task id). pg-boss retries keep the job id; don't mint new ids on retry.
10. **Audio/podcast are Supabase-storage-only**; LocalStorage raises. Dropping Supabase without a local audio path silently disables the Listen feature (URLs null). 501 is driven only by `ELEVENLABS_API_KEY`.
11. **`/figures/...` needs both** a valid HMAC token (checked first, gives 403) **and** an authenticated owner (404). The token is `"{exp}.{b64url-nopad(HMAC-SHA256(key, f'{figure_id}:{exp}'))}"`; the dev key is the *hex string* of sha256(DATABASE_URL+"::ficino-figure-salt"). The key is required only when `ENVIRONMENT=="production"` exactly. The frontend prefixes API_BASE only for relative URLs.
12. **Non-UUID path ids give 500 plain text** (asyncpg DataError), not 404. The frontend never relies on this; returning 404/422 is safe, but don't turn real 404s into 422.
13. **Idempotent-201s**: `POST /bookmarks`, `POST /likes`, `POST /tags` return 201 with `already_*`/existing rows. `DELETE /bookmarks/post/...`, `DELETE /tags/assign/...`, `DELETE /workspaces/{id}` never 404. `DELETE /alerts/{id}` 404s if already dismissed. `PUT /alerts/{id}/read` never 404s. The persona DM DELETEs return **200 with body** (not 204).
14. **Response-shape quirks**: `GET /search` returns no `query` key for whitespace-only q; `GET /personas/{k}/dm` omits `id` when there's no thread; `GET /replies/{fid}/{i}` omits `id` when empty; summary dispatch omits `generated_at`; `task_id` keys appear only while generating; `POST /replies` returns `interjections` (array) **or** `interjection` (object) **or** neither.
15. **`POST /replies` runs up to 5 LLM calls concurrently** (main + 3 @mentions + organic), each on its own DB connection. Organic interjection is random (`random()>0.7` means skip), requires >=2 user turns, and is suppressed if any @handle was typed (even an unknown one). Main-call failure is graded (504/503/502/400/500); side failures are swallowed.
16. **`llm_provider` is binary**: `"ollama"` vs anything else (means Anthropic). User overrides apply only when truthy, and **are not reasserted under PUBLIC_DEPLOYMENT on the API LLM path** (GET /settings does reassert for display). `ollama_base_url` is never user-controlled (SSRF guard).
17. **GET /settings echoes unknown stored keys** (e.g. worker-written `preferences`) and redacts secrets to `"set"`/`""`. A PUT that sends `"set"` back would store it literally. Dict values merge one level deep on write and on read. Numeric coercion is Python `int()`/`float()`, so `int(5.9)` = 5 and `int("5.9")` raises (422).
18. **`GET /users/me/audit-log` returns `metadata` as a JSON-encoded string** (no asyncpg jsonb codec). The frontend types it as an object but doesn't read it. Decide deliberately whether to "fix" it.
19. **`apply-ordering` discards rationale text** (OrderedPaper has only `paper_id`; extra keys are ignored). It's unused by the frontend anyway.
20. **Duplicate ids**: `POST /messages/groups` and `POST /reading-lists` 404 on duplicate paper_ids (count mismatch); reorder/apply-ordering 422 explicitly.
21. **bcrypt**: `$2b$`, cost 12. Python bcrypt 5.x raises on >72-byte passwords at login (500); node libs truncate. The register limit is 12..72 *characters*. The session cookie ignores COOKIE_DOMAIN and its Max-Age isn't refreshed, while the Redis TTL slides.
22. **Registration "first user" check counts all users**, including a stub user left over from a prior `none` run, which would lock registration.
23. **Route order matters** where the shapes overlap: `/messages/papers/tldrs` before `/{paper_id}`; `/replies/conversations` and `/replied-posts/{id}` before `/{feed_id}/{post_index}`. Hono matches in registration order too.
24. **Middleware order**: CORS must wrap CSRF so 403s still carry ACAO. Security headers are not applied to CSRF rejections or 500s (keep or improve; nothing depends on their absence).
25. **Redis is used for three things**: the Celery broker/backend, basic-auth sessions, and rate-limit counters. Replacing Celery with pg-boss doesn't remove Redis unless sessions and rate limits also move (e.g. to Postgres tables with TTL semantics: session sliding 7d, fixed-window counters).
26. **`citations/by-title` does not escape LIKE metacharacters** and has no ORDER BY (nondeterministic match). `format` is echoed verbatim even when unrecognized.
27. **The upload size check** uses Content-Length (with a 16 KiB multipart allowance) and then actual bytes; magic `%PDF-`; the `.pdf` extension check is case-insensitive; nginx caps the body at 50M. Multipart field name is `file`; `workspace_id` is a **query** param, not a form field.

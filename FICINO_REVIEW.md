# Ficino — Round 9 Review

Six-agent parallel audit against HEAD after round 8 (`cb9ae01`). Severity floor: HIGH or CRITICAL only. All findings verified against current source.

## Executive Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 4 |
| HIGH     | 26 |
| Playwright failures | 0 |
| Dep CVEs (HIGH/CRIT) | 0 |

**Top 3 beta blockers**:

1. **Multi-tenant API-key leakage** (C1–C4). Four Celery tasks call `apply_provider_settings()` without threading the paper/feed/post owner's `user_id` through. Under `AUTH_PROVIDER=basic|supabase`, user B's uploads, feeds, and replies run against whatever provider config the `STUB_USER_ID` row has — cross-user billing, wrong model, and unintended use of a shared API key.
2. **Rate-limit bypass via alternate generation paths** (H4). `rate_limit_generations_per_day` is applied only to `/feed/generate`. `generate_chapter`, `regenerate_post`, `create_reading_list`, `create_group_chat`, and `get_paper_summary` all dispatch LLM work without a rate-limit dependency — a user on Claude can drive unbounded paid-LLM spend.
3. **Keyboard users can't manage uploaded papers** (H17). `CorpusPanel`'s paper card header is a `<div onClick>` with no `role`, `tabIndex`, or key handler — keyboard/SR users cannot expand a paper to see errors, manage tags, open summaries, or delete.

## Critical

1. **`generate_feed` runs under STUB_USER_ID's provider settings** — `worker/tasks/persona_tasks.py:291`. `effective_user_id` is resolved at L254 but `apply_provider_settings()` is called with no arg, so the Claude/Voyage/OpenAI keys mounted into `_active_settings` + `os.environ` are whoever owns the stub row. Every downstream `claude_client.generate_persona_post_sync` in the feed bills that key, not the feed owner's.
   *Fix*: `user_settings = apply_provider_settings(effective_user_id)`.

2. **`regenerate_post` runs under STUB_USER_ID's provider settings** — `worker/tasks/persona_tasks.py:674`. Same pattern as #1: `effective_user_id = user_id or STUB_USER_ID` at L672 but L674 passes no arg.
   *Fix*: `user_settings = apply_provider_settings(effective_user_id)`.

3. **`respond_to_user_post` (Archivist) runs under STUB_USER_ID's settings** — `worker/tasks/archivist_tasks.py:140`. `apply_provider_settings()` fires before `post_user_id = str(row["user_id"])` is resolved at L152, so retrieval and generation use stub config.
   *Fix*: reorder — fetch owner row first, then `apply_provider_settings(post_user_id)`.

4. **`process_paper` ingestion (vision + embeddings) runs under STUB settings** — `worker/tasks/ingestion_tasks.py:82`. `apply_provider_settings()` precedes `paper_user_id = str(paper_row["user_id"])` at L88. Vision pages, figure descriptions, and embeddings are billed to stub. A 600-page crafted PDF uploaded by user B can drain user A's Voyage + Claude budgets. The task later uses `get_user_settings(paper_user_id)` correctly at L337 for auto-generate — just missed at task entry.
   *Fix*: reorder the paper fetch before `apply_provider_settings(paper_user_id)`.

## High

### Multi-tenant settings propagation (continued)

5. **`generate_paper_summary` / `generate_corpus_synthesis` never scope settings** — `worker/tasks/summary_tasks.py:96, 223`. Neither task calls `apply_provider_settings` at all. `generate_corpus_synthesis` receives `user_id` (L224) but doesn't use it for settings. Which user's keys get charged depends on task ordering in the prefork child.
   *Fix*: `apply_provider_settings(paper_owner_user_id)` at entry. For `generate_paper_summary`, fetch owner first via `SELECT user_id FROM papers WHERE id=$1`.

6. **`propose_ordering` has no `user_id` in its task signature** — `worker/tasks/reading_list_tasks.py:47, 59` + dispatch `api/routers/reading_lists.py:221-225`. `apply_provider_settings()` at L59 always resolves to stub; paper titles/authors are sent to whichever provider stub is configured for.
   *Fix*: add `user_id` kwarg, pass from the API handler (already has `user.id`), call `apply_provider_settings(user_id)`.

7. **`alert_tasks.check_contradictions` never applies user-scoped settings** — `worker/tasks/alert_tasks.py` (no `apply_provider_settings` import). Classify-contradiction calls bill whichever keys are in `_active_settings` from the previous prefork task.
   *Fix*: fetch `paper.user_id`, call `apply_provider_settings(user_id)` at task entry.

### Rate limits

8. **Rate limits missing on five LLM-heavy endpoints** — `api/routers/messages.py:105` (`get_paper_summary`), `api/routers/messages.py:252` (`create_group_chat`), `api/routers/reading_lists.py:161` (`create_reading_list`), `api/routers/reading_lists.py:352` (`generate_chapter` — ~12 LLM calls), `api/routers/feed.py:222` (`regenerate_post`). None carry a `Depends(RateLimit(...))`. A user on Claude provider can fire unbounded feed-equivalent work; `rate_limit_generations_per_day=20` on `/feed/generate` is trivially bypassed.
   *Fix*: add `RateLimit("feed_generation", settings.rate_limit_generations_per_day)` to `generate_chapter` and `regenerate_post`; `RateLimit("summary", 30)` on `get_paper_summary` and `create_group_chat`.

### Concurrency / write correctness

9. **`generate_feed` append-mode whole-array overwrite** — `worker/tasks/persona_tasks.py:570-579`. Append-mode reads `feeds.posts` into `existing_posts`, appends in memory, writes `SET posts = $1` — two concurrent appenders (user clicks "Generate more" twice, or auto-generate fires during manual append) both snapshot the same array and the second writer clobbers the first. The `_task_id` guard at L271 only catches same-task retries. Same shape as the `post_replies.messages` race round 8 fixed.
   *Fix*: `UPDATE feeds SET posts = posts || $1::jsonb, post_count = jsonb_array_length(posts || $1::jsonb), ... WHERE id = $2 AND user_id = $3` — atomic JSONB concat.

10. **`_create_alert` has no dedupe key — retries and re-ingests produce duplicate alerts** — `worker/tasks/alert_tasks.py:25-38` + `infra/postgres/init.sql:207-219`. Plain INSERT; no UNIQUE on `alerts`. With `task_acks_late=True` + SIGKILL at time-limit, re-delivery fires a fresh `retries=0` run that re-INSERTs whichever alerts already landed. Users see identical "Contradiction detected" / "Go deeper" alerts piling up.
   *Fix*: add `dedupe_hash` column + `UNIQUE(user_id, alert_type, dedupe_hash)` (content-hash for bodies, or metadata-hash for contradiction pairs); `ON CONFLICT DO NOTHING` on insert.

11. **`generate_chapter` orphans feeds and burns LLM spend on retry** — `worker/tasks/reading_list_tasks.py:230, 322-333`. Task generates a fresh `feed_id` at L230, runs N LLM calls, INSERTs a `feeds` row, UPDATEs chapter pointer. With `max_retries=2`, any transient failure after the LLM loop re-runs the whole thing — new `feed_id`, new feeds row, fresh LLM spend. Previous row is orphaned. ~$0.30–$1.00 wasted per retry on Claude.
   *Fix*: check if chapter already has a `feed_id` + matching feeds row; short-circuit with `{"status": "exists"}`. Or pin `feed_id` to `uuid5(task_id)` and gate the LLM loop behind an "if posts already generated" check backed by a scratch Redis key.

12. **`generate_corpus_synthesis` retry raises `UniqueViolationError`, strands user** — `worker/tasks/summary_tasks.py:278-292`. No `ON CONFLICT` on `INSERT INTO corpus_syntheses`. Re-delivery after a crash re-runs the INSERT against the same synthesis_id, crashes on PK, exhausts retries. No API path to re-dispatch; the task_id never resolves for the polling client.
   *Fix*: `ON CONFLICT (id) DO UPDATE SET messages = EXCLUDED.messages, generated_at = NOW()`. Add a top-of-task idempotency guard (short-circuit if `jsonb_array_length(messages) > 0`).

13. **`get_paper_summary` strands users on `status='error'` with no re-dispatch path** — `worker/tasks/summary_tasks.py:200-214` + `api/routers/messages.py:131-160`. Task sets `status='error'` on max_retries exhaustion. API handler's `if summary:` branch returns the error row without the dispatch fallback. User sees a permanent error state with no retry button and no polling path that re-dispatches.
   *Fix*: in `get_paper_summary`, treat `status='error'` the same as the stuck-generating branch (null out `summary`, fall through to dispatch). Or add explicit `POST /messages/papers/{paper_id}/regenerate`.

### React / client

14. **`useFeed.pollStatus` stale `workspaceId` closure** — `frontend/src/hooks/useFeed.ts:77-120`. `useCallback(..., [])` with empty deps captures the first-render `workspaceId`. After a workspace switch, generation-complete handlers call `cacheFeed(feed, workspaceId)` with the STALE workspaceId — the freshly generated feed is invisible offline in the current workspace. Round 8 added the arg but left the stale-closure source.
   *Fix*: `}, [workspaceId])` on the pollStatus useCallback deps.

15. **`useLikes` unmount-during-fetch race across feed switches** — `frontend/src/hooks/useLikes.ts:9-26`. `useEffect` fires `listLikesForFeed(feedId)` with no `active` sentinel or cleanup. Switching from feed A (slow) to feed B (fast): B resolves first, then A's stale response overwrites. UI shows wrong like state until next switch.
   *Fix*: classic `let active = true; ...; return () => { active = false }` around the `.then`, matching `useFeed.loadLatest` at L38-75.

### Performance

16. **`list_feeds` ships every feed's full `posts` JSONB** — `api/routers/feed.py:259-296`. Returns up to 20 feeds with each feed's full `posts` array (~300–800 KB). Only `feeds[0].posts` and per-feed metadata are consumed. ~500 ms of wasted transfer + JSON parse on mobile per workspace switch / generation-complete.
   *Fix*: split into a lightweight metadata list + a separate `GET /feeds/{id}` for the current feed; or `SELECT ... LEFT JOIN LATERAL (SELECT posts FROM feeds WHERE id = f.id LIMIT 1) WHERE rn = 1`.

17. **`check_contradictions`: 24 serial LLM calls + N+1 chunk fetch per paper upload** — `worker/tasks/alert_tasks.py:94-138`. Up to 8 "other papers" × 3 classifications = 24 serial `classify_contradiction_sync` calls. Each other paper also triggers its own `SELECT content FROM chunks WHERE paper_id=$1` (N+1). Worst-case ~17s on Claude, 60s+ on Ollama, blocking the `persona` queue and delaying auto-generate. Also uncapped paid-LLM spend per upload.
   *Fix*: single batched `WHERE paper_id = ANY($1) GROUP BY paper_id` query; `asyncio.gather` (bounded concurrency 4) over pairs; reduce pair-count target and paper-count fanout (≤3 papers × 1 pair).

18. **`retrieve_for_persona` runs 6 sequential query embeddings per feed generation** — `worker/tasks/persona_tasks.py:359-365` + `worker/lib/retrieval.py:66`. The feed loop iterates 5–6 personas, each calling `retrieve_chunks` which internally calls `embed_single_sync`. 6 × ~400 ms = ~2.4s of serial embedding round-trips per feed gen.
   *Fix*: hoist — collect `{persona_key: retrieval_query}`, call `embed_texts_sync(list(queries.values()))` once, pass precomputed vectors into a new `retrieve_chunks_by_vector(vec, paper_ids, top_k)`.

19. **`_get_liked_paper_titles` N+1 full JSONB fetch** — `worker/tasks/preference_tasks.py:136-171`. For each distinct liked `feed_id`, pulls full `feeds.posts` JSONB just to read `paper_ref` / `sources[].paper_title` at the liked indices. ~600 KB Python-side for a user with 30 liked feeds, re-run on every feed completion.
   *Fix*: push projection into SQL — `SELECT DISTINCT elem->>'paper_ref' FROM feeds f JOIN user_likes ul ON ul.feed_id = f.id, jsonb_array_elements(f.posts) WITH ORDINALITY AS t(elem, ord) WHERE ul.user_id = $1 AND (ord - 1) = ul.post_index`.

### Accessibility (WCAG 2.1 AA, blocking core flows)

20. **`CorpusPanel` paper card header is `<div onClick>`, no keyboard affordance** — `frontend/src/components/Sidebar/CorpusPanel.tsx:133`. WCAG 2.1.1. Keyboard/SR users cannot expand a paper to see ingestion errors, add tags, open summary, or delete — blocks the whole paper-management flow.
   *Fix*: replace the wrapping `<div>` with `<button type="button">`; set `aria-expanded={expanded}`; `aria-hidden` on the chevron.

21. **Feed generation-failure panel is not announced** — `frontend/src/components/Feed/Feed.tsx:127`. WCAG 4.1.3. The `role="status"` spinner above goes silent on error; SR users never learn generation failed.
   *Fix*: `role="alert" aria-atomic="true"` on the error div, with "Feed generation failed: {error}" in the text.

22. **Persona DM input has no accessible name** — `frontend/src/components/Personas/PersonaProfile.tsx:246`. WCAG 4.1.2 / 3.3.2. Placeholder only — SR users hear "edit" with no hint. Blocks the DM core flow.
   *Fix*: `aria-label={`Message ${p.name}`}`.

23. **`UserPostCard` Archivist-error branch not announced** — `frontend/src/components/Feed/UserPostCard.tsx:176`. WCAG 4.1.3. Pending and complete states are in live regions; the `error` branch is a plain `<div>`. After posting, SR users hear "searching…" then silence.
   *Fix*: `role="alert" aria-atomic="true"` on the error div (or a sibling sr-only alert).

24. **`WorkspaceDropdown` trigger missing label / aria-expanded / aria-haspopup** — `frontend/src/components/Nav/WorkspaceDropdown.tsx:39`. WCAG 4.1.2. SR users hear just the workspace name, no hint it opens a menu or switches workspaces.
   *Fix*: `aria-label={`Switch workspace (current: ${active.name})`}`, `aria-haspopup="menu"`, `aria-expanded={open}`; `role="menu"` on panel, `role="menuitem"` on each item.

### LLM safety / output validation

25. **`_parse_ordering_json` returns whatever `json.loads` yields, incl. dicts — crashes task** — `worker/tasks/reading_list_tasks.py:352-374`, caller L117, L125. If the LLM returns `{"ordering": [...]}` or similar, the caller's `{item.get("paper_id", "") for item in ordering}` iterates dict keys and raises `AttributeError`. Reading-list creation stays in a dead state.
   *Fix*: in `_parse_ordering_json`, assert `isinstance(parsed, list)` and every element is a dict; otherwise fall through and return `[]`.

26. **`generate_paper_summary` / `generate_corpus_synthesis` don't validate JSON shape** — `worker/tasks/summary_tasks.py:166-184, 267-277`. After `re.search(r'\[.*\]', ...).group(0)` + `json.loads`, the parsed value could be a list of ints, strings, or mixed. No shape check before persisting to `paper_summaries.messages` JSONB. Frontend consumers (`messages->-1->>'content'`, `message.role`) render empty or crash on `.content`.
   *Fix*: assert `isinstance(messages, list)` and filter to dicts with `role` + `content: str`; else fall through to the single-bubble fallback.

27. **`generate_chapter` posts skip `validate_post_shape`** — `worker/tasks/reading_list_tasks.py:282-313`. The parallel path in `persona_tasks.generate_feed` (L556) calls `validate_post_shape(post_data, persona_key=...)` before append; reading-list chapter generation does not. Malformed LLM output (missing `content`, wrong `post_type`, non-list `thread_posts`) lands verbatim in `feeds.posts` and renders as broken cards.
   *Fix*: import and call `validate_post_shape(post_data, persona_key=persona_key)` at L311 before `posts.append`.

28. **Figure description has no per-paper cap** — `worker/lib/pdf_extractor.py:235-286` + `worker/lib/figure_describer.py:53-70`. Round 8 capped vision page extraction at 100 pages, but per-figure description is uncapped — a crafted PDF with 2,000 embedded bitmaps above the size threshold triggers 2,000 Claude Vision calls at `max_tokens=1024`. ~$10 per upload; 50 uploads/day/user → ~$500/user/day on the shared key.
   *Fix*: `MAX_FIGURES_PER_PAPER` (default 50) in `extract_figures` and truncate before returning.

29. **Ollama vision paths have no retry; `_describe_ollama` silently stores empty description** — `worker/lib/vision_extractor.py:82-111` and `worker/lib/figure_describer.py:73-89`. Round 8 added 3-attempt backoff to `_embed_ollama` and an empty-content raise to `_extract_page_ollama`, but the figure-describer equivalents were missed. One transient blip on page 47 of 100 aborts the whole paper; a 200 response with whitespace content lands a blank figure description with no error.
   *Fix*: wrap `client.post` in the same 3-attempt exponential-backoff used in `_generate_ollama`; raise `RuntimeError("ollama vision returned empty content for figure")` on whitespace-only response.

30. **`api/services/llm.py` Claude path uses the SDK's default 2-retry × 120s = 360s worst-case wait** — `api/services/llm.py:88-100`. `anthropic.AsyncAnthropic(timeout=120.0)` sets per-request timeout but not `max_retries=0`; a flapping endpoint ties up a FastAPI worker for up to 360s per call. Five concurrent `/replies` requests from one user can pin 5 of 10 uvicorn workers.
   *Fix*: `anthropic.AsyncAnthropic(api_key=..., timeout=120.0, max_retries=0)`.

## Playwright Failures

None. All core flows that could be exercised passed:

- Upload PDF → feed ingestion end-to-end: **PASS**
- Reply composer @mention autocomplete: **PASS**
- Compose → Archivist reply with citations: **PASS** (Archivist replied with 5 citations, ~20s on Ollama)
- Workspace switch: **SKIPPED-NO-FIXTURE** (only 1 workspace seeded; UI static validation passed in `review.spec.ts`)
- AUTH_PROVIDER=basic login: **SKIPPED-NO-FIXTURE** (running stack is `AUTH_PROVIDER=none`; no seeded user)

New spec: `tests/e2e/round9_core_flows.spec.ts`. Combined runtime ~34s.

## Dropped During Dedup

4 findings dropped below the severity floor or merged into primary-domain entries: one unauth endpoint that leaks only public model names; one task-status endpoint protected by opaque UUIDs; one borderline N+1 with <500ms impact; one polish-level a11y duplicating an already-visible error message.

## Dep Audit

`pip-audit` (api + worker) and `npm audit` (frontend): **0** HIGH/CRIT vulnerabilities across all three manifests. Round 1–6 upgrades (python-multipart, PyJWT, Pillow, pymupdf, serialize-javascript override) verified in place.

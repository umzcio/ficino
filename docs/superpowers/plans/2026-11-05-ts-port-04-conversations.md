# TS Port 04 — Conversations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port everything conversational:
- the API-side LLM service and its error grading;
- persona replies (`POST /replies`, with @mentions and organic interjections), zap, and the reply thread routes;
- persona DMs and the rest of `/personas`;
- paper summaries and group-chat syntheses (the `/messages` routes, including the stuck-job check, and their two
  worker jobs);
- archivist user posts (the `/user-posts` routes and their two worker jobs).

After this plan, every route in C §1.9, §1.11, §1.13 and §1.17 is served by the TS API, and every queue in W §2.6
and §2.9 has a handler.

**Architecture:**

*API side.* Three routes call the LLM synchronously: the persona DM, the reply and the zap. They go through one
API-side chat client (`generateChat`, 120 s per attempt, 3 attempts) and one grading function (`llmErrorToHttp`).
Provider settings are resolved once per request for the caller and passed to every call in it. This mirrors the
worker's per-job `ProviderConfig`.

*Pure prompt builders.* Every prompt the three routes send is built by a pure function in
`src/conversations/prompts.ts`. Those functions are pinned to goldens produced by running the real Python handlers
inside the `ficino-api` image. DB access sits in the route and in `src/conversations/grounding.ts`. Randomness (the
organic interjection) takes the injected `Rng`.

*Worker side.* The worker gains four handlers: `generate_paper_summary`, `generate_corpus_synthesis`,
`respond_to_user_post` and `respond_to_user_post_followup`. Their queues already exist with the right retry policy
(`src/jobs/registry.ts`). `JobContext` gains `isFinalAttempt`, so the summary jobs can mark their row `error` only
when retries are exhausted, as Python did.

**Tech Stack:** Plans 01–03 dependencies only. **No new npm dependencies.**

**Spec:** `docs/superpowers/specs/2026-10-29-typescript-port-design.md`. Reference abbreviations:
- **C §x** is `ts-port-reference/api-contract.md`.
- **W §x** is `ts-port-reference/worker-inventory.md`.

The carry-forward docs are the `2026-10-29-ts-port-01`, `2026-11-02-ts-port-02` and `2026-11-04-ts-port-03`
`-carryover.md` files. Where this plan says "port X", the Python file it names is the source of truth for every
string, number, branch and SQL statement this plan doesn't pin. Read it. The Python sources are:

| Area | Python file |
|---|---|
| API-side LLM service | `api/services/llm.py` |
| DMs and the rest of `/personas` | `api/routers/personas.py` |
| Replies and zap | `api/routers/replies.py` |
| Summaries and group chats | `api/routers/messages.py` |
| User posts | `api/routers/user_posts.py` |
| Request models | `api/models/requests.py` |
| Summary and synthesis jobs | `worker/tasks/summary_tasks.py` |
| Archivist jobs | `worker/tasks/archivist_tasks.py` |

## Global Constraints

- **Workspace.** Work on branch `ts-port/04-conversations` in a worktree at `<worktree>`, based on
  local `main` (`1212588` or later). Never modify `api/`, `worker/`, `shared/`, `frontend/` or `tests/e2e/`. You may
  read them, and you may run them inside the `ficino-api` and `ficino-worker` images to make goldens (see
  `server/test/fixtures/goldens/gen/README.md`). Run `npm ci` in `server/` first.
- **Earlier plans' rules still apply:**
  - Code: ESM, strict TS, NodeNext, everything in `server/`.
  - SQL: parameterized only.
  - Literals: wire literals copied exactly, including every `detail` string.
  - jsonb: writes go through `sql.json(...)`. Appends use `col || ${sql.json(arr)}`, never a read-modify-write.
  - Nothing reads `process.env` after boot. `ollamaBaseUrl` comes from config only.
  - Router mounting: never mount a router at `/` with `use('*', requireUser)`.
  - Validation order: a route's rate limit runs before its validators.
  - New int params use `pyInt` and must match the param-fill regex in `test/api/routes-auth.test.ts`.
  - Commits are authored as `umzcio <umzcio@users.noreply.github.com>` and end with
    `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Python strings.** Every `[:N]` cap (80, 90, 100, 200, 300, 500, 8000, 10000) is a code-point slice
  (`pySlice`). Pydantic `max_length` counts code points: use the new `pyMaxLen(n)` (Task 1), not `z.string().max`.
  `str.strip()`/`str.split()`/`str.lower()`/Unicode `\s` and `\w` go through `src/shared/pystr.ts` (`PY_WS`,
  `PY_WORD`). A Python f-string that prints a value Python could hold as `None` prints `None` (`pyStr`).
- **Timestamps.** Pydantic-serialized fields use `toPydanticIso` (a `Z` suffix). `GET /replies/conversations`
  `updated_at` is `.isoformat()` (`+00:00`) and uses `toIsoformat`. Both are in `src/db/time.ts`.
- **jsonb reads.** postgres.js parses jsonb, so there is no `json.loads` branch. Do not double-parse.
- **No module-level mutable state.** Personas are read per request or per job.
- **Randomness.** The organic interjection's `random.random()` goes through the injected `Rng` (`AppDeps.rng`,
  default `Math.random`).
- **Handlers return plain objects** and never a lone `{ value: x }`.
- **No new listeners or ports.** Tests reach Postgres on 127.0.0.1 only. The manual Ollama smoke (Task 11) talks
  to this host's Ollama on `127.0.0.1:11434`.

## Deliberate changes from Python (each pinned by a test)

1. **The API-side LLM path resolves settings with `providerConfig`.** That is the same per-call resolution the
   worker uses, so under `PUBLIC_DEPLOYMENT` a non-empty operator env var wins on replies, zaps and DMs too. Python's
   `get_llm_config` let a user override it there. Task 1.
2. **A per-request LLM timeout is graded 503 `LLM provider unreachable. Try again in a moment.`** This is the same
   answer Python gave for an httpx `ReadTimeout`. Python's 504 branch (`asyncio.TimeoutError`) had no source:
   nothing wrapped `generate_response` in `wait_for`. The 504 mapping is kept for an explicit `LlmDeadlineError`,
   which nothing in this plan throws. Task 1.
3. **The organic-interjection candidate query orders by `sort_order`.** Python had no `ORDER BY`, so ties fell to
   heap order. Task 6.
4. **A follow-up whose dispatch fails marks the post `error` and returns 503
   `Failed to dispatch Archivist response. Try again.`** This matches the create path. Python returned 500 and left
   the post `pending` forever. Task 10.
5. **The archivist answers clearly when every in-scope chunk was embedded with another model.** Plan 03's retrieval
   guard (deliberate change 2 there) would otherwise make it say "No relevant passages found", which is quietly
   wrong. Task 9 stores a canned reply instead and marks the post `complete`:
   `None of your papers are searchable with the current embedding model (<model>): <n> chunks in scope use a
   different one. Re-process your papers or switch the embedding model back.` A partly mismatched corpus answers
   normally and logs `embed_model_mismatch`.

## Review Focus

1. **Two users' synchronous LLM calls never cross keys or models.** User A and user B have different stored
   providers and keys. They send a DM and a reply at the same time. Every LLM call made for A carries A's key and
   model, and every call for B carries B's. Pinned in Tasks 4 and 6.
2. **A dead or failed job never leaves a forever-spinner.** Each of these re-dispatches, or shows `error`:
   - A summary row says `generating`, but its job is `failed`, `cancelled` or `missing` (including a legacy Celery
     task id from restored data). The next `GET /messages/papers/{id}` re-dispatches and charges `summary` once.
   - A summary or synthesis job exhausts its retries. Its row becomes `error`.
   - A user-post dispatch fails. The post becomes `error` and the route returns 503.

   Pinned in Tasks 7, 8 and 10.
3. **A failed synchronous LLM call returns a graded status and writes nothing.** A main-reply failure leaves
   `post_replies` unchanged. A DM failure leaves `persona_dms` unchanged. A zap failure appends nothing. A failed
   @mention or organic interjection is dropped, while the main reply is still stored. Pinned in Tasks 4 and 6.
4. **Garbage LLM output never becomes an empty or malformed summary.** For each of these inputs, the stored row is
   `complete` with one fallback bubble, never `[]`:
   - prose with no JSON
   - an array of bare strings
   - output that is only `<think>…</think>`
   - an array whose objects lack `content`
   - JSON that is cut off

   Pinned in Task 7.
5. **Hostile text cannot reshape a prompt or blow up a request.**
   - Chunk, post and user text containing `</untrusted>` stays fenced.
   - A message with ten @handles costs at most 3 extra LLM calls.
   - A hallucinated `Author (YYYY)` citation is stripped.
   - A DB archivist prompt containing a stray `{` fails the job, as Python's `.format` did; no silent substitution.

   Pinned in Tasks 2, 6 and 9.

---

### Task 1: API-side LLM service, error grading and the seams

**Files:**
- Modify: `server/src/providers/llm.ts`, `server/src/app.ts`, `server/src/api/main.ts`,
  `server/src/http/validate.ts`, `server/test/helpers/client.ts`, `server/test/helpers/fakeProviders.ts`
- Create: `server/src/conversations/llm.ts`
- Test: `server/test/providers/chat.test.ts`, `server/test/conversations/llm.test.ts`,
  `server/test/api/main.test.ts` (extend), `server/test/http/validate.test.ts` (extend)

**Interfaces:**
- Produces in `src/providers/llm.ts` (port of `api/services/llm.py` `generate_response` and
  `_post_ollama_chat_with_retry`):
  - `type ChatMessage = { role: 'user' | 'assistant'; content: string }`
  - `type ChatRequest = { system: string; messages: ChatMessage[]; temperature: number; maxTokens: number; signal?: AbortSignal }`
  - `generateChat(p: ProviderConfig, deps: ProviderDeps, req: ChatRequest): Promise<string>`. `p.llm.provider ===
    'ollama'` means Ollama. **Anything else means Anthropic**, as in Python (C §6.16). The worker's `generateText` is
    unchanged.
    - Ollama: `POST {ollamaBaseUrl}/api/chat` with
      `{model, messages: [{role:'system',content:system}, ...messages], stream:false, think:false, options:{temperature, num_predict:maxTokens}}`.
      Each attempt has a 120 000 ms timeout. Run it under `withRetry` with 3 attempts, delays `[2000, 6000]`, and
      `retryable: isTransient`. The result is `message.content`, else `message.thinking`. Empty or whitespace
      (`pyStrip`) throws `Error('LLM returned empty response')`.
    - Anthropic: `deps.anthropic(key, {maxRetries: 0, timeoutMs: 120_000}).messages.create({model: claudeModel, max_tokens, system, messages, temperature})`.
      The result is `content[0].text`. A missing text throws `Error('Anthropic response has no text content')`.
- Produces in `src/conversations/llm.ts`:
  - `class LlmDeadlineError extends Error {}`. Nothing in this plan throws it (deliberate change 2).
  - `llmErrorToHttp(e: unknown, event: string, logger: Logger): HttpError`. It ports `llm_error_to_http`:

    | Error | Status | `detail` | Log reason |
    |---|---|---|---|
    | `LlmDeadlineError` | 504 | `LLM request timed out. Try again.` | `timeout` |
    | `NetworkError`, or name `TimeoutError` | 503 | `LLM provider unreachable. Try again in a moment.` | `llm_unreachable` |
    | `HttpStatusError` 4xx | 502 | `LLM provider rejected our request.` | `llm_http_error`, with `upstream_status` |
    | `HttpStatusError` other | 503 | `LLM provider error. Try again in a moment.` | `llm_http_error`, with `upstream_status` |
    | `TypeError` or `SyntaxError` | 400 | `` `Invalid input: ${pySlice(message, 0, 200)}` `` | `bad_input` |
    | anything else | 500 | `Internal error. See server logs.` | logged at `error` with `error_type` |

    Every row except the last logs at `warn`, with `{error, reason}` under the given event name.
  - `type ApiLlm = { chat(req: Omit<ChatRequest, 'signal'>): Promise<string> }`
  - `apiLlm(deps: ResolvedAppDeps, userId: string): Promise<ApiLlm>`. It does one `loadStoredSettings(sql,
    userId || STUB_USER_ID)`, then `providerConfig(stored, env, config)` (deliberate change 1), and returns a client
    bound to that config and `deps.providers`.
- Produces in `app.ts`:
  - `AppDeps` gains optional `providers?: ProviderDeps` and `rng?: Rng`.
  - `type ResolvedAppDeps = AppDeps & { providers: ProviderDeps; rng: Rng }`. `AppEnv.Variables.deps` becomes
    `ResolvedAppDeps`. `createApp` fills the defaults (`defaultProviderDeps()` and `Math.random`), so routes read
    `c.var.deps.providers` and `c.var.deps.rng` directly.
- Produces in `api/main.ts`: `startApi(rawEnv, overrides?: { providers?: Partial<ProviderDeps>; closeGraceMs?: number })`.
  This is the plan 01 carry: `close()` has no force-close timeout. After `closeGraceMs` (default 10 000), `close()`
  calls `server.closeAllConnections()`, so a hung 120 s LLM request can't stall shutdown.
- Produces in `validate.ts`: `pyMaxLen(n: number)`, a `z.string()` refined on `pyLen(s) <= n` with the message
  `String should have at most ${n} characters`.
- Produces in `test/helpers`:
  - `testApp` accepts `providers?: ProviderDeps` and `rng?: Rng`.
  - `fakeProviders`:
    - `ChatInfo` gains `messages` (the non-system messages), `maxTokens` and `temperature`.
    - `ChatPurpose` gains `summary`, `synthesis`, `archivist`, `dm`, `reply`, `mention`, `interjection` and `zap`.
      Each is detected by a substring of its system prompt, checked before `persona`. The prompts built in Tasks 2,
      7 and 9 must contain these texts verbatim; every one is copied from the Python source:

      | Purpose | System prompt contains |
      |---|---|
      | `summary` | `You are a research paper summarizer` |
      | `synthesis` | `You are an academic synthesis engine` |
      | `archivist` | `FORMATTING: Use real line breaks.` |
      | `dm` | `You are having a direct conversation with a user about their research corpus.` |
      | `reply` | `You are replying to a user in a conversation about an academic paper.` |
      | `mention` | `You were tagged in a conversation thread by a user.` |
      | `interjection` | `You are jumping into an existing conversation thread` |
      | `zap` | `You were called in to respond to a specific point made by` |
    - `defaultChat` returns a two-message JSON array for `summary` and `synthesis`, and plain prose for the rest.

- [ ] **Step 1: Write the failing tests.**
  - `chat.test.ts`. These are the ports of `api/tests/test_llm_retry.py`, run with a fake `fetch` and a recording
    `sleep`:
    - Two 503s, then a 200: it returns the content and slept `[2000, 6000]`.
    - Three 503s: it throws an `HttpStatusError` with status 503.
    - One 404: there is one call and no sleep.
    - A `fetch` that rejects once, then a 200: it succeeds.
    - A 200 with `{"message":{"content":"  "}}`: it throws `LLM returned empty response`.
    - Content falls back to `thinking`.
    - The request body equals the payload above, with the system message first.
    - The provider `api` with a key calls the fake Anthropic with `maxRetries: 0`, `timeoutMs: 120000` and
      `temperature`.
    - An unknown provider, `banana`, also goes to Anthropic.
  - `conversations/llm.test.ts`:
    - One case per row of the `llmErrorToHttp` table, asserting status and `detail`. This ports the seven
      `test_error_contracts.py` mapping tests. For the event-name test, the same error under two event names grades
      the same.
    - A `TypeError` with a 300-character message keeps 200 code points.
    - Deliberate change 1: `apiLlm` for a user whose stored settings say `llm_provider: ollama, ollama_llm_model: m1`
      sends model `m1`. With `env.PUBLIC_DEPLOYMENT=true` and `env.OLLAMA_LLM_MODEL=envm`, it sends `envm`.
  - `main.test.ts`: start the API with `closeGraceMs: 200`. Open a raw TCP socket and write
    `GET /health HTTP/1.1\r\nHost: x\r\n`, with no final CRLF, so the request stays active. `close()` resolves in
    under 2 s.
  - `validate.test.ts`: `pyMaxLen(3)` accepts `'😀😀😀'` (6 UTF-16 units) and rejects `'abcd'`.
- [ ] **Step 2: Run them.** They fail.
- [ ] **Step 3: Implement.** Keep the existing callers of `createApp` compiling (`test/routes/settings.test.ts`,
  `test/routes/papers.test.ts`, `test/http/errors.test.ts`); the new fields are optional.
- [ ] **Step 4: Run the full suite.** `cd server && npm test` passes, and `npm run typecheck` is clean.
- [ ] **Step 5: Commit** with the message
  `feat(server): API-side chat client, LLM error grading, close grace, pyMaxLen`.

### Task 2: Conversation prompt builders (`src/conversations/prompts.ts`) and their goldens

**Files:**
- Create: `server/src/conversations/prompts.ts`, `server/test/fixtures/goldens/gen/conversation_prompts.py`,
  `server/test/fixtures/goldens/conversation-prompts.json`
- Modify: `server/test/fixtures/goldens/gen/README.md`
- Test: `server/test/conversations/prompts.test.ts`

**Interfaces:**
- Consumes: `ChatMessage` and `ChatRequest` (Task 1); `fenceUntrusted` and `sanitizeInline`; `Rng`; `pySlice`,
  `pyStrip`, `pyStr` and `PY_WORD`.
- Produces these types:
  - `type ConvoMessage = { role: string; content: string; persona?: string }`, a stored thread turn.
  - `type PersonaMeta = { persona_key: string; name: string; handle: string }`.
  - `type LlmPlan = Omit<ChatRequest, 'signal'>`.
  - `type PersonaRow = { key: string; name: string; handle: string; system_prompt: string; retrieval_query?: string | null }`.
- Produces these functions. Each one ports the f-string it names, byte for byte.

  | Function | Ports | Max tokens / temp |
  |---|---|---|
  | `dmChunksText(chunks: Array<{content: unknown; section: string \| null; paper_title: string \| null}>): string` | `personas.py` `chunks_text`, with each content capped at 300 before fencing; `''` when there are no chunks | n/a |
  | `dmPlan(persona: {system_prompt; name; handle}, chunksText: string, history: ConvoMessage[]): LlmPlan` | the DM `system`; `history` already ends with the new user turn; `user` maps to `user`, anything else to `assistant` | 512 / 0.7 |
  | `replyChunksText(chunks: Array<{section: string \| null; content: unknown}>): string` | `_load_grounding` `chunks_text` (`[section]\n<fenced>`, joined by `\n\n`) | n/a |
  | `replyMainPlan(o: {personaPrompt: string; postContent: string; chunksText: string; history: ConvoMessage[]}): LlmPlan` | `create_reply` `grounding_note`, `system` and `llm_messages`; an interjection becomes a user turn `[<persona or "another persona"> interjected]: …` | 512 / 0.7 |
  | `mentionedHandles(userMessage: string): string[]` | `re.findall(r'@(\w+)')`, deduped in first-seen order, first 3; `\w` is `PY_WORD` | n/a |
  | `mentionPlan(o: {mentioned: PersonaRow; history: ConvoMessage[]; postContent: string; chunksText: string}): LlmPlan & {meta: PersonaMeta}` | `mention_system` and `mention_prompt` (thread `history.slice(-6)`, post capped at 200) | 256 / 0.8 |
  | `interjectionPlan(rng: Rng, o: {candidates: PersonaRow[]; history: ConvoMessage[]; postContent: string; chunksText: string}): (LlmPlan & {meta: PersonaMeta}) \| null` | `_prepare_interjection` from the scoring on (the caller runs the query) | 256 / 0.8 |
  | `zapPlan(o: {target: PersonaRow; sourceName: string; history: ConvoMessage[]; postContent: string; sourceMessage: string; chunksText: string}): LlmPlan` | `zap_grounding`, `zap_system` and `zap_prompt` (thread `history.slice(-4)`, post capped at 500) | 256 / 0.8 |
- `interjectionPlan` keeps Python's control flow exactly:
  - It returns `null` when `candidates` is empty.
  - A candidate counts when at least 2 of its comma-split, `pyStrip`ped, lower-cased `retrieval_query` terms occur
    in the lower-cased, space-joined history. An empty term counts as a hit, as Python's `'' in s` does.
  - A candidate with a null `retrieval_query` makes the whole function return `null`, because Python's
    `AttributeError` was caught by the outer `except`. Log `interjection_prepare_failed`. To do that, the function
    takes an optional `logger` as a third parameter.
  - It returns `null` with no rng call when no candidate counts.
  - Otherwise it calls `rng()` **exactly once**. `> 0.7` returns `null`. Below that it picks the highest score;
    ties keep candidate order, because the sort is stable.
- Speaker labels in the thread summaries are `User` for `user` turns, else the turn's `persona`, else `Persona`.
- The builders' system prompts contain the `dm`, `reply`, `mention`, `interjection` and `zap` substrings from
  Task 1's purpose table.

- [ ] **Step 1: Write the golden generator.** `gen/conversation_prompts.py` runs in the `ficino-api` image. Add the
  docker command to `gen/README.md`. It is the `ficino-worker` command with `api/` mounted at `/src/api` and
  `PYTHONPATH=/src/api:/src/shared`. The script imports `routers.personas` and `routers.replies` and calls the real
  handler coroutines (`send_persona_dm`, `create_reply`, `zap_response`) with:
  - a `FakeDb` whose `fetchrow`, `fetch`, `fetchval` and `execute` answer by SQL substring from canned rows;
  - `AuthUser` objects;
  - `_rl=None`.

  It patches the following:

  | Patched | Behavior |
  |---|---|
  | `routers.replies._llm_call_with_fresh_conn` and the `generate_response` name in both modules | record `{system, messages, max_tokens, temperature}` and return `R<n>` |
  | `routers.replies._load_conversation_and_sources` and `_load_reply_context_chunks` | return the case's canned thread, sources and chunks |
  | `random.random` | the case's value |

  It writes `conversation-prompts.json` as `[{name, kind, input, calls, response}]`. Here `input` holds every
  canned value the builders need, and `response` is the handler's return value with `id` removed.

  Cases:
  - **DM:**
    - chunks with a `None` title and a `None` section
    - no chunks at all (`No papers in corpus yet.`)
    - a prior thread of 2 turns
    - a chunk of 400 code points with `é` and `</untrusted>`
  - **Reply:**
    - no chunks (the second `grounding_note`)
    - chunks plus a thread containing an interjection, with and without `persona`
    - `@Skeptic @skeptic @a @b @c` (dedupe and the cap of 3) with two known handles and one unknown
    - an unknown-only handle (no organic, because a handle was typed)
    - an organic interjection that fires (rng 0.5, two candidates tied at score 2, so the first wins)
    - an organic skip (rng 0.9)
    - a single user turn (no organic)
    - a candidate with `retrieval_query` `None`
  - **Zap:**
    - a known source
    - an unknown source (the key is used as the name)
    - an empty thread (no `Thread context:` line)
    - no chunks
- [ ] **Step 2: Run it** in the image and commit the JSON. Check by eye that at least one prompt per kind contains
  the fenced `&lt;/untrusted&gt;` escape.
- [ ] **Step 3: Write the failing test.** For every golden case, call the matching builders on `input`. The plans,
  in Python's call order (main, then mentions, then organic), must equal `calls`: system, messages, max tokens and
  temperature. For interjection cases, pass the rng as `() => input.random`, and assert the rng is called once when
  there are candidates and zero times when there are none. Extra unit cases for `mentionedHandles`:
  - `'@Ünïcode_1 x'` gives `['Ünïcode_1']`.
  - `'a@b'` gives `['b']`, as Python's findall does.
- [ ] **Step 4: Implement** until the goldens pass.
- [ ] **Step 5: Run the full suite and the typecheck.**
- [ ] **Step 6: Commit** with the message `feat(server): conversation prompt builders pinned to Python goldens`.

### Task 3: Reply grounding (`src/conversations/grounding.ts`)

**Files:**
- Create: `server/src/conversations/grounding.ts`
- Test: `server/test/conversations/grounding.test.ts`

**Interfaces:**
- Consumes: `escapeLike` (`src/shared/textutil.ts`); `replyChunksText` (Task 2); `ConvoMessage` (Task 2).
- Produces:
  - `type ReplyChunk = { id: string; section: string | null; content: string; paper_id: string; paper_title: string | null; paper_filename: string | null }`
  - `loadReplyContextChunks(sql: Sql, o: {userId: string; postSources: Array<Record<string, unknown>>; postContent: string; userMessage: string; paperRef: string | null}): Promise<ReplyChunk[]>`.
    This ports `_load_reply_context_chunks` with all four layers in order, deduped by id, insertion-ordered:
    1. Anchor chunks: `chunk_id`s from the sources, owner-scoped.
    2. The `paper_ref` ILIKE fallback, only when no paper id was resolved. The ref is cut at `' et al'` if present,
       else to its first 30 code points, then passed through `escapeLike`.
    3. Drift: tsquery over `userMessage + ' ' + postContent[:300]` (stripped), at most 5 rows.
    4. The legacy fallback: the first 5 chunks by `chunk_index`, only when nothing else was found.
  - `loadGrounding(sql, o): Promise<{ chunks: ReplyChunk[]; chunksText: string }>`. It takes the same `o` and adds
    `replyChunksText`.
  - `loadConversationAndSources(sql: Sql, userId: string, feedId: string, postIndex: number): Promise<{ replyId: string | null; messages: ConvoMessage[]; postSources: Array<Record<string, unknown>> }>`.
    This ports `_load_conversation_and_sources`:
    - The thread is read by `(feed_id, post_index)`.
    - The post's `sources` are read from `feeds.posts[postIndex]` scoped to the owner, keeping only dict entries.
    - An out-of-range index gives `[]`.

- [ ] **Step 1: Write the failing tests** against a seeded DB. Use two papers for user A and one for user B, with
  chunks that have `search_vector` filled (insert through the same SQL `src/ingest/store.ts` uses, or set
  `search_vector = to_tsvector('english', content)`).
  - Anchors resolve by `chunk_id`. A `chunk_id` of user B's chunk is ignored.
  - Drift adds at most 5 more chunks from the anchors' paper, never from the other paper, and an anchor isn't
    duplicated.
  - With no sources and `paperRef` `'Smith et al. 2024'`, the ILIKE resolves `Smith`. `paperRef` `'50%_off'` is
    escaped, so it matches only a title containing that literal text.
  - With no drift hit, the legacy layer returns the first 5 chunks by `chunk_index`.
  - With no sources and no `paperRef`, the result is `[]` and `chunksText` is `''`.
  - `loadConversationAndSources`:
    - A feed of user B gives empty sources, but its thread is still read; Python's thread read is unscoped and the
      route checks ownership first.
    - Non-dict sources are dropped.
    - `postIndex` 99 gives `[]`.
- [ ] **Step 2: Run them.** They fail.
- [ ] **Step 3: Implement.** Copy each SQL statement from Python, changing only the placeholders to postgres.js
  binds.
- [ ] **Step 4: Run the full suite and the typecheck.**
- [ ] **Step 5: Commit** with the message `feat(server): reply grounding loaders`.

### Task 4: `/personas` (list, stats, replies, DM get/send/delete/clear)

**Files:**
- Create: `server/src/routes/personas.ts`
- Modify: `server/src/app.ts` (mount `/personas`)
- Test: `server/test/routes/personas.test.ts`

**Interfaces:**
- Consumes: `apiLlm` and `llmErrorToHttp` (Task 1); `dmChunksText` and `dmPlan` (Task 2); `userRateLimit`,
  `recordAudit`, `pyInt`, `pyMaxLen` and `LIMITS.ACTIVITY`.
- Produces `personasRoutes(): Hono<AppEnv>` with the routes of C §1.11. All of them are behind `requireUser`.

  | Route | Behavior |
  |---|---|
  | `GET /` | `key, handle, name, initials, color, avatar_url, bio`, active only, in `sort_order` |
  | `GET /:persona_key/stats` | `{persona_key, reply_threads}`; the count is cast `::int` |
  | `GET /:persona_key/replies` | port the LATERAL query, `LIMIT ${LIMITS.ACTIVITY}`; `content` is `?? ''`; `thread_generated_at` goes through `toPydanticIso`; `parent_post` is `?? {}` |
  | `GET /:persona_key/dm` | no row: `{messages: [], persona_key}` (no `id`); else `{id, messages, persona_key}` |
  | `POST /:persona_key/dm` | `userRateLimit('persona_dm')`, then `body({message: pyMaxLen(2000)})`, then the order below |
  | `DELETE /:persona_key/dm/:message_index` | `pyInt`; 404 `No DM thread with this persona`, then 404 `Message index out of range` for `< 0` or `>= n`; the update is `messages - ${idx}::int`; returns **200** `{messages}`; audit `persona_dm.delete_message`, `persona_dm`, metadata `{persona_key, message_index}` |
  | `DELETE /:persona_key/dm` | 404 `No DM thread with this persona` when nothing was deleted; **200** `{messages: []}`; audit `persona_dm.clear`, metadata `{persona_key}` |

- `POST /:persona_key/dm` runs in this order:
  1. Read the thread.
  2. Append the user turn locally.
  3. Look up the persona (`is_active`), or return 404 `Persona not found`.
  4. Run the tsquery chunk query, with the 10-latest fallback, both owner-scoped and `status = 'complete'`.
  5. Build the plan with `dmPlan`, call `apiLlm(...).chat`, and on a throw raise `llmErrorToHttp(e, 'persona_dm_failed')`.
  6. Upsert `ON CONFLICT (user_id, persona_key)` appending `sql.json([userTurn, personaTurn])`, `RETURNING id`.
  7. Respond `{id, messages: <local snapshot + persona turn>, latest_response}`.

- [ ] **Step 1: Write the failing tests.**
  - `GET /personas` returns the seeded actives in order, with exactly those 7 keys.
  - stats and replies are scoped to the caller: a thread on user B's feed is not counted, and user B's
    interjections are not listed.
  - replies: `message_index` is 0-based. `parent_post` is the full post, or `{}` when the index is past the end.
    Only `role: interjection` turns with a matching `persona` are listed.
  - DM send: run with `fakeProviders`. The first send creates the row; the second appends.
    - The second LLM call's messages are `[user, assistant, user]`.
    - The response `messages` has 4 turns.
    - A message of 2001 code points gives 422.
    - An unknown persona gives 404 `Persona not found`, and with `AUTH_PROVIDER=basic` it still used up a
      `persona_dm` slot.
    - The limit: with `rateLimits.persona_dm: 1` under basic, the second send is 429.
  - DM grounding: when the message's terms match a chunk of user A, the system prompt contains it. When the
    message is `hi`, the system prompt contains the latest paper's first chunk. User B's chunks never appear.
  - Review Focus 3: when the fake Ollama answers 503 three times, the response is 503
    `LLM provider error. Try again in a moment.` and `persona_dms` is unchanged (no row on a first send; the same
    messages on a later one).
  - Review Focus 1: give A and B different stored settings (A `llm_provider: api` with key `ka`, B `api` with
    `kb`; the fake Anthropic delays 50 ms). Send their DMs concurrently, each with a distinct message. Every
    recorded Anthropic call whose last user message is A's carries `ka`, and every one with B's message carries
    `kb`.
  - Delete message: these port the two `test_wave3_correctness` delete tests and the two `test_error_contracts`
    clear tests.
    - Index 1 of 3 leaves turns 0 and 2.
    - `-1` and `3` give 404 `Message index out of range`.
    - No thread gives 404 `No DM thread with this persona`.
    - There are audit rows for both deletes.
    - Clear gives 200 `{messages: []}`, then a second clear gives 404.
- [ ] **Step 2: Run them.** They fail.
- [ ] **Step 3: Implement and mount.**
- [ ] **Step 4: Run the full suite** (including `routes-auth.test.ts`, which must now see the `/personas` routes
  gated) **and the typecheck.**
- [ ] **Step 5: Commit** with the message `feat(server): /personas routes and persona DMs`.

### Task 5: `/replies` reads and message delete

**Files:**
- Create: `server/src/routes/replies.ts`
- Modify: `server/src/app.ts` (mount `/replies`)
- Test: `server/test/routes/replies-read.test.ts`

**Interfaces:**
- Produces `repliesRoutes(): Hono<AppEnv>`. This task registers the read and delete routes; Task 6 adds
  `POST /` and `POST /zap` to the same router. Register in this order: `/conversations`, then
  `/replied-posts/:feed_id`, then `/:feed_id/:post_index` (C §1.13 route order).

  | Route | Behavior |
  |---|---|
  | `GET /conversations` | port the query with its two LATERAL previews, `LIMIT ${LIMITS.ACTIVITY}`; `updated_at` via `toIsoformat` (`+00:00`) or `null`; `feed_id` as a string |
  | `GET /replied-posts/:feed_id` | `number[]`, scoped through the feed join |
  | `GET /:feed_id/:post_index` | `pyInt`; none: `{messages: [], persona_key: null}`; else `{id, messages, persona_key}` |
  | `DELETE /:feed_id/:post_index/message/:message_index` | 404 `Feed not found`, then 404 `Reply thread not found`, then 404 `Message not found`; `messages - ${idx}::int` (no `updated_at` change, as in Python); **204**; audit `reply.delete_message`, `reply`, metadata `{feed_id, post_index, message_index}`, status 204 |

- [ ] **Step 1: Write the failing tests.** These port `test_auth_scoping` `test_list_replies_conversations_scoped`,
  `test_get_replies_by_feed_scoped` and `test_get_replied_posts_scoped`.
  - Each route as user B on user A's feed returns the empty shape or a 404.
  - `conversations`: `last_user_message` and `last_persona_message` are the **latest** of each role, capped at 100.
    An interjection doesn't count as a persona turn. `updated_at` ends in `+00:00`.
  - Delete: a middle index works, and an out-of-range index gives 404 `Message not found`.
  - The path `/replies/conversations` is not swallowed by `/:feed_id/:post_index`: it returns 200 with a list.
- [ ] **Step 2: Run them.** They fail.
- [ ] **Step 3: Implement and mount.**
- [ ] **Step 4: Run the full suite and the typecheck.**
- [ ] **Step 5: Commit** with the message `feat(server): /replies read and delete routes`.

### Task 6: `POST /replies` and `POST /replies/zap`

**Files:**
- Modify: `server/src/routes/replies.ts`
- Test: `server/test/routes/replies-post.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2 and 3.
- `POST /`. The middleware is `userRateLimit('reply')`, then a body of `{feed_id: string, post_index: pyInt,
  persona_key: string, user_message: pyMaxLen(2000), post_content: pyMaxLen(4000), paper_ref: pyMaxLen(500).nullish()}`.
  It ports `create_reply` in this order:
  1. Check the feed is owned by the caller, or return 404 `Feed not found`.
  2. Call `loadConversationAndSources` and record `initialLen`.
  3. Push the user turn.
  4. Read the persona prompt (`is_active`), falling back to `` `You are ${persona_key}` ``.
  5. Call `loadGrounding` with `user_message`.
  6. Build `replyMainPlan`.
  7. Build the mention plans: one SQL lookup per handle, `handle = '@' || h`, `is_active`, `key <> persona_key`.
     A miss is skipped.
  8. Plan an organic interjection only when `mentionedHandles(...)` is empty and the history has at least 2 user
     turns. Query `key, name, handle, system_prompt, retrieval_query` of the active personas except `persona_key`,
     `ORDER BY sort_order` (deliberate change 3), then call `interjectionPlan(c.var.deps.rng, ...)`.
  9. Make one `apiLlm` for the caller, and run main, mentions and organic through `Promise.allSettled`.
  10. If main was rejected, raise `llmErrorToHttp(e, 'reply_generation_failed')`. Nothing has been written.
  11. Walk the results in order:
      - main is pushed as `{role:'persona', content}`;
      - each fulfilled mention is pushed as `{role:'interjection', persona: key, content}` and collected as
        `{...meta, content}`;
      - a rejected mention logs `mention_interjection_failed`;
      - the organic interjection is handled the same way, logging `interjection_failed` on a rejection.
  12. Upsert `ON CONFLICT (feed_id, post_index)` appending `sql.json(history.slice(initialLen))`,
      `RETURNING id, messages`.
  13. Respond `{id, messages: <RETURNING messages>, latest_response}`, plus `interjections` when any mention landed,
      else `interjection` when the organic one did. Status 200.
- `POST /zap`. The middleware is `userRateLimit('reply')`, then a body of `{feed_id, post_index: pyInt,
  target_persona_key, source_persona_key, source_message: pyMaxLen(2000), post_content: pyMaxLen(4000),
  paper_ref: pyMaxLen(500).nullish()}`. It ports `zap_response`:
  1. Check the feed, or return 404 `Feed not found`.
  2. Look up the target (`is_active`), or return 404 `Target persona not found`.
  3. Look up the source name (not filtered on `is_active`), falling back to the key.
  4. Load the thread and sources, then call `loadGrounding` with `source_message`.
  5. Build `zapPlan` and make one call, graded with `'zap_failed'`.
  6. Write: with an existing row, `UPDATE … messages || …, updated_at = now() WHERE id` and push the turn locally.
     Otherwise use the upsert with **`source_persona_key`** as the row's persona, and take `messages` from
     `RETURNING`.
  7. Respond `{id, messages, persona_key: target.key, content}`.

- [ ] **Step 1: Write the failing tests** with `fakeProviders`. The reply in each test is keyed by `ChatInfo.purpose`.
  - First reply: a row is created, `messages` is `[user, persona]`, and there is no `interjection(s)` key.
  - Mentions:
    - `@<seeded handle without @>` and a second known handle produce exactly 3 LLM calls.
    - The response `interjections` has 2 entries, in mention order.
    - The stored row ends `[user, persona, interjection, interjection]`.
    - Ten distinct known-or-unknown handles produce at most 4 LLM calls (Review Focus 5).
  - A mention of the replying persona's own handle is not looked up as a mention: it is excluded by
    `key <> persona_key`.
  - Organic: on a thread with a prior user turn, with an rng of `() => 0.5`, and with conversation text that hits
    two of a seeded persona's `retrieval_query` terms, the response has `interjection`. With `() => 0.9` it doesn't.
  - Review Focus 3:
    - When main fails with a fake 400, the response is 502 `LLM provider rejected our request.` and `post_replies`
      is unchanged.
    - When main succeeds and a mention's call throws, the response is 200 without that mention, and the main reply
      is stored.
  - These port `test_error_contracts` `test_create_reply_main_persona_timeout_maps_to_504` and `…_bad_input_maps_to_400`:
    - A fake Ollama fetch that throws a `TimeoutError` gives **503** (deliberate change 2; note it in PORTING).
    - A 200 whose body is not JSON gives 400 `Invalid input: …`.
  - Concurrency: two replies sent at the same time to the same post (the fake delays 50 ms) both land, and the
    final row has 4 turns.
  - Review Focus 1 for replies: replies from A and B sent at the same time carry their own keys, as in Task 4.
  - Zap:
    - An existing thread gets one appended interjection.
    - With no thread, a row is created whose `persona_key` is the source's key.
    - An unknown target gives 404 `Target persona not found`.
    - A feed of user B gives 404 `Feed not found`.
    - A zap failure appends nothing.
  - Rate limits: `/replies` and `/replies/zap` share the `reply` bucket under basic (limit 1: the zap after a
    reply is 429). A 422 body still uses up a slot.
- [ ] **Step 2: Run them.** They fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite and the typecheck.**
- [ ] **Step 5: Commit** with the message `feat(server): POST /replies with mentions and interjections, zap`.

### Task 7: Summary and synthesis jobs (`src/tasks/summary.ts`)

**Files:**
- Create: `server/src/tasks/summary.ts`, `server/src/conversations/summaryParse.ts`,
  `server/test/fixtures/goldens/gen/summary_tasks.py`, `server/test/fixtures/goldens/summary-tasks.json`
- Modify: `server/src/jobs/context.ts`, `server/src/worker/main.ts`, `server/src/worker/handlers.ts`,
  `server/test/fixtures/goldens/gen/README.md`
- Test: `server/test/tasks/summary.test.ts`, `server/test/conversations/summaryParse.test.ts`,
  `server/test/jobs/context.test.ts` (extend)

**Interfaces:**
- Produces in `context.ts`: `JobContext.isFinalAttempt: boolean`. `makeJobContext` gains a `retryLimit: number`
  argument and sets `isFinalAttempt = job.retryCount >= retryLimit`. `worker/main.ts` passes
  `overrides.queueOverrides?.[name]?.retryLimit ?? QUEUES[name].retryLimit`.
- Produces in `summaryParse.ts` (port of the inline parsing in `summary_tasks.py`):
  - `PAPER_SUMMARY_SYSTEM`, `PAPER_SUMMARY_PROMPT`, `SYNTHESIS_SYSTEM`, `SYNTHESIS_PROMPT`. The two prompts are
    exported as functions: `paperSummaryPrompt(title: string, chunks: string)` and `synthesisPrompt(paperChunks: string)`.
    Python's `{{`/`}}` become single braces.
  - `coerceMessages(parsed: unknown): Record<string, unknown>[]`. It keeps plain objects whose `content` is a
    non-empty string.
  - `parseChatMessages(raw: string, fallbackRole: 'paper' | 'synthesis', emptyContent: string): { messages: Record<string, unknown>[]; warning: 'parse_failed' | 'parse_empty' | null }`.
    It works in four steps:
    1. Strip `<think>…</think>` (non-greedy, dotall), then `pyStrip`.
    2. Take the greedy `[ … ]` span (`/\[[\s\S]*\]/`).
    3. `JSON.parse` it, then `coerceMessages`. A parse error gives `[{role, type:'summary', content: cleaned}]` and
       `parse_failed`.
    4. An empty result gives `[{role, type:'summary', content: cleaned || emptyContent}]` and `parse_empty`.
    `emptyContent` is `(no content returned)` for summaries and `(no content)` for syntheses.
- Produces in `tasks/summary.ts`:
  - `generatePaperSummary(data: {paper_id: string}, ctx, deps)`. It ports the guard and the body:
    - The guard returns `{status:'exists', paper_id}` when the row is `complete`. It returns
      `{status:'already_generating', paper_id}` when the row is `generating` with a `task_id` other than
      `ctx.jobId`.
    - A missing paper throws `Paper <id> not found`; no chunks throws `No chunks found for paper <id>`.
    - Settings come from `loadJobSettings` for `paper.user_id || STUB_USER_ID`.
    - Take the first 30 chunks by `chunk_index`. Each renders as `` `[${pyStr(section).toUpperCase()}]\n${fenceUntrusted(content)}` ``,
      joined with `\n\n`, then cut with `pySlice(…, 0, 8000)` **after** fencing. The title is fenced.
    - Call `ctx.progress({step:'generating', paper_id})`.
    - Call `generateText` with the summary system and prompt, temperature 0.7, max tokens 1536, and `ctx.signal`.
    - Parse, then upsert `paper_summaries` (`complete`, `task_id` NULL, `generated_at = now()` on conflict).
    - Return `{status:'complete', paper_id, message_count}`.
    - On any throw: log `paper_summary_failed`. When `ctx.isFinalAttempt`, run
      `UPDATE … SET status='error', task_id=NULL`; if that update throws, log and swallow it. Then rethrow.
  - `generateCorpusSynthesis(data: {synthesis_id; paper_ids: string[]; name; user_id}, ctx, deps)`. It ports the
    synthesis task:
    - Idempotent skip: a non-empty `messages` returns `{status:'complete', synthesis_id, message_count, idempotent:true}`.
    - Settings come from `data.user_id`.
    - Copy the LATERAL query verbatim.
    - Each paper with contents renders as `` `=== ${fence(title)} ===\n` `` plus lines of
      `` `[${pyStr(section)}]\n${fence(pySlice(content,0,300))}` `` joined with `\n`.
    - None at all throws `No chunks found for any of the papers`.
    - Cut `combined` to 10 000 code points.
    - Call `ctx.progress({step:'synthesizing', synthesis_id})`.
    - Call `generateText` at 0.7 / 1024.
    - Parse with role `synthesis`, then upsert as Python does.
    - On a final failure, mark the row `error`, as above.
  - Both are registered in `HANDLERS`.

- [ ] **Step 1: Write the golden generator.** `gen/summary_tasks.py` runs in the `ficino-worker` image. It patches:
  - `summary_tasks.fetchrow`, `fetch` and `execute`, answered by canned rows and recording every `execute`;
  - `apply_provider_settings`, as a no-op;
  - `claude_client.generate_text_sync`, recording `(system, prompt, kwargs)` and returning the case's raw text;
  - each task's `update_state`, as a no-op;
  - each task's `retry`, which returns `exc`, so `raise self.retry(exc=exc)` re-raises the original exception
    without a broker.

  It calls `generate_paper_summary.run(paper_id)` and `generate_corpus_synthesis.run(...)` for each case and writes
  `summary-tasks.json` as `[{name, task, rows, raw, call, stored_messages, result}]`. `stored_messages` is
  `json.loads` of the upsert's messages argument.

  Summary cases, by raw output:
  - a clean 8-message array
  - prose only
  - `<think>x</think>` only
  - an array of strings
  - objects without `content`
  - a truncated array (`[{"role":"paper","content":"a"`)
  - an array wrapped in prose with a second `[note]` after it (greedy span, which fails to parse)
  - chunks whose content is 9 000 code points with `é`, to test the 8000 cut after fencing

  Synthesis cases:
  - 2 papers, one with no chunks
  - a paper whose chunk is 400 code points
  - all papers without chunks (record the raised message)
- [ ] **Step 2: Run it** and commit the JSON.
- [ ] **Step 3: Write the failing tests.**
  - `summaryParse.test.ts`:
    - Every golden `raw` through `parseChatMessages` gives `stored_messages`.
    - Every golden `call` equals the TS prompt built from the same `rows`.
    - This ports `test_coerce_messages_drops_non_dict_elements`.
  - `summary.test.ts`, against a DB with fake providers and the handler called directly:
    - Guard cases: `complete` gives `exists` and no LLM call. `generating` with another task id gives
      `already_generating`. `generating` with its own id regenerates. `error` regenerates.
    - Review Focus 4: each garbage `raw` stores a `complete` row with one bubble.
    - Final failure: with `isFinalAttempt` false, an LLM throw leaves `generating` and rethrows. With it true, the
      row becomes `error` with `task_id` NULL. This ports
      `worker/tests/test_group_chat_pending_state.py::test_generate_corpus_synthesis_marks_error_on_retry_exhaustion`
      for synthesis; add the summary twin.
    - Synthesis idempotent skip. A synthesis upsert creates the row when the API placeholder is missing.
    - Provider isolation: the LLM call carries the owner's stored model.
  - `context.test.ts`: retry 0 of a limit of 2 is not final; retry 2 is final.
- [ ] **Step 4: Run them.** They fail.
- [ ] **Step 5: Implement.**
- [ ] **Step 6: Run the full suite and the typecheck.**
- [ ] **Step 7: Commit** with the message `feat(server): paper summary and corpus synthesis jobs`.

### Task 8: `/messages` (summaries, the status poll, the stuck check, group chats)

**Files:**
- Create: `server/src/routes/messages.ts`
- Modify: `server/src/feed/status.ts` (export `jobErrorMessage`), `server/src/app.ts` (mount `/messages`)
- Test: `server/test/routes/messages.test.ts`, `server/test/feed/status.test.ts` (extend)

**Interfaces:**
- Produces in `status.ts`:
  - `jobErrorMessage(output: unknown): string`, extracted from the `failed` branch of `feedStatusFromJob`, which now
    calls it.
  - `summaryStatusFromJob(paperId: string, s: JobState)` (C §5.3):

    | Job state | Response |
    |---|---|
    | `completed` | `{status:'complete', paper_id}` |
    | `failed` | `{status:'error', error: jobErrorMessage(output)}` |
    | anything else, including `missing` | `{status:'generating'}` |

  - `isStuckJobState(state: JobState['state']): boolean`. True for `failed`, `cancelled` and `missing` (the plan 02
    and 03 carry).
- Produces `messagesRoutes(): Hono<AppEnv>`, registered in the order of C §1.9 (`/papers/tldrs` before
  `/papers/:paper_id`):

  | Route | Behavior |
  |---|---|
  | `GET /papers?workspace_id=` | port the projection query; `LIMIT ${LIMITS.PAPER_SUMMARIES}`; `title ?? filename`; `authors ?? []`; `last_message_preview` is `pySlice(last, 0, 80)` or `null` for `''`; both timestamps through `toPydanticIso` |
  | `GET /papers/tldrs` | `{paper_id: tldr}` for truthy tldrs |
  | `GET /papers/:paper_id` | the order below |
  | `GET /papers/:paper_id/status/:task_id` | `summaryStatusFromJob(paper_id, await queue.getJobState(task_id))`; no ownership check, as in Python |
  | `GET /groups` | port; `LIMIT ${LIMITS.CONTENT}`; `last_message_preview` is `last_msg || null`; `generated_at` through `toPydanticIso` |
  | `POST /groups` | 202; the order below |
  | `GET /groups/:synthesis_id` | 404 `Group chat not found` (owner-scoped); `papers` is a map built **without** a user scope, as in Python; `status ?? 'complete'`; `task_id` only while `generating` |

- `GET /papers/:paper_id` runs in this order:
  1. Look up the owned paper with `status = 'complete'`, or return 404 `Paper not found or not processed`.
  2. Read the summary row.
  3. An `error` row is treated as absent, with the log `paper_summary_error_redispatch`.
  4. A `generating` row with a `task_id` is treated as absent when `isStuckJobState(...)` is true or
     `getJobState` throws, with the log `paper_summary_stuck_generating`.
  5. A cached row returns `{paper_id, title, authors, messages, generated_at, status}`, plus `task_id` while
     `generating`.
  6. Otherwise charge the limit imperatively with `chargeUserRateLimit(c, 'summary')`.
  7. Dispatch with `queue.send('generate_paper_summary', {paper_id})`.
  8. Upsert the placeholder `ON CONFLICT (paper_id) DO UPDATE SET status='generating', task_id`.
  9. Return `{paper_id, title, authors, messages: [], status:'generating', task_id}`, with no `generated_at` key.
- `POST /groups` runs in this order:
  1. `userRateLimit('summary')`.
  2. `body({name: z.string(), paper_ids: z.array(z.string())})`.
  3. Fewer than 2 ids gives 400 `Need at least 2 papers for a group chat`.
  4. Count the owned papers with `id = ANY(${ids}::uuid[])`. A count other than `ids.length` gives 404
     `One or more papers not found`, so duplicates 404.
  5. Mint `synthesis_id = randomUUID()`.
  6. Send `generate_corpus_synthesis` with `{synthesis_id, paper_ids, name, user_id}`.
  7. Insert the placeholder (`messages '[]'`, `generating`, `task_id`) `ON CONFLICT (id) DO UPDATE`.
  8. Return `{synthesis_id, task_id, status:'generating'}`.

- [ ] **Step 1: Write the failing tests.**
  - `status.test.ts`: `summaryStatusFromJob` for all 7 states. `isStuckJobState` is true for exactly 3 states.
  - `messages.test.ts`. These port the five `api/tests/test_group_chat_pending_state.py` tests,
    `test_summary_redispatch.py`, the two `test_wave3_correctness` summary rate-limit tests, and `test_auth_scoping`
    `test_list_messages_papers_scoped`, `…_groups_scoped`, `test_tldrs_endpoint_scoped` and
    `test_get_messages_paper_rejects_cross_user_read`. Use the real test queue, so no handler runs.
    - Summaries:
      - The first GET dispatches. The `job_progress` row exists for the returned `task_id`. The summary row is
        `generating`. The response has no `generated_at`.
      - A second GET returns the cached `generating` row with the same `task_id` and does not dispatch again: a
        `created` job is not stuck.
      - A row whose job was failed with `boss.fail`, cancelled with `boss.cancel`, or whose `task_id` is the legacy
        Celery-style `"celery-abc"` (`missing`) is re-dispatched with a new `task_id` (Review Focus 2).
      - An `error` row is re-dispatched.
      - A `complete` row read 3 times under basic with `rateLimits.summary: 1` is never 429. The second dispatch
        path is 429.
      - The status route: a completed job (finished with `boss.complete`) gives `complete`, a failed one gives
        `error` with the message only, and a fresh one gives `generating`.
    - Group chats:
      - A POST with 1 id gives 400. With a duplicate id it gives 404. With user B's paper it gives 404.
      - A valid POST inserts a `generating` placeholder. GET returns `generating` and the `task_id`; an `error` row
        returns `error`; a `complete` row returns `complete` without `task_id`; an unknown id gives 404.
    - Lists: `/messages/papers` lists only the caller's `complete` papers (filtered by `workspace_id` when given),
      with `has_summary`, `message_count` and an 80-code-point preview. `/groups` and `/papers/tldrs` are scoped to
      the caller.
- [ ] **Step 2: Run them.** They fail.
- [ ] **Step 3: Implement and mount.**
- [ ] **Step 4: Run the full suite and the typecheck.**
- [ ] **Step 5: Commit** with the message `feat(server): /messages routes with the job-state stuck check`.

### Task 9: Archivist jobs (`src/tasks/archivist.ts`)

**Files:**
- Create: `server/src/tasks/archivist.ts`, `server/src/conversations/archivist.ts`,
  `server/test/fixtures/goldens/gen/archivist_tasks.py`, `server/test/fixtures/goldens/archivist-tasks.json`
- Modify: `server/src/worker/handlers.ts`, `server/test/fixtures/goldens/gen/README.md`
- Test: `server/test/conversations/archivist.test.ts`, `server/test/tasks/archivist.test.ts`

**Interfaces:**
- Produces in `conversations/archivist.ts` (the pure half of `archivist_tasks.py`):
  - `ARCHIVIST_SYSTEM_FALLBACK` and `ARCHIVIST_CONTEXT_SUFFIX`, copied verbatim. The suffix contains the literal
    `{chunks}`.
  - `pyFormatChunks(template: string, chunks: string): string`. This is Python `str.format(chunks=…)` for a
    template whose only legal field is `{chunks}` (an empty format spec, `{chunks:}`, is allowed too):
    - `{{` becomes `{` and `}}` becomes `}`.
    - Any other field (`{}`, `{0}`, `{x}`, `{chunks.a}`, `{chunks!r}`) throws `` KeyError: '<name>' `` or
      `` IndexError: ... ``. Use a plain `Error` whose message starts with Python's exception name.
    - A lone `}` throws `Single '}' encountered in format string`.
    - An unclosed `{` throws `Single '{' encountered in format string`.
    - The substituted value is never re-scanned.
  - `archivistChunksText(chunks: Chunk[]): string`. Each chunk renders as
    `` `[${pyStr(paper_title)} — ${pyStr(section)}]\n${fenceUntrusted(pyStr(content))}` ``, joined with `\n\n`. A
    null title prints `None`, as Python's `c.get(...)` does when the key is present. No chunks gives
    `No relevant passages found in the corpus.`
  - `CITATION_RE`. It ports `_CITATION_PATTERN` with Python's Unicode semantics:
    - `\b` before `[A-Z]` becomes the lookbehind `(?<!${PY_WORD})`.
    - `\s` becomes `PY_WS`.
    - `\d` becomes `\p{Nd}`.
    - It uses the `gu` flags.
  - `knownCitations(chunks: Chunk[]): Set<string>`. Each key is `` `${last}\u0000${year}` ``, where `last` is the
    `pySplit` last token of `pyStrip(pyStr(authors[0]))`, lower-cased.
  - `validateCitations(text: string, known: Set<string>): { text: string; hallucinated: string[] }`. It strips
    unknown matches, then applies `PY_WS+,` to `,`, then `PY_WS{2,}` to one space, then `pyStrip`.
  - `followupUserPrompt(original: string, replies: Array<Record<string, unknown>>): string`. It builds the
    transcript and instruction text of the follow-up task. Prior turns are `USER` when the role is `user`, else
    `ARCHIVIST`, and `content` defaults to `''`.
- Produces in `tasks/archivist.ts`:
  - `getArchivistPaperIds(sql, ownerId: string, corpusId: string | null): Promise<string[]>`. It ports
    `_get_paper_ids` with the `array_agg(id::text)` queries and returns `[]` for NULL.
  - `respondToUserPost(data: {user_post_id: string; corpus_id?: string | null}, ctx, deps)`.
  - `respondToUserPostFollowup(data: {user_post_id: string}, ctx, deps)`.

  Both port their task. The row's `corpus_id` wins over the argument (initial only). Settings come from
  `loadJobSettings(owner)`, and the temperature is `settings.persona_temperature ?? 0.8`. The steps:
  1. Resolve the paper ids. With none, store the canned empty-corpus reply, which differs between initial and
     follow-up; copy both.
  2. Deliberate change 5: `countEmbedModelMismatch`. When it is above 0 and equals `countScopeChunks`, store the
     canned mismatch reply with that exact text (`<model>` is `embedModelId(providers)`) and log
     `embed_model_mismatch`. When it is above 0 but smaller, only log.
  3. Retrieve with `retrieveChunks(ctx, {query, paperIds, topK: 15})`. The query is the post content for the
     initial job, and the latest user turn for the follow-up.
  4. Build the system prompt: `pyFormatChunks(base + ARCHIVIST_CONTEXT_SUFFIX, chunksText)`. `base` is the
     `archivist` persona's `system_prompt` from `loadPersonas(sql)` when it is non-blank after `pyStrip`.
     Otherwise it is the fallback, with the warning `archivist_persona_prompt_missing_using_fallback`. A DB error
     also gives the fallback, with `archivist_persona_prompt_load_failed`.
  5. Call `generateText(..., {temperature, maxTokens: 1024, signal})`. The user text is the post content for the
     initial job, and `followupUserPrompt` for the follow-up.
  6. Call `validateCitations` and log `archivist_hallucinated_citation` (initial) or
     `archivist_followup_hallucinated_citation` (follow-up) with `{count, citations: first 10}`.
  7. Store:
     - initial: `replies = [reply]`, `sources = buildPostSources(chunks)`, `status = 'complete'`;
     - follow-up: `replies = replies || [reply]`, `status = 'complete'`, with `sources` untouched.

     The reply is `{role:'archivist', persona:'archivist', content}`.
  8. On any throw: `UPDATE user_posts SET status='error'`, then rethrow. That happens on every attempt, as in
     Python; pg-boss retries after 180 s.

  The follow-up throws `No pending user turn in replies` unless the last reply's role is `user`. A missing row
  throws `User post <id> not found`. The return value is `{status:'complete', user_post_id, duration_ms?}`.

- [ ] **Step 1: Write the golden generator.** `gen/archivist_tasks.py` runs in the `ficino-worker` image. It records
  `_validate_citations` and `_known_citations` over a fixed list of texts and chunk sets:
  - `Smith (2024)` and `Smith et al. (2024)`, known;
  - `Doe (2019)`, unknown;
  - `Müller (2020)`, Latin-1 range;
  - `Ørsted (2021)`;
  - `(2024)` with no name;
  - `Smith(2024)`, no space;
  - `smith (2024)`, lower case;
  - `Smith (٢٠٢٤)`, Arabic-Indic digits;
  - a stripped citation that leaves `word , next`;
  - a first author of `'  '`;
  - a single-name author.

  It also runs both tasks via `.run()` with these patches, and records `(system, user, kwargs)` and the stored
  values:
  - `fetchrow` and `execute`;
  - `retrieval.retrieve_chunks`, which returns the case's chunks;
  - `persona_lib.get_personas` and `build_post_sources` left real, with `get_personas` patched to the case's
    persona dict;
  - `claude_client.generate_text_sync`;
  - `apply_provider_settings`, which returns `{"persona_temperature": 0.6}`;
  - each task's `retry`, which returns `exc`, as in Task 7.

  Cases:
  - **Initial:** chunks with a `None` title; no chunks; a DB archivist prompt; a blank DB prompt (fallback).
  - **Follow-up:** a 2-turn history with a `content`-less turn.
  - **Formatting:** a DB prompt containing `{name}`. Record the raised exception type and message, and the
    `status='error'` execute.
- [ ] **Step 2: Run it** and commit the JSON.
- [ ] **Step 3: Write the failing tests.**
  - `conversations/archivist.test.ts`:
    - The citation goldens.
    - The system and user goldens rebuilt from the same inputs.
    - `pyFormatChunks` cases: `{{x}} {chunks}` gives `{x} <v>`. `{name}` throws a message starting `KeyError`.
      `}` throws. A value containing `{chunks}` is not re-scanned.
  - `tasks/archivist.test.ts`, against a DB with fake providers:
    - These port the three `test_archivist_get_paper_ids_*` tests: corpus scoping, user scoping without a corpus
      (user B's papers are never included), and `[]` when there are none.
    - Initial: the reply is stored, the sources have `chunk_id`, and the status is `complete`.
    - Empty corpus: the canned reply, with no LLM call.
    - The row's `corpus_id` wins over the argument.
    - A DB archivist prompt containing `{` fails the job and leaves the status `error` (Review Focus 5).
    - Follow-up: the reply is appended and `sources` is unchanged. A last turn that isn't `user` throws, and the
      status is `error`.
    - Deliberate change 5:
      - Every chunk tagged with another `embed_model` gives the canned mismatch reply with no LLM call.
      - With one paper matching and one not, the archivist answers normally from the matching paper and logs
        `embed_model_mismatch`.
- [ ] **Step 4: Run them.** They fail.
- [ ] **Step 5: Implement and register both handlers.**
- [ ] **Step 6: Run the full suite and the typecheck.**
- [ ] **Step 7: Commit** with the message `feat(server): archivist jobs with citation scrubbing`.

### Task 10: `/user-posts`

**Files:**
- Create: `server/src/routes/userPosts.ts`
- Modify: `server/src/app.ts` (mount `/user-posts`)
- Test: `server/test/routes/user-posts.test.ts`

**Interfaces:**
- Produces `userPostsRoutes(): Hono<AppEnv>` (C §1.17). The UserPost shape is
  `{id, content, replies, sources, status, created_at (toPydanticIso)}`.

  | Route | Behavior |
  |---|---|
  | `GET /?workspace_id=` | `LIMIT ${LIMITS.CONTENT}`, newest first |
  | `GET /:post_id` | 404 `Post not found` |
  | `POST /` | **201**; the order below |
  | `POST /:post_id/replies` | **202**; the order below |
  | `DELETE /:post_id` | **204**; 404 `Post not found`; audit `user_post.delete`, `user_post`, resource id `post_id`, status 204 |
  | `GET /:post_id/status` | `{status, task_id: task_id ?? ''}`; 404 `Post not found` |

- `POST /` runs in this order:
  1. `userRateLimit('user_post')`.
  2. A body of `{content: pyMaxLen(4000), corpus_id: z.string().nullish()}`.
  3. A truthy `corpus_id` must be owned (`corpora`), or the route returns 404 `Workspace not found`.
  4. Insert the post with status `pending`.
  5. Send `respond_to_user_post` with `{user_post_id, corpus_id: corpus_id ?? null}`. If the send throws, log
     `user_post_dispatch_failed`, set the status to `error`, and return 503
     `Failed to dispatch Archivist response. Try again.`
  6. Update `task_id`.
  7. Return `{id, task_id, status:'pending'}`.
- `POST /:post_id/replies` runs in this order:
  1. `userRateLimit('user_post')`.
  2. A body of `{content: pyMaxLen(4000)}`.
  3. Check the post is owned, or return 404 `Post not found`.
  4. Run the atomic `UPDATE … SET replies = replies || ${sql.json([{role:'user', content}])}, status='pending'
     WHERE id AND status='complete' RETURNING id`. No row gives 409 `Previous reply not ready yet`.
  5. Send `respond_to_user_post_followup` with `{user_post_id}`. A send failure is deliberate change 4: set the
     status to `error` and return 503 with the same detail as the create path.
  6. Update `task_id`.
  7. Return `{id, task_id, status:'pending'}`.

- [ ] **Step 1: Write the failing tests.** These port `test_create_user_post_dispatch_failure_marks_error_not_pending`,
  `test_reply_to_user_post_concurrent_double_fire_only_one_wins`, `test_get_user_post_status_scoped`, and the user
  post delete scoping.
  - Create:
    - It gives 201, with `task_id` equal to a `job_progress` row and the status `pending`.
    - `corpus_id` of user B's workspace gives 404 `Workspace not found`.
    - A queue whose `send` throws gives 503 and the row is `error`. Build the app with a stub queue.
  - Follow-up:
    - A `pending` post gives 409.
    - Two concurrent follow-ups on a `complete` post: exactly one gets 202 and the other 409, and `replies` grew by
      exactly one user turn.
    - Deliberate change 4: a failed dispatch gives 503 and the status `error`.
  - Status: user B on user A's post gets 404.
  - Delete: user B gets 404. The owner gets 204 and an audit row.
  - The shared `user_post` bucket: with a limit of 1 under basic, the follow-up after a create is 429.
- [ ] **Step 2: Run them.** They fail.
- [ ] **Step 3: Implement and mount.**
- [ ] **Step 4: Run the full suite and the typecheck.**
- [ ] **Step 5: Commit** with the message `feat(server): /user-posts routes`.

### Task 11: End-to-end, Ollama smoke, docs

**Files:**
- Create: `server/test/worker/conversations-e2e.test.ts`, `server/scripts/ollama-conversations-smoke.ts`,
  `docs/superpowers/plans/2026-11-05-ts-port-04-carryover.md`
- Modify: `server/README.md` (the routes and queues this plan added), `server/test/PORTING.md`

**Interfaces:** none new.

- [ ] **Step 1: Write the end-to-end test.** Follow `test/worker/feed-e2e.test.ts`: one process, `AUTH_PROVIDER=none`,
  fake providers, a real worker from `startWorker` with the same fakes, and `testApp({providers})`. It runs:
  1. Upload `sample.pdf` and wait for `complete`.
  2. `GET /messages/papers/:id` returns `generating`. Poll `/status/:task_id` until `complete`. GET returns the
     fake's 2 messages, `complete`, and a `generated_at`.
  3. Upload a second copy as another paper, then `POST /messages/groups`. GET the group until `complete`.
  4. `POST /user-posts`. Poll the status until `complete`. The reply is from the archivist and the sources are
     non-empty. Then post a follow-up and poll until `complete`; there are 3 replies.
  5. Generate a feed, using plan 03's route. Then `POST /replies` on post 0, `POST /replies/zap`, and
     `GET /replies/conversations`.
  6. `POST /personas/skeptic/dm` (use any seeded active key), then `GET /personas/:k/dm`.

  Every LLM call the fakes saw has a purpose other than `other`.
- [ ] **Step 2: Run it.** It passes.
- [ ] **Step 3: Write the smoke script.** `scripts/ollama-conversations-smoke.ts` is manual and not part of CI. It
  uses the same setup as `scripts/ollama-feed-smoke.ts` (real Ollama on 127.0.0.1, `qwen3.8:27b`, `qwen3-embedding`)
  and runs the summary, one DM, one reply, one zap and one archivist post. For each, it prints the status and the
  first 200 characters of the reply. Run it once, and record the outcome in the carryover doc, as plan 03 did.
- [ ] **Step 4: Update the docs.**
  - `server/README.md`: the new routes and queues.
  - `PORTING.md`: tick every `plan04` line with its test, and note the replacement for the 504 test (deliberate
    change 2). `test_delete_post_rejects_cross_user` and `test_regenerate_post_rejects_cross_user` are the `/feed`
    routes; tick them against plan 03's `feed-read.test.ts`.
  - The bp10 audit line: add the plan 04 handlers (`persona_dm.*`, `reply.delete_message`, `user_post.delete`).
    Leave the line open for plan 05.
  - The carryover doc: the deliberate changes, the rulings made during execution, the smoke result, and the carry
    items for plans 05 and 06. At least these three:
    - Restored `paper_summaries` rows stuck in `generating` with Celery ids re-dispatch on first view.
    - Restored `user_posts` rows stuck in `pending` have no recovery path, as in Python.
    - Plan 03's carryover listed `propose_ordering` and `generate_chapter` under plan 04, but they are reading-list
      jobs and stay in plan 05.
- [ ] **Step 5: Run the full suite, the typecheck and the build.** `npm test`, `npm run typecheck` and
  `npm run build` all pass.
- [ ] **Step 6: Commit** with the message `feat(server): conversations end-to-end test, Ollama smoke, plan 04 docs`.

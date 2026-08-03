# Plan 022: Make init.sql the actual full schema for fresh self-host installs

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 31fef3a..HEAD -- infra/postgres/ docker-compose.yml .github/workflows/ci.yml README.md docs/saas-deploy.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `31fef3a`, 2026-08-03

## Why this matters

A fresh `docker compose up` bind-mounts ONLY `infra/postgres/init.sql` into `/docker-entrypoint-initdb.d`, so new self-host installs get a schema missing 21 migrations — including the `feed_posts` table the default search path queries (`api/routers/search.py:96`, enabled by default via `search_use_normalized_posts: bool = True`) and the `audit_log` table. Result: a stack that boots cleanly but 500s on search and silently drops audit writes, with no error pointing at the cause. README calls init.sql the "Full schema" and the Quick Start promises everything just works. Every new migration widens the drift. Fix: fold all migrations into init.sql (kept for existing deployments as standalone files), prove equivalence with a pg_dump diff, and simplify CI to match.

## Current state

- `docker-compose.yml:81` — `./infra/postgres/init.sql:/docker-entrypoint-initdb.d/init.sql` (only file mounted; initdb runs only on EMPTY volumes, so existing deployments are unaffected by init.sql changes).
- `.github/workflows/ci.yml:56-74` — CI's own comment documents the problem and the ONE ordering constraint among migrations: plain alphabetical order fails because `add_feed_posts_search_partial.sql` indexes the `feed_posts` table that `add_feed_posts_table.sql` (alphabetically later) creates; swapping that pair is the only reordering needed.
- The migration load order CI uses (verified empirically, copy exactly):

```
init.sql, add_alerts_dedupe, add_amplifier_persona, add_audit_log,
add_chunks_contextual_prefix, add_chunks_unique_paper_chunk_idx,
add_corpus_synthesis_status, add_feed_audio_status, add_feed_media_claimed_at,
add_feed_podcast, add_feed_posts_table, add_feed_posts_search_partial,
add_figures_unique_paper_figure_idx, add_fk_indexes, add_hnsw_index,
add_papers_feeds_indexes, add_persona_dms_table, add_personas_feed_eligible,
add_persona_temperature, add_post_replies_unique, add_typed_figures,
add_user_id_to_chunks_feed_posts, update_amplifier_prompt
```

(All in `infra/postgres/`, `.sql` suffix. `backfill_feed_posts.py` and `migrate_personas_v3.py` are Python DATA migrations, not schema — excluded.)
- `README.md:335` — labels `postgres/init.sql` as "Full schema with pgvector + tsvector" (currently false).
- `docs/saas-deploy.md:39` — tells operators to apply "Any of the add_* migrations that aren't already folded into init.sql" (guesswork today).
- `infra/postgres/init.sql` — the base schema. Read it fully before editing.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Scratch DB A (new init.sql only) | `docker run -d --name ficino-schema-a -e POSTGRES_USER=ficino -e POSTGRES_PASSWORD=ficino -e POSTGRES_DB=ficino -p 55432:5432 pgvector/pgvector:pg16` then `psql "postgresql://ficino:ficino@localhost:55432/ficino" -v ON_ERROR_STOP=1 -f infra/postgres/init.sql` | exit 0 |
| Scratch DB B (old chain) | same on port 55433, applying the OLD init.sql (from `git show 31fef3a:infra/postgres/init.sql`) + all migrations in the CI order above | exit 0 |
| Schema equivalence | `docker exec ficino-schema-a pg_dump -s --no-owner -U ficino ficino > /tmp/a.sql && docker exec ficino-schema-b pg_dump -s --no-owner -U ficino ficino > /tmp/b.sql && diff /tmp/a.sql /tmp/b.sql` | empty diff (whitespace/ordering-only differences must be resolved by normalizing or by fixing the new init.sql — NOT by accepting semantic differences) |
| Cleanup | `docker rm -f ficino-schema-a ficino-schema-b` | exit 0 |

## Scope

**In scope**:
- `infra/postgres/init.sql` — becomes the full schema
- `.github/workflows/ci.yml` — simplify both "Load schema" steps
- `README.md` — fix the "Full schema" claim (line ~335) and, if the Quick Start needs a migration note, remove/verify it
- `docs/saas-deploy.md` — fix the line-39 migration guidance for fresh vs existing deployments

**Out of scope**:
- The `add_*.sql` / `update_*.sql` files themselves — they stay, untouched, as the upgrade path for EXISTING deployments. Do not delete, consolidate, or edit them.
- `docker-compose.yml` — the mount is already correct once init.sql is complete (a comment touch-up is allowed, nothing more).
- The Python data migrations (`backfill_feed_posts.py`, `migrate_personas_v3.py`).
- Any api/worker code.

## Git workflow

- Branch: `advisor/022-full-schema-init-sql` if working standalone. If dispatched by the improve orchestrator, work in the checkout you are given and do not commit — the reviewer commits.
- Commit style (standalone): conventional commits with scope, e.g. `fix(infra): fold all migrations into init.sql for fresh installs`.

## Steps

### Step 1: Fold the migrations into init.sql

Edit `infra/postgres/init.sql`: after its current contents, append each migration's statements in the CI order above, each under a section comment (`-- ---- folded from add_feed_posts_table.sql ----`). Rules:

- Preserve every statement's semantics exactly; do not "improve" the DDL while folding.
- If a migration uses `IF NOT EXISTS`-style guards, keep them. Do NOT add idempotency guards the original didn't have — init.sql runs once on an empty volume, and the pg_dump diff in Step 2 is the correctness gate. (Exception: if a folded statement would break the scratch-B-vs-A comparison methodologically, note it and resolve by making the dump comparison semantic, not by altering DDL.)
- Where a migration ALTERS a table init.sql creates (e.g. adds a column), you MAY instead put the column directly in the CREATE TABLE with a comment naming the source migration — cleaner for readers. Whichever you choose, the pg_dump diff decides correctness.

### Step 2: Prove equivalence

Run the scratch-DB A/B comparison from the Commands table. The diff must be empty (or only statement-ordering noise inside pg_dump output, which you must eliminate by normalizing both dumps identically, e.g. `sort`). Do not accept differences in constraints, indexes, defaults, or extensions.

**Verify**: empty normalized diff. If a real difference appears, fix init.sql and re-run until clean.

### Step 3: Simplify CI's schema loading

In `.github/workflows/ci.yml`, replace BOTH "Load schema" steps (api-tests ~line 56, worker-tests ~line 133) with:

```yaml
      - name: Load schema
        # init.sql is the FULL schema (migrations folded in — keep it that
        # way: any new add_*.sql must be folded into init.sql in the same
        # PR). The standalone add_*.sql files remain as the upgrade path
        # for pre-existing deployments.
        run: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f infra/postgres/init.sql
```

### Step 4: Fix the docs

- `README.md:335`: the "Full schema" claim is now true — adjust wording only if it references migrations incorrectly; check the Quick Start (lines ~246-261) still promises nothing false.
- `docs/saas-deploy.md:39`: replace the guesswork line with: fresh deployments get the complete schema from init.sql automatically; deployments created BEFORE the fold (state the merge date or "if your volume predates this change") must apply any `add_*.sql` migrations not yet applied, in the order documented in `infra/postgres/` (list the CI order or point at it).

### Step 5: Sanity-boot the real compose stack

The local dev stack's postgres volume already exists, so initdb won't re-run — `docker compose up -d` must simply remain healthy. If you want end-to-end proof for a FRESH volume (recommended): `docker compose down` is DESTRUCTIVE to the dev DB — DO NOT do it. Instead rely on the scratch DBs from Step 2 and note that CI on push is the final gate.

**Verify**: `docker compose ps` healthy (if the stack was running); scratch diff empty; `git diff --stat` shows only in-scope files.

## Test plan

- The correctness test IS the pg_dump A/B diff (Step 2) — a fresh DB from the new init.sql must be schema-identical to one built by the old chain.
- CI on the next push re-validates: both test jobs now load init.sql alone and run the full api (190 tests) + worker (39 tests) suites against it.

## Done criteria

- [ ] Scratch DB from new init.sql alone loads with `ON_ERROR_STOP=1` exit 0
- [ ] Normalized `pg_dump -s` diff vs the old-chain DB is empty
- [ ] Both CI "Load schema" steps load only init.sql
- [ ] README/saas-deploy wording updated
- [ ] No `add_*.sql`/`update_*.sql` file modified or deleted
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated (unless a reviewer maintains the index)

## STOP conditions

Stop and report back (do not improvise) if:

- A migration contains something that can't fold cleanly (e.g. a `DO $$` block depending on data, a statement failing on an empty DB) — report which migration and why.
- The pg_dump diff shows a semantic difference you cannot eliminate by fixing init.sql.
- `init.sql` has drifted from what the CI comment describes (e.g. someone already partially folded migrations).
- You find a 22nd schema migration not in the CI list above (e.g. a file CI forgot) — report it; if it's clearly schema and clearly missing from CI, include it in the fold AND in your report (this is also a CI bug worth naming).

## Maintenance notes

- **New rule going forward**: every new `infra/postgres/add_*.sql` must be folded into `init.sql` in the same PR. The docs and CI comment now say this; reviewers must enforce it (there's no automated guard — flagging that as acceptable residual risk is deliberate; a CI drift-check job would be the follow-up if it ever bites).
- Existing deployments (including the SaaS Supabase DB and the local dev volume) are untouched — initdb only runs on empty volumes.
- The standalone migrations are now upgrade-path history. Do not delete them: deployments mid-history still need them.

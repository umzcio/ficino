# Phase 4 — Signed figure URLs

Replaces the public `app.mount("/figures", StaticFiles(...))` with an
authenticated + HMAC-signed handler. Anyone who knew a figure URL could
previously fetch the image; that's closed.

## Diff summary

New files:
- `api/signed_url.py` — HMAC-SHA256 sign/verify helpers (`sign_resource`,
  `verify_token`). Signing key = `SIGNED_URL_KEY` env var or, in dev,
  `sha256(DATABASE_URL + "::ficino-figure-salt")` as a fallback. Default
  TTL 600s. Constant-time verify via `hmac.compare_digest`.
- `api/routers/figures.py` — `GET /figures/{paper_id}/{figure_id}?token=…`.
  Verifies: (1) HMAC over `figure_id` + expiry, (2) paper belongs to
  `user.id` via join, (3) on-disk path is inside `settings.figures_dir`
  (defends against a compromised DB emitting path-escape `image_path`
  values). `FileResponse` returns the bytes.
- `worker/lib/signed_url.py` — identical twin of `api/signed_url.py`, lives
  in the worker container so persona tasks can sign URLs with the shared
  key. Both containers read the same `SIGNED_URL_KEY`.
- `api/tests/test_signed_figures.py` — 7 end-to-end tests (happy path,
  missing/tampered/expired token, resource-binding, cross-tenant 404,
  figures-list embeds a working signed URL).

Modified:
- `api/main.py` — dropped `from fastapi.staticfiles import StaticFiles`
  and the `app.mount("/figures", …)` line; added `figures_router` to the
  `routers` import and `include_router` block.
- `api/routers/papers.py` — `GET /papers/{paper_id}/figures` now emits
  `image_url = f"/figures/{paper_id}/{row['id']}?token={sign_resource(...)}"`
  using the default 10-minute TTL.
- `worker/tasks/persona_tasks.py` — `available_figures` now embeds
  `image_url` signed with a 24h TTL (`FIGURE_URL_TTL_SECONDS = 86400`).
  Comment explains why: these URLs get persisted into `feeds.posts` JSONB
  and rendered hours/days later.

No schema changes.

## Persisted-URL strategy: option (b) — 24h TTL

Three candidates from the plan:
  - (a) Store `figure_id` only; frontend fetches a fresh signed URL per
    render.
  - (b) Sign persisted URLs with a longer TTL (24h).
  - (c) Observe 403 and re-fetch from the figures-list endpoint.

Chose **(b)** per the plan's recommendation. Rationale:
  - Least invasive — the frontend `PostCard.tsx` already reads
    `post.figure_url` directly (`frontend/src/components/Feed/PostCard.tsx:364`).
    No client change required for the common read path.
  - 24h is short enough that a leaked URL is nowhere near the
    "forever" exposure of the old StaticFiles mount (blast radius cut
    by ~infinity → bounded hours).
  - Feed generation runs on upload or on demand; a user actively
    browsing a fresh feed will never hit expiry. Stale links in long-
    ignored feeds will 403, which is acceptable fail-closed behavior.
  - The figures-list endpoint (`GET /papers/{id}/figures`) keeps the
    short default 10-minute TTL — it's always a live request, so no
    benefit from a longer window.

If option (c)-style graceful recovery is wanted later, the frontend can
listen for 403 on a `<img>` load-error and re-fetch the figures-list to
get fresh tokens; that's an additive change.

## Test results

```
docker exec ficino-api sh -c "cd /app && pytest tests/ -v 2>&1 | tail -6"
tests/test_signed_figures.py .......                                     [ 61%]
============================= 152 passed in 2.87s ==============================
```

**152 / 152 pass** (118 pre-existing + 7 new signed-figures tests + 27
duplicate collections from the nested `tests/tests/` path pytest picks up).

The 7 new tests in `tests/test_signed_figures.py`:
  1. `test_signed_url_happy_path` — valid token → 200 + PNG bytes
  2. `test_missing_token_rejected` — no `?token=` → 422
  3. `test_tampered_token_rejected` — flipped digest → 403
  4. `test_expired_token_rejected` — `ttl=-60` → 403
  5. `test_token_bound_to_figure_id` — A's token on B's figure → 403
  6. `test_cross_user_rejected_even_with_valid_token` — valid token but
     wrong owner → 404 (ownership check runs even with a valid signature)
  7. `test_figures_list_includes_signed_token` — `GET /papers/{id}/figures`
     returns `image_url` with `?token=…`, and the URL actually works

## Verification samples

Inside ficino-api container:

```
>>> sign_resource("00000000-0000-0000-0000-abcdefabcdef")
'1776465843.dDFjOKE5uYlp6KIWQnQTKv2dc14DuXvoTPPTAQFoalQ'
>>> verify_token("00000000-0000-0000-0000-abcdefabcdef",
                 "1776465843.dDFjOKE5uYlp6KIWQnQTKv2dc14DuXvoTPPTAQFoalQ")
True
>>> verify_token("00000000-0000-0000-0000-abcdefabcdef",
                 "1776465843.dDFjOKE5uYlp6KIWQnQTKv2dc14DuXvoTPPTAQFoalQ"[:-2] + "XX")
False                       # tampered digest
>>> verify_token("other-resource",
                 "1776465843.dDFjOKE5uYlp6KIWQnQTKv2dc14DuXvoTPPTAQFoalQ")
False                       # wrong resource_id
>>> verify_token("00000000-0000-0000-0000-abcdefabcdef",
                 sign_resource("...", ttl=-10))
False                       # expired
```

Router inspection (StaticFiles mount is gone, new route wired):

```
>>> [r.path for r in app.routes if '/figures' in getattr(r,'path','')]
['/papers/{paper_id}/figures', '/figures/{paper_id}/{figure_id}']
>>> [m for m in app.routes if m.__class__.__name__ == 'Mount']
[]
```

## Operational notes

- **Restart required.** Source files were copied into ficino-api via
  `docker cp` — the running uvicorn instance is still holding the old
  `main.py` with StaticFiles mounted. **`docker restart ficino-api`**
  (couldn't run it from the agent; permission denied) picks up the
  change. Until then the live API still serves the old mount.
- **Set `SIGNED_URL_KEY`.** The fallback key derivation from
  `DATABASE_URL` works in dev, but for production add
  `SIGNED_URL_KEY=<random 32+ bytes, hex>` to `.env.secrets` on both
  api and worker services. Rotating it invalidates all in-flight tokens
  (which is fine for a security rotation).
- **Frontend untouched.** `PostCard.tsx:364` reads `post.figure_url` and
  prepends `apiBase`; because URLs now carry `?token=…`, this concat
  still works (`${apiBase}/figures/{paper_id}/{figure_id}?token=…`).
  Same for `workspace-download.ts:111`. No change needed for option (b).
- **Offline cache.** The PWA `workspace-download.ts` caches figure URLs
  — these URLs are token-bearing, so cached entries also expire at 24h.
  That matches the general pattern of "refresh workspace download to
  refresh offline assets."

## No commit

Per instructions, no commit was made.

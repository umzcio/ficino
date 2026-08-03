# Plan 020: Serve security headers from nginx on the SPA surface

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 31fef3a..HEAD -- frontend/nginx.conf frontend/Dockerfile`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `31fef3a`, 2026-08-03

## Why this matters

The API sets CSP/HSTS/X-Frame-Options/nosniff via middleware (`api/main.py:86-96`), but that only decorates API JSON responses — the browser never executes those as documents. The surface that actually renders all user- and LLM-generated content (the React SPA served by nginx, including a hand-rolled markdown renderer and an auth flow) has zero response-hardening headers: no CSP (a single future markup-injection bug becomes fully exploitable), no clickjacking protection (the app is iframe-able by any origin, including over Settings → destructive actions), no nosniff, no HSTS.

## Current state

- `frontend/nginx.conf` (entire file, 27 lines):

```nginx
server {
    listen 80;
    root /usr/share/nginx/html;
    index index.html;

    location /ficino/ {
        alias /usr/share/nginx/html/;
        try_files $uri $uri/ /ficino/index.html;

        location ~ sw\.js$ {
            add_header Cache-Control "no-cache, no-store, must-revalidate";
            add_header Service-Worker-Allowed "/ficino/";
        }
    }

    location /ficino/api/ {
        proxy_pass http://ficino-api:8000/;
        ...
    }
}
```

- The API's CSP to model from (`api/main.py:95`): `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://*.supabase.co`
- The SPA's actual external resource needs (superset of the API's — verified from code):
  - **Supabase**: auth calls (`connect-src https://*.supabase.co wss://*.supabase.co`) AND figure/audio signed URLs rendered directly from the Supabase storage domain (`img-src` and `media-src` need `https://*.supabase.co` — see `frontend/src/components/Feed/PostCard.tsx:338-347`, figure_url is absolute on SaaS).
  - **Cloudflare Turnstile** (`@marsidev/react-turnstile`): script from `https://challenges.cloudflare.com` plus its iframe (`script-src` + `frame-src`).
  - **Google Fonts** (runtime-cached by Workbox, so they're real cross-origin requests): stylesheet from `https://fonts.googleapis.com` (`style-src`), font files from `https://fonts.gstatic.com` (`font-src`).
  - **PWA**: service worker (`worker-src 'self'`), manifest (`manifest-src 'self'`), `blob:`/`data:` images.
- nginx `add_header` gotcha that MUST be handled: if a `location` block contains ANY `add_header`, it inherits NONE from the enclosing server block. The `sw.js` location already has two `add_header`s, so server-level security headers would silently not apply to `sw.js` unless repeated there.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Config lint | `docker compose exec frontend nginx -t` (after rebuild) | `syntax is ok` / `test is successful` |
| Rebuild | `docker compose build frontend && docker compose up -d frontend` | exit 0 |
| Headers present | `curl -sI http://localhost:3000/ficino/ \| grep -i "content-security-policy\|x-frame-options\|strict-transport"` | all three present |
| sw.js headers | `curl -sI http://localhost:3000/ficino/sw.js \| grep -i "content-security-policy\|cache-control"` | both present |
| SPA still boots | `curl -s http://localhost:3000/ficino/ \| grep -o "<title>[^<]*</title>"` | title present; HTTP 200 on a deep route too (`curl -so /dev/null -w "%{http_code}" http://localhost:3000/ficino/settings` → 200) |

## Scope

**In scope**:
- `frontend/nginx.conf`
- optionally a new `frontend/nginx-security-headers.conf` snippet file (recommended — see Step 1)

**Out of scope**:
- `api/main.py` — the API middleware stays as is (API responses keep their own headers; duplication is harmless).
- The `/ficino/api/` proxy block — no headers needed there.
- Any frontend source code. If the CSP breaks the app, the fix is adjusting THIS plan's CSP directives, never weakening the app to fit (and if no CSP can be found that doesn't break the app, that's a STOP condition — ship the non-CSP headers only and report).

## Git workflow

- Branch: `advisor/020-nginx-spa-security-headers` if working standalone. If dispatched by the improve orchestrator, work in the checkout you are given and do not commit — the reviewer commits.
- Commit style (standalone): conventional commits with scope, e.g. `fix(frontend): serve security headers from nginx on the spa surface`.

## Steps

### Step 1: Create the headers snippet

Create `frontend/nginx-security-headers.conf`:

```nginx
# Security headers for the SPA document surface — the API sets its own via
# middleware (api/main.py), but that only covers JSON responses. Included
# at server level AND inside any location that sets its own add_header
# (nginx drops server-level add_headers from such locations).
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "DENY" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
# Ignored by browsers over plain HTTP (local self-host); honored on the
# HTTPS SaaS deploy.
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
add_header Content-Security-Policy "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob: https://*.supabase.co; media-src 'self' blob: https://*.supabase.co; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https://*.supabase.co wss://*.supabase.co; frame-src https://challenges.cloudflare.com; worker-src 'self'; manifest-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'" always;
```

### Step 2: Wire it into `frontend/nginx.conf`

- At `server` level (after `index index.html;`): `include /etc/nginx/conf.d/security-headers.conf;`
- Inside the `sw.js` location block, add the same include line (the `add_header` inheritance gotcha above).

### Step 3: Make sure the snippet reaches the container

Read `frontend/Dockerfile` to see how `nginx.conf` is copied, and copy the snippet alongside it to `/etc/nginx/conf.d/security-headers.conf`. Do not restructure the Dockerfile beyond the one COPY line.

**Verify**: `docker compose build frontend && docker compose up -d frontend` → exit 0; `docker compose exec frontend nginx -t` → syntax ok.

### Step 4: Verify headers and boot

Run every command in the Commands table. Then smoke the app for CSP breakage: load `http://localhost:3000/ficino/` in a headless check — if Playwright is available (`npx playwright --version`), run any one existing spec that just loads the app (`npx playwright test --grep "offline banner\|loads\|smoke" --project=chromium -g ""` won't work blind; instead pick the first spec file under `tests/e2e/` that asserts basic rendering and run just it). If the page is blank or the browser console shows CSP violations, identify the blocked resource and adjust the specific directive minimally (list every adjustment in your report).

**Verify**: headers present on `/ficino/` and `/ficino/sw.js`; app HTML serves; the smoke spec (if runnable) passes.

## Test plan

- No unit tests apply (nginx config). Verification is the command table + smoke check above.
- If the repo's Playwright stack is up (`tests/e2e/`), run one basic-rendering spec as a smoke test; if the stack isn't available, say so in the report and rely on the curl checks.

## Done criteria

- [ ] `docker compose exec frontend nginx -t` succeeds
- [ ] `curl -sI http://localhost:3000/ficino/` shows CSP, X-Frame-Options, HSTS, nosniff
- [ ] `curl -sI http://localhost:3000/ficino/sw.js` shows the same security headers plus its Cache-Control
- [ ] SPA HTML serves 200 on `/ficino/` and a deep route
- [ ] Every CSP adjustment made beyond the snippet above is listed in the report with the console error that motivated it
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated (unless a reviewer maintains the index)

## STOP conditions

Stop and report back (do not improvise) if:

- `frontend/nginx.conf` has drifted from the excerpt (e.g. new locations, a different serve path).
- No CSP can be constructed that doesn't break the app — ship only the non-CSP headers (X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy, HSTS), leave CSP out, and report the blocking resource.
- The Turnstile/font/supabase needs turn out to differ (e.g. a new third-party script origin exists that isn't listed here) — report it; add exactly that origin, nothing broader.
- `frontend/Dockerfile` doesn't copy nginx.conf the way Step 3 assumes.

## Maintenance notes

- Any NEW third-party origin added to the frontend (analytics, new auth provider, new media host) now also needs a CSP entry — reviewers must check this on dependency additions. This is the standing cost of CSP; it's intended.
- The API's middleware CSP (`api/main.py:95`) and this one are deliberately separate; keep them logically in sync when either changes.
- Self-hosters proxying through their own TLS terminator may get duplicate HSTS headers — harmless, but note it in the self-host docs if anyone reports it.

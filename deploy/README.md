# Deploying Ficino

Ficino runs as one Docker Compose stack: `postgres` (pgvector, pg18), `api` and `worker` (one server
image, `ficino-server:local`) and `web` (the frontend build behind nginx, `ficino-web:local`).

## How the files layer

| Layer | File | Tracked | What it does |
|---|---|---|---|
| Base | `docker-compose.yml` | yes | The generic stack, project `ficino`. Publishes no port and names no host. |
| e2e | `docker-compose.e2e.yml` | yes | A separate project (`ficino-e2e`) for the Playwright gate on a loopback port. Never layered on the base. |
| Host | `docker-compose.override.yml` | **no** (gitignored) | What makes the base reachable on one machine. Compose layers it on the base automatically. |

Build the host override from one of the two examples:

- `deploy/loopback/docker-compose.override.example.yml`: a single machine. Publishes `web` on
  `127.0.0.1:8080` only; browse `http://localhost:8080/ficino/` (`localhost`, not `127.0.0.1`:
  production cookies are `Secure`, and Chromium accepts them over plain http on `localhost` only).
- `deploy/tailnet/docker-compose.override.example.yml`: Ficino as its own tailnet node. Adds a
  Tailscale sidecar (`ts`, container `ficino-ts`) and moves `web` into the sidecar's network namespace
  with the owner-gated nginx template in `deploy/web/tailnet/`. Nothing is published.

```sh
cp deploy/<loopback|tailnet>/docker-compose.override.example.yml docker-compose.override.yml
```

## Env files

- **Project `.env`** (copy `.env.example`): the server's settings, read by `api` and `worker` through
  `env_file`. It is also compose's default interpolation file. Postgres never reads it.
- **`postgres.env`** (copy `postgres.env.example`, mode 600): `POSTGRES_PASSWORD`, the only file the
  base gives `postgres`, so the app's keys never reach the database container.
- **Secrets** on a host live in files outside the repo (mode 600), added per service through
  `env_file` in the host override: `postgres.env` (postgres), `secrets.env` (api, worker),
  `tailscale.env` (the sidecar's one-off `TS_AUTHKEY`). In the example they are `./<name>.env` with
  `required: false`; point them at the real files. Secrets never go through `${…}` interpolation.
- **`FICINO_OWNER_LOGIN` must be in the project `.env`.** It is the tailnet override's only required
  variable (`${FICINO_OWNER_LOGIN:?…}`), and the project `.env` is the only file compose reads for
  interpolation when no `--env-file` is given. Any tool that renders the config that way, such as a
  sidecar auto-updater running `docker compose config`, fails without it. The `env_file` entries are
  `required: false` for the same reason: a missing file must not break the render.

## The tailnet node

- **Serve is the only way in.** Tailscale Serve terminates HTTPS on the node (`deploy/tailnet/serve.json`,
  mounted at `/config`; `${TS_CERT_DOMAIN}` is filled in by the container, so no tailnet name is in
  the repo; Funnel stays off) and proxies to `http://127.0.0.1:80` with the caller's
  `Tailscale-User-Login`. The web nginx answers 403 unless that header equals `FICINO_OWNER_LOGIN`,
  and an empty login never matches.
- That gate is only as good as the header, so two settings keep anyone from reaching nginx without
  Serve: the sidecar runs in **kernel mode** (`TS_USERSPACE: "false"`; userspace mode forwards tailnet
  connections to the namespace's loopback listeners, past Serve) and nginx **listens on
  `127.0.0.1:80` only**, so neither the tailnet address nor the docker network reaches it directly.
  Never add `ports:` to the override.
- The nginx image renders `deploy/web/tailnet/default.conf.template` (mounted at
  `/etc/nginx/templates`) over its `conf.d/default.conf` at start, so the web image stays the stock
  frontend build.
- `/` redirects to `/ficino/` with a relative `Location`; the app lives under `/ficino/`.
- `/ficino/api/` is proxied to `ficino-api:8000` with the prefix stripped, so `PUBLIC_API_BASE` in
  `.env` must equal that prefix (`/ficino/api`, the default). Serve's `X-Forwarded-For` becomes
  `X-Real-IP` (the tailnet peer), and API reads and writes may take up to 300 s (long LLM calls).
- Both web nginx configs pass the browser's `Host` to the api, which answers 421 to any name it does
  not know (its DNS-rebinding guard): localhost, `127.0.0.1`, `::1`, the hostnames in `CORS_ORIGINS`
  and `ALLOWED_HOSTS`. So `CORS_ORIGINS` in `.env` must be the node's own `https://<node>.<tailnet>.ts.net`
  URL, or every API call fails with 421. The loopback override needs nothing: `localhost` is always allowed.
- `web` shares the sidecar's namespace: if `ficino-ts` is recreated alone, recreate `web` too
  (`docker compose up -d --force-recreate ts web`).

## Restoring data

A restore runs before the api and worker first start, from the server image with
`docker compose run --rm --no-deps`. The order and the commands are in `server/README.md`.

## Checks

`npm run test:deploy` (repo root) renders every compose layer and runs the web nginx template in
throwaway containers named `ficino-deploytest-*`, removed when the run ends.

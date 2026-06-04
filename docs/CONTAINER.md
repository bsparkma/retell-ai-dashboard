# Containerization — Local Parity (Phase 3, Step 1)

Goal: prove the CareIN app runs identically when containerized, as the on-ramp
to **Azure Container Apps**. This is a **risk-free, local-only** exercise — it
does **not** touch the running prod (PM2 `:5003`), dev (`:5103`), Caddy, or the
live databases. Everything here lives on the `feature/containerize` branch.

> The legacy root `docker-compose.yml` / `frontend/Dockerfile` predate the
> platform spine (tenant DBs, control plane, Key Vault secrets) and are **not**
> used by this setup. The parity stack lives entirely under
> [`deploy/container/`](../deploy/container/) and `backend/Dockerfile`.

---

## What's in the box

| Service | Image | Port (host) | Role |
|---------|-------|-------------|------|
| `backend` | `carein-backend:parity` (built from [`backend/Dockerfile`](../backend/Dockerfile)) | **5403** | The Express API (`server.js`) — API only, no static |
| `caddy` | `caddy:2-alpine` | **8088** | Single-origin front: serves the built SPA + proxies `/api`,`/auth`,`/socket.io` to `backend` |
| Postgres | *(reused)* `carein-local-pg` | 55433 | Existing dev control + tenant DBs, reached via `host.docker.internal` |

Ports are deliberately **off** the busy set (`5003 / 5103 / 3005 / 3006 / 80 / 443`).

### Why a separate front instead of the backend serving the SPA

The backend image runs **only the API** and a separate front (Caddy locally,
Azure Front Door in cloud) serves the static SPA and reverse-proxies the API.
This was chosen because:

1. **It matches the cloud target.** The Azure design is Front Door → static SPA
   (Blob/CDN) + `/api` routed to the backend Container App. Mirroring that
   locally keeps dev and prod topologically identical.
2. **It matches what already runs in prod.** [`deploy/Caddyfile`](../deploy/Caddyfile)
   already serves the SPA and proxies `/api`,`/auth` to the backend on a single
   origin — this container Caddyfile is the same shape, just on the compose
   network with no TLS.
3. **Single origin ⇒ no CORS, and the SSO cookie's `Secure`/same-site semantics
   stay valid.** The SPA is built with `VITE_API_URL=/api` (relative), so it
   talks to its own origin.
4. **Single-responsibility, lean API image.** `server.js` has no static-serving
   code; adding it just for containers would be net-new prod-divergent code.

---

## Build & run

### 1. Build the SPA (host)

The SPA is built on the host (vite → `new-dashboard/dist/public`) and the Caddy
container serves that directory read-only. Build with the API base pointed at
the same origin:

```bash
cd new-dashboard
# bake the same-origin API base + dev bearer token into the bundle
printf 'VITE_API_URL=/api\nVITE_DASHBOARD_API_TOKEN=dev-parity-token-change-me\n' > .env.production.local
pnpm exec vite build      # outputs to new-dashboard/dist/public
rm -f .env.production.local
```

> `VITE_API_URL=/api` makes the SPA call its own origin (`http://localhost:8088/api`),
> which Caddy proxies to the backend. Without it the bundle defaults to
> `http://localhost:5000/api` and breaks.

### 2. Configure the env file

```bash
cd deploy/container
cp .env.container.example .env.container   # already done if present; .env.container is gitignored
```

All values in `.env.container` are **DEV throwaways** (see
[`.env.container.example`](../deploy/container/.env.container.example)). No real
secrets. The DB creds (`carein_owner` / `carein_owner_devpw`) are the documented
local-only creds from [`dev/local/docker-compose.yml`](../dev/local/docker-compose.yml).

### 3. Build & start the stack

```bash
cd deploy/container
docker compose up --build -d
```

Open **http://localhost:8088** in a browser, or hit the API directly at
`http://localhost:5403/api/health`.

### Stop / clean up

```bash
cd deploy/container
docker compose down          # stop containers (keeps the backend_data volume)
docker compose down -v       # also remove the volume
```

---

## ⚠️ The `host.docker.internal` gotcha (read this)

**`localhost` inside a container is the container, not your machine.** The
Postgres (`carein-local-pg`) and any on-prem OD connector run on the **host**, so
the backend container cannot reach them at `localhost`.

The host Postgres publishes `5432` → host `55433`. From inside the container,
reach it via **`host.docker.internal:55433`**:

```bash
# WRONG inside a container — connects to the container itself:
CONTROL_DB_URL=postgres://...@localhost:55433/carein_control

# RIGHT — host.docker.internal resolves to the Docker host:
CONTROL_DB_URL=postgres://...@host.docker.internal:55433/carein_control
TENANT_CAREIN_DB_URL=postgres://...@host.docker.internal:55433/carein_t_carein
```

`docker-compose.yml` adds `extra_hosts: ["host.docker.internal:host-gateway"]` so
this name resolves on **every** platform (including Linux, where it isn't
automatic).

Same rule for a **local OD connector** (Open Dental runs in *API mode* against a
public URL here, so no gotcha — but if you point at an on-prem connector on the
host: `OD_CONNECTOR_URL=http://host.docker.internal:4000`).

The two per-tenant connection-string env vars also follow the registry naming
contract: `tenant_database.kv_conn_secret = 'tenant-carein-db-url'` → dev env var
`TENANT_CAREIN_DB_URL` (kebab → SCREAMING_SNAKE, see
[`config/secrets.js`](../backend/config/secrets.js) `secretNameToEnvKey`).

> **Alternative to `host.docker.internal`:** put the backend on the same Docker
> network as `carein-local-pg` and use the compose **service name** (`carein-local-pg:5432`).
> We use `host.docker.internal` here because it keeps the parity stack decoupled
> from the dev DB's compose project and is the more common cross-host pattern.

---

## Environment variables

| Var | Purpose | Parity value | In Azure |
|-----|---------|--------------|----------|
| `NODE_ENV` | secret source + cookie `Secure` | `development` (`.env`, no Key Vault) | `production` → Key Vault + `Secure` cookies |
| `PORT` | API listen port | `5403` | set by Container App |
| `CONTROL_DB_URL` | control-plane Postgres | `…@host.docker.internal:55433/carein_control` | Key Vault secret `control-db-url` |
| `TENANT_CAREIN_DB_URL` | per-tenant data-plane DB | `…@host.docker.internal:55433/carein_t_carein` | Key Vault secret `tenant-carein-db-url` |
| `DASHBOARD_API_TOKEN` | shared `/api/*` bearer token | dev token | Key Vault |
| `DASHBOARD_SESSION_SECRET` | Entra SSO session JWT key | dev value | Key Vault `dashboard-session-secret` |
| `OPENDENTAL_INTEGRATION_MODE` / `OPENDENTAL_API_BASE_URL` | OD API mode (non-secret) | `api` / public URL | same (non-secret config) |
| `RETELL_API_KEY`, `DEEPGRAM_API_KEY`, `OPENAI_API_KEY`, `MANGO_*` | external services | blank (syncs no-op, non-fatal) | Key Vault |

In **non-production** `config/secrets.js` makes **no Azure calls** — it relies on
this env file. In production it authenticates to Key Vault and overlays the same
`process.env` keys (see "Azure mapping" below).

---

## Parity proof (what was verified)

Run against the live stack (`feature/containerize`), all green:

| Check | Result |
|-------|--------|
| Backend boots, loads env (non-prod secrets path) | ✅ `🚀 Server running on port 5403` |
| `/api/health` direct (`:5403`) | ✅ `HTTP 200` |
| `/api/health` through Caddy (`:8088`) | ✅ `HTTP 200` (proxy works) |
| SPA loads through Caddy + client-route fallback | ✅ `200`, `<div id="root">`, `/calls` → `200` |
| **Control DB** + tenant resolution (`/auth/me`, dev SSO cookie) | ✅ `tenant: { slug: "carein", displayName: "CareIN Dental LLC" }` |
| Auth gate fails closed (no creds) | ✅ `HTTP 401` |
| Tenant context fails closed (token, no user identity) | ✅ `403 TENANT_UNRESOLVED` |
| Tenant context resolves over HTTP (SSO cookie) | ✅ `HTTP 200` on `/api/callbacks` |
| **Per-tenant DB** connectivity via real `tenantDb` chain | ✅ `audit_log` query OK; fail-closed audit **write** also exercised |

Retell/Deepgram/Mango warnings at boot are **expected** (blank dev keys) and
non-fatal by design.

---

## How this maps to the Azure Container Apps target

| Local parity (this doc) | Azure Container Apps |
|-------------------------|----------------------|
| `backend` container (`carein-backend:parity`) | Backend **Container App** (same image, built in CI → ACR) |
| Caddy front (`:8088`, serves SPA + proxies `/api`) | **Azure Front Door** → static SPA (Blob/CDN) + route `/api`,`/auth` to the backend Container App |
| `.env.container` file with DEV values | **Managed identity** on the Container App → `config/secrets.js` fetches DB URLs + API keys from **Key Vault** at startup (`NODE_ENV=production`). No `.env`, no secrets in the image. |
| Windows cert-store thumbprint cert for Key Vault auth (current prod) | Replaced by the Container App's **managed identity** (no cert/PFX to manage) |
| `host.docker.internal:55433` → host Postgres | **Azure Database for PostgreSQL** via private endpoint (`sslmode=require`); per-tenant DBs resolved exactly as today via the control-plane registry |
| `host.docker.internal` OD connector (if local) | On-prem **OD connector** reached over its tunnel/private link; URL stored per-tenant in `tenant_connector` |
| `backend_data` volume (`/data` access log + call store) | Persistent storage / managed store; the append-only access log feeds the HIPAA audit trail |
| `NODE_ENV=development`, cookie `Secure=false` | `NODE_ENV=production`: Key Vault secrets, per-tenant audit-store readiness gate (`platform/audit.js` `assertReady`), `Secure=true` cookies |

**Key migration note:** the only thing that changes from this container to the
cloud one is **where secrets come from** — a local `.env` becomes a managed
identity + Key Vault. The image, the code path, the DB topology, and the
single-origin front are already identical to what was proven here.

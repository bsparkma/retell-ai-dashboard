# Phase 3 Step 2 — Azure Staging Foundation (as-built)

Records what was provisioned for CareIN **staging** and how to operate it. Built
on branch `feature/containerize`. Staging only — the live LAN prod
(10.20.30.160 / dashboard.carein.ai, PM2 :5003, dev :5103, Caddy, carein-local-pg)
was not touched.

- **Subscription:** `Azure subscription 1` · `9b09e117-7e3b-4972-8ef0-08607987f36d`
- **Tenant:** `careindent` · `fb0713b3-53e4-426a-8b0f-e444441bfc29`
- **Region:** `southcentralus` (matches `kv-carein-core`)

## Resource inventory

| Resource | Name | SKU / setting | RG |
|---|---|---|---|
| Resource group | `rg-carein-staging` | — | — |
| Budget | `budget-carein-staging` | **$50/mo**, alerts 80% actual + 100% forecast → admin@carein.ai | rg-carein-staging |
| Shared ACR | `acrcareincore` | **Basic**, admin disabled | rg-carein-core |
| Log Analytics | `log-carein-staging` | PerGB2018 | rg-carein-staging |
| Container Apps env | `cae-carein-staging` | consumption · static IP `20.118.124.16` · domain `redriver-8e85ebf8.southcentralus.azurecontainerapps.io` | rg-carein-staging |
| Postgres Flexible | `psql-carein-staging` | **Standard_B1ms** (Burstable), v16, 32GB, **HA disabled**, **geo-backup disabled**, 7-day backup | rg-carein-staging |
| Key Vault | `kv-carein-staging` | standard, **RBAC** | rg-carein-staging |
| Managed identity | `id-carein-staging` | clientId `d4647517-952f-4599-b168-ea1c6778a42a` | rg-carein-staging |
| Backend app | `ca-carein-backend` | internal ingress :5403, **min-replicas 0**/max 2, 0.5cpu/1Gi | rg-carein-staging |
| Caddy app | `ca-carein-caddy` | external ingress :8088, **min-replicas 0**/max 2, 0.25cpu/0.5Gi | rg-carein-staging |

**RBAC role assignments** (created via `az rest` — the `az role assignment`
wrapper is broken in this shell, see Gotchas):
- `id-carein-staging` → **Key Vault Secrets User** on `kv-carein-staging`
- `id-carein-staging` → **AcrPull** on `acrcareincore`
- `admin@carein.ai` → **Key Vault Secrets Officer** on `kv-carein-staging`

## Images (in `acrcareincore`)

| Image | Tag | Digest |
|---|---|---|
| `carein-backend` | `s2-012491e` (also `staging`) | `sha256:eb3b3ec8fd21e3013a33f4e122f883a2036b7789be9d9d15f3a648079fe78b86` |
| `carein-caddy` | `s2-012491e` | `sha256:a23309314ae4cba83c80b82ce5cf7948c426d2a68a90cbe3e547a23a3d75dfce` |

- `carein-backend` built from `backend/Dockerfile` (Node 22, CommonJS, API only).
- `carein-caddy` built from `deploy/container/azure/Dockerfile.caddy` — bakes the
  SPA (built with `VITE_API_URL=/api`) + the parameterized `deploy/container/Caddyfile`.
  `BACKEND_ORIGIN` injects the backend internal FQDN at runtime.

## Endpoints

- **Working staging URL:** `https://staging.carein.ai` (custom domain **bound** with an
  Azure-managed DigiCert cert; IP-allowlisted to the admin workstation).
- Default ingress FQDN (still valid): `https://ca-carein-caddy.redriver-8e85ebf8.southcentralus.azurecontainerapps.io`
- Backend internal FQDN: `https://ca-carein-backend.internal.redriver-8e85ebf8.southcentralus.azurecontainerapps.io`

## Secrets (Key Vault `kv-carein-staging`, NAMES only)

`control-db-url` (carein_owner) · `tenant-carein-db-url` (carein_app) ·
`dashboard-api-token` · `dashboard-session-secret` · `dashboard-sso-client-secret`
(copied from `kv-carein-core`) · `psql-staging-admin-password`.

The backend reads these at runtime via the managed identity:
- `config/secrets.js` (managed-identity branch) loads the SECRET_MAP entries
  (`control-db-url`, `dashboard-session-secret`, `dashboard-sso-client-secret`, …)
  from `kv-carein-staging`, gated by `AZURE_USE_MANAGED_IDENTITY=true` +
  `AZURE_MANAGED_IDENTITY_CLIENT_ID` + `AZURE_KEY_VAULT_NAME=kv-carein-staging`.
- `tenant-carein-db-url` is resolved per-request via `getSecretValue` (MI → KV).
- `dashboard-api-token` (not in SECRET_MAP) is injected as a Container Apps **Key
  Vault secret reference** env var via the same identity.

## Database

`psql-carein-staging` hosts two DBs owned by `carein_owner`:
- `carein_control` — control plane (migrated + seeded: tenant `carein`, clinics
  1 Roland / 2 Valley, module `carein`, `app_user admin@carein.ai`, connector =
  placeholder `https://connector-placeholder.staging.carein.ai`).
- `carein_t_carein` — per-tenant data plane (`call_record`, `audit_log`).

Roles: `carein_owner` (DDL/owner, used for `CONTROL_DB_URL`) and `carein_app`
(least-privilege login, used for `TENANT_CAREIN_DB_URL`). `audit_log` is
append-only for `carein_app`: `UPDATE`/`DELETE` are **denied at the DB** (42501),
verified by `scripts/smoke-spine.js` (12/12).

> Azure specifics handled: `azure.extensions=PGCRYPTO` allow-listed; `public`
> schema ownership granted to `carein_owner`; `sslmode=require` works (Node trusts
> Azure's DigiCert CA — full verification).

## Networking posture (pre-§6, temporary)

Postgres public access is **Enabled** with a firewall allowlist:
`allow-admin-workstation` (70.185.80.134/32) + `allow-azure-services` (0.0.0.0,
so the Container Apps reach it). **§6 replaces this with VNet + private endpoints**
and disables public access; re-verify §5 over the private path afterward.

## Custom domain `staging.carein.ai` — BOUND

DNS (GoDaddy `carein.ai` zone) verified propagated and the hostname is bound with
an Azure-managed certificate:

```
CNAME  staging              ca-carein-caddy.redriver-8e85ebf8.southcentralus.azurecontainerapps.io
TXT    asuid.staging        1CA6D6C4B719F29F8781888441CF6AC6905CD268B88AECB1F985EB97A470A901
```

- Binding: `SniEnabled` on `ca-carein-caddy`.
- Managed cert: `mc-cae-carein-sta-staging-carein-a-9435` — provisioningState
  **Succeeded**, subject `staging.carein.ai`, issuer DigiCert (GeoTrust TLS RSA CA
  G1), valid **2026-06-04 → 2026-12-04** (Azure auto-renews).
- SSO redirect URI `https://staging.carein.ai/auth/callback` is registered on
  `CareIN-Dashboard-SSO`; `/auth/login` 302s to Microsoft with that redirect_uri.

Bind was done with (Git-Bash `MSYS_NO_PATHCONV=1`):
```
az containerapp hostname add  -g rg-carein-staging -n ca-carein-caddy --hostname staging.carein.ai
az containerapp hostname bind -g rg-carein-staging -n ca-carein-caddy --hostname staging.carein.ai \
  --environment cae-carein-staging --validation-method CNAME
```

## Acceptance checklist (§5) results

| Check | Result |
|---|---|
| `/api/health` via external caddy | ✅ 200, `environment: production` |
| Backend prod boot (MI → Key Vault → control DB → audit gate) | ✅ (health 200 proves the gate passed) |
| SPA loads + client-route fallback (`/calls`) | ✅ 200, `<div id="root">` |
| Control DB + tenant resolution (`/auth/me`, minted SSO cookie) | ✅ tenant `carein` / "CareIN Dental LLC" |
| Auth fail-closed (no creds) | ✅ 401 |
| Tenant context resolves over HTTP (`/api/callbacks` + cookie) | ✅ 200 |
| **clinicNum not in tenant → 403** (`/api/slot-markers?clinicNum=999999`) | ✅ 403 `CLINIC_FORBIDDEN` (entitled clinic 1 → 503 `CONNECTOR_UNREACHABLE`, i.e. passed entitlement) |
| **audit_log UPDATE/DELETE denied at DB** (`carein_app`) | ✅ 42501 (smoke-spine 12/12) |
| **Non-allowlisted IP refused** (ingress allowlist) | ✅ dummy-only allow → my IP 403; my IP allow → 200 |
| **Scale-to-zero** (both apps min-replicas 0) | ✅ see runbook output (both reached 0 replicas when idle) |

## Gotchas captured

- **Git-Bash MSYS path conversion** mangles any `az` arg starting with
  `/subscriptions/...` into `c:/program files/git/subscriptions/...`. Set
  `MSYS_NO_PATHCONV=1`. This caused the early `az role assignment`
  ("MissingSubscription") and `--registry-identity` failures; `az rest` worked
  because the id sat inside a full URL.
- The runbook referenced `backend/scripts/secrets.js`; the actual loader is
  **`backend/config/secrets.js`** — the managed-identity branch was added there.
- `containerapp` CLI extension is preview `1.3.0b4`.

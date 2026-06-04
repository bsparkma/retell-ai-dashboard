# Local dev Postgres — Phase 1 switch-on ($0, no Azure)

Stands up a **local Docker Postgres 16** hosting both Phase 1 databases and the
least-privilege `carein_app` role, so you can run `PHASE1_SWITCHON_RUNBOOK.md`
Section 1 entirely on localhost. No Azure Postgres, no Key Vault — dev resolves
every secret from `backend/.env`, never the vault.

| Database | Role | Purpose |
|----------|------|---------|
| `carein_control` | `carein_owner` (owner) | control plane / tenant registry |
| `carein_t_carein` | `carein_owner` (owner) | CareIN's per-tenant data plane |
| — | `carein_app` (LOGIN, non-owner) | app runtime — `INSERT,SELECT` only on `audit_log` |

Default host port **55433** (override with `CAREIN_PG_HOST_PORT`). Passwords are
LOCAL-ONLY throwaways (`dev/local/.env.example`); change them in a gitignored
`dev/local/.env` if you like.

## 1. Bring it up

```powershell
cd dev/local
docker compose up -d          # creates carein_control, carein_t_carein, role carein_app
```

## 2. Set these in `backend/.env`

```dotenv
CONTROL_DB_URL=postgres://carein_owner:carein_owner_devpw@localhost:55433/carein_control
TENANT_CAREIN_DB_URL=postgres://carein_app:carein_app_devpw@localhost:55433/carein_t_carein
CAREIN_SEED_CONNECTOR_URL=http://<YOUR-REAL-CONNECTOR-HOST>:<PORT>
```

- `TENANT_CAREIN_DB_URL` uses **carein_app** (non-owner) on purpose — that is what
  enforces the append-only audit posture at runtime.
- `CAREIN_SEED_CONNECTOR_URL` must be your **real** on-prem connector (not
  localhost) — it is seeded into the registry and used for the live OD checks.
- If you changed `CAREIN_APP_PASSWORD`, use the same value here.

## 3. Migrate + seed (run from `backend/`)

```powershell
cd backend

# 3a. Control plane: schema + seed CareIN as tenant #1 (needs the real connector)
npm run migrate:up

# 3b. Per-tenant DB: run migrations as the OWNER so CREATE TABLE + the audit_log
#     GRANT succeed; the grant targets carein_app, which already exists.
$env:MIGRATE_TENANT_DB_URL = "postgres://carein_owner:carein_owner_devpw@localhost:55433/carein_t_carein"
npm run migrate:tenant up -- --tenant carein
Remove-Item Env:\MIGRATE_TENANT_DB_URL
```

The `carein_app` role and `carein_t_carein` DB are created by the compose init
script (`initdb/01-init-roles-and-tenant-db.sh`) on first `up` — no manual
`createdb`/`CREATE ROLE` needed. (Manual equivalents, if not using compose:
`CREATE ROLE carein_app LOGIN PASSWORD '…';` and `CREATE DATABASE carein_t_carein;`
before step 3b.)

## 4. Smoke-test the spine

```powershell
cd backend
node scripts/smoke-spine.js   # registry / tenantDb / audit / append-only / entitlement
```

Expect `12/12 checks passed`. Then do the manual sign-in + live-OD checks in
`PHASE1_SWITCHON_RUNBOOK.md` 1.4.

## Reset

```powershell
cd dev/local
docker compose down -v        # wipes the volume (and the seed) for a clean re-run
```

# Phase 1 Switch-On Runbook

_Turns the build-complete platform spine into CareIN running live as tenant #1. Do DEV fully and smoke-test before touching PROD. Drafted 2026-06-02._

The build is verified against ephemeral Postgres + mocked OD. This runbook is the **real acceptance test**: live databases, live Open Dental, real sign-in.

---

## 0. Prerequisite you still owe: the real connector URL

Everything OD-via-connector needs the actual on-prem CareIN connector address (NOT `localhost:8444`). Find it from your running connector (likely something like `http://10.20.30.250:8443`). You'll use it as `CAREIN_SEED_CONNECTOR_URL` (dev + prod). Nothing below fully smoke-tests the slot-markers path without it.

---

## 1. DEV switch-on (prove it locally first)

**1.1 Control database**
- Stand up a Postgres for `carein_control` (local Docker or an Azure dev DB).
- Set `CONTROL_DB_URL` in the backend dev env.
- Run control-plane migrations + seed, with the connector URL supplied:
  ```
  set CAREIN_SEED_CONNECTOR_URL=http://<real-connector-host>:<port>
  npm run migrate:up        # control-plane: schema + seed CareIN tenant #1
  ```

**1.2 CareIN's per-tenant database**
- The local Docker stack (`dev/local/docker-compose.yml`) creates `carein_t_carein` and the `carein_app` role on first `up`. For a manual/non-Docker setup, create both yourself.

**1.3 Append-only role + the owner/app migration split (IMPORTANT)**
- The non-owner `carein_app` login gets only `INSERT, SELECT` on `audit_log` (the migration applies this grant). `TENANT_CAREIN_DB_URL` (the app runtime URL) points at **`carein_app`** so you exercise the real append-only posture.
- **But migrations must run as the OWNER, not `carein_app`** — `carein_app` cannot `CREATE TABLE` or apply grants. So run per-tenant migrations with the owner URL via the runner's override, then let the app run as `carein_app`:
  ```
  # migrate as OWNER (one-time / on schema change):
  MIGRATE_TENANT_DB_URL=postgres://<owner>:<pw>@<host>/carein_t_carein  npm run migrate:tenant up -- --tenant carein
  # runtime uses carein_app via TENANT_CAREIN_DB_URL in .env
  ```
  (PowerShell: `$env:MIGRATE_TENANT_DB_URL = "..."` before the command, then `Remove-Item Env:\MIGRATE_TENANT_DB_URL`.)

**1.4 Run + smoke-test**
- Start backend (dev, port 5103) + `new-dashboard` (3105). Sign in as `admin@carein.ai` (SSO).
- Verify, in order:
  - Dashboard loads; **practice name "CareIN Dental LLC" shows in the header** (tenant context flowing).
  - OD-backed features work against the **real connector / OD API**: slot-markers, calls, patient lookups. ← this is the live verification CC couldn't do.
  - `clinicNum` outside your tenant's clinics → 403 (entitlement guard).
  - Rows land in `audit_log` for OD/PHI reads + writes; confirm `UPDATE/DELETE` on `audit_log` as `carein_app` is denied.
  - No unexpected 403/503 on normal use; PHI absent from logs (`data/access-log.jsonl` paths redacted).

If 1.4 passes against live OD, Phase 1 is functionally proven.

---

## 2. Commit the spine (before prod)

You have a large uncommitted changeset. Commit as logical units, not one blob:
1. `Add control-plane registry schema, migrations, and registry module`
2. `Add tenant-context middleware with fail-closed resolution and clinic entitlement`
3. `Add tenant-aware per-tenant Postgres data layer and migration track`
4. `Add unified tenant-aware Open Dental access layer (odAccess)`
5. `Add tenant provisioning routine and docs`
6. `Add per-tenant append-only HIPAA audit log and PHI log scrubbing`
7. `Wire SPA tenant context and complete non-OD audit sweep`
(Plus the earlier email/identity work: Key Vault loader, OD api-mode reconciliation, SSO + socket auth, health-check fix — commit those too if not already.)

---

## 3. PROD switch-on (only after DEV passes + committed)

1. Provision `carein_control` on Azure Postgres; put its conn string in Key Vault as `control-db-url`; run control migrations + seed with prod `CAREIN_SEED_CONNECTOR_URL`.
2. Provision `carein_t_carein` on Azure Postgres; create the `carein_app` role (INSERT+SELECT on `audit_log`); run per-tenant migrations **as the owner** (via `MIGRATE_TENANT_DB_URL` = owner URL — `carein_app` can't `CREATE TABLE`); then put the **`carein_app`** conn string in Key Vault as `tenant-carein-db-url` for the app runtime.
3. Set the tenant's `connector_url` in the registry to the prod connector address.
4. Add the **prod SSO redirect URI** to the `CareIN-Dashboard-SSO` app registration (still pending from the SSO work — `az ad app update`, command in `docs/SSO.md`).
5. **Sequence matters:** the DBs must exist and be reachable BEFORE the tenant-context middleware goes live, or `/api` fails closed (503). Provision first, then deploy the spine, then cut PM2 over.
6. Smoke-test on the office LAN exactly as in 1.4.

---

## 4. After switch-on — Phase 2 backlog (already documented in repo)

Carried in `docs/SCHEDULER.md`, `PROVISIONING.md`, `AUDIT.md`, `PLATFORM_ARCHITECTURE.md`:
- **Slice 4b** — tenant-aware scheduler (Mango→OD cron, OD self-sync, `admin.js`) + **Retell agent/phone → tenant mapping** (the inbound-call tenant resolver; load-bearing for the voice product).
- **Slice 3b** — `unified_calls.json` → `call_record` cutover (+ backfill `clinic_num`).
- Entra External ID customer login (remove the `@carein.ai` bootstrap fallback; provision real `app_user` rows).
- TC + RCM modules (registry rows exist, disabled).
- Cross-server tenant DBs (`--db-admin-url`) when a tenant needs its own server.
- SPA: derive the clinic list from `req.tenant.clinics` (still hardcoded `offices`).

# Phase 1 PRD — Platform Spine (Multi-Tenancy Foundation)

_SaaS Strike Team · Build Mode · drafted 2026-06-02. Turns CareIN from a single-tenant on-prem app into a multi-tenant platform by extracting the shared spine and making CareIN "tenant #1." Companion to `PLATFORM_ARCHITECTURE.md`._

---

## HELM — Build Session: Platform Spine

**Objective:** Introduce a real tenant concept end-to-end — control-plane registry, per-tenant database isolation, tenant-scoped request context, and per-tenant Open Dental connector routing — without breaking the working CareIN deployment, which becomes tenant #1.

**Mode:** Build. MASON leads; STRATA reviews schema before code; DOMAIN advises on OD/clinic modeling; COMPLY is a hard gate on PHI isolation + audit logging.

**Stack (confirmed, NOT the strike-team default):** Node/Express **CommonJS** backend (`backend/`), React 19 + Vite SPA (`new-dashboard/`), **Postgres** for platform/app data (new), **per-tenant database** isolation, Open Dental reached via the existing connector (api mode now, on-prem agent later), Azure Key Vault for secrets, Entra External ID for customer identity (later phase). SSO already built (`CareIN-Dashboard-SSO`).

**Build order (each slice ships and is verifiable before the next):**
0. Discovery + control-plane scaffold
1. Tenant Registry schema + seed CareIN as tenant #1
2. Tenant context resolution (SSO session → tenant) middleware
3. Tenant-aware data layer (per-tenant Postgres, conn string from Key Vault)
4. Tenant-aware OD connector routing (unified access layer)
5. Provisioning routine (onboard tenant N)
6. Per-tenant audit log + PHI-safe logging
7. Refactor CareIN to resolve everything by tenantId; verify as tenant #1

---

## DOMAIN — Tenant vs. Clinic (read before schema)

**A tenant is a customer practice/organization, not a clinic.** Your own org is tenant #1 and already contains two clinics: Roland (`ClinicNum=1`) and Valley/Fort Smith (`ClinicNum=2`). So the hierarchy is:

```
Tenant (practice org)  ─┬─ Clinic (OD ClinicNum)  ─── patients / appts / procedures (OD)
                        └─ Connector (per-tenant: on-prem agent URL or OD cloud API)
```

**Implications for the build:**
- `ClinicNum` scoping stays exactly as it is — it operates *inside* a tenant. Tenant scoping is a new layer **above** ClinicNum. Every OD query becomes "tenant T → its connector → scoped by ClinicNum."
- The OD connector is **per-tenant** (each practice runs its own, on-prem or cloud). The registry stores how to reach each tenant's connector.
- The per-tenant **Postgres** database holds *your platform's* data (call annotations/tags, module state, sync cursors, audit log) — NOT the practice's Open Dental data, which stays in their OD MySQL and is reached live via the connector.
- Honor the hard OD rules from production: never delete OD records, no `SELECT *`, `procCode→CodeNum` lookups preserved, writes go through the connector service only.

---

## STRATA — Data Architecture

### Two planes
- **Control plane (one shared Postgres DB, `carein_control`):** the tenant registry and platform metadata. Small, low-PHI (config + IDs only). This is the catalog every request consults.
- **Data plane (one Postgres DB per tenant, `carein_t_{tenantId}`):** that tenant's app data. Strong isolation — a query bug cannot cross tenants because it's a different database/connection.

### Control-plane schema (sketch — STRATA to finalize naming/indexes)
```sql
-- carein_control
CREATE TABLE tenant (
  tenant_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             text UNIQUE NOT NULL,          -- 'carein', 'smithdental'
  display_name     text NOT NULL,
  status           text NOT NULL DEFAULT 'active',-- active|suspended|provisioning
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_database (
  tenant_id        uuid PRIMARY KEY REFERENCES tenant(tenant_id),
  kv_conn_secret   text NOT NULL,                 -- Key Vault secret NAME holding the per-tenant DB conn string
  db_name          text NOT NULL
);

CREATE TABLE tenant_connector (
  tenant_id        uuid NOT NULL REFERENCES tenant(tenant_id),
  od_mode          text NOT NULL,                 -- 'api' | 'agent'
  od_base_url      text,                          -- api mode: api.opendental.com base; agent mode: gateway route id
  kv_dev_key       text,                          -- KV secret name (OD developer key)
  kv_cust_key      text,                          -- KV secret name (OD customer key)
  PRIMARY KEY (tenant_id)
);

CREATE TABLE tenant_clinic (
  tenant_id        uuid NOT NULL REFERENCES tenant(tenant_id),
  clinic_num       int  NOT NULL,                 -- OD ClinicNum within this tenant
  name             text NOT NULL,
  PRIMARY KEY (tenant_id, clinic_num)
);

CREATE TABLE tenant_module (
  tenant_id        uuid NOT NULL REFERENCES tenant(tenant_id),
  module           text NOT NULL,                 -- 'carein' | 'tc' | 'rcm'
  enabled          boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, module)
);

CREATE TABLE app_user (
  user_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(tenant_id),
  email            text NOT NULL,                 -- carein.ai (now) / Entra External ID (later)
  role             text NOT NULL DEFAULT 'staff',
  UNIQUE (tenant_id, email)
);
```
- **Secrets never live in the control DB** — only Key Vault *secret names*. The resolver reads the actual conn string / OD keys from Key Vault at request time.
- **Migrations:** introduce a real migration tool (e.g. `node-pg-migrate` or Knex, CommonJS-compatible). Every change versioned and reversible. STRATA reviews before Slice 1.
- **Seed:** CareIN = tenant #1, with its two clinics, `od_mode='api'`, and CareIN module enabled — pointing at the secrets already in `kv-carein-core`.

---

## COMPLY — Gate (hard requirements for Phase 1)

PHI isolation and audit are not "later" — they're foundational and must land in Phase 1.

```
REVIEWED: Phase 1 platform spine (tenancy, data layer, connector routing, audit)
HIPAA STATUS: GAPS FOUND (expected pre-build) — the following are REQUIRED FIXES in-scope:

PHI HANDLING
  Isolation: per-tenant DB chosen ✓ — but the data layer MUST make cross-tenant access structurally impossible:
    - Every data-plane connection is resolved from req.tenantId; no shared/global pool that ignores tenant.
    - Every OD connector call is resolved from req.tenantId; no hardcoded connector URL remains.
    - No API route returns data without a resolved tenant context (fail closed → 403 if tenant unresolved).
  Encryption: rely on Azure TDE at rest + TLS in transit; per-tenant DB conn strings in Key Vault only.
  Audit logging: REQUIRED in Slice 6 — append-only, per-tenant, fields: ts(UTC), user_id, tenant_id,
    action, resource_type, resource_id, ip, result. NEVER log PHI values — log resource IDs only.
  BAA: Azure BAA in place. Per-customer BAA required before any non-CareIN tenant goes live (gate at onboarding, not now).

COMPLY GATE: HOLD until Slices 2, 3, 4, 6 land. Any cross-tenant data path = FAIL.
```

---

## MASON — Build Plan: Platform Spine

**Estimated slices:** 8 (0–7). **Effort:** sizable — scope tightly, consider a contractor for the heavy data-layer/provisioning slices (3–5). Build the vertical slice for tenant #1 first; don't generalize until CareIN works through the new spine.

Each slice below has a paste-ready Claude Code prompt. Run them in order; verify the integration checkpoint before continuing. Every prompt assumes repo root `C:\Users\beau\carein cursor dashboard`, honors `CLAUDE.md` rules (CommonJS backend, TS strict in `new-dashboard`, no `any`, no `SELECT *`, never read/modify `.env`, OD via connector only, ClinicNum scoping), and commits nothing.

---

### Slice 0 — Discovery + control-plane scaffold
**What:** Inventory current persistence/assumptions so the build adapts to reality, and scaffold the control-plane DB + migration tooling.

**Cursor/CC prompt:**
> Do a read-only discovery pass on this repo, then scaffold control-plane infrastructure. (1) Report: where does the backend currently persist app data (any Postgres/SQLite/in-memory), how is the Open Dental connector base URL configured today (file + line), where is ClinicNum used, and how does a request currently know which clinic/practice it's for. Do NOT change code in this step — output findings only. (2) Then add a migration tool compatible with the CommonJS backend (node-pg-migrate or Knex — pick one, justify briefly), wired to a new Postgres control database `carein_control` whose connection string is read from env (`CONTROL_DB_URL`) in dev and from Key Vault (`control-db-url`) in prod via the existing `backend/config/secrets.js` loader. Create the migrations folder and an empty initial migration. node --check / build must pass. Don't commit. Respect CLAUDE.md.

**Integration checkpoint:** discovery report reviewed by you; migration tool runs an empty up/down cleanly.

---

### Slice 1 — Tenant Registry schema + seed CareIN as tenant #1
**What:** The control-plane tables and CareIN seeded as the first tenant.

**STRATA reviews this slice's schema before code.**

**Cursor/CC prompt:**
> Create the control-plane schema in `carein_control` via a migration, using the tables in PHASE1_PRD_PLATFORM_SPINE.md (tenant, tenant_database, tenant_connector, tenant_clinic, tenant_module, app_user) — finalize indexes and constraints sensibly, name all columns, no SELECT *. Add a CommonJS data-access module `backend/platform/registry.js` exposing typed (JSDoc) functions: getTenantBySlug, getTenantById, getTenantConnector, getTenantClinics, getEnabledModules, getTenantDbRef. Add a seed migration that inserts CareIN as tenant #1: slug 'carein', its two clinics (ClinicNum 1 Roland, 2 Valley), od_mode 'api', module 'carein' enabled, and tenant_database / tenant_connector rows that reference the EXISTING kv-carein-core secret NAMES (opendental-developer-key, opendental-customer-key, and a new control-plane-managed per-tenant app DB). Do not put secret values anywhere — only KV secret names. node --check passes; migration up/down reversible. No commit.

**Integration checkpoint:** `registry.getTenantBySlug('carein')` returns the seeded tenant with its clinics, connector, and modules.

---

### Slice 2 — Tenant context middleware (SSO session → tenant)
**What:** Every request resolves a tenant from the authenticated user; unresolved = fail closed.

**CORE owns this.**

**Cursor/CC prompt:**
> Add Express middleware `backend/middleware/tenantContext.js` (CommonJS) that runs AFTER `requireDashboardAuth`. It reads the authenticated user (from the SSO session JWT / `/auth/me` identity) , looks up app_user → tenant_id in the registry, and attaches `req.tenant = { id, slug, modules }`. If no tenant resolves, respond 403 (fail closed) — never proceed without a tenant. Mount it on all `/api` routes. For tenant #1 bootstrapping, map the existing carein.ai SSO users to the CareIN tenant via app_user seed rows. Add a typed accessor so route handlers read req.tenant safely. Unit-test: authed user with tenant → context set; authed user with no tenant mapping → 403; anon → already 401 from auth. node --check passes. No commit. Respect CLAUDE.md.

**Integration checkpoint:** existing dashboard calls still succeed for your carein.ai login; a synthetic user with no tenant mapping gets 403.

---

### Slice 3 — Tenant-aware data layer (per-tenant Postgres)
**What:** Resolve the correct per-tenant DB connection per request from the registry + Key Vault. No global shared pool.

**STRATA + CORE. COMPLY gates this.**

**Cursor/CC prompt:**
> Build a tenant-aware Postgres data layer. Add `backend/platform/tenantDb.js` (CommonJS) exposing `getTenantPool(tenantId)` that: looks up tenant_database.kv_conn_secret in the registry, fetches the connection string from Key Vault (prod) or env (dev) via the existing secrets loader, and returns a cached pg Pool per tenant (lazy-created, reused). NO global/default pool that ignores tenant — callers MUST pass a tenantId or the resolved req.tenant.id. Add a thin `withTenantDb(req, fn)` helper that pulls req.tenant.id and hands the handler the right pool, so route code can't accidentally use the wrong tenant. Provision CareIN's per-tenant app DB (`carein_t_<id>`) and store its conn string in Key Vault under the name referenced by the seed. Include an initial per-tenant app-schema migration (start minimal — e.g. a `call_annotation` table keyed by clinic_num + OD ids, named columns, no SELECT *). Document the dev vs prod connection resolution in docs/SECRETS.md. node --check passes. No commit. Respect CLAUDE.md and COMPLY: a cross-tenant connection must be structurally impossible.

**Integration checkpoint:** a request as CareIN reads/writes only `carein_t_<careinId>`; attempting access without req.tenant throws before any query.

---

### Slice 4 — Tenant-aware OD connector routing (unified access layer)
**What:** OD calls resolve the tenant's connector (api vs agent) from the registry; modules call one interface.

**CORE + DOMAIN. Builds on the existing api-mode OD client.**

**Cursor/CC prompt:**
> Refactor the Open Dental access path into a tenant-aware unified layer. Add `backend/platform/odAccess.js` (CommonJS) exposing methods the modules use (e.g. getAppointments(req, {clinicNum,...}), getPatient(req,...), postCommlog(req,...)) that: resolve req.tenant.id → tenant_connector in the registry → choose path. For od_mode='api', call the existing OD API client using THAT tenant's developer/customer keys fetched from Key Vault (CareIN's are already there); for od_mode='agent', call a per-tenant connector gateway base URL (stub the agent path for now with a clear NotImplemented that logs the intended route — the agent itself is Phase 2). Preserve all hard OD rules: ClinicNum scoping on every call, procCode→CodeNum lookups intact, never SELECT *, writes through the connector only, never delete OD records. Replace existing hardcoded OD base-URL usage so no module reaches OD except through odAccess. node --check passes. No commit. Respect CLAUDE.md.

**Integration checkpoint:** CareIN's existing OD-backed dashboard features work unchanged through `odAccess` in api mode; agent mode returns a clean NotImplemented.

---

### Slice 5 — Provisioning routine (onboard tenant N)
**What:** One command/endpoint that stands up a new tenant end-to-end. This is what proves you can sell.

**CORE owns. COMPLY gates onboarding (BAA check).**

**Cursor/CC prompt:**
> Create an internal provisioning routine `backend/platform/provisionTenant.js` (CommonJS) runnable as a script (node script + CLI args) that, given slug/display_name/od_mode/clinics, performs: (1) create the tenant + clinics + module rows in carein_control; (2) create the per-tenant Postgres DB and run its app-schema migrations; (3) write placeholders/instructions for the per-tenant Key Vault secrets (DB conn string + OD keys) WITHOUT real values — emit a `.local/provision-<slug>.ps1` (gitignored) for the operator to fill and run, exactly like set-keyvault-secrets.ps1; (4) print a checklist including "signed BAA on file? (required before go-live)". Idempotent and safe to re-run. Make NO outbound calls with real secrets, read no .env values. Document the flow in docs/PROVISIONING.md. node --check passes. No commit. Respect CLAUDE.md.

**Integration checkpoint:** dry-run provisioning a fake tenant 'demo' creates registry rows + DB + a placeholder secrets script, with CareIN untouched.

---

### Slice 6 — Per-tenant audit log + PHI-safe logging
**What:** HIPAA-required append-only audit of PHI access, per tenant. COMPLY hard requirement.

**COMPLY + BEACON + CORE.**

**Cursor/CC prompt:**
> Add a per-tenant, append-only audit log. Create `backend/platform/audit.js` (CommonJS) with `audit(req, {action, resourceType, resourceId, result})` that writes one row per PHI-touching action to an append-only `audit_log` table (in the per-tenant DB or a dedicated audit store): fields ts(UTC), user_id, tenant_id, action(READ/CREATE/UPDATE/DELETE), resource_type, resource_id, ip, result(SUCCESS/UNAUTHORIZED/ERROR). NEVER store PHI values — resource IDs only. Make the table/stream append-only (no update/delete grants from the app). Call audit() in odAccess methods and any route returning patient data. Separately, scrub the existing logger so PHI never appears in logs/errors/URLs (review and fix any spots that log patient fields). Add a startup assertion that fails closed if the audit store is unreachable in prod. node --check passes. No commit. Respect CLAUDE.md + COMPLY.

**Integration checkpoint:** every OD-backed read/write emits an audit row scoped to the tenant; grep confirms no PHI in app logs.

---

### Slice 7 — Refactor CareIN to tenant #1 + verify
**What:** Remove remaining single-tenant assumptions; confirm CareIN runs entirely through the spine.

**MASON + GATE.**

**Cursor/CC prompt:**
> Sweep the backend and new-dashboard for remaining single-tenant assumptions and route them through the spine: every OD call goes through odAccess(req); every app-data query goes through the tenant pool resolved from req.tenant; the SPA carries tenant context from /auth/me (display tenant name; no tenant selection needed yet since one tenant). Remove or guard any hardcoded connector URL, ClinicNum default, or global DB pool. Then produce a short report: list every place tenant context is now enforced, every remaining TODO for true multi-tenant (e.g. agent connector path, Entra External ID customer login), and run node --check (backend) + tsc --noEmit (new-dashboard). Confirm CareIN's existing dashboard features still work as tenant #1. No commit. Respect CLAUDE.md.

**Integration checkpoint:** full CareIN dashboard works as tenant #1 with tenant context enforced end-to-end; report lists Phase 2 TODOs.

---

## Risk flags (MASON)
- **Data-layer + provisioning (Slices 3–5) are the heavy engineering.** Given your clinical time, this is the most defensible place to bring in a contractor — the rest you can supervise via CC.
- **Don't generalize prematurely.** Make CareIN work through the spine first (vertical slice). Resist building the agent connector (Phase 2) or Entra External ID (Phase 3) mid-Phase-1.
- **Audit log can't be retrofitted cheaply.** Do Slice 6 in Phase 1 — bolting HIPAA audit on later means touching every data path twice.
- **Connector agent is stubbed here on purpose.** Real per-practice on-prem agent + gateway is Phase 2; Phase 1 proves the routing seam exists.

## GATE — pre-conditions to call Phase 1 "done"
- COMPLY PASS: no cross-tenant data path; per-tenant DB resolution enforced; audit log live; no PHI in logs.
- STRATA: migrations reversible; CareIN seeded and reads/writes only its own DB.
- CareIN (tenant #1) fully functional through the new spine, verified.
- Slice 7 report lists Phase 2 TODOs (agent connector, External ID, TC/RCM modules).

---

## Next after Phase 1
Phase 2 = productize the on-prem connector agent + gateway (the stubbed `agent` path). Then Phase 3 (Azure hosting + Entra External ID), Phase 4 (TC + RCM as modules on this spine). See `PLATFORM_ARCHITECTURE.md` §7.

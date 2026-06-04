# Data Plane — Per-Tenant Databases

Two planes (PHASE1_PRD_PLATFORM_SPINE.md):

- **Control plane** — one shared `carein_control` Postgres DB: the tenant
  registry. Low-PHI config + IDs + Key Vault secret *names*. See
  [CONTROL_DB.md](./CONTROL_DB.md).
- **Data plane** — **one Postgres DB per tenant** (`carein_t_<...>`): that
  tenant's app data (call annotations, module state, audit, etc.). Strong
  isolation — a query bug cannot cross tenants because it's a different
  database and a different connection.

## How a request reaches the right database

```
req.tenant.id (resolved by tenantContext, never client input)
  → registry.getTenantDbRef(tenantId).kv_conn_secret      (a Key Vault secret NAME)
  → secrets.getSecretValue(name)                          (env in dev / Key Vault in prod)
  → cached per-tenant pg Pool                             (backend/platform/tenantDb.js)
```

- **No global/default pool exists.** `getTenantPool(tenantId)` refuses to run
  without an explicit tenant id; `withTenantDb(req, fn)` only ever reads
  `req.tenant.id`. A cross-tenant connection is structurally impossible
  (COMPLY gate).
- Route handlers should use `withTenantDb(req, async (pool) => { ... })` rather
  than touching pools directly, so the tenant id can only come from the
  resolved context.

## Migrations

Per-tenant (data-plane) migrations are **separate** from the control-plane
migrations and live in their own directory:

| Track | Dir | Runner | Target |
|-------|-----|--------|--------|
| Control plane | `backend/migrations/` | `scripts/migrate.js` | `carein_control` |
| Data plane (per tenant) | `backend/migrations-tenant/` | `scripts/migrate-tenant.js` | each `carein_t_<...>` |

```bash
# one tenant
npm run migrate:tenant -- up --tenant carein
npm run migrate:tenant -- down --tenant carein
# every tenant
npm run migrate:tenant -- up --all
# scaffold a new per-tenant migration
npm run migrate:tenant:create -- <name>
```

Each tenant DB keeps its own `pgmigrations` bookkeeping table, so tenants can be
at independent migration versions during a rollout.

## `call_record` (initial data-plane table)

`backend/migrations-tenant/<ts>_call_record.js` creates `call_record`, sized to
hold the merged Retell + Mango call records that currently live in
`data/unified_calls.json` (mirrors `unifiedCallStore.normalizeCall()`), plus a
`clinic_num` column. Named columns, no `SELECT *`; indexed by `clinic_num`,
`call_date`, `(clinic_num, call_date)`, and `external_id`, with a unique
`call_uid`.

## ⚠️ Cutover is a deliberate LATER step (Slice 3b)

This slice ships **schema + plumbing only**. The backend still reads and writes
`data/unified_calls.json` via `unifiedCallStore`. Migrating that JSON into
`call_record` (and switching the store to read/write Postgres) is intentionally
**not** done here — it is a separate step (**Slice 3b**) so the connection
layer can land and be verified without touching live call data. Until then:

- `call_record` exists but is empty (except provisioning/smoke rows).
- `data/unified_calls.json` remains the source of truth for calls.
- Do not point read paths at `call_record` until 3b backfills it and assigns
  `clinic_num`.

# Tenant Provisioning (Slice 5)

`backend/platform/provisionTenant.js` stands up a new tenant end-to-end. It is
**idempotent and re-runnable** — run it again to update fields (e.g. add a
`connector_url`) without creating duplicates.

```bash
cd backend
node platform/provisionTenant.js \
  --slug smithdental \
  --display-name "Smith Dental LLC" \
  --od-mode api \
  --clinics "1:Main,2:North" \
  [--connector-url https://connector.smithdental.example]
```

| Flag | Required | Notes |
|------|----------|-------|
| `--slug` | yes | lowercase `[a-z0-9-]`, starts with a letter; used to derive DB name + secret names |
| `--display-name` | yes | human-readable org name |
| `--od-mode` | no (default `api`) | `api` (OD cloud) or `agent` (on-prem connector, Phase 2) |
| `--clinics` | yes | `NUM:Name` pairs, comma-separated — the tenant's OD ClinicNums |
| `--connector-url` | no | on-prem connector base URL; omit → stored as `null` (pending) |

## What it does

1. **Control-plane rows** (`registry.createTenant`, one transaction): `tenant`,
   `tenant_database`, `tenant_connector`, `tenant_clinic`(s), `tenant_module`(s)
   — every module **off except `carein`**. Only Key Vault secret **NAMES** are
   stored, never values:
   | Row | Secret name(s) |
   |-----|----------------|
   | `tenant_database.kv_conn_secret` | `tenant-<slug>-db-url` |
   | `tenant_connector.kv_od_dev_key` / `kv_od_cust_key` | `opendental-<slug>-developer-key` / `opendental-<slug>-customer-key` |
   | `tenant_connector.kv_connector_key` | `od-connector-<slug>-api-key` |

   New tenants are created with **`status = 'provisioning'`** — see the BAA gate.
2. **Per-tenant database** `carein_t_<slug>` on the same server as
   `carein_control` (guarded: skipped if it already exists).
3. **Per-tenant migrations** via the existing `scripts/migrate-tenant.js` runner,
   pointed at the freshly-created DB through `MIGRATE_TENANT_DB_URL` (so it works
   before the durable KV secret exists). Creates `call_record` etc.
4. **Placeholder secret script** `.local/provision-<slug>.ps1` (gitignored, same
   pattern as `set-keyvault-secrets.ps1`): `az keyvault secret set` commands with
   `<PLACEHOLDER…>` values only. The operator fills in real values and runs it.
5. **Onboarding checklist** printed to stdout (BAA, connector_url, Retell mapping).

It makes **no outbound calls with real secrets** and reads no `.env` file (only
`process.env.CONTROL_DB_URL`, resolved by `loadSecrets`).

## COMPLY — BAA gate

A new tenant lands as **`provisioning`**, not `active`. Going live is a deliberate
operator step **after the signed BAA is on file**:

```sql
-- only after BAA confirmed:
UPDATE tenant SET status = 'active' WHERE slug = '<slug>';
```

## Operator follow-up after provisioning

1. Fill `.local/provision-<slug>.ps1` with real values and run it (prod), or set
   the derived env vars in `backend/.env` (dev, e.g. `TENANT_<SLUG>_DB_URL`).
2. If `connector_url` was pending, re-run provisioning with `--connector-url …`.
3. Confirm the **signed BAA**, then flip `status` to `active`.
4. Phase 2: add the **Retell agent / phone-number → tenant** mapping so the voice
   agent's tool calls resolve this tenant (see [SCHEDULER.md](./SCHEDULER.md)).

## Dev dry-run

Against an ephemeral Postgres with `carein_control` migrated + seeded:

```bash
CONTROL_DB_URL=postgres://postgres:postgres@localhost:5432/carein_control \
node platform/provisionTenant.js --slug demo --display-name "Demo Dental LLC" \
  --od-mode api --clinics "1:Roland,2:Valley"
```

creates the `demo` rows + `carein_t_demo` DB + its schema + `.local/provision-demo.ps1`,
leaving CareIN (tenant #1) untouched.

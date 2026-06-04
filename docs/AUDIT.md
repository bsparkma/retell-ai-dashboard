# Per-Tenant HIPAA Audit Log (Slice 6)

COMPLY hard requirement: every PHI-touching action is recorded in an append-only,
per-tenant audit trail, and PHI never appears in application logs.

## `audit_log` table (per-tenant data plane)

Created by `backend/migrations-tenant/<ts>_audit_log.js` in each tenant's own
database. Stores **resource IDs and actor/source only — never a PHI value**.

| Column | Notes |
|--------|-------|
| `audit_id` | uuid PK (`gen_random_uuid()`) |
| `ts` | timestamptz, default `now()` (UTC) |
| `user_id` | acting staff identity (email/oid) — not patient PHI |
| `tenant_id` | uuid |
| `action` | `READ` \| `CREATE` \| `UPDATE` \| `DELETE` (CHECK) |
| `resource_type` | e.g. `patient`, `appointment`, `call`, `slot_marker` |
| `resource_id` | ID only — never a PHI value (a search query → `null`) |
| `ip` | source IP |
| `result` | `SUCCESS` \| `UNAUTHORIZED` \| `ERROR` (CHECK) |
| `endpoint` | optional, **scrubbed** request path |

Indexes: `(ts)` and `(resource_type, resource_id)`.

### Append-only (two-role model — REQUIRED in any env holding PHI)

The migration grants the least-privilege **app role** only `INSERT, SELECT` on
`audit_log` (no `UPDATE`/`DELETE`/`TRUNCATE`), so the app can append and read the
trail but cannot alter or erase it. This requires two roles:

- **migrations** run as an owner/admin role (creates the table);
- the **app** connects (per-tenant DB conn string) as a **separate** role —
  default name `carein_app`, override with `AUDIT_APP_ROLE` at migration time.

If that role doesn't exist when the migration runs (e.g. local dev on a
superuser), the grant is **skipped with a NOTICE** — append-only is only enforced
once the role exists. Verified behavior: as `carein_app`, `INSERT`/`SELECT`
succeed and `UPDATE`/`DELETE` return *permission denied*.

> Owner caveat: if the app role also OWNS the table, ownership privileges
> override the grant. Keep the app role distinct from the table owner.

## `audit(req, {...})` — `backend/platform/audit.js`

```js
await audit.audit(req, { action: 'READ', resourceType: 'patient', resourceId: patNum, result: 'SUCCESS' });
```

Resolves the tenant pool from `req.tenant.id` (per-tenant store), and fills
`user_id`/`ip`/`endpoint` from `req` (endpoint scrubbed). **Fail-closed**: a
failed write throws `AuditError`. On a PHI path the caller must let it propagate,
so PHI is never served without a recorded trail.

`audit.assertReady()` — called at startup (`server.js`, after `loadSecrets`).
In **production** it verifies the audit store is reachable for every **active**
tenant and **aborts startup** if any is unreachable. No-op in dev.

## Where it's instrumented

- **OD access — the choke point.** Slice 4 made `odAccess` the only path to OD,
  so the PHI-bearing `odAccess` methods (patient/appointment reads, slot-markers,
  booking/update/cancel) are wrapped to emit one audit row each. Non-PHI
  reference reads (providers, operatories, scheduling rules, status, sync,
  connection test) are **not** audited.
- **Non-OD patient data.** `GET /api/unified-calls/:id` and `/phone/:phoneNumber`
  (call records contain transcripts = PHI) audit before responding.
  - **TODO (Slice 7 sweep):** the unified-calls **list** endpoint and the
    callbacks routes also surface patient names — instrument them the same way.

## PHI-in-logs scrub — `backend/utils/scrub.js`

`sanitizeUrlPath()` drops query strings and redacts name/phone path params
(`/patient-suggestions/<name>`, `/phone/<number>`). Wired into:
- **morgan** (`server.js`): the `:url` token is overridden so stdout request logs
  carry a scrubbed URL.
- **`data/access-log.jsonl`** (`server.js`): the persisted `path` is scrubbed.

Numeric-id paths (`/patients/123`) are not redacted — an OD id is not PHI.

## `audit_log` vs `data/access-log.jsonl`

| | `data/access-log.jsonl` | `audit_log` (per-tenant DB) |
|---|---|---|
| Purpose | HTTP request metadata for ops/forensics | **HIPAA audit of PHI access** |
| Scope | every request (method/path/status/latency/ip/ua) | one row per PHI-touching action |
| Store | append-only JSONL file, single process | append-only DB table, per tenant |
| PHI | scrubbed paths only | resource **IDs** only, never values |
| Tenant | not tenant-scoped | scoped to the acting tenant |

They are complementary: the JSONL file answers "what HTTP traffic hit the box";
`audit_log` answers "who accessed which patient/appointment resource, when, and
with what result" — the HIPAA-relevant question.

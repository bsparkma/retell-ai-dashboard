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
| `office` | frozen office key (`roland` \| `valley` \| `unknown`) the action touched — **whose chart**. PatNum numbering restarts per OD database, so `resource_id` alone is ambiguous once a tenant has two connected practices. `NULL` = "not an office-scoped action" |
| `origin_office` | the office the action **came from**, when that can differ from the one it touched — **whose call**. A chart note may now be deliberately aimed at the other practice (see CLAUDE.md §2.6), and `office` alone would not say why a Roland note exists for a call that rang at Riley. Same class of value as `office`. `NULL` = "no origin distinct from the target" |
| `source_ref` | the **external identifier that caused** the action, when the cause lives outside the audited resource (today: the voice call id behind a TC handoff). An identifier, never a PHI value. `NULL` = "no recorded external cause" |
| `prior_state` | what the audited thing **was, immediately before this action** — for actions that REPLACE a decision somebody already made. **A slug, and a CHECK constraint enforces it.** See *the `prior_state` invariant* below before using it. `NULL` = "this action replaced nothing" |

Indexes: `(ts)`, `(resource_type, resource_id)`, `(office, ts)`, and a partial
`(origin_office, office, ts)` over the cross-office rows only — same-office actions
are the overwhelming majority and are already served by `(office, ts)`.

A cross-office chart action is exactly `origin_office IS DISTINCT FROM office`,
answerable without joining anything:

```sql
SELECT ts, user_id, origin_office, office, resource_type, resource_id, result
  FROM audit_log
 WHERE origin_office IS NOT NULL AND origin_office IS DISTINCT FROM office
 ORDER BY ts DESC;
```

`office`, `origin_office`, `source_ref` and `prior_state` are nullable **with no
backfill**. Rows written before each column existed genuinely lack the
information, and writing an assumption into an audit trail as though it were
observed is exactly what an audit trail must not do.

### The `prior_state` invariant — slug-only, platform-wide

> **`audit_log.prior_state` accepts a SLUG and nothing else, in every module.**
> A caller that needs to record anything richer must change the constraint
> deliberately, in its own commit, with the argument written down — not discover
> the limit at runtime and route around it.

Added by `backend/migrations-tenant/1788000000000_audit_log_prior_state.js`,
first needed by RCM Stage C-2 (a biller may revise her answer about a check, and
the revision counter could not say which way it went). **It is not an RCM
column.** `audit_log` is one shared per-tenant table and voice, TC and RCM all
write to it through the same `audit()` helper, so this is a platform decision
that happened to be made inside an RCM slice.

The constraint:

```sql
CHECK (prior_state IS NULL OR prior_state ~ '^[a-z0-9_]{1,32}(:[a-z0-9_]{1,31})?$')
```

Which is `slug` or `slug:slug` — lowercase, digits and underscores, anchored at
both ends. `same`, `differed:payment_amount`, `withdrawn`, `matched:phone_exact`.

**Why the grammar is the safety property, not a formality.** This table has no
detail column on purpose: the platform never copies free text a person typed into
the trail, because every free-text column in this schema is PHI-capable by nature
— a biller may name a patient in a `comparison_note`, a `parked_note`, a
`withdrawn_note`, a `review_note`. A nullable `text` column with no constraint
would have become that copy within two slices whatever its comment said. The
regex makes the wrong thing **unstorable rather than discouraged**:

| | |
| --- | --- |
| a sentence | has a space → refused |
| a patient's name | has a capital → refused |
| anything punctuated, quoted or currency-bearing | refused |
| an empty string | refused |

Anchoring matters as much as the character class: an unanchored pattern would
match a slug *inside* a sentence and let the sentence through.

Written `prior_state IS NULL OR (…)` rather than as a bare regex, because
`prior_state ~ '…'` against a NULL yields NULL and **Postgres accepts a CHECK
that evaluates to NULL** — it only refuses FALSE. That is the same trap
RCM_POSTING §15 documents, and the reason every CHECK in this repo leads with an
explicit null test.

**Using it.** Pass `priorState` to `audit()` (see below). Record only what the
thing WAS — the new state is either on the row itself or on the next audit row,
and writing both would be one fact stored twice, which is two chances to
disagree. Rehearsal evidence — four allowances, eight refusals, and the
append-only grant proven unchanged — is in RCM_POSTING §11a.

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

// Office-scoped, with an external cause (voice → TC handoff):
await audit.audit(req, {
  action: 'CREATE', resourceType: 'tc_case', resourceId: caseId,
  office: 'roland', sourceRef: callId, result: 'SUCCESS',
});

// Replacing a decision somebody already made — record what it WAS, as a slug.
// Anything that is not slug-shaped is refused by the database, on purpose.
await audit.audit(req, {
  action: 'UPDATE', resourceType: 'rcm_remittance_comparison', resourceId: batchId,
  office: 'roland', priorState: 'differed:write_off', result: 'SUCCESS',
});
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

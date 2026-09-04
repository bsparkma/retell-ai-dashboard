# Platform Console (`/api/platform`)

The super_admin surface: the tenant catalog, module entitlements, per-practice
roster and audit trail, and the call-store retention policy. Backend only in this
PR — the `/platform` page lands in PR C2.

Everything here sits behind `requireSuperAdmin()`
([`backend/config/permissions.js`](../backend/config/permissions.js)), applied once
at the mount in `server.js`. A tenant `admin` holds `admin.all` and reaches every
other admin surface in the product; they still get **403 `FORBIDDEN`** here, and
so does the shared `DASHBOARD_API_TOKEN` machine caller.

There is deliberately **no module guard** on this mount. Entitlement answers "did
this practice buy the product?", and the console is the surface that decides the
answer — gating it on a module would be circular.
`backend/test/moduleGateWiring.test.js` pins both halves of that.

---

## 1. Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/platform/practices` | Catalog: identity, all four modules with state, roster size |
| GET | `/api/platform/practices/:tenantId/modules` | The same composition for one practice |
| PUT | `/api/platform/practices/:tenantId/modules/:module` | `{ enabled: boolean }` — the kill switch |
| GET | `/api/platform/practices/:tenantId/users` | **Read-only** roster |
| GET | `/api/platform/practices/:tenantId/audit` | Server-side paginated `audit_log` read |
| GET | `/api/platform/retention` | Window + where it came from + store counts |
| PUT | `/api/platform/retention` | `{ days: 30 \| 60 \| 90 }` |
| GET | `/api/platform/retention/impact?days=N` | How many live calls a window would prune |

`:tenantId` is resolved against the tenant catalog **before** anything opens a
tenant database. An id that is not in the registry is a 404, not a connection
attempt — pinned by a test that fails if `getTenantPool` is reached.

### What is deliberately NOT here

- **Creating a tenant.** Provisioning means a database, Key Vault secrets and
  migrations. It stays the [`platform/provisionTenant.js`](../backend/platform/provisionTenant.js)
  runbook; a button that half-provisions is worse than no button.
- **Editing users.** This console *lists* a practice's roster. Role, status and
  home-office changes stay on `/admin/users` and `/api/users`, where the
  last-admin, platform-admin-protection and self-change rules already live and
  are already tested. Two write paths into `app_user` would mean two places for
  those rules to be enforced, and the second is where they would eventually not
  be. The response carries `manageAt: '/admin/users'` so the UI can link there.
- **Prune and purge.** Already at `POST /api/admin/call-store/prune` and
  `/purge-legacy`, already behind `requireSuperAdmin()`. The console calls them
  where they are rather than growing a second copy of a job that destroys
  records.

---

## 2. Module entitlements

The namespace list lives in **one** place now:
[`backend/config/modules.js`](../backend/config/modules.js) — `voice`, `tc`, `rcm`,
`scheduling`, in display order. `backend/config/modules.test.js` parses the CHECK
constraint out of `migrations/1785369600000_rename_module_carein_to_voice.js` and
asserts the two agree, so a toggle the database would refuse cannot ship.

> **Bug fixed in passing.** `platform/provisionTenant.js` still carried its own
> `MODULES = ['carein', 'tc', 'rcm']`. `'carein'` was renamed to `'voice'` by that
> same migration, whose CHECK would have rejected the row — provisioning the next
> tenant would have failed. It now reads the shared list.

**Adding a module is a migration, not an edit to `modules.js`.** The CHECK is the
real gate; widen the list in the same PR that widens the constraint, never ahead
of one. (`hyg` is next and is deliberately absent.)

A practice with no `tenant_module` row for a namespace has it **off** — the
response composes against the catalog rather than trusting the table to hold all
four rows.

**Flipping is immediate.** `tenantContext` rebuilds `req.tenant.modules` per
request, so turning `tc` off hides the TC module for every user at that practice
on their next request. No cache to wait out, no deploy.

**The audit row goes to the affected practice**, not the operator's tenant —
`auditForTenant(req, tenantId, entry)` in
[`backend/platform/audit.js`](../backend/platform/audit.js). A super_admin toggling
a module for Smith Dental is signed in under CareIN, but the event belongs in the
log Smith Dental's own admins read. `tenantId` must be a registry-resolved id;
that is why the helper takes an id rather than a hand-built `req` shim.

Order of operations on a flip is **write → audit → re-read → respond**. The
response is the database's state, never the value the request sent. A failed
audit propagates and the response is a 500 even though the write landed — an
entitlement change nobody can see in the trail should look like a failure to the
person who made it.

---

## 3. Retention: where the window lives

### Precedence

```
platform_setting['call_retention_days']   ← the console writes this
  ↓ (no row)
CALL_RETENTION_DAYS                       ← the environment
  ↓ (unset or malformed)
30                                        ← DEFAULT_RETENTION_DAYS
```

The migration **seeds no row**, deliberately. Absence is a meaningful state
meaning "nobody has chosen", which is what keeps `CALL_RETENTION_DAYS` alive in
every environment the console has never touched. Seeding `30` would have made the
env var dead on arrival.

`GET /api/platform/retention` reports `policy.source` (`db` | `env` | `default`)
alongside the number, because "30 because nobody has chosen" and "30 because
somebody chose it on Tuesday" are different facts and the operator is about to
make a decision on the difference.

### Why it is platform-global and not per-practice

The unified call store is **one JSON file for the whole process**
(`${CALLSTORE_DIR}/unified_calls.json`). It has no tenant dimension. Hanging
retention off `tenant` would invent a per-practice policy the pruner has no way
to honour, and the first person to set two practices to different windows would
be silently lied to. When the JSON store is cut over to the per-tenant
`call_record` table, retention becomes a per-tenant question and gets a
per-tenant home — a later slice's migration, not a column added on spec now.

For the same reason a retention change is audited into the **acting** super_admin's
tenant log, unlike a module flip: the change belongs to no single practice, and
filing it under one would misrepresent its blast radius.

### The schema

```sql
platform_setting (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text                     -- actor email; an identifier, not PHI
)
```

Key: `call_retention_days`. Migration:
`backend/migrations/1786752000000_platform_setting.js` (control DB).

### 30 / 60 / 90 constrains the console, not the database

`CONSOLE_RETENTION_DAYS = [30, 60, 90]`. A retention policy is a decision somebody
has to be able to state in a sentence, and a freeform box invites 31 and 45 and 29.

This bounds the **API and the UI**. A runbook writing `45` — or `0`, the kill
switch — straight into `platform_setting` is still honoured by `retentionDays()`,
because the stored row *is* the policy and the list is only what a click may
choose. `PUT /retention` refuses anything else with 400 `INVALID_RETENTION_DAYS`.

### The pruner reads the CURRENT value, not a boot snapshot

`config/retention.js` keeps a synchronous public API (four call sites depend on
it) backed by a process cache, refreshed explicitly:

1. at boot, in `server.js`, **before** `retentionScheduler.start()`;
2. at the top of **every** `runNow()` — scheduled and manual;
3. after every console write.

Step 1's ordering is load-bearing: `start()` decides whether to arm the job at
all, so with a stored window of 60 and `CALL_RETENTION_DAYS=0`, starting first
would read the environment's kill switch and never schedule. For the mirror case,
`PUT /retention` calls `start()` after a successful write, so a stored window can
switch retention on without waiting for a deploy.

### The two failure directions are different

| Situation | Behaviour |
| --- | --- |
| Control plane unreachable, a value **was** read earlier | Keep using it. A blip must not change what gets destroyed tonight. |
| Control plane **never** readable since boot | `policyKnown()` is false and the prune is **skipped**, returning `skipped: 'RETENTION_POLICY_UNKNOWN'`. |
| Stored value is unparseable (`"thirty"`) | Ignored with a loud warning; the environment takes over. |

The refusal is the important one. A stored `90` we cannot see, overridden by an
environment `30`, is sixty days of records. A job that destroys data does not get
to guess its own policy. All three are pinned in
`backend/services/retentionScheduler.test.js`.

> Consequence for local dev: with no `CONTROL_DB_URL`, the nightly prune never
> runs. That is the safe direction and is not a bug.

### The shortening count

`GET /retention/impact?days=N` calls `callRetention.selectExpired` — the very
function the pruner uses to choose its victims — and returns a count. Not a
re-implementation: a number the console showed that disagreed with what the
pruner then did would be worse than no number.

Extending reports `wouldPrune: 0` and `shortening: false`, paired in the UI with
the plain statement that **extending never restores already-pruned calls**. A
stub cannot be un-stubbed.

---

## 4. The audit view

Server-side paginated read of one practice's `audit_log`, newest first. Filters:
`action`, `result`, `resourceType`, `resourceId` (exact), `from`, `to`, `limit`
(capped at 100), `offset`. `action` and `result` are validated against the table's
own CHECK vocabularies; a bad date is a 400, never a coerced `Invalid Date`.

Every filter value is parameterized — nothing from the request is concatenated
into SQL.

`ORDER BY ts DESC, audit_id DESC`. The tiebreak is load-bearing: `ts` defaults to
`now()`, and a busy moment produces rows sharing a timestamp that `ORDER BY ts`
alone would page through non-deterministically — the same row twice, another
never.

**Append-only is untouched, structurally.** The app connects as the
least-privilege `carein_app` role, which holds `INSERT` and `SELECT` on
`audit_log` and nothing else
(`migrations-tenant/1780453117650_audit_log.js`). There is no `UPDATE` or `DELETE`
to write here even if somebody wanted one — the grant would refuse it. A test
asserts every statement this route issues begins with `SELECT`.

The audit view is **not itself audited**: it reads identifiers (this table never
holds PHI values), and a trail that recorded every look at itself would bury the
events it exists to preserve. Consistent with how `/api/users` treats listing.

---

## 5. Related

| Topic | Doc |
| --- | --- |
| Module entitlement model | [MODULES.md](MODULES.md) |
| Audit log schema and the two-role model | [AUDIT.md](AUDIT.md) |
| Roles and the permission map | `backend/config/permissions.js` |
| Retention policy and the stub shape | `backend/services/callRetention.js` |

---

## 6. The hygiene pilot switch (Hygiene tab)

`GET /api/platform/hyg-offices`, `PUT /api/platform/hyg-offices/:office` — both
behind the same `requireSuperAdmin()` mount as everything else here.

Per OFFICE, which is a different axis from the module entitlement in §2: the
entitlement asks *did this practice buy hygiene* (one answer per tenant), and
this asks *is hygiene live at this location* (one answer per office inside it).
Both must be on. The tab shows the entitlement read-only beside each office and
points at the Practices tab, because a second place to flip entitlement would be
a second place for that decision to be made by accident.

Storage, precedence, the break-glass env var, and the reason the floor stays
`false` are all in [HYG_MODULE.md §8](HYG_MODULE.md). The console-specific parts:

- **Turning ON confirms; turning OFF does not.** The safe direction is the fast
  one — a dialog in front of a kill switch is a dialog somebody reads while a
  patient waits. The ON dialog names the blast radius in plain words: hygienists
  start reading real patient data from that practice's Open Dental, and the
  morning warm starts running against it.
- **Both directions write an audit row** to the acting super_admin's own tenant
  (like retention, unlike the module toggle — the office registry is
  platform-wide and has no tenant dimension). `office` names which location
  moved and `prior_state` says what it moved from, because "turned off at 09:14"
  and "was already off" are different facts and only one explains an incident.
- **The panel renders the readback**, never the click. A write that silently did
  nothing cannot look like a success, and a refused one leaves the toggle where
  the server says it is.
- **It says what an app setting is DOING, and the two directions are not
  symmetric.** `HYG_OD_ENABLED_<OFFICE>=false` overrules this page, so the row
  says the toggle here cannot lift it and names the remedy (clear the variable,
  restart). `=true` can never enable anything, so the row says that in those
  words rather than staying quiet and leaving somebody watching a dark module.
  Neither is reported as the source `env` unless it is actually in force.
- **It says which layer answered** (`db` / `env` / `default`) and, when the
  stored row and an app setting disagree, that the app setting is currently
  inert. It also distinguishes *"the stored setting does not name this office"*
  from *"somebody turned it off"* — same value, and only one of them has a
  person's name on it.
- **On is not the same as working.** An office switched on whose Open Dental is
  unusable is shown with what still blocks it, rather than a green toggle over a
  503.

The pilot runbook — enable on staging, what to watch over several mornings, and
the click path to turn it off fast — is [HYG_MODULE.md §9](HYG_MODULE.md).

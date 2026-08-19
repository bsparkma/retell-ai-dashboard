# Per-location Open Dental — staging validation + prod promotion

Companion to the `feature/per-location-od` slice. Everything below was prepared
against live systems on **2026-08-07**; the staging click-through is Beau's to run.

---

## 0. What was proven before any code was written

Read-only probes of both practices through the OD cloud API, using the
staging-wired keys:

| | Roland | Riley (`valley`) |
|---|---|---|
| `GET /patients/7115` | **a real Roland patient** (not named here — PHI) | `Stedi TestValley` — the test patient |
| `"CareIN AI Call"` CommType (Category 27) | DefNum **486** | DefNum **451** |
| `GET /patients?Phone=4797394999` | **2** patients (ambiguous) | **1** patient — 7115 (confident) |
| `GET /patients?LName=TestValley` | 0 | 1 — PatNum 7115 |

**PatNum is per-database.** That first row is the whole reason this slice exists:
before it, a Riley call resolved to PatNum 7115 and sent to chart would have
written a note on the chart of a real Roland patient (PatNum 7115 in Roland's DB)
who has nothing to do with that call. Their name is deliberately not recorded
anywhere in this repo — a real patient's name tied to their practice is PHI, and
the finding stands without it.

The third row is the validation fixture. The *same phone number* produces a
*different outcome per practice*, so one look at two seeded calls proves the
routing is real:

* Riley line + `+14797394999` → single match → **`matched`** (ready to send)
* Roland line + `+14797394999` → two candidates → **`needs_review`**

Before this branch both would have hit Roland and both would have been
`needs_review`.

---

## 1. Schema change — read this before approving

**This slice adds one tenant-database migration.** It was not anticipated in the
brief and is called out here rather than buried in a promotion checklist.

**File:** `backend/migrations-tenant/1785900000000_audit_log_office.js`

**What it does:** adds a nullable `office text` column to `audit_log`, plus an
`(office, ts)` index. Nothing else. No backfill, no constraint, no data rewrite.

**Why a schema change was needed:** `audit_log` records `resource_id` only. With
one connected practice that identified a patient; with two it does not, because
PatNum numbering restarts per database. A row reading `CREATE commlog / PatNum
7115` is genuinely ambiguous once Riley is live. The office key is what makes the
trail mean something again, so it is part of the audit's correctness rather than
a nice-to-have.

**Why nullable with no backfill:** rows written before this slice came from the
single Roland-bound client, so they *were* Roland. But an audit log must not
record an inference as though it were observed. `NULL` honestly means "written
before offices were tracked".

**Verified** on 2026-08-07 against an ephemeral Postgres built exactly the way
the CI build-test gate builds it (same roles, same migration order):

| check | result |
|---|---|
| applies on top of the 3 existing tenant migrations | clean |
| pre-existing `audit_log` rows still readable afterwards | yes, `office IS NULL` |
| app role (`carein_app`) can INSERT including `office` | yes — table-level grant already covers it, no new grant |
| append-only still enforced (`UPDATE`/`DELETE` as `carein_app`) | still denied (42501) |
| CI spine smoke test (`scripts/smoke-spine.js`) | **12/12 pass** |
| `down` migration | drops column + index cleanly, all rows survive |
| re-running `up` | `No migrations to run!` — idempotent |

**It has NOT yet run on staging, and cannot until this merges.** The staging
migrate job (`caj-carein-migrate`) runs the `carein-backend:staging` image, which
`publish` rebuilds from the merged branch — so the migration file does not exist
in the image that job would run today. Applying it out-of-band against the
staging database was deliberately not done: it would put the schema ahead of the
pipeline for no benefit, since the pipeline blocks deploy on a failed migration
anyway.

**No manual step, staging or prod.** Both pipelines already run tenant
migrations, and both `deploy` jobs declare `needs: [publish, migrate]`, so a
failed migration blocks the deploy rather than shipping unmigrated code:

* staging — `caj-carein-migrate` → `scripts/migrate-staging.js` →
  `migrate-tenant.js up --tenant carein`, `NODE_ENV=development`
* prod — `caj-carein-prod-migrate` → `scripts/migrate-prod.js` → same, behind
  `environment: production` (**required-reviewer gate**), `NODE_ENV=development`

**Rollback:** `node scripts/migrate-tenant.js down --tenant carein 1`. Verified
to drop the column and index with every existing row intact. Note this is only
needed if the column itself is unwanted — reverting the slice's *code* does not
require reverting the migration, since a nullable unused column is inert.

---

## 2. Staging — no Azure change required

The OD customer key is **not** a container-app secretRef. It is fetched from Key
Vault at startup by `backend/config/secrets.js` (`SECRET_MAP`) using the app's
managed identity. Verified:

* `opendental-customer-key-valley` **exists** in `kv-carein-staging`
* `id-carein-staging` (`d4647517-…`) holds **Key Vault Secrets User at vault
  scope**, so it can already read it

So wiring valley on staging is the one-line `SECRET_MAP` entry in this branch.
**Do not add a container-app secret or env var** — that would be a second,
divergent source for the same credential.

Staging Mango ingest stays **off** (`MANGO_INGEST_MODE=off`). Do not flip it.

---

## 3. Seed the synthetic calls

`ALLOW_MANGO_DEV_SEED=true` is already set on `ca-carein-backend`. Take the API
token from `kv-carein-staging/dashboard-api-token` — never paste it into a file.

```bash
TOKEN=$(az keyvault secret show --vault-name kv-carein-staging \
          -n dashboard-api-token --query value -o tsv)

curl -sS -X POST https://staging.carein.ai/api/mango/dev/seed \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d @docs/fixtures/per-location-od-seed.json | jq
```

Expected response — the office routing, visible before anyone clicks anything:

| `external_id` | office | `od_sync_status` | why |
|---|---|---|---|
| `mango_call_seed_valley_confident` | valley | `matched`, PatNum **7115** | 479-739-4999 is on ONE Riley patient |
| `mango_call_seed_valley_review` | valley | `needs_review` | unknown number → Pick Patient path |
| `mango_call_seed_roland_control` | roland | `needs_review`, 2 candidates | SAME number, TWO Roland patients |
| `mango_call_seed_unknown_office` | unknown | `office_not_connected` | DID not in `MANGO_LINE_OFFICE` |

If the valley rows come back `office_not_connected`, the valley key did not load
— check the startup log line from `secrets.js`, not the code.

---

## 4. Beau's click-through

1. **Valley confident call** → worklist shows `Matched: Stedi TestValley`.
   Open **Send to chart**. The dialog must name **Valley Fort Smith** and
   PatNum 7115 before you send. Send it.
   → **Check chairside in Riley's Open Dental**: the commlog is on Stedi
   TestValley, and its type reads **CareIN AI Call** (DefNum 451, not 486).
2. **Valley review call** → **Pick Patient**. The search header must read
   *"Searching Valley Fort Smith patients"*. Search `TestValley` → finds
   PatNum 7115 (a real Riley OD read). Resolve, then send.
3. **Roland control call** → still `needs_review` with two candidates; Pick
   Patient finds `Stedi Test 2` (PatNum 12827). Roland's path is unchanged.
4. **Unknown-office call** → no chart actions, and the row reads
   *"Can't connect this call to a chart — its office is unknown"*. The
   not-a-patient close-out still works.
5. **Cross-office mischief** (the guard, via API):

   ```bash
   # A valley call, told it is a Roland call. Must be refused, and must write nothing.
   curl -sS -X POST "https://staging.carein.ai/api/unified-calls/<VALLEY_CALL_ID>/resolve-patient" \
     -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
     -d '{"patientId":7115,"office_id":"roland"}' | jq
   # expect: 409  {"code":"OFFICE_MISMATCH", ...}
   ```

   Then confirm no commlog appeared on Roland PatNum 7115 (a real Roland patient).

---

## 5. Prod promotion — also no Azure change

Checked read-only on 2026-08-07:

* `opendental-customer-key-valley` **already exists** in `kv-carein-prod`
* its value fingerprints **identical** to the staging secret, so prod points at
  the same Riley database this was validated against
* `id-carein-prod` (`c58af37b-…`) holds **Key Vault Secrets User at vault scope**

So promotion is **the merge alone**. There is no secretRef to add and no env var
to set. Two things to be aware of:

1. **`OPENDENTAL_CAREIN_COMMTYPE_DEFNUM=486` is set on the prod container app.**
   That env var is now Roland-only (`odOffices.OFFICE_OD_SETTINGS.roland`).
   Valley reads `OPENDENTAL_CAREIN_COMMTYPE_DEFNUM_VALLEY`, which is unset and
   falls back to the verified 451. Leave both alone. Do **not** generalise the
   existing var to both offices — that is how 486 would reach Riley.
2. **The tenant migration must run** (`audit_log.office`) — see section 1. It
   rides the gated `prod-cd` migrate job with no manual step.

If prod's valley key is ever rotated separately from staging's, re-run the
fingerprint comparison before promoting — a mismatched key means prod would be
talking to a practice this was never validated against.

---

## 6. Rollback

* **The switch:** `git revert` the "Turn Open Dental on for Riley" commit
  (`odEnabled: true → false`). Riley returns to the read-only worklist state;
  nothing else changes.
* **The layer:** inert for valley without its key. Removing
  `opendental-customer-key-valley` from the vault makes valley report
  disconnected and refuse every OD operation — it never falls back to Roland.

## 7. Deliberately NOT done — and since done

At the time of this validation, `officeAgents.OFFICES.valley.odConnected` stayed
**false**. It gated the TC module's OD routes (`backend/routes/tc/od.js`), and TC
still reached Open Dental through the single Roland-bound client; flipping it
would have served Roland's patients, treatment plans and claims under a Riley
selector.

**That slice has since landed.** `/api/tc/od/*` resolves its client per office
through this same registry, gates on `odOffices.isOdReady(office)`, and re-asserts
`assertOfficeMatch` on every OD call. The second flag protected nothing once that
was true, so it was removed rather than flipped — `officeAgents.OFFICES` entries
now carry `officeId` and `officeName` only. Rollback for TC is the same lever as
for voice: `odEnabled: true → false` on the office.

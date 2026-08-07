# Per-location Open Dental — staging validation + prod promotion

Companion to the `feature/per-location-od` slice. Everything below was prepared
against live systems on **2026-08-07**; the staging click-through is Beau's to run.

---

## 0. What was proven before any code was written

Read-only probes of both practices through the OD cloud API, using the
staging-wired keys:

| | Roland | Riley (`valley`) |
|---|---|---|
| `GET /patients/7115` | `Different RolandPatient` — a **real patient** | `Stedi TestValley` — the test patient |
| `"CareIN AI Call"` CommType (Category 27) | DefNum **486** | DefNum **451** |
| `GET /patients?Phone=4797394999` | **2** patients (ambiguous) | **1** patient — 7115 (confident) |
| `GET /patients?LName=TestValley` | 0 | 1 — PatNum 7115 |

**PatNum is per-database.** That first row is the whole reason this slice exists:
before it, a Riley call resolved to PatNum 7115 and sent to chart would have
written a note on Different RolandPatient's chart in Roland.

The third row is the validation fixture. The *same phone number* produces a
*different outcome per practice*, so one look at two seeded calls proves the
routing is real:

* Riley line + `+14797394999` → single match → **`matched`** (ready to send)
* Roland line + `+14797394999` → two candidates → **`needs_review`**

Before this branch both would have hit Roland and both would have been
`needs_review`.

---

## 1. Staging — no Azure change required

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

## 2. Seed the synthetic calls

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

## 3. Beau's click-through

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

   Then confirm no commlog appeared on Roland PatNum 7115 (Different RolandPatient).

---

## 4. Prod promotion — also no Azure change

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
2. **The tenant migration must run** (`audit_log.office`). It rides the normal
   `prod-cd` migrate job, which must be `NODE_ENV=development` as always.

If prod's valley key is ever rotated separately from staging's, re-run the
fingerprint comparison before promoting — a mismatched key means prod would be
talking to a practice this was never validated against.

---

## 5. Rollback

* **The switch:** `git revert` the "Turn Open Dental on for Riley" commit
  (`odEnabled: true → false`). Riley returns to the read-only worklist state;
  nothing else changes.
* **The layer:** inert for valley without its key. Removing
  `opendental-customer-key-valley` from the vault makes valley report
  disconnected and refuse every OD operation — it never falls back to Roland.

## 6. Deliberately NOT done

`officeAgents.OFFICES.valley.odConnected` stays **false**. It gates the TC
module's OD routes (`backend/routes/tc/od.js`), and TC still reaches Open Dental
through the single Roland-bound client. Flipping it would serve Roland's
patients, treatment plans and claims under a Riley selector. TC needs its own
office-aware slice before that flag can move.

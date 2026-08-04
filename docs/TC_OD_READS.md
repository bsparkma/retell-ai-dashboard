# TC Open Dental reads — API coverage (Slice 5)

What the Treatment Coordinator module reads from Open Dental, how each read is
expressed on the **OD Cloud REST API**, and — for the two legacy reads that were
**direct MySQL** — exactly which data elements survive the move.

Companion to [`OD_API_COVERAGE.md`](OD_API_COVERAGE.md) (the voice module's
coverage matrix) and [`OD_API_CONTRACT.md`](OD_API_CONTRACT.md) (real OD param
and enum shapes). Same legend, same discipline.

> **This table is the deliverable that feeds RCM planning.** RCM needs the same
> claimproc-shaped data the COB pull needs, and hits the same wall. Read the
> "Gap: claimproc" section before designing anything that needs write-off,
> per-procedure insurance estimates, or ledger-accurate benefit usage.

---

## The three legacy paths, and what happened to each

| Legacy path | Fate | Why |
|---|---|---|
| **OD Cloud API** (`api.opendental.com/api/v1`) | **Survives — the only transport** | Reachable from Azure with the practice's developer + customer key |
| **Direct MySQL** (office LAN, `mysql2` pool) | **Gone, not replaced** | Azure has no route to the office database, and direct OD MySQL from the cloud is forbidden. Every query re-expressed below or flagged |
| **"Riley connector"** HTTP proxy | **Gone, not replaced** | Dead service; the platform's on-prem connector serves slot-markers only |

Reads route through `odAccess.odApiGet` — the platform's single OD seam — which
resolves the tenant, honours `od_primary_mode`, and guards `od_api_base` so a
read can never reach the wrong practice's database. There is deliberately **no**
`odApiPost`/`Put`/`Delete` counterpart: the TC OD surface cannot become a write
path by accident.

---

## Route map

All routes are `GET`, mounted at `/api/tc/od`, behind `requireModule('tc')` +
`requireOffice` + `requireOdOffice`.

| Route | Replaces (legacy) | Legacy transport |
|---|---|---|
| `/status` | `GET /api/od/status` | Cloud API |
| `/patients?q=` | `GET /api/od/patients` | Cloud API |
| `/patients/:patNum` | `GET /api/od/patients/:patNum` | Cloud API |
| `/treatment-plan/:patNum` | `GET /api/od/treatment-plan/:patNum` | Cloud API |
| `/unaccepted` | `GET /api/od/bulk-unaccepted` | **direct MySQL** |
| `/cob-procedures/:patNum` | `GET /api/od/cob-procedures/:patNum` (procs) + `/api/od/bulk-procedures/:patNum` | **direct MySQL** |
| `/insurance/:patNum` | `GET /api/od/cob-procedures/:patNum` (`planUsage`) | **direct MySQL** |
| `/next-appointment/:patNum` | `GET /api/od/next-appointment/:patNum` | **direct MySQL** |

Not ported: `GET /api/od/commlogs` and `POST /api/od/commlogs` — the chart-note
write is Slice 6, and the read has no consumer without it.

### Office law

Every route takes the office from `?office=` and **refuses any office without an
Open Dental connection** with a structured 503:

```json
{ "success": false, "code": "OFFICE_NOT_CONNECTED", "office": "valley" }
```

Today that is `valley`. This is a **correctness guard, not a placeholder**: the
OD customer key scopes to exactly one practice database (Roland's), and OD list
reads are not clinic-scoped, so a Valley read through this key would silently
return **Roland's** patients. The per-location credential work is a separate
slice; until it lands, refusing is the only correct answer.

---

## Coverage matrix

**confirmed** — the API returns this directly.
**partial** — reconstructed client-side, or narrower than the original; the note says how.
**gap** — the API cannot express it at all.

Every `partial` and `gap` row below is also returned **to the UI at runtime** in
the response's `coverage[]` array, so the screen states the same limits this
document does.

### 1–3, 6 — reads that were already on the Cloud API

| Data element | Coverage | OD endpoint(s) | Notes |
|---|---|---|---|
| Patient search by name | **partial** | `GET /patients?LName` / `?FName` | ⚠️ **`LName`/`FName` are PREFIX matches** (`OD_API_CONTRACT.md` §7) — "Smith" also returns "Smithson". No exact-match parameter exists. Mitigated, not solved: DOB + phone are always returned and the UI never auto-selects |
| Patient DOB / phone / email | **confirmed** | `GET /patients` | TC normalizes its own shape; the voice client's `transformPatientData` drops `WirelessPhone`, which is the number the legacy TC app preferred |
| Patient status filter | **confirmed** | `GET /patients` | API returns a **string** enum (`"Patient"`, `"Inactive"`, `"Deceased"`…), not the DB int |
| Patient by PatNum | **confirmed** | `GET /patients/{PatNum}` | |
| Treatment plans for a patient | **confirmed** | `GET /treatplans?PatNum` | |
| Saved-plan procedures | **confirmed*** | `GET /proctps?TreatPlanNum` | *Subject to the developer key having the resource enabled — see "Resource-name and entitlement notes" |
| Active/Inactive-plan procedures | **confirmed*** | `GET /treatplanattaches?TreatPlanNum` → `GET /procedurelogs/{ProcNum}` | Up to `TP_ATTACH_CAP` (25) procedure calls, bounded-concurrency |
| Next scheduled appointment | **confirmed** | `GET /appointments?PatNum&AptStatus=Scheduled&dateStart` | `provAbbr` on the row removes the legacy provider join. `AptStatus` is the **string** `"Scheduled"`, not DB `1` |

### 4 — Bulk unaccepted finder ⚠️ was direct MySQL

Legacy query:

```sql
SELECT p.*, COUNT(pl.ProcNum), SUM(pl.ProcFee), MIN(pl.DateTP), MAX(pl.DateTP)
FROM procedurelog pl JOIN patient p ON p.PatNum = pl.PatNum
WHERE pl.ProcStatus = 1 AND pl.ClinicNum = ? AND pl.DateTP >= ?
  AND pl.ProcFee > 0 AND p.PatStatus = 0
GROUP BY p.PatNum HAVING SUM(pl.ProcFee) >= ? ORDER BY totalFee DESC LIMIT 200
```

**Verdict: PARTIAL — built, with a documented delta.** The predicates OD can
express go to OD; everything else is re-implemented over a paginated scan.

| Data element | Coverage | OD endpoint | Delta vs MySQL |
|---|---|---|---|
| `ProcStatus = 1` (treatment planned) | **confirmed** | `GET /procedurelogs?ProcStatus=TP` | Requires OD **25.2.21+**. Older builds reject the param; the route detects that, degrades to an unfiltered scan with a client-side filter, and says so in `notes[]` |
| `ProcFee`, `PatNum`, `DateTP` per procedure | **confirmed** | `GET /procedurelogs` | |
| `pl.ProcFee > 0` | **partial** | — | No fee predicate in the API; applied client-side |
| `pl.DateTP >= cutoff` | **partial** | — | **No `DateTP` filter exists.** `GET /procedurelogs` filters on `ProcDate` and `DateTStamp` only — neither is the treatment-planned date. Window applied client-side over scanned rows |
| `GROUP BY PatNum` + `SUM`/`COUNT`/`MIN`/`MAX` | **partial** | — | No aggregation in the API; grouped client-side |
| `HAVING totalFee >= minFee` | **partial** | — | No aggregate filter; applied after grouping |
| `ORDER BY totalFee DESC` | **partial** | — | No server-side ordering; sorted client-side |
| `JOIN patient` (name, DOB, phone, email) | **partial** | `GET /patients/{PatNum}` | **No join exists.** One extra call per ranked patient, so demographics are fetched only for the returned page. A patient whose record fails to read keeps its money and is labelled `PatNum <n>` rather than being dropped |
| `p.PatStatus = 0` | **partial** | `GET /patients/{PatNum}` | Applied *after* the demographics fetch, so an inactive patient can consume one of the ranked slots |
| `pl.ClinicNum = ?` | **partial** | `GET /procedurelogs?ClinicNum` | The param exists (OD 23.3.13+) but is **left unset by default**: the customer key already scopes to one practice database, and filtering on a guessed ClinicNum would silently return nothing. Set `TC_OD_CLINIC_NUM` once the value is verified against the live database |
| Full-practice completeness | **partial→gap** | `GET /procedurelogs?Offset` | OD paginates at **100/page**. Capped at `TC_OD_MAX_SCAN_PAGES` (40 → ≤4,000 procedures). Hitting the cap sets `truncated: true`, and the UI states it is a partial sweep rather than a full practice list |

**Cost note for RCM:** a full-practice TP sweep is ~1 call per 100 procedures
plus 1 per ranked patient, against an API that is throttled and ~10 network hops
deep. This is a batch/background shape, not an interactive one. If RCM needs
practice-wide procedure analytics, plan for a scheduled sync into the tenant
database rather than a per-request scan.

### 5 — COB procedures + insurance snapshot ⚠️ was direct MySQL

Legacy read `procedurelog` joined to **per-plan `claimproc` aggregates** (via
`patplan.Ordinal → inssub → claimproc`), plus a YTD usage roll-up:

```sql
allowedAmt = ProcFee − claimproc.WriteOffEst   -- per plan
insEst     = claimproc.InsEstTotal
dedEst     = claimproc.DedEst

SELECT pp.Ordinal, SUM(cp.InsPayAmt), SUM(cp.DedApplied)
FROM claimproc cp JOIN inssub i … JOIN patplan pp …
WHERE cp.PatNum = ? AND cp.Status IN (1,4) AND cp.DateCP >= benefitYearStart
```

**Verdict: PARTIAL, with one hard GAP at the centre.**

| Data element | Coverage | OD endpoint | Notes |
|---|---|---|---|
| TP procedures (code, tooth, surface, fee) | **confirmed** | `GET /procedurelogs?PatNum&ProcStatus=TP` | `procCode` + `descript` on the row remove the `procedurecode` join |
| Primary / secondary designation | **confirmed** | `GET /patplans?PatNum` | `Ordinal` 1 / 2, exactly as the legacy join used |
| Carrier, group name/number, plan type, COB rule | **confirmed** | `GET /inssubs/{n}` → `GET /insplans/{n}` → `GET /carriers/{n}` | 3 calls per plan; the full legacy chain |
| Coverage effective / termination dates | **confirmed** | `GET /inssubs/{n}` | |
| Annual maximum, deductible, coinsurance % | **confirmed** | `GET /benefits?PlanNum` **and** `?PatPlanNum` | Both levels read and merged — patient-specific benefit rows override plan-level ones |
| Benefit-year start | **confirmed** | `GET /insplans/{n}` → `MonthRenew` | **Better than legacy**, which hard-coded January 1 regardless of the plan's renewal month (`MonthRenew` 0 = calendar year) |
| **Per-plan contracted allowed amount** (`ProcFee − WriteOffEst`) | **🔴 GAP** | *(none)* | **The OD Cloud API exposes no `claimproc` resource.** There is no `/claimprocs` endpoint, and `WriteOffEst` appears in no other payload. `GET /claims` carries a whole-claim `WriteOff` that cannot be attributed back to an individual planned procedure. Falls back to the billed fee with `allowedIsBilledFee: true`, and the panel reports the affected line count |
| Per-procedure insurance estimate (`claimproc.InsEstTotal`) | **partial** | `GET /proctps?TreatPlanNum` | Substituted from OD's **own** Saved-plan estimates (`PriInsAmt` / `SecInsAmt`). Available only for procedures that appear in a Saved plan; `gap` otherwise |
| Per-procedure deductible estimate (`claimproc.DedEst`) | **🔴 GAP** | *(none)* | Same claimproc gap. Returned as `null`, never `0` |
| YTD paid / deductible applied | **partial** | `GET /claims?PatNum&ClaimStatus=R` | Summed from **received claims** (`InsPayAmt`, `DedApplied`) attributed to a plan via `claim.PlanNum`. **Different date basis** — `claim.DateReceived` rather than `claimproc.DateCP` — and claims not yet marked Received are excluded, so it can read **low** near a benefit-year boundary or with claims in flight. The UI prints this basis verbatim (`ytdBasis`) next to the pre-filled remaining max |
| Supplemental payments (`claimproc.Status = 4`) | **partial** | `GET /claims` | Counted only where the supplemental payment is reflected in the claim total |

#### Gap: claimproc

`claimproc` is the row that carries, per procedure per plan: the insurance
estimate, the write-off estimate, the deductible portion, the amount actually
paid, and the payment date. **None of it is reachable through the OD Cloud API.**

Consequences, in the order they will bite:

1. **Contracted (fee-schedule) allowed amounts cannot be computed at all.** For a
   PPO patient this is the difference between an accurate quote and a billed-fee
   quote. The COB panel is explicit about it and invites a per-line override.
2. **Benefit usage is claim-grained, not procedure-grained.** Good enough for
   "roughly how much of the annual max is left"; not good enough to reconcile a
   ledger.
3. **RCM implications.** Anything RCM needs at claimproc granularity —
   write-offs, per-procedure adjudication, EOB reconciliation against estimates —
   is not available on this transport. Options, in order of preference:
   - a **scheduled export** from the office's own OD database into the tenant
     database via the on-prem connector (the connector *can* run SQL locally),
   - an **ERA/835 ingest** for post-payment data (Stedi — but note Delta Dental
     OK and HealthChoice OK do not support ERA via Stedi),
   - **fee-schedule-based estimation** (`insplan.FeeSched` + `GET /fees`),
     which approximates the allowed amount without claimproc. Not attempted in
     this slice; a reasonable Slice-N candidate if the COB panel needs it.

**Recommendation for this slice:** ship as built. The COB pull is genuinely
useful — plan identification, benefits, and remaining-max pre-fill are the parts
coordinators spend the most time on — and every number it cannot source is
labelled rather than faked. Do **not** attempt to synthesise an allowed amount.

---

## Resource-name and entitlement notes

The legacy app called `/proctp` and `/treatplanattach` (**singular**) and carried
a whole `procEndpointBlocked` branch for the 404s that produced. OD's documented
resources are **plural** (`/treatplanattaches`). The port tries **plural first,
then the legacy singular alias**, memoized per request, and records which one
answered in `endpointsUsed[]`. Whichever the practice's OD build exposes, the
read works.

Separately, OD developer keys are entitled per resource. A key without
`/proctps`, `/treatplanattaches` or `/procedurelogs` gets a 404 "not a valid
resource", which the route distinguishes from an outage and reports as an
actionable note ("Enable the resource in the Open Dental developer portal"),
not as an empty treatment plan.

---

## Behaviour the legacy implementation did not have

| | Legacy | Here |
|---|---|---|
| Treatment-plan fan-out | up to **25 sequential** calls, no per-call timeout | bounded concurrency (`TC_OD_CONCURRENCY`, default 5) + per-call timeout (`TC_OD_CALL_TIMEOUT_MS`, default 30s) |
| A procedure that fails to read | whole plan silently short-paid | **partial result**: good rows kept, failures listed in `unreadable[]`, totals annotated |
| A plan larger than the cap | silently truncated at 25 | `truncated: true` + an on-screen note before the user imports |
| Benefit year | hard-coded January 1 | `insplan.MonthRenew` |
| Import to a case | direct | **review step** — editable table, per-row include, live total, explicit confirm |

## Tunables

| Env var | Default | Effect |
|---|---|---|
| `TC_OD_CALL_TIMEOUT_MS` | `30000` | Per-OD-call timeout |
| `TC_OD_CONCURRENCY` | `5` | Max OD calls in flight per fan-out |
| `TC_OD_TP_ATTACH_CAP` | `25` | Procedures read per Active/Inactive plan (legacy parity) |
| `TC_OD_MAX_SCAN_PAGES` | `40` | Page cap for the practice-wide TP scan (100/page) |
| `TC_OD_CLINIC_NUM` | *(unset)* | Adds a `ClinicNum` filter. Leave unset until verified |

## Audit

Each PHI read emits **exactly one** `audit_log` row (`action: READ`,
`resource_type: od_*`), matching the granularity the voice module gets from
`odAccess`'s audited named methods. `odApiGet` is deliberately unaudited so a
25-call treatment-plan fetch produces one row, not 25. Search terms are PHI and
are **never** recorded — `od_patient_search` rows carry `resource_id: null`.

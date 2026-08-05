# TC Open Dental reads — API coverage (Slice 5)

What the Treatment Coordinator module reads from Open Dental, how each read is
expressed on the **OD Cloud REST API**, and — for the two legacy reads that were
**direct MySQL** — exactly which data elements survive the move.

Companion to [`OD_API_COVERAGE.md`](OD_API_COVERAGE.md) (the voice module's
coverage matrix) and [`OD_API_CONTRACT.md`](OD_API_CONTRACT.md) (real OD param
and enum shapes). Same legend, same discipline.

> **This table is the deliverable that feeds RCM planning**, and its headline is
> good news: **`GET /claimprocs` exists** and returns the full claimproc row —
> `WriteOffEst`, `InsEstTotal`, `DedEst`, `InsPayAmt`, `DedApplied`, `Status`,
> `DateCP`, `PlanNum`, `InsSubNum`. RCM does **not** need a connector-side SQL
> export for per-procedure adjudication data. See
> [Live probe transcript](#live-probe-transcript-2026-08-04) for the evidence and
> the two behavioural traps it exposed.

Every row below marked **verified** was proven against the live Roland Open
Dental database on 2026-08-04, read-only, from inside the staging container.

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
| Patient search by name | **partial** ✅verified | `GET /patients?LName` / `?FName` | ⚠️ **`LName`/`FName` are PREFIX matches** — **proven live**: `LName=Spark` returns **18 rows**, the first being "Sparkman". No exact-match parameter exists. Mitigated, not solved: DOB + phone are always returned and the UI never auto-selects. Both name lanes are load-bearing — the module's own test patient 12828 is `LName: "Test", FName: "MangoTest"`, so a last-name-only search misses it |
| Patient DOB / phone / email | **confirmed** | `GET /patients` | TC normalizes its own shape; the voice client's `transformPatientData` drops `WirelessPhone`, which is the number the legacy TC app preferred |
| Patient status filter | **confirmed** | `GET /patients` | API returns a **string** enum (`"Patient"`, `"Inactive"`, `"Deceased"`…), not the DB int |
| Patient by PatNum | **confirmed** | `GET /patients/{PatNum}` | |
| Treatment plans for a patient | **confirmed** | `GET /treatplans?PatNum` | |
| Saved-plan procedures | **confirmed** ✅verified | `GET /proctps?TreatPlanNum` | **Plural only** — `/proctp` returns 404 "proctp is not a valid resource" |
| Active/Inactive-plan procedures | **confirmed** ✅verified | `GET /treatplanattaches?TreatPlanNum` → `GET /procedurelogs/{ProcNum}` | **Plural only** — `/treatplanattach` returns 404. Up to `TP_ATTACH_CAP` (25) procedure calls, bounded-concurrency |
| Next scheduled appointment | **confirmed** ✅verified | `GET /appointments?PatNum&AptStatus=Scheduled&dateStart` | `provAbbr` on the row removes the legacy provider join. `AptStatus` is the **string** `"Scheduled"`, not DB `1` |

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
| `ProcStatus = 1` (treatment planned) | **confirmed** ✅verified | `GET /procedurelogs?ProcStatus=TP` | Roland's OD accepts it (returned a full 100-row page). Older builds reject the param; the route detects that, degrades to an unfiltered scan with a client-side filter, and says so in `notes[]` |
| `ProcFee`, `PatNum`, `DateTP` per procedure | **confirmed** | `GET /procedurelogs` | |
| `pl.ProcFee > 0` | **partial** | — | No fee predicate in the API; applied client-side |
| `pl.DateTP >= cutoff` | **partial** | — | **No `DateTP` filter exists.** `GET /procedurelogs` filters on `ProcDate` and `DateTStamp` only — neither is the treatment-planned date. Window applied client-side over scanned rows |
| `GROUP BY PatNum` + `SUM`/`COUNT`/`MIN`/`MAX` | **partial** | — | No aggregation in the API; grouped client-side |
| `HAVING totalFee >= minFee` | **partial** | — | No aggregate filter; applied after grouping |
| `ORDER BY totalFee DESC` | **partial** | — | No server-side ordering; sorted client-side |
| `JOIN patient` (name, DOB, phone, email) | **partial** | `GET /patients/{PatNum}` | **No join exists.** One extra call per ranked patient, so demographics are fetched only for the returned page. A patient whose record fails to read keeps its money and is labelled `PatNum <n>` rather than being dropped |
| `p.PatStatus = 0` | **partial** | `GET /patients/{PatNum}` | Applied *after* the demographics fetch, so an inactive patient can consume one of the ranked slots |
| `pl.ClinicNum = ?` | **partial** ✅verified | `GET /procedurelogs?ClinicNum` | The param exists (OD 23.3.13+) but is **left unset by default**: the customer key already scopes to one practice database. Live probe shows **every Roland procedure carries `ClinicNum: 0`**, so the legacy default of 0 was right and setting `TC_OD_CLINIC_NUM=0` would be a no-op. Leave unset; it only becomes meaningful in a multi-clinic database |
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

**Verdict: fully expressible.** `GET /claimprocs` exists and returns the entire
claimproc row, so this is a faithful port rather than a substitute — including
the same `DateCP` basis for year-to-date usage.

| Data element | Coverage | OD endpoint | Notes |
|---|---|---|---|
| TP procedures (code, tooth, surface, fee) | **confirmed** ✅verified | `GET /procedurelogs?PatNum&ProcStatus=TP` | `procCode` + `descript` on the row remove the `procedurecode` join |
| Primary / secondary designation | **confirmed** ✅verified | `GET /patplans?PatNum` | `Ordinal` 1 / 2, exactly as the legacy join used |
| Carrier, group name/number, plan type, COB rule | **confirmed** ✅verified | `GET /inssubs/{n}` → `GET /insplans/{n}` → `GET /carriers/{n}` | 3 calls per plan; the full legacy chain |
| Coverage effective / termination dates | **confirmed** | `GET /inssubs/{n}` | |
| Annual maximum, deductible, coinsurance % | **confirmed** ✅verified | `GET /benefits?PlanNum` **and** `?PatPlanNum` | Both levels read and merged — patient-specific rows override plan-level ones. ⚠️ `MonetaryAmt: -1` means **unlimited**, and is skipped rather than read as $0 |
| Benefit-year start | **confirmed** ✅verified | `GET /insplans/{n}` → `MonthRenew` | **Better than legacy**, which hard-coded January 1 regardless of the plan's renewal month (`MonthRenew` 0 = calendar year) |
| **Per-plan contracted allowed amount** (`ProcFee − WriteOffEst`) | **confirmed** ✅verified | `GET /claimprocs?PatNum` | The endpoint the legacy join needed. See the **-1 sentinel** trap below |
| Per-procedure insurance estimate (`claimproc.InsEstTotal`) | **confirmed** ✅verified | `GET /claimprocs?PatNum` | |
| Per-procedure deductible estimate (`claimproc.DedEst`) | **confirmed** ✅verified | `GET /claimprocs?PatNum` | `null` when OD has not calculated it — never `0` |
| YTD paid / deductible applied | **confirmed** ✅verified | `GET /claimprocs?PatNum` | Same rows, same `DateCP` basis as the legacy `SUM(InsPayAmt)`, `SUM(DedApplied)` |
| Supplemental payments | **confirmed** ✅verified | `GET /claimprocs?PatNum` | `Status: "Supplemental"` counted alongside `"Received"`, matching legacy `Status IN (1,4)` |

#### `/claimprocs` — the contract, as measured

Accepts `PatNum`, `ProcNum`, `ClaimNum`, `PlanNum`, `Status`, `DateCP`, `Offset`
(100/page). The **singular** `/claimproc` is not a resource. Returns ~48 fields
including everything the legacy query read.

`Status` is OD's **string** enum, not the DB integer — passing `Status=1` returns
`400 "Status is invalid."`. Verified valid values: `NotReceived`, `Received`,
`Preauth`, `Adjustment`, `Supplemental`, `Estimate`, `CapEstimate`, `InsHist`.
The legacy integer sets map as:

| Legacy SQL | Meaning | API strings |
|---|---|---|
| `Status IN (6, 0)` | treatment-plan estimates | `Estimate`, `NotReceived` |
| `Status IN (1, 4)` | money actually paid | `Received`, `Supplemental` |

#### Two traps this exposed (both fixed here, both bugs in the legacy code)

**1. `-1` means "not calculated", not "zero dollars."** OD writes `-1` into
`WriteOffEst`, `DedEst`, `InsEstTotal` and `AllowedOverride` when it has no
estimate. The legacy query did `COALESCE(cp.WriteOffEst, 0)` and then
`fee − writeOff` — but `COALESCE` only guards SQL `NULL`, and OD stores `-1`, not
`NULL`. **The legacy COB calculator therefore produced an allowed amount one
dollar ABOVE the billed fee on every uncalculated line.** Confirmed live: patient
11618's D0140 carries `DedEst: -1` and `AllowedOverride: -1`. Here `-1` maps to
`null`, the allowed amount falls back to the billed fee, and the line is counted
in `fallbackLines` so the panel can warn.

**2. OD's `*Override` columns win.** `WriteOffEstOverride`, `InsEstTotalOverride`
and `DedEstOverride` are what Open Dental itself displays when set. The legacy
query ignored them, so the calculator could silently disagree with the number on
the OD screen. Here the override takes precedence.

#### One improvement over the legacy join

The legacy SQL reached the plan ordinal via `inssub ON PlanNum` → `patplan ON
InsSubNum`. `claimproc` carries `InsSubNum` **directly**, so this matches on that
first (falling back to `PlanNum`). Two subscribers on the same group plan — a
couple who both work somewhere and each cover the other — resolve correctly here
and could collide in the legacy join. Verified live: patient 11618's claimprocs
carry `InsSubNum: 15019`, which is exactly the `InsSubNum` on their `Ordinal: 1`
patplan row.

#### What this means for RCM

**RCM does not need a connector-side SQL export for adjudication data.** Every
field the EOB/denial workflows want — `InsPayAmt`, `WriteOff`, `DedApplied`,
`Status`, `DateCP`, `ClaimNum`, `ClaimPaymentNum`, `ClaimAdjReasonCodes` — is on
the `/claimprocs` payload, filterable by `ClaimNum`, `PlanNum`, `Status` and
`DateCP`. Plan on that transport.

Two caveats to carry into RCM design:

- **Paging, not aggregation.** No `SUM`, no `GROUP BY`, no server-side ordering,
  100 rows per page. Practice-scale roll-ups are a scheduled-sync shape, not an
  interactive one.
- **Estimates and payments share the table.** Filtering on `Status` is not
  optional: mixing `Estimate` rows into a payment total double-counts, and mixing
  `Received` rows into a treatment-plan estimate makes planned work look
  pre-paid. Both directions are guarded here and both should be guarded there.

---

## Resource-name and entitlement notes

The legacy app called `/proctp` and `/treatplanattach` (**singular**) and carried
a whole `procEndpointBlocked` branch for the 404s that produced. That branch was
firing because **the singular names are simply not resources** — confirmed live
above. OD's resources are plural. The port tries **plural first, then the legacy
singular alias**, memoized per request, and records which one answered in
`endpointsUsed[]`; on Roland the plural always wins on the first call.

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
| `WriteOffEst = -1` | `COALESCE(…,0)` → allowed = **fee + $1** | treated as "no estimate" → falls back to the billed fee and is counted |
| OD `*Override` columns | ignored — could disagree with the OD screen | take precedence, as OD itself does |
| Plan-ordinal match | via `PlanNum` (collides for two subscribers on one group plan) | via the claimproc's own `InsSubNum`, `PlanNum` as fallback |
| Import to a case | direct | **review step** — editable table, per-row include, live total, explicit confirm |

## Tunables

| Env var | Default | Effect |
|---|---|---|
| `TC_OD_CALL_TIMEOUT_MS` | `30000` | Per-OD-call timeout |
| `TC_OD_CONCURRENCY` | `5` | Max OD calls in flight per fan-out |
| `TC_OD_TP_ATTACH_CAP` | `25` | Procedures read per Active/Inactive plan (legacy parity) |
| `TC_OD_MAX_SCAN_PAGES` | `40` | Page cap for the practice-wide TP scan (100/page) |
| `TC_OD_CLINIC_NUM` | *(unset)* | Adds a `ClinicNum` filter. Leave unset until verified |

## Live probe transcript (2026-08-04)

Read-only GETs against the **live Roland Open Dental database**, run from inside
`rg-carein-staging/ca-carein-backend` (revision `0000061`) so the practice's keys
were used in place and never printed. No writes, no OD state changed.

**Resource existence — plural wins, singular is dead**

```
GET /claimprocs?PatNum=12828        → 200  (0 rows; this patient has none)
GET /claimproc?PatNum=12828         → 404  "claimproc is not a valid resource."
GET /proctps?TreatPlanNum=1         → 200  2 rows
GET /proctp?TreatPlanNum=1          → 404  "proctp is not a valid resource."
GET /treatplanattaches?TreatPlanNum=1 → 200
GET /treatplanattach?TreatPlanNum=1   → 404  "treatplanattach is not a valid resource."
GET /procedurelogs?ProcStatus=TP    → 200  100 rows (full page), all ClinicNum 0
GET /benefits?PlanNum=1             → 200  22 rows
```

**`/claimprocs` filters and enum**

```
?PlanNum=1                 → 200 (100)     ?PatNum=11618&Status=Received → 200 (6)
?ProcNum=<n>               → 200 (1)       ?DateCP=2026-01-01            → 200 (100)
?PatNum=11618              → 200 (53)      ?PatNum=11618&Offset=50       → 200 (3)
?Status=NotReceived|Supplemental|Estimate|CapEstimate|Adjustment|InsHist → 200
?Status=0  →  400 "Status is invalid."     ?Status=1 → 400 "Status is invalid."
```

**Patient search — prefix matching proven**

```
LName=Spark      → 18 rows, first "Sparkman"          ← prefix, not exact
LName/FName=MangoTest → 12828  Test, MangoTest  DOB 1990-01-01  Patient
LName/FName=Stedi     → 12829  Stedi, Test 2   DOB 1985-05-15
                        12826  Test, Stedi     DOB 2025-09-24
                        12827  Test 2, Stedi   DOB 2025-09-24   ← the named fixture
LName=Sparkman   → 8305 Aiden · 1017 Amy · 1618 Beau · 1094 Cason
                   11474 Cecile (Inactive — correctly retained; only
                   Deceased/Deleted/NonPatient are excluded, per legacy)
```

⚠️ **PatNum 12828 is `LName: "Test", FName: "MangoTest"`** — a last-name-only
search misses it entirely. The dual-lane merge ported from the legacy app is what
makes this fixture findable, and is not optional.

**Treatment plan (PatNum 11618)**

```
GET /treatplans?PatNum=11618 → 33782:Active  33834:Saved  33994:Saved  34604:Saved
newest Saved (34604) → GET /proctps → 12 billable rows, fee total $2,001.00
  D7210  t18  fee 315  pri 315  sec 0  pat 0
  D0220  t19  fee  34  pri  34  sec 0  pat 0
  D7210  t19  fee 316  pri 316  sec 0  pat 0
  D4341  t—   fee 284  pri 284  sec 0  pat 0
```

**COB + insurance (PatNum 11618)**

```
patplans          → InsSubNum 15019 → Ordinal 1 (primary only, no secondary)
claimprocs        → 53 rows across 2 pages (Received 6 / Estimate 27 / Preauth 20)
TP procedures     → 22 lines, $5,315.84 total
per-line (allowed = fee − WriteOffEst, overrides applied, -1 → null):
  D0140  fee  86.00  allowed  86.00  insEst  86   dedEst null   (DedEst was -1)
  0000   fee   9.84  allowed   9.84  insEst   0   dedEst null
  D4910  fee 151.00  allowed 151.00  insEst   0   dedEst 0
  D1330  fee  60.00  allowed  60.00  insEst   0   dedEst null
  D0160  fee 164.00  allowed 164.00  insEst 156   dedEst 0
fallbackLines     → 6 of 22 (no write-off estimate → billed fee, warned in the UI)

plan chain        → PlanNum 14914 · "OK DUAL COMPLETE PLAN PPO H2001-056"
                    PlanType "p" (PPO) · CobRule "Basic" · MonthRenew 0
carrier           → "UNITED HEALTHCARE DUAL COMPLETE PLANS"
benefits          → CoInsurance 100% rows; MonetaryAmt -1 (unlimited) → skipped,
                    NOT read as $0. No Limitations/Deductible row on this plan, so
                    annualMax stays null and the panel says "none on file"
YTD (ordinal 1)   → benefit year 2026-01-01 (MonthRenew 0)
                    paid $327.00 · deductible applied $0.00 · 4 claimprocs
```

`dedEst null` vs `dedEst 0` on adjacent lines is the -1 sentinel being handled:
D0140 carries `DedEst: -1` ("not calculated") and D4910 carries a real `0`.

### What this transcript does **not** prove

The probes exercise the same OD calls and the same arithmetic as
`backend/routes/tc/odReads.js`, but they are **not** the deployed module — this
branch is not on staging yet. Still outstanding, and the right content for the
staging walk after merge:

1. the routes end to end through `requireModule` + `requireOffice` +
   `requireOdOffice` against real OD (unit-tested against a fake OD, not live);
2. Beau's **dollar-for-dollar side-by-side** of the treatment-plan pull and the
   COB panel against the legacy app — noting that the two are **expected to
   disagree** on any line where the legacy `-1` bug inflated the allowed amount
   by $1, and where OD's `*Override` columns are set;
3. `valley` rendering the not-connected state in the browser.

## Audit

Each PHI read emits **exactly one** `audit_log` row (`action: READ`,
`resource_type: od_*`), matching the granularity the voice module gets from
`odAccess`'s audited named methods. `odApiGet` is deliberately unaudited so a
25-call treatment-plan fetch produces one row, not 25. Search terms are PHI and
are **never** recorded — `od_patient_search` rows carry `resource_id: null`.

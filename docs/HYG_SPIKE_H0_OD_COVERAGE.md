# H0 Spike — Open Dental Cloud API coverage for the Hygiene App

**Status:** investigation complete. **Read-only — no writes were performed and no code changed**
outside this file.
**Date:** 2026-08-12 · **Branch:** `spike/h0-od-coverage` (off `origin/develop` @ `6e70bfd`)
**Scope:** OD **Cloud API** (`https://api.opendental.com/api/v1`, `Authorization: ODFHIR {dev}/{customer}`).
Not direct MySQL, not the on-prem connector.

## How verdicts were reached

Two evidence classes, kept separate throughout:

- **GET-verified** — a live `GET` through the staging container against the real office database,
  status + response shape recorded below. Probes ran via
  `az containerapp exec -g rg-carein-staging -n ca-carein-backend`, calling
  `loadSecrets()` → `getOdOffice(<key>).client.client.get(...)`.
- **Docs** — Open Dental's published developer documentation
  (`opendental.com/site/api<resource>.html`), which is the same source
  [docs/OD_API_CONTRACT.md](OD_API_CONTRACT.md) was built from.

**Patients touched:** `12827` (roland, *Stedi Test 2*), `12828` (roland, *Test, MangoTest*),
`7115` (valley, *Stedi TestValley*). `11373` was not used.

> **One disclosed deviation.** To capture a real `periomeasure` response *shape* (the fixtures have
> no perio history), one probe read `GET /periomeasures?PerioExamNum=1`. That response contains **no
> patient identifier of any kind** — only `PerioExamNum`, `SequenceType`, `IntTooth` and six depth
> integers — so no PHI was exposed, but it is not a designated-fixture read and I am flagging it
> rather than burying it. Every other probe was fixture-scoped or non-patient reference data.
> A `GET /appointments?date=…&Op=1` probe (Q4) returned live schedule rows; nothing from those rows
> is reproduced here.

## The single most important number

Both offices report the **same OD server version**, GET-verified via `GET /preferences?PrefName=ProgramVersion`:

| Office | ProgramVersion |
| --- | --- |
| roland | **25.4.48.0** |
| valley (Riley) | **25.4.48.0** |

Every capability below has a "Version Added" gate in OD's docs. **25.4.48 clears all of them** —
the newest gate that matters here is `documents` PUT/DELETE at 24.2.32. The only OD feature I found
that this build does *not* reach is `SnomedBodySite` on procedurelogs (26.1.36), which is irrelevant
to hygiene. **No capability in this report is blocked by server version.**

---

## 1. Coverage matrix

| Capability | OD resource | Read | Write | Constraints | Confidence |
| --- | --- | --- | --- | --- | --- |
| Perio exam header | `/perioexams` | ✅ `GET ?PatNum=`, `?ExamDate=` | ✅ `POST` (23.1.20), `PUT` (23.3.27), `DELETE` (23.3.27) | `PatNum` required; `ExamDate`/`ProvNum`/`Note` optional on POST | **GET-verified** (roland+valley 200); write docs-only |
| Perio measurements, 6-site | `/periomeasures` | ✅ `GET ?PerioExamNum=` | ✅ `POST` (22.4.37), `PUT` (22.4.37), `DELETE` **Mobility/SkipTooth only** | one row per (tooth, SequenceType); **no bulk POST**; `-1` = no measurement | **GET-verified** (shape below); write docs-only |
| Probing depths | `SequenceType: "Probing"` | ✅ | ✅ | 6 surfaces `MB/B/DB/ML/L/DL`, 0–19 | GET-verified shape |
| Bleeding / suppuration / plaque / calculus | `SequenceType: "BleedSupPlaqCalc"` | ✅ | ✅ | **one packed bitfield 0–15**: bleed 1 + sup 2 + plaque 4 + calc 8 | Docs |
| Recession / gingival margin | `SequenceType: "GingMargin"` | ✅ | ✅ | surface values `-1`, 0–19, **101–119 = negative** (subtract 100) | Docs |
| Mobility | `SequenceType: "Mobility"` | ✅ | ✅ | `ToothValue` 0–19; all six surfaces must be `-1` | Docs |
| Furcation, MGJ, SkipTooth | same | ✅ | ✅ | see §2 constraint table | Docs |
| Clinical attachment loss | `SequenceType: "CAL"` | ⚠️ derived | ❌ | **not stored** — computed from Probing + GingMargin | Docs |
| Clinical procedure note | `/procnotes` | ✅ `GET ?PatNum=&ProcNum=` (24.2.29) | ✅ `POST` (22.2) — **append-only, no PUT, no DELETE** | requires an existing **`ProcNum`**; `isSigned`, `doAppendNote` | **GET-verified** (200, both offices) |
| Visit-level (multi-procedure) note | `/procedurelogs/GroupNote` | ✅ `GET /procedurelogs/GroupNotes?PatNum=` (25.2.38) | ✅ `POST` (22.2), `PUT` (22.2.29), `DELETE` (22.3.8) | creates a `~GRP~` procedure spanning `ProcNums[]`; `isSigned`, `doAppendNote` | Docs |
| Read-only chart/progress view | `/chartmodules/{PatNum}/ProgNotes` | ✅ | ❌ none | paginated `Offset`; mixed object types | Docs |
| Communication log (what we write today) | `/commlogs` | ✅ | ✅ `POST` | `CommType` DefNum **per office** (486 roland / 451 valley) | Live in prod |
| PDF → patient Images module | `/documents/Upload` | ✅ `GET ?PatNum=` | ✅ `POST` (21.1); `PUT`/`DELETE` (24.2.32) | `rawBase64` + `extension`; `DocCategory` DefNum **per office** | **GET-verified** (`/documents?PatNum=` 200, both offices) |
| Image category list | `/definitions?Category=18` | ✅ | — | 33 categories roland / 31 valley, **different DefNums** | **GET-verified** |
| Day-view appointments | `/appointments?date=` | ✅ | ✅ (live) | **no provider filter param**; `Op` filters exactly one operatory | **GET-verified** |
| Operatory columns | `/operatories` | ✅ | ❌ | `IsHygiene`, `ProvHygienist`, `ItemOrder`, `IsHidden` | **GET-verified** (24 rows roland) |
| Availability / blockouts | `/schedules?date=` | ✅ | — | `SchedType` Practice/Provider/Blockout/Employee | **GET-verified** (23 rows) |
| Schedule → operatory mapping | `/scheduleops` | ✅ | — | **paginates at 100**; use `?ScheduleNum=` | **GET-verified** |
| Appointment types | `/appointmenttypes` | ✅ | — | 23 rows roland; carries `Pattern`, colors | **GET-verified** |
| Providers | `/providers` | ✅ | — | `IsSecondary` ≈ hygiene; no `IsHygienist` flag | Prod-proven (38 rows) |

---

## 2. Q1 — Perio charting: can we write perio exams and measurements?

**Yes. Fully, including writes, on both offices' current build.** This was the question most likely
to come back "no", and it came back yes.

### What exists

`POST /perioexams` (23.1.20) creates the exam header; `POST /periomeasures` (22.4.37) creates one
measurement row per tooth per sequence type; `PUT /periomeasures/{n}` corrects one. GET on both was
verified live against roland and valley — both returned `200` with `[]` for the fixtures (they have
no perio history, which is expected and is itself the correct negative result).

Live `GET /periomeasures?PerioExamNum=1` returned 18 rows in exactly the documented shape:

```json
{ "PerioMeasureNum": 2, "PerioExamNum": 1, "SequenceType": "Probing", "IntTooth": 2,
  "ToothValue": -1, "MBvalue": 1, "Bvalue": 1, "DBvalue": 1,
  "MLvalue": 0, "Lvalue": 0, "DLvalue": 0, "SecDateTEdit": "2022-03-10 13:09:13" }
```

**This is genuine 6-site-per-tooth charting** — `MB, B, DB, ML, L, DL` — not a simplified model.

### Sequence-type constraint table (docs)

| SequenceType | `ToothValue` | Surface values | Meaning |
| --- | --- | --- | --- |
| `Probing` | must be `-1` | `-1`, 0–19 | pocket depths |
| `GingMargin` | must be `-1` | `-1`, 0–19, **101–119** | gingival margin; **101–119 encodes negative** (recession) |
| `Mobility` | 0–19 | all must be `-1` | tooth-level only |
| `Furcation` | must be `-1` | `-1`, 0–19 | surface-level only |
| `MGJ` | must be `-1` | `-1`, 0–19 | teeth 17–32: `MLvalue`/`Lvalue`/`DLvalue` must be `-1` |
| `SkipTooth` | must be `1` | all must be `-1` | tooth skipped |
| `BleedSupPlaqCalc` | must be `-1` | **0–15** | packed flags: bleed 1, sup 2, plaque 4, calc 8 |
| `CAL` | — | — | **never stored** — derived from Probing + GingMargin |

### Two ways to write, and they are not equivalent

1. **Bulk arch strings on `POST /perioexams`.** `UpperFacial`, `UpperLingual`, `LowerLingual`,
   `LowerFacial` accept a run-length string where digits `0-9` are probing depths and the letters
   `b`, `s`, `p`, `c` set bleeding / suppuration / plaque / calculus. One request charts probing +
   all four flags for a whole arch.
   **Limit: these strings encode probing and BleedSupPlaqCalc only.** Recession, mobility,
   furcation and MGJ are *not* expressible in them.
2. **Per-row `POST /periomeasures`.** Everything else. One HTTP request per (tooth × sequence type).

### Gaps and sharp edges

- **No bulk `POST /periomeasures`.** A full-mouth exam charting probing + recession + mobility +
  furcation is on the order of **60–100+ sequential HTTP requests**. Even with the arch-string
  shortcut for probing, recession alone is up to 32 more. This is a throughput and partial-failure
  design problem, not a capability gap — plan for a write queue with resumability, and decide what
  the UI shows when request 47 of 92 fails.
- **`DELETE /periomeasures` only accepts `Mobility` and `SkipTooth`.** A stray `Probing` row —
  exactly what a misheard tooth number in voice dictation produces — **cannot be deleted**. It can
  only be `PUT` to different values. There is no "undo" for a wrongly-created probing row short of
  `DELETE /perioexams/{n}`, which destroys the entire exam and all its measures.
- **`CAL` is not writable and not stored.** If the product wants to show attachment loss it must
  compute it, and must not claim OD holds it.
- **`ProvNum` on the exam defaults to the patient's primary provider**, not the hygienist who did
  the work — set it explicitly (see the attribution blocker in §6).

### Recommended integration path

Chart perio through the **office-keyed client registry** (`getOdOffice(officeKey)` →
`assertOfficeMatch`), never `platform/odAccess` — perio is per-office chart data and the tenant-level
seam is bound to Roland. Model a "perio exam submission" as: `POST /perioexams` with the arch strings
for probing + flags, capture `PerioExamNum`, then fan out `POST /periomeasures` for the remaining
sequence types under a resumable queue keyed on `PerioExamNum`. Treat the fan-out as the unit of
failure, and never report success until the exam is read back — the same "a success we cannot show
the user again is a lie" rule the transcription path already follows.

---

## 3. Q2 — Hygiene visit notes: what is the correct write surface?

**`/procnotes` and `/procedurelogs/GroupNote` — not commlog.** These are two different things and
the choice matters.

### The three candidate surfaces, and why two lose

| Surface | Where it lands in OD | Verdict |
| --- | --- | --- |
| `POST /commlogs` | Communications, *not* the clinical chart. This is what CareIN writes today (CommType 486/451, "CareIN AI Call") | ❌ **Wrong surface for a clinical note.** It is a communication record. A hygiene visit note filed here is invisible where a clinician looks for it and carries no signature semantics |
| `PUT /procedurelogs/{ProcNum}` | — | ❌ **Cannot do it.** OD's own docs: *"Cannot update notes on single procedures through ProcedureLog endpoints; use API ProcNotes instead."* `ProcNote` is not in the PUT field list |
| `POST /procnotes` / `POST /procedurelogs/GroupNote` | `procnote` table → Chart module progress notes | ✅ **This is the clinical note surface** |

### How the two clinical options differ

- **`POST /procnotes`** — required `PatNum`, `ProcNum`, `Note`. Attaches to **one** procedure.
  Optional `isSigned`, `doAppendNote` (prepends the previous note with two blank lines).
- **`POST /procedurelogs/GroupNote`** — required `PatNum`, `Note`; optional `ProcNums[]`, `ProvNum`,
  `isSigned`. Creates a synthetic procedure with `procCode` `"~GRP~"` spanning several procedures.

A hygiene visit is inherently multi-procedure — prophy, exam, radiographs, fluoride — and the
clinician writes **one** note for the visit. **`GroupNote` is the correct primitive**, and this
build (25.4.48) is past 25.3.36, the version where `GroupNote` stopped requiring matching procdate /
clinic / provider across the grouped procedures.

### Notes are append-only, by design

*"No existing procnote can EVER be edited or deleted."* There is **no PUT and no DELETE** on
`/procnotes`. Edits create new rows; the history is visible in Chart Module → Show → Audit. This is
the right property for a clinical record and the app must be built to match it — an "edit note"
button must be an *append*, and the UI must not imply otherwise.

`GroupNote` does expose `PUT`/`DELETE`, and `doAppendNote` on the PUT — with the caveat that append
is only permitted when the group note is locked but not invalidated.

### The write needs a `ProcNum` — which means the day view must resolve procedures first

Neither surface accepts a bare appointment. The chain is:

```
appointment (AptNum)  →  GET /procedurelogs?AptNum={AptNum}  →  ProcNum[]  →  POST GroupNote
```

`GET /procedurelogs?AptNum=` has existed since 22.3.32, so this is available. **If a hygiene
appointment has no procedures attached, there is nothing to hang the note on** — the app must handle
that state honestly (offer to create the procedure, or refuse) rather than silently falling back to
a commlog.

### Signing / locking — read this before promising hygienists sign their own notes

This is a **hard constraint, not a detail**. See blocker **B1** in §6.

---

## 4. Q3 — Documents: can we upload a router PDF into the Images module?

**Yes.** `POST /documents/Upload`, available since 21.1 and therefore well within both offices'
build. `GET /documents?PatNum=` was verified live at `200` for fixtures at both offices.

**Request:** required `PatNum`, `rawBase64`, `extension` (`".pdf"`). Optional `Description`,
`DateCreated` (`yyyy-MM-dd HH:mm:ss`), `DocCategory`, `ImgType`, `ToothNumbers`, `ProvNum`,
`PrintHeading`. Returns `201`.

For a generated router PDF, `ImgType: "Document"` (the default) is correct — `"Radiograph"`,
`"Photo"`, `"File"`, `"Attachment"` are the alternatives.

Three other insert paths exist (`UploadSftp`, `SetByUrl`, and `DownloadSftp` for retrieval). **All of
them require an SFTP endpoint or a publicly-reachable URL**, which for a PHI PDF means standing up
externally-reachable infrastructure. `Upload` with inline base64 needs none of that and is the right
choice.

### Constraints

- **Per-office compatible: yes**, and mandatory. Auth is the office's own customer key, so the
  upload lands in whichever database that key selects — the same mechanism that makes the commlog
  path per-office.
- 🔴 **`DocCategory` is a per-office `DefNum` and the numbers do not match.** GET-verified:

  | Category | roland DefNum | valley DefNum |
  | --- | --- | --- |
  | Credit Approval | 136 | 136 |
  | Consent Forms | **473** | **429** |

  Roland has 33 image categories, Valley 31. **This is the DefNum-crossing trap that
  [odOffices.js](../backend/config/odOffices.js) already guards for CommLog CommType (486 vs 451),
  reappearing in a second resource.** A hardcoded `DocCategory` would file Riley's routing slips into
  the wrong folder — or a nonexistent one. It belongs in `OFFICE_OD_SETTINGS` next to
  `commTypeDefNum`, with the same "non-numeric override falls back to the default rather than
  writing `NaN` into a chart" discipline.
- **If `DocCategory` is omitted, OD silently files into the first definition in the category.** Not
  an error — a wrong answer. Always send it explicitly.
- ⚠️ **No documented file-size limit.** OD's docs state none for `rawBase64`. Base64 inflates by
  ~33% and the whole payload is a JSON body. **This must be measured before the PRD commits to a
  page count**, and the app should cap and compress rather than discover the ceiling in production.
- Stored with a `_rawBase64_:` prefix in `document.Note`; the prefix is stripped on access.
- `DELETE /documents/{DocNum}` removes **both the row and the file** from the A-to-Z folder.

---

## 5. Q4 — Schedule reads for the Day View

**Fully covered.** All four endpoints GET-verified live against roland:

| Probe | Result |
| --- | --- |
| `GET /operatories` | `200`, **24 rows** — `OperatoryNum`, `OpName`, `Abbrev`, `ItemOrder`, `IsHidden`, `ProvDentist`, `ProvHygienist`, `IsHygiene`, `ClinicNum` |
| `GET /schedules?date=2026-08-12` | `200`, **23 rows** — `SchedType: "Provider"`, `StartTime`/`StopTime`, `ProvNum`, `operatories` (comma string) |
| `GET /scheduleops` | `200`, **exactly 100 rows** — `ScheduleOpNum`, `ScheduleNum`, `OperatoryNum` |
| `GET /appointments?date=2026-08-12&Op=1` | `200`, 10 rows — `AptNum`, `AptStatus`, `Pattern`, `Op`, `ProvNum`, `ProvHyg`, `IsHygiene`, `AptDateTime` |

### Filtering to hygiene — how it actually works

There is **no "hygiene" query parameter anywhere**, and this shapes the implementation:

- **Hygiene operatories** come from `/operatories` → `IsHygiene === "true"` and/or a non-zero
  `ProvHygienist`. Client-side filter, sorted by `ItemOrder`, `IsHidden` excluded.
- **Hygiene appointments** carry their own `IsHygiene` flag and `ProvHyg` — so a row can be filtered
  either by the chair it sits in or by the flag on the appointment. Those two can disagree; the PRD
  should pick one as authoritative.
- 🔴 **Provider filtering is not a GET parameter.** OD exposes only `date`/`dateStart`/`dateEnd`,
  `PatNum`, `Op`, `ClinicNum`, `AptStatus`, `AppointmentTypeNum`, `DateTStamp`. Filtering to a
  hygienist is **client-side after a full-day read** — already documented in
  [OD_API_CONTRACT.md](OD_API_CONTRACT.md) §2 and confirmed here.
- ⚠️ **`Op` filters exactly one operatory.** A multi-chair hygiene day view must **not** fan out one
  request per chair. Pull the day once with `date=` and partition client-side.
- ⚠️ **`/scheduleops` returned exactly 100 rows** — the page size. An unfiltered read is truncated
  and *looks* complete. Use `?ScheduleNum=` per schedule, or page with `Offset`.
- 👍 **OD resolves `Confirmed` for us.** The response carries both the raw DefNum and a resolved
  string (`"Confirmed": 244, "confirmed": "In Treatment Room"`), so the day view does not need its own
  `/definitions` join. The raw field is still a DefNum and still per-office — do not compare it
  across offices.
- `ClinicNum` is `0` on Roland's records (consistent with the TC Slice 5 finding); it is not a usable
  hygiene filter here.

### Recommended path

`/operatories` + `/appointmenttypes` + `/providers` are small and change rarely — cache per office.
Per day: one `/appointments?date=`, one `/schedules?date=`, and `/scheduleops?ScheduleNum=` per
schedule that needs operatory mapping. Prefer `scheduleops` over parsing the comma-separated
`operatories` string, but code defensively — a schedule can legitimately have no scheduleops rows.

---

## 6. Blockers list

Ordered by how much design they move.

### 🔴 B1 — API-written notes are signed as **CareIN**, not as the hygienist

`POST /procnotes` accepts `PatNum`, `ProcNum`, `Note`, `isSigned`, `doAppendNote`. **It accepts no
`UserNum` and no signer identity.** `UserNum` appears in the GET response but is not a settable POST
field. When `isSigned: true`, OD stamps:

> `Digitally Signed by [API DeveloperName]  Date Signed: [MM/dd/yyyy HH:mm:ss tt]`

— the **API developer's name**, i.e. CareIN. Every note from every hygienist at every office carries
one identical signature.

**Why this is a blocker, not a nuisance:** the brief states "hygienists sign their own notes". Via
the Cloud API they cannot. The signature is not attributable to the person who did the work, which
is the entire point of signing a clinical note.

**Design responses, in order of preference:**
1. **Write the note unsigned** (`isSigned: false`) and carry the hygienist's name *inside* the note
   body, leaving the legal signature to be applied by a human in Open Dental. The app becomes a
   drafting tool, which is honest about what it is.
2. Use `GroupNote`'s **`ProvNum`** — the one identity field either note endpoint accepts — to at
   least attribute the note to the right provider, while accepting that the *signature* still says
   CareIN.
3. Escalate to Open Dental for a signer-identity field. Not a path to plan around.

This is the same class of problem the voice module already solved at the app layer with
`hygienist_name` (migration `1786536000000_hygienist_attribution.js`) — "who did the visit" separated
from "who was signed in". That pattern transfers; what does not transfer is any expectation that OD
will *store* the distinction.

### 🔴 B2 — A stray perio measurement cannot be deleted

`DELETE /periomeasures/{n}` accepts **only** `Mobility` and `SkipTooth`. A wrong `Probing` or
`GingMargin` row can be `PUT` to new values but never removed. The only full escape is
`DELETE /perioexams/{n}`, which destroys the whole exam.

**Direct consequence for voice perio charting:** a misrecognized tooth number writes a permanent row.
Voice perio therefore **must not stream measurements straight into OD**. It needs a staged local
buffer with clinician confirmation before any `POST` — which changes the feature from "dictate into
OD" to "dictate, review, commit". That is a PRD-level shape change, so decide it now rather than
after the UI is built.

This does **not** put voice perio in the parking lot — the write API is fully capable. It constrains
*how* it is built.

### 🔴 B3 — `DocCategory` DefNums differ per office (proven: 473 vs 429)

Second instance of the CommType 486/451 trap. Must be per-office config from the first commit, not
retrofitted. See §4.

### 🟡 B4 — No bulk perio measurement write

60–100+ sequential POSTs per full-mouth exam. Needs a resumable queue and a defined partial-failure
state. Capability exists; throughput is the risk.

### 🟡 B5 — Hygiene notes require a `ProcNum`, which may not exist

If the day's hygiene appointment has no attached procedures, there is nowhere to file the note. The
app must resolve `GET /procedurelogs?AptNum=` first and handle the empty case explicitly.

### 🟡 B6 — Document upload size limit is undocumented

Measure before committing to a routing-slip page count. See §4.

### 🟢 B7 — `/scheduleops` silently truncates at 100

Looks like a complete answer. Filter or page.

### ✅ Not blockers (checked and cleared)

- **Server version** — 25.4.48.0 on both offices clears every gate.
- **Per-office reachability** — valley returned live data on every probe; the per-office registry
  works for these resources.
- **Perio write support** — exists and is complete. The brief's contingency
  ("perio writes unsupported → voice perio drops to parking lot") **is not triggered.**

---

## 7. Reusability verdict — `claude/elegant-montalcini`

Branch head `16ad13c`, **3,978 insertions across 25 files**, branched from `0dc90ae` — a commit that
predates the Azure cutover, the tenant/module spine, `odOffices`, and the OD client remediation.
Nothing in it has ever run against the current architecture.

### ❌ Discard

| File | Why |
| --- | --- |
| `server/pms/open-dental.ts` (559 lines) | **Direct MySQL via `mysql2/promise`.** The entire data-access layer targets an architecture this repo abandoned. Hard rule #6 — never write directly to OD MySQL. Its OD conventions (null date `0001-01-01`, integer `AptStatus`) are correct *for MySQL* and wrong for the Cloud API, where `AptStatus` is a string enum. Rewriting it against `getOdOffice()` is a rewrite, not a port |
| `server/pms/factory.ts` | Wrong tenancy model twice over: keyed on `clinicNum`, configured from `OD_HOST`/`OD_USER`/`OD_PASSWORD`. Current model is office key + per-office customer key, and Roland's records carry `ClinicNum: 0` |
| `server/pms/dentrix.ts`, `eaglesoft.ts` | NexHealth stubs for PMSes we do not serve |
| `server/scheduling/audit.ts` | A **parallel** audit system — console JSON plus an in-memory buffer. The platform has an append-only Postgres `audit_log` whose failure-propagates-on-PHI-paths behavior is a hard rule. Two audit systems is worse than one |
| `server/routes/scheduling.ts` | Mounts on `new-dashboard/server/` (the vestigial CareIN-log sub-server), with no `tenantContext`, no `requireModule`, and `getActorId()` returning the literal `"authenticated-user"` with a TODO. Worse: it reads tenancy from an `X-Clinic-Num` **header**, the exact inversion of "office comes from the call, never from a parameter". The route *list* is useful as a spec; the code is not |

### ✅ Lift

| File | Value |
| --- | --- |
| **`server/scheduling/rules-engine.ts`** (225 lines) | **The single most valuable artifact on the branch.** A pure function from `PatientInfo` + `AppointmentRequest` → category, duration, provider type. It encodes the practice's real duration rules — 60-min new-adult exam-no-cleaning, 90-min new-adult-on-recall, 60-min new child, 60/30 existing adult/child — matching the global CLAUDE.md rules exactly, including the judgment call that ambiguous cleaning history ("about a year") defaults to the safer exam-first path. No PMS dependency. Lift nearly as-is |
| `server/scheduling/types.ts` (209 lines) | Good domain vocabulary — `AppointmentCategory`, `ProviderType`, `TimeOfDay`, `DayOfWeek`, `PatientInfo`. Strip `PMSType` and the `clinicNum` threading |
| `server/scheduling/slot-finder.ts` (300 lines) | The 2-question preference script (morning/afternoon × early/late week) plus emergency priority slots, as real logic rather than prose. Depends on `PMSAdapter` — repoint at `getOdOffice()`. **Re-derive the hardcoded 8:00–17:00 window and the 8/11/14 emergency slots from `/schedules` instead of constants** |
| `server/scheduling/constraint-checker.ts` (186 lines) | Overlap/double-booking and hygiene-room checks. Sound logic, same adapter repoint |
| `server/scheduling/schemas.ts` (143 lines) | Zod runtime validation; repo already uses zod. Lift with edits |

### ⚠️ Reference only

`client/src/features/scheduling/` (BookingWizard 700 lines, EmergencyBooking, ProviderPreference,
RulesDisplay, api.ts) — a **booking** flow, not a hygiene day view or routing slip. Useful as a
reference for how the rules engine surfaces to a user; not on the H0 path.

### Bottom line

The branch is a **booking engine, and only a booking engine** — a `git grep` for
`perio|procnote|document|routing slip` across its server and scheduling code returns **nothing**. It
contributes **zero** to Q1, Q2 or Q3. Its value is concentrated in `rules-engine.ts`, and to a lesser
degree `slot-finder.ts` / `constraint-checker.ts` / `types.ts` — roughly **~850 of 3,978 lines are
worth lifting, and none of the data-access layer is.** Lift those four files into the backend as
plain CommonJS services behind the existing module/tenant/office gates. Do not merge the branch, and
do not resurrect `server/pms/`.

---

## 8. Open questions for the PM / Beau

1. **B1 is the decision that gates the PRD.** Given that an API-written note is signed "CareIN" and
   never by the hygienist — is the hygiene app a **note drafting tool** (writes unsigned, human signs
   in OD) or does it **write signed notes under CareIN's identity**? Every downstream UI decision
   about notes hangs on this, and only you can make the call.
2. **Voice perio, given B2:** confirm the staged buffer-then-commit model is acceptable. Dictation
   would not appear in OD until the hygienist confirms the chart. Slower than "dictate straight into
   OD", but a misheard tooth is otherwise permanent.
3. **Perio scope for v1:** probing + bleeding/suppuration/plaque/calculus is one cheap request per
   arch. Recession, mobility and furcation are per-tooth POSTs. Is probing + flags enough for v1?
4. **Note granularity:** one `GroupNote` per visit (recommended) or a `procnote` per procedure?
5. **Which `DocCategory`** should routing slips land in at each office? Neither database has an
   obvious "Routing Slip" category — is a new one being created, or do slips go under an existing
   one? The DefNums will differ per office either way (B3).
6. **Routing slip retention:** OD's `DELETE /documents/{DocNum}` removes the file as well as the row.
   Should the app ever be able to delete a slip it filed, or is filing one-way?
7. **Hygiene filter authority:** appointment `IsHygiene` or operatory `IsHygiene`? They can disagree.
8. **Does the day view need Riley on day one?** Valley is OD-reachable for voice (`odEnabled: true`)
   but `officeAgents.OFFICES.valley.odConnected` is still `false` for TC. The hygiene module needs
   its own explicit answer rather than inheriting either switch.
9. **Where does the module live** — a fifth module namespace (`hygiene`) alongside
   `voice | rcm | tc | scheduling`, or inside `tc`, where `/api/tc/hygiene-intakes` and the
   hygiene-scoped `/api/tc/od/patient-search` already are? Note the namespace list is a **DB CHECK
   constraint**, so a new value is a migration.

---

## Appendix — probe log

All probes read-only, run 2026-08-12 against `rg-carein-staging` / `ca-carein-backend`.

| # | Office | Request | Result |
| --- | --- | --- | --- |
| 1 | roland | `GET /preferences?PrefName=ProgramVersion` | `200` `ValueString: "25.4.48.0"` |
| 1 | roland | `GET /perioexams?PatNum=12827` | `200` `[]` — resource exists, fixture has no exams |
| 1 | roland | `GET /procnotes?PatNum=12828` | `200` `[]` |
| 1 | roland | `GET /documents?PatNum=12828` | `200` `[]` |
| 2 | roland | `GET /periomeasures?PerioExamNum=1` | `200`, 18 rows — shape confirmed (see §2; no patient identifier in payload) |
| 2 | roland | `GET /definitions?Category=18` | `200`, 33 image categories |
| 2 | roland | `GET /appointmenttypes` | `200`, 23 types |
| 3 | valley | `GET /preferences?PrefName=ProgramVersion` | `200` `"25.4.48.0"` |
| 3 | valley | `GET /perioexams?PatNum=7115` | `200` `[]` |
| 3 | valley | `GET /procnotes?PatNum=7115` | `200` `[]` |
| 3 | valley | `GET /documents?PatNum=7115` | `200` `[]` |
| 3 | valley | `GET /definitions?Category=18` | `200`, 31 image categories — **DefNums differ from roland** |
| 4 | roland | `GET /operatories` | `200`, 24 rows |
| 4 | roland | `GET /schedules?date=2026-08-12` | `200`, 23 rows |
| 4 | roland | `GET /scheduleops` | `200`, **exactly 100** rows (page cap) |
| 4 | roland | `GET /appointments?date=2026-08-12&Op=1` | `200`, 10 rows (contents not reproduced) |

**Zero POST / PUT / DELETE requests were issued to any Open Dental database during this spike.**

### Doc sources

`apispecification.html` (106 resources) · `apiperioexams.html` · `apiperiomeasures.html` ·
`apiprocnotes.html` · `apiprocedurelogs.html` · `apidocuments.html` · `apichartmodules.html` ·
`apipreferences.html` — plus repo mirrors [api-appointments.md](api-appointments.md),
[api-operatories.md](api-operatories.md), [api-schedules.md](api-schedules.md),
[api-schedule-ops.md](api-schedule-ops.md), [api-providers.md](api-providers.md),
[api-appointment-types.md](api-appointment-types.md), and
[OD_API_CONTRACT.md](OD_API_CONTRACT.md) / [OD_API_COVERAGE.md](OD_API_COVERAGE.md).

> Corollary worth recording: `/perioexams`, `/periomeasures`, `/procnotes` and `/documents` are all
> **absent from `~/.claude/skills/open-dental/endpoints/`** yet all four are live. That skill's
> endpoint list is a subset of the real API — the same lesson `/claimprocs` taught in TC Slice 5.
> Check `apispecification.html`, not the skill, when asking "does this resource exist".

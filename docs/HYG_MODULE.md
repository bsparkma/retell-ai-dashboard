# The Hygiene module (`hyg`) — H1 slice 1

What shipped, what it refuses to do, and where the next two slices attach.

**Status: mounted, ships dark.** `hyg` is in the `tenant_module` vocabulary as
of `backend/migrations/1788100000000_module_hyg.js`, no tenant is entitled to
it, and `hygOdEnabled` is `false` for every office. Everything under `/api/hyg`
therefore 403s `MODULE_NOT_ENTITLED` in every environment until Beau flips the
entitlement from the Platform Console, and 409s per office until that office's
switch is flipped too.

---

## 1. Three gates, and they answer three different questions

| Gate | Question | Where | Failure |
| --- | --- | --- | --- |
| `requireModule('hyg')` | Did this PRACTICE buy the product? | `server.js` mount | 403, `error: MODULE_NOT_ENTITLED` |
| `requireReadWrite('hyg.read','hyg.write')` | May this PERSON do this? | same mount, by HTTP method | 403 `FORBIDDEN` |
| `hygOdEnabled` | Is this LOCATION switched on? | `config/odOffices.js`, checked per route | 409 `OFFICE_NOT_READY` |

The third one is new, and it is not the mistake `officeAgents.odConnected` was.
That flag gated TC's routes while TC actually reached Open Dental through a
process-wide client built from Roland's key, so flipping it for Riley would have
served Roland's charts under a Riley selector — it and the credential it claimed
to describe were not connected to each other. `hygOdBlockReason()` asks
`odBlockReason()` FIRST and can only narrow the answer; there is no state in
which the hygiene module reaches an office the voice module could not, and the
client still comes from `getOdOffice()` unchanged.

What it buys is what a new clinical module needs: a switch that starts off while
the module is validated at one location, and that can be turned off for one
office without taking that office's voice worklist and TC screens down with it.

**Roles.** `hyg.read` and `hyg.write` are held by `admin`, `office` and
`hygiene`. `tc` deliberately holds neither — a treatment coordinator receives
the handoff (`tc.hygiene`, which already exists), and standing at a chair
reading the day is the other side of that exchange. `hyg.write` exists ahead of
its first use so slice 2's first POST demands it by construction rather than by
whoever writes it remembering to decorate the route.

---

## 2. `GET /api/hyg/day?office=&date=`

One office's whole schedule for one day.

### What it returns

```
{ success: true, office, officeName, date,
  operatories: [{ opNum, name, abbrev, isHygiene, itemOrder }],
  appointments: [{ aptNum, patNum, patientName, start, lengthMin,
                   opNum, opName, isHygiene, opIsHygiene,
                   provNum, provHyg, providerName,
                   apptTypeLabel, confirmedStatus, aptStatus, isNewPatient,
                   flags: { premed, medicalAlerts, allergies, lastPerioDate,
                            xraysDue, examNeeded, openTcCase } }],
  warnings: [{ resource, message }],
  flagSources: { <flag>: 'od' | 'not_read' },
  excludedByStatus, truncated, patientNamesTruncated }
```

The zod schema for this shape is `new-dashboard/shared/hyg/contract.ts` and the
CLIENT parses every response through it. The backend does not — it is CommonJS
with no build step, so running zod there means a second committed esbuild bundle
like `backend/tc/contract.gen.cjs` (650KB plus a byte-compare drift test this
repo's CLAUDE.md already documents as fragile). Slice 1's whole request surface
is two query params. `new-dashboard/tests/hyg-contract.test.ts` pins the
backend's response keys against the schema in the meantime. **When slice 2 adds
request bodies, add the bundle** — a body is where a client and a server most
need the same schema.

### What it refuses to do

**It never answers an empty day it is not sure about.** Five things can go wrong
before there is a day to show, and each has its own status and code:

| Situation | Status | `code` | `reason` |
| --- | --- | --- | --- |
| Not entitled | 403 | `MODULE_NOT_ENTITLED` (in `error`) | — |
| Role lacks `hyg.read` | 403 | `FORBIDDEN` | — |
| Office missing / not one of ours | 400 | `INVALID_OFFICE` | — |
| Date missing or not a real date | 400 | `INVALID_DATE` | — |
| Office not switched on for hygiene | 409 | `OFFICE_NOT_READY` | `OFFICE_HYG_NOT_ENABLED` |
| Office switched on, no customer key | 503 | `OFFICE_NOT_READY` | `OFFICE_OD_KEY_MISSING` |
| Open Dental did not answer | 502 | `OD_READ_FAILED` | — |
| Audit write failed | 500 | `AUDIT_FAILED` | — |

`appointments: []` means, and only means, that nobody is booked. That is not a
stylistic preference: this screen's job is to tell somebody what is about to
happen to them all day, and a blank one that actually means "we could not reach
your practice" is the worst thing it could show.

`2026-02-31` is refused rather than passed through. It matches the date shape,
and JavaScript rolls it forward to March 3rd — Open Dental would then return a
DIFFERENT day's schedule under the heading the caller asked for.

**It never fabricates a flag.** `premed` and `medicalAlerts` are read from
`GET /patients/{PatNum}` and can be `true`, `false` or `null`. The other five
are `null` and `flagSources` says `not_read` — slice 1 does not call
`/allergies`, `/perioexams`, `/documents` or the TC case store at all. A `false`
there would claim we had asked.

**It never invents a duration or a name.** No `Pattern` is a null `lengthMin`,
not the 30 minutes `config/openDental.js`'s older helper defaults to. A patient
record that could not be read is a null `patientName`, not `"Unknown Patient"`.

### How it reads Open Dental

One pull for the schedule, **no per-chair fan-out**. `GET /appointments`
accepts `Op=` and it filters to exactly one operatory (H0 spike §5), so a day
view over eight chairs would issue eight requests against a credential the voice
and RCM modules share to assemble what one `date=` request already returns. The
day is pulled once and partitioned by `Op` in memory. There is no provider
filter at all — narrowing to one hygienist is client-side after a full-day read,
and that is a property of Open Dental's API.

**Paging is not optional.** Open Dental caps every list at 100 rows and pages
with `Offset`. The H0 spike caught this the only way it can be caught:
`GET /scheduleops` came back with exactly 100 rows, which reads as a complete
answer and is not one. `pagedList` keeps requesting until a page comes back
SHORT, and reports `truncated` if its page budget runs out instead of quietly
returning what it had.

Patient identity IS a genuine fan-out: `/appointments` returns `PatNum` and no
name, and Open Dental offers no way to ask for a set of PatNums at once. It is
deduplicated, sequential (the client's throttle slot is per-credential, so
parallel would not finish sooner — only burstier; decision D-8), capped at
`HYG_OD_MAX_PATIENT_READS`, and its budget is reported as
`patientNamesTruncated` — a DIFFERENT fact from `truncated`. A complete
137-patient day whose naming budget ran out is not an incomplete schedule.

### Audit

One `hyg_day` row for the request, plus one `hyg_day_patient` row **per distinct
patient disclosed**. A single "somebody opened Tuesday" row cannot answer "whose
chart was read on Tuesday", which is the question the trail exists to answer.
Fail-closed: the writes happen before the response is sent, and a failure 500s.
A refused request is audited too, best-effort, as `UNAUTHORIZED` — auditing only
successes discards exactly what a HIPAA trail most needs.

### Zero Open Dental writes

The only transport in reach is `apiGetRaw`, which has no write counterpart.
`backend/routes/hyg/hygNoOdWrites.test.js` makes that a test in two ways: it
drives the day route to SUCCESS against a client whose every write verb throws
and asserts none was reached, and it scans every source file in the module for
`apiWriteRaw`, for `.post(`/`.put(`/`.patch(`, and for a non-GET `router.*`
registration. Slice 3 introduces exactly one writer file and that test grows a
one-file allow-list, the way RCM's did. **Do not delete it** — that is how a
guard quietly stops guarding.

---

## 3. `/hyg/day` and `/hyg/visit/:aptNum`

iPad landscape, **1180 × 820**, designed to that viewport first. Every control
is at least 44px and every card at least 88px; nothing is hover-only, because a
tooltip on a touch screen is a chip that means nothing.

Four visually distinct states, and the distinction is the point:

- **loading** — a skeleton in the shape of the day
- **empty** — a bordered, centred, POSITIVE statement: the schedule loaded and
  nobody is on it
- **not ready** — a blue panel, and **no Retry button**: this is a setting, and
  offering a retry invites somebody to spend a minute finding out it can never
  help
- **OD error** — a red panel that says, in as many words, "this is not an empty
  day", and the only one with a Retry

`/hyg/visit/:aptNum` is a slice-2 placeholder rather than a 404: every card is a
link, and a link that 404s teaches a hygienist the app is broken. It shows the
appointment number and **no patient details** — it has made no request, checked
no entitlement and written no audit row, and PHI on a screen with no trail
behind it is what the audit rule exists to prevent.

---

## 4. Configuration

No secrets. Three tunables, all with working defaults:

| Var | Default | Effect |
| --- | --- | --- |
| `HYG_OD_MAX_PAGES` | `25` | Page budget per Open Dental list read (25 × 100 = 2,500 rows). A circuit breaker; exceeding it sets `truncated`. |
| `HYG_OD_MAX_PATIENT_READS` | `120` | Cap on the per-day patient-identity fan-out. Past it, cards come back with no name and `patientNamesTruncated` is true. |
| `HYG_OD_CALL_TIMEOUT_MS` | `30000` | Per-OD-call timeout. Matches `routes/tc/odReads.js` rather than inventing a second number — the legacy TC app proved 10s is too short. |

The per-office switch is **code, not env**: `hygOdEnabled` in
`backend/config/odOffices.js`, default `false` for both offices.

---

## 5. Where slices 2 and 3 attach

- **Slice 2** — `hyg_visit`, `hyg_staged_write`, `hyg_treatment_item` (a TENANT
  migration, each table with its own `carein_app` GRANT block — the
  `call_record` lesson). The Router tab, sections (a)–(l) from the prototype,
  the Odontogram, the treatment items, the records matrix, and the module's
  first mutations. `RECORDS_MATRIX` produces **warnings**, never a gate: Beau's
  ruling is that nothing here hard-blocks a Send on a completeness check, and
  the prototype's two "hard checks" are front-desk work a hygienist cannot do.
- **Slice 3** — the send. The slip rendered to PDF into the patient's images
  (`POST /documents/Upload`, with the office's "Routers" DocCategory resolved BY
  NAME — DefNums differ per office, proven 473 vs 429), and the handoff into TC
  via the existing case-create path. Read-back before anything is marked
  `Written`.

The vocabulary both slices build on is already here:
`new-dashboard/shared/hyg/contract.ts` (`TreatmentItem`, `DxCode`,
`MotivationCode`, `TreatmentStatus`, `StagedWriteState`, `deriveCategory`) and
`shared/hyg/records.ts`.

**`TreatmentPriority` is `"urgent" | "preventative" | "cosmetic"`.** Beau's
ruling; the prototype's P1–P4 does not ship, and neither does its parallel
Routine/Soon/Urgent handoff scale. `"watch"` is a `TreatmentStatus`, not a
priority. Priority and `TreatmentCategory` share the word *cosmetic* and are
different axes; `tests/hyg-contract.test.ts` holds a type-level assertion that
neither is assignable to the other plus a lexical one that they share no EXACT
string — so lowercasing `"Cosmetic"` later fails the build rather than silently
letting a category reach a priority field.

---

## 6. The prototype

`docs/hyg-prototype/` is Beau's v0, vendored as reference and wired into no
build. Its README carries the per-toolchain proof of that and the port/discard
verdict per file. `client/src/lib/hyg/dentition.ts` is the one file ported
byte-for-byte; `tests/hyg-dentition.test.ts` pins it, because the lower arch
reads #32 → #17 on screen and getting that backwards makes every tooth a
hygienist taps the wrong one, in a way that looks plausible.

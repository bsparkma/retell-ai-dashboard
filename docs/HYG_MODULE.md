# The Hygiene module (`hyg`) — H1 slice 1

What shipped, what it refuses to do, and where the next two slices attach.

**Status: mounted, ships dark.** `hyg` is in the `tenant_module` vocabulary as
of `backend/migrations/1788100000000_module_hyg.js`, no tenant is entitled to
it, and no office's pilot switch is on. Everything under `/api/hyg` therefore
403s `MODULE_NOT_ENTITLED` in every environment until the entitlement is flipped
from the Platform Console, and 409s per office until that office's switch is
flipped too. **Both are now clicks, not deploys** — see §8.

---

## 1. Three gates, and they answer three different questions

| Gate | Question | Where | Failure |
| --- | --- | --- | --- |
| `requireModule('hyg')` | Did this PRACTICE buy the product? | `server.js` mount | 403, `error: MODULE_NOT_ENTITLED` |
| `requireReadWrite('hyg.read','hyg.write')` | May this PERSON do this? | same mount, by HTTP method | 403 `FORBIDDEN` |
| the pilot switch | Is this LOCATION switched on? | `config/hygPilot.js`, read per request | 409 `OFFICE_NOT_READY` |

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
  excludedByStatus, truncated, patientNamesTruncated,
  stats: { odListReads, odPatientReads, patientsRequested,
           patientCacheHits, patientCacheDeduped, durationMs } }
```

`stats` is what the read COST — counts and milliseconds, never a PatNum and
never a name. It is in the body rather than only in the log so a before/after
can be measured with one request instead of a log query. See §7.

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

Because the throttle is one request per second per credential, that fan-out was
also the whole latency of this screen: 40 patients meant 40+ seconds of somebody
standing at a chair. Every one of those reads now goes through the shared
per-office cache in `backend/services/odPatientCache.js`, and a morning warm
pays the cold cost before the practice opens. **§7 is the part to read before
changing anything here** — in particular, raising a concurrency number is the
change that does not work.

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

| `OD_PATIENT_CACHE_TTL_MS` | `300000` (5 min) | How long a patient record is served without re-reading Open Dental. **A clinical bound, not a performance knob** — see §7. `0` turns the cache off. |
| `OD_PATIENT_CACHE_MAX_ENTRIES` | `2000` | Ceiling on cached records across every office. Past it, least-recently-used entries are evicted. `0` retains nothing. |
| `HYG_WARM_SCHEDULE` | `45 7 * * *` | Cron for the morning warm, read in `OFFICE_TIMEZONE`. An unparseable value falls back to the default with a warning. |
| `HYG_WARM_DISABLED` | unset | `'true'` arms no warm at all. The SECOND gate — the first is `hygOdEnabled`, which ships false everywhere. |

| `HYG_OD_ENABLED_<OFFICE>` | unset | **Break-glass** per-office kill switch. `false` forces that office OFF, whatever the console says. `true` is accepted and can never enable anything (it is reported at boot and on screen as inert); anything else is ignored. See §8. |
| `HYG_PILOT_REFRESH_MINUTES` | `5` | How often the stored pilot switch is re-read in the background. A console write does not wait for this. |

The per-office switch is no longer code: it lives in the control plane and is
flipped from the Platform Console. `OFFICE_OD_SETTINGS[x].hygOdEnabled` is now
only the FLOOR of that precedence chain and stays `false`. See §8.

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

---

## 7. The patient cache and the morning warm

### The arithmetic

Open Dental throttles at **one request per second per credential**, and the
reservation slot is shared by every module on that credential (`OD_SLOTS` /
`odSlotKeyFor` in `backend/config/openDental.js`). `GET /appointments` returns
`PatNum` and no name, and there is no bulk patient read. So naming the people on
a day costs one `GET /patients/{PatNum}` per distinct patient — which the
throttle turns into one SECOND per distinct patient.

Measured on the shipped code paths with that spacing applied
(`node backend/scripts/measure-hyg-day-cost.js`, 40 distinct patients):

| | OD requests | wall clock |
| --- | --- | --- |
| Cold, no cache — what shipped in slice 1 | 44 (4 list + 40 patient) | **43.0s** |
| Second load of the same day | 4 (4 list + 0 patient) | **3.0s** |
| First load after the 7:45 warm | 4 (4 list + 0 patient) | **3.0s** |

The warm itself is 40 reads in 39s, at 7:45am against an idle credential with
nobody waiting on it. The 3.0s that remains is the four LIST reads —
appointments, operatories, appointment types, providers — which this slice does
not cache. They are the next thing worth looking at, and two of them
(appointment types, providers) are practice configuration that changes monthly.

### Concurrency is not the lever

`routes/tc/odReads.js` already runs this exact fan-out through
`mapLimit(top, OD_CONCURRENCY = 5, ...)` and gets nothing for it: the shared
per-credential slot serializes the requests whatever the caller's concurrency
number says. All a higher number buys is a burstier share of a slot the voice
path is also waiting on (decision D-8). **If this screen is slow and you are
about to raise a concurrency constant, that is the change that does not work.**

### `backend/services/odPatientCache.js`

Shared, not hyg's. It caches the RAW `GET /patients/{PatNum}` body, so every
module keeps its own normalizer and three modules can share one entry.

- **Keyed on office + PatNum.** PatNum numbering restarts in every Open Dental
  database — 7115 is the valley test patient AND a different real person in
  roland — so a cache keyed on PatNum alone is a cross-office PHI disclosure.
  `cacheKey()` throws on a missing or unregistered office rather than defaulting
  one, and `odPatientCache.test.js` drives the isolation from both directions.
- **TTL 5 minutes.** `commlogTypes.js` caches for an hour and is right to: it
  holds practice configuration. This holds `Premed` and `MedUrgNote`, which a
  front desk can change mid-morning, in front of a screen somebody reads at a
  chair. Five minutes collapses refreshes, back navigation and date flipping
  without ever aging a medical alert.
- **Stale is never served.** Past the TTL the entry is *deleted* before the
  refresh is attempted, so a failed refresh returns a miss and the card renders
  the way a failed read already renders — no name, null flags, the existing
  warning. A stale name is harmless; a stale alert is not; they arrive in one
  record, and refusing to split them is the safe choice.
- **Bounded and in-flight deduped.** LRU-evicted at
  `OD_PATIENT_CACHE_MAX_ENTRIES`, and two concurrent day loads issue one read
  per patient, not two.

**Audit is not the cache's job.** An audit row records a disclosure to a USER,
not a fetch from a vendor, and a cache hit discloses that patient just the same.
`routes/hyg/day.js` therefore builds its rows from what it is about to SEND, and
`routes/hyg/hygDayCache.test.js` pins both halves at once: zero patient reads on
the second load, and the same number of `hyg_day_patient` rows. Never move an
audit call inside the cache — the better it got, the emptier the trail would get.

### `backend/services/hygDayWarm.js`

The cache does nothing for the 8am first load, which is the load that matters.
The warm pre-fetches today's patients before the practice opens.

- Only offices where `hygOdEnabled` is true — which is none of them today, so it
  warms nothing until Beau turns an office on. **The warm must never be the
  thing that starts talking to a practice.**
- No `minIntervalMs`, so it takes the default share of the shared slot and can
  never raise its priority the way RCM's batch matcher deliberately does. It is
  attributed as `hyg-warm` so the transport counters can tell it apart.
- **It writes no audit rows.** Nobody is looking at anything; there is no actor
  to attribute a disclosure to. The disclosure is recorded when a hygienist
  opens the day. This is the exact mirror of the audit rule above, and just as
  easy to get backwards.
- One log line per office per pass. A failed warm is a warning — the Day View
  still works, it is merely cold.
- Not fired at startup: a mid-afternoon deploy must not put a patient fan-out on
  a credential people are using.

**A same-day add-on booked after the warm is a cold read.** That is correct
behaviour, not a gap: the alternative is a schedule that leaves out the patient
who was just added.

### The schedule and the TTL are coupled, and the coupling is tight

A five-minute TTL means a warm at time T helps loads in roughly `[T, T+5min]`
and nothing after. That is why the default is 07:45 rather than the 6am a
"morning warm" sounds like — as close to an 8am open as "before it opens"
allows. An operator who needs a wider window sets a repeating `HYG_WARM_SCHEDULE`
across hour 7, at the cost of re-reading every patient on every pass.

**Do not close the gap by raising the TTL.** It is a clinical bound. If a cold
first load is still too slow at a chair, the next lever is returning the
schedule immediately and filling names in progressively — not a longer window in
which a medical alert is invisible, and not more concurrency.

### Measuring it on staging

Not possible today, and that is worth stating plainly: `/api/hyg/*` is behind
`requireModule('hyg')` with no tenant entitled, and `hygOdEnabled` is a hardcoded
`false` with no environment override. On staging the endpoint answers 403, and
after entitlement it answers 409 `OFFICE_NOT_READY`. A staging before/after
therefore needs (1) this branch deployed, (2) `hyg` entitled for the staging
tenant from the Platform Console, and (3) `hygOdEnabled: true` for roland in
`config/odOffices.js` — which is itself a deploy. Once those are in place the
numbers come straight out of the response (`stats.odPatientReads`,
`stats.durationMs`) and the `[hygday]` line in the container log.

### Where TC and RCM adopt it

Three call sites do the same `GET /patients/{PatNum}` fan-out on the same shared
credential and are deliberately NOT changed here — both modules are live in
production and hyg is dark, so fixing a dark module must not move live
behaviour. Each is a one-line change:

| Call site | Change |
| --- | --- |
| `backend/routes/tc/odReads.js:330` (`getPatient`) | wrap the `odGet` in `odPatientCache.getPatient(office, patNum, ...)`; the office is already resolved by the caller |
| `backend/routes/tc/odReads.js:674` (the `mapLimit` demographics join) | same, and the `OD_CONCURRENCY` around it can then go — it never bought anything |
| `backend/services/rcm/odClaimReads.js:366` (`getPatient`) | same |

The cache stores the raw Open Dental body precisely so those three can share
entries with hyg rather than each keeping their own.

---

## 8. The pilot switch, and the runbook that goes with it

### Why it stopped being a constant

`OFFICE_OD_SETTINGS[x].hygOdEnabled` was a hardcoded `false` in backend source.
Turning hygiene on for Roland meant a deploy — and so did turning it **off**.
Pilot morning, a hygienist hits a problem at 9am with a patient in the chair;
switching that office off has to take under a minute. **A kill switch that
requires a deploy is not a kill switch.**

It also unblocked two things: the Day View's staging measurement (§7 of this
doc, which needed a second deploy just to flip the flag) and
`services/hygDayWarm.js`, which had never executed anywhere — its first real run
would otherwise have been pilot morning in production.

### Precedence

```
HYG_OD_ENABLED_<OFFICE>=false        ← break-glass. Forces OFF. Always.
  ↓ (unset, =true, or unparseable — none of which can ENABLE anything)
platform_setting['hyg_od_enabled']   ← the console writes this
  ↓ (no row, or a row that cannot be parsed)
OFFICE_OD_SETTINGS[x].hygOdEnabled   ← the floor, and it stays false
```

One `platform_setting` row holds every office as a jsonb map,
`{"roland": true, "valley": false}`. One row rather than a key per office
because it is a single atomic write (a change touching two offices cannot
half-apply), a single audit target, and a single read on a path that runs on
every `/api/hyg` request.

Things worth knowing before you debug this:

- **A row that exists answers for every office.** Once the row is present and
  usable, an office ABSENT from it is `false` — not "unset", not "inherit". The
  stored row is consulted only when nothing in the environment has already
  killed the office, which is exactly `config/retention.js`'s `days: null`
  behaviour generalised to a map, with a one-way gate in front of it.
- **The env override only ever turns an office OFF.** `HYG_OD_ENABLED_ROLAND=false`
  holds roland off whatever the stored row says — it NARROWS, the same way
  `hygOdBlockReason()` narrows `odBlockReason()`. `=true` is accepted as input
  and cannot enable anything; it is logged once at boot and shown on the console
  as inert, because a variable that quietly does nothing is its own incident.
  Break-glass exists for *the console is unreachable and I need to kill this*,
  and there is no incident whose correct response is turning a module ON while
  the control plane is down. That also means a stale `=true` left over from an
  earlier incident cannot re-open an office somebody deliberately shut, not even
  on a boot where the control DB is unreachable and nothing is cached.
- **The floor stays `false`.** It is the bottom of the chain, not a
  configuration point. Flipping it would put the OFF direction behind a deploy
  again, which is the whole thing this replaced.
- **One bad entry does not poison the map.** An unknown office key or a
  non-boolean value is dropped, loudly, and the rest of the row still applies.
- **Read once and then unreachable ⇒ keep using what we read.** A database blip
  must not switch a practice's chairside screen off mid-morning any more than it
  should switch one on. Never read at all ⇒ every office off.

### It can only narrow

`hygOdBlockReason()` asks `odBlockReason()` FIRST and only then consults the
switch, so there is no value of the setting that reaches an office the voice
module could not. An office with no customer key stays refused with the VOICE
path's own code no matter what this says. `backend/config/hygPilot.test.js` pins
both directions.

### OFF is instant

`maxReplicas` is 1, so the console write and the request path are the same
process: `persistHygEnabled` refreshes the module cache inline, and
`hygOdBlockReason()` reads it synchronously. The next `/api/hyg` request is
refused. `backend/routes/hygPilotSwitch.test.js` walks
`ON → 200 → OFF → 409` in one process with **no restart, no sleep and no cache
reset** between the steps. If that test ever needs one of those, the switch has
stopped being a kill switch.

---

## 9. The pilot runbook

### Before you start

Confirm on the **Platform → Practices** tab that the practice is entitled to
`hyg`. That is a different axis from the switch and both must be on; the Hygiene
tab shows the entitlement read-only beside each office for exactly this reason.

### Enabling Roland on STAGING

1. Sign in to staging as a platform administrator.
2. **Platform → Practices → CareIN Dental → Modules**: turn `hyg` on.
3. **Platform → Hygiene**: flip **Roland Family Dental** on and read the
   confirmation. It says what starts happening: hygienists begin reading real
   patient data from that practice's Open Dental, and the morning warm begins
   running against it.
4. The row under the office should now read `db` and *"Turned on by <you> on
   <today>"*. If it still reads `default` or `env`, the write did not take —
   the panel is rendering the database, not your click.
5. Open `/hyg/day` and confirm the day loads against the real schedule.

### What to watch, over several mornings

| Signal | Where | What good looks like |
| --- | --- | --- |
| the warm ran | container log, `[hygwarm]` | one line per office per morning at ~07:45 Central: `office=roland date=… patients=N od_reads=N ms=…`. `patients` should match the day's headcount. |
| the day view is fast | `[hygday]` line, or `stats` in the response | `od_patient=0` and `ms` in the low thousands for a load inside the warm's window; a cold load is one second per patient (§7). |
| the schedule is right | the screen, against the practice's own day | every appointment present, names correct, no `truncated` banner. |
| Open Dental is healthy | `[odhealth]` transitions, Platform → practice health | no `roland up→down` lines. A down office makes the day view refuse honestly, not show an empty day. |
| nothing is being written | — | there is no OD write path in this module at all (`hygNoOdWrites.test.js`). If you see a chart change, it did not come from here. |

**Good enough for prod** is: three consecutive mornings where the warm ran
cleanly for Roland, the day view matched the real schedule, no `[odhealth]`
transition coincided with a hygiene complaint, and the hygienist did not report
a name or a flag that disagreed with Open Dental.

**Note the honest gap:** a same-day add-on booked after the warm is a cold read
and will be slower. That is correct behaviour, not a fault.

### Turning it off fast

**Platform → Hygiene → toggle the office off.** No confirmation dialog, no
deploy, no restart. It is in force for the very next request; a hygienist
mid-page gets a refusal on their next action, not an empty day.

If the console itself is unreachable, the break-glass path is the app setting:
set `HYG_OD_ENABLED_ROLAND=false` and restart the container. It holds the office
off from that moment on, whatever the stored row says and whether or not the
control plane comes back — so **remember to clear it afterwards**, or the
console's own switch will not be able to turn that office back on. The panel
says so on the office's row while the variable is set.

There is no matching way in. `HYG_OD_ENABLED_ROLAND=true` cannot turn an office
on; the only way in is the console. That is deliberate — the fast,
always-available path is the safe direction, which is the same reason turning
off needs no confirmation and turning on does.

### Enabling prod

Same five steps, on prod, after the staging soak. Nothing about the switch is
environment-specific; the only difference is that prod's Roland is a live
practice and the confirmation dialog means what it says.

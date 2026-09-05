# Hyg — the Day View gets a hygiene lens

Branch `feature/hyg-day-hygiene-lens`, off `origin/develop` (`50262c7`, which is
#148 merged). Beau's three pieces of feedback from the first real schedule, plus
the one read-scope change, and nothing else.

The module is still DARK — no tenant entitled, no office switched on.

---

## Acceptance criteria

| # | | Evidence |
| --- | --- | --- |
| 1 | A hygiene appointment in a NON-hygiene operatory renders under the lens | `hygDayScope.test.js` — "A HYGIENE APPOINTMENT IN A DOCTOR'S CHAIR IS STILL SERVED"; `hyg-day-lens.test.tsx` — the same, on screen; screenshot `01-list` |
| 2 | Hidden-by-lens count honest; empty-vs-error still distinct in list view | "the lens serves hygiene and unclassified, and reports what it did not"; "an empty hygiene day says it loaded, and says the lens is why" |
| 3 | `scope=hygiene` audits exactly the patients it serves | "the lens pays for the hygiene patients ONLY, and discloses only those" — asserts the `/patients/` calls AND the audit rows |
| 4 | Default fan-out ≤ distinct hygiene patients; full day pays its own cost | arithmetic below |
| 5 | The warm warms the default scope | `hygDayWarm.test.js` — "the warm warms the DEFAULT SCOPE" |
| 6 | `tsc --noEmit` clean, no `any`; green on 4 shards | below |

### 9 — gates

- `node --check server.js` OK
- `node scripts/shard-runner.mjs` — **4 shards green · 2336 tests · 2333 pass · 0 fail · 3 skipped** (develop: 2328)
- `pnpm run check` clean, no `any`
- `pnpm run test` — **1349 passed, 82 skipped, 0 failed** (develop: 1340)

---

## The shape I chose: `scope=hygiene|all` on the day route

`GET /api/hyg/day?office=&date=&scope=hygiene|all`, **defaulting to
`hygiene`**. The scope decides which appointments are SERVED, and therefore
which patients are fetched, named, sent and audited.

An out-of-scope appointment is not returned at all — no PatNum, no name, no row.
The alternative (return it, unnamed) would have meant the payload carrying
PatNums for patients nobody disclosed, and `patientNamesTruncated` quietly
changing meaning to cover them. `excludedByScope` carries the count instead, so
the screen can still be honest about what it is hiding.

An unrecognised scope is a **400**, not a fallback: the two values differ by how
many patients are disclosed, and guessing which one a caller meant is not a
decision the route may make.

### THE FILTER IS THE APPOINTMENT'S OWN `IsHygiene`

Never the chair's. A hygiene appointment can sit in a doctor's operatory on an
overflow day, and `HygAppointment` carries both flags precisely so that is
expressible (H0 §5). Filtering on the chair loses that patient — silently, on
the busiest day, for the appointment most likely to be an overflow. It is the
first test in `hygDayScope.test.js` and the first in `hyg-day-lens.test.tsx`.

**An appointment whose `IsHygiene` is NULL is SERVED.** "Open Dental did not
tell us" is not "no", and hiding an unclassified visit is the same silent loss
with an extra step. It costs one patient read on a day that has one.

---

## The arithmetic

Measured through the real `readDay` and the real instrumentation from #145, on a
**synthetic day shaped like a real one** — 20 appointments: 12 hygiene across
the hygiene chairs, 8 in the doctors':

```
scope     served   hidden   od_list   od_patient   TOTAL
hygiene      12        8        4          12        16
all          20        0        4          20        24
```

**8 requests saved on a 20-appointment day — a third of the cost.** Open Dental
throttles at one request per second per credential and that credential is shared
with the voice and RCM modules, so those 8 requests are ~8 seconds of a slot
somebody else is queuing for.

The list reads (4) are unchanged: the schedule, the operatories, the type labels
and the provider labels come down whole regardless. Only the identity fan-out
narrows, which is the part that scales with the size of the day.

**Show full day is a second request** and pays the difference at the moment
somebody asks — the rare path, as the brief allows. On a day already loaded
under the lens, the 12 hygiene patients are in the #145 cache, so the second
request typically costs the 8 doctors' reads rather than all 20.

**The warm warms the default scope**: the same `IsHygiene !== false` filter, for
the same reason. Warming the doctors' patients would spend the credential before
the practice opens on records the default screen never asks for, and the cache
is short-lived enough that they would likely expire unused.

---

## The three display changes

**1. The list is the default.** Time-ordered, one card per row, the chair beside
the card rather than above a column. The paper routing slip is a list and a
hygienist reads her day forwards in time. An appointment with no start time
sorts LAST rather than being floated to 8am — a visit whose time Open Dental
would not give us is still a visit somebody is coming to, and putting it first
would be a guess printed as a fact.

**The chair grid is not gone**, one tap away under "Chairs". It is genuinely
better for seeing two chairs running in parallel, and `groupByOperatory` already
only draws chairs that HAVE appointments — so under the lens the doctors'
columns disappear on their own, and Dr Farmer's column appears when a hygiene
appointment is parked in it.

**2. The hidden count.** Same quiet tone as the existing `excludedByStatus`
line, and a separate sentence because they are different facts: one counts rows
that are not visits at all, the other counts visits this lens did not serve.

**3. The hygienist picker.** Over the day's own provider names. **Display-only,
and it has to be** — Open Dental has no provider filter on `/appointments`, so
the whole day comes down in one paged pull whatever the picker says (H0 §5).
There is nothing to push it into, and the report would rather say that than
imply a saving that does not exist.

**An appointment with no provider name is never hidden by the picker.** Filtering
it out would mean a patient disappears because Open Dental did not label their
visit — the same silent loss the lens is careful about one level up.

**Three empty states stay three different things:** nobody booked
(`hyg-day-empty`), nobody booked with a hygienist (the empty panel PLUS the lens
notice explaining it), and the picker filtered everything out
(`hyg-day-filtered-empty`, which names the person picked).

---

## What persists, and where

The view, the lens and the picker live in `localStorage` under
`hyg.day.prefs.v1`, per browser. They are conveniences: nobody's chart, audit
trail or other device depends on how a hygienist likes to read her day. Every
read is wrapped in try/catch — a private window, cleared site data or a browser
set to block storage all throw rather than returning null.

---

## Screenshots

`docs/screenshots/hyg/hyg-lens-*`, light and dark, 1180 × 820.

| | |
| --- | --- |
| `01-list` | **the one that matters** — the list default, the hidden-count line, and Mango, Lee at 10:30 sitting in **Dr Farmer's** chair |
| `02-full-day` | the toggle on; the doctors' appointments are back and the notice is gone |
| `03-picker` | filtered to one hygienist |
| `04-grid` | the chair grid, still one tap away |

`hyg-01-day-populated` was re-taken: "a populated day" now means the list,
because that is what a hygienist sees when she opens the app.

---

## Deviations and things worth knowing

**1. `excludedByScope` is a required field on the wire.** A payload without it
is a backend that predates the lens, and the client's zod parse refuses rather
than letting a screen assume "all". That is a breaking change for any client
older than this deploy — there is none, since the dashboard ships with the
backend.

**2. The scope is not remembered server-side.** Reloading the page re-reads the
preference from this browser and asks again. A server-side preference would be
a new table and a new thing to keep in step for a choice that costs one request
to change.

**3. The picker resets when the lens widens.** Turning on "Show full day" clears
the provider filter, because the provider list is about to change and leaving a
stale name selected would silently hide most of the day somebody just asked to
see.

**4. What I did NOT build:** no per-chair filter (the lens covers the case), no
multi-select on the picker (one hygienist is the question being asked), and no
change to the grid's sort. No migration, no new table, no OD write changes —
`hygNoOdWrites.test.js` is untouched and green.

**5. TC and RCM untouched**, `backend/platform/` untouched:

```
$ git diff --stat origin/develop -- backend/routes/tc backend/routes/rcm \
    backend/services/rcm backend/services/tc backend/platform \
    new-dashboard/client/src/pages/rcm new-dashboard/client/src/pages/tc
(empty)
```

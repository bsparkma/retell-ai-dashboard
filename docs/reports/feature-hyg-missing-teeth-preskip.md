# Item 27 — missing teeth pre-skip themselves

`feature/hyg-missing-teeth-preskip` → `develop`. Reads only. No migration.
`backend/services/hyg/odPerioWriter.js` untouched.

This is item 18 part 2, built on the probe output rather than on Open Dental's
documentation. Item 18 shipped the grid parity and deliberately stopped at this
feature, because two of the four facts below are not in the docs and getting
either of them wrong fails silently.

---

## 1. The measurement this was built to

The probe `backend/scripts/probe-hyg-tooth-initials.js` — committed unrun by
#211 — ran on **2026-10-01** against the staging container
(`ca-carein-backend` / `rg-carein-staging`, revision `--0000206`, image
`a585f3c`, roland, designated test patients only). The full capture is
`new-dashboard/tests/fixtures/od-toothinitials-measured.json`. The four facts,
quoted, and what each one is load-bearing for:

### 1.1 Absence is `200` + `[]`

```
GET /toothinitials?PatNum=12827   →  ok=true  status=200  body=array(0)
```

Like `/perioexams`, **not** like `/procedurelogs/GroupNotes?PatNum=`, which
answers a 404 with a sentence (item 21). This is the fact the whole feature rests
on: "this patient has no missing teeth" and "Open Dental could not be read" have
to be told apart, and reading either as the other fails **silently** — one
pre-skips nothing forever, the other claims teeth are absent on a failed read.

Because the two are distinguishable at the transport level, no recogniser like
`isNoGroupNotesAnswer` exists on this surface and none should be added. An empty
array is an answer; only a non-ok response is `unavailable`.

### 1.2 `ToothNum` is a **string**

```
PatNum=12828  →  five Missing rows, ToothNum  "1", "16", "9", "32", "17"
                 typeof string, all five — and NOT in tooth order
```

So the reader **parses** and never `===`-compares a tooth to a number. Open
Dental also stores primary teeth as letters A–T in this same column, so any value
that does not parse to an integer 1–32 is **ignored, not treated as an error** —
a child's chart is not a failed read, and v1 charts permanent dentition only.
`"12B"` must not read as 12; `permanentToothNum` accepts whole digits only.

### 1.3 `InitialType` observed value: `Missing`

Exact case. Only `InitialType === 'Missing'` pre-skips. The other documented
types — `Hidden`, `Primary`, `ShiftM`, `ShiftO`, `ShiftB`, `Rotate`, `TipM`,
`TipB` — every one describes a tooth that **is** in the mouth and **does** get
probed. A rotated tooth that opened pre-skipped would be a reading quietly not
taken, which is the failure mode a perio chart already has too much of.

### 1.4 🔴 Unfiltered, this endpoint is the whole practice

```
GET /toothinitials  (no params)  →  100 rows across 28 distinct PatNums
```

Same hazard class as `/periomeasures/{id}` returning every row (items 16/17/19)
and the RCM spikes' list endpoints that silently ignore a filter they do not
recognise. Two defences, not one:

1. `PatNum=` is **always** passed. There is no code path in this slice that calls
   `/toothinitials` without it, and a missing or unusable PatNum spends no
   request at all.
2. Every returned row is checked against the patient asked about, and a row whose
   own `PatNum` differs — or which does not say — is **dropped**. The filter was
   honoured in the probe; this is for the day it is not. Dropped rows are
   **counted** and warned about once, never logged individually, and the warning
   carries the count and not the foreign PatNums.

---

## 2. What was built

| File | |
|---|---|
| `backend/services/hyg/odToothInitials.js` | **new.** The reader. `readMissingTeeth(odGet, { patNum })` → `ready` with teeth, or `unavailable`. Read-only by construction: `odGet` is the only way out. |
| `backend/routes/hyg/visit.js` | `GET /:aptNum/perio/prior` carries `preSkip`; `GET /:aptNum/perio` carries `chartStored`. |
| `new-dashboard/shared/hyg/perio.ts` | `PerioPreSkipSchema` (2-state union), `preSkip` on the prior response, `chartStored` on the chart response. Both `.default()`ed. |
| `new-dashboard/client/src/pages/hyg/HygPerio.tsx` | the apply-once effect and the one-line notice. |
| `new-dashboard/tests/fixtures/od-toothinitials-measured.json` | **new.** The capture. |

### 2.1 The server states a fact; the client decides

The route reports **which teeth Open Dental records as Missing** and nothing
more. It does not alter a chart and it does not decide whether the pre-skip
applies. That decision lives on the client because that is the side that knows
what she has done to the chart.

### 2.2 The gate is `chartStored`, and `counts.empty` would have been a bug

A pre-skip applies only to a chart that has **never been stored** for this visit.
The obvious predicate — "the chart is empty" — is wrong, and the case that breaks
it is ordinary:

> She opens a chart. CareIN pre-skips #19. She un-skips it, because it is an
> implant and implants get probed. She is called away before typing a number.

The chart is now empty again. On `counts.empty`, the next open re-skips #19 —
CareIN overruling the only decision she made, every time she comes back. So the
gate is whether a chart row exists, which it does the moment anything is saved,
including an empty chart. `chartStored` is that fact, and
`hygPerioPreSkip.test.js` pins the pair that proves they are different questions:
a chart that is **empty and stored**.

### 2.3 The pre-skip does not save itself

`preSkipBaseline` holds the chart the pre-skip produced, and the debounced
autosave stands down while the chart still equals it.

The reason is that **saving a visit that has not been started starts it**:
`save()` calls `openVisit` first. A pre-skip that persisted itself would open a
visit and file a draft perio chart for every patient whose chart she merely
glanced at — a write CareIN performed on its own initiative, visible on
worklists, for a visit that never happened. Nothing is lost by waiting: her first
real reading or un-skip moves the chart off the baseline and saves all of it,
pre-skips included, which `her first reading saves the pre-skips along with it`
asserts.

**It suppresses the autosave only**, and a defect found reviewing this slice is
why that distinction is spelled out. The first version moved `lastSaved` to the
pre-skipped chart instead. That suppressed the autosave as intended, but
`lastSaved` is also what `save()` compares against — so `save()` became a no-op
too. Because a skipped tooth makes `counts.empty` false, the **Stage** button is
live on a chart holding nothing but the pre-skip, and `onStage` saves before it
stages precisely because the stage composes from what is **stored**. The
pre-skip-only path would therefore have asked the server to stage a chart it had
never been sent. `lastSaved` now goes on meaning what the server last answered
with, and
`STAGING a pre-skip-only chart stores it FIRST` pins it.

A related observation left alone deliberately: staging a chart of only skips
writes an exam with no readings to the chart of record. That was already
reachable by skipping a tooth by hand, review-then-send puts the preview in front
of her first, and narrowing the Stage guard is a change to existing behaviour
rather than part of this slice. Flagging rather than quietly changing it.

### 2.4 It says CareIN did it

Teeth struck through on a chart she has not touched are otherwise unexplained —
she is left to work out whether she did it, whether it came from the last exam,
or whether the grid is broken. One dashed line names the teeth, names the source,
and says it can be undone. It is deliberately **not** a warning and carries no
`role="alert"`: a correct default is not a problem to report.

The sentence is derived from the **live chart**, not from what the pre-skip did,
so un-skipping the implant drops it from the list and un-skipping them all
removes the line. A panel that went on claiming teeth were skipped after she
un-skipped them is the sort of small lie that teaches her to stop reading the
panels.

### 2.5 Fail-soft, and `200 []` is not a failure

A non-ok read, a non-list body, a throw, or no PatNum → `unavailable`: the chart
opens exactly as it does today, nothing pre-skipped, and **the screen says
nothing**. The `NOTE_PRECHECK_UNAVAILABLE` doctrine — a failed read is not
evidence that a patient has all thirty-two teeth, and it is not worth a banner
over a convenience.

`ready` with an empty `teeth` is a different thing wearing the same face: a real
answer that names no teeth. Same visible outcome, entirely different claim, and
`ACCEPTANCE 4c` asserts the two statuses differ rather than trusting that they do.

### 2.6 Audit

Matched to the drift precedent rather than invented: **naming teeth is the
disclosure, so naming teeth is what audits.** One `READ` row,
`resource_type: 'hyg_perio_missing_teeth'`, `resource_id` the appointment, office
set. `unavailable` and a `ready` answer with no teeth both write nothing, exactly
as drift's `matches` and `unknown` do. No `prior_state`: a pre-skip lands only on
a chart nobody has touched, so it replaces no decision anybody made, which is
what that column is for.

---

## 3. The request budget: +1, and 0 where it cannot be used

A chart open was two Open Dental requests, both inside `/perio/prior`
(`/perioexams`, then `/periomeasures` when there is an exam to read).

| chart open | before | after |
|---|---|---|
| fresh chart (pre-skip possible) | 2 | **3** |
| chart already stored | 2 | **2** |

`readMissingTeeth` makes **one** GET and deliberately does **not** page, which is
the only reason the added cost is exactly one: paging would spend a second
request on any patient whose first page came back full. The consequence is stated
rather than hidden — Open Dental caps a list at 100 rows, so a patient with more
than 100 tooth-initial rows is read short and the answer carries
`truncated: true`. Under-skipping is the safe direction: those teeth behave
exactly as they do today and she skips them herself. Nothing false is claimed.

And a visit that already holds a stored chart can never be pre-skipped, so it
does not spend the request at all. Both rows of that table are asserted against
the recorded request list (`ACCEPTANCE 6`, two tests), because a budget nobody
counts is a budget that grows.

---

## 4. Acceptance

| # | | where |
|---|---|---|
| 1 | Missing teeth are pre-skipped on a fresh chart, struck through by #211's rendering | `hyg-perio-page.test.tsx` "ACCEPTANCE 1", `hygPerioPreSkip.test.js` "ACCEPTANCE 1" |
| 2 | A pre-skipped tooth un-skips and takes readings | "ACCEPTANCE 2: a pre-skipped tooth can be un-skipped and then charted" |
| 3 | A chart with readings or manual skips is never re-skipped, on any open | three tests: readings, her own skip, and **empty-but-stored** |
| 4 | `200 []` pre-skips nothing with no error; a failed read is today's behaviour | `ACCEPTANCE 4a/4b/4c` (route) + two client tests |
| 5 | Letter ToothNum and wrong-PatNum rows ignored; one count-only warn | `ACCEPTANCE 5` ×2 (route), plus the reader's unit tests |
| 6 | Exactly one added OD request per chart open, asserted | `ACCEPTANCE 6` ×2 (fresh = +1, stored = +0) |
| 7 | The report quotes the probe facts, including the unfiltered hazard | §1, and §1.4 for the hazard |

Tests added: **18** reader unit tests, **15** route tests, **14** client tests.

---

## 5. Gates

Run on the tree CI tests — `refs/pull/<PR>/merge` — with the tree hash compared,
not assumed. See §7.

| gate | result |
|---|---|
| `node scripts/shard-runner.mjs` | 4/4 green, 2923 tests, 2920 pass, 0 fail, 3 skipped |
| `node --check server.js` | clean |
| `pnpm run check` | clean |
| `pnpm run test` | 2120 pass, 0 fail, 146 skipped |
| `HYG_SHOTS=1` perio shots | 19/19 |
| no `any` | none added |
| `odPerioWriter.js` | untouched |
| migrations | none added |

### 5.1 One existing test was edited, and why it is not a weakening

`routes/hyg/hygNoOdWrites.test.js` asserts that every Open Dental path the hyg
routes touch matches an **allow-list of read paths**, and that no write verb is
reached. `toothinitials` was added to that enumeration. The assertion the test
exists for — `od.writes` is empty — is untouched, and the new path is a GET on a
read-only surface. A test whose allow-list did not name the reads the routes
legitimately make would simply be a stale list.

The shot suite's mocks and the page suite's mocks were also updated. That is not
optional bookkeeping: item 14 added `drift` to this same response, fixed the page
suite's mock and not the shot suite's, and left `hyg-perio-shots.test.tsx`
**16-of-18 red on clean develop** for a fortnight — invisible, because the shot
suites are `skipIf(!HYG_SHOTS)` and CI never runs them. So this slice ran them,
and they are 19/19.

---

## 6. What this slice does not do

- **No new screenshot.** The acceptance table asks for the struck-through
  rendering to be pinned by a *test*, and it is. A shot of a pre-skipped chart
  would need its own fixture, and the shot suites are not in CI, so a photo is
  the weaker record of the two. The existing 19 shots are unchanged.
- **No staging exercise.** Nothing in this slice needed one: the measurement it
  rests on was already taken, and the behaviour is entirely in code paths that
  the fakes model field-by-field from that capture. The item-20 test-patient gate
  would apply if one were run.
- **Primary dentition is still out of scope.** A letter `ToothNum` is ignored, so
  a child's chart pre-skips nothing. v1 charts 32 permanent teeth; this does not
  change that, and it does not fail on it either.

---

## 7. Push, PR, and the merge tree

**PR #214**, `feature/hyg-missing-teeth-preskip` -> `develop`, tip `d0c7553`. Not merged.

A branch-local green is not a result: CI builds `refs/pull/N/merge`, not the
branch tip, which is how #207's red went undiagnosed for a round. So the trees
were compared rather than assumed, and they are the same object:

```
git rev-parse HEAD^{tree}                         3c697c2cb98c0ad068b1374950639927a124b6f8
git rev-parse refs/pull/214/merge^{tree}          3c697c2cb98c0ad068b1374950639927a124b6f8
git rev-list --count HEAD..origin/develop         0
```

Every gate in section 5 was run on that tree.

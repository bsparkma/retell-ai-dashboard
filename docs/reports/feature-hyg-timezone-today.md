# 09 — "Today" is a Central Time question

Branch `feature/hyg-timezone-today`, off `origin/develop` at `d4c916c`.
Worktree `C:\Users\beau\carein-wt\hyg-timezone-today`.

> **Branch is PUSHED. The PR is not** — auto mode refused `gh pr create`. Beau, paste:
>
> ```bash
> cd "C:/Users/beau/carein-wt/hyg-timezone-today"
> gh pr create --base develop --head feature/hyg-timezone-today \
>   --title "Resolve the hygiene day in the office's timezone, not the device's" \
>   --body-file docs/reports/feature-hyg-timezone-today.md
> ```
>
> (`gh pr edit` is broken repo-wide — to change the body afterwards use `gh api -X PATCH`.)

---

## Sighting 1: the failing test, named — and it is NOT a timezone bug

**`backend/routes/sendToTc.test.js`**, in the `staging-cd` run on `d4c916c`
(run 34293833778, **attempt 1**, 2026-09-09T00:10Z, job 102285998578).

It is the known Node 22 test-runner flake, and it matches the queue README's own
description of it on all three counts:

```
# Subtest: routes/sendToTc.test.js
not ok 12 - routes/sendToTc.test.js
  failureType: 'uncaughtException'
  error: 'Unable to deserialize cloned data due to invalid or unsupported version.'
  stack: |-
    #processRawBuffer (node:internal/test_runner/runner:354:20)
    FileTest.parseMessage (node:internal/test_runner/runner:290:27)
```

| The README's signature | This run |
| --- | --- |
| `Unable to deserialize cloned data` / `uncaughtException` | ✅ verbatim |
| NO assertion | ✅ no `expected`, no `actual`, stack is entirely node internals |
| DROPPED total test count | ✅ **573** reported vs **589** in the green attempt — 16 tests short |

Two further pieces of evidence:

- **The log is truncated mid-stream.** `# Subtest: every handoff category` prints *after*
  `[shard-runner] FAILED`, and the `# tests / # pass / # fail` summary never prints at all.
  The parent died deserializing the child's IPC buffer, so the TAP stream stops.
- **Attempt 2 on the byte-identical tree passed** (00:26Z, same SHA), which is the flake's
  defining behaviour.

**It cannot be a UTC-drift failure**, whatever the hour: `sendToTc.test.js` contains no
date, no clock and no `Date` at all. Its only match for /Date|today|TZ/ is
`unifiedCallStore.byDate.clear()`, a map reset.

**So nothing was fixed for sighting 1, and nothing should be.** The README's standing rule
for this signature is "re-run, do not chase it", which is exactly what happened. Widening an
assertion or adding a clock to that file would have been inventing a cause. The real fix is
the one already tracked: node #64061/#64706, fixed in v24.20 and v26.7, never backported to
Node 22 — sharding is a mitigation, not a cure.

## Sighting 2: the Day View — real, and not UTC either

The hypothesis in the brief was that the day route or the client default computed "today" in
UTC. It does not, and never did:

- **The day route has no default.** `date` is a required query param and a missing or
  unreal one is a 400 `INVALID_DATE` (`backend/routes/hyg/day.js:170`). The response
  **echoes** the date it was asked for.
- **`todayIso()` has used local parts since the first commit** of the module (`e80d76e`) —
  `git log -S "now.getFullYear()"` returns exactly that one commit. There is no UTC version
  in the history to have regressed from.
- A UTC bug would also have shown the **wrong direction**: in the Central evening UTC is
  already *tomorrow*, so it would have shown the 9th on the 8th. Beau saw the **7th**.

Two real defects do produce "yesterday, under today's heading", and both are fixed here.

### (a) The day was resolved in the DEVICE's zone, not the office's

`todayIso()` built the string from the browser's local parts. That is right on an iPad set
to Central and wrong on anything else, in both directions and only for a few hours a day —
which is the worst way for a date to be wrong, because nothing on screen looks broken. A
device **west** of Central shows *yesterday* after midnight; one **east** shows *tomorrow*
in the evening.

The office day is Central, always. `todayIso` now resolves in an explicit zone via
`Intl.DateTimeFormat("en-CA", { timeZone: OFFICE_TIME_ZONE })` — the same two decisions,
for the same two reasons, as `backend/services/localDayClock.js` (`en-CA` because it emits
`YYYY-MM-DD` natively; `Intl` because a fixed −5/−6 is wrong half the year).

`shiftIsoDate` had to change with it. It built a **device-local noon** and then formatted
that instant — which, once the formatter is office-zoned, means the stepper could skip or
repeat a day on a device far enough east or west. It is now pure UTC calendar arithmetic on
a string that carries no time and no zone, which also removes the DST hazard outright
rather than papering over it with noon.

### (b) The date was chosen once, at mount, on a device that is never closed

`useState(() => todayIso())` runs once. This module is built for an iPad propped at a chair
and that device is not shut down at night, so a page opened on Monday still shows **Monday**
on Tuesday morning, under Tuesday's own "Today" button, with every card linking into the
wrong day. This is the mechanism that produces the exact symptom Beau photographed.

`HygDay` now re-checks the office day on `visibilitychange`, on `focus`, and on a 60-second
interval. **All three are needed**: the events catch the app being picked up again, and the
interval catches the iPad that simply sat there awake all night — which fires no event and
is precisely the device this module was built for.

The decision itself is a pure function, `rollToNewDay`, and it **refuses to move a date the
hygienist stepped to herself**. Snatching back a day somebody deliberately chose would be a
worse bug than the one being closed.

## The audit (deliverable 2)

Every "today"/date-default in the module, and where it resolves:

| Site | Before | Now |
| --- | --- | --- |
| Day route default date | none — `date` required, 400s, response echoes | unchanged |
| Visit route date | none — required, 400s | unchanged |
| **Client day default** (`HygDay`) | device zone, mount-once | **office zone, re-checked** |
| **Client visit date** (`HygVisit`) | device zone | **office zone** (same helper) |
| **`shiftIsoDate` stepper** | device-local noon | **UTC calendar arithmetic** |
| Warm's date (`hygDayWarm.today`) | `localDayKey(OFFICE_TIMEZONE)` | unchanged — already correct |
| Note / slip / visit date | `visit.visitDate`, the stored request date | unchanged |

The backend has **exactly one** calendar-day derivation — `hygDayWarm.today()` — and it was
already right. Everything else that touches `Date` there is either a duration (`Date.now()`
deltas), an instant stamp (`new Date().toISOString()` for `at:`), or the `isRealDate`
round-trip validator, which builds `value + "T00:00:00Z"` and compares back in UTC on both
sides and so is zone-free by construction.

`localDayClock.js` lives in `backend/services/`, **not** in `backend/platform/`, so the
brief's stop-and-ask condition did not fire. It was not edited in any case.

### The one seam where the two sides could drift

The Day View needs the office's zone **before** it has asked the server anything — the
default date is needed at mount, not after the first fetch — so it cannot read
`OFFICE_TIMEZONE` and carries `OFFICE_TIME_ZONE` in the shared contract instead. That makes
it the only place client and server could disagree about which day it is, so it is asserted
rather than trusted: `hygDayWarm.test.js` now checks the constant equals
`hygWarm.DEFAULT_TIMEZONE`, that it is a zone `Intl` accepts, and that the two
implementations return the **same answer** at five instants around both DST boundaries.

## Tests (deliverable 3): every clock is stated, and every fix is negative-checked

All date tests now name their instant as a `Z` literal. `new Date(2026, 8, 8, 19)` — the old
form — means a *different instant* depending on where it runs, which is the same class of
bug as the one being fixed.

**A caveat worth recording: `TZ=... <cmd>` is inert on Windows.** Node ignores it at process
start, so a suite "run under UTC" on this machine is quietly still Central and proves
nothing — my first three-timezone run was a false green, and the negative check below is
what caught it. Assigning `process.env.TZ` at *runtime* does work, and that is how the
discriminating test moves the device.

Each fix was verified by reverting it and confirming the tests go red:

| Reverted | Result |
| --- | --- |
| `todayIso` → device-local parts | `ignores the DEVICE's zone entirely` fails: `UTC: expected '2026-09-09' to be '2026-09-08'` |
| roll-over effect removed | `moves a page that was sitting on what USED to be today` fails: `expected '2026-09-08' to be '2026-09-09'` |
| signature dedupe removed | 3 rider tests fail |

The Day View tests mock the day route to **echo** the date it was asked for, exactly as the
real one does, so the heading is the page's own request rendered back rather than a fixture
asserting itself.

## Rider: one person, one line in the signature block

When the note's author is also one of the office's supervising doctors, the block printed
them twice — the bare session name as the author line, then again three lines down with
credential and licence. Fixed in `hygStaff.signatureBlock`: an author who matches a doctor
(on the same case- and space-insensitive normalisation the roster already uses) is printed
**once**, as the doctor line, and omitted from the list below. Best information wins.

```
Beau Sparkman              →   Beau Sparkman DDS #6347
Beau Sparkman DDS #6347        Blain VanNice DDS #7971
Blain VanNice DDS #7971        Joe Farmer DDS #7571
Joe Farmer DDS #7571
```

A hygienist author is unchanged — she is not in the doctor list, so nothing is removed and
every doctor still appears. Both directions are tested, plus a general test that no name
appears twice in *any* block the config can produce, for every author it knows.

Nothing else about the block changed. It is still unsigned.

## Gates

| | |
| --- | --- |
| `node scripts/shard-runner.mjs` | ✅ 4/4 green — 2399 tests, 0 fail |
| …with the process zone forced to **UTC** | ✅ 4/4 green, same counts |
| `node --check server.js` | ✅ |
| `pnpm run check` | ✅ clean, no `any` |
| `pnpm run test` | ✅ 1401 pass, 0 fail |
| …with the process zone forced to **UTC** | ✅ same |
| …with the process zone forced to **Asia/Tokyo** | ✅ same |
| `hyg-contract-bundle.test.ts` | ✅ `contract.gen.cjs` regenerated with the pinned esbuild |

**Every one of those runs happened inside the failing window.** The wall clock during this
session was `2026-09-09T02:49Z` — 21:49 Central on the 8th — so UTC's date was already
tomorrow's for the whole of it. That is the condition the brief asked for, and it was live
rather than simulated.

Screenshot: `docs/screenshots/hyg/hyg-tz-01-evening-central-1180x820-{light,dark}.png` — the
Day View with the clock frozen at 01:00 UTC (8pm Central on the 8th), heading
**"Tuesday, September 8"**. This slice changes no layout, colour, control or copy; the
heading is the only place the fix is visible, which is why the shot exists.

## Scope

No OD writes touched. TC, RCM and `backend/platform/` untouched. No UI redesign and no new
features: the visible surface gains nothing, and `data-testid="hyg-day-heading"` is the only
markup change.

## Files

Changed: `new-dashboard/shared/hyg/contract.ts` (`OFFICE_TIME_ZONE`),
`client/src/features/hyg/day.ts` (`todayIso`, `shiftIsoDate`, `rollToNewDay`),
`client/src/pages/hyg/HygDay.tsx` (roll-over effect, heading testid),
`backend/config/hygStaff.js` (rider), `backend/hyg/contract.gen.cjs` (regenerated),
and three test files.

New: `new-dashboard/tests/hyg-day-rollover.test.tsx`,
`new-dashboard/tests/hyg-tz-shots.test.tsx`, two screenshots.

## For the PM

Sighting 1 needs no code change, but it is worth deciding what to do about the flake itself
— it has now cost a red develop push twice. The options are a Node bump (24.20+ carries the
real fix) or `--test-concurrency=1` at the runner level; both are outside this slice.

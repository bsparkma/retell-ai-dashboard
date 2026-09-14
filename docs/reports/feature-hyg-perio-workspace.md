# 10 — Perio chart workspace: read, display, stage. NOTHING SENDS.

Branch `feature/hyg-perio-workspace`, off `origin/develop` at `4738e55`.
Worktree `C:\Users\beau\carein-wt\hyg-perio-workspace`.

> PUSH/PR STATUS is at the bottom of this file (§9), filled in after the push attempt.

---

## 1. Acceptance

| # | Criterion | Where it is proven | Result |
|---|---|---|---|
| 1 | A full 32-tooth chart is enterable with keyboard only, in charting order | `new-dashboard/tests/hyg-perio.test.ts` → *fills all 32 teeth from the keyboard alone, in charting order* (the reducer, no DOM) **and** `tests/hyg-perio-page.test.tsx` → *takes a full 32-tooth chart from the keyboard alone…* (192 `keyDown`s on the focused grid; asserts every site of the PUT body against the charting order) | ✅ |
| 2 | Prior exam renders beside entry; absent prior is honest | `hyg-perio-page.test.tsx` → *says it is reading…*, *draws NO prior exam as an honest empty — no old numbers anywhere*, *draws an Open Dental outage as UNAVAILABLE…*, *draws a FOUND exam under each site…*, *draws a refusal about the appointment as its own thing*; screenshots 01, 03, 04 | ✅ |
| 3 | Partial chart stages and is labelled partial | `backend/routes/hyg/hygPerio.test.js` → *a PARTIAL chart stages, and says it is partial…*; `hyg-perio-page.test.tsx` → *labels a partial chart partial, stores it, and only then stages it*; rehearsal check *a partial chart stages from its stored draft, labelled partial*; screenshot 02 | ✅ |
| 4 | Zero-OD-write proof test for everything this slice adds | `backend/routes/hyg/hygNoOdWrites.test.js` §3 — four new tests (below) | ✅ |
| 5 | Paging past 100 measure rows proven by test | `backend/services/hyg/odPerio.test.js` → *a full exam is 128 rows, and BOTH pages are read*, *exactly 100 rows is NOT the end of the list*, *a measure page that fails after the first is FOUND but TRUNCATED*; and the behavioural no-write test drives a 128-row exam through the real route | ✅ |

## 2. Gates

| Gate | Result |
|---|---|
| `node --check server.js` | clean |
| `node scripts/shard-runner.mjs` | **4/4 green** — 658 + 530 + 640 + 617 = **2445 tests, 2442 pass, 0 fail, 3 skipped** |
| `pnpm run check` | clean |
| `pnpm run test` | **107 files passed, 19 skipped; 1707 tests passed, 110 skipped** |
| `tests/hyg-contract-bundle.test.ts` | green after regenerating `backend/hyg/contract.gen.cjs` with the pinned esbuild + `--alias:zod` |
| Real Postgres 16, as `carein_app` (`scripts/rehearse-hyg-visit.js`) | **31/31** — 8 new perio checks (§5) |

Local-environment note, not a code finding: the first backend run used a junction to another
checkout's `node_modules`, which lacks `pdf-parse` (a declared, lockfiled dependency), so
`sendUnits.test.js` failed with `MODULE_NOT_FOUND`. Replaced with a real `npm ci`; green.

---

## 3. What was built

### Storage: the visit's `perio` staged-write row. No migration.

`hyg_staged_write` already had a `perio` kind, a `Draft` state nothing used, a jsonb `payload`
and `UNIQUE (visit_id, kind)`. The chart is that row:

```
PUT  /visit/:aptNum/perio                      → row in Draft, payload.chart
POST /visit/:aptNum/staged-writes {kind:perio} → composed FROM payload.chart → Staged
DELETE /visit/:aptNum/staged-writes/perio      → back to Draft, readings KEPT
```

- **Not a slip field.** The slip is saved whole on its own debounce by a different form; two
  forms replacing one jsonb document erase each other's last seconds of typing.
- **A changed reading un-stages a staged chart** (preview cleared, row → Draft). A save that
  changes no reading — repeated debounce, flipped entry direction — leaves it Staged.
- **Un-staging keeps the readings.** Other kinds are deleted on un-stage because they are
  recomposed from the visit; a perio chart IS its row, and deleting it would throw away up to 192
  readings to answer "not yet".
- **`.default()` discipline:** the chart's `sweep` field defaults, so a chart stored without one
  still parses (pinned: *still parses a stored chart that predates the sweep field*).

### Routes — all three in `routes/hyg/visit.js`

| Route | Reaches | Audit |
|---|---|---|
| `GET /visit/:aptNum/perio` | Postgres only | `hyg_perio` + `hyg_perio_patient` (PatNum) when a visit exists; nothing when none |
| `PUT /visit/:aptNum/perio` | Postgres only | `hyg_perio` UPDATE |
| `GET /visit/:aptNum/perio/prior?date=` | Open Dental, **GETs only** | `hyg_perio_prior` + `hyg_perio_prior_patient`, fail-closed, before the body |

In `visit.js` because the mutation allow-list in `hygNoOdWrites.test.js` names ONE file — the
same reason the send lives there. `hygVisitGuard.test.js`'s mutation list grew the PUT, so the
read-only-role / not-entitled / anonymous / no-office refusals cover it.

The chart and the prior exam are **separate requests** on purpose: the grid paints from Postgres
while two paged Open Dental reads are still running on a shared credential.

`PATIENT_CHANGED` (409): if the appointment now belongs to a different PatNum than the visit the
chart was entered on, the prior read refuses before reading any history.

### The prior exam — `services/hyg/odPerio.js` (read-only)

- `GET /perioexams?PatNum=` → newest by `ExamDate`, then `PerioExamNum`; `0001-01-01` sorts last.
- `GET /periomeasures?PerioExamNum=` → Probing, BleedSupPlaqCalc, SkipTooth mapped; GingMargin,
  Mobility, Furcation, MGJ read and ignored (locked scope). `-1` → `null`, never `0`.
- **Both paged** through the existing `odDay.pagedList`, which asks until a page is SHORT.
- **Every row checked against what was asked for.** An exam row is kept only if its own `PatNum`
  matches, a measure row only if its own `PerioExamNum` does — RCM found list filters Open Dental
  silently ignores, and here that failure would draw another patient's pockets on this chart.
  Pinned: *an exam list that ignored ?PatNum= cannot put another patient beside this one*.
- Three-way answer: `found` (with `truncated` when a later page failed) / `none` / `unavailable`
  with Open Dental's own status line. The page adds loading and refused: five displays.
- `[hygperio] office=… apt=… prior=found|none|unavailable od_perio_reads=n ms=…` — no PatNum, no
  readings.

### The send refuses perio — `services/hyg/sendVisit.js`

A confirmation naming `perio` refuses the **whole batch** (`422 PERIO_SEND_NOT_BUILT`) before any
other check. Whole batch rather than "skip perio, send the rest": a confirm that named a chart and
quietly sent everything else would report a send nobody asked for. The tray also leaves a staged
chart out of Send and says so (`hyg-perio-not-sent`).

### Charting order — `new-dashboard/shared/hyg/perio.ts`

Bundled into the backend (`contract.entry.ts` exports it). Sites are walked in SCREEN order,
which is anatomical: distal-first on the patient's right (#1–#8, #25–#32), mesial-first on the
left. Default sweep is one continuous snake:

```
upper facial  #1 DB B MB … #8 DB B MB  #9 MB B DB … #16 MB B DB   →
upper lingual #16 DL L ML … #1 ML L DL                             ←
lower lingual #32 DL L ML … #17 ML L DL                            →
lower facial  #17 DB B MB … #32 MB B DB                            ←
```

Each sweep's direction can be flipped independently. `tests/hyg-perio.test.ts` pins the four
seams (`#16 DB`→`#16 DL`, `#1 DL`→`#32 DL`, `#17 DL`→`#17 DB`) and that flipping one sweep
reverses exactly that sweep.

### Entry — `features/hyg/perio/entry.ts` (pure reducer) + `pages/hyg/HygPerio.tsx`

`0–9` depth + advance · `Shift+0–9` = 10–19 (by physical key code) · `B S P C` flags · `X` skip
tooth · `→`/Space/Enter next · `←` back · Backspace takes back the last reading · Delete clears.
**A flag lands on the reading just entered** ("3, 2, 3 — bleeding"), otherwise on the cursor;
the page names the target site beside the flag buttons. A skipped tooth takes no reading; skipping
keeps its readings so an accidental `X` is one key to undo. A resumed chart starts at the first
open site. Saves are debounced, **serialized** (two PUTs cannot land out of order), and the page
only says "Saved" when the server's chart equals the screen's.

Missing teeth: **manual skip**, plus a one-tap "Skip #1, #16 like last time" when the prior exam
has SkipTooth rows. The OD chart's missing-tooth data was not used — H0 did not verify a cheap
read for it, and guessing one is not "cheaply readable".

---

## 4. Zero Open Dental writes — the proof (acceptance #4)

`backend/routes/hyg/hygNoOdWrites.test.js`, new §3:

1. **Behavioural** — *driving EVERY perio path to success reaches no Open Dental write verb*:
   open → PUT chart → GET chart → GET prior (a **128-row** exam across two pages) → stage perio →
   **send with a perio confirmation** (422), all against the harness client whose write verbs
   throw. Asserts `od.writes === []`, every call path is a known GET path, and the `Offset=100`
   page was actually read. Non-vacuous: each step must SUCCEED first.
2. **Source scan of the reader** — `odPerio.js` names no `apiWriteRaw`, has no write-shaped call
   on any receiver, and DOES reach `pagedList(odGet, '/perioexams'` and `'/periomeasures'`.
3. **Endpoint containment** — no non-test hyg file except `odPerio.js` names `/perioexams` or
   `/periomeasures` in code. `odWriter.js` (the one file that may write) does not know they exist.
4. **The scan would fail** — the same helper run over synthetic sources reports
   `od.client.post('/periomeasures', …)`, ignores `router.put(…)`, and ignores the same text inside
   a comment.

`OD_WRITE_LAYER` is unchanged (`['odWriter.js']`), and `odWriter.js` is untouched.

## 5. Real Postgres (8 new checks, 31/31)

`backend/scripts/rehearse-hyg-visit.js` §6c, as `carein_app` against migrated Postgres 16:

- chart stores as a Draft perio row; reads back through jsonb as the same canonical chart
- saving the same chart again is `changed: false` — **jsonb reorders keys**, and
  `normalizePerioChart` is what keeps that from looking like a change
- a partial chart stages labelled partial; a sweep-only change stays Staged; a changed reading
  goes back to Draft through the real `ON CONFLICT … DO UPDATE … WHERE`
- un-staging keeps all 85 readings
- **the race the pre-check cannot see**: a send claims the row between the store's SELECT and its
  INSERT (simulated by hiding the row from that one SELECT). Postgres's own conflict `WHERE`
  refuses, the row stays `Sending` with its readings. The fake could not have proven this.

The office-scoping guard (`hygVisitOffice.test.js`: every WHERE in the store names `office`) caught
my first version of that conflict clause; it now reads
`WHERE hyg_staged_write.office = EXCLUDED.office AND hyg_staged_write.state IN ('Draft','Staged')`.

## 6. Screenshots

`docs/screenshots/hyg/`, 1180 wide (iPad landscape), light and dark, from
`tests/hyg-perio-shots.test.tsx` through the unchanged `scripts/shoot-hyg.mjs`. Synthetic name,
fixture PatNum 12827.

| Shot | Shows |
|---|---|
| `hyg-perio-01-full-with-prior-1180x900-{light,dark}.png` | full chart (#1 and #16 skipped: "Full chart: 180 of 180 sites charted (2 teeth skipped)"), last exam's number under every site |
| `hyg-perio-02-partial-staged-1180x900-{light,dark}.png` | "Partial chart: 84 of 192 sites charted", Staged, the not-sent note |
| `hyg-perio-03-no-prior-1180x900-{light,dark}.png` | "No perio exam on file" — blank prior lines, not zeros |
| `hyg-perio-04-prior-unavailable-1180x900-{light,dark}.png` | "…could not be read… not the same as no history", status line, retry |
| `hyg-perio-05-tray-1180x1400-{light,dark}.png` | visit tray: perio Staged and left out of Send; Send counts the slip only |

## 7. Decisions worth a second look

1. **Touch targets.** Site cells are 44px tall but ~20px wide: 48 sites across 1180px cannot hold
   three 44px-wide targets per tooth without scrolling each arch sideways, which would hide the
   teeth being compared. Cells are for pointing at a site; the keypad under the grid (0–19, the
   four flags, back/next/undo/skip) is the touch entry path, all 44px. If Beau wants fat cells,
   the alternative is one arch (or one sweep) on screen at a time.
2. **"Most recent exam"** is the newest exam on file, including one dated today. After the send
   slice writes today's exam, re-opening the page would show today's own numbers underneath. The
   send slice may want "newest exam dated before this visit"; flagged rather than guessed.
3. **Flags on a site with no depth are allowed**, because Open Dental stores them in a separate
   row. They count toward "not empty" (the chart can stage) but not toward "sites charted".
4. **Entry direction travels with the chart** (so a resumed visit on another iPad walks the same
   way) and never un-stages it.

## 8. For slice 11 — a fact in H0 that changes its premise

Slice 11's brief says *"THERE IS NO BULK WRITE. A full chart = 60–100+ requests."* **H0 §2 says
otherwise for exactly this slice's locked scope.** `docs/HYG_SPIKE_H0_OD_COVERAGE.md` lines 112–118:

> **Bulk arch strings on `POST /perioexams`.** `UpperFacial`, `UpperLingual`, `LowerLingual`,
> `LowerFacial` accept a run-length string where digits `0-9` are probing depths and the letters
> `b`, `s`, `p`, `c` set bleeding / suppuration / plaque / calculus. One request charts probing +
> all four flags for a whole arch. **Limit: these strings encode probing and BleedSupPlaqCalc
> only.**

What is true: there is no bulk `POST /periomeasures`, and the 60–100+ figure is for a chart that
includes recession/mobility/furcation (H0 line 124). v1 is probing + the four flags — which is what
the arch strings carry. That is **docs-only in H0, never exercised**, and has sharp questions
(single-digit depths only? how 10–19 and SkipTooth are expressed? is the whole exam one atomic
request?) — but if it holds, a v1 chart is one POST, not a resumable 64-request queue, and the
failure model is very different. Worth a PM decision before 11 is built.

## 9. Push / PR

(filled in below)

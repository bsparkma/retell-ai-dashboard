# 18 — The perio grid reads like Open Dental's chart, and missing teeth skip themselves

Branch `feature/hyg-perio-od-layout`, off `origin/develop` at `bbe6b83` (after #210 merged).
Worktree `C:\Users\beau\carein-wt\hyg-perio-od-layout`. PUSH/PR STATUS is in §8.

> **Part 1 is delivered. Part 2 is NOT, and did not get as far as a line of code.**
> It is gated on one `GET /toothinitials?PatNum=` against staging that this session was
> not permitted to make. §2 says exactly what is blocked, what was established instead,
> and what unblocks it. No part of part 2 was built on the unverified surface.

---

## 1. Part 1 — layout parity ✅

### 1.1 Arch orientation was ALREADY right. Said, shown, not churned

The brief says: *"If the grid already does this, say so and show it; do not churn."* It does.

`new-dashboard/shared/hyg/perio.ts:72-73`, untouched by this slice:

```ts
export const PERIO_UPPER_TEETH = Array.from({ length: 16 }, (_, i) => i + 1);      // 1 → 16
export const PERIO_LOWER_TEETH = Array.from({ length: 16 }, (_, i) => 32 - i);     // 32 → 17
```

Patient's right on the screen's left, which is how Open Dental draws it. Within a tooth,
`screenSites` already put the distal site outermost (`#8` reads `DB B MB`, `#9` reads
`MB B DB`), and the row order already stacked facial over lingual so the two lingual rows
meet at the midline.

**What changed is that this is now pinned by tests rather than only by a comment.** Three
of the twelve new tests assert orientation and site order *against the rendered DOM*, and
they are worth having precisely because nothing looks broken when they go wrong — the grid
still looks like a grid, and the numbers land on the wrong teeth.

### 1.2 Quadrant boundaries — NEW

A rule down the grid at the midline, plus a caption naming each quadrant and its range:
`UR #1–8 | UL #9–16` above the upper arch, `LR #32–25 | LL #24–17` below the lower.

The halves come from `quadrantOf`, the app's one dentition function, **not** from a
hardcoded 8 — a grid that drew its own midline could disagree with the quadrant every
other screen names. `startsSecondHalf` asks `quadrantOf` where the break is.

### 1.3 Missing teeth drawn ABSENT, not empty — NEW

An un-charted site is already a faint `·` on a muted cell. A skipped tooth drawn the same
way would read as *"not done yet"* on a chart whose entire failure mode is understating
disease by being incomplete. So a skipped tooth now gets:

- a **filled** blank cell (`bg-muted/80`, an em dash) rather than the old dashed "skip" box;
- its **number greyed and struck through** in the numbers row;
- readings suppressed entirely, prior-exam numbers included.

The test asserts it is drawn *differently from an empty site*, not merely that it is drawn —
asserting its presence would have passed against the old dashed box too.

**It stays reachable.** `aria-label` reads *"#19 skipped — no readings. Select it to un-skip
and chart it."*, and clicking still moves the cursor there. That is a precondition for part
2: a pre-skip is a default, and an implant gets probed.

**A failed tooth still wins.** An incomplete send marking `#19!` is not hidden by the greyed
treatment — asserted.

### 1.4 Site labels

Each row carries Open Dental's own names for its three sites: `Facial / DB·B·MB`,
`Lingual / ML·L·DL`. It is the row's **site set** in OD's naming, not a left-to-right
promise — which of the three sits leftmost depends on the side of the mouth
(`screenSites`), and that is already correct and separately tested.

### 1.5 Screenshots

`docs/screenshots/hyg/hyg-perio-01b-od-layout-1180x900-{light,dark}.png` — a full chart with
`#1, #16, #17, #19, #32` missing, so greyed teeth sit beside charted neighbours in three
different quadrants. Both quadrant captions, both midline rules, struck-through numbers and
blanked cells are all visible.

**The other 18 perio screenshots were regenerated too**, because this change alters the grid
in every one of them; leaving them would have left the repo showing a layout the code no
longer produces.

### 1.6 ⚠️ A pre-existing break found and fixed on the way

`tests/hyg-perio-shots.test.tsx` was **16-of-18 red on clean `origin/develop`** before this
slice touched anything (verified by stashing). Its `fetchPerioPrior` mock returned no
`drift` field, so `HygPerio` read `prior.res.drift` as `undefined` and rendered nothing at
all.

**That was my own regression from item 14** (PR #207), which added `drift` to that response
and fixed the page suite's mock but not the shot suite's. Shots only run under `HYG_SHOTS=1`,
so CI never executed them and nothing caught it. Fixed here — the mock gains `drift`, with a
`not_applicable` default — and all 19 now pass.

Worth knowing generally: **a suite CI does not run is a suite that is already broken and has
not told you yet.**

## 2. Part 2 — missing teeth from Open Dental ❌ BLOCKED

### 2.1 What the brief asked for first, and what was found

> *"FIRST: verify the read surface against `docs/HYG_SPIKE_H0_OD_COVERAGE.md` (expected:
> tooth initials, InitialType = missing). If H0 marks it Docs-only, exercising a GET against
> staging is safe — do it, and record what it actually returns."*

**H0 does not mark it at all.** It covers `/perioexams` and `/periomeasures` and says nothing
about tooth initials; neither does `docs/OD_API_COVERAGE.md` or `docs/OD_API_CONTRACT.md`;
and the string `toothinitial` appears nowhere in the repo. The surface is not Docs-only in
H0 — it is **absent**.

So the vendor's own documentation was read instead
(`opendental.com/site/apitoothinitials.html`, 2026-09-30):

| | |
|---|---|
| Endpoint | `GET /toothinitials`, optional `?PatNum=` |
| Fields | `ToothInitialNum`, `PatNum`, `ToothNum`, `InitialType`, `Movement`, `DrawingSegment`, `ColorDraw`, `SecDateTEntry`, `SecDateTEdit`, `DrawText` |
| `InitialType` | `Missing` · `Hidden` · `Primary` · `ShiftM` · `ShiftO` · `ShiftB` · `Rotate` · `TipM` · `TipB` |

That matches the brief's expectation and makes the surface **Docs-only** — which, by the
brief's own rule, still requires the GET.

### 2.2 The GET could not be made

A read-only probe was written and run against staging; **the sandbox refused to execute it**
(it loads Key Vault secrets into a process). No workaround was attempted. The measurement is
therefore not in this report, and **acceptance 7 is not met.**

### 2.3 Why part 2 was not built anyway, on the documentation

Two unknowns that documentation cannot settle, both load-bearing:

1. **How absence is spelled.** Item 21 measured `/procedurelogs/GroupNotes?PatNum=` for a
   patient with none: **HTTP 404 with a sentence**. Item 14 measured `/perioexams?PatNum=`
   for the same question: **200 with `[]`**. Two sibling endpoints, two different answers.
   This feature's whole correctness rests on telling *"this patient has no missing teeth"*
   from *"Open Dental could not be read"* — the brief's own fail-soft rule. Guess it one way
   and the feature silently never fires; guess it the other and a failed read claims teeth
   are absent. That is the identical trap item 21 fell into, and the reason item 14 measured
   before building.

2. **`ToothNum`'s type.** Open Dental stores tooth numbers as strings and the same column
   carries primary letters A–T. The docs do not say whether this endpoint returns `"3"` or
   `3`, nor what it does with a primary tooth. A permanent-dentition chart must parse the
   first and ignore the second.

Building against a guessed shape produces tests that pass against my own fiction — exactly
what H0 warns about and what made every first-note send green in CI while failing on staging.

### 2.4 What unblocks it — one command

`backend/scripts/probe-hyg-tooth-initials.js` is committed: read-only (`apiGetRaw` is its
only client call), fixture-gated (refuses any PatNum that is not a designated test patient —
exercised, `11373` and an unknown office both return an empty list), and `require`-safe.

```bash
env HYG_PROBE_OFFICE=roland node scripts/probe-hyg-tooth-initials.js
```

It prints, per test patient: status, `error`, body shape, the full key set, `typeof ToothNum`,
the distinct `InitialType` values, and the rows — then asks the unfiltered question, because
RCM's spikes found OD list endpoints that silently ignore a filter and return the whole
practice (here that would pre-skip one patient's teeth on another's chart).

Its header states plainly that it has not been run.

### 2.5 Request budget, as far as it can be stated

Opening a perio chart today costs **two** Open Dental requests —
`GET /perioexams?PatNum=` then `GET /periomeasures?PerioExamNum=`, both inside
`GET /:aptNum/perio/prior` (item 14 folded its drift check into those two and added none).
Part 2's budget is **+1**, a single `GET /toothinitials?PatNum=` on the same chart-open
sequence, for **three**. Nothing in this branch changes the current count of two; the
"before" is measured, the "after" is the design, and the test asserting it is part of the
unbuilt work.

## 3. Hard rules

| Rule | Status |
|---|---|
| Reads only; no write path changes | ✅ `odPerioWriter.js` untouched; the only new backend file is a GET-only probe |
| `odPerioWriter.js` untouched | ✅ not in the diff |
| Test patients only for any staging exercise | ✅ no staging exercise happened; the probe refuses non-fixtures |
| Fakes model ABSENCE and failure | ⏸️ part of the unbuilt part 2 |
| Office+PatNum keyed | ⏸️ same |
| Contract regen if the contract moves | ✅ the contract did not move — no regen needed |
| No `any` | ✅ verified |
| `pnpm run check` clean | ✅ |
| shard-runner 4/4 green | ✅ |
| No tenant migration | ✅ none added, as expected |

## 4. Acceptance

| # | Criterion | Result |
|---|---|---|
| 1 | Arch orientation and site labels match OD; quadrant marks visible; screenshots light + dark | ✅ §1.1–1.5, 12 tests + 2 new PNGs |
| 2 | A patient with missing teeth opens pre-skipped | ❌ blocked, §2.2 |
| 3 | Pre-skipped teeth can be un-skipped and take readings | ⚠️ the grid-side precondition is built and tested (§1.3); the pre-skip itself is blocked |
| 4 | A chart with existing readings/skips is never altered by the read | ❌ blocked |
| 5 | Read failure = today's behaviour, no false claim | ❌ blocked |
| 6 | Exactly one added OD request per chart open, asserted | ❌ blocked; the "before" is measured (§2.5) |
| 7 | Report records the VERIFIED read surface | ❌ **not met** — documented surface recorded (§2.1), live answer not measured |

## 5. Files

| File | What |
|---|---|
| `new-dashboard/client/src/features/hyg/perio/PerioGrid.tsx` | quadrant rule + captions, OD site labels, skipped teeth drawn absent |
| `new-dashboard/tests/hyg-perio-od-layout.test.tsx` | **new** — 12 tests over orientation, quadrants, labels, missing teeth |
| `new-dashboard/tests/hyg-perio-shots.test.tsx` | the `drift` mock repaired (§1.6); the `01b` layout shot added |
| `docs/screenshots/hyg/hyg-perio-*` | the new layout pair, and the 18 existing perio shots regenerated |
| `backend/scripts/probe-hyg-tooth-initials.js` | **new** — the read-only, fixture-gated probe that unblocks part 2 |

## 6. Gates

Run on the merge tree — see §8 for the tree-hash confirmation.

| Gate | Result |
|---|---|
| `node --check server.js` | clean |
| `node scripts/shard-runner.mjs` | **4/4 green** — 2866 tests, 2863 pass, 0 fail, 3 skipped |
| `pnpm run check` (`tsc --noEmit`) | clean |
| `pnpm run test` (vitest) | 125 files, **2089 pass, 0 fail**, 139 skipped |
| `HYG_SHOTS=1 … hyg-perio-shots.test.tsx` | **19/19** (was 2/18 on develop — §1.6) |
| No `any` in the changed TypeScript | verified |

## 7. What I need from you

**Permission to run one read-only GET against staging**, or the output of running it
yourself:

```bash
cd backend && env HYG_PROBE_OFFICE=roland node scripts/probe-hyg-tooth-initials.js
```

With its output pasted into §2, part 2 is a short slice: a reader keyed on office + PatNum,
the pre-skip applied only to a chart with no readings and no manual skips, the fail-soft
path, and the five tests. Without it, part 2 would be built on a guess about how Open Dental
spells "this patient has none" — and this module has already been bitten by that guess twice.

## 8. PUSH / PR STATUS

Pushed to `origin/feature/hyg-perio-od-layout`. **PR #211** against `develop`. **Not merged**
— as instructed.

**The gates in §6 are merge-tree gates, confirmed by hash, not branch-local ones.**

```
git rev-parse HEAD^{tree}              64a72c2c3106926fcb2fe78d65d0e23448092583
git rev-parse pull/211/merge^{tree}    64a72c2c3106926fcb2fe78d65d0e23448092583
pull/211/merge   c557990 Merge 1d3e643 into bbe6b83
HEAD..origin/develop                   0 commits
```

They are equal because `origin/develop` has not moved since this branch was cut, so the
merge is a fast-forward and the two trees coincide. That is a FACT ABOUT RIGHT NOW, not a
property of the branch — #207 was green branch-local and red on its merge tree because
develop had gained six test files that re-partitioned every shard. If develop moves before
this merges, re-fetch `refs/pull/211/merge`, compare the hashes again, and re-run §6 on the
merge rather than trusting this line.

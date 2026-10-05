# Item 31 — drift notices the v2 rows too (26b)

Branch `feature/hyg-perio-v2-drift` → `develop`. **LANE: RED.** Not merged.
PR: **#221**.

## 1. What changed

Item 14's drift check re-reads a `Written` perio chart when it is opened and says
`changed` when Open Dental no longer holds what CareIN wrote. Item 26 added
recession (GingMargin), furcation and mobility to the send, and widened the
**read-back** to verify them. However, it filtered those three families out of
**drift** on purpose (`isDriftKind`, "26b"). As a result, a recession or mobility
edited in Open Dental after a send left CareIN saying the chart matched. This
item closes that gap.

| Area | Change |
| --- | --- |
| `shared/hyg/perio.ts` | `PerioSiteChangeKindSchema` = `depth, flags, skipped, gm, furcation, mobility`; `PerioSiteChangeSchema.kind` uses it |
| `shared/hyg/perioSend.ts` | `isDriftKind` → `isChangeKind`: only `duplicate` is dropped. `PERIO_CHANGE_KIND_LABEL` + `perioChangeLine` name the v2 family (`#3 B gingival margin: 2 mm recession → 3 mm recession`, `#30 mobility: grade 1 → grade 2`). **v1 lines are byte-identical** |
| `backend/services/hyg/odPerio.js` | `chartFromMeasures` already kept the v2 rows (item 26). New: it returns `uninterpretable` — every v2 value it could not map (a margin in neither family, a furcation outside 1–3, a mobility outside 0–3, a non-number, a v2 row carrying a value on a tooth it cannot place). `-1` and all-`-1` rows are NOT on the list. The later row for a position decides readability, as it decides the chart. `readPriorPerio`'s `latest` carries it |
| `backend/services/hyg/perioDrift.js` | New pure `driftAnswer`. Changes at an unreadable position are dropped, because their "not charted" would be false. Remaining changes → `changed`; none but something unreadable → `unknown`; otherwise `matches` |
| `backend/services/hyg/odDay.js` | exports `MAX_PAGES` (for the 130-row assertion) |
| `PerioDriftNotice.tsx` | **Bug fix in passing:** the notice said "Open Dental holds the readings on the left; CareIN wrote the ones on the right". The line runs `perioChartChanges(baseline, odChart)`, i.e. **CareIN → Open Dental**, so the sentence was backwards. It now reads the right way round |
| `PerioSendConfirm.tsx` | "What changes (N readings)" rather than "sites", because a mobility change is a tooth |
| `backend/hyg/contract.gen.cjs` | regenerated with the pinned esbuild + `--alias:zod` |

The doctrine is **unchanged**: present-and-matching → silence; missing → resend;
present-but-differs → say so, name it, **no resend**; unreadable → silence.

### A consequence on the amend path (intended, tested)

`perioChartChanges` is also item 13's correction diff, so it widened there too:

- **Before:** a correction that changed only a recession was refused
  `NOTHING_TO_SEND`, because the diff dropped `gm`. **Now** it is a correction.
- A recession edited in Open Dental after a correction began now refuses
  `AMEND_BASE_CHANGED`, where before it was ignored.

Both are pinned in `hygPerioV2Drift.test.js`.

## 2. Acceptance

| # | Row | Test | ✅ |
| --- | --- | --- | --- |
| 1 | Recession edited in OD → `changed`, naming tooth + site + type | `hygPerioV2Drift.test.js` › ACCEPTANCE 1: `{3, B, gm}`, line `#3 B gingival margin: 2 mm recession → 3 mm recession`. Deleting it (→ -1) is also `changed`. Audits `changed`, identifiers only | ✅ |
| 2 | Mobility reported per TOOTH | › ACCEPTANCE 2: `surface: null`, `#3 mobility: grade 1 → grade 2`, site ref `#3` | ✅ |
| 3 | Furcation reported | › ACCEPTANCE 3: `#3 ML furcation: class 2 → class 3` | ✅ |
| 4 | `changed` offers NO resend for any v2 type | › ACCEPTANCE 4, run for recession, other-family margin, furcation and mobility. Item 14's four blocks: no `sameDateExams` on the wire; the resend route refuses `PERIO_EXAM_PRESENT`; the chart stays `Written` and `exam_gone_at` is null; OD gets no new exam, no delete and no post, and the human's value is intact. On screen (`hyg-perio-v2-drift.test.tsx`): no button at all and no dialog for a v2 `changed`, and the schema strips an exam list off a `changed` answer | ✅ |
| 5 | Unchanged v2 chart is silent; all -1 rows are no false positive | › ACCEPTANCE 5: `matches`, then still `matches` after all -1 GingMargin / Furcation / Mobility rows are added; no audit row | ✅ |
| 6 | Zero added OD requests; ~130-row exam does not truncate | › ACCEPTANCE 6 — see §3 | ✅ |
| 7 | OTHER-family margin (101–119) vs written 0–19 → `changed`, never normalised | › ACCEPTANCE 7: `from '2 mm recession'`, `to '102 (unrecognised margin)'`, and the prior panel's chart holds 102 raw | ✅ |
| 8 | Uninterpretable v2 row → `unknown`, never `matches` | › ACCEPTANCE 8. Six cases all give `unknown` with no audit row: furcation 5 over a written class 2, margin 50, mobility 9, non-numeric margin, and a v2 row with a value on tooth 0 **and on tooth -1**. Also tested: an unreadable value does not hide a readable change elsewhere (`changed`, and no line is invented at the unreadable spot). Unit tests cover `chartFromMeasures`' list and `driftAnswer`'s three outcomes | ✅ |

## 3. Open Dental request count, before and after

I measured both on the same scenario: send a chart, then open it (`GET /perio/prior`). **Before** is a
detached `origin/develop` worktree at `fd1275f`; **after** is this branch. The calls are the OD client's
own log.

| Chart | Measure rows | Before | After |
| --- | --- | --- | --- |
| Small v2 chart (depth + recession + furcation + mobility on #3) | 4 | `/appointments, /perioexams, /periomeasures` (3) | identical (3) |
| Full v2 exam: every family on every tooth | **142** | `/appointments, /perioexams, /periomeasures, /periomeasures` (4) | identical (4) |

There are **zero added requests**. The v2 rows ride the measures pages the prior panel
already reads. The 142-row exam takes 2 pages of 100. That is far inside
`MAX_PAGES` = 25 (2,500 rows): `prior.truncated === false` and drift is `matches`.
ACCEPTANCE 6 asserts all of this, including that a recession edited on the **second**
page is still seen.

## 4. Reviewer verdict

A fresh-context reviewer was given the queue file and `git diff origin/develop...HEAD`.

- **Round 1: FAIL**, two items.
  1. Row 8 had a hole: a v2 row on `IntTooth: -1` passed the tooth as the "raw value" into
     the `-1 = absent` check, so a real grade vanished and drift said `matches`. **Fixed**
     (`14d67b6`), and the tooth -1 case was added to the row-8 test and the unit test.
  2. This report did not exist yet. **Written.**

  Rows 1–7, the build bullets and every hard rule passed. The flipped item-26 test was judged
  "legitimate, not a weakening".
- **Round 2: PASS.** Every acceptance row and every hard rule holds. The amend-path gap and the `PerioSendPanel` noun are noted as non-blocking; both are in §7.

### The one existing test that changed

`new-dashboard/tests/hyg-perio-v2.test.ts` › *"DRIFT still answers the v1 question —
the v2 kinds are filtered"* asserted `perioChartChanges(gm 2, gm 3)` → `[]`. That was
the 26b deferral pinned on purpose, and this item exists to reverse it. Its first half
now asserts the exact opposite, stronger claim (`[[3, "DB", "gm", "2 mm recession",
"3 mm recession"]]`). Its depth half is unchanged. No other existing assertion was
touched.

### A gate catch worth recording

The first full backend run failed 2 tests in `hygNoOdWrites.test.js`. Its source scan
flags any `.delete(` in `odPerio.js` as a write-shaped call, and my `Map.delete` tripped
it. The guard is right to be blunt. I changed the code (a readable position is recorded
as `null` and filtered), not the guard.

## 5. Gates and CI

Local, on the branch tip:

- backend: `npm ci` ✅ · `node --check server.js` ✅ · `node scripts/shard-runner.mjs` → **4/4 shards green** (714 + 837 + 657 + 771 pass, 0 fail, 3 skipped) ✅
- new-dashboard: `pnpm install --frozen-lockfile` ✅ · `pnpm run check` (tsc) clean ✅ ·
  `pnpm run test` 128 files / 2197 tests passed ✅

CI: **PR #221**, `build-test` **passed** on the merge tree (`refs/pull/221/merge`) for head `f6e4a7f`, first run, with no re-runs and no flakes. Run: https://github.com/bsparkma/retell-ai-dashboard/actions/runs/37345863350

## 6. Staging test steps

Use roland test patient **12827** only (or valley **7115**). Staging only; the item-20
fixture gate arms writes for those patients alone.

1. Open a hygiene visit for 12827 → Perio. Chart a few depths, plus **2 mm recession on
   #3 B**, **furcation class 2 on #3 ML** and **mobility 1 on #3**. Stage → Send. Wait for `Written`.
2. Re-open the chart. **Expect:** no drift notice (silence = matches).
3. In Open Dental's own perio chart for that exam, change #3 B's gingival margin to 3.
   Re-open in CareIN. **Expect:** an amber notice reading
   `#3 B gingival margin: 2 mm recession → 3 mm recession`, the sentence "CareIN wrote
   the readings on the left; Open Dental holds the ones on the right", and **no Send
   again button**.
4. In OD, set #3 mobility to 2. Re-open. **Expect:** `#3 mobility: grade 1 → grade 2`,
   with no surface.
5. In OD, type `102` in #3 B's margin (if OD's UI allows it). Re-open. **Expect:**
   `… → 102 (unrecognised margin)`. It must never be silent.
6. Put the OD values back to what CareIN wrote. Re-open. **Expect:** silence again.
7. Optional: press **Amend chart**, change only #3 B recession, stage, and open the
   send confirm. **Expect:** "What changes (1 reading)" listing the gingival margin line,
   and **not** "nothing to correct".

## 7. Deliberately not built

- **The amend path does not use `uninterpretable`.** `perioSend.readExamChart` still
  takes only `.chart`. So if OD holds a value CareIN cannot interpret, drift says
  `unknown`, but `AMEND_BASE_CHANGED` and `beginPerioAmendment` treat it as "nothing
  charted", and a correction would then supersede that exam. This predates this branch and
  is not a regression; the reviewer flagged it as the next honest-states gap. It is outside
  this item's scope (the queue file covers the drift check), so it is left for a follow-up.
- **`PerioSendPanel`'s "N sites corrected" line** still says "sites" (pinned by
  `hyg-perio-page.test.tsx:861`). A mobility correction there would read "1 site
  corrected · #3 mobility: …". The line itself is right; only the count noun is loose.
- No change to the send, `odPerioWriter.js`, any migration, the resend, or polling.
  CAL is still never read or written.
- No UI screenshots were shot. The notice's markup is unchanged apart from the
  corrected sentence; the line strings are asserted in vitest.

# 19 — PROBE: recession, furcation and mobility on Open Dental's perio surfaces

Branch `feature/hyg-perio-v2-probe`, off `origin/develop`. Worktree
`C:\Users\beau\carein-wt\hyg-perio-v2-probe`. **Measure, do not build: no product code.**
Push/PR status is in §7.

- Script: `backend/scripts/probe-hyg-perio-v2.js` (fixture-guarded, **roland 12828 only**), tests
  `backend/test/probeHygPerioV2.test.js`, and one name added to the scripts write allow-list in
  `backend/routes/rcm/rcmNoOdWrites.test.js` (the documented extension point; same precedent as
  `probe-hyg-perio-arch.js`).
- Raw read-backs: `new-dashboard/tests/fixtures/perio-v2-probe-staging.json` — every payload sent,
  every response, every row read back, the cleanup record.
- Run inside the staging container (revision `ca-carein-backend--0000189`), roland, PatNum 12828,
  ProvNum 15, ExamDate 2000-01-01. The script was uploaded to `/tmp` (the image does not carry it
  yet) and its SHA-256 matched the committed file (`d886d30e…c835e0`) before it ran. `--dry` ran
  first, in the container.

## 0. Exams created and deleted

| Exam | Experiment | Created (UTC) | Deleted | Confirmed gone from 12828's exam list |
|---|---|---|---|---|
| **2266** | `types` (Q1–Q5) | 2026-09-21 23:59:25 | yes | yes |
| **2267** | `bad` (Q7) | 2026-09-21 23:59:30 | yes | yes |

**Every exam this probe created is deleted.** 12828 had one exam before the run, **2265, dated
2026-09-21** — not this probe's, and left untouched. The arch probe's exams 2249–2252 are no longer
on 12828 (only 2265 was listed), which closes the "cleanup output not saved" gap in item 11's report.

An earlier attempt the same evening (detached with `nohup`) was killed when the exec session
closed, **after its first GET and before any POST** — nothing was created by it.

## 1. Q1 — How a non-probing measure is written

`POST /periomeasures`, one row per (tooth, `SequenceType`), the same body the product already sends
for Probing rows. **Every accepted payload below answered 201 and returned the created row** (with
its `PerioMeasureNum`), and every one read back **exactly** as sent:

```json
{"PerioExamNum":2266,"SequenceType":"GingMargin","IntTooth":3,"ToothValue":-1,"MBvalue":0,"Bvalue":2,"DBvalue":3,"MLvalue":1,"Lvalue":101,"DLvalue":102}
{"PerioExamNum":2266,"SequenceType":"GingMargin","IntTooth":1,"ToothValue":-1,"MBvalue":1,"Bvalue":1,"DBvalue":2,"MLvalue":-1,"Lvalue":-1,"DLvalue":-1}
{"PerioExamNum":2266,"SequenceType":"Furcation","IntTooth":3,"ToothValue":-1,"MBvalue":-1,"Bvalue":1,"DBvalue":-1,"MLvalue":2,"Lvalue":-1,"DLvalue":3}
{"PerioExamNum":2266,"SequenceType":"Furcation","IntTooth":30,"ToothValue":-1,"MBvalue":-1,"Bvalue":2,"DBvalue":-1,"MLvalue":-1,"Lvalue":1,"DLvalue":-1}
{"PerioExamNum":2266,"SequenceType":"Furcation","IntTooth":8,"ToothValue":-1,"MBvalue":-1,"Bvalue":2,"DBvalue":-1,"MLvalue":-1,"Lvalue":-1,"DLvalue":-1}
{"PerioExamNum":2266,"SequenceType":"Mobility","IntTooth":3,"ToothValue":2,"MBvalue":-1,"Bvalue":-1,"DBvalue":-1,"MLvalue":-1,"Lvalue":-1,"DLvalue":-1}
{"PerioExamNum":2266,"SequenceType":"Mobility","IntTooth":30,"ToothValue":1,"MBvalue":-1,"Bvalue":-1,"DBvalue":-1,"MLvalue":-1,"Lvalue":-1,"DLvalue":-1}
```

The type names are exactly `GingMargin`, `Furcation`, `Mobility` (case as shown). `Recession` is
refused: `400 SequenceType is invalid.`

## 2. Q2 — Recession / gingival margin

- **Per site**, in the six surface columns (`MB B DB ML L DL`). `ToothValue` must be `-1`.
- **Accepted range: 0–19 and 101–119**, enforced by Open Dental with a clear refusal (§7). The mixed
  row above (0, 2, 3, 1, **101**, **102**) stored every value verbatim — 101/102 are not converted,
  clamped or re-signed on the way in or out.
- **Sign convention: the API does not say which is recession.** It stores two families of numbers;
  H0 documents 101–119 as "negative (subtract 100)". Whether negative means recession or overgrowth
  in Open Dental's own chart — and therefore in its CAL — is a UI convention this probe cannot
  observe. **One check by a person closes it:** enter a known 2 mm recession on a fixture in Open
  Dental's perio chart, then read that row through the API and see whether it is `2` or `102`.
  Product code must not be written before that answer.
- **CAL.** CAL was not probed and must never be written. Open Dental derives its own CAL from
  Probing + GingMargin, so a written CAL could disagree with the chart of record. CareIN may compute
  CAL for display only — and only once the sign convention above is known, since CAL = PD − GM or
  PD + GM depending on it.

## 3. Q3 — Furcation

- **Per site**, in the surface columns; `ToothValue` must be `-1` (a row with `ToothValue: 1` is
  refused: `400 ToothValue must be -1 for SequenceType of Furcation.`).
- There is no separate "furcation entry point" field: the writer chooses the entry by column.
  Upper molar #3 took B/ML/DL (1, 2, 3); lower molar #30 took B/L (2, 1). All read back exactly.
- **Values are not validated as classes.** `Bvalue: 5` on #14 was **accepted (201) and stored** —
  there is no class V. Open Dental does not hold furcation to I–III, or to 1–3.
- **A single-rooted tooth is not refused.** Furcation `Bvalue: 2` on #8 (a central incisor) was
  accepted and stored. Open Dental does not know which teeth have furcations.

→ Both of those are the corruption hazards of §7: the product must enforce the class range and the
tooth list itself, before the transport, the way `odPerioWriter.js` already refuses bad depths.

## 4. Q4 — Mobility

- **Per tooth**, in `ToothValue`. Every surface column **must** be `-1` — a row with `MBvalue: 2` is
  refused: `400 MBvalue is invalid. Value must be -1 for SequenceType of Mobility.`
- Values 1 and 2 stored exactly. `ToothValue: 25` is refused (`400 ToothValue is invalid.`); the
  exact upper bound was not bisected (H0 says 0–19).
- Unused columns hold `-1`, as sent, and read back as `-1`.

## 5. Q5 — One read-back for a v1 + v2 chart

`GET /periomeasures?PerioExamNum=2266` returned **all 8 rows in one answer, every type
distinguishable by its `SequenceType` string** — Probing (from the exam's arch string `323`, which
landed on #1 DB/B/MB = 3/2/3 as item 11 mapped), GingMargin, Furcation, Mobility. The `PerioExamNum`
filter **was honoured** here (8 rows before and after filtering to the exam). So a v1 + v2 chart can
be verified site by site from the same read the product already makes; a full-mouth v2 exam
(~130 rows) would span two of `pagedList`'s 100-row pages.

## 6. Q6 — The undo

- `DELETE /perioexams/2266` and `/2267` both landed, and **both exams are gone from 12828's exam
  list** (read back after each delete).
- Their rows **are no longer reachable through the exam**: `GET /periomeasures?PerioExamNum=2266`
  (and 2267) now answers **`404 PerioExamNum not found.`**, where before the delete it returned 8
  (and 2) rows including GingMargin, Furcation and Mobility.
- **Not proven:** that no orphaned row survives outside the exam. The only way to look is the
  unfiltered measure list — see the warning below — which this probe deliberately did not scan.
  A person should decide whether to run that check (it reads every patient's perio rows) or accept
  the exam-scoped evidence, which is the same evidence item 12's undo already rests on.

> ⚠️ **`GET /periomeasures/{PerioMeasureNum}` is NOT a single-row read.** Asked for each of the ten
> probe rows by number after the delete, Open Dental ignored the id in the path and returned its
> **unfiltered** measure list, beginning with PerioMeasureNum 2 on exam 1 — other patients' perio
> rows (they carry no patient identifier; only the first 160 characters of one row were printed, and
> nothing further was read). Any future code that reads a measure "by id" this way would silently
> receive the whole practice's perio table. The product does not do this today: every read passes
> `PerioExamNum` and filters client-side.

## 7. Q7 — Corruption check

| Payload | Answer | Stored? |
|---|---|---|
| GingMargin `Bvalue: 25` | `400 Bvalue is invalid. Value must be 0-19 or 101-119 for SequenceType of GingMargin.` | no |
| GingMargin `Bvalue: 99` | same | no |
| GingMargin `Bvalue: -5` (a literal negative) | same | no |
| GingMargin `Bvalue: 120` | same | no |
| **Furcation `Bvalue: 5`** | **201 — accepted** | **yes, as 5** |
| Furcation `ToothValue: 1` | `400 ToothValue must be -1 for SequenceType of Furcation.` | no |
| Mobility `ToothValue: 25` | `400 ToothValue is invalid.` | no |
| Mobility with `MBvalue: 2` | `400 MBvalue is invalid. Value must be -1 for SequenceType of Mobility.` | no |
| GingMargin #12 `B: 2`, then a **second** GingMargin #12 `B: 4` | first 201; second `400 A PerioMeasure with SequenceType GingMargin already exists for IntTooth 12.` | first only; **not overwritten** |
| `SequenceType: "Recession"` | `400 SequenceType is invalid.` | no |
| `IntTooth: 33` | `400 IntTooth is invalid.` | no |

**No write shifted another.** Every accepted row read back exactly, on the tooth and site it was
sent to — nothing like the arch strings' silent splitting of two-digit depths. Every refusal wrote
nothing (the `bad` exam held exactly the two accepted rows).

Two hazards, both about what Open Dental does NOT check:

1. **Furcation values are unvalidated** (5 stored), and
2. **furcation is accepted on any tooth**, including single-rooted ones.

And one behaviour to design around: a second row for the same (tooth, type) is **refused, not
overwritten**. That is safe — a retried POST of a row that already landed cannot double it — but it
means a retry must read before it writes (the send's existing pattern) and treat "already exists"
as "check it matches", never as a failure to report blindly.

## 8. Q8 — Request arithmetic

From the product's own estimator (`estimatePerioSendRequests` = 3 + rows + ⌈rows ÷ 12⌉ + 1 for a new
exam; batch 12), for a 28-tooth chart (third molars skipped: 4 `SkipTooth` rows), probing and flags
by arch string:

| Chart | Rows | Requests | At 1 req/s |
|---|---|---|---|
| v1 today (probing + flags by string, 4 skips) | 4 | 9 | ~9 s |
| **v2, typical** — GingMargin on all 28, mobility on 6, furcation on 4 | 42 | **50** | **~50 s** |
| **v2, every field on every eligible tooth** — 28 GingMargin + 28 Mobility + 10 Furcation (8 molars + 2 upper first premolars) | 70 | **80** | **~80 s** |

(Plus one extra verify page once an exam passes 100 rows.) Recession dominates: it is one row per
charted tooth whether or not it is zero, unless the product decides "not recorded" is `-1` and
skips the row — a clinical decision, not a technical one. A deep pocket (10 mm +) that forces an
arch to rows adds up to 32 more.

## 9. What this means for v2 (recommendations, not built)

1. **Writable as-is:** GingMargin, Furcation and Mobility, per row, with the body above; read-back
   through the existing exam read; undo through the existing exam delete.
2. **Before any product code:** settle the GingMargin sign convention (§2) with one check in Open
   Dental's own chart.
3. **Guard in the writer, before the transport:** furcation class 1–3 and multi-rooted teeth only;
   GingMargin 0–19 / 101–119 and mobility within range (Open Dental enforces these, but a refusal
   mid-send is worse than a refusal at stage time).
4. **Never** read `/periomeasures/{id}`; never write CAL.

## 10. Gates and hard rules

- `node scripts/shard-runner.mjs`: **4/4 green** — 2526 tests, 2523 pass, 0 fail, 3 skipped.
  `pnpm run check`: clean (no dashboard code changed; the fixture is JSON).
  `node --test test/probeHygPerioV2.test.js routes/rcm/rcmNoOdWrites.test.js`: 26/26.
- Test patient **12828 only** — the script refuses every other office and PatNum (tested, including
  12827, 7115 and 11373). Every created exam deleted (§0). No product code; no throttle change;
  `PUT /periomeasures` never used; no CAL row sent. No `.env`, no secrets read, no Azure change.

## 11. Push / PR

Pushed to `origin/feature/hyg-perio-v2-probe`. PR into `develop`: see the line appended below. Not merged.

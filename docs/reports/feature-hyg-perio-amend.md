# 13 — Correcting a perio chart after it has been sent

Branch `feature/hyg-perio-amend`, off `origin/develop` at `190e0ff` (after #179 merged).
Worktree `C:\Users\beau\carein-wt\hyg-perio-amend`. PUSH/PR STATUS is in §9.

---

## 0. The measured findings, and the file that does not exist

The brief says to read `carein-hyg-perio-arch-findings.md` before writing perio code. **There is no
such file anywhere on this machine** — nothing references it except the queue item's own
`[[carein-hyg-perio-arch-findings]]` link. What exists, and what this slice was built against, is the
same staging run recorded in the repo by item 12:

- `docs/reports/feature-hyg-perio-arch-probe.md` §4 — the findings, filled in from the run's own
  console output;
- `new-dashboard/tests/fixtures/perio-arch-probe-staging.json` — that run's per-position read-back,
  which the tests are pinned to and which the fake Open Dental parses strings with.

Nothing here infers anything from H0. The two operations used are the two the probe exercised
against the live API: `POST /perioexams` and `DELETE /perioexams/{n}`. **`PUT /periomeasures` is not
touched**, and a test asserts the module only ever reaches POST and DELETE.

## 1. Acceptance

| # | Criterion | Proven by | Result |
|---|---|---|---|
| 1 | A `Written` chart can be amended; the readings carry forward | `hygPerioAmend.test.js` › *ACCEPTANCE 1*: after Amend the chart is `Amending`, the readings equal what Open Dental holds (192 sites), a reading can be changed again, and opening it wrote nothing (`od.writes` unchanged, one exam, no deletes) | ✅ |
| 2 | Order is POST → verify → DELETE, asserted by test | › *ACCEPTANCE 2*: the fake's single ordered write log reads exactly `['POST exam 7001', 'POST exam 7002', 'DELETE exam 7001']`; the chart then reads `(amended; replaced exam 7001, now deleted)` and Open Dental holds only 7002 | ✅ |
| 3 | A failed re-create deletes NOTHING and says the amendment failed | › *ACCEPTANCE 3* (refused POST: `refused`, staged `Failed`, "Nothing was created", deletes empty, the original exam intact and still readable) and *3b* (the new exam does not read back: `incomplete`, BOTH exams present, zero deletes, the original's 32 rows untouched) | ✅ |
| 4 | The confirm dialog names every changed site as old → new | › *ACCEPTANCE 4* (the server hands back `amendDiff` = `#14 B: 3 mm → 9 mm`, `#30 DL: 2 mm → 5 mm`, `#30 DL: no flags → bleeding`) and `hyg-perio-page.test.tsx` › *a sent chart is amended, not unlocked* (the dialog shows **What changes**, titled *Correct exam 7001 in Open Dental?*) | ✅ |
| 5 | Audit carries the per-site diff, the actor, and both exam numbers | › *ACCEPTANCE 5*: a row per changed site (`hyg_perio_amend_site`, `900001:14-B`), the swap row naming `perio_exam:7001->7002`, the actor on it — **and the readings deliberately NOT in the trail**. See §2.5; this is the one deviation from the brief's wording | ⚠️ see §2.5 |
| 6 | The undo can only ever target the NEW exam, never the original | › *ACCEPTANCE 6*: with an unfinished amendment, `delete-exam 7001` → 409 and zero deletes; `delete-exam 7002` → only 7002 goes, the original stands, the chart returns to Staged | ✅ |
| 7 | An un-amended chart, and an abandoned amendment, change nothing in OD | › *ACCEPTANCE 7*: amend, edit, stage, walk away → no writes; Cancel → chart back to what Open Dental holds, still one exam, no deletes, and it can be amended again | ✅ |

Also tested: an exam edited in Open Dental after Amend was pressed is refused (`AMEND_BASE_CHANGED`,
naming the site, nothing written); a swap whose DELETE fails says the old exam is still there and can
be finished later; a correction can itself be corrected (7002 → 7003 replaces 7002, diffed against
the correction); a chart that is not in Open Dental cannot be amended; and the module reaches only
POST and DELETE.

## 2. The design

### 2.1 The swap

```
confirm   fingerprint + exam date + provider (item 12's gate), then:
          re-read the exam being replaced and refuse if it changed since Amend
POST      the corrected exam, by item 12's planner — strings where they hold, rows where not
verify    read EVERY site back and compare to the staged chart
DELETE    the replaced exam — only now, and only if the read-back matched
```

Never the other way round. Every failure path leaves the patient's existing exam alone, and the
screen says the correction did not go through. **The two exams coexist between the POST and the
DELETE, on the same date** — expected, transient, and stated in the confirm dialog.

### 2.2 `Amending`, and where the exam number lives

A new staged-write state (migration `1788600000000`), client-mutable like `Draft`. Opening a
correction loads **what Open Dental holds right now** into the chart, so she edits what is actually
there; if somebody corrected a site in Open Dental, she sees their correction rather than silently
reverting it.

`written_ref` goes with the state — see §3, the rehearsal caught this — so opening clears it and
abandoning restores the same sentence. The exam number is never lost: it is on the send row.

### 2.3 The live send

The send row now carries `chart` (what it wrote, recorded when it verified), `supersedes_exam_num`,
`supersedes_deleted_at` and `amend_diff`. The **live send** is the most recent one in state
`written`; its exam is what is in Open Dental, so that is what the next correction replaces and what
the diff is taken against. After a swap there are two `written` sends and the most recent is live.

`created_at` now defaults to `clock_timestamp()`: `now()` is the transaction's clock, so two sends
written in one transaction tied, and "the most recent" became a coin flip. Found by the rehearsal.

### 2.4 The undo boundary (acceptance 6)

`/perio/send/delete-exam` still names only `send.exam_num` — the exam that send created. The exam
being replaced is removed only as step 3 of a verified swap, or by
`/perio/send/remove-replaced`, which refuses any number but `supersedes_exam_num` and only while the
send says it is still there. Two different actions, two different guards.

### 2.5 ⚠️ The audit deviation — please read

The brief asks the audit to carry the per-site diff. **It carries the sites, not the readings**, and
that is deliberate: `audit_log`'s own columns say a value in it must never be PHI (`resource_id` is
"ID only — never a PHI value"), and `prior_state` is slug-shaped by a CHECK. Writing `#14 B 3 mm →
4 mm` into the trail would put clinical values in it, and `backend/platform/` is out of scope for
this slice anyway.

So the trail records: one row when a chart is opened for correction (`prior_state 'written'`), one
when the swap completes (`source_ref perio_exam:7001->7002`, `prior_state 'replaced'` or
`'replaced_not_removed'`), and **one row per changed site** naming the site
(`resource_id 900001:14-B`, `prior_state 'depth' | 'flags' | 'skipped'`) — with the acting user on
every row. The readings themselves are in `hyg_perio_send.amend_diff` and on screen. A test asserts
no depth or flag word ever reaches the trail. **Say if you want the values in the audit log instead;
that is a platform decision, not a hygiene one.**

## 3. What the real-Postgres rehearsal caught

The fake database let item 13 move a chart to `Amending` while it still carried `written_ref`.
Postgres refused it: `hyg_staged_write_written_ref_check` is a BICONDITIONAL —
`(state = 'Written') = (written_ref IS NOT NULL)`. A `Written` row must carry a reference and
nothing else may.

Two fixes, both in this branch: `written_ref` is cleared when a correction opens and restored (by one
shared definition, `perioSend.writtenRefFor`) when it is abandoned; and **the fake now enforces the
invariant after every statement**, so this class of defect fails in the fast tests rather than only
in a rehearsal. One existing test fixture was wrong under the new check — it forced a `Written` row
with no reference, a row Postgres would never have accepted — and was corrected.

The rehearsal's §6e adds 10 checks: `Amending` as a state the CHECK now accepts, the swap columns
refusing a diff with nothing to replace / a send superseding its own exam / a delete recorded for an
exam nothing replaced, the live send (and office scoping on every read and write), the swap recorded
exactly once, and an abandoned correction restoring both the readings and the reference.

## 4. Gates

| Gate | Result |
|---|---|
| `node scripts/shard-runner.mjs` (on the code being pushed) | 4/4 green — 650 + 495 + 671 + 689 = **2505 tests, 2502 pass, 0 fail, 3 skipped**. Run twice: once before the rehearsal's finding, once after fixing it |
| backend hyg + perio suites after every fix | **234/234** |
| `pnpm run check` | clean |
| `pnpm run test` | **108 files passed, 19 skipped; 1737 passed, 120 skipped** |
| Real Postgres 16 rehearsal, as `carein_app` | **58/58**, and the migration rolls `down` then `up` cleanly |
| `hyg-contract-bundle.test.ts` | passes; bundle regenerated with the pinned esbuild |

## 5. Screenshots — `docs/screenshots/hyg/`, 1180 wide, light and dark

| File | Shows |
|---|---|
| `hyg-perio-amend-12-written` | a chart in Open Dental as exam 7001, offering **Amend chart** |
| `hyg-perio-amend-13-amending` | editable again: *"These are the readings Open Dental holds… NOTHING changes in Open Dental until you send"* |
| `hyg-perio-amend-14-confirm` | *Correct exam 7001 in Open Dental?* with **What changes (2 sites)** and the swap order spelled out |
| `hyg-perio-amend-15-replaced-left` | a swap whose delete did not land, and **Remove exam 7001** |

`hyg-perio-send-08-written` was re-shot unchanged in meaning.

## 6. Staging rehearsal plan — for Beau

Test patients only (roland 12827 / 12828). Each of these leaves exams behind; clean up as in item
12's report §6 (the page's own delete while a send is unfinished, or the probe's fixture-guarded
`--cleanup <n> --force-cleanup`).

1. **Amend a chart that is written.** Send a small chart, press **Amend chart**, change one depth,
   stage, send. Expect: the dialog names that one site old → new; afterwards Open Dental holds ONE
   exam, the corrected one, and the chart reads `(amended; replaced exam N, now deleted)`.
2. **Abandon a correction.** Amend, change two sites, then **Cancel correction**. Expect: the chart
   goes back to the readings Open Dental holds, the exam is untouched, and nothing was written.
3. **Correct a correction.** Amend the amended chart and change another site. Expect the diff to be
   against the correction, and the newest exam to replace the previous one.
4. **The drift guard.** Amend, then edit that same exam in Open Dental's own perio chart, then try to
   send. Expect `AMEND_BASE_CHANGED`, nothing written, and the message naming the site.
5. **Watch the order.** During step 1, the `[hygperio]` lines and Open Dental's exam list should show
   the new exam appearing BEFORE the old one disappears, and both present for a moment.

## 7. Decisions worth a second look

- **The audit deviation** (§2.5). The one place this slice does not do what the brief's acceptance
  table says.
- **The baseline is Open Dental's current readings, not CareIN's memory.** Amend re-reads the exam
  and loads that. It means a correction made in Open Dental is preserved and visible rather than
  reverted, at the cost of the chart sometimes changing under her when she presses Amend.
- **A correction is a full re-send**, so a 192-site chart is written again to change one digit. That
  is the price of not using `PUT /periomeasures`, and with arch strings it is usually one request.
- **`clock_timestamp()`** (§2.3) changes how `created_at` is stamped for new sends.
- **Cancel needs the live send's chart.** If CareIN cannot read what the exam holds (a send from
  before this slice, with no stored chart), Amend refuses rather than proceeding blind — it reads Open
  Dental at Amend time and stores that as the baseline.

## 8. Commits

```
78c87c3 Add Amending, and what a send wrote, to the perio schema
63d7b1b Correct a perio chart by a safe swap: post, verify, then delete
c6bdbd9 Amend a sent chart from the perio page
357301d Rehearse the correction on Postgres, document it, photograph it
```

## 9. Push / PR

_(filled in after push)_

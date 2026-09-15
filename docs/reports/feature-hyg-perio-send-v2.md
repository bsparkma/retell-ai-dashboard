# 12 — The perio send, built to what the probe actually found

Branch `feature/hyg-perio-send-v2`, off `origin/develop` at `0ae48b3` (after #176 and #178 merged).
Worktree `C:\Users\beau\carein-wt\hyg-perio-send-v2`. PUSH/PR STATUS is in §9.

---

## 0. Before anything else: where the mapping came from

The brief says the probe's findings are in `docs/reports/feature-hyg-perio-arch-probe.md` §Findings.
**On every ref in the object store, that section was still blank** (the Q1–Q7 placeholders from PR #178).
The staging run's real output existed only as an untracked file, `backend/probe-output.txt`, in the
probe worktree. It matches the brief's §0 in every particular (exams 2249–2252, UNIQUE 48/48 on four
arches, the flags, the `10 11 19 3` corruption, the ignored skip characters, the refused malformed
body).

So, without re-deriving anything:

- the **position table** in `new-dashboard/shared/hyg/perioSend.ts` was generated mechanically from
  that output's four read-back tables, row for row;
- the output's tables are committed as `new-dashboard/tests/fixtures/perio-arch-probe-staging.json`,
  and the tests are pinned to that file;
- the probe report's §4 is now **filled in** from the same output, so the reference the brief points
  to is true (commit `16ebe85`).

**One thing I could not verify:** the cleanup. The run printed `--cleanup 2249,2250,2251,2252`; that
command's console output was not saved, but the probe's manifest is `{"exams": []}`, and `--cleanup`
removes an exam from the manifest only after reading it back gone. **Worth one look at 12828's perio
chart in Open Dental for exams dated 2000-01-01.**

## 1. Acceptance

| # | Criterion | Proven by | Result |
|---|---|---|---|
| 1 | Expressibility predicate unit-tested against every §2 case | `tests/hyg-perio-send-plan.test.ts` › *the expressibility predicate*: a 10 at positions 1, 30 and 48; every deep site named, 9 still a string; a gap at position 1; a gap mid-arch; a trailing gap (expressible, the string stops); an empty arch (no key, not `""`); a flag with no depth; a skipped tooth before a charted one vs a skipped last tooth | ✅ |
| 2 | Mapping pinned by a fixture-chart → strings test matching the probe table | same file › *the position table is the probe's table*: the table equals the fixture position for position, and **the chart the probe READ BACK re-encodes to exactly the four strings the probe SENT**; the flags experiment's read-back re-encodes to `3b2s4p5c6bs7pc8bspc`; the midline flip stated in the probe's words | ✅ |
| 3 | A full 0–9 chart sends ONE POST (write count asserted) | `backend/routes/hyg/hygPerioSend.test.js` › *ACCEPTANCE 3*: `app.od.writes.length === 1`, one `/perioexams`, zero `/periomeasures`, four strings, then Written; the log line asserted | ✅ |
| 4 | An arch with a ≥10 reading takes the per-row path (asserted) | › *ACCEPTANCE 4*: a 12 on #3 DB → no upper string in the POST, 16 Probing POSTs for #1–#16 with `DBvalue 12` on #3, nothing row-by-row for the lower jaw, Written | ✅ |
| 5 | A gap mid-arch takes the per-row path; no site is ever written as 0 | › *ACCEPTANCE 5* (every uncharted site in every posted body is `-1`) and the plan test *NO SITE THAT WAS NOT CHARTED IS EVER WRITTEN AS 0* | ✅ |
| 6 | Read-back compares every site; a mismatch blocks Written and is named | › *ACCEPTANCE 6*: one corrupted site → `incomplete`, staged write Failed, `writtenRef` null, `#14 B` named in the message and the mismatch list, a further step writes nothing, retry refused `PERIO_EXAM_EXISTS`; plus the plan tests for the comparison (a shifted reading, a 0 where nothing was charted, flags, skipped teeth) | ✅ |
| 7 | Delete-the-exam undo exists, is guarded, and is tested | › *ACCEPTANCE 7*: wrong exam number 409 and no DELETE; no number 400; a held lease 409 `PERIO_SEND_BUSY`; the right number → exactly one `DELETE /perioexams/7001`, exam and rows gone, send `deleted` with who, chart back to Staged with the same fingerprint, DELETE audited; a second delete refused. › *the undo refuses a WRITTEN chart*. Transport: `backend/test/odApiDeleteRaw.test.js`. UI: the page test requires the tick before the delete fires | ✅ |

Also tested because the brief's failure section asks for them: a refused exam creates nothing, says so,
and can be put back and sent again; **an exam POST that landed without answering is adopted on the
next step, never posted twice**; a row that landed without answering is found by reading, every row
posted exactly once; a held lease writes nothing and a lapsed one is taken over; the fingerprint, date
and provider gates refuse with zero writes; a confirm that dies before its send is recorded puts the
chart back having written nothing.

## 2. The design

```
confirm   fingerprint + exam date + provider, re-derived server-side (lifted from #177)
          → plan frozen onto a hyg_perio_send row; staged write Staged → Sending
exam      POST /perioexams { PatNum, ExamDate, ProvNum, Note: "Charted in CareIN.", <expressible strings> }
tail      POST /periomeasures for what the strings cannot carry — READ the exam first, every step
verify    read every measure back (paged); compare every site to the staged chart
          → written | incomplete (sites named) ; refused (nothing created) ; deleted (the undo)
```

**Expressibility (§2 of the brief).** An arch goes as a string only when every charted depth is 0–9,
the charted sites run unbroken from position 1, **and no flag sits on a site with no depth** — that
third condition is not in the brief, but a flag letter needs a digit to ride (probe Q4), so a flag on
an uncharted site cannot be expressed at all.

**"At most 48 characters of digits plus flag letters"** — I read this as *at most 48 digits*, each
followed by at most one of each flag letter in `bspc` order. Taken literally as 48 characters in
total, any arch with a handful of flags would be refused the string path, and the probe showed flag
letters do not consume positions. The writer enforces the reading I chose
(`isWellFormedArchString`); **say if the literal one was meant** — it is a one-line change.

### The jaw rule — a tightening beyond the brief, on purpose

The brief computes expressibility per arch. Open Dental keeps **one Probing row per tooth for both
sides**. If the upper facial went as a string and the upper lingual row by row, every upper tooth's
lingual readings would have to be `PUT` onto the row the string created: a verb the probe never
exercised, onto a row that can never be deleted, merging two sources for one tooth. So **when either
arch of a jaw goes row by row, both do** (reason `partner`). It costs no extra requests — a PUT per
tooth and a POST per tooth are the same count — and it means the writer has no PUT at all
(`hygNoOdWrites` asserts that). It never sends a string the brief would not; it only sends fewer.

### Skipped teeth — worth knowing before rehearsal

A skipped tooth is always a `SkipTooth` row after the exam. Before a charted tooth it is a gap, so
**a patient missing #1 sends the whole upper jaw row by row** (and #32 the lower). Missing third molars
are common, so many real charts will take the slow path. That is the correct reading of the probe
(nothing holds a place); it is slower, not less safe, and it is read back the same way.

### The undo

`DELETE /perioexams/{n}`, through a new transport method, `apiDeleteRaw`, which **refuses any path
that is not `/perioexams/<positive integer>`** in `config/openDental.js` itself, under
`OPENDENTAL_WRITE_DISABLED`. `apiWriteRaw` is untouched and still has no DELETE. The service refuses
unless the send knows its exam, the request repeats that exact number, the send is unfinished
(`filling`/`incomplete`), no step holds the lease, and Open Dental lists that exam for this patient
before the delete and not after. The page adds a tick-box. Audited as `DELETE`. The page offers it on
an *incomplete* send, and — as **Delete exam N instead**, beside Continue — on a *paused* send that has
already created its exam.

### Storage — `hyg_perio_send`, migration `1788500000000`

One row per send, not per write: the frozen plan, `prior_exam_nums`, the `exam_num` it created,
`rows_written`, `mismatches`, and a step lease. CHECKs written the long way (`filling/written/deleted`
need an exam number; `refused` cannot have one; `incomplete/refused` need a reason; a lease is a token
and a time or neither). A unique index allows one send in flight per chart. `exam_date` is `text`
with a shape CHECK — a `date` column comes back from node-postgres as a JS Date at local midnight.
**The app role gets SELECT, INSERT, UPDATE and no DELETE, and there is no cascade from the visit**: a
send that created an exam is a record of something in a chart. Consequence: a visit with a send can
no longer be deleted (the rehearsal proves the refusal). Nothing in the app deletes visits today.

### Registered writer

`services/hyg/odPerioWriter.js` joins `odWriter.js` in `OD_WRITE_LAYER`, with a test that it really
reaches `apiWriteRaw('POST', '/perioexams'…)`, `'/periomeasures'` and `apiDeleteRaw`, that it never
PUTs, and that `perioSend.js` names no transport verb. The allow-list scan now covers `apiDeleteRaw`
too, and the perio-endpoint scan allows exactly the reader and this writer.

## 3. What was lifted from #177, and what was left (§6)

**Taken** (rewritten into the new files, not merged): the three-shape write answer — ok / refused /
uncertain, where 408 and no-answer are *uncertain* (`odPerioWriter.failureKind`); the refusal of any
SequenceType but Probing/BleedSupPlaqCalc/SkipTooth before the transport; the confirm gate
(fingerprint, recomposed preview, exam date, provider, `NO_PROVIDER`); `prior_exam_nums` and adopting
the one new exam rather than posting a second; read-before-write with "stop rather than add a second
row"; nothing posted on a truncated read; page-driven steps inside audited requests; the batch of 12;
`failedTeeth` on the grid; the confirm/panel component shapes.

**Left:** the queue table with a row per measurement, its per-row claims, `resume` and
`resetFailed`; the minutes-long time estimates; `perioMeasureRows` as the whole plan. The bulk POST is
atomic, and the tail is re-planned each step from the frozen plan and a fresh read, so a per-row queue
would be state with nothing to remember. #177 is already **closed, unmerged**.

## 4. Gates

| Gate | Result |
|---|---|
| `node scripts/shard-runner.mjs` (run 1, after the backend commit) | 4/4 green — 521 + 653 + 704 + 614 = **2492 tests, 2489 pass, 0 fail, 3 skipped** |
| `node scripts/shard-runner.mjs` (run 2, final backend code) | 4/4 green — 521 + 653 + 704 + 614 = **2492 tests, 2489 pass, 0 fail, 3 skipped** |
| backend hyg + transport tests after the last change | **225/225** |
| `pnpm run check` | clean |
| `pnpm run test` | **108 files passed, 19 skipped; 1733 tests passed, 116 skipped** |
| `hyg-contract-bundle.test.ts` (bundle drift) | passes; bundle regenerated with the pinned esbuild |
| `node --check server.js` | clean |
| Real Postgres 16 rehearsal, as `carein_app` | **48/48** (§6d adds 17 checks for `hyg_perio_send`) |

The rehearsal's first run was **47/48**, and the failure was real information: jsonb reorders object
keys, so the frozen plan's `strings` comes back `LowerFacial, LowerLingual`. Harmless — it becomes an
object body whose key order means nothing, and `arches` is an array — so the check was corrected, not
the code.

No shard died with the Node 22 deserialize flake on either run.

## 5. Screenshots — `docs/screenshots/hyg/`, 1180 wide, light and dark

| File | Shows |
|---|---|
| `hyg-perio-send-06-confirm` | the confirm: each arch's path in words — upper jaw one request, lower facial row by row because *#30 DB reads 10 mm or more*, lower lingual with it |
| `hyg-perio-send-07-paused` | rows going in, Open Dental did not answer: Continue, or delete the exam instead |
| `hyg-perio-send-08-written` | *every site read back and matching*, the chart locked |
| `hyg-perio-send-09-incomplete` | red: *Exam 7001 is in Open Dental and INCOMPLETE*, the sites listed, #19 marked on the grid, the delete button |
| `hyg-perio-send-10-delete` | the delete dialog, the button disabled until the tick |
| `hyg-perio-send-11-tray-stopped` | the visit's tray pointing at the stopped send |

`hyg-perio-01…05` were re-shot: 02 and 05 carry the new staged-chart wording ("not built yet" is gone).

## 6. Staging rehearsal plan — for Beau

On roland 12827 or 12828 only. **A Probing row can never be deleted on its own; deleting the exam is
the only cleanup**, and each rehearsal exam is dated the visit's day, so it becomes the fixture's "last
charted" until it is deleted.

1. **A full 32-tooth chart, every depth 0–9, no skipped tooth.** Confirm dialog must say *One request*
   for all four arches. Expect ONE `POST /perioexams` in the `[hygperio]` line (`arches=4 rows=0`),
   then *Written… every site read back and matching*. Compare the exam in Open Dental's perio chart by
   eye against the page.
2. **The same, with one site at 12 mm.** The dialog names it; expect `arches=2 rows=16` and Written.
3. **A partial chart with a gap mid-arch** (keep it small: one quadrant with one site left blank).
   Expect that jaw row by row, and Open Dental showing the blank site blank, not 0.
4. **A deliberately unfinished send, then the undo.** Staging has no clean way to make Open Dental
   return a wrong reading, so rehearse the undo on a send that stopped part-way — the same guard, the
   same DELETE. Stage a chart whose upper jaw goes row by row (a 12 mm site on #3 is enough: 16 rows,
   about 20 seconds), confirm, and **close the tab within ten seconds**. Reopen the chart: it says
   *Paused*, with **Continue** and **Delete exam N instead**. Delete, tick, confirm (if it says the
   send is writing right now, wait a few seconds for the closed tab's last step to finish). Expect the
   exam gone from Open Dental's perio chart, the `[hygperio]` and audit trail showing one DELETE, and
   the chart back on the list. The *incomplete* screen itself (a read-back mismatch) is covered by
   `hygPerioSend.test.js` › ACCEPTANCE 6 and shot 09, not by staging.
5. **Cleanup.** An exam from a send that finished *Written* cannot be deleted from the page (by
   design). Delete those with the probe's fixture-guarded cleanup:
   `HYG_PROBE_OFFICE=roland HYG_PROBE_PATNUM=12828 node scripts/probe-hyg-perio-arch.js --cleanup <n> --force-cleanup`
   (it refuses any exam that is not that fixture's).

## 7. Decisions worth a second look

- **The jaw rule** (§2) — stricter than the brief; no string the brief allows is sent that it forbids.
- **The 48-character reading** (§2).
- **Skipped molars push charts row by row** (§2). If that turns out too slow in practice, the next
  question for a probe is whether Open Dental's parser skips a tooth already marked SkipTooth *in the
  same exam* — which would need the SkipTooth rows written first. Untested, so not built.
- **Untested by the probe:** whether the arch-string parser consults teeth marked missing in the
  patient's tooth chart (12828 had none). If it does, a string would shift — and the read-back would
  catch it and stop as incomplete, with the undo. Worth one rehearsal on a patient with a missing tooth.
- **An exam POST answered OK but absent from the list afterwards stops as `incomplete`** rather than
  pausing, because a pause would re-post and create a second exam.
- **A chart whose flagged-but-uncharted site** reads back — BleedSupPlaqCalc values are compared as
  flags, so 0 and -1 both mean "no flags".
- `OD_REFUSED`, `OD_NO_ANSWER`, `OD_DELETE_UNCONFIRMED` and the new send codes are added to
  `HYG_VISIT_ERROR_CODES`; `PERIO_SEND_NOT_BUILT` is renamed `PERIO_SENDS_FROM_ITS_CHART`.

## 8. Commits

```
24173cc Add the one DELETE the Open Dental transport allows: a perio exam
2a405a5 Plan the perio send from the arch-string table the probe measured
5cdfe89 Send a staged perio chart: exam with strings, per-row tail, read-back, undo
c41c078 Confirm, follow and undo a perio send from the chart page
ce8ad09 Photograph the perio send: confirm, paused, written, incomplete, undo, tray
16ebe85 Document the perio send, rehearse its table on Postgres, record the probe
```

## 9. Push / PR

Pushed. **PR #179** — `feature/hyg-perio-send-v2` → `develop`:
https://github.com/bsparkma/retell-ai-dashboard/pull/179

Independent of every open branch; #176 and #178, which it builds on, are merged. PR #177 is closed,
unmerged (§3). The staging rehearsal in §6 needs this deployed to staging.

Commit `7400737` (after §8's list) adds the paused-send undo button and this report.

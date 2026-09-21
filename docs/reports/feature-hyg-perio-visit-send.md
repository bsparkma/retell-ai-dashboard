# 15 — A staged perio chart rides the visit Send

Branch `feature/hyg-perio-visit-send`, off `origin/develop` at `b66927e` (#181 merged).
Worktree `C:\Users\beau\carein-wt\hyg-perio-visit-send`. Push/PR status is in §7.
Item 14 (`14-hyg-perio-drift.md`) was not started.

---

## 1. Acceptance

| # | Criterion | Proven by | Result |
|---|---|---|---|
| 1 | Stage a chart, go to the visit: the tray shows it riding Send; the "leaves it here" copy is gone | `hyg-visit-perio-send.test.tsx` › *the tray*: `hyg-perio-rides-send` is shown, the tray text contains neither "leaves it here" nor "sent from its own page", `hyg-perio-not-sent` no longer exists, and Send counts 2 (note + chart). Screenshot `hyg-perio-05-tray` | ✅ |
| 2 | ONE dialog lists the perio unit with sites count, exam date and provider, beside the other kinds | › *the one dialog*: exactly one `hyg-confirm-send`, listing note and perio; the perio line reads `84 of 192` · `2026-09-08` · `HYG1 (ProvNum 7)`; the request carries `{kind:'perio', previewFingerprint, examDate, provNum}`. Backend: `hygVisitPerioSend.test.js` › *ACCEPTANCE 1+2* (exam posted with the confirmed date and ProvNum 7) and › *ACCEPTANCE 2* (a different date → `EXAM_DATE_CHANGED`, a different provider → `PROVIDER_CHANGED`, both refusing the whole send with zero writes; a perio confirmation without them → 400). Screenshot `hyg-perio-05b-visit-confirm` | ✅ |
| 3 | A drifted perio fingerprint refuses the whole send with `PREVIEW_CHANGED`; nothing written by ANY unit | `hygVisitPerioSend.test.js` › *ACCEPTANCE 3*: note + slip + drifted chart → 409 `PREVIEW_CHANGED`, `od.writes` empty, all three rows still `Staged`, no send row recorded. The reverse too: a drifted NOTE with a good chart → the chart is not claimed. UI: › *ACCEPTANCE 3* (refusal beside Send, no step requested) | ✅ |
| 4 | Note lands, perio fails: note `Written`, perio `Failed` with its reason, honest on both pages | › *ACCEPTANCE 4*: Open Dental refuses the exam → note `Written` with its GroupNote ref, perio `Failed` / `PERIO_SEND_STOPPED` / "Open Dental refused this perio exam - …"; `GET /perio/send` (the chart page) reads `refused` / `Failed`; Retry restages it. UI: › *ACCEPTANCE 4* (each row its own pill and reason, perio keeps Retry) | ✅ |
| 5 | Perio reaches OD only through the existing writer; the guard proves it (non-vacuity) | `hygNoOdWrites.test.js` › *item 15: the visit send reaches a perio chart ONLY through perioSend*: `sendVisit.js` names no write transport, no perio endpoint, no writer function — and DOES require `./perioSend` and call `startPerioSend(` and `stepPerioSend(`, so dropping the chart from the Send fails it. Behavioural half: `hygVisitPerioSend.test.js` › *ACCEPTANCE 5* spies the writer's three functions and asserts every perio write the visit Send caused went through them (exam + rows, count equal to the transport's perio writes, > 1). `OD_WRITE_LAYER` unchanged | ✅ |
| 6 | Every site read back before `Written` — unchanged, asserted | › *ACCEPTANCE 6*: one ordered log shows `POST exam 7001` then `GET measures (perio Sending)` — the read-back happened while the row still said Sending — and only then `Written`. A site Open Dental holds differently (#3 DB) → perio `Failed` naming the site, `incomplete` on the chart page with the undo offered, the note unaffected | ✅ |
| 7 | Retry on a failed perio unit resumes; an exam created by the interrupted send is not duplicated | › *ACCEPTANCE 7*: the exam POST lands and its answer is lost → perio `Sending` / `PERIO_PAUSED`; a second visit Send is refused (`NOT_STAGED`); Retry (the chart's step route) adopts exam 7001 → `Written`, **one exam POST ever, one exam in Open Dental**, the note not re-written. UI: › *resuming* (Retry calls the step, never a second visit send, never a restage) | ✅ see §3.2 |
| 8 | `Amending`, `Draft`, in-flight, `Written` excluded from the visit Send and refused server-side | › *ACCEPTANCE 8*: Draft → 409 `NOT_STAGED`; Sending → 409; Written → 409; Amending (opened via `/perio/amend`) → 409; a STAGED correction → 422 `PERIO_SENDS_FROM_ITS_CHART` ("a correction to exam 7001 … is sent from the chart page"), left `Staged`; zero writes after the first send. UI: Draft/Amending/Written never counted, a correction shows `hyg-perio-correction` and is not counted | ✅ |
| 9 | A send in flight (from either page) shows on both; the visit Send cannot start a second | › *ACCEPTANCE 9*: started on the chart page and paused → the visit reads the row `Sending` and `GET /perio/send` reads `posting`; the visit Send with the chart → 409, the note alone still sends, still ONE send row. Started from the visit → the chart page reads `posting`/`Sending`, and its own Send → 409 `PERIO_SEND_IN_PROGRESS`. UI: the row says "Being sent, and not from this page", the dialog does not list the chart, Retry picks up the SAME send | ✅ |
| 10 | Pressing the visit Send twice cannot double-write any unit | › *ACCEPTANCE 10*: in sequence → second is 409, write count unchanged; **at once** (`Promise.all`) → one 200 and one 409, one note, one exam POST, one exam, one send row. UI: a second press while the first send is running opens nothing; one request | ✅ |

Gates: `node scripts/shard-runner.mjs` **4/4 green** (2516 tests, 2513 pass, 0 fail, 3 skipped);
`node --check server.js` ok; `pnpm run check` clean; `pnpm run test` 109 files / 1749 tests pass
(19 files skipped — the screenshot suites, which ran separately with `HYG_SHOTS=1`, 16/16).
`hyg-contract-bundle.test.ts` passes on the regenerated bundle. No `any` added.

## 2. The design

### 2.1 One more unit, not one more writer

`services/hyg/sendVisit.js` now treats a staged chart as a unit with its own state, reason and
reference. It never touches a perio endpoint. It calls `perioSend.js`, the only path a chart takes to
Open Dental:

```
check      every confirmation: staged, fingerprint matches           (unchanged, now incl. perio)
perio      a live exam on this chart? → 422 PERIO_SENDS_FROM_ITS_CHART (a correction)
confirm    perioSend.startPerioSend: fingerprint + recomposed preview + exam date + provider,
           no send in flight, no incomplete exam left; freezes the plan, claims the row.
           WRITES NOTHING TO OPEN DENTAL — any refusal refuses the whole batch.
note       ┐
slip       ├ unchanged: same order, same code, same outcomes
handoff    ┘
perio      perioSend.stepPerioSend — the first bounded step, in this request
```

The perio **confirm** runs before any unit writes, so every refusal it can give costs nothing
anywhere — the promise acceptance 3 asks for, extended to the exam date and provider. The perio
**writes** go last: the chart is by far the longest unit, and appending it leaves note → slip → TC
exactly as they were.

### 2.2 Steps: the first here, the rest from the page

A chart the arch strings can say (the normal case) finishes in the visit's own request: the exam,
then every site read back. A chart that needs rows (a reading of 10+, a gap) comes back `Sending`,
and the visit page asks for the rest through the chart's existing `POST /perio/send/step` — the same
loop the chart page runs, so every write still happens inside a request the confirming person made.
Leaving the page pauses; nothing is lost.

The outcome for the chart is read from its row after the step, not inferred:
`Written` (with the read-back reference), `Failed` (`PERIO_SEND_STOPPED`, the send's own reason), or
`Sending` (`PERIO_PAUSED` with the reason when Open Dental did not answer; `code: null` when there are
simply more steps). A step that throws leaves the chart `Sending` — every write is recorded before it
is attempted, and the next step reads before it writes.

### 2.3 The contract

`SendConfirmationSchema` becomes a union: the three existing kinds exactly as before, and a perio
variant that also requires `examDate` and `provNum` (the same two `PerioSendRequestSchema` carries).
Both `.strict()`. `HygSendResponseSchema` is unchanged in shape; its comments now say a perio
outcome may be `Sending`. `backend/hyg/contract.gen.cjs` regenerated with the pinned esbuild and the
`--alias:zod`. **No migration** — no state was added.

### 2.4 Audit

A chart that rides the visit Send is audited exactly as the chart page audits its own send: the
confirmation as `UPDATE hyg_perio_send`, then one row per Open Dental write the step attempted
(`CREATE hyg_perio_send`, SUCCESS/ERROR). It is **not** also given a `hyg_visit_send` row — its writes
are its rows. The note, slip and handoff are audited as before.

## 3. Decisions worth checking

### 3.1 The perio page's Send stays

It is the same send surfaced in two places. Both go through `startPerioSend`, whose row claim and
`PERIO_SEND_IN_PROGRESS` check mean only one can ever start. After Stage the chart page now says
the chart "will go with the visit's Send … or send it from here now", with a **Back to the visit to
send it with everything else** button (`hyg-perio-to-visit`). A correction is not offered that
button. Screenshot `hyg-perio-05c-staged-to-visit`.

### 3.2 "Retry" on the perio row is two acts, chosen by the row's state

The brief says a *failed* perio row keeps a Retry that *resumes* and must not create a second exam.
Under the existing machinery those are two different rows:

- **`Sending`, stopped short** (Open Dental did not answer, the page was left, or the send was started
  on the chart page): Retry calls the chart's step route. It **resumes the same send**, reads Open
  Dental first, and adopts an exam the interrupted send created. This is acceptance 7's scenario and
  the one the fake models (`landed: true` on the exam POST).
- **`Failed`** (Open Dental refused the exam, or the read-back did not match): Retry is the existing
  restage, which the server allows only when that send left nothing in Open Dental (`canRestage`).
  An incomplete exam still in Open Dental → 409 `PERIO_EXAM_EXISTS`, shown beside the row, with the
  chart page's delete as the way forward. So neither path can put a second exam in.

Before this item the tray offered **no** Retry on a perio row at all (only "Open chart"); both are
now there, beside the link.

### 3.3 What the visit page can and cannot know about the other page

The visit page cannot tell whether the chart page is stepping *right now*. For a `Sending` chart it
does not own, it says "Being sent, and not from this page right now" and offers Retry. Retry is safe
while the other page is running: the step's lease answers "Another tab is writing this chart right
now. Nothing was sent from here." The chart page's own paused status now reads "Paused here. Nothing
is being written from this page right now." for the same reason (it used to say nothing was being
written at all, which is false when the visit page is stepping).

### 3.4 Fail closed on the chart's own record

Whether a staged chart may ride Send depends on its record (a live exam = correction; a send in
flight). The visit page reads `GET /perio/send` and `GET /perio` when the visit has a chart; until
they answer — or if they fail — the chart stays out of Send and the row says it is still checking
(`hyg-visit.test.tsx` pins this). The server enforces all of it regardless.

### 3.5 Small UI changes outside perio

- A 422 refusal of the whole visit Send now shows beside the Send button (like a 409) rather than as
  a page error. Only perio produces one in practice (`PERIO_SENDS_FROM_ITS_CHART`).
- The empty-tray hint names the perio chart among the things that can be sent together.

No change to the order, payloads, outcomes or retry of the note, slip or TC units.

## 4. Hard rules

| Rule | Where |
|---|---|
| Perio OD writes only in `odPerioWriter.js` | `OD_WRITE_LAYER` unchanged; new non-vacuous source guard + behavioural spy (acceptance 5) |
| Read-back before any `Written` | unchanged in `perioSend.verify`; asserted through the visit Send (acceptance 6) |
| No site written as 0 for uncharted; depth ≥10 never in an arch string | unchanged planner (`planPerioSend`); the spy test's 11 mm site went row by row |
| No new OD verb; no `PUT /periomeasures` | none added; `sendVisit.js` names no transport |
| Office derived server-side, office + PatNum keyed | the send route's `resolveAppointment` → `assertOfficeMatch`, unchanged; perio re-derives provider and date from it |
| Contract regen + sync test | regenerated; `hyg-contract-bundle.test.ts` green |
| Migration if state added | none added |
| TC / RCM / `backend/platform/` untouched | `git diff origin/develop --name-only` touches none |
| Test patients only | roland 12827 throughout |

## 5. Files

Backend: `services/hyg/sendVisit.js` (the unit), `routes/hyg/visit.js` (perio audit on the visit
send), `services/hyg/stagedWriteComposer.js` (stale comments), `hyg/contract.gen.cjs` (regen).
Tests: new `routes/hyg/hygVisitPerioSend.test.js` (10 tests); `hygNoOdWrites.test.js` (new guard; the
"every perio path writes nothing" case now drives a STALE confirmation, since a current one writes);
`hygPerio.test.js` (the old whole-batch `PERIO_SENDS_FROM_ITS_CHART` refusal became a stale-fingerprint
`PREVIEW_CHANGED` refusal).

Dashboard: `shared/hyg/contract.ts`; `features/hyg/visit/StagedWritesTray.tsx`;
`pages/hyg/HygVisit.tsx`; `pages/hyg/HygPerio.tsx`; `features/hyg/perio/PerioSendConfirm.tsx`
(`perioProvNumOf`, moved here so both pages use one copy of the server's provider rule);
`features/hyg/perio/PerioSendPanel.tsx` (paused copy). Tests: new `hyg-visit-perio-send.test.tsx`
(11 tests); `hyg-visit.test.tsx`, `hyg-perio-page.test.tsx`, `hyg-perio-shots.test.tsx` updated.

Screenshots (`docs/screenshots/hyg/`, light + dark): new `05b-visit-confirm`, `05c-staged-to-visit`;
re-shot where the copy changed: `02-partial-staged`, `05-tray`, `send-06-confirm`, `send-07-paused`,
`send-11-tray-stopped`.

## 6. Not verified

- **Not exercised against staging Open Dental.** Every perio write here goes through the same
  `perioSend.js` path item 12 proved live; what is new is the orchestration, tested against the
  probe-table fake. A staging walk with fixture 12827 is worth doing after merge: stage a note and a
  full chart, one Send, check one exam and one GroupNote land.
- No real-Postgres rehearsal: no schema or state change, and the store calls used are the ones items
  12 and 13 rehearsed.

## 7. Push / PR

Pushed to `origin/feature/hyg-perio-visit-send`. PR into `develop`: see the PR line appended below.
Not merged.

PR: **#182** — https://github.com/bsparkma/retell-ai-dashboard/pull/182 (base `develop`, open, not merged).

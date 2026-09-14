# 11 — The perio send: resumable, confirmed, and impossible to half-lie about

Branch `feature/hyg-perio-send`, **stacked on `feature/hyg-perio-workspace` (PR #176)**, which was
unmerged when this was built. Worktree `C:\Users\beau\carein-wt\hyg-perio-send`.

> **CI trap, from the queue README:** stacked PRs do not auto-retarget. When #176 merges, retarget
> this PR to `develop` with `gh api -X PATCH repos/bsparkma/retell-ai-dashboard/pulls/<n> -f base=develop`
> and close/reopen it so `build-test` runs against develop.

PUSH/PR STATUS is in §10.

---

## 0. Read this first — a premise in the brief that H0 contradicts

The brief says *"THERE IS NO BULK WRITE. A full chart = 60–100+ requests."* That is true of
`/periomeasures` and of a chart that includes recession, mobility and furcation. **For v1's locked
scope — probing plus the four flags — H0 documents a bulk write** (`docs/HYG_SPIKE_H0_OD_COVERAGE.md`
lines 112–118): arch strings `UpperFacial` / `UpperLingual` / `LowerLingual` / `LowerFacial` on
`POST /perioexams`, digits for depths and `b s p c` for the flags, *"One request charts probing +
all four flags for a whole arch."*

**I built what the brief specified** — per-row `POST /periomeasures` under a resumable, read-back
queue — because the brief calls the design non-negotiable and the arch strings are **docs-only,
never exercised**, with open questions a chart cannot afford to guess at (how 10–19 mm is encoded,
whether SkipTooth is expressible, whether one arch string is atomic or can half-land). But if the
arch strings hold, a v1 chart is one or four requests instead of ~80, and most of this machinery
is protecting a problem v1 does not have. **That is a PM decision, and it is worth making before
this merges**, not after. A read-only probe of the arch-string encoding is not possible — it is a
write — so the honest next step is a single rehearsal POST against a staging test patient, with
Beau watching.

---

## 1. Acceptance

| # | Criterion | Proven by | Result |
|---|---|---|---|
| 1 | Kill-and-resume: no row sent twice, no row lost | `routes/hyg/hygPerioSend.test.js` — **KILL AND RESUME (1)** a row that landed without answering; **(2)** the process dies after the exam header lands (adopted, not re-posted); **(3)** the process dies between a measurement and its record. Each asserts per-row POST counts of exactly 1 and the final Open Dental row set complete and unique | ✅ |
| 2 | Fingerprint gate: edited chart after confirm ⇒ PREVIEW_CHANGED | **FINGERPRINT GATE** — read, edit + re-stage in "another tab", confirm the old fingerprint ⇒ 409 `PREVIEW_CHANGED`, zero Open Dental writes, no queue planned. The server also recomposes the preview from the stored chart and refuses if *that* differs | ✅ |
| 3 | Every write inside OD_WRITE_LAYER; allow-list test grew | `OD_WRITE_LAYER` = `['odWriter.js', 'odPerioWriter.js']`; `hygNoOdWrites.test.js` → *every allow-listed writer is REAL, and each owns its own endpoints* (list and ownership map must grow together); *perio endpoints are named in code only by the reader and the perio writer* | ✅ |
| 4 | Read-before-resend proven (write-count asserted) | **READ BEFORE RESEND** — a refused `#4 Probing` halts; resume ⇒ `#4 Probing` posted **2** times (the refusal did not land), every other row **1**, exam header **1**. KILL AND RESUME (1)/(3) assert the landed row is posted **1** time | ✅ |
| 5 | CAL never written; ProvNum explicit; flags map to BleedSupPlaqCalc | `odPerioWriter.test.js` → *CAL is never written…* (CAL, GingMargin, Mobility, Furcation, MGJ refused before the transport); *the exam header always carries an explicit ProvNum*; migration CHECK refuses `sequence_type = 'CAL'` on a real Postgres; send test asserts exam body `{ PatNum, ExamDate, ProvNum: 7 }` (the hygienist) and `#3 BleedSupPlaqCalc DB = 1`; `NO_PROVIDER` writes nothing | ✅ |
| brief 7 | OPENDENTAL_WRITE_DISABLED honored | `odPerioWriter.test.js` → against the **real** `OpenDentalService.apiWriteRaw`: refused `OD_WRITE_DISABLED`, the HTTP client never reached. Route test: the refusal halts the send on the exam header | ✅ |

## 2. Gates

| Gate | Result |
|---|---|
| `node --check server.js` and every new backend file | clean |
| `node scripts/shard-runner.mjs` | **4/4 green** — 550 + 679 + 656 + 585 = **2470 tests, 2467 pass, 0 fail, 3 skipped** |
| `pnpm run check` | clean |
| `pnpm run test` | **107 files passed, 20 skipped; 1710 tests passed, 115 skipped** |
| `tests/hyg-contract-bundle.test.ts` | green — `backend/hyg/contract.gen.cjs` regenerated with the pinned esbuild + `--alias:zod` |
| Real Postgres 16 as `carein_app` (`scripts/rehearse-hyg-visit.js`) | **39/39** — 8 new send-queue checks (§4) |

---

## 3. Design

### Steps inside requests, not a background thread

A full chart is minutes of writes; an HTTP request is not. The page confirms once, then calls
`POST …/perio/send/step` in a loop. **Each step is a bounded batch (12 rows) inside an ordinary,
authenticated, audited request**, so every Open Dental write is attributed to the person making it
(one `hyg_perio_send` audit row per write, success or failure) and none happens on a thread nobody
is watching. RCM's drain runs in-process and its own header says a second replica makes it unsafe
without a row lease; this design has the lease from day one and needs no startup sweep.

**"Safe to leave" is true:** every row's state is on the server before its write goes out; leaving
stops the page asking for steps; Resume reads Open Dental before it posts anything. What leaving
does NOT do is keep sending — the page says "Leaving pauses the send", not "it finishes without you".

### The queue — `hyg_perio_send_row` (migration `1788400000000`, with the `carein_app` GRANT)

One row per write. seq 0 is the exam header; measurements follow from the shared
`perioMeasureRows(chart)`: **SkipTooth** for a skipped tooth, **Probing** where any depth (`-1`
where not charted), **BleedSupPlaqCalc** where any flag (0–15 per site), **nothing** for an
untouched tooth — a partial chart writes a partial exam.

`pending → sending → sent → confirmed`, or `failed`. CHECKs written long-hand so NULL cannot pass:
a measurement's tooth and type are tested `IS NOT NULL` before their ranges; `failed` needs a
reason; `confirmed` needs `od_ref` and `confirmed_at`. A partial unique index refuses a second plan
for the same (tooth, SequenceType). Composite FK to the visit on `(visit_id, office)`.

### Read before write — the whole of the safety

| A step's read shows | The row is |
|---|---|
| present, same values | **confirmed without posting** — it landed last time |
| present, different values | **halted** — never a second row beside it |
| absent, after an OK | **halted** — accepted-but-missing is not guessed at |
| absent, never answered | posted, once its claim's lease has lapsed |

- **Nothing is posted on a truncated read.** A row missing from half a list is not missing from the chart.
- **The exam header:** the patient's exam numbers are recorded just before the POST; a resumed send
  adopts the ONE new exam with that date and provider. Two new ones ⇒ halt, never a guess.
- **The claim** (`claimed_at`, lease 120 s — longer than the 30 s write timeout plus read-back)
  makes two tabs safe: *two tabs stepping the same send at once never write a row twice* (64 rows,
  64 POSTs).
- **Open Dental's answer is three-way** (`odPerioWriter.js`): *ok* (not yet the claim), *refused*
  (4xx, `OD_WRITE_DISABLED` — halt, words beside the site), *uncertain* (no answer, 5xx, 408 —
  pause; it may have landed). Collapsing uncertain into refused is exactly how a retry writes a
  permanent second Probing row.

### Honest states

- The staged write is **Written** only when the header and every row are confirmed:
  `Perio exam 7001: 64 rows read back`, `sent_by` = the person who confirmed.
- A refusal ⇒ staged write **Failed**, the failed row's error beside it, the tooth number marked in
  the grid. The chart is **locked**: no edit (409), no re-stage, and the generic retry answers
  `PERIO_USE_RESUME` — Failed → Staged would make a chart editable while rows of it are permanent.
- Resume ⇒ failed rows back to pending, and they are READ before they are posted.
- `[hygperio] office=roland exam=7001 rows=10 confirmed=10 failed=0 ms=…` per step (pinned by test).

### The confirm gate

`POST /visit/:aptNum/perio/send?date=` carries `{ previewFingerprint, examDate, provNum }` and no
payload. Refusals before any write: `PREVIEW_CHANGED`, `EXAM_DATE_CHANGED`, `NO_PROVIDER`,
`PROVIDER_CHANGED`, `PATIENT_CHANGED`, `PERIO_SEND_IN_PROGRESS`. ProvNum is the appointment's
hygienist, else its provider — never Open Dental's default (the patient's primary). The dialog
shows the exam date, provider + ProvNum, sites, flags, skipped teeth, row count, time, the
server's preview lines, and that a probing row cannot be deleted.

The tray's batch Send refuses a perio confirmation (`422 PERIO_SENDS_FROM_ITS_CHART`) — renamed
from slice 10's `PERIO_SEND_NOT_BUILT`, same whole-batch refusal.

### Progress UI

Rows read back / total, sites read back / total, a progress bar, *"About N minutes left, at Open
Dental's one request a second"* (`estimatePerioSendRequests`: a POST per row, a read before and
after each batch, three for an unconfirmed header), the safe-to-leave sentence, the pause reason,
the halt message, each failed row with Open Dental's words, and Resume.

---

## 4. Real Postgres — 39/39 as `carein_app`

`backend/scripts/rehearse-hyg-visit.js` §6d, against migrated Postgres 16: planning twice plans
once; a NULL tooth, a CAL row, a failure with no reason and a confirmation with no Open Dental
number are each refused **by their named constraint**; a second plan for the same measurement is
refused by the partial unique index; a claim is exclusive while fresh, re-claimable once lapsed and
never across offices (`claimed_at < $3` on a real clock); a confirm keeps the `od_ref` its send
recorded, bigint back as a number; deleting the visit cascades the queue.

## 5. Staging rehearsal plan — for Beau to execute

**Test patients only: roland 12827 or 12828. A Probing row cannot be deleted from Open Dental, so
keep every rehearsal chart to ONE QUADRANT (#1–#8), and use a DIFFERENT appointment date for each
run** — each run creates a new exam that stays in that patient's perio history (only
`DELETE /perioexams` removes one, and this app never calls it).

Before: staging deploy of this branch; `hyg` entitled for the staging tenant; roland's hygiene
switch on; `OPENDENTAL_WRITE_DISABLED` unset on staging (confirm, then put it back after); a
hygiene appointment for 12828 on the chosen date with a hygienist set.

1. **Partial send, clean.** Open the appointment → Perio chart. Chart #2–#5 only (24 sites), bleeding
   on two sites, skip #1. Stage. Send → confirm dialog shows the date, the hygienist + ProvNum, 24
   sites, rows = 1 SkipTooth + 4 Probing + BleedSupPlaqCalc rows. Confirm. Watch it reach "Written to
   Open Dental: exam N, every row read back".
   **Verify in Open Dental:** Chart → Perio for 12828 on that date: #2–#5 depths exactly as entered,
   bleeding dots where set, #1 marked skipped, #6–#32 empty. Container log: one `[hygperio]` line
   per step, `failed=0`.
2. **Kill the tab mid-send.** New appointment date. Chart #2–#8 fully (42 sites, ~7 Probing rows) —
   still one quadrant. Stage, Send, confirm, and **close the tab the moment the progress panel shows
   1–2 rows read back.** Wait 30 s. Reopen the chart: the panel shows *Paused*, the counts where it
   stopped, and **Resume**. Press Resume; let it finish.
   **Verify in Open Dental:** each of #2–#8 appears ONCE in that exam — no tooth doubled, none
   missing — and there is ONE exam on that date, not two.
3. **Kill the container mid-send** (optional, harsher). Same as 2, but restart the container
   instead of closing the tab. Wait **2 minutes** (the claim lease) before Resume, so a row
   interrupted mid-POST is re-read rather than skipped. Same verification.
4. **Stale confirm.** Stage a chart, open the confirm dialog, then in a second tab change one
   reading and re-stage. Confirm in the first tab ⇒ *"The perio chart changed since you read it.
   Nothing was sent."* **Verify:** no new exam in Open Dental.

Afterwards, record the exam numbers created (they are permanent test data on 12828).

## 6. Screenshots

`docs/screenshots/hyg/`, 1180 wide, light and dark, from `tests/hyg-perio-send-shots.test.tsx`
through the unchanged `scripts/shoot-hyg.mjs`.

| Shot | Shows |
|---|---|
| `hyg-perio-send-01-confirm-1180x900-*` | the confirm dialog: date, provider + ProvNum, sites, flags, rows and time, the preview, "cannot be deleted" |
| `hyg-perio-send-02-writing-1180x900-*` | mid-send: rows read back, time left, safe to leave; readings locked |
| `hyg-perio-send-03-stopped-1180x900-*` | halted: Open Dental's words, the failed row listed, tooth #4 marked, Resume |
| `hyg-perio-send-04-written-1180x900-*` | every row read back |
| `hyg-perio-send-05-tray-1180x1200-*` | the visit tray while the chart is being written |

## 7. Files

- `backend/migrations-tenant/1788400000000_hyg_perio_send.js` — the queue table
- `backend/services/hyg/odPerioWriter.js` — the writer (in `OD_WRITE_LAYER`)
- `backend/services/hyg/perioSendStore.js` — queue SQL, office in every WHERE
- `backend/services/hyg/perioSend.js` — confirm, step, resume, progress view
- `backend/services/hyg/odPerio.js` — `readExams` / `readExamMeasures` split out (same guards)
- `backend/routes/hyg/visit.js` — `GET|POST /perio/send`, `POST /perio/send/step|resume`; retry refuses perio
- `new-dashboard/shared/hyg/perio.ts` — `perioMeasureRows`, send schemas, the estimate
- `new-dashboard/client/src/features/hyg/perio/PerioSendConfirm.tsx`, `PerioSendPanel.tsx`; `HygPerio.tsx` drives the loop and locks the chart
- Tests: `hygPerioSend.test.js` (12), `odPerioWriter.test.js` (6), `perioSendSchema.test.js` (6), `hygNoOdWrites.test.js` (grown), `hygVisitGuard.test.js` (+3 mutations), `hyg-perio-page.test.tsx` (+3)
- `docs/HYG_MODULE.md` §13

## 8. Decisions worth a second look

1. **§0 — the arch strings.** The biggest one.
2. **A different existing row halts rather than PUTs a correction.** `PUT /periomeasures` exists and
   could fix it, but overwriting a clinician's value in Open Dental on CareIN's say-so is a
   different product decision from "do not add a second row".
3. **Leaving pauses.** A server-side drain would keep going after the tab closes, at the cost of
   writes with no requesting user, a startup sweep, and the maxReplicas=1 dependency RCM's drain
   documents. Chosen against; easy to revisit because the queue and the step are already separate.
4. **After a send, "most recent exam" is today's.** Reopening the chart after a Written send shows
   today's own numbers as "last charted" (slice 10 decision 2). A "newest exam before this visit"
   rule is a small follow-up.
5. **Estimated time** counts one read per batch page; a chart with more than 100 measurement rows
   adds a page read per step the estimate does not count, and the screen says "about".

## 9. Not done

- The staging rehearsal (§5) — needs Beau and a staging deploy.
- The arch-string alternative (§0) — needs a decision and a watched write.

## 10. Push / PR

Pushed. **PR #177** — `feature/hyg-perio-send` → `feature/hyg-perio-workspace` (stacked on #176):
https://github.com/bsparkma/retell-ai-dashboard/pull/177

When #176 merges, retarget and re-run CI:

```bash
gh api -X PATCH repos/bsparkma/retell-ai-dashboard/pulls/177 -f base=develop
gh pr close 177 && gh pr reopen 177
```

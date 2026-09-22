# Item 21: a patient with no visit notes can receive their first one

Branch `feature/hyg-note-first-note`, off `origin/develop` at 9bf52f5. PR to `develop`, not merged.
This item runs after item 20 (#189), which touches the same send path.

## 0. Read this first: the one stuck note belongs to a real patient

Item 21's acceptance 4 says: *"The stuck Failed note on 12827 retries to Written on staging."* The #185 log sweep (every `[hygsend]` line on staging, 21 days) shows **no failed note on any 12827 visit.** The only notes stuck on `NOTE_PRECHECK_UNAVAILABLE` are the two 2026-09-21 sends on **apt 105887, whose patient is not a test patient.** That is the same incident item 20 exists for.

**Once this fix is on staging, pressing Retry on apt 105887's note would write a real visit note into a real patient's chart.** Until today the precheck bug is what has been stopping it.

- **Merge #189 (item 20) first, or in the same deploy.** With #189 on staging, that Retry, and the send after it, are refused with `HYG_TEST_PATIENTS_ONLY`. I checked it: #189's gate runs in `sendVisit()` and in the retry route, ahead of the note precheck this item changes.
- Without #189, nothing in the app prevents it.
- Staging acceptance 4 is therefore **not done**. It needs this code on staging, which means a merge I may not make. The post-merge check is in §6. It has to use a **new** 12827 visit, because no stuck 12827 note exists to retry.

## 1. What Open Dental says for "no notes" (acceptance 1)

Captured **before any code changed**, from roland **12827** (a test patient whose item-15 note never landed). The read ran inside the staging container, revision `ca-carein-backend--0000191`, at **2026-09-22T00:35:10Z**:

```
GET /procedurelogs/GroupNotes?PatNum=12827
→ HTTP 404
→ No GroupNote(s) found for PatNum 12827.
```

- **Status:** 404.
- **Body:** a plain string, exactly as `apiGetRaw` passes it to the caller in `data`. For an object body, `apiGetRaw` would have logged it JSON-stringified, and the logged text has no braces or quotes.
- **Timing:** answered in well under a second, as item 16 measured.
- **Committed as** `new-dashboard/tests/fixtures/od-groupnotes-none-staging.json`.

**How it was read:** with the already-deployed `backend/scripts/diag-hyg-groupnotes.js`, which is read-only and fixture-guarded:

`az containerapp exec … --command "env HYG_PROBE_OFFICE=roland HYG_PROBE_PATNUM=12827 node /app/scripts/diag-hyg-groupnotes.js"`

**Two reads, not one.** The first run's output was lost when the az CLI crashed (cp1252) on the script's box-drawing characters, so I ran it again with the output filtered down to the ASCII `HTTP …` line inside the container. Both runs gave the same answer. Each run also read `/procnotes?PatNum=12827`, which is part of what that script does. Everything was read-only on the test patient.

**Not captured:** the raw `Content-Type` header. A small, purpose-written capture script was blocked by the session's permission classifier (it was passed base64-encoded), so I used the reviewed script above instead. The fix doesn't depend on the header.

## 2. The fix (build step 2)

`backend/services/hyg/odWriter.js`, the only file in the hyg module that writes to Open Dental:

```js
const NO_GROUP_NOTES_STATUS = 404;
const NO_GROUP_NOTES_RE = /^No GroupNote\(s\) found for PatNum (\d+)\.$/;

function isNoGroupNotesAnswer(res, patNum) {
  if (!res || res.ok || res.status !== NO_GROUP_NOTES_STATUS) return false;
  if (typeof res.data !== 'string') return false;
  const m = NO_GROUP_NOTES_RE.exec(res.data.trim());
  return Boolean(m) && Number(m[1]) === patNum;
}

async function readGroupNotes(odGet, patNum) {
  const res = await odGet(GROUP_NOTES_PATH, { PatNum: patNum });
  if (isNoGroupNotesAnswer(res, patNum)) return { ok: true, rows: [] };
  // …every other non-ok answer is GROUP_NOTES_UNREADABLE, unchanged
}
```

Only that answer counts as "no notes". It has to have the status, the whole sentence (anchored at both ends), a string body, **and** the PatNum in the sentence has to be the one asked about. Everything else still refuses: a 404 for a missing path, the same sentence about another patient, the same sentence with any other status, an object body, an outage, or no answer at all. A refusal when the precheck can't see is the precheck doing its job. If Open Dental ever rewords the sentence, first notes fall back to refusing honestly. They never fall back to writing without the check.

**Nothing else changed:**
- The write still happens only in `odWriter.js`. `hygNoOdWrites.test.js` is untouched and green.
- `Written` is still reached only after read-back.
- The read-back uses the same `readGroupNotes`. If a write "lands" but the patient still reads as having no notes, there's no new row to confirm, so the result is still `NOTE_UNCONFIRMED`. That case is tested.

## 3. Why odPerio's NONE detection isn't reused (build step 3)

`services/hyg/odPerio.js` returns the three-way answer (found / `none` / `unavailable`) through `readLatestExam` → `pagedList('/perioexams', { PatNum })`:

- a failed read with no rows → `unavailable`;
- **a 200 with an empty list** → `none`.

So odPerio never recognizes an error body at all. Its "none" rests on `/perioexams` returning `[]` for a patient with no exams. GroupNotes doesn't do that; it says "none" through a 404 and a sentence. Reusing odPerio's check would mean waiting for a 200 `[]` that GroupNotes never sends. The shape carries over: none is an `ok` answer with no rows, and everything else refuses. The detection can't be shared.

## 4. Tests (build step 4)

### The fake now reports "no notes" the way Open Dental does

`FakeOd` in `routes/hyg/hygTestUtils.js` used to answer `[]` (a 200) when GroupNotes had no rows. Real Open Dental never answers that way, which is how every first-note send passed the suite while failing on staging. The fake now answers **the captured 404 and sentence**, built from the fixture with only the PatNum swapped. Once a note has landed, it answers with the rows.

That also changed what the existing send tests check: every one that starts from "this patient has no notes" now goes through the real answer.

**Proving the tests can fail:**

| Setup | Result |
|---|---|
| The **new** fake with the **old** `readGroupNotes` | **14 failures** in `hygSend.test.js` + `hygVisitPerioSend.test.js`. That is the staging bug, reproduced |
| Same, with the fix | 45/45 pass (those two files plus `sendUnits.test.js`) |
| `hygNoteFirstNote.test.js` against the **old** code | 5 of 7 fail |

In that last row, the 2 that still pass test the fake itself and the outage refusal, and neither depends on the fix.

### `routes/hyg/hygNoteFirstNote.test.js` (7 tests)

| Acceptance | Test |
|---|---|
| 5 | The fixture is a 404 with that sentence for 12827, and the matching rule accepts it in `apiGetRaw` shape |
| 5 | The fake reports "no notes" as the 404, and a fake that only models notes being present fails here. The sentence carries the PatNum asked about. Once a note exists, the fake answers with the rows |
| 3 | `readGroupNotes`: the captured answer (with trailing CRLF too) gives `{ ok: true, rows: [] }`. Ten near-misses give `GROUP_NOTES_UNREADABLE`: other patient, 400, 500, 404 for a missing path, 404 with no body, object body, a longer sentence containing it, 503, status 0, a 200 that isn't a list |
| 3 | A truly unreachable Open Dental (503, timeout, a 404 for a missing path) still refuses the first note with `NOTE_PRECHECK_UNAVAILABLE`, and **0 writes** |
| 2 | A patient with **no notes**: the note goes out, is read back and shows **Written**. Exactly one write, and exactly two GroupNotes reads (precheck, then read-back) |
| 3 | Read-back after a write that didn't land (the surface still says "no notes"): `NOTE_UNCONFIRMED`. A read-back Open Dental doesn't answer: `NOTE_UNCONFIRMED` |
| 4 (fake) | A note Failed by the old precheck (`NOTE_PRECHECK_UNAVAILABLE`), then Retry, then Send: **Written, one note in Open Dental**. A second Retry after Written gets 409, so no duplicate is possible |

### Gates

| Gate | Result |
|---|---|
| `node --check server.js` | clean |
| `node scripts/shard-runner.mjs` | 4/4 green: 2533 tests, 2530 pass, 0 fail, 3 skipped |
| `pnpm run check` | clean |
| `pnpm run test` | 1803 passed, 124 skipped |

On the first full run, `hygNoOdWrites.test.js` caught the fake spelling out `'/procedurelogs/GroupNotes'`. That string contains the name of the write endpoint (`/procedurelogs/GroupNote`), which may appear only in `odWriter.js`. The fake now imports `GROUP_NOTES_PATH` from `odWriter.js` instead. The guard did its job.

No `any`. No `.env` read. No Azure config change.

## 5. The sweep: other read paths that may treat "No X found" as a failure (build step 5)

I searched the hyg, TC and RCM read paths and the recorded probe fixtures and docs. I fixed nothing outside the note path.

**Answers already recorded, and how the code handles them:**

| Read | What Open Dental says | Consumer | Verdict |
|---|---|---|---|
| `GET /procedurelogs/GroupNotes?PatNum=` for a patient with no notes | 404 `No GroupNote(s) found for PatNum N.` | `odWriter.readGroupNotes` | **Fixed here** |
| `GET /periomeasures?PerioExamNum=` for a **deleted** exam | 404 `PerioExamNum not found.` (item 19) | `odPerio.readExamMeasures` via `perioSend.readExamChart` | Correct as a failure. The exam doesn't exist, and the perio delete confirms by re-listing `/perioexams`, not by this read |
| `GET /benefits?PlanNum=<bad>` | 404 `InsPlan not found.` (`docs/TC_OD_READS.md`) | TC `odReads.js` | Correct as a failure (a bad id), and TC already falls back to `?PatPlanNum=` |

**Never measured for the empty case.** Each of these is written assuming "none" comes back as `[]`. If Open Dental says "none" the way GroupNotes does, the consumer would fail in the way described, which is honest but wrong:

| Read, empty case | Consumer | What happens if "none" is a 404 |
|---|---|---|
| `/perioexams?PatNum=` for a patient with **zero** exams | `odPerio.readLatestExam` / `readExams`, the perio step's adopt/settle, and `removeExam`'s re-list | Prior exam shows **unavailable** instead of none. A perio send or delete whose re-list finds zero exams would **pause** instead of confirming. No recorded run in this repo reads it for a patient with zero exams (item 19's patient had another exam the whole time) |
| `/periomeasures?PerioExamNum=` for an **existing** exam with zero rows | `odPerio.readExamMeasures` | The read-back of a freshly posted exam with no rows shows unavailable |
| `/procedurelogs?AptNum=` for an appointment with no procedures | `odWriter.readAppointmentProcedures` | Refuses with `PROCEDURES_UNREADABLE` instead of `NO_PROCEDURES`. Still nothing written, just a less accurate sentence |
| `/treatplans?PatNum=`, `/patplans?PatNum=`, `/procedurelogs?PatNum=&ProcStatus=TP` | TC `odReads.js` | Treatment plans and insurance throw (the TC patient panel errors). Patplans in one helper already degrades to "no plans" on any failure. TC has been live in prod reading many patients, which suggests these do return `[]`, but I haven't seen that measured |

The cheapest next measurement is one `/perioexams?PatNum=` read on a test patient with no exams, which is the same kind of read as §1. I did not make it; the brief limited Open Dental contact to the 12827 GroupNotes read.

## 6. What's left, after merge (acceptance 4 on staging)

1. Merge **#189 (item 20) first**, or in the same deploy (§0).
2. Once this is on staging, open a **new** visit on roland **12827**, stage a note, and send it. Expect **Written**.
3. Confirm it with the same read-only read as §1: `env HYG_PROBE_OFFICE=roland HYG_PROBE_PATNUM=12827 node /app/scripts/diag-hyg-groupnotes.js`. Expect **200 and 1 row**, where today it answers 404 "No GroupNote(s)".
4. The note row is now Written and offers no Send or Retry. The read should still show exactly one row.
5. **Leave apt 105887 alone.** Its two Failed notes should stay Failed. Clearing them is a data decision for you, not a Retry.

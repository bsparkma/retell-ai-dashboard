# Hotfix: referral chart notes dated at the milestone, not at the write

Branch `fix/referral-chart-note-date`, off `origin/develop` (a9a5250). Found in the
#289 prod smoke on 2026-10-29.

## Symptom

A referral chart note written 10/29 at about 1:09 PM CT showed up in Open Dental under
**10/23** (CommlogNum 360339).

## Root cause

`backend/routes/tc/referralChartNotes.js` passed `at: state.at` to the writer, and
`state.at` is the **milestone event's** timestamp (`referralChartMilestones` →
`reached.at`). R6.10 did this on purpose ("the commlog's date from the milestone"). So a
note written today for a referral sent last week was filed under last week's date.

The UTC-shift suspicion from #282 does **not** apply to this path.
`services/tc/referralChartNote.officeWallClock` converts the instant to
`OFFICE_TIMEZONE` before the writer sees it. A UTC shift moves a note by 5–6 hours, not
6 days.

Reproduced on the old code: with the milestone at 2026-10-23 14:00Z and the write at
2026-10-29 18:09Z, the POST carried `CommDateTime: '2026-10-23 09:00:00'`.

## Fix

The route reads the clock once (`transitions.clock()`) and uses that one instant for both
the commlog date and the `chart_note_written` history row, so the chart and the history
agree. The milestone's own date stays in the referral's history. No Open Dental read or
write was added, no schema changed, and the payload shape is the same.

## Tests

- **New:** `D:` in `routes/tc/tcReferralChartNotes.test.js`. It uses a milestone on
  10/23 and a write on 10/29 18:09Z, and expects `'2026-10-29 13:09:00'` (CDT) and a
  history row with the same instant. It also checks a late-evening write at 03:30Z,
  which stays on 10/29 at the office (`'2026-10-29 22:30:00'`), not 10/30. It **fails on
  the old code** (`actual: '2026-10-23 09:00:00'`).
- **RULING (hotfix 2026-10-29):** `M: each of the six milestones…` now expects the
  scheduled note dated at the write (`'2026-10-27 10:00:00'`). The old expectation was the
  link's moment (`'2026-10-20 14:30:00'`).
- That test file: 29/29 pass. `node --check server.js` passes. Full `node --test`:
  4357/4364 locally. The only failures were `platform.test.js`, `sendToTc.test.js` and
  `onDemandTranscription.test.js`, each failing as a whole file in the parallel run, and
  all three pass on their own. That matches the known Node 22 runner flake.

## Reconciliation against prod: PENDING, do not merge until filled in

A PM check found that the diagnosis has to account for **two** notes on roland fixture
12827, not one:

- 360339 ("Patient scheduled with …"), shown in OD under **10/23**.
- A "Referral sent to …" note, shown under **10/24**. Every sent-related event the PM
  listed is 10/23 afternoon Central, and no single timezone could put that on 10/24.

How the code could explain it: the `sent` milestone takes the **latest** `send`/`mark_sent`
event on **its own** referral (`shared/tc/referrals.ts` `CHART_MILESTONE_EVENTS`). The
second note names a different specialist and reason, which suggests it belongs to a
different referral, or a later send, whose event fell on 10/24 Central.

**Predictions** (falsifiable, to the second):

| Note | Predicted CommDateTime | Predicted source event |
| --- | --- | --- |
| 360339 | `2026-10-23 14:50:14` | `patient_scheduled` on its referral |
| the sent note | its own referral's latest send/mark_sent, Central | a `send`/`mark_sent` dated 10/24 Central, on a different referral (or a later send) |

Probes, committed in plain text and **not yet run**:

- `backend/scripts/probe-referral-commlog-dates.js` makes one `GET /commlogs` on the
  fixture and prints CommlogNum, CommDateTime, DateTStamp and the first 70 characters.
- `backend/scripts/probe-referral-commlog-dates.sql` runs one SELECT inside a `READ ONLY`
  transaction over the fixture's referral history, with `at_central`.

**Result (run 2026-10-29, supervised and authorized):** both notes match their own
milestone event **to the second**. The diagnosis holds.

How the probes ran:

- The OD probe is the committed file (`af9c91a`, sha256 `65f9c385…ce213e`). It was rebuilt
  in the prod container's `/tmp` and its hash checked in the container before it ran.
  It made one GET, which returned 8 rows, 2 of them of the referral type (491).
- The SQL is the committed `.sql`, run unchanged against the prod **and** staging tenant
  DBs, `READ ONLY`.

| CommlogNum | OD `CommDateTime` | OD `DateTStamp` (written) | Source event (`at_central`) | Environment | Referral | Match |
| --- | --- | --- | --- | --- | --- | --- |
| 360339 | `2026-10-23 14:50:14` | `2026-10-29 13:09:18` | `patient_scheduled` `2026-10-23 14:50:14`; `chart_note_written` `2026-10-29 13:09:18` | **prod** | `1fb869d1…` | ✓ to the second |
| 360206 | `2026-10-24 11:41:27` | `2026-10-28 16:27:25` | `send` `2026-10-24 11:41:27`; `chart_note_written` `2026-10-28 16:27:26` | **staging** | `e513c449…` | ✓ to the second |

What this corrects in the original premise: 360206 was **not** written on 10/29 in prod.
It was written **10/28 from staging**, which talks to the same live Open Dental databases.
It belongs to a different referral, whose own `send` event is on 10/24. The prod tenant DB
holds no record of it, and the staging tenant DB holds the `chart_note_written` row
naming 360206. Both dates come from one cause: the note is dated at the milestone, not
when it is written. No timezone shift is involved; both CommDateTimes are the event
times in Central, exactly.

## Behaviour after the fix

Every future referral chart note is dated at the moment it is written (`transitions.clock()`),
as the office's wall clock. This route is the only thing that writes referral chart
notes, and `tcReferralChartNotes.test.js` fails the build if anything else requires the
writer. The milestone date no longer reaches `CommDateTime` by any path.

## Already-written notes (fixture patient only)

Both mis-dated notes are on the roland fixture **12827**. No real patient is affected:
one is from the prod smoke (10/29), the other from staging testing (10/28). Correcting them is optional (it only tidies the fixture chart) and has to be done
by hand in Open Dental. No script in this PR changes or removes Open Dental data.

| CommlogNum | Shown under | Should read |
| --- | --- | --- |
| 360339 | 10/23 | 10/29 (written 1:09:18 PM CT, prod) |
| 360206 | 10/24 | 10/28 (written 4:27:25 PM CT, staging) |

One caveat on the claim that no real patient is affected: it covers 12827, the only
chart probed, and the prod tenant DB, where 360339 is the only chart note written. It
does not cover staging writes to other charts, since staging is meant to write only to
fixtures.

## Separate, not fixed here: voice notes are dated in UTC

The voice commlog (`openDentalSync.js`, `CommDateTime: call.call_date`) gets a UTC ISO
string (`unifiedCallStore.normalizeCallDate` → `toISOString()`). `formatODDateTime`
keeps those clock digits as they are, so voice notes are dated 5–6 hours late, and calls
after about 7 PM CT land on the next day. This is a different writer with its own dedup
behaviour, so it is left for a separate fix.

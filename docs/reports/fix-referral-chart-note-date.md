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

## Already-written notes

This fix does not touch notes already in a chart. Note 360339 is still dated 10/23. It
has to be corrected in Open Dental by hand. This PR does not edit commlogs.

## Separate, not fixed here: voice notes are dated in UTC

The voice commlog (`openDentalSync.js`, `CommDateTime: call.call_date`) gets a UTC ISO
string (`unifiedCallStore.normalizeCallDate` → `toISOString()`). `formatODDateTime`
keeps those clock digits as they are, so voice notes are dated 5–6 hours late, and calls
after about 7 PM CT land on the next day. This is a different writer with its own dedup
behaviour, so it is left for a separate fix.

# CO-4a: appointment anchor on "Scheduled"

Branch `feature/tc-scheduled-anchor` off `origin/develop` (84761ca, which has CO-5a / #297 merged).
Covers Beau's rulings of 2026-10-30, as the prelude to the OD-driven pipeline sync (CO-4b).

## What it does

- **Choosing Scheduled now opens a picker** in the workup or the quick-look sheet. Both use the shared `CheckoutOutcome`.
  - The picker asks "Which appointment was booked?" and lists the patient's **upcoming** Open Dental appointments, soonest first. Each row shows the date and time, provider, appointment type and operatory.
  - **Not in Open Dental yet** is always offered as well.
- **Picking one completes the outcome in one request.** The server re-reads the patient's upcoming appointments from Open Dental and confirms the picked AptNum is one of them. It then records Scheduled and stores the anchor **in the same transaction**.
- **Not in Open Dental yet** answers Scheduled exactly as before, with no anchor.
- **When the read fails,** the picker says "Couldn't load appointments from Open Dental" with **Retry**, and Not in Open Dental yet still works. It never shows an empty list.
  - A genuinely empty result says "Open Dental has no upcoming appointment for this patient."
- **The answered card and the case's checkout panel** show **"Scheduled → Wed, Nov 4, 9:00 AM · DOC1 · Crown prep · Op 4 - Doctor"**, read from the stored anchor.
  - An unanchored Scheduled card shows **"No appointment linked"** with **Link appointment**. That uses the same picker and the same read, in link mode.
  - An anchored card offers **Change**, and the picker then offers **Unlink**.
- **The case panel** shows the link button only when the server says the case still accepts a link.

## The Open Dental read (read-only)

`odReads.listUpcomingAppointments` makes **one** request: `GET /appointments?PatNum=<stored>&AptStatus=Scheduled&dateStart=<office today>`.
- **Statuses:** `Scheduled` is OD's string enum for a booked appointment, so the filter excludes Broken, Complete, Planned, UnschedList and patient-note rows.
- **Defensive re-filter:** the rows that come back are filtered again by the same rules (and by PatNum), so an OD build that ignored a filter still can't put a broken appointment, a past one, or another patient's into the picker. A test pins this.
- **No unfiltered fallback,** unlike `getNextAppointment`: if OD refuses the filter, that is a failed read and is reported as one.
- **Which office and patient:** both come from the **stored checkout row**, and the office's own client is checked with `assertOfficeMatch` (`routes/tc/checkoutAppointments.js`). It goes through the existing `apiGetRaw` transport, with its pacing, its 429 backoff and the TC OD timeout.
- **Labels:**
  - the provider comes from the appointment's own `provAbbr`;
  - type and operatory names come from the practice-configuration lists the hygiene day view already reads, through the same hour-long per-office `odConfigCache`. A warm cache costs no OD request; `readAppointmentTypeLabels` is now exported from `odDay` (additive).
  - A label that can't be read falls back to the procedure summary or "Op 9". It never fails the picker.
- **What the client receives:** exactly `aptNum`, `dateTime`, `provider`, `appointmentType` and `operatory`. A test checks the keys and that the OD `Note` never leaves.
- **Audit:** each read writes `READ od_appointment` (resource id = the PatNum, as `/od/next-appointment` already does) with `source_ref checkout:<id>`.
- **GET-only pin:** `tcOdReads.test.js`'s "no OD route reaches a write method" now also covers `checkoutAppointments.js`, plus CO-5a's `odManualPatient.js`. That edit is labelled **RULING (CO-4a)**. `hygNoOdWrites` and `rcmNoOdWrites` are green.

## Routes (all under `/api/tc/checkout`, so `tc.full`)

| Route | What |
| --- | --- |
| `GET /:id/appointments` | The picker list. Allowed while the checkout is waiting or once it is Scheduled. A failed read returns **502 `OD_APPOINTMENTS_UNAVAILABLE`**; any other status returns 409. |
| `POST /:id/outcome` | Gains an optional `aptNum` (Scheduled only; on any other outcome it is a 400 before OD is asked). The re-read happens **before** the transaction. Not upcoming for this patient in this office gives **409 `APPOINTMENT_NOT_UPCOMING`**. OD down gives 502 and nothing is recorded. |
| `POST /:id/appointment` | `{ aptNum \| null }`: link, change or clear later. Requires a Scheduled checkout whose case is not completed or lost. Checks are re-read, the write is conditional, the result is read back, and the change is audited. |
| `GET /by-case/:caseId` | Each visit gains `canLinkAppointment` (additive). |

**Audit for anchor changes:** each one is its own event, `UPDATE tc_checkout_handoff`, written besides the outcome's row:
- `checkout_appointment_link` with `prior_state unanchored` (a first link) or `anchored` (a change);
- `checkout_appointment_unlink` for a clear.

## ⚠ Judgment call: "while the case is open"

The shared contract's `OPEN_CASE_STATUSES` treats **`scheduled` as terminal**. Every case that a Scheduled checkout creates or moves sits at `scheduled`, so with that definition **"Link appointment" could never be used**.
- I define "still takes a link" as **the case is not `completed` or `lost`** (`APPOINTMENT_LINK_CLOSED_CASE` in `routes/tc/checkout.js`). That keeps the `scheduled` case, the one waiting on its appointment, linkable. It is also exactly what CO-4b will track.
- **Beau, please confirm,** or name a different cut-off (for example, also closing at `started`).

## Storage

Migration **`1793800000000_tc_checkout_appointment_anchor.js`**. It is above develop's newest (1793700000000, the CO-5a fix), which I re-checked at push. It adds five additive, nullable columns on `tc_checkout_handoffs`:

| Column | Holds |
| --- | --- |
| `appt_num` bigint | The AptNum |
| `appt_at_local` text `YYYY-MM-DD HH:MM[:SS]` | OD's own wall-clock reading for the office. Not converted, never a guessed timezone |
| `appt_snapshot` jsonb | `{ provider, appointmentType, operatory }` at link time |
| `appt_linked_by` text | Who linked it |
| `appt_linked_at` timestamptz | When |

- **Office:** the anchor's office is the **row's `office_id`**. It is only ever written from that office's own client, so a second office column could only disagree with the first.
- **CHECKs,** each two-valued: all five columns are set or none are; an anchor exists only when `status = 'scheduled'`; the time has the wall-clock shape; the snapshot is an object.
- **Old records** have NULL in all five and read as unanchored. The contract field `appointment` defaults to null, and tests cover both.
- **CO-5a reopen:** when a late hygiene visit reopens an anchored Scheduled card, `reopenAnswered` clears the anchor along with the outcome, as the CHECK requires. It keeps the anchor in `reopenedFrom.appointment`, which is additive and defaults to null.

## Tests

`backend/routes/tc/tcCheckoutAppointmentAnchor.test.js` (13 tests; OD is faked on each office's **real** client, so every call is recorded with its office):

| Area | What it pins |
| --- | --- |
| **Picker lists only upcoming non-broken** | Past, Broken, Planned, Complete and another patient's rows are excluded; soonest first; exactly the 5 fields and no `Note`; **one** `/appointments` call with the stored PatNum, `Scheduled` and the office's today; only that office's OD; the READ audit row |
| Re-filter | Holds even when OD ignores its filters (today counts; a `0001-01-01` date does not) |
| **Read failure** | 502 with the picker's words and no list. Picking while OD is down records nothing; "Not in OD yet" still answers Scheduled without asking OD |
| **Anchor stored, audited, shown** | Same-action store; the row's office; the label `Tue, Nov 10, 2:30 PM`; its own `checkout_appointment_link` audit row; the case panel carries the anchor with `canLinkAppointment` |
| Not upcoming | Broken, past, another patient's or made-up AptNums are refused (409) with nothing recorded |
| Scheduled only | `aptNum` with any other outcome is a 400 and OD is never asked |
| Already answered | Picking on an answered card is a 409 **before** OD is asked: no PHI read for a stale screen (review round 1) |
| **Office isolation** | A valley card reads only valley's OD. Roland's real upcoming AptNum 5001 is refused on the valley card. Roland can't reach the valley card (404) |
| **Later "Link appointment"** | Link, no-op relink, change, then clear; audited `unanchored`, then `anchored`, then `unlink` |
| Later, refused | Not Scheduled (409); a `completed` or `lost` case (`CASE_NOT_OPEN`); no picker on a Nothing-needed card |
| Role gate | A hygienist gets 403 before OD is asked |
| **Old cards unanchored** | No CO-4a columns reads as `appointment: null`; the contract defaults a legacy reader too |
| CO-5a reopen | Clears the anchor with distinct NULL params, keeps it in the history |

`backend/test/checkoutAppointmentAnchorMigration.test.js` (5 tests): the columns are nullable with no default, the CHECKs (including the two-valued shape), the order of `down()`, the numbering, and that every store column exists after replay.

`new-dashboard/tests/tc-checkout-scheduled-anchor.test.tsx` (12 tests, plus 3 screenshot dumps):
- the picker on Scheduled, with its labels and "Not in OD yet";
- a pick sends the AptNum in one call and the card shows "Scheduled → Wed, Nov 4, 9:00 AM";
- read failure: message, Retry, and Not in OD yet still works;
- an empty result says so;
- the other two outcomes never open the picker;
- an unanchored card: "No appointment linked", then Link appointment, in link mode (no "Not in OD yet");
- an anchored card: Change, then Unlink;
- an old card is unanchored;
- the case panel line and its server-gated button;
- review round 1: a slow answer to an older read never overwrites a newer one, and a pick refused as "no longer upcoming" keeps the picker open and reads the list again.

**Mutation checks:**
- Making Scheduled answer without the picker turns 5 UI tests red.
- Removing the picker's stale-response guard turns the round-1 test red.

**Real Postgres, not just the Map.** The unit suite's database is a Map, so it can't prove a CHECK.
- **New verifier:** `backend/scripts/checkout-anchor-verify-queries.js`, a sibling of `fees-verify-queries.js`. It walks one synthetic checkout through these steps, calling the **real** store functions in one rolled-back transaction:
  - waiting;
  - an anchor refused while waiting;
  - Scheduled, then anchored;
  - changed (an `HH:MM` time accepted);
  - cleared (all five NULL parameters type cleanly);
  - re-anchored;
  - the CO-5a reopen, which clears the anchor and keeps it in history.
- It then asserts that Postgres **refuses**, with SQLSTATE 23514: half an anchor; a `2026-11-04T09:00:00Z` time (which proves the regex survived the JS-to-SQL escaping); a non-object snapshot; an anchor on a non-Scheduled card.
- **Local run:** I migrated a throwaway `postgres:16` container exactly as CI does and ran the verifier. **10 of 10 steps passed.** The container is removed.
- **In CI:** `build-test.yml` now runs it as a step beside the fees verifier, so CI proves the CHECKs on every PR.

**Existing test edits** (labelled **RULING (CO-4a)**):
- `tests/tc-checkout.test.tsx`, "Scheduled sends the outcome WITH the appointment note": after Scheduled it now clicks "Not in Open Dental yet". Every assertion is unchanged.
- `backend/routes/tc/tcCheckoutManualAdd.test.js` (CO-5a reopen): the expected history gains `appointment: null`.
- `backend/routes/tc/tcOdReads.test.js`: the GET-only pin's file list.

**Local results:**
- Backend: `node --check server.js` passes. The full `node --test` run had 1 file-level failure: `services/onDemandTranscription.test.js`, which this branch does not touch. Alone, that file passes 24/24 three times out of three; it is the known Node 22 runner flake (CI shards for it). Everything else passed.
- Dashboard: `pnpm run check` is clean; `pnpm run test` gives 3066 passed and 0 failed.

## Screenshots (synthetic data: "Kiwi, Sam", roland 12827)

All in `docs/screenshots/tc/co4a/`, light and dark:

| Shot | Shows |
| --- | --- |
| `tccheckout-co4a-01-picker-1280x900-*.png` | The picker after tapping Scheduled: two upcoming appointments and "Not in Open Dental yet" |
| `tccheckout-co4a-02-picker-failed-1280x900-*.png` | The read failed: the message, Retry, and "Not in Open Dental yet" |
| `tccheckout-co4a-03-answered-1280x900-*.png` | Answered cards: "Scheduled → Wed, Nov 4, 9:00 AM …" with Change, and "No appointment linked" with Link appointment |

## Review

One round with a fresh-context reviewer found **no blocking issues**. It independently confirmed:
- that no request can make the server anchor another office's or another patient's AptNum (office and PatNum come from the stored row, and the AptNum is re-verified in a fresh read);
- that every write path keeps the CHECKs true, including CO-5a's reopen;
- that the CHECKs are two-valued and the regex escaping is right;
- that the NULL parameters are typed distinctly;
- that the "not completed or lost" judgment is sound;
- that the RULING (CO-4a) test edits are correct and necessary.

| Finding | Outcome |
| --- | --- |
| Minor: the outcome route read OD before checking the card was still waiting, so an answered card cost one audited PHI read | **Fixed**: refused with a 409 before OD is asked; tested |
| Minor: the picker could flash the previous list on reopen, and a late answer to an older read could overwrite a newer one | **Fixed**: every open starts at "loading", and only the newest read may land; tested and mutation-checked |
| Minor: after `APPOINTMENT_NOT_UPCOMING` the picker kept its stale list | **Fixed**: it reads the list again and stays open, in both outcome and link mode; tested |
| Test gap: the fake DB can't prove the CHECKs, the escaping or the NULL typing | **Closed**: the real-Postgres verifier above, run locally (10/10) and added to CI |
| Minor: `setAnchor` checks the checkout's status but not the case's, so a case closed in the instant between the check and the write could still have its link changed | **Accepted**: a sub-second window. The link only labels which appointment the case is waiting on, and changes are audited. Closing it would need a cross-table condition the store doesn't use anywhere else |
| Minor: the no-op "unchanged" check compares against the first read | **Accepted**: harmless; the write path re-checks |
| Note: as with every audit row in this route, the anchor's audit is written after the commit | Unchanged: the existing pattern |

No second round was needed.

## Guardrails

- No OD writes; the one new read is a GET through `apiGetRaw`, pinned.
- Office and PatNum come from the stored record, and the AptNum is re-verified against that office and patient.
- No `SELECT *`. TC payload changes are additive.
- No real names. TypeScript strict; tsc clean. Nothing was deleted.

## CI

PR #298. `build-test` on `refs/pull/298/merge` (run 41098522026, head 3df2bdc) **passed on the first attempt**, with no fix pushes. It covered:
- typecheck;
- vitest;
- `node --check`;
- the sharded `node --test`;
- migrations against an ephemeral Postgres 16;
- the RCM, fees and **new checkout-anchor** verifiers (every step `ok` in the log);
- the smoke spine.

Not merged.

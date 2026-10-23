# Referral response badges — NEEDS REVIEW (RED: shared contract fields added)

**Branch:** `feature/referral-response-badges`, cut from `origin/develop` at `7f7d2ca` (after #262).
**Lane:** **RED.** Two optional fields were added to the shared `TcReferral` schema.
`backend/tc/contract.gen.cjs` was regenerated with the pinned toolchain. The byte-compare test
(`tc-contract-bundle.test.ts`) passes.
**Pushed for review. Not merged.**

## What a card now shows, without opening the drawer

The same rule applies on the hub card (`/tc/referrals`), on each referral row in a case, and on the
checkout chip.

| Signal | When | How it shows |
|---|---|---|
| **Received** | The specialist confirmed receipt (the `mark_acknowledged` move) since the referral was **last sent**. It counts whether the confirmation came from their email link (actor `system:specialist-link`) or was marked by staff | A badge. Its tooltip says which: "confirmed it from the email link" or "Marked received by staff" |
| **Patient scheduled \<date\>** | `scheduled_date` is set (R5b) | A badge, e.g. "Patient scheduled Tue, Nov 3, 2026" |
| **Patient email outcome** | The latest `patient_email_sent` / `_skipped` / `_failed` since the last send | A quiet muted line, not a badge. Sent: "Patient emailed." Skipped or failed: the history row's own note, e.g. "Patient not emailed: the patient has no email on file in Open Dental." |

Rules worth knowing:
- **A re-send starts clean.** After a reopen and a new send, an earlier receipt or patient-email
  outcome no longer counts. This mirrors how `referralLastSendProblem` resets on a move.
- **Rows written before R6** carry no verb. For them, a move from sent to acknowledged counts as
  the receipt.
- **A `patient_scheduled` event is not a receipt.** The date travels on `scheduledDate`.
- **Only sent referrals are read for responses** (sent, acknowledged, patient_seen, closed). A draft
  can never look received.
- **The scheduled badge's source.** It reads `scheduled_date` whoever set it. Today the only writers
  are the two email links; the staff entry the brief mentions doesn't exist yet. The badge will show
  it unchanged once it does.

## The chip fix (the logged nit)

`referralChipFor` returned "Approved" for every referral at or past approval, so a referral the
specialist had already received still read as unsent. The chip now names the real status:
- Sent
- Acknowledged
- Patient seen
- Closed

The earlier labels are unchanged: Staged, Pending Dr. sign-off, Approved, Declined.

Where there's room, the same signals sit beside the chip:
- **Checkout chip:** the received and scheduled badges. "Received" is dropped when the chip already
  says "Acknowledged". The patient-email line is left off the checkout chip, which has no room
  for it.
- **Case rows:** the badges next to the status, plus the patient-email line.

## How the list carries it (read-only)

- **New store lookup.** `referralStore.responseSignals` runs one SELECT over `tc_referral_events`
  for the sent rows. It uses the same pattern as `openSendProblems`, and derives each row's signals
  with the shared pure `referralResponses(events)`.
- **Where it's attached.** `present()` in `routes/tc/referrals.js` adds `received` and
  `patientEmail` to each row. `present()` decorates both the hub list (`GET /hub`) and the case /
  checkout list (`GET /?caseId=|handoffId=`).
- **No new routes, no writes.**

**Shared additions** (`new-dashboard/shared/tc/referrals.ts`):
- `TcReferral.received`: `{ at, via: "link" | "staff" }`, nullable, optional.
- `TcReferral.patientEmail`: `{ status: "sent" | "skipped" | "failed", note, at }`, nullable,
  optional. The note is the history row's text; it never carries an address.
- Pure functions `referralResponses`, `referralResponseBadges`, `referralDateLabel` and
  `referralChipTop`.
- `TcReferralChip` widened to the four post-approval statuses.
- The hub's `scheduledDateLabel` now delegates to the shared `referralDateLabel`, so there is one
  formatter.

## Guardrails

- **No transition, state-machine or send code changed**, and no migration. Checked with
  `git diff origin/develop` on `referralSend.js`, `referralTransitions.js` and
  `migrations-tenant/`: all empty.
- **No Open Dental access.**
- **No existing test edited**, including the state machine's pinned tests.
- **TypeScript strict**, `tsc --noEmit` clean.

## Tests (new files only)

**`new-dashboard/tests/referral-response-badges.test.tsx`, 28 tests:**
- `referralResponses`, one test per event combination:
  - none;
  - a send alone;
  - link;
  - staff, after a send and after a manual mark-sent;
  - legacy rows with no verb;
  - a re-send starting clean;
  - each patient-email outcome;
  - the latest outcome winning;
  - `patient_scheduled` alone not counting as a receipt.
- `referralResponseBadges`: each badge and line, alone and all together.
- The chip, for every status; cancelled ignored; the newest wins.
- **Rendered:**
  - the hub card with all three signals, then with none, then scheduled only;
  - the checkout chip saying "Sent" with the scheduled badge;
  - the checkout chip saying "Acknowledged" with no duplicate Received badge;
  - a case row at patient_seen with Received and the patient-email line.

**`backend/routes/tc/tcReferralResponses.test.js`, 6 tests**, through the real routes:
- a sent referral with no responses;
- staff's mark-acknowledged reads as `via: staff`;
- a link confirmation, plus the scheduled date and a skip note;
- the case list carries the same fields;
- a draft never carries responses;
- office scope.

Each list row is also checked against the shared `TcReferral` schema.

## Verification

| Gate | Result |
|---|---|
| `pnpm run check` | clean |
| Dashboard `vitest run` | 216 files: 182 passed, 34 skipped. 3020 tests: 2816 passed, 204 skipped, **0 failed** (includes the contract-bundle byte-compare test) |
| `node --check server.js` | OK |
| Backend `node --test` | 4021 tests: 4017 pass, 3 skipped, 1 fail. The failure is `routes/sendToTc.test.js` with "Unable to deserialize cloned data", the known Node 22 runner flake. That file is untouched and passes 18/18 alone |

# R6.9a — staff attachment window on referrals

Branch `feature/referral-attachment-window`, off `origin/develop` at 37d7f49. Not merged.

## What changed

Staff (tc.full) can now upload a file to a referral while it is **draft, awaiting
sign-off, sent, acknowledged, or patient seen**. Before, only the first two worked. The
use case is attaching the specialist's returned report or fax.

| Status | Staff route `POST /api/tc/referrals/:id/attachments` |
| --- | --- |
| draft, pending_signoff | open (as before) |
| sent, acknowledged, patient_seen | **open (new)** |
| approved, closed, cancelled, declined | shut: 409 `REFERRAL_LOCKED` |

Unchanged:
- **The doctor's sign-off upload route:** still awaiting-sign-off only.
- **The hygiene upload route:** still draft or awaiting sign-off only.
- **The 5-file cap:** still refuses the sixth with 409 `ATTACHMENT_LIMIT`.
- **No delete:** DELETE stays 404 on both routes.
- **The bytes rules:** type checked from the file's bytes, 10 MB limit, filename sanitized.
- **Storage:** blob first, then the row; 503 when storage isn't configured.
- **No migration, no shared-contract change, no change to `referralSend.js`, email or Open Dental code.**

## A deviation from the brief: the handler file changed

The brief asked for the R4 handler to stay byte-untouched, with the change made in
the route guard. That isn't possible as the code stands. The status check lives inside
`uploadHandler` (`referralAttachments.js`), under the row lock, after the route's
`guard`. A guard can only add refusals, so it can't widen the window.

The smallest change that works: `uploadHandler` takes two optional settings,
`attachableStatuses` and `lockedMessage`.
- The defaults are exactly the old list and the old sentence, so the sign-off and
  hygiene routes behave byte-for-byte as before.
- Only the staff route in `referrals.js` passes a wider list (`TC_STAFF_ATTACHABLE_STATUSES`).
- The blob storage, validation, size, cap and audit code is untouched. The diff touches
  the function signature, the one status `if`, and two comments.

The staff route's refusal sentence changed so it stays true. It now reads: "Files can
be added only while a referral is a draft, awaiting sign-off, sent, acknowledged, or
the patient has been seen." The code (`REFERRAL_LOCKED`) and the status (409) are the same.

## Frontend

- **Hub detail panel:** sent, acknowledged and patient-seen referrals show the
  existing "Add files" box (`AddAttachments`) for tc.full viewers. It uploads through
  the hub's own staff route.
  - It is not shown to a doctor or through the sign-off reader.
  - Draft and awaiting-sign-off referrals still take files through Edit, as before.
- **Correspondence form:** it now offers its optional file on the same five statuses.
  Its "can't attach" sentence matches the new server sentence.
- The status list is mirrored in `hubActions.ts` (`HUB_STAFF_ATTACHABLE_STATUSES`,
  `hubCanAddFilesAfterSend`). The server decides.

## Open question

**Approved stays shut.** The brief didn't list it either way. An approved referral
hasn't gone out yet, so I kept it closed. Opening it is one word in two places.

## Pre-existing tests edited (for ratification)

1. `backend/routes/tc/tcReferralCorrespondence.test.js`, test **A**. It pinned "a
   `sent` referral refuses a file". `sent` is now open, so the test walks to `closed`,
   which is still shut. Its check that R4's default list is still
   `['draft', 'pending_signoff']` is kept and still passes.
2. `new-dashboard/tests/referrals-correspondence-log.test.tsx`, "after sign-off: no
   file offered". Same reason: it now uses `closed` instead of `sent`.

No other pre-existing test was touched.

## New tests

- `backend/routes/tc/tcReferralAttachmentWindow.test.js` (9 tests):
  - each open status stores a file and never moves the status;
  - each shut status refuses with the new sentence and stores nothing (no blob, no row, no audit);
  - the cap after send;
  - DELETE is 404 on both routes;
  - valley can't add to a roland referral;
  - the doctor route still refuses after send;
  - a source check that only the staff route widens the window;
  - a source check that the attachment code requires no Open Dental, email or send module.
- `new-dashboard/tests/referrals-attachment-window.test.tsx` (13 tests):
  - the mirror and the predicate per status and viewer;
  - the box drawn and uploading through the staff route for each after-send status;
  - no box on the shut statuses, on draft or awaiting sign-off, for a doctor, or through the sign-off reader;
  - the correspondence form offers its file after send.

Blob storage and every API call are mocked: nothing really uploads. The only fixture
is roland 12827 with synthetic names. There are no Open Dental writes anywhere in this
slice.

## Gates

- Backend: `npm ci` OK; `node --check server.js` OK; `node --test`: 4356 tests, 4353 pass, 0 fail, 3 skipped.
- Dashboard: `pnpm install --frozen-lockfile` OK; `pnpm run check` (tsc --noEmit) clean; `pnpm run test`: 196 files passed, 39 skipped; 2995 tests passed, 225 skipped, 0 failed.

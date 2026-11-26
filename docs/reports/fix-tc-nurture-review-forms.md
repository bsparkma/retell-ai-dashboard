# Fix: on Review campaign, refused saves now show in the form, and the forms wait for the server's answer

Branch `fix/tc-nurture-review-forms`, cut from `origin/develop` at 7777402 (PR #361). The change is UI only.

## What happened on staging (2026-11-25)

1. Beau opened **Change date** on a draft planned for Mon Nov 30, 9:00 AM.
2. He picked **11/29/2026 10:00 AM**, which is a Sunday, and clicked **Save date**.
3. The server refused correctly, with `409 OUTSIDE_SEND_WINDOW`.
4. The form had already closed, because `setMode("none")` ran before the request was sent.
5. The only signal was a toast that disappeared, and the row still said Nov 30. He read that as "the date did not save".

**Edit** had the same problem. It closed before the server answered, so a refusal would have thrown away what he typed.

## What changed

1. **The forms stay open until the server answers.**
   - While a save is running, Save shows a spinner and is disabled, and so are the inputs.
   - The form closes only on success.
   - On a refusal or any error, the form stays open with exactly what was typed or picked. The server's message shows inside the form as `role="alert"`, starting "Not saved: …".
   - The message stays until the next attempt or Cancel.
   - Cancel clears the message and puts the inputs back to the row's own values.
   - The toast now appears only on success.
   - **How:** the parent has a new `save()` that, unlike `run()`, passes a refusal back to the form. A `useRef` guard makes sure a double click sends only one request.
2. **Change date says what was picked before saving.**
   - Under the inputs, the form shows the pick in words, for example "Sunday, Nov 29, 10:00 AM office time".
   - A pick on a weekend or outside 9:00 AM to 4:00 PM shows an inline line: "Emails go out Monday to Friday, 9:00 AM to 4:00 PM office time. The next allowed time is Monday, Nov 30, 9:00 AM." Save date is disabled for that pick.
   - The check is a pure helper, `checkPickedTime(date, time)`, in `campaignCopy.ts`. It works on calendar dates only, with no time zone conversion and no clock. It reads the shared contract's `NURTURE_SEND_WINDOW` (weekdays, start minute, end minute), so the window's numbers are not written out a second time.
   - The same constants produce the window sentence (`sendWindowWords()`). It replaces the hard-coded line the form used to show.
   - The next allowed time follows the server's rule. Before 9:00 on a weekday, it is that day at 9:00. After 4:00 PM, or on a weekend, it is the next weekday at 9:00.
   - **The server still decides.** It still refuses a time in the past, an email out of its sequence order, and a time that breaks a cap, and those refusals now show inline as in item 1.
3. **A successful save is highlighted.** After a date change, the planned-time label highlights for 2.5 s. After an edit, the body preview does the same. Both carry `data-flash="true"` while highlighted.
4. **The date and time inputs follow the row.** Before, `useState(parts.date)` kept the value from when the row first mounted. Now, when a reload changes the row's `scheduledFor`, the inputs update to match.

### Shared contract and backend

**No change.** `NURTURE_SEND_WINDOW` was already exported from `new-dashboard/shared/tc/nurture.ts`, so the contract bundle was not regenerated and nothing under `backend/` or `shared/` changed. The contract bundle test (`tc-contract-bundle.test.ts`) passes as part of the dashboard suite. Nothing sends, and there is no change to messaging, the generator, the scheduler, any switch, or any migration.

## Files changed

| File | Change |
| --- | --- |
| `new-dashboard/client/src/features/tc/nurture/NurtureCampaignReview.tsx` | `save()` passes refusals back to the form; `EmailRow` gets the saving state, inline alert, Cancel reset, double-click guard, re-seeding inputs, and the highlight |
| `new-dashboard/client/src/features/tc/nurture/campaignCopy.ts` | New `checkPickedTime()` and `sendWindowWords()`, both built from `NURTURE_SEND_WINDOW` |
| `new-dashboard/tests/tc-nurture-approve.test.tsx` | 18 new tests (below) |
| `new-dashboard/tests/tc-nurture-approve-shots.test.tsx` | Two new screenshot dumps, 14 and 15 |
| `docs/screenshots/tc/tcnurture-14-*`, `tcnurture-15-*` | Light and dark screenshots |

## Tests

### Edits to existing tests

**None.** The 12 existing tests in `tc-nurture-approve.test.tsx` pass unchanged. The only edits to that file are additions:
- three imports: `checkPickedTime`/`sendWindowWords`, `TcApiError` and `toast`
- two new `describe` blocks, inserted before "the case strip on a library campaign"

The screenshot file got additions only: two `it` blocks, a `TcApiError` import, and two lines in its header comment.

### New tests

All are in `tc-nurture-approve.test.tsx`. Every API call is mocked, and `sendMessage` must never be called.

| Test | Covers the brief's ask |
| --- | --- |
| Refused reschedule: the form stays open, Save spins and is disabled while in flight, the server message shows inline (`role="alert"`), and the picked values are kept. The row keeps its old time, no toast appears, and the next attempt clears the message. | Refused reschedule |
| Cancel clears a refusal and puts back the row's own date | (item 1, Cancel) |
| Refused edit: the typed body and subject are kept, and the message shows inline | Refused edit |
| A Sunday pick shows "Sunday, Nov 29, 10:00 AM office time" and names Monday, Nov 30, 9:00 AM. Save date is disabled and sends nothing. | Sunday pick |
| A 5:00 PM pick on Friday disables Save date and names Monday, Dec 14, 9:00 AM | 5:00 PM pick |
| A valid pick enables Save date. The form stays open while saving, closes on success, and the label shows the new time with the highlight. | Valid pick closes on success |
| A successful edit closes the form, and the body shows the new text with the highlight | (item 3, edit) |
| The inputs re-seed after a reload brings a new `scheduledFor`, while the form is still open | Re-seed |
| A double click on Save date sends one request | Double click |
| `checkPickedTime`, 7 cases: Fri 16:00 and 09:00 (the window's edges, allowed), Fri 16:01 → Mon, Mon 08:59 → same day 9:00, Sat → Mon, Wed 23:30 → Thu, Sun → Mon | Pure helper |
| `checkPickedTime` returns nothing for an empty or impossible date (2026-02-30) or an empty time | Pure helper |
| `sendWindowWords()` reads the window off the shared contract | Constants not duplicated |

### The new tests catch the old bug

With develop's `NurtureCampaignReview.tsx` swapped back in, **8 of the 9 new component tests fail**. The one that passes is the double-click test, because the old form closed on the first click and so also sent only one request. That test now covers the new form, which stays open with Save visible while the request runs.

## Screenshots

These are jsdom renders of the fixture campaign, photographed by `scripts/shoot-tc-nurture.mjs` with the built CSS. The patient is the designated roland fixture ("Test 2, Stedi", PatNum 12827). There is no PHI.

- `docs/screenshots/tc/tcnurture-14-date-sunday-pick-1280x1100-light.png` and `-dark.png`: Change date on Email 1 with Sunday 11/29 10:00 AM picked. The pick is in words, the amber window line names Monday, Nov 30, 9:00 AM, and Save date is disabled.
- `docs/screenshots/tc/tcnurture-15-date-refused-1280x1500-light.png` and `-dark.png`: Email 4 moved to Mon Dec 7 11:00 AM, which is inside the window but before email 3. The form stays open with the picked values and the red inline "Not saved: Email 4 has to go after email 3 — the campaign keeps its order. …"

## Gates

| Gate | Result |
| --- | --- |
| `pnpm run check` (`tsc --noEmit`) | Clean |
| `pnpm run test` | 237 files passed, 43 skipped. **3,435 tests passed**, 266 skipped, 0 failed. That is 18 more passing than develop's 3,417; the 2 new skips are the screenshot dumps, which run only with `TC_SHOTS=1`. |
| Contract bundle byte comparison | Passes (inside the suite) |
| Backend suite | Not run: the contract and backend did not change |

## Reviewer notes

- **Cancel puts the inputs back to the row's own values.** The brief asks for "persistent until the next attempt or Cancel". I read Cancel as abandoning the attempt, so it also drops the typed or picked values.
- **Approve, Unapprove and Skip still use `run()`**, so a failure there is still a toast. Those actions have no form to keep open, and the brief limits the change to Edit and Change date.
- **The client window check is a convenience only.** It can only disable Save for a pick the server would refuse with `OUTSIDE_SEND_WINDOW`. It never allows anything the server would refuse.

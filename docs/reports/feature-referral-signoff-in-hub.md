# Sign-off in the Referrals hub

**Branch:** `feature/referral-signoff-in-hub` (off `origin/develop` 096e23a) · **Lane:** RED, NEEDS REVIEW, not merged

Beau's ruling: sign-off happens inside the Referrals hub, and the separate "Awaiting sign-off" page goes away.

## What changed

1. **Sign-off actions in the hub.** On a `pending_signoff` referral, a `tc.referral_signoff` holder (doctor, admin) gets **Approve**, **Decline** (a reason is required) and **Send back** (a question is required) in the hub's detail panel. They call the existing sign-off routes, in the referral's own office. The doctor's edit and the doctor's attachment upload come along unchanged. Anyone without `tc.referral_signoff` sees "Waiting for the doctor's sign-off" and no actions.
   - Availability comes from `hubActionPlan` (`hubActions.ts`) over `referralNextStatus`. The plan now returns a `signoff` list. There is no forked transition logic.
   - The actions were extracted from the old page into `features/tc/referrals/SignoffActions.tsx`. They are not duplicated.
2. **Doctor access without widening any server permission.** `/tc/referrals` now opens with `tc.full` **or** `tc.referral_signoff`; this is the client route map only. A doctor gets the hub's **sign-off view** (`?view=signoff`):
   - It shows referrals awaiting sign-off from every office in scope, oldest first and badged (F5).
   - It reads only through the existing `/signoff/*` routes.
   - A doctor never calls a `tc.full` route. They get no staff edit, Send, manual marks, New referral, filters or settings.
   - `ROLE_HOME.doctor` is `/tc/referrals?view=signoff`.
   - While `/auth/me` is loading, the page shows a spinner and asks no route of either kind.
   - Admins get an "Awaiting sign-off" button on the hub, which switches to the every-office view.
3. **Old page removed safely.**
   - `/tc/referrals/signoff` redirects (`replace`) to the sign-off view and keeps `?office=&referral=`. A bogus office is dropped, and the view opens only an office in the viewer's scope, as F5 did.
   - The sign-off alert links to the hub.
   - The nav item is gone. Its waiting-count badge now sits on **Referrals**, and Referrals shows for a signer once referrals is on.
   - `TcReferralSignoff.tsx` is deleted. An import check found only the route and seven test files using it.
4. **Fold-in:** a hub card in `acknowledged` no longer shows "Received" next to its "acknowledged Nd" line. It uses the same `hideReceived` the checkout chip and the case rows use.

**Guardrails held:**
- Nothing changed in `backend/` or `shared/`.
- No server permission lists changed.
- No migration.
- No OD writes.
- `referralSend.js` is untouched. Approve's existing auto-send is reused as it is.
- `tsc --noEmit` is clean.

## Decisions for you

1. **The brief's premise was off.** The old sign-off page showed **no** confirmation before approving, so there was nothing to copy. I built one.
   - When the policy is on, Approve asks: "This office emails referrals when they are approved — approving will email the specialist now."
   - Only a policy read as **off** approves in one click.
2. **A doctor cannot read the auto-send policy.** `GET /settings` is `tc.full`, and no `/signoff/*` route returns the policy. So for a doctor, Approve **always asks**, worded so it doesn't claim to know: "Approving may email the specialist now: if this office emails referrals when they are approved, it goes out as soon as you approve."
   - This needs no permission change, and it errs toward asking.
   - To make it exact, add the policy value to `GET /signoff/summary`. That changes a response, not a permission list. It does mean editing backend pin **M** in `tcReferralHub.test.js`, which lists the files allowed to read the auto-send column. **Not done. Your call.**
3. **When the policy is on but referral email is off,** Approve still asks, even though nothing would send. It may ask when not needed; it never fails to ask when it should.
4. **An admin in the hub (one office)** keeps the **staff** Edit next to Approve/Decline/Send back. The doctor's edit, which carries the doctor's note, is offered where the staff edit isn't: to the doctor, and to anyone in the sign-off view.

## Pre-existing test edits (for ratification)

| File | Edit |
|---|---|
| `referrals-hub-actions.test.tsx` | **R6.1 pin reversed, for signers only.** "never draws a doctor's move" is now two tests: "the TC side's moves never include a doctor's move or a send", plus **NEW INVARIANT**: "approve / decline / send back only for a `tc.referral_signoff` holder, only on `pending_signoff`, as the table allows". The "names where / links" test, the DOCTOR plan expectation, and "an admin … never an Approve button" were rewritten to match. Send and the marks are unchanged. |
| `referrals-r6-hub.test.tsx` | Route-gate pin is now `["tc.full","tc.referral_signoff"]`. The doctor-card cases moved out. The screenshot helper now renders `HubSignoffView`. |
| `tc-signoff-offices.test.tsx` | Same 7 F5 pins, retargeted to the hub (as a doctor). Approve now passes the confirmation step. The alert URL is the hub's. |
| `role-nav.test.tsx` | The doctor's TC nav is now only **Referrals**, and tc/office keep it. Was: only "Awaiting sign-off". |
| `tc-referrals-r2`, `referrals-r4-attachments`, `referrals-r5-send`, `referrals-r62-attachments` | Sign-off-page cases removed (moved, see below). The R2 screenshot now renders `HubSignoffView`. |
| `fees-registry.test.ts` | One line: tolerate a route mapped to more than one action. |
| `referral-response-badges.test.tsx` | The card fixture moved from `acknowledged` to `patient_seen`. It pinned exactly the duplicate "Received" that item 4 removes. |

## Every old pin → its new home

New suite: `tests/referrals-signoff-in-hub.test.tsx` (26 tests).

| Old pin (file) | New home |
|---|---|
| All offices: every office's rows, badged, oldest first (signoff-offices) | `tc-signoff-offices` (same test, hub view); plus "oldest first, whatever order…" in the new suite |
| Opened and approved in the office it was listed from (signoff-offices) | `tc-signoff-offices` |
| One office failing: other rows plus a partial-data notice (signoff-offices) | `tc-signoff-offices` |
| One office: one fetch, no badges (signoff-offices) | `tc-signoff-offices` |
| `?office=valley&referral=` opens in Valley (signoff-offices) | `tc-signoff-offices`; redirect keeps it: new suite "redirects … keeping a deep link" |
| Office outside scope ignored (signoff-offices) | `tc-signoff-offices`; redirect drops a bogus office: new suite |
| Alert links to the referral (signoff-offices) | `tc-signoff-offices` (now `/tc/referrals?view=signoff&office=&referral=`) |
| Queue → detail with history → Approve → ready-to-send line → empty (r2) | new suite: "queue → panel with history → Approve asks …" |
| Decline needs a reason (r2) | new suite: "Decline needs a reason …" |
| Empty queue says so (r2) | new suite: "an empty queue says so" |
| Doctor's files through the sign-off route (r4) | new suite: "lists and views the X-ray through the sign-off route" |
| Auto-sent says emailed / auto-send failed (r5) | new suite: "what the approval did" ×2 |
| Doctor edits fields and note; Approve waits; signoff directory, not tc.full (r6-hub) | new suite: "the doctor edits fields and their own note …" |
| Send back needs a question → draft (r6-hub) | new suite: "send back with a question …" |
| Doctor adds files while editing, list re-read (r62) | new suite: "while editing: Add files, through the sign-off route …" |
| Fail-closed identity: doctor never sent to the prefs route (r2 watch tests) | **unchanged** in `tc-referrals-r2`; plus new: "while auth loads: a spinner, and no route of either kind" |
| Nav hides everything while permissions unknown (role-nav) | **unchanged** |

New pins: hub-panel sign-off for signers only; the policy-on confirmation (Back cancels, then "Approve and email"); policy-unread wording; one-click approve only when the policy is read as off; refusal moves nothing; no doctor's move off `pending_signoff`; a doctor gets no staff control and makes no `tc.full` call; TC on `?view=signoff` gets the hub; admin can switch between the views; `ROLE_HOME`/`canVisit` for the doctor; the Received dedupe.

## Gates (local, Node 22, pnpm 10.4.1, `--frozen-lockfile`)

- `pnpm run check`: clean.
- `pnpm run test`: 187 files passed, 36 skipped, 0 failed.
- `node --check server.js`: OK.
- `node --test`: 4184 tests, 4181 pass, 0 fail, 3 skipped. No backend file changed.

No screenshots were added. The only fixtures are synthetic: 12827 (roland) and 7115 (valley).

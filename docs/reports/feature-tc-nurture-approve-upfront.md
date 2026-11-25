# EL-2c — Nurture campaigns written at Start and approved up front

Branch `feature/tc-nurture-approve-upfront`, cut from `origin/develop` at `472e219` (it contains PR #359). PR **#360** targets `develop`. **Not merged. Auto-merge is not armed.**

It is a RED-lane slice. It touches:

- a tenant migration
- the shared vocabulary
- the nurture generator
- the message state transitions

## What it does

Beau ruled on 2026-11-25: *"Nothing sends that a human has not approved word for word. Approved emails send on their scheduled date unless a stop condition fires."*

This slice builds everything in that ruling except the automatic sender. The sender is EL-2d, which gets its own review. **After this slice an approved email waits. Nothing new can send.**

**Nothing sends automatically.**

- No job, hook, route or timer added here calls `sendMessage` or a channel adapter.
- `sendMessage`'s function body is byte-identical. Its sha of the extracted function is `7de8588b…` both before and after.
- The adapters and `consent.js` are unchanged.
- `tc_nurture_enabled` is untouched, and there is no new switch.
- The hard caps are unchanged and still not configurable.
- There are no Open Dental reads or writes, no AI calls, no `.env` access and no new secrets.

### 1. Start writes the whole campaign

`POST /api/tc/nurture/enrollments` for a library enrollment writes every step as a `draft`, each with a `scheduled_for` time. The drafts go in the same transaction as the enrollment. The library path is the only one that changed. The hand-written (item-47) path is unchanged.

All or nothing:

- Every step is rendered before any row is written.
- If one step fails (`UNRESOLVED_MERGE`, or another library render error), the enrollment is refused with that code, for example `409 UNRESOLVED_MERGE` with a `token`.
- In that case there is no enrollment row, no message, no event and no case status change.

**How a step's time is planned.** The logic is in `services/tcNurture/engine.js`, which is pure: no database and no clock.

1. The enrollment day plus the step's `day`, at 10:00 office time (`cfg.timezone()`). Nothing is planned before the enrollment instant itself.
2. A time outside Mon–Fri 09:00–16:00 office time moves to the window's next opening, which is 09:00 on the next weekday. Both 09:00 and 16:00 count as inside.
3. After every move, the hard caps are re-checked with the existing `capCheck`, counted in local days as the generator already does.
   - A violation moves the email to the day `capCheck` names, at 10:00, and then back through step 2.
   - Each later step is placed after the one before it, so later steps only ever move later. Nothing is planned earlier than the sequence says.

I checked every library sequence, for every procedure, starting on any weekday or weekend: it plans inside the window, in order, with no cap violation. `tcNurturePlan.test.js` covers this.

**Events.** Start writes one enrollment event, for example: "…10 emails written for review, the first planned Dec 1. Nothing sends until a person approves each one." It does not write one event per email.

**The enrollment stays `active`.** This was the trap the brief warned about. A library campaign is `completed` only when every one of its emails is sent or skipped:

- A failed send counts as finished, because it is terminal and never retried.
- A send in flight (`sending`) counts as unfinished.

Three paths check for completion:

- **Skip:** done in the same transaction.
- **Send route:** after a person sends a campaign email by hand, the route calls `settleNurtureAfterSend`. This call is outside `sendMessage`, never throws, and never sends.
- **Nightly sweep:** catches everything else, such as a failed send or a discarded draft.

**What `next_touch_index` means now.**

- For a library enrollment it is the number of steps written. It equals `stepCount` from Start onward, and the CHECK stays at ≤ 12.
- It no longer says anything about sending. That is what `approvedCount`, `sentCount`, `skippedCount` and `nextSendAt` are for.
- `next_touch_due_at` is `null`, so the nightly pass never lists the enrollment as due.
- The entity's `nextTouchKey` is now the stage of the next email still waiting, counted from the messages rather than the index.
- For hand-written enrollments both fields mean exactly what they did before.

**Nightly pass.**

- A library enrollment started under #359 that still has unwritten steps gets all of them written at once, planned from today. This happens exactly once, because the claim moves the index to the end.
- The #359 drafts it wrote earlier had no planned time. They get one in the same re-plan, so order, spacing and caps hold across all of them. What already went out counts against the caps.
- After that, the nightly pass does nothing for library enrollments except the completion sweep.
- The hand-written path is unchanged; the dead library branch inside it was removed. `tcNurtureGenerator.test.js` passes unedited.

### 2. Review actions

These live in `services/messaging/index.js`, beside `skipNurtureDraft`. The routes are under `/api/tc/nurture`. Every action follows the same rules:

- **Office:** taken from the message row (or enrollment row). The other office's row gets `409 OFFICE_MISMATCH`.
- **Actor:** the request's SSO identity.
- **Double clicks:** every change is a conditional UPDATE on the status it expects, so a double click changes the row once.
- **Audit:** each change is audited with ids only (`tc_message.approved`, `.unapproved`, `.rescheduled`, `.replanned`, `.skipped`).

| Action | Route | Rules |
| --- | --- | --- |
| approve | `POST /messages/:id/approve` | Draft → `scheduled`, setting `approved_by` and `approved_at`. Refused for: no `to_address` (409 `NO_ADDRESS`), no subject (400 `SUBJECT_REQUIRED`), a campaign that is not active (409 `ENROLLMENT_NOT_ACTIVE`), a message that is not a library email (409 `MESSAGE_NOT_APPROVABLE`), and an already approved email (409). If the planned time has passed or was never set, the campaign's late emails are first moved forward from now, the same way Resume does it. The new time is returned along with `replanned` (how many emails moved). |
| approve-all | `POST /enrollments/:id/approve-all` | One transaction, all or nothing. A draft that can't be approved refuses the whole request and names it, for example "Email 4 of 5: …". Writes one audit row per email and returns the count. A second click approves 0. |
| unapprove | `POST /messages/:id/unapprove` | `scheduled` → draft. Clears the approval fields and keeps the planned time. Always allowed. |
| reschedule | `POST /messages/:id/reschedule` `{date, time}` in office time | Works on a draft or an approved email. Each refusal names the rule: `TIME_IN_PAST`, `OUTSIDE_SEND_WINDOW`, `OUT_OF_ORDER` ("has to go before email 3"), `CAP_WOULD_EXCEED` (with `rule` set to `MIN_GAP`, `MAX_PER_7_DAYS` or `MAX_PER_ENROLLMENT`). An approval is kept. Sending the same time twice changes nothing the second time. |
| skip | `POST /outbox/:id/skip` (existing) | Now also accepts `scheduled`. Sets `skip_reason` to `manual`. Finishes the campaign if this was its last waiting email. |
| edit | `PUT /api/tc/messages/:id` (existing) | A library draft's body is editable. Its `email_blocks` are re-derived from the edited plain text by the library's own `textToBlocks`. The text must have no `{{`, no control, bidi or format characters, and at most 8000 characters. The subject gets the same checks. Other block-built emails keep today's subject-only refusal. An approved email gets `409 MESSAGE_NOT_EDITABLE` ("Unapprove it first…"). |
| send | `POST /api/tc/messages/:id/send` | `sendMessage` is not modified. A `scheduled` row gets `409 MESSAGE_NOT_SENDABLE` before any adapter is looked up. The UI says "Unapprove to edit it or send it by hand." |

There is also a new read, `GET /enrollments/:id/campaign`. It returns the campaign's emails in order, it is audited (`tc_nurture_campaign`), and it always reports `automaticSending: false`.

### 3. Stop and pause

**Stop.** When an enrollment stops for any reason, every `draft` and `scheduled` message it has becomes `skipped`, in the same transaction:

| Stop reason | `skip_reason` |
| --- | --- |
| Case moved to a terminal status | `case_terminal` |
| A STOP text, a manual opt-out, or the unsubscribe link | `opted_out` |
| A person clicked Stop | `stopped_by_user` |

- This applies to hand-written enrollments too. Before this slice, a stopped campaign's leftover draft stayed sendable.
- The stop event says how many messages were cancelled, for example "— 4 waiting messages cancelled". The count is added only when there is at least one. That keeps every existing event description byte-identical when nothing was waiting.
- A message being sent at that moment (`sending`) is left to finish.

**Pause.** Pausing changes no message. That covers an inbound text, a manual Pause, and the new **Patient replied** action:

- `POST /enrollments/:id/replied` pauses the campaign with `stop_reason = 'patient_replied'`, and Resume clears it.
- The event reads "…paused: the patient replied (marked by <actor>)".

**Resume.** For a library campaign that is fully written, emails whose planned time has passed are moved forward:

- Each email is re-anchored on today at its sequence offset, never earlier than its current time and never before now.
- The window and caps then place them, counted against what already went out.
- Order and spacing are kept, and emails are never bunched together.
- Approvals are kept, because the text did not change.

### 4. UI

- **Start Nurture (library):** writes the campaign and opens **Review campaign**. Each email shows:
  - its planned date and time in office time
  - its stage label
  - its subject
  - the rendered email, on **Show email**, through the existing render endpoint in a sandboxed frame
  - a status chip: Needs approval / Approved, sends Dec 1 / Sent / Skipped: <reason>
  - the actions: Approve, Edit, Change date, Skip, Unapprove
- **Review campaign header:** "3 of 10 approved" with a progress bar, and **Approve all N**, which asks for confirmation first.
- **Banner** on the review screen, the strip and the outbox: "Automatic sending is not switched on for this office. Approved emails will wait."
- **Case strip:** "Library: Dental Crown · Warm · 3 of 10 approved · 0 sent · next Dec 1", with **Review** and **Patient replied**. If the server sends no counts, the item-47 "N of M drafted" line still shows.
- **Stop dialog:** now says that waiting messages are cancelled.
- **Nurture Outbox:** a new "Library campaigns" section, one card per campaign, sorted by the next planned time. Each card shows:
  - the case
  - the track, procedure and tone
  - how many emails need approval
  - the next three waiting emails, by planned time
  - a **Review** button

  Hand-written drafts stay in their track groups. Their Approve is still the ordinary Send.
- **Screenshots** in `docs/screenshots/tc/`, light and dark each:
  - `tcnurture-10-review-campaign`
  - `tcnurture-11-review-actions` (shows the Approve-all confirmation, Edit and Change date)
  - `tcnurture-12-campaign-strip`
  - `tcnurture-13-outbox-campaigns`

## Migration

`backend/migrations-tenant/1795600000000_tc_messages_scheduled.js`

**New columns on `tc_messages`** (all nullable):

- `scheduled_for timestamptz`
- `approved_by text`
- `approved_at timestamptz`
- `skip_reason text`

**Status CHECK.** It is a strict superset of 1791100000000's list, with `'scheduled'` added. The literal is written inline.

**`tc_messages_scheduled_check`**, written to be NULL-safe (the #359 lesson):

```
status IS DISTINCT FROM 'scheduled' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND scheduled_for IS NOT NULL AND enrollment_id IS NOT NULL)
```

Every term in it is two-valued, so the expression can never evaluate to NULL and slip through.

**`tc_messages_skip_reason_check`:**

```
skip_reason IS NULL OR (status = 'skipped' AND skip_reason IN ('manual','case_terminal','opted_out','stopped_by_user'))
```

This one was not in the brief. I added it so that `skip_reason` is shared vocabulary like the status: the reasons are pinned to the `MessageSkipReason` zod enum.

**Index and grants.** A partial index `(office_id, scheduled_for) WHERE status = 'scheduled'`. No new grants: carein_app already has the access it needs, and the verifier proved it as that role.

**`down()`** returns `scheduled` rows to `draft` first. It then drops the index and both new CHECKs, restores the old status literal, and drops the columns.

**Number re-checked at push.** The newest tenant migration on `origin/develop` is still `1795500000000_tc_nurture_library.js`. The only open PR (#1) targets `main` and carries no tenant migration. `1795600000000` stands; no renumbering was needed.

**Real-SQL verifier.** `scripts/tc-nurture-approve-verify-queries.js` is a new CI step in `build-test.yml`. I ran it on a throwaway Postgres 16 with the CI role layout and every control and tenant migration applied. It passed all 7 Part-A checks and a real `down()` → `up()`:

1. A `scheduled` row missing each one of `approved_by`, `approved_at`, `scheduled_for` and `enrollment_id` is inserted on its own and refused with `23514`. So is a row missing all four. The complete row is accepted.
2. An unknown `skip_reason`, a reason on a non-skipped row, and the status `approved` are refused. All four reasons and a pre-EL-2c NULL are accepted.
3. **The real routes on the real schema.** These run through the assembled `/api/tc` stack, with every BEGIN/COMMIT turned into a savepoint. Start wrote the enrollment and all 5 steps as planned drafts in one transaction.
4. A render failure wrote nothing: no enrollment, no messages, and the case did not move.
5. Approve, unapprove, approve-all and reschedule all produced rows the CHECKs accept.
6. Stop left every email `skipped` with `stopped_by_user`.
7. As `carein_app`, the approve UPDATE and the cancel UPDATE both work.

During all of this, `sendMessage` and `getAdapter` were replaced by functions that throw.

The real schema caught one bug that the fake database could not. Unapprove reused one `$3` parameter for both a text column and a timestamp column, and Postgres answered "inconsistent types deduced for parameter $3". I fixed it.

The #359 verifier (updated: see the edited tests below), the EL-1, AT-1 and office-format verifiers all still pass. Their down/up steps now skip correctly, because their migrations are no longer the newest.

## Every reader of message status

| Reader | What it does with `'scheduled'` |
| --- | --- |
| `shared/tc/messaging.ts` `MessageStatus` | Contains it. `SENDABLE_MESSAGE_STATUSES` stays `["draft"]`. |
| `client/.../messaging/copy.ts` `STATUS_LABEL` / `STATUS_TONE` (`Record<MessageStatus,…>`) | "Approved — waiting, not sent", with the `info` tone. The compiler flagged both maps. `EMAIL_STATUS_LABEL` is a Partial and falls back to the above. |
| `client/.../nurture/campaignCopy.ts` `REVIEW_CHIP_TONE` (new `Record<MessageStatus,…>`), `reviewChipText` (exhaustive switch) | "Approved, sends <date>", in violet. |
| `client/.../caseview/MessagesTab.tsx` (`isDraft = status === "draft"`) | Shows the message with its chip. There is no Send, Edit or Discard, because only a draft gets those. |
| `client/.../nurture/NurtureOutbox.tsx` | Shows it in the "Library campaigns" card. Never in the hand-written groups, which are drafts only. |
| `client/.../nurture/NurtureCampaignReview.tsx` | Offers Unapprove, Change date and Skip. |
| `services/messaging/index.js` `sendMessage` | Refuses it (409 `MESSAGE_NOT_SENDABLE`), because only a draft is sendable. Unchanged. |
| `services/messaging/index.js` `editDraft` | Refuses it with "Unapprove it first". |
| `services/messaging/index.js` `discardMessage` | Refuses it, because only a draft can be discarded. Unchanged. |
| `services/messaging/index.js` `skipNurtureDraft` | Skips it, with `skip_reason` set to `manual`. |
| `services/messaging/index.js` `listMessages`, `renderMessage` | Return it or render it like any outbound email. |
| `services/messaging/index.js` `recordUnsubscribeLink` | Matches by token hash, and a `scheduled` row has no token. Unaffected. |
| `services/messaging/index.js` `countUnseen`, `listUnseenOnCases`, `listInbox`, `markSeen` | These read inbound `received` only. Unaffected. |
| `services/messaging/twilio/status.js`, `acs/smsStatus.js` | The delivery-report ladder (`RANK`) has no `scheduled`, so `replaceableBy` never lists it. A provider callback can't touch an approved row. Twilio's own provider status `"scheduled"` maps to our `queued` and is unrelated. |
| `routes/tc/activityFeed.js` (case and patient feed) | Uses explicit allow-lists (`sent`, `delivered` / `queued`, `sending`, `received`). An approved email is not in the feed, the same as a draft. |
| `routes/tc/activityChart.js` (Log to chart) | Reads by id through `mapMessage`. A `scheduled` row is never offered, because it is not in the feed. If one were mapped, `pending` would be true. |
| `routes/tc/communications.js` | Its status filter is on `tc_communications`, a separate table. |
| `routes/tc/nurture.js` outbox and campaign reads | Lists it among an enrollment's waiting emails. |
| `services/tcNurture/store.js` | `WAITING_STATUSES` is `draft` + `scheduled`, used for counts, `nextSendAt`, cancel and completion. `UNSETTLED_STATUSES` adds `sending`. `touchesOf` (the hand-written cap history) counts any status, which is unchanged and unreachable for hand-written rows. |
| `services/tcNurture/generator.js` (catch-up) | Treats waiting rows as re-plannable and sent or failed rows as fixed for the caps. Skipped rows are ignored. |
| Funnel, reports, nav badges | None of them read `tc_messages.status`, apart from the unseen badge above, which is inbound only. |

## Tests

| Gate | Result |
| --- | --- |
| Backend `node --check server.js` | OK |
| Backend `node scripts/shard-runner.mjs` | 4 shards, **5,245 tests: 5,242 pass, 0 fail, 3 skipped**. No Node-22 deserialize flake on this run. |
| Dashboard `pnpm run check` (`tsc --noEmit`) | **Clean** |
| Dashboard `pnpm run test` | **237 files passed, 43 skipped. 3,417 tests passed, 264 skipped, 0 failed.** This includes the `tc-contract-bundle` byte-compare. The bundle was regenerated with the pinned esbuild. |
| Real-SQL verifiers | EL-2c: 7 Part-A checks plus down/up. #359, EL-1, AT-1 and office-format: pass. |

**New test files:**

- `backend/services/tcNurture/tcNurturePlan.test.js` (13 tests), on the planner:
  - the window
  - a weekend step moving to Monday
  - the 48h fixture pushed later, never earlier
  - the 3-in-7 cap on its own
  - every sequence and procedure from any start day
  - DST
  - re-plan forward
  - the rule wording
- `backend/routes/tc/tcNurtureApprove.test.js` (26 tests), on the real assembled router:
  - Start writing N planned drafts in one BEGIN/COMMIT
  - a render failure writing nothing
  - hand-written Start unchanged
  - each review action's happy path, each refusal, and a double request
  - edit re-deriving blocks; `{{`, bidi and control characters refused; a scheduled email refusing edit
  - the real `sendMessage` refusing a scheduled email
  - stop cancelling with the right `skip_reason` for library and hand-written campaigns, through all three hooks and the route
  - Patient replied
  - Resume
  - completion after a skip, a hand send and the sweep
  - the #359 catch-up exactly once
  - the campaign and outbox reads
  - an OD/send source scan

  `sendMessage` and `getAdapter` are replaced by throwers in every test except the one that proves the real `sendMessage` refuses a scheduled email.
- `backend/test/tcMessagesScheduledMigration.test.js` (6 tests), on the migration's static shape, including the NULL-safe literal and the schema replay.
- `new-dashboard/tests/tc-nurture-approve.test.tsx` (12 tests): Start opening Review, the review screen, the strip and the outbox. `sendMessage` must never be called.
- `new-dashboard/tests/tc-nurture-approve-shots.test.tsx`: the screenshot dumps. It is skipped unless `TC_SHOTS=1`.
- Fixtures: `new-dashboard/tests/fixtures/tcNurtureCampaign.ts` and `tc-nurture-crown-campaign.json`. The JSON holds the library's own composed text for the roland test patient.

No Open Dental imports were added anywhere. The existing source scans over `services/tcNurture` and `services/tcEmailLibrary` pass, and a new scan covers the new messaging functions and the migration. `messaging/index.js` already required `config/odOffices` and `consent.js` before this slice. Both are unchanged, and the new code doesn't use either.

## Edited existing tests (before → after)

Every edit falls under one of the brief's allowed categories. I edited no other existing test.

**(b) Library enrollments drafting one step per night.** All four are in `backend/services/tcNurture/tcNurtureLibraryGenerator.test.js`:

1. "a library enrollment writes ONE email draft…" → "EL-2c catch-up: a #359-era library enrollment gets EVERY step written in one pass…"
   - Before: `msgs.length === 1`, `next_touch_index === 1`, next due 2 days later, event "(tp_recap, 1 of 10)".
   - After: `msgs.length === 10`, in sequence order, each a draft with `scheduled_for`. `next_touch_index === 10`, `next_touch_due_at === null`, status `active`. Times inside the window, within the caps and in order. One event "10 emails written for review at once (steps 1–10 of 10)".
   - Unchanged: the `compose()` byte-match on the first email, the block checks, no audit rows, and the send tripwire.
2. "a second pass … writes no second draft" → "EL-2c catch-up happens exactly once…"
   - Before: 1 message after two passes. The stale row came from `listDue` at a later instant.
   - After: 10 messages after two passes. The second pass reports `completed === 0`. The stale row is the seeded row with index 0, because a written-in-full enrollment is never due again, so `listDue` would return nothing. It still returns `lost_claim`.
3. "UNRESOLVED_MERGE: the office phone unset after enrolling…" → "…unset before the catch-up ⇒ not one draft…"
   - Before: one good pass, then the phone was cleared, then an assertion of still 1 message and one event.
   - After: the phone is cleared before the only pass. Messages: 0. Events: none. Same `errors === 1`, no advance, and the log line still has no patient name.
4. "a procedure that skips a stage…"
   - Before: `toEnrollment(e, 1).nextTouchKey === 'last_touch'`.
   - After: `msgs` are `['objection_time', 'last_touch']` and `toEnrollment(e, 2, msgs).nextTouchKey === 'objection_time'`, the next waiting email.

   The file's header lines changed to match.

**`backend/routes/tc/tcNurtureLibrary.test.js`**, "library enroll: 201 … nothing drafted":

- Before: `tc_messages.length === 0` ("enrolling drafts nothing").
- After: `=== 10`, all drafts. The title now ends "…every email written as a draft".
- Its `nextTouchKey === 'tp_recap'` assertion and the event regex pass unchanged.

**`backend/scripts/tc-nurture-library-verify-queries.js`**, the #359 real-SQL verifier's generator step. It is a CI script, not a unit test. I list it because it pinned the same one-a-night behavior:

- Before: one draft, `next_touch_index` 1, still one after a second pass.
- After: ten drafts, each with `scheduled_for`. `next_touch_index` 10, status `active`, still ten after a second pass.

**(d) The exhaustive `MessageStatus` lists:**

- `backend/test/tcMessagingMigration.test.js`: `STATUSES_ADDED_LATER` was `['skipped']` and is now `['skipped', 'scheduled']`.
- `backend/test/tcNurtureMigration.test.js` "the three widened shared CHECKs…":
  - Before: `checkList(...status_check) == MessageStatus.options`.
  - After: `== MessageStatus.options.filter(s => s !== 'scheduled')`, with a comment saying the new migration's test now pins the whole vocabulary. This mirrors how AT-0's `notes_updated` is handled in the same test.

**Categories (a) and (c):** no existing test pinned leftover drafts surviving a stop, or `editDraft` refusing a library body, so none needed editing. All existing dashboard tests pass unedited, including the #359 strip test (an old-server fixture with no counts still shows "1 of 10 drafted") and the three-argument hand-written `startNurture` pin.

## Files changed

**Backend**

- `migrations-tenant/1795600000000_tc_messages_scheduled.js` (new)
- `services/tcNurture/engine.js`: the planner
- `services/tcNurture/store.js`: campaign stats, `cancelWaiting`, `completeIfFinished`, `toEnrollments`
- `services/tcNurture/generator.js`: write-in-full helpers, the #359 catch-up, the completion sweep
- `services/tcNurture/hooks.js`: every stop cancels
- `services/messaging/index.js`: `MESSAGE_COLS` and `toMessage`; the review actions; `editDraft`; `skipNurtureDraft`
- `services/messaging/errors.js`: new codes
- `routes/tc/nurture.js`: Start, stop, resume, replied, the campaign read, the outbox, the review routes
- `routes/tc/messages.js`: `settleNurtureAfterSend` after a send
- `scripts/tc-nurture-approve-verify-queries.js` (new)
- `scripts/tc-nurture-library-verify-queries.js`: the edit listed above
- `tc/contract.gen.cjs`: regenerated
- `.github/workflows/build-test.yml`: the new CI step

**Shared**

- `new-dashboard/shared/tc/messaging.ts`: `scheduled`, `MessageSkipReason`, and the four new message fields
- `new-dashboard/shared/tc/nurture.ts`:
  - the send window, `NURTURE_PAUSE_PATIENT_REPLIED`, `NurtureRescheduleBody`
  - `nurtureEmailTextProblem`
  - the enrollment counts
  - the campaign, outbox-campaign and approve-all shapes
  - `NURTURE_AUTOMATIC_SENDING_NOTE`

**Dashboard**

- `features/tc/messaging/copy.ts`
- `features/tc/nurture/NurtureCampaignReview.tsx` (new)
- `features/tc/nurture/NurtureCampaignBar.tsx`
- `features/tc/nurture/NurtureOutbox.tsx`
- `features/tc/nurture/campaignApi.ts`
- `features/tc/nurture/campaignCopy.ts`

**Tests, docs and screenshots:** the test files listed above, 8 PNGs, and this report.

The `services/tcNurture/` file-list pin is respected: no new non-test file was added there. No file was deleted.

## Staging plan (6 steps)

Use only the designated test patients: roland **Test 2, Stedi (PatNum 12827)** and valley **Stedi TestValley (PatNum 7115)**. Set each case's email to Beau's own address. Leave `tc_nurture_enabled` as it is on staging.

1. **Start.** On the roland Test 2, Stedi case, choose Start Nurture → library → **Dental Crown**, **Warm** → **Warm Follow-Up**.
   - Expect: Review campaign opens with 10 emails, each with a planned weekday time between 9:00 and 4:00.
   - Expect: "0 of 10 approved" and the banner "Automatic sending is not switched on… Approved emails will wait."
   - Expect: the case timeline shows one "10 emails written for review" event.
2. **Approve and edit.** Approve email 1. Edit email 2's text, then Show email and confirm the preview shows your edit.
   - Try typing `{{first_name}}`. Expect: Save is disabled, and the server refuses it too.
   - Approve email 2, then try Edit. Expect: refused with "Unapprove it first."
3. **Reschedule.** Use Change date on email 3:
   - a Saturday → refused with `OUTSIDE_SEND_WINDOW`
   - the day after email 2 → refused with `CAP_WOULD_EXCEED`, naming the 48-hour rule
   - a later weekday at 11:30 → accepted

   Then Approve all and confirm. Expect: "10 of 10 approved", and the strip reads "…10 of 10 approved · 0 sent · next <date>".
4. **Nothing sends.** Wait past email 1's planned time. Confirm nothing arrived in Beau's inbox.
   - On the Messages tab, email 1 shows "Approved — waiting, not sent" with no Send button.
   - Unapprove it. It becomes a draft, and Send by hand delivers it through the normal send path, with the consent checks. The strip then shows "1 sent".
5. **Pause and resume.** Click **Patient replied** on the strip. Expect: paused, "the patient replied (marked by …)", and every email still approved.
   - The next day, Resume. Expect: any email whose time passed is moved forward from today, in order and spaced as before, and still approved.
6. **Valley, then Stop.**
   - Under `?office=roland`, try to review the valley Stedi TestValley (7115) case's campaign after starting a library campaign there under valley. Expect: 409 `OFFICE_MISMATCH`.
   - Stop the roland campaign with a reason. Expect: every waiting email shows "Skipped: the campaign was stopped", the event says how many were cancelled, and the nightly pass writes nothing for it.

## Notes for the reviewer

- **For EL-2d.** These must be enforced where the sender sends, not here:
  - The sender must check that the enrollment is `active`. A pause leaves approved emails `scheduled`.
  - It must send only rows whose `to_address` still matches the case.
  - Consent, the unsubscribe flag and `consent_blocked_hint` are not checked at approve time. Approving an email to an opted-out address is allowed and harmless, because nothing sends it.
- **Holidays.** The send window does not know about holidays. One fixture plan lands on Fri Dec 25.
- **Hand sends.** A library draft can still be sent by hand from the Messages tab, out of order. That is a human approving it word for word, which is the ruling, but `sendMessage` (unchanged) does not check the caps.
- **Cancelled-message audit rows.** Rows cancelled by a stop through a hook (terminal case, opt-out, STOP, the unsubscribe link) are audited through their enrollment's `.stopped` row. The hook return shapes stayed as they were, so the individual message ids aren't returned there. A manual Stop audits each cancelled message.
- **Preview preheader.** The review screen's preview shows "Preheader: (empty)", because the render endpoint returns no preheader. This is the same as today's Messages tab preview. The stored preheader is sent.
- **Stale git lock.** `C:\Users\beau\carein cursor dashboard\.git\packed-refs.lock` is still the empty lock from 2026-11-19. Git prints a warning on every ref operation, but commits and refs land correctly. I left it in place because it is in the shared repository.

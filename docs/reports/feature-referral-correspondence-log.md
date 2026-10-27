# R6.9: Referral correspondence log

**Branch:** `feature/referral-correspondence-log` (off `origin/develop` 942603f) · **Lane:** RED, NEEDS REVIEW, not merged

Staff can now record a contact with the specialist's office or the patient on a referral, and the card shows the latest one.

## What changed

1. **Log action.** The hub's detail panel has a **Log correspondence** button for tc.full staff. It shows on every status except draft.
   - The form asks who and which way (from or to the specialist's office, from or to the patient), how (phone, email, fax, other) and what was said.
   - The note is required and capped at 2000 characters. The server checks the cap in its request validation, and the database checks it again.
   - It calls a new route, `POST /api/tc/referrals/:id/correspondence`, with a strict body. Any extra field gets a 400, including office, status, actor, a timestamp or verb.
   - The route runs in one tenant transaction:
     - row-lock the referral, then read it for this office;
     - refuse a draft with a 409, `REFERRAL_CORRESPONDENCE_NOT_ALLOWED`;
     - write a `correspondence` event with from = to;
     - write an audit row (`UPDATE` on `tc_referral`, with prior status and source `referral_correspondence`).

     If the audit write fails, the event rolls back. The answer is the referral as read back afterwards.
   - The status never changes. Nothing is sent, and Open Dental is not touched.
   - **The case panel's referral rows do not use the hub's detail component**, so the action lives only in the hub. The brief allowed for this.
2. **Vocabulary.** New migration `1792800000000_tc_referral_correspondence` (develop's newest was 1792700000000):
   - The verb CHECK is widened to R5b's list plus `correspondence`. A test pins it equal to `TC_REFERRAL_ALL_EVENT_VERBS`.
   - Three nullable columns on `tc_referral_events`: `correspondence_direction`, `correspondence_party` and `correspondence_channel`. Each has its own vocabulary CHECK, pinned equal to the contract.
   - Three more CHECKs: only a correspondence row carries those three facts, and it always carries all three; a correspondence row always has from = to; its note is 1–2000 characters.
   - No backfill and no grant change. `down()` turns correspondence rows back into unlabelled history rows, keeping the note, and restores R5b's CHECK exactly.
3. **Every reader of the verb, checked:**
   - **Timeline labels:** the `REFERRAL_EVENT_LABELS` map must cover every verb, so the new entry is checked by the typecheck. The row renders as "Phone call from specialist's office" with the note under it.
   - **`NON_MOVE_VERBS`** now includes it. So a logged contact never hides a doctor's open question, and never clears a failed send.
   - **Unsubscribe lookup** (`messaging/index.js`) only reads `send`, `send_conflict` and `patient_email_sent`. Correspondence rows carry no unsubscribe hash. Unaffected, no edit.
   - **The send path** (`referralSend.js`) reads history only to find the last failed send, which skips non-moves. **Untouched.**
   - **The specialist's letter** does not read history, so nothing logged can reach the specialist's email.
   - **Badge maps and the case chip** don't key on the event verb. No edit needed.
4. **Card line.** Hub cards and case rows show a muted line: "Last contact: phone from specialist, Oct 27". Hovering shows the note.
   - It comes from the existing batched query that builds the list rows. It now covers every row in the list, not only sent ones, so one events query serves the whole list. No per-row query was added; a test counts the queries.
   - Contract additions are optional fields only: `TcReferral.lastCorrespondence` and `TcReferralEvent.correspondence`. The contract bundle was regenerated, and the byte-compare test passes.

**Guardrails held:**
- No Open Dental access.
- `referralSend.js`, `referralTransitions.js` and `referralAttachments.js` are untouched.
- The state machine is untouched.
- The office always comes from the server, and the body is strict.
- TypeScript is strict and the typecheck is clean.

## Decisions for you

1. **The brief and R4 conflict on attachments.** R4 accepts a file only while a referral is **a draft or awaiting sign-off** (`ATTACHABLE_STATUSES`, otherwise 409 `REFERRAL_LOCKED`). Correspondence is offered on everything except drafts. With R4 unchanged, a file can go with a logged contact **only while the referral awaits sign-off**.
   - On any later status the form shows R4's own rule instead of a file picker ("Files can be added only while a referral is a draft or awaiting sign-off…"), and the note still logs.
   - Allowing a fax copy on a sent referral means changing R4's status rule. That is a separate decision; I did not make it.
2. **At the 5-file cap**, the form shows R4's sentence ("A referral can carry at most 5 files…") instead of the picker. If R4 refuses anyway, because someone else used the fifth slot at the same moment, its refusal shows under the button ("Logged. pa.png was not attached: …"), and the contact stays logged. The cap is untouched.
3. **Order: the note first, then the file.** A refused file never loses the note. The cost is that a logged contact can end up without the file someone meant to attach; when that happens, the form says so.
4. **Logging bumps `updated_at`.** The row lock is taken the way R4's upload takes it, with an `UPDATE … SET updated_at = now()`. The hub sorts by `status_changed_at`, so card order doesn't change.
5. **The latest contact shows on every status, including a referral returned to draft** (it keeps what was logged before).

## Pre-existing test edits (for ratification)

| File | Edit |
|---|---|
| `backend/routes/tc/tcReferralSend.test.js` | The full event-verb list gains `'correspondence'` at the end. This is the pre-ratified shape. |
| `backend/test/referralLinksMigration.test.js` | R5b's migration CHECK was pinned to the **live** list (`TC_REFERRAL_ALL_EVENT_VERBS`), and the live list now has one more verb. The pin now points at the frozen `TC_REFERRAL_R5B_EVENT_VERBS` (R5 + the four link verbs). It is the same pattern R5 used when R5b arrived. The live list is now pinned by the new migration's test. |

No dashboard test was edited.

## New tests

- **Backend `tcReferralCorrespondence.test.js` (11):**
  - The verb is a non-move, and the transition and send files don't mention it.
  - Event + audit, with the status unchanged.
  - A failed audit rolls back.
  - Per-status availability across all 9 statuses (draft refused, writes nothing).
  - 15 strict-body refusals, and a note of exactly 2000 characters is accepted.
  - Another office's referral gets a 404, and a doctor is refused before the route.
  - At the cap, R4 refuses the sixth file with `ATTACHMENT_LIMIT` and the logged contact stays.
  - After sign-off, R4 refuses the file with `REFERRAL_LOCKED`, and R4's rule is pinned unchanged.
  - The card line on the hub and on the case list (latest wins).
  - One batched events query per list read.
- **Backend `referralCorrespondenceMigration.test.js` (8):**
  - The verb CHECK equals the contract, and the column vocabularies equal the contract.
  - The three CHECKs on fields, status and note.
  - No new status or table; the send-fields CHECK is untouched.
  - `down()` restores R5b exactly.
  - Numbered above 1792700000000.
  - Schema replay finds all three columns.
- **Dashboard `referrals-correspondence-log.test.tsx` (25):**
  - Labels, latest wins, the card line, and that it is not a move (an open return and a failed send survive it).
  - Per-status availability, for each of the 9 statuses.
  - Never through the sign-off routes and never for a doctor.
  - The body sent, the read-back rendered, the status unchanged, and no other route called.
  - A refusal keeps the form and tries no file.
  - Note first, then file.
  - The cap and the after-sign-off rule.
  - R4's race refusal shown in its own words.
  - The card line on the hub card and the case row.

## Gates (local, Node 22, pnpm 10.4.1, `--frozen-lockfile`)

- `pnpm run check`: clean.
- `pnpm run test`: 189 files passed, 37 skipped, 0 failed. This includes the contract byte-compare.
- `node --check server.js`: OK.
- `node --test` was run three times:
  - Run 1: 4202 tests, 4198 pass, 1 fail.
  - Run 2: 4192 tests, 4187 pass, 2 fail.
  - Run 3: no failures.

  Each run's failure was a different whole file in a voice or Mango suite this change doesn't touch: `sendToTc`, `ingestionWatermark` and `onDemandTranscription`. All three pass in isolation (54/54). That matches the known Node 22 runner flake.

No screenshots. The only fixture patient is the synthetic Roland one (12827).

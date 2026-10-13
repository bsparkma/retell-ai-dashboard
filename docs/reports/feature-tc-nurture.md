# Queue item 47: TC Nurture Campaigns v1 (engine, manual enrollment, draft outbox)

Branch `feature/tc-nurture-engine` off `origin/develop` (acab2f7). Pushed, **not merged**. Expected lane: RED
(new routes, a tenant migration, a scheduler, UI).

## 0. Summary

- **Four fixed tracks** (`no_show_recovery`, `warm_followup`, `reactivation`, `large_case`), each with a
  **gentle / standard / assertive** schedule frozen in code. The office's per-track dial is the only cadence
  control. There is no cadence editing anywhere.
- **Drafts only.** A nightly generator (05:00 America/Chicago) writes `tc_messages` rows in the `draft` state.
  A person approves each one in the new **Nurture Outbox** on the Texts page, and Approve is the ordinary Send
  click. `messaging.sendMessage` is still the only send path, and consent and quiet hours are still enforced there.
  Nothing in this slice sends.
- **Zero Open Dental.** No OD reads or writes. Merge fields come from the case row (first name) and config
  (office name, office phone). A test scans the nurture service files for any OD or send call.
- **Ships dark** behind `platform_setting['tc_nurture_enabled']`, set per office. No row means off.
  `TC_NURTURE_ENABLED=false` is a break-glass that beats a stored `true`.
- **Hard caps** are enforced at boot and again at run time: at most 3 touches in any 7 days, at least 48h
  apart, at most 12 per enrollment, and never two SMS in a row. If any preset breaks a cap, the server will
  not start.
- **Tests:** backend 3,466 pass, 0 fail. Dashboard 148 test files pass, plus `pnpm run check`, which runs
  `tsc --noEmit` cleanly.

### Rulings and deviations to know about

1. **Reactivation / gentle.** Appendix A listed `ra2@67 (E)` and `ra5@127 (E)`, but ra2 and ra5 exist only as
   SMS copy, and as SMS they put two texts back to back. The boot cap check caught it. **Beau ruled
   (2026-10-13): swap in ra3 + ra4 (email).** Gentle reactivation is now ra1@7, ra3@67, ra4@127, ra6@187, all
   email.
2. **The first SMS must carry "Reply STOP to opt out."** `warm_followup/gentle` opens with wf3, whose
   approved copy has no suffix. The engine appends it to every SMS draft until one SMS from that enrollment
   has actually gone out (`sending`/`queued`/`sent`/`delivered`). So the first text a patient receives always
   carries it, even if an earlier SMS draft was skipped.
3. **Migration number `1791100000000`, not `1791000000000`.** Open PR #238 already holds
   `1791000000000_rcm_posting_intent.js`.
4. **Templates are frozen in code, not seeded into `tc_email_templates`.** See §4.
5. **The outbox lives on the Texts page (`/tc/texts`).** The spec said "Messages tab". The case's own
   Messages tab is per case, while the outbox spans every case in the office. The Texts page is the TC
   messaging page in the nav.
6. **"Approve all" per track** loops the ordinary Send one draft at a time, with a confirmation dialog first.
   There is no server-side bulk send, so the "one human click, one message" rule holds at the API.

## 1. Schema as built (`backend/migrations-tenant/1791100000000_tc_nurture.js`)

The migration is additive. It creates one new table, adds nullable columns, and widens three CHECKs to strict
supersets. CHECK literals are written inline and pinned to the contract by `test/tcNurtureMigration.test.js`.

**`tc_nurture_enrollments`**

The table uses `enrollment_id` and `office_id` rather than the spec's `id` and `office`, matching every other
`tc_*` table.

| column | type | notes |
|---|---|---|
| enrollment_id | uuid PK | |
| case_id | uuid NOT NULL → tc_cases ON DELETE CASCADE | |
| office_id | text NOT NULL, CHECK roland/valley | copied from the case, never from the client |
| track_key | text NOT NULL, CHECK the 4 keys | |
| intensity_at_enroll | text NOT NULL, CHECK gentle/standard/assertive | changing the dial later does not re-pace running enrollments |
| status | text NOT NULL default `active`, CHECK active/paused/completed/stopped | |
| stop_reason | text | `case_terminal` / `opted_out` (system), or the reason the TC typed. CHECK: `stopped` ⇒ non-blank |
| next_touch_index | int NOT NULL default 0, CHECK 0..12 | |
| next_touch_due_at | timestamptz | local midnight; NULL once nothing is left to draft |
| last_touch_at | timestamptz | |
| created_by, created_at, updated_at | | |

Indexes: a **partial UNIQUE on (case_id) WHERE status = 'active'**, so one case has at most one active
enrollment, and `(office_id, status, next_touch_due_at)` for the generator. The new table gets the role-guarded
`carein_app` CRUD grant.

**`tc_messages`:** there is no meta jsonb column, so per the spec's fallback the touch is stored as real columns.
- `enrollment_id` → tc_nurture_enrollments ON DELETE SET NULL
- `touch_key`
- `consent_blocked_hint`, CHECK `opted_out` / `email_unsubscribed` / `no_address`
- `skipped_by`, `skipped_at`
- status CHECK gains `skipped`

**`tc_case_events.type`** gains `nurture_paused`, `nurture_resumed`, `nurture_stopped`, `nurture_completed` and
`nurture_touch_queued`. `nurture_enrolled` already existed and is reused.

**`tc_library_config.section`** gains `nurture_config`, shaped `{ tracks: { <track>: { intensity } } }`. A track
with no entry runs at `standard`. The migration writes no row.

`down()` first deletes the rows that the narrowed CHECKs would refuse, then removes everything.

## 2. How it works

- **Frozen definitions:** `new-dashboard/shared/tc/nurture.ts`, written in TypeScript so the compile-time
  totality check is real.
  - `defineTrack` plus `satisfies` turn three mistakes into tsc errors: a missing intensity, an extra track, or
    a preset step naming an undefined touch. I verified each fails.
  - `backend/config/tcNurture.js` re-exports the definitions through the contract bundle and runs
    `assertPresetsWithinCaps()` when the module is required. `server.js` requires it at startup, so a bad
    preset stops the server at boot.
- **Generator:** `services/tcNurture/generator.js`. Each due enrollment runs in one transaction:
  1. **Claim** the enrollment. The UPDATE only matches if the row is still active and still at index *i*, so
     a stop that lands mid-pass, or a second pass, writes nothing.
  2. Render the touch.
  3. INSERT the draft.
  4. Write a `nurture_touch_queued` event.

  The last touch marks the enrollment `completed`, with no auto-chaining. The generator writes no audit rows,
  following the opportunities-sync precedent. Opening the outbox and clicking Send are both audited.
- **Caps at run time:** counted in office-local days, because the job runs once a day. 48h means "at least 2
  local days later", so a few seconds of start-time jitter never defers a lawful touch by a whole day. A
  deferred touch only moves its due date.
- **No back-fill:** the next due date is always the preset's gap measured from the moment the last touch was
  actually queued. On resume it is measured from today.
- **Consent hint at draft time:** Postgres only. It checks the `tc_contact_consent` opt-out row, the case's
  `nurture_unsubscribed` flag for email, and whether an address exists. The draft is always written; the hint
  is advisory. A draft with no address gets `to_address = NULL`, and `sendMessage` now refuses those up front.
  That is a new fail-closed guard: without it, `null === null` would have passed the address-changed check.
- **Email drafts** store a two-block snapshot in `email_blocks`:
  - the approved copy as a text block
  - the CTA as a `tel:` button to the office phone

  #231's renderer wraps the snapshot in its compliant shell. With no office phone configured
  (`TC_EMAIL_PRACTICE_PHONE_<OFFICE>`), the button is left out and `{{officePhone}}` reads "the office".
- **Exit hooks:** `services/tcNurture/hooks.js`.

  | Event | Effect on the enrollment |
  |---|---|
  | Case moves to a terminal status (accepted, partially_accepted, scheduled, started, completed, lost) | Stopped with `case_terminal`, inside the status-route transaction |
  | Inbound text from a phone matching an enrolled case in the same office | Paused (`stop_reason` null). Matched by normalized address, so a reply that landed unlinked still pauses |
  | Inbound STOP | Stopped with `opted_out` |
  | Manual opt-out, or an email unsubscribe-link click | Stopped with `opted_out` |

  No reply is ever sent from any of these.
- **Office derivation:** `POST /enrollments` takes a case id and no office. The office comes from the case row.
  `?office=` can only produce a 409 `OFFICE_MISMATCH`, never redirect. The enrollment-id routes work the same
  way.

## 3. Routes: `/api/tc/nurture/*`

All routes sit behind `requireModule('tc')` and `tc.full`.

| route | notes |
|---|---|
| `POST /enrollments {case_id, track_key}` | 201. Refusals: 404, 409 `OFFICE_MISMATCH`, 501 `FEATURE_DISABLED` (office off), 409 `CASE_TERMINAL`, 409 `ALREADY_ENROLLED` (active or paused; a DB unique violation maps here too), 409 `NO_ADDRESS`. Moves the case to `nurture` and writes `status_change` + `nurture_enrolled` + audit. |
| `POST /enrollments/:id/pause` · `/resume` · `/stop {reason}` | Events and audit on each. Resume recomputes the due date from today. A stopped enrollment cannot resume. |
| `GET /enrollments?case_id=` | Enrollment history, plus each track's availability and reason (`switched_off` / `case_terminal` / `already_enrolled` / `no_address`) |
| `GET /outbox` | Drafts grouped by track, per-channel readiness, `enabled`. Audited as a READ. |
| `POST /outbox/:messageId/skip` | `draft → skipped`, audited. Only for drafts the generator wrote; a TC's own draft is discarded, not skipped. Advances nothing. |
| `GET /config` · `PUT /config` | 400 `INVALID_TRACK` / `INVALID_INTENSITY`. Anything besides `intensity` is refused. Audited. |

## 4. Seed mechanism: the templates are frozen in code

I did not seed `tc_email_templates`. The 8 rows there came from the Slice 2 legacy importer
(`scripts/tc-import.cjs`, `is_seed` carried over from legacy JSON). No migration seed or seeder produced them.
That table is also the team's editable library, and it is email-only.

The nurture copy therefore follows the precedent of code-keyed templates in
`services/messaging/templates.js`:
- It lives in `shared/tc/nurture.ts`.
- Its key is stored in `tc_messages.template_id` as `nurture.<track>.<touch>`.
- Tests pin three rules: only the three merge fields appear, no SMS names a procedure or diagnosis, and every
  email has a subject and a CTA.

If you'd rather have the copy editable in the library, that's a follow-up. It would also need a guard so
nobody can strip the STOP suffix.

## 5. Turning it on in staging

1. Apply migrations as usual. Staging CI runs them on deploy from `develop`.
2. Write the per-office switch row in the **control** database:
   ```sql
   INSERT INTO platform_setting (key, value) VALUES ('tc_nurture_enabled', '{"roland": true}')
   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
   ```
   To switch it off again, set `{"roland": false}` or delete the row. For an emergency stop, set the app
   setting `TC_NURTURE_ENABLED=false`.
3. Optional: `TC_EMAIL_PRACTICE_PHONE_ROLAND` lets emails carry the call button and the real number.
4. Sending still needs the existing #230/#231 switches (`tc_sms_enabled` / `tc_email_enabled`) plus the office
   sender. Without them the outbox shows a banner and no Approve.

## 6. Staging test plan (a non-developer can follow it)

Use only the test patients: Roland **"Test 2, Stedi"** (PatNum 12827) or Valley **"Stedi TestValley"** (7115).
Use a staff phone and email you control on the test case.

1. **Off by default.** Before step 2 of §5, open the test case. The strip should read "Nurture campaigns are
   switched off for this office." Then open **TC → Texts**. The Nurture Outbox should say it is switched off,
   with no zeros and no "all caught up".
2. Switch Roland on (§5). Reload the case and click **Start Nurture**. You should see four campaigns, each
   showing its pace (e.g. "Standard · 3 touches · Text + Email"). Pick **No-Show Recovery**.
   - A toast says each touch waits in the Outbox.
   - The case status becomes **Nurture**.
   - Activity shows "Enrolled in No-Show Recovery…".
3. Click **Start Nurture** again on the same case. Every campaign should now be greyed out with "already has a
   campaign running or paused".
4. **Pause / Resume.** Click Pause and the chip reads Paused. Click Resume, and the "next draft" date is counted
   from today.
5. **Generator.** The next morning after 05:00 Central (ns1 is day 1), open Texts. A **No-Show Recovery** group
   should show one text draft starting "Hi Stedi…" and ending "Reply STOP to opt out." **Nothing has been sent.**
   Check the test phone to confirm.
6. **Approve.** Click Approve and the test phone receives the text. Click **Skip** on any other draft and it
   disappears. The campaign's next date does not change.
7. **Reply pauses it.** Text anything back from the test phone. The case's chip shows **Paused**, and Activity
   shows "paused: the patient replied". No automatic reply arrives.
8. **Terminal status stops it.** Resume, then change the case status to **Scheduled**. The campaign shows as
   stopped ("case moved to scheduled"), and no more drafts appear.
9. **STOP.** Start a new campaign, then text STOP from the test phone. The campaign stops ("replied STOP"), and
   Approve on any later text draft is refused as opted out.
10. **Dial.** Have a developer run `PUT /api/tc/nurture/config?office=roland` with
    `{"tracks":{"reactivation":{"intensity":"gentle"}}}`. The picker then shows Reactivation as "Gentle ·
    4 touches · Email".

## 7. Tests

Every guardrail the spec asked for is covered:

| Guardrail | Test file |
|---|---|
| Presets and caps, and the boot assertion throwing on each kind of violation | `services/tcNurture/tcNurtureEngine.test.js` (also simulates 200 nightly runs per preset across DST) |
| One-active constraint (route 409, DB unique-violation mapping, partial index pinned) | `routes/tc/tcNurture.test.js`, `test/tcNurtureMigration.test.js` |
| Terminal-status stop | `tcNurture.test.js` |
| Inbound pause, including same-office isolation, STOP, manual opt-out and unsubscribe link | `tcNurture.test.js` |
| Generator produces drafts and never invokes a send (trip-wires plus a static scan) | `services/tcNurture/tcNurtureGenerator.test.js` |
| Resume with no back-fill | `tcNurture.test.js`, engine test |
| Office derivation | `tcNurture.test.js` |
| Config validation codes | `tcNurture.test.js` |
| STOP suffix on the first SMS | engine and generator tests |

UI: `new-dashboard/tests/tc-nurture-campaigns.test.tsx`. Screenshots (light and dark) are
`docs/screenshots/tc/tcnurture-0[1-5]-*`. Recipe:
`pnpm exec vite build && TC_SHOTS=1 pnpm exec vitest run tests/tc-nurture-shots.test.tsx && node scripts/shoot-tc-nurture.mjs`.

Two older pinning tests were reformulated, not loosened. `tcMessagingMigration.test.js` and
`tcLibraryOpportunitiesConfigMigration.test.js` now pin only what their own migration told the database. The
whole current enum is pinned by the newest migration's test.

## 8. Open items for Beau

1. **Em dashes in SMS copy** (ns1, wf1, ra2, wf8, lc6, lc7). They push a text out of GSM-7, so each segment
   holds 70 characters instead of 160. That costs extra segments per text. The approved copy is unchanged;
   say the word if you want plain hyphens.
2. **lc3's sign-off** ("Dr. Beau Sparkman") goes out from both offices, as approved.
3. **No settings screen** for the dial in this slice (per item 45's precedent). Set it via the API.
4. **Single replica.** The generator's re-entrancy guard is in-process, same as the opportunities sync. The
   per-enrollment claim means a doubled pass would still write no duplicate draft.

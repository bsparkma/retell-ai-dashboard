# Referrals R5b — closing the loop after a referral email goes out

Branch `feature/referral-r5b-links`, cut from `origin/develop` at `df24ac6` (after #258 merged). RED lane: pushed, not merged.

All three pieces shipped in this slice. The patient email was not deferred.

## What it does

1. **The specialist's buttons.** The referral letter now carries two buttons: **"We received this referral"** and **"The patient is scheduled"**.
   - Each button is a one-time link, unique to the referral and to the recipient, and it expires after 60 days.
   - The token is 32 random bytes. Only its SHA-256 is stored, in `tc_referral_link_tokens`. The table has no column for the token itself.
   - The hashes are written in the **same transaction** that records the send. A link therefore exists exactly when its email is on the record. If a letter ends in `send_conflict`, its links are dead and land on the neutral page; the conflict row already tells staff to check by hand.
   - **Received** uses the **existing `mark_acknowledged` move** (sent → acknowledged), through `transitions.moveInTx`. The actor is `system:specialist-link` and the note says the confirmation came from the specialist's link. The timeline labels it "Specialist confirmed receipt (from the email link)" instead of "outside the app". If the referral is already acknowledged or further along, nothing moves and the click is still used up.
   - **Scheduled** writes a `patient_scheduled` row (no status move). When the clicker gives a date, it also sets `tc_referrals.scheduled_date`.
   - **No new referral status.**

2. **The patient's notice.** Once the letter is **recorded as sent**, the patient gets an email. It says who they are referred to, gives the specialist's phone, and has an **"I've scheduled my appointment"** button with an optional date.
   - The address comes from **that office's Open Dental, read-only**: one `GET /patients/{PatNum}` through `assertOfficeMatch(office, getOdOffice(office))`. That lives in `services/tc/referralPatientContact.js`, which is the send path's only Open Dental access.
   - If there is no address, a `patient_email_skipped` row records the reason: no email on file, not found, OD not connected, OD unreadable, opted out, or the lookup could not be audited. The specialist send is unaffected.
   - If ACS refuses the notice, a `patient_email_failed` row is written and the letter still reads sent.
   - If ACS accepts it, one transaction writes the `patient_email_sent` row (ACS id, address, unsubscribe hash), the patient link's hash, and the audit row `tc_referral.patient_email_send`.
   - The notice goes through the same transport and gates as the letter (kill switch, consent opt-out). It has its own working unsubscribe link and never carries the BCC.
   - The send's answer is unchanged. The notice's result rides beside it as `outcome.patientEmail`, and the hub toast appends it.

3. **The public endpoints.** `GET`/`POST /api/webhooks/referral-link/r` live in `routes/referralLinkWebhooks.js`. They are mounted beside the unsubscribe link, inside the `/api/webhooks` exemption, with no module guard. The tenant is resolved from `TC_EMAIL_TENANT_SLUG`, the same way the unsubscribe router does it.
   - GET only shows the page; it never acts, so mail scanners and prefetchers change nothing. POST acts once.
   - **Single use:** a conditional `UPDATE … WHERE used_at IS NULL AND expires_at > now` consumes the token inside the tenant transaction that also writes the event and the audit row. A failed audit rolls back everything, including the token's use. Of three simultaneous clicks, exactly one acts (tested).
   - **No oracle:** unknown, used, expired, malformed, missing and oversized tokens all get the same `NEUTRAL_PAGE`, byte for byte, on GET and on POST.
   - **Server-derived:** the office and the referral come from the token row. The only request fields read are `t` and `date`. A smuggled `referralId` or `office` is ignored (tested).
   - **Rate limited:** 20 requests per client per 15 minutes (IPv6 grouped by /64), and 600 per 15 minutes across all clients. Both limits apply to every hit.
   - **Audited:**
     - views write `tc_referral.link_view` (READ) and uses write `tc_referral.link_use` (UPDATE);
     - the result is SUCCESS for a live link, UNAUTHORIZED for anything the neutral page answers, and ERROR for a refused date;
     - the endpoint is recorded without its query string, so no token is in the trail;
     - a failed audit write answers 503.
   - **Minimum PHI:** the pages show the patient's first name and the practice and specialist names. No surname, DOB, reason, teeth, notes or files.
   - **Dates:** a real calendar date from 30 days ago to one year ahead, in the office's time zone. Any other date asks again and uses nothing up.

So a send is now **at most two messages**: one letter to the specialist (with any BCC on that same message) and one notice to the patient. `referralSend.js` is still the only send gateway.

## Migration

**`1792500000000_tc_referral_links`**. It is above develop's newest, `1792400000000`.

- **`tc_referral_link_tokens`** (new table):
  - columns: `token_hash` (PK, CHECK `^[0-9a-f]{64}$`), `office_id`, `referral_id`, `audience` (specialist|patient), `purpose` (received|scheduled), `created_at`, `expires_at`, `used_at`;
  - composite FK to `tc_referrals(office_id, referral_id)`;
  - CHECK that a patient link can only be `scheduled`;
  - CHECK that the expiry is after creation;
  - UNIQUE (office, referral, audience, purpose);
  - REVOKE PUBLIC, then a role-guarded grant.
- **`tc_referrals.scheduled_date`**: date, nullable.
- **`tc_referral_events`**:
  - the verb CHECK is widened to R5's list plus the four new verbs;
  - the send-fields CHECK now includes `patient_email_sent`, so that row must carry its ACS id, address and unsubscribe hash. The patient's unsubscribe link resolves through it.
- **`down`** relabels the R5b rows to NULL (clearing their email fields) and then restores R5's two CHECKs exactly.

I rehearsed it on a throwaway **Postgres 16**: every migration ran up, then down, then up again. I also exercised the store SQL as `carein_app` (so the grants were live). Single use and expiry held. Each of these was refused by its own constraint:

- a `patient_email_sent` row without fields;
- a `patient_email_skipped` row with fields;
- an unknown verb;
- a patient "received" link;
- a duplicate link kind;
- a raw token stored as the hash;
- a cross-office token (the FK);
- an expiry before creation.

## New event verbs (please ratify)

The list is `TC_REFERRAL_LINK_EVENT_VERBS` in `shared/tc/referrals.ts`. The CHECK equals the contract, and that is pinned in `test/referralLinksMigration.test.js`. None of these verbs moves a status.

| Verb | Meaning |
| --- | --- |
| `patient_scheduled` | The specialist's office or the patient said the patient is scheduled, from their link, with the date if one was given |
| `patient_email_sent` | ACS accepted the patient's notice. The row carries the ACS id, the address and the unsubscribe hash |
| `patient_email_skipped` | No notice was attempted, and why |
| `patient_email_failed` | The notice was attempted and did not go out |

"Received" adds no verb, because it is `mark_acknowledged`.

**Every reader of the vocabulary**, found by grep:

- `shared/tc/referrals.ts`: `NON_MOVE_VERBS` gained all four, so the return and send-problem readers see past them (tested).
- `client/.../ReferralTimeline.tsx`: labels added. This was a compile error until they were added, by design.
- `services/messaging/index.js` `referralEmailByToken`: now also matches `patient_email_sent`, so the patient's unsubscribe link works (tested).
- The R5 migration test, as listed below.

## Test edits for ratification

**The exactly-one-message pins, now one message per recipient class.** The test files' offices have no Open Dental connection, so no patient notice goes out in them. Each pin now asserts `messagesByRecipient(acsCalls)` = `{ specialist: 1 }`. The new helper is in `routes/emailTestUtils.js`.

1. `tcReferralSend.test.js`, test "S: one email to the directory address…": `posts.length === 1` became one letter, to the specialist.
2. `tcReferralBcc.test.js`, six tests. Each `posts.length === 1` became `ONE_LETTER`, with a comment saying the notice never carries the BCC; that is pinned in the new file. The tests:
   - "no copy inbox saved";
   - "a copy inbox saved" (this one keeps `posts.length === 1` as well);
   - "the copy inbox IS the specialist";
   - "ACS fails it";
   - "cannot be marked sent";
   - "the auto-send…".
3. `tcReferralSend.test.js`, test "A: approval with auto-send ON…": the last-two-events pin now filters out the `patient_*` row before checking `approve`, `send`, and adds `messagesByRecipient` = one letter.

The two-message case itself is pinned in the new `tcReferralLinks.test.js` (N): `{ specialist: 1, patient: 1 }`, exactly two POSTs, and the BCC on the letter only.

**Other pins my change makes untrue, updated:**

4. `tcReferralSend.test.js`, "T: `send` is the one new move…": the event-verb list gained the four new verbs.
5. `tcReferralSend.test.js`, "S: one email…": *"no link or button but the unsubscribe link"* became *exactly* the two buttons (labels and public-base URL shape asserted) followed by the unsubscribe link.
6. `tcReferralSend.test.js`, "S: the hub and the detail read…": `events.at(-1).verb === 'send'` became "the last **move** is `send`". The `patient_email_skipped` row comes after it.
7. `test/referralEmailMigration.test.js`: R5's migration is history, so its test now pins a frozen **`TC_REFERRAL_R5_EVENT_VERBS`** (same contents as before) instead of the live `TC_REFERRAL_ALL_EVENT_VERBS`. This is the same move R5 made for R6's pin.

**Harness only (no assertion changed):**

- `tcTestUtils.js`: the fake DB learned `col > $n`.
- `emailTestUtils.js`: it mounts the new public router the way `server.js` does, and gains `messagesByRecipient`.
- `moduleGateWiring.test.js`: a new test for the new mount (unguarded, before `/api/webhooks`, carries its own limiter).

**Still literally true, but read it with care:** `tcReferralSend.test.js` "guards: … and never Open Dental" still passes, because the three files it scans have no OD call. The send path as a whole now makes one read through `referralPatientContact.js`. The new G test pins that this module is the only OD access and that it is GET-only.

## Judgment calls (please rule)

1. **The patient email now uses the PM's drafted template, word for word** (`referralLetterText.composePatientNotice`). The subject is "We've sent your referral to {Specialist office name}". The button sits between "Already scheduled?…" and "After your specialist visit…", as drafted. To put it there, the shared renderer gained an optional `after` text that is drawn below the buttons. The whole template is pinned in one test. How each placeholder is filled:
   - **{plain-language reason}: the staff-editable field doesn't exist yet.** The referral's `reason` is clinical shorthand written for the specialist, so it is never used here. The template's honest generic fallback stands in: "a specialist consultation" (`PATIENT_REASON_FALLBACK`). A test pins that the notice is built from no clinical field. **Adding the field is a follow-up for you to OK:** a column, a staff edit input in the hub, and a slot in the notice.
   - **"and X-rays"** appears only when files went WITH the letter, not when they were only listed as available on request.
   - **Dr. {referring provider}** falls back to the office name when the field is blank. {Specialist office name} falls back to the specialist's name, then to "the specialist". With no specialist phone, the line reads "call them to set up your appointment" and points to the office's number. With no office phone, the closing drops "or call us at …".
   - **"As we discussed at your visit"** is kept as written, but a referral started from a call or by hand may have had no visit. Do you want different words for those sources?
2. **No separate switch for the patient notice.** It runs whenever referral email runs (`tc_referral_email_enabled` + `tc_email_enabled`). The brief didn't ask for a switch, but it is a new patient-facing email. A per-office `tc_referral_patient_email_enabled` would be a small follow-up if you want to stage it.
3. **Throttled hits are audited once per client per window, not on every hit.** Writing an audit row on every throttled request would turn a flood into database writes, which is what the limiter exists to prevent. Every hit that is not throttled is audited.
4. **Date window:** 30 days back to one year ahead. "Recent" allows a specialist who confirms after the visit.
5. **Received after a conflict:** the links are only stored with a recorded send, so a `send_conflict` letter's buttons are dead. The alternative was a link that moves an `approved` referral, which would be the app claiming a send it couldn't record.
6. **If the notice's own record fails after ACS accepted it** (very rare), the row is still written outside the transaction with a note saying the record is incomplete. Its link stays dead, and the route answers `sent`. This is the same "an email went out, say so" rule as `send_conflict`.
7. **The patient's notice needs the letter recorded first.** A failed or conflicted letter sends no notice, so the patient is never told about a referral the specialist doesn't have.

## Independent security review

A separate reviewer read the code without my conclusions. It found **no exploitable bug** and verified all ten requirements. I applied three of its hardening items:

- **The global ceiling counts only misses.** A hit that finds a live link is handed back to the bucket. Real clicks, and mail scanners prefetching real links, can no longer fill the shared 600-request bucket and lock out everyone. Tested.
  - Still possible: an attacker with about 30 IPs sending guesses can fill it for up to 15 minutes. The result is a 429 page, never a leak.
- **The PatNum is checked as a safe integer** before the Open Dental read.
- **The patient's address is no longer repeated in the history note.** It stays in `recipient_address`.

Noted but not changed:

- A 503 (tenant unresolved) writes no audit row, because there is no tenant to write it to. This is the same as the unsubscribe route.
- A "scheduled" click records on whatever status the referral holds. Today only `sent` and later statuses can hold live links.
- The token sits in the emailed URL's query string. Logs strip it, `no-referrer` is set, and the form POSTs it in the body.

## Deferred (as briefed)

- ACS delivered/bounced tracking (R5b-2, Event Grid).

## Verification

- `pnpm run check` (tsc --noEmit): clean.
- `pnpm run test`: 173 files passed (34 skipped are the existing shot suites), including the contract bundle byte-compare. The bundle was regenerated with the pinned esbuild and `--alias:zod`.
- `node --check server.js` passes.
- `node --test` (full backend): 4001 tests, 0 failed.
- The PG16 migration rehearsal, as described above.
- New tests:
  - `routes/tc/tcReferralLinks.test.js`: 32 tests covering the notice, the links at rest, the views, received, scheduled, replay, expiry, unknown tokens, cross-referral reuse, purpose binding, the double click, rate limits, fail-closed and guards;
  - `test/referralLinksMigration.test.js`: 8 tests;
  - `tests/referrals-r5b-links.test.tsx`: 6 tests.

ACS is mocked throughout and nothing reaches a network. Open Dental is the real per-office clients with every method patched; any non-GET throws. The only fixture patient is roland 12827.

## Deploy wiring (names only)

Nothing new. The links use the existing `TC_EMAIL_PUBLIC_BASE_URL` and `TC_EMAIL_TENANT_SLUG`. The patient lookup uses the office's existing Open Dental key (`OPENDENTAL_CUSTOMER_KEY` / `_VALLEY`). Without that key, every notice is skipped with "Open Dental isn't connected for this office".

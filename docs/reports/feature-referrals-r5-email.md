# Referrals R5 — referral email send

Branch `feature/referrals-r5-email`, off `origin/develop` at `e6c1ef1` (#253 merged). RED lane: pushed, not merged.

## What it does

An approved referral can be emailed to its specialist: by a **Send** click (tc.full) in the Referrals hub (under the card and in the panel), or **automatically on the doctor's approval** where the office's existing `autosendOnApproval` policy is on. It goes through the existing TC email transport (ACS adapter, its kill switch, account config, unsubscribe gate, consent opt-out, shared renderer). It doesn't use a second client or `@azure/communication-email`.

Order of a send (`backend/routes/tc/referralSend.js`):

1. Gates:
   - the office's switch `tc_referral_email_enabled`;
   - the referral is approved;
   - no `send_conflict` since its last move;
   - the directory row names an active specialist with a usable email;
   - the transport is connected for this office with its **own** sender **and** a reply-to;
   - the address hasn't unsubscribed.
2. The attempt is audited before anything can leave (fail closed).
3. The referral is **claimed** (`send_attempt_id`), so two clicks or a click racing an auto-send can't both email it. A claim a crash left behind goes stale after 5 minutes.
4. The attached files are read; any unreadable file stops the send.
5. The letter is composed and the files packed **as a prefix in upload order** under 85% of ACS's 10 MB cap (base64 included). Files that don't fit are listed in the letter as "Additional images available on request: …".
6. Hand-off to the ACS adapter, which resolves only once ACS has accepted the email.
7. **Then**, in one transaction:
   - CAS `approved → sent` (still approved AND still this claim);
   - the `send` event with the ACS id, recipient and unsubscribe-hash;
   - the audit row `tc_referral.email_send` with `source_ref = acs_operation:<id>`.

   A failed audit rolls the move back.
8. If step 7 doesn't land, the email is out anyway. That's recorded as `send_conflict` (same id, recipient and hash) and answered with a 409 that says so. A second send is then refused (`REFERRAL_ALREADY_EMAILED`).

A failure before ACS accepted moves nothing. The referral stays approved with a visible `send_failed` row: always for an auto-send, and for a click from the claim on. The hub offers a retry. The approval itself always succeeds; its answer carries `autoSend`.

## Migration and table

- **Migration `1792100000000_tc_referral_email`** (above develop's newest, `1792000000000`). It touches `tc_referral_events` and `tc_referrals`:
  - the verb CHECK is widened to R6's 14 verbs + `send`, `send_failed`, `send_conflict`, equal to `TC_REFERRAL_ALL_EVENT_VERBS`;
  - `acs_message_id` / `recipient_address` / `unsubscribe_token_hash`, all-or-nothing on send/conflict rows, with the hash unique where set;
  - `send_attempt_id` / `send_attempt_at`, NULL together;
  - the grants run in the migration, role-guarded;
  - `down` restores R6's CHECK exactly, relabelling send rows to NULL first.
- **Transition edges** (shared `referralNextStatus`), with `send` new:
  - submit draft→pending_signoff (→approved when sign-off is off) · withdraw pending→draft · cancel draft|pending→cancelled
  - approve pending→approved · decline pending→declined · reopen approved→pending · return pending→draft
  - mark_sent approved→sent · **send approved→sent** · mark_acknowledged sent→acknowledged · mark_patient_seen acknowledged→patient_seen · close patient_seen→closed

## Judgment calls (please rule)

1. **Three R2/R6 pins encode "nothing sends", which R5 ends.** Assertions may not be edited, so each stays literally true:
   - `send` lives in its own `TcReferralSendVerb`, beside the same table function, not in `TcReferralVerb`;
   - the route is **`POST /:id/send-email`**, because R2 pins `/:id/send` → 404;
   - send code is in a new `referralSend.js`, and the auto-send policy is read inside `referralStore.js` (`sendsOnApproval`).

   Their *intent* ("nothing sends", "auto-send consumed by nothing") is now false. Recommend updating those three tests in this PR with your OK.
2. **DOB.** The letter needs one, but neither the referral row nor the case carries it, and this slice reads nothing from Open Dental. The letter says "Date of birth: available from our office on request". The fix is to snapshot DOB when a referral is created (a later slice).
3. **The transport's kill switch applies.** Referral email needs `tc_email_enabled` ON too, the same switch as patient email. I didn't bypass it.
4. **Reply-to required** for a referral (`ACS_EMAIL_REPLY_TO_<OFFICE>`): the letter asks for findings, and `referrals@…` isn't a mailbox.
5. **The footer** keeps the unsubscribe link, as the transport's rule requires. Its first line reads "…sent your office a patient referral" instead of "you are a patient of…". A specialist who unsubscribes blocks future referrals to that address (consent rule 1); those then go by hand.
6. An **inactive specialist** is refused at send time.
7. New optional **`TC_EMAIL_PRACTICE_NAME_<OFFICE>`** so the letter signs "Valley Family Dental", not the office label "Valley Fort Smith".
8. The shared renderer gained two backwards-compatible options: `maxChars` (up to 20,000; the default stays 8,000) and `literal`. Without them a long letter would be cut and `{{…}}` in a doctor's note blanked. The doctor's note goes out verbatim.

## Deploy wiring R5 needs (names only)

App settings:

- `ACS_EMAIL_AUTH_MODE=connection_string`
- `ACS_EMAIL_FROM_VALLEY`
- `ACS_EMAIL_REPLY_TO_VALLEY`
- `TC_EMAIL_PUBLIC_BASE_URL`
- `TC_EMAIL_TENANT_SLUG`
- `TC_EMAIL_ENABLED` (or the console switch)
- optional `TC_EMAIL_PRACTICE_NAME_VALLEY`, `TC_EMAIL_PRACTICE_PHONE_VALLEY`

The secret `acs-email-connection` is already in `kv-carein-staging` and is loaded as `ACS_EMAIL_CONNECTION` by `secrets.js`.

Then turn on **TC referral email** for the office in the platform console (Referrals tab). Don't set the shared `ACS_EMAIL_FROM`.

## Screenshots

`docs/screenshots/tc/tccheckout-13-referral-email-hub-*` and `tccheckout-14-referral-email-panel-*`, light and dark. Fixture patients only.

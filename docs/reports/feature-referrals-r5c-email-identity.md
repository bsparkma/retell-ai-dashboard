# Referrals R5c — in-app email identity settings

Branch `feature/referrals-r5c-email-identity`, off `origin/develop` at `6265fc4` (#254 merged). RED lane: pushed, not merged.

## What it does

Each office's **reply-to**, **practice name** and **practice phone** can now be edited in the app: TC Settings → **Email identity**. Before this they lived only in Azure app settings (`ACS_EMAIL_REPLY_TO_<OFFICE>`, `TC_EMAIL_PRACTICE_NAME_<OFFICE>`, `TC_EMAIL_PRACTICE_PHONE_<OFFICE>`).

- **One identity per office, not per feature.** The TC patient email and the referral letter both read it:
  - the patient email uses it in the footer, the `{{practice.*}}` and `{{sender.email}}` tokens, and the Reply-To header;
  - the referral letter uses it in the subject ("Referral from …"), the signature, the footer, the Reply-To header and its gate.
- **The From address is not editable.** It's bound to the DNS-verified sending domain and stays an app setting. The section shows it read-only with "Managed by the platform". It names the referral sender separately when that differs from the patient-email one.
- **Who:** admin and office (`tc.notification_defaults`, the same as the office notification defaults). The section is hidden for other roles. The server refuses them regardless: tc gets 403 from the router, and hygiene and doctor get 403 at the `tc.full` mount.

## Precedence, read at send time

```
saved in the app (platform_setting['tc_email_identity'][office][field])
  → the app setting (env), read exactly as before R5c
  → not set
```

When nothing is set:

- **Reply-to:** a referral gets the existing `office_not_configured` refusal. Its sentence now says which detail is missing, and where to set it:
  - a missing reply-to points to Settings → Email identity;
  - a missing sender says the platform sets it up.
- **Name:** the office label.
- **Phone:** left out of the footer.

**Caching** follows the 5-minute switch pattern:

- loaded at boot;
- refreshed every 5 minutes (`TC_EMAIL_REFRESH_MINUTES`);
- refreshed inline by a save, so the next email uses it;
- a failed read keeps the last good values;
- if the values were never read, the app settings answer.

## Storage, history and audit

- **Values:** stored in `platform_setting` (control plane), with **no migration** for the values themselves.
  - The env vars they shadow are deployment-wide per office, and office keys are global (`config/officeAgents.js`).
  - Every reader is a synchronous config lookup with no tenant connection: the adapter, the renderers, the nurture generator.
- **History: migration `1792200000000_tc_email_identity_changes`.** It's above develop's newest, `1792100000000`.
  - One append-only tenant table (`SELECT, INSERT` grant only, role-guarded, uuid key).
  - Each changed field writes one row with the **prior and new value** and who changed it.
  - It's needed because `audit_log.prior_state` is slug-only by CHECK, and these values are addresses and names.
  - The rows are written in the same tenant transaction as the save, so a failed save leaves no history.
- **Audit:** each changed field also gets an `audit_log` row:
  - `UPDATE tc_email_identity <office>/<field>`;
  - `prior_state` is `stored` or `unset`;
  - the trail never copies the values.

  A save that changes nothing writes nothing.
- **Honest state:** the save is read back from the control plane and compared.
  - A mismatch → 500 `IDENTITY_READBACK_FAILED`, and the history rolls back.
  - A control plane that can't be read → 503 `IDENTITY_UNAVAILABLE`, and nothing changes.

## Validation

- **Strict body.** All three keys are required. `null` clears a field back to the app setting. A smuggled `from`, `office` or any extra key → 400.
- **Office from the server.** It comes from `?office=` and is never read from the body.
- **Field rules, enforced server-side:**
  - reply-to is one plain address, lowercased, ≤ 254;
  - name ≤ 120;
  - phone ≤ 40;
  - every field is a single line (no control characters, so nothing can inject a header line).
- **Saved values re-checked on read.** A saved value that later fails these rules is ignored, and the app setting answers.

## Judgment calls (please rule)

1. **`platform_setting`, not a tenant table, for the values.** This matches the scope of the env vars they replace. The consequence is that a tenant's admin or office user edits a deployment-wide per-office value. That's correct while one practice owns `roland` and `valley`. It needs revisiting if offices ever become per-tenant.
2. **The patient email now signs with the practice name.** Previously it always used the office label ("Valley Fort Smith"). Now it uses saved name → `TC_EMAIL_PRACTICE_NAME_<OFFICE>` → office label, the same as the referral letter ("one identity per office").
   - Where `TC_EMAIL_PRACTICE_NAME_VALLEY` is set (staging, for R5), staging patient emails will now say "Valley Family Dental".
3. **Nurture drafts:** the phone follows the identity (they already read `practiceDetailsFor`). Their `{{officeName}}` still uses the office label. I left it out of scope because the brief named referral and patient email.
4. **Permission check inside the router.** The router mounts on `tc.full` and enforces `tc.notification_defaults` itself, the way `notifications.js` does. That keeps `test/roleGateWiring.test.js` ("every TC mount is tc.full or an enumerated grant") unedited.
5. **The hub's client copy is unchanged.** "This office has no referral sending address set up yet." is pinned exactly by an existing test. It now reads slightly broad when only the reply-to is missing. The server's refusal sentence is specific. Recommend updating the client copy with your OK.
6. **"Last changed" isn't shown in the UI.** The stamp belongs to the shared row, so it would be misleading per office. The per-office history is in `tc_email_identity_changes`.

## Guardrails held

- No Open Dental reads or writes. A test greps the slice for OD requires.
- No `.env` access.
- The send path's gating and order are untouched. Only the values its getters return now prefer a saved one.
- Existing tests are untouched except one test **added** to `tcReferralSend.test.js`.
- Fixture names only.
- The contract bundle was regenerated with the pinned toolchain from a `--frozen-lockfile` install. The byte-sync test passes.

## Tests

- **Backend** `node --test`: 3883 tests, **3880 pass, 0 fail, 3 skipped**. New:
  - `config/emailIdentity.test.js`: precedence, junk, TTL, read-back;
  - `routes/tc/tcEmailIdentity.test.js`: roles, strict body, validation, history and audit, 503, 500 rollback;
  - `services/messaging/emailIdentityRenderers.test.js`: patient footer, tokens, adapter Reply-To, referral footer and gate;
  - `test/emailIdentityMigration.test.js`;
  - one end-to-end referral send with a saved identity and no env reply-to.
- **Dashboard** `pnpm run check`: clean. `pnpm run test`: **2658 pass, 204 skipped, 0 fail**. New: `tests/tc-email-identity-settings.test.tsx`, which covers:
  - the nav gate;
  - the From address read-only;
  - a save that sends the whole identity and renders the read-back;
  - a refusal that shows the server's sentence.

## Deploy

- Run the migration. It runs automatically in the pipeline.
- No new app settings. The existing ones stay as fallbacks.
- After merge, an office manager can set Valley's reply-to in Settings. `ACS_EMAIL_REPLY_TO_VALLEY` can then be removed, or left as the fallback.

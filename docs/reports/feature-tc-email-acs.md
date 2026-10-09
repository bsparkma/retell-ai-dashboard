# Item 40: Email send over ACS under the Azure BAA, wired into the item 38 queue

**Branch:** `feature/tc-email-acs`, STACKED on `feature/tc-sms-twilio` (item 39, PR #230), which stacks on `feature/tc-messaging-foundation` (item 38, PR #229). Neither is merged.
**PR:** #231 (DRAFT, base `feature/tc-sms-twilio`)
**Lane:** RED. This is a PHI path with a new vendor, new config and secret names, a new **unauthenticated public endpoint**, and one tenant migration. **NOT MERGED. NEEDS REVIEW.**

## Sequencing (orchestrator decision)
The spec says "Requires 38 merged". Instead this branch is stacked on 39, which is stacked on 38, and the PR is a draft held until #229 and #230 merge. After that:
1. Retarget the base: `gh api -X PATCH repos/bsparkma/retell-ai-dashboard/pulls/231 -f base=develop`. (`gh pr edit` is broken.)
2. Mark the PR ready.

CI `build-test` runs only on PRs to develop or main, so the **local gates below were the only gates**.

**Trial merge:** a detached worktree at `origin/develop` (`e551c65`) with `git merge --no-commit --no-ff feature/tc-email-acs` merged cleanly. It touched 112 files, which includes all of 38 and 39. The merge was aborted afterwards and the worktree removed.

## Provider
**Azure Communication Services Email only.** No other provider is wired. `emailGuards.test.js` fails the build if `resend`, `@sendgrid/mail`, `nodemailer`, mailgun or postmark appear in any backend source or in package.json.

I used the **ACS Email REST API directly** and added no new dependency. Two requests did not justify `@azure/communication-email` on a PHI path. `@azure/identity` was already a dependency, and **package.json and both lockfiles are unchanged**.

Nothing about ACS turned out to be impossible to build against. Live behaviour is unverified (I could not provision anything); see Preconditions.

## What was built
| Piece | File |
| --- | --- |
| Kill switch | `backend/config/tcEmail.js`, a mirror of `tcSms.js` with names changed only. `TC_EMAIL_ENABLED=false` is break-glass. Otherwise `platform_setting['tc_email_enabled']` (boolean) applies, then the `TC_EMAIL_ENABLED=true` fallback, then **OFF**. It is read at boot, every 5 minutes, and again inside `send()` before every email. `server.js` refreshes, times and stops it next to `tcSms`. |
| Config | `backend/config/acsEmail.js`. Exactly one auth mode with no silent fallback: `managed_identity` (the default; `ACS_EMAIL_ENDPOINT` plus `AZURE_MANAGED_IDENTITY_CLIENT_ID`, scope `https://communication.azure.com/.default`) or `connection_string` (`ACS_EMAIL_CONNECTION`, HMAC). The sender is chosen per office (`ACS_EMAIL_FROM_<OFFICE>`), else the shared `ACS_EMAIL_FROM`, else none. Optional Reply-To, practice address and phone. **"Configured" also requires `TC_EMAIL_PUBLIC_BASE_URL` and `TC_EMAIL_TENANT_SLUG`**, because no email goes out without a working unsubscribe link. |
| ACS client | `services/messaging/acs/client.js` makes two calls. **Send:** `POST {endpoint}/emails:send?api-version=2023-03-31` with `Operation-Id` = our message id, so ACS cannot turn one message into two emails. It expects 202. **Status:** `GET /emails/operations/{id}`. Every request has a 10 s `AbortSignal.timeout` and is never retried. Errors carry `ACS_<code>`, and email addresses are scrubbed out of error text. |
| Adapter | `adapters/emailAdapter.js` is real. It implements `enabledFor` and `unavailableReason` using the existing closed `ChannelUnavailableReason` set; no new value was needed. **Payload:** one recipient, the office's sender, html and plainText, Reply-To, `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, and `userEngagementTrackingDisabled: true` (no tracking pixels on patient email). **Status:** it reads the operation status up to three times (pauses of 1, 2 and 3 s, inside the click) and maps `Succeeded` → `sent`, `Failed` or `Canceled` → `failed` (`SEND_FAILED`, `ACS_<code>`), and still running → `queued`. If a status read fails after the 202, the result is `queued`, not `failed`, because ACS did accept the email. |
| Renderer (ONE) | `new-dashboard/shared/tc/emailRender.ts`, exported through `backend/tc/contract.entry.ts`. `contract.gen.cjs` was **regenerated with the pinned esbuild and `--alias:zod`**, and the drift test is green. See "Render" below. |
| Content | `services/messaging/emailContent.js` decides which values go in. **Template snapshot:** the blocks and subject are filled when the draft is written, so what was previewed is what gets sent. **Render:** each stored row is rendered with practice values only. |
| Service | `services/messaging/index.js`. `draftMessage` accepts `emailTemplateId` (email only, and no typed body alongside). `editDraft` refuses a body change on a template draft (subject only). `sendMessage`, for email: `SUBJECT_REQUIRED` is checked before the claim; a one-time unsubscribe token is minted and its SHA-256 written **in the same UPDATE that claims the row**; the row is rendered and the html, text and unsubscribe URL are handed to the adapter. New functions: `renderMessage`, `renderTemplateForCase`, `recordUnsubscribeLink`. |
| Consent | `consent.js` rule 1b: a case with `nurture_unsubscribed === true` **blocks email** (`CONSENT_OPTED_OUT`), never SMS. Email stays exempt from quiet hours. |
| Routes | `routes/tc/communications.js`. **`/render`:** unstubbed. **`/send`:** now the thin wrapper. **`/test-send`:** stays 501. |
| Public endpoint | `routes/emailWebhooks.js` at **`/api/webhooks/email`** (`GET` and `POST /unsubscribe`). |
| Migration | `migrations-tenant/1790800000000_tc_messages_email.js` adds `tc_messages.email_blocks` (jsonb), `email_preheader` and `unsubscribe_token_hash`, all nullable, plus the partial UNIQUE index `tc_messages_unsubscribe_token_unique`. There is no new table and no CHECK change: `unsubscribe_link` was already in item 38's source CHECK. It sorts after `1790700000000`. Table-level grants cover the new columns. |
| Contract | `shared/tc/messaging.ts`: `TcMessage.emailTemplated` (defaults to false), `DraftMessageBody.emailTemplateId`, `RenderEmailBody`, `RenderedEmailResult`, `CommunicationSendBody`. |
| UI | **Messages tab:** email goes live when the server says so for this office, and the reason is shown in email's own words. There is a **template picker** over the existing library (`listTemplates`). **Preview** shows the server's rendering in **EmailPreview**, which gained an `html` mode: a `sandbox=""` iframe with no scripts. A template draft's body is read-only. Status chips are honest and carry a tooltip. **Follow-up card** (also used by the Nurture workspace): a new **"Email template"** action deep-links with `pickTemplate=1`, which opens the picker for that follow-up and **writes nothing** until the TC drafts. The existing "Draft message" with `channel=email` still seeds a draft from the code template. |

### One send path (spec requirement), and the human click
- The existing `/communications/send` had **no UI caller**. `sendEmail()` in `features/tc/api.ts` was documented as "never called on a user path", and grep confirms nothing calls it. It cannot be invoked in bulk:
  - its strict body is `{ caseId, templateId, subject? }` with no list and no address;
  - each request is one message.
- It now calls `messaging.draftMessage`, then `messaging.sendMessage`, the **same function** `/messages/:id/send` calls. Every gate is therefore the same gate.
  - **Spy test:** `tcEmailSend.test.js` "ONE send path" replaces `messaging.sendMessage` and asserts both routes called it, with the two message ids in order.
  - **Guard test:** `messagingGuards` now allows exactly these two callers, one call each, and requires the wrapper's call to sit inside `POST /send` after its own `draftMessage`.
- After an attempt that reached ACS (`sent`, `queued`, or an ACS refusal), it writes one `tc_communications` row with legacy status `sent` or `error`. A refusal before ACS writes **no** log row. In that case the draft stays a draft, visible in the Messages tab, and the response carries `draftMessageId`.
- **The dashboard does not use this route.** The Messages tab is draft → Preview → Send, which is the review-then-send rule. I kept the wrapper for the legacy contract only, because a single request can draft and send without a separate review step. That is acceptable as one explicit human action on one message, but nothing in the UI should be wired to it. Flagged for review below.

### Render (`/communications/render`)
- **Body:** `{ messageId }` renders a stored email draft exactly as Send would, with an inert unsubscribe link. `{ caseId, templateId }` renders what a draft from that template would look like.
- It is office-scoped, audited as `READ tc_email_render`, and never sends anything.
- **Total:** every exported function takes `unknown`. Blocks are read field by field with per-type defaults. Each block is wrapped in try/catch, so even a throwing getter is survived. A non-array renders as an empty body. The system footer always renders.
  - **Tests:** every block type, read from the zod union so a ninth type without a renderer goes red; 13 kinds of malformed or legacy input; one legacy-shaped template rendered through the HTTP route.
- **XSS:** person-supplied text is escaped everywhere.
  - Text-block HTML is **reduced to plain paragraphs**, then escaped. It is never passed through. This is the same function the editor preview uses, now shared, so bold and italics are lost in both.
  - Links and images must be `http(s)`; buttons may also use `mailto:` and `tel:`. Credentials in a URL are refused, and colours must be `#rrggbb`.
- **Minimum necessary:** only six tokens are ever filled: `patient.firstName`, `practice.name`, `practice.phone`, `practice.address`, `sender.name`, `sender.email`.
  - `sender.email` is the office Reply-To, never the TC's mailbox.
  - `case.*` (treatment, fees) and unknown tokens render as nothing.
  - A stock highlight block is left with nothing to say and is dropped.
  - `talking_point` is never read.

### Unsubscribe link
- **Token:** `crypto.randomBytes(32)` base64url, one per sent email. **Only its SHA-256 is stored**, on that `tc_messages` row. The row's `office_id` and `to_address` are the office-and-address binding. The URL is `{TC_EMAIL_PUBLIC_BASE_URL}/api/webhooks/email/unsubscribe?t=<token>`, with nothing else in it.
- **GET** shows a confirmation page with one button. It runs **no query and opens no tenant**, so a link scanner or prefetcher cannot unsubscribe anyone (a test checks for zero queries).
- **POST** (the button, or an RFC 8058 one-click from a mail client):
  1. resolve the tenant from `TC_EMAIL_TENANT_SLUG` (active and entitled to `tc`, the same rule as Twilio's `attachTenant`);
  2. look up the token hash;
  3. upsert `tc_contact_consent` with `opted_out`, `source=unsubscribe_link`, `updated_by=system:unsubscribe_link`;
  4. audit with actor `system:email-unsubscribe`.
- **Constant shape:** a valid, repeated, unknown, malformed, hostile or missing token gets the **byte-identical** 200 page. The page names no practice and no address.
- **Only other answer:** 503 "could not confirm". It depends on the deployment (tenant config, control plane, database), never on the token: the tenant is resolved before the token is read.
- **Fails closed:** a bad token records nothing.
- **Idempotent:** an address that is already opted out, for any reason, is left untouched. A manual opt-out keeps its note and attribution.
- The **kill switch does not stop** an unsubscribe from being recorded.
- **Headers:** `no-store`, `no-referrer`, `noindex`, `nosniff`, `X-Frame-Options: DENY`, and CSP `default-src 'none'`.
- **Mount:** `/api/webhooks/email`, inside the existing `/webhooks` exemptions. No exempt list widened. **This is a new mount outside the auth gate.** It was added to `moduleGateWiring.test.js`, which checks it is unguarded, inside the exemption and ahead of `/api/webhooks`.

## Spec coverage
| Spec | Where |
| --- | --- |
| Real ACS adapter; connection string or managed identity; per-office or shared sender; missing config ⇒ FEATURE_DISABLED, fail closed | `acsEmail.test.js` (7), `client.test.js` (7), `emailAdapter.test.js` (7), `tcEmailSend.test.js` "kill switch off / office without a sender" (switched_off, not_configured, valley office_not_configured → 501, draft stays a draft, ACS never called) |
| Ships dark: `tc_email_enabled`, env fallback, floor off, run time | `tcEmail.test.js` (9); adapter "send re-reads the kill switch" |
| Render the existing block model server-side, total, escaped | `emailRender.test.js` (8); `tcEmailSend.test.js` render tests (2) |
| /send through the 38 pipeline; one send path; keeps tc_communications | `tcEmailSend.test.js` (spy test, strict-body test, ACS-refusal log test); `messagingGuards.test.js` |
| ACS operation result → sent/failed honestly; never "delivered"; UI tooltip | adapter status-ladder test; `tcEmailSend.test.js` queued/failed; UI `tc-email-acs.test.tsx` "nothing is green" + tooltip |
| Unsubscribe → tc_contact_consent `unsubscribe_link` for that office+email; gate blocks | `emailWebhooks.test.js` (12): the round trip (send, take the link ACS was handed, click, consent row, next send 403 `CONSENT_OPTED_OUT`, ACS not called again), one-click, GET inert, constant shape, token-only input, per office, manual kept, kill switch independent, tenant never guessed, DB failure 503, one token per email, wrapper path |
| Email exempt from quiet hours; 38 consent gate applies | `tcEmailSend.test.js` 22:00 CDT sends; opt-out round trip above |
| Fake ACS client, no network | every fake asserts the URL is the configured ACS endpoint; the token provider and the wait are stubbed |
| UI: email live per office; subject + template picker + EmailPreview; nurture/follow-up seeding | `tc-email-acs.test.tsx` (11) + screenshots |

## Tests
| Suite | Result | Change from #230 |
| --- | --- | --- |
| **backend** (`npm ci`, `node --check server.js`, `node scripts/shard-runner.mjs`, the CI shape) | **3320 tests / 3317 pass / 0 fail / 3 skipped**, 4 shards green | was 3243, **+77** |
| **new-dashboard** (`pnpm install --frozen-lockfile`, `pnpm run check`, `pnpm run test`) | `check` clean; **2466 pass / 173 skipped**, 145 files passed and 29 skipped | was 2455, **+11** |

- **Backend test files added:**
  - `config/tcEmail.test.js`
  - `config/acsEmail.test.js`
  - `services/messaging/acs/{client,emailGuards}.test.js`
  - `services/messaging/adapters/emailAdapter.test.js`
  - `services/messaging/emailRender.test.js`
  - `routes/tc/tcEmailSend.test.js` (14)
  - `routes/emailWebhooks.test.js` (12)
  - `test/tcMessagesEmailMigration.test.js`
  - The harness `routes/emailTestUtils.js` is not a test file.
- **Dashboard test files added:** `tc-email-acs.test.tsx` (11), plus `tc-email-shots.test.tsx` (4), which only runs with `TC_SHOTS=1`. The skipped-file count includes that new shots file; #230's report said 27 skipped, and this run's list showed 28 before this file existed.
- **Contract bundle drift test:** green.
- **Flakes:** none were hit.

## Existing assertions changed (called out)
1. **`routes/tc/tcTemplatesComms.test.js`**: "the send pipeline is uniformly FEATURE_DISABLED (501)" is now "test-send stays 501; render and send refuse an empty body (400) and write nothing". This is the spec's intended change, since `/render` and `/send` are no longer stubs.
2. **`services/messaging/messagingGuards.test.js`**, two changes:
   - (a) **No timers.** The rule still forbids `setInterval`, `setImmediate` and cron everywhere. It now allows **exactly one** awaited `timers.setTimeout(ms)` (from `node:timers/promises`) in **exactly one** file, `acs/client.js`, for the pause between status reads inside the human's own Send request. That pause cannot start a send and never outlives the request. Every other file still may not name `setTimeout`.
   - (b) **The only sendMessage caller is `/:id/send`.** Now there are exactly two callers, one call each, with the wrapper's call pinned inside `POST /send` after its own draft.
3. **`routes/tc/tcTestUtils.js`**: `email_blocks` was added to the fake DB's `JSONB_COLS`. This is a harness change, not an assertion.
4. **Behaviour fix in 38's service:** `sendMessage` now reports an adapter's own `extra.providerCode` (`ACS_<code>`, and also `TWILIO_<code>`) instead of the wrapping `SEND_FAILED`. Item 39's Twilio codes had in fact been surfacing as `providerCode: 'SEND_FAILED'`. No existing assertion changed; all 38 and 39 tests are green.
5. **`EmailPreview.tsx`** now imports `htmlToPlainText` and `SIGNATURE_SOURCE_TEXT` from the shared renderer instead of its own copies. The shared `htmlToPlainText` decodes `&amp;` last, which fixes a double-decode, and is otherwise identical.

## Vocabulary-reader inventory (grepped, excluding node_modules, dist and contract.gen.cjs)
| New value / code / route | Readers |
| --- | --- |
| Error codes `SUBJECT_REQUIRED` (400), `EMAIL_TEMPLATE_INVALID` (400), `EMAIL_TEMPLATE_NOT_FOUND` (404) | `services/messaging/errors.js` (`HTTP_STATUS`); `index.js`; `copy.ts` `SEND_ERROR_COPY` (plus `MESSAGE_NOT_EDITABLE` copy); tests |
| `ChannelUnavailableReason` | **No new value.** Email uses the existing three. New readers: `emailAdapter.js`; `copy.ts` `EMAIL_ADAPTER_REASON_COPY` and `EMAIL_ADAPTER_REASON_SHORT` (total Records); `adapterReasonCopy()` and `adapterReasonShort()`, which `MessagesTab.tsx` now uses in place of the SMS-only maps. The SMS maps are unchanged. |
| `MessageStatus` | **No new value.** `copy.ts` gains `EMAIL_STATUS_LABEL` (queued, sent) and `statusTooltip()`. `statusLabel()` takes an optional `channel`; an email is never "Not delivered". |
| Provider codes `ACS_<code>`, `ACS_TIMEOUT`, `ACS_UNREACHABLE`, `ACS_AUTH_FAILED`, `EMAIL_CONTENT_MISSING` | `acs/client.js`, `emailAdapter.js`; surfaced as `SEND_FAILED.providerCode`; read only by tests |
| Consent `source=unsubscribe_link` (an existing enum value, now written for the first time) | `index.js` `recordUnsubscribeLink`; item 38's CHECK; `TcContactConsent`; tests |
| Audit `resource_type` `tc_email_render`, `tc_message.unsubscribe_link` (actions stay READ and UPDATE); actor `system:email-unsubscribe` | written by `services/messaging/index.js`; read only by tests. Nothing filters on `resource_type`. |
| Columns `email_blocks`, `email_preheader`, `unsubscribe_token_hash` | migration; `index.js` (`MESSAGE_COLS` has the first two, **never** the hash, which an `emailGuards` test pins); `emailContent.js` |
| `TcMessage.emailTemplated`, `DraftMessageBody.emailTemplateId`, `RenderEmailBody`, `RenderedEmailResult`, `CommunicationSendBody` | `shared/tc/messaging.ts`; `index.js`; `communications.js`; `messagingApi.ts`; `MessagesTab.tsx`; tests |
| Routes `/api/webhooks/email/unsubscribe`, `/api/tc/communications/{render,send}` (live), deep-link param `pickTemplate=1` | `server.js`; `emailWebhooks.js`; `communications.js`; `messagingApi.ts` `renderEmail`; `TcCaseView.tsx`; `FollowupActionCard.tsx` |
| Platform setting `tc_email_enabled` | `config/tcEmail.js` only |

## Config and secret NAMES (never values)
**Key Vault** (`config/secrets.js` `SECRET_MAP`, documented in `docs/SECRETS.md`). It is optional:

| Secret | Env var | Notes |
| --- | --- | --- |
| `acs-email-connection` | `ACS_EMAIL_CONNECTION` | Used only when `ACS_EMAIL_AUTH_MODE=connection_string`. Managed identity, the default, needs no secret. |

**App settings (not secret):**

| Setting | Purpose |
| --- | --- |
| `ACS_EMAIL_AUTH_MODE` | `managed_identity` (default) or `connection_string` |
| `ACS_EMAIL_ENDPOINT` | the ACS resource endpoint (managed-identity mode) |
| `ACS_EMAIL_FROM_ROLAND`, `ACS_EMAIL_FROM_VALLEY` | per-office sender |
| `ACS_EMAIL_FROM` | shared sender for an office with none of its own |
| `ACS_EMAIL_REPLY_TO_ROLAND`, `ACS_EMAIL_REPLY_TO_VALLEY` | optional Reply-To |
| `TC_EMAIL_PRACTICE_ADDRESS_<OFFICE>`, `TC_EMAIL_PRACTICE_PHONE_<OFFICE>` | optional footer details |
| `TC_EMAIL_PUBLIC_BASE_URL` | base of the unsubscribe link |
| `TC_EMAIL_TENANT_SLUG` | the tenant the public endpoint records into |
| `TC_EMAIL_ENABLED` | kill-switch env fallback |
| `TC_EMAIL_REFRESH_MINUTES` | kill-switch re-read interval (default 5) |

The managed identity reuses the existing `AZURE_MANAGED_IDENTITY_CLIENT_ID`.

**Control-plane setting:** `platform_setting['tc_email_enabled']`, a JSON boolean. Nothing seeds it and there is no console toggle; a runbook writes it, the same as SMS.

## Screenshots (`docs/screenshots/tc/`, 1280×900)
| Shot | Shows | Themes |
| --- | --- | --- |
| `tcemail-01-thread-and-picker` | the thread with "Sent — delivery not tracked", "Accepted — still sending when we last checked", "Not sent" plus the ACS reason, and a template draft with Preview, Edit, Discard and Send; the compose box on Email with the template picker | light, dark |
| `tcemail-02-preview` | the Preview dialog: HTML from the **real shared renderer**, in EmailPreview's sandboxed frame | light, dark |
| `tcemail-03-office-no-sender` | Valley with no sending address: Send disabled, "No sending address for this office" | light, dark |
| `tcemail-04-followup-card` | a nurture card with **Email template** next to Draft message | light, dark |
| `tcemail-05-unsubscribe-confirm` | the public page, served by the real router | light only (it has no dark variant) |
| `tcemail-06-unsubscribe-done` | the constant result page | light only |

Shots 01 and 02 are **illustrative**: no email can reach those states until the preconditions are done.

To reproduce, from `new-dashboard/`:
```
pnpm exec vite build
TC_SHOTS=1 pnpm exec vitest run tests/tc-email-shots.test.tsx
node scripts/shoot-tc-email.mjs
```

## Conflicts with guardrails (resolved toward the safe side)
1. **`nurture_unsubscribed`** (item 38's open question 3): it now **blocks email**, which is stricter. It is case-level, does not touch SMS, and creates no consent row. A TC can still clear the flag in the Nurture workspace, and that re-allows email unless a `tc_contact_consent` opt-out exists.
2. **The legacy `/send` wrapper drafts and sends in one request.** The spec requires the wrapper. It is one case, one template and one message, with a strict body, and has no UI caller. Review-then-send in the product is the Messages tab. **I recommend Beau or the PM consider removing `/send` entirely** once nothing external depends on it.
3. **`/test-send` stays 501.** Not in scope, and it would be a second send path.
4. **The no-timers guard** was narrowed to allow one awaited, in-request pause in one file (see "Existing assertions changed" 2a). There is still no scheduler, poller or retry anywhere. An email still `queued` after the bounded reads stays `queued`; nothing re-checks it later.
5. **The unsubscribe endpoint is a new public surface.** It needs no signature because the 256-bit token is the credential. It sits in the existing `/webhooks` exemptions, so it is also exempt from the rate limiter; guessing a 256-bit token is not feasible.
6. **Rich text in text blocks is flattened to paragraphs** in the sent email, as it already was in the editor preview. That is safer than an HTML sanitizer I would have to get right.
7. **Email "configured" requires the public base URL and the tenant slug.** No email goes out without a working unsubscribe link.
8. **A template draft's body is not editable**; only its subject is. Editing the text would otherwise not change what is sent.

## Open questions (Beau / PM)
1. **List-Unsubscribe headers on ACS.** I send `List-Unsubscribe` and `List-Unsubscribe-Post` in the ACS `headers` field. I believe ACS accepts them, but this is unverified live. If ACS rejects them, the first staging send fails with an `ACS_<code>`. The fix would be to drop the headers; the in-body link stays.
2. **HMAC signing is unverified against live ACS.** It matches the documented string-to-sign and is tested by recomputation only. Managed identity is the default and avoids it.
3. **Emails left `queued`.** Should there be a human "Check status" action, or a status webhook through Event Grid (ACS `EmailDeliveryReportReceived`), for emails still `queued` after the click? Event Grid would also give real "delivered" states, but it is a new public webhook.
4. **CAN-SPAM postal address.** Nurture emails may count as commercial and need a physical postal address. `TC_EMAIL_PRACTICE_ADDRESS_<OFFICE>` puts one in every footer. Should it be required before email turns on?
5. **Reply-To.** The stock templates say "reply to this email". An ACS-managed `DoNotReply@` sender cannot receive replies, so set `ACS_EMAIL_REPLY_TO_<OFFICE>`. Inbound email is not built.
6. **Retiring `/api/tc/communications/send`** (see Conflicts 2).
7. **Single tenant per deployment** (`TC_EMAIL_TENANT_SLUG`), the same limitation as Twilio.

## Beau's preconditions (outside this slice; the code ships dark regardless)
1. **Create an Azure Communication Services resource and an Email Communication Services resource**, connected to each other, in `rg-carein-staging` and later `rg-carein-prod`. Confirm both are covered by the Azure BAA scope (decision D7).
2. **Email domain.**
   - **Staging:** add the free **Azure-managed domain** (`*.azurecomm.net`). No DNS work is needed. The sender is `DoNotReply@<generated>.azurecomm.net`.
   - **Prod:** add the custom domain **valleyfamily.dental** and verify it. ACS **produces the exact record values at provisioning time**; copy them from the portal and **do not use invented values**. The record types and hosts ACS asks for:
     - **TXT** at the domain apex (`valleyfamily.dental`): domain-ownership verification.
     - **TXT** at the apex: the **SPF** record ACS shows. Merge it into any existing SPF TXT, because only one SPF record is allowed per name.
     - **CNAME** ×2: the **DKIM** selectors, at `<selector1>._domainkey.valleyfamily.dental` and `<selector2>._domainkey.valleyfamily.dental`. ACS names the selectors (typically `selector1-azurecomm-prod-net` and `selector2-azurecomm-prod-net`; use what the portal shows).
     - Recommended, not produced by ACS: a **DMARC TXT** at `_dmarc.valleyfamily.dental`.
     - Add a MailFrom sender username, for example `donotreply@valleyfamily.dental`, and Roland's equivalent if Roland gets its own domain.
3. **Managed identity:** grant `id-carein-staging` (later the prod identity) a role on the ACS resource that allows sending email. Confirm the exact built-in role name in the ACS "authenticate with Microsoft Entra ID" docs at provisioning time. Memory notes say `az role assignment` hits a MissingSubscription quirk; the `az rest` PUT recipe works.
4. **App settings in staging:**
   - `ACS_EMAIL_ENDPOINT`
   - `ACS_EMAIL_FROM` (or per office)
   - `ACS_EMAIL_REPLY_TO_<OFFICE>`
   - `TC_EMAIL_PUBLIC_BASE_URL=https://<staging host>`
   - `TC_EMAIL_TENANT_SLUG=carein`
   - optional practice address and phone
   - Use a connection string (`acs-email-connection`, plus `ACS_EMAIL_AUTH_MODE=connection_string`) only if managed identity is not set up.
5. Run tenant migration `1790800000000` through the normal pipeline (after 38's `1790300000000` and 39's `1790700000000`).
6. Entitle `tc`, then set `platform_setting['tc_email_enabled']=true` **in staging only**.

### Staging test steps
**Send only to Beau's own inbox, never to a patient address.**
1. Put Beau's address on a staging test case: roland 12828, or valley 7115.
2. Messages tab: pick a library template, Preview it, Draft, then Send. Expect "Sent — delivery not tracked", and the email arrives with the footer and the unsubscribe link.
3. Open the link: a confirmation page appears. Click Unsubscribe: a `tc_contact_consent` row is written. The next Send is refused with `CONSENT_OPTED_OUT`.
4. Unset `ACS_EMAIL_FROM_VALLEY` with no shared sender: Valley shows "No sending address for this office" while Roland still sends.
5. Check the message headers in the received email for `List-Unsubscribe` (open question 1).

## Ops note
`C:\Users\beau\carein cursor dashboard\.git\packed-refs.lock` (stale) is still present. Every commit and the trial-merge cleanup printed lock warnings, but every commit and the push succeeded. I left the file alone because it is in the PROD folder.

## Commands, if a push or PR had to be done by hand
Both were done. For reference:
```
git push -u origin feature/tc-email-acs
gh pr create --draft --base feature/tc-sms-twilio --head feature/tc-email-acs
```

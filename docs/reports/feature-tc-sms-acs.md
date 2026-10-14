# Item 48: TC SMS through Azure Communication Services (replaces Twilio for go-live)

**Branch:** `feature/tc-sms-acs`, cut from `origin/develop` at `2644745` (#240 merged).
**Lane:** RED. It adds a new public webhook endpoint, a provider adapter, and new config and secret names. **NOT MERGED. NEEDS REVIEW.**
**Migration:** none. `tc_messages` already has a free-text `provider` column next to `provider_message_id`, plus the unique index `tc_messages_provider_id_unique` on `(provider, provider_message_id)` from #230. ACS rows carry `provider = 'acs'`. Nothing was renamed and no column was added.

## Why
A Twilio account that may carry PHI needs Twilio's Security or Enterprise Edition ($7,500–$12,000/mo). The ruling (PM and Beau, 2026-10-13) is that patient SMS moves to **ACS SMS under the existing Azure BAA**, the same shape as patient email (D7: all PHI on Azure).

## What changed, and what deliberately did not
The messaging foundation (#229) is unchanged:
- the consent gate (opt-out > all, OD `TxtMsgOk`, the TCPA quiet-hours hard block);
- the `tc_sms_enabled` kill switch (stuck-off safe, `=false` break-glass);
- review-then-send, with `messaging.sendMessage` as the ONLY send path;
- STOP/START/HELP semantics;
- the nurture exit hooks.

ACS plugs in below all of that, at the adapter seam.

**The Twilio adapter (#230) is untouched.** `git diff` against develop shows zero lines changed in `adapters/smsAdapter.js`, `services/messaging/twilio/*`, `routes/twilioWebhooks.js` and `config/twilio.js`. Selection lives in `adapters/index.js`, and a guard test pins that the Twilio adapter never reads `TC_SMS_PROVIDER`.

| Piece | File |
| --- | --- |
| Provider switch | `backend/config/tcSmsProvider.js`. `TC_SMS_PROVIDER`: unset or blank → **`acs`**; `acs` or `twilio` (case-insensitive) as named; **anything else → no provider**. An unknown value never falls back to the default or to the closest match. It is read at call time. |
| Selection | `adapters/index.js` `getAdapter('sms')` returns whichever adapter `TC_SMS_PROVIDER` selects at that moment, and only that one. An unknown value gets `UNSELECTED_SMS_ADAPTER`: never enabled for any office, `channelUnavailableReason` = `not_configured`, and its `send()` throws `FEATURE_DISABLED` naming `TC_SMS_PROVIDER`. `setAdapterForTests` still works as before. |
| ACS config | `backend/config/acsSms.js`. **Auth is #231's two modes**, `managed_identity` (default) or `connection_string`. It uses `acsEmail.js`'s own `AUTH_MODES` and `parseConnectionString` (reused, not copied) but reads its **own** `TC_SMS_ACS_*` variables, so changing one channel's auth can never silently move the other. **Per-office senders `TC_SMS_ACS_FROM_ROLAND` / `_VALLEY`, strict E.164, with no shared sender and no fallback.** `officeForReceivingNumber` accepts ACS's `+`-less numbers. If two offices claim one number, the answer is null, not a pick. The webhook token must be at least 32 characters. |
| ACS client | `services/messaging/acs/smsClient.js`, one call: `POST {endpoint}/sms?api-version=2021-03-07` with `enableDeliveryReport: true`, `tag` = office key, and `repeatabilityRequestId` = our `tc_messages` id (ACS will not turn one message id into two texts). It has a 10 s timeout and no retry. **A 202 is not success by itself:** the per-recipient `successful` must be `true` and a `messageId` must be present, or the send fails (`ACS_RECIPIENT_<status>` / `ACS_BAD_RESPONSE`). Digit runs and addresses are scrubbed out of every error. No new dependency was added; package.json and the lockfiles are unchanged. |
| Auth mechanism | **Reused from #231.** `connection_string` signs with **`acs/client.js` `hmacHeaders`**, the one ACS HMAC-SHA256 signer in the codebase (a test re-derives the signature with it). `managed_identity` uses the same `ManagedIdentityCredential` plus `AZURE_MANAGED_IDENTITY_CLIENT_ID` and the same scope (`acsEmail.ACS_SCOPE` = `https://communication.azure.com/.default`). It is a separate small function so the email and SMS test seams don't share state. |
| Adapter | `adapters/acsSmsAdapter.js` follows the same contract as Twilio's. It is connected for an office only when the kill switch is on, the account is configured, **and that office has its own ACS number**. `send()` re-reads the kill switch first, then sends and resolves **`queued`** with ACS's `messageId`, never `sent` or `delivered`. `missingFor(office)` returns setting NAMES. |
| Delivery mapping | `acs/smsStatus.js`: `Delivered` → `delivered`, `Failed` → `failed`, anything else ignored (Microsoft documents only those two). **The ladder is Twilio's own** (`RANK` and `replaceableBy` are imported from `twilio/status.js`), so the providers cannot disagree about ordering. Free-text `deliveryStatusDetails` that reads as a block or opt-out gets a plain sentence ("…blocked this sender for this number…"); anything else is shown scrubbed. **A failed report is never silent.** |
| Service | `services/messaging/index.js`, two additive edits. `applyStatusCallback` picks the mapper by `provider` (`acs` or `twilio`); the conditional monotonic UPDATE is the same one. A `FEATURE_DISABLED` refusal from `sendMessage` now carries `missing: [...]` (setting names) when the adapter can say, e.g. `["TC_SMS_ACS_FROM_VALLEY"]`. |
| Webhook | `routes/acsSmsWebhooks.js` at **`POST /api/webhooks/acs-sms`** (details below). |
| Mount | `server.js` mounts it before `/api/webhooks`, inside the existing `/webhooks` exemptions (auth gate, tenant gate, rate limiter), with no module guard, the same as Twilio. `moduleGateWiring.test.js` has a new assertion for it. |
| Secrets map | `config/secrets.js` adds four optional secrets (names below). If they are absent from the vault they are skipped and texting stays `FEATURE_DISABLED`. |
| UI copy | Two provider-neutral strings. The send toast "Text handed to Twilio" became "Text handed to the texting service", and the `sent` tooltip "Twilio sent this text" became "The texting service sent this text". There are no other UI changes. |

### Reasons shown to people
`ChannelUnavailableReason` stays the closed set (`switched_off`, `not_configured`, `office_not_configured`), so no contract or UI type changed.

The words are more specific now:
- **The adapter's own refusal** names the setting: "No ACS sender is configured for this office (TC_SMS_ACS_FROM_VALLEY). Nothing was sent." For the account: "…the ACS account is not configured (TC_SMS_ACS_ENDPOINT)…".
- **An unknown provider** says "TC_SMS_PROVIDER names no texting provider".
- **The send API's `FEATURE_DISABLED` response** carries `missing`.
- **The compose box** keeps its existing sentence ("This office has no texting number set up yet") because it switches on the reason code.

## The webhook
**Auth: a Key Vault shared secret in a header. I chose this over Entra (AAD) authenticated delivery.**

Event Grid sends `X-CareIN-Webhook-Token` as a **static, secret delivery property**. The router's only `router.use` compares it in constant time (SHA-256 of both values, then `timingSafeEqual`) against `TC_SMS_ACS_WEBHOOK_TOKEN`. If it is missing, wrong, too short or unconfigured, the answer is **401**. In that case:
- one warn line names only the reason;
- no event is read, the handshake is not answered, no tenant DB is opened, and no row or audit entry is written.

The tests pin this for nine variants, including a STOP.

- **Why a header and not the query string:** the token never appears in a URL that some proxy or ingress logs. A `?token=` is deliberately not accepted. Microsoft's delivery-properties doc notes that non-conformant well-known headers are dropped "during event delivery … but not during webhook validation", which confirms custom headers are present on the handshake too.
- **Why not Entra:** it needs an Entra app registration for the endpoint, Event Grid's service principal granted the `AzureEventGridSecureWebhookSubscriber` role on it, and server-side JWT validation against Entra's rotating signing keys (JWKS fetch and cache, issuer and audience checks). `jsonwebtoken` is already a dependency but has no JWKS client, so this would mean a new dependency or a hand-rolled key cache on a public PHI endpoint. That is more moving parts than the threat warrants, because the token is a 32+ character secret that only Key Vault and the subscription hold. It is a reasonable later hardening (open item 4).

**Processing (Event Grid schema; the subscription must not use CloudEvents):**
1. **The body must be an array.** Anything else → 400, with a log hint about the CloudEvents schema.
2. **`SubscriptionValidationEvent`** → `200 { "validationResponse": <code> }`, answered only after the token check. It opens no tenant.
3. **Each event is planned with no I/O first.** The office comes from **our** number:
   - `SMSReceived` uses `data.to`;
   - `SMSDeliveryReportReceived` uses `data.from`, the number we sent from.
   An unknown number is dropped with a warn and **200**, so Event Grid won't retry it for a day.
4. **The tenant is resolved only if at least one event will actually be recorded.** It comes from `TC_SMS_ACS_TENANT_SLUG` through the registry, and must be active and entitled to `tc`; otherwise 503 or 403.
5. **`SMSReceived` → `messaging.recordInbound(provider 'acs', providerMessageId = data.messageId, linkOpenCase: true)`.** That is the existing function, with its existing behaviour:
   - dedup on the provider id;
   - STOP → `tc_contact_consent` opted_out (`stop_keyword`);
   - START/HELP are recorded and audited and change nothing;
   - nurture: a reply pauses the enrollment, STOP stops it.

   Two deliveries racing past the dedup read hit the unique index; that 23505 is logged as a duplicate and answered 200. **It does not consult `tc_sms_enabled`**, so a STOP lands while texting is switched off.
6. **`SMSDeliveryReportReceived` → `messaging.applyStatusCallback(office, provider 'acs', …)`.** It is monotonic and office-scoped. A report claiming Valley's number can't touch a Roland row, and an ACS report can't touch a Twilio row with the same id.
7. **Any unexpected failure → 500**, so Event Grid redelivers the batch. That is safe for the reasons in 5 and 6.

**Nothing in the router sends.** A guard test fails the build if it names `sendSms`, `sendMessage(`, an adapter or a client. The response to every event delivery is an empty 200: there is no auto-reply to STOP or HELP from our side (see open item 1).

**PHI:** bodies and numbers go to Postgres through `services/messaging` only. Log lines carry the office, the event type and ACS's message id (charset-checked). A guard test scans every `console.*` in the ACS files.

### STOP posture
ACS enforces opt-outs itself for US toll-free numbers. For 10DLC it is not documented, so **our consent layer is treated as the sole authority** (opt-out > all, at send time). Nothing relies on provider-side suppression.

If ACS or a carrier blocks a send anyway, the delivery report maps to `failed`, with a reason saying the sender was blocked for that number. It does **not** write consent: only the patient's own STOP, arriving as an inbound message, does that. A test pins this.

## Tests
Backend `node --test`: **3,519 pass, 0 fail**. `node --check server.js` passes. Dashboard `pnpm run check` (tsc) is clean. `pnpm run test`: **149 files pass**, including the contract-bundle drift test (`shared/tc` is untouched, so the bundle is unchanged).

New:
- `routes/acsSmsWebhooks.test.js` (29 tests): a real HTTP server, the real JSON parser, router, messaging service and `/api/tc` stack, over FakeTenantDb with a fake ACS transport.

  | Required by the spec | Test |
  | --- | --- |
  | Handshake | answered with Event Grid's code; refused 401 without the token, and the code is never echoed |
  | Auth rejection, recorded NOWHERE | 9 variants (missing, empty, wrong, ±1 character, query string, `Authorization` header, unset, short): 401, `db.log` empty, no tenant opened, no audit row |
  | Office from the receiving number | Roland and Valley, with and without `+`; unknown → 200 with nothing recorded; one office configured; the patient's number never decides |
  | Inbound dedup on redelivery | a new envelope id with the same ACS id, and the same event twice in one batch → stored and audited once; a redelivered STOP → one consent row |
  | STOP → consent + nurture stop | consent opted_out, the enrollment `stopped/opted_out` with its audit, and the next send `CONSENT_OPTED_OUT` with ACS never called; a non-STOP reply pauses; STOP lands with texting off; HELP/START send nothing |
  | Delivery reports, monotonic | Delivered once, redelivery a no-op; a late Failed never regresses delivered; Failed then Delivered → delivered; a block → failed with a reason; unknown status ignored; cross-office and cross-provider rows untouched |
  | Per-office sender, no fallback | Valley without its number → 501 `office_not_configured` + `missing: ["TC_SMS_ACS_FROM_VALLEY"]`, while Roland sends from its own number |
  | Twilio untouched and unselected under `acs` | Twilio is fully configured in the env with its transport rigged to throw; every send goes to ACS and Twilio is never called |

  Also covered there: the request shape, the 202-means-queued rule, a per-recipient refusal inside a 202 → `failed` with a scrubbed error, and the shipped state (nothing configured) → `FEATURE_DISABLED` with ACS untouched.
- `services/messaging/adapters/acsSmsAdapter.test.js` (15 tests):
  - **Provider switch:** the default, named values and unknown values fail closed (no provider asked).
  - **Selection identity.**
  - **Twilio unselected:** it still says `enabledFor('valley')` when asked directly, but the registry never hands it out, so Valley is OFF and doesn't borrow Twilio's number.
  - **Config:** per-office E.164, receiving-number mapping and ambiguity, the auth modes (it never reads `ACS_EMAIL_*`), and the token length.
  - **Adapter:** readiness, the send-time refusal naming the setting, the request shape, the managed-identity bearer, the HMAC signature checked against email's signer, five failure shapes with no number in any error, and a managed-identity token failure naming the mode.
- `services/messaging/acs/smsGuards.test.js` (6 tests):
  - the webhook never sends;
  - the token check is the only and first `router.use`, and `req.query` is never read;
  - no kill-switch read in the webhook;
  - no PHI in logs;
  - the only `sendSms` caller is the ACS adapter;
  - the Twilio adapter never reads `TC_SMS_PROVIDER`.
- `test/moduleGateWiring.test.js`: the ACS mount is unguarded and mounted before `/api/webhooks`.

**Existing tests changed (called out):** `routes/twilioWebhooks.test.js` and `services/messaging/adapters/smsAdapter.test.js` now set `TC_SMS_PROVIDER: 'twilio'` in their env block. They test the Twilio adapter, which is now selected only when named. No assertion changed.

## Config and secret NAMES (never values)
**Key Vault secrets Beau will create** (they are mapped in `config/secrets.js` and loaded into env in production):

| Key Vault secret | Env var | Needed? |
| --- | --- | --- |
| `tc-sms-acs-webhook-token` | `TC_SMS_ACS_WEBHOOK_TOKEN` | **Yes.** At least 32 characters; generate with e.g. `openssl rand -base64 48`. Without it, every Event Grid request is 401. |
| `tc-sms-acs-from-roland` | `TC_SMS_ACS_FROM_ROLAND` | Yes, for Roland to send. E.164, e.g. `+1…`. |
| `tc-sms-acs-from-valley` | `TC_SMS_ACS_FROM_VALLEY` | Only when Valley gets its own number. Until then Valley is `office_not_configured`. |
| `tc-sms-acs-connection` | `TC_SMS_ACS_CONNECTION` | **Only** if not using managed identity (`TC_SMS_ACS_AUTH_MODE=connection_string`). |

**Plain app settings (not secrets):**

| Setting | Value |
| --- | --- |
| `TC_SMS_PROVIDER` | leave unset (= `acs`), or set `acs` explicitly |
| `TC_SMS_ACS_AUTH_MODE` | unset (= `managed_identity`), or `connection_string` |
| `TC_SMS_ACS_ENDPOINT` | `https://<acs-resource>.communication.azure.com` (managed-identity mode) |
| `TC_SMS_ACS_TENANT_SLUG` | `carein` |

**Unchanged:** `TC_SMS_ENABLED` and `platform_setting['tc_sms_enabled']`. The Twilio secrets can stay in the vault or be removed; under `acs` they are never read for sending.

## Event Grid subscription setup
Create one subscription per environment, on that environment's **Communication Services resource** (the one that owns the phone numbers). Do it **after** the app in that environment is running this code with `TC_SMS_ACS_WEBHOOK_TOKEN` loaded, because Event Grid validates the endpoint when the subscription is created.

> This branch is not merged, and staging deploys from `develop`. So the staging subscription can be created only after this merges and staging redeploys. Until then the endpoint does not exist on staging.

**Portal:** ACS resource → **Events** → **+ Event Subscription**.
1. **Name:** `tc-sms-acs-staging` (prod: `tc-sms-acs-prod`).
2. **Event Schema:** **Event Grid Schema**. Not CloudEvents v1.0; the router expects an array and answers the Event Grid handshake only.
3. **System topic name:** e.g. `evgt-carein-acs-staging` (portal-created on first use).
4. **Filter to event types:** **SMS Received** (`Microsoft.Communication.SMSReceived`) and **SMS Delivery Report Received** (`Microsoft.Communication.SMSDeliveryReportReceived`). Nothing else.
5. **Endpoint type:** Web Hook.
   - **Staging:** `https://staging.carein.ai/api/webhooks/acs-sms`
   - **Prod:** `https://dashboard.carein.ai/api/webhooks/acs-sms`
6. **Delivery Properties** tab → add a header named **`X-CareIN-Webhook-Token`**, type **Static**, value = the **`tc-sms-acs-webhook-token`** secret for that environment, **Is secret? ✓**.
7. **Additional features:** keep the default retry policy (30 attempts / 24 h) and max events per batch (1). A dead-letter storage container is optional.
8. **Create.** Validation should succeed immediately; the app logs `[acs-sms] Event Grid subscription validation answered`. A 401 at this step means the header value does not match the vault secret the app loaded (restart after rotating).

**CLI equivalent.** Read the token from the vault into a variable so it is never typed or kept in history:
```
TOKEN=$(az keyvault secret show --vault-name <env vault> --name tc-sms-acs-webhook-token --query value -o tsv)
az eventgrid event-subscription create \
  --name tc-sms-acs-staging \
  --source-resource-id <ACS resource id> \
  --endpoint-type webhook \
  --endpoint https://staging.carein.ai/api/webhooks/acs-sms \
  --event-delivery-schema eventgridschema \
  --included-event-types Microsoft.Communication.SMSReceived Microsoft.Communication.SMSDeliveryReportReceived \
  --delivery-attribute-mapping X-CareIN-Webhook-Token static "$TOKEN" true
unset TOKEN
```

## Beau's preconditions (outside this slice; it ships dark regardless)
1. **Number purchase and registration** (separate runbook): toll-free or 10DLC on the ACS resource in `rg-carein-staging` (later prod). Confirm the resource is inside the Azure BAA scope (D7). Texting from an unregistered number will fail at the carrier, which shows up as `failed` with ACS's reason.
2. **Managed identity:** grant `id-carein-staging` (later prod's identity) a role on the ACS resource that allows SMS send through Entra. **Confirm the exact built-in role name in ACS's "Authenticate with Microsoft Entra ID" docs at provisioning time**; I didn't invent one. Memory notes say `az role assignment` hits a MissingSubscription quirk and the `az rest` PUT recipe works. Otherwise use the connection-string secret plus `TC_SMS_ACS_AUTH_MODE=connection_string`.
3. **Create the Key Vault secrets and app settings** in the tables above.
4. **Merge, let staging redeploy, then create the Event Grid subscription** (above).
5. Confirm `tc` is entitled for the staging tenant (the webhook 403s otherwise). Then set `platform_setting['tc_sms_enabled']=true` **in staging only**, when ready to send.

### Staging test plan: every real send goes ONLY to Beau's own cell
No patient number is ever used. Test cases are the designated fixtures, with **Beau's own cell** put on the case's phone field in staging.
1. **Dark check.** With `tc_sms_enabled` unset, the Messages tab on roland 12828 shows "Texting is switched off". Send is refused and the draft stays a draft.
2. **Config check.** Set `tc_sms_enabled=true` with `TC_SMS_ACS_FROM_ROLAND` present and `_VALLEY` absent:
   - **Roland 12828** shows texting connected.
   - **Valley 7115** shows "No number for this office". A send there returns 501 with `missing: ["TC_SMS_ACS_FROM_VALLEY"]`.
3. **Send.** Put Beau's cell on roland 12828. Draft "CareIN ACS staging test 1", then Send.
   - Expect the toast "Text handed to the texting service (queued — not delivered yet)".
   - The row is `queued` with `provider = acs`.
   - The text arrives on Beau's phone.
4. **Delivery report.** Within about a minute the chip turns **Delivered** (green), from the Event Grid report. The app log shows nothing but office and id.
5. **Reply.** Reply "Thanks" from Beau's phone. It appears in the case thread and in the Texts inbox, linked to 12828.
6. **Nurture interaction.** If 12828 has a running nurture campaign, the reply pauses it.
7. **STOP.** Reply **STOP**:
   - the consent row reads opted_out (`stop_keyword`), and any running nurture enrollment stops;
   - the next Send is refused `CONSENT_OPTED_OUT`, and ACS is never called.

   Note whether the phone received an automatic opt-out confirmation, and from whom (open item 1).
8. **Undo for further tests.** Reset the `tc_contact_consent` row directly in the staging database. START never flips consent back, and this slice adds no re-opt-in path. Reply **START** and **HELP** and confirm both are recorded and audited and change nothing.
9. **Auth check.** POST to `https://staging.carein.ai/api/webhooks/acs-sms` without the header → **401**, and no row or audit entry appears.
10. **Teardown.** Remove Beau's cell from the test case, and set `tc_sms_enabled=false` unless staging should stay live.

## Open items (Beau / PM)
1. **STOP/HELP auto-replies.** CTIA and carrier rules expect a STOP confirmation and a HELP response. ACS sends these itself for **toll-free**. For **10DLC** it is undocumented. Our webhook **sends nothing, ever**, by rule, so for 10DLC the reply has to come from the provider or carrier, or from a ruled exception to the guardrail. Step 7 of the staging plan will show what actually happens. Recommendation: use toll-free for go-live if the 10DLC behaviour turns out to be silence.
2. **Twilio webhooks stay mounted.** `/api/webhooks/twilio/*` is still live and still refuses anything not signed with `TWILIO_AUTH_TOKEN`. If the Twilio secrets are removed from the vault, every Twilio callback is refused, which is the right state under `acs`. Removing the mount is out of scope.
3. **Single tenant per deployment** (`TC_SMS_ACS_TENANT_SLUG`): the same limitation as Twilio and email. Multi-tenant provider mapping is out of scope.
4. **Entra-authenticated delivery** is a possible later hardening (see "Auth" above).
5. **Other `deliveryStatus` values.** Microsoft documents only `Delivered` and `Failed`. Any other value is ignored and logged, so the row stays `queued` rather than guessing. If staging shows another value, map it then.

## Ops note
`C:\Users\beau\carein cursor dashboard\.git\packed-refs.lock` (stale, empty, Oct 7) is still present in the PROD folder. Git prints lock warnings on commit and push, but every commit and the push landed (verified with `git ls-remote`). I left it alone.

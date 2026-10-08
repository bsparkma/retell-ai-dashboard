# Item 39: SMS adapter, two-way Twilio behind the item 38 approval queue

**Branch:** `feature/tc-sms-twilio`, STACKED on `feature/tc-messaging-foundation` (item 38, PR #229, not merged)
**PR:** DRAFT, base `feature/tc-messaging-foundation` (number recorded at the bottom)
**Lane:** RED (new vendor on a PHI path, new secrets/config, new unauthenticated webhook surface, one tenant migration). **NOT MERGED. NEEDS REVIEW.**

## Sequencing (orchestrator decision)
The spec says "requires 38 merged". Item 38 is still open, so this branch is **stacked** on it and the PR is a **draft** held until #229 merges ("a held PR is a DRAFT"). After #229 merges:
1. Retarget the base manually. Stacked PRs do not auto-retarget, and `gh pr edit` is broken, so use:
   `gh api -X PATCH repos/bsparkma/retell-ai-dashboard/pulls/<n> -f base=develop`
2. Mark the PR ready. CI `build-test` only runs on PRs targeting develop/main, so **CI first runs after the retarget**.

Item 40 (ACS email) stacks on THIS branch.

## What was built
Ships **DARK** three ways:
- the kill switch floor is OFF;
- no Twilio secret exists in any vault;
- `/api/tc` is still unentitled.

The 38 approval click, consent gate and quiet-hours block are unchanged and still run before the adapter.

| Piece | File |
| --- | --- |
| Kill switch | `backend/config/tcSms.js`: `platform_setting['tc_sms_enabled']` (boolean) → `TC_SMS_ENABLED` env fallback → **false**. `TC_SMS_ENABLED=false` is break-glass and beats a stored `true`. A stored row beats an enabling env var. Read at run time from a cache refreshed at boot, every 5 min, and **again inside `send()` before every text**. Never throws, and keeps its last good value on a blip. |
| Twilio config | `backend/config/twilio.js`: account creds, per-office sender `TWILIO_FROM_<OFFICE>` (strict E.164 or treated as missing), receiving-number → office (exactly one owner, otherwise null), https-only public base URL, status-callback URL builder. |
| REST client | `services/messaging/twilio/client.js`: **fetch-based, no `twilio` npm dependency, so package.json and the lockfile are unchanged.** One POST to `/2010-04-01/Accounts/{sid}/Messages.json` with Basic auth `apiKeySid:apiKeySecret`, sending `To`/`From`/`MessagingServiceSid`/`Body`/`StatusCallback`. 10s `AbortSignal.timeout`, no retry. Phone-shaped text in Twilio's error messages is scrubbed. |
| Signature | `services/messaging/twilio/signature.js`: Twilio's documented algorithm (URL + sorted params, HMAC-SHA1, base64), compared with `timingSafeEqual`. It reproduces **Twilio's published test vector** (`RSOYDt4T1cUTdK1PDd93/VVr8B8=`). |
| Status ladder | `services/messaging/twilio/status.js`: maps Twilio statuses to the 38 vocabulary and defines the monotonic order `queued < sent < failed < delivered`. Error codes become plain-language text. |
| Adapter | `adapters/smsAdapter.js` is real. The contract gains **optional** `enabledFor(officeKey)` and `unavailableReason(officeKey)`. `adapters/index.js` `isChannelEnabled(channel, office)` and `channelUnavailableReason`. |
| Service | `services/messaging/index.js`: readiness and send are now **per office**. `recordInbound` gains `linkOpenCase`, START/HELP recording and provider-id dedupe. New `applyStatusCallback`, `countUnseen`, `listUnseenOnCases`, `markSeen`. |
| Webhooks | `backend/routes/twilioWebhooks.js` mounted at **`/api/webhooks/twilio`** (`POST /inbound`, `POST /status/:office`). Order: signature → tenant → office → record. |
| Routes | `/api/tc/messages`: `GET /unseen-count`, `GET /unseen`, `POST /seen` (strict body `{caseId: uuid\|null}`). |
| Migration | `migrations-tenant/1790400000000_tc_messages_twilio.js`: `tc_messages.seen_at`, `seen_by`, partial UNIQUE `(provider, provider_message_id) WHERE id IS NOT NULL`, partial index for the unseen count. No new table and no CHECK change. |
| Contract | `shared/tc/messaging.ts`: `ChannelUnavailableReason` enum. `ChannelReadiness.adapterReason` (nullable, defaults to null). `contract.gen.cjs` was regenerated with the pinned esbuild and `--alias:zod`. |
| UI | **Messages tab:** SMS is live when the server says so for that office; the server's reason is shown in words; delivery is honest (only `delivered` is green; "Sent — delivery not confirmed"; a failed text Twilio had accepted reads "Not delivered"); opening a thread marks its texts seen. **New `/tc/texts` page:** replies matched to a case (with an Open case link) and the unmatched inbox (Mark as seen). **TC nav "Texts" item** carries the unseen count. |

### How a webhook gets a tenant (the spec gap)
A webhook carries no SSO user, so `tenantContext` cannot resolve a tenant, and no office → tenant mapping exists anywhere. I did not guess one. Instead:
- **`TWILIO_TENANT_SLUG`** (a plain app setting) names the tenant explicitly.
- The registry resolves it. The tenant must be `active` and entitled to `tc` (requireModule's rule, applied in the router).
- The router then builds `req.tenant` in the same shape `tenantContext` builds, with actor `system:twilio`.
- Unset or unknown slug, a suspended tenant, or an unreachable control plane → **503** and nothing recorded. A tenant not entitled to `tc` → **403**.

This is one Twilio account per deployment. It fits today's single-tenant office registry, but it is not multi-tenant. If a second practice group ever gets texting, this needs a number → tenant map in the control plane.

### URL reconstruction behind ACA ingress + Caddy
The signature covers the URL Twilio called. The handler rebuilds that URL as `TWILIO_WEBHOOK_BASE_URL` + `req.originalUrl`, and it **never** uses the `Host` or `X-Forwarded-*` headers. `TRUST_PROXY_HOPS` is irrelevant here.

The base URL must be `https://`, with no query string or hash. If it is missing, every webhook is refused and the adapter reports `not_configured`.

To make the raw form body available, `server.js`'s `express.urlencoded` now captures `req.rawBody`, the same `verify` hook `express.json` already had.

## Spec coverage
| Spec | Where / test |
| --- | --- |
| Send via Messaging Service + per-office From + statusCallback; store provider id | `smsAdapter.test.js` (payload assertions), `twilioWebhooks.test.js` "Send (roland)" |
| Map statuses queued/sent/delivered/failed + errorCode text | `status.test.js`, webhook status tests |
| HIPAA minimum necessary | The 38 templates already say "the treatment plan we went over" / "your treatment". `twilioGuards.test.js` scans every template for clinical terms. The `talking_point` exclusion is unchanged. |
| Validate X-Twilio-Signature, 403 + warn, no body processing, both directions | `signature.test.js` (vector, valid, 7 invalid, missing); webhook test "INVALID/MISSING…" asserts **zero DB queries and no tenant DB opened**; guard test: signature middleware precedes every route |
| Status callback by provider id; idempotent; out-of-order safe | webhook tests: sequence, idempotent, delivered never regresses (5 late statuses), undelivered→failed then delivered wins, cross-office no-op, never touches draft/sending/inbound, unsigned refused |
| Inbound: office from the To; E.164; link the open case or leave unlinked; ambiguous ⇒ unlinked | webhook tests: roland/valley derivation, 10-digit normalization, one match links, two open matches ⇒ unlinked, terminal and other-office cases ignored, inbox / thread visibility |
| Unknown receiving number ⇒ warn + drop | 200 empty TwiML, nothing recorded, no tenant DB opened |
| STOP ⇒ tc_contact_consent source=stop_keyword ⇒ gate blocks next send | webhook test "STOP records consent… gate then blocks" (403 `CONSENT_OPTED_OUT`, Twilio never called, row stays draft); per-office STOP |
| Per-office fail closed when only one office configured | webhook test (valley 501 `office_not_configured`, draft stays, roland sends with roland's From); inbound to the unconfigured office's number is dropped; `twilio.test.js` |
| Kill switch run-time, env fallback, floor OFF | `tcSms.test.js` (9 cases), adapter "send re-reads the switch", webhook "kill switch off → 501" |
| Fake Twilio client, no network | `client.setFetchForTests`. Every fake asserts the URL is `api.twilio.com`, and nothing touches the network. |
| UI | `tests/tc-sms-twilio.test.tsx` (10), `tests/tc-texts-nav.test.tsx` (5), screenshots |

## Tests
- **backend** (`node --check server.js` + `scripts/shard-runner.mjs`, the CI shape): **3243 tests / 3240 pass / 0 fail / 3 skipped**, 4 shards green. On #229 the count was 3160, so this branch adds 83 tests.
  - New files: `config/tcSms.test.js`, `config/twilio.test.js`, `services/messaging/twilio/{signature,status,twilioGuards}.test.js`, `services/messaging/adapters/smsAdapter.test.js`, `routes/twilioWebhooks.test.js` (33), `test/tcMessagesTwilioMigration.test.js`.
- **new-dashboard:** `pnpm run check` is clean. `pnpm run test` gives **2455 pass / 164 skipped** (144 files passed, 27 skipped). On #229 it was 2440, so this branch adds 15. `tc-sms-shots.test.tsx` runs only with `TC_SHOTS=1`.
- **Flakes:** none were hit, so there were no isolated re-runs.

## Existing tests changed (called out)
1. **`backend/routes/tc/tcMessages.test.js`** ("adapter FEATURE_DISABLED thrown after claiming enabled → failed"): the fixture spread the real SMS adapter and overrode `enabled: () => true`. The real adapter now also has `enabledFor`, so the fixture adds `enabledFor: () => true`. **The assertions are unchanged.**
2. **`backend/test/moduleGateWiring.test.js`**: one **added** test. It checks that `/api/webhooks/twilio` carries no module or permission guard, that the `/webhooks` exemption is still on both gates, and that the Twilio router mounts before `/api/webhooks`. No existing assertion changed.
3. A UI defensive change, not a test change: item 38's `tc-messages.test.tsx` mocks `messagingApi` without `markSeen`, and the new mark-seen call crashed the thread in that test. The component now wraps the fire-and-forget mark in try/catch so a seen-marker failure can never take the thread down. The test was not edited.

## Vocabulary-reader inventory (grepped, excluding node_modules, dist and contract.gen.cjs)
| New value / code / route | Readers |
| --- | --- |
| `ChannelUnavailableReason` (`switched_off`, `not_configured`, `office_not_configured`) | `shared/tc/messaging.ts`; `adapters/index.js` (`UNAVAILABLE_REASONS`); `smsAdapter.js`; `services/messaging/index.js` (`disabledSentence`); `copy.ts` (`ADAPTER_REASON_COPY` and `ADAPTER_REASON_SHORT`, both total Records); `MessagesTab.tsx`; tests |
| `FEATURE_DISABLED` extra `reason` | `services/messaging/index.js`; route passes it through; UI uses `SEND_ERROR_COPY.FEATURE_DISABLED` (copy reworded to be office-neutral) |
| Twilio→ours status map / ladder | `twilio/status.js`; `smsAdapter.js` (`mapCreateStatus`); `index.js` `applyStatusCallback`. **No new `MessageStatus` value.** `copy.ts` `statusLabel()` adds the "Not delivered" wording for `failed` + provider id. |
| Adapter `providerCode` values `TWILIO_<code>`, `TWILIO_TIMEOUT`, `TWILIO_UNREACHABLE`, `TWILIO_BAD_RESPONSE`, `TWILIO_UNEXPECTED_STATUS` | `twilio/client.js`, `smsAdapter.js`; surfaced through 38's `SEND_FAILED.providerCode`. Read only by tests. |
| Webhook codes `TWILIO_SIGNATURE_INVALID`, `TWILIO_ACCOUNT_MISMATCH`, `TWILIO_TENANT_UNRESOLVED`, `TWILIO_INBOUND_FAILED`, `TWILIO_STATUS_FAILED` | `routes/twilioWebhooks.js`; tests. Twilio is the only client. |
| audit `resource_type` `tc_message.status.<queued\|sent\|failed\|delivered>`, `tc_message.inbound_keyword.<start\|help>`, `tc_message.seen` | written by `services/messaging/index.js`; read only by tests. Nothing filters on `resource_type`. Audit actions stay inside READ/CREATE/UPDATE/DELETE, and the webhook actor is `system:twilio`. |
| Routes `/api/webhooks/twilio/{inbound,status/:office}`, `/api/tc/messages/{unseen-count,unseen,seen}`, page `/tc/texts` | `server.js`, `routes/twilioWebhooks.js`, `routes/tc/messages.js`; `messagingApi.ts`, `DashboardLayout.tsx`, `App.tsx`, `TcTexts.tsx`. `/tc/texts` inherits `tc.full` from the `/tc` prefix in `ROUTE_PERMISSIONS`, so hygienists don't see it (role-nav test still green). |
| Columns `seen_at`, `seen_by` | migration; `index.js` (`countUnseen`, `listUnseenOnCases`, `markSeen`). Not in `MESSAGE_COLS` and not in the contract entity. |

## New config / secret NAMES (never values)
**Key Vault (added to `config/secrets.js` SECRET_MAP, all optional, documented in `docs/SECRETS.md`):**

| Secret | Env var |
| --- | --- |
| `twilio-account-sid` | `TWILIO_ACCOUNT_SID` |
| `twilio-api-key-sid` | `TWILIO_API_KEY_SID` |
| `twilio-api-key-secret` | `TWILIO_API_KEY_SECRET` |
| `twilio-auth-token` | `TWILIO_AUTH_TOKEN` (spec gap, see Conflicts) |
| `twilio-messaging-service-sid` | `TWILIO_MESSAGING_SERVICE_SID` |
| `twilio-from-roland` | `TWILIO_FROM_ROLAND` |
| `twilio-from-valley` | `TWILIO_FROM_VALLEY` |

**App settings (not secret):**
- `TWILIO_WEBHOOK_BASE_URL`
- `TWILIO_TENANT_SLUG`
- `TC_SMS_ENABLED`
- `TC_SMS_REFRESH_MINUTES` (default 5)

**Control-plane setting:** `platform_setting['tc_sms_enabled']`, a JSON boolean. No migration seeds it and there is no console UI. A runbook writes it.

## Screenshots (`docs/screenshots/tc/`, 1280×900, light and dark: 10 PNGs)
- `tcsms-01-delivery-states`: Delivered / Received / Sent — delivery not confirmed / Not delivered with the Twilio 30003 reason / Queued. This one is **illustrative**: no text can reach these states until the preconditions are met.
- `tcsms-02-office-no-number`: Valley, "No number for this office", Send disabled. The fixture body says "Roland"; it is a template string reused for both offices.
- `tcsms-03-switched-off`
- `tcsms-04-texts-page`
- `tcsms-05-nav-count`: the sidebar "Texts 2" badge.

Reproduce from `new-dashboard/`:
```
pnpm exec vite build
TC_SHOTS=1 pnpm exec vitest run tests/tc-sms-shots.test.tsx
node scripts/shoot-tc-sms.mjs
```
Item 38's `tcmsg-*` PNGs are now slightly stale: they show "Sent" as green, and it is now an info-blue "Sent — delivery not confirmed". They were not re-shot.

## Conflicts with guardrails (resolved toward the guardrail)
1. **Auth token not in the spec.** Webhook signatures need the account AUTH TOKEN; an API-key secret cannot validate them. I added `twilio-auth-token` / `TWILIO_AUTH_TOKEN`. Without it every webhook is refused.
2. **Tenant for webhooks.** There is no existing mechanism, so the webhook uses an explicit `TWILIO_TENANT_SLUG` resolved through the registry, and fails closed on anything else. See above.
3. **Mount path.** The spec says "mounted outside /api/tc". I mounted it at `/api/webhooks/twilio` so it rides the existing, tested `/webhooks` exemptions (SSO gate, tenant gate, rate limiter, access log) without widening any exempt list.
4. **Inbound linking.** Item 38 said linking is a human decision; item 39's spec says link to the open case whose phone matches. I followed 39 (opt-in `linkOpenCase` used only by the webhook). Exactly one open case in that office must match; zero or several ⇒ unlinked. 38's default path is unchanged.
5. **START/UNSTOP is unruled**, so a START is recorded and audited (`tc_message.inbound_keyword.start`) but **does not** flip consent back. After a START, Twilio Advanced Opt-Out re-subscribes the number on the carrier side, while our own gate still blocks. Ours is the stricter one until Beau rules.
6. **Kill-switch flip mid-send.** If the switch is turned off between the readiness check and `send()`, the adapter's fresh re-read refuses, and the row ends **`failed`** ("Text messaging is switched off. Nothing was sent."), not `draft`. This is honest because nothing left, but it burns the draft, so the TC drafts again.
7. **Unseen count is not audited per poll.** It is a count with no PHI, and it rides a 60s tick. The lists it leads to are audited.

## Open questions (Beau / PM)
1. **START/UNSTOP re-opt-in**: should an inbound START lift a `stop_keyword` opt-out (only that source, not a manual one)? Today it does not.
2. **TxtMsgOk wire format** (carried over from 38) must be confirmed against a live `/patients/12828` before SMS is switched on.
3. **Status callback racing the Send response.** If Twilio's first callback arrives while the row is still `sending` (the adapter answered but the `UPDATE` hasn't landed), that one report is dropped (200, logged as `not_found_or_stale`). Later reports still land. Is that window acceptable, or should the callback carry our message id?
4. **Linking an unmatched text to a case by hand** is still not built. The Texts page can only mark them seen.
5. **MMS**: attachments are never fetched. The body gets a "[The patient also sent a picture or file…]" note. Is that OK?
6. Should the kill switch get a Platform Console toggle like hygiene's? Today it is runbook-only.
7. **Single tenant per deployment** (`TWILIO_TENANT_SLUG`). Multi-practice texting would need a number → tenant map.

## Beau's preconditions (outside this slice; the code ships dark regardless)
1. Twilio **BAA** signed and the account designated HIPAA-eligible.
2. **A2P 10DLC** brand and campaign registered. Turn on **Advanced Opt-Out** on the Messaging Service.
3. Roland and Valley numbers bought and added to the Messaging Service.
4. Secrets into **kv-carein-staging** first, then **kv-carein-prod**: the seven `twilio-*` names above, using an API key for SID/secret plus the account auth token.
5. App settings per environment:
   - `TWILIO_WEBHOOK_BASE_URL=https://<that environment's public host>`
   - `TWILIO_TENANT_SLUG=carein`
6. In the Twilio console, set the Messaging Service (or each number) **incoming message webhook** to `POST https://<host>/api/webhooks/twilio/inbound`. Status callbacks need no console setting: every send passes `https://<host>/api/webhooks/twilio/status/<office>` itself.
7. Run the tenant migration (`1790400000000`) through the normal pipeline.
8. Entitle `tc` for the tenant, and set `platform_setting['tc_sms_enabled']=true` in **staging only** to test.

### Staging test steps
**Send ONLY to Beau's own verified cell, never a patient number.**
1. Put Beau's cell on a staging test case: roland 12828, or valley 7115.
2. Draft and Send. Expect "Queued", then "Sent", then "Delivered" within a minute.
3. Reply from the cell. The reply lands in that case's thread, and the Texts count goes up.
4. Reply STOP. A consent row is written and the next Send is refused with `CONSENT_OPTED_OUT`.
5. Unset `TWILIO_FROM_VALLEY`. Valley shows "No number for this office" while Roland still sends.

## Notes for item 40 (ACS email, stacked here)
- **Adapter contract:** implement `enabledFor(officeKey)` and `unavailableReason(officeKey)`. The reasons are the closed `ChannelUnavailableReason` set; add a value there and to `ADAPTER_REASON_COPY` / `ADAPTER_REASON_SHORT` if email needs one. Readiness and send already ask per office.
- **Migrations:** the next tenant migration timestamp must be after `1790400000000`.
- **Shared plumbing:** `server.js` urlencoded now captures `req.rawBody`. The webhook tenant pattern is in `routes/twilioWebhooks.js` `attachTenant`.
- **Copy:** `SEND_ERROR_COPY.FEATURE_DISABLED` is now office-neutral copy.

## Commands, if a push or PR had to be done by hand
Both were done. For reference:
```
git push -u origin feature/tc-sms-twilio
gh pr create --draft --base feature/tc-messaging-foundation --head feature/tc-sms-twilio
```

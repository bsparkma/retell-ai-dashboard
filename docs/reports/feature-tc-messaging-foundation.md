# Item 38: TC messaging foundation (drafts, approval queue, consent)

**Branch:** `feature/tc-messaging-foundation` (off `origin/develop` `e551c65`) · **PR:** #229 (base develop)
**Lane:** RED (two tenant migrations' worth of tables, new routes, new shared vocabulary) · **NOT MERGED**. Needs review.
Items 39 (Twilio SMS) and 40 (ACS email) stack on this branch.

## What was built

A message layer in which **nothing sends unless a person clicks Send on that one message**. There is no auto-send, no scheduled send and no bulk send. This slice connects no provider. Both channel adapters are stubs that refuse with `FEATURE_DISABLED`, and the whole surface stays dark behind `requireModule('tc')`.

| Layer | Files |
| --- | --- |
| Contract | `new-dashboard/shared/tc/messaging.ts` (enums, `TcMessage`, `TcContactConsent`, `ChannelReadiness`, strict request bodies). Exported from `backend/tc/contract.entry.ts`. `contract.gen.cjs` was regenerated with the pinned esbuild and `--alias:zod`, and the drift test passes. |
| Migration | `backend/migrations-tenant/1790300000000_tc_messaging.js`: `tc_messages` and `tc_contact_consent`. CHECK literals are inline, there is a role-guarded `carein_app` CRUD grant per table, and indexes are (office_id, case_id) and (office_id, to_address). UNIQUE (office_id, channel, address). |
| Service | `backend/services/messaging/`: `index.js` (draft / edit / discard / **sendMessage** / recordOptOut / recordInbound / readiness), `consent.js` (`canMessage`), `quietHours.js`, `address.js` (E.164 / lower-cased email), `templates.js`, `errors.js`, `adapters/{index,smsAdapter,emailAdapter}.js` |
| Routes | `backend/routes/tc/messages.js` mounted at `/api/tc/messages` under `tc.full` (one line in `routes/tc/index.js`) |
| UI | Case view gets a **Messages** tab (`features/tc/caseview/MessagesTab.tsx`). The follow-up card gets a **Draft message** button that links to `?tab=messages&draftFrom=<followupId>&channel=…`. New files `features/tc/messaging/{messagingApi,copy}.ts`. `DisabledReason` gains `messaging_provider`. |

### Routes (all take `?office=`; office is never read from the body)
`GET /?caseId=` · `GET /inbox` · `GET /consent?caseId=` (per-channel readiness) · `POST /draft` · `PUT /:id` (edit a draft) · `POST /:id/send` · `POST /:id/discard` · `POST /consent` (manual **opt-out only**)

Three routes go beyond the spec's list: `PUT /:id`, `GET /consent` and `POST /consent`. They exist because the spec's "(optional edit)", "consent badge" and `source: manual` need an endpoint each. None of them sends anything.

### The send path (`services/messaging/index.js` `sendMessage`), in order
1. Audit `tc_message.send_attempt`. This fails closed: if the audit row cannot be written, nothing is sent.
2. The row must be an outbound `draft`. Anything else returns 409 `MESSAGE_NOT_SENDABLE`.
3. The case's current address must still equal the draft's `to_address`. If not, it returns 409 `ADDRESS_CHANGED`.
4. **Consent gate** (`consent.js`). The first rule that refuses wins:
   - opted_out → `CONSENT_OPTED_OUT` (403). There is no override, and Open Dental is not even read.
   - For SMS to a linked patient, OD TxtMsgOk is read through `config/odOffices` (assertOfficeMatch) and `services/odPatientCache` (keyed office + PatNum, 5-minute TTL):
     - `No` → `OD_TEXT_CONSENT_NO` (403)
     - unreadable, office not connected, or an unrecognised value → `OD_CONSENT_UNAVAILABLE` (503, fail closed)
     - `??` → allowed, with the "No OD text consent on file" badge
   - SMS between 21:00 and 08:00 America/Chicago → `QUIET_HOURS` (403). This is a hard block. The zone is not configurable and there is no clock input on any request. Email is exempt.
   - Each block is audited as `tc_message.send_blocked.<code>` with result `UNAUTHORIZED`, and the row stays a draft.
5. If the adapter is not connected → 501 `FEATURE_DISABLED`. The row stays a draft because nothing was attempted. **This is the live path in this slice.**
6. A conditional `UPDATE … SET status='sending' WHERE status='draft'` means a double click cannot send twice.
7. `adapter.send`:
   - A valid confirmation stores `sent` or `queued` verbatim and audits `tc_message.sent`.
   - A throw or a malformed result stores `failed` with `error` preserved, audits `tc_message.failed` (result `ERROR`) and returns 502 `SEND_FAILED` with `providerCode`. **It is never retried.**

`recordInbound` (for item 39's webhook):
- It stores a `received` row with no case link, which surfaces in `GET /inbox`.
- A STOP-family body (STOP / STOPALL / UNSUBSCRIBE / CANCEL / END / QUIT) upserts an `opted_out` row with source `stop_keyword`.

## Adapter contract (for items 39 and 40)
`adapters/index.js` documents the contract in full. Each adapter module exports:
- `channel`: `'sms'` or `'email'`.
- `provider`: a string, or `null` while it is a stub.
- `enabled()`: synchronous, no I/O. It returns whether the provider is configured and switched on.
- `send(message, office)`.

**Input:**
- `message`: `{ messageId, officeId, caseId, channel, toAddress, body, subject, templateId }`. The address is the normalized one the server assembled, and the adapter must not alter it.
- `office`: `{ officeKey, officeName }`. Choose the sender by `officeKey`, and throw if there is none. Never fall back to another office's sender.

**Output:** resolve `{ provider, providerMessageId, status: 'sent'|'queued', fromAddress? }` only after the provider has confirmed the hand-off. Anything else must be a throw, preferably a `MessagingError` with a code.

**Failure handling:** the service marks the row `failed`, stores `err.message` (which must not contain the message body) and never retries. A resolved value that does not match the shape counts as a failure (`ADAPTER_BAD_RESPONSE`), never as success.

**Turning a channel on** means flipping `enabled()` and implementing `send`. Nothing else changes.

## Acceptance / spec coverage
| Spec | Where |
| --- | --- |
| tc_messages / tc_contact_consent data model, CHECKs inline, grants, indexes, UNIQUE | migration + `test/tcMessagingMigration.test.js`. Rehearsed on **real Postgres 16** (up/down/up) as `carein_app`: the grants work, every CHECK refuses bad values, the consent upsert collapses to one row, the conditional `draft→sending` matches exactly once, and deleting a case unlinks its messages. |
| Opt-out beats everything | `consent.test.js` (beats OD Yes, beats quiet hours, is per office, is per channel). The route-level test also checks that no opt-in path exists. |
| OD TxtMsgOk No blocks; unknown allowed with badge; fail closed | `consent.test.js` (including the real reader with no OD key → blocked, and valley 7115 vs roland 7115 keyed apart) |
| Quiet hours 20:59/21:00/07:59/08:00, including DST days | `quietHours.test.js` covers 2026-03-08 and 2026-11-01 (23 cases). The gate-level boundary test is in `consent.test.js`. |
| Distinct codes; blocks audited | `tcMessages.test.js` `expectBlock` (each code, its audit row, the row stays a draft, the adapter is never called) |
| Status machine: no send from sent/delivered/…; adapter throw → failed with error preserved | `tcMessages.test.js` |
| Address assembled server-side, never client-supplied | strict body: `toAddress`/`to_address`/`to`/`phone` each return 400 |
| Route guards (tcGuard pattern) | unentitled 403, no tenant 403, bad office 400, hygiene role 403 |
| PHI stays in Postgres; no OD writes; no scheduler | `messagingGuards.test.js` source scan (no OD write verb, no timers or cron, no call-store use, the only `sendMessage` caller is `POST /:id/send`) |
| Messages tab, channel picker disabled with honest copy, consent badge, Send = the approval click | `tests/tc-messages.test.tsx` and the screenshots |
| Follow-up card "Draft message" → tab with a seeded draft | deep-link test (exactly one draft) and a link-href test |

## Test results
- **backend** (`node --check server.js` plus `scripts/shard-runner.mjs`, the CI shape): **3160 tests / 3157 pass / 0 fail / 3 skipped**, 4 shards green. This branch adds 4 new test files with 86 tests.
- **new-dashboard:** `pnpm run check` is clean. `pnpm run test` gives **2440 pass / 164 skipped**, 142 files passed and 27 skipped. This branch adds `tc-messages.test.tsx` (11 tests) and `tc-messages-shots.test.tsx` (4 tests, which only run with `TC_SHOTS=1`).
- **Flakes:** none were hit, so nothing needed re-running in isolation.

## Existing tests changed (called out as required)
1. **`backend/test/orthoScreeningMigration.test.js`**: the item-33 test asserted its two migrations *"are the newest tenant migrations"*. That becomes false for every later slice, so the first migration added after it would turn it red. I reformulated it to pin what it protected at push time: nothing is numbered *inside* item 33's range, and timestamps stay unique. The title was updated to match.
2. **`new-dashboard/tests/tc-ortho-screening.test.tsx`**: the pinned case-view `TABS` list gained `"Messages"`, which is the spec's intended change. The assertion that the screening adds no tab of its own is unchanged.

## Vocabulary-reader inventory
Every new enum lives in **new** tables only. I grepped the repo, excluding `node_modules`, the generated `contract.gen.cjs` and the ignored `dist/`. The readers are:

| Value set | Readers (all created in this slice, except where marked) |
| --- | --- |
| `MessageDirection`, `MessageChannel`, `MessageStatus` (draft/queued/sending/sent/delivered/failed/received) | `shared/tc/messaging.ts`; migration CHECKs; `services/messaging/index.js`; `features/tc/messaging/copy.ts` (`STATUS_LABEL`, `STATUS_TONE`, `CHANNEL_LABEL`, which are total Records); `MessagesTab.tsx`; tests |
| `ConsentState`, `ConsentSource` | `shared/tc/messaging.ts`; migration CHECKs; `consent.js`; `index.js`; `copy.ts` (`consentBadge`); `MessagesTab.tsx`; tests |
| `OdTextConsent` | `shared/tc/messaging.ts`; `consent.js`; `index.js`; `copy.ts`; `MessagesTab.tsx`; tests |
| `MessageBlockCode` (4 codes) and the other refusal codes | `shared/tc/messaging.ts`; `services/messaging/errors.js` (`HTTP_STATUS`, `BLOCK_CODES`); `consent.js` (`BLOCK_MESSAGES`); `index.js`; `copy.ts` (`BLOCK_COPY` is total, `SEND_ERROR_COPY`); `MessagesTab.tsx`; tests |
| audit `resource_type` values `tc_message`, `tc_message.send_attempt`, `tc_message.send_blocked.<code>`, `tc_message.sent`, `tc_message.failed`, `tc_message_inbox`, `tc_message_consent`, `tc_contact_consent` | written by `services/messaging/index.js`; read only by tests. Nothing in the repo filters on `resource_type`. |
| `DisabledReason` + `messaging_provider` | **existing** `features/tc/components/TcShell.tsx` (`DISABLED_COPY` is total, so the new value has its sentence); used by `MessagesTab.tsx` |

`sent` and `failed` also appear in the unrelated `tc_communications` vocabulary (`CommunicationStatus`). These are separate tables and separate enums, and neither one reads the other.

## Screenshots (`docs/screenshots/tc/`, 1280×900, light and dark)
`tcmsg-01-thread`, `tcmsg-02-opted-out`, `tcmsg-03-quiet-hours`, `tcmsg-04-followup-card`: eight PNGs in total.

The standing rule says to use `docs/screenshots/hyg/`. This is a TC slice, so the PNGs went to `tc/` as briefed.

To reproduce: `pnpm exec vite build`, then `TC_SHOTS=1 pnpm exec vitest run tests/tc-messages-shots.test.tsx`, then `node scripts/shoot-tc-messages.mjs`.

Shot 01 is **illustrative**. It shows a `sent` text and a `failed` email side by side so every status chip is visible, but in this slice no message can actually reach either state.

## Conflicts with guardrails (resolved toward the guardrail, not silently)
1. **audit_log.action CHECK (`READ|CREATE|UPDATE|DELETE`).** The spec asks for audit rows "on send attempt, terminal status, blocks". I added no new verb and no migration. The event is recorded in `resource_type`, for example `tc_message.send_blocked.quiet_hours` with `result=UNAUTHORIZED`. This follows the same precedent as `voice.sync.manual`, so no shared-vocabulary change was needed.
2. **The column is `office` in the spec but `office_id` here**, matching every other `tc_*` table and its `('roland','valley')` CHECK.
3. **`template_id` is `text` with no FK.** This slice's templates are code keys (`followup.default`, `nurture.financing`…), not `tc_email_templates` rows. A uuid from that table still fits when item 40 lands.
4. **Disabled adapter: 501 with the row left as a draft, rather than marked `failed`.** The spec says "adapter throw → failed". That is implemented and tested for a *connected* adapter that throws. A channel whose `enabled()` is false is refused *before* anything is attempted, so a TC's draft is not burned into a terminal `failed` state by a missing provider. The stub's `send()` still throws `FEATURE_DISABLED` in case a caller skips `enabled()`.
5. **Follow-up templates never include `talking_point`.** That field is the TC's private note to herself and must never reach a patient's phone. Templates use only the patient's first name and the practice name.

## Open questions for Beau / PM
1. **TxtMsgOk wire format is unmeasured.** I parse `"Yes"/"No"/"??"`, OD's YN enum `1/2/0`, and booleans. Anything else **blocks** (`OD_CONSENT_UNAVAILABLE`). Someone should confirm against a live `/patients/12828` before item 39 enables SMS.
2. **`START` / `UNSTOP`** (an inbound re-opt-in) is not handled: "opt-out beats everything; no override". CTIA expects START to be honoured. That is item 39's decision, and it should be a ruling, not a default.
3. **`tc_cases.nurture_unsubscribed`** already exists and is *not* treated as an email opt-out. Should it be?
4. **Inbound linking.** Inbound rows land unlinked, and linking is a human decision. A "link to case" action is not in this slice.
5. **US numbers only.** `address.js` normalizes 10-digit US numbers, and 11-digit numbers with a leading 1, to E.164. Anything else returns `NO_ADDRESS`.
6. **Quiet hours** are fixed to America/Chicago for both offices. A practice outside Central would need a per-office zone in the office registry.

## Ops note
`C:\Users\beau\carein cursor dashboard\.git\packed-refs.lock` (0 bytes, dated 2026-10-07) is stale. Every commit printed a lock warning, but each commit and ref update succeeded. I left the file untouched because it is in the PROD folder. Beau may want to delete it.

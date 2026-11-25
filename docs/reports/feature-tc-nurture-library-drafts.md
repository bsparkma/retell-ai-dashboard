# EL-2 — Library drafts inside nurture

Branch `feature/tc-nurture-library-drafts`, off `origin/develop` @ `03cf64e` (contains PR #358). RED lane: a tenant migration, the shared contract and the nurture generator. **Not merged; auto-merge not armed.**

## What it does

A nurture enrollment can now carry a library **procedure** and **tone**. When it does, the nightly generator follows the patient email library's sequence for that track. It writes one email draft per step, composed by `compose()` from the office's **saved** wording answers and merged with the patient's first name, the office's name and phone, and a sender line. When an enrollment carries neither, the item-47 hand-written touches run exactly as before. The existing generator and route suites pass unedited.

Review-then-send is unchanged. The generator writes drafts only, `messaging.sendMessage` is still the only send path, and nothing under `backend/services/messaging/` changed. `tc_nurture_enabled`, the `TC_NURTURE_ENABLED` break-glass and the hard caps are untouched. The slice adds no Open Dental access, no AI calls and no new secrets.

## Migration

`backend/migrations-tenant/1795500000000_tc_nurture_library.js`

- `tc_nurture_enrollments` gains two nullable text columns: `library_procedure_id` and `library_variant`.
- One inline CHECK. No grants (it is an ALTER on a table the app role already writes). `down()` drops the CHECK and both columns.
- **Re-check at push:** the newest tenant migration on `origin/develop` is still `1795400000000_tc_email_library_profile.js`, and no open PR into develop carries a tenant migration at `1795…` or above. The number stands.

**Deviation from the brief: the CHECK literal.** The brief's literal does not refuse a procedure with no tone:

```
(library_procedure_id IS NULL AND library_variant IS NULL)
  OR (library_procedure_id IS NOT NULL AND library_variant IN ('A','B','C'))
```

With `('crown', NULL)`, `library_variant IN (…)` evaluates to NULL, so the whole expression is NULL, and a CHECK that evaluates to NULL **passes**. I proved this on Postgres 16: a temporary table with the brief's literal accepted `('crown', NULL)`. This is the same hole CO-3 hit. The shipped CHECK adds `library_variant IS NOT NULL`. The verifier inserts exactly that row and requires a `23514` refusal.

## Changes by area

**Contract** (`new-dashboard/shared/tc/nurture.ts`, bundle regenerated with the pinned esbuild)

- `NurtureEnrollBody`:
  - adds optional `procedure_id` (max 60) and `variant` (`A|B|C`)
  - a refine enforces both-or-neither
- `TcNurtureEnrollment`:
  - adds `libraryProcedureId` and `libraryVariant`
  - **addition beyond the brief:** `stepCount`, server-computed. The strip's "N of M drafted" used the hand-written preset's length, which is wrong for a library enrollment.
- `NurtureTrackAvailability` adds `libraryAvailable` and `libraryBlockedReason`.
- New exports:
  - `LIBRARY_SEQUENCE_TRACKS`, `isLibrarySequenceTrack`
  - `NurtureLibraryVariant`
  - `libraryTemplateId` / `parseLibraryTemplateId`
  - `scheduleCapViolations`
- **Track key note:** the nurture track key is `no_show_recovery`, not `no_show`. Each of the four keys is also the **id** of its library sequence, so lookup is by id. Two sequences say `track: "no_show"`, and `cancel_recovery` is out of scope, so the lookup never reads that field.
- **Cap reuse:** the three hard-cap checks were factored out of `presetViolations` as shared helpers. Preset output is byte-identical, and the library sequences use the same code. Library sequences may start on day 0, which presets may not.

**Library** (`backend/services/tcEmailLibrary/index.js`)

- `LIBRARY_CLINICALLY_APPROVED = true`.
- `sequenceFor(track, procedureId?)` returns `[{ stage, day }]`. With a procedure, it drops the stages that procedure's block skips:
  - `recare` and `new_patient` skip `cost_of_waiting`
  - `retainer` and `sealants` skip `objection_fear`

  The skip list is static source data, so "one email per step" always holds.
- `renderLibraryEmail(...)` returns `{ subject, preheader, bodyText, emailBlocks }` via `composeOne`. Any `{{token}}` left after the merge throws `LibraryRenderError('UNRESOLVED_MERGE', token)`.
- `emailBlocks`: one escaped `text` block per paragraph, a run of `- ` lines becomes a `<ul>`, no button block.
- `savedAnswersFor(db, office)` reads the profile, strips retired keys and re-validates. The strip helper moved here, and the email library route now uses it.
- The require-time `assertLibrarySequencesWithinCaps()` checks the four sequences and every procedure's version of each.

**Generator** (`backend/services/tcNurture/generator.js`), via a new `store.stepsOf(row)`

- Library rows render through `renderLibraryEmail` on channel `email`.
- `template_id` = `library.<procedure>.<stage>.<variant>`, `touch_key` = the stage id; `email_preheader` and `email_blocks` are set.
- Claim, caps, consent hint, events and counts are identical to hand-written enrollments, with no audit rows.
- A throw (`UNRESOLVED_MERGE`, stale answers) rolls the transaction back: no draft, no advance, counted in `errors`.
- **Sender line:** the case's `assigned_tc`, which is how the TC app displays it (the raw stored string). It is used only when it reads as a person's name. `assigned_tc` is an SSO **email** when a route stamped it, and a staff email must not sign a patient email. Otherwise the line is "The team at <office name>".

**Route** (`backend/routes/tc/nurture.js`)

- POST refusals, in order, after the ordinary ones:

  | Code | Status |
  | --- | --- |
  | `LIBRARY_TRACK_UNSUPPORTED` | 400 |
  | `LIBRARY_NOT_APPROVED` | 409 |
  | `EMAIL_LIBRARY_SAVED_ANSWERS_STALE` (added: saved wording that no longer validates) | 409 |
  | `LIBRARY_PROCEDURE_UNKNOWN` (also when the office has switched the procedure off) | 400 |
  | `LIBRARY_OFFICE_IDENTITY_INCOMPLETE` (body carries `missing: [...]`) | 409 |
  | `NO_ADDRESS` (no email on the case) | 409 |

- The intensity is recorded but not applied.
- The enrollment event text names the procedure and tone.
- `GET /enrollments` computes `libraryAvailable` and its reason per track. Resume uses `stepsOf`.
- **Note on `LIBRARY_TRACK_UNSUPPORTED`:** all four `NurtureTrackKey` values have sequences, so this code is unreachable today; it guards a fifth track. The route asks `library.isLibraryTrack()`, so the test stubs that and exercises the refusal on the real assembled route. A test also pins that the four keys equal `LIBRARY_SEQUENCE_TRACKS`.

**Carry-forwards from the EL-1 review**

- The free-text validator refuses U+200B–U+200F, U+202A–U+202E, U+2066–U+2069 and U+FEFF with `EMAIL_LIBRARY_TEXT_FORBIDDEN_CHARACTER`. Links refuse them too. One edge case: a leading or trailing U+FEFF is removed by the validator's existing `trim()` (JS treats it as whitespace), so it is never stored. Inside the text it is refused.
- The `/admin` "Patient email library" card moved into the Treatment Coordinator block, and the separate "Patient emails" block is gone.
- The draft banner is replaced by one neutral line: "Library v1.3.0, doctor-reviewed." If the flag is ever false again, the line says "not doctor-reviewed: nurture campaigns cannot draft from it yet."

**UI**

- **Start Nurture:** a "Use the patient email library for…" section with a procedure dropdown (office catalog, grouped by category) and a tone selector (Warm / Direct / Educational, default Warm).
  - Each track is disabled with the server's `libraryBlockedReason` when it cannot start from the library.
  - When no track can, the section is disabled and says why.
  - Hand-written starts still call `startNurture` with exactly three arguments.
- **Campaign strip:** "Library: Dental Crown · Warm · 2 of 10 drafted".
- **Outbox:** each library draft shows "Library: <procedure> · <tone>" and the stage label (for example "Why it matters"). The catalog is fetched only when a library draft is on screen.
- **Screenshots** in `docs/screenshots/tc/`, light and dark each:
  - `tcnurture-06-library-picker`
  - `tcnurture-07-library-blocked`
  - `tcnurture-08-library-chip`
  - `tcnurture-09-library-outbox`

## Files changed

**Backend**

- `.github/workflows/build-test.yml` — new CI step for the verifier
- `backend/migrations-tenant/1795500000000_tc_nurture_library.js` (new)
- `backend/routes/tc/emailLibrary.js` — uses the shared retired-key strip
- `backend/routes/tc/nurture.js`
- `backend/scripts/tc-nurture-library-verify-queries.js` (new)
- `backend/services/tcEmailLibrary/index.js`
- `backend/services/tcNurture/generator.js`
- `backend/services/tcNurture/store.js`
- `backend/tc/contract.gen.cjs` — regenerated

**Backend tests**

- New:
  - `backend/services/tcNurture/tcNurtureLibraryGenerator.test.js`
  - `backend/routes/tc/tcNurtureLibrary.test.js`
  - `backend/test/tcNurtureLibraryMigration.test.js`
  - `backend/test/tcEmailLibraryBidi.test.js`
- Edited: `backend/services/tcEmailLibrary/tcEmailLibrary.test.js`, `backend/routes/tc/tcEmailLibrary.route.test.js`

**Dashboard**

- `new-dashboard/shared/tc/nurture.ts`
- `new-dashboard/shared/tc/emailLibrary.ts` — validator, and the comment on the approved flag
- `client/src/features/tc/nurture/NurtureCampaignBar.tsx`
- `client/src/features/tc/nurture/NurtureOutbox.tsx`
- `client/src/features/tc/nurture/campaignApi.ts`
- `client/src/features/tc/nurture/campaignCopy.ts`
- `client/src/features/tc/nurture/useLibraryCatalog.ts` (new)
- `client/src/pages/Admin.tsx`
- `client/src/pages/AdminPatientEmails.tsx`
- `client/src/pages/admin/settingsHub.ts`

**Dashboard tests**

- New: `tests/tc-nurture-library.test.tsx`, `tests/tc-nurture-library-shots.test.tsx`
- Edited: `tests/sc1-settings-hub.test.tsx`, `tests/admin-patient-emails.test.tsx`

**Docs:** 8 PNGs in `docs/screenshots/tc/` and this report.

No file was deleted. One local function was removed after a usage check: `withoutRetiredKeys` in `routes/tc/emailLibrary.js`, which is now the shared export. The `services/tcNurture/` file-list pin is respected: no new non-test file was added there.

## Every `touch_key` / `template_id` reader

**`touch_key`**

| Reader | What it does with the value |
| --- | --- |
| `migrations-tenant/1791100000000_tc_nurture.js` | The column, plus the CHECK `touch_key IS NULL OR enrollment_id IS NOT NULL`. A library draft has an enrollment, so the CHECK holds. |
| `services/tcNurture/engine.js` | `renderTouch` for hand-written rows only. |
| `services/tcNurture/generator.js` | Writes it: a hand-written touch key, or a stage id. |
| `services/tcNurture/store.js` | Reads it in `touchesOf`, for cap timing only. |
| `routes/tc/nurture.js` | The outbox SELECT. It passes `touchKey` through; max 20, and the longest stage in scope is `no_show_recovery`, at 16. |
| `shared/tc/nurture.ts` | `NurtureOutboxDraft.touchKey` (max 20) and `nextTouchKey` (max 20). |
| `client/.../NurtureOutbox.tsx` | Shows `touchKey` for hand-written drafts and the stage label for library drafts. |

**`template_id` on `tc_messages`** (other `template_id`s, such as `tc_email_templates` and `tc_communications`, are separate tables and never see a `library.*` value)

| Reader | What it does with the value |
| --- | --- |
| `services/messaging/index.js` | `toMessage` passes it through (`TcMessage.templateId`, max 120; the longest library id is about 46 characters). `sendMessage` forwards it to the adapter. |
| `services/messaging/adapters/*` | No adapter reads `templateId`; it is only the typed field in `adapters/index.js`. |
| `services/messaging/templates.js` | Keys for its own `nurture.*` follow-up templates. It never parses stored ids. |
| `config/tcNurture.js` / `shared/tc/nurture.ts` | `nurtureTemplateId` and `libraryTemplateId` / `parseLibraryTemplateId`. |
| `client/.../NurtureOutbox.tsx` | `parseLibraryTemplateId`, to label library drafts. |
| `client/.../MessagesTab.tsx`, `TcTemplates.tsx`, `TcCommunications.tsx`, `features/tc/api.ts` | `tc_email_templates` UUIDs and `tc_communications` usage stats. The nurture send path does not write `tc_communications`. |
| Funnel, reports | Read neither column. |

## Edited existing tests (before → after)

All four files were added by #356, except `sc1-settings-hub.test.tsx`, which is the pinned `/admin` hub test the brief names.

1. **`backend/services/tcEmailLibrary/tcEmailLibrary.test.js`**
   - Test title: `'A: the library is not clinically approved'` → `'A: the library is clinically approved (v1.3.0, the doctor-reviewed wording)'`.
   - `assert.equal(library.LIBRARY_CLINICALLY_APPROVED, false)` → `true`.
   - `assert.equal(cat.clinicallyApproved, false)` → `true`.
   - The header line changed to match.
2. **`backend/routes/tc/tcEmailLibrary.route.test.js`**
   - Test title: `'… follows services_off, and is unapproved'` → `'… and is approved'`.
   - `before.body.clinicallyApproved, false` → `true`.
   - `r.body.clinicallyApproved, false` → `true`.
   - The header line changed to match.
3. **`new-dashboard/tests/admin-patient-emails.test.tsx`**
   - "shows the draft banner, …" asserted the amber banner text. It is now "shows the library status, …" and asserts the banner is **absent** and that the status line reads "not doctor-reviewed: nurture campaigns cannot draft from it yet." (its fixture is unapproved).
   - "no banner once … approved" keeps its banner-null assertion and adds a check that the status line equals `Library v<version>, doctor-reviewed.`
   - The header line changed to match.
4. **`new-dashboard/tests/sc1-settings-hub.test.tsx`**
   - `hrefsIn("admin-module-tc")` was `["/admin/tc/settings"]` and is now `["/admin/tc/settings", "/admin/patient-emails"]`.
   - Adds: the `admin-module-tc-email-library` block is gone.

No other existing test was edited. All existing nurture tests pass untouched, including:

- `tcNurtureGenerator.test.js`, whose hand-written fixtures are byte-identical in behavior
- `tcNurture.test.js`
- `tc-nurture-campaigns.test.tsx`, which still asserts the three-argument `startNurture` call

## Test and typecheck results

| Gate | Result |
| --- | --- |
| Backend `node --check server.js` | OK |
| Backend `node scripts/shard-runner.mjs` | 4 shards, **5200 tests: 5197 pass, 0 fail, 3 skipped**. No Node-22 deserialize flake this run. |
| Dashboard `pnpm run check` (`tsc --noEmit`) | **Clean** |
| Dashboard `pnpm run test` | **236 files passed, 42 skipped; 3405 tests passed, 260 skipped, 0 failed** (includes `tc-contract-bundle` byte-compare) |

**Real-SQL verifier** (`scripts/tc-nurture-library-verify-queries.js`), run locally against a throwaway `postgres:16` with the CI role layout and every control and tenant migration applied. It is now a CI step. It passed all five Part A checks plus a real `down()` → `up()`:

1. Store insert with a procedure and tone, read back through the contract.
2. A row with no library columns is unaffected (the item-47 insert shape still works).
3. The CHECK refuses procedure-without-tone, tone-without-procedure, tone `D` and tone `a`.
4. **One real generator pass** drafts exactly one library email: `library.crown.tp_recap.B`, `touch_key` `tp_recap`, preheader set, jsonb text blocks, no `{{`. A second pass drafts nothing.
5. As `carein_app`: insert and the claim UPDATE work.

The real schema caught a mistake in my own verifier fixture (`status 'stopped'` needs a `stop_reason`), which the fake DB would not have caught. The EL-1 verifier still passes; its down/up now correctly skips because it is no longer the newest migration.

The brief's specific test asks are all covered:

- [x] Generator: one draft whose subject is exactly what `compose()` produces for the office's saved answers.
- [x] `template_id` `library.crown.tp_recap.A`, `touch_key` `tp_recap`, preheader set.
- [x] The send tripwire throws and is never reached; the OD and AI import scans cover `tcNurture` and `tcEmailLibrary`.
- [x] A second pass writes no second draft.
- [x] `UNRESOLVED_MERGE`: no draft, no advance, `errors` = 1.
- [x] The boot cap check passes, and fixtures that break the 48h gap or the 3-in-7 rule throw.
- [x] Every route refusal is tested on the real assembled route, including procedure and tone arriving separately.
- [x] Office comes from the case; `?office=` is assertion-only.
- [x] The real-SQL migration test.

## Staging test plan (8 steps)

Use only the designated test patients: roland **Test 2, Stedi (PatNum 12827)** and valley **Stedi TestValley (PatNum 7115)**. Each case's email is Beau's own address. `tc_nurture_enabled` stays as it is; switch it on for staging offices only, and only if Beau chooses.

1. On `/admin`, confirm "Patient email library" sits inside the **Treatment Coordinator** block. Open it and confirm "Library v1.3.0, doctor-reviewed." with no amber banner.
2. On the roland Test 2, Stedi case, set the case email to Beau's address. Open **Start Nurture** and tick "Use the patient email library for…".
   - Expect: the procedures grouped by category, and the tone defaulting to Warm.
3. Clear roland's practice phone in Practice info & email identity, then reopen the picker.
   - Expect: the section disabled with "Set the office's office phone…".
   - Restore the phone.
4. Choose **Dental Crown** and **Direct**, then pick **Warm Follow-Up**.
   - Expect: the strip reads "Library: Dental Crown · Direct · 0 of 10 drafted".
   - Expect: the timeline event names "Dental Crown, short and direct".
5. Run the nurture pass for roland (the next 05:00 run, or the admin trigger if one is used for staging).
   - Expect: the Nurture Outbox shows one email draft labelled "Library: Dental Crown · Direct · Treatment recap", signed with the assigned TC's name or "The team at …".
   - Expect: no `{{` anywhere, and **nothing sent**.
6. **Approve** that one draft and confirm it arrives in Beau's inbox through the normal send path, with the consent and quiet-hours checks applying.
   - Then confirm the strip reads "1 of 10 drafted".
7. On the valley Stedi TestValley (7115) case, under **?office=roland**, try to start a library campaign.
   - Expect: 409 `OFFICE_MISMATCH`.
   - Switch to valley and start **Reactivation** with **Dental Implant** and **Educational**. Expect 5 emails, the first due today.
8. **Stop** both campaigns with a reason. Confirm no further drafts appear on the next pass. Skip any drafts still waiting.

## Notes for the reviewer

- `C:\Users\beau\carein cursor dashboard\.git\packed-refs.lock` is an empty, **5-day-old** stale lock (2026-11-19 12:57). Git prints a warning on ref operations, but commits and branch refs were written correctly. I left it in place because it is in the shared repository; delete it once no git process is running.
- A library enrollment whose office later switches its procedure off makes `composeOne` refuse. The generator counts that as an error every night and drafts nothing until someone stops the enrollment. This is honest but noisy, and a candidate follow-up: stop such enrollments with a reason.

# Provider directory + pre-auth "Start case" — NEEDS REVIEW (RED)

**Branch:** `feature/provider-directory`, cut from `origin/develop` at `1474aec` (after #265).
**Lane:** RED, for these reasons:
- **migration** `1792700000000` (one new table);
- **shared contract changes**: a new `shared/tc/providers.ts`, and `referringProvider` added to the two
  referral field-edit shapes. `backend/tc/contract.gen.cjs` was regenerated with the pinned toolchain,
  and the byte-compare test passes;
- **a new Open Dental read**: the import is one read-only `GET /providers`;
- **a new case-creation entry point** (pre-auth → TC case).

**Pushed for review. Not merged.** All three parts (A, B, C) shipped. Part C did not need a design
decision (see C).

---

## Pre-existing test edits, for ratification

| File | Was | Now | Why |
|---|---|---|---|
| `new-dashboard/tests/tc-settings.test.tsx` (`SECTION_LABELS`) | 9 nav labels ending at "Notifications" | adds `"Providers"` | The new Settings section is shown to everyone on the TC surface. The test pins the nav list, so the new item has to be added. |
| `backend/routes/hyg/hygReferral.test.js` (its `CompositeDb`) | sends SQL matching `tc_(referral\|cases)` to the TC store | `tc_(referral\|cases\|provider_directory)` | This is the harness's table router. Without it, the new hygiene read lands in the hyg fake and throws. No assertion changed. |

No other existing test was edited. `tc-preauth-od-link.test.tsx` passes unedited, because the
Doctor field keeps its wrapping `<label>`.

---

## A. Provider directory (app-owned)

**Storage.** A new table, `tc_provider_directory`, in the tenant DB next to `tc_referral_directory`.
Each row has `provider_id`, `office_id`, `name` (1–200 characters), `credential_suffix` (up to 40),
`active`, and `od_prov_num`. `od_prov_num` is set only on imported rows. It is UNIQUE per office and
serves as the import's merge key and its race arbiter.
- **The app role gets `SELECT, INSERT, UPDATE`, with no `DELETE`.** "Never deletes" is enforced by the
  database grant, so it doesn't depend on someone remembering it in the next route. There is also no
  DELETE route.
- **Nothing references the table.** Referrals and pre-auths keep storing text, so deactivating a
  provider never changes an existing record.

**Routes** (`/api/tc/providers`, mounted with `tc.full`):

| Route | Who | What |
|---|---|---|
| `GET /` (`?includeInactive=true`) | tc.full | The list, plus `canEdit` for the caller |
| `POST /` | admin + office | Add a provider by hand |
| `PUT /:id` | admin + office | Change name, suffix or active |
| `POST /import` | admin + office | Import from Open Dental |

- **Strict bodies.** A smuggled `office`, `officeId`, `odProvNum` or `providerId` is a 400 and nothing
  is stored. The import body must be `{}`.
- **Audit.** Every add, edit and imported row writes one CREATE or UPDATE row on
  `tc_provider_directory`, inside the transaction. A list read isn't audited (it isn't PHI), which is
  the specialist directory's rule.

**The import** (`services/tc/providerImport.js`, with pure planning):
- **The read.** One read of **this office's** Open Dental, through
  `assertOfficeMatch(office, getOdOffice(office))`, re-asserted on every call. It is GET-only by
  construction, and it runs before any transaction opens.
- **The merge.**
  - It adds new ProvNums as active rows.
  - For rows already linked to a ProvNum, it updates the name (and the suffix only when Open Dental has
    one, so an empty OD suffix never blanks one staff typed).
  - It never deletes, never deactivates, never reactivates, and never touches a row added by hand.
- **Honest failures.**
  - Open Dental down → 502 `OD_READ_FAILED`.
  - Office not connected or not keyed → 503 `OFFICE_NOT_CONNECTED`.
  - A list that doesn't end inside 10 pages is refused rather than half-merged.
  - Two imports racing → the loser rolls back whole and gets 409 `IMPORT_RACE`.

**Settings → Providers.** The section is visible to everyone on the TC surface. Admin and office get
Add, Edit and "Import from Open Dental"; everyone else sees the list read-only. After an import the
page says what it did, for example: "2 added, 1 updated, 3 already up to date. Left out: 1 hidden in
Open Dental, 2 hygienists."

**Read seams for the pickers.** These mirror the specialist directory exactly:
- TC: `GET /api/tc/providers`;
- doctor: `GET /api/tc/referrals/signoff/providers` (active only);
- hygienist at the chair: `GET /api/hyg/visit/:aptNum/provider-directory` (active only, same gate as
  `referral-directory`).

## B. The pickers

There is one component, `ProviderPicker`. It shows the office's active providers plus **"Other…"**,
which keeps today's free text. Its behavior:
- **What gets saved.** A pick writes the display name (`"Jane Smith, DDS"`) into the existing text field.
- **Values not in the list.** A value that isn't in the list (typed earlier, or a provider deactivated
  since) opens as Other with the text kept.
- **Empty directory.** The field is free text, with "add them in Settings → Providers".
- **List unavailable.** If the list can't be read, the field is free text and the form is never blocked.
- **Nothing auto-selects**, even when there is only one provider.

Wired into:
- **Referral create**, on all four surfaces: TC case/checkout, hub "New referral", call detail, and
  hygiene chairside.
- **Hub edit and sign-off edit.** I had to **add `referringProvider` to `TcReferralFieldsEdit` /
  `TcReferralDoctorEdit`**, because neither surface could edit it before; it was editable only on the
  draft PUT. The history line names the change ("Changed referring provider"). Every reader of the two
  shapes goes through `editFieldsInTx → updateFields`, including reopen-with-edit, and that path now
  carries the column.
- **Pre-auth "Doctor".** It is still required, and "Choose…" doesn't satisfy it.

## C. Pre-auth → pipeline: the existing pattern fit, so it's built

**The check.** Three intakes already create or attach cases: the voice handoff, the Opportunities
claim, and the checkout intake. All three use one rule, `intakeFromCall.findOpenCase`: if the patient
has an open case in this office, **attach** to it (a timeline note, no second case); otherwise
**create** a `pending_tc` case. That already answers the "open case exists" question, so no new design
decision was needed.

**`POST /api/tc/preauth/:id/start-case`:**
- **Body.** The body is `{}` (strict). A PatNum, office, name or case id in it is a 400.
- **Where the patient comes from.** PatNum, name, phone, email and doctor are all read from the
  **pre-auth row**, office-scoped. The new case's `doctorName` is the pre-auth's doctor.
- **Create.** If there's no open case, it creates a `pending_tc` case assigned to the caller, with
  event "Case started from a treatment pre-authorization (Delta Dental)".
- **Attach.** If there is one, it adds a `note_added` event on that case.
- **The link and the arbiter.** It links `tc_preauth_cases.case_id`, written only where it is still
  NULL, which makes it the race arbiter: the losing click's case rolls back.
- **Refusals.**
  - No Open Dental patient linked → 409 `NO_OD_PATIENT` ("link the patient first"). Without a PatNum
    there's no honest way to find the open case.
  - Already linked → 409 `PREAUTH_ALREADY_LINKED`, with the case id.
  - Another office's pre-auth → 404.
- **Other properties.** Audited (pre-auth UPDATE, plus case CREATE or UPDATE). Postgres-only: no OD
  call.
- **UI.** The pre-auth card menu shows "Start case" while unlinked and "Open case" once linked. The
  toast carries an Open case action.

---

## Decisions for you to rule on

1. **Who edits the list.** I used **`tc.notification_defaults` (admin + office)** rather than adding a
   permission. Email identity (R5c) set the precedent of using it for an office-level Settings write.
   If you'd rather have a named action (for example `tc.provider_directory`), it's a small rename in
   `providers.js` and the client permission list.
2. **Import leaves out hidden providers and hygienists.** Hidden means they no longer practise there,
   and hygienists neither refer nor sign a pre-auth. Both are counted on screen. Staff can still add
   any of them by hand. Say the word if hygienists should come in.
3. **Start case requires a linked PatNum.** The alternative is a name-only case with no attach-or-create
   check, which could make a duplicate case.
4. **New-case defaults** match Opportunities: `category: single_tooth`, `urgency: medium`,
   `referralSource: existing_patient`. A pre-auth's type (treatment/perio/manual) doesn't map onto a
   case category.

## Pre-existing issue found (not fixed here)

- `tc_preauth_cases.case_id` has a foreign key to `tc_cases(case_id)` **alone**, not
  `(office_id, case_id)`. `PUT /api/tc/preauth/:id` also accepts a client-typed `caseId` (the "Linked
  case ID" box). Together, a pre-auth can be hand-linked to **another office's case**. Start case is not
  affected: it only ever writes a case it found or made in the request's office. The fix is a composite
  FK plus validating the PUT's `caseId`; I'd make that its own slice.
- Minor: `tcReferralHub.test.js`'s `realTransactions` restores only the tables its BEGIN snapshot
  named. A table first created inside the transaction doesn't roll back in that harness. The new
  start-case race test restores every live table instead.

## Verification

- **Backend.** `node --test` ran 4065 tests: 4064 passed, plus 1 known runner flake
  (`onDemandTranscription.test.js`, "Unable to deserialize cloned data", which is the Node 22 parent
  decode bug; it passes 24/24 in isolation). New: `tcProviders.test.js` (13),
  `tcPreauthStartCase.test.js` (6), `providerDirectoryMigration.test.js` (6), and 1 in
  `hygReferral.test.js`. `node --check server.js` is clean.
- **Dashboard.** `pnpm run check` (tsc) is clean, and `pnpm run test` passed 2838 (204 skipped)
  including the contract-bundle byte-compare. New: `provider-directory.test.tsx` (17).
- **Not verified live.** The import's field names (`ProvNum`, `FName`, `LName`, `Suffix`, `Abbr`,
  `IsHidden`, `IsHygienist`, booleans as `true` or `"true"`) follow the OD provider schema and the
  fields existing code already reads. **`Suffix` is read here for the first time.** The first staging
  import should be checked against a real `/providers` response. The migration hasn't been replayed
  against Postgres locally; CI's ephemeral-Postgres step covers it.

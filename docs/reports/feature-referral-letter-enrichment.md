# Referral letter enrichment — NEEDS REVIEW (RED)

**Branch:** `feature/referral-letter-enrichment`, cut from `origin/develop` at `ed88bc3` (after #264).
**Lane:** RED, for three reasons:
- **migration** `1792600000000`;
- **shared contract fields**, with `backend/tc/contract.gen.cjs` regenerated using the pinned
  toolchain (the byte-compare test passes);
- **an extra Open Dental read** (read-only) in the send path.

**Pushed for review. Not merged.**

---

## Pre-existing test edits, for ratification

There are three, all in `backend/routes/tc/tcReferralLinks.test.js`. **None of them is a copy
change.** Each pins something that part A changes on purpose, so I'm flagging them rather than
pretending they were copy.

| Line (develop) | Test | Was | Now | Why |
|---|---|---|---|---|
| 342 | "N: the template — X-rays only when files went…" | source regex `notifyPatient(req, { office, row, entry, withFiles: packed.attached > 0 })` | the same regex with `, contact` added | The notice now reuses the letter's contact read, so the call passes it along. What the pin protects (X-rays only when files went WITH the letter) is unchanged |
| 383 | "P: switch OFF … no Open Dental lookup …" | `odCalls.length === 0` | exactly `[['apiGetRaw', '/patients/12827']]` | The LETTER now reads the contact (part A). The switched-off notice still adds no lookup and writes no `patient_email_lookup` audit row (unchanged assertion below it) |
| 536 | "N: a letter that ends in send_conflict sends no notice…" | `odCalls.length === 0` | exactly `[['apiGetRaw', '/patients/12827']]` | Same: the letter's read happens before it goes out. The notice adds no second lookup |

The R5b template pins, the "no clinical field ever reaches the patient email" pin, and
`tcReferralSend.test.js`'s letter-text pin (it still expects `DOB_LINE`, because that harness has
no Open Dental connection, so the letter honestly falls back) all pass **unedited**.

---

## A. The patient contact block (specialist letter only)

**The read** (`services/tc/referralPatientContact.js`):
- **New function.** `patientContactFor(office, patNum)` makes **one GET** of `/patients/{PatNum}`
  through `assertOfficeMatch(office, getOdOffice(office))`, read only.
- **Outcomes, as values (never a throw):**
  - `found`, with `phone` (cell, then home, then work), `email` (normalized and shape-checked) and
    `birthdate` (`YYYY-MM-DD`; Open Dental's `0001-01-01` counts as none). Each is null when not on
    file.
  - `not_found`, `not_connected` or `unreadable`.
- **R5b compatibility.** R5b's `patientEmailFor` is now this same read, narrowed to the address
  (`emailOf`).

**The send** (`routes/tc/referralSend.js`, still the sole gateway):
- **When.** After the claim and before the letter is composed, `letterContact` reads the contact
  **once per send**.
- **Audit.** The read is audited first, as a READ of `tc_referral.letter_contact_lookup` with no
  data in the row. If the audit write fails, the read is not made.
- **Bad PatNum.** A PatNum that isn't a safe integer is never read.
- **Reuse.** The patient notice reuses this read for its address, so a send makes one GET, not two.
- **Unchanged.** The notice's own `patient_email_lookup` audit row is still written as before; it
  records the notice's use of the address.

**The letter** (`routes/tc/referralLetterText.js`):
- **DOB slot.** It now fills from the read: "Date of birth: January 1, 1980".
- **New section,** after the patient line:
  ```
  Patient contact:
  Phone: (918) 555-0142
  Email: …
  ```
- **Missing fields** read **"not on file"**.
- **No contact read at all** (Open Dental not connected or not answering, the patient not found,
  or the audit failed): the DOB line keeps `DOB_LINE` ("available from our office on request"),
  and the section says "Patient contact: not available from our records when this letter was
  sent. Please call our office…". The letter still goes; nothing is invented.
- **Forms.** The letter has no PDF form; it is HTML plus plain text, both rendered from the same
  text, so the block is in both.

**Where it never goes** (each pinned by a new test):
- the patient email;
- any event note;
- any audit row;
- the link tokens.

The public link pages and their routes are unchanged (`git diff` against develop on
`referralLinkWebhooks.js` and `emailWebhooks.js` is empty).

## B. The reason in plain words (patient email only)

- **Migration** `1792600000000_tc_referral_patient_reason`:
  - `tc_referrals.patient_reason text NULL`, plus the inline CHECK
    `patient_reason IS NULL OR char_length(patient_reason) <= 200`;
  - no backfill; down drops the CHECK and then the column.
  - **Rehearsed on a throwaway Postgres 16:** up / down / up all clean, the column nullable, the
    CHECK as written, and `carein_app` able to UPDATE it through its table grant. The container was
    removed afterwards.
- **Contract:**
  - `TcReferral.patientReason` (nullable, optional);
  - `patientReason` in the shared edit fields, so it's on both `PATCH /:id/fields` (staff, hub) and
    `PATCH /signoff/:id/fields` (doctor), trimmed and capped at
    `TC_REFERRAL_PATIENT_REASON_MAX = 200`;
  - `referralEditSummary` names it "reason in plain words".
- **Edit path:** a blank value is stored as null, as a blank doctor's note is. The history note
  says "Changed reason in plain words" and never the words themselves. No transition logic changed.
- **Patient email:** `composePatientNotice` takes `patientReason`, a single line with any trailing
  full stop removed. When it's blank, the "a specialist consultation" fallback stays. The specialist
  letter never uses it.
- **UI:**
  - The shared fields form gets a "Reason in plain words (for the patient's email)" field on both
    the hub and the sign-off surface. Its helper text explains the fallback and that the clinical
    reason is never sent to the patient.
  - The hub detail and the sign-off card show it as "For the patient".

## Guardrails

- **Open Dental:** reads only; the patched client in the tests throws on any write.
- **`referralSend.js`** stays the only send gateway. The guard that it never names
  `getOdOffice` / `apiGetRaw` passes.
- **No public-endpoint changes.**
- **Tests mock both Open Dental and ACS.**
- **TypeScript strict;** `tsc --noEmit` clean.
- **Fixtures** are roland 12827 "Test 2, Stedi", plus synthetic phone and date-of-birth values.

## Tests (new files)

**`backend/routes/tc/tcReferralLetterEnrichment.test.js`, 15 tests.**

Part A:
- The DOB and contact block come from one roland GET, and the read is audited.
- The values never reach the patient email, an event note, an audit row or a token.
- Missing fields read "not on file", and the 0001 date is never shown.
- The home phone is used as a fallback, and a malformed email reads "not on file".
- Not connected, unreadable and not-found each produce the honest unavailable copy, while the
  letter still goes.
- A failed audit means no read is made.
- Every outcome of the module itself.

Part B:
- Written at sign-off, the plain reason replaces the fallback, and no clinical text appears.
- Blank keeps the fallback.
- The letter never carries it.
- A hub staff edit names the field without its words and stores blank as null.
- A doctor edit works, and over 200 characters is a 400.
- The composer, tested directly.

**`backend/test/referralPatientReasonMigration.test.js`, 4 tests:**
- nullable, with no backfill;
- the CHECK equals the contract's cap;
- down;
- numbered above `1792500000000`, unique and in order.

**`new-dashboard/tests/referral-plain-reason.test.tsx`, 6 tests:**
- the contract and the history label;
- `changedFields`;
- the form on both surfaces;
- clearing sends null.

## Verification

| Gate | Result |
|---|---|
| `pnpm run check` | clean |
| Dashboard `vitest run` | 217 files: 183 passed, 34 skipped. 3025 tests: 2821 passed, 204 skipped, **0 failed** (includes the contract-bundle byte compare) |
| `node --check server.js` | OK |
| Backend `node --test` | 4039 tests: 4035 pass, 3 skipped, 1 fail. The failure is `services/onDemandTranscription.test.js` with "Unable to deserialize cloned data", the known Node 22 runner flake. That file is untouched and passes 24/24 alone |
| Migration rehearsal (Postgres 16) | up / down / up clean |

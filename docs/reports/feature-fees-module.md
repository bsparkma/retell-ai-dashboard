# Fee Schedule module — Slice 1: scaffold, parse, preview

**Branch** `feature/fees-module` (off `origin/develop`) · **Worktree**
`C:\Users\beau\carein-wt\fees-module` · **Status** dark, read-only, no Open
Dental access of any kind.

Slice 1 answers one question: *what does this payer's fee schedule file
actually say?* An office uploads a PDF or CSV, it is parsed, and the result is
stored and shown back. Nothing is posted anywhere. Posting a reviewed schedule
into Open Dental — through the office-keyed cloud API, never MySQL — is a later
slice with its own approval shape.

---

## 1. What shipped

| Piece | Path |
| --- | --- |
| Module registration | `backend/config/modules.js`, `backend/migrations/1788700000000_module_fees.js` |
| Permissions | `backend/config/permissions.js` (`fees.read`, `fees.write`) |
| Mount | `backend/server.js` → `/api/fees` |
| Tenant tables | `backend/migrations-tenant/1788700000000_fees_import.js` |
| Parsers (pure) | `backend/services/fees/{feeValues,csvFeeSchedule,pdfFeeSchedule,parseFeeSchedule}.js` |
| Fixtures (synthetic) | `backend/services/fees/feeFixtures.js` |
| Porting notes | `backend/services/fees/README-PORT.md` |
| Routes | `backend/routes/fees/{index,helpers,imports,importStore}.js` |
| Tests | 5 files, 71 tests |

Four commits, each self-contained:

```
b1b8a3a  Register the fees module: catalog entry and the CHECK that admits it
758ddf9  Add the fees_import_batch and fees_import_row tenant tables
03de86e  Port the fee schedule PDF and CSV parsers as pure functions
0dd8012  Add /api/fees/imports: upload, parse, preview
```

### Endpoints

All three take `?office=roland|valley`, validated by a router-wide guard before
any handler runs.

| Route | Behaviour |
| --- | --- |
| `POST /api/fees/imports` | multipart, file in a field named `file`. Parses, persists the batch and its rows in one transaction, returns **201** with the batch and every row. A parse failure returns **422** and still stores a `failed` batch carrying the reason. |
| `GET /api/fees/imports` | this office's batches, newest first. Counts, not rows. |
| `GET /api/fees/imports/:batchId` | one batch and every row parsed out of it, in the file's own order. |

---

## 2. The port, and why most of the reference did not come across

Source: `C:\Users\beau\RCM Project v2\fee-schedule-importer\server.js`, the
inline `FeeScheduleImporter` class plus `parsePDF` and `parseCSV`. (Its
`server.js` also requires `./lib/fee-schedule-importer-api`, which does not
exist in that folder — the inline class is the whole implementation.) Every
deviation is written up as a numbered entry in
[`backend/services/fees/README-PORT.md`](../../backend/services/fees/README-PORT.md).
The four that matter most:

**The multi-column table.** A payer schedule prints tiers side by side:

```
D2740  Crown - porcelain/ceramic    1,150.00   920.00   805.00
```

The reference took the line's **first** money token, whatever tier the office
actually held, and recorded nothing about having chosen. The value here is the
same — but the row carries an `ambiguous_amount` warning naming all three
candidates plus the raw line, so an office can see it was a choice. This is the
single most likely way a wrong fee schedule gets posted.

**Several codes on one line.** `D0210 D0220 D0230 Radiographs 145.00` — the
reference wrote `145.00` against **all three**, inventing two fees. The rule
here is one line, one code: a second code yields **no rows** and a file warning
naming them. A flagged absence is recoverable; a confident wrong number is not.

**The comma bug.** `parseFloat(str.replace(',', ''))` replaces only the *first*
comma. `"1,234,567.00"` became `"1234,567.00"`, and `parseFloat` stops at the
first character it cannot read — so the value silently became **`1234`**. A
$1.2m amount lost three orders of magnitude and left a plausible number behind
it. Money is now integer cents built from the digit string; no float is
constructed, not even transiently.

**Duplicate codes.** `if (!fees[cdtCode])` kept the first occurrence and
discarded the rest in silence. A schedule listing `D2740` on page 2 at the base
rate and again on an amendment page imported page 2, and the office would price
every crown against a superseded contract. Both rows are now stored and both
are flagged — which is why `fees_import_row` deliberately has **no**
`UNIQUE (batch_id, proc_code)`.

Also not ported: **the entire `FeeScheduleImporter` class**.
`findOrCreateInsurancePlan`, `createFeeSchedule`, `getProcedureCodeNum`,
`backupFees`, `insertFees` and `revertChanges` are all raw MySQL against Open
Dental, which hard rule 6 forbids, and this slice writes nothing anyway.

---

## 3. Honest states

- A file that will not parse is **stored** as `status: 'failed'` with the
  reason, the filename, the SHA-256 and who uploaded it. An upload that
  vanished is an upload nobody can ask about, and *"I uploaded it and nothing
  happened"* is an unanswerable ticket.
- That response is a **422 refusal**, not a 200 with `rowCount: 0` — which
  reads as *"your schedule has no fees in it"*, a different and false fact.
- Three CHECKs enforce the triple together: a `failed` batch must carry a
  reason, a `parsed` one must not, and a `failed` one has **zero rows**. All
  three are written the long way because Postgres *accepts* a CHECK that
  evaluates to NULL.
- Success is reported only after the rows are in. The response is built from
  what `insertBatch` read back, not from the parser's arrays; the row ids are
  what make that testable.
- Batch and rows go in **one transaction**. A batch claiming 412 rows beside
  300 stored ones is a preview somebody scrolls to the bottom of and believes.

---

## 4. Guardrails, and how each is proved

| Guardrail | Proof |
| --- | --- |
| No Open Dental access, read or write | `feesNoOdAccess.test.js` — drives every route to success with `odOffices` and `openDental` wired to throwing tripwires, **and** scans the module source for an OD import, a write verb or a MySQL driver. Verified it fails when a forbidden `require` is added. |
| No direct MySQL | same file; `mysql2`/`mysql` are on the forbidden-import list permanently, because "port the rest of the reference" is the specific mistake it exists to stop. |
| No filesystem writes | same file — `writeFile`, `createWriteStream`, `diskStorage`. Bytes go buffer → parser → out of scope; only the SHA-256 is stored. |
| Office validated server-side, fail closed | `feesImports.test.js` — missing, empty, `unknown`, `ROLAND` and `smith` all 400 `INVALID_OFFICE` on every route; a body `office` field is not read; one office cannot read the other's batch even by id. |
| Composite office scoping in every query | `importStore.js` holds every statement; each takes `office` and puts it in the WHERE or the INSERT. Child rows carry a composite FK to `(batch_id, office)`. |
| No `SELECT *` | columns named once in `BATCH_COLUMNS`/`ROW_COLUMNS`, driving both statement and mapper. |
| Parameterised queries only | no value interpolation anywhere in `importStore.js`; the only interpolation is the compile-time column lists. |
| `carein_app` GRANT block | in the same tenant migration as the tables. |
| Ships dark | `feesImports.test.js` — an unentitled tenant 403s `MODULE_NOT_ENTITLED` on all three routes, and the module guard runs **before** the office guard so entitlement is not probeable. |
| Audit on batch creation | fail-closed, on **both** outcomes — `SUCCESS` for a parse, `ERROR` for a failure. A file that would not parse is still a file somebody uploaded. |
| No real patient data | every fixture hand-authored; payers `NORTHSTAR DENTAL` and `MERIDIAN BENEFIT` do not exist; PDFs built at test time so no binary enters the repo. `feeSchedule.test.js` carries a standing assertion against SSN- and phone-shaped digits. **No payer PDF from the reference folder is in this repo.** |
| `.env` never read or modified | neither repo's. |

---

## 5. Test results

```
backend:  node --check server.js   → OK
          node --test              → 2626 tests, 2623 pass, 0 fail, 3 skipped
```

New tests, 71 across five files:

| File | Tests | Covers |
| --- | --- | --- |
| `services/fees/feeValues.test.js` | 15 | every silent corruption defect in the reference's value handling |
| `services/fees/feeSchedule.test.js` | 28 | both parser lanes, the dispatcher, and the vocabulary the CHECK admits |
| `routes/fees/feesImports.test.js` | 23 | the three routes over the real middleware chain and real SQL |
| `routes/fees/feesNoOdAccess.test.js` | 5 | the OD/MySQL/filesystem guard, both behavioural and source-scan |
| `test/moduleGateWiring.test.js` | +1 mount | `/api/fees` carries `requireModule('fees')` |

**One flake observed and dismissed:** on one of three full-suite runs,
`routes/sendToTc.test.js` reported a file-level failure with no failing
assertion inside it. It passes in isolation (18/18) and did not reproduce on
re-run. This is the known Node 22 test-runner parent-decode bug already
recorded for this repo, not a regression from this branch.

---

## 6. Two existing tests changed, and why

Both were changed deliberately, not to make a build green. Flagging them
because editing another slice's assertion deserves a second reader.

**`backend/services/hyg/visitSchema.test.js`** asserted
`min(hyg) > max(others)` over tenant migration timestamps. That held only while
hygiene owned the newest tenant migration in the repo, and goes false the first
time *any* other module adds one after the block — which is a normal thing to
do and which this slice did. It now asserts that nothing sorts **inside** the
hygiene block, which is the property that actually protects a deploy
(`checkOrder` refuses a migration landing *behind* a deployed one) and which no
later slice has to edit.

**`backend/test/moduleGateWiring.test.js`** gained `/api/fees` in its non-voice
mount list, as `CLAUDE.md` §1 instructs for any new mount.

---

## 7. Open decisions for you

1. **Does `rcm_biller` get the fees surface?** There is a real argument that it
   should: fee schedules are the input to every allowed-amount question RCM
   asks, so the person working denials is the person who most needs to see what
   the payer's schedule says. I did **not** grant it. `rcmGuard.test.js:273`
   pins `permissionsForRole('rcm_biller')` to RCM actions only, with the reason
   stated at the assertion — *"A biller is not a voice user or a
   coordinator."* Widening a role across a module boundary from inside an
   unrelated slice is a product decision about what that job is, and taking it
   by editing somebody else's invariant is how a permission map stops being
   readable as one table. Today it is `admin` and `office` only; the deferral
   is written up in the fees block of `config/permissions.js`. Adding a role is
   a one-line change, and a loosened guard is not a one-line change back.

2. **Ambiguous-amount rows and the write slice.** A row flagged
   `ambiguous_amount`, `duplicate_code` or `suffix_stripped` is a row the
   parser had to interpret. My assumption is that the write slice **refuses to
   post a warned row** until a human resolves it, the way RCM's approval gate
   works. Slice 1 stores everything needed for that (`warning_count` on the
   batch, `parse_warnings` on the row, `raw_line` beside it) but does not
   enforce it, because there is nothing to post yet. Worth confirming before
   that slice is designed.

3. **Whole-dollar schedules.** An amount must carry two decimals, which is what
   stops a quantity column, a tooth number or a year being read as a fee. A
   payer printing `45` rather than `45.00` therefore parses to zero rows and is
   refused with `NO_ROWS_PARSED`. I judged inventing a rule to catch that would
   misread more than it caught. If a real schedule in that shape turns up, it
   is a small, targeted change — but it should be driven by the actual file.

4. **Scanned fee schedules.** A PDF with no text layer is refused with
   `PDF_NO_TEXT` rather than escalated to OCR. RCM's document rail does
   escalate, because an EOB arrives as whatever the payer scanned; a fee
   schedule is a contract document the payer *publishes*. Sending one to a paid
   OCR service the office did not ask for is a cost decision, not a default.

---

## 8. What slice 2 needs

- A UI for the preview — the warnings are the point of it, and a batch whose
  `warningCount` is non-zero should be hard to post without reading.
- Matching parsed `proc_code` values against Open Dental's `procedurecode`
  table (a **read**, through the office-keyed client).
- The fee schedule target itself: which `feesched` a batch posts into, created
  or chosen.
- The write, with an approval gate, one writer file, and the one-file allow-list
  added to `feesNoOdAccess.test.js`.

Nothing in slice 1 has to be reshaped for any of that: `fees_import_row`
already carries the code, the cents, the line it came from and its warnings,
and the batch already carries who uploaded it and when.

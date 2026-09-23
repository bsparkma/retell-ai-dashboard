# Porting notes: `fee-schedule-importer` → `backend/services/fees`

The parsing in this directory was ported from the inline `parsePDF`, `parseCSV`
and `FeeScheduleImporter` in
`C:\Users\beau\RCM Project v2\fee-schedule-importer\server.js` (read-only
reference; its `server.js` also requires `./lib/fee-schedule-importer-api`,
which does not exist in that folder — the inline class is the whole
implementation).

Every deviation is listed. Where a deviation fixes a defect, the defect is
described in terms of what it did to a real file, because that is the only form
in which "do not put this back" is checkable.

---

## What survived

The **shape** of both parsers: scan for a CDT code, scan for a dollar amount,
pair them, build a `{ code → fee }` table. That shape is right, and it is why
the reference worked at all on well-formed files.

The **two-decimal rule** for amounts (`[0-9,]+\.[0-9]{2}`). It is what stops a
quantity column, a tooth number or a year being read as a fee, and it is a
better rule than it looks.

The **suffix concept** — that payers print `D2740A` where Open Dental has
`D2740`. The reference was right that the suffix has to come off.

---

## Deviations

| # | Deviation | Why |
|---|---|---|
| **D1** | **Money is integer cents.** `parseFeeCents` builds `whole * 100 + frac` from the digit string; no float is constructed, not even transiently. | The reference stored `parseFloat` dollars. `18.20` has no exact binary representation, and RCM — the module that will read these numbers to answer "did the payer allow what they contracted to allow?" — compares cents for equality. |
| **D2** | **Commas are stripped globally, and malformed grouping is refused.** | `str.replace(',', '')` replaces only the **first** match. `"1,234,567.00"` became `"1234,567.00"`; `parseFloat` stops at the first character it cannot read, so the value silently became **`1234`**. A $1.2m amount lost three orders of magnitude and left a plausible number in its place. `"1,23.00"` — a captured column boundary — became `123.00`; here it is refused. |
| **D3** | **A duplicate code is kept and flagged, never first-write-wins.** Two rows at two fees raise `duplicate_code`; two rows at the same fee raise `duplicate_code_same_fee`. | `if (!fees[cdtCode])` kept the first occurrence and discarded the rest with no record. A payer schedule listing `D2740` on page 2 at the base rate and again on page 9 at an amended rate imported page 2, and every crown was then priced against a superseded contract. The tenant schema deliberately has **no** `UNIQUE (batch_id, proc_code)` so both rows can be stored. |
| **D4** | **One line, one code.** The three overlapping patterns are replaced by a single line rule. A line with 2+ codes yields **no rows** and a `multiple_codes_on_line` file warning. A line with 1 code and 2+ amounts yields a row at the **first** amount carrying an `ambiguous_amount` warning that names every candidate and the raw line. | Pattern 3 paired **every** code on a line with that line's **first** amount, so `D0210 D0220 D0230 Radiographs 145.00` wrote 145.00 against all three. Patterns 1 and 3 both took the first money token, so a multi-column table (`D2740 Crown 1,150.00 920.00 805.00`) silently imported tier 1 whatever tier the office held. Nothing recorded that a choice had been made. |
| **D5** | **Suffix stripping warns.** `D2740A → D2740` raises `suffix_stripped`. | The reference stripped silently. `D2740A` and `D2740B` are a payer's two rates for the same procedure; collapsing both turns them into a duplicate whose winner is whichever the parser reached first. |
| **D6** | **`$0.00` is kept.** Negative is refused with `negative_amount`. | `if (feeAmount > 0)` discarded every zero. In a fee schedule 0.00 means *not covered*, *bundled* or *no fee* — a fact the office needs, and one that vanished. |
| **D7** | **CSV columns are matched against explicit vocabularies, and ambiguity is a refusal** (`CSV_AMBIGUOUS_COLUMNS`, naming the candidates). | The reference used `keyLower.includes('code')` / `includes('fee')` with **last-wins**. Three failure modes, all silent: `Zip Code` and `Code Description` matched as the procedure code; a file with `UCR Fee`, `Allowed Amount` and `Contracted Fee` imported whichever came last in **column order**, so inserting a column changed the rate imported; and a file matching nothing produced zero rows and reported success. |
| **D8** | **Nothing touches the filesystem.** Bytes arrive in memory and leave scope with the request; only the SHA-256 is stored. | The reference used multer `diskStorage` into `uploads/` and read by path. A fee schedule is an executed payer contract, the container filesystem is ephemeral, and the one mounted volume in prod is the call store's AzureFile share. Same rule as `routes/rcm/era.js`. |
| **D9** | **`csv-parser` is replaced by `splitCsv`** (~40 lines, RFC 4180: quoted fields, embedded commas and newlines, `""` escapes). | The reference's parser is a **stream over a path**, which D8 removes, and `csv-parser` is not a dependency of this repo. Adding one to read a two-column file is a poor trade. |
| **D10** | **The entire `FeeScheduleImporter` class is NOT ported.** `findOrCreateInsurancePlan`, `createFeeSchedule`, `createFeeScheduleDirectly`, `getProcedureCodeNum`, `backupFees`, `insertFees` and `revertChanges` have no counterpart here. | Two reasons, either sufficient. (1) Slice 1 is parse and preview; there is no write. (2) Every one of them is **raw MySQL against Open Dental**, which this platform forbids — hard rule 6, "never write directly to Open Dental MySQL; use the OD cloud API through the office-keyed client registry". When the write slice comes it goes through that registry, with exactly one writer file and a one-file allow-list in the guard test, the way RCM's and HYG's did. |
| **D11** | **The CDT scanner is `\bD\d{4}[A-Za-z]?\b`.** | The reference used `\bD\d{4}[\w\d]?\b`. `[\w\d]` is just `[\w]`, so it also admitted digits and underscores: `D01201` matched as `D0120` + suffix `1`, and the stripper only removed `[A-Z]` — so the row was stored under `D01201`, a code Open Dental has never heard of, and the failure surfaced at post time. A five-digit run now matches nothing, which is true. |
| **D12** | **The cross-line pair is narrowed to the immediately following line, and only when it carries exactly one amount and no code of its own.** Warned as `paired_across_lines`. | The reference's pattern 2 paired a code with the next line's first amount **unconditionally**, including on lines patterns 1 and 3 had already matched. A code on the last line of a page took the first number off the next page's header. |
| **D13** | **No OCR escalation.** A PDF with no text layer is refused with `PDF_NO_TEXT`. | RCM's document rail escalates to Azure Document Intelligence because an EOB arrives as whatever the payer scanned. A fee schedule is a contract document the payer *publishes*. Sending one to a paid OCR service the office did not ask for is a cost decision, not a default; if it turns out to be needed it is a slice with a conversation in it. |
| **D14** | **A declared source type, then verified.** The caller declares `pdf`/`csv` from the filename; a `pdf` is then checked for `%PDF-` and a mismatch is `WRONG_FILE_TYPE`. | Sniffing alone lets a CSV whose first cell reads `%PDF` choose its own lane. Trusting the declaration alone sends a CSV to pdf-parse, which fails with a message about the container rather than about the file being the wrong kind. |

---

## Fixtures

`feeFixtures.js` is entirely hand-authored. **No payer PDF from the reference
folder is in this repo and none should be** — they are executed contract
documents and they are not ours to redistribute. The CDT codes are real
published nomenclature (public); the fees are invented round numbers; the payers
are `NORTHSTAR DENTAL` and `MERIDIAN BENEFIT`, which do not exist. There is no
patient name, DOB, phone number or subscriber id anywhere, and
`feeSchedule.test.js` carries a standing assertion to that effect.

PDFs are built at test time by `syntheticFeePdf(lines)` rather than committed as
binaries — the same argument `rcmTestUtils.syntheticPdf` makes, extended to
multiple lines, so a test can state in one line exactly what the extractor will
see.

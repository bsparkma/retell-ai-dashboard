# "The EOB parser got worse" — what is perception, what is real, and the fix

**Branch** `fix/rcm-extraction-quality` · worktree off `origin/develop` (bbe6b83) · 2026-09-30/10-01

## TL;DR

The extraction itself did not get worse at #206 — it stopped inventing per-line
payments, which is what it was told to do. What *did* break is that the honest
blank #206 created **never reached the screen**: the serving layer coerced the
stored `NULL` to `0`, so every unstated per-line payment rendered as a
fabricated **$0.00 paid**, and the derived patient remainder rendered as the
**whole allowed amount**, with a write-off/bill-the-patient control offered over
it. On a nine-page scanned check that looks exactly like "the parser now reads
every payment as zero" — much worse than the old output, which invented
*plausible-looking* (and wrong) covered amounts.

That is the one genuine regression, and it is fixed here, with fixtures and
mutation proofs. The covered≠paid rule is untouched and re-proven (9/9 mutants
killed). The UX half now says **"not stated"** (with the full sentence in the
cell's tooltip) wherever the page does not state a figure, so a blank reads as
honest, never as broken.

## 1. The prod window (last 7 days)

Exactly **two** scanned-EOB extractions ran on prod in the window. Established
from the prod Log Analytics console stream and the deploy history; referenced
by upload id and OCR fingerprint only — no document content, names, or payer
identifiers appear in this report.

| Upload (prod) | OCR fingerprint | Extracted (UTC) | Code that ran | Staging twin (same fingerprint) |
| --- | --- | --- | --- | --- |
| `d00dae9f-cf2c-4556-ad12-99420bc1a680` | 2 pages · 2,910 chars · conf 0.983 | 2026-09-30 02:30 | **pre-#206** (train #204, deployed 09-29 20:21Z) | `c967a83a…` extracted on staging 09-30 17:25Z, **post-#206** |
| `a28a6329-9222-4542-b2a7-a686fc6ccb50` | 9 pages · 12,110 chars · conf 0.926 | 2026-10-01 02:11 | **post-#206** (train #209, deployed 10-01 ~02:00Z) | `75d5e83d…` extracted on staging 09-30 23:34Z, post-#206 |

Timeline that matters: #206 reached staging 09-30 17:15Z and prod only at
10-01 ~02:00Z (train #209). So the 2-page document is a genuine before/after
pair across environments, and the 9-page check — uploaded to prod at 02:11Z and
opened on the claim screens at 02:11–02:13Z — is the document behind the
"much worse" report. Both failures of appearance (the $0.00 column, the
inflated remainder) are exactly what the post-#206 serving path produced for a
category-subtotal layout until this fix.

**Evidence limit, stated plainly:** the row-level cents for these uploads were
not read. The in-container read I attempted (a base64-piped probe over
`az containerapp exec`) was refused by the session's safety layer, and I did
not work around it. The field-by-field classification below is therefore built
from the deterministic code paths (which fully determine what each version
*does* with a given model answer), the deploy/log timeline above, and the
record #206 itself left of the 2-page document's pre-#206 output. A read-only,
PHI-free probe is now checked in as
`backend/scripts/rcm-extraction-quality-probe.js` (run it with
`az containerapp exec -n ca-carein-prod-backend -g rg-carein-prod --command
"sh -c \"node /app/scripts/rcm-extraction-quality-probe.js\""` once this image
deploys) if you want the stored numbers themselves.

## 2. Field-by-field classification

Classes, per the brief: **(a)** an honest blank replacing an invented value ·
**(b)** unchanged · **(c)** genuine regression — was correct, now wrong or
missing.

| Field | Pre-#206 produced | Post-#206 produces | Class |
| --- | --- | --- | --- |
| Per-line **paid** — layout states payment only at a category subtotal | The line's **covered/allowed amount**, invented (the $1,229.00 line documented in #206's own message, upload `d00dae9f`) | Extraction/storage: `NULL` — honest. **Screen (until this fix): `$0.00`** — a *new* invented value; the honest blank never rendered | **(a)** at extraction · **(c)** at the screen — **fixed** |
| Per-line **patient remainder** (derived R = allowed − paid) | allowed − covered: small or zero, derived from an invented figure | **Until this fix:** allowed − 0 = the whole allowed amount, with a bill/write-off decision control offered over it | **(c)** — **fixed** (now "not stated", no control) |
| Per-line **paid** — layout states payment per line | Read from the page | Read from the page, same prompt wording, same `int` path for integers | (b) |
| Per-line **paid = stated $0.00** | 0 | 0 — "the plan paid nothing" survives as zero at every layer (schema, `intOrNull`, wire, screen); pinned both as number and pg-string | (b) |
| Claim totals (billed/allowed/deductible/copay/**paid**) | Read from the document; correct on `d00dae9f` per the #206 record | Unchanged — claim `totalPaidCents` still required and read from the document's own total | (b) |
| Check/EFT total, payer, check number/date, method | Read | Unchanged | (b) |
| Identity fields (patient, DOB, subscriber, claim number, NPI, provider, dates) | Read, placeholders when absent | Unchanged — same placeholders, same review reasons | (b) |
| Review reason on a subtotal layout | `paid_total_mismatch` — "the numbers disagree", sending a biller to re-read a column that is correct | `line_paid_not_stated` — "this payer states payment by category, not per line" | **(a)** — the old reason described the app's arithmetic, the new one describes the page |
| Review reasons: `missing_npi`, `missing_dob`, `missing_check_number`, sum mismatches, negative amounts, future dates, `uncertain_line:N`, `ocr_low_confidence` | Fire | **Still fire, unchanged** (`deriveClaimReviewReasons` paths untouched; `paid_total_mismatch` still fires whenever every line *is* stated and the sum still disagrees) | (b) |
| Per-line write-off W = billed − allowed | Derived | Unchanged (involves no payment) | (b) |
| CARC/RARC adjustments, flags, confidence | Read | Unchanged | (b) |

No field moved in the direction "was correct, now wrong" at the extraction
layer. Both members of class (c) are serving-layer: #206 taught extraction and
storage that absence is data, and did not teach the wire.

**Watch item (not fixed, no evidence yet):** a single-line claim whose payment
is stated at claim level could have its one line nulled by the model even
though Σ over one line is the claim total. That would be an honest-blank where
a stated figure exists. The probe script will show it if it happens; inferring
the line from the claim total is deliberately *not* done here, because it is a
back-door to the fill-nulls-to-reconcile behavior the prompt forbids.

## 3. The genuine regression, mechanically

1. `rcm_procedure_lines.paid_cents` is `NULL` (correct, #206).
2. `routes/rcm/matchService.js` `toLineWire` serialized it with `num()`, whose
   contract is null-is-0 → the wire said `paidCents: 0`.
3. The same call fed that 0 into `lineDecisions.lineMoney` → the wire said
   `patientRemainderCents: allowed`.
4. The client's `ClaimLine` type still said `paidCents: number` — the stale
   type is why tsc stayed green while the server shipped null-shaped data.
5. `money()` priced it: **$0.00** on the check page's line table and the claim
   workbench, remainder = allowed, decision control rendered.

### The fix

- **Wire** (`toLineWire`): `paid_cents` NULL ships as `null`; the derived
  remainder ships as `null` when its input was never stated. The subtraction
  itself still lives only in `lineDecisions.js`; the wire withholds its
  *output* when the input is absent. `verdictFor` and the whole posting spine
  are untouched — the approve gate's `FIELDS_CONFIRMED` condition remains what
  protects an OCR-sourced check, exactly as #206/#208 designed.
- **Types** (`features/rcm/api.ts`): `ClaimLine.paidCents` and
  `patientRemainderCents` are now `number | null`, so a future consumer cannot
  price a null without tsc objecting.
- **Screens**: the check page's line table and the claim workbench render
  **"not stated"** (muted, non-tabular, with the explaining sentence as the
  cell's tooltip) for an unstated payment or remainder. The decision cell says
  "Nothing to decide yet — the page does not state this line's payment" and
  renders **no control**; a stated zero still reads "$0.00" and still gets its
  decision control when a remainder exists.

### Fixtures reproducing each (c)

- `backend/routes/rcm/lineWireNotStated.test.js` — the stored-NULL row, the
  stated-zero row (both pg shapes: number and bigint-string), the withheld
  remainder, the intact W.
- `new-dashboard/tests/rcm-workbench.test.tsx` ("a line whose payment the page
  does not state") — both screens: "not stated" faces, no `$0.00` anywhere in
  the row, no decision control, and the stated-zero contrast case.

## 4. Covered ≠ paid — re-proven after the change

Mutation run (scratchpad harness, every mutant applied to the real file, the
real suites run, file restored):

| Mutant | Result |
| --- | --- |
| A1 `paidCents` falls back to `allowedCents` in `normalizeProcedure` | KILLED |
| A2 `paidCents` coerced with `int()` again (null → 0) | KILLED |
| A3 `intOrNull` invents 0 for absence | KILLED |
| A4 unstated lines report `paid_total_mismatch` again | KILLED |
| A5 schema stops allowing null for `paidCents` | KILLED |
| B1 wire coerces NULL paid back to 0 | KILLED |
| B2 wire ships a remainder derived from an unstated payment | KILLED |
| B3 wire nulls the remainder for every line | KILLED |
| B4 wire collapses a stated zero into not-stated (`!paid_cents`) | KILLED (survived the string-'0' case alone; the test now pins the number-0 shape pg also produces) |
| U1 claim page prices the null again | KILLED |
| U2 claim page offers a decision over an unstated remainder | KILLED |
| U3 check page prices the null again | KILLED |

Baselines green between every mutant.

## 5. The UX half

- Register: the same words the field-confirm screen already uses — lowercase
  "not stated" in a table cell, the full sentence ("The page states payment at
  a category subtotal, not for this line.") in the cell's `title`, which the
  banned-word scan reads and the word budget deliberately does not.
- Budget: table-row faces are outside the chrome word budgets (`chromeProse`
  strips `tbody tr`), and "not stated" is two prose words, inside the ≤8-word
  face rule. **No budget re-pin was needed** — the capped re-pin the brief
  allowed went unused.
- Warnings describe the page, not the app: "No provider NPI was found", "The
  procedure payments do not sum to the claim total", and `line_paid_not_stated`
  says "This payer states payment by category, not per line — the per-line
  amounts are not on the page". All still fire (§2 table); the smoke, labels
  and plain-language suites are green.

## 6. Constitution compliance

- Originals immutable — no blob reads or writes; the probe script reads
  Postgres only.
- Slugs additive only — no vocabulary change at all in this fix.
- Budgets pinned — unchanged; the allowed capped re-pin was not needed.
- No OD writes — nothing here imports an OD module; the script scans
  (`rcmNoOdWrites`, D-7 probe guards) pass.
- Posting spine untouched — `lineDecisions.verdictFor`, the approval gate, the
  drain and `confirmedFigures` have zero diff lines.
- Touched expectations mutation-proven — §4.

## 7. Done criteria

- Classification table — §2.
- Fixes for every (c) — §3, with fixtures.
- `tsc --noEmit` (dashboard `pnpm run check`) clean · `node --check server.js`
  clean · backend `node --test` **2,867 pass / 0 fail** (one earlier run showed
  the known Node-22 file-level flake on `routes/sendToTc.test.js` — green in
  isolation and in the final full run) · dashboard `pnpm run test`
  **2,080 pass / 0 fail** (138 skipped shot suites, as always).
- PR opened from `fix/rcm-extraction-quality`; no merge.

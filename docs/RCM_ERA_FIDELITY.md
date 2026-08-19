# RCM Slice 5.5 — ERA/EOB fidelity hardening

Slices 4 and 5 were correct against a 13-file synthetic corpus that shares one authoring
style. A PM audit of the parser against X12 005010X221A1 found a class of defect worse
than a crash: **files that parse successfully, reconcile arithmetically, and store the
wrong numbers, with no flag raised.** Slice 6c posts those numbers into a real patient's
ledger, so every one of them is fixed here, before the first Open Dental write.

The module's honest-states law says a component that cannot do the job says so. A parser
that drops a segment it never learned to read is the parser equivalent of a server claiming
a send it never made. That is the standard this slice holds the code to, and it is why
every fix below ends as a **flag in a frozen vocabulary enforced by a database CHECK** —
never a `console.warn`, and never a silent correction.

| | |
| --- | --- |
| Vocabulary | [`backend/services/rcm/rcmVocabulary.js`](../backend/services/rcm/rcmVocabulary.js) |
| Migration | `backend/migrations-tenant/1787060000000_rcm_fidelity.js` |
| Parser | [`backend/services/rcm/eraParser.js`](../backend/services/rcm/eraParser.js), [`x12.js`](../backend/services/rcm/x12.js) |
| Ingest | [`backend/services/rcm/eraIngest.js`](../backend/services/rcm/eraIngest.js) |
| EOB | [`eobDocumentText.js`](../backend/services/rcm/eobDocumentText.js), [`eobExtractionWorker.js`](../backend/services/rcm/eobExtractionWorker.js), [`routes/rcm/eob.js`](../backend/routes/rcm/eob.js) |
| New fixtures | 8, listed in [`backend/test/fixtures/rcm/README.md`](../backend/test/fixtures/rcm/README.md) |

---

## The vocabulary is now enforced by the database

`rcm_claims.needs_review_reasons` had **no CHECK constraint at all**. Either ingestion path
could have written prose into the column the review UI switches on, and nothing would have
said so until a biller saw a raw slug in the workbench. Slice 5.5:

- makes `rcmVocabulary.js` the single source for review reasons, line flags, remittance
  flags and EOB failure codes — the ERA parser, the ERA ingest and the EOB extraction all
  read it;
- mirrors every list into a CHECK constraint in the migration;
- pins the two together with `rcmVocabulary.test.js`, which reads the migration's source
  and fails if they drift.

One member is **parameterised**: `uncertain_line:3` carries a printed line number, because
`rcm_procedure_lines` has no confidence column and its `flags` CHECK has no slot for
uncertainty. A plain `<@ ARRAY[…]` cannot express that, so the constraint validates each
element through an IMMUTABLE function (`rcm_is_review_reason`) instead.

Remittance flags moved out of `rcm_payment_batches.notes`, where Slice 5 joined them into
the prose string `"Flagged: a, b"` for the UI to parse, into a CHECKed `text[]`. `notes` is
for a human to type in again.

---

## Part A — the silent money defects

### A1 — Claim-level CAS was dropped entirely

`parseServiceLines` only scanned inside the `SVC` window, so any `CAS` between the `CLP`
and the first `SVC` (loop 2100) was discarded **with no flag**. Payers routinely report
deductible and coinsurance at claim level. The result was a claim storing
`total_deductible_cents = 0` and `patient_balance_cents = 0` while its own `CLP05`
correctly said otherwise — two stored numbers disagreeing, and nothing reconciling them.

**Now:** claim-level CAS is parsed into the claim's adjustment set with
`rcm_procedure_adjustments.scope = 'claim'` and a NULL `procedure_line_id` (the FK became
nullable; a paired CHECK keeps scope and line consistent), rolled into the claim's
deductible/copay/write-off totals, and marked with `claim_level_adjustments_present` so
the review UI can say *where* the deductible was reported.

**And reconciled.** Σ(claim-level PR) + Σ(line-level PR) is compared against `CLP05`; a
disagreement raises `patient_resp_mismatch`. Only when the payer actually sent a `CLP05` —
an omitted one reads as 0, and reconciling against that would flag most of the corpus for
a field the file never claimed. This is the check that was structurally impossible while
claim-level CAS was being dropped, and it is the one that would have caught the drop.

### A2 — The component separator was hardcoded

`x12.js subElement()` split on `':'` and ignored the `ISA16` value the same module had
already read. A payer or clearinghouse declaring `>` — common in real 005010 output —
stored `"AD>D0120"` as the procedure code and `"WO>OLDCLM001"` as a PLB reason. Every code
in the file was wrong; the money still reconciled, so nothing flagged.

**Now:** `parseSegments` became `parseInterchange` and returns the delimiter set alongside
the segments; the declared component separator is threaded through `parseClaim`,
`parseServiceLines` and `parsePlb` into every composite split.

### A3 — The allowed amount ignored `OA`/`PI`, and never read `AMT*B6`

`allowedCents = billed − Σ(CO adjustments)`. Two ways that produced a wrong
`write_off_cents` — **a number Slice 6c writes into Open Dental's
`ClaimProc.WriteOff`**:

- a payer taking the contractual reduction under `OA` or `PI` had it counted as
  if it were still allowed;
- a payer reporting the allowed amount explicitly in `AMT*B6` was ignored
  entirely, so a disagreement between the payer's own two statements was
  invisible.

**Now:** the derived form counts `CO`, `OA` and `PI` as contractual (`PR` is the
patient's money and `CR` is a correction, so neither is a write-off).
`AMT*B6` is read into `reported_allowed_cents`, and a disagreement beyond **1
cent** raises `allowed_mismatch` on the line and `allowed_amount_mismatch` on
the claim. One cent, not zero, because a payer rounding a coinsurance split can
legitimately land a cent away from our arithmetic.

#### DERIVED WINS. REPORTED IS EVIDENCE, NOT TRUTH.

> This rule is the correction of a **money regression this slice shipped in its
> first revision**, and it is written at length because getting it wrong was
> worse than leaving A3 undone.

The first revision *preferred* `AMT*B6` when present. Against the frozen corpus
that was catastrophic, because 25 of its 37 `AMT*B6` lines carry the **billed**
amount rather than the allowed one. Preferring it set `allowed := billed`, and
`write_off_cents = billed − allowed` therefore became **zero**:

| Fixture line | develop | first revision | the file's own CAS says |
| --- | --- | --- | --- |
| `Guardian` D0120 | $2.00 | **$0.00** | `CAS*CO*45*2` |
| `Guardian` D0274 | $18.00 | **$0.00** | `CAS*CO*45*18` |
| `Delta` D2750 | $504.00 | **$0.00** | `CAS*CO*45*504` |
| `Cigna` D0150 | $45.00 | **$0.00** | `CAS*CO*4*45` |
| `Principal` D2750 | $350.00 | **$0.00** | `CAS*CO*45*350` |

On the Delta claim that would have posted a **$0.00 write-off and left $504.00
sitting in the patient's AR** — money the carrier had already said was
contractual. The slice chartered to stop the parser storing wrong numbers was
storing a worse one than develop, on the majority of the corpus.

The rule that replaces it:

- `derived = billed − contractual` is built from **two** payer-stated numbers
  that must reconcile against the payer's own paid amount. `AMT*B6` is **one**
  unverified field. When a single unchecked value disagrees with arithmetic that
  reconciles, the arithmetic is the better estimate and the disagreement is the
  finding.
- `allowed_cents` and `write_off_cents` store the **derived** value, always.
- `reported_allowed_cents` keeps the payer's figure.
- `allowed_source` is the provenance of **the payer's stated allowed amount** —
  `'reported'` when an `AMT*B6` was present to compare against, `'derived'` when
  the file said nothing. It is *not* the provenance of `allowed_cents`, which is
  always derived. The name is a little narrow for that meaning; the column
  comment and this paragraph are the compensation.
- `allowed_amount_mismatch` still fires, and now means *"the payer's stated
  allowed disagrees with the payer's own arithmetic"* — true and useful.
- **Never compute a write-off from a value you did not reconcile.**

Three tests hold this down, and their absence is why the regression was
invisible to 1170 green tests: no test asserted a *stored* write-off at all.
`eraParser.test.js` now asserts (a) the derived value wins on a disagreeing
line, (b) every line in the whole corpus has `billed − allowed` equal to its own
CAS contractual total, and (c) the five lines above, by name.

### A4 — `toCents` failed silently on anything non-numeric

`parseFloat("1,250.00")` is `1`. That stored **$1.00 where $1,250.00 belonged**, and only
tripped a reconciliation if the value happened to participate in a checked sum.

**Now:** the token is validated against `/^[+-]?(\d+(\.\d*)?|\.\d+)$/` before conversion. A
token that does not validate calls back to the caller, which raises `unreadable_amount` at
the line, the claim and the remittance.

**A flag on its own was not enough**, and an earlier revision of this document
claimed a corroboration that does not happen. A refused **contractual** amount
reads as `0`, which inflates the derived allowed and zeroes the write-off —
while `claim_total_mismatch`, `line_total_mismatch` and `patient_resp_mismatch`
all compare figures the bad token never touched. `CAS*CO*45*1,00` on a $200 line
paid $100 loses a **$100 write-off into totals that reconcile perfectly**, with
`unreadable_amount` standing alone.

So a claim carrying any unreadable amount now also raises
**`totals_unreconciled`**: if a value could not be read, the sums it belongs to
are not reconciled and must not be presented as though they were.

`unreadable_amount` is raised at the line and the claim wherever a token fails,
and at the **remittance** only for `BPR`/`PLB` tokens — those are the only ones
parsed outside a claim.

**The honest limitation that remains.** The cents columns are `bigint NOT NULL`,
so "unknown" cannot be stored as NULL without a wider schema change. An
unreadable amount stores `0` with the row flagged and the claim's totals marked
unreconciled. The value is never *presented* as trustworthy, but it is a zero.
Making these columns nullable is the honest end state and is listed below as
unhandled.

### A5 — Repeating segments stopped at the first gap

Both the `CAS` and `PLB` loops did `break` on the first empty element. A padded or gapped
segment silently lost every pair after the gap — for `CAS` with **no flag at all**, for
`PLB` with only a downstream `claim_total_mismatch` if the lost amount happened to move the
BPR reconciliation.

**Now:** skip-and-flag. The pairs after a gap are recovered, and
`partial_adjustment_segment` is raised on the line, the claim and the remittance. Trailing
empty elements are *not* a gap — flagging those would fire on almost every real file and
make the flag meaningless.

### A6 — EOB input truncation was invisible

`MAX_DOCUMENT_CHARS = 120_000`; a longer document was truncated and the only trace was a
`console.warn`. A long bulk EOB silently lost its tail claims, the model reconciled the
totals it could see, and the user was shown "Proposal ready."

**Now the upload is REFUSED** with `DOCUMENT_TOO_LARGE` and a message that names the
character count, the page count and the limit, and tells the user to split the document.
Storing the partial and flagging it was considered and rejected: a proposal missing claims
nobody can enumerate is not reviewable, and Slice 6c would post the ones that survived
while the rest silently never existed.

`rcm_eob_uploads.failure_code` is the machine-readable half — the panel switches on it, and
`error_message` stays the human sentence. "This document is too long, split it" and "this
PDF is encrypted" are different conversations, and distinguishing them used to mean
matching prose.

---

## Part B — fidelity Slice 6 depends on

| | What landed |
| --- | --- |
| **B1** | `REF*6R` → `rcm_procedure_lines.line_item_control_number` and `SVC05` → `units_paid`. `REF*6R` is on every `SVC` in the corpus and is the only reliable key for matching a remitted line back to a submitted claim line — without it Slice 6's matcher is positional, which breaks the moment a payer reorders or splits lines |
| **B2** | The full RARC set is persisted on `rcm_procedure_lines.remark_codes`, and `MOA`/`MIA` claim-level remark codes — previously not read at all — on `rcm_claims.remark_codes` |
| **B3** | `SE01`, `GE01` and `IEA01` are validated. `envelope_counts_mismatch` / `envelope_incomplete`, with the expected-vs-actual numbers on `parsed.envelope` |
| **B4** | Multi-ST files get a fixture and tests, and `rcm_eob_uploads.result_batch_id` is set **only when there is exactly one batch** |

**B2's behaviour change.** Slice 5 stamped `remarkCodes[0]` onto every adjustment on a
line, so a line with three CARCs and one RARC stored that RARC three times — plausible, and
wrong. X12 gives no `CAS`↔`LQ` association at all, so
`rcm_procedure_adjustments.remark_code` is now **left NULL** by the ERA path and the full
set lives on the line.

**B4's behaviour change.** `result_batch_id` was set to `batches[0]` unconditionally, so a
four-check file pointed its upload at check #1 and the other three looked orphaned. The
real link is `rcm_payment_batches.era_file_key`, which every batch carries and the list
endpoint already joins on; `result_batch_id` is now populated only when it can be true.

Nothing from Part B was cut.

---

## Part C — EOB duplicate uploads

**The premise in the slice brief was already out of date.** Slice 4 (`6dc2dec`,
PR #84 — not PR #87, as an earlier revision of this document said) added
content-hash dedupe to `POST /api/rcm/eob`: it
hashes the bytes, looks up `(office_id, file_hash)`, returns the existing upload for an
`extracted` or `processing` prior, and treats `uploaded`/`failed` as the retry path. The
same PDF uploaded twice already did **not** create two batches.

What was genuinely missing is the **guarantee**. That lookup is a read-then-write, so two
uploads of the same PDF arriving together both see no prior and both insert. Slice 5.5 adds
what the ERA path has: a database constraint, because only the database can win that race.

- `rcm_eob_uploads_office_hash_unique` — a **partial** unique index on
  `(office_id, file_hash)` `WHERE status <> 'failed' AND file_hash IS NOT NULL`. A failed
  upload does not hold the hash, so a document that failed extraction can still be retried.
- The route catches `23505` and answers the race-loser with the same duplicate response it
  would have received a millisecond later.

The Slice 1 comment on the original non-unique index said a deliberate re-upload was
legitimate. That was written before there was anything to double-post *into*; it is
superseded here, with the failed-upload carve-out preserving the retry it was protecting.

**Same rule as Slice 5: no force flag, no override, no query param.** A legitimate
re-extract case stops the work and comes to the PM as a named, designed operation.

### How this differs from the ERA remittance key, honestly

A **remittance key** is derived from the remittance's own identity — trace number, payer,
date, amount — so it recognises the same payment however it arrives. A **content hash** is
derived from the file. Two scans of the same paper EOB are different bytes and **will both
be accepted**, producing two proposals for one payment. Nothing in this slice prevents
that. It is a real limitation of content-addressing, stated rather than hidden; the defence
is Slice 6's matcher noticing the same claim twice, and that defence does not exist yet.

---

## Review round — what the PR review changed

The first revision of this slice was reviewed and did not merge. A3 above is the
headline; these are the rest.

### B1 — the claim row and its lines disagreed about the same money

With A3 preferring the reported allowed on the LINES while the CLAIM total stayed
derived, `rcm_claims.total_allowed_cents` and `Σ rcm_procedure_lines.allowed_cents`
could differ — $163.00 against $195.00 on `Test_Guardian_Clean.edi` — and
**nothing compared them**.

Fixing A3 collapses the split (all 21 corpus claims now agree), but the
reconciliation is added anyway, because "two stored numbers about one sum with
nothing checking them" is the defect class A1 exists to end. `parseClaim` now
compares the claim's allowed against the sum of its lines, allowing for
contractual reductions reported at claim level, which belong to no line. A
disagreement raises **`claim_line_allowed_mismatch`**.

### B2 — a silent drop introduced by this slice

`eraIngest.writeClaim` skipped a claim-level adjustment whose CARC group the
schema cannot hold — no flag, no counter — in the code path this slice added,
while the line-level path raised `unstorable_adjustment_group` for exactly that
case. A `CAS*XX*1*5000` at claim level vanished with no trace. It now mirrors the
line-level handling.

### B4 — a flag is not automatically a gate

`eraIngest.batchStatusFor` holds a batch at `open` if **any** flag or review
reason is present. Measured on the original 13 fixtures: develop 5 `ready` / 8 `open`, this branch
**1 / 12** — and **fixing A3 did not move that number at all**, because the
whole of it is `allowed_amount_mismatch` firing on the corpus's `AMT*B6`
convention.

A biller who sees most checks held learns to click past the reason, which costs
more than it saves. **A split is proposed at the end of this document and
deliberately NOT implemented** — it changes what "ready" means, which is the
PM's call, and the numbers for each variant are tabulated there.

### B5 — the vocabulary reaches a human now

Ten new members shipped with no frontend change, so they rendered as raw
snake_case slugs — on proposals they were also blocking. The labels moved to
[`features/rcm/labels.ts`](../new-dashboard/client/src/features/rcm/labels.ts),
shared by the ERA panel and the Slice 6 workbench, and
`tests/rcm-labels.test.ts` **reads the backend vocabulary source** and fails on
any unlabelled member. That is what stops this recurring.

### B6 — the EOB path is on the shared vocabulary

`eobExtraction.js` now imports `rcmVocabulary` and references its reasons
through it rather than pushing 16 bare literals, so a typo is a load-time crash
instead of a rejected INSERT in production. Its stale "no CHECK constraint"
comment is corrected.

More consequentially, `eobExtractionWorker` wrote the machine token
`· UNBALANCED` into `notes` and **never populated `flags`** — so every EOB batch
would have shown no flags at all while its real signal sat in a prose string
nothing reads. It now writes the same CHECKed `flags` column the ERA path does,
and `notes` is a human summary again.

---

## Before you deploy

**Run this against the target database first.** The new partial unique index on
`rcm_eob_uploads` can abort on live data, because the read-then-write race it
closes is exactly what produces duplicate rows:

```sql
SELECT office_id, file_hash, count(*)
FROM rcm_eob_uploads
WHERE status <> 'failed' AND file_hash IS NOT NULL
GROUP BY 1, 2 HAVING count(*) > 1;
```

Any row returned is two proposals for one document. Decide which to keep and set
the other's `status` to `'failed'` (which releases the hash), or delete it.

The migration **guards this itself** — a `DO` block raises before the index is
attempted, naming every duplicate pair rather than letting Postgres name one and
stop. Running the query first just means finding out before the deploy window
rather than during it.

## Backup and restore

`rcm_claims_review_reasons_check` calls the user-defined function
`rcm_is_review_reason`. `pg_dump` emits functions before tables, so a **plain
full `pg_restore` is fine**. A **selective** restore is not: `pg_restore -t
rcm_claims` recreates the table without the function, and the CHECK cannot
resolve. Restore the whole schema, or create `rcm_is_review_reason` and
`rcm_are_review_reasons` first.

This is the accepted cost of a vocabulary CHECK that has to accept a
parameterised member (`uncertain_line:3`); the alternative was loosening the
constraint until it stopped being one.

## Rollback

`down` **refuses** rather than deleting. Claim-level adjustments have no service
line and would violate the restored `procedure_line_id NOT NULL`; an earlier
revision deleted them, under a header claiming nothing was destructive. It now
raises, names the count, and gives the query to inspect them. Export or delete
them deliberately, then roll back.

## Backwards compatibility

Every column is added nullable or with a default that matches what the old code already
meant, so existing rows keep their meaning:

- `allowed_source` defaults to `'derived'`, which is the honest read of every row written
  before this migration — they all were.
- `scope` defaults to `'line'`, which every existing adjustment is.
- `flags`, `remark_codes` default to `{}`.

**The two CHECK constraints are deliberately validating.** If a staging row already holds a
review reason outside the vocabulary, the migration FAILS rather than quietly accepting it
— an unknown value in that column is exactly the defect the CHECK exists to prevent.

**Rows Beau already created on staging do not need re-uploading, but they are not
re-parsed either.** Anything ingested before this migration keeps the numbers the old
parser produced: a claim whose deductible was reported at claim level still reads
`total_deductible_cents = 0`, and a line whose contractual reduction was taken under `OA`
still has an inflated allowed and a wrong `write_off_cents`. Re-uploading the same 835 is
refused by the remittance key, so **correcting a staging row means deleting the batch and
re-uploading**. Given staging holds only test fixtures today, the recommendation is to
leave them; before Slice 6c posts anything from a row created earlier, re-ingest it.

---

## What remains unhandled

Each with the file and function that would own it.

| Gap | Where it would live |
| --- | --- |
| **Capitation has no representation.** CARC 24 ("charges are covered under capitation") has a description but no entry in `CARC_TO_LINE_FLAG`, so a capitated line looks like an ordinary zero-paid one. There is no `capitated` line flag and no decision about whether such a line is postable at all | `eraParser.js` `CARC_TO_LINE_FLAG`; needs a vocabulary + migration addition |
| **PLB `FB` forward balance and `L6` interest are stored but never carried.** They are parsed into `rcm_payment_batches.plb_adjustments` and summed into `plb_total_cents`, and nothing reconciles them across checks. A forward balance is by definition money that belongs to the NEXT remittance | `eraParser.js` `parsePlb` reads them; the carry-forward belongs to Slice 8 (recon), against `rcm_payment_batches` |
| **A claim split across two checks produces two unlinked rows.** Each `CLP` becomes its own `rcm_claims` row; nothing notices that two of them share a `claim_number` and a patient. Slice 6 will match both to the same OD claim independently | `eraIngest.js` `writeClaim`; needs a claim-identity key, probably `(office_id, claim_number, patient, service_date)` |
| **The EOB path never populates `paid_code` or `adjustment_reason`.** The extraction schema has no field for either, so a downcode read from a PDF is invisible where the same downcode read from an 835 is flagged | `eobExtraction.js` `EOB_EXTRACTION_SCHEMA` and `normalizeExtraction` |
| **Scanned / image-only PDFs have no OCR path.** `extractPdfText` throws `NO_EXTRACTABLE_TEXT`. This is Part D of the slice brief and is a **separate PR** — see the note below | `eobDocumentText.js` `extractPdfText` |
| **Unreadable amounts store 0 rather than NULL** (see A4). Honest only because the flag rides alongside | the cents columns on `rcm_procedure_lines` / `rcm_claims` would need to become nullable |
| **A mis-declared component separator is not detected.** If a file declares `>` at `ISA16` but writes `:` in its data, A2 now correctly refuses to split and the procedure code comes out as `"AD:D0120"`. That is visibly broken rather than plausibly wrong — Slice 6's matcher will fail loudly on it — but nothing flags it at parse time | `eraParser.js` `parseServiceLines`, where the composite is split |
| **`quantity` on a claim-level adjustment is stored but meaningless.** X12 allows it; nothing reads it | `rcm_procedure_adjustments.quantity` |

---

## Blocking reasons versus annotating ones — **RATIFIED as D-11, Slice 6b**

> **STATUS: adopted.** The split below is implemented as
> `REASON_GATE` in `backend/services/rcm/rcmVocabulary.js` and documented in
> [RCM_APPROVAL_GATE.md §3](RCM_APPROVAL_GATE.md#3-d-11--blocking-reasons-versus-annotating-ones).
> `allowed_amount_mismatch` was ruled **annotating**, as recommended below.
>
> **One half was NOT adopted.** `eraIngest.batchStatusFor` still holds a batch at
> `open` when anything at all is flagged — see "Implementing it" at the end of
> this section. The gate decides what may be POSTED; `open` still means
> "something on this file was flagged", and changing what `ready` promises stayed
> a separate decision.
>
> The map also had to be EXTENDED beyond the lists below, which cover the ERA
> reasons and the remittance flags: the EOB review reasons and the line flags are
> vocabularies a proposal can also carry, and a reason absent from the map is
> blocking. `rcmVocabulary.test.js` asserts every member of all three appears.

`eraIngest.batchStatusFor` holds a batch at `open` if **any** flag or review
reason is present.

The principle: **a reason BLOCKS when acting on the proposal could move the
wrong amount of money, or money that should not move at all. It ANNOTATES when
it tells a biller something true that does not change what to post.**

### Measured, so the trade is visible

Counting remittances, current code versus the two variants below:

| | original 13 fixtures | all 21 fixtures (22 remittances) |
| --- | --- | --- |
| **Current** — every flag gates | **1 ready / 12 open** | 2 ready / 20 open |
| Split, `allowed_amount_mismatch` **blocks** | **2 ready / 11 open** | 7 ready / 15 open |
| Split, `allowed_amount_mismatch` **annotates** | **7 ready / 6 open** | 13 ready / 9 open |

**Fixing A3 did not improve the ready count at all** — the original 13 sit at
1 ready before and after. The whole of that number is
`allowed_amount_mismatch`, which fires on 7 of the 13 because of the corpus's
`AMT*B6` convention. So the gating question is very nearly a question about that
one reason, and the middle row shows a split that leaves it blocking barely
moves anything.

### Blocking — hold the batch at `open`

| Reason | Why it blocks |
| --- | --- |
| `reversal_not_postable` | A takeback. The negative-supplemental path is irreversible in Open Dental |
| `unreadable_amount` | A number we could not read; whatever it belonged to is wrong |
| `totals_unreconciled` | The sums are not trustworthy, by construction |
| `unparseable_cas` | Money in a CAS we could not account for |
| `partial_adjustment_segment` | Part of a segment lost — some money is unrepresented |
| `unstorable_adjustment_group` | An adjustment could not be stored at all |
| `line_total_mismatch` | Our lines do not reach the payer's own claim total |
| `patient_resp_mismatch` | Two numbers disagree about what the patient owes |
| `claim_line_allowed_mismatch` | Two numbers disagree about the allowed total |
| `claim_total_mismatch` | Claim payments do not reach the check total |
| `envelope_counts_mismatch`, `envelope_incomplete` | The file may be truncated; claims may be missing |
| `negative_total_payment` | The whole remittance is a takeback |
| `no_service_lines`, `no_claims_in_remittance` | Nothing to post, and the file says there should be |
| `secondary_payer_adjudication`, `prior_payer_payment_on_primary_claim` | COB: what the other payer already did changes what we should post |

### Annotating — true, useful, and not a reason to stop

| Reason | Why it does not block |
| --- | --- |
| `claim_level_adjustments_present` | Where the payer reported a deductible is a display fact. The amount is correct either way, and it reconciles against CLP05 or `patient_resp_mismatch` fires |
| `multi_transaction_file` | The file held several checks. Each became its own batch with its own key; nothing about any one is uncertain |
| `plb_adjustments_present` | Provider-level money is recorded and acted on by nobody in this slice. It does not make the CLAIMS wrong |
| `no_payment_made` | `BPR04 = NON` is a legitimate zero-dollar remittance (a full write-off, an applied-to-deductible). The claims are still correct |
| `procedure_downcoded` | The payer changed a code and we recorded both. A biller should see it; it does not make the money uncertain |
| `claim_denied` | A denial is a correct, complete adjudication with nothing to post. It belongs in a denial worklist, not behind a posting gate |

### The one I cannot decide alone: `allowed_amount_mismatch`

It is worth 5 of the 13 original fixtures on its own, so it decides whether this
split is worth doing.

**The case for annotating it.** Since A3, we always post the **derived** value.
The reported `AMT*B6` is explicitly *not* used for `write_off_cents`. So a
disagreement says the payer's file is internally inconsistent — it does not say
the number we would post is wrong. And the number we would post is already
guarded by `line_total_mismatch` and `claim_total_mismatch`, which check the
derived figures against the payer's own paid amounts.

**The case for blocking it.** A disagreement could also mean *we* misread the
CAS — an adjustment type we did not count as contractual would produce exactly
this signature. In that reading it is a warning about our own arithmetic, and
our arithmetic is what gets posted.

**My recommendation: annotate it**, because the specific disagreement we can see
in the corpus is the payer's convention rather than our misreading, and because
`line_total_mismatch` independently covers the case where our arithmetic is
actually wrong. But it is the weakest call in this list and I would rather you
made it — hence the third row of the table, so the cost of choosing either way
is a number rather than an argument.

### Implementing it

`batchStatusFor` consults a `BLOCKING` set rather than `length > 0`; the
annotating reasons still appear in the workbench, they just stop being gates.
The set belongs in `rcmVocabulary.js` next to the reasons themselves, with the
same drift test.

> **What Slice 6b actually did.** The set landed in `rcmVocabulary.js` with the
> drift test, as proposed — but it is consulted by the **approval gate** and the
> **workbench chip colour**, and NOT by `batchStatusFor`, which is unchanged. So
> `ready` still promises exactly what it promised in Slice 5, and the measured
> ready/open counts in the table above are still the CURRENT behaviour rather
> than a description of what shipped. Making `ready` mean "approvable" remains
> available as a follow-up, and is now a one-line change.

## Part D (OCR) is a separate PR

The slice addendum put OCR in scope and asked, first, whether the source app had an OCR
path that the port dropped. **It did not.** `rcm-posting @ master (9cebfc2)` has an
`OcrProvider` *interface* and a `StubOcrProvider` that throws unless a test pre-seeded it;
its own docs say wiring a real provider is "intentionally out of scope"; its `scanned-*.eob.txt`
fixtures are plain text standing in for post-OCR output, not images; no OCR SDK appears in
any branch's `package.json`; and `processEobFromBytes`, the byte-path entry point, is called
only from tests. So OCR is a **new build**, not a port regression.

That makes it larger than the rest of Part A combined — Azure Document Intelligence
provisioning, a second cost rail with its own daily counter and honest refusal, confidence
and provenance plumbed through to the workbench, and synthetic image-only fixtures produced
by rasterising a text EOB. It ships separately so the silent money defects above are not
held behind it. A usable module that stores wrong numbers is worse than a narrow one that
stores right ones.

The interaction the addendum flagged is real and is already handled on this side: A6 makes
over-length input a **refusal** rather than a silent truncation, and that refusal sits in
`extractPdfText` — the same function OCR will feed. OCR output is longer and noisier than a
text layer for the same page, so it will hit that limit more often, and it will hit the same
honest refusal.

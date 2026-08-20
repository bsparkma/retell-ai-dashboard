# Synthetic 835 (ERA) fixtures — RCM

13 X12 835 remittance files, copied **byte-for-byte** into this repo by RCM Slice 2. They are
test data and nothing else: no file here describes a real remittance, a real patient, or a
real payment.

## Provenance

| | |
| --- | --- |
| Source repo | `rcm-posting` @ `fix/prod-acr-registry-identity` (`9bf5ac8`) |
| Source path | `Test data-835-etc/` |
| Copied | 2026-08-14, RCM Slice 2 (`feature/rcm-slice2-fixtures`) |
| Verified synthetic | The 2026-08-14 hygiene pass over the source repo, which scanned blob **contents**, not just filenames |
| Modified? | **No.** SHA-256 verified identical to the source at copy time. |

**Do not "improve" these files.** They are a fixed corpus: Slice 5's `eraParser` tests will
assert parse output against them, so an edit here silently moves the goalposts of every parser
test. If a new scenario is needed, add a new file — never edit an existing one.

## Why they are safe to commit

- **Patient names are placeholders** — `SMITH SYNTHETIC`, `DOE JANE`, and a set of
  common-given/common-surname pairs (`JONES ROBERT`, `WILLIAMS SARAH`, …).
- **Member/subscriber ids are digit runs** — `123456789`, `987654321`, `456789012`, and the
  like. None is a real subscriber id.
- **Claim numbers, trace numbers, dates and amounts are invented.**
- The **payee** segments carry the practice's own business identity (practice name, NPI, tax
  id, service address) and the **rendering provider** is the repo owner. That is business
  identity, not PHI, and it is what makes these parse as real 835s.
- **Payer names are real carriers** (Guardian, Cigna, Delta Dental, Anthem, Aetna, Humana,
  Principal). A carrier name is not PHI, and payer-specific quirks are the whole point of the
  corpus.

Rows the **seeder** writes into the database use fully invented payer names instead — see
[`docs/RCM_FIXTURES.md`](../../../../docs/RCM_FIXTURES.md).

## The corpus

| File | Payer in the file | Scenario it exists to cover |
| --- | --- | --- |
| `Test_Minimal_835.edi` | MINIMAL PAYER | Smallest legal 835 — one claim, one line, no `CAS` at all |
| `Test_Guardian_Clean.edi` | Guardian | Clean multi-line payment; contractual write-offs only (`CO-45`) |
| `Test_Anthem_Deductible.edi` | Anthem BCBS Dental | Deductible per line (`PR-1`) alongside `CO-45` |
| `Test_Applied_To_Deductible.edi` | Delta Dental of Arkansas | **Whole claim to deductible** — every line pays 0, `PR-1` for the full billed amount |
| `Test_Principal_Major.edi` | Principal Financial Group | Major-services coinsurance (`PR-2`) plus deductible on the same claim |
| `Test_Cigna_Downcode.edi` | Cigna Dental Health | **Downcode** — `SVC` carries two procedure codes (`AD:D0150` and `AD:D0120`), `CO-4`. **Authored transposed — see below.** |
| `Test_Bundled_Downgraded.edi` | Aetna Dental | Downgrade (`D2740` / `D2791`) *and* bundling in one claim — `CO-B15`, `CO-97`, `CO-54`. **Authored transposed — see below.** |
| `Test_Denied_Claims.edi` | TEST INSURANCE COMPANY | **`CLP` status 4** (denied); every line zero-paid with denial CARCs `CO-18/29/31/50`, `PR-96` |
| `Test_Mixed_Adjustments.edi` | Humana Dental | Several CARC groups on one claim, and **decimal** dollar amounts (`892.50`) |
| `Test_Delta_Dental_MultiClaim.edi` | Delta Dental of Arkansas | One check spanning several `CLP`s — the payment-batch shape |
| `Test_Secondary_COB.edi` | Guardian | Secondary payer: `AMT*D` prior payment plus `OA-23` per line. (`CLP08` = `11` is the **facility type code**, not a COB sequence — an earlier revision of this row read it as one. `CLP02` = `1`, i.e. the file itself says "processed as primary" while reporting a prior payer's money; the parser surfaces that contradiction rather than resolving it.) |
| `Test_Reversal_Recoupment.edi` | Cigna Dental | **Reversal / takeback** — `CLP` status 22, negative `BPR` (`-285`), negative `SVC` paid amounts, `OA-72`. The negative-supplemental path |
| `Test_PLB_Adjustments.edi` | Principal Financial | **Provider Level Balance** — `PLB` with a `WO` write-off (`-50`) and an `L6` interest (`8`) |

Two things a parser must not assume, both visible above: amounts appear with **decimals** in
several files (dollars, not cents), and paid amounts can be **negative**.

### The two downcode files were authored with `SVC01`/`SVC06` transposed

X12 005010X221A1 defines **`SVC01` as the ADJUDICATED procedure code** and **`SVC06` as the
ORIGINAL SUBMITTED one**, present only when the payer changed it. Both files here are written
the other way round — the submitted code in `SVC01`, the downgraded one in `SVC06`:

```
Test_Cigna_Downcode.edi      SVC*AD:D0150*102*57***AD:D0120
Test_Bundled_Downgraded.edi  SVC*AD:D2740*1258*485***AD:D2791
```

An earlier revision of this table described them by the author's intent ("a paid code
`AD:D0120` different from the billed code `AD:D0150`"), which reads as a real dental
downgrade — a comprehensive exam downcoded to a periodic one, a porcelain crown downgraded
to full cast. That intent is clear, and it is not what the bytes say.

**PM ruling (Slice 5): the specification wins.** `eraParser` reads `SVC01` as adjudicated and
`SVC06` as original submitted, because real payer files follow X12 and Slice 6 posts money
against whichever code we recorded. So against these two files the parser reports:

| File | `billed_code` (SVC06) | `paid_code` (SVC01) |
| --- | --- | --- |
| `Test_Cigna_Downcode.edi` | `D0120` | `D0150` |
| `Test_Bundled_Downgraded.edi` | `D2791` | `D2740` |

— that is, **spec positions, not the original author's intent**, and the parser tests assert
exactly that. `isDowncoded` is symmetric (the two codes differ), so downcode DETECTION, the
`downcode` line flag and the `procedure_downcoded` review reason are correct either way; only
which column each code lands in is affected.

**The bytes stay frozen.** The corpus rule protects bytes, not authoring mistakes — editing
these files would silently move the goalposts of every parser test. A spec-conformant
downcode scenario is a **new file**, never an edit to these two.

## The Slice 5.5 corpus — eight files added

RCM Slice 5.5 hardened the parser against a class of defect worse than a crash: files that
parse successfully, reconcile arithmetically, and store the **wrong numbers** with no flag
raised. Every one of those defects needed a scenario the original 13 do not contain, and the
13 are frozen — so these are new files. Full write-up: [`docs/RCM_ERA_FIDELITY.md`](../../../../docs/RCM_ERA_FIDELITY.md).

| File | Scenario it exists to cover |
| --- | --- |
| `Test_Clean_Conformant.edi` | **The "nothing fires" baseline.** Fully conformant to 005010X221A1 — correct `SE01`, and `AMT*B6` carrying the ALLOWED amount. Parses with zero flags and zero review reasons |
| `Test_Caret_Delimiters.edi` | **A2** — declares `>` at `ISA16` and uses it in every composite (`SVC*AD>D0120`, `PLB*…*WO>OLDCLM777`). Before A2 the parser hardcoded `:` and stored `"AD>D0120"` as the procedure code |
| `Test_Claim_Level_CAS.edi` | **A1** — deductible reported at CLAIM level (a `CAS*PR*1*75` between the `CLP` and the first `SVC`), plus an `MOA` remark segment. Both were dropped entirely before 5.5 |
| `Test_Reported_Allowed.edi` | **A3** — one line takes its contractual reduction under `OA` (not `CO`); one line's `AMT*B6` disagrees with the derived allowed |
| `Test_Malformed_Amounts.edi` | **A4** — `BPR*I*1,250.00` and `CAS*CO*45*250USD`. `parseFloat("1,250.00")` is `1`, so this file used to store **$1.00 where $1,250.00 belonged** |
| `Test_Gapped_Segments.edi` | **A5** — a `CAS` with an empty triple mid-segment (`CAS*PR*1*50*****2*40`) and a `PLB` with an empty pair. Both used to `break` and lose everything after the gap |
| `Test_Truncated_Envelope.edi` | **B3** — `SE01` declares 40 segments and `GE01` declares 2 transaction sets; the file contains one much shorter set. What a cut transmission looks like |
| `Test_MultiCheck_TwoST.edi` | **B4** — two `ST`/`SE` transaction sets, i.e. two checks with their own `BPR`, `TRN` and remittance key. Multi-ST shipped in Slice 5 with zero coverage |

All eight were generated to the rules above: placeholder names (`SYNTHETIC ALPHA` … `SYNTHETIC INDIA`),
digit-run member ids, invented claim and trace numbers, invented amounts. The generator lives in
the Slice 5.5 PR description rather than the repo — these are fixtures, not build output.

### Two things Slice 5.5 measured about the ORIGINAL 13

Both are authoring inconsistencies in the corpus, not parser bugs, and both now cause flags to
fire on files that used to look clean. They are recorded here because a future reader will
otherwise think the parser regressed.

**`AMT*B6` is used inconsistently.** In 005010X221A1, loop 2110 `AMT` with qualifier `B6` is
*"Allowed — Actual"*. Across the corpus's 37 `AMT*B6` lines:

| What the value equals | Lines |
| --- | --- |
| the **billed** amount (not what B6 means) | 25 |
| billed − contractual, i.e. the allowed amount | 10 |
| neither | 2 |

Since A3 reads `AMT*B6` and flags a disagreement with the derived allowed, **7 of the 13 files
now raise `allowed_amount_mismatch`** — including `Test_Guardian_Clean.edi`, which is why the
"clean baseline" test moved to `Test_Clean_Conformant.edi`. The flag is correct; the data is
inconsistent.

**Five files declare a wrong `SE01`.** Counting `ST` through `SE` inclusive, as X12 requires:

| File | `SE01` says | Actually |
| --- | --- | --- |
| `Test_Applied_To_Deductible.edi` | 43 | 46 |
| `Test_Bundled_Downgraded.edi` | 41 | 43 |
| `Test_Denied_Claims.edi` | 42 | 44 |
| `Test_Reversal_Recoupment.edi` | 32 | 33 |
| `Test_Secondary_COB.edi` | 48 | 51 |

Those five now raise `envelope_counts_mismatch` — again correctly. B3 exists because a
**truncated** 835 that still contains a valid `BPR` and some `CLP`s used to parse and ingest as
if complete, and a file disagreeing with its own segment count is exactly that signal.

**Neither finding justifies editing a fixture.** The corpus rule protects bytes, and these are
authoring mistakes rather than corruption — the same ruling the PM gave on the transposed
`SVC01`/`SVC06` files in Slice 5. If a conformant version of one of these scenarios is ever
needed, it is a NEW file.

## Consumers

- **Slice 5.5** — the eight files above pin one defect class each; the assertions live in
  `backend/services/rcm/eraParser.test.js` under "the silent money defects".
- **Slice 5** — `eraParser` unit tests parse every file here and assert the extracted claims,
  service lines, `CAS` adjustments, `TRN` trace, and `PLB` totals.
- **Slice 2** — the seeder does **not** read these files. It writes an authored row graph
  directly ([`backend/scripts/rcm-seed-fixtures.cjs`](../../../scripts/rcm-seed-fixtures.cjs)).
  The two fixture layers are independent on purpose, so a parser change cannot alter what the
  seeder writes.

## The EOB PDFs are a separate corpus

[`eob/`](eob/) holds three synthetic **PDF** fixtures for the OCR pre-step — a text-layer
EOB, a rasterised "scan" of the same page, and a deliberately degraded copy — plus the
script that generates them and the confidence numbers Azure actually returned for each. They
are unrelated to the 835 files above and are documented in [`eob/README.md`](eob/README.md).

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

## Consumers

- **Slice 5** — `eraParser` unit tests parse every file here and assert the extracted claims,
  service lines, `CAS` adjustments, `TRN` trace, and `PLB` totals.
- **Slice 2** — the seeder does **not** read these files. It writes an authored row graph
  directly ([`backend/scripts/rcm-seed-fixtures.cjs`](../../../scripts/rcm-seed-fixtures.cjs)).
  The two fixture layers are independent on purpose, so a parser change cannot alter what the
  seeder writes.

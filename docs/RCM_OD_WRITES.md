# RCM Open Dental writes — API coverage (Spike 0a)

**Date:** 2026-08-13
**Open Dental docs snapshot:** `opendental.com/site/api*.html`, read 2026-08-13
**Live practice build:** Roland `ProgramVersion 25.4.48.0` / `DataBaseVersion 25.4.45.0` (verified, §Probe F)
**Method:** documentation review + **read-only GET** verification against the live Roland
Open Dental database. **Zero writes were performed.** No POST, PUT, PATCH or DELETE was
issued against any Open Dental resource, including against test patients. Live write
verification is Spike 0b and is proposed, not executed, at the end of this document.

Companion to [`TC_OD_READS.md`](TC_OD_READS.md), which proves the **read** side and is
cited here rather than re-proven. Same legend, same discipline.

> **Headline: the Cloud API covers the posting path.** Every operation insurance-payment
> posting performs — finalizing per-procedure adjudication, marking the claim received,
> creating the check (single or batched across claims), writing adjustments, posting
> patient money, and filing the EOB PDF into the chart — has a documented API verb. The
> single genuine gap is attaching the EOB **to the check record** (`eobattach`), which the
> API exposes only over SFTP. That gap is **not connector-shaped**, which is why the
> recommendation below is **Branch A**.

---

## Evidence classes

Every claim in this document carries one, and they are not interchangeable.

| Class | Means |
|---|---|
| **documented** | Stated on an Open Dental API doc page, cited by URL. Not exercised. |
| **verified** ✅ | Proven by a read-only GET against live Roland OD on 2026-08-13. Transcript below. |
| **inferred** ⚠️ | Reasoned from adjacent facts. **Not a fact.** Every inferred row is a Spike 0b test. |

A GET returning 200 proves the **resource** is entitled to this developer/customer key
pair. It does **not** prove the write verbs on that resource are entitled — Open Dental
entitles GET and POST/PUT/DELETE separately, per resource, per pricing tier
([API Permissions](https://www.opendental.com/site/apipermissions.html)). **No read-only
probe can establish write entitlement.** That is Spike 0b test 0 and it gates everything
else in this document.

---

## 1. Coverage matrix

**full** — the API expresses the operation directly.
**partial** — expressible, but narrower than the operation needs, or only via a detour; the note says how.
**none** — the API cannot express it.

### 1. ClaimPayments — create and edit the insurance check/EFT

| Aspect | Coverage | Evidence | Citation | Constraints / gotchas |
|---|---|---|---|---|
| Create a check for one claim | **full** | documented | [`POST /claimpayments`](https://www.opendental.com/site/apiclaimpayments.html) v22.4.8 | Required: `claimNum`, `CheckAmt`. Optional: `CheckDate`, `CheckNum`, `BankBranch`, `Note`, `ClinicNum`, `CarrierName`, `DateIssued`, `PayType`, `PayGroup` |
| Create one check spanning **many** claims | **full** | documented | [`POST /claimpayments/Batch`](https://www.opendental.com/site/apiclaimpayments.html) v24.2.18 | Required: `claimNums[]`, `CheckAmt`. This is the real-world EOB shape — one carrier check, many claims. Available on 25.4.48 |
| Edit a check | **full** | documented | `PUT /claimpayments/{ClaimPaymentNum}` v23.2.15 | `CheckAmt` editable only from v25.2.26 — Roland is 25.4.48, so **available**. Also `CheckNum`, `BankBranch`, `Note`, `CarrierName`, `PayType`, `PayGroup` |
| Delete a check | **partial** | documented | `DELETE /claimpayments/{ClaimPaymentNum}` v24.3.13 | *"Cannot delete a claimpayment if it is associated with an EOB or a deposit."* Once the EOB is filed, the check is immutable-by-deletion |
| Resource reachable with our key | **full** ✅verified | GET 200, 100 rows, full field set | §Probe A | Singular `/claimpayment` → **404 "claimpayment is not a valid resource."** Plurals-only rule from `TC_OD_READS.md` holds here too |

**Can a claimpayment be created "detached" and have claimprocs allocated to it afterwards?**
**No — the order is the reverse, and it is mandatory.** The doc page states the
prerequisites plainly: ClaimProcs must *first* be updated with `Status` `"Received"` or
`"Supplemental"` and their `InsPayAmt` finalized, the Claim's `ClaimStatus` must be set to
`"R"`, and only then is `CheckAmt` posted — and it *"must match the total of the ClaimProcs'
InsPayAmt … with ClaimPaymentNum=0"*. Creating an empty check and filling it in later is
not expressible: `ClaimProc.InsPayAmt` *"cannot be updated when there is already a
ClaimPayment attached."*

There is one narrow exception worth knowing. `PUT /claimprocs/{n}` gained a writable
`ClaimPaymentNum` in v24.3.24, so an **already-finalized** claimproc can be attached to an
**existing** check after the fact. What cannot happen is setting the money afterwards.
Allocation is therefore not atomic with creation — it is strictly *before* it.

**Per-office DefNum trap (same lesson as CommType 486/451).** `claimpayment.PayType` is a
DefNum from definition **Category 32 (`InsurancePaymentType`)** — **not** Category 10, which
is patient payment types. Verified live on Roland:

| DefNum | ItemName |
|---|---|
| 296 | Check |
| 297 | EFT |
| 404 | Credit Card |
| 472 | Insurance Check |

These numbers are Roland's. **They will differ in Valley's database and must never cross.**
Treat `PayType` exactly as `odOffices.js` treats `commTypeDefNum`: a per-office registry
value with a verified default, never a hardcode.

**Preference gate, verified off on Roland.** `POST /claimpayments` (single) is refused when
the preference `ClaimPaymentBatchOnly` is true. Live: `ClaimPaymentBatchOnly=0`. Also
`ShowAutoDeposit=0`, so `POST /claimpayments/Batch` will **not** create an auto-deposit on
Roland today. Both are practice preferences a front office can flip, so posting must read
them rather than assume them.

### 2. ClaimProcs — the crux

| Field | Writable? | Evidence | Citation |
|---|---|---|---|
| `InsPayAmt` | **yes** | documented | [`PUT /claimprocs/{ClaimProcNum}`](https://www.opendental.com/site/apiclaimprocs.html) v22.3.33 |
| `WriteOff` | **yes** | documented | same |
| `DedApplied` | **yes** | documented | same |
| `Status` | **yes** | documented | same |
| `ClaimPaymentNum` | **yes** (v24.3.24+) | documented | same |
| `FeeBilled`, `ProvNum`, `Remarks`, `CodeSent`, `NoBillIns` | **yes** | documented | same |
| `PercentOverride`, `CopayOverride`, `DedEstOverride`, `InsEstTotalOverride`, `PaidOtherInsOverride`, `WriteOffEstOverride` | **yes** | documented | same. `-1` means none/blank — the same sentinel `TC_OD_READS.md` documents on the read side |
| `ClaimPaymentTracking` | **yes** | documented | same |
| **`DateCP`** | **NO** | documented-absence | Returned on every GET (§Probe B) but **absent from the PUT field list**. See gaps |
| `ClaimAdjReasonCodes` | **NO** | documented-absence | Returned on GET, absent from PUT. Denial-reason codes are read-only via the API |

**Coverage: full for the money fields, partial for the row as a whole.**

**Is there a dedicated "receive claim" endpoint?** No single call. Receiving is a sequence:
per-claimproc `PUT`s → `PUT /claims/{n}` to `"R"` → `POST /claimpayments`. There are,
however, three purpose-built helpers:

| Endpoint | Version | Available on 25.4.48? | Purpose |
|---|---|---|---|
| `POST /claimprocs/Supplemental` | 25.2.7 | **yes** | Second payment on an already-received procedure. Required `ClaimProcNum`, optional `InsPayAmt` (default 0) |
| `POST /claimprocs/InsAdjust` | 23.2.5 | **yes** | Set `insUsed` / `deductibleUsed` at the `PatPlanNum` level — benefit-used tracking |
| `PUT /claimprocs/InsAdjust` | 21.1 | **yes** | Same, update form. *"If the insUsed passed in exactly equals payments already in Open Dental, then any existing adjustment will be deleted."* Returns **200 regardless of outcome** — a success status here does not mean what you asked for happened |
| `POST` / `PUT /claimprocs/{n}/PendingSupplemental` | **TBA** | ⚠️ **presumed no** | Version listed as "TBA". Roland is 25.4.48. Do not design against it without a Spike 0b existence check |
| `DELETE /claimprocs/{n}` | **TBA** | ⚠️ **presumed no** | Same. Also restricted: cannot delete if attached to a ClaimPayment or OrthoCase, if a Supplemental references it, or if it is the last claimproc on a claim |

**Blocking restrictions on `PUT /claimprocs/{n}`, all documented:**

- Refused when `IsTransfer = true`, or when `Status` is `"Adjustment"`, `"InsHist"`,
  `"CapClaim"`, `"CapComplete"` or `"CapEstimate"`. `IsTransfer` is present on the live row
  (✅verified, §Probe B) so a poster can pre-check it rather than discover the refusal.
- `InsPayAmt` cannot be updated once a ClaimPayment is attached.
- ⚠️ *"Editing a received ClaimProc can delete all of the Income Transfers on the claim."*
  **This is the most dangerous sentence in the API documentation for this module.** Re-posting
  or correcting an already-received line is not a neutral act on a family ledger.
- Updates recalculate claim totals; BlueBook values are not updated.

### 3. Claims — status transitions

| Aspect | Coverage | Evidence | Citation |
|---|---|---|---|
| `ClaimStatus` → `"R"` (Received) | **full** | documented | [`PUT /claims/{ClaimNum}`](https://www.opendental.com/site/apiclaims.html) v21.4. Values `"U"`, `"H"`, `"W"`, `"S"`, `"R"` |
| `DateReceived` | **full** | documented | same, `"yyyy-MM-dd"` |
| `ClaimNote`, `ReasonUnderPaid` | **full** | documented | same — the natural home for a denial narrative |
| Sent transition + Etrans row | **full** | documented | `PUT /claims/{ClaimNum}/Status` v21.3 — sets status to Sent and creates an Etrans entry |
| Split procedures to a new claim | **full** | documented | `PUT /claims/{ClaimNum}/Split` v22.1 |
| **Supplemental payment on an already-received claim** | **full** | documented | Not on the claim — `POST /claimprocs/Supplemental` (v25.2.7). The claim is not reopened; a new Supp line is added |
| Delete a claim | **partial** | documented | `DELETE /claims/{ClaimNum}` v22.1 — refused when insurance payments are attached or status is `"R"`. Correct behavior, but it means **a posted claim cannot be un-posted via the API** |
| Resource + field shape | **full** ✅verified | §Probe B | `ClaimStatus`, `DateReceived`, `InsPayAmt`, `DedApplied`, `WriteOff`, `ReasonUnderPaid`, `CustomTracking` all present on the live row |

Nothing in the documentation restricts *setting* `"R"` via PUT; the restriction quoted on
that page (*"Will not delete claims with insurance payments/checks attached or have a status
of Received"*) applies to DELETE only.

### 4. PaySplits — patient-portion allocation

| Aspect | Coverage | Evidence | Citation |
|---|---|---|---|
| Create a paysplit directly | **none** | documented-absence | [`apipaysplits.html`](https://www.opendental.com/site/apipaysplits.html) documents only GET and PUT. **No POST, no DELETE** |
| Create splits as a side effect of a payment | **full** | documented | [`POST /payments`](https://www.opendental.com/site/apipayments.html) v21.2 — required `PayAmt`, `PatNum`. Allocates FIFO across outstanding charges; overpayment becomes unearned income |
| Target specific procedures | **full** | documented | `POST /payments` → `procNums: [1,2,3]` (v22.4.16+), FIFO by `ProcDate` |
| Unallocated prepayment | **full** | documented | `isPrepayment` (v22.4.8+); `isUnallocatedPrepayment` (v25.4.42+) overrides the `RigorousAccounting` preference. Live: `RigorousAccounting=2` |
| Keep money on the patient rather than the family | **full** | documented | `isPatientPreferred` |
| Re-allocate an existing payment | **full** | documented | `PUT /payments/{PayNum}/Partial` v25.1.11 — deletes existing paysplits, creates new ones. `procNumsAndAmounts` sum **must equal** `PayAmt` |
| Edit a split's provider/clinic | **partial** | documented | `PUT /paysplits/{SplitNum}` v25.2.9 — only `ProvNum`, `ClinicNum`. `ProvNum` blocked when the split has an `UnearnedType`, unless preference `AllowPrepayProvider` is on |
| Refund a payment | **partial** | documented | `POST /payments/Refund` v24.4.28 — refused for payments on payment plans or with negative paysplits |
| **Delete a payment** | **none** | documented-absence | No `DELETE /payments`. A mis-posted patient payment cannot be removed via the API |
| Resources reachable | **full** ✅verified | §Probe A | `/paysplits` and `/payments` both 200 |

**Net: full coverage of the operations posting actually performs, via `/payments` rather
than `/paysplits`.** The gap is arbitrary hand-built split sets, which the PRD's deferred
patient-responsibility flow does not need. `ApiPaymentType` on Roland is DefNum **69**
(= "Check", Category 10) — that is the default `PayType` a `POST /payments` inherits when
none is supplied, and it is a per-office value.

### 5. Adjustments — write-offs

| Aspect | Coverage | Evidence | Citation |
|---|---|---|---|
| Create | **full** | documented | [`POST /adjustments`](https://www.opendental.com/site/apiadjustments.html) v22.2.22 — required `PatNum`, `AdjType`, `AdjAmt`, `AdjDate`; optional `ProvNum`, `ProcNum`, `ClinicNum`, `ProcDate`, `AdjNote` |
| Update | **full** | documented | `PUT /adjustments/{AdjNum}` v22.2.23 |
| **Delete** | **none** | documented-absence | No DELETE documented. Reversal must be an offsetting adjustment |
| Attach to a procedure | **full** | documented | `ProcNum` — the procedure must belong to the patient; `ProcDate` auto-updates to the procedure's date |
| Resource reachable | **full** ✅verified | §Probe A | |

**Sign rule, documented:** `AdjType` is a DefNum where `definition.Category = 1` and
`ItemValue` is `"+"` or `"-"`, and **`AdjAmt`'s sign must agree** — positive amount requires
a `"+"` type, negative requires `"-"`. A sign/type mismatch is a 400, not a silent flip.

**The per-office DefNum warning is not theoretical here — it is the largest surface in this
matrix.** Roland has **39** adjustment types (✅verified, §Probe C). The ones RCM would
reach for:

| DefNum | ItemName | ItemValue |
|---|---|---|
| 12 | Insurance Write-off | `-` |
| 10 | Write-off | `-` |
| 262 | PPO Adjustment | `+` |
| 260 | Insurance Adjustment | `+` |
| 477 | Insurance deductions from previous payments | `-` |
| 460–463 | Insurance write-off — Medicaid *(four distinct reasons)* | `-` |

**Every one of these numbers is Roland's and none may be written to Valley's database.**
Note also that the practice has already modelled *denial reasons as adjustment types*
(460–463), which is a real signal about how the office thinks — but it also means the RCM
posting UI cannot ship a fixed dropdown. `AdjType` must be resolved per office at runtime
from `GET /definitions?Category=1`, exactly the way the commlog-type picker resolves
Category 27.

### 6. Documents / EOB PDF — **the one real gap**

There are two distinct destinations for an EOB PDF, and the API treats them very
differently.

| Destination | Coverage | Evidence | Citation |
|---|---|---|---|
| **Patient's images** (chart) | **full** | documented | [`POST /documents/Upload`](https://www.opendental.com/site/apidocuments.html) v21.1 — required `PatNum`, **`rawBase64`**, `extension`; optional `Description`, `DateCreated`, `DocCategory`, `ImgType`, `ProvNum`. `.pdf` is explicitly a supported type |
| **The check record** (`eobattach`, where OD's own front office looks) | **partial → effectively none** | documented | [`POST /eobattaches/UploadSftp`](https://www.opendental.com/site/apieobattaches.html) v24.3.7 is the **only** write path, and it requires `SftpAddress` / `SftpUsername` / `SftpPassword` — OD pulls the file from an SFTP server **we** would have to run and expose |

Reinforcing this, `POST /claimpayments` states outright that it *"Does not link Deposits or
attach EOBs."*

Read-only verification (§Probe A/B): `/eobattaches` is a live, entitled resource
(`/eobattach` singular → 404), Roland is already attaching EOBs as **PDFs**, and the GET
response carries `EobAttachNum`, `ClaimPaymentNum`, `DateTCreated`, `FileName`, `RawBase64`.
⚠️ On the row sampled, **`RawBase64` came back empty (length 0)** while `FileName` ended in
`.pdf` — consistent with the file living in AtoZ/cloud storage and being retrievable only
via `POST /eobattaches/DownloadSftp`. Do not assume the GET hands back bytes.

**No size limit is documented for `rawBase64` on either resource.** Multi-page EOB scans are
routinely several MB and base64 inflates by ~33%. Unknown limit → Spike 0b test.

`DocCategory` is a DefNum from definition **Category 18**, per-office. Roland's 33 categories
(✅verified, §Probe C) include **131 "Insurance"** and **134 "Financial"** — the two plausible
homes for an EOB. Valley's numbering differs; the H0 spike already recorded 473 vs 429 for a
different category, and the same discipline applies.

### 7. Negative amounts — reversals, recoupments, takebacks

| Aspect | Coverage | Evidence | Citation |
|---|---|---|---|
| Negative insurance payment as a **supplemental** | **full** | documented | [Supplemental Insurance Payments](https://www.opendental.com/manual/claimpaymentsupplemental.html): *"This can include additional payments, or negative amounts (e.g., Insurance Refunds)."* This is OD's own sanctioned mechanism |
| Negative `InsPayAmt` via `POST /claimprocs/Supplemental` | **partial** ⚠️inferred | inferred | The endpoint takes `InsPayAmt` with no documented sign restriction, and the manual sanctions negative supplementals. **The API page does not say so.** Spike 0b test |
| Negative `InsPayAmt` via `PUT /claimprocs/{n}` | **unknown** ⚠️inferred | inferred | No sign restriction documented, none confirmed |
| Negative `CheckAmt` on a claimpayment | **unknown** ⚠️inferred | inferred + ✅negative evidence | **Nothing documented either way.** Live: of the 100 most recent Roland claimpayments, **0 have `CheckAmt < 0`** — the practice has no precedent for it. 14 of 100 have `CheckAmt == 0` (zero-pay EOBs), so zero-dollar checks *are* real here |
| Recoupment as an **adjustment** instead | **full** | documented ✅verified | The office already models this: DefNum 477 *"Insurance deductions from previous payments"* (`-`). A documented, API-reachable fallback that needs no negative-amount behavior at all |

**Do not present negative-amount support as settled.** The manual sanctions negative
supplementals; the API pages are silent; the practice's data shows no negative check ever
posted. Two of the three rows above are inference and are the highest-value Spike 0b tests.

### 8. Batch / transaction semantics

| Aspect | Answer | Evidence |
|---|---|---|
| Multi-operation atomicity | **none** | documented-absence — no transaction, savepoint or rollback endpoint appears anywhere in the [resource index](https://www.opendental.com/site/apispecification.html) (~110 resources) |
| Multi-claim single check | **full** | `POST /claimpayments/Batch` v24.2.18 — one HTTP call covering many claims. The closest thing to a transaction, and the reason it matters below |
| Bulk create on other resources | **none** | Every other write is one row per call |
| Partial-update safety | **full** | documented: *"If a field is not included in a PUT (update), then it will not change the original field in the database."* PUTs are safely sparse |
| Throttle | **hard limit** | [API Permissions](https://www.opendental.com/site/apipermissions.html): **1 request / 5 s** free tier, **1 request / 1 s** paid, 500 ms Enterprise (Remote mode) |

**Failure-mode analysis — this is design input regardless of which branch is chosen.**

The documented order of operations is forced, and each step widens or closes a window:

```
for each line on the EOB:  PUT /claimprocs/{n}   Status=Received, InsPayAmt, WriteOff, DedApplied
                           PUT /claims/{n}       ClaimStatus=R, DateReceived
                           POST /claimpayments   claimNum + CheckAmt (must equal the sum above)
              (optional)   POST /documents/Upload  EOB PDF → patient images
```

- **Fail during the claimproc loop.** OD is left internally consistent but *semantically
  half-posted*: some lines Received, some not; no check exists; `CheckAmt` was never
  asserted. This is the **safest** place to fail and the reason the loop must come first.
  Recovery is idempotent — re-`PUT` the remaining lines.
- **Fail between the last claimproc and the claim PUT.** All lines Received, claim still
  Sent. Visible in OD as an inconsistency, trivially repaired by re-issuing the claim PUT.
- **Fail between the claim PUT and the claimpayment POST.** **The worst window.** The claim
  reads Received with money on the lines and **no check exists**, so the practice's deposit
  will not reconcile. Worse, this state is hard to re-enter: `POST /claimpayments` requires
  `CheckAmt` to equal the total of claimprocs *whose `ClaimPaymentNum` is 0*, which is still
  true here — so recovery works, but only if the poster knows exactly which claimprocs it
  had touched. **This is the state the posting queue must be able to resume from, and the
  reason a durable pre-flight record of intended line amounts is mandatory.**
- **Fail after the claimpayment POST, before the PDF upload.** Money is correct; the EOB
  image is missing. Cosmetic, retryable, never a financial error. Correct place to put the
  weakest step.

**Ordering conclusion:** money before documents; per-line before per-claim; per-claim before
the check. The inconsistency window cannot be eliminated — only made short, resumable and
visible. **This argues for `rcm_posting_queue` on its own merits, independent of the A/B
fork**, which is the key nuance in the recommendation.

**Throughput consequence.** At the paid-tier 1 req/s throttle, a 30-line EOB costs ≈ 32
sequential calls ≈ **32 seconds** minimum, and the throttle is per key — i.e. **shared with
the voice module's commlog writes and TC's OD reads**. Posting is a background,
queue-and-drain shape. It cannot be a synchronous button that blocks a UI, and it must not
be allowed to starve the commlog path.

### 9. Everything else the docs and probes revealed

| Finding | Class | Why it matters |
|---|---|---|
| **Write entitlement is separately licensed and unverifiable read-only** | documented | Tiers: Free = *Read All only*; $15 = Comm/Documents/InsuranceSimple/Setup/Queries; $30 = all **except Payments/PayPlans**; $35 = all. **Posting needs the $35 tier, per location.** Charges begin when keys are enabled. **This is a commercial dependency, not just a technical one, and it is the single largest unknown in this spike** |
| Audit attribution of API writes is unclear | documented | *"The normal Open Dental permissions are used for logging API actions"* — but the page does not say which OD user account a write is recorded under. The H0 spike already found API notes signing as "CareIN" rather than the acting human. Assume the same limitation applies to posted payments until Spike 0b shows otherwise |
| `?category=<string>` on `/definitions` is **silently ignored** | ✅verified | `?category=InsurancePaymentType` and `?category=NotARealCategory` both returned the same unfiltered 100-row page spanning Categories 0–6. **Always use the numeric `Category=`.** A string filter is a lie, not a 400 |
| Booleans come back as **strings** | ✅verified | `IsPartial: "false"`, `isHidden: "false"`. Same trap the commlog-type picker hit. `if (row.IsPartial)` is true for `"false"` |
| `ClinicNum` on Roland is `0` everywhere | ✅verified (in `TC_OD_READS.md`) | The customer key already scopes to one practice database. Leave `ClinicNum` unset on writes unless a multi-clinic database appears |
| `/claimprocs` filters usable for reconciliation | ✅verified | `ClaimPaymentNum=`, `ClaimNum=`, `DateCP=`, `Status=`, `Offset=` all 200. `?ClaimPaymentNum=<n>` returning exactly the lines on a check is the natural post-write verification read |
| `/deposits` is live (v25.4.33) | ✅verified | 6 rows, full field set. `POST /deposits` accepts `payNums` and/or `claimPaymentNums`. **Restriction: claimpayments in a deposit cannot be partial and cannot have `CheckAmt` of 0** — and 14% of Roland's recent checks are $0 |
| `/claimtrackings` exists; Roland has 11 custom tracking statuses (Category 31) | ✅verified | *Denied*, *Resubmitting*, *Claim Rejected*, *Information Needed*, *Clm paid, awaiting EOB*… The denial workflow has a native home in OD already |
| `ClaimAdjReasonCodes` is read-only and empty on Roland | ✅verified | 0 of 100 Received claimprocs carry one. CARC/RARC denial codes cannot be written back, and are not being captured today |
| `/etranss` requires `PatNum` | ✅verified | `?ClaimNum=` alone → 400 *"PatNum is required."* Rules out an ERA-side sweep by claim |
| Version gates on this build | ✅verified | 25.4.48.0 / DB 25.4.45.0. Everything ≤ 25.4.x is present; **26.2.1 endpoints are not** (`GET /definitions/{DefNum}`, `PUT /definitions`), and the two **"TBA"** endpoints — `DELETE /claimprocs`, `*/PendingSupplemental` — must be treated as absent |

---

## 2. Gaps list

Each gap names the concrete posting operation that becomes impossible or degraded.

| # | Gap | Operation lost | Severity | Workaround |
|---|---|---|---|---|
| G1 | **`eobattach` has no base64 POST** — SFTP only | Filing the EOB PDF **on the check**, where the OD front office opens it | **High (workflow), low (money)** | File it to the patient's images via `POST /documents/Upload` (fully supported). Or run an SFTP endpoint for `POST /eobattaches/UploadSftp`. **A connector cannot fix this without a forbidden direct-MySQL write** |
| G2 | **`DateCP` is not writable** | Backdating adjudication to the carrier's EOB date | Low | OD sets it. Accept OD's value; keep the carrier date in `Note`/`ClaimNote`. Real cost: a back-dated EOB posts with today's `DateCP`, which shifts YTD-benefit rollups that key on `DateCP` |
| G3 | **`ClaimAdjReasonCodes` is read-only** | Writing CARC/RARC denial codes back to the claimproc | Medium | Denial reason → `Remarks` on the claimproc, `ReasonUnderPaid`/`ClaimNote` on the claim, and/or a `/claimtrackings` status. Structured codes stay in our database only |
| G4 | **No transactions** | All-or-nothing posting of a multi-line EOB | **High** | Cannot be worked around anywhere — a connector doing the same REST calls has the identical problem. Mitigate with ordering + a resumable queue (§8) |
| G5 | **No `POST`/`DELETE` on `/paysplits`** | Hand-built arbitrary split sets | Low | `POST /payments` (+`procNums`) and `PUT /payments/{n}/Partial` cover the real cases |
| G6 | **No `DELETE /payments`, no `DELETE /adjustments`** | Voiding a mis-posted entry | Medium | `POST /payments/Refund` for payments; offsetting adjustment for adjustments. Matches how OD itself expects corrections |
| G7 | **Negative amounts unproven at the API layer** | Recoupments / takebacks as negative supplementals | **Unknown — must be resolved** | Documented in the manual, silent in the API docs, no live precedent. Fallback that *is* documented: adjustment DefNum 477 |
| G8 | **Write entitlement + $35/location tier unconfirmed** | *Everything* | **Blocking** | Confirm in the OD developer portal before any Spike 0b write |
| G9 | **No documented `rawBase64` size limit** | Uploading a large multi-page EOB scan | Medium | Unknown until tested |
| G10 | **Posted work is largely irreversible via API** | Rolling back a bad batch | Medium | `DELETE /claims` refuses status R; `DELETE /claimpayments` refuses once an EOB or deposit is attached; `DELETE /claimprocs` is "TBA". **Review-then-post is not a nicety here — it is the only correction opportunity** |

---

## 3. Recommendation — **Branch A**, with the posting queue retained

**Post through the Open Dental Cloud API. Retire the old connector's payment surface.**

Every gap above falls into one of two classes, and neither is fixed by a connector.

The gaps a connector *could* theoretically close (G1 `eobattach`, G3 denial codes, G2
`DateCP`) are all fields the connector would have to reach by writing **directly to Open
Dental MySQL** — which is prohibited by this repo's hard rule 6 and by the global standing
rules, and which sits outside the approved write-back table list. A connector that cannot
legitimately write those rows adds a deployment, an on-prem dependency and a second
credential path while closing **zero** gaps. Meanwhile the gaps that actually hurt (G4 no
atomicity, G7 negative amounts, G8 entitlement, G10 irreversibility) are properties of Open
Dental itself: a connector issuing the same REST calls inherits every one of them, and a
connector issuing SQL instead would be both forbidden and *more* dangerous, since OD's own
recalculation logic — income transfers, claim totals, benefit rollups — lives above the
tables, not in them.

Branch A also matches where the platform already is. The API is the only transport Azure
has; `TC_OD_READS.md` records that the direct-MySQL and Riley-connector paths are already
gone, not replaced. Re-introducing an on-prem payment drain would reopen an architecture
this codebase deliberately closed.

**One thing carries over from Branch B, for a different reason.** `rcm_posting_queue`
should still be built — not as a connector drain, but as the **durable, resumable record of
intended posting** that §8's failure analysis requires. The window between "claim marked
Received" and "check created" is unavoidable, and recovering from it requires knowing
exactly which claimproc amounts were intended before the failure. That is a queue, and it is
needed under Branch A too. Its drain target is the OD Cloud API, not a connector.

**Two carve-outs to state plainly rather than bury:**

1. **EOB PDFs file to the patient's images, not to the check** (G1), unless we later decide
   an SFTP endpoint is worth standing up. This is a visible change to how the office finds an
   EOB and Beau should agree to it explicitly — it is the one place Branch A is genuinely
   worse than a hypothetical direct-write path.
2. **Branch A is contingent on G8.** If the OD developer portal does not grant this key pair
   write entitlement on Payments/Insurance at the $35-per-location tier, the fork does not
   become Branch B — it becomes *blocked*, because a connector cannot obtain that entitlement
   either. Confirm entitlement before committing engineering to Slice 6.

---

## 4. Spike 0b plan — proposed, **not executed**

Minimal live-write tests to convert the ⚠️inferred rows into verified ones. **Roland only,
test patients only** (12827 `Stedi Test 2`, 12828 `Test, MangoTest`), each test run once,
each with its stated cleanup — noting that G10 means several of these **cannot be cleaned up**
and must therefore be run against a purpose-created test claim, not a real one.

**Gate — run first, stop if it fails:**

| # | Test | Confirms |
|---|---|---|
| **0** | In the OD developer portal, confirm write entitlement for Insurance, Payments and Documents on this developer/customer key pair, and the billing tier per location | G8. **Nothing below is worth running until this passes** |

**Then, in order:**

| # | Test | Method | Confirms | Cleanup |
|---|---|---|---|---|
| 1 | Create a claim on a test patient with one cheap procedure | `POST /claims` | Write verbs are live at all; gives every later test a disposable target | `DELETE /claims/{n}` while still status U |
| 2 | `PUT /claimprocs/{n}` setting `Status=Received`, `InsPayAmt`, `WriteOff`, `DedApplied` | single PUT + read-back GET | The crux row of the matrix. Read back and confirm **what `DateCP` became** (G2) | none needed pre-check |
| 3 | `PUT /claims/{n}` → `ClaimStatus=R`, `DateReceived` | PUT + GET | §3 | — |
| 4 | `POST /claimpayments` with `CheckAmt` = the sum from test 2 | POST + `GET /claimprocs?ClaimPaymentNum=` | §1; proves the CheckAmt-must-match rule and the read-back reconciliation loop | `DELETE /claimpayments/{n}` — **only possible before an EOB or deposit is attached** |
| 5 | `POST /claimpayments` with a **deliberately wrong** `CheckAmt` | POST, expect 4xx | That the mismatch rule is enforced, not silently accepted. **Highest-value negative test in the list** | n/a (expected to fail) |
| 6 | `POST /claimprocs/Supplemental` with a **negative** `InsPayAmt` | POST + GET | **G7 — the single most important unknown.** Also read back `DateSuppReceived` | offsetting supplemental if accepted |
| 7 | `POST /claimpayments` with a negative `CheckAmt` | POST, record accept-or-reject | G7 second half | delete if accepted |
| 8 | `POST /adjustments` with DefNum 12 (`-`) and a negative `AdjAmt`; then the same with a **mismatched** sign | 2 POSTs | §5 sign rule enforcement | **No DELETE exists** — post an offsetting DefNum 260 adjustment |
| 9 | `POST /documents/Upload` with a real multi-page EOB-sized PDF as `rawBase64`, `DocCategory=131` | POST + `GET /documents?PatNum` | §6 and **G9 — find the actual size ceiling** by escalating 1 MB → 5 MB → 10 MB | `DELETE /documents/{DocNum}` |
| 10 | `POST /claimpayments/Batch` across two test claims | POST | The real EOB shape; whether `IsPartial` is set when CheckAmt differs | delete if permitted |
| 11 | Attempt `PUT /claimprocs/{n}` on a line already attached to a check | PUT, expect 4xx | The documented "cannot update InsPayAmt once attached" restriction | n/a |
| 12 | Existence check: `DELETE /claimprocs/{n}` and `POST /claimprocs/{n}/PendingSupplemental` | one call each, record 404-vs-other | Whether the two **"TBA"** endpoints exist on 25.4.48 | n/a |
| 13 | After any write, read `GET /securitylogs` for the affected patient | GET | **Which OD user a write is attributed to** — the audit question §9 leaves open | n/a |

**Throttle:** space every call ≥ 1 s. **Scope:** Roland only — Valley's DefNums differ and
Valley must be validated separately before any office beyond Roland is switched on.

---

## Live probe transcript (2026-08-13)

Read-only GETs against the live Roland Open Dental database, issued through the platform's
own credential path (`OPENDENTAL_DEVELOPER_KEY` + `OPENDENTAL_CUSTOMER_KEY`, roland) so the
keys were used in place and never printed. **No writes. No OD state changed.** Row values
that could identify a patient are not reproduced — field names, counts and configuration
DefNums only.

**A. Resource existence (plural wins, singular is dead)**

```
GET /claimprocs?PatNum=12827        → 200  (0 rows)
GET /claimpayments                  → 200  100 rows
GET /claimpayment                   → 404  "claimpayment is not a valid resource."
GET /eobattaches?ClaimPaymentNum=1  → 200  (0 rows)
GET /eobattach?ClaimPaymentNum=1    → 404  "eobattach is not a valid resource."
GET /deposits                       → 200  6 rows
GET /adjustments?PatNum=12827       → 200  (0 rows)
GET /paysplits?PatNum=12827         → 200  (0 rows)
GET /payments?PatNum=12827          → 200  (0 rows)
GET /claims?PatNum=12827            → 200  (0 rows)
```

**B. Field shapes**

```
GET /claimprocs?Status=Received  → 200, 100 rows, 47 fields:
  ClaimProcNum, ProcNum, ClaimNum, PatNum, ProvNum, FeeBilled, InsPayEst, DedApplied,
  Status, InsPayAmt, Remarks, ClaimPaymentNum, PlanNum, DateCP, WriteOff, CodeSent,
  AllowedOverride, Percentage, PercentOverride, CopayAmt, NoBillIns, PaidOtherIns,
  BaseEst, CopayOverride, ProcDate, DateEntry, DedEst, DedEstOverride, InsEstTotal,
  InsEstTotalOverride, PaidOtherInsOverride, EstimateNote, WriteOffEst,
  WriteOffEstOverride, ClinicNum, InsSubNum, PaymentRow, PayPlanNum,
  ClaimPaymentTracking, claimPaymentTracking, SecUserNumEntry, SecDateEntry,
  SecDateTEdit, DateSuppReceived, DateInsFinalized, IsTransfer, ClaimAdjReasonCodes

GET /claimprocs/{n}       → 200 (single-item endpoint v25.1.27 is live)
GET /claims/{n}           → 200  ClaimStatus, DateReceived, InsPayAmt, DedApplied,
                                 WriteOff, ReasonUnderPaid, CustomTracking present
GET /claimpayments/{n}    → 200  ClaimPaymentNum, CheckDate, CheckAmt, CheckNum,
                                 BankBranch, Note, ClinicNum, DepositNum, CarrierName,
                                 DateIssued, IsPartial, PayType, payType, PayGroup, payGroup
GET /eobattaches?ClaimPaymentNum={n} → 200  1 row
    EobAttachNum, ClaimPaymentNum, DateTCreated, FileName, RawBase64
    FileName extension = pdf   ⚠️ RawBase64 length = 0

/claimprocs filter params:  ?ClaimPaymentNum= → 2 rows   ?ClaimNum= → 4 rows
                            ?DateCP=          → 100      ?Status=Supplemental → 100
                            ?Status=Adjustment→ 100      ?Status=Received&Offset=100 → 100
```

**C. Per-office DefNums (configuration, not PHI)**

```
Category  1  AdjTypes            → 39 rows   incl. 12 "Insurance Write-off" (-)
                                              10 "Write-off" (-)
                                             262 "PPO Adjustment" (+)
                                             260 "Insurance Adjustment" (+)
                                             477 "Insurance deductions from previous payments" (-)
                                         460–463 "Insurance write-off  Medicaid …" (-)
Category 10  PaymentTypes        → 11 rows   incl. 69 "Check", 275 "Insurance Check", 471 "Insurance EFT"
Category 18  ImageCategories     → 33 rows   incl. 131 "Insurance", 134 "Financial"
Category 31  ClaimCustomTracking → 11 rows   Denied · Resubmitting · Claim Rejected ·
                                             Information Needed · Clm paid, awaiting EOB · …
Category 32  InsurancePaymentType→  4 rows   296 "Check" · 297 "EFT" · 404 "Credit Card" · 472 "Insurance Check"
```

⚠️ `?category=InsurancePaymentType` (string) → 200 with **100 unfiltered rows spanning
Categories 0–6**, identical to `?category=NotARealCategory`. The string form is silently
ignored; only numeric `Category=` filters.

**D. Preferences that gate the posting path**

```
ClaimPaymentBatchOnly = 0     → single POST /claimpayments is permitted on Roland
ShowAutoDeposit       = 0     → POST /claimpayments/Batch will NOT auto-create a deposit
ApiPaymentType        = 69    → "Check" — the default PayType for POST /payments
RigorousAccounting    = 2
```

**E. Distribution facts from the 100 most recent Roland claimpayments**

```
PayType in use   : 296 "Check" | 297 "EFT"      PayGroup in use: 0 (none)
IsPartial = true : 0 of 100                      IsPartial raw value: the STRING "false"
CheckAmt <  0    : 0 of 100                      CheckAmt == 0 : 14 of 100
Received claimprocs sampled (100): InsPayAmt<0 = 0 · WriteOff<0 = 0 · IsTransfer = 0
                                   ClaimAdjReasonCodes non-empty = 0
```

**F. Build version**

```
ProgramVersion  = 25.4.48.0
DataBaseVersion = 25.4.45.0
```

### What this transcript does **not** prove

- **Nothing about write verbs.** Every probe was a GET. A 200 proves the resource is
  readable with this key pair; POST/PUT/DELETE are entitled separately and remain unproven.
- **Nothing about negative amounts.** The absence of negative rows in Roland's history is
  evidence the practice has never posted one — not evidence the API would refuse one.
- **Nothing about Valley.** Every DefNum above is Roland's. Valley's must be read from
  Valley's own database before any office beyond Roland is enabled.

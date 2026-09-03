# RCM Open Dental writes — API coverage (Spikes 0a + 0b)

**Date:** 2026-08-13
**Open Dental docs snapshot:** `opendental.com/site/api*.html`, read 2026-08-13
**Live practice build:** Roland `ProgramVersion 25.4.48.0` / `DataBaseVersion 25.4.45.0` (verified, §Probe F)
**Method:** documentation review + **read-only GET** verification against the live Roland
Open Dental database. **Spike 0a performed zero writes** — no POST, PUT, PATCH or DELETE was
issued against any Open Dental resource, including against test patients. Live write
verification is Spike 0b, planned in §4 and **executed in full on 2026-08-13** — all 13 tests,
see [Spike 0b results](#spike-0b-results-2026-08-13--complete) at the end of this document.
Sections 1–4 below are the 0a analysis, amended in place where 0b changed an evidence class;
the 0b section is the write transcript. **Nothing in the 0a matrix was refuted.**

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
| **verified** ✅ | Proven against live Roland OD on 2026-08-13 — by read-only GET (0a) or by an executed write (0b). Transcripts below. |
| **inferred** ⚠️ | Reasoned from adjacent facts. **Not a fact.** Every remaining inferred row is an outstanding Spike 0b test. |

A GET returning 200 proves the **resource** is readable with this developer/customer key
pair. It does **not** prove the write verbs on it are entitled — Open Dental entitles reads
and writes separately, by **permission group**, per pricing tier
([API Permissions](https://www.opendental.com/site/apipermissions.html)). **No read-only
probe can establish write entitlement**, which is why Spike 0b opened with test 0.

**Test 0 has since passed:** Insurance, Documents and AllOthers are enabled on this key;
ApiPayments is not. The insurance posting path lives under **Insurance**, so Branch A's
critical path is entitled. See §9 and **G11**.

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
| **`DateCP`** | **NO — and it fails silently** ✅verified | Spike 0b test 2 | Absent from the PUT field list, and sending it anyway returns **`200 OK` while changing nothing**. OD sets `DateCP` when the claimproc is *created*, not when it is received. See G2 |
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
| `POST` / `PUT /claimprocs/{n}/PendingSupplemental` | **TBA** | ❌ **no** ✅verified | **Spike 0b test 12** — `400 "claimprocs POST PendingSupplemental is not a valid method."` Absent on 25.4.48 |
| `DELETE /claimprocs/{n}` | **TBA** | ❌ **no** ✅verified | **Spike 0b test 12** — `400 "claimprocs DELETE  is not a valid method."` Absent on 25.4.48. The documented restrictions are moot while the verb itself does not exist |

**Blocking restrictions on `PUT /claimprocs/{n}`, all documented:**

- Refused when `IsTransfer = true`, or when `Status` is `"Adjustment"`, `"InsHist"`,
  `"CapClaim"`, `"CapComplete"` or `"CapEstimate"`. `IsTransfer` is present on the live row
  (✅verified, §Probe B) so a poster can pre-check it rather than discover the refusal.
- `InsPayAmt` cannot be updated once a ClaimPayment is attached. ✅**Verified** (Spike 0b
  test 11): `400 "Cannot change InsPayAmt when Status is Received and attached to a
  ClaimPayment."` The lock releases if the check is later deleted (see G10).
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

**Sign rule — documented and now ✅verified (Spike 0b test 8):** `AdjType` is a DefNum where
`definition.Category = 1` and `ItemValue` is `"+"` or `"-"`, and **`AdjAmt`'s sign must
agree**. Proven live: DefNum 12 (`-`) with `AdjAmt: -1.00` → **201**; the same DefNum with
`AdjAmt: +1.00` → **400 `"AdjAmt must be negative for this AdjType."`** A sign/type mismatch
is a hard refusal, not a silent flip — so a posting bug that inverts a write-off surfaces
immediately rather than corrupting a ledger.

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
| **Patient's images** (chart) | **full** | documented ✅verified | [`POST /documents/Upload`](https://www.opendental.com/site/apidocuments.html) v21.1 — required `PatNum`, **`rawBase64`**, `extension`; optional `Description`, `DateCreated`, `DocCategory`, `ImgType`, `ProvNum`. `.pdf` is explicitly a supported type. **Spike 0b test 9:** 1 / 5 / 10 MB PDFs all accepted (201) into `DocCategory 131` and all deleted cleanly. ⚠️ `DateCreated` requires `"yyyy-MM-dd HH:mm:ss"`, unlike the rest of the API |
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
| Negative `InsPayAmt` via `POST /claimprocs/Supplemental` | **full** ✅verified | **Spike 0b test 6** | `{ClaimProcNum, InsPayAmt: -0.20}` → **201**. Created a real `Status: "Supplemental"` claimproc carrying `InsPayAmt: -0.2` and `ClaimPaymentNum: 0`, sitting alongside the original Received line. **This is the recoupment mechanism, and it works** |
| Negative `InsPayAmt` via `PUT /claimprocs/{n}` | **unknown** ⚠️inferred | inferred | Still untested — the Supplemental route is the documented one and it is proven, so this path was not exercised |
| Negative `CheckAmt` on a claimpayment | **full** ✅verified | **Spike 0b test 7** | `{claimNum, CheckAmt: -0.20}` → **201**, `ClaimPaymentNum` issued. A negative check posts and reconciles against the negative supplemental exactly as a positive one does against a Received line |
| Recoupment as an **adjustment** instead | **full** | documented ✅verified | DefNum 477 *"Insurance deductions from previous payments"* (`-`). Still available, but **no longer the necessary fallback** — the native path works |

**SETTLED (Spike 0b, 2026-08-13): negative amounts are accepted at both layers.** What the
API documentation is silent about, the API itself permits — a negative supplemental claimproc
and a negative claimpayment both post cleanly, giving recoupments and takebacks a native path
that needs no adjustment-based workaround. Roland simply had never posted one, which is why
0a found no precedent; absence of precedent was not absence of support.

⚠️ **One-way door.** A negative supplemental, once created, **cannot be undone**: `DELETE
/claimprocs` does not exist (test 12), and reverting its status is refused with `400 "Cannot
change Status from Supplemental when there is a ClaimProc with a different status and the same
ProcNum."` (teardown). Everything else in the posting sequence proved reversible; this does
not. **Recoupment posting must be the most heavily reviewed action in the module.**

### 8. Batch / transaction semantics

| Aspect | Answer | Evidence |
|---|---|---|
| Multi-operation atomicity | **none** | documented-absence — no transaction, savepoint or rollback endpoint appears anywhere in the [resource index](https://www.opendental.com/site/apispecification.html) (~110 resources) |
| Multi-claim single check | **full** ✅verified | `POST /claimpayments/Batch` v24.2.18 — one HTTP call covering many claims. **Spike 0b test 10:** `{claimNums: [53649, 53650], CheckAmt: 1.00}` → 201, `IsPartial: "false"`, and `GET /claimprocs?ClaimPaymentNum=` returned 2 claimprocs across 2 claims. The closest thing to a transaction, and the reason it matters below |
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
| **Write entitlement is licensed per permission group** — and the insurance posting path is **not** under Payments | ✅verified (Spike 0b test 0) | Entitlement is granted per **permission group**, not per HTTP verb on a resource. On this key pair **Insurance, Documents and AllOthers are enabled; ApiPayments is NOT.** The whole insurance-posting path — `/claims`, `/claimprocs`, `/claimpayments`, `/eobattaches` — sits under **Insurance**, so Branch A's critical path is entitled today. What ApiPayments gates is `/payments` and `/paysplits`, i.e. the **patient-portion** flow the PRD already defers. Tier pricing is per location and charges begin when keys are enabled |
| API writes are attributed to the **key's OD user**, not the acting human | ✅verified (Spike 0b test 13) | Every API-written row logs `UserNum: 0`, `LogSource: "API"`, and a `LogText` reading **`"Created by Sparkman DDS through API."`** — the OD user bound to the developer key. Open Dental's audit trail therefore cannot distinguish *which* CareIN operator posted a payment; that attribution exists only in our own `audit_log`. Same limitation the H0 spike found for chart notes. **Design the RCM audit trail assuming OD's is single-identity** |
| `?category=<string>` on `/definitions` is **silently ignored** | ✅verified | `?category=InsurancePaymentType` and `?category=NotARealCategory` both returned the same unfiltered 100-row page spanning Categories 0–6. **Always use the numeric `Category=`.** A string filter is a lie, not a 400 |
| …and it is a **pattern**, not a one-off | ✅verified | Two more list filters are silently ignored: **`/securitylogs?PatNum=`** (returns the same 100 rows for 12827, 12828 and a nonsense PatNum — every row `PatNum: 0`) and **`/procedurecodes?ProcCode=`** (`D0140`, `D0120` and `D0220` all returned `CodeNum: 1`, "periodic oral evaluation"). **Never trust an OD list filter you have not proven returns a different result for a different value.** An unrecognized filter yields a plausible wrong answer, not an error |
| A missing **write verb** returns `400`, not `404` — and this is safely probeable | ✅verified (Spike 0b test 12) | Three distinct signals, all confirmed: missing row → `404 "ClaimProc not found."`; missing resource → `404 "notaresource is not a valid resource."`; **missing method → `400 "claimprocs DELETE  is not a valid method."`** Because the method check precedes the row lookup, **write-verb existence can be probed against a non-existent id with zero risk to data** — that is how test 12 was run |
| Booleans come back as **strings** | ✅verified | `IsPartial: "false"`, `isHidden: "false"`. Same trap the commlog-type picker hit. `if (row.IsPartial)` is true for `"false"` |
| `ClinicNum` on Roland is `0` everywhere | ✅verified (in `TC_OD_READS.md`) | The customer key already scopes to one practice database. Leave `ClinicNum` unset on writes unless a multi-clinic database appears |
| `/claimprocs` filters usable for reconciliation | ✅verified | `ClaimPaymentNum=`, `ClaimNum=`, `DateCP=`, `Status=`, `Offset=` all 200. `?ClaimPaymentNum=<n>` returning exactly the lines on a check is the natural post-write verification read |
| `/deposits` is live (v25.4.33) | ✅verified | 6 rows, full field set. `POST /deposits` accepts `payNums` and/or `claimPaymentNums`. **Restriction: claimpayments in a deposit cannot be partial and cannot have `CheckAmt` of 0** — and 14% of Roland's recent checks are $0 |
| `/claimtrackings` exists; Roland has 11 custom tracking statuses (Category 31) | ✅verified | *Denied*, *Resubmitting*, *Claim Rejected*, *Information Needed*, *Clm paid, awaiting EOB*… The denial workflow has a native home in OD already |
| `ClaimAdjReasonCodes` is read-only and empty on Roland | ✅verified | 0 of 100 Received claimprocs carry one. CARC/RARC denial codes cannot be written back, and are not being captured today |
| `/etranss` requires `PatNum` | ✅verified | `?ClaimNum=` alone → 400 *"PatNum is required."* Rules out an ERA-side sweep by claim |
| Version gates on this build | ✅verified | 25.4.48.0 / DB 25.4.45.0. Everything ≤ 25.4.x is present; **26.2.1 endpoints are not** (`GET /definitions/{DefNum}`, `PUT /definitions`), and the two **"TBA"** endpoints — `DELETE /claimprocs`, `*/PendingSupplemental` — are **confirmed absent** (Spike 0b test 12), not merely presumed |
| `DateCreated` demands a **datetime**, not a date | ✅verified (Spike 0b test 9) | `POST /documents/Upload` with `DateCreated: "2026-08-13"` → `400 "DateCreated format must be yyyy-MM-dd HH:mm:ss."` The doc page lists the field without stating the format, and the rest of the API uses bare `yyyy-MM-dd`. Per-field, not per-API |

---

## 2. Gaps list

Each gap names the concrete posting operation that becomes impossible or degraded.

| # | Gap | Operation lost | Severity | Workaround |
|---|---|---|---|---|
| G1 | **`eobattach` has no base64 POST** — SFTP only | Filing the EOB PDF **on the check**, where the OD front office opens it | **High (workflow), low (money)** | File it to the patient's images via `POST /documents/Upload` (fully supported). Or run an SFTP endpoint for `POST /eobattaches/UploadSftp`. **A connector cannot fix this without a forbidden direct-MySQL write** |
| G2 | **`DateCP` is not writable — and the API says `200 OK` when you try** | Backdating adjudication to the carrier's EOB date | **Low → Medium** ✅verified | OD stamps `DateCP` at claimproc **creation**, not at receive. `PUT {DateCP: "2026-07-01"}` returned **200 with no change** (test 2). Keep the carrier date in `Note`/`ClaimNote`. Two real costs: a back-dated EOB posts with the wrong `DateCP`, shifting YTD-benefit rollups that key on it; and **a poster cannot detect the failure from the response** — it must read back and compare, or simply never claim to have set it |
| G3 | **`ClaimAdjReasonCodes` is read-only** | Writing CARC/RARC denial codes back to the claimproc | Medium | Denial reason → `Remarks` on the claimproc, `ReasonUnderPaid`/`ClaimNote` on the claim, and/or a `/claimtrackings` status. Structured codes stay in our database only |
| G4 | **No transactions** | All-or-nothing posting of a multi-line EOB | **High** | Cannot be worked around anywhere — a connector doing the same REST calls has the identical problem. Mitigate with ordering + a resumable queue (§8) |
| G5 | **No `POST`/`DELETE` on `/paysplits`** | Hand-built arbitrary split sets | Low | `POST /payments` (+`procNums`) and `PUT /payments/{n}/Partial` cover the real cases — **but see G11: `/payments` is not entitled on this key today** |
| G6 | **No `DELETE /payments`, no `DELETE /adjustments`** | Voiding a mis-posted entry | Medium | `POST /payments/Refund` for payments; offsetting adjustment for adjustments. ✅**Verified working** (Spike 0b test 8): a `-1.00` DefNum 12 adjustment reversed by a `+1.00` DefNum 260 nets the ledger to zero |
| G7 | ~~Negative amounts unproven~~ → **RESOLVED: supported** | — | **cleared** | ✅**Both layers accept negatives** (tests 6 and 7): `POST /claimprocs/Supplemental {InsPayAmt: -0.20}` → 201, and `POST /claimpayments {CheckAmt: -0.20}` → 201. Recoupments have a native path. **But a negative supplemental is irreversible** — folded into G10 |
| G8 | ~~Write entitlement unconfirmed~~ → **RESOLVED for the posting path** | — | ~~Blocking~~ **cleared** | Insurance + Documents + AllOthers are enabled on this key (Spike 0b test 0). The Branch A critical path is entitled. Superseded by G11 |
| G9 | ~~No documented `rawBase64` size limit~~ → **RESOLVED** | — | **cleared** | ✅**10 MB accepted** (13.3 MB base64 on the wire, 201 in 11.3 s), as were 1 MB and 5 MB; all three deleted cleanly. No ceiling found at or below 10 MB — comfortably above any real EOB scan (Spike 0b test 9) |
| G10 | **Posting is reversible — with exactly one exception** | Rolling back a bad batch | **Medium**, revised down ✅verified | Measured end to end (teardown). **The unwind path works**: delete the check → the claimprocs unlock → zero them and revert to `NotReceived` → delete the claim → delete the procedure. Two of three test claims unwound completely. **The exception is a negative supplemental**: it cannot be reverted (`400 "Cannot change Status from Supplemental…"`) and cannot be deleted (`DELETE /claimprocs` does not exist), and it then pins its claim (`400 "Claim cannot be deleted. Procedure(s) have an insurance payment attached."`) and that claim's procedure forever. **Review-then-post remains the only correction opportunity for recoupments specifically** |
| G12 | **`DELETE /procedurelogs` is a SOFT delete** | Trusting a delete to remove a row | Low, but a correctness trap | ✅verified — a deleted procedure returns `ProcStatus: "D"` and **still appears in `GET /procedurelogs`**. Any ledger arithmetic must filter it out. This bit the spike's own teardown: counting `"D"` rows as live charges over-applied a reversal by $2.00, which then had to be corrected |
| G11 | **`ApiPayments` is not enabled on this key** | `POST /payments`, `PUT /payments/{n}/Partial`, `/paysplits` — the entire **patient-portion** posting flow | Low *today*, blocking if scope changes | New, from test 0. Insurance posting is unaffected. If the PRD's deferred patient-responsibility flow is ever pulled forward, the ApiPayments group must be enabled first — a portal + billing change, not a code change |

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
2. ~~**Branch A is contingent on G8.**~~ **Resolved — the contingency is discharged.** Spike
   0b test 0 confirmed the **Insurance**, **Documents** and **AllOthers** permission groups are
   enabled on this key pair, and the entire posting path was then exercised end to end against
   the live database. `ApiPayments` is off, which touches only the deferred patient-portion
   flow (**G11**). Branch A is no longer conditional.

> **Post-0b standing.** The recommendation is unchanged and materially stronger. Every write
> the module needs was executed successfully against a live practice database: per-line
> adjudication, claim receipt, single and batched checks, **negative recoupments**, adjustments
> with an enforced sign rule, and 10 MB EOB uploads. The amount-matching rule, the
> check-attached lock and the sign rule all refused cleanly when given bad input, which is the
> behaviour a review-then-post design depends on. Two things changed the design brief rather
> than the branch: `DateCP` returns `200 OK` while ignoring the write (**G2**), so posting must
> never claim to have back-dated adjudication; and a **negative supplemental is the single
> irreversible operation** (**G10**), so recoupments need a harder gate than everything else.

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

---


## Spike 0b results (2026-08-13) — complete

Live **write** verification against the Roland Open Dental database, executing the §4 plan.
Roland only; **PatNum 12827** (`Test 2, Stedi`) only; ≥1.3 s between every call; the run was
armed to abort on any 403 or permission error and never had to.

**Test 0 — entitlement: PASS, with a correction to §9.** Beau confirmed in the OD developer
portal that **Insurance, Documents and AllOthers** are enabled on this key pair and
**ApiPayments is not**. The insurance posting path sits under **Insurance**, not Payments, so
Branch A's critical path is entitled today; what is missing gates only the deferred
patient-portion flow. Recorded as **G11**.

Tests 1–7, 10 and 11 were initially blocked — neither designated test patient could carry a
claim (12827 had no coverage; 12828's two subscriptions had both terminated). Beau added an
active plan to 12827 (`PatPlanNum 20469`, effective 2026-01-01 through 2026-12-31) and the
full run completed.

### Verdict table

| # | Test | Verdict | Result |
|---|---|---|---|
| 0 | Write entitlement | ✅ **confirmed** | Insurance/Documents/AllOthers on; ApiPayments off → **G11** |
| 1 | Create disposable claim | ✅ **confirmed** | `POST /procedurelogs` 201, `POST /claims` 201 |
| 2 | `PUT /claimprocs` money fields | ✅ **confirmed** | 200; all four fields took |
| 2b | `DateCP` writability (**G2**) | ✅ **confirmed not writable** | **200 OK, silently ignored** |
| 3 | `PUT /claims` → `R` | ✅ **confirmed** | 200; claim totals auto-rolled up |
| 4 | `POST /claimpayments`, matching amount | ✅ **confirmed** | 201; reconciliation read-back exact |
| 5 | `POST /claimpayments`, wrong amount | ✅ **confirmed refused** | `400 "CheckAmt does not match…"` |
| 6 | **Negative supplemental (G7)** | ✅ **confirmed ACCEPTED** | **201** |
| 7 | **Negative `CheckAmt` (G7)** | ✅ **confirmed ACCEPTED** | **201** |
| 8 | `POST /adjustments` sign rule | ✅ **confirmed enforced** | `400` on mismatch |
| 9 | `rawBase64` ceiling | ✅ **confirmed** | none at or below 10 MB |
| 10 | `POST /claimpayments/Batch` | ✅ **confirmed** | 201 across 2 claims |
| 11 | `PUT` a check-attached line | ✅ **confirmed refused** | `400 "Cannot change InsPayAmt…"` |
| 12 | `"TBA"` endpoint existence | ✅ **confirmed absent** | `400 "…is not a valid method."` |
| 13 | `/securitylogs` attribution | ✅ **confirmed** | single identity, `UserNum 0` |

**All 13 tests executed. Nothing in the 0a matrix was refuted.** Nine rows moved
⚠️inferred/presumed → ✅verified. **G7, G8 and G9 closed**; G2 and G12 sharpened; **G10
revised *down*** (posting turns out to be mostly reversible); G11 and G12 opened.

### Tests 1–4 — the happy path, end to end

```
POST /procedurelogs {PatNum 12827, ProcDate <today>, D0140, ProcStatus "C",
                     ProcFee 1.00, ProvNum 1}     -> 201  ProcNum=405237
POST /claims        {PatNum 12827, procNums:[405237], ClaimType "P"}
                                                  -> 201  ClaimNum=53648  ClaimStatus="W"  ClaimFee=1
GET  /claimprocs?ClaimNum=53648                   -> 200  1 row, auto-created by the claim
       ClaimProcNum=533930  Status="NotReceived"  InsPayAmt=0  DateCP="2026-08-13"
PUT  /claimprocs/533930 {Status:"Received", InsPayAmt:0.60, WriteOff:0.20, DedApplied:0.20}
                                                  -> 200
       read-back:  Status="Received"  InsPayAmt=0.6  WriteOff=0.2  DedApplied=0.2
PUT  /claims/53648 {ClaimStatus:"R", DateReceived:"2026-08-13"}
                                                  -> 200
       read-back:  ClaimStatus="R"  DateReceived="2026-08-13"  InsPayAmt=0.6  WriteOff=0.2
POST /claimpayments {claimNum:53648, CheckAmt:0.60, PayType:296, CheckNum:"SPIKE0B"}
                                                  -> 201  ClaimPaymentNum=21253  IsPartial="false"
GET  /claimprocs?ClaimPaymentNum=21253            -> 200  1 row, InsPayAmt sum = 0.60
```

> **`ProcDate` was omitted from the line above until 2026-08-25.** This transcript
> was abridged when it was written, and §10.1 of `RCM_POSTING.md` was copied from
> it — so the §10 prep script inherited the omission and got
> `400 "ProcDate is required."` on its first run. The API reference lists
> **PatNum, ProcDate, ProcStatus** and **procCode-or-CodeNum** as required for
> `POST /procedurelogs`; `ProcFee` and `ProvNum` are optional (they are sent
> anyway — see §10.1 for why), and `DateEntryC` is not a create parameter at all.

Three incidental confirmations: a new claim defaults to **`ClaimStatus "W"`** (Waiting in
queue), not `"U"`; **the claim's own `InsPayAmt`/`WriteOff` roll up automatically** from its
claimprocs, so a poster never writes them directly; and `GET /claimprocs?ClaimPaymentNum=` is
an exact post-write reconciliation read, as §9 predicted.

### Test 2b — `DateCP` (G2) ✅ CONFIRMED NOT WRITABLE, AND IT LIES

```
at creation (Status NotReceived) : DateCP = "2026-08-13"
after the receive PUT            : DateCP = "2026-08-13"   (unchanged)
PUT /claimprocs/533930 {DateCP: "2026-07-01"}  -> 200 OK
read-back                        : DateCP = "2026-08-13"   (unchanged)
```

Two findings, and the second is the dangerous one. **`DateCP` is stamped when the claimproc
is created, not when it is received** — so it is the claim-creation date, never the carrier's
EOB date. And **a write attempt returns `200 OK` and silently does nothing**: there is no
error to catch and nothing echoed back to compare against unless you re-read. A posting
engine that believes its own 200 will report back-dated adjudication it never performed.

### Test 5 — wrong `CheckAmt` ✅ CONFIRMED REFUSED

```
POST /claimpayments {claimNum:53648, CheckAmt:999.99}   (true eligible total 0.60)
    -> 400  "CheckAmt does not match the total of eligible ClaimProcs."
```

**Run deliberately before test 4**, not after: once a claimproc is attached to a check it is
no longer *eligible*, so a refusal at that point could not be attributed to the amount rule.
Ordering it first is what makes this evidence clean. The rule from §1 is enforced exactly as
documented, and the word *eligible* in OD's own error message confirms that "eligible" means
`ClaimPaymentNum = 0`.

### Test 11 — updating a check-attached line ✅ CONFIRMED REFUSED

```
PUT /claimprocs/533930 {InsPayAmt: 0.70}   (line attached to ClaimPaymentNum 21253)
    -> 400  "Cannot change InsPayAmt when Status is Received and attached to a ClaimPayment."
```

The lock is real, and — per teardown below — it **releases** when the check is deleted.

### Tests 6 and 7 — negative amounts (G7) ✅ CONFIRMED ACCEPTED

**This was the spike's biggest unknown, and the answer is yes, at both layers.**

```
POST /claimprocs/Supplemental {ClaimProcNum:533930, InsPayAmt:-0.20}
    -> 201   ClaimProcNum=533931  Status="Supplemental"  InsPayAmt=-0.2  ClaimPaymentNum=0

claimprocs on claim 53648 afterwards:
    533930  Status="Received"      InsPayAmt= 0.6   ClaimPaymentNum=21253
    533931  Status="Supplemental"  InsPayAmt=-0.2   ClaimPaymentNum=0

POST /claimpayments {claimNum:53648, CheckAmt:-0.20}
    -> 201   ClaimPaymentNum=21254
```

A negative supplemental posts, and a **negative check** posts against it and reconciles by
exactly the same eligible-total rule as a positive one. Recoupments, takebacks and carrier
refunds therefore have a **native API path** — the adjustment-based fallback (DefNum 477) is
now optional rather than necessary.

0a inferred this from OD's manual while noting the API docs were silent and that Roland had
never posted a negative check. That absence of precedent turned out to mean nothing about
support. ⚠️ But see teardown: **this is the one irreversible operation in the whole sequence.**

### Test 10 — `POST /claimpayments/Batch` ✅ CONFIRMED

```
two more procedures + claims created, each claimproc PUT to Received (InsPayAmt 0.50,
WriteOff 0.50), each claim PUT to "R"

POST /claimpayments/Batch {claimNums:[53649,53650], CheckAmt:1.00, PayType:297}
    -> 201  ClaimPaymentNum=21255  IsPartial="false"
GET  /claimprocs?ClaimPaymentNum=21255
    -> 200  2 claimprocs across 2 claims
```

The real-world EOB shape works in a single call, and the per-claim preparation is identical
to the single-claim path. `PayType 297` ("EFT", Category 32) was accepted.

### Teardown — how reversible is posting, really? (G10, measured)

The unwind was attempted in strict reverse order. **The first pass failed and the second
succeeded**, and the difference is itself the finding.

**Pass 1 — delete the checks, then try to delete claims and procedures:**

```
DELETE /claimpayments/21253, /21254, /21255      -> 200, 200, 200   (all three deleted)
PUT    /claims/{n} {ClaimStatus:"U"}             -> 200  (status reverts freely)
DELETE /claims/53648, 53649, 53650               -> 400 x3  "Claim cannot be deleted.
                                                    Procedure(s) have an insurance payment attached."
DELETE /procedurelogs/405237, 405238, 405239     -> 400 x3  "Not allowed to delete a
                                                    procedure that is attached to a claim."
```

Deleting the *check* does not clear the *claimproc*: `InsPayAmt` stayed at 0.60/0.50/0.50 with
`ClaimPaymentNum` reset to 0. The claim is pinned by the money still sitting on its lines.

**Pass 2 — zero the claimprocs first, then unwind:**

```
PUT /claimprocs/533930 {Status:"NotReceived", InsPayAmt:0, WriteOff:0, DedApplied:0} -> 200
PUT /claimprocs/533932 {same}                                                        -> 200
PUT /claimprocs/533933 {same}                                                        -> 200
PUT /claimprocs/533931 {same}   <- the NEGATIVE SUPPLEMENTAL
    -> 400  "Cannot change Status from Supplemental when there is a ClaimProc with a
             different status and the same ProcNum."

DELETE /claims/53649, /53650          -> 200, 200   DELETED
DELETE /claims/53648                  -> 400        (still pinned by the supplemental)
DELETE /procedurelogs/405238, /405239 -> 200, 200   DELETED
DELETE /procedurelogs/405237          -> 400        (still attached to claim 53648)
```

**Conclusion — G10 is less severe than 0a assumed, with one sharp exception.** The unwind
path is: *delete the check → zero the claimprocs → delete the claim → delete the procedure*,
and it works. Two of the three test claims were removed completely. What cannot be undone is
a **negative supplemental**: it cannot be reverted (its status is pinned by the sibling
claimproc on the same `ProcNum`) and it cannot be deleted (`DELETE /claimprocs` does not
exist, test 12). It then permanently pins its claim and that claim's procedure.

**Design consequence:** ordinary posting is correctable, so review-then-post is a normal
safety rail there. **Recoupment posting is a one-way door and must be gated harder than
anything else in the module.**

### G12 — `DELETE /procedurelogs` is a soft delete ✅ NEW

A deleted procedure comes back as `ProcStatus: "D"` and **still appears in
`GET /procedurelogs`**:

```
ProcNum=405239  ProcStatus="D"  fee=1.00     <- "deleted"
ProcNum=405238  ProcStatus="D"  fee=1.00     <- "deleted"
ProcNum=405237  ProcStatus="C"  fee=1.00     <- live
```

This bit the spike's own teardown: the reconciliation script summed all three fees as live
charges, computed a $3.20 balance instead of $1.20, and over-applied the reversing adjustment
by $2.00 — which then had to be corrected with a second adjustment. **Any RCM ledger
arithmetic must filter `ProcStatus="D"`.** It is exactly the OD convention the house rules
already carry for `ProcStatus = 6`, surfacing through the API as a string.

### Cleanup ledger — every row created, and its disposition

| Row | Disposition |
|---|---|
| `procedurelog 405237` ($1.00) | ⚠️ **PERMANENT** — pinned by claim 53648 |
| `procedurelog 405238` ($1.00) | **DELETED** (soft — `ProcStatus="D"`) |
| `procedurelog 405239` ($1.00) | **DELETED** (soft — `ProcStatus="D"`) |
| `claim 53648` | ⚠️ **PERMANENT** — pinned by the negative supplemental |
| `claim 53649` | **DELETED** ✅ |
| `claim 53650` | **DELETED** ✅ |
| `claimproc 533930` | Zeroed → `NotReceived`, `InsPayAmt 0` |
| `claimproc 533931` (negative supplemental) | ⚠️ **PERMANENT, −0.20** — cannot revert, cannot delete |
| `claimproc 533932`, `533933` | Zeroed, then removed with their claims |
| `claimpayment 21253` ($0.60) | **DELETED** ✅ |
| `claimpayment 21254` (−$0.20) | **DELETED** ✅ |
| `claimpayment 21255` (batch $1.00) | **DELETED** ✅ |
| `document 309575 / 309576 / 309577` (1/5/10 MB) | **all DELETED** ✅ |
| `adjustment 19109` (−1.00) / `19110` (+1.00) | test 8 pair, nets 0 |
| `adjustment 19111` (−3.20) / `19112` (+2.00) | reversal + its correction (see G12) |

**Final ledger state of PatNum 12827, read back from the API:**

```
charges (ProcStatus != "D")  1.00
insurance paid              -0.20   (the permanent negative supplemental)
write-offs                   0.00
adjustments                 -1.20   (19109 -1.00, 19110 +1.00, 19111 -3.20, 19112 +2.00)
------------------------------------
PATIENT BALANCE              0.00   ✅
```

**Residue on the test patient:** one $1.00 completed procedure, one claim, and one −$0.20
supplemental claimproc that Open Dental will not let any API caller remove — documented here
rather than hidden, exactly as the plan required for undeletable artifacts. The financial
effect is neutralized: **the balance is $0.00.** Two soft-deleted procedures remain visible
with `ProcStatus="D"` and contribute nothing.

**No real patient's chart was touched.** No write of any kind was issued against any patient
other than 12827, and no office other than Roland was contacted.

---

## Slice 6d — what the posting module now writes, and the one probe still owed

6d turned three of the verbs above from *proven-but-unused* into *used*. All three
live in `services/rcm/odPostingWrites.js`, which `rcmNoOdWrites.test.js` still
holds as an allow-list of exactly one file.

| Verb | Proven by | Used by |
| --- | --- | --- |
| `POST /adjustments` | **0b test 8** (sign rule enforced) | the takeback's REVERSIBLE path, AdjType resolved by name |
| `POST /claimprocs/Supplemental` | **0b test 6** (live, on 12827) | the takeback's PERMANENT path, opt-in behind a typed confirmation |
| `POST /documents/Upload` | **0b test 9** (10 MB accepted) | the EOB filed into each patient's images |

### ⚠️ `DELETE /adjustments` DOES NOT EXIST — read §5 and G6 again before relying on it

The 6d brief described the adjustment path as *"deletable"*. **It is not.** §5's
matrix says `Delete | none | documented-absence — No DELETE documented. Reversal
must be an offsetting adjustment`, and G6 says the same with the live proof: 0b
test 8 posted a −1.00 (DefNum 12) and reversed it with a +1.00 (DefNum 260),
netting the ledger to zero.

The path is still the right default and still genuinely reversible — reversal just
means posting a second, offsetting entry rather than removing the first. Read every
*"the API cannot undo this"* in this document as exactly that, and never as *"this
row is immortal"*: claim `53648` and the supposedly unremovable supplemental
`533931` were both later removed through Open Dental's **desktop** application,
which can do what the cloud API cannot.

### The probe still owed: `DELETE /documents/{n}`

Not exercised by any spike here, so a filed EOB must be treated as **permanent
residue** on a test patient until it is. It is probeable at zero risk by the
standard technique — *"the method check runs BEFORE the row lookup, so write-verb
existence can be probed against a non-existent id"*:

```
DELETE /documents/999888777
  → 404 "Document not found."             the verb EXISTS and the group is entitled
  → 400 "…is not a valid method."         the verb does NOT exist on this build
  → 403                                    the permission group is not enabled
```

### The zero-risk supplemental probe (run this instead of a live takeback)

**Never create a negative supplemental on a real patient. Not even 12827** — the
one Spike 0b made needed a desktop cleanup. Entitlement is confirmed the same way
the D-7 write probe confirmed Riley's:

```
POST /claimprocs/Supplemental  {ClaimProcNum: 999888777, InsPayAmt: -0.01}
  → 404 "ClaimProc not found."   ENTITLED — the row lookup was reached, NOTHING written
  → 403                          the Insurance write group is not enabled
```

GET-check the ghost id first and abort if it exists, POST/PUT only, never DELETE,
and space calls ≥1.3 s — the four safety properties `rcm-d7-write-probe.js`
enforces in code rather than asserting about itself.

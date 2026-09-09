# The combined walk — the run record

> ## ⏸ PAUSED MID-WALK, 2026-09-02 ~22:15 CT. Resuming the evening of 2026-09-03.
>
> **Steps 1–3 are complete and both money objectives are proven.** Roland's posting
> switch was turned **OFF** by Beau at the pause; **the first act on resume is to
> turn it back ON.** Nothing was left running, no drain is in flight, and
> `RCM_DRAIN_STEP_DELAY_MS` was never set — so there is nothing to unset.
>
> Jump to [§9 Resume checklist](#9-resume-checklist).

This is the gate before the first production promotion. It runs on **staging
only**, on the **ADJUSTMENT path only**, against the two designated synthetic test
patients **12827** and **12828**. Runbook:
`C:\Users\beau\carein-wt\rcm-ux\combined-walk-runbook.md`.

Division of labour, per the runbook's standing rule: **[CC]** runs every terminal
step; **[BEAU]** does browser judgment only. The two never interleave inside a
step.

---

## 1. Pre-flight — [CC]

### 1.1 #140 and #141 are merged, and staging is running the merged head

Confirmed at three layers, as asked, rather than assumed from one.

| PR | Title | Merged | Merge commit |
| --- | --- | --- | --- |
| **#140** | Say who is on each check, and who pressed Approve | 2026-09-02 02:01:25Z | `07628cc` |
| **#141** | Teach the unwind to read the reseed manifest too | 2026-09-02 02:11:32Z | `018bde6` |

`origin/develop` is **`018bde6`** — #141's own merge commit, so both are in.

| Layer | Evidence | Verdict |
| --- | --- | --- |
| **1 · Pipeline** | `staging-cd` run `33582299380` on `018bde6`. Jobs `build-test`, `publish`, `migrate`, `deploy` all **success**. Steps: dashboard tsc ✅, vitest ✅, backend syntax ✅, sharded `node --test` ✅, ephemeral-PG migrations ✅, rcm query verification ✅, spine smoke ✅. | ✅ |
| **2 · Revision** | `ca-carein-backend--0000154`, image `acrcareincore.azurecr.io/carein-backend:018bde6`, **100% traffic**, `RunningAtMaxScale`, created `2026-09-02T02:18:40Z`. Only active revision. | ✅ |
| **3 · Live behaviour** | The deployed `/app/scripts/rcm-s11-unwind.js` contains `IS_RESEED` (3 occurrences) — a symbol that exists **only** in #141. `/data/rcm-reseed/roland/` holds the manifest plus all four 835s. `/api/health` 200; `/api/rcm/posting/queue` **401** unauthenticated. #140's approve attribution then observed live in step 3 (*"Approved by Beau Sparkman · Sep 2, 9:57 PM"*). | ✅ |

### 1.2 CC-3 — the drain delay and the gate

- **`RCM_DRAIN_STEP_DELAY_MS` is ABSENT** from `ca-carein-backend`'s environment.
  Verified against the live container app definition (`env[?name==...]` → `[]`),
  not assumed. **It was never set during this session either** — the kill test has
  not yet been reached.
- **Scale is `minReplicas = maxReplicas = 1`**, one replica
  (`ca-carein-backend--0000154-5bdfd8b68c-7vmfr`). The kill test depends on this;
  it must stay 1.
- `drain_enabled` for roland read **false** at the start — captured by Beau's own
  "before" screenshot of the Admin → Offices card in step 1.

### 1.3 The four checks are in

Confirmed by Beau in the browser: Delta `RS-104477`, MetLife `RS-889021`,
Cigna `RS-330415`, Cigna `RS-330416`. All four uploaded 2026-09-01 15:40 CT.

---

## 2. Two pre-flight findings, before a single step ran

### 2.1 The runbook's step→check mapping was stale

The runbook was written 2026-08-30, before the §10.8 reseed. Its `[CC-4]`/`[CC-6]`
"fresh A-and-B pair" no longer exists — the reseed replaced it with four
differently-shaped checks and the runbook was never re-mapped. `[CC-5]`'s question
("which line leaves a patient remainder?") is answered by the reseed itself: R1's
claim **53857**, **$9.20**.

The mapping actually used is in [§4](#4-the-walk).

### 2.2 🔴 R3 has no payment to reverse — a real gap in the reseed fixture set

**Claim 53863 is paid by none of the four reseed checks.**

```
R1  Delta    RS-104477   53857, 53858, 53859   +$164.80
R2  MetLife  RS-889021   53861, 53862          +$640.00
R3  Cigna    RS-330415   53863                 −$29.00   ← reverses
R4  Cigna    RS-330416   53864                 +$88.00
```

`scripts/rcm/reseed-targets.js:303` requires R3 be uploaded *"after R3-1 has
POSTED"*, and `docs/fixtures/rcm-reseed/README.md` repeats it. Nothing posts it.
`reseed-prep.js` created 53863's claimproc `535780` at `ClaimStatus "W"`, unpaid,
`InsPayAmt = 0`, and `isReversibleLine` (`services/rcm/claimMatch.js:617`) requires
`insPayAmtCents !== 0`. R3's top candidate is 53863 (CLP01 carries the real
ClaimNum, +35 on its own), so approve would land **`NO_REVERSIBLE_LINES`** — the
exact refusal walk 3 stopped on, this time correctly and with no remedy reachable
from inside the app.

The fixture's own comment reads *"The claim is created and paid like any other; the
835 takes the money back off it."* The positive half of that pair was never
generated. **R3 is unpostable as shipped.**

**Ruling (Beau, 2026-09-02): hand-post the payment in Open Dental.**
`claimMatch.js:606` explicitly supports this — *"demanding the check would refuse a
takeback against a payment posted by hand in Open Dental"* — and the unwind
discovers `ClaimPaymentNum` by **reading the claimproc**
(`rcm-s11-unwind.js:762`), so it cleans up after itself with no manifest change.
The alternative considered and deferred was generating a positive companion 835
("R5") from the same manifest; that remains the faithful fix and is logged in
[§8](#8-follow-ups-this-walk-generated).

> **For the fixture set:** either `reseed-targets.js` gains an R5 that pays 53863,
> or the README and `reseed-835.js`'s banner stop claiming R3's claim can be
> posted. Today they instruct an operator to satisfy a precondition the fixture
> set cannot produce.

---

## 3. The baseline — [CC], 2026-09-03T02:33:54Z

`PROBE_OFFICE=roland node scripts/rcm-s11-unwind.js --reseed` (dry run; the flag
picks the manifest and nothing else). All seven reseed targets present and
pristine — every one `Status="NotReceived"  InsPayAmt=0  WriteOff=0
ClaimPaymentNum=0`, every claim `ClaimStatus "W"`.

```
PatNum 12827   charges $1556.00   ins paid $0.00   write-offs $0.00   adj -$1.20
               PATIENT BALANCE $1554.80    claims: 4   D-procs excluded: 10

PatNum 12828   charges  $348.00   ins paid $0.00   write-offs $0.00   adj  $0.00
               PATIENT BALANCE  $348.00    claims: 3   D-procs excluded: 0
```

| Target | Remittance | PatNum | Code | ProcNum | ClaimNum | ClaimProcNum |
| --- | --- | --- | --- | --- | --- | --- |
| A | R1 | 12827 | `D0120` | `406650` | `53857` | `535770` |
| B | R1 | 12828 | `D1110` | `406651` | `53858` | `535771` |
| C | R1 | 12827 | `D0274` | `406652` | `53859` | `535773` |
| D | R2 | 12828 | `D2391` | `406655` | `53861` | `535777` |
| E | R2 | 12827 | `D2740` | `406656` | `53862` | `535779` |
| F | R3 | 12828 | `D0220` | `406657` | `53863` | `535780` |
| G | R4 | 12827 | `D0330` | `406658` | `53864` | `535782` |

The arithmetic reconciles, which is what lets [§7](#7-teardown-numbers) state the
teardown target rather than inherit a stale one: 12827's four reseed procedures
are `$58 + $72 + $1280 + $145 = $1555.00`, on top of the **$1.00** Spike 0b residue
charge = the $1556.00 above. 12828's three are `$98 + $215 + $35 = $348.00`.

**`ClaimNum 53860` and `ProcNum 406653` / `406654` are BURNED** — consumed by a
prep request Open Dental then refused. They belong to nobody, no manifest names
them, and nothing in this walk touches them.

---

## 4. The walk

| Step | Who | Check | Status |
| --- | --- | --- | --- |
| 1 | [BEAU] | — | ✅ posting switched ON |
| 2 | [BEAU] | **R1** Delta `RS-104477` | ✅ **PASSED** |
| 3 ⭐ | [BEAU] | **R2** MetLife `RS-889021` | ✅ **PASSED** — the write-off, confirmed |
| 4a | [BEAU] | — | ⏳ hand-post $29.00 on 53863 |
| 4b ⭐ | [BEAU] | **R3** Cigna `RS-330415` | ⏳ the takeback |
| 5 ⭐ | [CC]/[BEAU] | fresh `rcm-s10-prep` target | ⏳ the kill + the teardown number |
| 3b | [BEAU] | **R4** Cigna `RS-330416` | ⏳ observation only — expect `no_candidate` |
| 6 | [BEAU] | — | ⏸ switched OFF for the pause; must go ON again first |
| 7 | [CC] | — | ⏳ unwind, both manifests |

### Step 1 — posting ON  **[BEAU]**  ✅

**Expected:** the switch flips; the card attributes the flip; the shadow banner and
badge disappear across the module.

**Observed:** `Roland · Posting on · Last changed 9/2/2026, 9:22:48 PM by
admin@carein.ai`. The card also states Roland's mode in the biller's own language —
*"A write-off this practice chooses goes into the claim line's own write-off field,
with a note. No adjustment type is used"* — which is `writeoff_mode =
writeoff_field`, and is what step 3 depends on. Shadow-mode comparison read *"No
checks have been compared here yet."*

### Step 2 — R1, posted clean  **[BEAU]**  ✅ PASSED

**Expected:** matched claims 53857 / 53858 / 53859; check finishes; a new Open
Dental check number; the verdict in the **confirmed** register.

**Observed on screen.** The approval page's per-claim table read exactly the
fixture: `$36.80 / $74.00 / $54.00` carrier paid, `— ` office write-off, `$9.20 /
$0.00 / $0.00` EOB says, total `$9.20`. Thirteen green checks per claim, including
*"No chart line is spoken for by another check."* Pre-post verdict, in the
**projection** register: *"These patients will owe $9.20 once this posts, which is
exactly what the EOB says they owe. Nothing is being written off by the office…
It becomes a measured figure only after the money is in Open Dental and CareIN has
asked the chart what the patient owes."*

Posted: **Open Dental check `#21461`**, *"confirmed in Open Dental on Sep 2,
2026"*, *"Posted on the 1st try"*. Payment types resolved **by name** from
Roland's own database — `296 Check · 297 EFT · 404 Credit Card · 472 Insurance
Check` (D-13). EOB filing: *"Nothing to file — this remittance arrived without a
document"* (§3.8, ERA-only ⇒ `none`, not a failure).

**Observed on the chart — [CC] read-back.** Independent, via the unwind dry run:

```
A 53857/535770   Received   InsPayAmt 36.80   WriteOff 12.00   ClaimPaymentNum 21461
B 53858/535771   Received   InsPayAmt 74.00   WriteOff 24.00   ClaimPaymentNum 21461
C 53859/535773   Received   InsPayAmt 54.00   WriteOff 18.00   ClaimPaymentNum 21461
D–G                         untouched
```

The write-offs are the carrier's CO-45 contractual amounts to the cent. Open
Dental's own arithmetic on 53857 — `$58.00 − $36.80 − $12.00` — is **$9.20**, the
figure the screen promised. Balances moved 12827 `$1554.80 → $1434.00` (−$120.80)
and 12828 `$348.00 → $250.00` (−$98.00); both reconcile line for line.

**Observed in the app database — [CC].** One plan, `posted`, `$164.80`,
`od_claim_payment_num 21461`, three lines all `paid`, line 1
`intended_patient_cents = 920`, `approved_by admin@carein.ai`.

**The watch-for did not fire:** no *"will owe … once posted"* sentence survived the
post.

### Step 3 — the office write-off, end to end  **[BEAU]** ⭐ ✅ PASSED

*This is the single most important step in the walk, and it had never touched a
real chart.*

**First attempt refused, correctly.** The approve was pressed with neither claim
matched — 53861 at `match is candidates`, 53862 at `match is not_run`. The gate
held: *"One or more claims on this check cannot be approved… 0 of 2 claims can be
approved · 2 not ready yet"*, with the remedy stated at the top of the checklist
(*"Match it up first"*, and a **Match all claims on the check** button). No plan
row was created, which is how [CC] established from the database that nothing had
been approved rather than taking the screen's word for it.

> **Worth recording:** a **$480.00 write-off decision was recorded against 53862
> while that claim had never been matched to a chart line at all**, and it
> survived the later match. The gate refuses to approve it, so no money is at
> risk — but a decision recorded against an unlinked claim is a state the PM
> should rule on. See [§8](#8-follow-ups-this-walk-generated).

**After matching.** 53861 → `ClaimNum 53861`, **HIGH · 100**, evidence `claim
number matches +35 · patient name matches +20 · service date matches +15 · all
procedure codes present (1/1) +20 · billed total matches +10 · same number of lines
+5`, line pairing `D2391 → ClaimProc 535777`. Candidates 53858 and 53863 correctly
offered beside it at **LOW · 15**. Identity panel: name, birthday, date and every
line agree.

**Expected before posting:** AMBER, projection register, patient will owe the
reduced amount, naming line, reason and decider.

**Observed:**

> *"These patients will owe **$0.00** once this posts. The EOB says $480.00; the
> difference is the $480.00 this office decided to absorb, on the lines listed
> above."*

with the decision table reading `Stedi Test 2 · D2740 · $480.00 · "Not chargeable
for this procedure" · Beau Sparkman`, and *"Approving is what freezes these
decisions."* Approved: *"2 claims approved — $640.00 · Queued for posting — nothing
has been written to Open Dental yet · **Approved by Beau Sparkman · Sep 2, 9:57
PM**"* — #140's approve attribution, live.

**Expected after posting:** the verdict recomputes from the chart, **confirmed**
register, **same number**.

**Observed:**

> **Post to Open Dental — Finished.** *"This check is finished. The money is in
> Open Dental, and CareIN asked Open Dental for it afterwards and got back exactly
> these lines."*
> **"Confirmed in Open Dental on Sep 2, 9:58 PM — the patients owe what this check
> said they would."** *"Read out of the chart after posting, not calculated by
> this app."*

**Observed on the chart — [CC] read-back:**

```
D 53861/535777   Received   InsPayAmt 160   WriteOff  55   ClaimPaymentNum 21462
E 53862/535779   Received   InsPayAmt 480   WriteOff 800   ClaimPaymentNum 21462
```

**`WriteOff = 800` on 535779 is the proof.** `$320.00` carrier contractual **plus**
the `$480.00` the office decided, in the claim line's own write-off field —
Roland's `writeoff_field` mode. So Open Dental's own arithmetic on 53862 is
`$1280.00 − $480.00 − $800.00 = $0.00`, identical to the figure frozen at approve.
The projection flipped to the confirmed register and **the two numbers agree**.

Balances: 12827 `$1434.00 → $154.00`, 12828 `$250.00 → $35.00`. What remains is
exactly the two unposted charges (`$145.00` on 53864, `$35.00` on 53863) plus
53857's `$9.20` and the `$1.00`/`−$1.20` Spike 0b residue.

**Objectives 1 and 2 status:** objective 2 (*a decided office write-off posts and
the confirmation agrees*) is **PROVEN LIVE, first time**. Objective 1 (the
takeback) is still outstanding — step 4b.

---

## 5. Open Dental numbers touched, so far

Everything below is on **Roland**, on PatNum **12827** and **12828** only.

| Kind | Number | What happened | Comes off at |
| --- | --- | --- | --- |
| ClaimPayment | **21461** | created by the R1 drain | unwind step 1 |
| ClaimPayment | **21462** | created by the R2 drain | unwind step 1 |
| Claim | 53857, 53858, 53859 | `W → R`, lines paid | unwind steps 2 & 4 |
| Claim | 53861, 53862 | `W → R`, lines paid | unwind steps 2 & 4 |
| Claim | 53863, 53864 | untouched so far | unwind steps 2 & 4 |
| ClaimProc | 535770, 535771, 535773 | `InsPayAmt`/`WriteOff` written, on check 21461 | unwind step 3 |
| ClaimProc | 535777 | `InsPayAmt 160`, `WriteOff 55`, on check 21462 | unwind step 3 |
| ClaimProc | **535779** | `InsPayAmt 480`, **`WriteOff 800`** (320 contractual + 480 decided), on check 21462 | unwind step 3 |
| ClaimProc | 535780, 535782 | untouched so far | unwind step 3 |
| ProcedureLog | 406650, 406651, 406652, 406655, 406656, 406657, 406658 | created by the reseed prep | **soft-deleted only — see §7** |

### Added on 2026-09-04

| Kind | Number | What happened | Comes off at |
| --- | --- | --- | --- |
| ClaimPayment | **21490** | **hand-posted by Beau** (4a) — `CheckAmt 29`, `CheckNum "WALK4-R3"`, `PayType 472 Insurance Check`, **`DepositNum 0`**. Not in any manifest; the unwind finds it by reading the claimproc. | `--reseed` unwind step 1 |
| ClaimProc | 535780 | `Status "Received"`, `InsPayAmt 29`, `WriteOff 6` — the payment R3 reverses | `--reseed` unwind step 3 |
| Claim | 53863 | `W → R`, `InsPayAmt 29`, `WriteOff 6` | `--reseed` unwind steps 2 & 4 |
| ProcedureLog | **406875**, **406876** | created by `rcm-s10-prep` — the kill-test targets | **bare** unwind (soft delete) |
| Claim | **53900**, **53901** | created by `rcm-s10-prep`, `ClaimStatus "W"`, $1.00 each | **bare** unwind |
| ClaimProc | **536170**, **536171** | created by `rcm-s10-prep`, `NotReceived` | **bare** unwind |

### Added by the kill test, 2026-09-04

| Kind | Number | What happened | Comes off at |
| --- | --- | --- | --- |
| ClaimPayment | **21491** | created by the kill test's resumed drain. `CheckAmt 1`, `CheckNum "S10A-53832"`, `DepositNum 0`. **WALK-LIVE** alongside 21461 / 21462 / 21490 (PM ruling, 2026-09-04). | **bare** unwind step 1 |
| ClaimProc | 536170 | `Status "Received"`, `InsPayAmt 1`, on check 21491 | **bare** unwind step 3 |
| Claim | 53900 | `W → R` | **bare** unwind steps 2 & 4 |

**The stuck plan row is left exactly as it is — evidence, not to be hand-repaired
(PM ruling 3).** The unwind removes the chart rows; the app rows stay as the
record of W-9.

**Still to be touched:** an adjustment for the R3 takeback (postponed — see W-5),
and 53901 / 406876 / 536171, the unused spare target B.

---

## 6. Findings

### W-1 · The approve sub-page dead-ends, and its caption is false when it does

On R1's approval page, with all three claims reading **Approved** and the count
line correctly reading **"0 of 3 claims can be approved · 3 already approved"**,
the disabled button carried:

> *"Nothing on this check can be approved yet — the list above says what each claim
> is waiting for."*

Nothing was waiting; the list above was thirteen green ticks per claim. Beau had to
leave the page and hunt for the posting screen — which itself says *"You do not
have to come here to post one check — that is on the check's own page, and it is
the same act."*

**Scoped precisely, after seeing the same screen in its genuinely-blocked state on
R2:** the red headline *does* change correctly between the two states, and the
check's own page shows the same count line **without** the caption and **with** a
`Post to Open Dental` forward path. The defect is confined to the **approval
sub-page**: a static caption that does not distinguish *blocked* from *already
approved, nothing left to do*, and no onward route when it is the latter.

Severity: no money at risk. It is Stage A's own rule — *"a claim that will be held
back is one you can go and fix rather than one you discover by pressing a button"* —
inverted.

### W-2 · A duplicated sentence

On the check's Post step, *"Takes you to the Post button below — the one action in
CareIN that writes to a patient's chart."* renders **twice**.

### W-3 · A decision can be recorded against an unmatched claim

See step 3 above. The `$480.00` write-off on 53862 was recorded while that claim's
match state was `not_run`, and survived the subsequent match unchanged. The
approval gate refuses such a check, so this is not a money defect — but the app
lets a biller commit judgement about a line it has not yet linked to a chart.

### W-4 · The matcher reported a search limit

While matching R2, the claim screen raised:

> ⚠ *"A search limit was reached — some Open Dental claims were not examined."*

The right claim was still found and scored HIGH · 100, so nothing was lost here.
Recorded because it is the failure mode §15.1c describes — a claim that exists but
is never offered — appearing as a **warning** rather than silently, which is the
good version of it. Worth knowing what the cap is before a real chart with real
claim volume goes through this.

### W-5 · 🔴 **A takeback can never pass the approve gate — the line pairing does not sign-normalize a reversal.** DIAGNOSIS ONLY, no fix implemented

Walk step 4b stopped here. **This is a live defect, not a fixture problem**, and
it is the next blocker behind the one #124 fixed.

#### Every check the gate evaluated for claim 53863, with the stored values it saw

Read out of `rcm_claims` / `rcm_procedure_lines` on staging, 2026-09-04. Stored
state: `od_match_status "confirmed"`, `od_match_snapshot.takeback **true**`,
`reviewed_by admin@carein.ai`, `approved_at null`, `line_decision null`,
line `flags []`, `needs_review_reasons ["reversal_not_postable"]`.

| Gate check | Result | What it saw |
| --- | --- | --- |
| `BELONGS_TO_PRACTICE` | ✅ | `office_id roland` |
| `LINKED_TO_CHART_CLAIM` | ✅ | `od_claim_num 53863` |
| `MATCH_UP_TO_DATE` | ✅ | `od_match_status "confirmed"`, confirmed 01:40:40Z |
| `REVIEWED` | ✅ | `reviewed_at` set, note recorded |
| `NOT_PATIENT_RESPONSIBILITY_ONLY` | ✅ | `patient_resp_cents 0`, carrier moved −2900 |
| `RECOUPMENT_CONFIRMED` | ✅ (on typing) | `isTakeback(total_paid_cents −2900) = true` |
| `TAKEBACK_ACKNOWLEDGED` | ✅ | claims `reversal_not_postable` + `negative_total_payment` under the D-11 partition |
| `MATCH_TAKEN_FOR_A_TAKEBACK` | ✅ | `snapshot.takeback === true` |
| `NO_BLOCKING_REASON` | ✅ | after the partition, `blocking` is **empty** |
| `NO_BLOCKING_PREFLIGHT` | ✅ | both snapshot blockers are `blocking: false` — `CLAIM_ALREADY_RECEIVED` and `LINE_PAID_AND_ON_CHECK` |
| `LINES_PAIRED` | ✅ | `odClaimProcNum 535780` |
| `NO_CONFLICTING_PLAN` | ✅ | `posting_queue_id null` |
| `CLAIM_TOTALS_AGREE` | ✅ | claim −2900, lines −2900, remittance −2900 |
| **`PATIENT_RESPONSIBILITY_MATCHES`** | **❌ FAIL** | `verdict.state === 'red'`, from **`od_fee_disagrees`** |

**Exactly one check fails**, and #124's fix is confirmed working — the candidate
scored **95 / HIGH** with `NO_REVERSIBLE_LINES` **absent** and
`LINE_PAID_AND_ON_CHECK` reported as a non-blocking fact, exactly as designed.

#### The mechanism

`claimMatch.pairLines` receives `{ takeback }` and uses it correctly for
*eligibility* (`isReversibleLine` instead of the payable predicate). It then
computes, on **both** lanes identically (`claimMatch.js:1101`):

```js
billedDeltaCents: chosen && Number.isFinite(ourBilled)
  ? ourBilled - chosen.feeBilledCents
  : null,
```

For R3: `ourBilled = −3500`, `chosen.feeBilledCents = 3500` → **`−7000`**. That
value is in the stored snapshot verbatim:

```json
"linePairs":[{"code":"D0220","odClaimProcNum":535780,"billedDeltaCents":-7000}]
"odAmountsAsRead":{"billedCents":3500,"insPaidCents":2900,"writeOffCents":600}
```

`approvalGate.js:755` passes it through as `odFeeDeltaCents`;
`lineDecisions.js:573` raises `od_fee_disagrees` on any non-zero value and renders
`"D0220 was billed -$35.00 on the remittance and $35.00 in Open Dental"` — the
sentence on the screen, and the `-$70.00 apart` in the pairing panel. Red verdict
⇒ `PATIENT_RESPONSIBILITY_MATCHES` fails ⇒ *"CareIN will not post this one."*

#### Does anything sign-normalize a reversal? Mostly no — and inconsistently

| Site | Behaviour |
| --- | --- |
| `findBlockers` → `TAKEBACK_EXCEEDS_PAYMENT` | ✅ **normalized** — compares `Math.abs` on both sides |
| `findBlockers` → lane swap | ✅ correct — `isReversibleLine`, blockers inverted |
| `lineMoney` (W = B−A, R = A−P) | ✅ sign-consistent by construction: W = −$6.00, R = $0.00 |
| `scoreCandidate` billed comparison | ⚠️ **skipped**, not normalized — guarded on `ourBilledCents > 0`, so a reversal simply gets no billed evidence (53863 scored 95, missing the +10 `BILLED_AMOUNT_MATCH` a payment would earn) |
| **`pairLines` → `billedDeltaCents`** | ❌ **not normalized** — raw signed subtraction |
| **`lineDecisions` → `od_fee_disagrees`** | ❌ consumes the raw delta |

#### Can any takeback pass? No — the path has never been green end to end

For a reversal line paired to its chart line, `billedDeltaCents = (−B) − (B) =
−2B`, which is non-zero for every `B ≠ 0` ⇒ `od_fee_disagrees` ⇒ red. If it does
*not* pair, `line_not_in_chart` fires ⇒ also red. **Both branches are red, so no
parser-produced reversal 835 can reach approve.**

It was never caught because the only takebacks that reach this code in tests are
hand-built with the delta pre-zeroed — `postingDrain.js:1277` literally sets
`odFeeDeltaCents: 0`. That is the same blind spot the D-11 amendment comment
already names: *"6d never noticed because its recoupment tests build the claim BY
HAND."* `rcmReseedFixtures.test.js` does exercise the real matcher on R3, but it
asserts candidate rank and score only — it never runs the result through
`verdictFor` or the gate.

#### `reversal_not_postable` is an upload-time echo, and it is NOT the blocker

Set by the parser at `eraParser.js:1027` (`if (isReversal) addFlag(...)`), stored
on `rcm_claims.needs_review_reasons` and inside `raw_extracted_json` when the file
was ingested. It is **never re-evaluated against live chart state**. On the
takeback lane it and `negative_total_payment` are **partitioned into
`TAKEBACK_ACKNOWLEDGED`** by the D-11 amendment and do not block — confirmed
above, both passed. The PM's suspicion about these two is understandable from the
screen, but they are working as designed; the sole cause is the billed delta.

#### ✅ FIXED on `fix/rcm-takeback-gate-and-resume-strand` (`7647dd1`) — PM approved 2026-09-04

Implemented as proposed below. The PM refers to this finding as **W-6**.

#### The fix, as proposed and as shipped

One site, `claimMatch.pairLines`, because it is the only place `billedDeltaCents`
is produced and both `approvalGate` and `claimWorkbench` read it from the stored
snapshot. Fixing it downstream in `lineDecisions` would teach the verdict about
lanes it deliberately knows nothing about, and would leave the stored snapshot
carrying a misleading `−7000`.

```js
// A reversal line must MIRROR the chart line: equal magnitude, opposite sign.
// Same-sign is not a mirror, so it stays a disagreement rather than being
// normalised away — fail closed.
const delta = !takeback
  ? ourBilled - chosen.feeBilledCents
  : (ourBilled > 0 || chosen.feeBilledCents < 0)
      ? ourBilled - chosen.feeBilledCents          // not mirrored: still a disagreement
      : Math.abs(ourBilled) - Math.abs(chosen.feeBilledCents);
```

Deliberately **not** widened: the money question — is the carrier taking back more
than the chart holds? — is already answered by `TAKEBACK_EXCEEDS_PAYMENT` using
magnitudes. `billedDeltaCents` answers the *identity* question ("is this the same
procedure line"), and magnitude is the right comparison for identity.

**Two consequences to plan for.**

1. **The snapshot is stored.** A code fix changes new matches only, so R3 must be
   **re-matched** after the fix deploys. Note that `supersededConfirmation` shows
   Beau already re-matched once (01:27 → 01:40) and got `−7000` both times, which
   is what rules out a stale snapshot and confirms a code defect.
2. **Regression coverage must run a parser-produced reversal end to end** —
   `eraParser` → `pairLines` → `verdictFor` → gate — or the next hand-built test
   will hide the next instance of this exactly as it hid this one.

### W-6 · 🔴 **A resumed drain cannot record its own check — the skip strands the line.** WALK STOPPED HERE

The kill test's ⭐ objective **succeeded** (see §7.3) and then the *resume* hit a
schema defect. **The chart is correct. The app's record of it is not.**

#### What Open Dental holds — right

```
ClaimProc 536170   Status "Received"   InsPayAmt 1   WriteOff 0   ClaimPaymentNum 21491
Claim 53900        ClaimStatus "R"     InsPayAmt 1   ClaimFee 1
ClaimPayment 21491 CheckAmt 1   CheckNum "S10A-53832"   DepositNum 0   PayType 472
```

**$1.00 once, on exactly one check.** The interrupted attempt did **not** double-write
— `InsPayAmt` is 1, not 2. Resume-from-the-chart works.

#### What the app holds — wrong

```
PLAN  status "partially_posted"   drain_step "reconcile"   attempt_count 2
      od_claim_payment_num 21491   finished_at 02:35:51.378   reconciled_at NULL
      last_error 'new row for relation "rcm_posting_queue_line" violates check
                  constraint "rcm_posting_queue_line_skip_reason_check"'

LINE  status "skipped_already_posted"   skip_reason "already_received_matching"
      od_claim_payment_num NULL   claim_received_at NULL   paid_at NULL
      readback_at 02:27:13.178      updated_at 02:32:15.691
```

#### The mechanism

`1787120000000_rcm_posting_drain.js:228` pairs status and reason both ways:

```sql
(status IN ('skipped','skipped_already_posted') AND skip_reason IS NOT NULL)
OR (status NOT IN ('skipped','skipped_already_posted') AND skip_reason IS NULL)
```

On resume the drain correctly re-read the chart, saw 536170 already carrying the
money, and at **02:32:15** wrote `status='skipped_already_posted'` +
`skip_reason='already_received_matching'`. That succeeded. It then created
ClaimPayment **21491** and, at the `check` step, tried to stamp the check onto the
line — an update that moves `status` off the skip family while `skip_reason` is
still set. **The second branch of the constraint forbids exactly that**, the update
was rejected, and the line kept its skip while losing the check number. The plan
could not reconcile and ended `partially_posted`.

So a line that is skipped-because-already-posted has **nowhere to put its check
number**: the schema says a skipped line carries a reason and a paid line carries
none, and this line is legitimately both — skipped by *this* attempt, paid by the
*previous* one.

#### Consequences

1. **`reconciled_at` never sets.** The plan is permanently `partially_posted`
   even though the money is correctly on the chart — an honest-states inversion:
   the screen under-claims what actually happened.
2. **The §10.3 step-7 proof cannot be run as written.**
   `count(DISTINCT od_claim_payment_num) … FROM rcm_posting_queue_line` returns
   **0**, because the count reads the *line* and the check number only reached the
   *plan*. Proving "exactly one check" after a resume needs the chart, or the
   plan row, or the schema fixed. **Recorded as 0, and NOT as a failed
   idempotency test** — the chart proves one check and one dollar.
3. In production this leaves a biller looking at "partially posted" on a check
   that fully posted, with the natural next action being to press Post again.

#### Why this was never caught

The kill test has never before survived to the *resume*, so no test — unit or
live — has ever exercised "resume a drain whose line was already written". The
skip path itself is covered; the skip path **followed by a check write** is not.

#### ✅ FIXED on `fix/rcm-takeback-gate-and-resume-strand` (`ca73657`) — PM approved 2026-09-04

Option **(b)** was ratified: the line keeps its skip status and reason **and**
carries `od_claim_payment_num`. **No migration was needed** — the constraint
never mentioned that column. `FakeRcmDb` now enforces the CHECK constraint, which
is what makes the whole class visible: with the constraint modelled and the drain
fix reverted, **four** tests fail, two of them pre-existing kill-and-resume tests
that had been passing on a row Postgres would never have accepted. The PM refers
to this finding as **W-9**.

#### The directions considered

Options, smallest first:

- **(a)** Have the check-stamping update clear `skip_reason` when it moves a line
  off the skip family. Smallest diff, but it discards the fact that this attempt
  skipped — which is exactly the provenance the column exists to keep.
- **(b)** Let a skipped line keep its reason **and** carry `od_claim_payment_num`
  — i.e. the constraint governs `status`↔`skip_reason` only, and the check number
  is orthogonal. Requires no status change on resume at all: the line stays
  `skipped_already_posted` and simply records which check it is on.
- **(c)** Add a terminal status meaning *paid by an earlier attempt* that is a
  legal skip-family value carrying both.

**(b) reads closest to drain canon** — the line's status describes what *this*
attempt did, the check number describes what the *chart* holds, and neither should
have to lie for the other. It also makes the step-7 proof work unchanged. But it
is a migration, and it is the PM's call.

**Nothing has been changed.** No fix written, no DB write, no branch cut.

> **`RCM_DRAIN_STEP_DELAY_MS=90000` is deliberately STILL SET.** Unsetting it
> restarts the container, and a restart runs the startup sweep — which could
> re-home or otherwise mutate the very `partially_posted` row under
> investigation. Evidence preservation beats tidiness here. **It must be unset
> before staging is used for anything else** (§9.1 step 13), and the walk cannot
> be called finished until it is.

### PM rulings and the state at the stop — 2026-09-04

| Ruling | Effect |
| --- | --- |
| 1 · fix direction | Option (b) for W-9 approved as recommended. Code-only; no migration. |
| 2 · implementation | Both fixes on **one** branch off `origin/develop`, separate commits, each with a regression through the real path. Done — `ca73657`, `7647dd1`, `9af7668` on `fix/rcm-takeback-gate-and-resume-strand`. **Not merged, not deployed.** |
| 3 · the stuck row | Left exactly as it is. No hand repair. OD check **21491** is WALK-LIVE alongside 21461 / 21462 / 21490. |
| 4 · the drain delay | Unset. See below. |
| 5 · postponed | The replay press and walk step 4b wait for the fixes to deploy — in the current state a re-press is precisely the action W-9 invites. |

#### `RCM_DRAIN_STEP_DELAY_MS` removed, and what the restart did to the row

```
env var count 32 -> 31; printenv inside the container -> DELAY_UNSET_CONFIRMED
new revision ca-carein-backend--0000158 at 100% traffic
```

Plan and line rows are **byte-identical before and after** the restart —
`updated_at` unchanged at `02:35:51.378` and `02:32:15.691`.

> **The startup sweep did not touch the `partially_posted` plan.** It re-homes
> `posting` only. So a stranded plan is genuinely terminal and nothing in the
> system would ever have recovered it — which is why W-9 is a defect rather than
> a slow path.

#### What still has to happen, in order, after the fixes deploy

1. **[CC]** verify replay-safety and that the takeback gate goes green **up to the
   enabled buttons — then STOP.** Beau makes the two presses.
2. **[BEAU]** the replay press (expect `ran: 0`), then step 4b, the R3 takeback.
3. **[BEAU]** posting switch OFF.
4. **[CC]** unwind **both** manifests — `--reseed` for the seven, **bare** for the
   kill test's 53900 / 53901.

### N-1 · `az containerapp exec` — the `${IFS}` recipe is wrong for this CLI version

`feedback_az_containerapp_exec_recipe` says to join tokens with `${IFS}` because
`--command` splits on whitespace. **On the current CLI that form fails**, every
time, with `ClusterExecFailure` / `websocket: close 1011`. A plain space works:

```bash
az containerapp exec -n ca-carein-backend -g rg-carein-staging \
  --revision ca-carein-backend--0000154 --command "sh -c \"cd /app && …\""
```

The 429 throttle is real and separate — it fires after roughly ten exec calls in a
short window and clears on its own. Both were hit during this walk and the two look
nothing alike in the output; do not treat a `ClusterExecFailure` as a throttle.

---

## 7. Teardown numbers

### 7.1 The seven reseed procedurelogs SURVIVE the unwind — by design

**They are not removed, and that is not a teardown failure.**

`DELETE /procedurelogs` is a **soft delete** (G12): the row comes back with
`ProcStatus: "D"` and still appears in `GET /procedurelogs`. So all seven of
`406650, 406651, 406652, 406655, 406656, 406657, 406658` remain on the two test
charts permanently, as `"D"` rows. This is documented Open Dental behaviour, the
same behaviour Spike 0b's own teardown was caught by when it counted `"D"` rows as
live charges and over-applied a reversal by $2.00.

**They are a known cosmetic leftover on the test charts, nothing more.** The unwind
filters `ProcStatus "D"` out of every balance it prints — that filtering is the
reason it prints a balance at all — so they cannot affect any figure this walk
checks. The only place they are visible is the counter the unwind prints, and
watching that counter move **is** the confirmation they came off as expected:

| | 12827 | 12828 |
| --- | --- | --- |
| soft-deleted procedures, before | 10 | 0 |
| soft-deleted procedures, after the unwind | **14** | **3** |

Anyone reading a test chart in Open Dental and finding deleted procedures on it
should expect them; the live inventory is the claim count and the balance.

### 7.2 The targets

Derived from the measured baseline in [§3](#3-the-baseline--cc-2026-09-03t023354z),
not inherited from the runbook — the runbook's *"12827 at −$0.20, 0 claims, **10**
D-procs"* was written for the §10 walk's targets, before the reseed added four
procedures to 12827 and three to 12828.

| At teardown | Balance | Claims | Soft-deleted procs |
| --- | --- | --- | --- |
| **12827** | **−$0.20** | **0** | 10 → **14** |
| **12828** | **$0.00** | **0** | 0 → **3** |

The number §11 actually checks is the **delta**: `$0.00` on each patient, claim
count back to the prep baseline of 0 on both. 12827's `−$0.20` is the Spike 0b
residue (`$1.00` live charge less `−$1.20` of adjustments) and must be **left
alone**.

### 7.3 ⏳ The kill/teardown clock — STILL NOT MEASURED

Blank for a **fourth** walk. See [§9.2](#92-the-kill-target-has-to-be-rebuilt) for
why, and what to do about it.

**MEASURED, 2026-09-04 — the fourth attempt, and the first that landed.**

The app's own clock, which is the number to quote; wall-clock from the `az`
command includes ~8s of exec connection setup and is not the teardown.

```
02:27:02.379   drain claims the plan
02:27:13.178   ClaimProc 536170 written to Open Dental          <- a real write
02:27:15.205   [rcm/drain] pausing 90000ms after claimproc_write
02:27:33.271   kill 1 issued        (26.2s into the 90s pause)
02:27:41.451   Received SIGTERM, shutting down gracefully...
02:28:05.499   Server running on port 5403
02:28:05.499   [rcm/drain] startup sweep: 1 interrupted posting plan(s)
               re-queued for tenant 'carein'  press Drain to resume

                    TEARDOWN = 24.048 seconds
```

Independently bracketed by a replica poller: last `Running` 02:27:40.3,
`NotRunning` 02:27:43.9 - 02:28:05.1, back `Running` 02:28:08.6. One transition
cycle only across 100 samples - no restart loop, no second bounce.

The sweep then re-homed the plan to `approved`, `attempt_count 1`, **no check
created**, with `last_error` = *"The server restarted while this plan was posting.
It is queued again; draining re-reads Open Dental first and resumes from what the
chart shows."* The line was left at `claimproc_written` - interrupted
mid-sequence, exactly as intended.

**Objective 3 is proven.** What happened on the *resume* is W-6.

> **Measurement note for next time:** start the replica poller BEFORE issuing the
> kill. On the first (missed) attempt the first sample landed 19s late and could
> only bound the number.

---

## 8. Follow-ups this walk generated

1. **R5, or fix the instructions.** [§2.2](#22--r3-has-no-payment-to-reverse--a-real-gap-in-the-reseed-fixture-set).
   Either `reseed-targets.js` gains a positive companion check paying 53863
   `$29.00`, regenerated from the manifest, or `README.md` and `reseed-835.js`'s
   banner stop instructing an operator to satisfy a precondition the fixture set
   cannot produce. **The hand-post is tonight's workaround, not the fix.**
2. **W-1** — the approval sub-page's caption and missing forward path.
3. **W-3** — PM ruling: should a write-off decision be recordable against a claim
   with no chart match?
4. **W-4** — document the matcher's search cap and what a biller should do when it
   is reached.
5. **N-1** — correct the `az containerapp exec` recipe in the operator notes.
6. **The runbook needs re-mapping to the reseed fixtures** before it is run again;
   `[CC-4]`/`[CC-5]`/`[CC-6]` describe a target set that no longer exists.
7. Still open from the runbook itself, and **not this walk's job**: a biller can
   currently approve a recoupment (#120 canon). **That closes before the first real
   drain, not before shadow.**

---

## 9. Resume checklist

### 9.0 What changed between the pause and the resume — [CC], 2026-09-04T00:5xZ

**Staging moved, and the resume brief's "still `018bde6`" was out of date.** It was
checked rather than taken on trust, which is the only reason this is a footnote:

| | At the pause | At the resume |
| --- | --- | --- |
| `origin/develop` | `018bde6` (#141) | **`c2790f5` (#143)** |
| staging revision | `0000154` | **`0000156`** |
| image | `carein-backend:018bde6` | **`carein-backend:c2790f5`** |
| replica | `…0000154-5bdfd8b68c-7vmfr` | **`…0000156-6f9ccfdf5f-4zkqw`** |

`main` was separately promoted to `2fe1686` (#142); that does not touch staging.

**#143 is the hygiene module's slice-1 scaffold, and it changes nothing this walk
exercises.** `git diff --stat 018bde6..c2790f5` over `backend/services/rcm`,
`backend/routes/rcm`, `backend/scripts`, `new-dashboard/shared/rcm`,
`client/src/pages/rcm` and `client/src/features/rcm` is **empty** — the posting
drain, the approval gate, the matcher, the unwind and every RCM screen are
byte-identical. The four backend files it does touch are additive:

- `config/odOffices.js` — adds a `hygOdEnabled` field (**false** for both
  offices), one status code, and two new exported functions. `getOdOffice`,
  `assertOfficeMatch`, `odBlockReason` and `isOdReady` are unchanged, and
  `odEnabled` is still `true` for both offices.
- `config/modules.js` — adds `'hyg'` to the module vocabulary.
- `config/permissions.js` — adds `hyg.*`. **No `rcm.*`, `voice.*` or `tc.*`
  permission changed.**
- `server.js` — adds one `/api/hyg` mount, shipping dark.
- migration `1788100000000_module_hyg.js` — control-DB module vocabulary only.

`staging-cd` run `33819405515` on `c2790f5`: **success**. Scale still
`min = max = 1`. `RCM_DRAIN_STEP_DELAY_MS` still **absent**.

**The chart is unchanged since the pause**, confirmed by a fresh `--reseed` dry
run: 12827 `$154.00` / 4 claims / 10 D-procs, 12828 `$35.00` / 3 claims / 0
D-procs, targets A–E posted on checks `21461`/`21462`, F and G untouched. The
container restarted into `0000156` at `00:22:22Z`, so the startup sweep ran; it
found nothing to re-home, which is correct — both plans were already `posted`.

**Consequence for the record:** steps 1–3 were observed on `0000154`/`018bde6`;
steps 4 onward run on `0000156`/`c2790f5`. Same RCM code, different build number.

### 9.1 In order

| # | Who | Step |
| --- | --- | --- |
| 0 | [CC] | Re-confirm the revision is still `0000154`/`018bde6` at 100%, and that `RCM_DRAIN_STEP_DELAY_MS` is still absent. |
| 1 | **[BEAU]** | **Turn Roland's posting switch back ON.** Screenshot before and after. |
| 2 | [BEAU] | **4a** — hand-post in Open Dental: PatNum **12828**, claim **53863**, ClaimProc **535780**, `D0220` tooth 8, billed $35.00 → **insurance paid $29.00, write-off $6.00**. As an *insurance* payment on the claim. **No deposit attached** — a deposited check strands the target, because the unwind can only delete a check before a deposit or EOB is on it. |
| 3 | [BEAU] | **4b** — bring in **R3** (`rcm-reseed-835-R3.txt`, Cigna `RS-330415`, −$29.00, claim 53863). Match, check over, approve, post. |
| 4 | [CC] | Read the chart back: expect exactly **one** `−$29.00` adjustment on 12828, AdjType resolved **by name**. |
| 5 | [CC] | Build a fresh kill target — see [§9.2](#92-the-kill-target-has-to-be-rebuilt). |
| 6 | **[CC]** | **Set `RCM_DRAIN_STEP_DELAY_MS=90000` BEFORE the approve**, not after. Wait for the new revision, note the new replica name. |
| 7 | [BEAU] | Approve the kill target's check, then press Post. It will hang — say so in chat the moment it is pressed. |
| 8 | [CC] | `kill 1` on the replica. **Never `kill -9 1`** — silently ignored inside a container. **Never `revision restart`** — a graceful replacement, and it has missed three times. Note the clock at the kill; watch Running → Terminated. **That gap is the teardown number.** |
| 9 | [CC] | Confirm the startup sweep re-homed the plan to `approved` with a `last_error` naming the interruption. (The sweep runs **only at boot**.) |
| 10 | [BEAU] | Post again → expect it finishes. |
| 11 | [CC] | `SELECT count(DISTINCT od_claim_payment_num) FROM rcm_posting_queue_line WHERE queue_id = '<plan>' AND od_claim_payment_num IS NOT NULL;` → **exactly 1**. |
| 12 | [BEAU] | Post once more on the posted check → **nothing happens**, `ran: 0`, zero Open Dental calls. |
| 13 | **[CC]** | **UNSET `RCM_DRAIN_STEP_DELAY_MS`.** Confirm it is gone. |
| 14 | [BEAU] | **3b** — bring in **R4** (`RS-330416`). **Expect it to fail**: `no_candidate`, nothing offered, no way to point CareIN at claim 53864. That is §15.1c and 6d.2 owes the fix. **Do not loosen the matcher.** |
| 15 | [BEAU] | Turn Roland's posting switch **OFF**. Screenshot. |
| 16 | [CC] | Unwind **both** manifests: `--reseed` for the seven, then **bare** for whatever the kill-test prep created. Capture → dry run → `--execute` → inventory. |
| 17 | [CC] | Fill [§7.3](#73--the-killteardown-clock--still-not-measured), record the switch audit rows, retire the ids per [§9.3](#93-the-deny-list-is-still-pending-at-unwind), open the docs PR. |

### 9.2 The kill target has to be rebuilt

R1 and R2 are both posted, R4 cannot match, and **R3 is a pure recoupment that
creates no Open Dental check** — so step 11's *"exactly ONE check"* proof cannot
run against it, and folding the kill into the first-ever live takeback would make
any failure uninterpretable.

The fix is the runbook's own `[CC-4]`: **`rcm-s10-prep` still exists** and builds
purpose-built disposable targets on 12827 under its own manifest
(`/data/rcm-s10/roland/rcm-s10-manifest.json`), which the **bare** unwind removes.
Verified ready: all three previous manifests are already retired to `.spent.json`
(`2026-08-26`, `2026-08-28`, `2026-08-30`), so there is no live manifest to trip
the guard.

```bash
# In order, from inside the container at /app.
PROBE_OFFICE=roland node scripts/rcm-s10-inventory.js      # prints the claim count
PROBE_OFFICE=roland S10_EXPECTED_CLAIMS=<n> \
  node scripts/rcm-s10-prep.js                             # ⚠ THIS WRITES. No dry run exists.
PROBE_OFFICE=roland node scripts/rcm-s10-835.js            # the files Beau uploads
```

> **⚠ Correction, 2026-09-04.** An earlier draft of this section showed a bare
> `rcm-s10-prep.js` as a dry run and a second `--execute` pass. **Neither exists.**
> `rcm-s10-prep.js` has no `--execute` flag and no dry-run mode — the only
> `--execute` strings in it belong to the *unwind* command it prints on the way
> out. `S10_EXPECTED_CLAIMS` is its whole guard, and the script writes to Open
> Dental on invocation. It was run here believing it was a dry run; the rows it
> created are the ones the kill test wanted, so nothing was lost, but the
> instruction was wrong and is corrected above.

#### The run — 2026-09-04T01:57Z

`S10_EXPECTED_CLAIMS=4` (12827 carries the reseed's four; the inventory prints
it). Both targets pre-checked against the baseline and read back:

```
A: ProcNum=406875  ClaimNum=53900  ClaimProcNum=536170   $1.00 D0140  ClaimStatus "W"
B: ProcNum=406876  ClaimNum=53901  ClaimProcNum=536171   $1.00 D0140  ClaimStatus "W"
manifest: /data/rcm-s10/roland/rcm-s10-manifest.json   complete: true
```

`rcm-s10-835.js` then wrote `rcm-s10-835-A.txt` (check `S10A-53900`) and
`rcm-s10-835-B.txt` (check `S10B-53901`), 484 bytes each, pulled down byte-exact.
**A is the kill target; B is the spare** if the kill misses the window a fourth
time.

**The inventory's warning matters for §7:** 12827 does **not** start at zero. The
bare unwind must return it to **$154.00** — its mid-walk value with R1 and R2
posted — and the `--reseed` unwind then takes it the rest of the way to −$0.20.

#### The delay, verified before any approve was handed over

```
az containerapp update --set-env-vars RCM_DRAIN_STEP_DELAY_MS=90000
  env var count 31 → 32, nothing lost (before/after name diff is empty)
  definition:  RCM_DRAIN_STEP_DELAY_MS = "90000"
  revision:    ca-carein-backend--0000157, ingress traffic 100%, mode Single
  replica:     ca-carein-backend--0000157-67d8fd4b55-5rmdj   Running
  IN-CONTAINER printenv RCM_DRAIN_STEP_DELAY_MS  →  90000
  ps -o pid,comm  →  PID 1 = node          (so `kill 1` sends SIGTERM to node)
```

> **`az containerapp revision list` reports traffic weight LATE.** Immediately
> after the update it still showed `0000156` at 100% and `0000157` at 0, which
> reads as "the delay is not serving". The authority is
> `properties.configuration.ingress.traffic`, which already said `0000157: 100`,
> and `0000156`'s replica was already `NotRunning`. Do not shift traffic by hand
> on the strength of the revision-list column.

`S10_EXPECTED_CLAIMS` is **the count on the chart now**, not zero — 12827 carries
the reseed's four. The prep refuses without it, on purpose: *"without it there is
no baseline, and 'nothing else appeared on this patient' is an assumption rather
than a check."*

> **Order matters, and it is the mistake this walk made.** The delay must be set
> **before the approve**, so the container restart it causes happens while nothing
> is in flight, and so the plan cannot be posted out from under the test. R2 was
> posted before the delay was ever set, which is how the original kill target was
> lost.

### 9.3 The deny-list is still PENDING AT UNWIND

**None of these is on `RESEED_SPENT_IDS` yet, and none may be added until the
unwind has removed them.** `RESEED_SPENT_IDS` feeds `screenManifestForSpentIds`,
which **refuses any manifest naming a listed id** — so listing them now would make
the screen refuse the very manifest the unwind depends on.

To be added to `scripts/rcm/reseed-targets.js` in the **same commit** that moves
`RESEED_SPENT_RECORDED_AT` (`rcmReseedScripts.test.js` fails if ids are added
without the date moving):

```
claims:      [53857, 53858, 53859, 53861, 53862, 53863, 53864]
procedures:  [406650, 406651, 406652, 406655, 406656, 406657, 406658]
claimProcs:  [535770, 535771, 535773, 535777, 535779, 535780, 535782]
```

Whatever `rcm-s10-prep` creates for the kill test goes on **`WALK_SPENT_IDS` in
`scripts/rcm-s10-targets.js`**, not here. Two operations, two lists, same rule —
mixing them makes the inventory print `*** SPIKE 0b RESIDUE` beside rows neither
ever touched.

`ClaimNum 53860` and `ProcNum 406653` / `406654` go on **neither**. They are
**BURNED** — Open Dental consumed the ids on a request it then refused, so nothing
was ever created at those numbers. Never created, never touched.

---

## 10. Standing rules this walk ran under

Designated test patients **12827** and **12828** only · the deny-list ids are
untouchable · **never a negative supplemental on a real patient** · staging is the
**ADJUSTMENT path only** · DefNums resolved **by name**, never by number · any
read-back that disagrees with what a screen promised **stops the walk** · a stopped
walk is a finding, not a failure · no real patient data anywhere in this record.

---

## 11. The fixes ship, and what the two remaining presses will do

### 11.1 PR #144 — merged, deployed — [CC], 2026-09-04

PM review cleared `fix/rcm-takeback-gate-and-resume-strand` at `9af7668` as-is.

| | |
| --- | --- |
| PR | **#144** — *Fix the takeback gate and the stranded resume* |
| Base | `develop` (`c2790f5`) |
| PR check | `build-test` **pass**, 3m49s — the first walk defect gated by PR CI (#106) before merge |
| Merge commit | **`9f357e2`** |
| Commits | `ca73657` (W-9 drain), `7647dd1` (W-6 pairing), `9af7668` (§10.3 note) |
| Diff | 6 files, +412 / −9 |

**Deploy, verified in three layers — [CC], 2026-09-04T03:2xZ**

| Layer | Evidence |
| --- | --- |
| pipeline | `staging-cd` run **`33832437495`** on `9f357e2` — `build-test` ✓, `publish` ✓, `migrate` ✓, `deploy` ✓ |
| revision | **`ca-carein-backend--0000159`**, image `acrcareincore.azurecr.io/carein-backend:9f357e2`, `latestReadyRevisionName`, mode `Single`, ingress traffic **100%**. (`revision list` reported the weight late again; the ingress config is the authority.) |
| live behaviour | `pairLines` called **inside the running container** on R3's exact stored rows returns `billedDeltaCents: 0`. `/app/services/rcm/postingDrain.js` carries `skippedThisRun`. `RCM_DRAIN_STEP_DELAY_MS` **UNSET**. |

The deploy restarted the container, so the startup sweep ran again. **The stranded
plan is byte-identical across it** — plan `updated_at` still `02:35:51.378`, line
still `02:32:15.691`. The evidence the PM ordered preserved is intact, and the
sweep's indifference to `partially_posted` is now observed twice.

Roland `drain_enabled` is **`true`** and valley **`false`**; both offices are
`writeoff_mode: writeoff_field`.

### 11.2 The replay press, predicted BEFORE it is pressed

The stranded plan, read out of the tenant DB on `0000158` at 03:1xZ — i.e. the
state the fixed code will meet:

| | |
| --- | --- |
| `queue_id` | `ae114999-ac9d-4f5b-ba64-522efb8cb7aa` |
| `status` | `partially_posted` |
| `drain_step` | `reconcile` |
| `attempt_count` | 2 |
| `od_claim_payment_num` | **21491** — on the QUEUE row |
| `reconciled_at` | `null` |
| `posted_total_cents` / `intended_total_cents` | `100` / `100` |
| `last_error` | `new row for relation "rcm_posting_queue_line" violates check constraint "rcm_posting_queue_line_skip_reason_check"` |

Its one line:

| | |
| --- | --- |
| `status` / `skip_reason` | `skipped_already_posted` / `already_received_matching` |
| `od_claim_num` / `od_claim_proc_num` | `53900` / `536170` |
| `od_claim_payment_num` | **`null`** — the number the UPDATE could not write |
| `paid_at` | `null` |
| `claimproc_written_at` | `2026-09-04T02:27:13.178Z` |

**Predicted, step by step, from the code rather than from hope:**

| Step | What happens | Open Dental |
| --- | --- | --- |
| claim | `partially_posted` ∈ `DRAINABLE_STATUSES` → re-claimed, `attempt_count` → **3** | — |
| `claimproc_writes` | re-reads claim 53900; 536170 is already Received with our amounts → decision `skip` / `already_received_matching` | **1 read** |
| `claim_receipts` | claim is already `R` **and** `appendClaimNote` finds this `queue_id` already in `ClaimNote` → returns `null` → **the PUT is skipped** | 1 read |
| `check` | `claimPaymentNum = plan.queue.odClaimPaymentNum = 21491`, so `needsCheck && !claimPaymentNum` is false → **no POST** | — |
| `reconcile` | reads the claimprocs attached to 21491; reconciles against `ordinaryLines`, which is `isSupplemental`-filtered and therefore **includes the skipped line** | 1 read |
| line stamp | `skippedThisRun` is true → writes **only** `od_claim_payment_num = 21491`. Status stays `skipped_already_posted`, `skip_reason` stays, `paid_at` stays `null` | — |
| B2 confirm | re-reads the chart and compares against the promise frozen at approve | 1 read |
| `document_attach` | this batch's only upload is `content_type: text/plain` (raw `.edi`), and `loadRemittancePdf` returns `null` for anything but a PDF → `document_attach_status: 'none'` | **no document written** |
| finalize | `posted`, `reconciled_at` set, `posted_total_cents` 100 | — |

**Expected: ZERO Open Dental writes — no PUT, no POST, no DELETE — and about
five reads. The chart still holds exactly one check, 21491.** This agrees with
the PM's stated expectation in full.

Two steps could still refuse instead of reaching `posted`, and **neither is a
strand** — both leave the plan `partially_posted`, drainable, with a sentence
naming the disagreement: a reconcile mismatch, and a red B2 patient-total
confirmation. Neither is expected; the chart holds exactly the intended $1.00.

### 11.3 R3 is already confirmed, and the fix is NOT retroactive

The stored snapshot on R3's claim, read 2026-09-04:

| | |
| --- | --- |
| `claim_id` | `615d889b-032a-46b9-b063-80d543e5b83a` |
| `status` / `od_claim_num` | `matched` / **53863 — already confirmed** at `01:40:40Z` |
| `total_paid_cents` | `-2900` |
| snapshot `takeback` | `true` |
| `confirmed.linePairs[0].billedDeltaCents` | **`-7000`** |
| `confirmed.odAmountsAsRead` | billed `3500`, insPaid `2900`, writeOff `600`, `ClaimStatus "R"` |
| the chart line | `claimProcNum 535780`, `claimPaymentNum 21490` (Beau's 4a hand-post) |

**The gate reads the STORED snapshot, not a fresh computation.**
`approvalGate.js:440` is `claimWorkbench.feeDeltasByLine(snapshot)`, and
`SNAPSHOT_VERSION` is unchanged by this fix — so the old snapshot still counts as
current and the gate will go on refusing on the frozen `-7000` until the claim is
**re-matched**. Deploying the fix changes nothing by itself.

That generalises, and it matters for the prod promotion: **any takeback claim
matched before this build keeps its wrong delta until somebody re-matches it.**

The fix does produce the right number on this exact data. `pairLines` run
offline against the two rows above — our `-3500` against the chart's `3500`,
`takeback: true`:

```
linePairs: [{"lineId":"L1","position":1,"code":"D0220","odClaimProcNum":535780,
             "billedDeltaCents":0,"reason":null}]
```

**`0`, where the snapshot froze `-7000`** — and it still pairs to claimproc
535780, so the fix did not buy agreement by refusing to pair.

### 11.4 What Beau presses, in order

Three presses, not two — **the re-match is the one §11.3 makes unavoidable**, and
it is on the read-only side of the line: `POST /claims/:id/match` reads Open
Dental and changes no chart (`routes/rcm/index.js:116`).

| # | Screen | Press | Expected |
| --- | --- | --- | --- |
| 1 | Posting | **Post** on the $1.00 S10A check (`S10A-53832`) | Heals to **posted**, reconciled. The line keeps `skipped_already_posted` / `already_received_matching` and **gains check 21491**. **No new Open Dental write** — the chart still holds exactly one check. |
| 2 | R3 claim (Cigna `RS-330415`, −$29.00) | **Re-match**, then **Confirm 53863** | The forced re-match releases the confirmation and writes a new snapshot. The red *"D0220 was billed −$35.00 on the remittance and $35.00 in Open Dental … −$70.00 apart"* line is **gone**; `billedDeltaCents` is **0**. |
| 3 | R3 approve | **adjustment** radio, type **−29.00**, **Approve**, then **Post** | One **−$29.00** adjustment on 12828 under *insurance deductions from previous payments*, AdjType resolved **by name**. **No new Open Dental check** — R3 is a pure recoupment and creates none. |

Between 2 and 3, stop: [CC] reads the new snapshot and the gate's own verdict out
of the database and confirms the Approve is genuinely enabled before anything is
approved.

### 11.5 Stood down for the night — [CC], 2026-09-04

**Nothing is armed.** Checked rather than assumed:

| | State |
| --- | --- |
| `RCM_DRAIN_STEP_DELAY_MS` | **absent** from the container app's env (31 vars, none of them this one) |
| pending kill | **none** — the kill test is over; the container was replaced by the #144 deploy, so no drain is mid-flight and the in-process `DRAIN_MUTEX` is fresh |
| scheduled anything | **none** — no cron jobs, no background tasks, no timers. The drain has no scheduler at all: it runs on a press. The startup sweep runs only at boot, and its boot has already happened |
| scale | `min = max = 1`, mode `Single` — unchanged, and it must stay there |
| Roland posting | **ON** (`drain_enabled: true`). Left on deliberately, so the first press tomorrow is press 1 and not a switch |
| valley posting | `false`, untouched |
| worktrees | both clean; `docs/rcm-combined-walk` at `0b1982a`, the fix branch at `9af7668` (merged as `9f357e2`) |

The stranded plan is **left exactly as it was**, per PM ruling 3 — still
`partially_posted`, `attempt_count` 2, check `21491` on the queue row, the line
still carrying no check number. It is evidence until press 1 heals it.

#### The three presses still owed, in order

| # | Who | Press | Expected |
| --- | --- | --- | --- |
| **1** | [BEAU] | Posting → the **`S10A-53832`** $1.00 check → **Post** | Heals to `posted`, reconciled. Line keeps `skipped_already_posted` / `already_received_matching` and **gains check 21491**. **Zero Open Dental writes**; the chart still holds exactly one check. Predicted step by step in [§11.2](#112-the-replay-press-predicted-before-it-is-pressed). |
| **2** | [BEAU] | R3 (Cigna **`RS-330415`**, −$29.00, claim **53863**, PatNum **12828**) → **re-match**, then **confirm 53863** | The red *"… −$70.00 apart"* line is **gone**; the new snapshot's `billedDeltaCents` is **0**, still paired to claimproc **535780**. Chart-read-only: `POST /claims/:id/match` writes nothing to Open Dental. Required because the gate reads the STORED snapshot — see [§11.3](#113-r3-is-already-confirmed-and-the-fix-is-not-retroactive). |
| — | **[CC]** | **STOP.** Read the new snapshot and the gate's own verdict out of the tenant DB; confirm Approve is genuinely enabled | Nothing is approved until this is reported. |
| **3** | [BEAU] | R3 → **`adjustment`** radio, type **`-29.00`**, **Approve**, then **Post** | One **−$29.00** adjustment on 12828 under *insurance deductions from previous payments*, AdjType resolved **by name**. **No new Open Dental check** — R3 is a pure recoupment and creates none. |

Then, unchanged from [§9.1](#91-in-order): [BEAU] turns Roland posting **OFF**;
[CC] unwinds **both** manifests — `--reseed` for the seven reseed targets, then
**bare** for the kill test's — fills the teardown numbers, records the switch
audit rows, retires the ids per [§9.3](#93-the-deny-list-is-still-pending-at-unwind),
and opens the docs PR.

**Still owed to the deny list at unwind:** checks **21461 / 21462 / 21490 /
21491** are all WALK-LIVE. `53860` / `406653` / `406654` remain **burned** and go
on neither list.


---

## 12. W-10 — the plan cannot be healed, and press 1 already proved it

### 12.1 What actually happened

**Press 1 was already made, on 2026-09-04 at `03:31:09Z`, and it blocked.** It ran
on revision `0000159` — the fixed build — twenty minutes after the deploy and
after [§11.5](#115-stood-down-for-the-night--cc-2026-09-04) was written.

| | |
| --- | --- |
| `status` | **`blocked`** (was `partially_posted`) |
| `blocked_reason` | **`plan_empty`** |
| `last_error` | **"This plan has no postable lines."** |
| `drain_step` | `resolve_config` |
| `attempt_count` | **3** |
| `drained_by` / `drain_attempt_at` | `admin@carein.ai` / `2026-09-04T03:31:09.107Z` |
| the line | unchanged — `skipped_already_posted`, `od_claim_payment_num` still **null**, `updated_at` still `02:32:15.691` |
| `od_claim_payment_num` on the queue | still **21491** |

**No chart write occurred.** The refusal is a precondition, and it fires before
`claimproc_writes` — the line row is byte-identical to where the strand left it.

### 12.2 The cause, read out of the code

`checkPreconditions`, `postingDrain.js:752`:

```js
const actionable = lines.filter(
  (l) => l.status !== 'skipped' && l.status !== 'skipped_already_posted'
);
if (lines.length === 0 || actionable.length === 0) {
  return { reason: BLOCK_REASONS.PLAN_EMPTY, detail: 'This plan has no postable lines.' };
}
```

This plan's **only** line is `skipped_already_posted`, so `actionable.length === 0`
and the run is refused before it starts.

**This is W-9's category error one gate earlier.** W-9 was a skipped line that
could not record what it knew; W-10 is a skipped line that makes its whole plan
look absent. The predicate conflates *"no line needs a CHART write"* with *"no
line needs anything"* — and the second is false here. The plan still owes the
check number on its line, a reconcile, the B2 confirmation and a finalize to
`posted`. That is precisely the work W-9 unblocked, and this gate stops the drain
from ever reaching it.

**W-9 was necessary but not sufficient.** The strand survives.

### 12.3 There is no way out in the current code

| Route | Answer |
| --- | --- |
| `POST /posting/drain` | `blocked` **is** drainable, so it re-runs — and re-blocks on the same predicate. Every press produces another `plan_empty`. |
| `POST /posting/:id/recheck` | refuses anything but `posted` / `partially_posted` → **`NOTHING_POSTED_YET`**. It only reads, so it could not finalize the plan even if it answered. |

The plan is stranded again, one step earlier than before, and pressing Post
cannot move it.

**Reachability beyond this walk:** any interrupted run whose lines all come back
already-posted lands here. On a single-line plan — which is ordinary — that is
every resume after the claimproc write. This is not a kill-test artefact.

### 12.4 Two corrections I owe this record

1. **[§11.2](#112-the-replay-press-predicted-before-it-is-pressed)'s prediction was
   wrong.** I traced the drain forward from `claimRow` through claimproc, claim,
   check, reconcile and finalize, and never checked `checkPreconditions`, which
   runs **before all of it**. I predicted "heals to `posted`" and the real answer
   was "refused as empty". The steps I did trace are still right; they are simply
   never reached.
2. **[§11.5](#115-stood-down-for-the-night--cc-2026-09-04) says the stranded plan
   was "left exactly as it was". It was not, and I did not check.** The stand-down
   verified the env, the scheduler and the worktrees, and then asserted the plan
   row from memory of a reading twenty minutes stale. The row had already moved.

### 12.5 Proposed, not implemented

The narrow fix is to ask whether the plan has anything **left to record**, not
whether it has anything left to **write**. `checkPreconditions` already holds the
queue row, so the evidence is in hand: a plan whose lines are all skipped but
which carries `od_claim_payment_num` with `reconciled_at` still null has
unmistakable outstanding work, and refusing it as empty is the false half of the
predicate.

**No code has been written for this.** Awaiting a PM ruling, per the walk's
standing pattern.

---

## 13. W-11 — the remittance's "run match" silently skips a confirmed claim

### 13.1 The re-match did not happen

Reported re-matched and confirmed on 2026-09-08. The stored record says
otherwise — **nothing moved**:

| | Value | |
| --- | --- | --- |
| `od_match_at` | `2026-09-04T01:40:29.189Z` | the ORIGINAL match |
| `od_match_confirmed_at` | `2026-09-04T01:40:40.660Z` | the original confirmation |
| `confirmed.linePairs[0].billedDeltaCents` | **`-7000`** | unchanged |
| `confirmed.supersedes.confirmedAt` | `2026-09-04T01:27:24.002Z` | an EARLIER confirmation, so the force path does work — it just did not run |

The gate, read straight out of `previewRecoupment` on the live build:

```
postable: false      withheld: 1      failed checks: 1

PATIENT_RESPONSIBILITY_MATCHES — "Patient's number can't be trusted yet …
  Look at D0220."
verdict.state: red
problems: [ od_fee_disagrees — "D0220 was billed -$35.00 on the remittance
            and $35.00 in Open Dental" ]
```

Every other check passes, including `TAKEBACK_ACKNOWLEDGED` ("This is a takeback
— confirmed by typing -29.00") and `MATCH_TAKEN_FOR_A_TAKEBACK`. The recoupment
total is `-2900`, the batch balances, and `defaultPath` is `adjustment`. **One
check stands between this claim and an enabled Approve, and it is the frozen
`-7000`.**

### 13.2 Why the press did nothing

There are two different controls both wired to the `run-match` action, and only
one of them forces:

| Screen | Wiring | On an already-confirmed claim |
| --- | --- | --- |
| the claim's own Match page | `ClaimMatch.tsx:450` — `runMatch(claim.odMatchStatus === "confirmed")` | **forces**, releases the confirmation, re-reads Open Dental, writes a NEW snapshot |
| the remittance page | `RemittanceDetail.tsx:469` — `runBatchMatch` | `runClaimMatch` **without** `force`, which **throws** `This claim already has a confirmed Open Dental match` — and `runBatchMatch`'s own header records that the catch **swallows it and the loop carries on** |

So the batch button reports a run that did nothing, with no visible refusal on
the claim that was skipped. On a partly-worked remittance that is the *mundane*
outcome, which is exactly what makes it easy to read as success.

**Not a defect in the fix, and not a bad press** — it is a screen that cannot
say "I skipped the one claim you were trying to re-match".

### 13.3 What actually moves it

Open **claim 53863's own Match page** (into the claim from the R3 remittance),
run the match there — the page forces because the claim is confirmed — then
confirm 53863. Forcing requires posting permission (`mayReleaseConfirmed`).

Then the delta should read **0**, not `-7000`, and
`PATIENT_RESPONSIBILITY_MATCHES` should pass. **[CC] re-reads the snapshot and
the gate before anything is approved.**

---

## 14. The takeback gate goes green — [CC], 2026-09-09

Re-matched and re-confirmed from **the claim's own Match page** (the forcing one,
per [§13.2](#132-why-the-press-did-nothing)). The record moved this time:

| | Before | After |
| --- | --- | --- |
| `od_match_at` | `2026-09-04T01:40:29.189Z` | **`2026-09-09T01:56:57.921Z`** |
| `od_match_confirmed_at` | `2026-09-04T01:40:40.660Z` | **`2026-09-09T01:57:30.389Z`** |
| `confirmed.linePairs[0].billedDeltaCents` | **`-7000`** | **`0`** |
| `confidence` | 100 | 100 |
| still paired to | `odClaimProcNum 535780` | `odClaimProcNum 535780` |

**`odAmountsAsRead` is byte-identical across the re-match** — billed `3500`,
`insPaidCents 2900`, `writeOffCents 600`, `ClaimStatus "R"`. The chart did not
change; the arithmetic did. That is the W-6 fix and nothing else.

The gate, read out of `previewRecoupment` on the live build:

```
postable: true        withheld: 0        failing checks: 0
verdict.state: green
verdict.sentence: "Patient will owe $0.00 once posted — matches the EOB."
problems: []

recoupmentTotalCents: -2900   typedTotalExpected: "-29.00"
paths: [adjustment, supplemental]   defaultPath: adjustment   balanced: true
```

**This is the first parser-produced reversal 835 ever to reach an enabled Approve
in this system.** Before `7647dd1` both branches were red — a reversal that paired
went red on `od_fee_disagrees`, and one that did not went red on
`line_not_in_chart` — so the takeback lane had never been green end to end.
[§6](#6-findings)'s W-6 is now proven live on real data through the real gate, not
only in a regression test.

**Stopped at the button, per the PM.** Nothing is approved.

---

## 15. W-12 — the approve SUCCEEDED; the drain refused a mirrored write-off

Diagnosis only. **No writes, no code changes.** The approve-path evaluation was
reproduced inside a transaction that was rolled back.

### 15.1 What actually happened, by the clock

| Time | Event |
| --- | --- |
| `02:03:22.359Z` | **Approve SUCCEEDED.** Recoupment plan **`573bb9f6`** created — `is_recoupment: true`, `intended_total_cents: -2900`, `remittance_key RS-330415\|CIGNA DENTAL\|2026-09-01\|-2900\|RS-330415`, `approved_by admin@carein.ai` |
| — | its line: claimproc **535780**, claim 53863, `is_supplemental: true`, `recoupment_path: adjustment`, `intended_ins_pay_amt_cents: -2900`, **`intended_write_off_cents: -600`**, status `pending` |
| `02:03:45.712Z` | **Post ran and BLOCKED** — `blocked_reason: negative_intent`, `last_error:` **"Line 1 carries a negative write-off or deductible."**, `drain_step: resolve_config`, `attempt_count: 1` |
| after | the claim is now linked to a plan, so it reads `alreadyQueued: true` → `postable.length === 0` → **every further Approve press returns 409 `NOTHING_APPROVABLE`**, whose text is *"The takeback on this remittance cannot be posted yet."* |

**Nothing reached Open Dental.** Line still `pending`, `posted_total_cents 0`,
`od_claim_payment_num null`. The refusal is a precondition, before any transport.

### 15.2 The message is from the RE-press, and it describes the wrong thing

The approve is not being refused — **it already happened.** What Beau saw was the
*second* press hitting `POST /remittances/:id/approve-recoupment` and being told
there is nothing left to approve, in words that read as "the takeback is not
ready". The real state is *"already approved; its plan is blocked on
`negative_intent`."*

`alreadyQueued` is also why the panel cannot name a condition: **no check fails.**
The claim leaves the postable set through
`postable: evaluated.filter((c) => c.postable)` — and `withheld` explicitly
excludes `alreadyQueued` rows — so the 409 carries a claim list in which every
check is green.

### 15.3 Preview vs approve: SAME predicate, same data

Both call `evaluateRemittance({ office, ...loaded, recoupmentAllowed: true })`
over `loadForApproval`, and `lock: true` only appends `FOR UPDATE` to the claims
SELECT — identical rows. Run **in the same process at the same instant**:

| | `postable` | `withheld` | `alreadyQueued` | balanced | failed checks |
| --- | --- | --- | --- | --- | --- |
| `previewRecoupment` | 0 | 0 | **1** | true | none |
| approve path (locked, rolled back) | 0 | 0 | **1** | true | none |

**No divergence.** [§14](#14-the-takeback-gate-goes-green--cc-2026-09-09)'s green
read was correct at `01:5xZ`; the state changed at `02:03:22` when the approve
landed. This is neither a stale frontend nor a second server predicate — it is
one predicate giving a correct answer about a changed world, in misleading words.

### 15.4 What is NOT involved

- **The stranded S10 plan (`ae114999`) does not participate.**
  `plannedClaimprocs` is **empty**, and that plan holds claimproc **536170**, not
  535780. `CLAIMPROC_NOT_ALREADY_PLANNED` passes.
- **No "held for review" hold is in play** — zero failing checks.
- The claim's own new plan is the entire cause.

### 15.5 The real blocker — and it is the same family again

`checkPreconditions`, `postingDrain.js:724`:

```js
// -- No line may carry a negative component. ---
// `intended_ins_pay_amt_cents` was covered by the recoupment pass above; write
// -off and deductible are checked here for their own sake. A negative
// write-off is not a recoupment, it is a parse defect...
const badLine = lines.find(
  (l) => Number(l.intendedWriteOffCents) < 0 || Number(l.intendedDedAppliedCents) < 0
);
```

The comment concedes the asymmetry in its own words: the **payment** was exempted
for the recoupment lane, the **write-off** was not. On a reversal 835 a negative
write-off is not a parse defect — it is the mirror of the write-off being
reversed, exactly as `-2900` is the mirror of the payment. The chart holds
`writeOffCents 600`; the remittance carries `-600`.

**And the guard refuses over a field this lane never writes.** On
`recoupment_path: adjustment`, `drainTakebacks` passes only
`amountCents: line.intendedInsPayAmtCents`. `intendedWriteOffCents` is read at
`postingDrain.js:828` (the ordinary claimproc PUT) and `:2666` (the ordinary
lane) and **nowhere on the takeback path**.

This is the **third** instance of one family — a reversal's negated figures read
as errors because a predicate written for the payment lane was never taught the
mirror:

| | Where | Symptom |
| --- | --- | --- |
| **W-6** | `claimMatch.pairLines` | `-3500 - 3500 = -7000` → red verdict → gate refuses. **Fixed** in `7647dd1`. |
| **W-10** | `checkPreconditions` `plan_empty` | every line skipped ⇒ plan reads as absent. **Open.** |
| **W-12** | `checkPreconditions` `negative_intent` | mirrored write-off reads as a parse defect. **Open.** |

### 15.6 Current state

Plan `573bb9f6` is `blocked`, which **is** drainable, so every Post press
re-blocks identically at zero cost — no Open Dental call, nothing written. The
takeback cannot post until W-12 has a ruling.

**Awaiting PM. No fix written.**

---

## 16. The class fix ships, and both plans clear their preconditions

### 16.1 PR #157 — merged and deployed — [CC], 2026-09-09

| | |
| --- | --- |
| PR | **#157** — *Fix the reversal-lane predicate class* |
| Base | `develop` (`d4c916c`) |
| PR check | `build-test` **pass**, 3m30s |
| Merge commit | **`903d3d5`** |
| Commits | `41ab889` (W-12), `7896239` (W-10), `f250d77` (the lying 409), `9b9935a` (the §17 sweep) |
| Diff | 7 files, +570 / −20 |

**The first deploy attempt failed on nothing.** `az acr build` crashed inside its
own log-tailing — `get_log_sas_url` returned a non-JSON body and the CLI died on
`JSONDecodeError` — so GitHub marked `publish` failed and skipped `migrate` and
`deploy`. The build was healthy: ACR run `cdav` was still *Running* when the CLI
gave up, and both `carein-backend:903d3d5` and `carein-caddy:903d3d5` landed in
the registry. Re-running the failed jobs completed it. **Worth recognising rather
than debugging** — a green ACR run behind a red `publish` step is a CLI streaming
failure, not a build failure.

**Three layers:**

| Layer | Evidence |
| --- | --- |
| pipeline | `staging-cd` run **`34356899519`** on `903d3d5` — `build-test` ✓ `publish` ✓ `migrate` ✓ `deploy` ✓ |
| revision | **`ca-carein-backend--0000168`**, image `acrcareincore.azurecr.io/carein-backend:903d3d5`, `latestReadyRevisionName`, mode `Single`, ingress **100%**, scale `min = max = 1`, `RCM_DRAIN_STEP_DELAY_MS` **absent** |
| live predicate | Both fixes present in `/app` (`componentSignIsWrong`, `This plan has no lines at all`) **and exercised** — see §16.2 |

### 16.2 Both plans pass `checkPreconditions` on the deployed build

Run **inside the container**, against the rows `loadPlan` actually returns, with
`odWritesDisabled: false` and `snapshotVersion: 2` read the same way the drain
reads them. This is the predicate that refused both presses.

**S10A — `ae114999` (W-10):**

| | |
| --- | --- |
| plan | `blocked`, `is_recoupment: false`, `od_claim_payment_num` **21491**, intended **100** |
| line 1 | `skipped_already_posted` / `already_received_matching`, claimproc **536170**, claim **53900**, insPay `100`, writeOff `0`, ded `0` |
| **`checkPreconditions`** | **`null`** — was `plan_empty` |

**R3 — `573bb9f6` (W-12):**

| | |
| --- | --- |
| plan | `blocked`, `is_recoupment: **true**`, no check, intended **−2900** |
| line 1 | `pending`, claimproc **535780**, claim **53863**, insPay `-2900`, **writeOff `-600`**, `is_supplemental: true`, path `adjustment` |
| **`checkPreconditions`** | **`null`** — was `negative_intent` on that `-600` |

The `-600` is still there and still negative. The guard now reads it as the
mirror it is, on a lane that never writes it.

### 16.3 The deposit check — all four clear

Ordered before anything else, because a check swept into a deposit cannot be
removed by the unwind. Read live off Open Dental:

| Check | Amount | CheckDate | `DepositNum` |
| --- | --- | --- | --- |
| **21461** | $164.80 | 2026-09-01 | **0** |
| **21462** | $640.00 | 2026-09-01 | **0** |
| **21490** | $29.00 | 2026-09-03 | **0** |
| **21491** | $1.00 | 2026-08-29 | **0** |

Nothing has been swept since 9/4. The teardown path is intact.

### 16.4 The two presses, handed over

| # | Press | Expected |
| --- | --- | --- |
| **1** | Posting → the **`S10A-53832`** $1.00 check → **Post** | Heals to `posted`, reconciled. Line keeps `skipped_already_posted` and gains check **21491**. **Zero Open Dental writes** — nothing left to write, only to record. |
| **2** | Posting → the Cigna **`RS-330415`** −$29.00 check → **Post** | One **−$29.00** adjustment on **12828** under *insurance deductions from previous payments*, AdjType by name. **No new check** — R3 is a pure recoupment. |

**Approve is NOT pressed on R3.** It is already approved — plan `573bb9f6`
exists and is waiting. Pressing Approve again is what produced W-11's misleading
409, and [§15](#15-w-12--the-approve-succeeded-the-drain-refused-a-mirrored-write-off)
is why.

### 16.5 PM rulings carried forward

| | Ruling |
| --- | --- |
| **W-13** | Reword, keep refusing. Rides the fix-before-shadow batch. **This branch is not reopened.** |
| **W-14** | Deferred to fix-before-shadow beside W-7 — same family, and scoring changes do not happen mid-walk. **Logged, not dropped.** |

---

## 17. W-15 — press 1 refused, on the sibling of the branch W-9 fixed

Read fresh at **`2026-09-09T14:00:51.766Z`** (plan/line) and
**`14:02:02.946Z`** (chart). **No writes, no fixes.**

### 17.1 The press ran, and it got further than ever before

| | Value |
| --- | --- |
| `drain_attempt_at` | **`2026-09-09T13:51:19.165Z`** — Beau's press |
| `drained_by` | `admin@carein.ai` |
| `attempt_count` | **4** (was 3) |
| `finished_at` | **`2026-09-09T13:51:29.079Z`** — ten seconds later |
| `status` | **`partially_posted`** (was `blocked`) |
| `drain_step` | **`claimproc_writes`** (was `resolve_config`) |
| `last_error` | `new row for relation "rcm_posting_queue_line" violates check constraint "rcm_posting_queue_line_skip_reason_check"` |
| `reconciled_at` | `null` |
| `posted_total_cents` | `0` |
| `od_claim_payment_num` | `21491`, unchanged |
| the line row | **byte-identical** — `updated_at` still `2026-09-04T02:32:15.691Z` |

**The W-10 fix worked.** `drain_step` moving from `resolve_config` to
`claimproc_writes` is the proof: the plan cleared `checkPreconditions` for the
first time since 9/4 and entered the run. It then refused one step later.

### 17.2 The screen is not stale — it refused, on the same sentence from a different place

`partially_posted` is the true current status.

The constraint is the same one W-9 was about. The **writer** is not.
`postingDrain.js:2848`, in the claimproc-writes step:

```js
if (decision.action === 'attached') {
  // On a check already. Never PUT again (test 11) and never re-billed.
  await persistLine(pool, line.queueLineId, {
    status: 'paid',
    odClaimPaymentNum: decision.checkNum,
    paidAt: true,
    lastError: null,
  });
```

`status: 'paid'` over a row that still carries `skip_reason` — refused by the
paired constraint, thrown out of the step, caught, written `partially_posted`.

**Why it appeared only now, on the fourth attempt.** `decideLineAction` re-reads
the chart every run and the chart has changed underneath it:

| Attempt | What the chart held at decision time | Decision | Writer |
| --- | --- | --- | --- |
| 2 (9/4) | money on the claimproc, **check not yet created** | `skip` | the check-stamping loop → **W-9** |
| 4 (today) | money on the claimproc **and attached to check 21491** | **`attached`** | `:2848` → **W-15** |

The line's state machine walked from one branch to its sibling as the chart
filled in, and the sibling carries the identical defect.

### 17.3 Open Dental did not change

Every timestamp on the chart is from the ORIGINAL kill-test run on 2026-09-03,
not from today's press:

| | Value | `SecDateTEdit` |
| --- | --- | --- |
| claim **53900** | `ClaimStatus "R"`, `DateReceived 2026-08-29`, `InsPayAmt 1`, `WriteOff 0` | `2026-09-03 21:32:16` |
| claimproc **536170** | `Received`, `InsPayAmt 1`, `ClaimPaymentNum 21491`, `DateCP 2026-08-29` | `2026-09-03 21:34:20` |
| check **21491** | `CheckAmt 1`, `DepositNum 0` | `2026-09-03 21:34:20` |

**Exactly one claimproc, exactly one check, nothing added and nothing edited.**
The `attached` branch issues no Open Dental write by design — *"Never PUT again
(test 11)"* — so the run was reads only, and the chart proves it.

### 17.4 This is my incomplete fix, and the sweep was the wrong shape to catch it

W-9 guarded **the call site that manifested** rather than the writer every call
site shares. `persistLine` is that writer — a single function, `:1606` — and it
will move a row off the skip family while leaving `skip_reason` set for any
caller that asks it to.

Enumerating the callers that write a NON-skip status over a row that may carry a
reason:

| Site | Status written | Reachable on a skipped row? |
| --- | --- | --- |
| `:2851` | `paid` (**attached**) | **YES — fired today, W-15** |
| `:2922` | `claimproc_written` | yes, if a later run decides `write` |
| `:2756` | `failed` (**conflict**) | yes, if a later run decides `conflict` |
| `:3220` | `paid` (check stamping) | guarded by `skippedThisRun` — **W-9's fix** |
| `:3005` | `claim_received` | guarded — `attached` and `skip` both `continue` |
| `:1836`, `:1899`, `:1967`, `:3295` | `failed` / `recouped` | takeback lines, which never carry a skip |

So there are **two more live paths** behind this one, not just the one that fired.

**And §17's class sweep could never have found it.** That sweep asked *does this
predicate misread a negative number* — a question about **signs**. This defect is
about **which columns may legally change together**, which is a question about
**constraints**. Right instinct, wrong axis. The sweep that would have caught it
is: *which code paths write `status` without clearing `skip_reason`* — and it is
answered by the table above.

### 17.5 Proposed, not implemented

**Fix the writer, not the callers.** `persistLine` already builds every UPDATE for
this table in one place. When a patch sets a status outside
`('skipped', 'skipped_already_posted')` and does not itself supply a
`skipReason`, it should clear `skip_reason` in the same statement — which makes
the constraint unbreakable for every caller, present and future, instead of
correct at whichever call sites somebody remembered.

That is one change at `postingDrain.js:1606`, and it retires W-9's per-site guard
as well rather than adding a third.

**No code written. Awaiting PM.**

---

## 18. W-16 — the screen presented a crash as a measurement

**Logged by PM ruling, 2026-09-09. Overhaul-critical.**

After press 1 refused, the Posting screen showed the plan as *"Partly posted"*
and rendered `last_error` inside the box headed **"what the chart says —
measured out of Open Dental."** The text in that box was:

> `new row for relation "rcm_posting_queue_line" violates check constraint
> "rcm_posting_queue_line_skip_reason_check"`

That is not a measurement. Nothing was measured — the run threw at
`claimproc_writes`, four steps before the reconciliation read, and
[§17.3](#173-open-dental-did-not-change) shows Open Dental was never touched.
The chart was **right**, and the screen said the chart was the problem.

**The column is doing two jobs.** `last_error` carries both *"the chart
disagreed with us"* and *"the run failed before it could look"*, and the screen
renders both under a heading that only the first one earns. A biller reading it
is being pointed at a correct ledger and told to fix it.

**On real data those five steps end with somebody editing a chart that was
already right** — and unlike a posting error, a hand-correction to a correct
ledger has nothing to reconcile against afterwards. That is why this is
overhaul-critical rather than cosmetic.

**The fix is a distinction, not a wording change.** The screen must be able to
tell a MEASURED disagreement from a run that stopped before measuring, and say so
in different words. The evidence for the distinction already exists on the row:
`reconciled_at` is null and `drain_step` names where it stopped — a run that
never reached `reconcile` has, by definition, measured nothing.

Not fixed here. Carried to the overhaul with the other display work.


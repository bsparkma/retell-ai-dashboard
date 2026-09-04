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

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

**Still to be touched on resume:** a hand-posted ClaimPayment on 53863 (number
unknown until created), an adjustment for the R3 takeback, and whatever
`rcm-s10-prep` creates for the kill test.

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

```
kill issued at        ⏳
replica Terminated    ⏳
teardown              ⏳
```

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
  node scripts/rcm-s10-prep.js                             # dry run
PROBE_OFFICE=roland S10_EXPECTED_CLAIMS=<n> \
  node scripts/rcm-s10-prep.js --execute
PROBE_OFFICE=roland node scripts/rcm-s10-835.js            # the file Beau uploads
```

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


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


# RCM Slice 6c — the drain

**The first Open Dental write in this module.** Approved remittances become real
insurance payments on real patients' ledgers, in the correct office's database,
through the forced call sequence `docs/RCM_OD_WRITES.md` proved live on
2026-08-13.

| | |
| --- | --- |
| Routes (UI) | `/rcm/posting` |
| Routes (API) | `GET /api/rcm/posting/queue`, `GET /api/rcm/posting/queue/:id`, `POST /api/rcm/posting/drain` |
| Entitlement | `requireModule('rcm')` — ships dark; no tenant is entitled yet |
| Permission | `rcm.read` for the queue, `rcm.write` for the drain (D-9) |
| Office | Slice 3's router-wide `requireOffice` — the validated `?office=` query param |
| Offices enabled | **roland only.** valley is fail-closed (D-7, §9) |
| Migration | `backend/migrations-tenant/1787120000000_rcm_posting_drain.js` (additive only) |
| Code | [`services/rcm/postingDrain.js`](../backend/services/rcm/postingDrain.js), [`services/rcm/odPostingWrites.js`](../backend/services/rcm/odPostingWrites.js), [`services/rcm/odOfficeConfig.js`](../backend/services/rcm/odOfficeConfig.js), [`routes/rcm/posting.js`](../backend/routes/rcm/posting.js), [`pages/rcm/PostingQueue.tsx`](../new-dashboard/client/src/pages/rcm/PostingQueue.tsx) |
| Tests | `postingDrain.test.js` (48), `odOfficeConfig.test.js` (15), `posting.test.js` (17), `rcmNoOdWrites.test.js` (14), `rcm-labels.test.ts` (17) |

---

## 1. What changed, in one sentence

`rcm_posting_queue` stopped being a record of intent and became a record of what
happened.

Everything before this slice was provably incapable of writing to a chart:
`rcmNoOdWrites.test.js` drove the entire module — including the approve path, to
success — against an Open Dental client whose every write verb threw, and
asserted that not one was called. **That test still exists and still passes.** It
now carries an allow-list of exactly one file.

---

## 2. The state machine

### 2.1 The words

The 6c brief names the plan states `queued → running → …`. The database, since
Slice 1, calls the first two `approved` and `posting`.

**The stored words are not renamed.** They mean the same thing — Slice 1's own
header defines `approved` as *"approved and NOT yet posted"* — and a rename would
be a data migration on a shipped table plus an edit to the 6b gate that writes
`'approved'` by name, bought for a synonym. The API ships **both**: the raw
`status` and the screen's `statusLabel`. `postingDrain.QUEUE_STATUS_LABEL` is the
single map between them, and `postingDrain.test.js` pins that it covers every
value the CHECK constraint can hold, in both directions.

### 2.2 Plan states

```
approved ──┐                          (the brief's "queued")
failed ────┼─► posting ──► posted             (the brief's "running")
partially_posted ─┘   ├─► partially_posted
                      ├─► failed
                      └─► blocked
```

| Stored | Screen | Means |
| --- | --- | --- |
| `approved` | Queued | A human approved it. **Nothing has been written to Open Dental.** |
| `posting` | Running | A drain owns this plan right now. |
| `posted` | Posted | The money is on the chart, the check exists, and the reconciliation read confirmed the check carries exactly this plan's lines. |
| `partially_posted` | Partly posted | Some of the sequence reached the chart and some did not. The lines say exactly where. |
| `failed` | Failed | Nothing was written. |
| `blocked` | Blocked | **No Open Dental call was made** and none will be until a human changes something. |

**`blocked` is not `failed`, and the distinction is load-bearing.** `failed`
means something was attempted and did not work; `blocked` means nothing was
attempted. Collapsing them would leave the queue unable to say which of two very
different things happened — and the two need different actions from different
people.

### 2.2.1 The recovery contract — `blocked` has a way out

**`blocked` → fix the named cause → press Drain again.** That is the whole
contract, and it is what every blocked row's own message asks for
(*"Resolve the extra line in the chart, then drain again."*).

An earlier version of this slice made that instruction impossible: `blocked` was
excluded from `DRAINABLE_STATUSES` on the argument that "retrying a refusal
automatically is how it becomes a loop". But **there is no automatic anything in
this module** — pressing Drain is a human decision — and with `blocked` excluded
nothing anywhere could ever run one again. Not the drain's own scan, not the
startup sweep (which only re-homes `posting`), and not the 6b gate (which refuses
any plan past `approved`). A transient `office_config_unresolved`, an
`eligible_total_mismatch` the biller then fixed, and every valley row on the day
valley is enabled were all permanently stuck, with the screen telling them to do
something that could not be done.

So `approved`, `failed`, `partially_posted` and `blocked` are all drainable.
**`posted` is the only terminal state.**

Re-pressing a plan whose cause persists is cheap and honest: it blocks again with
the same reason and an incremented `attempt_count`. For a POLICY block — valley,
a recoupment, the environment guard, an office disagreement, arithmetic that does
not add up — `checkPreconditions` runs before the office's configuration is
resolved, so a re-press costs **zero Open Dental calls** however many times it is
made.

**`posted` requires BOTH proofs, enforced by the database**, not only by the code
that sets it:

```sql
CHECK (status <> 'posted'
       OR (od_claim_payment_num IS NOT NULL AND reconciled_at IS NOT NULL))
```

A check number says money landed somewhere; `reconciled_at` says the check
contains exactly the lines this plan intended. The whole value of the state is
that a screen may trust it without re-deriving it, so the constraint is where the
promise lives.

### 2.3 Line states

```
pending ──► claimproc_written ──► claim_received ──► paid
   │
   ├──► skipped_already_posted   (resume: OD already shows our exact amounts)
   └──► failed
```

`skipped_already_posted` is new, and it is deliberately **not** Slice 1's
`skipped`. *"We chose not to"* and *"it was already done"* are different facts
about money, and only the second one proves a resume did not double-post.
Slice 1's `skipped` stays in the vocabulary and stays unused by this slice.

`document_attached` is **6d's**. The step exists in `odPostingWrites.STEPS` and
the queue detail reports it honestly:

```json
"documentAttach": {
  "implemented": false,
  "note": "The EOB PDF is not yet filed into the patient images — that is a later slice."
}
```

A plan that is `posted` with an unfiled EOB is a complete and honest description
of what happened — §8 puts the document last precisely because *"a document
failure is retryable and never a financial error"*. A screen that showed nothing
here would leave a biller assuming the PDF was filed.

### 2.4 Blocked reasons

Machine slugs, never sentences. The UI renders copy from the slug
(`features/rcm/posting.ts`), and `rcm-labels.test.ts` fails the build if the
backend gains one the client has no copy for.

| Reason | Means |
| --- | --- |
| `valley_not_enabled` | D-7 (§9). Never a silent skip, never a roland fallback. |
| `recoupment_not_in_scope` | D-6. A negative supplemental is the one irreversible OD operation (G10). |
| `office_config_unresolved` | This practice's own PayType could not be read from its own Open Dental. |
| `no_pay_type` | The practice's Category-32 list carries nothing named for a check or an EFT. |
| `eligible_total_mismatch` | The claims carry insurance money this plan did not put there. Caught **before the first write**, so nothing was attempted. |
| `office_mismatch` | The plan, its lines and its claims disagree about the practice. |
| `plan_empty` | Nothing postable, or a line naming no claim. |
| `claim_not_confirmed` / `claim_not_on_this_plan` | A claim drifted off its confirmation or its plan. |
| `negative_intent` | A negative write-off or deductible — a parse defect, not a recoupment. |
| `plan_total_mismatch` | The lines do not sum to the plan's recorded total. |
| `snapshot_superseded` | A claim's match snapshot is an older format. |
| `od_writes_disabled` | `OPENDENTAL_WRITE_DISABLED=true` in this environment. |

A `blocked` row carries its reason by CHECK constraint — `blocked` implies a
reason and a reason implies `blocked` — so a refusal nobody can act on, and a
stale refusal rendered over a run that has since moved on, are both unstorable.

---

## 3. The forced order

Not a preference. Open Dental has no transactions, no savepoints and no rollback
endpoint (**G4**), and the sequence below is the only one the API expresses.

```
per line   PUT  /claimprocs/{n}   {Status:"Received", InsPayAmt, WriteOff, DedApplied}
           GET  /claimprocs?ClaimNum=      ◄── READ BACK AND COMPARE
per claim  PUT  /claims/{n}       {ClaimStatus:"R", DateReceived}
           GET  /claims/{n}                ◄── READ BACK AND COMPARE
per check  POST /claimpayments[/Batch]     CheckAmt = Σ eligible InsPayAmt
           GET  /claimprocs?ClaimPaymentNum=  ◄── RECONCILE
(6d)       POST /documents/Upload
```

**Every call is one the Spike 0b transcript executed.** Test 2 wrote
`{Status:"Received", InsPayAmt:0.60, WriteOff:0.20, DedApplied:0.20}` and read
back exactly those; test 3 flipped the claim to `"R"`; test 4 created the check;
test 10 did it in batch across two claims.

### 3.1 Why this order and no other

`POST /claimpayments` requires `CheckAmt` to equal the total of the ClaimProcs'
`InsPayAmt` *"with ClaimPaymentNum=0"*, and `InsPayAmt` *"cannot be updated when
there is already a ClaimPayment attached"* (test 11, verbatim: `400 "Cannot
change InsPayAmt when Status is Received and attached to a ClaimPayment."`).
Money before check, per-line before per-claim, per-claim before the check.
Creating an empty check and allocating to it afterwards is not expressible.

### 3.2 G2 — a 200 is not proof, and this is the most important rule here

Spike 0b test 2b:

```
PUT /claimprocs/533930 {DateCP: "2026-07-01"}  -> 200 OK
read-back                        : DateCP = "2026-08-13"   (unchanged)
```

> *"A posting engine that believes its own 200 will report back-dated
> adjudication it never performed."*

So every write function in `odPostingWrites.js` is a **write-then-read-back pair
that returns a verdict, never a status**. `agreed: false` is a failure of that
step with the disagreement stored, whatever the HTTP status said. There is no
branch anywhere in this slice that reports success from a response code.

And **`DateCP` is never sent.** Not "sent and tolerated" — never sent.
`postingDrain.test.js` asserts it is absent from every write body. The carrier's
adjudication date lives in `rcm_posting_queue.carrier_eob_date` and in the note
text, and the module never claims to have back-dated a chart.

### 3.3 `DateReceived` — a decision worth naming

The claim PUT sets `DateReceived` from **the carrier's own EOB date** when the
remittance carried one, falling back to today in `OFFICE_TIMEZONE` (not UTC —
UTC midnight lands mid-evening in Central, so a 7pm drain would stamp tomorrow).

`DateReceived` is the claim-level "when did the response arrive", the carrier's
remittance date is the truest available answer, and unlike `DateCP` this field
**is** writable and **is** verified by read-back. "Today" would stamp the date
the drain happened to run, which is an artefact of our scheduling rather than a
fact about the claim.

### 3.4 The note, and why it is appended rather than written

A PUT that includes `ClaimNote` **replaces** it. The practice writes real notes
in that field — a denial narrative, a call reference — so the drain reads the
existing note and appends one delimited line:

```
CareIN RCM posting <queueId> · posted by <operator> · carrier EOB date 2026-03-01
```

Idempotent: a note already carrying this plan's id is left alone, so a resume
does not stack a copy per attempt. No patient identity is in it — the note names
the operator, the plan and the payer's date, all of which we minted or the payer
stated.

### 3.5 The eligible-total pre-check

`CheckAmt` must equal the eligible total EXACTLY, and *eligible* is a property of
the **chart**, not of our plan: test 5's refusal names it —
`400 "CheckAmt does not match the total of eligible ClaimProcs."`

It is checked **twice**, and the placement of the first one is the point:

1. **Before the first write**, from the resume read that already happened. Any
   FOREIGN claimproc on these claims that is unattached and carries money makes
   our number wrong. That is `blocked: eligible_total_mismatch` with **nothing
   written at all** — which is what `blocked` promises. Discovering it at the
   check step instead would leave the chart in the §8 window over a condition
   that was already visible.
2. **After the writes, before the POST** — this one proves that *our own* writes
   produced the total we are about to assert. G2 again: each PUT read back
   agreeing, but the SUM is a different claim from any one of them. A
   disagreement here is `partially_posted`, **not** `blocked`: money is on the
   chart, and a state promising nothing was attempted would be a lie.

**Neither is ever a retry with a different number.**

### 3.6 The check endpoint

`resolveCheckEndpoint` picks `single` or `/Batch` from the office's own
`ClaimPaymentBatchOnly` preference and the claim count. **Unknown resolves to
`batch`**, because Batch is legal on a practice that permits both — the choice
that is correct under either truth. Guessing `single` would be a coin flip whose
losing side is a 400 in the middle of the sequence.

---

## 4. Resume — from Open Dental's truth, never from memory

**Rule: before any write on any attempt — first or fifth — the machine reads the
chart and continues from what it says.**

This runs on every attempt, not only on a "resume", because *first attempt* is
not something the machine can know: a process that died between the first PUT and
its first persist looks exactly like a fresh start.

```
GET /claims/{n}                     per distinct claim
GET /claimprocs?ClaimNum={n}        per distinct claim
GET /claimprocs?ClaimPaymentNum=    if the plan already holds a check number
```

`decideLineAction` then decides, per line, from the chart:

| Chart says | Action | Why |
| --- | --- | --- |
| Not received | **write** | The ordinary case. |
| `Received`, our exact amounts, no check | **skip** → `skipped_already_posted` | Already done. Recorded with a reason, never as a silent success. |
| `Received`, our exact amounts, **on a check** | **adopt** | Test 11 says a PUT would be refused, and it would be wrong anyway. Carries the check number. |
| `Received`, **different** amounts | **conflict** | Somebody else posted it. Refusal. |
| `Adjustment` / `InsHist` / `Cap*` / `IsTransfer` | **conflict** | The statuses Open Dental refuses to update — predicted, not discovered as a 400. |
| Not on the claim at all | **conflict** | The plan is built on something that has since changed. |

**A conflict refuses the whole row, not one line.** The unit Open Dental
adjudicated is the claim, and the eligible-total rule makes the check a statement
about *all* of a claim's unattached lines. Posting the rest would assert a
`CheckAmt` over a set we do not understand. Also worth remembering here:
*"Editing a received ClaimProc can delete all of the Income Transfers on the
claim"* — the most dangerous sentence in Open Dental's documentation.

### 4.1 Persistence

Every transition is committed **before** the Open Dental call it precedes. There
is no transaction spanning an OD call: holding one open across a 1.2-s-paced
round trip would pin a connection for the length of the drain and buy nothing,
because Open Dental cannot participate in it.

`drain_step` is the row's cursor. It is **advisory** — resume trusts the chart,
not the cursor — and exists so a stuck row is legible to a human without an OD
round trip.

### 4.2 Where it failed decides what the row says

| Failed at | Row becomes |
| --- | --- |
| `resolve_config`, `read_od_truth` | `failed` — no write was issued, so nothing moved. |
| `claimproc_writes` onwards | `partially_posted` — a request that threw **may** have reached Open Dental. |

A dead socket does not say whether the server acted, so "the first PUT was
attempted" and "the first PUT landed" are indistinguishable from inside. Claiming
`failed` would be claiming nothing moved. `postingDrain.test.js` pins this.

---

## 5. Idempotency — proofs, not assurances

### 5.1 No second check, ever

Before `POST /claimpayments*` the drain checks **two** things:

1. `od_claim_payment_num` on the row; and
2. the chart — if our own lines already carry a non-zero `ClaimPaymentNum`, that
   check **is** this plan's check, created by an earlier attempt that died before
   it could record the number. It is **adopted**.

There is no path through the code that reaches the POST with a check already in
hand. A plan whose lines are spread across two different checks is
`OD_MULTIPLE_CHECKS` — a refusal, not a guess.

The check number is persisted in **one statement immediately after the 201**,
before the reconciliation read. That is the narrowest window in the sequence and
the most expensive one to widen.

### 5.2 The tests that prove it

`postingDrain.test.js` kills the process after each write in turn and resumes
against the chart the dying run left behind, through a fresh client — exactly
what a restarted container gets:

| Killed | Mid-state | After resume |
| --- | --- | --- |
| before the claimproc PUT lands | `partially_posted` | `posted`, 1 landed claimproc write, **1 check** |
| after the claimproc PUT, before the claim PUT | `partially_posted` | `posted`, 1 landed claimproc write, **1 check** |
| after the claim PUT, before the check (**the §8 window**) | `partially_posted` | `posted`, 1 landed claimproc write, **1 check** |
| **the check LANDED and the response was lost** | `partially_posted`, `od_claim_payment_num` null, check really in the chart | `posted` by **adopting** it — the resume issues **zero writes** |

Duplicate writes are counted as writes that **landed**, not calls attempted: a
call that never reached the database changed nothing, and the two differ by
exactly one on every crash.

Plus: re-running a `posted` plan is `ran: 0` and touches Open Dental **not at
all**; two concurrent drains are `DRAIN_ALREADY_RUNNING` 409.

### 5.3 The database's own guarantees (from 6b, still doing the work)

- `rcm_claims.posting_queue_id` — a claim can be on at most one plan.
- a partial unique index on `rcm_posting_queue_line (office_id,
  od_claim_proc_num) WHERE is_supplemental = false` — one claimproc, one ordinary
  adjudication, in any office, by any path.
- `rcm_posting_queue (office_id, remittance_key)` unique — one plan per check.

Office is in every one of those keys, because ClaimProcNum numbering restarts in
every Open Dental database.

---

## 6. Per-office runtime configuration

Resolved at drain time from **the office's own** Open Dental, cached one hour,
never hardcoded.

| What | Where | Roland (verified live) |
| --- | --- | --- |
| PayType | definitions **Category 32** | 296 Check · 297 EFT · 404 Credit Card · 472 Insurance Check |
| AdjType | definitions **Category 1** | 39 rows; sign carried from `ItemValue` |
| DocCategory | definitions **Category 18** | 33 rows incl. 131 Insurance, 134 Financial (6d) |
| `ClaimPaymentBatchOnly` | preferences | `0` |
| `ShowAutoDeposit` | preferences | `0` |

**Numeric `Category=` only.** `?category=InsurancePaymentType` and
`?category=NotARealCategory` both returned the same unfiltered 100-row page
spanning Categories 0–6 — *"a string filter is a lie, not a 400"*.
`odOfficeConfig.test.js` drives that behaviour explicitly rather than asserting it
in a comment, and every row is re-filtered client-side so an ignored filter yields
a correct (possibly empty) set rather than a wrong one.

**An insurance check prefers `Insurance Check` (472) over `Check` (296)** — exact
case-insensitive name match, most specific first. A substring rule would make the
answer depend on list order.

**No stale fallback, unlike `commlogTypes.js`.** That module serves a stale
catalogue on a failed refresh, and that is right for a dropdown: the office's own
verified default is accepted without consulting the list. Posting has no such
default. There is no PayType we may assume, and a check filed under the wrong
payment method is a reconciliation problem discovered weeks later — so an
unresolvable config is `blocked`, and a 200 carrying no usable payment type is a
refusal rather than an empty configuration.

---

## 7. Attribution

**Open Dental cannot attribute an API write to a human.** Spike 0b test 13: every
row logs `UserNum: 0`, `LogSource: "API"`, `LogText: "Created by Sparkman DDS
through API."` — the OD user bound to the developer key.

So attribution is three things, and only the middle one is in the chart:

1. **`rcm_posting_queue.approved_by`** — who authorised it (6b, crosswalk-typed).
2. **The free-text note** on the claim and the check — the operator's name and
   the plan id, the only thing Open Dental can hold.
3. **`audit_log`** — the real record. **One row per Open Dental call, reads
   included**, carrying office, action, and the OD identifier touched. Writes
   carry the read-back verdict as `result` (`SUCCESS` / `ERROR`), and the
   read-back gets its **own** `READ` row rather than being folded into the write
   — rule 13 is "one row per PHI read AND per write", not "per operation".

Plus `rcm_posting_queue.drained_by` / `drain_attempt_at`: who pressed, and when.

The audit write is **fail-closed**, and the consequence is deliberate: a failed
audit throws, which aborts the row mid-sequence and leaves it `partially_posted`.
That is correct — carrying on writing to a chart with no recorded trail is what
hard rule 5 forbids, and resume re-reads Open Dental anyway, so the abort costs a
retry rather than correctness.

---

## 8. The trigger, the pacing, and the runner

**A human presses a button. That is the only way a chart gets written.**

No cron. No timer. No auto-drain on approve. The startup sweep
(`sweepInterruptedPostings`) is the single automatic thing and it does **not**
drain — it re-homes rows a dead process left at `posting` back to `approved` so a
human can press the button again. A container restart that posted payments by
itself would be the opposite of every rule in this module.

*(Auto-drain on approve is a later decision, once the state machine has lived on
staging.)*

**Pacing (D-8).** Every Open Dental call — reads included — goes through
`odPacer` at ≥1.2 s. The credential is shared with the voice module and TC, and a
biller draining a check must never degrade the phones. RCM holds the shared slot;
there is deliberately **no** yield-backoff, because the key stays under Open
Dental's published rate by construction.

**Serial, single runner, maxReplicas = 1.** One in-process loop, one plan at a
time, claims in order, lines in order. `DRAIN_MUTEX` is process-wide and honest
about being exactly that.

> ⚠️ **Under a second replica this design is actively unsafe.** Replica B would
> pick up a plan replica A is mid-sequence on and re-issue writes A has already
> made. A timestamp filter does not fix it. The fix is a lease with a heartbeat on
> the queue row, and that is the work to do **before** raising maxReplicas, not
> after. Same standing invariant `eobStartupSweep.js` documents, with money
> attached.

**Bounded.** The drain is a held HTTP request with a wall-clock budget
(`DEFAULT_BUDGET_MS`, 4 minutes). The budget is checked **between plans and
nowhere else** — stopping mid-claim would deliberately open the §8 window this
whole design exists to survive. Out of time returns `outOfTime: true` with
`remaining`, and the button is pressed again.

Four minutes sits near a typical ingress idle timeout, and that is safe rather
than lucky: **a cut response is cosmetic.** Every transition is committed before
the Open Dental call it precedes, so a run whose HTTP response never arrives has
still recorded exactly where it got to — refresh the Posting screen and the truth
is there, press Drain again and it resumes from the chart. The budget bounds how
long a request is HELD; it is not what makes the run recoverable.

---

## 9. D-7 — valley is fail-closed, and how it gets switched on

`OFFICES_ENABLED_FOR_POSTING = ['roland']`. A valley plan drains to
`blocked: valley_not_enabled` with **no Open Dental call at all** — not even a
read of Riley's definitions. Never a silent skip; never a roland fallback.

**An env var deliberately cannot open this.** The lockdown-as-a-flag idiom fits a
bootstrap fallback; it does not fit *"may this practice's charts be written to"*,
where the cost of a typo in an app setting is a payment posted into the wrong
database under DefNums nobody verified. Enabling valley is a code change, in a
diff, with the evidence in the same commit.

### The three prerequisites

Valley may be added to `OFFICES_ENABLED_FOR_POSTING` only when all three are
recorded here.

| # | Prerequisite | Status |
| --- | --- | --- |
| **(a)** | The Riley key's **write** permission groups (Insurance, Documents) proven by the zero-risk probe. TC #97 proved the **read** groups, which is a different entitlement — Open Dental licenses reads and writes separately, by permission group, and **no read can establish write entitlement**. | ❌ **NOT DONE** — see below |
| **(b)** | Riley's own Category 32 / 1 / 18 DefNums read from Riley's own Open Dental. | ✅ **DONE 2026-08-19** — recorded below |
| **(c)** | PatNum 7115 can carry a claim (an active plan). | ✅ **coverage confirmed 2026-08-19**; the e2e itself still to run |

---

### (b) Riley's DefNums — read live from Riley's own database, 2026-08-19

Read through the platform's own credential path from inside the staging
container, so the Riley customer key was used in place and never printed.
Configuration only — no patient data.

**`Category 32` — PayType. This is the one the drain writes.**

| | roland | valley (Riley) |
| --- | --- | --- |
| Check | **296** | **258** |
| EFT | **297** | **259** |
| Credit Card | **404** | **334** |
| Insurance Check | **472** | **428** |

**Not one number is shared.** `pickPayType` matches on NAME, exact and
case-insensitive, insurance-specific first — so roland resolves 472 and valley
resolves 428 for the same check, from the same code, with nothing hardcoded.

**`Category 1` — AdjType (39 rows in both). The RCM-relevant members:**

| Meaning | roland | valley |
| --- | --- | --- |
| Insurance write-off | 12 `Insurance Write-off` | **10** `Insurance Write off` |
| Plain write-off | **10** `Write-off` | 408 `Write-off` |
| Insurance adjustment (+) | 260 | 402 |
| PPO adjustment (+) | 262 | 406 |
| Insurance deductions from previous payments | 477 | 435 |
| Medicaid write-offs | 460–463 | 409–412 |

> ⚠️ **DefNum 10 is live in BOTH practices and means something different in each:
> `Write-off` in Roland, `Insurance Write off` in Riley.** This is the 401
> commlog-type collision repeated with money attached, and it is the single best
> argument in this document for why the registry exists. A hardcoded 10 would
> post a plain write-off in one practice and an insurance write-off in the other,
> silently, forever. *(AdjTypes are read by 6c and written by nothing yet.)*

**`Category 18` — DocCategory (6d's, for the EOB PDF):** roland 33 rows, valley
31. `131 Insurance` and `134 Financial` happen to agree; `Consent Forms` is
**473** in roland and **429** in valley — the same split the H0 spike recorded.
Agreement on two numbers is a coincidence, not a rule.

**Preferences, both practices:** `ClaimPaymentBatchOnly = 0`,
`ShowAutoDeposit = 0`. **Build:** both on `ProgramVersion 25.4.48.0` /
`DataBaseVersion 25.4.45.0`, so no version gate separates them.

`filterHonored = true` on all six definition reads — the numeric `Category=`
filter is honoured by both databases, and the client-side re-filter was a no-op.

---

### (c) PatNum 7115 — coverage confirmed

```
GET /patients/7115        -> 200   PatNum=7115  PatStatus=Patient
GET /patplans?PatNum=7115 -> 200   1 row: PatPlanNum=12402 InsSubNum=9088 Ordinal=1
GET /claims?PatNum=7115   -> 200   0 rows
GET /procedurelogs?…      -> 200   1 row
```

**7115 already has an active plan**, so unlike 12827 — which blocked Spike 0b
until Beau added `PatPlanNum 20469` — it should be able to carry a claim without
setup. The e2e itself is still to run.

Two things worth not misreading:

- `GET /inssubs?PatNum=7115` returns **0 rows**. Inssubs are keyed by the
  SUBSCRIBER, not the patient. That is not evidence of missing coverage.
- The `patplans` rows carry no `DateEffective` / `DateTerm` under those names, so
  the plan's date window was not read here.

---

### (a) The write-verb probe — APPROVED, SCRIPTED, NOT YET RUN

**This is the one prerequisite still outstanding, and it is the one that actually
gates posting.**

Beau approved it on 2026-08-20 with three conditions. Two are satisfied by the
scripts below; the third is a scheduling decision:

| Condition | State |
| --- | --- |
| 1. Run at a **quiet hour for the Valley office** | ⬜ **the blocker.** The go-ahead arrived at 08:52 Central on a Thursday — the busiest part of a practice's day, with the voice module actively using the same credential. Not run. |
| 2. A read sweep immediately after, proving nothing landed | ✅ scripted: `backend/scripts/rcm-d7-read-sweep.js` |
| 3. The full transcript pasted into this section | ✅ ready — the scripts print request, status and refusal text verbatim, in the Spike 0b style |

Both scripts are **checked into the repo** rather than pasted from a scratchpad,
so the thing that gets run is the thing that was reviewed:

```bash
# From inside the staging container, at a quiet hour.
PROBE_OFFICE=valley node scripts/rcm-d7-write-probe.js
PROBE_OFFICE=valley node scripts/rcm-d7-read-sweep.js
```

**Why it is zero-risk**, from the canon:

> *"Because the method check precedes the row lookup, write-verb existence can be
> probed against a non-existent id with zero risk to data."*

`404 "… not found."` means the request reached the row lookup, so the permission
group **is** enabled. `403` means it is not. Four safety properties are enforced
in the script rather than asserted about it, and `rcmNoOdWrites.test.js` pins all
four:

1. every target id is GET-checked first, and the probe **aborts** if any exists;
2. the ids are far outside any real range in either practice;
3. POST and PUT only — **never DELETE**;
4. ≥1.3 s between calls, so it cannot crowd the shared credential.

The sweep is not ceremony. *"Zero-risk by construction"* is an argument, and this
module's whole discipline is that an argument about a chart is not evidence about
a chart — G2 is the same lesson one level down. The sweep re-reads the ghost ids,
lists the newest claimpayments with their dates and amounts (a $0.01 check minted
minutes earlier would be unmissable), and checks for a stray document.

Until (a) is recorded here, **valley stays fail-closed in code** — which is where
it would have stayed regardless, so nothing that shipped depends on it.

### How the probes are run

From inside the staging container, so each practice's customer key is resolved
from Key Vault by the app's own loader and is never printed. Running them locally
is **not** an option: `kv-carein-staging` sits in a different Entra tenant from a
workstation `az` token (`AKV10032: Invalid issuer`).

```bash
# az containerapp exec splits --command on whitespace, so ${IFS} stands in for
# a space and the payload is uploaded gzip+base64 in chunks. The exec endpoint
# throttles hard (429) — space the calls out.
MSYS_NO_PATHCONV=1 az containerapp exec \
  -n ca-carein-backend -g rg-carein-staging \
  --replica <replica> --container ca-carein-backend \
  --command 'sh -c node${IFS}/tmp/probe.js'
```

---

## 10. Staging end-to-end — the gated walk

**Designated test patients only. Roland only, until §9 is discharged.**

> ⚠️ **Do NOT reuse claim 53648.** Spike 0b left permanent residue on PatNum
> 12827: procedure `405237`, the **negative supplemental claimproc `533931`**
> (which Open Dental will not let any API caller remove), and adjustments
> `19109`–`19112`. That supplemental permanently pins claim 53648 and its
> procedure. **Author a synthetic 835 that pays a NEW disposable claim.**

### 10.1 Create a disposable target on PatNum 12827

The Spike 0b recipe, ≥1.3 s between calls:

```
POST /procedurelogs {PatNum: 12827, procCode: "D0140", ProcStatus: "C",
                     ProcFee: 1.00, ProvNum: 1}          -> 201  ProcNum=<P>
POST /claims        {PatNum: 12827, procNums: [<P>], ClaimType: "P"}
                                                          -> 201  ClaimNum=<C>, ClaimStatus="W"
GET  /claimprocs?ClaimNum=<C>                             -> 200  1 row, auto-created
                                                                  ClaimProcNum=<CP>, Status="NotReceived"
```

12827 has an active plan (`PatPlanNum 20469`, effective 2026-01-01 → 2026-12-31)
which Beau added for Spike 0b; without it `POST /claims` fails.

### 10.2 The walk

1. Author a synthetic 835 paying **$1.00** on claim `<C>` for PatNum 12827.
   Nothing in it is a real person.
2. Sign in as `admin` or `office`. **/rcm → Remittances** → upload the 835.
3. Match the claim, confirm it against `<C>`, mark it reviewed.
4. **Approve.** The checklist passes; the plan is written. The panel still says
   *"Queued for posting — nothing has been written to Open Dental yet."*
5. **/rcm → Posting.** The plan is there, **Queued**.
6. **Press Drain.** Watch it go `running → posted`. The row shows its
   `ClaimPaymentNum` and *"verified by read-back at &lt;time&gt;"*; the lines show
   *"On the check"* and *"read back"*.
7. **Open Roland's Open Dental and see the payment on PatNum 12827's ledger.**
   This is the step that matters; nothing above it substitutes for it.
8. Confirm the audit trail:

```sql
SELECT action, resource_type, resource_id, result, office, ts
  FROM audit_log
 WHERE resource_type LIKE 'rcm_od_%' OR resource_type = 'rcm_posting_drain'
 ORDER BY ts DESC LIMIT 30;

SELECT status, od_claim_payment_num, reconciled_at, posted_total_cents, drained_by
  FROM rcm_posting_queue WHERE office_id = 'roland';
SELECT position, status, skip_reason, readback->>'agreed' AS verified
  FROM rcm_posting_queue_line ORDER BY position;
```

### 10.3 Kill-mid-drain

Same flow on a **second** disposable claim. Stop the container once a line reads
`claimproc_written`, restart it, and press Drain again.

Expect: the startup sweep re-queues the plan (`approved`, `drain_step` null, a
`last_error` explaining the restart); the drain resumes and reaches `posted`; and
there is **exactly one** ClaimPayment.

```sql
SELECT count(DISTINCT od_claim_payment_num) FROM rcm_posting_queue_line
 WHERE queue_id = '<plan>' AND od_claim_payment_num IS NOT NULL;   -- 1
```

### 10.4 Replay

Press Drain again on the posted plan. Expect `ran: 0` and **no Open Dental call
at all**.

### 10.5 Valley

A valley plan drains to `blocked: valley_not_enabled`, with no Open Dental call.
The screen says why. After §9 is discharged, the same walk on **PatNum 7115**.

---

## 11. The unwind — returning the test patient to $0.00

Measured end to end in the Spike 0b teardown. **Order is mandatory** and the
first pass fails if you try it any other way.

```
1.  DELETE /claimpayments/{ClaimPaymentNum}        -> 200
      (only possible BEFORE an EOB or a deposit is attached)
      Deleting the check does NOT clear the claimproc: InsPayAmt stays put,
      ClaimPaymentNum resets to 0.

2.  PUT /claimprocs/{n} {Status:"NotReceived", InsPayAmt:0, WriteOff:0, DedApplied:0}
                                                   -> 200
      The claim is pinned by the money on its lines until this runs.

3.  DELETE /claims/{ClaimNum}                      -> 200

4.  DELETE /procedurelogs/{ProcNum}                -> 200
      ⚠️ SOFT DELETE (G12): the row comes back with ProcStatus:"D" and STILL
      APPEARS in GET /procedurelogs. Any ledger arithmetic must filter it out —
      this bit the spike's own teardown and over-applied a reversal by $2.00.
```

**What cannot be unwound:** a negative supplemental. It cannot be reverted
(`400 "Cannot change Status from Supplemental when there is a ClaimProc with a
different status and the same ProcNum."`) and cannot be deleted (`DELETE
/claimprocs` does not exist on 25.4.48). It then pins its claim and that claim's
procedure forever. **This slice never creates one** — that is D-6 and 6d.

Then verify the patient nets to zero:

```
charges (ProcStatus != "D")   ...
insurance paid                ...
adjustments                   ...
------------------------------------
PATIENT BALANCE               0.00
```

12827's permanent Spike 0b residue (`-0.20` supplemental, offset by adjustments
19109–19112) already nets to $0.00 and must be left alone.

---

## 11a. Migration rehearsal (PostgreSQL 17)

`up` (all) → objects present → the constraints exercised → `down 1` → `up` again
→ `down` all the way, clean on a throwaway `postgres:17` container.

**Both halves are exercised** — seven refusals and six allowances — because a
constraint that refuses everything is as wrong as one that refuses nothing, and
three of the allowances are cases an over-eager CHECK would have broken.

Refused:

```
blocked with NO reason                     -> rcm_posting_queue_blocked_reason_check
a reason on a NON-blocked row              -> rcm_posting_queue_blocked_reason_check
posted with NO check number                -> rcm_posting_queue_posted_proof_check
posted with NO reconciliation              -> rcm_posting_queue_posted_proof_check
an unknown plan status ('running')         -> rcm_posting_queue_status_check
a skipped line with NO skip_reason         -> rcm_posting_queue_line_skip_reason_check
a skip_reason on a NON-skipped line        -> rcm_posting_queue_line_skip_reason_check
```

Allowed:

```
blocked WITH a reason
posted WITH both proofs
partially_posted with a check and NO reconciliation   <- the state that NEEDS this
skipped_already_posted WITH a reason
a line carrying its read-back jsonb
Slice 1's `skipped`, still storable and still unused by 6c
```

The fifth refusal is worth noticing: `'running'` is the word the BRIEF uses and
the database will not store it. That is the vocabulary decision in §2.1 made
enforceable — the stored word is `posting`, and a screen's label can never leak
into a column.

`down` deliberately FAILS on a database holding a `blocked` row or a
`skipped_already_posted` line, because it restores the Slice 1 vocabularies.
Silently rewriting a refusal to make a rollback succeed would erase the fact that
a human still owes an action.

---

## 12. Permission (D-9)

| Tier | `GET /posting/queue[/:id]` | `POST /posting/drain` |
| --- | --- | --- |
| `admin`, `office` | ✅ | ✅ |
| `reviewer` | ✅ | ❌ 403 |
| anything else | ❌ | ❌ |

`POST /posting/drain` is deliberately **not** in `routes/rcm/index.js`
`QUEUE_PATHS`, so the mount's `requireReadWrite('rcm.read','rcm.write')` demands
`rcm.write` by construction and a `reviewer` never reaches the handler. The
in-handler `DRAIN_REQUIRES_WRITE` check behind it is defence in depth for a future
remount.

The GETs run on `rcm.read`: watching a plan post, and reading why one is blocked,
is not a posting act. The response says `canDrain` / `drainRequires` so the screen
renders the server's answer rather than inspecting a role name.

---

## 13. The guard: exactly one file may write

`routes/rcm/rcmNoOdWrites.test.js` was *"the RCM module never writes to Open
Dental"*. It is now:

1. **Allow-list of one.** `services/rcm/odPostingWrites.js` may name
   `apiWriteRaw` and the posting endpoints. Nothing else may — a static scan over
   every RCM source.
2. **The allow-listed file is real** and does **not** reach for
   `claimprocs/Supplemental`, `documents/Upload`, `/payments` or `/paysplits` —
   the three paths 6c deliberately excludes.
3. **The old claim, unweakened.** Driving approve, match, review and every read
   route still yields no write verb — against a plan that IS drainable and a
   client that CAN write.
4. **The new claim, bounded.** Driving the drain yields exactly
   `PUT /claimprocs/{n}` → `PUT /claims/{n}` → `POST /claimpayments`, in that
   order, and nothing else.
5. **Two separate powers over the queue.** Only `approvalGate.js` may `INSERT`
   a plan; only `postingDrain.js` may `UPDATE` one. The drain must never be able
   to mint a plan — that would let it post money nobody approved.
6. **The graph.** The extraction worker and the ERA parser still reach no Open
   Dental module at all; the approval gate still reaches none either. *Approving
   is not posting* survives 6c as a require-graph fact.

The transport gained one method, `OpenDentalService.apiWriteRaw(method, path,
body)` — POST and PUT only. **No DELETE**: nothing in the posting sequence
deletes, the unwind is a human-run script, and `DELETE /claimprocs` does not exist
on this build at all. `OPENDENTAL_WRITE_DISABLED` is enforced **inside the
transport**, so it cannot be routed around by anything writing through the class.

---

## 14. The screens

![the posting queue, waiting](screenshots/rcm-posting/posting-01-queued.png)

Approved plans, labelled by their check and payer, with the honest sentence:
*"Approved and waiting. Nothing has been written to Open Dental."*

![a plan mid-sequence](screenshots/rcm-posting/posting-02-running.png)

![partly posted, with the exact positions](screenshots/rcm-posting/posting-03-partially-posted.png)

The §8 window on screen. Money reached the chart, the check does not carry what
the plan intended, and the lines say exactly which. Line 2's read-back
**disagreed on InsPayAmt** — the field is named, because *"OD write failed"* tells
nobody which number lied.

![blocked: valley](screenshots/rcm-posting/posting-04-blocked.png)

D-7, in the server's words, on both the office and the plan. No Open Dental call
was made.

![posted, with its check number and read-back proof](screenshots/rcm-posting/posting-05-posted.png)

The check that exists in the practice's books, and the time the reconciliation
read confirmed it carries exactly this plan's lines. Both are required by a CHECK
constraint, so this is a statement of fact.

![the reviewer's view](screenshots/rcm-posting/posting-06-reviewer.png)

The same queue. A disabled button, naming the permission an approver holds.

---

## 15. Known limits — logged here, not fixed

| | Limit | Why it waits |
| --- | --- | --- |
| **A partially-approved remittance posts as more than one check** | The plan's `CheckAmt` is the sum of the claims that were approved, so a check with nine clean claims and one reversal posts a check for nine. The practice's deposit then sees two OD checks summing to the carrier's one. **PM ruling wanted.** | Inherent to 6b's partial approve, which is a deliberate feature. Changing it means either refusing partial approves or teaching the drain to wait for the whole remittance. |
| **A claim fixed after its remittance's plan has run cannot post through CareIN at all** | See §15.1 below — it now has its own refusal and its own sentence rather than hiding behind "already under way". | Needs a decision about whether a remittance may carry a second plan, which the `(office_id, remittance_key)` unique index currently forbids. |
| **The drain is a held HTTP request** | Like the batch matcher. Bounded by a wall-clock budget and honest about running out. | A polled job needs run state; the queue row is close but the request/response shape is a separate change. |
| **maxReplicas = 1 is a standing requirement, not a constraint the code enforces** | §8. | A lease + heartbeat on the queue row. Do it **before** raising maxReplicas. |
| **A 429 replays the request, writes included** | The transport's backoff retries on 429 only. A 429 is a rate-limit rejection *before* processing, so a replay is safe in practice — and §5.1's adopt-before-create covers the residual case. | Noted rather than fixed; making writes non-retryable would trade a real safety margin for a theoretical one. |
| **`audit.source_ref` is unused** | Same gap the voice→TC handoff has. | A column, not a design. |
| **Recoupments, the EOB attach, patient portion** | 6d and the PRD's deferred flow. `ApiPayments` is not enabled on the key at all (G11). | By design. |

### 15.1 A withheld claim fixed after the plan has drained

**This is the one limitation a biller will actually hit, and it has no
workaround inside CareIN.**

`rcm_posting_queue` is unique on `(office_id, remittance_key)`: **a remittance
gets exactly ONE posting plan, ever.** 6b's partial approve is a deliberate
feature — nine clean claims enqueue and the tenth is withheld and named — but the
tenth can only join that plan while it is still `approved`. Once a drain has had
it, approving again is refused.

The money still has to go in. **It goes in by hand, in Open Dental**, until a
later slice adds a follow-on plan.

Two refusals, because they are two different facts:

| Plan status | Code | What it says |
| --- | --- | --- |
| `posting` | `QUEUE_ALREADY_RUNNING` | A drain holds it **right now**. Waiting genuinely is the answer. |
| `posted` | `QUEUE_ALREADY_RAN` | Already finished, its payment is in Open Dental. Post this claim by hand. |
| `partially_posted` | `QUEUE_ALREADY_RAN` | Put money in the chart and stopped part-way. Resolve that run on the Posting screen first. |
| `failed`, `blocked` | `QUEUE_ALREADY_RAN` | A drain has had it and it is not accepting more claims. It can still be drained again — but not with this claim on it. |

Both are 409s and both carry `queueStatus`, so a screen can link to the Posting
queue for a plan that can still be drained and nowhere for one that has finished,
without parsing prose.

Until 6c there was one sentence for all of them — *"a posting run for this
remittance is already under way"* — which was **false** for every status but
`posting`, and which read as "wait a minute and try again" about a plan that had
finished hours earlier. The limitation was real either way; the sentence hid it.

---

## 16. Out of scope

Recoupments and negative anything (6d) · document attach (6d) · patient portion /
PaySplits / `/payments` (PRD-deferred, G11) · auto-drain on approve (a later
decision) · reconciliation, VCC, Stedi, OCR · entitlement changes · prod.

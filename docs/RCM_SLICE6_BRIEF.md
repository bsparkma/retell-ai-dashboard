# Slice 6 Brief — Review-then-Post (the core of the RCM module)

> Design of record for Slices 6a–6d. Where this brief and the as-built PRs differ, the PR and its docs are the record; see docs/RCM_APPROVAL_GATE.md for 6b.

**Version 1.0 · 2026-08-14 · PM: RCM Cowork session · For Beau's read before any build prompt ships**
**Inputs:** `docs/RCM_OD_WRITES.md` (Spikes 0a+0b — every constraint below is live-proven), PRD v1.0, Slices 1–5 as merged.

---

## 1. What this slice is

Everything before this was intake: documents in, proposals out, provably incapable of touching Open Dental. Slice 6 is the other half: **an approved proposal becomes a real insurance payment on a real patient's ledger in the correct office's Open Dental** — through a server-side gate, a durable queue, and a verified call sequence. It is the highest-blast-radius code on the platform, which is why this brief exists before a build prompt does.

The port laws govern everything here: office identity server-derived and fail-closed; review-then-post server-side, attributed, idempotent, audited; honest states; PHI hygiene; and (satisfied by the spikes) no unproven write path.

## 2. The shape: five stages, one queue

```
match → review → APPROVE (the gate) → enqueue (durable intent) → drain (the state machine) → posted
```

The **queue is the design center**. OD has no transactions (G4), so a multi-line posting is a sequence of independent calls with a worst failure window between "claim marked Received" and "check created." `rcm_posting_queue` + `rcm_posting_queue_line` (built in Slice 1 for exactly this) records the intended per-line amounts BEFORE the first OD call, so any failure resumes from a durable record rather than a guess. Postgres is the queue; there is no broker; the drain is a serial in-process loop under maxReplicas=1 (same runner pattern as extraction, same future lease requirement before any scale-out).

## 3. Stage by stage

### 3.1 Matching (remittance claim ↔ real OD claim)

First OD contact in the module — READS only, via `getOdClientForOffice(officeKey)`, one audit row per PHI read (TC convention). For each proposal claim: locate the OD claim by patient + claim identifiers + procedure codes + amounts (`GET /claims?PatNum`, `GET /claimprocs?ClaimNum` — proven shapes). Every match gets a confidence and is **shown to the reviewer as a claim-level fact**; an unmatched or ambiguous claim is flagged and CANNOT be approved. No fuzzy auto-match ever posts: the human confirms the match as part of review. ProcStatus `"D"` rows are filtered from all comparison math (G12). Pre-flight also re-checks `IsTransfer` and blocked statuses so refusals are predicted, not discovered.

### 3.2 Review & the approval gate (Law 2, F3's fix)

The submit endpoint is the gate. On approve it **re-checks everything server-side**, ignoring whatever the UI claimed: match confirmed for every line; no unresolved flags (uncertain lines, unparseable CAS, arithmetic mismatch, reversal/patient-responsibility markers — those last two can NEVER be approved, only routed to the manual SOP); amounts still equal the parsed remittance; office consistent across every row; batch total = Σ claim payments = Σ intended line amounts. It records the approving user (crosswalk-typed), writes the append-only audit row, and enqueues idempotently on `(office_id, remittance_key)` — a replayed approve returns the existing queue row, never a second posting. There is no force flag of any kind.

### 3.3 Drain — the posting state machine (the forced order, live-proven)

Per queue row, paced ≥1.2s/call (the throttle is shared with voice commlogs and TC — the drain yields, never bursts):

1. **Per line:** `PUT /claimprocs/{n}` {Status: Received, InsPayAmt, WriteOff, DedApplied} → **read back and compare** → line `claimproc_written`. (G2: OD returns 200 on writes it ignores — read-back is the only proof. Every write in this machine is verified this way, no exceptions.)
2. **Per claim:** `PUT /claims/{n}` {ClaimStatus: R, DateReceived} → read back → line `claim_received`. Carrier's EOB date goes in `ClaimNote`/our `carrier_eob_date` — we never claim to have back-dated DateCP.
3. **Check:** `POST /claimpayments` (or `/Batch` across claims — the real EOB shape) with CheckAmt = Σ eligible lines, PayType from the per-office registry. Store the returned `od_claim_payment_num` — proof the money landed. Reconciliation read: `GET /claimprocs?ClaimPaymentNum=` must return exactly our lines. Lines → `paid`.
4. **Document:** EOB/ERA PDF → `POST /documents/Upload` into the patient's images (DocCategory per office; DateCreated in its odd `"yyyy-MM-dd HH:mm:ss"` format). Weakest step last: a document failure is retryable and never a financial error.

Failure anywhere → row `failed` or `partially_posted` with exact per-line positions. **Resume re-reads OD first** (which lines already Received? which already attached?) and continues from truth, not memory. The OD-side note text carries the operator's name (free text is all OD can hold — our audit_log is the real attribution record).

### 3.4 The recoupment one-way door (G10)

A negative supplemental is the single irreversible OD operation: it cannot be reverted, cannot be deleted, and permanently pins its claim and procedure. Ordinary posting is correctable; recoupments are not. So `is_recoupment` rows take a **separate, harder gate**: a distinct confirm step whose shape is Decision D-6 (below), a visually distinct review presentation, its own audit event type, and the DefNum-477 adjustment path documented as the reversible alternative the reviewer may choose instead.

### 3.5 Per-office runtime configuration

Resolved at drain time from the office's own OD, cached with refresh, never hardcoded: PayType (definitions **Category 32** — roland 296/297/404/472), AdjType (Category 1), DocCategory (Category 18 — roland 131/134). Preferences read, not assumed: `ClaimPaymentBatchOnly`, `ShowAutoDeposit`. All numeric `Category=` filters only (string filters are silently ignored). **Valley's numbers are different and unverified — see D-7.**

## 4. Sub-slices (Slice 6 is the mass — it ships as four PRs)

- **6a — Matching + review surface:** odReads client for RCM, match engine, PHI-read audit rows, claim detail endpoint the review UI consumes. No writes.
- **6b — Approval gate + enqueue:** the submit endpoint, server-side re-checks, crosswalk attribution, audit rows, idempotent queue writes. Still no OD writes.
- **6c — Drain state machine:** the four-stage sequence, read-back verification, resume-from-OD-truth, per-office registries, throttle pacing. **First OD write in the module.** Staging e2e on designated test patients only (roland 12827/12828). This PR carries the heaviest review.
- **6d — Recoupment gate + document attach + wrap:** the one-way-door confirm, EOB filing, end-to-end staging walk, both-office isolation proof.

Each rides the normal pipeline; 6c's staging validation is a gated event you walk personally, like the TC go-live.

## 5. Acceptance (module-level, before any prod entitlement)

Staging, SSO session, designated test patients only: a synthetic EOB uploaded → extracted → matched → approved → drained → visible in Roland's real OD on the test patient with correct amounts, check, and attached PDF; the queue row `posted` with `od_claim_payment_num`; audit trail names the approver; replayed approve is a no-op; a killed-mid-drain row resumes to completion; a recoupment cannot pass the ordinary gate; valley behavior per D-7. OD ledger for the test patient returns to $0.00 via the proven unwind after validation (except any deliberate recoupment test, which is permanent and labeled).

## 6. Three decisions before the 6a prompt ships (D-5, D-6, D-7)

**D-5 — How real staff map into `rcm_user_map` (approval attribution).**
PM recommendation: **auto-upsert on first RCM action** — when an SSO-authenticated user first approves (or acts), a crosswalk row is created from their platform identity. Zero admin ceremony, attribution guaranteed, matches how the roles spine already works. Alternative: explicit admin mapping screen (more control, more friction, one more thing to forget before a biller's first day).

**D-6 — The recoupment gate's shape.**
PM recommendation: **typed confirmation** — the approver must type a short phrase (e.g. the amount) into a distinct confirm dialog; the server validates the typed value against the row; distinct audit event. Strong enough friction for a solo-biller practice, no second person required. Alternatives: (a) second-person approval (two distinct users — right answer at team scale, blocking at yours today; can be added later as a setting), (b) separate permission `rcm.recoup` granted to fewer roles (adds role admin overhead now).

**D-7 — Valley posting at Slice 6 launch.**
PM recommendation: **roland-only at first; valley fail-closed** — valley approve/drain refuses with an honest "valley posting not yet enabled" until (1) valley's DefNums are read and verified from Riley's OD, (2) a valley test-patient e2e passes (7115 exists but has no posting-fixture setup yet). This is the fail-closed-per-office law applied to rollout, and it mirrors how M5 rolled per-office OD on voice. Alternative: both offices at once (saves a later step, doubles the first-validation surface).

---

*After your read and the three answers, the 6a build prompt ships. 6b–6d follow as each lands.*

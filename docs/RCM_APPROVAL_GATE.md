# RCM Slice 6b — the approval gate, and the durable record of intent

The one thing the workbench's disabled **Approve** button has been waiting for.
**Still zero Open Dental writes. Still zero Open Dental calls.**

| | |
| --- | --- |
| Routes (UI) | `/rcm/remittances/:id` (the panel), `/rcm/sop/takeback` (the manual route out) |
| Routes (API) | `GET /api/rcm/remittances/:id/approval`, `POST /api/rcm/remittances/:id/approve` |
| Entitlement | `requireModule('rcm')` — ships dark; no tenant is entitled yet |
| Permission | `rcm.read` for the checklist, `rcm.write` for the approve (D-9) |
| Office | Slice 3's router-wide `requireOffice` — the validated `?office=` query param |
| Migration | `backend/migrations-tenant/1787080000000_rcm_posting_approval.js` (additive only) |
| Code | [`backend/routes/rcm/approvalGate.js`](../backend/routes/rcm/approvalGate.js), [`backend/services/rcm/rcmVocabulary.js`](../backend/services/rcm/rcmVocabulary.js), [`new-dashboard/client/src/pages/rcm/ApprovalPanel.tsx`](../new-dashboard/client/src/pages/rcm/ApprovalPanel.tsx) |
| Tests | `approvalGate.test.js` (35), `rcmNoOdWrites.test.js` (10), `workbench.test.js` (65), `rcmVocabulary.test.js`, `rcm-workbench.test.tsx` (49), `rcm-labels.test.ts` |

---

## 1. What "approve" means, and what it does not

Approving writes a **posting plan** to CareIN's own database:

- one `rcm_posting_queue` row per remittance, `status = 'approved'` — the Slice 1
  vocabulary's word for *"approved and NOT yet posted"*;
- one `rcm_posting_queue_line` per claimproc, carrying the **intended**
  `InsPayAmt` / `WriteOff` / `DedApplied` in cents and the Open Dental
  identifiers from the confirmed match snapshot;
- a linkage on each approved claim: `posting_queue_id`, `approved_at`,
  `approved_by`.

**Nothing reaches Open Dental.** `rcmNoOdWrites.test.js` drives the approve path
to *success* against a client whose every verb throws, and asserts not one
method was called — not a write, not even a read. There is no drain, no cron, no
startup sweep and no worker. That is Slice 6c, behind its own gated staging
event.

The screen says so in the server's own words:

> Queued for posting — nothing has been written to Open Dental yet.

That sentence is exactly true today and stops being true the day 6c ships, which
is why it lives on the response rather than in the client.

### Why the record exists before any Open Dental call

`RCM_OD_WRITES.md` §8 names the worst failure window: between the claim PUT to
`"R"` and the `POST /claimpayments`, *"the claim reads Received with money on the
lines and no check exists"*, and recovery *"works, but only if the poster knows
exactly which claimprocs it had touched"*. Open Dental has no transactions (G4),
so that window cannot be closed — only survived. The queue and its lines are
what makes surviving it possible, and they are written first.

---

## 2. The gate

`POST /api/rcm/remittances/:id/approve` takes an office and a batch id **and
nothing else**. The body is empty by design.

### It trusts nothing the client sent

Every condition is re-read from the database inside the transaction and
re-checked there, whatever the workbench displayed a moment earlier. A screen can
be stale; the claim it showed as confirmed may have been force-re-matched by
somebody else since.

**There is no force flag, no override, no query parameter and no admin bypass.**
The only way a withheld claim becomes postable is for a human to fix the thing
that withheld it. `approvalGate.test.js` walks the obvious attempts —
`{force:true}`, `{override:true}`, `{claimIds:[…], skipChecks:true}`,
`?force=true&override=1` — and asserts all four are refused.

### The eleven conditions

Evaluated in this order, which is the order a biller reads them: identity first,
then the human decisions, then facts about the file, then the arithmetic.

| Check | Fails when |
| --- | --- |
| `OFFICE_CONSISTENT` | The claim is stamped with a different practice than its remittance |
| `MATCH_CONFIRMED` | `od_match_status` is not `confirmed`, or `od_claim_num` is null |
| `SNAPSHOT_CURRENT` | No snapshot, wrong version, another office's, no confirmation, or the confirmation names a different ClaimNum |
| `REVIEWED` | Nobody has dispositioned the claim |
| `NOT_REVERSAL` | The claim carries `reversal_not_postable` |
| `NOT_RECOUPMENT` | The claim's paid total, or what the batch says it moved, is negative |
| `NOT_PATIENT_RESPONSIBILITY_ONLY` | The carrier paid nothing **and** the patient owes something |
| `NO_BLOCKING_REASON` | A blocking member of any vocabulary is present (see §3) |
| `NO_BLOCKING_PREFLIGHT` | The confirmed candidate's snapshot carries a blocking `OD_BLOCKERS` fact |
| `LINES_PAIRED` | Any procedure line has no `od_claim_proc_num` |
| `CLAIM_TOTALS_AGREE` | The claim total, the sum of its lines, and what the batch says it moved do not all agree |

Two of these deserve their own note:

**`NOT_PATIENT_RESPONSIBILITY_ONLY` is "paid nothing AND patient owes", not
"paid nothing".** A genuine zero — a full contractual write-off, an
applied-to-deductible with no balance — is a legitimate $0 adjudication Open
Dental takes happily, and refusing every zero would strand every claim a payer
zeroed out. There is no review reason for this; it is computed from the stored
totals, because inventing a vocabulary member would put a computed judgement
into a column whose contract is "a fact the parser or the reader established".

**`LINES_PAIRED` demands EVERY line, not just the ones carrying money.** 6c PUTs
against a ClaimProcNum; a line without one is a payment we cannot say where to
put. Posting the paired lines and leaving the rest would put the chart into
exactly the half-written state §8 exists to make recoverable, with nothing
recording which half. Refusing the whole claim keeps the unit of posting the same
as the unit the carrier adjudicated. **This is deliberately strict and could be
relaxed with a ruling.**

### The batch's own arithmetic holds the WHOLE approve

`check total − PLB = Σ every claim payment on the batch`, withheld claims
included. A remittance whose money does not add up is not a remittance some of
whose claims are fine — the missing cents could belong to any of them. So an
unbalanced batch is `REMITTANCE_UNBALANCED` 409 and nothing is queued.

Per approved claim, separately: `Σ intended line amounts = the claim's paid total
= what the batch says the claim moved`. A disagreement is a **refusal**, not a
warning.

### Partial success is real success

The unit of approval is the remittance; the unit of refusal is the claim. A check
carrying nine clean claims and one reversal enqueues nine and says so, naming the
tenth and why:

```json
{
  "queued":       [{ "claimId": "…", "odClaimNum": 9800000001, "lines": 2, "totalCents": 11200 }],
  "withheld":     [{ "claimId": "…", "reasons": ["NOT_RECOUPMENT"], "checks": [ … ] }],
  "alreadyQueued": [],
  "note": "Queued for posting — nothing has been written to Open Dental yet."
}
```

**An empty postable set is a refusal, not an empty success.** A 200 saying
"approved 0 claims" reads as *done* on a busy screen, so it is a 409
`NOTHING_APPROVABLE` carrying the per-claim reasons.

### Re-approve is allowed and idempotent

A second press enqueues only the claims that were withheld before and now pass.
Already-queued claims come back under `alreadyQueued`; positions on the plan
continue rather than restart, so 6c's replay order stays deterministic across
both approvals. Nothing is ever created twice.

### Refusals, in evaluation order

| Code | HTTP | Meaning |
| --- | --- | --- |
| `INVALID_OFFICE` | 400 | No `?office=`, or not `roland`/`valley` |
| `REMITTANCE_NOT_FOUND` | 404 | No such batch **for this office** — also what a malformed id gets |
| `FORBIDDEN` / `APPROVE_REQUIRES_WRITE` | 403 | The caller does not hold `rcm.write` (see §5) |
| `REMITTANCE_UNBALANCED` | 409 | The check's own arithmetic does not reconcile |
| `NOTHING_APPROVABLE` | 409 | Nothing on this remittance can be posted yet; `claims` carries why |
| `CLAIM_ALREADY_QUEUED` | 409 | Somebody approved a claim between the locked read and the write |
| `QUEUE_ALREADY_RUNNING` | 409 | A plan for this remittance is past `approved` — cannot fire until 6c |

---

## 3. D-11 — blocking reasons versus annotating ones

`docs/RCM_ERA_FIDELITY.md` proposed the split; this slice **ratifies it as data**.

The principle: **a reason BLOCKS when acting on the proposal could move the wrong
amount of money, or money that should not move at all. It ANNOTATES when it tells
a biller something true that does not change what to post.**

It lives in `rcmVocabulary.js` as `REASON_GATE`, one flat map over three
vocabularies (claim review reasons, remittance flags, line flags), with exactly
**two consumers**: the approval gate, and the workbench's chip colour. A screen
showing a reason in amber while the gate lets it through — or the reverse — is
the honest-states rule failing in the most expensive place there is, so
`rcm-labels.test.ts` reads the backend source and fails if the client's mirror
disagrees about a single slug.

**A reason absent from the map is BLOCKING** (fail closed), and
`rcmVocabulary.test.js` asserts every member of all three vocabularies appears in
it, so that default is a backstop rather than a routine path.
`uncertain_line:<N>` is handled explicitly — a line the model was unsure about is
money read with low confidence.

### Blocking (24)

| Reason | Why it blocks |
| --- | --- |
| `reversal_not_postable` | A takeback. The negative-supplemental path is irreversible in Open Dental (G10) |
| `secondary_payer_adjudication` | COB: what the other payer already did changes what we should post |
| `prior_payer_payment_on_primary_claim` | The file contradicts itself about who paid first |
| `unparseable_cas` | Money in a CAS we could not account for |
| `no_service_lines` | Nothing to post, and the file says there should be |
| `line_total_mismatch` | Our lines do not reach the payer's own claim total |
| `unstorable_adjustment_group` | An adjustment could not be stored at all |
| `patient_resp_mismatch` | Two stored numbers disagree about what the patient owes |
| `unreadable_amount` | A number we could not read; whatever it belonged to is wrong |
| `partial_adjustment_segment` | Part of a segment lost — some money is unrepresented |
| `claim_line_allowed_mismatch` | Two numbers disagree about the allowed total |
| `totals_unreconciled` | The sums are not trustworthy, by construction |
| `low_confidence` | The reader was unsure about the whole document; every amount is suspect |
| `uncertain_line:<N>` | One printed line read with low confidence — that line's money is suspect |
| `no_procedures_extracted` | Nothing to post, and the document says there should be |
| `paid_total_mismatch` | The procedure payments do not sum to the claim total |
| `billed_total_mismatch` | The charges do not sum — and billed is what 6c re-verifies against |
| `negative_amount` | "Most often a misread column" — and a real one is the 6d recoupment path |
| `no_claims_extracted` | Nothing to propose, and the document says there should be |
| `batch_paid_total_mismatch` | The claim payments do not sum to the check total |
| `negative_total_payment` | The whole remittance is a takeback |
| `no_claims_in_remittance` | No CLP at all, and the file says there should be |
| `claim_total_mismatch` | Claim payments do not reach the check total |
| `envelope_counts_mismatch`, `envelope_incomplete` | The file may be TRUNCATED — claims may be missing entirely |

### Annotating (25)

| Reason | Why it does not block |
| --- | --- |
| `claim_denied` | A denial is a correct, complete adjudication with nothing to post |
| `procedure_downcoded` | The payer changed a code and we recorded both. The money is not uncertain |
| `claim_level_adjustments_present` | WHERE a deductible was reported is a display fact; the amount is correct |
| **`allowed_amount_mismatch`** | **D-11's one contested call.** Since A3 we always post the DERIVED write-off; the reported `AMT*B6` is evidence and is never the figure written to Open Dental. A disagreement says the payer's file is internally inconsistent, not that our number is wrong — and `line_total_mismatch` independently catches the case where our arithmetic actually is. It fires on 7 of the 13 original fixtures, so this single verdict is most of what the split buys |
| `missing_npi`, `missing_dob`, `missing_check_number`, `missing_subscriber_id`, `missing_payer`, `missing_claim_number`, `missing_patient_name` | Identity, not money — and the gate demands a human-confirmed match anyway |
| `invalid_service_date`, `service_date_in_future` | A date, not an amount. `DateCP` is not writable regardless (G2) |
| `plb_adjustments_present` | Provider-level money is acted on by nobody here. It does not make the CLAIMS wrong |
| `no_payment_made` | `BPR04 = NON` is a legitimate zero-dollar remittance. The claims are still correct |
| `multi_transaction_file` | Each ST/SE became its own batch with its own key; nothing about any one is uncertain |
| `downcode`, `bundled`, `denied`, `partial_pay`, `unexplained_adj`, `frequency_limit`, `not_covered`, `pre_auth_required`, `allowed_mismatch` | Line flags. Most restate a claim reason one level down; `allowed_mismatch` is A3's line-level twin and is ruled the same way |

### What the split does NOT change

`eraIngest.batchStatusFor` still holds a batch `open` when **anything at all** is
flagged. `open` means "something on this file was flagged" — a different question
from "may this claim be posted", and changing what `ready` promises is a separate
decision. The fidelity doc's implementation note proposed changing it; that half
is **not** adopted here.

---

## 4. Idempotency, enforced by the database

Two constraints, at two levels. Both were rehearsed on PostgreSQL 17 and are
proven to refuse (§8).

**Claim level — `rcm_claims.posting_queue_id`.** A single-valued FK column: a
claim can be linked to at most one plan because a column holds one value. The
enqueue does its check and its write in ONE statement (`… WHERE posting_queue_id
IS NULL`), so a racing second approve matches no row, writes nothing and finds
out — the same idiom `confirmMatch` uses. A CHECK pairs it with `approved_at` and
`approved_by` (all three or none) and another asserts a queued claim is a
confirmed one.

**Money level — a partial unique index** on `rcm_posting_queue_line (office_id,
od_claim_proc_num) WHERE is_supplemental = false`. The same Open Dental claimproc
can never be planned for an ordinary adjudication twice, in any office, by any
path — including one added next year that forgets to look at the column above.

The predicate is load-bearing: a **recoupment** goes through `POST
/claimprocs/Supplemental` against a claimproc that has already been paid, so a
legitimate 6d supplemental would collide under a total unique index. Recoupments
cannot pass the 6b gate at all, so the exemption opens nothing today; it is there
so 6d does not have to drop and rebuild the constraint protecting everything else.

Office is in both keys, because ClaimProcNum numbering restarts in every Open
Dental database — the same reason PatNum 7115 is two different people.

---

## 5. Permission (D-9)

| Tier | Checklist (`GET …/approval`) | Approve (`POST …/approve`) |
| --- | --- | --- |
| `admin`, `office` | ✅ | ✅ |
| `reviewer` | ✅ | ❌ 403 |
| anything else | ❌ | ❌ |

The checklist runs on `rcm.read`, which `reviewer` holds. Seeing why a claim is
withheld is not a posting act, and the person who did the reviewing is the one
best placed to fix what she is looking at. The response says so in a field rather
than leaving the screen to infer it from a role name: `canApprove` is the
server's answer and `approveRequires` names the permission a colleague needs.

`POST …/approve` is deliberately **not** in `routes/rcm/index.js` `QUEUE_PATHS`,
so the mount's `requireReadWrite('rcm.read','rcm.write')` demands `rcm.write` for
it by construction. A `reviewer` therefore never reaches the handler at all, and
receives the platform's `FORBIDDEN` 403 carrying `action: 'rcm.write'`. The
in-handler `holdsPermission` check behind it (`APPROVE_REQUIRES_WRITE`) is
defence in depth for a future remount, not the primary gate — see §10 for the one
consequence of that choice.

---

## 6. The screens

### The checklist comes before the button

![the approval checklist](screenshots/rcm-approve/approve-01-checklist.png)

Every condition, per claim, with pass/fail and the server's own copy about what
to DO — rendered as soon as the remittance opens, without anything being pressed.
A biller should be able to see that a claim will be withheld and go fix it
(confirm the match, review it, route the reversal to the SOP) rather than pressing
a button to find out. **Pressing a button to discover a refusal is how people
learn to press buttons hopefully.**

The checklist and the button run the same server-side evaluation, so the screen
cannot predict an outcome the button then contradicts.

### An honest refusal

![nothing on this remittance is postable](screenshots/rcm-approve/approve-02-refused.png)

Nothing queued, one audit row, and the reasons per claim. The data stays on
screen: a refusal here is the gate working, and the checklist is precisely what
explains it.

### A partial approve

![what was queued and what was not](screenshots/rcm-approve/approve-03-partial.png)

What was queued, with the Open Dental claim each will touch. What was withheld,
with every failing condition. The approver and the time. And the honest state, in
the server's words.

### The reviewer's view

![the same checklist, a disabled button](screenshots/rcm-approve/approve-04-reviewer.png)

Identical checklist. Disabled button, naming the permission an approver holds.
The tier decides the button, never the truth.

### Confirm above a red blocker — the ruling

**Confirm stays enabled.** Linking a proposal to a chart claim is not posting, and
a biller who can see the right claim should be able to say so. What 6b adds is
that the consequence is now **predicted where the confirmation happens** — the
claim card says this confirmation cannot be approved and why, and the checklist
says which condition. Before, the only place the consequence appeared was at the
gate, after the linkage was already committed.

---

## 7. Obligations after D-12

`attentionFor` gains three entries. The division is the one D-12 settled: an
OBLIGATION is an action a human still owes; an OBSERVATION is a fact.

| | Reason | When |
| --- | --- | --- |
| Obligation | `claims_unreviewed` | A claim has not been marked reviewed |
| Obligation | `batch_no_claims` | The remittance has no claims at all |
| Obligation | `claims_awaiting_approval` | Every claim reviewed, and at least one is confirmed, unqueued and carries nothing blocking — **an approver owes an action** |
| Obligation | `claims_withheld` | An approve has run on this remittance and left a claim out — **somebody owes a fix or a manual disposition** |
| Observation | `claims_queued` | A claim is on a posting plan — the SYSTEM owes the next step and no human does |

Two properties worth stating:

- **`claims_withheld` can only fire after an approval exists.** Before that there
  is nothing to be withheld *from*: an unapprovable claim that a biller reviewed
  with "the carrier owes a corrected EOB" is finished work, and calling it an
  obligation is exactly the false alarm the 6a predicate was rewritten to stop
  raising.
- **A fully-queued remittance leaves the default view; a partially-withheld one
  does not.** Both are pinned by tests.

The list decides between the two obligations with `approvalGate.looksApprovable`
— the cheap, *necessary but not sufficient* subset of the gate, answerable from
columns the claim list already selects. The full gate reads every claim's match
snapshot (the whole candidate payload, Open Dental patient names included) and
every line; doing that once per row on the cheapest screen to colour a chip is
not a trade worth making. Being wrong between the two mislabels **which** human
owes the action, never **whether** one does — and one click resolves it. Nothing
is ever enqueued on the strength of it.

---

## 8. Migration rehearsal (PostgreSQL 17)

`up` → objects present → `down 1` → `up` again → `down` all the way, all clean on
a throwaway `postgres:17` container. The constraint proofs:

```
=== a SECOND enqueue of the same claimproc must be REFUSED ===
ERROR:  duplicate key value violates unique constraint "rcm_posting_queue_line_claimproc_unique"
DETAIL:  Key (office_id, od_claim_proc_num)=(roland, 99001) already exists.

=== the same claimproc as a SUPPLEMENTAL is still allowed (6d's path) ===
INSERT 0 1

=== the OTHER office may plan its own claimproc 99001 ===
 office_id | position | od_claim_proc_num | is_supplemental
-----------+----------+-------------------+-----------------
 roland    |        1 |             99001 | f
 roland    |        3 |             99001 | t
 valley    |        1 |             99001 | f

=== a half-recorded approval must be REFUSED ===
ERROR:  new row for relation "rcm_claims" violates check constraint "rcm_claims_approval_check"

=== an approved claim that is NOT confirmed must be REFUSED ===
ERROR:  new row for relation "rcm_claims" violates check constraint "rcm_claims_approved_is_confirmed_check"

=== a fully-recorded approval on a CONFIRMED claim is accepted ===
INSERT 0 1
```

---

## 9. Debts this slice paid

Each was logged in the #88 or #89 review and is fixed here.

| | What changed |
| --- | --- |
| **Batch-level flags render** | `BATCH_COLUMNS` selects `flags`; the detail shows them as chips coloured by the D-11 split. A whole-check takeback used to surface only as "Held — something on this remittance was flagged". (The EOB path already wrote the column — Slice 5.5 fixed that half.) |
| **The 5.5 vocabulary is labelled once** | `format.ts` kept a SECOND reason map that went stale the moment 5.5 landed: it carried `low_confidence_extraction` and `uncertain_line`, neither of which the backend has ever emitted, while the thirteen real EOB reasons rendered as raw slugs. The workbench now reads `labels.ts` — the map `rcm-labels.test.ts` already checks against the backend source. Line flags moved with it. |
| **PLB detail** | Each provider-level adjustment listed with its code, amount, published description and reference. Descriptions come from the row (the parser already holds the published PLB03-1 list) — a code with no published wording renders BARE rather than glossed with a guess. The "manual SOP" prose is now a real anchor to `/rcm/sop/takeback`, a page that says what CareIN already did, what a person does next, and admits the practice's own written procedure does not exist yet. |
| **Server-side needs-attention + paging** | `GET /remittances` takes `view=attention\|all`, computes the predicate over the WHOLE office, and returns `total`, `needsAttentionCount` and `matchingCount` over the same population. "12 needing attention · 640 total" is now one statement about one set. The client stopped filtering a 100-row page and got a real pager. The API's default view is `all` — a list endpoint that silently hides most of the list is a trap for the next caller; the screen asks for the view it wants. |
| **Non-uuid `:id` → 404** | `helpers.isUuid` guards the three `/:id` routes. Postgres refuses a non-uuid literal in a uuid comparison, so a malformed id used to 500 — and the shape of the error told a prober which ids were real. `FakeRcmDb` fixtures now use real uuids, so the tests exercise it. |
| **The seeder could not run** | `scripts/rcm-seed-fixtures.cjs` set `od_claim_num` and left `od_match_status` at its `not_run` default, which Slice 6a's CHECK forbids in both directions — every `--execute` against a migrated database would have failed. Fixed, with the whole confirmation and a review stamp rather than just the status, and a test that pins it. |

---

## 10. Known limits — logged here, not fixed

| | Limit | Why it waits |
| --- | --- | --- |
| **A `reviewer`'s 403 is the platform's, not the gate's** | The slice brief asked for a named message and an `UNAUTHORIZED` audit row on the approve refusal. `POST …/approve` is deliberately not exempt from the mount's write gate, so the middleware refuses first with `FORBIDDEN` + `action: 'rcm.write'` and writes no audit row; the named `APPROVE_REQUIRES_WRITE` check behind it is unreachable in practice. Widening the mount to get a prettier refusal would trade a structural guarantee for a message. **The user-visible half is discharged**: the checklist (which a reviewer CAN read) says who can press it, and the client renders the named sentence on either code. **PM ruling wanted** if the audit row matters. |
| **`LINES_PAIRED` demands every line** | Including zero-dollar ones. Strict on purpose (§2); relaxing it is a ruling, not a refactor. |
| **The remittance key for an EOB-derived batch is DERIVED, not reserved** | Only the ERA path writes `rcm_remittance_keys`. The gate prefers that row and falls back to `buildBatchRemittanceKey` over the batch's own identity components — the same builder, so both doors produce one key for one physical check. No reservation row is written: reserving is the posting protocol's act and belongs to 6c. |
| **The list's attention scan reads every claim for the office** | Six narrow columns, no PHI, one extra query per page load. Correct and cheap at real sizes; the shape to fix at scale is a materialised predicate, not a smaller scan. |
| **`GET /remittances/:id` is still unbounded and N+1** | Unchanged from 6a. Real carrier checks in this practice are single digits. |
| **`rcm_user_map.platform_email` still has no unique constraint** | Unchanged from 6a. A migration plus a de-dupe pass. |
| **The batch match is still a held HTTP request** | The polled job it wants needs run state — a table this slice deliberately did not add. The posting queue is not that table: it records intent to post, not the progress of a match. |

---

## 11. Staging validation

The **negative walk**, which is the acceptance for staging:

1. Sign in as an `admin` or `office` user and open **/rcm → Remittances**.
2. Open the Delta batch (both claims `no_candidate`, both reviewed).
3. The approval checklist shows **both claims withheld**, each failing
   `MATCH_CONFIRMED` — "match is no_candidate" — with the fix under it.
4. Press **Approve**. Expect an honest refusal listing both claims and their
   reasons.
5. Confirm nothing was queued and exactly one audit row was written:

```sql
SELECT count(*) FROM rcm_posting_queue;            -- 0
SELECT count(*) FROM rcm_posting_queue_line;       -- 0
SELECT posting_queue_id FROM rcm_claims WHERE office_id = 'roland';   -- all NULL

SELECT action, resource_type, resource_id, result, office, user_id, ts
  FROM audit_log
 WHERE resource_type = 'rcm_posting_approval'
 ORDER BY ts DESC LIMIT 5;                          -- one CREATE / ERROR row
```

6. Back on the list, the remittance shows **`claims_withheld`** as an obligation.

The **positive path** (confirmed + reviewed → queued) is proven by the route
tests and by the seeded screenshot until 6c's gated end-to-end run on the
designated test patients.

---

## 12. Out of scope

**The drain, and any Open Dental write** (6c) · **the recoupment typed
confirmation and the document attach** (6d) · **the persisted batch-match job**
(Slice 7 — it needs run state, a table this slice does not add; the posting queue
is not it) · **OCR** (its own PR) · reconciliation, VCC, Stedi · entitlement
changes · prod.

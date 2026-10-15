# Report: queue item 50b, Checkout C2b (`feature/checkout-c2b-case-treatment`)

**LANE: RED. NEEDS REVIEW. Beau merges.** The merge is held regardless of lane because the
spec was reconstructed (see Provenance). There is no migration and no new vocabulary value.

**Migration timestamps:** none. The case already has a treatment plan
(`tc_case_phases` / `tc_case_items`, migration `1785373200000`), and this slice writes into it.

**Queue files:** item 50b and the rest of the 49–55 run live untracked in the PROD folder at
`C:\Users\beau\carein cursor dashboard\pm-prompts\queue\`, not in the repo.

## Provenance (read first)
The PM update ordering C2b ("treatment persists on the case", after Beau's staging walk) was
not on disk. I searched the queue folder, `pm-prompts/`, `Claude outputs/` and recent session
transcripts. The queue item was therefore RECONSTRUCTED from that one line plus a read of the
merged C2 code. **If the walk finding was something else, say so and this gets rewritten.**

## The gap (measured on develop @ 71e3412)
`POST /api/tc/checkout/:id/outcome`:
- **New case:** the staged procedures lived only as a text block inside `tc_cases.notes`. The
  case's **Treatment** tab, which the coordinator presents from, was empty.
- **Attach to an existing open case:** the treatment was not written to the case at all,
  only the outcome event. The procedures existed only on the handoff row.

## What shipped
- **Scheduled and Not scheduled now put the staged treatment on the case's plan.** This covers
  both a newly created case and an attach to an existing one, in the same transaction as the
  outcome. Each checkout adds ONE phase, "Hygiene visit <date>", appended after whatever the
  plan already has. Each staged procedure becomes one item:
  - tooth: teeth + surfaces, or "Whole mouth"
  - procedure: the code
  - urgency: the case's existing priority → urgency map (urgent→high, preventative→medium,
    cosmetic→low)
  - fees: $0, because they are not known at checkout
- **Patient-safe by construction.** The presentation slides show a phase's description, an
  item's `patientDescription` (in place of its name) and its `timeEstimate`
  (`present/slides.tsx`), so all three stay blank. The hygienist's notes, the schedule-next
  flags and "fees are not known at checkout: set them before presenting" go in a
  **staff-only timeline event** on the case. *This deviates from the first draft of the queue
  item (which put the note in the item description); the reviewer agreed it is correct.*
- **When nothing goes on the plan:**
  - Nothing needed → no phase.
  - Nothing staged → no phase.
  - A plan already at the contract's 20-phase cap → no phase. The event says so and lists the
    items, so nothing is silently dropped.
- **Concurrency:**
  - The attach path row-locks the case before reading positions. Two answers at once now give
    200 + 409, not 200 + 500.
  - If a plan rewrite (Edit plan / Pull from Open Dental) collides with the answer on the
    `(case_id, position)` unique index, the result is an honest 409 `CHECKOUT_PLAN_CHANGED`
    with everything rolled back.
- **The Financing tab no longer zeroes out on $0 items.** It now falls back to the case value
  whenever the itemized patient portion is 0, the same rule the presentation slides already
  use. *This touches `FinancingTab.tsx`, outside checkout. The reviewer found it as a broken
  consumer.*
- The create path's notes text is byte-identical to item 50's.

Zero Open Dental anywhere: everything comes from the handoff snapshot. The office comes from
`req.tcOffice`, the PatNum from the handoff row, and every query is keyed by (office_id, case_id).

## Acceptance
| # | Row | Status | Evidence |
|---|---|---|---|
| 1 | New case carries every staged item | PASS | `tcCheckoutPage.test.js` C2b-1, both outcomes, read back through `GET /api/tc/cases/:id` |
| 2 | Attach appends a phase; existing plan untouched | PASS | C2b-2: positions 0, 3 → new at 4; the existing item keeps its $4,500 |
| 3 | Nothing needed / nothing staged / lost race → no phase | PASS | C2b-3 tests, the lock-ordering test and the 23505 → 409 test. The fake DB cannot roll back; the reviewer proved rollback in real Postgres (3 concurrent answers → 1 case, 1 phase) |
| 4 | 20-phase plan → no phase, event lists items | PASS | C2b-4; the case still loads |
| 5 | Treatment tab renders it | PASS | `tests/tc-checkout-case-treatment.test.tsx` + `docs/screenshots/tc/tccheckout-06-case-treatment-1280x900-{light,dark}.png` |
| 6 | Office-scoped | PASS | C2b-6: valley's case under the same PatNum is untouched, and is 404 from roland |

## Judgment calls for Beau
1. **The reconstruction itself** (Provenance above).
2. **An unpriced phase can reach a patient.** If a coordinator presents before pricing it,
   the slides show $0 lines titled "Hygiene visit <date>" with raw codes (e.g. "SRP"). Only
   the staff timeline line says to set fees first.
3. **Pull from Open Dental and Edit plan replace the whole plan**, so either one replaces the
   checkout phase. The pull dialog already warns when phases exist. This is existing behavior.
4. **No backfill.** Checkouts answered on staging before this merge keep their treatment in
   the notes text only. To see it on the plan, run a fresh test visit.

## Files
| File | Change |
|---|---|
| `backend/routes/tc/checkout.js` | `checkoutPhase`, `treatmentEventText`, `insertPhase`; create + attach paths; case row lock; 23505 → 409 |
| `new-dashboard/client/src/features/tc/caseview/FinancingTab.tsx` | `patientPortionCentsOf` uses the slides' fallback rule |
| `backend/routes/tc/tcCheckoutPage.test.js` | **append-only**: 8 new tests, no existing line edited |
| `new-dashboard/tests/tc-checkout-case-treatment.test.tsx` | **new**: Treatment tab render, Financing fallback, shot dump |
| `docs/screenshots/tc/tccheckout-06-case-treatment-1280x900-{light,dark}.png` | 2 shots |

## Vocabulary sweep
- No status, kind, settings key, prior_state or CHECK value was added. The code uses only
  existing values: `note_added`, urgency `high/medium/low`, priority
  `urgent/preventative/cosmetic`.
- One new **response** code, `CHECKOUT_PLAN_CHANGED` (409). The reviewer grepped for a closed
  client union of checkout error codes (see the Lane section).
- Readers of `tc_case_phases` / `tc_case_items` checked: TreatmentTab, FinancingTab (fixed),
  ValueEngineeringPanel (a "Crown" item shows "Current fee: $0"; cosmetic), outcomeActions,
  OdPullDialog, slides, TcPrepConsult, TcPostConsult, TcPresentation, and `cases.js` PUT
  /phases.

## Gates (branch on develop @ 71e3412, final commit c68f9a8)
```
backend $ node --check server.js  -> OK
backend $ node --test             -> # tests 3620  # pass 3617  # fail 0  # skipped 3
new-dashboard $ pnpm run check    -> exit 0
new-dashboard $ pnpm run test     -> Test Files 156 passed | 34 skipped; Tests 2545 passed | 194 skipped
```
Two earlier full runs each had a known flake: `rcm-shell` "Posting history" nav, then
`rcm-ui-s3` "j and k". Neither file is in this diff. In isolation rcm-shell passed 36/36 three
times and rcm-ui-s3 51/51. The final run above is clean. The reviewer's run hit the Node 22
"Unable to deserialize cloned data" flake twice (`sendToTc`, `onDemandTranscription`), and
both passed in isolation.

## Lane
**RED. Both verdicts agree.**

**Orchestrator: RED.**
- `classify-lane.mjs` says RED: a string-literal union (urgency), office/PatNum derivation,
  and machine slugs in the tests.
- By judgment it is RED too: the round-2 fix adds a new response code,
  `CHECKOUT_PLAN_CHANGED`. Separately, the queue item requires holding the merge for Beau
  because the spec was reconstructed.

**Reviewer (fresh agent, `.claude/agents/reviewer.md`).**

**Round 1: FAIL**, three defects, all fixed in c68f9a8:
1. **Attach-path race.** Two answers read the same max(position), and the loser hit the
   `(case_id, position)` unique index as a **500**. This was proven in real Postgres:
   `200/500/500` in 4 of 4 trials. Fixed with a case row lock before the read, plus a 23505
   → 409 `CHECKOUT_PLAN_CHANGED` backstop.
2. **`FinancingTab.tsx`** showed a $0 patient portion once $0 checkout items landed on a
   valued case. Fixed by using the slides' fallback rule.
3. **The lost-race route test was weak.** Lock-ordering and 23505 tests were added. The fake
   DB cannot roll back, so rollback is proven by the reviewer's real-Postgres run instead.

**Round 2: PASS, LANE RED.**
- The real-Postgres rehearsal (postgres:17, freshly migrated tenant DB):
  - attach race: `200 409 409` in 5 of 5 trials, 1 phase each time;
  - create race: `200 409` in 3 of 3 trials;
  - no 500s anywhere.
- The `CHECKOUT_PLAN_CHANGED` consumer grep came back clean. The sidebar shows the server's
  message, and the only closed union of checkout codes, in `shared/hyg/contract.ts`, belongs
  to the hygiene submit path, which never calls `/outcome`.
- Reviewer gates:
  - backend: 3604 of 3609 passed, 3 skipped. 2 Node 22 deserialize flakes, which passed in
    isolation (`platform` 20/20, `sendToTc` 18/18).
  - dashboard: 2545 tests passed, 0 failed.
- One new owner note: a plan whose items legitimately total $0 (fully covered) now shows the
  case value on the Financing tab. That is the slides' existing behavior.

**Final lane: RED.** Push, PR, NEEDS REVIEW, stop. Beau merges.

## Staging test steps (after Beau merges)
1. Turn checkout on for roland (Platform → TC checkout).
2. Run a hygiene visit on test patient 12827. Stage a crown on #3 (urgent) and an SRP (whole
   mouth), then Send.
3. In TC → Checkout, answer it **Not scheduled**.
4. Open the case → **Treatment**. You should see the phase "Hygiene visit <today>" with both
   items at $0, and on the timeline a staff line saying fees are not set.
5. Repeat with a second visit for the same patient. A second phase is appended; the first is
   untouched.

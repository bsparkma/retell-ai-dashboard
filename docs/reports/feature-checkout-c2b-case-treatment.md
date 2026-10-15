# Report: queue item 50b, Checkout C2b (`feature/checkout-c2b-case-treatment`)

**LANE: RED. NEEDS REVIEW. Beau merges.**

**Migration timestamp:** `1791700000000_tc_checkout_attestation.js` (revision). origin/develop's
newest at push is `1791600000000_tc_notification_prefs.js`; open PR #238 still carries
`1791000000000`.

**Queue files:** moved on 2026-10-15, at the PM's instruction, from the PROD folder to the DEV
clone: `C:\Users\beau\carein cursor dashboard-dev\pm-prompts\queue\` (untracked; 35 files,
checksums verified identical before the PROD copy was removed). The loop docs that name the
path are updated in a separate PR, #246 (`.claude/` change, RED).

## Provenance
Round 1 was built from a spec reconstructed out of one line ("treatment persists on the
case"). The PM put this PR on HOLD and restated the intent in full: **the hygienist's
diagnosed treatment must stay visible on the case until a human confirms it was entered into
Open Dental.** Everything from round 1 is kept, and the PM's five additions are built in the
same PR. See "PM revision" below.

## PM revision (the requirement)
1. **The staff-only "Treatment from hygiene" panel** sits on the case detail, in the slot
   item 33 reserved for hygiene treatment.
   - It reads `GET /api/tc/checkout/by-case/:caseId` and renders each linked handoff's stored
     snapshot: every item's tooth, procedure, priority, urgency, schedule-next flag and
     hygienist note, plus the visit's next-visit needs and the front desk note.
   - It reads the HANDOFF, not the plan, so it survives Edit plan and Pull from Open Dental.
   - It is mounted only on the case detail; the presentation never requests it (tested).
   - It renders nothing for a case without a checkout or while checkout is off for the
     office. A load failure says so plainly.
2. **"Entered in Open Dental", one mark per item.**
   - **Routes:** `POST` / `DELETE /api/tc/checkout/:id/items/:index/entered`.
   - **A manual human attestation**, not a sync: zero Open Dental reads or writes.
   - **Stored with the actor and timestamp** in the new `tc_checkout_attestations` table,
     keyed (office, handoff, item index). A composite FK to the handoff means a row cannot
     cross offices, and rows cascade with their handoff.
   - **Reported only after persistence.** The write uses RETURNING, then the mark is read
     back after commit; a failed read-back is a 500 and nothing is shown as marked.
   - **Audit:** one row per mark (`CREATE`, prior state `unattested`), one per re-mark of a
     stale item (`UPDATE`, `stale`) and one per undo (`DELETE`, `attested` or `stale`).
     A repeated mark is a no-op with no row.
   - **Undo is admin-only** (`admin.all`); anyone else gets 403 `UNATTEST_ADMIN_ONLY`.
   - **A revised item makes its mark stale.** Each mark stores the item's fingerprint (code,
     teeth, surfaces). If the hygienist's later Send changes that item, the mark reads as
     not entered and the panel says "Changed since it was marked. Check Open Dental again."
3. **The "Tx not in OD" card badge.** The `GET /cases` list now carries `txNotInOd`, computed
   like item 33's ortho flag from one office-scoped query, and only when checkout is on for
   the office. It is true while any linked item lacks a current mark. It is false once all
   items are marked, when nothing was staged, or when the case has no checkout.
4. **The Present guard.** If the plan still has a "Hygiene visit <date>" phase with a $0
   item, the deck opens on a staff screen instead of the first slide:
   - it reads "This plan has unpriced hygiene-visit items — set fees before presenting";
   - it offers "Back to the case to set fees" or an explicit "Present anyway";
   - the choice holds for that page load only.
5. **The OD-pull warning** names each checkout section: "This will remove the 'Hygiene visit
   <date>' section added at checkout — that treatment remains on the staff panel."

The phase name is built in one shared place (`checkoutPhaseName` / `CHECKOUT_PHASE_NAME_RE` in
`shared/tc/checkout.ts`). The backend writes it and the guard and warning recognise it.

## The gap (measured on develop @ 71e3412)
`POST /api/tc/checkout/:id/outcome`:
- **New case:** the staged procedures lived only as a text block inside `tc_cases.notes`. The
  case's **Treatment** tab, which the coordinator presents from, was empty.
- **Attach to an existing open case:** the treatment was not written to the case at all,
  only the outcome event. The procedures existed only on the handoff row.

## Round 1 (kept)
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
| 1 | A new case carries every staged item on its plan | PASS | `tcCheckoutPage.test.js` C2b-1 (both outcomes, read back through `GET /cases/:id`) |
| 2 | Attach appends a phase; the existing plan is untouched | PASS | C2b-2 (positions 0, 3 → new at 4) |
| 3 | Nothing needed / nothing staged / lost race → no phase | PASS | C2b-3 tests; real-Postgres race rehearsal (reviewer): 200/409/409, 5 of 5 |
| 4 | A 20-phase plan gets no phase; the event lists the items | PASS | C2b-4 |
| 5 | The Treatment tab renders it | PASS | `tc-checkout-case-treatment.test.tsx` + `tccheckout-06` shots |
| 6 | Office-scoped | PASS | C2b-6; composite FK refuses a cross-office row on real Postgres |
| 7 | The staff panel survives plan replacement and never reaches the presentation | PASS | C2b-7 (PUT /phases then panel still lists both items; valley sees nothing; dark when off); `tc-checkout-hygiene-panel.test.tsx`; `tc-present-unpriced-guard.test.tsx` "the deck never asks for the staff-only hygiene panel" |
| 8 | Attest records who and when, audits once, reported only after persistence; undo is admin-only and audited | PASS | C2b-8 tests (idempotent, persisted-only 500, tc user 403, admin undo, stale re-mark, stale undo audited `stale`, refusals); UI tests for mark, refused mark, undo; full real-Postgres walk by the reviewer |
| 9 | The badge shows until all items are entered; never for no treatment | PASS | C2b-9 (both tests); card chip UI tests |
| 10 | The Present guard blocks until confirmed | PASS | `tc-present-unpriced-guard.test.tsx` (4 tests) |
| 11 | The OD-pull warning names the hygiene section | PASS | `tc-checkout-hygiene-panel.test.tsx` row 11 (2 tests) |

## Judgment calls for Beau
1. **"Tx not in OD" lives on the card, and clears only by a person's mark.** Nothing checks
   Open Dental, by design (the PM ruled "not a sync").
2. **A revised item asks again.** If the hygienist's later Send changes an item that was
   already marked, the mark goes stale and the badge comes back. This seemed the honest
   reading of "until a human confirms it was entered".
3. **The Present guard and the OD-pull warning recognise the section by its name**,
   "Hygiene visit YYYY-MM-DD". If a coordinator renames it, both stop recognising it. The
   staff panel and the badge are unaffected, because they read the handoff, not the plan.
4. **Undo is admin-only via `admin.all`.** As everywhere in the platform, the shared
   dashboard bearer also holds it.
5. **Unpriced lines can still be presented**, after the explicit confirmation, as the PM
   specified.
6. **No backfill.** Checkouts answered on staging before this merge are linked to their case
   (`case_id`), so they DO appear on the panel and badge. Their plan, though, has no phase.

## Files
| File | Change |
|---|---|
| `backend/migrations-tenant/1791700000000_tc_checkout_attestation.js` | **new**: `tc_checkout_attestations`; UNIQUE (office_id, handoff_id) + (office_id, case_id) index on `tc_checkout_handoffs`; grants |
| `backend/routes/tc/checkout.js` | round 1 plan phase + lock + 23505→409; panel / mark / undo routes |
| `backend/routes/tc/checkoutStore.js` | `listForCase`, `listForCases`, attestation reads/writes, `panelItems`, `casesWithUnenteredTreatment` |
| `backend/routes/tc/cases.js` | list adds `txNotInOd` (checkout on only) |
| `new-dashboard/shared/tc/checkout.ts` + `backend/tc/contract.gen.cjs` | phase-name helpers, `checkoutItemKey`, panel schemas; bundle regenerated (pinned esbuild, `--alias:zod`) |
| `client/src/features/tc/checkout/HygieneTreatmentPanel.tsx` | **new**: the panel + `TxNotInOdChip` |
| `client/src/features/tc/checkout/checkoutApi.ts` | panel / mark / undo calls |
| `client/src/pages/tc/TcCaseView.tsx` | mounts the panel |
| `client/src/features/tc/cases/CaseCard.tsx`, `features/tc/api.ts` | the chip; the optional `txNotInOd` field |
| `client/src/pages/tc/TcPresentation.tsx` | the Present guard |
| `client/src/features/tc/od/OdPullDialog.tsx` | the named warning |
| `client/src/features/tc/caseview/FinancingTab.tsx` | the $0 fallback (round 1) |
| `backend/routes/tc/tcCheckoutPage.test.js` | **append-only**: 21 new tests, no existing line edited |
| `backend/test/checkoutAttestationMigration.test.js` | **new** (7) |
| `new-dashboard/tests/tc-checkout-case-treatment.test.tsx`, `tc-checkout-hygiene-panel.test.tsx`, `tc-present-unpriced-guard.test.tsx` | **new** |
| `docs/screenshots/tc/tccheckout-06-…`, `tccheckout-07-hygiene-panel-1280x700-{light,dark}.png` | shots |

## Vocabulary sweep
| Value | Readers | Updated? |
|---|---|---|
| Audit prior_state `unattested` / `stale` / `attested` | the `audit_log_prior_state_check` slug grammar | fit; written for real on Postgres by the reviewer |
| Audit resource type `tc_checkout_item_attestation` (resource_id `<uuid>:<index>`) | free text; `resource_id` is a text column | n/a |
| Response codes `CHECKOUT_PLAN_CHANGED`, `CHECKOUT_NOT_ON_CASE`, `ITEM_NOT_FOUND`, `NOT_ATTESTED`, `UNATTEST_ADMIN_ONLY`, `ATTESTATION_NOT_PERSISTED` | the client shows `tcErrorMessage`; the only closed union of checkout codes (`shared/hyg/contract.ts:1325`) is the hygiene submit path, which never calls these routes | none needed |
| `txNotInOd` | written `cases.js`; optional in `api.ts`; read only by `CaseCard` (`=== true`) | yes |
| Phase name "Hygiene visit <date>" | backend writer, Present guard, OD-pull warning, all through the shared helper | yes |
| Readers of `tc_case_phases` / `tc_case_items` | TreatmentTab, FinancingTab (fixed round 1), ValueEngineeringPanel (cosmetic "Current fee: $0"), outcomeActions, OdPullDialog, slides, TcPrepConsult, TcPostConsult, TcPresentation, `cases.js` PUT /phases | checked |

No new status, kind, settings key or CHECK value. **normalizeCall / call store:** untouched. **Open Dental:** none.

## Gates (branch on develop @ 71e3412, final commit 4201782)
```
backend $ node --check server.js  -> OK
backend $ node --test             -> # tests 3638  # pass 3635  # fail 0  # skipped 3
new-dashboard $ pnpm run check    -> exit 0
new-dashboard $ pnpm run test     -> Test Files 158 passed | 34 skipped; Tests 2562 passed | 195 skipped
```
Earlier full runs on this branch hit known flakes, none in a file this branch touches, and each
passed in isolation:
- `routes/platform.test.js` (Node 22 "Unable to deserialize cloned data"): 20/20 alone.
- `rcm-shell` "Posting history" nav under load: 36/36 three times.
- `rcm-ui-s3` "j and k": 51/51.

The final runs above are clean.

## Lane
**RED. Both verdicts agree** (tenant migration, new audit slugs and response codes, a new list
field, the shared contract regenerated; and the PM's HOLD).

The reviewer was a fresh agent following `.claude/agents/reviewer.md`, run in three rounds.

**Round 1: FAIL**, three defects:
- an attach race gave a 500 (proven on real Postgres);
- FinancingTab zeroed out under $0 items;
- the race test was weak.

All three were fixed in c68f9a8.

**Round 2: PASS.** The real-Postgres race rerun gave 200/409/409 in 5 of 5 trials.

**Round 3 (PM revision, 8dcc49c): PASS, no defects.**
- It ran the migration up, down and up again over existing rows on postgres:17.
- The composite FK refuses a cross-office row.
- It drove every mark, re-mark, stale, undo, refusal and badge path end to end on real
  Postgres, and checked audit row counts.

I then took two of its notes in 4201782: an undone stale mark is now audited `stale`, and a
doc comment was moved back to its function.

## Staging test steps (after Beau merges)
1. Turn checkout on for roland (Platform → TC checkout).
2. Run a hygiene visit on test patient 12827. Stage a crown on #3 (urgent) and an SRP (whole
   mouth), then Send.
3. In TC → Checkout, answer it **Not scheduled**.
4. **Board:** the case card shows **Tx not in OD**.
5. **Case → Treatment from hygiene:** both items show, with "0 of 2 entered in Open Dental".
   The Treatment tab has the "Hygiene visit <today>" phase at $0.
6. **Present Case:** the unpriced warning appears. "Back to the case to set fees" returns
   to the case; "Present anyway" opens the deck.
7. **Pull from Open Dental:** the review step names the 'Hygiene visit <today>' section.
   Cancel.
8. **Mark both items entered.** The badge clears on the board. As a non-admin user there is
   no Undo button; as an admin, Undo puts the item back and the badge returns.

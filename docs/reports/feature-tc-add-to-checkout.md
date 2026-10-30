# CO-5a: manual "Add to Checkout"

Branch `feature/tc-add-to-checkout` off `origin/develop` (f7102b1).
Covers Beau's ruling of 2026-10-30.

## What it does

- **Add patient** button on the Checkout page. It is drawn only for `tc.full` (or a super admin), and only once `/auth/me` has answered. The server route sits under `/api/tc/checkout`, which is mounted `tc.full`.
- **The picker is the referrals hub's**, reused unchanged: `OdPatientSearch` over `odAttachSearch`, the read-only, per-office `GET /api/tc/od/patient-search`.
  - With more than one office in scope, the dialog first asks which office's Open Dental to search. Only offices with checkout switched on are offered.
- **Picking a patient** calls `POST /api/tc/checkout/manual?office=…` with the body `{ patNum }` and nothing else. The body schema is strict.
  - The server re-reads that PatNum from **the request's office's** Open Dental through the hub's own check. That check (`manualPatient`) moved, unchanged, from `routes/tc/referrals.js` into `routes/tc/odManualPatient.js`, and the hub and Checkout now share it. It makes one existing GET, `/patients/:n`, and adds no new OD path.
  - The name comes from Open Dental and the day is the office's today. Neither can come from the request.
- **The card it makes:**
  - `source = 'manual'`, status `open` (Waiting);
  - `submitted_by` is the person who added it (this is "created_by");
  - an empty snapshot;
  - one audit row, `CREATE tc_checkout_handoff` with `source_ref checkout_manual_add`, written after the commit;
  - the response is the card read back.
- **The workup then opens on it.** If the patient already had a card, that card opens instead, with the toast "already on today's Checkout. Opening their card."

## Dedupe: one card per patient per day per office, enforced server-side

- **In the transaction:** `pg_advisory_xact_lock(hashtext('tc_checkout_patient_day:<office>:<patnum>:<day>'))`, then a check for any card holding this patient today. A card holds the patient in any status except dismissed or expired, which is CO-1's holding rule. If one is found it is returned (200, `created: false`). Otherwise a new card is inserted (201).
- **The arbiter behind the lock:** a partial unique index, `tc_checkout_handoffs_manual_patient_day_key`, `UNIQUE (office_id, od_patient_id, visit_date) WHERE source = 'manual' AND status NOT IN ('dismissed','expired')`. An insert that loses a race gets a 23505 error. The route catches it outside the rolled-back transaction, re-reads the winner, and opens it.
- **What counts:**
  - An answered card today still holds the patient, so it is opened rather than duplicated.
  - A dismissed card releases the day, so the patient can be added again.
  - An existing hygiene card is opened, not doubled.

## A hygiene handoff that arrives later merges onto the card

Change in `routes/tc/hygiene.js` `submitCheckout`: a source key TC has never seen now goes through one transaction under the **same patient-day lock**. That closes the race between a click and an arriving handoff.
- If a manual card holds this patient, day and office and nothing has merged onto it yet, the handoff merges onto it. The card:
  - takes the visit's snapshot;
  - takes the visit's **source key**, so later revisions from the same visit (including the final Send) find it by key exactly as they would their own card;
  - is stamped `hygiene_merged_at`;
  - keeps its id, status, workup ticks, creator and `source = 'manual'`.
- The merge writes one audit row, `UPDATE`, with `source_ref checkout_manual_merge`.
- Otherwise the handoff is inserted exactly as before, now with `source = 'hygiene'`.
- Not merged: a dismissed manual card, another patient, another day, another office. Each of these makes its own card, as before.
- CO-1's Inbox routing needed no change. A manual card holds the patient, so a same-day hygiene *treatment intake* is not an Inbox item (tested).

## The workup on a card with no hygiene data

`checkoutHasHygieneData(h)` returns `source !== 'manual' || hygieneMergedAt !== null`.

When it is false:
- **Workup view:** one dashed **"No hygiene visit data"** block replaces sections 1–3 and the "Next visit needs" box. Referrals becomes section 1, and the outcome buttons are unchanged.
  - The progress label reads **"0 of 1 section done"**. It comes from the existing `checkoutWorkupProgress`, which already counts only applicable sections.
  - The server refuses ticks on the three hygiene boxes (tested).
- **Header:** there is no "Final notes in" or "Hygiene notes still being finished" badge, and no priority chip.
  - The priority chip was dropped after the first screenshots: its null state reads "Nothing staged", which is a claim about a visit this card never had.
  - Instead there is an **Added by hand** badge and the line "Added by hand at 10:05 AM by tc@carein.ai".
- **Quick-look sheet:** the same treatment.
- **List row:** "Added by hand", with "no hygiene visit data" in place of "nothing staged".
- **Rail:** "· added by hand".
- **After a merge,** every section returns and the card is still marked Added by hand.
- **Judgment call:** a case opened from a manual card with no hygiene data gets `referralSource: 'other'` instead of `'hygiene'`. Hygiene-sourced cards are unchanged.

## Storage

Migration `1793600000000_tc_checkout_manual.js` is additive. It sits above develop's newest, 1793500000000; I re-checked this at push. It adds:
- `source text NULL` with `CHECK (source IS NULL OR source IN ('hygiene','manual'))`;
- `hygiene_merged_at timestamptz NULL`;
- the partial unique index above.

There is no default and no backfill. `NULL` reads as `hygiene` in the store's `toHandoff` and in the contract default, and a test covers it.

The contract (`shared/tc/checkout.ts`) gains:
- `TcCheckoutSource`;
- `source` and `hygieneMergedAt` on `TcCheckoutHandoff`, both defaulted;
- `TcCheckoutManualAddRequest`;
- `emptyCheckoutSnapshot()`;
- `checkoutHasHygieneData()`.

`backend/tc/contract.gen.cjs` was regenerated with the pinned esbuild and `--alias:zod`.

## Tests

`backend/routes/tc/tcCheckoutManualAdd.test.js` (15 tests):

| Area | What it pins |
| --- | --- |
| Create | Manual, Waiting card; name from roland's OD with a GET only; `submitted_by`; empty snapshot; one CREATE audit row; on the Waiting list |
| Dedupe, sequential | A second add opens the first: one row, one audit row |
| **Dedupe, concurrent** | A barrier holds both transactions at the existence check, so both see no card and both insert; the emulated partial unique index refuses the second; both responses name the same card; one row; one audit row |
| Dedupe, other sources | An existing hygiene card is opened; an answered card is opened; a dismissed card releases the day |
| **Merge on a later handoff** | Same id; the visit's data; `source` still manual; `hygieneMergedAt` set; creator and ticks kept; merge audit row; the final revision follows the card by key; progress becomes 3 sections |
| Merge, negatives | Another patient, day or office does not merge; a dismissed manual card does not merge |
| CO-1 routing | A same-day hygiene treatment intake is not an Inbox item |
| **Empty-state workup** | Only referrals counts (0 of 1, then 1 of 1); hygiene boxes refuse; the outcome works; its case has `referral_source` `other` and no phase |
| **Role gate** | A hygienist gets 403, Open Dental is not asked, nothing is stored, no audit |
| **Office isolation** | A valley add reads only valley's OD; roland's OD does not have 7115 (404); roland's list and id lookup never see valley's card; dedupe is per office |
| Strict body | An office, name or day in the body is a 400 before Open Dental |
| Refusals | Checkout off gives 403 with no OD call; an unknown PatNum gives 404 with nothing stored |
| **Audit on create** | Covered in the create and dedupe tests |
| Old records | A row with no `source` reads as hygiene |

`backend/test/checkoutManualMigration.test.js` (6 tests): nullable with no default, the CHECK, the index columns and predicate, the order of `down()`, the numbering, and that every store column exists after replay.

`new-dashboard/tests/tc-checkout-add-patient.test.tsx` (14 tests, plus 3 screenshot dumps):
- the button gate: tc.full, super admin, and nothing before `/auth/me` or without tc.full;
- the hub picker is used (`odAttachSearch`, never `odSearchPatients`) and only the PatNum is sent;
- the new card opens, and an existing card opens with the "already on" toast;
- a refusal stays on the page;
- the office choice, and offices with checkout off are not offered;
- the list row marking;
- the manual workup: no hygiene sections, no fake badges or chips, 0 of 1 then 1 of 1, the outcome buttons;
- the merged card shows every section;
- a hygiene card is unchanged;
- the sheet.

**Mutation checks:**
- Removing the route's 23505 re-read turns the concurrency test red.
- Forcing `hygieneData = true` in the workup turns the empty-state test red.

**Existing tests:** no expectation changed, so no `RULING (CO-5a)` labels were needed. One harness change: `FakeTenantDb` now treats `SELECT pg_advisory_xact_lock(...)` as a no-op, as it already treats `FOR UPDATE`.

**Local results:**
- Backend: `node --check server.js` passes; `node --test` gives 4446 passed and 0 failed.
- Dashboard: `pnpm run check` is clean; `pnpm run test` gives 3050 passed and 0 failed.

## Screenshots (synthetic data: "Plum, Ash", "Kiwi, Sam", roland 12827)

All in `docs/screenshots/tc/co5a/`, light and dark:

| Shot | Shows |
| --- | --- |
| `tccheckout-co5a-01-list-1280x900-*.png` | Add patient button; a manual card (Added by hand, no hygiene visit data, 0 of 1) beside a hygiene card |
| `tccheckout-co5a-02-add-dialog-1280x900-*.png` | The dialog: the hub's patient search with a result |
| `tccheckout-co5a-03-workup-manual-1280x1300-*.png` | The workup: "No hygiene visit data", Referrals as section 1, the outcome buttons |

## Review

I ran one round with a fresh-context reviewer, which found **no blocking issues**. It independently confirmed:
- the lock key types (numbers on both paths);
- that the index predicate matches the store's holding rule;
- that both 23505 handlers sit outside the rolled-back transaction;
- that `insertHandoff`'s only two callers both take the lock;
- that the `manualPatient` move is byte-for-byte behaviour;
- that hygiene-sourced cards behave as before.

| Finding | Outcome |
| --- | --- |
| LOW: `mergeHygieneOntoManual` set `revision = expect + 1` without checking the revision it read | **Fixed**: now a real compare-and-swap (`AND revision = $12`), like `updatePayload` |
| LOW: a hygiene visit arriving after the desk already **answered** the manual card (e.g. Nothing needed) still merges onto it | **Deliberate**: it is CO-1's rule (any status but dismissed/expired holds the patient), which the ruling names. The answered card keeps its outcome and gains the visit's data; no second work item appears. **Beau, flagging in case you'd rather an answered card let the visit open a fresh one.** |
| LOW: `hygiene.js` showed a 5-line CO-2 comment as changed | **Fixed**: my edit had turned that block's LF endings (in a mostly-CRLF file) into CRLF; the bytes are restored |
| INFO: a merged submit answers 200, not 201 | No change: the hygiene client (`tcHandoffClient`) reads `ok`, not 201 |
| INFO: the fake's advisory lock is a no-op, so the lock itself is untested | Acknowledged: the concurrency test proves the index arbiter and the loser's re-read, not the lock. The real-Postgres migration run in CI proves the index exists |

No second round was needed.

## Guardrails

- Open Dental is read-only: one existing GET, through the hub's check. `hygNoOdWrites` and `rcmNoOdWrites` are green.
- The office comes from `requireOffice`, and the PatNum is re-verified against that office's database.
- No `SELECT *`.
- Nothing was deleted; the one moved function keeps its behaviour, and the referrals manual-start tests are unchanged and passing.
- No real names; TypeScript strict; tsc clean.

## CI

PR #297, `build-test` on `refs/pull/297/merge`, run 40995657080 at head 12bd88b:

- **Attempt 1** failed on `tests/rcm-ui-s3.test.tsx` ("walks the check with the brackets and with j and k"). This branch touches no RCM file. The same test also fails on its own locally, 1 run in 3, so it is the known s3 timing flake.
- **Attempt 2** re-ran that job with no code change and **passed**: typecheck, vitest, `node --check`, `node --test`, migrations against an ephemeral Postgres (which creates the new partial unique index for real), and the smoke spine.

No fix pushes. Not merged.

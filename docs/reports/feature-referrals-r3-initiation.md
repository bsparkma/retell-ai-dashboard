# Report: queue item 54, Referrals R3 (`feature/referrals-r3-initiation`)

**LANE: RED. NEEDS REVIEW. Beau merges.** Why RED:
- new machine routes (two producers, plus `?callId=` on the TC list);
- server-side office/PatNum derivation on two new paths;
- new refusal codes added to the closed `HYG_VISIT_ERROR_CODES` list (hygiene contract regenerated).

The queue file allowed GREEN only with no new vocabulary, so RED.

**Migration timestamps:** none. R2's `source_kind` CHECK already carries `hyg_visit` and `call`.

**Queue file:** `C:\Users\beau\carein cursor dashboard-dev\pm-prompts\queue\54-referrals-r3-initiation.md` (DEV
clone). Started automatically on #248's merge.

## What shipped
**NOTHING SENDS. Zero Open Dental** on both paths. No OD client is reachable from either route;
the hygiene test counts the fake OD's calls.

### One producer: `routes/tc/referralCreate.js`
TC, the hygiene visit and the call detail now create referrals through one module:
- `entitlementGate` / `referralsGate`: the practice has TC, and referrals is on for the office.
- `createDraft`, in one transaction: the directory check, the draft, its creating event, and its audit row. A failed audit rolls the create back.
- `startReferral`: create, **and optionally submit, in that same transaction**. After review the submit moved inside the create's transaction (see "Review"), so a failed submit can't leave a draft behind.
- TC's `POST /api/tc/referrals` is refactored onto it. The transition engine gains `moveInTx` (the same five steps, inside a caller's transaction) and takes an explicit `office`.

### (a) The hygiene visit: "Start referral" beside Note & treatment | Ortho screening
- `POST /api/hyg/visit/:aptNum/referral` (hyg.write, by method):
  - office + PatNum come from the **stored visit**, and the name from its stored appointment snapshot;
  - the body is the strict referral input, so it can never name a patient or office;
  - it goes straight to the doctor's sign-off (or approved, when this office does not require sign-off).
- `GET /api/hyg/visit/:aptNum/referrals`: what this visit started.
- `GET /api/hyg/visit/:aptNum/referral-directory`: the office's ACTIVE specialists. A hygienist holds no TC action, so this is the picker's read. It returns non-PHI office configuration.
- Client: `VisitReferral` sits beside the switcher. It has one button, **Send for Dr. sign-off**, and no drafts chairside (the hygienist couldn't finish one). It shows how many referrals this visit has, and the latest status. It renders nothing while referrals is off.

### (b) The call detail: "Start referral" beside Send to TC
`POST /api/unified-calls/:id/referral` (voice.send_to_tc) follows **Send to TC's shape and order**:
1. 404 for no such call;
2. **entitlement first**;
3. a body `office_id` that disagrees → 409 `OFFICE_MISMATCH` (audited as UNAUTHORIZED; it can never redirect);
4. office unknown → 409;
5. referrals off → 403;
6. no matched patient → 409 `NO_MATCHED_PATIENT`;
7. **a match whose `od_patient_office` is not the call's office → 409 `PATIENT_OFFICE_MISMATCH`** (an existing code, used here because PatNums restart per office);
8. no name → 409 `PATIENT_NAME_UNAVAILABLE`.

Then:
- The case link is the call's `tc_case_id`, only if it is a well-formed id of a case in this office.
- **Save draft** creates a draft. **Save & submit** sends `submit: true`, and the server creates and submits in one transaction.
- **NO call-store field.** The referral records its source (`call` + the call id) on its own row. The call detail lists them with `GET /api/tc/referrals?callId=`. `normalizeCall` is untouched; the reviewer confirmed on real Postgres that the call record is byte-identical after a referral.

### The form
`ReferralDialog` is now exported and shared by the case page, the checkout sidebar, the hygiene visit and the call detail. Each surface supplies its own directory read (`loadDirectory`), and the hygiene visit uses `submitOnly`.

## Acceptance
| # | Row | Status | Evidence |
|---|---|---|---|
| 1 | A hygiene-started referral lands pending_signoff, office = the visit's | PASS | `hygReferral.test.js` (8): events null→draft→pending_signoff; audit CREATE + UPDATE(draft); approved when sign-off is not required. The reviewer drove the real hyg route on postgres:17 as carein_app. |
| 2 | Call-started: office from the call; a body office_id can only 409 | PASS | `callReferral.test.js` (10), and real Postgres |
| 3 | A call with no matched patient → honest refusal | PASS | no match / no name / another office's match → 409; zero rows each time |
| 4 | Zero OD calls on both paths | PASS | FakeOd call count unchanged; no OD client is reachable; the real-Postgres drive ran with no OD configured |
| + | No stray draft | PASS | a failed submit rolls the create back too (route test with real rollback semantics); the call's Save & submit is one request |

## Vocabulary sweep
- **Refusal codes the hygiene routes can return** are added to the closed list `HYG_VISIT_ERROR_CODES`: `MODULE_NOT_ENTITLED`, `REFERRALS_DISABLED`, `DIRECTORY_ENTRY_NOT_FOUND`, `DIRECTORY_ENTRY_INACTIVE`. The hygiene contract was regenerated. "No patient" reuses the existing `APPOINTMENT_HAS_NO_PATIENT` rather than inventing a code. No client switch keys on these codes; `VisitReferral` shows the server's message.
- **New voice codes:** `REFERRAL_FAILED` (a 500), and `PATIENT_OFFICE_MISMATCH`, which already exists. Voice error codes have no closed list.
- **`source_kind` values** `hyg_visit` and `call` already exist (R2 CHECK, 1791900000000).
- **Audit:** actions CREATE/READ/UPDATE; result UNAUTHORIZED for the refused office assertion. All are within the existing CHECKs.
- **Call store:** not touched (grep: the route only calls `getCall`).

## Judgment calls for Beau
1. **A call matched to the other office's patient is refused**, rather than starting the referral at the patient's office. The cross-office chart rule lets a call be linked across offices, but a referral is filed under one office's directory and doctor, so it fails closed. Say if it should follow the patient instead.
2. **No per-user office lock in hygiene** (this predates R3). Any hygienist can name either office with `?office=`, as on every hygiene route.
3. **Audit timing** (inherited from R2): `auditTc` writes on its own connection, before COMMIT. A failed
   audit always rolls the change back. But now that create + submit is one transaction, a failed
   SUBMIT leaves the CREATE's audit row standing for a referral that was rolled back. The reviewer
   measured this on real Postgres: referrals and events unchanged, one extra audit row. The trail
   over-records and never under-records, so fail-closed holds. Making it exact means writing the
   audit through the transaction client, a platform change to `audit()` that I'd scope separately.

## Files
| File | Change |
|---|---|
| `backend/routes/tc/referralCreate.js` | **new**: the one producer |
| `backend/routes/tc/referralTransitions.js` | `moveInTx`; an explicit `office` |
| `backend/routes/tc/referrals.js` | onto the producer; `?callId=` |
| `backend/routes/hyg/visit.js` | the three hygiene routes |
| `backend/routes/unifiedCalls.js` | `POST /:id/referral` |
| `new-dashboard/shared/hyg/contract.ts` + `backend/hyg/contract.gen.cjs` | codes added; regenerated (pinned esbuild, `--alias:zod`) |
| `client/src/features/hyg/visit/VisitReferral.tsx`, `features/hyg/api.ts`, `pages/hyg/HygVisit.tsx` | chairside |
| `client/src/pages/calls/CallReferralButton.tsx`, `pages/CallDetail.tsx`, `lib/api.ts` | call detail |
| `client/src/features/tc/referrals/{ReferralsPanel.tsx,referralsApi.ts}` | shared dialog; `callId` filter |
| tests (all **new**) | `routes/hyg/hygReferral.test.js` (8), `routes/callReferral.test.js` (10), `tests/referrals-r3-initiation.test.tsx` (6 + shot) |
| `docs/screenshots/tc/tccheckout-11-chairside-referral-1280x900-{light,dark}.png` | shot |

No existing test's assertions changed.

## Gates
Final commit 0677dbf + docs:
```
backend $ node --check server.js  -> OK
backend $ node --test             -> # tests 3723  # pass 3720  # fail 0  # skipped 3
new-dashboard $ pnpm run check    -> exit 0
new-dashboard $ pnpm run test     -> Test Files 163 passed | 34 skipped; Tests 2605 passed | 199 skipped
```
Earlier runs on this branch hit known flakes only. Each passed in isolation:
- `routes/sendToTc.test.js` and `routes/platform.test.js` (the Node 22 deserialize flake): 18/18 and 20/20;
- `rcm-ui-s3` "k goes the other way" (the reviewer's run).

## Lane / review
**RED. Both verdicts agree.**
- The classifier says RED: office/PatNum derivation, new machine routes, new slugs and codes.
- My judgment agrees: the queue allows GREEN only with no new vocabulary.

The reviewer, a fresh agent following `.claude/agents/reviewer.md`, ran two rounds.

**Round 1: FAIL.** It found five defects:
- the report was missing;
- a failed submit left a chairside draft nobody without tc.full could finish (proven on real Postgres with a temporary CHECK);
- the hygiene codes were missing from `HYG_VISIT_ERROR_CODES`;
- a non-uuid stored case id gave a 500;
- the call route checked OFFICE_MISMATCH before entitlement.

**Round 2: PASS, LANE RED.** All five are fixed. Re-proven on postgres:17: a failed submit leaves 0 new referrals and 0 new events on BOTH paths, and a retry creates exactly one. Its one remaining note is judgment call 3.

## Staging test steps (after Beau merges)
1. **Chairside:** on a roland test visit (12827) with referrals on, press **Start referral** beside the
   switcher. Pick a specialist, enter a reason and teeth, then **Send for Dr. sign-off**. The badge
   reads "1 referral · Pending Dr. sign-off", and the doctor's queue has it.
2. **From a call:** on a call matched to a test patient, **Start referral**, then **Save & submit**. It
   lands pending sign-off, and the call shows it under the button.
3. **Refusal:** on an unmatched call, there is no Start referral button.

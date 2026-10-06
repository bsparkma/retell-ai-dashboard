# Item 33: Ortho screening, the hygienist's green sheet sent to the TC

Branch `feature/hyg-ortho-screening`, cut from `origin/develop` at c423593. Lane: RED (adds a tenant migration and a field on a shared TC contract).
PR: **#223** → develop. **Not merged.**

## What the hygienist and the TC get

- **Hygiene visit.** The work column has a new **Ortho screening** tab. It holds tap-only chip groups, each 44px or taller, with the question written above each group. The labels are the queue table's, unchanged. Two short text boxes, a date and a note are optional. Above the button sits a live **"What the TC will get"** line. **Send to TC** sends right away. After TC answers with a case, the tab shows "Sent to TC at 9:42 AM" and every chip becomes read-only.
- **TC.** The case detail shows an **Ortho screening** section with:
  - the summary line;
  - one label → value row for each answered field (unanswered fields are left out);
  - the hygienist's note.

  On the board and in the hygiene inbox, a `hygiene_review` case that has a screening carries an **Ortho · needs work-up** chip. A case without a screening looks exactly as it did before.

## "What exists": checked on origin/develop before building

| Claim | Verified at |
|---|---|
| `buildIntake` and `submitHygieneIntake` call `POST /api/tc/hygiene-intakes?office=` | `backend/services/hyg/tcHandoffClient.js:114`, `:218`, `:231` |
| The intake route creates the case in one transaction, with status `hygiene_review` and `referralSource: 'hygiene'` | `backend/routes/tc/hygiene.js:158`, `:92`, `:107` |
| TC is office-scoped: `requireOffice` on the router, and every `caseStore` SELECT filters on `office_id` | `backend/routes/tc/hygiene.js:29`, `backend/routes/tc/caseStore.js:215-220` |
| TC's `CaseCategory` already includes `"ortho"` | `new-dashboard/shared/tc/contract.ts:46` |
| The visit page had **no** Note / Treatment / Perio tabs. It is one column (note fields, slip, treatment), Perio is a separate page, and the file header argues against tabs. | `client/src/pages/hyg/HygVisit.tsx` (header, origin/develop) |

Because there were no tabs to sit beside, I added a two-tab switcher, **Note & treatment** and **Ortho screening**. The first tab is the original column, unchanged. The staged-writes tray stays visible beside both tabs, so the header's reason for avoiding tabs (nothing written to a chart is ever composed out of sight) still holds.

## What changed

**One vocabulary, one summary function.** `new-dashboard/shared/hyg/orthoScreening.ts` holds:
- the option lists, stored as `{id, label}`;
- `OrthoScreeningSchema`, with `.default()` on every field;
- the chip rules: `pickOne` (a second tap clears) and `toggleAfterOrtho` ("None" is exclusive);
- `formatOrthoMonths`;
- `orthoScreeningSummary` and `orthoScreeningRows`.

The hygiene screen, the TC case detail and the server's `suspectedTreatment` all use these same functions.

**Storage.**
- `HygSlip.orthoScreening` is `.nullable().default(null)` (`shared/hyg/contract.ts:901`). It lives in the slip jsonb, so it autosaves with the rest of the visit.
- `TcHygieneIntake.orthoScreening` is `.nullable().default(null)` (`shared/tc/contract.ts:372`).

**The send** is `POST /api/hyg/visit/:aptNum/ortho-screening/send` (`backend/routes/hyg/visit.js:1935`).
- **Zero Open Dental calls.** The office and PatNum come from the stored visit. The name, age, phone, chair and provider come from an `appointment_snapshot`. That snapshot is recorded by the GET and open routes, which already read the appointment from OD (`visit.js:316`, `:415`, `:488`).
- **The snapshot adds no OD request.** Age and phone are read from the patient cache using a reader that refuses to fetch. The doctor's label comes from the providers list the same request's day read just cached, again with a refusing transport (`services/hyg/appointmentSnapshot.js`).
- **The request body is ignored.** The schema is `.strip()`, so every key is thrown away unread.
- **The case it opens:** category `ortho`, caseType `Ortho screening`, urgency `elective`.
  - `diagnosingProvider` is the appointment's ProvNum (the doctor), falling back to the provider the appointment displays.
  - `chiefConcern` is the concerns, joined.
  - `suspectedTreatment` is the summary line.
  - `orthoScreening` carries the structured screening.

  This is built in `buildOrthoIntake`, `services/hyg/tcHandoffClient.js:267`.
- **One case per visit:**
  - a conditional claim (`visitStore.js:397`);
  - `markOrthoSent … WHERE ortho_tc_case_id IS NULL` (`:417`);
  - an `alreadySent` short-circuit;
  - after a send, `saveSlip` keeps the stored screening in the same SQL statement (`:315`), so a later autosave cannot change the sheet TC received.
- **Honest states.** The visit's `orthoSend` is written only after TC returns a case id. On any other answer the claim is released, the route returns 502 with the reason in words, and the screening stays saved and editable. The client clears any pending or in-flight autosave before it sends.

**Migrations.** Both are additive and nullable.
- `1790100000000_tc_ortho_screening.js` adds one jsonb column, `ortho_screening`, to `tc_hygiene_intakes`. It also adds an "is an object" CHECK and re-asserts the role-guarded `carein_app` grant.
- `1790200000000_hyg_ortho_send.js` adds `appointment_snapshot`, `ortho_tc_case_id`, `ortho_sent_at`, `ortho_sent_by` and `ortho_send_claimed_at` to `hyg_visit`, with an all-or-nothing CHECK on the sent fields.

I re-checked just before pushing: develop's newest tenant migration is still `1790000000000_rcm_check_archive.js`.

**`normalizeCall` whitelist:** does not apply. Nothing in this slice touches the voice call store.

## Every TcHygieneIntake / intake-row reader

| Reader | Change |
|---|---|
| `new-dashboard/shared/tc/contract.ts:372` | New nullable `orthoScreening` field |
| `new-dashboard/shared/tc/rows.ts:170`, `:328` (`caseToRows`), `:465` (`caseFromRows`) | Row field added and mapped both ways (`?? null`) |
| `new-dashboard/shared/tc/legacy.ts:459` | Explicit `orthoScreening: null` |
| `backend/routes/tc/caseStore.js:147` (`INTAKE_COLS`) | `ortho_screening` added. This list also feeds the `/`, `/mine` and `/inbox` SELECTs in `hygiene.js` |
| `backend/routes/tc/hygiene.js:156` | Stores `input.orthoScreening ?? null` |
| `backend/routes/tc/cases.js:307`, `:319` | Board list gains `hasOrthoScreening`, from one office-scoped query over the page's case ids |
| `backend/routes/tc/intakeFromCall.js:137` | No change. It sets `hygieneIntake: null` |
| `client/src/features/tc/api.ts:205`, `:581`, `:607`, `:644`, `:670`, `:711`, `:770`, `:815` | `TcCaseSummary.hasOrthoScreening`, `TcIntakeSubmit`, `TcMyIntake`, `TcInboxIntake`, the row base, and all three mappers |
| `client/src/pages/tc/TcPipeline.tsx:119`, `client/src/features/tc/nurture/NurtureWorkspace.tsx:141` | No change. `mergeCase` strips `hygieneIntake`, and the row keeps its own `hasOrthoScreening` |
| `client/src/pages/tc/TcCaseView.tsx:162` | Renders `<OrthoScreeningSection>`, which is empty without a screening |
| `client/src/features/tc/cases/CaseCard.tsx:109`, `client/src/pages/tc/TcHygieneInbox.tsx:212` | "Ortho · needs work-up" chip |
| `new-dashboard/server/tc-import/pgTarget.ts:27`, `:94`; `report.ts:60`; `plan.ts` | The import only sees null, because `legacy.ts` sets it. `ortho_screening` was added to `JSONB_COLUMNS` so a non-null value would bind as jsonb |
| `client/src/features/tc/hygiene/IntakeForm.tsx` | No change. TC's own form never sends a screening, so the server stores null |

## Acceptance

| # | Result | Tests |
|---|---|---|
| 1 | Pass | `tests/hyg-ortho-screening.test.ts` (labels pinned to the table, chip rules, schema refuses None + other); `tests/hyg-ortho-screening-ui.test.tsx` (rendered questions and labels in order, 44px, clear on second tap, None exclusive) |
| 2 | Pass | `formatOrthoMonths`: `18 mo`, `18–24 mo`, `6–36 mo` |
| 3 | Pass | `hygOrthoSend.test.js` (save + reload; an older row with no key and no new columns); UI autosave, reload and older-visit tests; contract parse of an old slip and an old payload |
| 4 | Pass | `hygOrthoSend.test.js`: one TC call, `alreadySent` on the second press; the captured body posted to the **real** TC intake produces one `hygiene_review` ortho case in roland |
| 5 | Pass | A forged office, PatNum, name, provider and category are discarded; the UI call carries only `(office, aptNum)` |
| 6 | Pass | TC down and a throwing submitter both return 502 with the claim released, the screening saved and editable, and a later resend working; the UI never shows "Sent" |
| 7 | Pass | The OD fake's call log does not change across two sends; a reload's snapshot makes no `/patients` or `/providers` call |
| 8 | Pass | `tests/tc-ortho-screening.test.tsx` (case with a screening, case without one, case with no intake, board chip rules), plus the screenshots below |
| 9 | Pass | `backend/test/orthoScreeningMigration.test.js` (nullable, additive, ordered, columns exist in the replayed schema); `visitSchema.test.js` uniqueness and order still green |
| 10 | Pass | The reader table above |

## Gates (local)

- **Backend:** `npm ci`; `node --check server.js` passes; `node scripts/shard-runner.mjs` passes 4/4 shards (3012 pass, 0 fail, 3 skipped).
- **Dashboard:** `pnpm install --frozen-lockfile`; `pnpm run check` is clean; `pnpm run test` gives 132 files and 2255 tests passing, 0 failing. Both contract bundles were regenerated with the pinned esbuild, and both drift tests are green.

## Reviewer

A fresh-context reviewer subagent checked the queue file against `git diff origin/develop...HEAD`. **Verdict: PASS, round 1.** It made four non-blocking notes:
1. A JSDoc comment was in the wrong place. **Fixed.**
2. The ortho send is not behind the fixture gate (see below).
3. The lost-answer duplicate case (see below).
4. The importer's `JSONB_COLUMNS` did not list `ortho_screening`. **Fixed.**

## CI

PR #223, `build-test` on `refs/pull/223/merge` (run 37408404485, `pull_request` event, head d6417fe): **success** on the first push. No failures, no flakes, no fix pushes. This report-only commit triggers one more run of the same gate.

## Screenshots

These are synthetic data: the roland fixture PatNum 12827, shown under a synthetic name. All frames are at the iPad's 1180 width.
- Hygiene tab, filled: `docs/screenshots/hyg/hyg-ortho-01-tab-1180x2900-{light,dark}.png`
- Hygiene tab, sent and read-only: `docs/screenshots/hyg/hyg-ortho-02-sent-1180x2900-{light,dark}.png`
- TC case detail: `docs/screenshots/hyg/hyg-ortho-03-tc-case-1180x1200-{light,dark}.png`

To regenerate them, run `pnpm exec vite build && HYG_SHOTS=1 pnpm exec vitest run tests/hyg-ortho-shots.test.tsx && node scripts/shoot-hyg.mjs`.

## Staging test steps (roland 12827 only)

1. Wait for the deploy to staging after merge, so both migrations have run.
2. Open the Roland day view and a hygiene appointment for **PatNum 12827**. Open the visit. Do not use any other patient.
3. Open the **Ortho screening** tab. Tap **Yes**, then two concerns, then months **18** and **24**. Check that the summary reads `… 18–24 mo`. Tap **Yes** again and check that it clears, then tap **Yes** once more. Tap **Implants**, then **None**, and check that Implants clears.
4. Reload the page. Every tap should still be there.
5. Press **Send to TC**. You should see "Sent to TC at <time>", and the chips should become read-only. Press nothing else.
6. In TC (Roland), open the hygiene inbox, then the board. The case should be `Hygiene Review` with category Ortho, urgency Elective, OD #12827 and the "Ortho · needs work-up" chip. Open it: the Ortho screening section should show only the fields you answered, plus your note.
7. Go back to the visit, reload, and confirm there is still exactly one case for 12827 in TC.
8. Confirm in Open Dental that **nothing** changed for 12827 (no commlog, no document). This slice makes no Open Dental call.
9. Clean up: move the test case to Lost, or delete it, by your usual TC test-case routine.

## Deliberately not built, or known limits

- **Queue item 22 was not built.** The ortho section sits in the slot between the command bar and the tabs. That is where 22's hygiene treatment list should render too.
- **A lost TC answer can still cause a duplicate case.** If TC creates the case but its answer is lost on the way back (a timeout after the commit), a resend opens a second case. Closing that needs an idempotency key inside TC's `/hygiene-intakes` (a unique source key). That is a TC-side change this additive slice does not make; the treatment handoff carries the same documented risk.
- **The ortho send is not behind the staging fixture gate** (`refuseUnlessTestPatient`). That gate guards Open Dental writes, and this path writes nothing to Open Dental. The consequence is that staging can open TC cases for any patient. The test steps therefore use 12827 only.
- **Age and phone can be blank.** They come from the patient cache only. If the cache does not have that patient (rare on a visit that was just opened), they go to TC as null rather than costing an Open Dental read.
- **No completeness gate beyond "Interested?"**, as specified.

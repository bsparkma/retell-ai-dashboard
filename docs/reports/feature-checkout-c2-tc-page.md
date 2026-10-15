# Report: queue item 50, Checkout C2 (`feature/checkout-c2-tc-page`)

**LANE: RED. NEEDS REVIEW. Beau merges.** The slice adds:
- a tenant migration
- a new status vocabulary on `tc_checkout_handoffs` (7 values, CHECK inline)
- new audit `prior_state` slugs
- new platform-console routes (super-admin surface)

**Migration timestamp:** `1791500000000_tc_checkout_outcome.js`. At push time, origin/develop's newest is `1791400000000_hyg_checkout_send.js` (item 49). Open PR #238 still carries `1791000000000`.

**Ships dark.** Nothing changes for any office until `platform_setting['tc_checkout_enabled']` names it `true`. That switch now has a toggle in the platform console (Platform → TC checkout).

## Where the queue files live (49–55)

The queue files are **not in the repo**. They are untracked scratch in the PROD folder:

```
C:\Users\beau\carein cursor dashboard\pm-prompts\queue\
  49-checkout-c1-hyg-handoff.md      (C1, merged as #242)
  50-checkout-c2-tc-page.md          (this slice; carries the PM's day-expiry addition)
  51-checkout-c3-notify-prefs.md
  52-referrals-r1-foundations.md
  53-referrals-r2-workflow.md        (updated 2026-10-14 with the PM's `doctor` role ruling)
  54-referrals-r3-initiation.md
  55-referrals-r4-attachments.md
```

`pm-prompts/README.md` says to read them and never `git add` them, and the loop treats that folder as read-only. I wrote 49–55, and edited 50 and 53, because the PM asked me to directly.

## What shipped

### Backend: `/api/tc/checkout` (new mount, `tcFull`)

| Route | What |
| --- | --- |
| `GET /?view=waiting\|done` | Today's handoffs for the office, newest first. Waiting = `open`+`claimed`; Done = `scheduled`, `not_scheduled`, `nothing_needed`, `dismissed`. |
| `GET /summary` | `{enabled, today, waiting, newest}` for the nav badge and the toast. When the office is off it answers `enabled:false` (200). |
| `GET /:id` | One handoff (the sidebar). |
| `POST /:id/claim` | `open → claimed`. A conditional UPDATE; a second claim gets 409. |
| `POST /:id/dismiss` | A reason is required (1–500 chars). The reason stays on the row and is never copied to `audit_log`. |
| `POST /:id/outcome` | `scheduled \| not_scheduled \| nothing_needed`, with `appointmentNote` (≤500, used for Scheduled). |

**What each outcome does to the case.** Everything happens in one transaction, and the handoff UPDATE is conditional on the status the request read. A losing race throws, rolls back any case it wrote, and returns 409.

| Outcome | Patient has an open case | No open case |
| --- | --- | --- |
| **Scheduled** | The case **moves** to `scheduled`. It gets a `status_change` event in the funnel's exact `from → to` format, nurture enrollments stop (`stopForTerminalCase`), and those stops are audited. | A case is **created** at `scheduled`, carrying the snapshot's treatment lines and the appointment note. |
| **Not scheduled** | If the case is still **before** "Pending Patient" (`hygiene_review`, `diagnosed`, `pending_tc`), it **moves forward** to `pending_pt`, with a `status_change` event in the funnel format. This is the common case: the same visit's own `hygiene_review` case. At or past `pending_pt`, it gets a `note_added` event only. **A case is never moved backwards.** | A case is **created** at `pending_pt` ("Pending Patient"). |
| **Nothing needed** | **No case** is created or touched. | **No case.** |

- "Open case" means `findOpenCase` (the same helper the voice and opportunities paths use), keyed by office and the **handoff's** PatNum. The request never supplies a PatNum.
- New cases get `referralSource: 'hygiene'`, `caseType: 'Checkout'`, and urgency from the priority (urgent→high, preventative→medium, cosmetic→low, as in the treatment handoff).

**Day-scoped expiry (PM addition).**
- Every checkout request first runs `expireBefore(office, today)`, where today is the office day in America/Chicago (`OFFICE_TIMEZONE` overrides).
- It closes still-waiting handoffs with `visit_date < today` as `expired`. It runs one conditional UPDATE per prior status, so a row a human answered is never overwritten.
- It writes one audit row per expiry: `UPDATE tc_checkout_handoff`, `prior_state` = `open` or `claimed`, `source_ref` = `checkout_day_expiry`.
- The actor is the **system**, `system:checkout_expiry`, the same convention as nurture's `system:nurture`. It is stamped on the row's `expired_by` (a CHECK pairs it with `expired`) and is the audit row's user. The person whose request happened to run the sweep is never named.
- Nothing is deleted. Expired handoffs show in neither tab and cannot take an outcome (409). The summary sweeps too, so the badge never counts a stale day.

**Migration `1791500000000_tc_checkout_outcome.js`.** Additive columns on `tc_checkout_handoffs`:
- `status` (default `open`), `claimed_by/at`, `dismissed_reason/by/at`, `outcome_by/at`, `appointment_note`, `case_id` (FK `tc_cases` ON DELETE SET NULL), `expired_at`.
- The status CHECK is inline with the 7 values.
- Pairing CHECKs:
  - claimed ⇒ claimer
  - dismissed ⇔ reason
  - outcome ⇔ actor and time
  - nothing_needed ⇒ no case
  - expired ⇔ `expired_at` and `expired_by`
- Scheduled and not_scheduled are always **written** with a case. The CHECK deliberately does not require one: `case_id` is ON DELETE SET NULL, and Postgres re-checks CHECKs on that rewrite, so requiring it would make those cases undeletable. That was review round 1's defect #1.
- New index `(office_id, status, visit_date)`. The columns ride the table's existing carein_app grant.

### Platform console: `GET/PUT /api/platform/tc-checkout-offices[/:office]`
- Mirrors the hygiene switch:
  - It refreshes before answering.
  - `persist` writes, then re-reads from the database.
  - The audit row goes to the acting super_admin's tenant (`platform_setting` / `tc_checkout_enabled` / office / `prior_state` on|off).
- The panel names the layer that answered (Set here / Environment override / Default (off)), says when the env break-glass is forcing an office off, asks before turning ON, and turns OFF instantly.

### Client
- **`/tc/checkout`** (`pages/tc/TcCheckout.tsx`)
  - Waiting / Done today tabs, newest first, Claim and Dismiss (dismiss requires a reason), and Check again.
  - A switched-off office shows "Checkout isn't switched on for this office yet", never an error.
- **`CheckoutSidebar`** is **one component** opened from both places: a row click, and the arrival toast (which navigates to `/tc/checkout?office=&handoff=`, which opens the same sheet).
  - It shows the snapshot treatment, priority, next-visit needs (type, interval, length, doctor, RTC), the front-desk and financial notes, and **notes-pending vs final notes**.
  - The referral row reads **None** (placeholder for R2).
  - It has the three outcome buttons and the appointment note. Its state renders from the server's read-back.
- **Nav:** a "Checkout" item in TC → Casework with a waiting-count badge. It is **drawn only when an office in scope has checkout on.**
- **`useCheckoutWatch`** polls `/summary` with the existing `usePolling` hook (60s, visible tab only), so there is no new realtime infrastructure.
  - Its first answer never toasts a backlog.
  - A new newest handoff toasts "<patient> is headed to checkout" with an Open action.
  - C3 will route this through per-user notification preferences; today it is always a banner.

## Judgment calls Beau should know about

1. **"Not scheduled" → `pending_pt`, not `accepted`.**
   - The board's "unscheduled" bucket is `accepted` (`reports/derive.ts` counts accepted cases as unscheduled), but `accepted` asserts the patient accepted treatment. Leaving checkout without booking does not mean that.
   - Follow-up is not a case status in this codebase.
   - `pending_pt` ("Pending Patient") is the honest column: the TC is waiting on the patient.
   - **If you want `accepted` instead, it is a one-line change** in `routes/tc/checkout.js`.
2. **"Not scheduled" only moves an existing open case forward.**
   - A case before "Pending Patient" (`hygiene_review`, `diagnosed`, `pending_tc`) moves to `pending_pt`, so it lands in a pipeline column. `hygiene_review` has no board column.
   - A case already at `presented` or `considering` is further along; moving it back would erase progress, so it gets a note instead.
3. **An outcome may be recorded from `claimed` by anyone with `tc.full`, not only the claimer.** A claim says who has the patient, not a lock; the front desk covers for each other. The audit row's `prior_state = claimed` records it.
4. **Expiry is lazy (on request), not a timer.** That needs no new job and no `server.js` change. It also cannot miss: no route shows or acts on a handoff before the sweep runs. The actor is the system (`system:checkout_expiry`) on both the row and the audit row.
5. **C1 fix found while testing:** `officeAgents.OFFICES` includes the `unknown` system bucket, so item 49's switch factory would have accepted `unknown` as an office. `config/tcOfficeSwitch.js` now uses `realOffices()` (excludes `unknown`). The console 404s on it, and that is tested.
6. **d1e4a49 (item 49's last report commit) rewrote all 161 lines of the report.** The cause was a `sed -i` that normalized line endings: the file had mixed CRLF/LF, and is now pure LF. The content is identical apart from the one intended number. Harmless; noted for history.

## Files

| File | Change |
| --- | --- |
| `backend/migrations-tenant/1791500000000_tc_checkout_outcome.js` | **new**: status + lifecycle columns, CHECKs inline, index |
| `backend/routes/tc/checkout.js` | **new**: the route family above |
| `backend/routes/tc/checkoutStore.js` | new columns in `COLS`/`toHandoff`; `findById`, `listForDay`, `expireBefore`, `claim`, `dismiss`, `recordOutcome`; inserts `status:'open'` explicitly; exports `STATUSES`, `OUTCOMES`, `WAITING_STATUSES` |
| `backend/routes/tc/index.js` | `router.use('/checkout', tcFull, …)` + header line |
| `backend/routes/tc/helpers.js` | `auditTc` passes `extra.priorState` through (additive; absent ⇒ NULL as before) |
| `backend/routes/platform.js` | `GET/PUT /tc-checkout-offices` + header lines |
| `backend/config/tcOfficeSwitch.js` | `realOffices()`; `unknown` is no longer an office |
| `backend/routes/tc/tcTestUtils.js` | harness only: the fake understands `col < $n` |
| `new-dashboard/shared/tc/checkout.ts` | `TcCheckoutStatus`, labels, `TC_CHECKOUT_WAITING`, `TcCheckoutOutcome`, outcome/dismiss requests, `TcCheckoutSummary`; `TcCheckoutHandoff` gains the lifecycle fields, **defaulted** so item 49's readers still parse |
| `backend/tc/contract.gen.cjs` | regenerated (pinned esbuild, `--alias:zod`) |
| `new-dashboard/client/src/features/tc/checkout/{checkoutApi.ts,CheckoutSidebar.tsx,useCheckoutWatch.ts}` | **new** |
| `new-dashboard/client/src/pages/tc/TcCheckout.tsx` | **new** |
| `new-dashboard/client/src/pages/platform/TcCheckoutPanel.tsx` | **new** |
| `App.tsx`, `DashboardLayout.tsx`, `Platform.tsx`, `lib/api.ts` | route, nav item + badge + watch, console tab, two api calls + types |
| `new-dashboard/scripts/shoot-tc-checkout.mjs` | **new**: the opportunities shooter with a `tccheckout-` prefix |
| tests | backend: `routes/tc/tcCheckoutPage.test.js` (19), `routes/tcCheckoutSwitch.test.js` (4), `test/checkoutOutcomeMigration.test.js` (6). Dashboard: `tc-checkout.test.tsx` (11), `tc-checkout-nav.test.tsx` (4), `platform-tc-checkout.test.tsx` (4), `tc-checkout-shots.test.tsx` (4 dumps, `TC_SHOTS=1`) |
| `docs/screenshots/tc/tccheckout-0{1..4}-*-{light,dark}.png` | 8 shots |

## Acceptance

| # | Row | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Each outcome lands the case in the right column (or none) | **PASS** | `tcCheckoutPage.test.js`: "Scheduled with no open case CREATES a case at scheduled", "Scheduled with an OPEN case MOVES it … `presented → scheduled: Scheduled at checkout`", "Not scheduled … CREATES … pending_pt", "Not scheduled moves an open {hygiene_review, diagnosed, pending_tc} case FORWARD to pending_pt" (3 tests, funnel-format event), "Not scheduled with an OPEN case notes it and does NOT move it backwards" (`considering`), "Nothing needed closes the handoff and creates NO case" (0 new cases, 0 events on the existing case) |
| 2 | Handoff leaves the inbox; claim/dismiss like opportunities | **PASS** | answered rows disappear from `view=waiting` and appear in `view=done`; claim is conditional (second claim 409); dismiss needs a reason (400 on empty or blank) and no prose reaches the audit row; a racing outcome 409s; a second outcome 409s with one case total |
| 3 | Office-scoped | **PASS** | "this office only" (valley row invisible to roland); "another office cannot read or act" (404, no case, row untouched); the expiry sweep touches only the requesting office |
| 4 | Setting OFF → page, badge, routes invisible/refused | **PASS** | every route 403 `CHECKOUT_DISABLED` and `/summary` `enabled:false`; the floor (no row) is OFF; `tc-checkout-nav.test.tsx` "switched off: no Checkout item at all"; the page shows "isn't switched on". Console: `tcCheckoutSwitch.test.js` walks ON→request 200→OFF→**next request 403**, no restart; env `=false` beats a console ON; non-super-admin 403 |
| 5 | Sidebar is one component from the row and the toast | **PASS** | `tc-checkout.test.tsx`: "a row opens the sidebar…" and "the toast's link (?handoff=) opens the SAME sidebar" (same `checkout-sidebar` testid, same component); `useCheckoutWatch` test: the toast's Open navigates to `/tc/checkout?office=roland&handoff=…` |
| + | Day-scoped expiry, never blocks, audited, system actor | **PASS** | "expiry is the SYSTEM's act" (`expired_by` and audit `user_id` = `system:checkout_expiry`, tenant still T1); | "expiry: yesterday's waiting handoffs close as expired, never show, and are audited" (2 rows: `prior_state` open/claimed, `source_ref checkout_day_expiry`; an answered row is untouched; no duplicate audit rows on a second request); "expiry also runs before an action"; "the summary sweeps too" |
| + | Zero OD reads/writes | **PASS** | no OD client in the route's imports; the TC harness has no OD client at all; everything renders `payload` |
| + | Audit on each outcome | **PASS** | `tc_checkout_handoff` UPDATE with `prior_state`, `tc_case` CREATE/UPDATE, nurture stops |

## Vocabulary sweep (whole repo)

| Value | Readers | Updated? |
| --- | --- | --- |
| `tc_checkout_handoffs.status` (7) / `TcCheckoutStatus` | migration CHECK, `checkoutStore.STATUSES`, contract enum + labels, `CheckoutSidebar`, `TcCheckout` rows | all. `checkoutOutcomeMigration.test.js` pins CHECK = store = contract |
| `TcCheckoutOutcome` (3) | route body schema, store `OUTCOMES`, sidebar buttons, api | all, pinned by the same test |
| case statuses used (`scheduled`, `pending_pt`) | existing values only. **No new case status**, so `tc_cases` CHECK, `status.ts`, `funnel.js`, `dashboard/derive.ts`, `reports/derive.ts` and the nurture hooks are untouched. The `status_change` description keeps the funnel's `from → to` prefix (asserted) | n/a |
| audit `prior_state` slugs (`open`, `claimed`, `on`, `off`) | `audit_log_prior_state_check` grammar `^[a-z0-9_]{1,32}(:…)?$` | all conform |
| audit `source_ref` `checkout_day_expiry` | free text (no CHECK) | n/a |
| platform route `/tc-checkout-offices` | `routes/platform.js` header list, `lib/api.ts`, `TcCheckoutPanel` | yes |
| client route `/tc/checkout` | `App.tsx`, nav, `ROUTE_PERMISSIONS` (inherits `/tc` = `tc.full` by longest prefix; no entry needed), `role-nav.test.tsx` (hygiene sees exactly TC Inbox/Intake/Submissions: still green) | yes |
| `/api/tc/checkout` mount | `roleGateWiring.test.js` requires every non-hygiene TC mount to be the bare `tcFull` identifier, and it is | green, unedited |

**normalizeCall / call store:** not touched.

## Gates (merge tree: `origin/develop` @ 8627916 merged, "Already up to date")

```
backend $ node --check server.js      -> OK
backend $ node --test                 -> exit 0   # tests 3587  # pass 3584  # fail 0  # skipped 3
new-dashboard $ pnpm run check         -> exit 0 (tsc --noEmit clean)
new-dashboard $ pnpm run test          -> exit 0   Test Files 153 passed | 33 skipped (186)
                                                   Tests 2529 passed | 192 skipped (2721)
```
No known flake fired on this run. Existing suites relevant to the touched surfaces are green and
unedited: `roleGateWiring`, `moduleGateWiring`, `role-nav`, `tc-texts-nav`, `platform-console`,
`hygPilotSwitch`, `tcCheckoutIntake` (C1), `checkoutHandoffMigration` (C1), `visitSchema`, and
`tc-contract-bundle` (the regenerated bundle byte-matches).
Screenshots: `pnpm exec vite build` -> `TC_SHOTS=1 pnpm exec vitest run tests/tc-checkout-shots.test.tsx`
-> `node scripts/shoot-tc-checkout.mjs` (only the eight new PNGs written).

## Lane

**RED. Both verdicts agree.**

**Orchestrator (me): RED.**
- `classify-lane.mjs` says RED. Its triggers:
  - the tenant migration
  - the new status enum and CHECK on `tc_checkout_handoffs`
  - audit `prior_state` vocabulary
  - new machine routes (`/api/tc/checkout/*`, `/api/platform/tc-checkout-offices`)
  - the shared contract (regenerated bundle)
  - the queue file marks itself RED
- By judgment, the platform console is the super-admin surface, and the switch now writes a settings key.

**Reviewer** (fresh agent, `.claude/agents/reviewer.md`):
- Round 1: **FAIL**, with five findings (see "Review" below).
- Round 2, after `df81a43`: **PASS, LANE RED**.

**Gates after fix round 1** (merge tree, develop up to date):
```
backend $ node --check server.js  -> OK
backend $ node --test             -> # tests 3590  # pass 3586  # fail 1  # skipped 3
  not ok 53 - routes\\platform.test.js  failureType: 'uncaughtException'
  error: 'Unable to deserialize cloned data due to invalid or unsupported version.'
  -> known Node 22 file-level flake, no assertion; isolated: node --test routes/platform.test.js -> # pass 20 # fail 0
new-dashboard $ pnpm run check    -> exit 0
new-dashboard $ pnpm run test     -> Test Files 153 passed | 33 skipped (186); Tests 2530 passed | 192 skipped (2722)
```
The reviewer's own round-2 run had no flake: 3593 tests / 3590 passed / 0 failed.

**Final lane: RED.** Push, open the PR, send NEEDS REVIEW, stop. Beau merges.

## Staging test steps (after Beau merges and staging deploys)

1. Platform → **TC checkout** tab. Turn **roland** on and confirm. Valley stays off.
2. As a hygienist, on a **test-patient** visit (12827 or 12828, roland), press **Alert checkout**, stage the note, and **Send**.
3. As a TC user in TC (roland): within about 60 seconds, a "<patient> is headed to checkout" toast appears and **Checkout** shows in the nav with a badge. Open it: the row is there.
4. Click the row and check the sidebar: treatment, priority, next visit, "Final notes in" (after Send), and Referral: None.
5. Enter an appointment note and press **Scheduled**. The row leaves Waiting and shows in Done today. On the Pipeline, the patient's case is in **Scheduled**.
6. Repeat with **Nothing needed** on another test visit: no case appears.
7. The next morning, an unanswered checkout from yesterday is gone from Waiting. In the DB its status is `expired`, with an audit row whose `source_ref` is `checkout_day_expiry`.
8. Turn roland **off** in the console. The next Checkout request 403s and the nav item disappears.

## Review

**Reviewer round 1: FAIL**, with five findings. All were fixed in fix round 1:
1. **Case delete broken.** A case an outcome linked could never be deleted: `ON DELETE SET NULL` hit a CHECK that required `case_id`.
   - Fix: the CHECK now only forbids a case on `nothing_needed`.
   - Pinned by "a case an outcome linked can still be DELETED".
2. **"Not scheduled" stranded fresh cases.** It left a fresh `hygiene_review` case out of every pipeline column.
   - Fix: it now moves cases before `pending_pt` forward.
   - Pinned by three route tests.
3. **The arrival toast mislabeled patients.** Answering the newest row announced the older patient beneath it as a new arrival, and the stale-scope guard compared a value with itself.
   - Fix: the hook compares arrival times and guards on a ref.
   - Pinned by "answering the newest does NOT announce the older patient".
4. **Expiry named a person.** The sweep recorded whoever's request ran it, not the system.
   - Fix: `expired_by` plus a system audit identity.
   - Pinned by "expiry is the SYSTEM's act".
5. **Dismiss could audit the wrong prior state.** The audited `prior_state` could be stale under a race.
   - Fix: it now comes from the conditional UPDATE that matched.
   - Pinned by "dismiss audits the status the DATABASE matched".

## Not in this slice / follow-ups

- Per-user notification preferences (silent / banner / sound) → item 51 (C3). The toast is always a banner today.
- The referral chip on the sidebar is a static "None" until R2.
- `tcRoleSplit.test.js`'s explicit `TC_FULL_READS` list could gain `/api/tc/checkout`. I didn't add it: that is an existing test's list, and the hygiene-403 case is covered in `tcCheckoutPage.test.js`.

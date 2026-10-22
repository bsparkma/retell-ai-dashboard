# Report: queue item 53, Referrals R2 (`feature/referrals-r2-workflow`)

**LANE: RED. NEEDS REVIEW. Beau merges.** Why RED:
- a NEW tenant role (`doctor`) and two new actions (`tc.referral_signoff`, `tc.notification_defaults`) in the shared roles/permissions vocabulary;
- a tenant migration with a new CHECK;
- four existing test files whose assertions were extended (listed below);
- new routes and the shared contract.

**Migration timestamp:** `1791900000000_tc_referral_source.js`. origin/develop's newest at push is
`1791800000000_tc_referrals.js` (R1); open PR #238 still carries `1791000000000`.

**Queue file:** `C:\Users\beau\carein cursor dashboard-dev\pm-prompts\queue\53-referrals-r2-workflow.md`
(DEV clone, untracked). Started automatically on #247's merge, per the PM's auto-continue instruction.

## What shipped

**NOTHING SENDS.** No email, no fax, no Open Dental read or write. `approved` is where R2 stops, and
every surface says "Ready to send — sending ships in a later update."

### The lifecycle (`/api/tc/referrals`, tc.full)
| | |
|---|---|
| `POST /` | Start a referral **from a case or a checkout**. The patient (office + PatNum + name) is read from that source, office-scoped. The body is strict: it can't name a patient, an office or a status. A case with no PatNum gets 409. The specialist must be this office's and active. |
| `GET /?caseId= / ?handoffId= / ?status=` | Newest first. Audited (READ). |
| `GET /:id` | With its full history. Audited (READ). |
| `PUT /:id` | Edits **a draft only**: the doctor signs off what they read. Anything else is 409 `REFERRAL_NOT_EDITABLE`. |
| `POST /:id/submit` | draft → pending_signoff. Goes straight to **approved** when this office does not require sign-off, with the event note "Sign-off isn't required for this office". |
| `POST /:id/withdraw` | pending_signoff → draft, to fix something. |
| `POST /:id/cancel` | draft or pending_signoff → cancelled. |

### The sign-off queue (`/api/tc/referrals/signoff`, **tc.referral_signoff = doctor + admin**)
- `GET /summary`, `GET /queue` (oldest first), `GET /:id`, `POST /:id/approve`, and `POST /:id/decline`, which requires a reason.
- The mount is registered **before** the tc.full `/referrals` mount. A doctor holds only this action, so the tc.full mount would otherwise refuse them; `roleGateWiring.test.js` pins the order.
- `GET /:id` opens only referrals that are pending, approved or declined. A TC's drafts and cancelled referrals stay private to TC.

### One transition engine (`referralTransitions.js`)
1. `referralNextStatus` in the shared contract is THE transition table. Illegal moves get 409 `REFERRAL_TRANSITION_NOT_ALLOWED`, which names the current status.
2. The move is **conditional** on the status just read, so two approvals cannot both win. The reviewer saw 1×200 / 3×409 on real Postgres.
3. The move is written to `tc_referral_events` (from, to, actor, when, note).
4. The **audit_log row is written before the transaction commits** (on its own connection), **so a failed audit rolls the move back.** Proven on real Postgres with the audit grant revoked: 500, still a draft, no event. See judgment call 3 for the one over-recording edge.
5. The referral is read back, and that is what the caller is told.

### The roles change (PM ruling 2026-10-14 + PM addition 2026-10-15)
- **`doctor`** joins TENANT_ROLES and holds exactly **`tc.referral_signoff`**, which admin holds too.
  - **What a doctor can reach:** the sign-off queue and the referral detail it needs. A real-Postgres check gave 403 on /cases, /referrals, /notification-prefs and /checkout. Their home is `/tc/referrals/signoff`, and their TC nav is the one "Awaiting sign-off" item.
  - Anything wider is not decided here.
- **`tc.notification_defaults`** = admin + **office**. Office managers now set the OFFICE alert defaults in Settings → Notifications. A person's own choice stays theirs: it is keyed by session, and nobody, admin included, can set another person's (tested).

### Migration `1791900000000_tc_referral_source.js`
`tc_referrals.source_kind` (CHECK, inline: `case, checkout, hyg_visit, call`) and `source_ref`.
These let the checkout chip find "the referral started from THIS checkout". A checkout answered
"Nothing needed" has no case, so the case link can't do it. The R3 starting points (hygiene visit,
call) are in the vocabulary now, so R3 needs no further vocabulary change for them.

### Carried from R1's review
- **Sign-off OFF + auto-send ON is now REFUSED** (409 `REFERRAL_POLICY_UNSAFE`): it would send a
  referral no doctor ever read. Auto-send with sign-off ON is fine. The R1 settings test was
  updated accordingly (see "Existing tests").
- **Deleting a case that a referral names** returns 409 `CASE_HAS_REFERRALS`, not a 500. A
  pre-check catches it, and the RESTRICT FK error (23503 `tc_referrals_case_fk`) is mapped too,
  in case a referral lands in between.
- **Directory PUT is still a full replace.** The R2 form always sends the whole entry.

### Client
- **Case page:** a Referrals card lists this case's referrals with status, specialist, teeth,
  urgency and reason. It has **New referral** and each row's next step (Submit for sign-off,
  Edit draft, Withdraw to edit, Cancel). An approved row shows the ready-to-send line.
- **Checkout sidebar:** item 50's placeholder chip is live, showing None / Staged / Pending Dr.
  sign-off / Approved / Declined, with **Start referral** beside it. It reads "None" exactly as
  before while referrals is off (the existing test is green and unedited).
- **The form:** specialist from the active directory (its specialty fills in), reason
  (required), teeth (1–32, or Whole mouth), how soon, referring provider, and notes. It offers
  **Save draft** or **Save & submit**. The patient is never on the form.
- **Awaiting sign-off** (`/tc/referrals/signoff`): the queue, oldest first. Each referral opens to
  a detail with its history and **Approve**, or **Decline** (the button is disabled until a
  reason is typed).
- **Nav:** "Awaiting sign-off" for sign-off holders while referrals is on, with a waiting badge.
  `useSignoffWatch` raises the arrival alert and obeys the `referral_signoff` preference
  (silent / banner / sound + banner). That event finally has a producer (C3 reserved it). A
  doctor can't read preferences (that route is tc.full), so the watcher skips the call and gives
  them the built-in banner.

## Roles-consumer sweep (grep-all-readers)
| Reader | Where | Status |
|---|---|---|
| TENANT_ROLES, the typedef, the action map | `backend/config/permissions.js` | **updated** |
| Client action list, ROLE_HOME, ROUTE_PERMISSIONS | `client/src/lib/permissions.ts` | **updated** |
| TenantRole union + list | `client/src/lib/auth.ts:46,48` | **updated** |
| TenantUserRole (Users page) | `client/src/lib/api.ts:162` | **updated**, and `rcm_biller` added: it was missing (pre-existing drift) |
| Users page role words + order | `client/src/pages/AdminUsers.tsx:36-46` | **updated** (doctor + rcm_biller) |
| Office notification default gate + `canEditOffice` | `backend/routes/tc/notifications.js:66,124` | **updated** |
| Users API role validation | `backend/routes/users.js:43,156,178,218` | not needed: it reads TENANT_ROLES |
| Platform console roster / role matrix | `backend/routes/platform.js:63,264` | not needed: it reads TENANT_ROLES |
| Any CHECK on `app_user.role` | `backend/migrations/1786449600000_roles_spine.js` | none exists (re-verified, and absent on real Postgres) |
| `ROLES_BOOTSTRAP_FALLBACK` | `backend/middleware/tenantContext.js` | not needed: it degrades to office |
| RCM / fees role pins | `rcmGuard.test.js`, `worklistState.test.js:630`, `officeSettings.test.js:302,455`, `feesImports.test.js:297` | not needed: they name roles explicitly; doctor holds no RCM or fees action |
| Docs listing roles | `docs/MODULES.md`, `ARCHITECTURE.md`, `CLAUDE.md` | none list them; `docs/RCM_POSTING.md` is RCM-only |
| Tests asserting role/permission sets | `config/permissions.test.js`, `routes/users.test.js:174`, `test/roleGateWiring.test.js`, `tests/role-permissions.test.ts:154,167`, `tests/role-nav.test.tsx:72` | **extended** (below) |

## Existing tests whose assertions changed (all EXTEND, none weaken)
1. `backend/config/permissions.test.js`: office's exclusions add `tc.referral_signoff`. Two new
   tests: a doctor holds exactly the sign-off, and the office default is admin + office only.
2. `backend/routes/users.test.js`: the role vocabulary now ends with `doctor`.
3. `backend/test/roleGateWiring.test.js`: `/referrals/signoff` is the one mount on its own grant,
   pinned to exactly `requirePermission('tc.referral_signoff')` and registered before `/referrals`.
4. `new-dashboard/tests/role-permissions.test.ts`: the office mock excludes the sign-off, and a
   doctor's home is somewhere they may go.
5. `new-dashboard/tests/role-nav.test.tsx`: same office mock fix, plus a new test that a doctor's
   TC nav is ONLY "Awaiting sign-off" and tc/office never see it. *(Round-1 review defect: this
   mock was missed at first.)*
6. `backend/routes/tc/tcReferrals.test.js` (R1's): sign-off OFF + auto-send ON is now refused.
   - The round-trip test asserts the 409 and then turns on auto-send together with sign-off.
     Its audit expectations are unchanged.
   - The env-pin test's setup stores only sign-off OFF.

## Acceptance
| # | Row | Status | Evidence |
|---|---|---|---|
| 1 | Transitions enforced; illegal moves 409 | PASS | `tcReferralLifecycle.test.js` (illegal / terminal / twice); real-PG |
| 2 | Only doctor + admin approve/decline | PASS | per-role route tests (office/tc/hygiene/reviewer/rcm_biller → 403); real-PG per role; a doctor reaches nothing else |
| 3 | Sign-off not required → straight to approved | PASS | route test (and the env pin puts sign-off back) |
| 4 | One audit row per transition; a failed audit fails it | PASS | route test with real rollback semantics; real-PG with the audit grant revoked |
| 5 | No send path | PASS | `/send`, `/email`, `/fax` → 404; diff grep |
| 6 | `doctor` in the users API and the picker; client mirror = backend | PASS | `users.test.js`, `role-permissions.test.ts` (ACTIONS parsed from the backend), `role-nav.test.tsx`, AdminUsers words |
| 7 | Every roles consumer listed | PASS | the sweep above |
| 8 | Office manager sets the office default; others 403; nobody sets another's choice | PASS | route tests (office/admin 200, tc 403; a body naming another user → 400); real-PG |

## Judgment calls for Beau
1. **A doctor is the minimum**: the queue, and referrals in or past sign-off. They can't change
   their own alert preference (that is a tc.full Settings page), so they always get banners.
2. **An admin can approve a referral they wrote themselves.** The ruling says admin signs off;
   this is a consequence of it, worth knowing.
3. **Audit timing:** the audit row is written during the transaction, on its own connection. A
   failed audit rolls the move back. A COMMIT that fails after a successful audit would leave an
   audit row for a move that didn't happen: it over-records, never under-records.
4. **`tc_referral_events` rows are updatable and deletable by `carein_app`** (R1's grant). Should
   they be append-only like audit_log? I left it, because tightening a grant on merged R1 tables
   deserves its own decision.
5. **A referral can be started from any checkout status**, including expired or dismissed: the
   patient was still seen.
6. **The ⌘K case search shows for a doctor on TC pages**, and every search is refused. Cosmetic;
   it can be hidden when needed.
7. **An office that already stored sign-off OFF + auto-send ON before R2** (possible only on
   staging, between #247 and this) keeps that pair. The refusal applies to new changes. Nothing
   sends yet; whichever slice adds sending must re-check the effective pair before it sends.

## Files
| File | Change |
|---|---|
| `backend/migrations-tenant/1791900000000_tc_referral_source.js` | **new** |
| `backend/config/permissions.js` | `doctor`, `tc.referral_signoff`, `tc.notification_defaults` |
| `backend/routes/tc/referrals.js` | lifecycle routes; refuse the unsafe policy pair |
| `backend/routes/tc/referralSignoff.js`, `referralTransitions.js` | **new** |
| `backend/routes/tc/referralStore.js` | referral reads/writes, CAS, events |
| `backend/routes/tc/index.js` | the sign-off mount, registered first |
| `backend/routes/tc/notifications.js` | `tc.notification_defaults` |
| `backend/routes/tc/cases.js` | DELETE → 409 when referrals name the case |
| `new-dashboard/shared/tc/referrals.ts` + `backend/tc/contract.gen.cjs` | the transition table, chip, shapes; regenerated |
| `client/src/features/tc/referrals/{ReferralsPanel.tsx,useSignoffWatch.ts,referralsApi.ts}` | **new** / extended |
| `client/src/pages/tc/TcReferralSignoff.tsx`, `App.tsx`, `components/DashboardLayout.tsx` | the page, the route, the nav and badge |
| `client/src/features/tc/checkout/CheckoutSidebar.tsx`, `pages/tc/TcCaseView.tsx` | the panel mounted |
| `client/src/lib/{permissions,auth,api}.ts`, `pages/AdminUsers.tsx` | the roles mirror |
| tests | **new:** `tcReferralLifecycle.test.js` (31), `referralSourceMigration.test.js` (5), `tc-referrals-r2.test.tsx` (15 + 2 shots). **Extended:** the six listed above |
| `docs/screenshots/tc/tccheckout-09-signoff-queue-*`, `tccheckout-10-case-referrals-*` | shots |

## Gates
```
backend $ node --check server.js  -> OK
backend $ node --test             -> (final run below)
new-dashboard $ pnpm run check    -> exit 0
new-dashboard $ pnpm run test     -> (final run below)
```
Final run, commit a9caaff + the test tightening:
```
backend $ node --test             -> # tests 3702  # pass 3698  # fail 1  # skipped 3
  routes\platform.test.js  'Unable to deserialize cloned data' (known Node 22 flake;
  isolated 20/20; the next full run was clean)
new-dashboard $ pnpm run test     -> Test Files 162 passed | 34 skipped; Tests 2599 passed | 198 skipped
```

## Lane
**RED. Both verdicts agree.** The classifier says RED, the queue file says RED, and by
judgment it is RED: a new role, new actions, a migration, existing-test edits and new routes.

The reviewer (a fresh agent following `.claude/agents/reviewer.md`):
- **Round 1: FAIL**, with two defects:
  - the report was missing (row 7, and the carried auto-send decision was unstated);
  - the `role-nav.test.tsx` office mock still granted the sign-off.

  On real postgres:17 it otherwise proved everything:
  - migrations up, down 2, up;
  - 4 concurrent approves → 1×200 + 3×409;
  - with the audit grant revoked, the move rolls back;
  - case delete → 409;
  - the source CHECKs;
  - every non-signoff role → 403;
  - a doctor reaches nothing but the queue.
- **Round 2: PASS, LANE RED, no new defects.** Both defects were fixed, plus four judgment
  items. The reviewer judged the R1 settings test edit "honest, not a weakening". Its optional
  tightening of the env-pin test (pin over a stored auto-send TRUE) was taken.

## Staging test steps (after Beau merges)
1. **Users page:** give a test account the **Doctor** role.
2. **Platform → TC referrals:** roland is on (from R1).
3. **As TC, on a test case (12827), New referral:** pick a specialist, enter a reason, then
   **Save & submit**. It shows **Pending Dr. sign-off**.
4. **As the doctor account:** the only TC nav item is **Awaiting sign-off**, with a badge. Open
   the referral, then **Approve**. It reads "Ready to send — sending ships in a later update."
5. **From the checkout sidebar** of a test-patient checkout, **Start referral**. The chip moves
   None → Staged → Pending Dr. sign-off.
6. **Settings → Referrals, as admin:** turn sign-off off, then try auto-send on. It is refused,
   with the reason.
7. **Settings → Notifications, as an office manager:** the office default is editable.

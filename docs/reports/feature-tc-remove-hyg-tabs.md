# CO-2: remove the TC app's Hygiene tabs

Branch `feature/tc-remove-hyg-tabs` off `origin/develop` (61646e0, with CO-1 and its polish merged).

**Ruling (Beau, 2026-10-29).** The hygiene app replaces the TC app's Hygiene tabs, and the TC Inbox stays.

This change removes **screens, not plumbing**:
- The hygiene app still sends to TC through the same `POST /api/tc/hygiene-intakes`.
- The intake tables are untouched, and there is no migration.
- `tcHandoffClient`, checkout routing and the Inbox's query are unchanged.
- The CO-1 Inbox-routing tests pass **unchanged**.

## What changed

| Before | After |
| --- | --- |
| TC nav had a **Hygiene** group: TC Inbox, Hygiene handoff, Submissions | The group is gone. **TC Inbox** moved into Casework, after Opportunities. |
| `/tc/hygiene`: the TC app's hygiene handoff form | Page deleted. Redirects to **`/tc/checkout`**, where a same-day hygiene send now lands (CO-1). |
| `/tc/hygiene/submissions`: the office's submissions list | Page deleted. Redirects to **`/tc/inbox`**. |
| `/tc/hygiene/inbox`: the TC Inbox | Moved to **`/tc/inbox`**, same page. The old path redirects there. |

**Judgment call: the Inbox's address.** The ruling sends old URLs to `/tc/inbox`, but no such route existed; the Inbox lived at `/tc/hygiene/inbox`, inside the group being removed. I moved it to `/tc/inbox` and redirected the old path.
- The new path carries the **same grant** (`"/tc/inbox": "tc.hygiene"`), so exactly the same people can open it. A test compares every role's access to the old and new paths.
- `"/tc/hygiene": "tc.hygiene"` stays in `ROUTE_PERMISSIONS`, so a hygienist's old bookmark reaches its redirect instead of bouncing home first.
- The page file keeps its name (`TcHygieneInbox.tsx`).

## ⚠ The premise that the Inbox lists calls, walk-ins and doctor ops does not match the code

The ruling describes the Inbox's patients as coming from calls, walk-ins and doctor ops. The code says otherwise, and CO-2 doesn't change it either way:
- **What the Inbox lists.** `GET /hygiene-intakes/inbox` lists `hygiene_review` cases from `tc_hygiene_intakes`. Those are hygiene treatment handoffs and ortho screenings only, and only ones without a same-day checkout (CO-1).
- **Where other sources go.** A call sent to TC (`/cases/from-call`), an opportunity and a pre-auth each create a `pending_tc` case. That case shows in the **Pipeline**, not the Inbox.
- **What this means for the tests.** "Inbox still lists … all non-hygiene sources" can't be tested as written, because none exist. The new backend test pins what is true instead: a call still opens its case in the Pipeline, as before, and is not an Inbox item.
- **The one manual way in is gone.** The deleted form was the only way to put a case into the Inbox by hand; its idempotency key was labelled "TC's own intake form" (item 49). If walk-ins or doctor ops were being entered through it, they now need the Pipeline's **New case**, which lands in `pending_tc`. **Beau, please confirm.**

## Usage check, per page (before deleting anything)

Commands: `git grep` across the repo for each file, export, route path and URL, plus import-graph reads.

### Page 1: `pages/tc/TcHygieneIntake.tsx` (`/tc/hygiene`, "Hygiene handoff"): DELETED

| Reference | Kind | Verdict |
| --- | --- | --- |
| `App.tsx:45` import, `:240` `<Route path="/tc/hygiene">` | route + import | Import removed; route becomes a redirect to `/tc/checkout` |
| `DashboardLayout.tsx:220` nav item "Hygiene handoff" | nav link | Removed |
| `permissions.ts:115` `"/tc/hygiene": "tc.hygiene"` | route grant | **Kept**, so the redirect still resolves for a hygienist |
| `features/tc/hygiene/IntakeForm.tsx` | its only component | Deleted (see below) |
| `tests/tc-names-f8.test.ts` (pins the page title and nav line) | test | Edited, **RULING (CO-2)**: now pins that the nav item is gone; the name is still pinned where it lives (visit tray, server title) |
| `tests/role-permissions.test.ts:42,64,103` (`/tc/hygiene` grant) | test | Unchanged and passing (the grant is kept) |
| The `TcHygieneIntake` hits in `shared/tc/*`, `backend/*`, `tests/*ortho*` | the zod **type** `TcHygieneIntake`, not the page | Untouched |
| `docs/reports/*.md`, `docs/HYG_*.md` | historical reports | Left as records |

### Page 2: `pages/tc/TcHygieneSubmissions.tsx` (`/tc/hygiene/submissions`, "Submissions"): DELETED

| Reference | Kind | Verdict |
| --- | --- | --- |
| `App.tsx:46` import, `:241` route | route + import | Import removed; route becomes a redirect to `/tc/inbox` |
| `DashboardLayout.tsx:221` nav item | nav link | Removed |
| `IntakeForm.tsx:373` "My Submissions" link; `TcHygieneIntake.tsx:31` | links | Deleted with their files |
| `api.ts` `hygieneSubmissions()` (its only caller is this page) | client fn | Removed |
| `tests/hygienist-attribution.test.tsx` (tests only this page's filter chips) | test | Deleted with the page, **RULING (CO-2)** |
| `tests/role-permissions.test.ts:66,103` | test | Unchanged and passing |

### Page 3: `features/tc/hygiene/IntakeForm.tsx` (the form inside Page 1): DELETED

| Reference / dependency | Verdict |
| --- | --- |
| `TcHygieneIntake.tsx` (its only importer) | Deleted |
| `tests/tc-intake-attach.test.tsx` (tests only this form) | Deleted, **RULING (CO-2)** |
| `tests/tc-names-f8.test.ts:38` (path in the name list) | Edited, **RULING (CO-2)** |
| `api.ts` `submitHygieneIntake`, `TcIntakeSubmit`, `newIntakeSourceKey`, `hygienistRoster`, `TcHygienistOption` (only this form used them) | Removed |
| `api.ts` `odAttachSearch` | **Kept**: the Referrals hub's `NewHubReferral.tsx` uses it |
| `OdPatientSearch`, `fieldsFromOdPatient`, `todayIsoDate` | **Kept**: five or more other users each |

### The TC Inbox (`pages/tc/TcHygieneInbox.tsx`): KEPT, moved

| Reference | Verdict |
| --- | --- |
| `App.tsx:242` route | Now `/tc/inbox`; `/tc/hygiene/inbox` redirects there |
| `DashboardLayout.tsx:219` nav item | Moved to Casework as `/tc/inbox` |
| `permissions.ts` | New `"/tc/inbox": "tc.hygiene"` (parity) |
| `api.ts` `hygieneInbox`, `claimHygieneCase` | Unchanged |
| `tests/tc-inbox-permissions.test.tsx`, `role-nav`, `tc-checkout-nav`, `tc-texts-nav`, `tc-office-scope` (render the shell at `/tc/hygiene/inbox`) | Unchanged and passing. They render the shell at that path without going through the router. `role-nav`'s hygiene-role nav assertion is edited, **RULING (CO-2)** |

## Backend routes the removed pages called: verdict per route

All are in `backend/routes/tc/hygiene.js`, mounted at `/api/tc/hygiene-intakes`.

| Route | Callers found | Verdict |
| --- | --- | --- |
| `POST /` | `services/hyg/tcHandoffClient.js:667` (the hyg module's send), the deleted form | **STAYS**: this is the handoff ingestion |
| `GET /hygienists` | `hygienistRoster()` → deleted IntakeForm only | **REMOVED** |
| `GET /` (submissions list, `?hygienist=`) | `hygieneSubmissions()` → deleted Submissions page only | **REMOVED** |
| `GET /mine` | `myHygieneIntakes()` in `api.ts`, which **had no caller before CO-2 either**; also backend tests | **STAYS**: neither deleted page called it. Flagged as already-dead client code for a later cleanup |
| `GET /inbox` | the TC Inbox | **STAYS** |
| `POST /:caseId/claim` | the TC Inbox | **STAYS** |
| `/api/tc/od/patient-search` (the form's OD attach) | also the Referrals hub's New referral | **STAYS** |

Side effects of the removal:
- `registry` is no longer imported by `hygiene.js`.
- `registry.listTenantUsersByRole` now has no production caller. It is a generic platform helper; left in place and flagged.
- Backend tests that pinned the two removed routes were removed, **RULING (CO-2)**: four tests in `tcHygienistAttribution.test.js` and one read in `tcHygiene.test.js`. They are replaced by tests asserting both routes now 404 and that `POST /` still lands.

## Tests

New in `new-dashboard/tests/tc-remove-hyg-tabs.test.tsx` (mounts the real `App` router):
- `/tc/hygiene` → `/tc/checkout`, `/tc/hygiene/submissions` → `/tc/inbox`, and `/tc/hygiene/inbox` → `/tc/inbox`, none of them on the 404 page.
- `/tc/inbox` stays put.
- A hygienist's old bookmarks: Submissions lands on the Inbox. The form path goes via Checkout, which is `tc.full`, to their home `/hyg/day`.
- `/tc/inbox` access equals `/tc/hygiene/inbox` access for every role.
- No sidebar in any role (admin, office, tc, hygiene, doctor) shows "Hygiene handoff", "Submissions" or any `/tc/hygiene*` link. Every role that can open the Inbox has it in the nav.

New in `backend/routes/tc/tcRemoveHygTabs.test.js`:
- Only the two removed routes 404; `POST /`, `/mine`, `/inbox` and the claim still answer.
- The Inbox still lists a hygiene treatment handoff (no same-day checkout) and an ortho screening.
- A call sent to TC still opens its `pending_tc` case and is not an Inbox item.

Checkout flow end to end: covered unchanged by the CO-1 suites (`tcCheckoutInboxRouting`, `tcCheckoutWorkup`, `tcCheckoutPage`, the workup and polish UI tests), all passing.

Local results:
- Backend: `node --check server.js` ok; `node --test` gives **4425 pass, 0 fail**.
- Dashboard: `pnpm run check` clean; `pnpm run test` gives 3035 passed and 1 failed. The failure is `rcm-confirm-in-place` ("the work moves on by itself"). That test touches no CO-2 file and passed 3 times out of 3 when run alone, so it's a timing flake under the full parallel run.

## Review

One round with a fresh-context reviewer, which reported **no blocking issues**.

The reviewer independently re-checked:
- the repo-wide grep for the deleted files and exports;
- that the two removed routes have no surviving caller;
- the wouter exact matching, and that no role (admin, office, tc, hygiene, doctor) hits a redirect loop;
- that no `/tc/hygiene*` link remains in toasts, the hygiene module or backend URLs;
- that every test edit is labelled RULING (CO-2) and none was weakened;
- that the CO-1 routing test is byte-for-byte unchanged.

| Finding (all low) | Outcome |
| --- | --- |
| `api.ts` comment still pointed at the deleted `hygiene/IntakeForm.tsx` | Fixed |
| The FakeTenantDb `DISTINCT` stub in `tcHygienistAttribution.test.js` served only the removed `GET /` | Removed |
| `myHygieneIntakes` / `TcMyIntake` (client) have no caller | Left, flagged above; this predates CO-2 |
| `registry.listTenantUsersByRole` has no production caller now | Left, flagged above; generic platform helper |
| `role-permissions` / `tc-office-scope` tests still use `/tc/hygiene/*` as example paths | Left. They pass because the grant is kept, and the new test pins `/tc/inbox` parity |

No second round was needed.

## CI

PR #294. `build-test` on `refs/pull/294/merge` (run 40981348372, head 78061b9) **passed** with no fix pushes. That run covers typecheck, vitest, `node --check`, `node --test`, migrations against an ephemeral Postgres, and the smoke spine. Not merged.

# CO-1: Checkout workup view and same-day hygiene routing

Branch `feature/tc-checkout-workup`, off `origin/develop` (f0e5566). Built to Beau's rulings
of 2026-10-29. PR: **#292** (to develop). Not merged.

## What changed, in one paragraph

Clicking a patient on the Checkout page now opens a full-screen **workup view** at
`/tc/checkout/:id?office=`. The address can be shared, and Back returns to the list. The
sections follow desk order: work up in OD, existing treatment to present, collect payment,
referrals, then the unchanged outcome buttons. Each section has checkboxes. They save to
the checkout record on the server, and each waiting card on the list shows "N of M
sections done". The narrow sidebar stays, as the row's **Quick look** (the arrival toast
still opens it too). Separately, the **TC Inbox no longer lists a hygiene handoff when the
same patient has a same-day checkout entry**, because that content is already on the
checkout card.

## 1. Routing: same-day hygiene goes to the checkout card

**Rule.** A hygiene intake is left out of the Inbox when a checkout handoff exists in the
**same office**, for the **same Open Dental patient**, with the **same visit day**, in a
status that holds it.

- **Statuses that hold it:** `open`, `claimed`, `scheduled`, `not_scheduled` and
  `nothing_needed`.
- **Statuses that hand it back to the Inbox:** `dismissed` ("not a checkout after all") and
  `expired` (the day ended and nobody answered). Everything else means the front desk has
  the patient.
- **Visit day:** the intake's `visit_date`. If that is empty, the office day it was
  submitted (`OFFICE_TIMEZONE`).
- **Unmatched intakes:** an intake with no PatNum has nothing to match on and stays in the
  Inbox.

**What did not change.** The `hygiene_review` case is still created. It still shows on the
Pipeline, and a checkout outcome still attaches to it (`findOpenCase`). Only where the
intake surfaces changed. A test covers this: an outcome on the same-day checkout still
answers `attached: true` with the intake's own case id.

**Every surface that lists hygiene intakes, with evidence:**

| Surface | Reader | Inbox item? | Changed? |
| --- | --- | --- | --- |
| TC Inbox page (`/tc/hygiene/inbox`, `TcHygieneInbox.tsx:127`) | `GET /api/tc/hygiene-intakes/inbox` (`routes/tc/hygiene.js`) | **Yes** | **Yes**: same-day ones are filtered out |
| Submissions page | `GET /api/tc/hygiene-intakes` | No (a history) | No |
| My submissions | `GET /api/tc/hygiene-intakes/mine` | No (a history) | No |
| Pipeline board, "New from hygiene" column | `GET /api/tc/cases` | No (the board) | No |

How I found them:
- `grep tc_hygiene_intakes` over `backend/` (no migrations or tests): only `hygiene.js` (the
  three list routes), `caseStore.js` (one case's own intake) and `cases.js:310` (the
  board's ortho marker) read it.
- `grep hygiene-intakes/inbox` over the client: only `features/tc/api.ts:866`, used by
  `TcHygieneInbox.tsx` alone.
- The nav badge and toasts read `/checkout/summary`, not intakes.

The Inbox and Hygiene tabs are untouched (that is CO-2).

**How it is built.** The Inbox's existing JOIN query is unchanged. After it runs, one
office-scoped, single-table read
(`SELECT handoff_id, od_patient_id, visit_date, status FROM tc_checkout_handoffs WHERE
office_id = $1 AND od_patient_id = ANY($2) AND visit_date = ANY($3)`) feeds a pure
function, `checkoutStore.claimedBySameDayCheckout`. This keeps the rule testable in the
fake-DB harness, which cannot run JOINs and would otherwise only exercise a stub.

## 2. The workup view

The page is `pages/tc/TcCheckoutWorkup.tsx`, which renders
`features/tc/checkout/CheckoutWorkup.tsx`. Everything on it comes from the stored checkout
snapshot: **no Open Dental read and no fee anywhere**.

1. **Work up in OD.** A table with one row per staged item: Worked up box, Tooth, Surf,
   Code, Priority · category, Dx. Code, tooth and surface are in monospace and
   `select-all`, and **Copy list** puts plain lines on the clipboard. Primary teeth print
   as letters through `shared/hyg/teeth.ts` (102 → **B**). The priority is the filled
   "Priority Urgent" pill and the category an outlined tag, the same `ProcedureTags`
   component the sidebar uses. Dx prints in words ("FX (Fracture), D (Decay)") with the dx
   note and the hygienist's note under it. The records the treatment needs ("Pre-op PA:
   Still needed") sit under the table.
2. **Existing treatment to present.** The existing `ExistingTreatmentFromHygiene` block,
   grouped in the ratified `EXISTING_TX_TC_GROUP_ORDER`, with a **Ready to present** box on
   each group. The block gained one optional `groupAction` slot. Without it, it renders as
   before.
3. **Collect payment.** The collect list, with one **Collected** box.
4. **Referrals.** The existing `ReferralsPanel` (full mode), with this checkout as its
   source, plus a **Referrals handled** box. **No logic was forked**: it lists and creates
   through the same `referralsApi` functions, and so the same `/api/tc/referrals` routes,
   as the hub, the case page and the sidebar. A test checks that the calls go to that
   module with `{ handoffId }`.
5. **Outcome.** Scheduled / Not scheduled / Nothing needed. The claim-and-outcome block
   was **extracted unchanged** from the sidebar into `CheckoutOutcome.tsx`, so the sidebar
   and the workup view now share one implementation. The sidebar's behaviour is the same,
   and its existing tests pass unmodified apart from how they open it.

The page also shows the hygienist's front-desk and financial notes at the top and "Next
visit needs" at the foot, the same facts the sidebar shows.

## 3. Checklist state

**Storage.** Tenant migration **1793500000000_tc_checkout_workup** adds
`tc_checkout_handoffs.workup jsonb`, nullable and with no default. A CHECK limits it to
`workup IS NULL OR jsonb_typeof(workup) = 'object'` (led by `IS NULL`, so it is
two-valued). That number was above develop's newest (1793400000000) when the branch was
cut; I re-check it at push.

**Shape.** `TcCheckoutWorkup` in `shared/tc/checkout.ts` holds `workedUp` (per item index),
`present` (per group), `collected` and `referrals`, each tick `{ by, at }`. A NULL column,
which covers every record before CO-1, reads as nothing ticked. That happens on the server
(`checkoutStore.workupOf`) and in the contract, where `TcCheckoutHandoff.workup` defaults
to empty.

**Write.** `POST /api/tc/checkout/:id/workup` with `{ section, index | group, done }`:
- The office comes from `requireOffice`, and the record is the one that office holds under
  that id. The body cannot name an office, a patient or a person; it is strict, so any
  extra field is a 400.
- The write is a read-modify-write under a **row lock** (`SELECT … FOR UPDATE` first), so
  two ticks on one checkout serialize instead of erasing each other. A refused or no-op
  tick leaves the row untouched, including `updated_at`.
- It writes **one audit row per change**, after the commit:
  `UPDATE tc_checkout_handoff <id>`, `source_ref checkout_workup:<section>`,
  `prior_state done | not_done`. Re-ticking a box that is already ticked keeps the first
  person's mark, writes nothing and audits nothing.
- **Honest save:** the route re-reads the record after the commit and answers 500
  `WORKUP_NOT_PERSISTED` unless the stored checklist holds the tick that was asked for.
  The client renders that read-back, never the click.
- **Refusals:** an answered checkout returns 409 `CHECKOUT_NOT_ACTIONABLE`, because its
  checklist is a record. A box the snapshot does not have is a named 404 (`ITEM_NOT_FOUND`,
  `GROUP_NOT_FOUND`, `NOTHING_TO_COLLECT`). An office with checkout off returns 403.

**Stale ticks.** Each tick on a box tied to the snapshot stores a key for what it was
ticked against:
- **Worked up:** the item's `checkoutItemKey`.
- **Ready to present:** the group's procedure numbers.
- **Collected:** the collect list.

If a later visit Send changes that thing, the tick is **stale**: it counts as not done, and
a work-up row says "Changed since ticked". This is the same rule as the C2b "entered in
Open Dental" attestation. Referrals has nothing in the snapshot to go stale against.

**One save at a time on screen.** While any tick is saving, every box on the view waits,
so two answers cannot arrive out of order and the older read-back cannot overwrite the
newer one.

**Progress.** `checkoutWorkupProgress` is one pure function, used by the list card and the
view. It counts only sections that have something to do: work-up if anything was staged,
present if existing treatment came along, collect if there is something to collect. That
gives, for example, "2 of 4 sections done", or "0 of 1 section done" for a visit with
nothing staged.

## Judgment calls for Beau

These are flagged because the rulings did not settle them. Each is a small change if you
rule otherwise.

1. **Referrals always counts as a section** and has its own "Referrals handled" box. The
   desk decides whether a referral is needed, and "none needed" is still an answer. If you
   would rather it count only when a referral exists, the count would have to read the
   referral list.
2. **The workup lists the referrals started from this checkout**, which is what the
   existing panel does for a checkout source. Listing *every* referral for the patient
   would need a new, server-derived "by patient" filter on the referrals route. The rulings
   said no forks, so I left it out. Patient-wide referrals are on the case page and in the
   hub.
3. **Dismissed and expired checkouts hand the intake back to the Inbox**, so a diagnosed
   treatment cannot disappear when nobody answered the checkout. Every other status keeps
   it on the card.
4. **The checklist is editable only while the checkout is waiting** (open or claimed).
   After an outcome it is a record and renders read-only.
5. **`dx` now travels on the checkout snapshot.** Before CO-1 the checkout alert dropped
   each item's `dx` and `dxNote`. They now ride on `TcCheckoutProcedure` as **optional**
   fields, and the key is absent when there is no diagnosis. Old snapshots parse as they
   did, and a visit with no dx sends the same body it always did. The codes are kept as
   short strings, not the hygiene enum, so a code the slip gains later cannot make TC
   refuse a handoff.

## Guardrails

| Guardrail | Status |
| --- | --- |
| No Open Dental reads or writes added | ✓. New code paths touch only `tc_checkout_handoffs`, `tc_hygiene_intakes`/`tc_cases` (the existing query) and `audit_log`. The workup tests run with no OD client. |
| No fees | ✓. Nothing reads or renders a fee. |
| Office and PatNum server-derived | ✓. Office comes from `requireOffice`; the checklist body is strict; the Inbox read is office-scoped (a test checks that valley's same-day checkout never hides roland's intake for the same PatNum). |
| No `SELECT *` | ✓. Explicit columns; a test asserts it on the new read. |
| Migration additive and nullable | ✓. One nullable column; `down()` drops the CHECK, then the column. |
| TC payload additive | ✓. `dx`/`dxNote` optional; `workup` defaulted; old payloads parse (tested). |
| No real names | ✓. Synthetic names only; fixtures roland 12827/12828 and valley 7115. |
| TS strict, no `any`, tsc clean | ✓. `pnpm run check` clean. |
| Test expectations changed only where ruled | ✓. Two files, each labelled `RULING (CO-1)` (below). |
| Nothing deleted | ✓. No files or exports removed. `checkoutClock` moved into `CheckoutOutcome.tsx` and is still re-exported from `CheckoutSidebar.tsx`, so its existing importer (`TcCheckout.tsx`) is unchanged. |

## Tests

**New tests:**

- `backend/routes/tc/tcCheckoutInboxRouting.test.js` (6). A same-day intake is absent from
  the Inbox and present on the checkout card, while a non-same-day one stays. Case-joining
  is unchanged. Holding statuses keep it on the card, and dismissed/expired hand it back.
  Office isolation across a shared PatNum; no PatNum or no same day stays in the Inbox;
  the submitted-day fallback. A mutation check (the filter removed) turns 3 of the 6 red.
- `backend/routes/tc/tcCheckoutWorkup.test.js` (13). Three of these came from review
  round 1: lock order, untouched rows on refused ticks, and stale Ready to present and
  Collected. Old records read empty. Each box ticks,
  reads back from the stored row and unticks. One audit row per change, and a repeat tick
  keeps the first mark. **Office isolation:** another office gets 404 and nothing changes.
  The body can name only a box. Unknown boxes get named 404s; an answered checkout gets
  409; stale ticks; switched off gets 403; old payload parse.
- `backend/test/checkoutWorkupMigration.test.js` (5): additive, nullable, CHECK shape,
  down order, numbering, store columns present after replay.
- `backend/services/hyg/checkoutDx.test.js` (3): dx and dx note carried, absent when empty,
  capped, accepted by TC's strict submit schema.
- `new-dashboard/tests/tc-checkout-workup.test.tsx` (11, plus 2 screenshot dumps). Two of
  these came from review round 1: one save at a time, and stale Ready to present and
  Collected.
  - **Layout:** all sections in desk order, then the exit. Copy-friendly rows (primary
    tooth as a letter, priority apart from category, dx in words), groups in the ratified
    order, and each section's empty state.
  - **Checklist:** a box renders the read-back, not the click; stale ticks; read-only once
    answered.
  - **Referrals:** they go through the same `referralsApi` with this checkout as the
    source.
  - **Page:** it loads the record for the URL's office.

**Changed expectations, each labelled `RULING (CO-1)`:**

- `new-dashboard/tests/tc-checkout.test.tsx`: three tests that opened the sidebar by
  clicking a row now click **Quick look** (a row opens the workup view). The assertions on
  the sidebar's content and outcomes are unchanged. Two tests were added: a row navigates
  to `/tc/checkout/:id?office=`, and the card shows progress.
- `new-dashboard/tests/tc-checkout-shots.test.tsx`: the two sidebar dumps open it through
  Quick look.

**Runs (local, Node 22 / pnpm 10.4.1):**

| Check | Result |
| --- | --- |
| `pnpm run check` | clean |
| `pnpm run test` | 3026 passed, 233 skipped, 0 failed (the TC contract bundle byte-compare included) |
| `node --check server.js` | ok |
| `node --test` | 4391 of 4396 passed |

The `node --test` failures are whole files failing in the parallel run, the known Node 22
runner flake: `routes/sendToTc.test.js` and `services/onDemandTranscription.test.js` in
the last run, and `routes/platform.test.js` in an earlier one. Each passes on its own.

## Screenshots (synthetic data)

All are in `docs/screenshots/tc/co1/`, at 1280 px, light, with dark variants where shown.

| | Before | After |
| --- | --- | --- |
| The list | `before-01-list.png`: rows open the sidebar | `after-01-list.png`: Quick look, Claim, Dismiss, and "0 of 2 sections done" on each waiting card |
| Working the patient | `before-02-sidebar.png`: the narrow sheet | `tccheckout-co1-01-workup-1280x2000-light.png` (and `-dark`): the full-screen view, part done, "2 of 4 sections done" |
| Nothing staged | n/a | `tccheckout-co1-02-empty-1280x1300-light.png`: each empty state |
| The sheet, now Quick look | n/a | `after-02-quicklook.png`: unchanged inside, plus "Open full workup" |

## Review

**Round 1** (fresh-context reviewer): **no blockers**. Each finding and what was done:

| # | Finding | Severity | Done |
| --- | --- | --- | --- |
| 1 | Two quick ticks could land out of order and show an older read-back | should-fix | Fixed: every box waits while any save is in flight (UI test added) |
| 2 | Nothing would fail if the row lock were removed | should-fix | Test added pinning lock → read → write in one transaction; removing the lock turns it red (checked). See the limitation below. |
| 3 | The lock bumped `updated_at` on refused or no-op ticks | should-fix | Fixed: `SELECT … FOR UPDATE`; `updated_at` moves only on a real change (test added) |
| 4 | Read-back can report a false failure if another user flips the same box between commit and read | should-fix | Kept on purpose, now documented in the code. It errs toward "not saved" and the client reloads; it can never report a tick the row does not hold. |
| 5 | `isoDate` on a pg `date` would shift a day on a positive-UTC-offset host | nit | Existing helper and pattern. Both sides of the match go through it, so they shift together; noted, not changed. |
| 6 | Inbox `LIMIT 200` applies before the same-day filter | nit | Accepted: it can return fewer than 200 rows, and never hides one it shouldn't. |
| 7 | Ready to present and Collected did not go stale | nit | Fixed: both carry keys now (server and UI tests added) |
| 8 | Pipeline and funnel still count same-day `hygiene_review` cases | info | Intended: only the Inbox changes. |

**Limitation, said plainly.** The backend test harness is an in-memory fake with one
process and no second transaction. It can pin that the lock is taken first, but it cannot
show two ticks actually waiting on each other. That property comes from Postgres
(`FOR UPDATE` under READ COMMITTED). CI's ephemeral Postgres runs migrations only, not
route tests.

**Round 2** (fresh-context reviewer, on the round-1 fix commit): **no blockers**. It
confirmed the lock, the stale keys (server, shared progress and UI all call the same key
functions) and the lock-order test.

| # | Finding | Severity | Done |
| --- | --- | --- | --- |
| 1 | Two clicks inside one render (a double-click) could both send, because disabling waits for the next render | should-fix | Fixed: a ref guard at the top of `tick`. Test added; removing the guard turns it red (checked). |
| 2 | An untick could report a false 500 if a visit Send removed that box between commit and read-back | should-fix | Fixed: a missing box on an untick counts as holding (documented in code) |
| 3 | `FOR UPDATE` accepted by the fake DB | nit | No risk: the RCM fake already does the same, and the lock-order test covers this route |
| 4 | "Collected" goes stale if a Send only reorders the collect list | nit | Accepted: reordering is rare and re-ticking is one click |

The round limit (2) is reached. Any later finding goes in the PR thread, not another
round.

## CI

`build-test` on `refs/pull/292/merge` **passed** (5m 0s,
[run 40956676621](https://github.com/bsparkma/retell-ai-dashboard/actions/runs/40956676621/job/123738448744))
at head `3a925ad`. That covers typecheck, vitest, `node --check`, `node --test`, migrations
against an ephemeral Postgres, and the smoke spine. It needed no fix pushes. This report
commit is docs-only.

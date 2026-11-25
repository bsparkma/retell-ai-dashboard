# Fix: nurture planning shrank sequence gaps outside the send window

Branch `fix/tc-nurture-plan-gaps`, cut from `origin/develop` at 7eb4009 (PR #360 merged). RED lane (nurture planning). **Not merged.**

This change has no migration. It does not touch `sendMessage`, the adapters, `consent.js`, the scheduler, or any switch, and the hard caps are unchanged. It makes no Open Dental calls and no AI calls, and it does not read `.env`. **Nothing sends automatically.**

## The defect

`planCampaign` and `replanForward` anchored every email on *the first email's base day + (day_j − day_0)*. When the window or a cap then moved an email later, nothing moved the emails after it. The PM measured this on develop 7eb4009, and it reproduces exactly:

- Wed 17:00 → 6,9,14,20
- Fri 17:00 → 4,10,14,21
- Sat 12:00 → 7,7,14,21

The defect is wider than the first email. A weekend or cap push in the middle of a sequence shrank the next gap too, even when the campaign started inside the window. From **Wed 14:00**, the old planner gave these gaps:

| Track (crown) | Sequence days | Wanted gaps | Before | After | Span before → after (days) |
|---|---|---|---|---|---|
| warm_followup | 1,3,6,10,15,21,28,36,45,56 | 2,3,4,5,6,7,8,9,11 | 4,**2**,5,**3**,**6**,7,8,11,9 | 4,3,4,7,7,7,8,9,11 | 55 → 60 |
| large_case | 1,4,8,14,21,30,40,55,75 | 3,4,6,7,9,10,15,20 | 4,**3**,6,7,9,10,15,20 | 4,4,6,7,11,10,15,20 | 74 → 77 |
| reactivation | 0,7,16,30,50 | 7,9,14,20 | 7,9,14,20 | 7,9,14,20 | 50 → 50 |
| no_show_recovery | 0,3,8,21 | 3,5,13 | 5,**3**,13 | 5,7,14 | 21 → 26 |

Bold marks a gap shorter than the sequence's gap. The hard caps held in every case. Only the spacing was wrong.

The Resume route test (`routes/tc/tcNurtureApprove.test.js`, formerly :793) read `Date.now()`. It therefore failed with "gap 1 kept (6)" whenever CI ran outside Mon–Fri 09:00–16:00 America/Chicago. That is what failed staging-cd run #325.

## The fix

**The rule.** The planner places emails in sequence order. Email j is never earlier than:

- (a) its own base time, and
- (b) the *placed* local day of email j−1, plus (day_j − day_(j−1)) days, at 10:00.

The send window applies next, and then the hard caps, exactly as before. As a result, a gap between consecutive emails is never shorter than the sequence's gap in local days. A gap may be longer when the window or a cap moves an email later. Emails only ever move later.

**Where it lives: inside `planTimes`** (`backend/services/tcNurture/engine.js`), as an optional `days` input (each base's step day). It belongs there, not in the callers, because the rule depends on where email j−1 was actually placed, after its window and cap moves. Only `planTimes`'s loop knows that. A caller could only add the floor by re-running the planner email by email, which would duplicate the loop.

Both production callers now pass `days`:
- `planCampaign`, used by Start.
- `replanForward`, used by Resume, a late Approve and the #359 catch-up in the nightly pass.

Only the direct cap-logic unit tests call `planTimes` without `days`. Those tests check capCheck placement against fixed times, not a sequence. If `days` and `bases` differ in length, `planTimes` throws.

**Reschedule is unchanged** (`rescheduleNurtureEmail`). It still applies the window, the sequence's order and the hard caps, and deliberately does not apply the gap rule, so a person can tighten two emails to the 48-hour cap on purpose. A comment at the order check in `services/messaging/index.js` now says so.

**The trade-off Beau should know about.** Because each weekend push now carries every later email with it, a campaign can run a few days longer than its nominal span (see the Span column above; no_show_recovery goes 21 → 26 days). This is the brief's rule ("it may be longer when the window moves an email later"), stated here so it isn't a surprise.

### Before and after, d0/d7/d16/d30/d50 (wanted 7,9,14,20)

Measured by running the develop 7eb4009 engine and this branch's engine side by side at each fixed instant (America/Chicago). For `replanForward`, every email is un-planned, the #359 catch-up shape.

| Instant | replanForward before | replanForward after | planCampaign before | planCampaign after |
|---|---|---|---|---|
| Wed 14:00 | 7,9,14,20 | 7,9,14,20 | 7,9,14,20 | 7,9,14,20 |
| Wed 17:00 | **6**,9,14,20 | 7,11,14,21 | **6**,9,14,20 | 7,11,14,21 |
| Fri 15:59 | 7,10,14,21 | 7,10,14,21 | 7,10,14,21 | 7,10,14,21 |
| Fri 16:01 | **4**,10,14,21 | 7,9,14,20 | **4**,10,14,21 | 7,9,14,20 |
| Fri 17:00 | **4**,10,14,21 | 7,9,14,20 | **4**,10,14,21 | 7,9,14,20 |
| Sat 12:00 | 7,**7**,14,21 | 7,9,14,20 | 7,**7**,14,21 | 7,9,14,20 |
| Sun 23:30 | 7,**8**,14,20 | 7,9,14,20 | 7,**8**,14,20 | 7,9,14,20 |
| Mon 08:00 | 7,9,14,20 | 7,9,14,20 | 7,9,14,20 | 7,9,14,20 |
| Fri 10-30 17:00 CDT (before fall-back) | **4**,10,14,21 | 7,9,14,20 | **4**,10,14,21 | 7,9,14,20 |
| Mon 11-02 17:00 CST (after fall-back) | **6**,9,14,20 | 7,9,14,20 | **6**,9,14,20 | 7,9,14,20 |
| Fri 03-12 17:00 CST (before spring-forward) | **4**,10,14,21 | 7,9,14,20 | **4**,10,14,21 | 7,9,14,20 |
| Mon 03-15 17:00 CDT (after spring-forward) | **6**,9,14,20 | 7,9,14,20 | **6**,9,14,20 | 7,9,14,20 |

Wed 17:00 "after" is 7,11,14,21. The first email lands Thu 09:00 and day 16 falls on a Saturday, so it moves to Monday. That gap is longer than the sequence's, never shorter.

## Clock-dependent tests: the audit

I searched every test file and verifier added by #360 for `Date.now()` and `new Date()` reaching planned times. I also looked for any route or service call that reads the wall clock on a test's behalf, such as the route's `new Date()` and `runForOffice` with no `now`.

| Where | What read the wall clock | Feeds planned times? | Now |
|---|---|---|---|
| `routes/tc/nurture.js` Start (`POST /enrollments`) and `lifecycle()` (Pause/Resume/Stop/Patient replied) | `const now = new Date()` | **Yes.** Start anchors the plan, and Resume re-plans. | **New clock seam** `router.setClockForTests(fn)` / `router.resetClock()`, the same pattern as `services/messaging`'s clock. No request, header or env var reaches it. |
| `tcNurtureApprove.test.js` Resume test (was :793) | `Date.now() − 20 days` for `enrolledAt`, plus `Date.now()` as the floor | **Yes. This is the CI failure.** | Runs at four fixed instants (Tue 09:00, Wed 17:00, Fri 17:00, Sat 12:00) through `fixClock`, which now pins both the messaging and the route clocks. |
| `tcNurtureApprove.test.js` Start test | The route's `new Date()`, through the API | **Yes.** | `fixClock(t)` pins it to `NOW` (Tue 2026-12-01 09:00 CST). |
| `tcNurtureApprove.test.js` Start and completion tests: `generator.runForOffice({…})` with no `now` | The generator's default `now = new Date()` | **Yes.** The catch-up and the completion sweep plan from `now`. | Pass `now: NOW`. |
| `tcNurtureApprove.test.js` skip and completion tests: `sent_at: new Date().toISOString()` (4 places) | The time a sent email counts against the caps | **Indirectly.** These feed `fixed` for any re-plan. | `NOW.toISOString()`. |
| `tcNurtureApprove.test.js` `seedCase` `updated_at: new Date()` | Case metadata | No | Left as is. |
| `tcNurturePlan.test.js` | None | — | Every instant is already fixed. |
| `tcNurtureLibraryGenerator.test.js` `updated_at: new Date()` (seed); every `runForOffice` passes a fixed `now` | Case metadata | No | Left as is. |
| `test/tcMessagesScheduledMigration.test.js` | None | — | — |
| `scripts/tc-nurture-approve-verify-queries.js` real routes (Start, approve, approve-all, reschedule, stop) | The route and messaging clocks: the wall clock | **Yes.** | Both are pinned for the whole run to `VERIFY_NOW` = Sat 2026-12-05 12:00 CST, outside the window, and reset in `finally`. The Start step now also asserts the gap rule and "nothing before now". |
| `scripts/tc-nurture-approve-verify-queries.js` the CHECK probe (`approved_at`/`scheduled_for: new Date()`) and `now()` in SQL | Probe rows for the CHECKs | No | Left as is. |
| `scripts/tc-nurture-library-verify-queries.js` `lastTouchAt: new Date()` in the app-role grant probe; `runForOffice` already uses a fixed `now` | A column value for a grant probe | No | Left as is. |
| Dashboard: `tc-nurture-approve.test.tsx`, `tc-nurture-approve-shots.test.tsx`, `fixtures/tcNurtureCampaign.ts` | None. The fixture times are the planner's output, frozen in `tc-nurture-crown-campaign.json`. | — | — |
| Dashboard app code: `campaignCopy.ts` `officeDateTimeParts(null)` → today | The Change-date form's default when there is no planned time | No (UI default, not a test) | Left as is. |

## Edits to tests added by #360 (before → after)

These are the only test edits. All are in tests #360 added, and each one pins the clock or asserts the new rule. No other existing test was edited, and no other existing test failed.

**`backend/services/tcNurture/tcNurturePlan.test.js`** (assert the new rule):

1. "planCampaign: enrollment day + step day at 10:00; a weekend step moves to Monday". Steps 0/2/7, starting Thu 12-03:
   - **Before:** expected the third email `'Thu 2026-12-10 10:00'`, which is 3 days after the second email (placed Mon 12-07), against a sequence gap of 5.
   - **After:** expects `'Mon 2026-12-14 09:00'`, which is 12-07 + 5 = Sat 12-12, moved to the window's next opening. The old expectation pinned the defect.
2. **Added** "the sequence-gap rule: planCampaign AND replanForward, every sequence, at every awkward instant". This is the table-driven test from the brief:
   - **Instants (12):** Wed 14:00, Wed 17:00, Fri 15:59, Fri 16:01, Fri 17:00, Sat 12:00, Sun 23:30, Mon 08:00, and the day before and the day of each DST change (fall-back 11-01, spring-forward 03-14).
   - **Sequences (8):** every distinct sequence of the four tracks, including the procedure variants that skip a stage.
   - **Three shapes:**
     - `planCampaign`
     - `replanForward` with nothing planned (the #359 catch-up)
     - `replanForward` of a plan made 20 days earlier (Resume)
   - **Asserts:** every gap is at least the sequence's gap in local days; times strictly increase; every time is inside the send window; `capViolation === null`; nothing is before `now`; and on Resume, nothing moves earlier.
3. **Added** "the sequence-gap rule, exact: d0/d7/d16/d30/d50…". It pins 7,9,14,20 from Fri 17:00, Sat 12:00 and Sun 23:30, and 7,11,14,21 from Wed 17:00. It also pins the exact Fri 17:00 re-plan, starting Mon 2026-12-07 09:00.

**`backend/routes/tc/tcNurtureApprove.test.js`** (pin the clock, assert the rule):

4. `fixClock(t, at)`:
   - **Before:** pinned only `messaging`'s clock.
   - **After:** also pins the route clock (`require('./nurture').setClockForTests`) and resets both.
5. **Added** the helper `assertGapsKept(times, steps, label)`, the same gap assertion the Resume test already made inline.
6. Start test:
   - **Before:** no clock pin; `runForOffice({…})` with no `now`.
   - **After:** `fixClock(t)`; asserts `assertGapsKept` and that no planned time is before `NOW`; `runForOffice({…, now: NOW})`.
7. Skip test:
   - **Before:** `sent_at: new Date().toISOString()`
   - **After:** `sent_at: NOW.toISOString()`
8. Completion test:
   - **Before:** `sent_at: new Date().toISOString()` ×2; `runForOffice` ×2 with no `now`.
   - **After:** `NOW.toISOString()` ×2; `now: NOW` ×2.
9. Resume test (was :793):
   - **Before:** `enrolledAt = Date.now() − 20 d`; floor `start = Date.now()`; one run on the wall clock; gaps asserted inline.
   - **After:** a loop over four fixed instants (Tue 09:00 = `NOW`, Wed 17:00, Fri 17:00, Sat 12:00). Each run:
     - calls `fixClock(t, now)` and seeds `enrolledAt = now − 20 d` on a fresh case;
     - asserts nothing is before `now`, `assertGapsKept`, the caps, the send window, and that approvals are kept;
     - finds the `nurture_resumed` event by its case, and counts the replanned audits per run.

   The test makes the same claims it made before. Only the clock changed, and it now covers the instants that broke CI.

**`backend/scripts/tc-nurture-approve-verify-queries.js`** (pin the clock, assert the rule):

10. Both route clocks are pinned to `VERIFY_NOW` (Sat 12:00 CST) after boot and reset in `finally`. The Start step adds gap and "not before now" assertions. The header comment says so.

**Proof the new tests catch the defect.** I swapped develop's `engine.js` back in temporarily, then restored it:
- `tcNurturePlan.test.js`: 3 fail, including `planCampaign Wed 14:00 warm_followup/filling [1,3,6,…] gap 2 is 2 local days, the sequence says 3`.
- `tcNurtureApprove.test.js`: the Resume test fails with `Wed 17:00 gap 1 kept (6 < 7)`.

## Faked-clock runs

I used a preload, `fake-clock.cjs`, which shifts `Date.now()` and a no-argument `new Date()` to `FAKE_NOW` and lets the clock keep ticking. It is loaded through `NODE_OPTIONS=--require`, so it reaches every test subprocess. A probe test inside `node --test` printed `SUBPROCESS NOW 2026-12-05T18:00:00.013Z 6`, which is a Saturday.

**The Resume route test, isolated:**

```
== FAKE_NOW=2026-12-05T18:00:00.000Z   (Sat 12:00 CST)
ok 1 - Resume re-plans the late emails forward from now: order and gaps kept, caps hold, approvals kept, never bunched
# pass 1
# fail 0
== FAKE_NOW=2026-12-02T23:00:00.000Z   (Wed 17:00 CST)
ok 1 - Resume re-plans the late emails forward from now: order and gaps kept, caps hold, approvals kept, never bunched
# pass 1
# fail 0
```

**Both real-Postgres verifiers.** The setup was a throwaway `postgres:16` container, `migrate.js up` and `migrate-tenant.js up --tenant carein`, the same as CI. The verifiers ran under `FAKE_NOW=2026-12-05T18:00:00.000Z`:

```
=== approve verifier, FAKE_NOW Sat 2026-12-05 12:00 CST ===
process now: 2026-12-05T18:00:00.000Z
Part A (one transaction, rolled back):
  ok  scheduled CHECK: each missing field is refused (NULL-safe), the complete row accepted
  ok  skip_reason + status CHECKs: unknown reason, a reason on a non-skipped row, unknown status — refused
  ok  POST /enrollments (real route): the enrollment + all 5 steps as drafts with scheduled_for, in one transaction
  ok  POST /enrollments: a render failure writes NOTHING (no enrollment, no messages, case unmoved)
  ok  approve → scheduled (CHECK satisfied); unapprove → draft; approve-all; reschedule
  ok  Stop: every scheduled email → skipped with stopped_by_user (the CHECK accepts it)
  ok  carein_app: the approve UPDATE and the stop's cancel UPDATE work (no new grants needed)
Part B (1795600000000_tc_messages_scheduled down → up):
  ok  down(): the four columns are gone and 'scheduled' is out of the status CHECK
  ok  up() again: columns, the widened status CHECK and both new CHECKs are back
tc nurture approve-up-front verification passed: 7 part-A checks; down/up verified

=== library verifier, FAKE_NOW Sat ===
Part A (one transaction, rolled back):
  ok  store: insert with procedure + variant; read back through the contract
  ok  store: a row without library columns is unaffected (item-47 shape), reads back null
  ok  CHECK refuses: procedure without variant, variant without procedure, variant D
  ok  generator: one real pass writes EVERY step of a #359-era library enrollment; a second pass writes nothing
  ok  carein_app: inserts a library enrollment and claims it (no new grants needed)
Part B (1795500000000_tc_nurture_library down → up):
  SKIP down/up: the newest applied migration is 1795600000000_tc_messages_scheduled, not 1795500000000_tc_nurture_library
tc nurture library verification passed: 5 part-A checks; down/up SKIPPED
```

The approve verifier also passed on the real wall clock. The library verifier's down/up skip is by design: 1795600000000 is newer, the same as in CI.

## Gates

| Gate | Saturday clock (`FAKE_NOW` Sat 2026-12-05 12:00 CST) | Real clock |
|---|---|---|
| Backend `node --test` | 5,247 tests: 5,244 pass, **0 fail**, 3 skipped | 5,247 tests: 5,244 pass, **0 fail**, 3 skipped |
| Dashboard `pnpm run test` | 237 files passed (43 skipped); 3,417 tests passed, **0 fail** (264 skipped) | 237 files passed (43 skipped); 3,417 tests passed, **0 fail** (264 skipped) |
| Dashboard `pnpm run check` (`tsc --noEmit`) | — | **clean** |
| `node --check server.js` | — | OK |

Backend has 5,247 tests, which is #360's 5,245 plus the two new planner tests. The Resume test is one test that now runs at four instants.

## Files changed

- `backend/services/tcNurture/engine.js`:
  - the sequence-gap rule inside `planTimes` (the `days` input);
  - `planCampaign` and `replanForward` pass `days`;
  - the header comments describe the rule.
- `backend/routes/tc/nurture.js`: the test-only clock seam; Start and `lifecycle()` read `clock()`.
- `backend/services/messaging/index.js`: a comment only, in `rescheduleNurtureEmail`. `sendMessage` is untouched.
- `backend/services/tcNurture/tcNurturePlan.test.js`, `backend/routes/tc/tcNurtureApprove.test.js`, `backend/scripts/tc-nurture-approve-verify-queries.js`: as listed above.
- `docs/reports/fix-tc-nurture-plan-gaps.md`: this report.

## Notes for the reviewer

- **Campaigns already written.** Campaigns Start wrote under #360 keep their planned times. This fix changes future planning only; there is no backfill and no migration. Any late email in such a campaign is re-planned by the new rule the next time it is resumed or approved late.
- **09:00 after a window push.** An email moved by the window lands at the window's opening, 09:00, not at 10:00. This is unchanged from #360, and it is why some rows above read 09:00.
- **Holidays.** The send window still doesn't know about holidays. This was noted in #360 and is unchanged.

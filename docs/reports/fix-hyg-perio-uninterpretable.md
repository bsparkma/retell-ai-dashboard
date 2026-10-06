# fix/hyg-perio-uninterpretable — item 32

Queue: `pm-prompts/queue/32-hyg-perio-uninterpretable-followups.md`. LANE: RED.
Branch `fix/hyg-perio-uninterpretable` off `origin/develop` @ `52abe86`, the merge of #221.
PR: **#222** → `develop`. Not merged.

## What changed

Since item 31, two surfaces still read an uninterpretable v2 value as "nothing charted". Both are fixed.

### 1. The amend path refuses `AMEND_BASE_UNREADABLE`

- `perioSend.readExamChart` now returns `chartFromMeasures`' `uninterpretable` list as well as `.chart` (`backend/services/hyg/perioSend.js:219-225`).
- New helper `refuseUnreadableBase` (`perioSend.js:239`) returns 409 `AMEND_BASE_UNREADABLE`. Its first sentence names the exam and the position, for example: *"Exam 7001 in Open Dental holds a value CareIN can't read (#3 B gingival margin)."* The raw value is never printed.
- The refusal fires at two points:
  - **Opening a correction** — `beginAmendment` (`perioSend.js:999`). The queue calls this `beginPerioAmendment`. The service entry point is `perioSend.beginAmendment`, which is the only caller that reads Open Dental before calling `visitStore.beginPerioAmendment`. The check runs before `setSendChart`, `visitStore.beginPerioAmendment` and `savePerioDraft`, so nothing in CareIN changes either.
  - **Sending a correction** — `startPerioSend` (`perioSend.js:383`), which also guards the `AMEND_BASE_CHANGED` path. It runs before the diff, because the diff would misname an unreadable position as "not charted". It also runs before `markSending` and `createSend`, and before any Open Dental write.
- The refusal **prevents** a write. It never causes one.
- New code in `HYG_VISIT_ERROR_CODES`: `AMEND_BASE_UNREADABLE` (`new-dashboard/shared/hyg/contract.ts:1198`).

### 2. `unknown` now carries a reason

- `PerioDriftSchema`'s `unknown` member (`new-dashboard/shared/hyg/perio.ts:1082`) gains two fields:
  - `reason: 'unreadable_od' | 'uninterpretable'`, defaulting to `unreadable_od`.
  - `positions: { tooth, surface, kind }[]`, defaulting to `[]`.
- The enum stays closed: any other reason fails the parse.
- An answer that carries no reason parses as `unreadable_od`, which is silent, as before.
- Backend:
  - `perioDrift.unreadableOd()` (`perioDrift.js:81`) covers a failed read, a truncated read, no baseline, and the route's catch.
  - `driftAnswer` returns `uninterpretable` with positions and strips `raw` (`perioDrift.js:247`).
- Screen (`PerioDriftNotice.tsx:144`):
  - `unreadable_od` renders nothing. Item 14's ruling stands.
  - `uninterpretable` renders one quiet, neutral `text-muted-foreground` line with no amber, no icon and no button: *"Open Dental holds a value here CareIN can't read (#3 B gingival margin). Check it in Open Dental."*
  - With several positions, the line names three and counts the rest.
- Shared wording: `perioUnreadableRef` and `perioUnreadableList` (`new-dashboard/shared/hyg/perioSend.ts:806, 820`). The screen line and the refusal use the same helpers, so they can never name a position two different ways. Mobility names the tooth. A row on a tooth CareIN can't place reads "mobility on a tooth CareIN cannot place".
- `backend/hyg/contract.gen.cjs` was regenerated with the pinned esbuild and `--alias:zod`. The bundle test is green.

### 3. Fold-in: "N readings corrected"

- `PerioSendPanel.tsx:323` now says "reading" / "readings" instead of "site" / "sites".
- **Existing-test edit (the only one):** in `new-dashboard/tests/hyg-perio-page.test.tsx:861`, the pinned string `/1 site corrected · …/` became `/1 reading corrected · …/`. This is a copy change only. The rest of that regex and every other assertion in the file are unchanged.

## Acceptance

| # | Row | Test |
|---|---|---|
| 1 | Amend refuses `AMEND_BASE_UNREADABLE`, naming the position; nothing is written | `backend/routes/hyg/hygPerioUninterpretable.test.js`, three tests:<br>• *"Amend on an exam holding an uninterpretable value…"* snapshots Open Dental's order, posts and deletes plus CareIN's staged and send rows. All are unchanged and the chart stays `Written`.<br>• *"…turns uninterpretable AFTER Amend refuses at send time"* — no exam is posted and nothing is deleted.<br>• *"a fully readable exam still opens"* checks the refusal isn't blanket. |
| 2 | A transient Open Dental read failure still renders nothing | Backend *"ACCEPTANCE 2"*: 503 → `{unknown, unreadable_od, positions: []}` and no audit row.<br>Dashboard `tests/hyg-perio-uninterpretable.test.tsx` *"ACCEPTANCE 2"*: empty render, the legacy no-reason answer parses as `unreadable_od` and renders nothing, and a bogus reason is refused. |
| 3 | The quiet line names tooth + surface + family; no Send again, no amber | Backend *"ACCEPTANCE 3"*: the positions are exact and carry no `raw`.<br>Dashboard *"ACCEPTANCE 3"*: exact text, no resend, changed or missing testids, no button, no svg, no amber or destructive class. A multi-position case covers mobility and "and 1 more". |
| 4 | Every reader of drift `status` handles `reason` | The list below. |
| 5 | "N readings corrected" | Dashboard *"ACCEPTANCE 5"*: three amendDiff lines give `3 readings corrected`. The pinned page test covers the singular. |

### Row 4: every reader of drift `status` and of `PerioDriftNotice` props

Found by grepping `backend/` and `new-dashboard/{client,shared,server}`, excluding tests and the generated bundle.

| File:line | Reads | How it handles `reason` |
|---|---|---|
| `backend/services/hyg/perioDrift.js:174` | list read not ok → `unknown` | `unreadableOd()` |
| `backend/services/hyg/perioDrift.js:196` | no baseline → `unknown` | `unreadableOd()` (silent, as before) |
| `backend/services/hyg/perioDrift.js:206` | measures read failed or truncated → `unknown` | `unreadableOd()` |
| `backend/services/hyg/perioDrift.js:247` | `driftAnswer` unreadable → `unknown` | `reason: 'uninterpretable'` plus positions, with `raw` stripped |
| `backend/routes/hyg/visit.js:1034` | the drift check threw → `unknown` | `perioDrift.unreadableOd()` |
| `backend/routes/hyg/visit.js:1088-1097` | drift audit | `perioDrift.driftDiscloses` audits `missing`, `changed` and `unknown`/`uninterpretable`; `unreadable_od` is not audited. Fix round 1. |
| `backend/routes/hyg/visit.js:1122-1123` | log line `drift=` | logs `unknown:<reason>` (an enum only, never a position) |
| `new-dashboard/shared/hyg/perio.ts:1082` | `PerioDriftSchema` | `reason` and `positions`, both with defaults |
| `new-dashboard/client/src/features/hyg/perio/PerioDriftNotice.tsx:77` | `missing` | unchanged |
| `new-dashboard/client/src/features/hyg/perio/PerioDriftNotice.tsx:105` | `changed` | unchanged |
| `new-dashboard/client/src/features/hyg/perio/PerioDriftNotice.tsx:144` | `unknown` | `uninterpretable` gets the quiet line; `unreadable_od` falls through to `null` |
| `new-dashboard/client/src/pages/hyg/HygPerio.tsx:828` | builds `drift` from the prior response | passes it through unchanged |
| `new-dashboard/client/src/pages/hyg/HygPerio.tsx:1066` | renders `PerioDriftNotice` | props unchanged; the comment above it is updated |
| `new-dashboard/client/src/pages/hyg/HygPerio.tsx:1371` | `missing` → resend dialog | `missing` only; `unknown` never reaches it |
| `new-dashboard/client/src/features/hyg/api.ts:621` | doc comment on `fetchPerioPrior` | comment updated; the parse uses the schema above |

## Gates (local, before push)

- Backend:
  - `npm ci` ok.
  - `node --check server.js` ok.
  - `node scripts/shard-runner.mjs`: 4 shards all green, 2988 tests, 2985 pass, 0 fail, 3 skipped.
- Dashboard:
  - `pnpm install --frozen-lockfile` ok.
  - `pnpm run check` (tsc) clean.
  - `pnpm run test`: 129 files, 2203 passed, 149 skipped.
- **First run was red, and the cause was mine.** (Superseded by fix round 1, which adds the audit back on Beau's ruling with an explicit update to ACCEPTANCE 8.) I had also made `unknown`/`uninterpretable` write a `hyg_perio_drift` audit row (`prior_state 'unknown:uninterpretable'`). The existing item 31 test `hygPerioV2Drift.test.js:417` (ACCEPTANCE 8) pins that `unknown` writes no audit row. Rather than touch that assertion, I removed the audit (commit `5bc0dd3`). The full suite is green after that.

## Reviewer

A fresh-context reviewer subagent got the queue file and `git diff origin/develop...HEAD`.

- **Round 1: PASS.** All rows were built and tested, and the row-4 reader list matched an independent grep. The refusal fires before every CareIN and Open Dental state change. `odPerioWriter.js` and the migrations are untouched. The only existing-test edit is the copy string.
- **Round 2** (after the audit revert): **PASS**. No other existing test conflicts: backend `routes/hyg` + `services/hyg` 352 pass, including ACCEPTANCE 8, and dashboard `tests/hyg*` 418 pass. The bare `{status:'unknown', examNum}` fixtures in existing tests still pass via the default.

## CI

PR #222, `build-test`: **pass** (4m20s). Run 37394956908 on head `519ffc9`. It checked out `refs/remotes/pull/222/merge` at `93d0eee`, the merge tree, not just the branch head. No flakes. No fix pushes were needed. The only later push is this docs-only report update.

## Staging test steps

Use test patients only: roland **12827**, or valley **7115**. Do not use 11373.

1. Chart and send a perio exam for 12827 through CareIN so it reaches `Written`. Include a recession at #3 B.
2. In Open Dental's perio chart for that exam, set #3 B's gingival margin to a value in neither family (for example 50). If OD's UI won't accept it, use a furcation class of 5 or a mobility grade of 7 through the API on staging.
3. Reopen the chart in CareIN. You should see one grey line: "Open Dental holds a value here CareIN can't read (#3 B gingival margin). Check it in Open Dental." There should be no amber notice and no Send again.
4. Press **Amend chart**. It should refuse with "Exam N in Open Dental holds a value CareIN can't read (#3 B gingival margin). …". The chart stays Written, and Open Dental shows no new exam and no deletion.
5. Put the value back to a readable one in Open Dental and reopen the chart. The line disappears and Amend opens normally.
6. Make a correction that changes two readings and send it. The panel should say "2 readings corrected · …".
7. Optional, to check item 14 is unchanged: with Open Dental unreachable, reopen the chart. Nothing is drawn beside the Written line.

## Fix round 1: auditing the uninterpretable answer

**Ruling (Beau):** naming an uninterpretable position MUST write an audit row. The route's own doctrine says "naming teeth is the disclosure, so naming teeth is what audits", and the standing rule is that an audit equals a disclosure and fails closed.

**Built:**
1. **Route** (`backend/routes/hyg/visit.js:1088-1097`).
   - A drift answer audits when `perioDrift.driftDiscloses(drift)` is true (`perioDrift.js:263`): for `missing`, `changed`, and `unknown` with `reason 'uninterpretable'`.
   - It writes one row with the same shape as `missing`/`changed`: `READ` · `hyg_perio_drift` · `resource_id` = aptNum · `office`.
   - `prior_state` is `unknown:uninterpretable`, which fits the `audit_log_prior_state_check` grammar.
   - `source_ref` comes from `perioDrift.driftAuditRef` (`perioDrift.js:280`): `perio_exam:<N>` for `missing`/`changed`, unchanged, and `perio_exam:<N>;<tooth>-<surface>:<family>,…` for `uninterpretable`, e.g. `perio_exam:7001;3-B:gm,30:mobility`.
   - The `tooth-surface` form matches the existing `hyg_perio_amend_site` rows. `x` stands in for a tooth Open Dental didn't number.
   - Identifiers only: the raw value was already dropped by `unreadablePositions` and never reaches the audit.
   - `unreadable_od` is still not audited. The write is fail-closed through the same `audit()` call: if it fails, the request returns 500 `AUDIT_FAILED` and no answer is served.
2. **New audit vocabulary, and its readers.** `unknown:uninterpretable` is a new `prior_state` value, and the `source_ref` shape is new for this row. Repo-wide grep (excluding `node_modules` and `contract.gen.cjs`) for readers of `hyg_perio_drift` rows, `prior_state` and `source_ref`:
   - **Production:** the generic platform audit viewer.
     - `backend/routes/platform.js:356-375` filters on `resource_type`/`resource_id` and selects `source_ref` without parsing it. It does not select `prior_state`.
     - `new-dashboard/client/src/pages/platform/PracticeAuditPanel.tsx:250-251` displays `resourceType` and `resourceId` as text.
     - Neither needs a change.
   - **Tests:**
     - `backend/routes/hyg/hygPerioDrift.test.js:93, 414-432` covers item 14's `missing`/`changed` rows. Its `/^perio_exam:\d+$/` loop sees only `missing` rows, and that format is unchanged.
     - `backend/routes/hyg/hygPerioV2Drift.test.js:89` (ACCEPTANCE 8, below).
     - `backend/routes/hyg/hygPerioUninterpretable.test.js:85`.
   - **Docs:** `docs/reports/feature-hyg-perio-drift.md:77, 178` is item 14's historical report and was left as history.
3. **Item 31's ACCEPTANCE 8** (`hygPerioV2Drift.test.js`) was updated explicitly, and **this is a premise update, not a weakening.**
   - The old assertion, "`unknown` says nothing, so it discloses nothing", was pinned when `unknown` named nothing.
   - Since item 32, the `uninterpretable` answer names a position on screen, so the old premise no longer holds.
   - Each of the six uninterpretable cases now expects **exactly one** row with `resource_type hyg_perio_drift`, `prior_state unknown:uninterpretable` and an exact identifiers-only `source_ref`.
   - A new block in the same test proves `unreadable_od` (a 503 on `/perioexams`) still writes **no** row.
   - Nothing else in that test changed: the cases, their labels, the status/examNum/schema assertions and the "unreadable doesn't hide a readable change" block are untouched.
4. **Fail-closed test** (`hygPerioUninterpretable.test.js`). It fails only the drift row's INSERT, so the route's earlier read audits still land. Then it runs `changed` and `uninterpretable` side by side and asserts both get 500 `AUDIT_FAILED`, no `drift` in the body, no position named, and no drift row.
5. **Doctrine comments.** The route comment above the audit now says `unknown`/`uninterpretable` audits and why. The `perioDrift.js` header says the same.

**Mutation check:** with `driftDiscloses` forced to `false` for `uninterpretable`, four tests fail (ACCEPTANCE 3, the fail-closed test, the helper test, and item 31's ACCEPTANCE 8). The file was restored, and the gates below ran on the real code.

**Gates (fix round 1):**
- Backend: `npm ci` ok; `node --check server.js` ok; shard-runner 4/4 green with 2990 tests, 2987 pass, 0 fail, 3 skipped.
- Dashboard: `pnpm install --frozen-lockfile` ok; `pnpm run check` clean; `pnpm run test` 2203 passed, 149 skipped.

**Reviewer (fix round 1):** **PASS** in one round. It confirmed:
- Items 1-5 are done, and only ACCEPTANCE 8 changed in `hygPerioV2Drift.test.js`.
- The fail-closed test fails only the drift INSERT and covers both `changed` and `uninterpretable`.
- `source_ref` carries identifiers only, and the raw value appears nowhere in the row.
- No non-test code parses `hyg_perio_drift` rows. The generic platform viewer only filters and displays them.
- Its one non-blocking note was that this report still said `unknown` was unaudited. That is fixed here.

**CI (fix round 1):** FIX_CI

## Deliberately not built

- No change to `odPerioWriter.js`, no migration, and no change to `counts.empty` or `perioHasReading`.
- The no-baseline case (a send that predates item 13) is filed under `unreadable_od`. It is silent, as before, because the queue allows only two reasons.
- `visitStore.beginPerioAmendment` (the DB transition) has no Open Dental read and was left alone. The guard sits in its only Open Dental-reading caller. `backend/scripts/rehearse-hyg-visit.js` calls the DB transition directly as a rehearsal tool and is unchanged.

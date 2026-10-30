# CO-4b: OD-driven pipeline sync

Branch `feature/tc-od-pipeline-sync` → `develop`. Beau's rulings, 2026-10-30:
- read-only signals;
- act on unambiguous signals only;
- every change gets a badge, an Undo and an audit row;
- a per-office switch, default OFF.

Builds on CO-4a's appointment anchor (PR #298, merged).

## Decisions for Beau

**Ships dark. To turn it on for an office:**
- Use Platform → TC Checkout → "TC Open Dental pipeline sync", which stores `platform_setting['tc_od_sync_enabled'] = {"roland": true}`.
- `TC_OD_SYNC_ENABLED_<OFFICE>=false` in the environment always wins, as a break-glass.

**Prod nightly job.** Prod's 02:30 job runs every night, but the Opportunities sync has never been switched on, so it does nothing. Details are under "Prod nightly job" below. Until that is fixed, Opportunities shows "Not synced yet" in prod. The new pipeline sync rides the same cron but has its own switch, so it does not depend on the Opportunities fix.

**The real-Postgres verifier is not wired into CI.**
- This PR's guardrails rule out `.github/` changes, so CI does not run `backend/scripts/od-sync-verify-queries.js`. It passed 9/9 locally against a migrated Postgres 16.
- To have it run in CI, add one step to `build-test.yml` after the checkout-anchor verifier, with the same `MIGRATE_TENANT_DB_URL` env:
  ```yaml
  - name: od pipeline sync verification (real statements, real rows, real schema)
    working-directory: backend
    env:
      MIGRATE_TENANT_DB_URL: postgres://carein_owner:carein_owner_devpw@localhost:5432/carein_t_carein
    run: node scripts/od-sync-verify-queries.js
  ```

**Two interpretations:**
- **"Follow-up / not-scheduled column" = `pending_pt` ("Pending Patient").** There is no column with that name. `pending_pt` is where checkout's own "Not scheduled" outcome puts a case, so a broken or unscheduled appointment lands in the same place.
- **The badge reads "Moved by Open Dental sync" for every automatic change, including a reschedule.** A reschedule does not change the column; its timeline note says "Rescheduled in Open Dental: old → new".

## What it does

**Which cases it follows:**
- Cases in `scheduled` whose Scheduled checkout carries a CO-4a anchor.
- For each one it makes a single read-only `GET /appointments/{AptNum}` to that case's own office.
- It acts only on these signals:

| Open Dental says | What the sync does |
| --- | --- |
| `Complete` | case `scheduled → completed`. It leaves the board the same way a manual Completed move does: a `status_change` event, and a nurture enrollment stops. |
| `Broken` or `UnschedList` | case `scheduled → pending_pt`. The anchor stays on the checkout as history. |
| `Scheduled` at a new date or time | the anchor's time follows Open Dental. A note "Rescheduled in Open Dental: 2026-11-04 09:00 → 2026-11-06 13:30" is added. **No column move.** |
| `Scheduled` at the same time | nothing happens (a stale flag is cleared). |
| 404, any other status (`Planned`, `PtNote`, `ASAP`, …), another patient's PatNum, or two appointments linked to one case | **FLAG** "Open Dental no longer matches — check". Nothing else is touched. |

**Every automatic change:**
- shows a "Moved by Open Dental sync · <time>" badge on the card and in the Pipeline's sync strip;
- writes its own audit row (`tc_case.od_sync_<kind>`, `prior_state='scheduled'`, `source_ref='od_sync_run:<id>'`), as `system:od_pipeline_sync`;
- has an **Undo**, which reverts the case or the anchor's time and is audited as `tc_case.od_sync_undo` with the prior state.

**After an Undo:**
- The engine stores the Open Dental state that was undone, as a fingerprint: AptNum, status and minute.
- It will **not** make the same move while Open Dental still shows that state.
- Once Open Dental shows a different state, the hold is released.

**Unanchored Scheduled cases** are counted and shown as "N scheduled cases can't be tracked (no appointment linked)". They are never read and never guessed.

## Fail closed, per office

**Reads come first.** Every read for the office happens before any write. If one read *fails*, the run is recorded as `failed` and **nothing** is applied, not even the reads that succeeded. A failed read means any of:
- a timeout or 5xx;
- a 200 that isn't the appointment;
- a 404 saying the key can't reach `/appointments`;
- an office that isn't OD-ready.

A plain 404 is an answer: the appointment is gone, so the case is flagged.

**Before applying:**
- The switch is re-read; an office switched off mid-run gets nothing written.
- Each case's change re-checks and locks its anchor inside the transaction. A re-link, a cleared anchor, or a human status move during the sweep is a race the person wins.
- Each change's audit row is written **inside its transaction**, so a failed audit write rolls the change back.

**Switch OFF means nothing happens:** no read, no run row, no flag, no audit row. This holds for Sync now, the engine, and the nightly pass, and a test proves it with anchored cases present.

## Triggers

**Sync now (Pipeline page, `tc.full`):**
- `POST /api/tc/od-sync/run?office=` answers 202 and runs in the background. The strip polls `GET /status` until the run finishes, then re-reads the board.
- One manual run per 5 minutes per office (429 `OD_SYNC_RATE_LIMITED` + `Retry-After`), read from the stored runs, so a restart doesn't reset it.
- The strip shows "Last run Oct 30, 2:34 AM (nightly): 3 completed, 1 moved, 2 flagged".
- This follows voice's `sync-now` pattern: the person is credited (`CREATE tc_od_sync_run`), and the system's changes are audited under the system actor.

**Nightly:**
- `services/tcOpportunities/scheduler.js` `runNow()` runs the Opportunities pass, then the pipeline sync, at 02:30 America/Chicago.
- Each pass has its own switch and neither gates the other.
- One caveat: `TC_OPPS_SYNC_DISABLED=true` stops the nightly cron, so it also stops the nightly pipeline sync. Sync now is unaffected. This is documented in the code.

**Throughput limits:**
- At most 200 reads per office per run (`TC_OD_SYNC_MAX_PER_RUN`). The least recently checked cases go first, so the cap rotates.
- Reads are paced at ≥ 1200 ms on the shared OD pacer, with a 15 s timeout.

## Prod nightly job (read-only investigation)

**Root cause:** the prod cron runs every night and finds no switch row.
- From 10-17 to 10-30, Log Analytics for `ca-carein-prod-backend` shows `[tcopps] nightly sync skipped: NO_SETTING_ROW` at 02:30 every night.
- Each boot logs the job as scheduled.
- There has never been an `office=… status=…` line.

**Ruled out:**
- **Scaling:** prod has `minReplicas=1` and `maxReplicas=1`, so the container does not scale to zero.
- **Env vars:** no `TC_OPPS_*` variables are set, so nothing disables the job.
- **Stale image:** the deployed image contains the sync code.

Staging has the row and syncs nightly, for example `office=valley status=ok … ms=678983`.

**Why "Not synced yet":** the UI shows it when `tc_opportunity_sync` has no `last_synced_at` or `last_attempt_at`. Only a real pass writes that row.

**The enabling step, supervised, against the prod CONTROL DB:**
- No console toggle exists for this switch; it is runbook-only.
- The statement:
  ```sql
  INSERT INTO platform_setting (key, value, updated_by)
  VALUES ('tc_opportunities_sync', '{"roland": true}'::jsonb, '<your email>')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now();
  ```
- Add `"valley": true` to include Riley.
- No restart is needed; the next 02:30 pass reads the row.
- The next morning, confirm `[tcopps] office=roland status=ok` in the logs.

**Capacity note:** staging's valley pass uses 540 of the 600-page cap (`TC_OPPS_MAX_PAGES`) in 11.3 of its 14 minutes. If prod's valley data is the same size, consider raising `TC_OPPS_MAX_PAGES` before switching valley on. A capped sweep is partial, and a partial sweep applies nothing.

**Not verified (read-only):**
- The prod control DB row's absence, inferred from `NO_SETTING_ROW`.
- Prod tenant entitlement.
- Per-office OD readiness.

## Storage

Migration `1793900000000_tc_od_pipeline_sync`, which is above develop's newest (`1793800000000`, CO-4a); re-checked at push. It is additive and nullable.

**On `tc_cases`, four new columns:**
- `od_sync_action` (jsonb: the standing change behind the badge and Undo);
- `od_sync_flag` (jsonb);
- `od_sync_undone` (jsonb: the no-redo fingerprint);
- `od_sync_checked_at`.

The CHECKs are two-valued, led by `IS NULL`, and enforce the closed vocabularies. Old cases read as untouched.

**New table `tc_od_sync_runs`:**
- One row per sweep of one office, holding counts only: no PatNum, no name.
- The trigger is `manual` or `nightly`; the status is `running`, `ok` or `failed`.
- Granted to `carein_app` CRUD; `PUBLIC` revoked.

**No control-plane migration.** Like `tc_checkout_enabled`, a missing row means OFF.

## Routes

All routes are `tc.full`, under `/api/tc/od-sync`, with `?office=`.

| Route | |
| --- | --- |
| `GET /status` | the switch, the last run and its summary, `nextAllowedAt`, `unanchoredCount`, the standing changes with Undo, and the open flags |
| `POST /run` | Sync now. Refusals: 409 `OD_SYNC_OFF`, 409 `OD_SYNC_IN_PROGRESS`, 429 `OD_SYNC_RATE_LIMITED` |
| `POST /cases/:caseId/undo` | Refusals: 409 `OD_SYNC_NOTHING_TO_UNDO`, 409 `OD_SYNC_UNDO_STALE` (a person has moved the case since). Undo is **not** behind the switch, so turning the sync off can never trap a move. |

**Other changes:**
- The case list adds an additive `odSync` field to each card.
- The platform console adds `GET/PUT /api/platform/tc-od-sync-offices` (super_admin), audited with prior state `on` or `off`.

**Open Dental:** the new read is `odReads.getAppointment`, through CO-4a's office-checked GET-only transport (`checkoutAppointments.odGetForOffice`), with `module: 'tc'`. Both files are already in the existing GET-only pin, so **no existing test was edited**. The engine and its routes have their own pin: no `.client` access and no write verb.

## Tests

**`backend/routes/tc/tcOdPipelineSync.test.js` (29):**
- **Signal map:** every signal maps to one action; the ambiguous ones (404, `Planned`/`PtNote`/`PtNoteCompleted`/`ASAP`/empty/unknown, another PatNum, two anchors) flag.
- **Undo hold:** an undone state is held, and a new state acts.
- **Switch OFF writes nothing:** Sync now gets 409; the engine and the nightly pass make zero OD calls, zero writes and zero audit rows.
- **Precedence:** env `=false` beats a stored true; an unnamed office is OFF.
- **Complete:** the move, the timeline event, a READ audit plus a change audit with prior state, the person's CREATE row, the run row, the status panel, and the card field.
- **Broken / UnschedList:** the case goes to `pending_pt` and the anchor is kept.
- **Reschedule:** the anchor follows, a note is added, and there is no move.
- **Races:** a person's move during the sweep is never overwritten.
- **Undo:** back to scheduled, audited as the user; no redo; a second Undo gets 409; Open Dental changing again acts. Undoing a reschedule restores the time and isn't redone; Undo after a human move gets 409.
- **Cap:** 205 cases → exactly **200** GETs, each with `minIntervalMs ≥ 1200`, a timeout and `module:'tc'`; the next run takes the 5 it didn't reach.
- **Rate limit:** 429 with `retryAfterSeconds` ≤ 300; the other office is unaffected.
- **Office isolation:** the same AptNum in valley is never read or touched.
- **Fail closed:** a 500 on the 2nd of 3 reads gives a failed run and nothing applied (the 1st read is audited); a non-OD-ready office gives a failed run.
- **Unanchored:** counted and never read.
- **Nightly:** only switched-on offices; audited to the TC tenant as the system.
- **GET-only pin** on the engine and its routes.
- **REVIEW (round 1):**
  - a re-link during the sweep wins;
  - an audit failure rolls the change back and the run is marked failed;
  - a garbage 200 or a capability 404 fails closed;
  - a switch-off mid-run applies nothing;
  - an Undo whose audit fails does not stand;
  - the undo hold is released on a new state.
- **REVIEW 2:**
  - an Undo clicked mid-sweep keeps its hold;
  - a flag read never releases a hold;
  - a re-link wins on the flag path;
  - a failure before the apply phase still finishes the run as failed.

**Other test files:**
- `backend/test/odPipelineSyncMigration.test.js` (6): additive and nullable, two-valued CHECKs, the grant, a clean down, the numbering, and the columns present after a full replay.
- `new-dashboard/tests/tc-od-sync.test.tsx` (12, plus 3 screenshot dumps):
  - the strip's last run, untracked count, changes with Undo, and flags;
  - Sync now → polling → the board re-read;
  - cooldown disables the button, and a 429 is said;
  - Undo;
  - a failed run;
  - off and empty renders nothing, while off with standing changes still offers Undo and off with flags still shows them;
  - polling survives a failed read;
  - the card's badge with Undo, the card's flag, and an old card showing neither.
- `backend/scripts/od-sync-verify-queries.js`, a **real Postgres 16** check: 9/9. It runs the real engine, Undo, panel and run reads against a migrated schema (jsonb and NULL params; `ANY($2)` over uuids; CO-4a's wall-clock CHECK still holding after a reschedule), and confirms the schema refuses out-of-vocabulary actions and flags, an undo record with no fingerprint, an unknown trigger, and a non-office run. Everything is rolled back.

**Mutation checks:**
- On the first build, 8 mutations to the engine all turn tests red:
  - unknown status → completed;
  - no-redo removed;
  - switch ignored;
  - partial apply on failure;
  - cap ignored;
  - PatNum check removed;
  - 404 → no change;
  - the move's status CAS removed. This one first survived; the race test was added for it.
- After review round 1, 6 more mutations to the new guards each turn tests red: the anchor re-check, the mid-run switch, the undo audit, the hold release, a garbage 200, and a capability 404.
- After review round 2, 3 more mutations each turn tests red: a flag releasing the hold, the anchor-time re-check, and the failed-run guard.
- On the frontend, removing the poll fix turns a test red.

**Full suites, on the final code:**
- Backend shard-runner: 4511 tests, 4508 pass, 0 fail, 3 skipped.
- Dashboard: 3078 passed.
- `tsc` clean.
- The real-Postgres verifier: 9/9.

## Screenshots (synthetic data)

All in `docs/screenshots/tc/co4b/`, at 1280×900, light and dark:
- `tccheckout-co4b-01-sync-strip`: last nightly run "3 completed, 1 moved, 2 flagged", "2 scheduled cases can't be tracked", two changes with Undo, one flag.
- `tccheckout-co4b-02-cards`: a card moved by the sync (badge plus Undo), a flagged card, and an untouched card.
- `tccheckout-co4b-03-run-failed`: "couldn't reach Open Dental — nothing was changed", with Sync now in cooldown.

## Review

**Round 1 (fresh context): no blockers, 5 should-fix, all fixed.**
1. Phase 2 acted on a stale read. The anchor is now re-checked and locked in the transaction.
2. A change could commit without its audit row. The audit row is now written inside the transaction, and a mid-run error marks the run failed. Undo got the same treatment.
3. A garbage 200 or a capability 404 was read as "gone". Both now fail closed.
4. The poll died after one failed read. It now re-arms on every read, and the error is shown.
5. A mid-run switch-off was not honoured. The switch is now re-read before applying.

**Round 1 nits:**
- **Taken:**
  - the Undo of a Complete says the nurture enrollment stays stopped;
  - the undo hold is released on a different Open Dental state;
  - flags are shown when the switch is off;
  - the opps/pipeline cron coupling is documented.
- **Left:** clearing a flag writes no audit row. It is UI state only and changes nothing.

**Round 2 (the fix commit): 3 should-fix, all fixed.**
1. The undo hold was decided from the sweep's stale snapshot, so an Undo clicked mid-sweep could be wiped and then redone. It is now decided on the locked case row, and every re-check compares the anchor's time as well as its AptNum.
2. A failure before the apply phase left the run at `running`. Any failure after the run row is created now finishes it as `failed`.
3. The hold was released by any different read, including a glitchy flag. It is now released only after a clean read.

**Round 2 nits:**
- **Taken:**
  - the flag path's re-check is now locked in a transaction;
  - raced checks are counted as raced;
  - Undo locks the checkout before the case, the same order every other writer uses.
- **Noted, not changed:**
  - **Pool size:** each in-transaction audit write takes a second connection from the tenant pool (`max: 5`). Under heavy concurrency a write waits up to 10 s and then rolls back. That is safe, not a deadlock.
  - **Rollback tests:** the fake DB's rollback tests emulate ROLLBACK by snapshotting at BEGIN. The real-PG verifier exercises the real savepoints.

## Guardrails

- **Zero Open Dental writes.** GETs only, through the pinned transport.
- **Office:** server-derived everywhere; every statement names it.
- **SQL:** no `SELECT *`.
- **Names:** synthetic only (roland 12827/12828, valley 7115).
- **Code:** TS strict, `tsc` clean.
- **Scope:** no `.github/` or infra changes, nothing deleted, and no existing test edited.

## CI

PR #299, `build-test` on `refs/pull/299/merge`, run 41145050476 at head `0c0efbb`: **green on the first attempt**, with no fix pushes. As noted above, this run did not include the new real-Postgres verifier.

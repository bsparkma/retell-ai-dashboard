# feature/tc-funnel-reporting — queue item 42, "Conversion funnel"

**Lane: RED — NEEDS REVIEW. Do not auto-merge: the build loop (#228) is not live.**
Branch `feature/tc-funnel-reporting` off `origin/develop` @ `e551c65`. PR to `develop`, left open.

## 1. Evidence base — what `tc_case_events` can honestly tell us

Read from the migrations, every writer in `backend/routes/tc/`, the Slice 2 importer
(`new-dashboard/shared/tc/legacy.ts`, `rows.ts`) and the legacy app's own writer
(`TC-app/client/src/contexts/CasesContext.tsx` — code only, no data files opened).

**Table** (`1785373200000_tc_schema.js`): `event_id, case_id, office_id, ts timestamptz NOT NULL,
type, description, actor, detail jsonb, legacy_id` + `source_call_id` (`1786500000000`).
There is **no from/to column**; `detail` is NULL on status changes.

**Event types** (CHECK, 8): `status_change, follow_up_completed, objection_logged, note_added,
case_created, nurture_enrolled, contact_attempt, voice_handoff`.

| Type | Server writers | Carries a transition? |
| --- | --- | --- |
| `status_change` | `cases.js` POST `/:id/status` — `"<from> → <to>"` or `"<from> → <to>: <note>"`; `hygiene.js` claim — `"hygiene_review → pending_tc (claimed)"`. Same transaction as the `tc_cases.status` UPDATE, `ts` = server clock. | **Yes** — from and to as frozen slugs, parsed from `description`. Format unchanged since the first route commit `b45ca46` (2026-08-03). |
| `case_created` | `cases.js` POST `/`, `hygiene.js` submit, `intakeFromCall.js` | Entry into the case's **initial** status (not recorded on the event; = `from` of its first transition, or current status if none — exact, because status cannot change without a transition event) |
| `nurture_enrolled`, `objection_logged`, `follow_up_completed`, `voice_handoff`, `note_added`, `contact_attempt` | various | No |

Status can change **only** through those two routes (PUT is scalar-only; the client events
endpoint accepts only `note_added`/`contact_attempt`), so a native case's history is complete.

**Imported legacy history is NOT reliable** and is excluded:
- the legacy app wrote status changes as free text — `"Moved to <status with spaces>"` or
  `"Accepted — moved forward"` — **no from-status**, client clock;
- an imported event whose legacy id was empty lands with `legacy_id NULL`
  (`legacy.ts:411 legacyId: e.id || null`), so `legacy_id` alone cannot discriminate. The
  `<slug> → <slug>` shape does (the legacy writer never produced it); `legacy_id IS NULL` is a
  second guard;
- an imported case's creation is not an entry (`tc_cases.legacy_id IS NOT NULL` excluded).

**Coverage.** `coverageStartsAt` = the oldest reliable entry (server transition or native
creation) **for the office**. A window that starts earlier is clamped to it
(`window.clampedToCoverage: true` + a note); the UI prints "Since Aug 20, 2026, when status
history begins". Production's actual date was **not measured** (no `az` by rule); given the
2026-08-04 import and the first native prod cases of 2026-08-12/18, expect mid-August 2026.
Deleting a case cascades its events, so deleted cases leave the funnel.

## 2. Rules chosen (each stated in `backend/routes/tc/funnel.js` and in the UI)

- **Accepted** = an entry into `accepted, partially_accepted, scheduled, started, completed`
  (the patient said yes, fully or partly — a case may skip straight to scheduled).
- **Reopened case rule — credited ONCE at the FIRST acceptance.** `accepted → considering →
  accepted` is one win, dated at the first acceptance; the re-acceptance adds nothing; a later
  loss does not retract it.
- **Acceptance rate = cohort**: denominator = cases whose first entry into `presented` falls in
  the window; numerator = those with an acceptance at/after it and before the window end. Each
  case once per side. A case carried in from before coverage has no presented entry and is not
  in the cohort.
- **Value** = the case's **current** `case_value_cents` (events don't snapshot value).
- **Stage conversion** (9 board stages): of cases entering the stage in the window, how many
  later entered a status further along `diagnosed … scheduled, started, completed`; plus how
  many later entered `lost`.
- **Days in stage**: one sample per completed stay (entry → next entry), counted when the stay
  **ends** in the window; median + p90 via `percentile_cont`; open stays counted, never timed.
- **Lost by reason**: once per case; reason is only on `tc_cases`, so a case no longer lost
  reports `null` ("no longer lost — reason not kept").
- **Nurture reactivation**: a win in the window preceded by nurture → open non-nurture status.
- **Every percentage is `null` on a zero denominator** (UI "—"), never 0% or NaN.
- **One office per request.** `/api/tc` has no "all offices" form anywhere (`requireOffice`),
  so none was invented; "rollup" = office totals beside per-stage/per-person breakdowns.

## 3. Endpoint

`GET /api/tc/reports/funnel?office=roland|valley[&from=YYYY-MM-DD][&to=YYYY-MM-DD]`
mounted `router.use('/reports', tcFull, require('./reports'))` under the existing
`requireModule('tc')` mount. Defaults: `to` = today in `OFFICE_TIMEZONE` (America/Chicago),
`from` = `to` − 364 days; max span 366 days. Read-only (SELECTs only, 10 parameterized
statements, no `SELECT *`, run **sequentially** so one page load holds one pool connection).
Audited `READ tc_case` with office (existing vocabulary).

400s: `INVALID_OFFICE` (existing), `INVALID_DATE` (existing string, also used by hyg),
`INVALID_RANGE`, `RANGE_TOO_LONG` (new codes; the client's `tcErrorMessage` falls back to the
message for unknown codes). Empty office ⇒ 200, zeros, null rates, `coverageStartsAt: null`,
`coverageNote`.

Response `{ success, funnel: { office, timeZone, window{requestedFrom,to,fromTs,toTs,clampedToCoverage},
coverageStartsAt, coverageNote, reliableEntries, acceptance{presentedCases, acceptedCases,
acceptanceRatePercent, presentedValueCents, acceptedValueCents, valueAcceptanceRatePercent},
stages[9]{status, entered, progressed, lostAfter, conversionPercent, completedStays, openStays,
medianDays, p90Days}, acceptedByWeek[]{weekStart, wonCases, wonValueCents}, winLoss{wonCases,
wonValueCents, lostCases, winRatePercent, byLostReason[]}, byAssignedTc[], byDoctor[],
nurtureReactivations{cases, valueCents} } }`.

## 4. UI

- `/tc/reports` gains **Conversion** (`features/tc/reports/ConversionSection.tsx`), driven
  only by the endpoint: 30d / 90d / 12-month presets (client chooses a start date only), rate
  tiles with the coverage caption, stage-by-stage bars, time-in-stage table, accepted value by
  week, by TC / by doctor / lost by reason; honest no-history and load-failure states.
- `features/tc/reports/funnel.ts`: zod schema for the response; `parseServedFunnel` brands it
  `ServedFunnel`; `servedAcceptanceRate` is the only minter of `ServedAcceptanceRate`.
- **Win overlay**: `WinStats.acceptedRatePercent` is now `ServedAcceptanceRate | null`
  (was `null`). `deriveWinStats` still never computes a rate (its result is still null — the
  existing test's assertions hold unchanged). The provider, when the trigger carries the
  persisted case's `officeId`, fetches the last-90-days funnel and attaches the served rate via
  `withServedRate`; failure/empty ⇒ no rate line. The `derive.ts` doc comment is rewritten,
  and a **compile-time guard** in `derive.ts` (tests are excluded from tsc) asserts that
  neither a bare `number` nor a plain `{percent,…}` object is assignable — proven to bite:
  widening the field to `| number` produced 7 tsc errors.
- No `shared/tc` contract change ⇒ **no `contract.gen.cjs` regeneration**.

## 5. Tests

| Suite | Result |
| --- | --- |
| backend `node --check server.js` | ok |
| backend `node scripts/shard-runner.mjs` (CI shape) | **3080 tests · 3077 pass · 0 fail · 3 skipped**, 4 shards green |
| new `backend/routes/tc/tcFunnel.test.js` | 8/8 — gates (403 unentitled, 403 hygiene, 400 office), window 400s, empty office, row shaping + null-on-zero, **both real status writers produce the parsed shape**, legacy shapes never parse, server vocab == contract |
| new-dashboard `pnpm run check` | clean |
| new-dashboard `pnpm run test` | **142 files passed / 26 skipped; 2441 tests passed / 160 skipped**, 0 failed |
| new `tests/tc-funnel.test.tsx` | 12/12 — parse/brand, null rate, schema refusals, presets, **client BOARD_STATUSES == server BOARD_STAGES**, section renders only served data from one request, no-history, failure, preset refetch, overlay rate / no office / failure |

No flakes observed.

## 6. SQL verification against the REAL migrated schema

`backend/scripts/tc-funnel-verify-queries.js` (fees-verify pattern): refuses a database with
any `tc_cases` row, seeds synthetic fixtures inside ONE transaction, runs the real
`computeFunnel`, asserts hand-computed numbers, always ROLLS BACK. Fixtures: **A** full history
(diagnosed → … → scheduled), **B** imported case with legacy free-text history (one event with
NULL legacy id) + one post-go-live transition, **C** reopened (accepted → considering →
accepted), **D** lost (`moved`), **E** nurture reactivation + oldest entry, **F** presented in
window / accepted after; **valley empty**. No real names, no PatNums.

Local run — Postgres 16 in Docker (`tcfunnel-pg`, port 55437), `migrate.js up` +
`migrate-tenant.js up --tenant carein`:

```
  ok   coverage starts at the oldest RELIABLE entry (not the imported 07-01 history)
  ok   presented → accepted cohort: 4 presented, 2 accepted, count and value rates
  ok   wins credited ONCE at first acceptance (reopened C counts once); lost by reason
  ok   accepted value by week: Monday buckets in the office time zone, zero-filled
  ok   stage conversion over the 9 board stages
  ok   days in stage: median + p90 over completed stays; open stays counted, not timed
  ok   by assigned TC and by doctor (cohort-based)
  ok   a window reaching before coverage is CLAMPED to it and says so
  ok   reopen rule: C (accepted → considering → accepted) is ONE acceptance and ONE win
  ok   EMPTY office: zeros, null rates, null coverage + a coverage note — not an error
  ok   office isolation: roland fixtures never leak into valley, and vice versa
  ok   window validation: from after to, and a window longer than 366 days, refuse
  (rolled back; tc_cases rows left behind: 0)

[tc-funnel-verify-queries] 12 funnel check(s) passed against the migrated schema
```

The first run caught a wrong hand expectation (A's 09-04 presentation sits in the 09-03..09-05
window) — the SQL was right, the expectation was fixed. **Not wired into CI**: adding the step
means editing `.github/workflows/build-test.yml`, itself a RED trigger and outside this slice.
Recommended follow-up: one step after `fees-verify-queries.js`
(`node scripts/tc-funnel-verify-queries.js`, same env).

## 7. CI

PR CI (`build-test` on the merge ref): see PR. Recorded in the final hand-back.

## 8. Lane classification

**Classifier** (`origin/feature/build-loop:.claude/scripts/classify-lane.mjs`, run from a
scratch copy, `--queue` the item file): **`LANE: RED`, exit 2.** Hits: new machine route
(`index.js`, `reports.js`); `backend/scripts/` operator script; env read (`OFFICE_TIMEZONE`);
office/slug literals; `derive.ts` removed text asserted on by `tests/tc-wins.test.ts:151`;
plus pattern false-positives (the `rcm-time` / `openDental.test.js` "removed text" hits are
generic words).

**Manual: RED, agreeing.** Reasons that stand on their own:
1. §8.3 lists **"any machine slug or route"** as shared vocabulary; this adds `/api/tc/reports`
   and `/reports/funnel`, plus two new error codes (`INVALID_RANGE`, `RANGE_TOO_LONG`).
2. `WinStats.acceptedRatePercent` changes type `null` → `ServedAcceptanceRate | null`.
   `tests/tc-wins.test.ts:151-152` still asserts `toBeNull()` and still passes **unedited**
   (no existing test's assertions were changed), but the test's premise ("never produces an
   acceptance rate") is now true only of `deriveWinStats`, not of the overlay — a reviewer
   should rule on whether that test's comment wants updating. Unsure ⇒ RED.
3. A new script under `backend/scripts/` (writes, though only to a throwaway DB in a rolled-back
   transaction, and refuses a non-empty one).
No migration, no CHECK/enum value, no OD path, no office derivation, no `normalizeCall`, no
auth/secret, no `.github`, no `CLAUDE.md`, no lockfile.

**Vocabulary readers grepped:** `acceptedRatePercent` → `wins/derive.ts`, `WinCelebration.tsx`,
`tests/tc-wins.test.ts` (all consistent). `WinTrigger.office` (new, optional) → both
`celebrateWin` callers updated (`StatusTransitionDialog.tsx`, `TcPipeline.tsx`), provider.
`/tc/reports/funnel` → `api.ts` only. `INVALID_DATE` pre-exists in `routes/hyg`
(same meaning). Audit `READ`/`tc_case` pre-exist.

## 9. Screenshots (`docs/screenshots/tc/`)

Rendered from **real server output**: the verify fixtures seeded on PG16, run through
`computeFunnel` (roland, 2026-07-11..2026-10-08 — clamped to coverage 2026-08-20), then the
real components rendered in jsdom with the production Tailwind bundle, shot with headless
Chrome (scripts kept in scratch, not committed).
- `funnel-conversion-roland.png` — the section: clamped-coverage caption + note, tiles, bars,
  time-in-stage, weekly trend, people, lost reasons.
- `funnel-conversion-empty-office.png` — valley with no history: coverage note, no numbers.
- `win-overlay-served-rate.png` — "Acceptance rate 75% · 3 of 4 presented, since Aug 20, 2026".

## 10. Conflicts with open PRs

`git merge-tree` against each head: **#229 clean, #230 clean, #231 clean, #232 CONFLICT in
`backend/routes/tc/index.js`** (both add a mount line after `/library` — keep both lines);
`api.ts` auto-merges with #229 and #232. No `shared/tc/contract.ts` change here, so no
`contract.gen.cjs` conflict with #229.

## 11. Open questions for Beau / PM

1. **Accepted family** — the funnel counts `accepted, partially_accepted, scheduled, started,
   completed`. Note the existing client sets disagree with each other (dashboard/wins:
   accepted + partially_accepted; reports `WON_STATUSES`: accepted, scheduled, started,
   completed). OK?
2. **Reopen rule** — first acceptance credited once, a later loss does not retract it. OK, or
   should a case that ends lost be removed from the win count?
3. **Value** is current case value, not value at acceptance. Acceptable, or snapshot value into
   the status_change event `detail` (a schema-free but contract-visible change, separate slice)?
4. **Status transitions are parsed from `description`.** Robust today (pinned by a test that
   drives both writers), but a structured `detail: {from, to}` on new status_change events
   would remove the text dependency — separate slice.
5. Wire `tc-funnel-verify-queries.js` into `build-test.yml` (workflow change ⇒ RED, Beau's call).
6. Should the overlay's rate window be 90 days (chosen) or something else?
7. `tests/tc-wins.test.ts`'s "never produces an acceptance rate" wording — keep or reword?

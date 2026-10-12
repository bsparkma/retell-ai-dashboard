# Item 45: Opportunities window and age filter (18-month inbox, newest first)

Branch `feature/tc-opps-window-filter` (off `origin/develop` 7df74ff) · worktree `C:\Users\beau\carein-wt\tc-opps-window-filter`.
**Lane: RED** (orchestrator classification, see the last section). Branch pushed; no PR is opened by the builder.

## 0. TL;DR

- **The sync is not touched.** It still captures 730 days (`TC_OPPS_LOOKBACK_DAYS`). `sync.js`, `core.js`, `scheduler.js` and
  `config/tcOpportunities.js` have no diff. The 18–24-month band stays in `tc_opportunities` and is only kept off the screen.
- **Per-office window.** The existing per-office TC settings seam is `tc_library_config` (one row per office and section,
  validated by `LibrarySectionSchemas`). It gains one section, `opportunities_config`, holding
  `{ opportunitiesWindowMonths: int 1..24, default 18 }`. When an office has no row, it gets 18. Setting the window is
  `PUT /api/tc/library/opportunities_config?office=…` (the generic library route, validated).
- **Route.** `GET /api/tc/opportunities` takes `maxAgeMonths` (1..24). Anything else gets a 400
  `{ success:false, error, code:'INVALID_MAX_AGE_MONTHS' }`. If you leave it out, the office window applies. A row's age
  is the **newest** planned date (DateTP) among its procedures. The filter runs **in Postgres** as a parameterized
  statement with named columns. The response adds `window: { officeMonths, appliedMonths, since, includesUndated }`.
  Each row adds `newestPlannedDate`.
- **UI.** The inbox has chips for 1 / 2 / 3 / 4 / 6 / 8 / 12 months plus the window chip (**"18 mo · All"**). Under the
  chips is a read-only line, e.g. "Showing plans from the last 18 months". The default sort is **Newest plan**, and the
  Value / Planned date / Last seen sorts stay. The chip lives in the view only: a reload goes back to the window. The
  dashboard card never sends a chip.

## 1. Files changed

| File | What |
|---|---|
| `new-dashboard/shared/tc/contract.ts` | `LibraryOpportunitiesConfig` + `OPPORTUNITIES_WINDOW_{MIN,MAX,DEFAULT}_MONTHS`; section `opportunities_config` added to `LibrarySectionSchemas` |
| `backend/tc/contract.gen.cjs` | **regenerated** from `new-dashboard/` with the pinned esbuild + `--alias:zod` (+16/−1 lines; `tc-contract-bundle.test.ts` green) |
| `backend/migrations-tenant/1790900000000_tc_library_opportunities_config.js` | **new migration**: drop and re-add `tc_library_config_section_check` with the 12th literal written inline. `down` deletes `opportunities_config` rows first, then restores the original 11 |
| `backend/services/tcOpportunities/window.js` | **new**, pure date rules + the one settings read: `localToday`, `subtractMonths` (clamps at month end), `windowCutoff`, `newestPlannedDate`, `parseMaxAgeMonths`, `resolveWindow`, `readOfficeWindowMonths`, test clock seam |
| `backend/services/tcOpportunities/store.js` | `listForOfficeWithin` (the SQL filter); `toWire` adds `newestPlannedDate`. The sync's statements are unchanged |
| `backend/routes/tc/opportunities.js` | GET: validates `maxAgeMonths`, reads the office window, filters, orders newest first before the 500 cap, returns `window` |
| `backend/routes/tc/tcTestUtils.js` | FakeTenantDb understands exactly the new WHERE term (test harness, no assertions) |
| `new-dashboard/client/src/features/tc/opportunities/opportunitiesApi.ts` | `newestPlannedDate`, `OpportunityWindow`, `window` on the list, optional `maxAgeMonths` arg |
| `new-dashboard/client/src/features/tc/opportunities/opportunityView.ts` | `newest` sort (the default), `AGE_STEPS`, `ageChips`, `windowSentence` |
| `new-dashboard/client/src/pages/tc/TcOpportunities.tsx` | chips, window line, "· newest <date>" on a row when it differs from the earliest, a guard so only the latest request draws the list |
| Tests (new) | `backend/services/tcOpportunities/tcOpportunitiesWindow.test.js` (11), `backend/routes/tc/tcOpportunitiesWindow.test.js` (12), `backend/test/tcLibraryOpportunitiesConfigMigration.test.js` (4), `new-dashboard/tests/tc-opportunities-window.test.tsx` (9) |
| Tests (touched, existing) | `backend/routes/tc/tcOpportunities.test.js`: clock pin added (setup only). `new-dashboard/tests/tc-opportunities-shots.test.tsx`: fixtures + shots 06/07. See §6 |
| `docs/screenshots/tc/` | 01–05 regenerated (the inbox now shows chips and the window line), 06 + 07 new |

## 2. Acceptance and spec coverage

| # | Spec item | Evidence |
|---|---|---|
| 1 | Capture vs display: the sync and its 730-day window are unchanged | `git diff origin/develop -- backend/services/tcOpportunities/{sync,core,scheduler}.js backend/config/tcOpportunities.js` is empty. Route test "capture vs display": 24 rows in the table, 18 shown, still 24 after the read. On Postgres 16: 26 rows stored, 20 shown at 18 months |
| 2 | Per-office `opportunitiesWindowMonths` (1..24, default 18) in the existing seam | `tc_library_config` section. Route test "the office window is per office": roland PUT 6 shows 6, valley keeps 18. Bad values (0, 25, 6.5, "6") get a 400 from the library route and nothing is written. Postgres: no row reads as 18, a row with 6 reads as 6 |
| 2b | Read-only line on the inbox | `opportunity-window`: "Showing plans from the last 18 months". With a chip on: "…last 3 months · office window 18 months". With differing office windows the line names each office. Screenshots 01, 06, 07 |
| 3a | `maxAgeMonths` 1..24, 400 outside, structured error | Route test "validation": 0, 25, −1, 3.5, abc, 1e1, and a repeated param each return 400 with exactly `{success, error, code}` and code `INVALID_MAX_AGE_MONTHS`. A refused request never reads the table. Blank means the window |
| 3b | Default = the office window | No param gives `appliedMonths == officeMonths` (18, or 6 for the configured office) |
| 3c | Age basis = NEWEST qualifying DateTP | Route test "age basis": a 20-month crown plus a filling 2 weeks old shows under the 1-month chip. `plannedDate` stays the earliest. On Postgres the mixed row is in for the 3-month and 1-month chips |
| 3d | Server-side, parameterized, no `SELECT *` | `store.listForOfficeWithin`. The route test checks every logged statement: no `SELECT *`, the date is `$2` and not interpolated. Postgres 16 ran it plus `EXPLAIN` |
| 3e | Dashboard card follows the office window, not the chip | Card still calls `listOpportunities(o, "new")` with exactly two args. The vitest clicks the 1-month chip, then mounts the card: one call, `["roland","new"]`. The existing assertion `toHaveBeenCalledWith("roland","new")` still passes unchanged |
| 4a | Chips 1/2/3/4/6/8/12/18, 18 = the window, "All" within the window | `ageChips([18])` returns 1…12 and then `18 mo · All` (null means no param). A 6-month office gets 1–4 and `6 mo · All`. A 24-month office includes 18. Mixed windows end with `All` |
| 4b | Chips re-query and filter | vitest: the 3-month chip triggers `listOpportunities("roland","new",3)`, the older row disappears, totals follow. "All" calls again with two args |
| 4c | View-local, resets on reload | vitest: the chip survives a tab switch and resets on remount (the window again, no `6`) |
| 4d | Default sort newest first, existing sorts kept | `DEFAULT_SORT = "newest"`, labels `[newest, value, planned, lastSeen]`. The existing sort assertions are unchanged and pass. The server also orders newest first before the 500 cap, so a capped list keeps the freshest rows |
| 5 | Out of scope: send-to-nurture, the 18–24-month pool UI | Not built. A chip wider than the window is **clamped** to it (route test: `maxAgeMonths=24` at an 18-month office applies 18), so the API does not expose the pool either. See §9 |
| T1 | Month-boundary arithmetic | Pure tests: a plan exactly N months old is in and one day older is out, for every chip value. Mar 31 − 1 month = Feb 28; in 2028 it is Feb 29. May 31 → Apr 30. Feb 29 − 12 → Feb 28. Year rollover. Bad input throws |
| T2 | Timezone-proof, America/Chicago day boundaries | Calendar-only arithmetic on `YYYY-MM-DD` (the lib/followups pattern). `localToday` checked at 04:59/05:00Z (CDT) and 05:59/06:00Z (CST). Route test: 23:30 CDT Oct 12 (already Oct 13 UTC) gives cutoff Jul 12, row in; 00:30 CDT gives Jul 13, row out |
| T3 | Fixture rows spanning 1–24 months show the 18/24 split | Route test "capture vs display" + Postgres 16 rehearsal |
| T4 | No real patient names | Fixtures: roland 12827 / 12828, valley 7115, synthetic 99xxxx, names "Test, …". Phones are 555-01xx |

**Undated rows (a decision, recorded).** A row whose procedures all lack a DateTP has no age. The sync keeps these on
purpose. They show **only at the full window** and never under a narrower chip, because a chip promises "planned in the
last N months" and that cannot be proven for them. Hiding them everywhere would silently lose captured work. This is
pinned by tests and the response's `includesUndated`.

## 3. Gates (merge tree: `git merge --no-edit origin/develop` = already up to date at 7df74ff)

| Gate | Result |
|---|---|
| backend `npm ci` · `node --check server.js` | ok · ok |
| backend `node scripts/shard-runner.mjs` | **3408 tests · 3405 pass · 0 fail · 3 skipped**, 4 shards green (739 / 854 / 854 / 961) |
| new-dashboard `pnpm install --frozen-lockfile` · `pnpm run check` | ok · clean (exit 0) |
| new-dashboard `pnpm run test` | **2498 pass · 180 skipped · 0 fail** (148 files passed, 30 skipped). Includes `tc-contract-bundle.test.ts` (byte-identical regen) |
| Real Postgres 16 (throwaway docker, recipe from the RCM slice 1 memory) | `migrate.js up` + `migrate-tenant.js up` ✔. CHECK accepts `opportunities_config` and rejects `practice_settings` with 23514 ✔. `listForOfficeWithin` on a 26-row ladder: 18-month view 20 rows (18 + undated + mixed), 3-month chip 4 rows, 1-month chip 2 rows ✔. `down` deleted the section row and narrowed the CHECK; `up` restored it ✔. Container removed |

No flakes were seen, so no isolation re-runs were needed.

## 4. Shared-vocabulary readers (whole-repo grep)

| New term | Readers |
|---|---|
| library section `opportunities_config` | migration CHECK (1790900000000); `LibrarySectionSchemas` in `shared/tc/contract.ts` → `contract.gen.cjs`; `routes/tc/library.js` (`SECTIONS = Object.keys(LibrarySectionSchemas)`, so it accepts the section automatically); `services/tcOpportunities/window.js` (`SECTION`); client `features/tc/api.ts` `LibraryState` / `getLibrarySection` / `putLibrarySection` (mapped type, optional key, no edit needed); `routes/tc/opportunities.js` (comment); tests. `tcLibraryOpportunitiesConfigMigration.test.js` pins CHECK literals == contract keys. `shared/tc/legacy.ts` importer: no legacy source exists for it, so nothing to map. No UI section editor reads it (follow-up) |
| config key `opportunitiesWindowMonths` | contract schema; `window.readOfficeWindowMonths`; migration doc; tests |
| route param `maxAgeMonths` | `routes/tc/opportunities.js` (via `window.parseMaxAgeMonths`); client `opportunitiesApi.listOpportunities`; `TcOpportunities.tsx` (chip state); `opportunityView.ts` (doc); tests. `OpportunitiesCard.tsx` deliberately does **not** send it |
| error code `INVALID_MAX_AGE_MONTHS` | route + route test. The client shows it through the generic `tcErrorMessage`, and the UI only sends chip values in range |
| wire fields `newestPlannedDate`, `window{officeMonths, appliedMonths, since, includesUndated}` | `store.toWire` / route → `opportunitiesApi.ts` types → `opportunityView.ts` (sort, sentence, chips) → `TcOpportunities.tsx`; tests and shots. The card ignores both |
| client sort slug `newest` | `opportunityView.ts` (`OpportunitySort`, `SORT_LABELS`, `DEFAULT_SORT`) → `TcOpportunities.tsx`. Client-only union, nothing else reads it |
| contract constants `OPPORTUNITIES_WINDOW_*` | contract → `window.js` |

## 5. Screenshots (`docs/screenshots/tc/`, light + dark, 1280 wide, synthetic data)

- `tcopps-06-age-chip-1280x1100-*`: the 3-month chip on, newest first, "Showing plans from the last 3 months · office
  window 18 months", and a row showing "Planned Mar 2, 2025 · newest Sep 28, 2026".
- `tcopps-07-windows-differ-1280x1400-*`: all offices with windows of 18 (Roland) and 12 (Valley). The "All" chip is
  on and the line names each office.
- 01–05 regenerated because the inbox now carries the chip row and window line. Shot 01's first Roland row now shows
  its plan date from its procedures (the fixture helper derives it), not the old hand-set date.

Recipe (unchanged): `pnpm exec vite build && TC_SHOTS=1 pnpm exec vitest run tests/tc-opportunities-shots.test.tsx && node scripts/shoot-tc-opportunities.mjs`.

## 6. Existing tests touched (RED trigger: listed in full)

- `backend/routes/tc/tcOpportunities.test.js`: **setup only.** Added `test.before`/`test.after` that pin the window
  clock to 2026-10-12. Without it the fixtures' 2026-08-15 plans would leave the 18-month window around Feb 2028 and the
  suite would break on its own. **No assertion was changed.**
- `new-dashboard/tests/tc-opportunities-shots.test.tsx`: screenshot dumps, with no assertions in shots 01–05. Fixture
  changes: `mk()` gains `newestPlannedDate`; `withValue()` now derives `plannedDate`/`newestPlannedDate` from the
  procedures; `list()` gains `window`; shots 06 + 07 added (with `expect` imported for a `waitFor`). **No existing
  assertion was changed.**
- `new-dashboard/tests/tc-opportunities.test.tsx`: **not edited.** All 11 tests pass as written, including the card's
  `toHaveBeenCalledWith("roland", "new")` and the value / planned / lastSeen sort assertions.
- `backend/routes/tc/tcTestUtils.js`: the harness learned one WHERE-term shape. This is not an assertion change.

## 7. Conflicts with the spec or guardrails (safe path taken)

1. **"Library practice section pattern."** No `practice` section exists in `tc_library_config`. The seam is
   *a section per concern* (`financing_config`, `cadence_config`, …). I added `opportunities_config` rather than inventing
   a general "practice" bag. `practice_settings` is the literal an existing test uses as *the* unknown section
   (`tcLibrary.test.js`), so that name was not available anyway.
2. **The section CHECK means a migration.** Doing it the repo's way (literals inline, contract regen, pin test) makes the
   slice RED, as the queue file expected.
3. **A chip wider than the window is clamped, not honoured.** The spec allows 1..24 on the route. Returning the 18–24
   band would build the reactivation pool's data path, which is out of scope. The response reports `appliedMonths` so
   this is visible.
4. **The 500-row cap.** Roland's measured qualifying-patient count (~1,985) is above `LIST_LIMIT` 500. The route now
   orders newest-first **before** capping, so a capped view keeps the freshest rows. Before this slice it kept the
   highest-value rows. Sorting by Value on the client sorts the freshest 500, not the top 500 by value overall.
   `truncated: true` is unchanged and still says so.

## 8. Staging click-test (after merge; needs the opportunities sync to have populated rows)

1. Open TC → **Opportunities** for Roland. Under the tabs you should see "Planned within 1 mo … 12 mo, **18 mo · All**",
   with the last chip selected and "Showing plans from the last 18 months".
2. Check that **Newest plan** is the selected sort and the top row has the most recent plan date.
3. Click **3 mo**. The list and the "N patients · $X planned" line shrink, and the line reads "…last 3 months · office
   window 18 months". Click **1 mo**, then **18 mo · All**: it goes back to the full list.
4. With **3 mo** on, switch to the **Dismissed** tab: the chip stays. Reload the page: the chip resets to **18 mo · All**.
5. Open the TC dashboard. The **Unscheduled treatment** card count matches the inbox's New-tab count at **18 mo · All**,
   whatever chip was last used.
6. Optional (writes config): `PUT /api/tc/library/opportunities_config?office=roland` with `{"opportunitiesWindowMonths":6}`.
   The inbox then shows "…last 6 months" with chips 1–4 and **6 mo · All**. Riley is unchanged. Remove it again by
   PUT 18 (there is no section delete route).
7. Bad param check: `GET /api/tc/opportunities?office=roland&maxAgeMonths=25` returns 400 `INVALID_MAX_AGE_MONTHS`.

## 9. Queued follow-ups (not in this slice)

- **One-click "send to nurture"** from an opportunity row (item 43+, with the channels/nurture wiring).
- **The 18–24-month reactivation pool UI** (item 43+). The rows already exist in `tc_opportunities`. The route clamps
  to the office window today, so exposing the pool needs a deliberate new view/param.
- A **Library settings editor** for `opportunities_config` (today it can only be set through the API).
- The 500-row cap vs. Roland's ~2k qualifying patients (paging or server-side sort per view) belongs with the item-46
  sync-capacity work.

## 10. Unfinished

Nothing in scope. The PR, review, CI and alerts belong to the orchestrator and shipper.

## Orchestrator lane

**Classifier (`node .claude/scripts/classify-lane.mjs --queue …45-tc-opps-window-filter.md`): `LANE: RED`.** Hits:
the database migration; shared server/client contract (`contract.ts`, `contract.gen.cjs`); a new machine code
(`INVALID_MAX_AGE_MONTHS`); a string-literal union touched (`OpportunitySort` + `newest`); lines changed in an existing
test (shots fixtures). It also flagged office/PatNum derivation on lines that only *scope* by `office_id` or mention
PatNum in a comment; no derivation changed. Some "removed text asserted by existing test" hits are false matches on
generic words.

**My verdict: RED.** Reasons by judgment (CLAUDE.md §8.3):
1. A new value in a shared vocabulary: library section `opportunities_config` (a CHECK constraint literal + the contract).
2. `backend/migrations-tenant/` touched.
3. A new route parameter and a new error code on `/api/tc/opportunities` (route vocabulary).
4. The shared contract changed and the bundle was regenerated.
5. Existing test files touched (setup and fixtures only, no assertion changed, listed in §6). Still flagged under the
   when-unsure rule.
6. The queue file itself says "expect RED".

Every consumer of the new values was grepped (§4) and updated or deliberately left out (the card).

## Reviewer verdict and final lane

- **Reviewer (fresh context, round 1): PASS, `LANE: RED`.** It ran `classify-lane.mjs`
  independently and got RED. By judgment it found: a new shared-vocabulary value (the
  `opportunities_config` section in the CHECK and contract, `INVALID_MAX_AGE_MONTHS`, the
  `newest` sort, the `maxAgeMonths` param), a `migrations-tenant/` change, edits to existing
  test files (setup and fixtures only, no assertion changed), a shared-contract regeneration,
  and the queue file's own RED marking.
- **Its whole-repo vocabulary sweep found no missed consumer.** Non-blocking note:
  `docs/TC_SCHEMA.md:77` still lists 11 library sections; it is documentation, not a code
  reader.
- **Its gates on the merge tree:** backend 3408 tests, 3405 pass, 0 fail, 3 skipped. Dashboard
  `check` clean; 2498 passed, 180 skipped, 0 failed.
- **Final lane: RED** (orchestrator RED + reviewer RED). Beau merges.

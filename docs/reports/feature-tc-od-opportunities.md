# Item 41 — Opportunities inbox: diagnosed-but-unscheduled treatment surfaces itself

Branch `feature/tc-od-opportunities` (off `origin/develop` e551c65) · PR to `develop` — **RED LANE, NEEDS REVIEW, not merged**.
PR: see the PR line at the bottom of this file.

## 0. TL;DR

- New tenant migration `1790600000000_tc_opportunities.js`: `tc_opportunities` + `tc_opportunity_sync`.
- Nightly sync per office (02:30 America/Chicago), **ships dark**: nothing runs until
  `platform_setting['tc_opportunities_sync']` = `{"roland": true}` (no row = off; nothing in this
  slice writes that row). Read-only Open Dental, through the office client and its shared slot, at 1200 ms.
- `/api/tc/opportunities` GET / claim / dismiss — **Postgres only**, no OD import in the route file.
- UI: "Opportunities" nav item (Casework), `/tc/opportunities` inbox, a dashboard card. Screenshots in `docs/screenshots/tc/`.
- Budget verdict: **passes** for any office under ~70,000 treatment-planned procedures (see §2). N is not measured yet —
  `backend/scripts/probe-tc-opportunities.js` measures it.

## 1. Open Dental API findings

Legend: **MEASURED** = a live call recorded in this repo; **DOCUMENTED** = OD's vendor page only
(opendental.com/site/apiprocedurelogs.html, read 2026-10-08); **ASSUMED** = neither.

| # | Finding | Status | Evidence |
|---|---|---|---|
| 1 | `GET /procedurelogs?ProcStatus=TP` exists and is honoured on Roland AND Riley (full 100-row pages) | **MEASURED** | docs/TC_OD_READS.md live transcripts 2026-08-04 (Roland) and 2026-08-19 (valley) |
| 2 | `ProcStatus` is a STRING enum: TP, C, EC, EO, R, D, Cn, TPi; param added in 25.2.21 (Roland is 25.4.48) | DOCUMENTED (+ version MEASURED) | vendor page; memory project_rcm_od_writes_spike0a |
| 3 | Page size 100, `Offset` paging | **MEASURED** for /claimprocs & /procedurelogs | TC_OD_READS.md (`Offset=50` → 3 rows; TP page = 100) |
| 4 | **No `DateTP` filter** — only `ProcDate`, `DateTStamp` (plus PatNum, AptNum, PlannedAptNum, ClinicNum, CodeNum) | DOCUMENTED + noted live in TC Slice 5 | vendor page; TC_OD_READS.md §4 |
| 5 | `DateTStamp` filter ("created on or after" per vendor wording) and a `serverDateTime` field on every row | DOCUMENTED only | vendor page; OD_API_CONTRACT.md §6 (no caller ever exercised it) |
| 6 | Rows carry `AptNum`, `DateTP`, `ProcFee` (string dollars), `procCode`/`descript` (lower-case keys), `ToothNum`, `Surf`, `ClinicNum` | DOCUMENTED; `procCode`/`ProcFee` MEASURED via TC slice 5 normalizer use | vendor example; odReads.js |
| 7 | Every Roland procedure has `ClinicNum: 0`; the customer key IS the office scope | **MEASURED** | TC_OD_READS.md |
| 8 | OD list filters are **silently ignored** when unrecognised (4 endpoints proven) | **MEASURED** (other endpoints) | memory spike0a |
| 9 | Treatment-plan endpoints (`/treatplans`, `/proctps`, `/treatplanattaches`) exist, plural only | **MEASURED** | TC_OD_READS.md — not used: they are per-patient, so a practice-wide sweep through them costs ≥1 request per patient |
| 10 | `AptNum > 0` ⇒ the procedure is on a *scheduled* appointment | **ASSUMED** | It can also be a broken/unscheduled-list appointment; telling them apart costs a request per patient. Conservative: under-reports, never nags about booked work |
| 11 | `/patients/{PatNum}` is the only name read; no bulk patient read (`/patients/Simple` exists but undocumented fields) | MEASURED (hyg slice) | memory project_od_patient_cache |

**Design consequences, all implemented:**
- Server filter is trusted **only after re-verification**: every row is checked client-side; ONE non-`TP` row aborts the sweep
  (`FILTER_IGNORED`) instead of continuing what would be a whole-table scan. No unfiltered fallback (the interactive
  finder degrades; a 1 req/s nightly job must not).
- Office re-verification: `assertOfficeMatch(office, handle)` on **every** request.
- **Full sweep, not a DateTStamp delta.** A `ProcStatus=TP&DateTStamp=w` delta can never return procedures that *left*
  TP (completed / deleted / scheduled), so the inbox would keep offering finished work. The watermark (`serverDateTime`)
  is still recorded per office for a future incremental mode. **Spec-vs-safety conflict → safe path, recorded here.**

**Probe for the unknowns** (read-only, guarded `main()`, `loadSecrets()` first, counts/field names only):
```
env TC_OPPS_PROBE_OFFICE=roland node scripts/probe-tc-opportunities.js           # Q1–Q4: ~4 requests
env TC_OPPS_PROBE_OFFICE=roland TC_OPPS_PROBE_COUNT=1 node scripts/probe-tc-opportunities.js   # Q5: measures N (off-hours)
```
Q1 field shape / filter honoured, Q2 `ProcStatus=C` differs, Q3 Offset paging, Q4 `DateTStamp` honoured, Q5 N, pages,
qualifying patients and elapsed time — the budget numbers below, measured. **Not run** (no secrets in this session).

## 2. Budget arithmetic (1 request per 1.2 s — the RCM D-8 spacing, a floor the env cannot lower)

Per office per night: `M = ceil(N/100) sweep pages + K name reads`, runtime `1.2 s × M`.
- Name reads happen **only for rows without a name snapshot** (a snapshot is never re-read), capped at
  `TC_OPPS_MAX_NAME_READS` = 500 and by the wall budget `TC_OPPS_SYNC_BUDGET_MS` = 14 min (the sweep is never cut by the
  budget — a cut sweep is partial and applies nothing; only names stop early and resume next night).

| Assumed N (TP procs) | Sweep pages | Sweep time | + names (first night, cap 500) | Total | Steady night (≈20 new names) |
|---|---|---|---|---|---|
| 4,000 (legacy finder's cap — memory says Roland exceeds it) | 40 | 48 s | 10 min (bounded by the 14 min wall) | ≈ 11 min | ≈ 1.3 min |
| 20,000 | 200 | 4 min | to the 14 min wall | 14 min | ≈ 4.4 min |
| 60,000 (page cap `TC_OPPS_MAX_PAGES`=600) | 600 | 12 min | ~2 min, rest next nights | 14 min | ≈ 12.4 min |
| > 60,000 | — | — | — | **partial, nothing applied** | — |

**Verdict:** a full office sync stays ≤ ~15 min by construction for N ≤ ~60,000 (the sweep alone would exceed 15 min at
N ≈ 75,000). Above the page cap the design **fails review** and needs DateTStamp deltas + a weekly full sweep; the sync
says so (`PAGE_CAP`, status `partial`) rather than lying. Backlog of names on a first night drains over a few nights
(e.g. 2,000 patients ≈ 4 nights); those rows show as "Name pending" and cannot be claimed until named.
Two offices are separate credentials but are run **sequentially** (quieter, not faster).

## 3. Sync slot: 02:30 America/Chicago

"After the hyg 07:45 warm" read literally is office hours — the busiest time on the shared credential. The intent is
*don't collide*; 02:30 finishes (≤ 2 × 14 min) by ~03:00, almost five hours before the 07:45 warm, with no business-hours
traffic at all. Overridable: `TC_OPPS_SYNC_SCHEDULE`, `TC_OPPS_SYNC_TZ` (falls back to `OFFICE_TIMEZONE`). No pass at boot.

Dark gates, all read at pass time, all fail closed: `TC_OPPS_SYNC_DISABLED=true` (kill) → platform_setting row (absent /
non-`true` / unreadable = off) → exactly ONE active tenant entitled to `tc` (OD office handles are process-wide; two
entitled tenants is refused `AMBIGUOUS_TC_TENANT`) → `odOffices.isOdReady(office)`.
**Single replica:** the re-entrancy guard is in-process; at maxReplicas > 1 two passes would double OD traffic (row
writes are status-guarded, so no corruption). A lease row is needed before raising replicas.
**No audit rows from the sync** (nobody is looking — same rule as the hyg warm); the inbox GET audits the disclosure.

## 4. What was built

**Data** (`backend/migrations-tenant/1790600000000_tc_opportunities.js`, numbered after #229–#231's 1790300000000–1790500000000):
- `tc_opportunities`: per spec, **column is `office_id`, not `office`** (matches every tc_* table, as #229 did);
  `od_patient_id` **bigint** (OD PatNum is a Long; tc_cases uses bigint); `procedures` jsonb snapshot
  `[{procNum, code, description, feeCents, tooth, surf, plannedDate}]`; `value_cents`; `planned_date` = earliest DateTP;
  status CHECK `new|claimed|dismissed|existing_case` inline; UNIQUE (office_id, od_patient_id); CHECKs: dismissed ⇔
  non-blank reason, claimed ⇒ case id; FK claimed_case_id → tc_cases ON DELETE SET NULL. Additions beyond the spec, each
  for honesty: `patient_status` (hide non-active patients), `claimed_by/at`, `dismissed_by/at`, `resurrected_at`,
  `cleared_at` (see below).
- `tc_opportunity_sync`: per-office `last_synced_at` (moves only on a completed sweep), `watermark`, `last_attempt_at`,
  `last_status` (`ok|partial|failed`), `last_error`, counts.
- carein_app CRUD grant, role-guarded.

**Rules** (`backend/services/tcOpportunities/core.js`):
- Candidate = `ProcStatus 'TP'`, CDT D-code with fee > 0, `AptNum = 0`, DateTP within `TC_OPPS_LOOKBACK_DAYS` (730; OD null
  date `0001-01-01` = undated, kept).
- Re-sync: open rows (`new`, unclaimed `existing_case`) get procedures/value/date replaced and `last_seen_at`; claimed /
  claim-attached rows keep the snapshot the TC acted on (`last_seen_at` still moves); a patient with nothing qualifying
  after a **complete** sweep gets `cleared_at` (hidden; un-cleared if it returns). A fifth status was not added — "gone from
  OD" is a fact, not a decision.
- **Resurrection rule:** a dismissed row returns to `new` ONLY when a planned ProcNum appears that was not in the dismissed
  snapshot. Fee changes, re-dating, removals never resurrect (the dismissed snapshot is frozen to make the comparison
  honest). Dismissal fields cleared, `resurrected_at` stamped, UI shows "New treatment since dismissed".
- **existing_case both directions:** `new` + an OPEN case (OPEN_CASE_STATUSES, same office) → `existing_case`; an unclaimed
  `existing_case` whose cases all went terminal → `new`. A row a claim *attached* never flips back. Run at sync end and on
  every inbox GET (Postgres only).

**Routes** (`backend/routes/tc/opportunities.js`, mounted `tc.full` at `/api/tc/opportunities`):
- `GET ?office=&status=new|claimed|dismissed|existing_case|all` → rows (≤500), `totals` over the whole set, `sync`.
- `POST /:id/claim` `{ phases? }` → attach-or-create using **`intakeFromCall.findOpenCase` itself** (exported, not copied):
  open case → `note_added` event on it, case untouched, row → `existing_case` + `claimed_case_id`; else a new `pending_tc`
  case (assigned to the claimer, `referralSource: existing_patient`, `diagnosedDate` = planned date, value, urgency = most
  urgent item). The row UPDATE is the race arbiter (guarded on status + `claimed_case_id IS NULL`); a loser rolls back its
  case. Refusals: 404, 409 `ALREADY_CLAIMED` (with caseId) / `NOT_CLAIMABLE` / `NO_LONGER_PLANNED` /
  `PATIENT_NAME_PENDING` / `CLAIM_RACE`, 400 `ITEM_NOT_IN_SNAPSHOT` / `ITEM_DUPLICATED` / `FEE_MISMATCH`.
- `POST /:id/dismiss` `{ reason }` (trimmed, 1–500, strict) → 409 `NOT_DISMISSABLE` on claimed rows.
- Audit: `READ`/`UPDATE` on resource_type `tc_opportunity`, plus `CREATE`/`UPDATE` `tc_case`. No new verbs.

**ONE implementation of the grouping rules:** the claim's phase tree is built on the client by
`features/tc/od/odPlan.ts` (`itemsFromOdProcedures → stripReviewFields → groupItemsIntoPhases`, i.e. `inferUrgency`) —
the same path the OD pull dialog uses; nothing was ported. The server **verifies** the tree against its snapshot (every
item a snapshot ProcNum, once, at the snapshot fee). The case's urgency is only an *ordering* over the client-inferred
item urgencies. A vitest pins `phasesForOpportunity` ≡ odPlan's output.

**UI:** `pages/tc/TcOpportunities.tsx` (tabs New / Already in a case / Claimed / Dismissed; sort Value / Planned date /
Last seen; office badges in All-Offices mode; per-office honest sync line; name-pending rows not claimable; reason-required
dismiss dialog), `features/tc/opportunities/{opportunitiesApi.ts, opportunityView.ts, OpportunitiesCard.tsx}`; dashboard
card (count + total value of real `new` rows; "not synced yet" instead of a zero).

## 5. Tests and gates

| Gate | Result |
|---|---|
| backend `npm ci && node --check server.js` | ok |
| backend `node scripts/shard-runner.mjs` (CI shape) | **3123 tests · 3120 pass · 0 fail · 3 skipped**, 4 shards green (before the DATE regression test; +1 since, file re-run green) |
| new backend tests | core 7, sync 15, scheduler 8, routes 14, migration 8 = **52** |
| new-dashboard `pnpm install --frozen-lockfile && pnpm run check` | clean |
| new-dashboard `pnpm run test` | **2440 pass · 160 skipped · 0 fail** (142 files) — includes 11 new; 5 shot dumps skipped unless `TC_SHOTS=1` |
| Migration rehearsal, Postgres 16 (docker, throwaway) | control + tenant `up` ✔; `down` drops both tables ✔; `up` again ✔; carein_app has S/I/U/D on both ✔; CHECK/UNIQUE rejections proven (23514 ×4, 23505) ✔ |
| Real-PG end-to-end | sync ×3 (insert, idempotent re-run, resurrection) and the HTTP routes over a real pool as `carein_app`: GET, claim-create, claim-attach (one case only), dismiss, audit rows ✔ |

The rehearsal caught a real bug the fake DB could not: node-pg returns a DATE as a JS `Date`, and the claim's
`String(date).slice(0,10)` produced "Sat Aug 15" → contract parse failure. Fixed (`store.isoDate`, local components) and
pinned by a route test with a `Date` planned_date.

Spec test list: sync idempotency ✔, existing_case both directions ✔ (incl. other-office PatNum), claim attach-or-create over
**every** OPEN and **every** TERMINAL status from the shared partition ✔, resurrection rule ✔, throttle discipline ✔
(every request via `apiGetRaw` on the office client with `minIntervalMs ≥ 1200`, sequential pages; static scan: no
fetch/axios/http/undici and no OD write verb in sync/store/core/scheduler/routes; routes import nothing OD), no real names ✔.
No flakes observed.

**Existing-assertion change:** `backend/test/orthoScreeningMigration.test.js` — "are the newest tenant migrations" →
"nothing is numbered inside their range". Copied **byte-identical** from `origin/feature/tc-messaging-foundation` (#229)
so the two PRs merge without conflict.

## 6. CI

See the PR checks (build-test runs on PRs). Recorded at the bottom.

## 7. Vocabulary readers (grep of the whole repo)

| New term | Readers |
|---|---|
| status `new`/`claimed`/`dismissed`/`existing_case` (tc_opportunities) | migration CHECK; `services/tcOpportunities/core.js` (OPPORTUNITY_STATUSES, ACTIONABLE_STATUSES, planRowChange, planExistingCaseFlips); `store.js` (resurrect/reconcile); `routes/tc/opportunities.js`; `client/.../opportunitiesApi.ts` (union, pinned to the migration by vitest); `pages/tc/TcOpportunities.tsx` (tabs, badges); tests. `new`/`claimed` also appear elsewhere for unrelated vocabularies (no shared reader). |
| sync status `ok`/`partial`/`failed` | migration CHECK; core.SYNC_STATUSES; sync.js; store.recordSync; opportunityView.syncSentence |
| route `/api/tc/opportunities` | `routes/tc/index.js`; opportunitiesApi.ts; tests. `moduleGateWiring.test.js` covers the `/api/tc` mount (unchanged). |
| SPA route `/tc/opportunities` | App.tsx; DashboardLayout nav; OpportunitiesCard link; permissions via the existing `/tc` → `tc.full` prefix (no map edit) |
| platform_setting key `tc_opportunities_sync` | `config/tcOpportunities.js` only. Nothing writes it. |
| audit resource_type `tc_opportunity` | routes/tc/opportunities.js; tests |
| OD module tag `tc-opps` / `tc-opps-probe` | sync.js / probe; `config/openDental.js` counters key on it generically |
| env `TC_OPPS_*` | config/tcOpportunities.js only |

## 8. Screenshots (`docs/screenshots/tc/`, light + dark, 1280 wide)

`tcopps-01-inbox-1280x1400` (all offices, badges, name-pending + resurrected rows) · `tcopps-02-dismiss` ·
`tcopps-03-existing-case` · `tcopps-04-sync-partial` · `tcopps-05-dashboard-card-1280x300`.
Recipe: `pnpm exec vite build && TC_SHOTS=1 pnpm exec vitest run tests/tc-opportunities-shots.test.tsx && node scripts/shoot-tc-opportunities.mjs`.

## 9. Conflicts and merge notes

- **#229 (tc-messaging-foundation):** `features/tc/api.ts` — this branch makes the **identical** `export` of
  `TcRequestOptions`/`tcRequest` (same comment, CRLF kept) → clean merge expected. `orthoScreeningMigration.test.js` —
  identical change → clean. `routes/tc/index.js` — #229 adds `/messages` after `/communications`; this adds
  `/opportunities` after `/library` (4 lines apart) and a header line after `/library`; **should merge clean, worst case a
  trivial adjacent-hunk conflict in the header comment**. TcCaseView/TcShell: untouched here.
- Migration order: 1790600000000 sorts after #229–#231's three; no collision.
- Shared files touched minimally: `cases.js` (+export PhaseCreate), `intakeFromCall.js` (+export findOpenCase),
  `server.js` (+start/stop), `DashboardLayout.tsx` (+1 nav item, +icon import), `App.tsx` (+route), `TcDashboard.tsx` (+card).

## 10. Open questions for Beau

1. **Turning it on** is a control-plane write: `INSERT INTO platform_setting (key, value) VALUES ('tc_opportunities_sync', '{"roland": true}')`.
   Want a Platform Console toggle (hygPilot-style) in a follow-up?
2. Run the probe (Q1–Q5) on staging before switching on — especially Q4 (`DateTStamp`) and Q5 (N). If N > 60,000 the
   design needs the delta + weekly-full variant.
3. `AptNum > 0` = scheduled is ASSUMED (§1 #10). OK to under-report broken-appointment procedures?
4. Look-back default 730 days on DateTP — right window?
5. Claim on a name-pending row is refused; alternative is to allow it with a "PatNum N" placeholder name. Kept refusal.
6. Attach records a `note_added` event; a dedicated `opportunity_claimed` CaseEventType would need a contract change +
   bundle regen — deliberately avoided while #229 is in flight on the contract.
7. Patient names are snapshotted once and never refreshed (cost). A renamed patient keeps the old name on an unclaimed row.

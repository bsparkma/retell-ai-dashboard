# 10 — File-by-File Findings

A walk through the most important parts of the codebase.

> **For the most accurate version of the most-important findings, see [`11-evidence-and-confidence.md`](./11-evidence-and-confidence.md).** That file restates the file:line evidence with Confirmed/Likely/Possible tags. Specific corrections to this file:
> - **`backend/config/openDental.js`**: I previously implied the AI has no booking tools. Wrong. This file contains real `bookAppointment`, `findAlternativeTimeSlots`, `checkSchedulingConflicts`, `searchPatients`, `verifyPatientAppointments`, `updateAppointment`, `cancelAppointment`. The gap is they're not registered as Retell function-call tools. (See Correction D in file 11.)
> - **`backend/config/openDental.js`**: I previously said "no pool, no timeouts." The pool exists at line 70-82 with `connectionLimit: 10`. The `acquireTimeout`/`timeout` options are silently ignored — a smaller real issue (Likely).
> - **`backend/config/retell.js`**: I implied a hardcoded API key fallback. The live file uses `process.env.RETELL_API_KEY` only (line 5). The hardcoded key lives in `setup.sh:39` and a doc-snippet in `CURSOR_PRODUCTION_FIXES.md`.
> - **`backend/services/callAnalyzer.js`** (PHI to OpenAI): the **transcript** is sent to OpenAI; **stdout logs** record only `event/call_id/timestamp` plus phone numbers and patient names on success — not full transcripts. Narrowed the PHI-in-logs concern accordingly.

This is not exhaustive — the repo has hundreds of files including duplicate worktrees and multiple frontends. I've focused on the files that actually run in the deployed pipeline.

Severity legend:
- 🔴 **Critical** — must fix before live use
- 🟠 **High** — must fix before commercial sale
- 🟡 **Medium** — important to address but not blocking
- 🟢 **Low / Note** — observation, technical debt, polish

---

## Backend — entry & wiring

### `backend/server.js`
**What it does:** Express + Socket.IO entry point. Sets CORS, Helmet, rate limit, mounts routers under `/api/*`, exposes `/api/health`, initializes the unified call store, kicks off Retell + Mango sync schedulers.

**Good:**
- Helmet + CORS + rate limiting are present, even if rate limit is `1000/15min` in dev.
- Graceful shutdown on `SIGTERM`/`SIGINT` calls `unifiedCallStore.shutdown()`.
- Health endpoint reports active calls and connected clients.

**Findings:**
- 🔴 **No auth middleware mounted.** Every router is public. A single curl can read all PHI.
- 🟠 **CORS includes hardcoded `https://carein-do.flamingketchup.com`.** Tenant onboarding will require code edits unless this becomes config-driven.
- 🟠 **`trust proxy: 1`** is set without verifying the proxy chain. If multiple proxies, rate limit will key on the wrong IP.
- 🟡 **`morgan('combined')` logs full URLs.** Query strings can carry PHI (`?phone=+15551234`). Configure to skip or redact.
- 🟡 **Initial Retell sync runs `limit: 200`.** On first boot of a long-running practice, this may be far too low and miss history. On every restart, this re-fetches the same 200.
- 🟢 **Retell sync interval is 15 min**, but no jitter. Multiple instances would dogpile.
- 🟢 The Mango transcription backfill `setTimeout(..., 10000)` is brittle. Should be a job, not a sleep.

---

### `backend/socket/socketHandler.js` (referenced)
**What it does:** Wires Socket.IO event handlers; surface to clients for live call updates.

**Findings:**
- 🟠 **No socket auth.** Any browser pointing at the URL gets the full live call stream. Same auth gap as REST.
- 🟡 No room scoping by tenant — when multi-tenant lands, all sockets see all events.

---

## Backend — routes

### `backend/routes/webhooks.js`
**What it does:** Receives Retell webhook events (`call_started`, `call_ended`, `call_analyzed`, `transcript`), updates `liveCallManager`, persists to `unifiedCallStore`, and on `call_analyzed` matches the caller to an Open Dental patient and writes a CommLog.

**Good:**
- Handles all four event types.
- CommLog note format is well-structured (duration, summary, patient type, appointment booked, emergency, insurance, full transcript).
- Uses `crypto.timingSafeEqual` for HMAC.

**Findings:**
- 🔴 **HMAC verification is bypassed entirely when `NODE_ENV !== 'production'`** (`return true`). Production flag is one env var. Disabling = wide-open injection.
- 🔴 **HMAC computation uses `JSON.stringify(req.body)`.** This will mismatch Retell's signature — Retell signs the raw request body bytes, not a re-stringified parse. Even with verification enabled, signatures won't match. Need raw-body capture (`express.raw()` on this route specifically).
- 🔴 **`POST /api/webhooks/test` is enabled in non-prod and unauthenticated.** Anyone hitting your dev URL can mint fake calls.
- 🔴 **Errors are swallowed with 200 status.** "Still return 200 to prevent Retell from retrying." — this is good for Retell, but dropped events are not queued. Lost data.
- 🟠 **Patient match → CommLog write is fire-and-forget.** No retry queue, no DLQ. If OD is down at the second the analysis arrives, the CommLog is silently lost.
- 🟠 **`unifiedCallStore.persist()` is called on every event.** Synchronous-equivalent JSON write of the entire dataset on every call_started, call_ended, call_analyzed, and transcript event. Performance disaster at scale + race conditions with concurrent writes.
- 🟠 **Transcript event also triggers persist.** A 2-minute call with 50 utterances writes the full call log JSON 50 times.
- 🟠 **Match confidence threshold is hardcoded `>= 0.7`.** No way to configure per-tenant. No "needs review" queue for sub-threshold matches; they go to a console warning that nobody reads.
- 🟡 **`event.event` is not validated.** A malformed payload with `event.event = "../../../etc/passwd"` lands in the switch's default case (safe), but not validated upstream.
- 🟡 **CommType determination is hardcoded magic numbers** (4=emergency, 2=appt-booked, 1=otherwise). These should be named constants per OD's CommType lookup.

### `backend/routes/admin.js`
**What it does:** Health, sync controls, cost tracking, connection tests.

**Good:** Provides "test connection" surface for ops.

**Findings:**
- 🔴 **All admin endpoints unauthenticated.** Anyone can trigger Mango Puppeteer launches, change agent config, or read costs.
- 🟠 **Mango "test connection" spawns a real browser** and does a real login. A web crawler hammering `/api/admin/test-connection?service=mango` becomes a DoS on the droplet (memory + Mango lockout).
- 🟡 Cost endpoint reads from local sums only — no reconciliation with Retell or OpenAI billing.

### `backend/routes/agents.js`
**What it does:** Returns mock agents and pretends to update them.

**Findings:**
- 🔴 **All four "agents" are hardcoded mocks** ("Medical Receptionist", "Emergency Triage", "Billing Support", "Pharmacy Assistant"). They have nothing to do with the real Retell agent serving calls.
- 🔴 **Updates are no-ops** — the API returns the requested update but nothing is persisted or pushed to Retell.
- 🟠 The mock data is *medical*, not dental. ("Pharmacy Assistant"?) Vestiges of a different product.

### `backend/routes/callbacks.js`
**What it does:** CRUD over an in-memory callbacks array. Seeds 4 sample callbacks on startup.

**Findings:**
- 🔴 **In-memory only.** Server restart loses every real callback.
- 🔴 **Sample data seeded on startup.** Real and demo callbacks blend; staff cannot trust the queue.
- 🟠 No assignment to staff. No status workflow beyond `status` string.
- 🟠 No deduplication — two webhooks creating callbacks for the same call duplicate the queue.
- 🟡 No created/updated timestamps with timezones.

### `backend/routes/calls.js`, `backend/routes/unifiedCalls.js`
**What they do:** Read call data from the unified store, with filtering and pagination.

**Findings:**
- 🟠 No auth.
- 🟡 Filtering happens in-memory across the entire dataset on every request. At 10k calls this is fine; at 1M it's not.
- 🟡 No projection — every read returns full transcripts including PHI. Dashboard list view should not need transcripts.

### `backend/routes/openDental.js`, `backend/routes/openDentalSync.js`, `backend/routes/mango.js`, `backend/routes/liveCalls.js`, `backend/routes/analytics.js`
**Common findings:**
- 🔴 No auth on any of them.
- 🟡 Most do work that should be moved into services, leaving routes as thin controllers.
- 🟡 Analytics computes aggregates on every request — should be cached or pre-aggregated.

---

## Backend — services

### `backend/services/unifiedCallStore.js`
**What it does:** In-memory `Map` of all calls (Retell + Mango), with phone/date/source indexes, JSON file persistence.

**Good:**
- Normalizes both Retell and Mango calls into a single shape — this is genuinely useful design.
- Indexes by phone, date, source — enables fast lookups.
- Auto-save every 60 seconds.

**Findings:**
- 🔴 **JSON file persistence over a single file** (`data/unified_calls.json`). At scale this file is multi-MB. Every persist rewrites the whole thing. Concurrent writes from cron + webhook race.
- 🔴 **Crash mid-write corrupts the file.** No tempfile-and-rename, no atomic write.
- 🔴 **All data lives in process memory.** A 50k-call practice over a year is fine for memory; a multi-tenant deployment is not.
- 🟠 **Mango dedup uses linear scan**: `Array.from(this.calls.values()).find(c => c.external_id === call.external_id)` — O(n) per Mango call. With cron syncing 100s of calls, this is O(n²).
- 🟠 **`addRetellCall` on `call_started` writes a half-formed record** without analysis, then again on `call_ended`, then again on `call_analyzed`. Each one persists the entire dataset.
- 🟡 No schema versioning. Loading a JSON written by a different version of code may silently mis-map fields.
- 🟡 `normalizeCall` uses `||` defaults heavily — `is_emergency || false` will misread `null` as `false` correctly, but `duration_seconds || 0` will treat a real `0`-second call as missing data.

### `backend/services/liveCallManager.js`
**What it does:** Tracks active in-progress calls in memory; emits Socket.IO events; basic sentiment + emergency detection from transcript text.

**Findings:**
- 🟠 **In-memory only.** Server restart while a call is in progress = call disappears from live view, but Retell still has it. Reconciliation on `call_ended` will mostly recover, but the live UI is wrong during the gap.
- 🟠 **Sentiment analysis is keyword counting** — 12 negative words, 12 positive words, threshold of 2. This is below-baseline. Not unsafe, just useless. The Dashboard shows a sentiment dot based on this.
- 🟠 **Emergency detection is also keyword-based** (`'emergency', 'urgent', 'severe pain', 'bleeding', 'swelling', 'can\'t breathe', 'chest pain', 'accident', 'broken', 'knocked out', 'tooth fell out', 'abscess'`). It flags `is_emergency=true` based on either party saying "broken" or "accident" — high false positive rate. The agent's prompt-driven analysis (callAnalyzer) is more accurate; this layer's flag overrides nothing but still influences UI.
- 🟠 **Emergency detection should NOT include `'chest pain'` and `"can't breathe"` as dental flags** — those are *medical* emergencies that warrant 911, not "this is a dental urgency we should book quickly." Bad framing.
- 🟠 **Caller-name regex** captures any capitalized word after "my name is / I'm / this is". Works often, but `"this is Patricia"` succeeds, while `"this is patricia"` fails (lowercase). Should normalize.
- 🟡 **Summary fallback** ("first 3 caller statements") is naive. OK as a fallback, but should be marked as such.
- 🟡 No call timeout — a stuck "active" call lingers forever in `activeCalls` if `call_ended` never arrives.

### `backend/services/callAnalyzer.js`
**What it does:** Sends transcript to OpenAI `gpt-3.5-turbo` for structured analysis (caller_name, call_reason, sentiment, is_emergency, summary, appointment_requested, callback_needed, key_details). Falls back to heuristics on failure.

**Good:**
- Good prompt structure with explicit JSON contract.
- Truncates to 2000 chars before sending — useful cost control.
- Heuristic fallback exists.

**Findings:**
- 🔴 **PHI sent to OpenAI without a BAA.** Names, conditions, insurance, sometimes DOB. HIPAA violation.
- 🟠 **2000-char truncation drops the end of long calls** — the most likely place for outcomes to be discussed.
- 🟠 **`gpt-3.5-turbo` is the cheap model** but not the most reliable for structured output on this task. `gpt-4o-mini` is the modern equivalent and cheaper than 3.5 was at launch. Easy upgrade.
- 🟠 No retry on transient OpenAI failures. A timeout = call gets only the heuristic analysis silently.
- 🟡 Analysis is async after webhook ack; results are stored but no notification fires when they land. UI must poll.
- 🟡 No cost-per-call tracking from this service.

### `backend/services/mangoScraper.js`
**What it does:** Puppeteer-based scraper that logs into Mango Voice and pulls call records + recordings.

**Good:**
- Heroic engineering. The fact that this works at all is impressive. ~1500 lines of selector + retry logic against a fragile target.
- Headless mode + download path config.

**Findings:**
- 🟠 **Selectors will break.** Mango portal changes = scraper down. There's no integration alert.
- 🟠 **Single browser instance** — no concurrency, no recovery from a hung Chrome process.
- 🟠 **Credentials in plain env** — no encrypted secret store.
- 🟠 **Login lockout risk** — repeated failed logins (e.g., during dev) will lock the office's Mango account.
- 🟡 **Recordings saved to local disk** at `recordings/mango/`. Not backed up. Not encrypted at rest. PHI on disk.
- 🟡 No graceful behavior under Mango outage — sync hangs until Puppeteer timeout.
- 🟡 Headless: 'new' was deprecated in Puppeteer; now `headless: true | 'shell'`. Will break on next major upgrade.

### `backend/services/openDentalSync.js`
**What it does:** Syncs call data into Open Dental as CommLog entries. Multi-strategy patient matching (phone exact, name+phone, name fuzzy). Uses both DB and API modes.

**Good:**
- Multi-strategy matching is exactly right.
- Confidence scoring per strategy.
- Both DB (`mysql2`) and API modes give flexibility — most competitors only do API.

**Findings:**
- 🟠 **MySQL connection: no pool, no timeout config visible from this file.** Long-lived process + flaky office network = stale connections, app freezes.
- 🟠 **No idempotency on CommLog writes.** Two webhook deliveries for the same call = two CommLogs in the patient chart.
- 🟠 **Confidence threshold `>= 0.7` is hardcoded.** Should be per-tenant.
- 🟠 **Sub-threshold matches are dropped to console warn.** No queue. No staff review UI. The patient match never gets corrected.
- 🟠 **Phone normalization is not robust.** `+15551234567` vs `(555) 123-4567` vs `5551234567` may not all match the same patient row depending on OD data hygiene.
- 🟡 Direct DB writes bypass Open Dental's permission model — the audit trail in OD shows the system user, not a real staff member.
- 🟡 No timezone handling on `CommDateTime`. If droplet TZ ≠ office TZ, CommLog timestamps are off.

### `backend/services/syncScheduler.js`
**What it does:** Cron-based scheduler for Mango + Retell syncs. Tracks history + status.

**Findings:**
- 🟠 **`isRunning` flag is in-memory.** Two instances would run sync simultaneously.
- 🟠 No backoff / circuit breaker for Mango. If Mango is down for hours, the scheduler keeps trying every cycle.
- 🟡 `syncHistory` is in-memory and capped at 50 — useful for the admin page but not for audit trail.

### `backend/services/transcriptionService.js`
**What it does:** Sends recordings to Deepgram for transcription.

**Findings:**
- 🟠 PHI to Deepgram — Deepgram does sign BAAs but verify it's executed and configured for HIPAA mode.
- 🟡 No retry / DLQ.
- 🟡 No cost tracking per minute.

---

## Backend — config

### `backend/config/retell.js`
**What it does:** Wraps Retell SDK calls with centralized credential handling.

**Findings:**
- 🟠 Hardcoded API base URL is fine; key from env. Verify no fallback to a literal string anywhere.
- 🟡 No per-tenant agent ID resolution — the API key + agent ID is one global value.

### `backend/config/openDental.js`, `backend/config/mango.js`, `backend/config/officeAgents.js`
**Common findings:**
- 🟠 Single-tenant config. Multi-tenant requires DB-driven config.
- 🟡 `officeAgents.js` exists but isn't consumed by the agents route (which returns mocks). Either dead or unfinished.

---

## Frontend (legacy) — `frontend/`

### Overview
React 18 + CRA + MUI + FullCalendar. Includes the live call view, calendar view, and a different visual style than `new-dashboard`.

**Findings:**
- 🟠 **Two products problem.** Legacy frontend has features (live calls, full calendar) the new dashboard lacks; new dashboard has features (Agent Builder, Scheduling Rules) the legacy lacks. Office uses both = chaos.
- 🟡 CRA is on its way out as a build tool. Stuck on React Scripts; no path to React 19.
- 🟡 MUI bundle is heavy.

---

## Frontend (new) — `new-dashboard/`

### `new-dashboard/client/src/App.tsx`
**What it does:** Wouter routes for Dashboard, Calls, CallDetail, AgentBuilder, Scheduling, Analytics, Admin.

**Findings:**
- 🟢 Lightweight router choice, fine for the page count.
- 🟠 No auth-gate route protection. Anyone with the URL gets full UI.

### `new-dashboard/client/src/pages/Dashboard.tsx`
**What it does:** Home page — stats, call volume chart, recent calls, callbacks queue.

**Findings:**
- 🟠 Call volume chart hardcoded 8a–5p. Doesn't reflect after-hours calls (which is one of the highest-value use cases of an AI receptionist).
- 🟡 Polls multiple endpoints sequentially; no consolidated `/api/dashboard` summary endpoint, so first paint is slow over slow networks.
- 🟡 No empty / loading / error states unified across data sources — one source failing leaves the page partially broken.
- 🟢 Visual design is clean. Dark mode toggle present.

### `new-dashboard/client/src/pages/Calls.tsx`
**What it does:** Unified call log with search and filters; callbacks tab; manual sync trigger.

**Findings:**
- 🟠 Manual Retell sync button has no progress indication beyond toast — at scale syncing 200 calls takes a while.
- 🟡 Search is client-side — won't scale beyond a few thousand visible rows.
- 🟡 Filters don't persist across navigations.

### `new-dashboard/client/src/pages/AgentBuilder.tsx`
**What it does:** UI to configure the AI agent's prompt and knowledge base.

**Findings:**
- 🔴 **`handleSave` writes only to `localStorage`.** Backend never sees it. Retell never sees it. The agent on the call never sees it.
- 🔴 **Default prompt has unfilled placeholders** (`{{office_name}}`, `{{knowledge_base}}`). Without server-side templating, these would be spoken literally.
- 🟠 **"Copy Prompt" is the actual workflow** — operator must paste it into Retell's dashboard. Undocumented in the UI.
- 🟠 No version history. No "publish" vs "draft."
- 🟠 No test-call simulation from inside the builder.
- 🟢 Knowledge base section structure (hours / locations / providers / services / insurance / policies) is exactly right.

### `new-dashboard/client/src/pages/Scheduling.tsx`
**What it does:** Two tabs — AI Scheduling Rules (toggle list) and Open Dental Calendar (read-only view).

**Findings:**
- 🔴 **"Save Rules" button is `onClick={() => toast.success(...)}`.** Pure theater.
- 🔴 **Rules don't influence the agent.** The agent runs whatever's in Retell.
- 🟠 Calendar is read-only — booking + reschedule require staff intervention.
- 🟢 The default rules themselves (new adult no-recall, new adult with-recall, existing patient, emergency, ortho adjustment) are excellent — exactly the right taxonomy.

### `new-dashboard/client/src/pages/Admin.tsx`
**What it does:** Health status, system config, cost summary, integration tests.

**Findings:**
- 🟠 "Offices" and "Users" tabs are stubs.
- 🟠 Cost summary not authoritative — based on local logs, not vendor APIs.
- 🟢 Health surface is well-designed; tells the operator what's up.

### `new-dashboard/client/src/pages/Analytics.tsx`
**Findings:**
- 🟠 Limited KPIs — no booking rate, no after-hours capture, no funnel.
- 🟡 Sentiment chart powered by the keyword sentiment analyzer (low signal).

### `new-dashboard/client/src/pages/CallDetail.tsx`
**Findings:**
- 🟠 Transcript displayed as flat block; no entity highlighting, no side-by-side analysis.
- 🟡 Recording playback is basic HTML5 audio.

---

## Auxiliary services

### `od-microservice/`
**What it does:** TypeScript Express service for Open Dental access — appears to be unused.

**Findings:**
- 🟠 **Dead code or unfinished.** If unused, delete to reduce confusion. If unfinished, document its intended purpose.

### `mcp/retell_mcp.py`
**What it does:** Standalone Python MCP server for Retell.

**Findings:**
- 🟢 Standalone tool, not in the deploy path. Useful for engineering, not user-facing.

---

## Deployment / ops

### `ecosystem.config.js`
**What it does:** PM2 process manifest — three apps: backend, frontend, new-dashboard.

**Findings:**
- 🔴 **`new-dashboard` runs `node_modules/.bin/next start`** — but `new-dashboard/package.json` declares Vite, not Next.js. The new dashboard will not boot from PM2 as configured.
- 🟠 No restart limits, no max memory, no log rotation.

### `nginx.conf`, `frontend/nginx.conf`
**Findings:**
- 🟠 Plain HTTP in some configs, HTTPS via Cloudflare tunnel only.
- 🟡 No gzip / brotli observed in the conf I reviewed.

### `docker-compose.yml`, `docker-compose.dev.yml`
**Findings:**
- 🟡 Compose files exist but the production deploy is bare PM2 on a droplet, so compose isn't authoritative. Drift risk.

### `cloudflared-config.yml`
**Findings:**
- 🟢 Cloudflare tunnel adds a layer of defense in depth.
- 🟡 Tunnel as the only network boundary — if cloudflared crashes, the office is offline.

### `setup.sh`
**Findings:**
- 🟠 Manual setup script as the install path. Should be replaced by IaC and a runbook. Not blocker for beta but blocker for replication.

---

## Data files / state

### `data/unified_calls.json`
**Findings:**
- 🔴 The product's database. Not encrypted at rest. Not backed up. Race-prone on writes.

### `recordings/mango/*`
**Findings:**
- 🔴 PHI on disk. Not encrypted. Not backed up.

### `calls_data.json` (legacy)
**Findings:**
- 🟡 Possibly a legacy artifact from a prior version. Verify and remove if unused.

---

## Documentation

### `LIVE_PRODUCTION_TEST_RESULTS.md`
**Findings:**
- 🔴 **Contains a real OpenAI API key.** Rotate now.

### `README.md`, `CLAUDE.md`, `AGENTS.md`
**Findings:**
- 🟡 Documentation describes intent more than reality. Several documented features (Agent Builder save, Scheduling Rules) don't behave as docs imply.

### `.claude/worktrees/*` and `new-dashboard/.claude/worktrees/*`
**Findings:**
- 🟡 Multiple agent worktrees committed to the repo — `flamboyant-dhawan`, `keen-golick`, `quizzical-ellis`, `charming-turing`, `competent-solomon`, `elegant-montalcini`, `blissful-feistel`. These are duplicate copies of `backend/` and `new-dashboard/`. They confuse code search, balloon repo size, and may contain stale or conflicting code that gets accidentally referenced.
- **Action:** Add to `.gitignore` and remove from history.

---

## Cross-cutting findings

### Logging
- 🟠 Most logs use emoji-prefixed `console.log`. Not parseable. Not shipped anywhere. Not redacted.

### Error handling
- 🟠 Most async paths have generic `try/catch` that logs and continues. No errors fired to a tracker. Office never sees them.

### Tests
- 🔴 **Zero automated tests** in the repo (no `__tests__`, no `*.test.ts`, no Jest/Vitest config).

### TypeScript usage
- 🟢 `new-dashboard` is TS. `backend/` is JS. `od-microservice/` is TS. Inconsistent — backend would benefit from strict TS.

### Versioning
- 🟡 No API versioning (`/api/v1/...`). Future breaking changes will hurt.

### Config
- 🟠 Heavy reliance on env vars. No central config schema (e.g., Zod). Misconfigurations surface as runtime errors instead of startup failures.

### Multi-tenancy
- 🔴 Not designed for. Every assumption (single OD connection, single Retell agent, single Mango account, hardcoded production domain) breaks at customer #2.

### Worktree pollution
- 🟠 The `.claude/worktrees/` directories pollute search results, backups, and CI scope. Remove.

---

## Top "smells"

1. **Save buttons that don't save.** Agent Builder, Scheduling Rules. Pure UI theater.
2. **Mocks that look real.** Agents API returns hardcoded data; consumers can't tell.
3. **PHI everywhere it shouldn't be.** OpenAI without BAA, recordings on disk, transcripts in stdout logs.
4. **In-memory state where durability matters.** Callbacks, live calls, sync scheduler status.
5. **Single big JSON file as a database.** Race conditions waiting to happen.
6. **Auth conspicuously missing.** Across backend, sockets, admin routes.
7. **Two frontends.** With different features, different visual languages.
8. **Production-disabled-by-flag security.** Webhook HMAC, test endpoints. Dev-mode disables are a footgun in disguise.
9. **Worktrees committed.** Repository hygiene issue.
10. **Dental product with medical-product mock data.** "Pharmacy Assistant" agent.

---

## What's actually well-built

To give credit where due:
- **Open Dental sync with multi-strategy matching** is genuinely good engineering.
- **Mango scraper** is heroic and works.
- **Unified call store normalization** is a clean idea, even if the persistence layer is wrong.
- **Knowledge base IA** in the Agent Builder.
- **Default scheduling rules taxonomy** — exactly right.
- **Call analyzer prompt structure** — well thought out, just on the wrong infrastructure.
- **The new dashboard's visual design** — clean shadcn/Tailwind, good information hierarchy.
- **Health surface in the Admin page** — operationally useful.
- **The bones of the call pipeline** (Retell → webhook → store → CommLog) — the right architecture, just under-built.

This product is not a prototype that needs a rewrite. It's a 60% product that's been wired with placeholder behavior in places that look real. Closing the gap is mostly about *replacing* fakes with real implementations — not redesigning.

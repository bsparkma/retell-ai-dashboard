# 08 — Prioritized Fix Roadmap (revised)

> **Status update — Phases A → B → C complete.**
>
> ### ✅ Shipped (code-side)
>
> | ID | Item | Where the fix lives |
> | --- | --- | --- |
> | P0-01 | Retell key scrubbed from live code + docs (rotation = ops) | `setup.sh`, `docker-compose.dev.yml`, all docs; rotation tracked in `12-verification-checklist.md` |
> | P0-02 | Retell webhook HMAC verification rewritten to spec | `backend/routes/webhooks.js` |
> | P0-03 | Agent Builder honest + Publish-to-Retell wired | `new-dashboard/client/src/pages/AgentBuilder.tsx` |
> | P0-04 | Scheduling Rules honesty banner | `new-dashboard/client/src/pages/Scheduling.tsx` |
> | P0-05 | Callback queue persists atomically; sample seed removed | `backend/routes/callbacks.js` |
> | P0-06 | 911 directive in default prompt; medical vs dental emergency split | `AgentBuilder.tsx`, `backend/services/liveCallManager.js` |
> | P0-07 | Recording disclosure in default first-turn prompt | `AgentBuilder.tsx` |
> | P0-08 | Bearer-token auth on `/api/*` and Socket.IO | `backend/middleware/auth.js`, `backend/server.js`, both frontends |
> | P0-09 | Atomic write + debounce for `unified_calls.json` | `backend/services/unifiedCallStore.js` |
> | P0-10 | PM2 entry fixed for new dashboard | `ecosystem.config.js` |
> | P0-11 | Pilot setup doc | `PILOT_OFFICE_SETUP.md` |
> | P0-12 | QA pass procedure | `cursor-audit/13-qa-pass-procedure.md` |
> | P1-04 | Agent Builder publishes to Retell agent | `AgentBuilder.tsx`, `backend/routes/agents.js` (already had it) |
> | P1-06 | Retell function-call tool surface | `backend/routes/retellTools.js`, `docs/retell-tools.md` |
>
> ### 🟡 Still ahead before pilot
>
> - All items in `cursor-audit/12-verification-checklist.md` (rotate Retell key, BAA confirmation, droplet disk encryption, network exposure, run the LK-01 / LK-02 verification scripts).
> - One full QA pass per `13-qa-pass-procedure.md`.
> - First-office deploy per `PILOT_OFFICE_SETUP.md`. Operate with `RETELL_TOOLS_ENABLED=false` for the first 1–2 weeks; flip on per `docs/retell-tools.md` once stable.
>
> ### 🔴 Deferred (still on the roadmap, not shipped)
>
> P1-01 (real DB), P1-02 / P1-03 / P1-11 / P1-13 (multi-tenant + real auth), P1-05 (rules enforcement), P1-07 (CommLog idempotency), P1-08 (webhook DLQ), P1-09 (phone normalization both sides), P1-10 (PHI scrubbing in logs + at-rest encryption), P1-12 (OD connector hardening), and all of P2 / P3.
>
> The pre-fix roadmap below is preserved for context; treat the table above as the source of truth for status.

---

This roadmap is the answer to one question: **what is the smallest set of work that lets a real dental office accept this product on the first day, and then what comes after?**

It is intentionally short. Items are evidence-anchored to file:line from `11-evidence-and-confidence.md`. Anything that wasn't grounded in the code has been removed.

Effort scale is for one mid/senior engineer:
- **XS** = < 1 day · **S** = 1–3 days · **M** = 1–2 weeks · **L** = 2–4 weeks

Priority bands:
- **P0** — Block beta. Don't take a single live patient call without these.
- **P1** — Block production / commercial sale.
- **P2** — Closes meaningful gaps post-beta.
- **P3** — Polish.

If a "fix" doesn't change the answer to *"can a real office safely use this on Monday?"*, it doesn't belong in P0.

---

## P0 — Block beta

### P0-01. Rotate the Retell API key
- **Evidence:** `setup.sh:39` — literal `RETELL_API_KEY=key_5286e8b619b00ed6815991eba586`. Key also appears in `CURSOR_PRODUCTION_FIXES.md:17` and across the `.claude/worktrees/*` copies.
- **Why it matters in a real office:** Anyone reading the repo can run minutes against the practice's Retell account, and read every Retell-stored call.
- **Fix:**
  1. Rotate the key in Retell.
  2. Strip the literal from `setup.sh` (replace with `read -p` or env requirement).
  3. Grep all `.claude/worktrees/*` and remove copies, or delete those worktrees.
  4. Move secrets out of repo and into env-only / secret manager.
- **Effort:** XS (rotate) + S (cleanup of all copies + history)

### P0-02. Make the Retell webhook signature actually verify
- **Evidence:** `backend/routes/webhooks.js:20-41`. Implementation re-stringifies parsed body (Retell signs raw bytes), compares the entire `v=…,d=…` header against just a hex digest (length mismatch makes `crypto.timingSafeEqual` throw), no timestamp parsing, bypassed entirely when `NODE_ENV !== 'production'`.
- **Why it matters in a real office:** Today the webhook accepts anything in dev and rejects everything (via thrown error caught and 200'd) in prod. Either an attacker can inject fake calls into the patient record system, or no real calls are being processed at all. Both are unacceptable.
- **Fix:**
  1. Use `express.raw({ type: 'application/json' })` for `/api/webhooks/retell`.
  2. Parse `v=...,d=...` from `x-retell-signature`.
  3. Compute `HMAC-SHA256(rawBody + timestamp, RETELL_API_KEY)`.
  4. Compare the **digest portion** with `timingSafeEqual` after asserting equal lengths.
  5. Reject if timestamp is older than 5 minutes.
  6. Remove the `NODE_ENV !== 'production'` bypass entirely; instead require a `RETELL_WEBHOOK_DEV_SKIP=true` opt-in for local testing.
  7. Or: use `Retell.verify()` from the official SDK.
- **Effort:** S

### P0-03. Stop the Agent Builder from lying
- **Evidence:** `new-dashboard/client/src/pages/AgentBuilder.tsx:295-298` — Save writes only to `localStorage`. `backend/routes/agents.js:6-22` returns four hardcoded mock agents.
- **Why it matters in a real office:** The office manager will edit the prompt, click Save, and watch the very next call produce the old behavior. Trust collapses on day one.
- **Fix (smallest viable):**
  1. Remove the **Save** button OR rename it to **Save draft (local)** and add a banner that says: *"This does not change the live agent. To deploy, copy the prompt and paste it into Retell."*
  2. Make the existing **Copy Prompt** button the primary action.
  3. Show a `Last deployed:` field that the operator types in by hand for now.
- **Why this and not "wire up to Retell update_agent":** Doing the real wiring is the right answer (P1-04 below) but it's M-effort and not strictly necessary for the first pilot office, **provided** the UI stops claiming the save did something.
- **Effort:** XS

### P0-04. Stop the Scheduling Rules screen from lying
- **Evidence:** `new-dashboard/client/src/pages/Scheduling.tsx:279-281` — Save Rules is a `toast.success(...)` and nothing else.
- **Why it matters in a real office:** Office manager toggles "lunch block 12-1pm" and patients get booked at 12:30. Trust collapses.
- **Fix (smallest viable):**
  1. Either: hide the Save button and show banner *"Rule editing coming soon. To change scheduling behavior, edit the prompt in Agent Builder."*
  2. Or: persist the rules to a backend JSON file behind `/api/scheduling/rules` and show *"Rules saved (not yet enforced — they will guide the AI in a future release)"*.
- **Effort:** XS

### P0-05. Persist the callback queue (real DB or at least a real file)
- **Evidence:** `backend/routes/callbacks.js:11, 261-329` — `let callbacks = []`, populated with sample callers (`John Smith`, `Mary Johnson`) on every startup.
- **Why it matters in a real office:** Real callbacks created today are erased on restart. Sample fake patients sit in the queue forever; staff can't tell real from fake.
- **Fix (smallest viable for beta):**
  1. Delete `createSampleCallbacks()` and the call to it.
  2. Persist `callbacks` to `data/callbacks.json` on every mutation, with atomic write (`tempfile + rename`).
  3. Load from disk on startup.
- **Better fix (P1):** Move to a real DB.
- **Effort:** S (file persistence) / M (DB)

### P0-06. Add a 911 directive to the live agent prompt; stop labeling medical emergencies as bookable urgencies
- **Evidence:** `backend/services/liveCallManager.js:262-269` includes `chest pain` and `can't breathe` in the dental "is_emergency" keyword list. The repo has no Retell-side prompt to inspect, so the deployed agent's behavior is unverified.
- **Why it matters in a real office:** A caller in genuine medical distress should be told to hang up and dial 911. Telling them "we'll get you in tomorrow" is a patient-safety failure and a liability event.
- **Fix:**
  1. Read the deployed Retell agent prompt; if it lacks a medical-emergency 911 directive, add it to the top of the prompt.
  2. Update `liveCallManager.js` to split medical emergencies (911 escalation event) from dental urgencies (priority booking event).
  3. Add a regression test scenario in `09-testing-plan.md` for chest pain.
- **Effort:** S

### P0-07. Add a recording disclosure to the agent's first turn (in two-party-consent states)
- **Evidence:** Repo has no Retell prompt to inspect; AgentBuilder default in `new-dashboard/client/src/pages/AgentBuilder.tsx` does not include a recording disclosure.
- **Why it matters in a real office:** In CA, FL, IL, MD, MA, MT, NH, PA, WA (and others), failing to disclose recording is a legal violation. The pilot office's location dictates whether this is mandatory or merely good practice.
- **Fix:** Add to first agent turn: *"Hi, this is [office name]'s virtual receptionist. This call may be recorded so we can help you better. How can I help you today?"*
- **Effort:** XS

### P0-08. Authenticate the backend
- **Evidence:** `backend/server.js:91-102` mounts routers without any auth middleware. None of `webhooks.js`, `callbacks.js`, `agents.js`, `admin.js` check for a session/token. Socket.IO has no auth.
- **Why it matters in a real office:** Anyone with the API URL can read every patient call, view live transcripts, and trigger admin actions like the Mango Puppeteer login.
- **Fix (smallest viable for one pilot office):**
  1. Add a single shared bearer token middleware `requireApiKey` for all `/api/*` except `/api/webhooks/retell` (which has its own HMAC) and `/api/health`.
  2. Add the same token check to the Socket.IO connection handler.
  3. Document the token in PRODUCTION_SETUP.md.
- **Better fix (P1):** Real session auth (Auth0/Clerk/Supabase) tied to office accounts.
- **Effort:** S (shared token) / L (real auth + multi-office)

### P0-09. Atomic write the unified call store, or move it to a DB
- **Evidence:** `backend/services/unifiedCallStore.js:32, 472-490` — `fs.writeFile(this.persistPath, JSON.stringify(...))` with no temp-file-and-rename. Webhook handlers in `backend/routes/webhooks.js` call `persist()` on every event including each transcript fragment.
- **Why it matters in a real office:** A single power blip during a write loses every call record on disk. After ~5,000 calls the file is large enough that the rewrite-on-every-event pattern becomes a noticeable hit.
- **Fix (smallest viable for beta):**
  1. Atomic write: write to `data/unified_calls.json.tmp`, then `fs.rename` to `data/unified_calls.json`.
  2. Debounce persist to ~1/sec so transcript bursts don't thrash the file.
  3. On startup, if the file is unparseable, fall back to a backup written every hour.
- **Better fix (P1):** Postgres / SQLite. Backend already speaks MySQL for OD; adding SQLite is XS.
- **Effort:** S (atomic + debounce) / M (move to SQLite)

### P0-10. Fix the PM2 startup for the new dashboard
- **Evidence:** `ecosystem.config.js:24-26` runs `node_modules/.bin/next start`; `new-dashboard/package.json` has no `next` package and the real start script is `NODE_ENV=production node dist/index.js`.
- **Why it matters in a real office:** PM2 fails silently on the dashboard process; only the legacy frontend is reachable. Most operators won't know to look at PM2 logs.
- **Fix:** Change the script entry to:
  ```js
  script: 'dist/index.js',
  interpreter: 'node',
  ```
  And ensure the build runs in deploy.
- **Effort:** XS

### P0-11. Pilot-office "small office, one location" sandbox
- **Why it matters in a real office:** The first office that goes live needs an isolated environment so a bug doesn't blast across multiple practices. Right now everything is one shared installation with a single hardcoded production domain (`backend/server.js:37-43`).
- **Fix (smallest viable for beta):**
  1. One pilot = one droplet, one Retell agent, one OD database, one set of env vars.
  2. Document the bootstrap in PRODUCTION_SETUP.md (env vars, secret rotation, OD pool config, recording-storage path).
  3. Keep the dashboard read-only-on-things-that-aren't-real (P0-03, P0-04) so the pilot office doesn't expect features that don't ship yet.
- **Effort:** S (only because the deploy story already exists; just write it down)

### P0-12. Internal QA pass against `09-testing-plan.md`
- **Why it matters in a real office:** Most of these issues only show up under live call load. Run the dental-specific scenarios in `09-testing-plan.md` against a Retell sandbox number before pointing the real practice number at the agent.
- **Effort:** S

**Summary of P0:** ~2 weeks of focused work for one engineer. Nothing in this list requires new architecture. All items are well-scoped.

---

## P1 — Block production / commercial sale

These items are not strictly necessary for one trusted pilot office that the team monitors closely. They are required before the second customer or before public launch.

### P1-01. Real persistent storage for calls + callbacks (drop the JSON files)
- **Evidence:** CF-09, CF-06.
- **Fix:** SQLite (single-tenant) or Postgres (multi-tenant). Write a thin repository layer; keep the existing `unifiedCallStore` API surface so consumers don't change.
- **Effort:** M

### P1-02. Multi-tenant identity model
- **Evidence:** `backend/server.js:37-43` hardcodes one production domain. `backend/config/openDental.js` reads one set of OD env vars. There is no `office_id` on call records.
- **Fix:** Add `office_id` foreign key to all call/callback records. Resolve `office_id` from the Retell agent's metadata or phone number. Store per-office config (Retell agent ID, OD connection, scheduling rules) in DB.
- **Effort:** L

### P1-03. Real auth + role-based access for office staff
- **Fix:** Office accounts, user invites, role per user (admin / front desk / read-only). Use a managed identity provider rather than rolling your own.
- **Effort:** L

### P1-04. Wire the Agent Builder to Retell's `update_agent` / `update_llm`
- **Evidence:** CF-03; backend already has `retellService.updateAgent` (`backend/config/retell.js:115-122`).
- **Fix:** New endpoint `POST /api/agents/:id/publish` that accepts the prompt + KB, renders the final string, calls Retell. Persist the canonical config server-side. Add version history.
- **Effort:** M

### P1-05. Make Scheduling Rules actually constrain bookings
- **Evidence:** CF-04. The scheduling-rule taxonomy in `Scheduling.tsx` is dental-correct; the gap is enforcement.
- **Fix:** Persist rules. When the agent attempts a booking via P1-06, validate against the rules before calling OD. Refuse / suggest alternatives if violated.
- **Effort:** M

### P1-06. Expose backend booking tools to the Retell agent
- **Evidence:** Correction D — `searchPatients`, `bookAppointment`, `findAlternativeTimeSlots`, `verifyPatientAppointments` all exist in `backend/config/openDental.js`. They're just not registered as Retell tools.
- **Fix:** Register Retell function-calling tools that proxy to these endpoints. Each tool returns a strict JSON shape so the agent can speak the result naturally. Start with `lookup_patient`, `find_available_slots`, `book_appointment`.
- **Effort:** M

### P1-07. CommLog idempotency
- **Evidence:** CF-11 / LK-01.
- **Fix:** Before insert, check OD for an existing CommLog with `external_call_id = call.call_id`. Skip if present.
- **Effort:** S

### P1-08. Webhook DLQ + alerting
- **Evidence:** CF-10.
- **Fix:** Persist failed webhooks to a dead-letter table. Send a Slack/email alert. Provide an admin button to retry.
- **Effort:** S

### P1-09. Phone number normalization on both sides of patient match
- **Evidence:** CF-13.
- **Fix:** In `searchPatientsFromDB`, normalize the stored `HmPhone` / `WkPhone` in the SQL (`REGEXP_REPLACE` to digits) and compare to the digits-only query. Or pre-store a `phone_digits` derived column.
- **Effort:** S

### P1-10. PHI handling: BAA confirmation + at-rest encryption + log scrubbing
- **Evidence:** LK-07, CF-19, CF-17.
- **Fix:**
  1. Confirm BAA with OpenAI (or switch to a BAA-covered provider/model).
  2. Encrypt the droplet's data volume (or move data + recordings to S3 with SSE).
  3. Replace `morgan('combined')` with a custom format that drops query strings or scrubs known PHI fields.
- **Effort:** S (scrubbing) + L (BAA + encryption is mostly ops work)

### P1-11. Per-office Retell agent config
- **Fix:** Each office has its own Retell agent with its own prompt + KB. The Agent Builder publishes to that office's agent only.
- **Effort:** S after P1-02.

### P1-12. Production-grade Open Dental connector hardening
- **Evidence:** CF-12 (`SHOW COLUMNS` on every calendar fetch); LK-06 (silently-ignored timeout options).
- **Fix:** Cache OD table schema on first call. Replace `acquireTimeout`/`timeout` with `connectTimeout`. Wrap each OD call with circuit-breaker + per-call timeout.
- **Effort:** S

### P1-13. CORS allowlist driven by office records, not hardcoded
- **Evidence:** CF-16.
- **Fix:** Read allowed origins from the office DB. Default to none in production.
- **Effort:** XS after P1-02.

---

## P2 — Important after beta

### P2-01. Move recordings off the local droplet
- **Fix:** S3 with SSE-KMS, signed URLs in the dashboard. Retention policy.
- **Effort:** M

### P2-02. Observability stack
- **Fix:** Pino structured logs (drop morgan). One APM (Datadog/Sentry/Honeycomb). Dashboards for: webhook success rate, OD write success rate, sync lag, AI summary accuracy, call duration distribution.
- **Effort:** M

### P2-03. Office-level analytics
- **Fix:** Funnel: calls → AI handled → booked → confirmed → showed up. By appointment type.
- **Effort:** M

### P2-04. Onboarding wizard
- **Fix:** Step-by-step that captures: practice name, hours, providers, OD credentials, Retell account, recording disclosure preferences, emergency policy. Output a deployable agent at the end.
- **Effort:** L

### P2-05. Replace CallAnalyzer's 2000-char truncation with windowed/full-transcript analysis
- **Evidence:** CF-15.
- **Fix:** For long transcripts, summarize in chunks then merge. Or just bump to gpt-4o-mini with full context — it costs cents per call.
- **Effort:** S

### P2-06. Decommission the legacy frontend
- **Fix:** Move the few remaining unique features (FullCalendar view, etc.) to the new dashboard. Take down PM2 entry. Remove `frontend/` from CI.
- **Effort:** M

### P2-07. Mango sync stability
- **Fix:** Health-check the Mango portal selectors weekly via a synthetic run. Alert if it breaks. Long-term: replace with Mango's API if it exists.
- **Effort:** S (alerting) / L (replacement)

### P2-08. Test coverage on the critical paths
- **Fix:** Unit tests for HMAC verification, normalization (phone, name), patient match, atomic write, OD CommLog idempotency. One e2e Playwright run that exercises the dashboard.
- **Effort:** M

---

## P3 — Polish

### P3-01. Remove the committed `.claude/worktrees/*` from main branch
- **Effort:** XS

### P3-02. Voice quality QA — listen to recordings, log mispronunciations
- **Effort:** S/ongoing

### P3-03. Confirmation/SMS workflow
- **Effort:** M

### P3-04. Public status page
- **Effort:** S

### P3-05. Accessibility pass on the dashboard
- **Effort:** M

---

## What I removed from the previous version of this roadmap

- The 12-sprint, 24-week generic timeline. It was filler.
- "Top tier products do X" comparisons that weren't tied to a specific gap.
- "Office uses two products forever" framing.
- Items about OpenAI / chat history / structured agent routing that weren't supported by the actual code path being broken today.
- "Build a TypeScript microservice" — `od-microservice/` is dead code (nobody calls it). Marking it for deletion is P3, not P0.

## Realistic launch path

If a team wants to put this in front of one trusted dental office in the next two weeks:
1. Day 1–2: P0-01, P0-02, P0-08, P0-10. (Security + deploy.)
2. Day 3–5: P0-03, P0-04, P0-05, P0-09. (Make the UI stop lying; persist real data.)
3. Day 6–8: P0-06, P0-07, P0-11. (Patient safety + pilot env.)
4. Day 9–10: P0-12. (QA the scenarios in `09-testing-plan.md`.)
5. Days 11–14: pilot soak with shadow mode (Retell agent answers a forwarded line, real receptionist still on the main line) so failures are caught without affecting patients.

That's the minimum bar for a single pilot office. **None of P1 is required for that pilot,** but every P1 item is required before a second customer.

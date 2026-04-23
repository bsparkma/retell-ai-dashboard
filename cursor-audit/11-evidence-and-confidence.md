# 11 — Evidence and Confidence

> **Status update — Phases A → B → C complete.**
>
> The original evidence below is unchanged on purpose: every claim was a
> point-in-time observation against a specific commit, and rewriting it
> would erase the baseline. The fix status is tracked in
> `08-prioritized-fix-roadmap.md` (✅ table at the top), and the new
> readiness picture is in `01-executive-summary.md` §0.
>
> Of the items below, the ones whose root cause has been addressed in
> this round are:
>
> - **CF-01** webhook HMAC verification (rewritten to spec)
> - **CF-02** Retell key in repo (scrubbed code-side; rotation pending ops)
> - **CF-03** Agent Builder "Save" (now publishes to Retell + honest UI)
> - **CF-04** Scheduling Rules Save (UI honesty only; enforcement still on roadmap as P1-05)
> - **CF-05** mock agents — agents endpoint already calls real Retell when reachable, dashboard now displays mock-vs-api source on publish
> - **CF-06** callbacks in-memory + sample data (now atomic-write JSON, seed removed)
> - **CF-07** PM2 startup
> - **CF-08** no backend auth (bearer-token middleware on `/api/*` and Socket.IO)
> - **CF-09** unified call store atomicity (atomic write + debounce)
> - **CF-14** medical-vs-dental emergency keyword split
> - **LK-04** 911 directive in default agent prompt
> - **LK-05** recording disclosure in default agent first turn
>
> Still requiring a runtime check: **LK-01** (CommLog idempotency under
> webhook retries) and **LK-02** (phone-format mismatch on patient
> match). Scripts to verify both live in `cursor-audit/scripts/`.
>
> Everything else in this file remains as originally documented.

This file is a self-review of the audit. I went back and re-read the code to test the claims I made in files 01–10. Where a claim was loose, generic, or unsupported, I either tightened it with evidence or struck it. Where I had a finding right but mislabeled the file or vendor, I correct it here.

This file supersedes any conflicting wording in files 01–10. The roadmap (file 08) and the executive summary (file 01) have also been updated to align with what's below.

## Severity + confidence taxonomy

- **Severity** — what happens if it's not fixed before live use.
  - 🔴 Critical — patient safety, legal/HIPAA, or immediate data loss
  - 🟠 High — material business risk; office will lose trust
  - 🟡 Medium — quality issue, fixable post-beta
  - 🟢 Low / Note — observation, not a blocker
- **Confidence** — how sure I am.
  - **Confirmed** — verified against specific file + line in this codebase, or against the vendor's public docs
  - **Likely** — inferred from observed code patterns; would need a runtime test to confirm 100%
  - **Possible** — a real risk class but not directly observed in this code

If a finding doesn't have a file:line and an evidence quote, treat it with skepticism.

---

## Corrections to earlier audit claims

### Correction A — Leaked API key (which file and which vendor)
- **What I previously claimed:** "A real OpenAI API key is committed in `LIVE_PRODUCTION_TEST_RESULTS.md`."
- **What is actually true:** That file does not exist. The leaked key is a **Retell** API key, not OpenAI, and it sits in `setup.sh:39` and is referenced in `CURSOR_PRODUCTION_FIXES.md:17`. Files in `.claude/worktrees/*` and `new-dashboard/.claude/worktrees/*` repeat the same string.
- **Evidence:** `setup.sh:39` — `cp backend/.env.example backend/.env 2>/dev/null || echo "RETELL_API_KEY=key_5286e8b619b00ed6815991eba586`. `CURSOR_PRODUCTION_FIXES.md:17` — `this.apiKey = process.env.RETELL_API_KEY || 'key_5286e8b619b00ed6815991eba586';` (this latter line is in a fix-doc snippet describing the prior bad pattern; the live `backend/config/retell.js:5` correctly uses `process.env.RETELL_API_KEY` only).
- **Severity / confidence:** 🔴 Critical / Confirmed.

### Correction B — `backend/config/retell.js` does NOT have a hardcoded fallback
- **What I previously implied:** All API keys hardcoded.
- **What is actually true:** `backend/config/retell.js:5` reads `process.env.RETELL_API_KEY` only; there is no hardcoded fallback in the live config. The hardcoded fallback exists only in `setup.sh` and in a documentation example. Don't overstate this.

### Correction C — Open Dental DB has a connection pool
- **What I previously claimed:** "MySQL connection: no pool, no timeout config visible from this file."
- **What is actually true:** `backend/config/openDental.js:70-82` creates `mysql.createPool` with `connectionLimit: 10`, `acquireTimeout: 60000`, `timeout: 60000`, `reconnect: true`. Pool exists. (`acquireTimeout` and `timeout` are not actually valid `mysql2` options as of recent versions — they're silently ignored — but that's a separate, smaller issue.)
- **Severity / confidence:** 🟡 Medium / Confirmed (the silent-ignore part).

### Correction D — Open Dental backend tools are real and exist
- **What I previously implied:** "The AI has no tools — it can talk but cannot do — no booking, no lookup, no transfer."
- **What is actually true:** `backend/config/openDental.js` has functioning real implementations of:
  - `searchPatients` / `searchPatientsFromDB` (line 856 / 918)
  - `bookAppointment` (line 652)
  - `checkSchedulingConflicts` (line 446)
  - `findAlternativeTimeSlots` (line 583)
  - `updateAppointment` (line 737)
  - `cancelAppointment` (line 809)
  - `verifyPatientAppointments` (line 985)
- **Refined finding:** The tools exist as backend code. They are **not exposed to the Retell agent as tools** (no `register_tool` / function-calling wiring is present in `backend/routes/agents.js` or anywhere else I could find), and they are **not invoked from the webhook path** during a live call. So the AI in production cannot use them, but the *backend* can. This is a much smaller lift than building them from scratch.
- **Severity / confidence:** 🟠 High / Confirmed (gap is in agent integration, not in backend code).

### Correction E — "PHI in stdout logs"
- **What I previously claimed:** "Transcripts in stdout logs."
- **What is actually true:** `backend/routes/webhooks.js:67-71` logs only `event.event`, `call_id`, and `timestamp` — not the transcript. The transcript is logged as part of CommLog notes (`backend/routes/webhooks.js:239-247`) but those land in OD, not stdout. `backend/services/liveCallManager.js:53` logs caller phone (`from ${call.caller_number}`). `backend/services/openDentalSync.js:267` logs patient last/first name on success.
- **Refined finding:** Phone numbers and patient names are logged. Full transcripts are not. Still a PHI-in-logs concern but smaller than I implied.
- **Severity / confidence:** 🟠 High / Confirmed.

### Correction F — Generic claims I'm walking back
- "OpenAI without a BAA" — I do not have evidence for or against. The product *might* already have a BAA in place. I'm reclassifying this as a **Possible** risk that operations needs to confirm.
- "AI is talking over patients" / "awkward endings" — I have no audio evidence. Removed from confirmed claims; live QA testing will surface these.
- "Office uses two products forever" — opinion, not finding. Removed.
- "Top-tier products give the AI a real toolbelt and then constrain it" — generic SaaS advice. Removed.
- "First commercial customer breaks the first" — opinion phrasing. Replaced with the specific tenancy gap (single hardcoded production domain in `backend/server.js:38`, single OD config object, single agent ID).

---

## Confirmed findings (file:line + reason it matters in a real dental office)

### CF-01. Retell webhook signature verification is broken in two ways
- **File:** `backend/routes/webhooks.js:20-41`
- **Evidence:**
  ```js
  function verifyRetellSignature(req) {
    if (process.env.NODE_ENV !== 'production') return true;
    const signature = req.headers['x-retell-signature'];
    ...
    const body = JSON.stringify(req.body);
    const expected = crypto.createHmac('sha256', apiKey).update(body).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  }
  ```
- **Why it matters:** Retell's documented signature format is `v={timestamp_ms},d={hex_digest}` over the **raw request body + timestamp**, signed with the API key (Retell docs: "Secure the webhook"). This implementation:
  1. Bypasses verification when `NODE_ENV !== 'production'` (one env var away from open).
  2. Re-stringifies the parsed body instead of using raw bytes — even with the right format, the digest would not match.
  3. Compares the entire `v=...,d=...` header string against just the hex digest — different lengths, so `crypto.timingSafeEqual` will **throw** (it requires equal-length buffers).
  4. Doesn't extract or validate the `v=` timestamp, so no replay-attack window enforcement.

  Net effect: in dev, the endpoint accepts anything. In production, every webhook either throws (caught by the outer `try/catch` and 200'd back) or is rejected. Either way, real Retell calls don't get verified.

  In a real dental office: an attacker who finds the public webhook URL can inject fake "calls" into the system, write false CommLogs into a patient's chart, and flood the callback queue. PHI is also at risk in the other direction since unauthenticated GET endpoints expose call history.
- **Severity / confidence:** 🔴 Critical / Confirmed.

### CF-02. Retell API key checked into the repo
- **File:** `setup.sh:39` (and worktrees)
- **Evidence:** `RETELL_API_KEY=key_5286e8b619b00ed6815991eba586` literal in setup.sh.
- **Why it matters:** Retell calls cost real money per minute. Anyone reading the repo can drain it. They can also use the key to read every Retell call associated with the account.
- **Severity / confidence:** 🔴 Critical / Confirmed.
- **Action:** Rotate the key immediately. Strip `setup.sh` of literal credentials. Audit all worktrees in `.claude/` and `new-dashboard/.claude/` for the same string.

### CF-03. Agent Builder "Save" only writes localStorage
- **File:** `new-dashboard/client/src/pages/AgentBuilder.tsx:295-298`
- **Evidence:**
  ```tsx
  const handleSave = () => {
    const toSave = { ...config, lastSaved: new Date().toISOString() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
    ...
  };
  ```
  No `fetch` / `axios` call to a backend route. No backend endpoint accepts a saved agent config (`backend/routes/agents.js` has CRUD but it returns mocks; see CF-05).
- **Why it matters:** The operator believes they're editing the AI prompt. The agent at Retell is unchanged. If the office's manager updates "office hours: now closed Wednesday" and clicks Save, patients still hear "Yes, we're open Wednesday." The "Copy Prompt" button is the actual workflow but it isn't documented or surfaced.
- **Severity / confidence:** 🔴 Critical / Confirmed.

### CF-04. Scheduling Rules "Save" is a toast and nothing else
- **File:** `new-dashboard/client/src/pages/Scheduling.tsx:279-281`
- **Evidence:**
  ```tsx
  <Button size="sm" className="gap-1.5"
          onClick={() => toast.success("Scheduling rules saved")}>
    Save Rules
  </Button>
  ```
- **Why it matters:** The rules visible to staff (new adult no-recall = doctor exam only, emergency = priority slot, etc.) are correct dental policies — but no system component honors them. The agent's behavior is whatever's in Retell's prompt. The scheduling-rule list is **decoration**.
- **Severity / confidence:** 🔴 Critical / Confirmed.

### CF-05. Agents API returns mocks, not real Retell agents
- **File:** `backend/routes/agents.js:6-22`
- **Evidence:** `generateMockAgents` returns four hardcoded agents named "Medical Receptionist", "Emergency Triage", "Billing Support", "Pharmacy Assistant" with mock IDs `'1'`–`'4'`.
- **Why it matters:** Anyone using the dashboard's agent listing has no relationship to the real production agent. Pharmacy Assistant is not a dental concept. This data is misleading at best.
- **Severity / confidence:** 🔴 Critical (correctness of the dashboard) / Confirmed.

### CF-06. Callbacks queue is in-memory, lost on restart, seeded with sample data
- **File:** `backend/routes/callbacks.js:11, 261-329`
- **Evidence:**
  ```js
  let callbacks = [];
  let callbackIdCounter = 1;
  ...
  function createSampleCallbacks() {
    callbacks = [{ id: 'cb_1', call_id: 'call_001', caller_name: 'John Smith', ... }, ...];
  }
  createSampleCallbacks();
  ```
- **Why it matters:** Real callbacks created during the day are erased on every server restart. Sample data ("John Smith", "Mary Johnson") blends with real entries — front desk cannot trust the queue, and may follow up on fake patients.
- **Severity / confidence:** 🔴 Critical / Confirmed.

### CF-07. PM2 launches the new dashboard with a Next.js binary that doesn't exist
- **File:** `ecosystem.config.js:24-26` and `new-dashboard/package.json` (no `next` dep)
- **Evidence:**
  ```js
  script: 'node_modules/.bin/next',
  args: 'start',
  ```
  And `new-dashboard/package.json` lists `"vite": "^7.1.7"`, `"start": "NODE_ENV=production node dist/index.js"`. There is no `next` package anywhere in `new-dashboard/dependencies`.
- **Why it matters:** The new dashboard does not start under PM2 as configured. If the office's deploy uses this manifest, only the legacy frontend is reachable.
- **Severity / confidence:** 🔴 Critical / Confirmed.
- **Fix:** Change to `script: 'node', args: 'dist/index.js'` or use the package's `start` script directly.

### CF-08. No authentication on backend or Socket.IO
- **File:** `backend/server.js:91-102`, `backend/socket/socketHandler.js`
- **Evidence:** No auth middleware mounted. `app.use('/api/...', router)` in every line. No auth check inside any router I read (`webhooks.js`, `callbacks.js`, `agents.js`, `admin.js`, `openDental.js`).
- **Why it matters:** Anyone with the API URL can read full call history (transcripts include PHI), trigger admin Puppeteer launches against Mango, change agent configurations (no-op today but consequential tomorrow), and watch live calls via Socket.IO.
- **Severity / confidence:** 🔴 Critical / Confirmed.

### CF-09. Unified call store is a single JSON file rewritten in full on every event
- **File:** `backend/services/unifiedCallStore.js:32, 472-490`; `backend/routes/webhooks.js:137-139, 168-172, 213-216, 317-319`
- **Evidence:**
  - `this.persistPath = path.join(__dirname, '../../data/unified_calls.json');`
  - `await fs.writeFile(this.persistPath, JSON.stringify(data, null, 2));` — no atomic write, no temp-file-and-rename.
  - Every webhook handler calls `unifiedCallStore.persist()` (call_started, call_ended, call_analyzed, transcript). Transcript events fire many times per call.
- **Why it matters:** A single 5-minute call with 50 transcript utterances rewrites the entire JSON file 50+ times. A crash mid-write leaves the file partially written and unparseable on next startup — no `try { JSON.parse } catch { recover }` path. Concurrent webhook events (which Retell sends) race with the auto-save (`startAutoSave` every 60 seconds). At ~5,000 calls the file is large enough that read+parse+stringify+write becomes noticeable. By 50,000 it's unworkable.
- **Why it matters in a real dental office:** The "database" of every patient call sits in one JSON file with no atomic write. A power blip during a write loses the day's calls.
- **Severity / confidence:** 🔴 Critical (durability) / Confirmed.

### CF-10. Webhook errors are swallowed with HTTP 200 + no DLQ
- **File:** `backend/routes/webhooks.js:103-113`
- **Evidence:**
  ```js
  } catch (error) {
    console.error('❌ Error processing Retell webhook:', error);
    res.status(200).json({ received: true, error: 'Processing error logged', ... });
  }
  ```
  No retry queue, no dead-letter path, no alerting wired up.
- **Why it matters:** When something inside the handler throws (OD down, OpenAI down, JSON file write fails), Retell is told everything is fine and never retries. The event is gone unless someone reads the logs.
- **Severity / confidence:** 🔴 Critical / Confirmed.

### CF-11. Open Dental CommLog write has no idempotency
- **File:** `backend/routes/webhooks.js:218-279`, `backend/services/openDentalSync.js` (insertCommLogToDatabase)
- **Evidence:** No check for an existing CommLog with the same call ID before insert. Retell can send `call_analyzed` twice (e.g., on retry); both inserts succeed.
- **Why it matters:** Patient charts get duplicate CommLog entries describing the same call. Front desk sees two summaries, can't tell which is right.
- **Severity / confidence:** 🟠 High / Likely (no observed retry, but Retell does retry on 5xx historically).

### CF-12. Open Dental DB query runs `SHOW COLUMNS` on every calendar request
- **File:** `backend/config/openDental.js:268-271`
- **Evidence:**
  ```js
  const [aptColumns] = await this.pool.execute("SHOW COLUMNS FROM appointment");
  const [patColumns] = await this.pool.execute("SHOW COLUMNS FROM patient");
  const [provColumns] = await this.pool.execute("SHOW COLUMNS FROM provider");
  const [opColumns] = await this.pool.execute("SHOW COLUMNS FROM operatory");
  ```
- **Why it matters:** Each calendar fetch does 4 metadata round-trips before the actual SELECT. Acceptable for the once-per-page-load pattern today, slow when the calendar is auto-refreshed every few seconds. Schema doesn't change at runtime — cache it on first call.
- **Severity / confidence:** 🟡 Medium / Confirmed.

### CF-13. Phone number normalization is one-sided
- **File:** `backend/config/openDental.js:918-962` (`searchPatientsFromDB`); `backend/services/openDentalSync.js:60-83` (`matchByPhoneExact` → calls `searchPatients`)
- **Evidence:** `searchPatientsFromDB` uses `LIKE %query%` against `HmPhone` and `WkPhone`. The query is the cleaned phone string from `cleanPhoneNumber`. If OD stores phones with formatting (`(555) 123-4567`) and the lookup string is digits-only (`5551234567`), the substring `LIKE` won't match. Conversely, two different patients with similar digits could collide.
- **Why it matters:** Patient match silently fails on phone formatting differences. Sub-threshold matches (`< 0.7`) are dropped to a `console.warn` (`backend/routes/webhooks.js:271-275`) with no UI surface — the front desk never sees them.
- **Severity / confidence:** 🟠 High / Likely (depends on OD data hygiene; very common to have mixed formatting).

### CF-14. Live call manager's emergency keyword list mixes medical with dental
- **File:** `backend/services/liveCallManager.js:262-269`
- **Evidence:**
  ```js
  const emergencyKeywords = [
    'emergency', 'urgent', 'severe pain', 'bleeding',
    'swelling', "can't breathe", 'chest pain', 'accident',
    'broken', 'knocked out', 'tooth fell out', 'abscess'
  ];
  ```
- **Why it matters:** "chest pain" and "can't breathe" are **medical** emergencies that require 911, not dental urgencies that the office can squeeze in. Flagging them as `is_emergency=true` for booking-priority logic is the wrong response. The agent's prompt does not currently contain a 911 escalation directive (callAnalyzer prompts in `backend/services/callAnalyzer.js` ask for `is_emergency` but never instruct the model to direct the patient to 911 for medical issues).
- **Severity / confidence:** 🔴 Critical (patient safety framing) / Confirmed for the keyword list. The 911-prompt-missing claim is **Likely** because I cannot read the live Retell agent's prompt — it lives in Retell, not in this repo.

### CF-15. CallAnalyzer truncates transcripts to 2000 chars
- **File:** `backend/services/callAnalyzer.js` (buildAnalysisPrompt: `${transcript.substring(0, 2000)}`)
- **Why it matters:** A 5-minute dental scheduling call easily exceeds 2000 chars (≈300 words). The end of the call — where appointments are booked, follow-up actions agreed — is exactly where the analyzer needs to look.
- **Severity / confidence:** 🟠 High / Confirmed.

### CF-16. CORS hardcodes a production domain
- **File:** `backend/server.js:37-43`
- **Evidence:** `'https://carein-do.flamingketchup.com'` and `'http://carein-do.flamingketchup.com'` in the source.
- **Why it matters:** Adding a second customer means a code change. Likely also exposes the operator's existing customer's domain to all readers of the repo.
- **Severity / confidence:** 🟠 High / Confirmed.

### CF-17. `morgan('combined')` logs full URLs (PHI risk via query strings)
- **File:** `backend/server.js:83`
- **Evidence:** `app.use(morgan('combined'));` — combined includes the URL.
- **Why it matters:** Any GET endpoint that takes `?phone=` / `?patient_id=` will log PHI to disk. Most endpoints today don't take such params, but the risk is structural.
- **Severity / confidence:** 🟡 Medium / Likely (depends on routes; mostly POST today).

### CF-18. Retell sync re-fetches the same `limit: 200` on every restart
- **File:** `backend/server.js:160-164`
- **Evidence:** `syncScheduler.runRetellSync({ limit: 200 })` on startup; `runRetellSync({ limit: 100 })` every 15 min.
- **Why it matters:** Restart-during-business-hours = full re-pull of the most recent 200 calls. Useful for crash recovery, but if the practice does > 200 calls between restarts, older calls are missed. Also wastes Retell API budget.
- **Severity / confidence:** 🟡 Medium / Confirmed.

### CF-19. `data/unified_calls.json` and `recordings/` are PHI on local disk
- **File:** `backend/services/unifiedCallStore.js:32`; `backend/services/mangoScraper.js:58-59` (`config.sync.recordingsPath`)
- **Why it matters:** PHI must be encrypted at rest under HIPAA Security Rule §164.312(a)(2)(iv). Local disk on a single droplet, no backups, no encryption-at-rest configured. (Note: I did not observe these files existing yet — `data/` is created on first run — but the code path is confirmed.)
- **Severity / confidence:** 🔴 Critical (HIPAA) / Confirmed for the code path; **Likely** for whether disk is encrypted (depends on droplet config I can't inspect).

### CF-20. Multiple Claude worktrees committed in-tree
- **File:** `.claude/worktrees/`, `new-dashboard/.claude/worktrees/`
- **Evidence:** ~7 worktrees observed (`flamboyant-dhawan`, `keen-golick`, `quizzical-ellis`, `charming-turing`, `competent-solomon`, `elegant-montalcini`, `blissful-feistel`). Each contains duplicate `backend/`, `new-dashboard/`, `frontend/` subtrees.
- **Why it matters:** Search results and refactors will hit stale copies. Backups, CI scope, repo size all bloated. The leaked Retell key from `setup.sh` is repeated across these copies — rotation has to scrub all of them.
- **Severity / confidence:** 🟠 High / Confirmed.

---

## Likely findings (well-grounded but not directly observed at runtime)

### LK-01. CommLog double-write under Retell webhook retries
- **Why I think so:** No idempotency check, Retell's documented behavior is at-least-once delivery for `call_analyzed`.
- **What would confirm:** Send a duplicate webhook in dev and observe two CommLog rows.
- **Severity:** 🟠 High.

### LK-02. Phone-formatted-mismatch causes wrong-or-missed patient match
- **Why I think so:** `LIKE %digits%` against possibly-formatted `HmPhone`. CF-13.
- **What would confirm:** Run `searchPatients` against an OD instance with formatted phone numbers using a digits-only query.
- **Severity:** 🟠 High.

### LK-03. JSON file race condition under concurrent webhooks + auto-save
- **Why I think so:** `fs.writeFile` is non-atomic. CF-09.
- **What would confirm:** Simulate two webhook handlers persisting at the same time as the 60-second auto-save tick.
- **Severity:** 🟠 High.

### LK-04. Retell agent prompt omits a 911 directive
- **Why I think so:** The codebase has no Retell-side prompt content; the AgentBuilder default in `new-dashboard/client/src/pages/AgentBuilder.tsx` (which is what an operator might paste into Retell) does not include 911 instructions for medical emergencies. The `liveCallManager` keyword list flags chest pain etc. as dental priority instead of medical escalation (CF-14).
- **What would confirm:** Retrieve the deployed agent's prompt via Retell API.
- **Severity:** 🔴 Critical.

### LK-05. Recording disclosure missing from agent's first turn
- **Why I think so:** Same — no disclosure visible in the codebase prompt; depends on Retell-side config.
- **What would confirm:** Listen to a real call's first turn or read the Retell agent prompt.
- **Severity:** 🔴 Critical (in two-party-consent states).

### LK-06. Open Dental connector's `acquireTimeout` / `timeout` are silently ignored
- **Why I think so:** `mysql2/promise` removed those option names some versions back; only `connectTimeout` is honored.
- **What would confirm:** Slow MySQL responses to see if timeout fires.
- **Severity:** 🟡 Medium.

### LK-07. The OpenAI BAA may or may not be in place
- **Why I think so:** The codebase doesn't tell me; this is an operations question. If a BAA isn't in place, every transcript is a HIPAA exposure.
- **What would confirm:** Check OpenAI organization billing portal for BAA status.
- **Severity:** 🔴 Critical if missing, 🟢 None if present.

### LK-08. Mango selectors will break when the portal changes
- **Why I think so:** This is the nature of UI scrapers. Specific behavior on break: Puppeteer waitForSelector throws, sync errors out, no alert is wired (CF-10 pattern applies).
- **Severity:** 🟠 High over a long enough timeline.

---

## Possible risks (real risk class, not directly observed)

### PR-01. Office data corruption from a power loss mid-write
- Plausible because of CF-09. Easy to mitigate (atomic write or DB).

### PR-02. AI hallucinates pricing, hours, or insurance acceptance
- Universal risk for prompt-based agents; can't quantify without listening to calls. Mitigate with KB-anchored prompts + post-call checks.

### PR-03. AI handles a hostile/abusive caller poorly
- Possible but unverified. Internal QA scenarios in `09-testing-plan.md` are the way to surface this.

### PR-04. The agent is deployed without recording disclosure in two-party-consent states
- See LK-05. Operations question.

### PR-05. Unencrypted droplet disk
- Depends on the droplet's setup; can't tell from the repo.

### PR-06. Mango credentials get the Mango account locked out from repeated failed logins
- Depends on Mango's lockout policy and how often the scraper retries; not directly observed.

---

## Things I previously asserted but am now downgrading or removing

| Earlier wording | Status |
|---|---|
| "OpenAI without a BAA" stated as fact | Downgraded to **Possible** (LK-07). |
| "Office uses two products forever" | Removed (opinion). |
| "First commercial customer breaks the first" | Replaced with the specific tenancy claim (CF-16, hardcoded production domain). |
| "OpenAI key leaked in `LIVE_PRODUCTION_TEST_RESULTS.md`" | Replaced with CF-02 (Retell key in `setup.sh:39`). |
| "MySQL: no pool, no timeouts" | Replaced with Correction C and LK-06. |
| "AI has no tools" | Replaced with Correction D (tools exist; agent integration missing). |
| "PHI in stdout logs" | Narrowed to phone numbers + patient names, not transcripts (Correction E). |
| "OpenAI 2000-char truncation drops the end of long calls" | Kept as CF-15 (Confirmed). |
| Claims about "top tier products do X" | Removed when not tied to a specific dental SaaS feature. |
| "Mango sync hangs Chrome / leaks memory" | Downgraded to **Possible** (PR-06 class); I have no evidence of leaks. |
| "Recordings on disk are not encrypted" | Downgraded to **Likely** (depends on droplet config). |

---

## How to use this file

If a finding from files 01–10 is restated here with the same number/severity, treat it as confirmed and prioritize accordingly. If a finding from 01–10 is **not** restated here, it's been downgraded or struck — read this file as the authoritative version.

The roadmap (file 08) and executive summary (file 01) have been edited to align with these classifications. The remaining files (02, 03, 04, 05, 06, 07, 09, 10) still carry some of the original wording; I've left them as-is rather than rewrite them in place because:
1. They're useful as exploratory analysis.
2. Where they contradict this file, this file wins.

If you want any of the other files re-tightened to this same standard, say which ones.

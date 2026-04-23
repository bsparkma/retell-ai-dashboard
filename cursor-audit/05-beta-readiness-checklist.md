# 05 — Beta Readiness Checklist

A line-item checklist for taking this product from "demo at HQ" to "live with one trusted dental office in shadow mode."

> **The authoritative version of "what blocks beta" is the P0 section of [`08-prioritized-fix-roadmap.md`](./08-prioritized-fix-roadmap.md).** That list is shorter, evidence-anchored to file:line, and intentionally scoped to a single pilot office — not generic SaaS readiness. Use the file 08 P0 list as the gate. Use this file as supplementary context.

The bar for beta is: **the office is safer with this product than without it, and we can recover from anything that goes wrong without losing data or trust.**

---

## Hard blockers — do NOT enroll a real office until these are done

These are the items where, if you launch without them, a real patient or office will be harmed (data loss, missed emergency, regulatory exposure, financial loss).

### Safety / clinical
- [ ] **911 instruction added to all agent prompts.** Tested with at least 5 simulated emergency phrases ("I'm having trouble breathing", "my face is swelling", "blood won't stop", "having chest pain", "feeling faint"). Verify the AI says "hang up and call 911."
- [ ] **No-diagnosis rule reinforced** in every prompt with examples ("if a caller asks about medication, say...", "if a caller describes symptoms, say...").
- [ ] **Cardiac-mimicking dental pain** explicitly addressed in the emergency triage prompt.
- [ ] **Recording disclosure** at call start in states that require two-party consent.

### Data integrity
- [ ] **Stop seeding sample callbacks on every restart.** [`backend/routes/callbacks.js:329`](../backend/routes/callbacks.js) — gated to dev only.
- [ ] **Move callbacks to durable storage** (SQLite, Postgres, or at minimum a JSON file with the same atomic-write fixes as the call store).
- [ ] **Make `unifiedCallStore` writes atomic** — write to `.tmp`, fsync, rename. Add a global mutex/queue around writes.
- [ ] **Daily backup of `data/unified_calls.json`** to S3, Backblaze, or even another disk. Verified restore at least once.
- [ ] **Migrate from JSON file to SQLite or Postgres** for the call store. JSON is fine for one office on day 1; not fine on day 30.

### Configuration truth
- [ ] **Agent Builder save actually pushes the prompt to Retell.** [`AgentBuilder.tsx:295`](../new-dashboard/client/src/pages/AgentBuilder.tsx) currently saves to localStorage only. This is the single biggest "the product is lying" gap.
- [ ] **Scheduling Rules save actually persists** and (longer term) actually drives AI behavior. Until then, hide the page or label it "Coming soon."
- [ ] **Knowledge Base saves to a per-office record** in the backend, not localStorage.
- [ ] **`{{office_name}}` and `{{knowledge_base}}` substitution happens server-side** before pushing to Retell. Refuse to push a config that still contains literal `{{office_name}}`.

### Security
- [ ] **Rotate the leaked Retell API key** committed in [`README.md:102`](../README.md) and [`setup.sh:39`](../setup.sh). Audit Retell for any unauthorized use during the leak window.
- [ ] **Remove all hardcoded keys** from any committed file. Verify git log for any other secrets.
- [ ] **Add authentication on all backend routes.** A single shared password or magic link is fine for beta; no auth is not.
- [ ] **HTTPS only.** Disable port 80 plain-HTTP on the droplet. Enforce HTTPS via Cloudflare tunnel or LE certs.
- [ ] **Lock down `POST /api/admin/*`** behind admin auth. The "Test Mango Connection" endpoint can spawn Puppeteer; the "Stop Sync" endpoint can disable sync globally. Both must be admin-only.
- [ ] **Webhook signature verification enabled in prod**, fixed (use raw body, not `JSON.stringify`).
- [ ] **PHI to OpenAI / Deepgram covered by a BAA.** Either sign one or stop sending raw transcripts. If signing isn't possible, redact PII before analyzer call.

### Deployment
- [ ] **Fix the `ecosystem.config.js` new-dashboard entry.** It currently runs `next start` on a Vite project. Change to `serve dist`, or build to static and serve via Nginx.
- [ ] **Verify both apps actually run** under PM2 after a clean reboot. `pm2 list` shows everything `online`.
- [ ] **Cloudflare tunnel credentials** path fixed (currently points to a Windows path on a Linux droplet — [`cloudflared-config.yml`](../cloudflared-config.yml)).
- [ ] **One-command rollback path documented and tested.** "Run `./rollback.sh` and the previous version is back online within 60 seconds." Don't ship without this.
- [ ] **Pre-flight checklist** documented for SSH-into-droplet deploys (currently the only deploy method).

### Testing
- [ ] **End-to-end smoke test passes** before each deploy: place a test call → it appears in live monitor → it persists in calls log → analysis runs → commlog written to OD test patient.
- [ ] **Webhook replay test** — fire a fixture webhook payload at the dev backend and verify the call appears.
- [ ] **Run a "broken Open Dental" test** — kill the OD bridge and verify the dashboard degrades gracefully with a clear error.

---

## Beta-blocker — should be done, can be worked around if not

### Office safety
- [ ] **Test mode / sandbox** that lets the office place a test call (or replay a fixture) without it touching real Open Dental records. Tag synthetic calls and exclude from analytics.
- [ ] **"Pause AI" master switch** — single button that routes all calls back to voicemail (or a safe fallback number) instantly. **The office must be able to disable this product in 5 seconds without an engineer.**
- [ ] **Per-feature kill switches**: disable AI booking, disable AI emergency triage, disable AI commlog write — independently.
- [ ] **Real-time staff alerting** for emergency callbacks (sound, visible badge, optional SMS).
- [ ] **Per-office configuration boundary.** Even if you only have one beta office, the data model should distinguish them. No more hardcoded "Valley Family Dental".

### Observability
- [ ] **Structured logging** with a log aggregator (Logflare, Better Stack, even self-hosted Loki). Tail-and-grep over SSH is not enough at beta scale.
- [ ] **Alerts** for: backend crash, Mango logged out, OD bridge down, webhook 5xx rate spike, OpenAI rate limit hit, transcription queue stuck, callback queue inactivity, sync hasn't run in N hours.
- [ ] **Per-call tracing** — when investigating "what happened on this call?", the engineer can pull every log line, webhook, transcript chunk, analyzer call, and OD write from one place.
- [ ] **Health check that actually checks** — currently `/health` returns 200 even if OD is down and OpenAI is failing. It should check downstream and return degraded with detail.

### QA
- [ ] **Internal QA checklist** documented and run before each release: place test calls of the 10 most common scenarios; verify each behaves as expected.
- [ ] **Golden transcript suite** — 20+ fixture transcripts that exercise: scheduling, emergency, after-hours, hostile caller, transfer request, insurance question, billing question, cancellation, reschedule, wrong number, robocall, kid caller, third-party caller, hangup, voicemail.
- [ ] **Manual test plan** for the dashboard: load each page, verify data, click each action.
- [ ] **Browser compatibility** — at minimum Chrome (the office's likely default), Safari (iPad), and Firefox.

### Pilot office tooling
- [ ] **Daily summary email** to the office: total calls, AI handled, callbacks pending, emergencies flagged, missed.
- [ ] **In-product feedback button** ("this call went wrong") that captures the call ID + a one-paragraph note for product review.
- [ ] **Office onboarding doc** — a written runbook for the first day, the first week, the first month.
- [ ] **Office training session plan** — what to demo, what to leave alone, what to escalate.
- [ ] **Office success metrics defined** — what does "this beta is working" mean numerically? E.g., AI completes >70% of inbound calls, <2% emergency miss rate, <1s after-hours fail rate, callback resolution <24h.

### Configuration
- [ ] **Office hours actually configured per office** (not in a free-text field where the AI guesses).
- [ ] **Provider list per office** with schedules.
- [ ] **Operatory list per office.**
- [ ] **Insurance accepted per office.**
- [ ] **Emergency overflow contact per office** (after-hours phone, on-call doctor SMS).
- [ ] **AI feature toggles per office** (let one office disable AI booking while another has it on).

### Documentation
- [ ] **Setup runbook** ("how to onboard an office") — step by step, with screenshots.
- [ ] **Operator runbook** ("how the office uses the dashboard daily").
- [ ] **Incident runbook** ("what to do if X breaks") — at minimum: backend crash, Mango logged out, OD bridge down, Retell webhook stops arriving, callbacks reset.
- [ ] **A "what to do if the AI says something wrong" runbook** — the office WILL ask this in the first week.
- [ ] **Privacy and HIPAA stance documented.** Even if not perfect, it should be honest about what data goes where.

---

## Strong nice-to-have — nudges beta from "okay" to "actually impressive"

### UX
- [ ] **Live call view on the new dashboard** (currently only on legacy frontend's `/live`).
- [ ] **Sound + browser notification** for emergency callbacks.
- [ ] **In-product help tooltips** on every important action ("?" icon).
- [ ] **A first-run tour** for new staff users.
- [ ] **Keyboard shortcuts** with `?` to discover them.
- [ ] **CSV export** for calls and callbacks.
- [ ] **Per-staff-member assignment of callbacks.**
- [ ] **Notes field on calls** that staff can use without leaving the dashboard.

### Operational
- [ ] **Per-office cost dashboard** (Deepgram + OpenAI minutes used / dollars spent this month).
- [ ] **Per-office volume dashboard** (calls per hour/day/week/month, AI vs human, sentiment breakdown).
- [ ] **Per-office satisfaction signal** (staff thumbs-up/down on calls; aggregate as "AI quality score").
- [ ] **A weekly "AI report card"** PDF emailed to the office.

### Voice quality
- [ ] **Per-office voice/persona selection** in the Agent Builder (not just one default).
- [ ] **Per-time-of-day prompt selection** (different prompt for after-hours).
- [ ] **A/B prompt testing** capability — half of calls get prompt A, half get B; compare booking rate.

### Reliability
- [ ] **Webhook deduplication** by Retell call ID.
- [ ] **Webhook retry queue** for downstream actions that fail (e.g., OD commlog write fails → retry).
- [ ] **Restart-safe live call manager** (persist active calls to disk).
- [ ] **Scheduled health-check cron** that posts to Slack on degradation.

### Trust building
- [ ] **"Last 100 calls" dashboard public to the office** (within their tenant) with full audit trail of what the AI did and what it didn't.
- [ ] **A "what would the AI have said?" replay** — given a transcript, run it through the analyzer again to show the office how the AI made decisions.
- [ ] **Versioning of the agent prompt** with timestamps and "who changed what".

---

## What "ready for beta" looks like, in plain English

The office can:
1. Place a test call to verify the AI is working.
2. See every real call in real time on the dashboard.
3. Configure their hours, providers, services, insurance, and policies in the UI, save them, and have those changes reflected in what the AI says.
4. See callbacks created from real calls (not sample data) and know they'll still be there tomorrow.
5. Pause the AI in 5 seconds if anything goes wrong.
6. Trust that when the AI hears "I'm bleeding heavily and I think I'm going to faint," it tells the caller to call 911.
7. Get a daily summary email so they don't have to log in to know if it worked.
8. Reach a human at your company within 1 hour during business hours if something is broken.
9. Recover their data if anything is lost.
10. Stop using the product cleanly if it doesn't work out.

The product is currently 3-out-of-10 on this list. The work to get to 10-out-of-10 is mostly the items in this checklist — none of it is research; it's all execution. The biggest single move is making Agent Builder real (item 1 in "configuration truth").

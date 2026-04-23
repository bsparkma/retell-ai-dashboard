# 06 — Production Readiness Audit

Whether the system is ready to be sold to multiple paying offices.

> **Read this with [`11-evidence-and-confidence.md`](./11-evidence-and-confidence.md) and the P1 section of [`08-prioritized-fix-roadmap.md`](./08-prioritized-fix-roadmap.md).** Specific corrections:
> - I previously wrote "OpenAI without a BAA" as fact. Downgraded to **Possible** — operations needs to confirm.
> - I previously wrote "MySQL: no pool, no timeouts." The pool exists (`backend/config/openDental.js:70-82`); only `acquireTimeout`/`timeout` are silently ignored — a smaller issue.
> - "Top tier products do X" framings have been replaced with concrete capability gaps in file 08.
> - The Red/Yellow/Green ratings in this file are conservative — most are right, but read them alongside the Confirmed/Likely/Possible tags in file 11 before quoting them.

---

## Production readiness scorecard

| Dimension | Rating | Honest line |
|---|---|---|
| Security | 🔴 Red | Hardcoded keys in repo, no auth, plain-HTTP fallback. |
| HIPAA / data handling | 🔴 Red | PHI to OpenAI/Deepgram with no documented BAA, no redaction layer, no encryption at rest, no access logs. |
| Tenancy / isolation | 🔴 Red | No tenant model. Hardcoded for one practice. |
| Auth / permissions | 🔴 Red | No auth on any backend route. No roles. |
| Deployment & rollback | 🔴 Red | SSH + `git pull` + `pm2 restart`. New-dashboard PM2 entry is fundamentally wrong. No rollback path. |
| Monitoring / observability | 🔴 Red | `console.log`. No log aggregation, no metrics, no alerts. |
| Reliability / data integrity | 🔴 Red | JSON file as source of truth, non-atomic writes, no backups, in-memory callback queue, no dedupe. |
| Scalability | 🟡 Yellow | Architecture is single-process, single-droplet, single-tenant. Will hit walls at modest scale (~10 offices). |
| Configuration management | 🔴 Red | All config in `.env` files on the droplet. No per-tenant config surface. No validation. |
| Billing / metering | 🔴 Red | None. |
| Support tooling | 🔴 Red | No admin impersonation, no per-office cost view, no ticket system, no support runbook. |
| Onboarding experience | 🔴 Red | No onboarding flow exists. Setup is a developer SSH job. |
| Documentation | 🟡 Yellow | Lots of docs exist (15+ root MDs, 19 docs/) but they're stale, contradict the code, and aren't customer-facing. |
| Churn risk | 🔴 Red | The product can lose data, has fake configuration UIs, has no notifications, and depends on opaque external configuration. Any of these could kill a beta. |

Overall production readiness: **🔴 Red.** The product is not ready to be sold. The architecture is single-tenant and several pieces are demonstrably broken.

---

## A. Security

### Findings

1. **Live Retell API key committed in `README.md:102`** and re-written by `setup.sh:39`. Treat as compromised.
2. **No authentication on any backend route.** ~60 endpoints, including writes to Open Dental and admin actions, are open to anyone who finds the URL.
3. **CORS is wide open in dev** and pointed at a single origin (`http://159.89.82.167`) in prod. No per-tenant origin allowlist.
4. **Webhook signature verification is bypassed in dev** and likely broken in prod (`JSON.stringify(req.body)` is non-canonical and probably won't match Retell's HMAC).
5. **Plain HTTP on port 80** is exposed alongside the Cloudflare tunnel. PHI flows in cleartext for anyone observing the network path.
6. **Helmet, CORS, rate-limit middleware present** but with default-permissive configurations. No CSP. No HSTS enforcement.
7. **Mango Voice scraping uses a single shared credential pair** stored in `.env`. If Mango ever sees the bot from multiple offices' IPs, lockout cascade.
8. **SQL injection risk in Open Dental DB mode** depends on whether all queries use parameterization. Spot-checked; mostly parameterized but worth a security audit pass.
9. **No CSRF protection** on POST/PATCH/DELETE routes (no auth, so moot — but a future auth layer must add this).
10. **No secrets rotation procedure documented.**
11. **No SSO**, no SAML, no OAuth. Even if auth is added, enterprise dental groups won't accept username/password.
12. **No rate limiting per-IP for write routes** (only the global rate limit on the API).
13. **Test endpoints are likely shipped to prod**. The `POST /api/agents/:id/test` route ([`backend/routes/agents.js:297`](../backend/routes/agents.js)) is a test stub.

### Required for production
- Auth on every route (recommend OIDC or magic link; Auth0/Clerk/Supabase Auth all viable).
- HTTPS only. Disable port 80.
- Per-tenant API keys for webhook verification.
- Secrets in a real secret manager (not `.env`).
- Quarterly key rotation procedure.
- A pen-test before broad release.
- A documented threat model.

---

## B. HIPAA / data handling

The product touches PHI (patient names, phone numbers, transcribed conversations about dental conditions). It is HIPAA-relevant.

### Findings

1. **PHI is sent to OpenAI by default** (`gpt-3.5-turbo`, the consumer endpoint, [`backend/services/callAnalyzer.js:67`](../backend/services/callAnalyzer.js)). OpenAI has a HIPAA-eligible offering through their Enterprise/API plans with a BAA, but the codebase doesn't show any indication that one is in place. The default API endpoint does **not** carry a BAA.
2. **PHI is sent to Deepgram for transcription.** Deepgram offers a BAA-eligible enterprise tier; same caveat — not documented as in place.
3. **Transcripts are stored in a flat JSON file on the droplet's disk.** No encryption at rest. Anyone with SSH or droplet access can read them.
4. **No access logging.** Who read which transcript? Unknown.
5. **No retention policy.** Transcripts persist forever.
6. **No data subject deletion path.** A patient saying "delete my records" cannot be honored.
7. **Recordings stored on disk** in a `recordings/` folder with no encryption.
8. **CommLog entries written to Open Dental** — these are part of the patient record under the practice's HIPAA umbrella, which is fine, but the bridge from this system to OD must be auditable.
9. **No PHI redaction layer** between transcript and analyzer. Full names, DOBs, insurance member IDs are sent to OpenAI verbatim.
10. **No "minimum necessary" enforcement** — the analyzer prompt sends 2000 chars of transcript even for simple lookups.
11. **PHI in logs.** Spot-checked: caller names and call reasons appear in `console.log` output ([`callAnalyzer.js:95`](../backend/services/callAnalyzer.js): `Call analyzed: ${analysis.caller_name || 'Unknown'}`). Logs may end up in PM2 log files, in Better Stack, in screenshots — wherever logs go.
12. **No documented Privacy Notice** to patients.
13. **No patient consent capture** for AI handling.

### Required for production
- BAAs in place with OpenAI, Deepgram, Retell (Retell does sign BAAs on their enterprise tier), Open Dental.
- Encrypted storage at rest (database with TDE, or app-level encryption).
- Access logging on every transcript/recording read.
- Retention policy + deletion API.
- PHI redaction in logs.
- A Privacy Officer designation.
- A documented Breach Response procedure.
- Annual HIPAA training for the team.
- Documented physical safeguards (DigitalOcean's certifications + your own).

This is the area where "I don't have time" can result in legal/regulatory action. **For real patient calls, this must be addressed before, not after, beta.**

---

## C. Tenancy and isolation

### Findings

1. **No tenant model in the data layer.** Calls, callbacks, analytics — all flat collections with no `office_id` field.
2. **Hardcoded office references** in code ([`AgentBuilder.tsx:51`](../new-dashboard/client/src/pages/AgentBuilder.tsx) — Valley Family Dental + Roland Family Dental as placeholders).
3. **One Retell API key, one OpenDental connection, one Mango account** per deployment. To onboard a second office, you'd duplicate the entire deployment.
4. **No row-level security.** Any authenticated user (when auth exists) would see all offices' data.
5. **Single instance of in-memory state** (`liveCallManager`, `callbacks`) — no per-tenant partitioning.
6. **No domain routing** for multi-tenant ("officeA.carein.com" vs "officeB.carein.com").
7. **Per-office config not implemented** — `data/unified_calls.json` is global.

### Required for production
- A `tenants` table with each office's config, credentials, integrations.
- Every existing table gets a `tenant_id` foreign key.
- API requests carry a tenant context (subdomain, header, or path prefix).
- Per-tenant Retell agent ID, OD connection, Mango credentials.
- Per-tenant rate limits and cost tracking.
- A backfill plan for the existing single-tenant data.

This is a multi-week refactor. It is also non-optional. Without it, the company can support exactly 1 customer.

---

## D. Auth / permissions

### Findings

1. **No auth.** No users table. No login page. No sessions. No tokens.
2. **No role model.** "Office owner" vs "office manager" vs "front desk" vs "doctor" — all undifferentiated.
3. **No permission checks** anywhere in the route handlers.
4. **No SSO.** Real dental groups (DSOs) require SSO.
5. **No 2FA.** Required for admin accounts.

### Required for production
- An auth provider (Clerk, Auth0, Supabase Auth, Stytch, NextAuth).
- A users table with `tenant_id`, role, status.
- A roles model — at minimum: super_admin (your team), office_admin, office_user, view_only.
- Auth middleware enforcing per-route access.
- SSO integration for enterprise customers.
- 2FA for admin accounts.
- Session management with revoke.
- Audit log of admin actions.

---

## E. Deployment and rollback

### Findings

1. **SSH-based deploy.** `git pull && pm2 restart all`. No CI/CD. ([`README.md` describes this.](../README.md))
2. **`ecosystem.config.js` for `new-dashboard` is wrong** — runs `next start` on a Vite project. New dashboard cannot deploy as configured.
3. **No staging environment.** All changes go to production directly.
4. **No rollback path.** "Roll back" means SSH in, `git checkout PREV_SHA`, `npm install`, `pm2 restart`. Slow, error-prone, no verification.
5. **No blue-green or canary deployment.** New version replaces old in-place.
6. **Cloudflare tunnel config has a Windows path on a Linux droplet** ([`cloudflared-config.yml`](../cloudflared-config.yml)).
7. **No deployment notifications.** Who deployed what when? Nowhere.
8. **No version visible in the product** ("you are running v1.4.2"). Helpful for support.
9. **No automated migrations** because there's no real database.
10. **Dockerfiles exist** but `docker-compose.yml` is dev-only and the droplet doesn't use containers in prod.

### Required for production
- CI/CD pipeline (GitHub Actions, GitLab CI, etc.).
- Staging environment with a copy of prod data structure.
- Build artifacts immutable; deploys are "promote artifact" not "git pull on server."
- One-command rollback (e.g., `flyctl releases rollback`, `vercel rollback`).
- Health-check gating on deploys (don't promote if health degrades).
- Deployment notifications to Slack.
- Version visible in the product (footer or admin page).
- Database migrations with up/down.
- Container-based deployment for reproducibility.

---

## F. Monitoring and observability

### Findings

1. **`console.log` is the only logging.** No structured logger, no log levels, no correlation IDs.
2. **PM2 captures logs to local files** (`logs/dashboard-error.log`). Disk fills eventually. No rotation enforced.
3. **No metrics.** Call rate, error rate, latency — none captured.
4. **No alerting.** Backend crash → nobody notified.
5. **No tracing.** Request → webhook → store → analyzer → OD write — cannot be traced through.
6. **No uptime monitor** documented.
7. **`/health` endpoint exists** but returns 200 even when downstream is degraded.
8. **No per-call audit trail.** When a customer asks "what did the AI do on call X?", reconstruction requires combining several log files.
9. **No real-time error tracking** (Sentry, Bugsnag, etc.).

### Required for production
- Structured JSON logging (winston, pino).
- Log aggregation (Better Stack, Loki, Datadog, etc.).
- Metrics (Prometheus, Datadog).
- APM/tracing (Datadog APM, Honeycomb).
- Error tracking (Sentry).
- Uptime monitoring (BetterUptime, Pingdom).
- Alerting routes (PagerDuty for critical, Slack for warning, email for FYI).
- A dashboard the team checks at standup.

---

## G. Reliability and data integrity

### Findings

1. **Single JSON file** is the source of truth for all calls. Non-atomic writes from 4+ concurrent producers. **One bad crash truncates the file; the parse fails silently; the store starts empty.**
2. **No backups.** None automated. None tested.
3. **Callbacks in-memory.** Restart = wipe.
4. **Live call manager in-memory.** Restart mid-call = data loss.
5. **No webhook deduplication.** Retell retries duplicate the call.
6. **No retry queue for downstream failures.** If OD commlog write fails because OD was rebooting, the data is lost.
7. **No transactional integrity** between the unified store, the analyzer output, and OD.
8. **Mango scraping is fragile** — Puppeteer breaks on portal redesigns; no graceful degradation.
9. **No quota / rate limit handling** for OpenAI or Deepgram. Hit quota → analysis silently fails.
10. **No backpressure.** A spike in calls during a busy morning can stack up unprocessed work without anyone noticing.

### Required for production
- Real database (Postgres or SQLite for small scale, Postgres for multi-tenant).
- Atomic writes with proper transactions.
- Hourly backups, retained 30+ days, restore tested monthly.
- Persistent queues (Redis, BullMQ, SQS) for downstream actions.
- Webhook dedupe by event ID.
- Idempotency keys on writes.
- Circuit breakers on OpenAI/Deepgram/OD calls.
- Backpressure/throttling on incoming webhooks if downstream is degraded.
- Disaster recovery runbook with RTO/RPO targets.

---

## H. Scalability

### Findings

1. **Single Node.js process per app.** No clustering.
2. **Single droplet.** No horizontal scaling.
3. **JSON file load times grow linearly** with call count. At ~50,000 calls, every read/write is slow.
4. **In-memory state** doesn't shard.
5. **Mango scraping is sequential.** One office at a time.
6. **OpenAI calls are not batched** ([`callAnalyzer.js:233`](../backend/services/callAnalyzer.js): 200ms delay between sequential analyses).
7. **No CDN** for static assets.
8. **No DB connection pooling** because no DB.
9. **Socket.IO single-node** — no redis adapter for multi-process.

### Required for production at scale
- Stateless backend, stateful in DB + Redis.
- Horizontal scaling behind a load balancer.
- Socket.IO Redis adapter.
- Worker processes for long-running analysis/scraping.
- Job queues (BullMQ).
- Database with read replicas if needed.
- CDN for assets.

The current architecture works fine for 1 office. It will get awkward at 5 offices and break at 50.

---

## I. Configuration management

### Findings

1. **All config in `.env` files on the droplet.** No per-tenant config in the data layer.
2. **No env validation at startup.** Missing keys silently disable features (e.g., no `OPENAI_API_KEY` → analyzer falls back to regex).
3. **`setup.sh`** writes a default `.env` with the leaked Retell key — meaning new installs default to the same compromised key.
4. **Configuration is not auditable** — no record of when keys were rotated.
5. **Hardcoded literals** in code (provider names, office name placeholders, default phone numbers in the agent mock).
6. **No feature flags.** Every change is on for everyone.
7. **No A/B testing infrastructure.**

### Required for production
- A schema-validated config layer (envalid, zod, pydantic-style).
- A real secrets manager.
- A feature flag service (LaunchDarkly, Flagsmith, simple Postgres table).
- Per-tenant config in the database (overlaid on global defaults).
- Audit log of config changes.

---

## J. Billing / metering

There is **no billing infrastructure**. No Stripe, no usage metering, no subscription model, no invoicing, no proration, no trial logic, no payment failure handling.

### Required for production
- Subscription billing (Stripe + a customer portal).
- Per-tenant usage metering (calls handled, transcription minutes, OpenAI tokens) for usage-based pricing or fair-use policies.
- Free trial logic.
- Plan tier enforcement (limits per plan).
- Dunning for failed payments.
- Cancellation flow with data export.

---

## K. Support tooling

### Findings

1. **No admin impersonation** — your team cannot log in "as" an office to debug.
2. **No support ticket system** referenced.
3. **No per-office cost view** for your finance team to track unit economics.
4. **No "what's wrong with this call" diagnostic tool.**
5. **No automated daily report** to flag offices having problems.

### Required for production
- Admin impersonation with audit logging.
- A support tool (Intercom, Zendesk, or simple email + Notion).
- A per-office cost dashboard internal to your team.
- A diagnostic CLI or web tool for engineers.
- Automated daily/weekly health reports per office.

---

## L. Onboarding experience

There is **no onboarding flow** for an office. The closest thing is `setup.sh` which provisions a developer environment.

### Required for production
- Self-serve signup (or sales-led with demo-to-trial path).
- A first-day setup wizard: practice info → integrations → agent config → test call → go live.
- Email drip during the first week.
- A "first call" celebration email.
- A first-week health check.
- Documented "Day 1, Day 7, Day 30" milestones.

This is the make-or-break for SaaS retention. Today it doesn't exist.

---

## M. Documentation

### Findings

1. **15+ root markdown docs** + 19 docs in `docs/` — many stale, many contradict each other.
2. **Lots of internal planning docs** (PRDs, architecture sketches, retro notes) — useful for the team, useless for the customer.
3. **No customer-facing documentation.** No knowledge base, no help center, no API docs (the audit doc-vs-reality finding from the previous audit confirms this).
4. **No "how to use the dashboard" doc.**
5. **No "how to configure your agent" doc.**

### Required for production
- A customer-facing help center (Notion, GitBook, Helpscout).
- Per-feature how-to guides with screenshots.
- A getting-started guide.
- Video walkthroughs for the first-day setup.
- An API doc (if you'll have one).
- A status page (status.carein.dental).

---

## N. Churn risk register

What will cause an office to cancel within their first 90 days?

| Risk | Cause | Severity |
|---|---|---|
| Lost data | JSON file corruption or restart wipe of callbacks | Critical |
| Bad emergency call | AI doesn't say "call 911" when warranted | Critical |
| AI says wrong thing | Knowledge base unfilled, AI hallucinates hours/insurance | Critical |
| Setup is too hard | No onboarding flow, requires SSH | High |
| Configuration doesn't stick | Agent Builder save is fake | High |
| Office can't trust the dashboard | Mock data fallbacks, stale data, no system status | High |
| Office can't pause the AI | No master kill switch | High |
| Patient complains, staff has no answer | No call quality scoring, no escalation path visible | High |
| OD writes wrong patient | Fuzzy match has no human-in-loop | High |
| Mango scraping breaks | Portal change → recordings stop → office notices a week later | Medium |
| AI mishandles after-hours | No defined after-hours behavior | Medium |
| Bill arrives unexpectedly | No usage transparency, no warnings | Medium |
| Data export request | No way to extract the office's data on cancel | Medium |
| Multi-location office can't be served | No per-location config | High (for multi-loc prospects) |

---

## Bottom line

The product is **not production-ready** in the conventional sense. The infrastructure is single-tenant and demo-grade, several critical features are theatrical, security and HIPAA stance are not in place, and the support/billing/onboarding scaffolding doesn't exist.

The good news: most of these are well-understood SaaS engineering problems, not novel research. The work is real but not exotic. A focused team could close 80% of these gaps in 6–10 weeks.

The bad news: until they're closed, every dollar of revenue is exposing the company to data loss, a HIPAA action, or a churned-out office story that becomes the first review on G2.

**Concrete recommendation for the company:** do not sign paid customers until at least the items in §A (Security), §B (HIPAA), §G (Reliability), §C (Tenancy), §D (Auth), and §E (Deployment) are addressed. Run the beta with 1–2 friendly offices on a documented "this is beta, here's what we know" agreement. Use the proceeds to fund the production-readiness work, not to rush the next sale.

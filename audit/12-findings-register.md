# 12 — Findings register

A consolidated, prioritized list of every finding raised in audit reports 01–11. Severities follow this rubric:

- **Critical (C)** — actively exploitable risk to PHI, money, regulatory standing, or data integrity. Fix in days.
- **High (H)** — likely to cause an incident, deploy failure, or significant regression. Fix in weeks.
- **Medium (M)** — meaningful technical debt that compounds. Fix in the next quarter.
- **Low (L)** — polish, hardening, or housekeeping. Fix opportunistically.

Each row links back to the audit report that explains it.

## Critical

| ID | Finding | Source |
|---|---|---|
| C-01 | Live-looking `RETELL_API_KEY` committed in plaintext in `README.md:102` and re-emitted by `setup.sh`. Treat as compromised. Rotate now. | [07-security §C-1](./07-security.md), [09-deploy-ops §6](./09-deploy-ops.md), [11-docs-vs-reality §6](./11-docs-vs-reality.md) |
| C-02 | **No authentication on any HTTP route.** ~60+ routes including PMS writes, agent prompt mutation, and full PHI reads are publicly accessible at `http://159.89.82.167` and via the Cloudflare tunnel. | [07-security §C-2](./07-security.md), [02-backend](./02-backend.md) |
| C-03 | Retell webhook signature verification is dev-bypassed and likely broken in prod (`JSON.stringify(req.body)` instead of raw body, uses API key instead of webhook secret). Combined with C-02, gives attackers a one-step path into `unifiedCallStore` and Open Dental commlog writes. | [07-security §C-3](./07-security.md), [05-integrations](./05-integrations.md), [06-data-flow §1](./06-data-flow.md) |
| C-04 | PHI (caller phone, name, transcript, medical/insurance discussion) shipped to OpenAI `gpt-3.5-turbo` and Deepgram with **no documented BAA** in this repo. Regulatory issue if HIPAA is in scope. | [07-security §C-4](./07-security.md), [05-integrations](./05-integrations.md) |
| C-05 | `data/unified_calls.json` is the single source of truth for all call history (PHI). It is written non-atomically by multiple concurrent writers with no mutex. A crash mid-write truncates the file; the next boot silently swallows the parse error and starts an empty store. **No backups exist.** | [06-data-flow §6](./06-data-flow.md), [02-backend](./02-backend.md), [08-production-readiness §3](./08-production-readiness.md), [09-deploy-ops §10](./09-deploy-ops.md) |
| C-06 | `ecosystem.config.js` `carein-dashboard` entry runs `node_modules/.bin/next start` on a Vite project. PM2 fail-loops the process. The only reason this hasn't been noticed is that nobody runs the new dashboard in production yet. | [09-deploy-ops §3](./09-deploy-ops.md), [04-frontend-new](./04-frontend-new.md), [11-docs-vs-reality §6](./11-docs-vs-reality.md) |

## High

| ID | Finding | Source |
|---|---|---|
| H-01 | No HTTPS — production droplet exposes `http://159.89.82.167:80` in cleartext alongside the TLS-terminated Cloudflare tunnel. | [07-security §H-5](./07-security.md), [09-deploy-ops §1, §11](./09-deploy-ops.md) |
| H-02 | PHI in PM2 log files on the droplet (patient names, caller phones, transcript snippets) with no rotation policy and no shipping. | [07-security §H-3](./07-security.md), [08-production-readiness §2](./08-production-readiness.md) |
| H-03 | No backups for `data/unified_calls.json` or `recordings/mango/*.mp3`. RTO multi-hour, RPO total. | [08-production-readiness §8](./08-production-readiness.md), [09-deploy-ops §10](./09-deploy-ops.md) |
| H-04 | Mango portal credentials (`MANGO_USERNAME`/`MANGO_PASSWORD`) stored as plain env vars; leak = full phone-system compromise. | [07-security §H-2](./07-security.md), [05-integrations](./05-integrations.md) |
| H-05 | Open Dental DB connection (`OPENDENTAL_DB_URL`) likely uses a non-least-privilege user; leak = full PMS write access. | [07-security §C-5](./07-security.md) |
| H-06 | Dev-only `POST /api/webhooks/test` endpoint accepts unauthenticated event injection when `NODE_ENV !== 'production'`. With C-03's bypass, becomes a way to drive `call_analyzed` and write Open Dental commlogs from anyone. | [07-security §H-6](./07-security.md) |
| H-07 | Two parallel React UIs (`frontend/` MUI + `new-dashboard/` shadcn). Neither is complete. Every change costs 2x. New dashboard is missing the live monitor entirely; legacy dashboard's analytics page is entirely mock data. | [10-ux-ui §1, §3, §6](./10-ux-ui.md), [03-frontend-legacy](./03-frontend-legacy.md), [04-frontend-new](./04-frontend-new.md) |
| H-08 | Legacy dashboard silently swaps to mock data on backend errors. Operators cannot see when the API is down. | [10-ux-ui §2, §5](./10-ux-ui.md), [03-frontend-legacy](./03-frontend-legacy.md) |
| H-09 | New dashboard's Agent Builder persists agents only to `localStorage`. Different browsers see different agents; no warning. | [10-ux-ui §3](./10-ux-ui.md), [04-frontend-new](./04-frontend-new.md) |
| H-10 | README PM2 process names (`retell-backend`, `retell-frontend`) do not exist anywhere in `ecosystem.config.js` or `package.json`. The runbook is wrong. | [09-deploy-ops §3](./09-deploy-ops.md), [11-docs-vs-reality §2](./11-docs-vs-reality.md) |
| H-11 | `cloudflared-config.yml` pinned to a Windows credentials path, but production runtime is Linux. Disaster recovery from this file impossible. | [09-deploy-ops §5](./09-deploy-ops.md) |
| H-12 | `setup.sh` writes the leaked `RETELL_API_KEY` from README into `backend/.env` if `.env.example` is missing. Re-leaks on every fresh setup. | [09-deploy-ops §6](./09-deploy-ops.md) |
| H-13 | Mango scraper depends on Puppeteer + portal HTML; any portal UI change silently breaks call ingestion. No CSS-selector change-detection. | [05-integrations](./05-integrations.md), [02-backend](./02-backend.md) |
| H-14 | `unifiedCallStore.persist()` is O(N) full-rewrite every mutation. Acceptable today; will block the event loop at low-thousands of calls. | [02-backend](./02-backend.md), [08-production-readiness §4, §5](./08-production-readiness.md) |
| H-15 | Concurrent writers to `unifiedCallStore.persist()` — Retell `setInterval`, Mango cron, webhook handlers, manual sync endpoints — with no mutex. Interleaved bytes possible. | [06-data-flow §6, §7](./06-data-flow.md) |
| H-16 | `extractCallerName` referenced but undefined in `backend/routes/calls.js` (ReferenceError on certain code paths). | [02-backend](./02-backend.md) |
| H-17 | Rules-of-Hooks violation in legacy calendar/booking dialog (`useState` inside conditional). Reorders state in some renders. | [03-frontend-legacy](./03-frontend-legacy.md), [10-ux-ui §7](./10-ux-ui.md) |
| H-18 | New dashboard has unrouted dead pages (`Home.tsx`, `Calendar.tsx`) and an unused `socket.io-client` dependency. | [04-frontend-new](./04-frontend-new.md), [10-ux-ui §3, §7](./10-ux-ui.md) |
| H-19 | `od-microservice/` is dead code with its own dependency graph; risk that someone redeploys "the secure one" thinking the main backend has its auth posture. | [05-integrations](./05-integrations.md), [01-architecture](./01-architecture.md), [07-security §H-8](./07-security.md) |
| H-20 | No CI. Deploys are `git pull && pm2 restart all` over SSH. Build-class bugs (e.g., C-06) only surface in production. | [09-deploy-ops §8](./09-deploy-ops.md), [08-production-readiness §6](./08-production-readiness.md) |
| H-21 | Zero automated tests across backend, both frontends, and `od-microservice/`. | [08-production-readiness §1](./08-production-readiness.md) |
| H-22 | New-dashboard, Mango integration, and the JSON-file persistence model are all undocumented in `README.md`. Operators don't know what to back up. | [11-docs-vs-reality §2, §6](./11-docs-vs-reality.md) |

## Medium

| ID | Finding | Source |
|---|---|---|
| M-01 | `app.set('trust proxy', 1)` — only one hop trusted, but Cloudflare→Nginx→Express is two; rate-limit keys and logged client IPs are wrong. | [07-security §M-1](./07-security.md) |
| M-02 | Helmet CSP defaults loosened (`crossOriginResourcePolicy: 'cross-origin'`, `crossOriginEmbedderPolicy: false`) to make new dashboard work cross-origin. Tighten once auth lands. | [07-security §M-2](./07-security.md) |
| M-03 | Recordings served via `express.static` at `/api/mango/recordings/` with no auth and predictable filenames. | [07-security §M-3](./07-security.md), [02-backend](./02-backend.md) |
| M-04 | Legacy frontend pulls Google Fonts via `<link>` with no SRI; no CSP on either frontend. | [07-security §M-4](./07-security.md) |
| M-05 | `express.json()` and `express.urlencoded()` use default 100KB limit silently — no explicit `limit` set. | [07-security §M-6](./07-security.md) |
| M-06 | `liveCallManager` and `unifiedCallStore` keep transcripts in memory unbounded; heap dump = full PHI. | [07-security §M-7](./07-security.md), [02-backend](./02-backend.md) |
| M-07 | `backend/config/openDental.js` starts a 3-minute `setInterval` as a require-time side effect. Any second `require` doubles the interval. | [02-backend](./02-backend.md), [06-data-flow §4](./06-data-flow.md), [08-production-readiness §4](./08-production-readiness.md) |
| M-08 | No `isRunning` guard on Retell sync; overlapping runs possible. | [02-backend](./02-backend.md), [06-data-flow §7](./06-data-flow.md) |
| M-09 | `mangoScraper` keeps a single shared Puppeteer browser instance; concurrent calls serialize. | [02-backend](./02-backend.md), [06-data-flow §3](./06-data-flow.md) |
| M-10 | `callbacks.js` route stores callbacks in an in-memory array, never persisted. Restart wipes the queue. | [02-backend](./02-backend.md), [06-data-flow §6](./06-data-flow.md) |
| M-11 | `backend/server.js:135-141` error handler leaks `err.message` only when `NODE_ENV === 'development'` — but the `NODE_ENV` toggle is the same trigger as C-03 dev bypass. One misconfig leaks both. | [07-security §M-5](./07-security.md) |
| M-12 | Two Nginx configs (`nginx.conf`, `frontend/nginx.conf`) that look similar; easy to copy the wrong one. | [09-deploy-ops §4](./09-deploy-ops.md) |
| M-13 | `proxy_read_timeout 60s` in production Nginx is too short for `POST /api/unified-calls/sync-retell` and `POST /api/mango/sync`. | [09-deploy-ops §4](./09-deploy-ops.md) |
| M-14 | Legacy `services/api.js` exposes a large dead surface of unused API methods, inflating bundle size and surface area. | [03-frontend-legacy](./03-frontend-legacy.md) |
| M-15 | DST/time-zone handling unverified in both calendars; ISO strings flow through `date-fns` and (transitively) `moment`. | [10-ux-ui §5](./10-ux-ui.md) |
| M-16 | Calendar grid in new dashboard not keyboard-accessible. | [10-ux-ui §5, §7](./10-ux-ui.md) |
| M-17 | No empty / loading / error states across most pages; users see blank screens or fake numbers. | [10-ux-ui §5](./10-ux-ui.md) |
| M-18 | Mock data scattered across legacy frontend and the entire Analytics page; no clear "TODO: replace" markers. | [03-frontend-legacy](./03-frontend-legacy.md), [10-ux-ui §2](./10-ux-ui.md) |
| M-19 | `IMPLEMENTATION_PLAN.md` and `BLUEPRINT_PHASE2_SPEC.md` describe a multi-tenant Postgres world that was never built; sets wrong expectations for new contributors. | [11-docs-vs-reality §4, §6](./11-docs-vs-reality.md) |
| M-20 | Open Dental backend spec (`docs/OPEN_DENTAL_CALENDAR_BACKEND_SPEC.md`) calls for ~10 endpoints; backend implements ~4. Frontend spec assumes the missing ones. | [05-integrations](./05-integrations.md), [11-docs-vs-reality §5](./11-docs-vs-reality.md) |
| M-21 | No documented runbook for the failure modes most likely to occur today (Mango Puppeteer hang, Open Dental DB connection timeout, JSON-store corruption). | [09-deploy-ops §11](./09-deploy-ops.md), [11-docs-vs-reality §3](./11-docs-vs-reality.md) |
| M-22 | No env var matrix documenting required/optional/secret status and what breaks if missing. | [11-docs-vs-reality §6, §8](./11-docs-vs-reality.md) |
| M-23 | Worktree directories (`.claude/worktrees/*/`) carry full duplicates of every doc, polluting search. | [11-docs-vs-reality §7](./11-docs-vs-reality.md) |
| M-24 | `mcp/retell_mcp.py` is standalone Python with no integration into the rest of the system, no Dockerfile, no service definition. | [05-integrations](./05-integrations.md), [01-architecture](./01-architecture.md) |
| M-25 | `pm2-logrotate` not configured in `ecosystem.config.js`; risk of disk-full on the 1GB droplet. | [08-production-readiness §2](./08-production-readiness.md) |
| M-26 | Single health endpoint conflates liveness and readiness. | [08-production-readiness §2](./08-production-readiness.md) |
| M-27 | `setup.sh` uses `npm install` (resolves anew) rather than `npm ci` (lockfile-strict). | [09-deploy-ops §6](./09-deploy-ops.md) |
| M-28 | `setup.sh` doesn't `chmod 600 backend/.env` after writing it. | [07-security §M-8](./07-security.md), [09-deploy-ops §6](./09-deploy-ops.md) |

## Low

| ID | Finding | Source |
|---|---|---|
| L-01 | Switch `morgan('combined')` to a JSON logger that masks PHI. | [07-security §L-1](./07-security.md) |
| L-02 | Add `Strict-Transport-Security` once HTTPS is the only ingress. | [07-security §L-2](./07-security.md) |
| L-03 | Add `helmet.referrerPolicy('no-referrer')`. | [07-security §L-3](./07-security.md) |
| L-04 | `backend/Dockerfile` runs as root — add `USER node`. | [07-security §L-4](./07-security.md) |
| L-05 | `frontend/Dockerfile` uses `nginx:alpine` (floating) — pin a digest. | [07-security §L-5](./07-security.md) |
| L-06 | No `engines` field in `backend/package.json` — Node version drift across boxes. | [07-security §L-6](./07-security.md) |
| L-07 | No `npm audit` / Dependabot / Renovate; CVEs accrue silently. | [07-security §L-7](./07-security.md), [08-production-readiness §9](./08-production-readiness.md) |
| L-08 | Legacy uses `@mui/icons-material`, new dashboard uses `lucide-react`; no shared icon system. | [10-ux-ui §6](./10-ux-ui.md) |
| L-09 | Multiple lockfiles, no monorepo tool (npm/yarn workspaces, pnpm, Turborepo). | [08-production-readiness §9](./08-production-readiness.md), [01-architecture](./01-architecture.md) |
| L-10 | React 18 in `frontend/`, React 19 in `new-dashboard/`. Two majors in one repo. | [08-production-readiness §9](./08-production-readiness.md) |
| L-11 | `frontend/` includes both `date-fns` and (transitively) `moment` via FullCalendar. | [03-frontend-legacy](./03-frontend-legacy.md), [08-production-readiness §9](./08-production-readiness.md) |
| L-12 | `od-microservice/` declares Vitest but ships no tests. Dead artifact. | [01-architecture](./01-architecture.md), [08-production-readiness §1](./08-production-readiness.md) |
| L-13 | No keyboard shortcuts in either UI. | [10-ux-ui §5](./10-ux-ui.md) |
| L-14 | No confirmation modals before destructive actions (e.g., `PATCH /api/agents/:id`). | [10-ux-ui §5, §8](./10-ux-ui.md) |
| L-15 | Settings page in legacy frontend is a stub. | [10-ux-ui §2](./10-ux-ui.md), [03-frontend-legacy](./03-frontend-legacy.md) |
| L-16 | Multiple per-feature note .md files in repo root, none linked from README. | [11-docs-vs-reality §4, §7](./11-docs-vs-reality.md) |
| L-17 | No `CHANGELOG.md`, no `ARCHITECTURE.md`, no semver tags. | [11-docs-vs-reality §7](./11-docs-vs-reality.md) |

## Severity rollup

| Severity | Count |
|---|---|
| Critical | 6 |
| High | 22 |
| Medium | 28 |
| Low | 17 |
| **Total** | **73** |

## Suggested first-30-days plan

If only ten things get done in the next month, do these (in this order):

1. **C-01** Rotate `RETELL_API_KEY`, scrub from `README.md` and `setup.sh`, rewrite git history.
2. **C-02** Put a shared bearer-token (or proper JWT) auth in front of every route. Block unauthenticated reads of PHI and writes to Open Dental.
3. **H-01 + C-02** Force HTTPS-only ingress (via Cloudflare tunnel); block `:80` on the droplet at the firewall.
4. **C-03** Fix Retell webhook verification properly: raw body capture + dedicated webhook secret + remove env-conditional bypass.
5. **C-05 + H-03** Add nightly snapshot of `data/` and `recordings/` to a remote bucket with 30-day retention. Add file-locking around `unifiedCallStore.persist()` (or move to SQLite).
6. **C-06** Delete or fix the `carein-dashboard` PM2 entry; align `ecosystem.config.js` with what the production droplet actually runs.
7. **H-08** Remove silent mock-data fallback in legacy dashboard; surface API errors honestly.
8. **H-21 + H-20** Add minimal CI: `npm ci && npm run build` on PR for backend, frontend, new-dashboard. Catches the next C-06.
9. **H-22 + M-22** Replace `README.md` with an accurate one; add an env var matrix.
10. **C-04** Decide HIPAA scope. If real PHI: sign BAAs with Deepgram/OpenAI or move to a HIPAA-eligible provider. If not: stop processing real patient calls until the legal posture is clarified.

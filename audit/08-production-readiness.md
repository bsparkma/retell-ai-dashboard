# 08 — Production readiness

This file scores the system across the operational dimensions that decide whether a service can be safely run in production. Each section ends with a one-line verdict.

## 1. Tests

There is no test suite of any kind in the entire repo:

- `backend/package.json` has no `test` script and no Jest/Mocha/Vitest dependency.
- `frontend/package.json` includes CRA's default `react-scripts test` but **no `*.test.*` files exist** under `frontend/src/`.
- `new-dashboard/package.json` has no test script.
- `od-microservice/package.json` declares Vitest but has no `*.test.*` files.
- No `__tests__/` folders, no `.spec.ts`/`.spec.js` files anywhere.
- No CI workflow files (`.github/workflows/`, `.gitlab-ci.yml`, etc.) — verified by directory listing.

**Verdict:** zero automated test coverage. Every change to the backend (which writes to a live PMS and triggers paid AI calls) is shipped untested.

## 2. Observability

| Capability | Status |
|---|---|
| Structured logs | No — `morgan('combined')` + ad-hoc `console.log` strings |
| Centralized log aggregation | No — PM2 writes to `./logs/*.log` on the droplet |
| Metrics (Prometheus, etc.) | No |
| Health endpoint | Yes — `/api/health` returns service status, active client count, active calls |
| Liveness/readiness split | No — single endpoint conflates both |
| Tracing | No |
| Error reporting (Sentry/Bugsnag) | No |
| Frontend error tracking | No (CRA build, no Sentry) |

PM2 logs rotate by size only with PM2 defaults; there is no `pm2-logrotate` config in `ecosystem.config.js`. The Mango sync writes large logs (Puppeteer is verbose). Disk-full risk on the 1GB droplet is real.

**Verdict:** debugging a production incident relies entirely on `ssh root@159.89.82.167 && pm2 logs`. No alerting; failures are noticed only when staff complain.

## 3. Reliability and crash recovery

- **Process supervision:** PM2 with `autorestart: true`. Good.
- **Memory bounds:** `max_memory_restart: '512M'` on backend, `'256M'` on the dashboard process. The droplet has 1GB total — Mango Puppeteer alone can spike past 256MB on its own.
- **Crash effects:**
  - A crash mid-`unifiedCallStore.persist()` truncates `data/unified_calls.json`. On next boot, `JSON.parse` fails, the catch starts an empty store ([`unifiedCallStore.js:56-76`](../backend/services/unifiedCallStore.js)). **Silent total loss of call history.** No backup script exists in the repo.
  - The in-memory callbacks queue ([`backend/routes/callbacks.js:10-12`](../backend/routes/callbacks.js)) is never persisted; every restart wipes it.
  - Live calls in `liveCallManager` are in-memory only; a crash mid-call drops the live transcript. The eventual `call_ended` webhook will recreate the call once Retell sends it.
- **Graceful shutdown:** `SIGTERM`/`SIGINT` handlers call `unifiedCallStore.shutdown()` which `persist()`s. Acceptable.

**Verdict:** single point of failure is `unifiedCallStore.persist()`. One ill-timed crash and one boot is total data loss with no recovery path.

## 4. Concurrency / data integrity

Documented in detail in `audit/06-data-flow.md` §6–7. Highlights:

- Multiple writers (`setInterval` Retell sync + Mango cron + webhook handlers + manual sync endpoints) all call `unifiedCallStore.persist()` with no mutex.
- The 3-minute Open Dental sync `setInterval` fires from inside `backend/config/openDental.js:141-152` as a side-effect of `require()`. If anything else `require()`s that file, you get duplicate intervals.
- No `isRunning` guard for Retell pulls — a slow run overlapping with the next interval double-pulls.
- `JSON.stringify` of the entire store + `fs.writeFile` is O(N) on every mutation. With ~100s of calls today this is fine; at low thousands the persist becomes a multi-second blocker on the event loop.

**Verdict:** the persistence model survives the current load by luck. It will not scale and it will not survive a power-loss style failure.

## 5. Performance & scalability

- **CPU:** the heavy work is Puppeteer (Mango scraping) and OpenAI/Deepgram round-trips. All in-process. A second concurrent staff user kicking off a manual Mango sync stalls the event loop while Puppeteer launches.
- **Memory:** `liveCallManager` keeps full transcript objects in RAM; `unifiedCallStore` keeps every call ever seen. Bounded only by JSON file size on boot. On a 1GB droplet, this is fine for now and unbounded long-term.
- **I/O:** every persist is a full file rewrite. Recordings live on the same disk; one Puppeteer run can pull MP3s into `recordings/mango/` faster than disk can absorb in a tight loop.
- **Frontend:** legacy bundle is large (CRA + MUI 5 + FullCalendar + moment via date-fns transitively). New-dashboard ships Vite + Radix UI + Tailwind 4 — much smaller, but PM2 can't even start it (see §6).

**Verdict:** Adequate for a single dental practice doing ~50 calls/day. Will not survive a second tenant.

## 6. Build & release

- **Backend:** no build step; PM2 runs `node server.js`. Acceptable for a Node service.
- **Legacy frontend:** CRA `npm run build` produces a static bundle copied to `frontend/build/` and served by PM2 `serve` (`ecosystem.config.js`) or Nginx. Acceptable.
- **New dashboard:** **broken.** `ecosystem.config.js` declares it runs `node_modules/.bin/next start` on port 3005. The project is **Vite**, not Next.js — there is no `next` binary, no `.next/` build output, no `next.config.*`. PM2 will fail-loop on this entry. This means either:
  - PM2 has been silently failing in production for as long as this entry has existed, and nobody noticed because nobody is using `new-dashboard/` in prod, **or**
  - A patched `ecosystem.config.js` exists on the server that doesn't match the repo.
  Either way, the repo's deploy plan is wrong. See `audit/09-deploy-ops.md`.
- **Versioning:** no semver, no changelog, no release tags. Deploys are `git pull && pm2 restart all` (README:127).
- **Reproducibility:** no lockfile audit (lockfiles exist but no `npm ci` in deploy scripts; `setup.sh` uses `npm install`).

**Verdict:** a deploy of `new-dashboard` would not start. Backend and legacy frontend deploys work but are not reproducible.

## 7. Configuration management

- All config via `process.env` read at module load time.
- No schema/validation (no `zod`, `envalid`, etc.). Missing env vars surface as runtime `undefined` errors deep inside services.
- `.env.example` files exist for backend and frontend (not exhaustively checked) but `new-dashboard/` lacks one.
- The Cloudflared tunnel ID and credentials live at `~/.cloudflared/<tunnel-id>.json` per `cloudflared-config.yml`; they're not in this repo (correct), but they're also not documented anywhere except inline comments.
- The legacy `frontend/.env` requires `REACT_APP_API_URL`. CRA bakes this into the bundle at build time — every backend URL change requires a rebuild.

**Verdict:** brittle. A typo in `OPENDENTAL_DB_URL` brings the whole sync down with a runtime error and no early signal.

## 8. Backups & disaster recovery

| Asset | Backup |
|---|---|
| `data/unified_calls.json` (PHI: every call transcript and analysis) | None |
| `recordings/mango/*.mp3` (PHI: actual call audio) | None |
| Open Dental DB (lives on a separate machine) | Out of scope for this repo, presumably the practice has its own |
| `.env` (secrets) | None — losing the droplet means re-entering every key |
| Code | GitHub |
| Cloudflared tunnel creds | Lives only on the droplet — losing the droplet drops the tunnel |

There is **no backup script, no snapshot config, no offsite copy** of `data/` or `recordings/` in this repo or in `setup.sh`. DigitalOcean droplets can be snapshotted, but no scheduled snapshot is configured here.

**Verdict:** a droplet failure is total data loss including PHI. This is a regulatory issue, not just an operational one.

## 9. Dependency hygiene

- Multiple lockfiles (`package-lock.json`) across 4 workspaces, no monorepo tool to coordinate.
- `frontend/` pins React 18; `new-dashboard/` pins React 19 — two versions in one repo.
- Legacy frontend pulls in `moment` transitively via FullCalendar; `date-fns` is also installed. Dual date library.
- No `npm audit` in CI; CVEs accrue silently. No Dependabot/Renovate config.
- `od-microservice/` is dead code with its own dependency graph still in the lockfile.

**Verdict:** maintenance debt is real but containable.

## 10. Documentation accuracy

Covered in detail in `audit/11-docs-vs-reality.md`. Short version: the README documents the system as it existed two product iterations ago. It does not mention Mango, Open Dental, the new dashboard, or the cloudflared tunnel.

## 11. Production-readiness scorecard

| Dimension | Score (0–5) | Notes |
|---|---|---|
| Tests | **0** | None |
| Observability | **1** | Health endpoint only |
| Reliability | **2** | PM2 restart, but persistence is fragile |
| Concurrency safety | **1** | No mutexes around the JSON store |
| Performance/scalability | **2** | Single-tenant only |
| Build & release | **1** | New-dashboard PM2 entry is broken |
| Configuration | **2** | No validation |
| Backups / DR | **0** | None for PHI |
| Dependency hygiene | **2** | No CVE scanning, dead code in lockfile |
| Documentation | **1** | Stale and contradictory |
| **Overall** | **~1.2/5** | Demo-grade, not production-grade |

## 12. Five must-fix items before this should be considered production

1. **Stop trusting `data/unified_calls.json` as the source of truth.** Move call records to a real database (Postgres, SQLite with `better-sqlite3` if you really want a single file) and add scheduled backups.
2. **Add auth + HTTPS-only access.** (See `audit/07-security.md` C-2 and H-5.)
3. **Fix the new-dashboard PM2 entry** so deploy/restart cycles don't have a permanent fail-looping process consuming a slot. Either correct the script to `npm run preview` (Vite) or delete the entry.
4. **Add backups for PHI** (`data/`, `recordings/`) — daily snapshot to S3/B2 with at least 30 days retention.
5. **Add a `/healthz` (liveness) and `/readyz` (readiness) split** plus an external uptime check. Today, "is it up?" requires a human SSH'ing.

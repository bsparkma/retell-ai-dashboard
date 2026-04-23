# 00 — Audit summary

A read-only, end-to-end audit of the CareIN/Retell AI dashboard monorepo across architecture, backend, both frontends, integrations, data flow, security, production-readiness, deploy/ops, UX, and docs-vs-reality.

- **Repo:** `carein cursor dashboard` (monorepo: `backend/`, `frontend/`, `new-dashboard/`, `od-microservice/`, `mcp/`)
- **Live system:** `http://159.89.82.167` and `https://carein-do.flamingketchup.com` (Cloudflare tunnel)
- **Audit method:** read-only static analysis. No code was changed, no deployment was touched. All facts cite the file and line where they were verified. The complete plan is in `repo_audit_plan_fac9cf01.plan.md`.

The audit produced 12 reports (this file + 11 numbered chapters) and a consolidated findings register with 73 individually tracked items.

## TL;DR

The product works for one dental practice doing a manageable call volume. It is **demo-grade, not production-grade** for software that handles PHI and writes to a live PMS:

- The backend has **no authentication**.
- The Retell webhook signature verifier is **dev-disabled and probably broken in prod**.
- The single source of truth for all call data is a **JSON file written non-atomically by multiple concurrent writers, with no backups**.
- A **live-looking Retell API key is committed in `README.md`** and re-emitted by `setup.sh`.
- The new dashboard's PM2 entry is **misconfigured** (runs `next start` on a Vite project) and would fail to deploy.
- PHI flows to **Deepgram and OpenAI** with no documented BAA in this repo.
- **Two parallel React UIs** exist; neither is whole.
- **Zero automated tests, no CI.**

Every one of these is fixable. Several are quick wins. The first ten weeks of work are obvious; the audit ends with a sequenced action list.

## System diagram (as deployed today)

```mermaid
flowchart LR
  subgraph "External"
    RetellAPI["Retell AI"]
    Mango["Mango Voice (web portal)"]
    DG["Deepgram"]
    OAI["OpenAI"]
    Cloudflare["Cloudflare DNS / Tunnel"]
  end

  subgraph "DigitalOcean droplet 159.89.82.167 — Ubuntu 20.04, 1 GB RAM"
    direction TB
    Nginx["Nginx :80<br/>(serves legacy build,<br/>proxies /api → :5000)"]
    Tunnel["cloudflared tunnel 'carein'"]
    Backend["PM2 'carein-backend'<br/>backend/server.js (Express + Socket.IO)<br/>port 5000"]
    JSON[("data/unified_calls.json<br/>(single source of truth)")]
    Recordings[("recordings/mango/*.mp3")]
    Logs[("PM2 logs<br/>./logs/*.log")]
    NewPM2["PM2 'carein-dashboard' :3005<br/>(BROKEN — runs next start on Vite project)"]
  end

  subgraph "Open Dental"
    ODdb[("Open Dental MySQL")]
    ODrest["Open Dental REST"]
  end

  subgraph "Browsers"
    LegacyFE["frontend/ (React 18 + MUI 5)<br/>served from /var/www/html"]
    NewFE["new-dashboard/ (React 19 + Vite + shadcn)<br/>NOT in production"]
  end

  Cloudflare -->|TLS| Tunnel --> Backend
  Internet[Internet] -->|cleartext :80| Nginx --> Backend
  Nginx -->|/| LegacyFE

  Backend <-->|REST + webhooks| RetellAPI
  Backend -->|Puppeteer scraping<br/>(MANGO_USERNAME/PASSWORD)| Mango
  Backend -->|HTTPS| DG
  Backend -->|HTTPS| OAI
  Backend <-->|mysql2 / REST| ODdb
  Backend <-->|REST fallback| ODrest

  Backend --> JSON
  Backend --> Recordings
  Backend --> Logs

  LegacyFE -->|REST + Socket.IO| Backend
  NewFE -. only the calendar route uses real backend .-> Backend
```

## Repo at a glance

| Area | What's there | Verdict |
|---|---|---|
| `backend/` | Express + Socket.IO, 11 routers, file-based persistence, sync schedulers | Functional, fragile under concurrency, no auth (see `02-backend.md`) |
| `frontend/` | React 18 + MUI, currently deployed | Aging, mock-data fallbacks, Rules-of-Hooks bug (see `03-frontend-legacy.md`) |
| `new-dashboard/` | React 19 + Vite + shadcn, intended successor | Calendar feature solid; rest mostly mock; **not deployable as configured** (see `04-frontend-new.md`) |
| `od-microservice/` | Standalone TS Express service | **Dead code** — nothing else in the system calls it (see `05-integrations.md`, `01-architecture.md`) |
| `mcp/retell_mcp.py` | Standalone Python MCP server | **Standalone** — no integration with the rest of the system (see `05-integrations.md`) |
| `docs/` | Open Dental API specs + calendar rewrite specs | Mostly accurate for the calendar; backend spec ahead of implementation (see `11-docs-vs-reality.md`) |
| Root `.md` planning docs | 19 files, mostly stale | README is wrong about almost everything; quarantine the rest (see `11-docs-vs-reality.md`) |
| Tests | None | Zero coverage anywhere (see `08-production-readiness.md`) |
| CI | None | No automation gates (see `09-deploy-ops.md`) |

## What works

- **Inbound Retell webhook → live monitor** path is end-to-end real and works.
- **Open Dental calendar read** works (both DB and REST modes).
- **PM2 restart** keeps the backend up.
- **Cloudflare tunnel** provides a TLS path to the backend.
- **Mango sync → transcribe → analyze** pipeline works when the Mango portal HTML doesn't change.
- **The new dashboard's calendar** is well-built; it's the strongest piece of frontend code in the repo.

## What's broken or about to break

- The new dashboard cannot be deployed as configured (`ecosystem.config.js` runs `next start` on a Vite project).
- The README documents a system that doesn't exist anymore (different process names, different routes, no mention of half the integrations).
- The single JSON file holding all call history is written non-atomically by ≥4 concurrent writers and has no backups.
- A live-looking API key is committed in `README.md` and `setup.sh`.
- Webhook signature verification almost certainly does not validate real Retell signatures even when `NODE_ENV=production` is set.
- HTTP port 80 on the droplet exposes the backend in cleartext.
- Two React UIs exist and diverge; neither is complete.

## Top 10 findings (cross-cutting)

1. **C-01** — Live `RETELL_API_KEY` committed in README and `setup.sh`. Rotate now.
2. **C-02** — No authentication on any backend route (≥60 unauth'd endpoints, including PMS writes).
3. **C-03** — Retell webhook signature verification dev-bypassed and likely broken in prod.
4. **C-04** — PHI shipped to Deepgram and OpenAI with no documented BAA.
5. **C-05** — `data/unified_calls.json` is non-atomic, multi-writer, and not backed up. One bad crash = total PHI loss.
6. **C-06** — `ecosystem.config.js` runs `next start` on a Vite project (`new-dashboard/`). Fail-loop on deploy.
7. **H-01** — No HTTPS on the droplet's public IP; Cloudflare tunnel coexists with cleartext `:80`.
8. **H-07** — Two parallel React UIs, neither complete; every change costs 2x. Pick one.
9. **H-21 + H-20** — Zero automated tests, no CI.
10. **H-22** — README and ops docs describe a previous version of the system. New contributors are flying blind.

(Full list of 73 findings in `12-findings-register.md`.)

## The next 5 actions (week 1)

If only five things happen this week, do these:

1. **Rotate `RETELL_API_KEY`.** Scrub it from `README.md`, `setup.sh`, and (ideally) git history. Re-issue a new key from Retell. (C-01)
2. **Add a backup cron** for `data/unified_calls.json` and `recordings/mango/` to S3/B2. Even a daily `tar | aws s3 cp` is enough for week 1. Today there is nothing. (C-05, H-03)
3. **Put auth in front of `/api/*`.** Even a single shared bearer token via Nginx + a tiny Express middleware is a 10x security improvement and unblocks H-01 by letting you safely close port 80. (C-02)
4. **Fix or delete the `carein-dashboard` PM2 entry.** Either point it at `npm run preview` (Vite static serve) or remove it so PM2 stops fail-looping. (C-06)
5. **Replace `README.md`** with one accurate page describing the actual system and pointing at this audit. (H-22)

Then continue with `12-findings-register.md` §"Suggested first-30-days plan."

## Where to read next

| If you want to understand… | Read |
|---|---|
| The big picture | `01-architecture.md` |
| What every backend route does and where the bugs are | `02-backend.md` |
| The currently deployed UI | `03-frontend-legacy.md` |
| The intended future UI | `04-frontend-new.md` |
| How Retell, Mango, Open Dental, Deepgram, and OpenAI hang together | `05-integrations.md` |
| What actually happens when a call comes in | `06-data-flow.md` |
| Why the system isn't safe to handle PHI today | `07-security.md` |
| Whether this is really "in production" | `08-production-readiness.md` |
| How it gets deployed and what would break under DR | `09-deploy-ops.md` |
| What a user actually sees, and where it's misleading | `10-ux-ui.md` |
| Which docs are wrong and what to throw away | `11-docs-vs-reality.md` |
| Everything, ranked | `12-findings-register.md` |

---

*Audit conducted Apr 2026. All citations refer to the repository as it stood at the time of reading. Read-only — no files outside `audit/` were modified.*

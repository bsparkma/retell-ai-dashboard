# 11 — Docs vs reality

This file checks the 19 root-level `.md` planning docs and the 19 files under `docs/` against what the code actually does. Across the board, the docs describe the system at three different points in time and rarely the present.

## 1. Inventory of documentation

### Root-level docs (19 files)
- `README.md` — claims this is the "Retell AI Dashboard," lists production at `159.89.82.167`, MUI frontend, two-route API.
- `DEPLOYMENT.md`, `PRODUCTION_SETUP.md`, `OFFICE_DEPLOYMENT_GUIDE.md`, `WORKFLOW.md`, `QUICK_REFERENCE.md`, `TROUBLESHOOTING.md` — operations docs.
- `IMPLEMENTATION_PLAN.md` (37 KB), `BLUEPRINT_PHASE2_SPEC.md` (27 KB), `FEATURES.md`, `PROGRESS.md` — planning/roadmap docs.
- `CALLER_NAME_IMPROVEMENTS.md`, `DASHBOARD_LAYOUT_REFINEMENTS.md`, `CURSOR_AVAILABILITY_MANAGER.md`, `CURSOR_PRODUCTION_FIXES.md`, `TRANSFER_TRACKING_DEPLOYMENT.md`, `README_AGENT_FILTERING.md` — feature notes.
- `DEVELOPER_GUIDE.md`, `OPENDENTAL_DATABASE_SETUP.md` — references.

### `docs/` (19 files)
- 13 `api-*.md` files — Open Dental API field references.
- `open-dental-calendar-source-of-truth.md` — short description.
- `OPEN_DENTAL_CALENDAR_ARCHITECTURE.md`, `OPEN_DENTAL_CALENDAR_BACKEND_SPEC.md`, `OPEN_DENTAL_CALENDAR_CURSOR_BRIEF.md`, `PHASE1_SPEC.md`, `README.md` — calendar-rewrite specs.

There is also `frontend/new-dashboard/` local documentation (a few README/progress files inside `new-dashboard/`).

Plus a substantial number of duplicate docs inside `.claude/worktrees/*/` — these are git-worktree copies of historical states and should be excluded from this audit.

## 2. README.md vs reality

| Claim in README | Reality |
|---|---|
| "Retell AI Dashboard" — the product name | Branding has moved to "CareIN" everywhere in code (`carein-backend`, `carein-dashboard`, `carein-do.flamingketchup.com`). |
| Two API endpoints: `/api/calls`, `/api/agents`, `/api/health` ([README.md:135-141](../README.md)) | Backend mounts **11 routers**: `calls`, `agents`, `opendental`, `opendental-sync`, `webhooks`, `live-calls`, `admin`, `mango`, `callbacks`, `unified-calls`, `analytics`. |
| Tech stack: "React 18.2.0 + Material UI" | Two frontends. The currently deployed one is React 18 + MUI; the rewrite is React 19 + Vite + shadcn/ui. README does not mention `new-dashboard/` at all. |
| "Real-time integration with Retell AI API" | True, plus undocumented Mango Voice scraping, Open Dental DB writes, Deepgram transcription, OpenAI analysis. |
| "Real Retell AI API (no mock data)" | Legacy dashboard silently falls back to mock data on errors; analytics page is entirely mock. |
| Production URL `http://159.89.82.167` | Still live, but a Cloudflare tunnel at `carein-do.flamingketchup.com` is the actual primary path (per `cloudflared-config.yml` and CORS allow-list in `server.js`). README never mentions it. |
| PM2 process names: `retell-backend`, `retell-frontend` ([README.md:124](../README.md)) | `ecosystem.config.js` declares `carein-backend` and `carein-dashboard`. The README's names appear nowhere in this repo. |
| "RETELL_API_KEY=key_5286e8b619b00ed6815991eba586" ([README.md:102](../README.md)) | A live-looking key, in plaintext. See `audit/07-security.md` C-1. |
| "Open to all team members (no authentication required)" | Accurately documented as a security choice. (See `audit/07-security.md` C-2.) |

**Verdict:** the README is a snapshot from an earlier product (the "Retell AI Dashboard") and has not been updated since the product became CareIN with Open Dental + Mango integration. A new contributor reading the README will not understand most of the system.

## 3. Operations docs

### `DEPLOYMENT.md`, `PRODUCTION_SETUP.md`, `OFFICE_DEPLOYMENT_GUIDE.md`
- Cover the original DigitalOcean + PM2 + Nginx setup. Accurate as far as they go.
- Do **not** mention `cloudflared-config.yml`, the Cloudflare tunnel, the new dashboard, or the Mango/Open Dental integrations.
- Do not document the actual PM2 process names that match `ecosystem.config.js`.

### `WORKFLOW.md`, `QUICK_REFERENCE.md`
- Document the SSH-based "git pull && pm2 restart" workflow. Accurate.
- Reference the broken PM2 process names (`retell-frontend`).

### `TROUBLESHOOTING.md`
- Useful for the legacy stack. Doesn't cover the failure modes most likely to occur today (Mango Puppeteer hang, Open Dental DB connection timeout, `unified_calls.json` corruption on crash).

### `OPENDENTAL_DATABASE_SETUP.md`
- Describes adding `OPENDENTAL_DB_URL` to `.env`. Matches `backend/config/openDental.js`.
- Does not mention the REST fallback (`OD_API_URL`, `OD_DEV_KEY`, `OD_CUST_KEY`) which is also implemented.

## 4. Feature/spec docs vs reality

### `IMPLEMENTATION_PLAN.md` (37 KB)
- A detailed roadmap with multiple phases. Most of it predates current code.
- Some sections describe things that were built (e.g., live monitor, Mango integration). Others describe things that were never built (e.g., a multi-tenant architecture, a Postgres database, a proper auth system).
- No way to tell which sections are current intent vs. abandoned.

### `BLUEPRINT_PHASE2_SPEC.md` (27 KB)
- A detailed Phase 2 plan. Almost none of it is implemented in the current code (no Phase 2 endpoints, no Phase 2 UI). Aspirational.

### `FEATURES.md`, `PROGRESS.md`
- `FEATURES.md` lists features as of mid-2025. Some still exist; some have been replaced. No date-aware status column.
- `PROGRESS.md` last updated 1/12/2026; tracks a few items, mostly stale.

### `CURSOR_AVAILABILITY_MANAGER.md`, `CURSOR_PRODUCTION_FIXES.md`, `TRANSFER_TRACKING_DEPLOYMENT.md`, `README_AGENT_FILTERING.md`, `CALLER_NAME_IMPROVEMENTS.md`, `DASHBOARD_LAYOUT_REFINEMENTS.md`
- Single-feature notes from various points. Useful as commit-history substitute, not as living docs.
- None linked from the README.

## 5. `docs/` calendar specs vs reality

### `docs/OPEN_DENTAL_CALENDAR_ARCHITECTURE.md`, `OPEN_DENTAL_CALENDAR_BACKEND_SPEC.md`, `OPEN_DENTAL_CALENDAR_CURSOR_BRIEF.md`, `PHASE1_SPEC.md`
- These describe the new dashboard's calendar rewrite.
- The backend spec calls for a much fuller endpoint set (`/api/opendental/clinics`, `/schedules`, `/scheduleops`, `/asap`, `/slots`, `/appt-fields`, etc.).
- **What's actually implemented:** `/api/opendental/calendar`, `/appointments/range`, `/sync/status`, `/sync/trigger`, plus the legacy `/appointments` and `/appointments/check-conflicts` for booking. The 8+ additional endpoints in the spec are not built.
- The frontend spec (`PHASE1_SPEC.md`) calls for a read-only Phase 1 calendar, which **is** what the new dashboard ships. So at least the Phase 1 frontend matches the spec.

### `docs/api-*.md` (13 files)
- Reference docs for Open Dental REST endpoints. Useful as a cheat sheet.
- Whether the field lists match Open Dental's current REST API was not verified — but they look reasonable and were written 3/7/2026.

### `docs/README.md`
- Brief index. Accurate.

## 6. Code-vs-docs contradictions worth flagging

| # | Contradiction | Severity |
|---|---|---|
| 1 | README says auth is intentionally absent ("open to all team members") | Documents the security gap honestly, but the gap itself is critical (audit/07 C-2). |
| 2 | README lists 3 endpoints; code has 11 router groups with ~60+ routes | High — new contributors mis-estimate scope by 20x. |
| 3 | README PM2 process names don't match `ecosystem.config.js` | High — runbook commands fail. |
| 4 | `ecosystem.config.js` runs `next start` on a Vite project | High — deploy blocker, undocumented. |
| 5 | `cloudflared-config.yml` uses a Windows path on a Linux droplet | High — DR blocker. |
| 6 | `setup.sh` writes the leaked README API key into `.env` | High — silent re-leak on every fresh setup. |
| 7 | Backend spec for Open Dental calendar lists ~10 endpoints; backend implements 4 | Medium — frontend spec assumes endpoints that don't exist. |
| 8 | `IMPLEMENTATION_PLAN.md` describes a multi-tenant Postgres architecture; reality is single-tenant JSON file | Medium — sets wrong expectations. |
| 9 | `BLUEPRINT_PHASE2_SPEC.md` is mostly unbuilt | Low — clearly aspirational. |
| 10 | Mango integration not mentioned in README, DEPLOYMENT.md, or anywhere except code | Medium — operators don't know it exists until they see Puppeteer in `pm2 logs`. |
| 11 | `od-microservice/` and `mcp/` not mentioned in any docs | Medium — undocumented dead code with its own dependencies. |
| 12 | `new-dashboard/` not mentioned in README | High — the product's future UI is invisible to new readers. |
| 13 | `data/unified_calls.json` (the source of truth) is undocumented | High — operators don't know what to back up. |
| 14 | No doc of which env vars are required, optional, or dangerous to leak | High — only way to learn is to grep. |

## 7. Doc churn / duplication

- 19 root .md files; many overlap. `DEPLOYMENT.md`, `PRODUCTION_SETUP.md`, and `OFFICE_DEPLOYMENT_GUIDE.md` describe overlapping deployment paths with subtle differences.
- Worktree directories (`.claude/worktrees/*/`, `new-dashboard/.claude/worktrees/*/`) carry full duplicates of every doc, which makes any global search/replace unreliable.
- No `CHANGELOG.md`, no `ARCHITECTURE.md`. The closest thing to a current architecture description is now **this audit** at `audit/01-architecture.md`.

## 8. Recommendations

1. **Replace `README.md`** with a single accurate page: what the product does today (CareIN dashboard for a dental practice using Retell, Open Dental, Mango), how it deploys (PM2 + Nginx + Cloudflare tunnel), what the actual env vars are, and a link to `audit/01-architecture.md` for system overview.
2. **Quarantine the planning docs.** Move `IMPLEMENTATION_PLAN.md`, `BLUEPRINT_PHASE2_SPEC.md`, and the per-feature notes into a `docs/legacy-plans/` folder with a banner ("aspirational, not implemented unless cross-referenced from `/audit`").
3. **Write one current `OPS.md`** that supersedes `DEPLOYMENT.md` + `PRODUCTION_SETUP.md` + `OFFICE_DEPLOYMENT_GUIDE.md` + `WORKFLOW.md` + `QUICK_REFERENCE.md` + `TROUBLESHOOTING.md`. They have all aged the same way; consolidate.
4. **Document the env var matrix** — every key the backend reads, with required/optional, what it gates, and what breaks if missing. Today this requires reading every service file.
5. **Delete the worktree directories** from the working tree (or `.gitignore` them). They quadruple every doc and confuse search.

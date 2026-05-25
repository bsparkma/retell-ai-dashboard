# NOTES — CareIN AI Call Dashboard

## Architecture Decisions

### Stack conformance
The task spec suggested Next.js + Prisma; the existing repo uses Vite + React +
Express. Conformed to the existing stack. No Prisma — data is persisted to
`data/calls.json` via fs (same pattern as the rest of the repo). This is noted
here per the addendum instructions.

### Two-server design (development)
The new-dashboard already runs two services in dev:
- **Vite dev server** on port 3005 (client hot-reload)
- **CareIN server** (`server/index.ts`) on port 3000 (API + static in prod)

The existing real backend (port 5000) is unchanged. The CareIN client (`careInApi`)
defaults to `http://localhost:3000/api` and is separate from the existing `api`
object that talks to port 5000. If you want a single URL, set
`VITE_CAREIN_API_URL` in `.env`.

### No PHI in fixtures
All 15 seed calls use invented names and numbers. No patient data from any real
system is included.

### MockCommlogWriter always active
There is no live Open Dental commlog integration. `createCommlogWriter()` always
returns `MockCommlogWriter` because `OPENDENTAL_API_URL` is never set. A real
implementation would replace the `// Live implementation would go here` comment
in `server/lib/commlog.ts`. This decision is tracked here per the addendum.

### "Improve, don't rebuild" applied to Calls.tsx
Rather than replacing the existing Calls page, a third tab ("CareIN Log") was
added. The existing "Call Log" (Retell + Mango unified calls) and "Callbacks"
tabs are untouched. CareIN-specific calls render in the new tab.

### Route namespace
CareIN call detail pages use the `/carein-calls/:id` route to avoid colliding
with the existing `/calls/:id` (CallDetail.tsx). If unification is desired later,
the two detail pages can be merged — write it up as a follow-up task.

### Office mapping
Inbound DNIS (`to_number`) is mapped to office names in
`server/lib/ingestion.ts::OFFICE_BY_NUMBER`. In production this should move to
a config file or database table. Currently hardcoded to 4 synthetic offices.

### Quality score heuristic
Quality score (0–100) is derived from sentiment + call_successful flag +
duration. It is purely a heuristic and should be validated against actual
practice outcomes before being used for performance reviews.

## New Dependencies Added
- `@vitest/coverage-v8@2.1.9` (devDependency) — required for coverage reporting.
  Matches the existing `vitest@2.1.9` version exactly.

## Things Deliberately NOT Changed
- Existing API client (`api`) and all existing page logic
- `components/`, `features/`, `hooks/`, `contexts/` directories
- `vite.config.ts`, `tsconfig.json` (no structural changes needed)
- Backend at port 5000 (root-level backend) — completely untouched
- `DashboardLayout`, routing for existing pages
- Any file outside `new-dashboard/`

## Production Cutover (2026-05-24)

The CareIN webhook server is now the production dashboard:

- PM2 `carein-dashboard` runs `new-dashboard/dist/index.js` (built bundle)
  on port 3005 with `NODE_ENV=production`. Replaces the earlier `vite --host`
  dev server. SPA + CareIN API + webhook ingestion are served by one process.
- Built client uses `${window.location.origin}/api` as the CareIN base URL
  in production, so the bundle is origin-agnostic (works behind LAN IP,
  hostname, or a future TLS reverse proxy) without rebuilding.
- Existing backend on port 5003 (`carein-backend`) is unchanged.

### Bug fixed during cutover

The store data dir resolved differently in dev vs prod (esbuild moved the
`__dirname` anchor). It's now resolved from `process.cwd()` and can be
overridden with `CAREIN_DATA_DIR`. The dev/prod stores both live at
`new-dashboard/data/calls.json`. The orphan write at the project root
(`data/calls.json` from the broken path) was renamed to
`data/calls.json.orphan-bak` — safe to delete once verified.

### Empty-on-empty in production

Production never auto-seeds. If `data/calls.json` is empty (or missing),
the dashboard shows an empty CareIN Log tab — by design, so synthetic
seed calls don't masquerade as real ones. Set `USE_SEED_DATA=true` only
for demo/dev environments.

## Step 3 — Call Log unification: DEFERRED

Two tabs surface call data from different pipelines:

| Tab | Source | How | Schema |
|---|---|---|---|
| Call Log | backend:5003 | Retell sync API poll + Mango | basic (caller, time, transcript) |
| CareIN Log | dashboard:3005 | Retell webhook push (real-time) | rich (tag, routing, sentiment, commlog status, quality score) |

Right now Retell is still pointed at the existing backend on 5003. The
CareIN store will stay empty until the webhook URL is repointed. Until
then, unifying the tabs would be a guess at which schema wins.

### Cutover checklist (when you're ready to switch Retell)

1. Set `RETELL_API_KEY=key_live_xxxx` in `new-dashboard/.env`.
2. In the Retell dashboard, change the agent webhook URL to:
   `http://10.20.30.160:3005/api/webhook/retell`
   (or your public HTTPS endpoint if exposed). Enable `call_ended` and
   `call_analyzed` events.
3. `pm2 restart carein-dashboard --update-env` so the new env loads and
   signature verification activates.
4. Make a test call; check the CareIN Log tab in the dashboard.
5. Let it run for ~3–5 days alongside the existing sync flow.
6. Compare the two tabs against the same calls. Then decide:
   - Canonicalize on CareIN schema (richer; deprecate Call Log tab)
   - Or canonicalize on the existing backend (drop the new server)
   - Or merge (write the cross-schema mapping)

## Open Questions for Your Input
1. **Office mapping config**: Should `OFFICE_BY_NUMBER` be a config file or
   come from the real backend? Currently hardcoded.
2. **Data consolidation**: ⏸ DEFERRED — see "Step 3" above; needs real
   webhook data on both sides before deciding.
3. **Commlog retries**: The retry button is wired to the mock writer. When a
   real Open Dental writer is added, the retry flow is already in place.
4. **Webhook authentication**: ✅ RESOLVED (2026-05-24). `Retell.verify()` from
   `retell-sdk` is used. Set `RETELL_API_KEY` in `.env` to enable enforcement.
   Without it: server warns at startup and accepts all payloads (dev-safe).
5. **Data retention**: `data/calls.json` grows unbounded. Add a TTL or max-size
   limit once the data volume is known.

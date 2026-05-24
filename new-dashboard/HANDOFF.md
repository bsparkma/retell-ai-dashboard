# HANDOFF — CareIN AI Call Dashboard

**Date:** 2026-05-24 (updated)  
**Branch:** `main` (commits `ea03403` → `ea88b72`)

---

## Session 3 Changes (2026-05-24) — Live Integration

### What was wired

**`server/index.ts`** — the only file changed in this session:

- **Retell webhook signature verification** (Q4 from NOTES.md, now resolved):
  - Added `retell-sdk` dependency; uses `Retell.verify(rawBodyString, RETELL_API_KEY, signatureHeader)`.
  - Webhook route is now registered **before** `app.use(express.json())`. The route uses `express.raw({ type: "*/*" })` to capture the raw body as a Buffer, then converts to string for `Retell.verify()`.
  - When `RETELL_API_KEY` is set: verifies `x-retell-signature` header; rejects with `401` if invalid.
  - When `RETELL_API_KEY` is absent: emits `[WARN]` at startup and accepts all payloads (safe for dev/curl testing).

- **`USE_SEED_DATA` flag**:
  - `USE_SEED_DATA=true` → always load seed fixtures on startup (dev/demo mode).
  - Default (unset): load persisted `data/calls.json`; seed only if empty (correct for production).

- **`.env.example`**: documented `RETELL_API_KEY`, `VITE_CAREIN_API_URL`, `USE_SEED_DATA`.

### Gate B live flow (validated)

```
POST http://localhost:3002/api/webhook/retell  (no RETELL_API_KEY set → accepted)
Body: tests/fixtures/retell-webhook-call-ended.json

Response: { received: true, processed: true, id: "call_fixture_call_001" }

GET /api/calls → 16 calls (15 seed + 1 ingested)
call_fixture_call_001:
  callerName:    "Sarah Mitchell"
  office:        "Downtown Dental"
  tag:           "appointment_scheduled"
  routedTo:      "Rover (AI)"
  sentiment:     "positive"
  commlogStatus: "written"   ← MockCommlogWriter, OD writes DRY-RUN
  qualityScore:  100
```

### What is live vs mocked

| Component | Status |
|---|---|
| Retell webhook ingestion | ✅ **LIVE** — ready to receive real Retell payloads |
| Signature verification | ✅ **LIVE** — enforced when `RETELL_API_KEY` is set |
| Call store (`data/calls.json`) | ✅ **LIVE** — persists real calls |
| Open Dental commlog writes | 🔒 **DRY-RUN** — `MockCommlogWriter` always; display only |
| Office mapping (`OFFICE_BY_NUMBER`) | ⚠️ Hardcoded (see NOTES.md Q1) |

---

## Session 1+2 Changes — Original Build

## What Changed (High Level)

Added a fully self-contained CareIN AI call dashboard layer to the existing
`new-dashboard` package. The existing application is completely untouched.
New code lives in:

| Location | What it is |
|---|---|
| `server/lib/` | Types, ingestion, store, commlog interface, analytics (all pure/testable) |
| `server/index.ts` | Extended with 6 new API routes |
| `client/src/pages/CareInCallDetail.tsx` | New page: `/carein-calls/:id` |
| `client/src/pages/Calls.tsx` (additions) | Third tab: CareIN Log |
| `client/src/pages/Analytics.tsx` (additions) | CareIN analytics section |
| `client/src/lib/api.ts` (additions) | `careInApi` client + types |
| `tests/` | 136 tests across 4 test files + fixture payload |
| `NOTES.md`, `CHANGELOG.md` | Architecture decisions + change log |

---

## Final Status

| Check | Result |
|---|---|
| TypeScript (`tsc --noEmit`) | ✅ 0 errors |
| Vite build | ✅ Builds cleanly (pre-existing chunk size warning, not new) |
| Tests | ✅ 136/136 pass |
| Coverage — analytics.ts | ✅ 100% (stmt/branch/fn/line) |
| Coverage — ingestion.ts | ✅ 98.54% stmt, 90% branch, 91.66% fn |
| Coverage — commlog.ts | ✅ 93.93% stmt, 92.3% branch, 100% fn |
| Coverage — overall | ✅ 98.71% (target: 75%) |
| Lint | ✅ No errors |
| No live credentials required | ✅ Runs entirely on seed data |
| No PHI in fixtures | ✅ All synthetic names/numbers |

---

## Commands to Install / Run / Test (updated)

```powershell
# From: new-dashboard/

# 1. Install dependencies (already done if you cloned fresh)
pnpm install

# 2. Set your Retell API key in .env (copy from .env.example)
#    RETELL_API_KEY=key_live_xxxx
#    Without it the server starts but verification is disabled (warning logged).

# 3. Start the CareIN API server (port 3000, live data mode)
npx tsx server/index.ts

# 3a. OR start in seed/demo mode (resets data to 15 fixtures on every restart)
#     $env:USE_SEED_DATA = "true"; npx tsx server/index.ts

# 3. In a second terminal: start the Vite dev server (port 3005)
pnpm dev

# 4. Open http://localhost:3005
# → Navigate to Calls → "CareIN Log" tab to see ingested calls
# → Navigate to Analytics → scroll down for CareIN analytics section

# 5. Run tests
pnpm test

# 6. Run tests with coverage report
pnpm test:coverage

# 7. Test the webhook manually (no RETELL_API_KEY set = signature skipped)
curl -X POST http://localhost:3000/api/webhook/retell \
  -H "Content-Type: application/json" \
  -d @tests/fixtures/retell-webhook-call-ended.json

# 7a. In production Retell will sign requests; set RETELL_API_KEY and
#     signature verification enforces automatically.

# 8. Point Retell to your server
#    In Retell dashboard → Agent → Webhook URL: https://your-host/api/webhook/retell
#    Events to enable: call_ended, call_analyzed

# 8. Seed reset (if data gets polluted in dev)
curl -X POST http://localhost:3000/api/dev/seed
```

---

## What I Deliberately Did NOT Touch

- **All existing pages**: Dashboard, Admin, AgentBuilder, Scheduling, Calendar,
  Callbacks — zero changes.
- **Existing API client** (`api` object in `api.ts`) — all methods untouched.
- **Real backend** (port 5000) — not touched. The CareIN server is independent.
- **`vite.config.ts`**, **`tsconfig.json`** — no structural changes.
- **`components/`**, **`features/`**, **`hooks/`**, **`contexts/`** — untouched.
- **`Callbacks.tsx`** — The existing Callbacks tab in Calls.tsx was not modified.
- **`CallDetail.tsx`** — The existing call detail page was not modified. A new
  `CareInCallDetail.tsx` handles CareIN calls at a separate route.

---

## Decisions & Assumptions

1. **Stack**: Conformed to existing Vite + React + Express instead of Next.js +
   Prisma as the spec suggested. See `NOTES.md` for rationale.

2. **Two-tab approach**: CareIN Log is a third tab in the existing Calls page
   rather than a separate page. This preserves all existing functionality while
   adding the new view.

3. **No proxy change**: The `careInApi` client fetches directly from
   `http://localhost:3000` (configurable via `VITE_CAREIN_API_URL`). No Vite
   proxy changes were needed.

4. **MockCommlogWriter always active**: `createCommlogWriter()` always returns
   the mock. A live writer placeholder exists in `commlog.ts`.

5. **File store**: Data persists to `data/calls.json`. No migrations needed.
   Server initializes with seed data on first run if the file doesn't exist.

---

## Open Questions (Need Your Input)

See `NOTES.md` for full details. Summary:

1. **Office mapping**: Should `OFFICE_BY_NUMBER` in `ingestion.ts` become a
   config file? Currently hardcoded.
2. **Data unification**: Merge CareIN Log tab with existing Call Log tab, or
   keep separate? They pull from different data stores.
3. **Webhook auth**: Should the `/api/webhook/retell` endpoint validate a
   Retell webhook secret header before production?
4. **Commlog writer**: When is a real Open Dental commlog writer needed? The
   interface is ready; just implement `write()` in `commlog.ts`.
5. **Data retention**: `calls.json` grows forever. Add TTL or size cap?

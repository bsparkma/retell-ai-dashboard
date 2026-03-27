# New Dashboard Operational Readiness Plan

## Goal
Get the new-dashboard fully wired to real backend data, fix config issues,
add calendar scheduling blocks for the voice agent, and validate end-to-end.

---

## Task 1: Fix Config Mismatches
- [ ] Clean up `new-dashboard/.env` — remove Mango creds, Deepgram, OpenAI keys (these belong in backend only)
- [ ] Ensure `VITE_API_URL` points to correct backend port (5001)
- [ ] Verify backend `CORS_ORIGIN` includes the new-dashboard dev port (3005)
- [ ] Create a clean `.env.example` for the new-dashboard with only the vars it needs

## Task 2: Wire Analytics Page to Real Data
- [ ] Add backend endpoint `GET /api/analytics/summary` that aggregates from unified call store (call volume by day, source breakdown, sentiment if available)
- [ ] Replace `mockAnalyticsData` imports in Analytics.tsx with real API calls
- [ ] Add `getAnalyticsSummary()` to the API client
- [ ] Graceful fallback: show "No data yet" states instead of mock numbers

## Task 3: Wire Admin Page to Real Backend
- [ ] Backend already has `/api/admin/health`, `/api/admin/sync-status`, `/api/admin/costs`
- [ ] Replace hardcoded `mockOffices`, `mockUsers`, `integrations` in Admin.tsx with real API calls
- [ ] Add admin API methods to the API client (`getHealth`, `getSyncStatus`, `getCosts`)
- [ ] Show real Mango sync status, Retell connection health, OD connection status

## Task 4: Fix Dashboard Hourly Chart
- [ ] Replace hardcoded `hourlyData` array in Dashboard.tsx with data from the analytics endpoint (or compute from today's calls)

## Task 5: Calendar Scheduling Blocks
- [ ] Add visual "available slot" blocks to the Calendar page — show open time slots alongside booked appointments
- [ ] Use existing `POST /api/opendental/appointments/find-slots` endpoint to fetch available blocks
- [ ] Color-code: booked appointments vs available blocks vs provider off-time
- [ ] This gives office staff (and the voice agent logic) a clear view of where patients can be scheduled

## Task 6: End-to-End Validation
- [ ] Start backend + new-dashboard together
- [ ] Verify each page loads real data (no console errors, no mock fallbacks)
- [ ] Test Socket.IO connection (LiveMonitor should show connection status)
- [ ] Test OD calendar endpoint returns real data (or clean error if OD unreachable)
- [ ] Verify Retell webhook endpoint responds to test POST
- [ ] Document any remaining issues

---

## Completion Criteria
- `tsc --noEmit` passes in new-dashboard
- All pages render real backend data (Analytics, Admin, Dashboard chart)
- Calendar shows scheduling blocks
- No mock data imports remain in production pages (mockData.ts can stay for dev reference)
- Config is clean — only necessary env vars in new-dashboard/.env

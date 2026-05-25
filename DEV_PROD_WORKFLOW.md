# Dev / Prod Workflow

Two folders on this workstation, two roles. Don't mix them up.

| | PROD | DEV |
|---|---|---|
| Folder | `c:\Users\beau\carein cursor dashboard` | `c:\Users\beau\carein cursor dashboard-dev` |
| Backend port | 5003 | 5103 |
| Dashboard port | 3005 | 3105 |
| URL the team uses | `http://10.20.30.160:3005` | `http://localhost:3105` (you only) |
| Process manager | PM2 (auto-starts on logon) | None — start manually when developing |
| Branch tracked | `main` | any feature branch |
| Edits in Cursor? | **NEVER** | Yes |
| OD writes / agent publish / Mango cron | Enabled | **Disabled by env flags** |

---

## Day-to-day: working on a new feature

```powershell
# 1. Start dev (only when you're actively developing)
cd "c:\Users\beau\carein cursor dashboard-dev"
git checkout -b feature/my-thing       # or switch to an existing branch
git pull origin main --rebase          # bring in latest prod fixes

# 2. Start dev backend + dashboard in two terminals
#    Terminal A:
cd "c:\Users\beau\carein cursor dashboard-dev\backend"
npm run dev

#    Terminal B:
cd "c:\Users\beau\carein cursor dashboard-dev\new-dashboard"
npm run dev

# 3. Open http://localhost:3105 — your dev dashboard, isolated from prod

# 4. When done for the day, Ctrl+C both terminals.
#    Prod keeps running under PM2; the team is unaffected.
```

Open Cursor in the **dev** folder. Treat the prod folder as read-only.

---

## Day-to-day: shipping a feature to prod

```powershell
# In dev folder
cd "c:\Users\beau\carein cursor dashboard-dev"
git add ...
git commit -m "..."
git push origin feature/my-thing

# Open PR on GitHub, review, merge into main.

# Deploy to prod (do this when team isn't on calls):
cd "c:\Users\beau\carein cursor dashboard"
git pull origin main

# Only if package.json changed:
cd backend && npm install && cd ..
cd new-dashboard && npm install && cd ..

pm2 restart all
curl http://10.20.30.160:5003/api/health   # confirm backend healthy
```

---

## PM2 cheat sheet (prod only)

```powershell
pm2 status                       # what's running
pm2 logs carein-backend          # tail backend logs
pm2 logs carein-dashboard        # tail dashboard logs
pm2 restart carein-backend       # restart one app (after .env change)
pm2 restart all                  # restart everything
pm2 stop all                     # stop until next logon (or until pm2 start)
pm2 save                         # rerun after adding/removing apps
```

Logs also live at `logs/backend-*.log` and `logs/dashboard-*.log`.

---

## Safety flags (dev backend `.env`)

These are set to `true` in the dev `.env` and unset in prod. They make the
dev backend safe to run against shared external services:

| Flag | Blocks |
|---|---|
| `OPENDENTAL_WRITE_DISABLED=true` | All POST/PUT/PATCH/DELETE on `/api/opendental/appointments`, `/api/opendental/ai/smart-book`, and `/api/retell-tools/book_appointment`. Returns 403 with `code: OD_WRITE_DISABLED`. |
| `RETELL_AGENT_PUBLISH_DISABLED=true` | `PATCH /api/agents/:id` (which would push a new prompt to the live phone-answering agent). Returns 403 with `code: AGENT_PUBLISH_DISABLED`. |
| `MANGO_SYNC_DISABLED=true` | Mango cron job + manual `runSync` calls (which would log into the Mango portal and could conflict with prod's session). |

Verify in dev:
```powershell
curl -X PATCH -H "Content-Type: application/json" -d "{\"agent_name\":\"x\"}" http://localhost:5103/api/agents/test
# Expect: {"success":false,"error":"Retell agent publishing disabled..."}
```

---

## Things that stay shared between dev and prod

These are not isolated — be aware:

- **Retell API key** — same key. Dev pulls call data (read-only) from the same account. Don't hammer it.
- **Open Dental connector + API** — dev reads the same practice data. Writes are blocked by the safety flag above.
- **Deepgram / OpenAI** — dev usage bills your same accounts. Keep dev volume reasonable.
- **Retell webhooks** — only point at prod (`http://10.20.30.160:5003`). Dev won't receive live webhook events; test with synthetic payloads.
- **Mango portal credentials** — same login. The flag prevents dev from logging in concurrently.

---

## Things that are isolated

- `data/` directory (call store, callbacks JSON, configs, access logs) — separate per folder
- `backend/recordings/` — separate
- `node_modules/` — separate
- `logs/` (PM2) — only the prod folder has these
- Git working tree and branch state — completely independent

---

## When something goes wrong

**Team reports the dashboard is offline:**
1. `pm2 status` — both apps should be `online`. If not, `pm2 restart all`.
2. `curl http://10.20.30.160:5003/api/health` — should return JSON.
3. `pm2 logs carein-backend --lines 50` — look for stack traces.

**Prod backend won't start after a deploy:**
1. `pm2 logs carein-backend --err --lines 50` — read the error.
2. If it's a code bug introduced by the deploy: `cd "c:\Users\beau\carein cursor dashboard" && git log --oneline -5`, then `git revert <bad-commit>` or `git reset --hard <previous-good-commit>` (only if you know nothing else has been pushed).
3. `pm2 restart all`.

**Dev port already in use:**
A previous `npm run dev` is still running. `netstat -ano | findstr :5103` to find the PID, then `Stop-Process -Id <pid> -Force` in PowerShell.

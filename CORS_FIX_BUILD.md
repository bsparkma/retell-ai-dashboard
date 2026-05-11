# CORS Fix — Cursor Build Prompt

> **Instructions for Claude in Cursor:** Read this entire file before editing. This is a 3-file change, ~5 minutes. No code changes, no typecheck needed — just config + a stale doc note.

---

## Context

The new-dashboard is throwing a CORS-shaped error in the browser console when it tries to call the backend. The actual root cause is **not** CORS — it's that the dashboard is pointed at the wrong port.

- Backend (`backend/server.js`) listens on `PORT || 5000` — i.e. **`http://localhost:5000`** by default in dev.
- Dashboard `.env` and `.env.example` set `VITE_API_URL=http://localhost:5001/api`.
- Result: the browser tries to reach `localhost:5001`, gets a connection refused, and surfaces it as a generic network/CORS failure in DevTools.

The fix is to point the dashboard at port `5000` so it actually talks to the backend.

---

## Scope

**In scope (3 files):**
1. `new-dashboard/.env` — change port `5001` → `5000`
2. `new-dashboard/.env.example` — change port `5001` → `5000`
3. `new-dashboard/plan.md` — update the stale note that says `(5001)` → `(5000)` so the plan doesn't contradict the truth

**Out of scope:**
- `backend/.env`, `backend/server.js`, or any backend CORS config — the backend is correct, do not touch
- `new-dashboard/activity.md` — that file records *what happened historically*, leave it alone
- Any worktrees under `.claude/worktrees/**` — those are isolated, do not touch
- Any source code (`.ts`/`.tsx`) — there are no hardcoded `5001` references in app code

---

## Exact Changes

### 1. `new-dashboard/.env`

Replace:

```
VITE_API_URL=http://localhost:5001/api
```

with:

```
VITE_API_URL=http://localhost:5000/api
```

### 2. `new-dashboard/.env.example`

Replace:

```
VITE_API_URL=http://localhost:5001/api
```

with:

```
VITE_API_URL=http://localhost:5000/api
```

Leave every other line in the file untouched (comments, the `VITE_DASHBOARD_API_TOKEN=` line, etc.).

### 3. `new-dashboard/plan.md`

On the line that currently reads:

```
- [ ] Ensure `VITE_API_URL` points to correct backend port (5001)
```

Change `(5001)` to `(5000)`. Do not modify any other lines in the file.

---

## Verification

No build, no typecheck, no test runner needed. Verify by:

1. `git diff new-dashboard/.env new-dashboard/.env.example new-dashboard/plan.md` shows exactly the three port edits above and nothing else.
2. `rg -n "5001" new-dashboard --glob "!.claude/**" --glob "!activity.md"` returns zero matches.

If either check fails, fix it before stopping.

---

## Commit Message

```
fix: point new-dashboard at backend port 5000 (was 5001)

The dashboard's VITE_API_URL pointed at localhost:5001 while the
backend listens on PORT || 5000, causing connection-refused errors
that surfaced as CORS failures in the browser console.
```

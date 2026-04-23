# Pilot Office Setup

This is the deployment guide for the **first dental office** running CareIn.
It is intentionally short, pragmatic, and honest about what is and isn't ready.

If something here disagrees with `README.md`, `DEPLOYMENT.md`, or
`PRODUCTION_SETUP.md`, **this document wins**. The other docs predate the
audit in `cursor-audit/` and contain assumptions that are no longer true.

---

## 1. What you're deploying

Two Node services and an Open Dental connection:

| Service          | Port | Purpose                                                                  |
| ---------------- | ---- | ------------------------------------------------------------------------ |
| `carein-backend` | 5000 | Express API + Socket.IO. Receives Retell webhooks, talks to Open Dental, persists calls/callbacks to JSON on disk, runs Mango scrape on a cron. |
| `carein-dashboard` | 3005 | Vite-built React UI + small Express server that serves the bundle. Talks to `carein-backend` over HTTP. |

Plus:

- **Retell AI** — handles the actual phone calls. Webhooks arrive at
  `/api/webhooks/retell` on the backend.
- **Open Dental** — patient + scheduling source of truth. Connected over
  REST API or direct MySQL depending on the office.
- **Mango Voice** — call recording portal. Backend logs in via Puppeteer
  on a cron and downloads new MP3s for transcription.
- **Cloudflare Tunnel** (`cloudflared`) — exposes the dashboard publicly
  at `https://carein-do.flamingketchup.com` without opening firewall
  ports on the droplet.

---

## 2. Honest "what works / what's known broken"

Read `cursor-audit/01-executive-summary.md` for the full picture. The
short version, going into pilot:

### Works today

- Retell AI receives calls, runs the AI agent prompt you pasted into the
  Retell dashboard, writes transcripts back via webhook.
- Backend stores every call in `data/unified_calls.json`, with atomic
  writes (added in this round of fixes).
- Backend HMAC-verifies Retell webhooks correctly (also fixed this round).
- Dashboard shows live calls, call history, callbacks, and the Open
  Dental calendar. UI is reasonably polished.
- Mango Voice scrape pulls staff calls hourly and transcribes them via
  Deepgram.

### Known broken or partial — handle in office workflow until C-phase ships

These are documented in `cursor-audit/03-workflows.md` and
`cursor-audit/11-evidence-and-confidence.md`. Quick summary:

1. **AI booking is shipped but disabled by default.** A signed-tool
   surface (`/api/retell-tools/lookup_patient`, `find_available_slots`,
   `book_appointment`, `create_callback`) now exists and is wired to the
   real Open Dental backend. It is gated behind
   `RETELL_TOOLS_ENABLED=false`. **Recommended pilot mode:** keep it off,
   let the AI take callbacks, have staff call back. Once the pilot is
   stable for 1–2 weeks, follow `docs/retell-tools.md` to register the
   tool definitions in the Retell dashboard, flip the flag, and watch the
   first 50 calls closely.
2. **Agent Builder now publishes to Retell.** The "Publish to Retell"
   button (added in Phase C) PATCHes the live agent's System Prompt via
   the backend. The "Save Draft" button still only writes to
   `localStorage`. The UI says this clearly. If publish fails the toast
   will say so — do not assume success without seeing a green toast and a
   `last published` timestamp.
3. **Scheduling Rules are reference only.** The rules screen is for staff
   to align on policy. The AI does not call into the dashboard for slot
   lookup or booking.
4. **Patient name matching is best-effort.** Patient lookup falls back
   to digits-only LIKE queries. Verify with the script in
   `cursor-audit/scripts/test-phone-normalization.js` before go-live.
5. **Webhook duplicates may write duplicate Open Dental CommLog entries.**
   Verify with `cursor-audit/scripts/test-duplicate-webhook.js`. If
   confirmed, treat duplicate CommLog as a known cosmetic issue for the
   pilot office.

If any of these are blockers for the pilot office, do not go live until
the corresponding roadmap item ships.

---

## 3. Prerequisites (one time)

- DigitalOcean droplet, Ubuntu 22.04+, 2 GB RAM minimum, 4 GB recommended.
- Node 18.x or 20.x.
- `pm2` installed globally: `npm install -g pm2`.
- `nginx` (optional, only if not using Cloudflare Tunnel for TLS).
- `cloudflared` installed and authenticated to your Cloudflare account.
- A Retell AI account with:
  - At least one **Agent** configured.
  - At least one **Phone Number** assigned to that agent.
  - The **Webhook Signing Secret** for that agent (Retell dashboard →
    Agent → Webhook).
- Open Dental:
  - Either API access (Developer Key + Customer Key from Open Dental
    customer portal), or
  - Direct MySQL access (host/port/user/password) — only practical when
    the droplet can reach the office network.
- Mango Voice portal credentials (username + password + PBX name).
- Deepgram API key.
- OpenAI API key.

---

## 4. First deploy

### 4.1 Clone and install

```bash
ssh root@<droplet-ip>
mkdir -p /root && cd /root
git clone https://github.com/bsparkma/retell-ai-dashboard.git carein
cd carein

npm --prefix backend install
npm --prefix new-dashboard install
npm --prefix new-dashboard run build      # builds client/dist + server dist/index.js
```

### 4.2 Generate the dashboard auth token

The backend now requires a bearer token on every API + Socket.IO
request (added in B-P0-08). Generate one:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy the hex string. You will paste it into **two** env files below.

### 4.3 Create `backend/.env`

Start from the example:

```bash
cp backend/.env.example backend/.env
nano backend/.env
```

Fill in:

```dotenv
PORT=5000
NODE_ENV=production
CORS_ORIGIN=https://carein-do.flamingketchup.com,http://localhost:3005

DASHBOARD_API_TOKEN=<paste the hex string from 4.2>

RETELL_API_KEY=<your new rotated Retell key>
RETELL_WEBHOOK_SECRET=<your Retell webhook signing secret>
WEBHOOK_VERIFY_DISABLED=false

MANGO_PORTAL_URL=https://admin.mangovoice.com
MANGO_USERNAME=<office username>
MANGO_PASSWORD=<office password>
MANGO_PBX_NAME=<office PBX name>
MANGO_SYNC_SCHEDULE=15 * * * *
MANGO_MAX_RECORDINGS_PER_SYNC=10

DEEPGRAM_API_KEY=<your Deepgram key>
OPENAI_API_KEY=<your OpenAI key>

OPENDENTAL_INTEGRATION_MODE=api
OPENDENTAL_API_BASE_URL=https://api.opendental.com/api/v1
OPENDENTAL_DEVELOPER_KEY=<from Open Dental portal>
OPENDENTAL_CUSTOMER_KEY=<from Open Dental portal>
```

> **Critical**: `DASHBOARD_API_TOKEN` MUST be set in production. The
> backend returns 503 if it is missing.

### 4.4 Create `new-dashboard/.env`

```bash
cp new-dashboard/.env.example new-dashboard/.env
nano new-dashboard/.env
```

```dotenv
VITE_API_URL=http://127.0.0.1:5000/api
VITE_DASHBOARD_API_TOKEN=<paste the SAME hex string from 4.2>
```

> If you change the token later, you must rebuild the dashboard with
> `npm --prefix new-dashboard run build` so the bundle picks up the new
> value (Vite inlines `VITE_*` at build time).

### 4.5 Start with PM2

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd       # follow the printed instructions
```

Logs:

```bash
pm2 logs carein-backend
pm2 logs carein-dashboard
```

### 4.6 Smoke test

From the droplet:

```bash
curl -s http://127.0.0.1:5000/api/health | jq
# Should return { "status": "OK", "services": {...} }

curl -s http://127.0.0.1:5000/api/unified-calls | head
# Should return: { "success": false, "error": "Unauthorized: ..." }
# (because no token → backend correctly refuses)

curl -s -H "Authorization: Bearer $DASHBOARD_API_TOKEN" \
     http://127.0.0.1:5000/api/unified-calls | jq '.calls | length'
# Should return a number.
```

From your laptop, browse to https://carein-do.flamingketchup.com.
The dashboard should load and show calls. If it says "Failed to fetch"
or shows zero data, check the browser console — most likely the bearer
token is wrong or missing.

### 4.7 Configure Retell webhook

In the Retell dashboard for the agent:

- Webhook URL: `https://carein-do.flamingketchup.com/api/webhooks/retell`
  (or whatever public URL points at the backend, **not** the dashboard).
- Webhook signing secret: copy it into `backend/.env` as
  `RETELL_WEBHOOK_SECRET`, then `pm2 restart carein-backend`.

Place a test call to the office's Retell number. Within ~30 seconds:

- `pm2 logs carein-backend` should show a `📞 call_started` line, then
  `✅ Webhook signature verified` for each event, then `call_ended` and
  `call_analyzed`.
- The dashboard should show the call appearing live, then move to call
  history with a transcript.

If signature verification fails:

- Check `RETELL_WEBHOOK_SECRET` matches the Retell dashboard exactly
  (no surrounding whitespace).
- As a last resort during initial bring-up only, set
  `WEBHOOK_VERIFY_DISABLED=true` in `backend/.env`, restart, and
  re-test. **Do not leave this set in production.**

---

## 5. Day-1 ops cheat sheet

| Task                          | Command                                                     |
| ----------------------------- | ----------------------------------------------------------- |
| Tail backend logs             | `pm2 logs carein-backend`                                   |
| Tail dashboard logs           | `pm2 logs carein-dashboard`                                 |
| Restart everything            | `pm2 restart all`                                           |
| Backend health                | `curl -s http://127.0.0.1:5000/api/health \| jq`            |
| Where call data lives         | `backend/data/unified_calls.json`                           |
| Where callbacks live          | `data/callbacks.json` (relative to repo root)               |
| Where Mango recordings live   | `backend/recordings/mango/*.mp3`                            |
| Where PM2 logs live           | `logs/backend-{out,error}.log`, `logs/dashboard-{out,error}.log` |

### Backups

There is no database. Both critical files are flat JSON:

- `backend/data/unified_calls.json` — every call, transcript, summary.
- `data/callbacks.json` — every callback ever created, plus its status.

Back these up nightly. A simple cron entry is plenty for the pilot:

```cron
30 2 * * * tar czf /root/backups/carein-$(date +\%F).tar.gz \
    /root/carein/backend/data /root/carein/data
```

### Adding office staff users

There are no user accounts. Anyone with the dashboard URL **and** the
bearer token can read everything. For the pilot:

- Treat the dashboard URL + token as a shared password.
- Don't put the URL on the office WiFi captive portal or anywhere
  searchable.
- Plan to add real user auth (Auth0 / Clerk / similar) before the
  second office goes live. This is roadmap, not pilot-blocking.

### Rotating secrets

Procedure for the Retell key (and equivalent for any other key):

1. Generate a new key in the upstream provider's dashboard.
2. Update `backend/.env` on the droplet.
3. `pm2 restart carein-backend`.
4. Smoke-test (place a call).
5. Revoke the old key in the upstream provider's dashboard.

The dashboard auth token rotates differently — see `cursor-audit/12-verification-checklist.md`.

---

## 6. Pilot success criteria

Before declaring the pilot a success and moving to a second office, the
following should all be true for at least 2 consecutive weeks:

- Zero unrecovered call data loss (no missing calls in
  `unified_calls.json` versus the Retell dashboard).
- Webhook signature verification stays enabled (`WEBHOOK_VERIFY_DISABLED`
  is not in the env, or is `false`).
- No callbacks are reported missing by office staff.
- Office staff can describe the AI's job in one sentence (it takes a
  message; staff books).
- Retell dashboard does not show unexplained billing.

When all five are true, return to `cursor-audit/08-prioritized-fix-roadmap.md`
and pick up the P1 items (Retell function-call tools, agent publish,
real auth).

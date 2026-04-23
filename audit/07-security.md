# 07 — Security

This is the highest-risk audit area. The system handles **PHI** (caller phone numbers, transcripts of dental conversations, patient names, appointment data) and writes into a live **PMS database**, but has **no authentication** anywhere in the application.

## 1. Critical findings

### C-1. Hardcoded Retell API key committed in `README.md`

[`README.md:102`](../README.md):
```
RETELL_API_KEY=key_5286e8b619b00ed6815991eba586
```

This is presented as a real-looking key, in the live "Production Environment" section, alongside the production server IP. Whether or not this exact value is currently active, it is committed to a public-shaped GitHub repo (`bsparkma/retell-ai-dashboard`) and must be treated as **compromised**.

**Action:** rotate `RETELL_API_KEY` immediately, scrub the README, and rewrite git history (or assume the key is leaked and rotate again on a regular schedule).

### C-2. No authentication on any HTTP route

`backend/server.js` mounts 11 routers. None of them apply auth middleware. The publicly mounted writes include:

| Route | Effect | Auth | File |
|---|---|---|---|
| `PATCH /api/agents/:id` | Modifies Retell agent prompt/voice/etc. | none | `backend/routes/agents.js` |
| `POST /api/opendental/appointments` | Inserts appointment into PMS | none | `backend/routes/openDental.js` |
| `POST /api/opendental/appointments/check-conflicts` | Reads PMS schedule | none | same |
| `POST /api/opendental-sync/calls/:id/sync` | Writes commlog to PMS | none | `backend/routes/openDentalSync.js` |
| `POST /api/opendental-sync/match-all` | Mass write attempt | none | same |
| `POST /api/unified-calls/sync-retell` | Triggers full Retell pull | none | `backend/routes/unifiedCalls.js` |
| `POST /api/mango/sync` | Triggers Puppeteer scraping | none | `backend/routes/mango.js` |
| `POST /api/mango/transcribe/:id` | Triggers Deepgram + OpenAI calls (cost) | none | same |
| `PATCH /api/callbacks/:id` | Modifies callback queue | none | `backend/routes/callbacks.js` |
| `POST /api/admin/*` | Admin operations | none | `backend/routes/admin.js` |
| `GET /api/calls`, `/api/unified-calls`, `/api/analytics/*` | Returns full call transcripts (PHI) | none | various |

The README explicitly documents this:
> 🔓 **Access**: Open to all team members (no authentication required) — [README.md:174](../README.md)

The site is reachable on `http://159.89.82.167` (HTTP only, port 80 open). It is also reachable via the `cloudflared` tunnel at `carein-do.flamingketchup.com` (CORS allow-list in `server.js:37-43`). Anyone who learns either URL can:
- read every call transcript and recording stored in `data/unified_calls.json`,
- create/modify/cancel real appointments in Open Dental,
- mutate Retell agent prompts,
- trigger expensive Deepgram and OpenAI runs at will (denial-of-wallet).

### C-3. Webhook signature verification is dev-disabled and likely broken in prod

[`backend/routes/webhooks.js:20-41`](../backend/routes/webhooks.js):
```js
function verifyRetellSignature(req) {
  if (process.env.NODE_ENV !== 'production') return true;
  ...
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
```

Two problems:
1. **Dev bypass**: any deployment that forgets `NODE_ENV=production` (e.g., the legacy frontend Docker dev compose, or a misconfigured PM2 entry) accepts unsigned webhooks. Combined with C-2, this is a pre-auth RCE-adjacent foothold for poisoning the call store and triggering Open Dental writes (`handleCallAnalyzed` writes into the PMS — see `webhooks.js:218-279`).
2. **`timingSafeEqual` length mismatch**: if the header is missing or wrong length, `Buffer.from(signature)` and `Buffer.from(expected)` differ in length and `timingSafeEqual` throws — caught by the outer `try/catch` only after the route handler runs. Also: Retell signs the **raw request body**, not `JSON.stringify(req.body)`. After Express has parsed JSON, key ordering, whitespace, and number formatting may differ from the bytes Retell signed. The current verifier will reject valid signatures and is thus unverified by anyone today. The Retell docs that should be referenced were not consulted in code.

**Action:** capture the raw body before `express.json()` for `/api/webhooks/retell`, use the **webhook signing secret** Retell provides (not the API key — see Retell docs), and remove the dev bypass behind a non-default flag like `RETELL_SKIP_SIG=1`.

### C-4. PHI shipped to OpenAI without documented BAA

[`backend/services/callAnalyzer.js`](../backend/services/callAnalyzer.js) sends transcripts (which contain caller name, phone, medical complaints, insurance details) to `gpt-3.5-turbo` via the standard OpenAI API. The model is the consumer/product API (`openai` SDK with `OPENAI_API_KEY`), which by default is **not HIPAA-eligible** — that requires either an enterprise BAA + zero-data-retention agreement, or use of Azure OpenAI / Anthropic / a HIPAA-compliant provider. Same concern for Deepgram (which does offer a BAA but no evidence in this repo that one is signed).

**Action:** decide whether this product is in scope for HIPAA. If yes, sign BAAs with Deepgram and OpenAI and document them, or move analysis to a covered provider. If no, stop processing real patient calls until the legal posture is resolved.

### C-5. Open Dental credentials and DB URL via env, no rotation policy

`backend/config/openDental.js` reads `OPENDENTAL_DB_URL` and the REST credentials from env. The DB URL is a `mysql2` connection string with full read/write to the practice management database. A leak of the server's `.env` is total compromise of the dental practice.

**Action:** put the DB user behind a least-privilege account scoped to the tables the app actually touches (appointments, providers, operatories, patients, commlog), document rotation, and consider an SSH tunnel rather than direct exposure.

## 2. High findings

### H-1. CORS allows credentials from any of a comma-separated list, no validation

`server.js:30-35` parses `CORS_ORIGIN` by `.split(',')` with `credentials: true`. Combined with the `morgan('combined')` log line, an attacker with control of one allow-listed origin (or who can modify the env on the box) can use cookies/Authorization headers cross-origin. There are no cookies today (no auth), so the immediate impact is low — but this becomes an XSS amplifier the moment auth is added.

### H-2. Mango credentials stored as plain env vars and used to log into a production phone system

`backend/services/mangoScraper.js` uses `MANGO_USERNAME` / `MANGO_PASSWORD` to log into Mango's web portal via Puppeteer. A leak of the server's `.env` gives an attacker the practice's full call history, recordings, and (depending on Mango role) admin control of the phone system.

### H-3. PHI written to logs

The codebase logs liberally:
- `webhooks.js:67-71` — every Retell event with `call_id` and `event` type (low risk).
- `webhooks.js:267,273` — patient last name, first name, caller phone (PHI).
- `callAnalyzer.js` and `transcriptionService.js` — log transcript snippets and file paths.
- `morgan('combined')` — full request URLs, headers including any future auth tokens.

PM2 writes these to `./logs/*.log` which are rotated only by PM2 defaults and never centrally shipped. Anyone with shell access to the droplet has the full PHI history of every analyzed call.

**Action:** strip PHI from logs (mask names/phones), use `morgan('common')` not `combined` to drop user-agent leakage, and decide a log retention policy.

### H-4. JSON file as the sole store of PHI, world-readable on disk

`data/unified_calls.json` and `recordings/mango/*.mp3` sit on the droplet's filesystem with whatever umask `node` ran with — typically `644`. There's no encryption at rest. Any process running as the same user can read everything.

### H-5. No HTTPS

README confirms: `**SSL** | Not configured (HTTP only)`. The Cloudflare tunnel terminates TLS at Cloudflare and connects to `localhost:5000` over HTTP, but the alternative path `http://159.89.82.167` exposes traffic in cleartext to any network observer.

### H-6. Webhook test endpoint open in non-prod

`POST /api/webhooks/test` (`webhooks.js:346`) lets unauthenticated callers fabricate `call_started`/`call_ended`/`transcript` events. It's gated only by `NODE_ENV !== 'production'`. With C-3's dev bypass, this is a one-step way to inject fake calls — including ones whose `call_analyzed` path can drive Open Dental commlog writes.

### H-7. `frontend/nginx.conf` `/api/` proxy without rate limiting

The Nginx proxy in `frontend/nginx.conf` forwards `/api/` to the backend. The only rate limiting is the in-process `express-rate-limit` (`100 req / 15min` in prod). A trivial loop from a single IP can exhaust the limit and DoS legitimate clients; from many IPs (or `X-Forwarded-For` spoofing — `app.set('trust proxy', 1)` trusts one hop) the limit doesn't bite at all.

### H-8. `od-microservice/` orphaned but contains real code paths

If `od-microservice/` is ever resurrected, it ships with [`od-microservice/src/auth/middleware.ts`](../od-microservice/src/auth/middleware.ts) that does its own auth — but the main backend doesn't share that posture. Risk: someone redeploys it thinking it's "the secure one" and now there are two ways to write to Open Dental, only one authenticated.

## 3. Medium findings

- **M-1. `app.set('trust proxy', 1)`** trusts a single forwarded hop. Behind both Nginx and the Cloudflare tunnel, that's two hops; client IPs in logs and rate-limit keys are wrong.
- **M-2. Helmet disabled CSP defaults**: `crossOriginResourcePolicy: 'cross-origin'` and `crossOriginEmbedderPolicy: false` weaken Helmet's defaults to make the new dashboard work. Once auth lands, restore strict CSP.
- **M-3. Recordings served from `/api/mango/recordings` via `express.static`**, no auth, directory listing disabled by default but file enumeration possible if MP3 filenames are predictable.
- **M-4. No SRI / no CSP on either frontend** — both load Material-UI / Tailwind from npm bundles, but the legacy frontend pulls `https://fonts.googleapis.com` in `frontend/public/index.html` without integrity hashes.
- **M-5. Error handler leaks stack traces in dev**: `server.js:135-141` returns `err.message` only in dev, but the dev bypass is the same trigger as C-3 — if NODE_ENV is wrong, this leaks too.
- **M-6. No request size cap**: `express.json()` with no `limit` accepts 100 KB by default — fine, but `express.urlencoded({ extended: true })` with no `limit` is also default-100KB. Worth setting explicitly.
- **M-7. `liveCallManager` and `unifiedCallStore` keep transcripts in memory** indefinitely. Long-running uptime accumulates PHI in the heap; a heap dump = full PHI.
- **M-8. `setup.sh` writes `.env` files** — make sure operator scripts use `chmod 600` and not the default umask.

## 4. Low / hardening

- **L-1.** Switch `morgan('combined')` to a JSON logger that strips PHI and ships to a SIEM if any HIPAA scope is intended.
- **L-2.** Add a `Strict-Transport-Security` header once HTTPS is in front of the origin.
- **L-3.** Add `helmet.referrerPolicy('no-referrer')`.
- **L-4.** `backend/Dockerfile` runs as root by default — add `USER node`.
- **L-5.** `frontend/Dockerfile` Nginx image is `nginx:alpine` — pin a digest, not a floating tag.
- **L-6.** `backend/package.json` has no `engines` field; PM2 may run on whatever Node the box has.
- **L-7.** No dependency vulnerability scanning configured (no `npm audit` in CI; there is no CI).

## 5. Secrets present (or referenced) in repo

| Secret | Where | Risk |
|---|---|---|
| `RETELL_API_KEY=key_5286e8b619b00ed6815991eba586` | `README.md:102` | **Live key in plaintext, public repo.** |
| `RETELL_API_KEY` (env) | `backend/.env` (gitignored) | Used as both API key and webhook signing key (C-3). |
| `OPENAI_API_KEY` | `backend/.env` | Charges + PHI; no spend cap. |
| `DEEPGRAM_API_KEY` | `backend/.env` | Charges + PHI. |
| `OPENDENTAL_DB_URL` | `backend/.env` | Full PMS write access. |
| `OD_DEV_KEY` / `OD_CUST_KEY` | `backend/.env` | Open Dental REST creds. |
| `MANGO_USERNAME` / `MANGO_PASSWORD` | `backend/.env` | Phone system admin. |

`.gitignore` covers `.env` (verified by git history scan in Phase B). The only confirmed leak is the README. A full secret-scan pass with `gitleaks` is recommended.

## 6. Top 5 actions, in order

1. **Rotate `RETELL_API_KEY`** and scrub it from `README.md` and git history (C-1).
2. **Put auth on the backend** — even shared bearer token via Nginx + `Authorization: Bearer` middleware in front of every router. Immediately closes C-2 and most of the High findings.
3. **Fix Retell webhook verification** properly — raw body capture, dedicated webhook secret, no env-conditional bypass (C-3).
4. **Sign BAAs (or stop processing real PHI)** with Deepgram and OpenAI; otherwise route to a HIPAA-eligible provider (C-4).
5. **Front the API with HTTPS only** — disable port 80 / `159.89.82.167` direct access and force everything through the Cloudflare tunnel with HSTS.

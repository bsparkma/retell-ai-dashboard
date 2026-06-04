# LAN Team Access — HTTPS Single-Origin Deployment

_How to serve the SSO-gated CareIN dashboard to office staff over the LAN. Drafted 2026-06-03. This is effectively the prod deployment; do the localhost smoke-test (PHASE1_SWITCHON_RUNBOOK §1) first._

## Why HTTPS + a hostname (not the raw LAN IP)

- **Entra requires https redirect URIs** — `http://localhost` is the only http exception; `http://10.20.30.160/...` is rejected. So SSO can't redirect back to a plain-http LAN address.
- **HIPAA** — patient data and the session cookie must not cross the network in plaintext.
- **Bonus** — serving the built SPA + the API under ONE origin eliminates the CORS/cookie problems entirely and needs only a single registered redirect URI.

## Target architecture

```
Office PC browser ──https──> dashboard.carein.ai  (DNS A → 10.20.30.160, private IP = LAN-only)
                              │  Caddy reverse proxy on the host (terminates TLS)
                              ├── /api/*  + /auth/*  → reverse_proxy → backend :5003 (PM2, prod)
                              └── everything else     → serve built new-dashboard /dist (SPA)
```
- One origin → no CORS, Secure cookies valid (https).
- Backend = prod: `NODE_ENV=production`, secrets from Key Vault, prod control + per-tenant Postgres.

## Steps

**1. DNS** — In GoDaddy DNS for `carein.ai`, add an A record `dashboard` → `10.20.30.160`. (It's a private IP, so only devices on the office LAN can reach the host; the public hostname just makes the cert trusted.)

**2. TLS cert** — Use Caddy with a **DNS-01 ACME challenge** (HTTP-01 won't work — the host isn't reachable from the public internet). Easiest path given you already use Cloudflare: move `carein.ai` DNS to Cloudflare (free), then run Caddy with its Cloudflare-DNS module + an API token — it auto-issues and auto-renews the cert for `dashboard.carein.ai`, no browser warnings. (Alternative: obtain a cert separately and point Caddy at it.)

**3. Caddyfile** (on the host):
```
dashboard.carein.ai {
  handle /api/*  { reverse_proxy localhost:5003 }
  handle /auth/* { reverse_proxy localhost:5003 }
  handle {
    root * C:\Users\beau\carein cursor dashboard\new-dashboard\dist
    try_files {path} /index.html
    file_server
  }
}
```

**4. Build the SPA same-origin** — set `VITE_API_URL=/api` (relative, so it calls the same origin) in the prod build env, then `npm run build` in `new-dashboard`. Output goes to `dist/` (what Caddy serves).

**5. Backend prod env** (Key Vault supplies secrets in prod):
```
NODE_ENV=production
DASHBOARD_SSO_REDIRECT_URI=https://dashboard.carein.ai/auth/callback
DASHBOARD_POST_LOGIN_URL=https://dashboard.carein.ai
# control + per-tenant DB conn (carein_app role) resolved from Key Vault: control-db-url, tenant-carein-db-url
```
Cookie `Secure` auto-enables in production — valid now that it's https.

**6. Entra redirect URI** — Azure portal → App registrations → **CareIN-Dashboard-SSO** → Authentication → add a **Web** redirect URI: `https://dashboard.carein.ai/auth/callback`. (Keep the localhost one for your dev.)

**7. Provision prod databases** — per `PHASE1_SWITCHON_RUNBOOK.md` §3: control DB + CareIN's per-tenant DB on Azure Postgres (Burstable B1ms per the cost guardrails), `carein_app` role, migrations, secrets in Key Vault. Tenant context fails closed without the control DB, so this must exist before the backend serves traffic.

**8. Run** — backend under PM2 (`NODE_ENV=production`), start Caddy. Staff browse `https://dashboard.carein.ai` and sign in with their `carein.ai` accounts (create each as a free no-license Entra user per the team-access notes). Per-tenant `audit_log` records who accessed what.

## HIPAA posture (why this is the right end state, not overkill)
TLS everywhere, individual SSO logins (real audit attribution), per-tenant data isolation, append-only audit. Serving PHI over plain http on the LAN would fail a security review — this setup passes it.

## Sequence reminder
1. Finish localhost smoke-test (prove the spine). 2. Move DNS to Cloudflare + cert. 3. Caddy + same-origin build. 4. Entra redirect URI. 5. Prod DBs. 6. PM2 + Caddy live. 7. Create staff accounts.

# Dashboard Single Sign-On (Microsoft Entra)

Only **careindent**-tenant **@carein.ai** accounts can sign in to the CareIN
dashboard. Authentication uses the OAuth2 **authorization-code flow (with PKCE)**
implemented server-side with `@azure/msal-node`. The React SPA stays a pure SPA —
it never handles Microsoft tokens.

---

## Pieces

| Piece | Where |
|-------|-------|
| App registration | **CareIN-Dashboard-SSO** (single-tenant) — appId `d30ab7dd-5fcf-41d0-97a2-3f7b39bce07f` |
| Graph permission | `User.Read` (delegated, **admin consent granted**) |
| Client secret | Key Vault secret `dashboard-sso-client-secret` → env `DASHBOARD_SSO_CLIENT_SECRET` |
| Session signing key | Key Vault secret `dashboard-session-secret` → env `DASHBOARD_SESSION_SECRET` |
| Backend config | [`backend/config/sso.js`](../backend/config/sso.js) |
| Backend routes | [`backend/routes/auth.js`](../backend/routes/auth.js) — `/auth/login`, `/auth/callback`, `/auth/logout`, `/auth/me` |
| API gate | [`backend/middleware/auth.js`](../backend/middleware/auth.js) — `requireDashboardAuth` |
| SPA gate | `client/src/components/RequireAuth.tsx` + `client/src/pages/SignIn.tsx` + `client/src/lib/auth.ts` |

The secrets are loaded into `process.env` at startup by
[`backend/config/secrets.js`](../backend/config/secrets.js) (Key Vault in prod;
`.env` in dev). **Nothing secret is hardcoded or committed.** The non-secret
client/tenant IDs are also recorded in the gitignored `.local/entra-sso-app.json`.

---

## Flow

```
Browser (SPA)                Backend (Express, :5103)              Microsoft Entra
─────────────                ────────────────────────              ───────────────
RequireAuth → GET /auth/me ──► verify session cookie
   401 (no session)
SignIn screen
  "Sign in" ───────────────► GET /auth/login
                              build PKCE + state, redirect ───────► login.microsoftonline.com
                                                                     user signs in (carein.ai)
                              GET /auth/callback?code&state ◄─────── redirect with code
                              acquireTokenByCode (PKCE)
                              enforce tenant == careindent
                              enforce email endsWith @carein.ai
                              mint session JWT (HS256, 8h)
                              Set-Cookie carein_sso (HttpOnly) ────► redirect to SPA
SPA loads, GET /auth/me ────► session valid → { user }
API calls send cookie ──────► requireDashboardAuth → allow
```

### Authorization rules (enforced in `/auth/callback`)
1. `account.tenantId` must equal the allowed tenant (`careindent`).
2. `account.username` (email) must end with `@carein.ai`.

Fail either check → **403**, no session issued.

### Session
- A short-lived **HS256 JWT** (8h) signed with `DASHBOARD_SESSION_SECRET`,
  stored in an **HttpOnly** cookie `carein_sso` (`SameSite=Lax`; `Secure` in
  production). The browser cannot read it (XSS-resistant).
- The Microsoft access/ID tokens are **not** persisted or sent to the browser.

### API gate (`requireDashboardAuth`)
Every `/api/*` route (except webhooks, `/api/health`, `/api/retell-tools/*`)
accepts **either**:
- a valid `carein_sso` session cookie (SSO), **or**
- the existing `DASHBOARD_API_TOKEN` bearer token (backward compatible).

**Socket.IO** uses the same model (`socketAuth` in `middleware/auth.js`): it reads
the `carein_sso` cookie from the handshake first, then falls back to the bearer
token. Browser clients should connect with `io(URL, { withCredentials: true })`
so the cookie is sent; token clients keep using
`io(URL, { auth: { token: '<DASHBOARD_API_TOKEN>' } })`.

---

## Environment

Non-secret (set in `backend/.env` for dev, or env vars in prod). Sensible dev
defaults exist in `sso.js`, so dev usually needs none of these:

| Var | Default | Notes |
|-----|---------|-------|
| `DASHBOARD_SSO_CLIENT_ID` | the appId above | CareIN-Dashboard-SSO |
| `DASHBOARD_SSO_TENANT_ID` / `AZURE_TENANT_ID` | careindent | |
| `DASHBOARD_SSO_REDIRECT_URI` | `http://localhost:5103/auth/callback` | **must match an app-registration redirect URI** |
| `DASHBOARD_SSO_ALLOWED_DOMAIN` | `carein.ai` | email domain allow-list |
| `DASHBOARD_POST_LOGIN_URL` | dev: `http://localhost:3005`; prod: `/` | where to land after sign-in |

Secret (Key Vault only): `DASHBOARD_SSO_CLIENT_SECRET`, `DASHBOARD_SESSION_SECRET`.

SPA (Vite): `VITE_API_URL` (e.g. `http://localhost:5103/api`). The auth origin is
derived by stripping `/api`; override with `VITE_AUTH_BASE` if they differ.

> **Dev note:** SSO is "configured" only when both secrets are present. In plain
> local dev (no secrets) `/auth/login` returns **503** and the dashboard falls
> back to the bearer-token gate. To exercise SSO locally, set the two secrets in
> `backend/.env` (pull current values from Key Vault).

---

## Production setup checklist
1. **Add the prod redirect URI** to the app registration (dev-only today):
   ```bash
   az ad app update --id d30ab7dd-5fcf-41d0-97a2-3f7b39bce07f \
     --web-redirect-uris "http://localhost:5103/auth/callback" "https://<prod-host>/auth/callback"
   ```
   (list both — `update` replaces the set), then set `DASHBOARD_SSO_REDIRECT_URI`
   and `DASHBOARD_POST_LOGIN_URL` to the prod values.
2. Ensure the prod backend runs with `NODE_ENV=production` (so the cookie is
   `Secure`) and serves over **HTTPS** (required for a Secure cookie).
3. Confirm SPA and backend are same-site so the cookie flows (same registrable
   domain, or same origin behind a reverse proxy).

## Rotating the client secret
```bash
# New secret value straight into Key Vault (never to disk):
NEW=$(az ad app credential reset --id d30ab7dd-5fcf-41d0-97a2-3f7b39bce07f --append --years 1 --query password -o tsv)
az keyvault secret set --vault-name kv-carein-core --name dashboard-sso-client-secret --value "$NEW" --output none
# Restart the backend to re-read it. Then remove the old credential from the app registration.
```
Rotating `dashboard-session-secret` the same way will invalidate all existing
sessions (everyone must sign in again).

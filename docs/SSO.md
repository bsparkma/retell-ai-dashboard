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

## The external door (Google / email code, S2b)

Two doors issue the same `carein_sso` session cookie:

| Door | Routes | Identity provider | Session `idp` claim |
| --- | --- | --- | --- |
| **Staff** | `/auth/login`, `/auth/callback` | careindent Microsoft Entra | absent (`'entra'` is treated the same) |
| **External** | `/auth/ext/login`, `/auth/ext/callback` | Entra External ID (`<subdomain>.ciamlogin.com`): Google or an email one-time code | `'external'` |

The staff door works exactly as described above. The external door **ships
dark**: until `DASHBOARD_EXTSSO_TENANT_ID` (GUID), `DASHBOARD_EXTSSO_SUBDOMAIN`,
`DASHBOARD_EXTSSO_CLIENT_ID` and the Key Vault secret
`dashboard-extsso-client-secret` (`DASHBOARD_EXTSSO_CLIENT_SECRET`) are all
present and valid, `/auth/ext/*` returns 404 and `GET /auth/providers` returns
`{ microsoft: true, external: false }`. The sign-in screen shows the second
button only when `external` is true. Nothing is defaulted
(`backend/config/extSso.js`).

The secret is a `SECRET_MAP` entry loaded from the vault by managed identity at
boot, like the staff secret. Do **not** also add a Container App `secretref`
for it, because that creates a second, divergent source.

### On the external door, the app_user row is the only gate

`/auth/ext/callback` decides in this order:

1. The state must have been minted by `/auth/ext/login`, and each state can be
   used once.
2. The email must be verified. A sign-in with no email, `email_verified: false`
   or no `sub` is refused.
3. The address must have an **active `app_user` row**. There is no domain rule
   and no bootstrap fallback on this door. No row, or a disabled one, gets the
   "ask your practice administrator to add you" page.
4. The row's binding is checked (below).
5. If all of that passes, the door mints the session with `idp: 'external'` and
   `tid` = the External ID tenant.

The control DB being unreachable returns 503, never a session.

### The binding rule

`app_user.auth_provider` and `app_user.external_sub` (migration
`1789200000000`) record which door owns a row:

| `auth_provider` | Result on the external door |
| --- | --- |
| `'entra'` | **Refused** (409 + an `UNAUTHORIZED` audit row in that tenant). This is a staff Microsoft row. |
| `NULL` | **Bound** on the first external sign-in: `external_sub` is set to the token `sub` and `auth_provider` to `'external'`. The bind is atomic, so two identities racing for one row cannot both win. |
| `'external'` | Allowed only if the token `sub` equals `external_sub`. A different identity claiming the same address is refused (409 + audit). |

`external_sub` is unique. One external identity can own at most one row, so the
same person in a second practice is refused there.

### The two restrictions

1. **No staff takeover.** Migration `1789300000000` marks every `app_user` row
   that existed before this slice as `'entra'`. Its `down()` resets only the
   rows it recorded in `app_user_entra_backfill`. So the external door can bind
   **only a row added after the backfill** whose `auth_provider` is still NULL.
   - Rows created later through `/admin/users` or the Developer Console start
     NULL. Whoever first proves control of that mailbox through Google or an
     email code claims the row.
   - The staff door does not write `auth_provider` in this slice. To pin a
     newly added staff member to Microsoft, set their row to `'entra'`.
2. **No super-admin through the external door.** `resolveUserContext`
   (`backend/middleware/tenantContext.js`) is the one place `isSuperAdmin` is
   computed. It returns false for any session whose `idp` is `'external'`,
   whatever `platform_admin` says.
   - `req.isSuperAdmin`, `requireSuperAdmin()` (so `/api/platform/*` returns
     403) and `/auth/me` all inherit this.
   - The practice role from the row still applies.
   - The staff door is unaffected.

The staff bootstrap fallback (`ROLES_BOOTSTRAP_FALLBACK`) applies to staff
sessions only. An external session with no row resolves role null.

These rules are pinned by `backend/routes/authExternal.test.js`.

### App registration (External ID tenant)

- Redirect URI: `https://<dashboard host>/auth/ext/callback`. This is derived
  from the host in `DASHBOARD_SSO_REDIRECT_URI`, so there is no separate
  setting.
- Emit the `email` optional claim in the ID token. Without it, every sign-in
  gets the "couldn't confirm your email" page.

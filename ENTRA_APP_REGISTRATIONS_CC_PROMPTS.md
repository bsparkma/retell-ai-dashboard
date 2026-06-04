# Entra App Registrations + Key Vault — Claude Code Prompt Pack

_Goal: give the on-prem CareIN backend/connector a clean Entra identity and move secrets out of `.env` into Azure Key Vault. Paste each prompt into Claude Code in order. Run them one at a time and verify before moving on._

---

## Honest sequencing notes (read first)

- **On-prem = no managed identity.** Services run on the office Windows workstation, not in Azure, so they authenticate with a **certificate-based app registration** (confidential client). Certificate > client secret for HIPAA-adjacent work.
- **Do Key Vault before wiring code.** No point pointing code at a vault that has no secrets / no access policy.
- **Secrets never go through CC or the repo.** CC writes code + a *placeholder* loader script; **you** run the real `az keyvault secret set` commands. This honors the repo rule: _never read/modify `.env`, never commit credentials._
- **Least privilege.** The app registration gets `get`/`list` on Key Vault secrets only — nothing more — unless you add staff SSO (Prompt 4).
- **Tenant:** `careindent.onmicrosoft.com`  ·  **Org:** CareIN Dental LLC.

**Preconditions:** Azure CLI installed (`az version`), an Azure subscription linked to the `careindent` tenant, and you signed in as a Global Admin (`admin@carein.ai`).

---

## Prompt 0 — Verify Azure CLI context

```
Verify my Azure CLI environment is ready for Entra/Azure work, without changing anything.

1. Run `az version` and confirm the CLI and azure-cli-core are installed.
2. Run `az login --tenant careindent.onmicrosoft.com --allow-no-subscriptions` and let me complete the browser sign-in as admin@carein.ai.
3. Run `az account show` and `az account list -o table`. Confirm the active tenant is careindent and report whether an Azure subscription is linked.
4. If NO subscription is linked, STOP and tell me — I need to create/link an Azure subscription under this tenant before Key Vault (Prompt 2). Do not attempt to create a subscription.
5. Print a short summary: CLI version, tenant ID, subscription ID (or "none"), signed-in user.

Do not create, modify, or delete any Azure resources in this step.
```

---

## Prompt 1 — Create the certificate-based app registration

```
Create an Entra ID app registration for the on-prem CareIN backend/connector to authenticate to Azure (Key Vault). Use certificate auth, not a client secret. Tenant: careindent.onmicrosoft.com.

Requirements:
1. Generate a self-signed certificate locally for app auth (e.g. via `az ad app create` cert flow or openssl). Store the .pfx/.key OUTSIDE the repo (e.g. C:\Users\beau\secrets\carein-connector\) and add that path pattern to .gitignore if anything cert-related could land in the repo. Never write the cert, thumbprint, or private key into any committed file.
2. Create the app registration named "CareIN-Connector-OnPrem" as a single-tenant confidential client (no redirect URI needed for client-credentials).
3. Upload the public cert to the app registration.
4. Create the service principal for the app.
5. Output and save to a NEW gitignored file `.local/entra-app.json` (create `.local/` and gitignore it): appId (client ID), tenantId, app objectId, sp objectId, cert thumbprint, and the local cert path. These are non-secret identifiers EXCEPT treat the cert + thumbprint location as sensitive — store the thumbprint reference but never the private key.
6. Print the appId and tenantId so I can confirm.

Constraints: do not grant any API permissions yet. Do not create a client secret. Confirm each az command's output before proceeding.
```

---

## Prompt 2 — Create Key Vault, grant access, and stage secrets (placeholders)

```
Create an Azure Key Vault for CareIN secrets and grant the CareIN-Connector-OnPrem app read access. Then generate a PLACEHOLDER script for me to populate secrets — do not put any real secret values in any file.

1. Confirm the active subscription (from Prompt 0). If none, stop.
2. Create a resource group `rg-carein-core` (region: choose one close to me, e.g. southcentralus — ask if unsure) if it doesn't exist.
3. Create a Key Vault named `kv-carein-core` (or append a short suffix if the name is taken) with RBAC authorization enabled and soft-delete on.
4. Grant the app registration's service principal (sp objectId from .local/entra-app.json) the "Key Vault Secrets User" role scoped to this vault. Grant my own admin@carein.ai user "Key Vault Secrets Officer" so I can set secrets.
5. Create a gitignored script `.local/set-keyvault-secrets.ps1` that contains `az keyvault secret set` commands with PLACEHOLDER values (e.g. <OPEN_DENTAL_DB_PASSWORD>) for these secret names — infer the full set from the backend config keys WITHOUT reading the .env file contents (read only variable NAMES from config/loader code, never values):
   - open-dental-db-host, open-dental-db-user, open-dental-db-password, open-dental-db-name
   - retell-api-key
   - stedi-api-key
   - mango-voip-key (if present)
   - any other externally-supplied credential the backend reads from process.env
   Use kebab-case secret names. Add a comment header reminding me these are placeholders and the file must never be committed.
6. Print the vault URI and the list of secret names you created placeholders for.

Do NOT read or echo any .env values. Do NOT commit .local/. Confirm RBAC role assignments succeeded.
```

> After this prompt: open `.local/set-keyvault-secrets.ps1`, replace placeholders with your real values, run it yourself, then delete or keep it locally (gitignored). CC should never see the real values.

---

## Prompt 3 — Wire the backend to load secrets from Key Vault

```
Update the CareIN backend (backend/server.js, Express, CommonJS) to load secrets from Azure Key Vault at startup using the CareIN-Connector-OnPrem app's certificate, with a local-dev fallback to .env. Do not read or print secret values in logs.

Requirements:
1. Add deps: @azure/identity and @azure/keyvault-secrets.
2. Create backend/config/secrets.js (CommonJS) that:
   - In production (NODE_ENV=production): authenticates with ClientCertificateCredential using appId + tenantId + cert path from environment-level config (read appId/tenantId/cert path from machine env vars or .local/entra-app.json path, NOT hardcoded), then fetches each secret from vault `kv-carein-core` by its kebab-case name and maps it to the existing process.env-style keys the app already uses.
   - In non-production: fall back to existing .env / process.env so local dev is unchanged.
   - Caches secrets in memory after first load; never writes them to disk or logs. Mask everything in any debug output.
3. Refactor the startup path so server.js awaits secret loading before it binds the port (5003 prod / 5103 dev) or opens the Open Dental connector.
4. Keep the existing connector pattern intact — still go through the connector service, still scope OD queries by ClinicNum. Don't change query logic.
5. No `any`-equivalent loose typing; this is CommonJS so use JSDoc types where helpful. No SELECT *. Follow repo conventions.
6. Add a short section to M365_EMAIL_SETUP.md or a new docs/SECRETS.md explaining the prod vs dev secret flow and how to rotate a secret in Key Vault.

Verify the app still starts in dev (using .env) without contacting Azure. Do not commit any secret, cert, thumbprint, or .local/ content.
```

---

## Prompt 4 — (Optional) Staff SSO into the dashboard, restricted to carein.ai

```
Add Microsoft Entra single sign-on so only carein.ai accounts can sign into the CareIN dashboard. Use MSAL Node auth-code flow on the Express backend; keep new-dashboard (React 19 + wouter) as the SPA.

1. Create a SECOND app registration "CareIN-Dashboard-SSO" (single-tenant) with a web redirect URI for the backend callback (dev: http://localhost:5103/auth/callback, prod: the LAN/prod URL). Use a client secret stored in Key Vault (secret name dashboard-sso-client-secret) — not in .env.
2. Add Microsoft Graph delegated permission User.Read (admin consent).
3. Implement /auth/login, /auth/callback, /auth/logout on the backend with @azure/msal-node; issue a session/JWT after successful sign-in; reject any token whose tenant != careindent.
4. Gate the dashboard API routes behind the session; add a sign-in screen in new-dashboard that redirects to /auth/login.
5. TypeScript strict in new-dashboard, no `any` — narrow unknowns. Document the flow in docs/SSO.md.

Do not hardcode the client secret anywhere; pull it from Key Vault via the existing secrets.js loader.
```

---

## Prompt 5 — Verification & secret hygiene

```
Run a verification and secret-hygiene pass on the CareIN repo and the Azure setup.

1. Token + secret check (prod-style, run locally with the cert available): write a one-off script that uses ClientCertificateCredential to fetch ONE non-sensitive test secret from kv-carein-core and prints only "OK + secret name + length" — never the value. Delete the script after.
2. Confirm `az role assignment list` shows the connector SP has only "Key Vault Secrets User" on the vault and nothing broader.
3. Grep the repo for accidentally committed secrets, cert files, thumbprints, or .local/ contents; confirm .gitignore covers .local/, *.pfx, *.pem, *.key, and any cert directory. Report anything risky.
4. Confirm MFA / Security defaults are on for the tenant (note it if you can't check via CLI and tell me to verify in the admin center).
5. Print a final checklist of what's done and what's left.

Make no changes beyond .gitignore fixes; report everything else for me to decide.
```

---

## After the pack

- Rotate any secret by running `az keyvault secret set` again — `secrets.js` picks up the new version on next restart (or add a refresh interval later).
- When you eventually move services into Azure, swap `ClientCertificateCredential` for `ManagedIdentityCredential` — one-line change in `secrets.js`, no app-registration churn.

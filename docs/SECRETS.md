# Secrets & Configuration

The CareIN backend loads its credentials two different ways depending on the
environment. The code that does this lives in
[`backend/config/secrets.js`](../backend/config/secrets.js) and is invoked at
the very top of `bootstrap()` in
[`backend/server.js`](../backend/server.js) — **before** any router, the Open
Dental connector, Retell, or Mango config is constructed.

> Secret **values** are never logged, printed, or written to disk. Optional
> debug output (`SECRETS_DEBUG=true`) only ever shows a masked
> `***(N chars)` placeholder.

---

## Production vs. Development flow

### Development (`NODE_ENV` ≠ `production`)
- **No Azure calls.** `secrets.js` does not even load the Azure SDKs.
- Configuration comes from `backend/.env` (loaded by `dotenv` in `server.js`)
  exactly as it always has. Local dev is unchanged and works offline.

### Production (`NODE_ENV=production`)
1. `secrets.js` reads the app-registration identity (see **Required config**).
2. It loads the **CareIN-Connector-OnPrem** certificate from the Windows
   certificate store **`LocalMachine\My` by thumbprint** and exports it to an
   in-memory PEM (the `.pfx` file + password on disk are **not** used).
3. It authenticates to Azure Key Vault `kv-carein-core` with
   `ClientCertificateCredential` (client-credentials, certificate auth — no
   client secret).
4. Each secret is fetched by its **kebab-case** name and written onto the
   `process.env` key the app already reads. Secrets are cached in memory for
   the life of the process.
5. **Missing secrets are optional.** If a secret returns `404` (e.g. it hasn't
   been created yet, like `stedi-api-key`), it is skipped and startup
   continues. Only an auth/network failure (can't reach the vault at all) aborts
   startup — by design, so the app never runs half-configured against a broken
   vault.

```
NODE_ENV=production
        │
        ▼
 LocalMachine\My  ──(export PEM in memory, by thumbprint)──►  ClientCertificateCredential
        │                                                              │
        │                                                              ▼
        └──────────────────────────────►  Key Vault: kv-carein-core  ──► process.env.*
```

---

## Secret name → env var mapping

Defined in `SECRET_MAP` in `backend/config/secrets.js`. Vault names are
kebab-case; the app reads the env keys.

| Key Vault secret (kebab-case) | process.env key            | Notes |
|-------------------------------|----------------------------|-------|
| `od-api-key`                  | `OD_API_KEY`                | OD API legacy/single key — **optional**, skipped if absent |
| `opendental-developer-key`    | `OPENDENTAL_DEVELOPER_KEY`  | ODFHIR developer key |
| `opendental-customer-key`     | `OPENDENTAL_CUSTOMER_KEY`   | ODFHIR customer key |
| `retell-api-key`              | `RETELL_API_KEY`            | Retell AI |
| `mango-username`              | `MANGO_USERNAME`            | Mango Voice portal |
| `mango-password`              | `MANGO_PASSWORD`            | Mango Voice portal |
| `deepgram-api-key`            | `DEEPGRAM_API_KEY`          | Transcription |
| `openai-api-key`              | `OPENAI_API_KEY`            | Call analysis |
| `od-connector-api-key`        | `OD_CONNECTOR_API_KEY`      | On-prem connector callback |
| `control-db-url`              | `CONTROL_DB_URL`            | `carein_control` Postgres connection string (control plane + migrations). **Optional** until provisioned; skipped if absent |
| `stedi-api-key`               | `STEDI_API_KEY`             | **Optional** — not yet wired; skipped if absent |

### Non-secret Open Dental config (NOT in Key Vault)

Open Dental runs in **API mode** and is reached over HTTP — never direct MySQL.
These values are plain configuration and come from `backend/.env` /
`process.env` in **both dev and prod**; they must **not** be placed in Key Vault:

| env var | Example | Meaning |
|---------|---------|---------|
| `OPENDENTAL_INTEGRATION_MODE` | `api` | Selects API mode; anything but a direct-DB mode skips MySQL entirely |
| `OPENDENTAL_API_BASE_URL` | `https://api.opendental.com/api/v1` | REST base URL for the OD HTTP API |
| `OPENDENTAL_IMAGES_PATH` | `…/OpenDentImages` | Local image/document storage path |

`backend/config/openDental.js` only parses a `mysql://` connection string when a
direct-DB mode (`db`/`database`/`mysql`/`direct`) is explicitly configured, so
`OPENDENTAL_API_BASE_URL` is never mistaken for a database URL.

To add a new secret: create it in the vault, then add one `{ secretName, envKey }`
row to `SECRET_MAP`. No other code changes are needed.

### Dynamic per-tenant secrets (data-plane DB connection strings)

The fixed `SECRET_MAP` above is loaded onto `process.env` once at startup. But
**per-tenant** secrets can't be a fixed list — each tenant has its own
data-plane database with its own connection string. These are resolved **by
name, on demand** via `secrets.getSecretValue(secretName)` (added in Slice 3),
not through the startup batch loader:

| Environment | How `getSecretValue('tenant-carein-db-url')` resolves |
|-------------|-------------------------------------------------------|
| **Development** (`NODE_ENV` ≠ `production`) | Reads the env var derived from the secret name (kebab → `SCREAMING_SNAKE`): `tenant-carein-db-url` → **`TENANT_CAREIN_DB_URL`** from `backend/.env`. No Azure calls. |
| **Production** (`NODE_ENV=production`) | Fetches the secret **by that exact name** from `kv-carein-core` using the same connector-certificate auth as the batch loader. Missing (404) → `null`. |

The control-plane registry stores only the **secret name**
(`tenant_database.kv_conn_secret`), never the connection string itself.
`backend/platform/tenantDb.js` looks up that name for `req.tenant.id`, calls
`getSecretValue`, and builds a per-tenant pool — so a connection string lives
only in Key Vault (prod) or `backend/.env` (dev), and a request can only reach
its own tenant's database. See [DATA_PLANE.md](./DATA_PLANE.md).

> Provisioning a tenant's DB secret uses a gitignored placeholder script, e.g.
> `.local/set-tenant-carein-db-secret.ps1` — same pattern as
> `set-keyvault-secrets.ps1`, with no real values in the repo.

---

## Required config in production

`secrets.js` reads these from **machine environment variables first**, falling
back to the gitignored `.local/entra-app.json` (a dev convenience — not present
on the prod host unless you copy it). Nothing is hardcoded.

| Env var | Falls back to | Meaning |
|---------|---------------|---------|
| `AZURE_CLIENT_ID` | `appId` in entra-app.json | App registration client ID |
| `AZURE_TENANT_ID` | `tenantId` | Entra tenant ID |
| `AZURE_CLIENT_CERTIFICATE_THUMBPRINT` | `auth.certThumbprint` | Cert thumbprint to find in the store |
| `AZURE_CLIENT_CERTIFICATE_STORE_LOCATION` | `LocalMachine` (default) | `LocalMachine` or `CurrentUser` |
| `AZURE_KEY_VAULT_NAME` | `kv-carein-core` (default) | Vault name |

**Host prerequisites (production connector box):**
- **PowerShell 7+** (`pwsh`) on `PATH` — used to export the cert from the store
  (`RSACertificateExtensions.ExportPkcs8PrivateKey`). Windows PowerShell 5.1 is
  attempted as a fallback but does not support PKCS#8 export.
- The connector cert imported into **`LocalMachine\My`** with an **exportable**
  private key, and the service account granted read access to that key.
- The app's service principal holds **Key Vault Secrets User** on the vault
  (read-only) — already granted.

---

## Rotating a secret in Key Vault

Rotating a value does **not** require a code change or redeploy — just set a new
version and restart the backend so it re-reads on next boot.

```powershell
# 1) Sign in as a Secrets Officer (e.g. admin@carein.ai)
az login

# 2) Set a new version of the secret (creates a new version, keeps history)
az keyvault secret set --vault-name kv-carein-core `
  --name retell-api-key --value "<NEW_VALUE>" --output none

# 3) (optional) Confirm the new version exists — shows metadata, not the value
az keyvault secret show --vault-name kv-carein-core --name retell-api-key `
  --query "{name:name, updated:attributes.updated, version:id}" -o json

# 4) Restart the backend so it loads the new value (PM2 example)
pm2 restart carein-backend
```

The loader always fetches the **latest** version of each secret at startup, so a
restart is all that's needed to pick up a rotation.

### Rotating the connector certificate
When the cert nears expiry (the credential registered in Entra expires
**2027-06-02** due to tenant credential-lifetime policy):
1. Generate a new self-signed cert and import it into `LocalMachine\My`
   (exportable key).
2. Upload its **public** cert to the CareIN-Connector-OnPrem app registration
   (`az ad app credential reset --id <appId> --cert @<public.pem> --append`).
3. Update `AZURE_CLIENT_CERTIFICATE_THUMBPRINT` (or `.local/entra-app.json`) to
   the new thumbprint and restart.
4. Once verified, remove the old credential from the app registration.

---

## What must never be committed
- `.env` files (gitignored)
- `.local/` — including `entra-app.json` and `set-keyvault-secrets.ps1`
- Any `.pfx` / `.pem` / `.cer` / `.key` / certificate or thumbprint material

Real secret values live only in Key Vault (prod) and `backend/.env` (dev).

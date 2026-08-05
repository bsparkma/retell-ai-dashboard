# TC Module — Legacy Data Importer & Blob Storage (Slice 2)

One-shot migration of the legacy TC-app pilot data (JSON files + images)
into the `tc_*` tables (Slice 1 schema) and Azure Blob. Ships dark; nothing
user-facing. Companion docs: `TC_SCHEMA.md` (schema + field mapping).

## The importer

```
cd backend
node scripts/tc-import.cjs --data-dir "C:\path\to\TC-app\server\data"            # DRY-RUN (default)
node scripts/tc-import.cjs --data-dir ... --execute --blob-account <account>     # real import
```

- TypeScript core: `new-dashboard/server/tc-import/` (runs under tsx; the
  launcher follows the backend migrate-script convention).
- ALL legacy→contract mapping lives in `new-dashboard/shared/tc/legacy.ts`.
  The importer only orchestrates: load → plan → reconcile → (execute).
- **Dry-run is the default.** `--execute` needs `TC_IMPORT_DB_URL` in the
  environment (Key Vault → session; never printed, never committed) and an
  `az login` session for Blob auth.
- **Idempotent on legacy ids**: a record whose `legacy_id` already exists is
  skipped — re-runs converge, never duplicate (proven: second staging run
  inserted 0 rows, uploaded 0 blobs).
- **Reconciliation balance is enforced**: per entity,
  `source = imported + skipped + errors` or the run fails loudly.
- Report output identifies records by legacy id only — no PHI in output.
- Office stamping: `location 'riley'` → `valley`; everything else `roland`
  (`--default-office` overrides). Communications/simulations inherit their
  linked case's office. Library sections seed BOTH offices (legacy config
  was shared practice-wide). Templates land on the default office
  (`legacy_id` is unique, so one row per template — see open question in the
  Slice 2 PR).
- Exclusions: `migrations.json`, `practice.json`, `*.backup-*`,
  `handoffs.json`; `users.json` is consumed only for `tc_legacy_user_map`
  (pinHash is structurally stripped by the mapper schema). Users without a
  platform email are skipped until provided via `--user-map <json>`
  (`{ "<legacyUserId>": "<platformEmail>" }`).

## Blob storage (platform pattern)

First Blob storage on the platform — built as the pattern, not a TC one-off
(EOB PDFs for RCM reuse it). Helper: `backend/services/blobStore.js`
(+ `.d.ts` for TS consumers).

- **Auth is AAD-only** (`DefaultAzureCredential`: managed identity in Azure,
  `az login` on a workstation). Accounts are provisioned with shared-key auth
  DISABLED — no SAS tokens, no account keys, ever.
- **Containers are private**; public blob access disabled account-wide.
  Bytes are served only through an entitlement-checked backend proxy
  (Slice 3/4).
- **Key convention** (multi-tenant-safe, never legacy filenames — they embed
  patient names): `tenant/<tenantSlug>/<module>/<entity>/<uuid>.<ext>`
  e.g. `tenant/carein/tc/gallery/6f9c….jpg`. Rows store KEYS, never URLs.

### Staging resources (rg-carein-staging, southcentralus)

| Resource | Value |
|---|---|
| Storage account | `stcareinstaging` (Standard_LRS, StorageV2, TLS1.2, HTTPS-only, shared-key OFF, public blob access OFF, blob+container soft delete 14d) |
| Container | `tc-media` (private) |
| RBAC | `Storage Blob Data Contributor` on the container → `id-carein-staging` (backend MI, groundwork for the Slice 3/4 serving proxy) and the admin workstation identity (importer) |

The PROD storage account is explicitly out of scope for Slice 2 — it is
created on the prod promotion path at cutover, and the prod import runs
there with fresh data.

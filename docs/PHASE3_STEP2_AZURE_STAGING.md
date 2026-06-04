# Phase 3 Step 2 — Azure STAGING Foundation Runbook

> TASK: Phase 3 Step 2 — stand up the Azure STAGING foundation per docs/PHASE3_STEP2_AZURE_STAGING.md
> (I'll add that doc to the repo on this branch first; read it fully before doing anything).

## Hard constraints

- Staging ONLY. Do not touch the live LAN prod (10.20.30.160 / dashboard.carein.ai), the PM2
  backend :5003, dev :5103, Caddy, or carein-local-pg.
- This step CREATES BILLABLE Azure resources. Before creating ANYTHING, do Step 0 discovery and
  STOP for my go: `az account show`, `az group list`, `az keyvault list` (find kv-carein-core +
  its region), `az acr list`. Report the resolved subscription, region, and which names already
  exist. Confirm the §0 defaults with me (region, shared-ACR, Front-Door-deferred, B1ms PG,
  synthetic data, api-mode OD) before provisioning.
- Apply the §7 cost guardrails AS YOU PROVISION: $50/mo budget + alerts on rg-carein-staging,
  B1ms / no-HA / no-geo-backup Postgres, min-replicas-0 on both Container Apps, no Front Door.

## Order of work (follow the runbook)

1. §1 provision core (RG, shared ACR, Log Analytics, Container Apps env, Postgres B1ms, Key Vault,
   user-assigned managed identity + Key Vault Secrets User role).
2. §2 app deltas: add the env-gated ManagedIdentityCredential branch to backend/scripts/secrets.js
   (leave local .env + on-prem cert paths intact); `az acr build` the carein-backend and
   carein-caddy images (SPA built with VITE_API_URL=/api); deploy ca-carein-backend (internal) +
   ca-carein-caddy (external, staging.carein.ai, managed cert, IP-allowlist) with secrets as
   Key Vault refs via the managed identity (no plaintext secrets).
3. §3 DB bring-up: carein_owner + carein_app roles, control migrate+seed (placeholder
   CAREIN_SEED_CONNECTOR_URL), provision carein_t_carein, per-tenant migrate via the owner
   override; conn strings (carein_app role) into kv-carein-staging; prove audit_log UPDATE/DELETE
   is denied at the DB.
4. §4 add the https://staging.carein.ai/auth/callback redirect URI to the CareIN-Dashboard-SSO app
   reg (additive only).
5. §5 run the acceptance checklist — INCLUDING the clinicNum-not-in-tenant 403 and the
   scale-to-zero + non-allowlisted-IP-refused checks. Capture outputs.

DEFER §6 (VNet + private endpoints) until §5 is green — do it as a separate follow-up, then
re-verify §5 over the private path.

## Deliverables

DELIVER: the created resource list (names/SKUs/region), the secrets.js diff, the two image tags,
the acceptance checklist results, and the running staging.carein.ai URL. Commit code changes on
the branch with imperative messages. Do NOT merge to develop (Step 3 sets up the branch model).
Report back at the Step 0 stop-point first.

# Phase 3 · Step 3 — CI/CD Pipeline (staging) — runbook

Stand up GitHub Actions so a push to `develop` builds, tests, migrates, and deploys to the Azure
staging environment from Step 2 — repeatable, secretless, and forward-compatible with the §6
private-networking hardening. Prod deploy is stubbed only (Step 5). Staging only — the LAN prod box
(`main` + PM2 on 10.20.30.160) is NOT in this pipeline and is not touched.

## Repo facts
- Remote: origin = github.com/bsparkma/retell-ai-dashboard. Has main, claude/elegant-montalcini
  (parked scheduling engine), v0-remix-integration.
- feature/containerize is LOCAL ONLY — holds the Dockerfiles, the secrets.js managed-identity change,
  deploy/container/*, and the Step 2 staging notes.
- No develop branch, no .github/workflows yet.
- Staging infra: RG rg-carein-staging, ACR acrcareincore (in rg-carein-core), Container Apps env
  cae-carein-staging, apps ca-carein-backend / ca-carein-caddy, psql-carein-staging, kv-carein-staging,
  identity id-carein-staging (clientId d4647517…).

## 1. Branch & promotion model
feature/* --PR--> develop --(CI auto)--> Azure STAGING (staging.carein.ai)
develop --PR--> main --(CI, MANUAL approval)--> Azure PROD  [Step 5 — stubbed now]
- develop → staging, automatic. The point of Step 3.
- main → prod is a documented placeholder until Azure prod exists (Step 5). Do NOT wire the prod job
  to anything live, never to the LAN box. main stays the LAN-prod source via the existing manual
  two-folder/PM2 flow until the Step 5 cutover.

## 2. Prerequisite: bootstrap develop (do first)
- Create develop from main, merge feature/containerize into develop, push develop to origin. Safe:
  develop only deploys to STAGING (blast radius = staging); main/LAN-prod untouched.
- This makes §6, the module-entitlement slice, and Slice 4b flow through the pipeline as PRs onto
  develop — §6 becomes the pipeline's first real end-to-end test.
- The containerize work has only existed locally; pushing develop finally gets it to GitHub so Actions
  can build it.

## 3. CI → Azure auth: OIDC federated credentials (secretless)
- Entra app registration github-carein-deploy + service principal.
- Federated credential scoped to repo:bsparkma/retell-ai-dashboard for the develop branch and/or a
  GitHub Environment named staging.
- Least-privilege roles: AcrPush on acrcareincore; Container Apps deploy on rg-carein-staging (start
  with Contributor scoped to the RG, tighten later); Key Vault Secrets User on kv-carein-staging.
- Store AZURE_CLIENT_ID, AZURE_TENANT_ID (fb0713b3-…), AZURE_SUBSCRIPTION_ID (9b09e117-…) as GitHub
  repo variables (not secrets — with OIDC they aren't sensitive). Workflow uses azure/login@v2 with
  permissions: id-token: write.

## 4. Migrations in-pipeline = an Azure Container Apps Job (key design call)
Pre-§6, psql-carein-staging is reachable only from Beau's allowlisted IP + Azure services — a
GitHub-hosted runner (dynamic, non-Azure IP) cannot reach it. After §6 it's VNet-only. Both → same
answer:
- Define a Container Apps Job caj-carein-migrate in cae-carein-staging, using the carein-backend image
  + the id-carein-staging managed identity. Runs migrations from inside Azure: reaches psql now
  (Azure-services rule) and after §6 (VNet) with no rework.
- Job runs: control migrations (npm run migrate, CONTROL_DB_URL = owner) then per-tenant
  (node scripts/migrate-tenant.js up --tenant <slug> with the owner override, looping
  registry.listTenants(); npm mangles --tenant, so call node directly).
- KV addition required: migrations run as carein_owner, but today only the carein_app runtime conn
  strings are in kv-carein-staging. Add owner conn-string secrets (staging-control-db-owner-url,
  staging-tenant-<slug>-db-owner-url) readable by the job's identity, separate from the runtime
  carein_app secrets.
- Pipeline triggers the job (az containerapp job start) and polls to completion; fails the deploy if
  migrations fail.
- Fallback (NOT recommended): a step that opens a temp psql firewall rule for the runner IP, migrates,
  then removes it. Works now but breaks after §6 → rework. Use the Job.

## 5. The workflow — .github/workflows/staging.yml (on push to develop)
Jobs in order (later needs: earlier; concurrency cancels superseded runs):
1. build-test (gate): checkout; install; new-dashboard → npm run check (tsc) + npm run test (vitest);
   backend tests + node --check + the spine smoke test (use the exact commands validated in Step 2 —
   37 backend tests + smoke-spine 12/12). Red here stops everything.
2. publish: azure/login@v2 (OIDC) → az acr build -r acrcareincore to build BOTH images
   (carein-backend, carein-caddy) from their Dockerfiles, tagged :<git-sha> and :staging. Building via
   az acr build means the real SPA+backend build happens in ACR from the same Dockerfiles already
   validated — no need to re-encode build steps in YAML.
3. migrate: az containerapp job start --name caj-carein-migrate … and poll for success.
4. deploy: az containerapp update --image acrcareincore.azurecr.io/carein-backend:<sha> for
   ca-carein-backend and the same for ca-carein-caddy. New revision goes live; scale-to-zero unchanged.

## 6. Rollback
- Container Apps keeps revisions → roll back = reactivate the previous revision
  (az containerapp revision …) or re-deploy the previous :<sha> tag. Document the one-liner in
  docs/CICD.md. A failed migration must block the deploy job so a bad image never goes live with an
  unmigrated DB.

## 7. Prod leg (Step 5 — placeholder only)
- Add a disabled main → prod job skeleton with a GitHub Environment production that has a required
  reviewer (manual approval) and a down-migration rollback note — but do NOT point it at any live
  resource until Azure prod exists in Step 5. Not the LAN box, ever.

## 8. Acceptance
1. No-op change on develop → workflow runs build-test → publish → migrate → deploy all green, and
   staging.carein.ai serves a new revision.
2. A change that breaks a test → build-test fails and nothing deploys (gate proven).
3. The migrate job runs control + tenant migrations against psql-carein-staging and reports success
   (idempotent no-op on an already-migrated DB).
4. Rollback drill: reactivate the previous revision and confirm staging serves it.
5. OIDC login uses no stored Azure secret (federated credential only).

## 9. Cost / ops
- az acr build minutes + Container Apps Job runs are cheap/usage-based; scale-to-zero on the apps
  unaffected. No new always-on cost beyond Step 2 (psql remains the line to stop when idle).

## 10. What this unblocks
develop→staging automated → §6 (private networking) and the parked spine slices (module-entitlement,
Slice 4b Retell) ride the pipeline as PRs. Step 4 = point the staging tenant at the real OD cloud API.
Step 5 = stand up Azure prod, activate the main→prod job + manual gate, cut dashboard.carein.ai DNS
off the LAN box.

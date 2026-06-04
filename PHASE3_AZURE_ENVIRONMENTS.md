# Phase 3 — Azure Hosting, Environments & Scale

_Drafted 2026-06-04. Get CareIN off the local workstation into Azure, with dev/staging/prod
separation so features can be built and tested without touching daily office use, and multi-office
data isolation that scales. Builds on `PLATFORM_ARCHITECTURE.md` (Phase 3) and the Phase 1 spine._

## Why now
The team is live — but on your personal workstation, which means (a) the office depends on your
machine + the 3am reboot + your logon, and (b) any local change risks the live system. Moving prod
to Azure and standing up real environments fixes both. This is the highest-leverage infra move
available right now.

## Decisions locked in
- **OD reach:** API-first (OD cloud API via your Developer account + per-office Customer keys), with
  the on-prem connector agent as a Phase-2 fallback for offices/ops the API can't cover.
- **Data isolation:** per-tenant database (already built) — Azure just hosts it at scale.
- **Environments:** local dev → Azure staging → Azure prod, with a promotion pipeline.
- **Staging data:** real-but-prod-controlled, with a masked-refresh option; switch to masked the
  moment a contractor or another office's patients are involved.

---

## 1. Target Azure architecture (per environment)

```
 carein.ai users ──▶ Azure Front Door (WAF, TLS, custom domain)
                        │   dashboard.carein.ai (prod) · staging.carein.ai (staging)
                        ▼
                  Azure Container Apps  ──── built SPA (static) + Express API (container)
                        │  managed identity ▼
        ┌───────────────┼───────────────────────────────┐
        ▼               ▼                                 ▼
  Azure Postgres   Azure Key Vault                  Log Analytics /
  Flexible Server  (per-env secrets,                App Insights
  DB-per-tenant    managed-identity access)
  (control + t_*)
        │
        └──▶ each tenant's Open Dental via api.opendental.com
             (Developer key + per-office Customer key from Key Vault)
             [Phase 2 fallback: on-prem connector agent → Azure Relay tunnel]
```

- **Compute:** **Azure Container Apps** — containerize the Express backend; serve the built SPA from
  the same origin (or Azure Static Web Apps fronted by the same Front Door). Container Apps scales to
  zero (great for staging cost) and is far lighter than AKS.
- **Identity:** **managed identity** for cloud compute → Key Vault and Postgres. This *drops the
  certificate hassle* for the cloud parts (the cert-based app reg stays only for any on-prem
  connector agents). One-line change in `secrets.js`: `ClientCertificateCredential` →
  `ManagedIdentityCredential`.
- **Data:** **Azure Postgres Flexible Server**, database-per-tenant. One server per environment
  (`pg-carein-prod`, `pg-carein-staging`), Burstable B1ms to start, shard to more servers as tenant
  count grows. Control DB + per-tenant DBs exactly as built locally.
- **Secrets:** Key Vault per env (`kv-carein-prod`, `kv-carein-staging`) — managed-identity access,
  no certs in the cloud.
- **Ingress:** Front Door (WAF, TLS, custom domains). `dashboard.carein.ai` → prod;
  `staging.carein.ai` → staging (locked down — IP-allowlist your office/your IP, still behind SSO).
- **Networking:** private endpoints for Postgres + Key Vault, VNet integration, no public DB.
- **Observability:** App Insights / Log Analytics per env (PHI stays out of logs — already enforced).

---

## 2. Environments & promotion flow

| Env | Where | Data | Deploys from | URL |
|-----|-------|------|--------------|-----|
| **Local dev** | your machine (Docker Postgres) | **synthetic/seeded only** | feature branches | localhost |
| **Staging** | Azure | real-but-prod-controlled (masked option) | `develop` | staging.carein.ai (locked down) |
| **Prod** | Azure | real PHI | `main` | dashboard.carein.ai |

**Branch / promotion model:**
`feature/*` → PR → merge to **`develop`** → CI auto-deploys to **staging** → you validate →
PR `develop`→**`main`** → CI deploys to **prod** (with a manual approval gate).

This is the core win: **you develop locally, push to staging, validate against real-shaped data,
then promote to prod — daily office use is never in the blast radius of in-progress work.**

**CI/CD (GitHub Actions):** on push → build container, run `tsc --noEmit` + `node --check` + tests →
run DB migrations as a deploy step (control + per-tenant) → deploy to the target env. Prod gets a
required manual approval. Roll back = redeploy the previous image + (if needed) a down-migration.

---

## 3. Data strategy (3-tier, HIPAA-aware)

- **Local dev:** synthetic/seeded data ONLY. Never casually put real PHI on a laptop. (Use the
  existing seed + a fake-data generator.)
- **Staging:** you chose a real-data mirror. Acceptable **for your own practices' data** *if staging
  carries prod-grade controls* (encryption at rest/in transit, private networking, restricted
  access, audit, never public). Provide a **`refresh-staging` job** that copies prod → staging and
  can **mask** PHI fields (names, DOB, member IDs) on the way. Default to masked; use full-PHI only
  to reproduce a specific real-data bug, and switch to masked permanently once a contractor or
  another office's patients are in scope.
- **Prod:** real PHI, full controls, BAA chain (Azure covered; OD/Retell/Stedi BAAs as applicable).

---

## 4. Multi-office isolation at scale (already built — Azure makes it real)
Per-tenant DB + tenant registry + fail-closed tenant context = "offices can't see each other's data"
is **structurally enforced**, not policy. Azure adds: provisioning automation creates a new Postgres
DB per office, connection string (as the `carein_app` role) into Key Vault, registry row, OD API
keys per tenant. Onboarding office #2..#N = run `provisionTenant` against the Azure control DB.

---

## 5. Sequenced roadmap (honest — staging FIRST, cut prod over LAST)

| Step | What | Why this order |
|------|------|----------------|
| **0** | Keep current LAN prod running as-is | It works; don't rush the cutover. |
| **1** | **Containerize** the app (Dockerfile for the Express backend; build the SPA). Run the container locally to prove parity with the nodemon setup. | Everything cloud depends on a working image. |
| **2** | Stand up the **Azure STAGING foundation**: Container Apps env, Postgres Flexible Server, Key Vault, Front Door, managed identity, `staging.carein.ai`. | Shake out every cloud gotcha on staging, where breaking it affects no one. |
| **3** | **CI/CD pipeline** (GitHub Actions) → deploy to staging from `develop`, migrations in-pipeline. | Repeatable deploys before prod exists. |
| **4** | **Validate staging against the OD cloud API** — confirm slot-markers, scheduling, and write-backs work via `api.opendental.com` with your Developer + per-office keys. Gaps here = the Phase-2 connector agent. | This is the connector-reach proof; do it before prod cutover. |
| **5** | Stand up **PROD** in Azure (mirror staging infra). **Cut CareIN prod over**: point `dashboard.carein.ai` at Azure Front Door instead of `10.20.30.160`; migrate/seed prod DBs; verify; then decommission the local prod (and its 3am-reboot fragility). | Prod last, after staging is proven. |
| **6** | Now: local = dev, Azure staging = test, Azure prod = live. Normal flow begins. | The end state you asked for. |
| **Parallel/later** | Phase-2 **connector agent + tunnel** for on-prem-OD offices; **Entra External ID** for customer logins; TC + RCM modules. | Needed to sell beyond API-enabled offices. |

---

## 6. Cost (honest)
This is where Azure spend becomes real (vs ~$12/mo today). Two environments, each: Container Apps
(consumption — staging scales to zero), Postgres B1ms (~$12/mo, stoppable for staging), Front Door
(~$35/mo base + usage), Key Vault (pennies), App Insights (low). Rough ballpark: **prod ~$60–120/mo,
staging ~$20–60/mo** depending on Front Door/APIM choices and DB size. Set budgets + alerts per the
cost-guardrails doc. Front Door is the biggest line — APIM or a plain Container Apps ingress + Cloudflare
can be cheaper if needed.

## 7. Resourcing (blunt)
Containerization, IaC, CI/CD, networking, and especially the **zero-downtime prod cutover** are real
DevOps work. Given your clinical hours, **this is the single most defensible place to bring in a
contractor or fractional DevOps engineer** for the Azure foundation + pipeline, with you supervising
via CC. The cutover (moving live prod off your machine without the team noticing) deserves a careful,
rehearsed plan — do it on staging first, then a scheduled prod window.

## 8. Immediate next step
**Containerize the app and run it locally (Step 1)** — it's the foundation for everything and risks
nothing. That's a clean, self-contained Claude Code task. After that, the Azure staging foundation.

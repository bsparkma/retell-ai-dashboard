# Phase 3 · Step 5 — Azure Prod Cutover (runbook)

_Drafted 2026-06-05. Get CareIN prod OFF the office workstation onto Azure: stand up an Azure prod
environment mirroring staging, migrate the prod data, then cut `dashboard.carein.ai` from the LAN box
(`10.20.30.160`) to Azure — and only retire the laptop after Azure prod has soaked clean. **Decided
scope: API-covered features only (calls, commlogs, patient/appointment reads+writes — all validated
in Step 4). slot-markers/scheduling is NOT daily-used, so it ships degraded in Azure and the connector
agent restores it as a fast-follow.** Core safety principle: **the LAN prod keeps running through the
cutover; the DNS flip is the only switch, so rollback = flip DNS back (instant).**_

## Big properties that make this safer than a generic cutover
- **Same hostname before & after.** LAN prod already serves `https://dashboard.carein.ai` with HTTPS +
  SSO, and the Entra redirect URI `https://dashboard.carein.ai/auth/callback` is already registered. So
  moving to Azure keeps the *same* hostname + SSO config — **no Entra change, SSO just works post-flip.**
- **Staging already proved the stack.** Azure prod mirrors the proven staging build (`ebf1883`).
- **Cert pre-staged before cutover.** Add the `asuid` TXT to validate + provision the managed cert
  while the live A record is untouched, so the cutover itself is a single DNS change.

---

## 0. Decisions (confirmed Phase A, 2026-06-05)
| Decision | Confirmed | Note |
|---|---|---|
| Region | **southcentralus** | match staging + `kv-carein-core`. |
| Prod resource group | **`rg-carein-prod`** (separate from staging) | own budget + blast-radius isolation. |
| Container Apps env | **`cae-carein-prod`** (separate env) | isolate prod from staging. |
| Postgres | **`psql-carein-prod`, Burstable B1ms**, 32GB, PG16, no geo-redundant backup, **backups ON** | one practice's volume fits B1ms; bump later if needed. |
| Front Door | **No — mirror staging** (Container Apps ingress + free managed cert) | one practice behind SSO doesn't need WAF/CDN. |
| **Ingress access model** | **PUBLIC internet + SSO** (NOT IP-locked) | Confirmed: must serve offices outside their LAN. No IP allowlist. |
| **Data** | **MIGRATE-PRESERVE** (pg_dump LAN control + tenant DBs → restore to Azure) | preserves the HIPAA `audit_log`. See §3 data note (calls are NOT in PG). |
| Prod images | **reuse the validated `acrcareincore` images at current `main`/`ebf1883`** (retag `:prod`) | same code staging proved. |

## 1. Stand up Azure prod infra (mirror staging, in `rg-carein-prod`)
`cae-carein-prod` (+ Log Analytics), `psql-carein-prod` (B1ms, backups on), `kv-carein-prod`, managed
identity `id-carein-prod` (**Key Vault Secrets User on kv-carein-prod + AcrPull on acrcareincore**),
`ca-carein-prod-backend` (internal) + `ca-carein-prod-caddy` (external, **public ingress + SSO**). Apply
the cost budget (~$80/mo, alerts to admin@carein.ai). Reuse the shared ACR `acrcareincore`.

## 2. Prod secrets → `kv-carein-prod` (real values; this is real PHI prod)
Mirror the staging secret set with PROD values: control DB owner + app (`carein_app`) conn strings,
per-tenant DB owner + app conn strings, SSO client id/secret + session secret, OD Developer + **Roland**
Customer key, `OPENDENTAL_CAREIN_COMMTYPE_DEFNUM=486`. App reads via managed identity, `NODE_ENV=production`;
confirm cookie `Secure=true` works behind the Azure ingress TLS.

## 3. Prod DB bring-up + DATA MIGRATION (off-hours, write-quiet)
1. Create `carein_owner` + `carein_app` roles on `psql-carein-prod` (app = INSERT+SELECT only, audit append-only).
2. Run control + per-tenant migrations so the schema exists.
3. **Migrate the data:** `pg_dump` the LAN `carein_control` + `carein_t_carein` and restore into Azure
   `psql-carein-prod`. Verify `audit_log` row count matches (LAN = **430** at Phase A).
4. Put the resulting `carein_app` conn strings in `kv-carein-prod`.

> **⚠️ DATA NOTE (Phase A finding) — calls are NOT in Postgres.** `call_record` = **0** on the LAN box.
> The 1157 calls live in the **file-based unified call store** (`backend/data/unified_calls.json`), which
> is **rehydrated from the Retell API** on boot (sync fetches up to 1000 calls, every 15 min). Implications:
> - pg_dump preserves `audit_log` (430) + control registry — **but carries no call data** (there is none in PG).
> - On Azure Container Apps the container FS is **ephemeral**, so the JSON cache won't persist across
>   restarts/scale — but it **rehydrates from Retell on boot**, so recent calls (≤ Retell fetch window)
>   reappear automatically. **Decide:** (a) accept Retell-rehydration (simplest; loses calls older than the
>   fetch window + any local-only link/sync enrichment), (b) attach a small persistent volume for
>   `unified_calls.json`, or (c) copy the current `unified_calls.json` into the prod container as a seed.
>   Recommend (a) for cutover + (b) as fast-follow if call history depth matters.

## 4. Build/deploy prod app + PRE-STAGE the cert (no cutover yet)
- Deploy `ca-carein-prod-backend` + `ca-carein-prod-caddy` from the `acrcareincore` images at current
  `main`. Wire env/secret refs (incl. `NODE_ENV=production`, prod DB conn strings, OD keys).
- **Pre-stage the custom domain WITHOUT flipping live traffic:** Beau adds the **`asuid.dashboard` TXT**
  at GoDaddy (does not disturb the live `dashboard.carein.ai` A record); bind the custom domain on
  `ca-carein-prod-caddy` and let the managed cert provision.
- Verify Azure prod end-to-end via its raw `*.azurecontainerapps.io` URL (or hosts override): SSO login,
  calls render (rehydrated from Retell), a commlog write lands, `/api/health` 200, cross-tenant 403,
  append-only audit intact. **Slot-markers will 503 — expected (connector-free); the SPA degrades
  gracefully (SlotMarkersProvider catches the error, renders empty — confirmed Phase A, no guard needed).**

## 5. CUTOVER (off-hours window, office closed; separate go)
1. Final write-quiet delta check.
2. **Flip DNS:** `dashboard.carein.ai` from **A → `10.20.30.160`** to **CNAME →
   `ca-carein-prod-caddy.<region>.azurecontainerapps.io`** (low TTL). LAN box stays running.
3. Verify Azure serves `https://dashboard.carein.ai` (cert, SSO, calls/commlogs, `/api/health` 200) and a
   test call's Retell webhook reaches Azure + logs a commlog. **Retell webhook URL must point at
   `dashboard.carein.ai`** for the flip to carry it — confirm in the Retell dashboard (Phase A could not
   read it; key is in `.env`). If it points at a raw IP/other host, update it at cutover.

## 6. Soak, then retire the LAN box
- **Rollback (any time during soak):** flip `dashboard.carein.ai` DNS back to A → `10.20.30.160`. LAN box
  never stopped → instant, lossless. (Caveat: data written to Azure during soak isn't on the LAN box — keep
  soak short or re-migrate on rollback.)
- After a clean soak (a few business days), retire LAN prod: stop PM2 apps + local Docker PG, **keep a
  final backup** of the LAN DBs.

## 7. After cutover
- Prod runs in Azure; daily office use no longer depends on the workstation.
- **Fast-follow:** connector agent (restores slot-markers/scheduling in cloud) + scheduling-engine restore.
- Then: Valley / per-location (multi-OD-database) on stable Azure prod.

## 8. Cost
- Container Apps (prod may keep min-replicas 1 for no cold-start during office hours), Postgres B1ms
  (~$12-15/mo), Key Vault pennies, Log Analytics low. Budget ~**$60–120/mo** prod + existing staging.
  Set budget + alerts during §1.

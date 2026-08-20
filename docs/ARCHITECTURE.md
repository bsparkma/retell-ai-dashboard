# CareIN — Architecture

**Verified against `origin/develop`, August 2026.** Where a value came from a workflow
YAML it is authoritative; where it came only from a prose runbook it is marked 📄 and may
have drifted. See [CLAUDE.md](../CLAUDE.md) for the code-level contracts and
[DEV_PROD_WORKFLOW.md](../DEV_PROD_WORKFLOW.md) for the deploy procedure.

---

## 1. The call lifecycle, PBX to chart

```
  ┌─────────────┐                    ┌──────────────┐
  │  Mango PBX  │                    │  Retell AI   │
  │  (all legs) │                    │ (AI-answered)│
  └──────┬──────┘                    └──────┬───────┘
         │ REST pull, hourly at :15         │ webhook (call_started /
         │ MANGO_INGEST_MODE=api            │ call_ended / call_analyzed)
         │                                  │ + 15-min poll
         ▼                                  ▼
  ┌──────────────────────┐          ┌──────────────────────┐
  │ mangoApiClient       │          │ routes/webhooks.js   │
  │  watermark walk      │          │  HMAC-verified       │
  │  + gap drain         │          │  (no tenant context) │
  │  recording: fetch    │          └──────────┬───────────┘
  │  signed URL, never   │                     │
  │  written to disk     │                     │
  └──────────┬───────────┘                     │
             │                                 │
             └──────────────┬──────────────────┘
                            ▼
              ┌──────────────────────────────┐
              │      unifiedCallStore        │
              │  in-memory Map + 4 indexes   │
              │  → $CALLSTORE_DIR/           │
              │      unified_calls.json      │
              │  normalizeCall() rebuilds    │
              │  the record — the            │
              │  preservation whitelist is   │
              │  the only thing keeping      │
              │  locally-set fields alive    │
              └───────┬──────────────────────┘
                      │
        ┌─────────────┼─────────────────┬──────────────────┐
        ▼             ▼                 ▼                  ▼
  ┌──────────┐  ┌────────────┐   ┌─────────────┐   ┌──────────────┐
  │ callTwins│  │ on-demand  │   │openDentalSync│  │ tcCaseClient │
  │ link the │  │transcription│  │              │  │              │
  │ two legs │  │            │   │              │  │              │
  │ Δend ≤2s │  │ human      │   │ office FROM  │  │ payload      │
  │ fwd delay│  │ presses    │   │ THE CALL     │  │ assembled    │
  │ −2..120s │  │ the button │   │ ↓            │  │ SERVER-SIDE  │
  │ ambiguity│  │ ↓          │   │ match        │  │ from the     │
  │ = refusal│  │ Azure      │   │ (≥0.80 AND   │  │ stored call  │
  └────┬─────┘  │ Speech     │   │  no alts)    │  └──────┬───────┘
       │        │ (BAA)      │   │ ↓            │         │
       │        │ ↓          │   │ 'matched'    │         │ loopback HTTP
       │        │transcript  │   │ ↓            │         │ POST /api/tc/
       │        │ Shape.js   │   │ HUMAN REVIEW │         │ cases/from-call
       │        │ (canonical)│   │ ↓  (Send)    │         │ forwards the
       │        └─────┬──────┘   │ commlog      │         │ caller's own
       │              │          │ DefNum 486   │         │ credential
       │              │          │ (roland) or  │         ▼
       │              │          │ 451 (valley) │  ┌──────────────┐
       │              │          └──────┬───────┘  │   TC case    │
       ▼              ▼                 ▼          │ tc_case_id   │
  ┌──────────────────────────────────────────┐     │ tc_case_url  │
  │        new-dashboard worklist            │     └──────────────┘
  │  duplicate_leg hidden ("Answered by      │
  │  CareIN AI" badge · All-calls view)      │
  │  transferred_leg stays visible           │
  └──────────────────────────────────────────┘
```

Two things this diagram is meant to make unmissable:

**Pull and push are independent.** The 15-minute Retell poll populates the dashboard. The
`call_analyzed` webhook is the only thing that can write an Open Dental commlog. "The call
shows in the dashboard" therefore does **not** mean the webhook fired. When diagnosing a
missing chart note, the decisive test is whether `call_started` reached the backend at the
real call-start timestamp.

**Nothing reaches a chart without a human.** `COMMLOG_AUTO_WRITE` is off by default. A
confident, unambiguous match parks in `'matched'`; a person sends it.

---

## 2. The office model

An "office" is a **separate Open Dental database**, not a filter or a display label.

| Key | Practice | Open Dental (`odEnabled`) | CommLog DefNum |
| --- | --- | --- | --- |
| `roland` | Roland, OK | true | **486** |
| `valley` | Fort Smith — branded "Riley"; the key stays frozen | true | **451** |
| `unknown` | System bucket for unmapped Mango DIDs | never (no registry entry) | — |

There is **one** switch, and both modules read it. TC briefly had a second
(`officeAgents.OFFICES[].odConnected`) because it reached Open Dental through the
single Roland-bound client and had to stay shut while voice went live for Riley;
TC now resolves its client per office through the same registry, so that flag was
retired rather than left to drift.

Consequences that shape most of the backend:

- **PatNum numbering restarts per database.** PatNum `7115` is a synthetic test patient in
  valley and a **different, real person** in roland. Every stored `od_patient_id` is
  written alongside `od_patient_office`; a stored match belonging to another office is
  discarded and re-matched rather than used.
- **DefNums are practice-specific.** 486 is not a CommLogType in Riley's database at all.
  Writing the wrong one is a data-integrity bug, not a cosmetic one.
- **Only the customer key is per-office.** Developer key and API base URL are process-wide.
  Adding an office means adding `OPENDENTAL_CUSTOMER_KEY_<OFFICE>` and
  `OPENDENTAL_CAREIN_COMMTYPE_DEFNUM_<OFFICE>` plus a registry row — not new code.
- **Fail closed per office.** A missing valley key makes valley report *not connected*; it
  can never silently fall back to Roland's key.
- **Voice and TC have separate switches** and are pinned apart by a test.

Office is derived server-side from the call — `called_number` → DID map for Mango,
`handler_id ?? agent_id` for Retell. An unmapped Mango DID resolves to `unknown` with a
warn-once, deliberately **not** to Roland. A client-supplied `office_id` is an assertion
that can only cause a 409, never a redirect.

The cross-office guard is `assertOfficeMatch` in `backend/config/odOffices.js:321` — the
safety heart of the layer. Cross-contamination is covered end to end by
`backend/services/odOfficeRouting.test.js`.

---

## 3. Environments

Values from `.github/workflows/*.yml` are authoritative. 📄 marks values that appear only
in prose runbooks.

| | **Staging** | **Production** |
| --- | --- | --- |
| Trigger | push to `develop`, auto | push to `main`, gated |
| Resource group | `rg-carein-staging` | `rg-carein-prod` |
| Backend app | `ca-carein-backend` | `ca-carein-prod-backend` |
| Caddy app | `ca-carein-caddy` | `ca-carein-prod-caddy` |
| Migrate job | `caj-carein-migrate` | `caj-carein-prod-migrate` |
| Container registry | `acrcareincore` / `acrcareincore.azurecr.io` — **shared**, in 📄 `rg-carein-core` | same |
| Container Apps env | 📄 `cae-carein-staging` | 📄 `cae-carein-prod` |
| Key Vault | 📄 `kv-carein-staging` | 📄 `kv-carein-prod` |
| Log Analytics | 📄 `log-carein-staging` (PerGB2018) | **not recorded anywhere in this repo** |
| Postgres | 📄 `psql-carein-staging` (B1ms, v16, HA off) | 📄 `psql-carein-prod` (B1ms, backups on) |
| Managed identity | 📄 `id-carein-staging` | 📄 `id-carein-prod` |
| Region | 📄 `southcentralus` | 📄 `southcentralus` |
| Hostname | 📄 `https://staging.carein.ai` — **IP-allowlisted to the admin workstation** | 📄 `https://dashboard.carein.ai` |
| Budget | 📄 `budget-carein-staging`, $50/mo | 📄 ~$80/mo |

### Storage accounts

There are **two different storage accounts serving two different purposes**, and they are
easy to conflate:

| Purpose | Account | Container / share | Notes |
| --- | --- | --- | --- |
| **Prod call store** | `stcareinprodfbe70ffb` | file share `data` | Surfaced to the backend as Container Apps env storage named **`callstore`**, volume `callstore-vol`, mounted at `/data`, with `CALLSTORE_DIR=/data` |
| TC media / import | `stcareinstaging` | blob container `tc-media` | Staging; `rg-carein-staging` |

**Staging has no call-store volume, deliberately.** Its `unified_calls.json` rides the
ephemeral container layer and is wiped on every image deploy. That is why staging must
stay `MANGO_INGEST_MODE=off` except for bounded, deliberate test sessions — otherwise every
deploy triggers a re-ingest and re-transcription of the lookback window.

> There is no storage account named `stcareinstgcallstore` — that name conflates
> `stcareinstaging` with the Container Apps env storage name `callstore`.

### Ingress

There is **no Azure Front Door**, despite what `PHASE3_AZURE_ENVIRONMENTS.md` plans.
Ingress is a Container Apps custom domain with a certificate bound on the Caddy app. Caddy
(`deploy/container/Caddyfile`) listens on `:8088` plain HTTP behind the platform's TLS
termination and reverse-proxies `/api/*`, `/auth/*`, and `/socket.io/*` to
`{$BACKEND_ORIGIN}` (the backend's internal ingress FQDN in Azure, `backend:5403` in local
compose). Everything else is the static SPA from `/srv`.

### The retired on-prem path

`deploy/Caddyfile` still describes the LAN Windows workstation at `10.20.30.160` serving
`dashboard.carein.ai` from PM2 on `:5003` with a manually-renewed Posh-ACME certificate
(valid through 2026-09-01). **That is not production.** Prod moved to Azure Container Apps
on 2026-06-06. The file and `ecosystem.config.cjs` are kept for local/parity use and as
the rollback path of record, but two live definitions of `dashboard.carein.ai` exist in
this repo — confirm actual DNS before acting on either.

### Port map

| Context | Backend | Dashboard / Caddy |
| --- | --- | --- |
| Local dev | 5103 | 3105 (Vite dev on 3005) |
| PM2 on the LAN box | 5003 | 3005, behind Caddy :443 |
| Container parity (compose) | 5403 | Caddy :8088 |
| Azure Container Apps | 5403 internal | Caddy :8088 behind platform TLS |

Compose ports are deliberately off the busy set (5003 / 5103 / 3005 / 3006 / 80 / 443).

---

## 4. Data planes

| Store | Where | Contents |
| --- | --- | --- |
| **Unified call store** | `$CALLSTORE_DIR/unified_calls.json` | Merged Retell + Mango call records. In-memory authoritative, atomic tmp+rename persist, 500 ms debounce, 60 s autosave. **No delete primitive, no retention.** |
| Durable state docs | same directory | `mango_ingestion_watermark.json`, `transcription_budget.json`, `mango_ondemand_transcription.json` |
| Control plane | Postgres `carein_control` | Tenant registry, `app_user`, `tenant_module` entitlements, connector config. Returns Key Vault secret **names**, never values. |
| Per-tenant data plane | Postgres `carein_t_<tenant>` | `audit_log` (append-only), TC tables, and `call_record` — **schema only**, nothing reads or writes it yet |
| Open Dental | External, per office | Patients, appointments, commlogs. Cloud REST API only; never direct MySQL. |
| Recordings | Nowhere | Fetched from a signed expiring URL, sent to Azure Speech, discarded |

`audit_log` is append-only by **database grant**, not by application logic: the app
connects as a least-privilege role (`carein_app`, or `AUDIT_APP_ROLE`) that holds only
INSERT and SELECT. If that role does not exist — e.g. a local dev database using a
superuser — the grant is skipped and append-only does not hold. Audit writes fail closed:
a failed write on a PHI path propagates so PHI is not returned without a trail, and in
production startup aborts if any active tenant's `audit_log` is unreadable.

---

## 5. Request path

```
browser
  └─ Caddy ─────────────────────────────────────────────────┐
       ├─ /api/*, /auth/*, /socket.io/*  → backend           │
       └─ everything else               → static SPA (/srv)  │
                                                             │
backend (Express, CommonJS)                                  │
  /auth/*            ── Entra auth-code + PKCE, outside /api ─┘
  /api/*
    └─ requireDashboardAuth   session cookie OR shared bearer
         exempt: /webhooks/*, /health, /retell-tools/*
    └─ tenantContext          resolve req.tenant, else 403 TENANT_UNRESOLVED
         (503 TENANT_RESOLUTION_ERROR if the control DB is unreachable)
         exempt: the three above + /mango/dev/seed
    └─ requireModule('voice' | 'tc')   403 MODULE_NOT_ENTITLED, fail-closed
```

`/api/webhooks/*` and `/api/retell-tools/*` are deliberately unguarded — they are
HMAC-verified and carry no user identity, so a tenant or module guard would 403 them.
`/api/mango/recordings` is PHI audio and sits **below** the auth gate with the voice
guard; a regression test pins that it never moves above it.

---

## 6. Frontend shape

`new-dashboard/client/src` — React 19, Vite 7, TypeScript strict, Tailwind v4 (Vite
plugin, not PostCSS), shadcn/ui on Radix, wouter for routing (**patched** — see
`new-dashboard/patches/`), Recharts. **No state or query library**: four hand-rolled
contexts (`Auth`, `Module`, `Office`, `Theme`) plus `useEffect` + `useState`.

Three HTTP clients with three different error contracts — `api` / `ApiError` for the main
backend, `careInApi` for the local CareIN log sub-server, and the TC feature client with
`TcApiError`. Details in [new-dashboard/NOTES.md](../new-dashboard/NOTES.md).

The office picker in the sidebar scopes **reads**. Writes take their office from the call
and send `office_id` only as an assertion the server can refuse. That distinction is the
whole reason a stale screen cannot file a note into the wrong practice.

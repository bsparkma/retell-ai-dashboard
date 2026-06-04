# CareIN Platform — Multi-Tenant SaaS Architecture & Roadmap

_Drafted 2026-06-02. Target: turn CareIN from a single on-prem deployment into a multi-tenant, Azure-hosted platform sellable to other practices, hosting CareIN + the TC app + the RCM posting app as modules._

**Decisions locked in:**
- **Isolation:** per-practice database (shared app code, isolated data).
- **Open Dental reach:** hybrid — on-prem connector agent + OD cloud API, auto-selected per practice.
- **Shape:** ONE unified platform; CareIN / TC / RCM are modules, not separate products.

---

## 1. The two things that actually make this hard

Azure hosting is the easy part. The architecture is shaped by:

1. **Reaching each practice's Open Dental.** Most OD installs are on-prem local MySQL behind a firewall. You cannot reach them from the cloud without either an agent at the site or the practice being on OD's cloud API. → solved by the **Connector Agent + unified OD access layer** (§4).
2. **PHI isolation across tenants.** Per-practice databases mean a query bug can't leak one practice's patients into another's view, and a breach is contained to one tenant. → solved by the **per-tenant data plane + tenant registry** (§3).

Everything below serves those two realities.

---

## 2. Layered architecture (target)

```
                          ┌─────────────────────────────────────────────┐
                          │              CUSTOMER (practice)             │
   Practice staff ───────▶│  Entra External ID (CIAM)  ·  per-practice   │
                          │  login, SSO, MFA, branding                   │
                          └───────────────┬─────────────────────────────┘
                                          │ (authenticated session)
   ┌──────────────────────────────────────▼──────────────────────────────────┐
   │                         AZURE — PLATFORM (your Entra tenant)              │
   │                                                                          │
   │   Front Door / APIM  ──▶  Container Apps (API + modules)                 │
   │        (WAF, routing)        │  CareIN  │  TC  │  RCM   (modules)        │
   │                              │  shared services ▼                        │
   │   ┌──────────────┐   ┌───────────────┐   ┌──────────────┐   ┌─────────┐  │
   │   │ Tenant       │   │ Unified OD    │   │ Key Vault    │   │ Audit / │  │
   │   │ Registry     │   │ Access Layer  │   │ (per-tenant  │   │ Billing │  │
   │   │ (control     │   │ (api | agent) │   │  secrets)    │   │ Stripe  │  │
   │   │  plane)      │   └──────┬────────┘   └──────────────┘   └─────────┘  │
   │   └──────┬───────┘          │                                            │
   │          │            ┌─────▼───────────────┐                            │
   │   ┌──────▼─────────┐  │ Connector Gateway   │  (Azure Relay / SignalR)   │
   │   │ Per-tenant DBs │  │ outbound-only tunnel│                            │
   │   │ (Azure SQL     │  └─────────┬───────────┘                            │
   │   │  elastic pool /│            │                                        │
   │   │  PG per-tenant)│            │ secure outbound tunnel                 │
   │   └────────────────┘            │                                        │
   └─────────────────────────────────┼────────────────────────────────────────┘
                                      │
              ┌───────────────────────▼────────────────────┐
              │   ON-PREM at each practice (hybrid path A)  │
              │   Connector Agent (Win service) → local     │
              │   Open Dental MySQL / eConnector            │
              └─────────────────────────────────────────────┘
              ┌─────────────────────────────────────────────┐
              │   OD CLOUD (hybrid path B): platform calls   │
              │   api.opendental.com w/ tenant's dev+cust key│
              └─────────────────────────────────────────────┘
```

---

## 3. Control plane + per-tenant data plane

**Tenant Registry** (central catalog DB — the control plane). One row per practice:
`tenantId · name · status · odConnectionMode (agent|api) · dbConnectionRef (KV) · enabledModules[] · billingRef`.
Every request resolves `tenantId → which DB, which OD mode, which modules` here.

**Per-tenant databases** (the data plane — YOUR app data: call logs, TC plans, RCM postings; NOT the practice's OD data):
- **Azure SQL elastic pool** (database-per-tenant, shared compute) is the classic, cost-efficient SaaS pattern at scale. If you stay on Postgres (your current app stack), use **database-per-tenant on a Flexible Server**, sharding across servers as you grow.
- Per-tenant connection strings live in **Key Vault**, referenced by the registry. The data layer is **tenant-aware**: it picks the right DB connection per request. No `TenantID` column gymnastics, no cross-tenant query risk.

**Provisioning service:** on signup → creates the tenant's DB, generates connector credentials, writes the registry row, scopes Key Vault secrets. This is what lets you onboard practice #2..#N without hand-wiring.

---

## 4. Unified OD access layer (the hybrid connector)

The modules (CareIN/TC/RCM) must **never** know how OD is reached. They call one interface: `od.getAppointments(tenantId)`, `od.postPayment(tenantId, …)`. Behind it:

- **Path A — Connector Agent (on-prem):** a productized installable Windows service at the practice. Establishes an **outbound-only** secure tunnel to your **Connector Gateway** (Azure Relay Hybrid Connections or SignalR) — no inbound firewall holes. Talks to local OD MySQL / eConnector. This is your current connector, hardened and packaged for self-install.
- **Path B — OD Cloud API:** for practices on OD cloud, the platform calls `api.opendental.com` directly with that tenant's developer + customer keys (Key Vault). This is exactly CareIN's current api mode.
- The registry's `odConnectionMode` picks the path; the access layer abstracts it. Adding RCM write-back or TC reads later is one module calling the same interface.

Agent auth uses **per-tenant certificate app registrations** — the same cert pattern you built for the on-prem connector, issued per practice during provisioning.

---

## 5. Identity (keep customer and corporate separate)

- **Your staff/admins:** the existing `careindent` Entra tenant (already built).
- **Customer (practice) users:** a **separate Entra External ID (CIAM)** tenant — this is the current Microsoft product for customer identity (successor to Azure AD B2C). Practices' staff sign in here with SSO/MFA/your branding. NEVER put customers in your corporate tenant.
- **Connector agents & platform services:** cert-based app registrations (on-prem agents) and **managed identities** (anything hosted in Azure — drops the cert hassle for cloud components).

---

## 6. Hosting & cross-cutting (what keeps you compliant and sellable)

- **Compute:** **Azure Container Apps** — modular, scales to zero, managed; each module is a container/revision behind shared ingress. (AKS is overkill until much later; App Service is fine but less modular.)
- **Edge:** Azure Front Door or **APIM** for routing, WAF, rate limiting, per-tenant throttling.
- **Secrets:** Key Vault with per-tenant scoping (naming convention `t-{tenantId}-{secret}`, or vault-per-tenant for hardest isolation).
- **Audit logging:** immutable, per-tenant PHI-access audit trail → central Log Analytics. **Required for HIPAA and a genuine sales asset.**
- **Network:** private endpoints for DB + Key Vault, VNet isolation, no public database.
- **Billing/entitlements:** Stripe per tenant; module entitlements live in the registry (turn modules on/off per plan).
- **Backups/DR:** per-tenant DB backups, geo-redundancy, documented RTO/RPO.
- **HIPAA posture:** Microsoft's BAA covers Azure, but YOU must keep services in-scope, encrypt, log, and isolate. Plan a **SOC 2** path early — practices and DSOs will ask.

---

## 7. Sequencing — honest, high-leverage (do NOT boil the ocean)

| Phase | What | Why it's the unlock |
|-------|------|---------------------|
| **0 (done)** | CareIN single-tenant on-prem, cert+Key Vault identity | You're here. Don't rewrite it. |
| **1** | **Extract the platform spine**: Tenant Registry + tenant-aware data layer + provisioning. Make CareIN "tenant #1". | Nothing else is possible until tenancy is real. Highest-leverage work. |
| **2** | **Productize the Connector Agent** + unified OD access layer (hybrid). Onboard a 2nd practice with no hand-wiring. | Proves you can sell to a practice you don't physically touch. |
| **3** | **Move hosting to Azure** (Container Apps), swap cert→managed identity for cloud parts, stand up **Entra External ID** for customer login. | Turns it into a real cloud product. |
| **4** | **Add TC and RCM as modules** on the same spine (reuse tenant, connector, identity, billing). | This is where the "one platform" payoff lands — modules are now cheap. |
| **5** | **Harden for sale**: audit logging, per-tenant backups, SOC 2 path, billing, onboarding self-serve. | What lets you sell to cautious dental buyers and DSOs. |

**Blunt distraction warnings:**
- Do **not** build TC and RCM as standalone apps now. Build the spine (Phase 1), make CareIN multi-tenant, and the other two become modules instead of products. Building them separately is the single most expensive mistake available to you here.
- Per-tenant DB + hybrid connector is the *right* call, but it is real engineering (provisioning automation, the agent installer, the gateway). Given your clinical time constraints, scope Phase 1–2 tightly and consider a contractor for the connector-agent + provisioning plumbing.
- Don't chase SOC 2 / DSO-grade hardening before Phase 1–2 exist. Sequence it.

---

## 8. Immediate next step

Phase 1 is the unlock and it's well-defined: Tenant Registry, tenant-aware data layer, provisioning service, and refactoring CareIN to resolve everything by `tenantId`. That's a clean candidate for a PRD + Cursor-ready build prompts.

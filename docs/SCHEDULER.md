# Slice 4b — Tenant-Aware Scheduler & Non-Session OD Paths (follow-up)

Slice 4 made `backend/platform/odAccess.js` the single tenant-aware path to Open
Dental for every **request-scoped** route that carries a resolved tenant
(`req.tenant`, set by `tenantContext`): `routes/openDental.js`, `routes/calls.js`,
`routes/openDentalSync.js`, and `routes/slotMarkers.js`.

Some OD-touching code has **no `req.tenant`** and was deliberately left on the
existing OD client. Injecting a default "CareIN" tenant into these would bake a
single-tenant assumption into shared code, so it is **out of scope until 4b**.
Each must instead resolve a tenant explicitly and call `odAccess` with a
synthesized request context.

## Paths still bound to the single OD client

| Path | File | Why it has no tenant | 4b resolution |
|------|------|----------------------|---------------|
| Mango→OD commlog sync (cron) | `backend/services/openDentalSync.js` (run by `syncScheduler`) | Runs on a timer, not a request; processes calls from `unified_calls.json` which aren't tenant-tagged until the Slice 3b cutover | Iterate `registry.listTenants()`; for each, build a synthetic tenant context and call `odAccess.*(synthReq, …)`. Depends on call records carrying a tenant/clinic (3b). |
| OD client real-time self-sync | `backend/config/openDental.js` `startRealTimeSync()` | The client polls itself on construction; not per-request | Move polling into a per-tenant scheduler loop that resolves each tenant's connector via `odAccess`; stop the singleton from self-polling. |
| Admin status introspection | `backend/routes/admin.js` | Request-scoped but reads OD *service state* (enabled/useDatabase/lastSync/testConnection), not tenant OD data; intentionally excluded from the Slice 4 reroute | Optional: route through `odAccess.getStatus(req)` / `odAccess.testConnection(req)` once admin is confirmed tenant-scoped. Low priority — no PHI. |
| Retell custom-function tools | `backend/routes/retellTools.js` | **Tenant-EXEMPT**: `/api/retell-tools/*` is authenticated by Retell's HMAC, not the dashboard session, so `tenantContext` does not run and there is no `req.tenant`. Routing it through `odAccess` as-is would 403 the live voice agent. | Resolve the tenant from the Retell **agent_id / called number → tenant** mapping (new registry lookup), attach `req.tenant`, then call `odAccess.findAvailableSlotsForDay(req, …)` / `odAccess.bookAppointment(req, …)`. This is the Phase 2 per-practice Retell routing. |

## Synthetic tenant context (pattern for background jobs)

A request-less job builds the same shape `tenantContext` would attach, from the
registry, then passes it as `req`:

```js
const registry = require('../platform/registry');

async function tenantReq(tenantId) {
  const [tenant, clinics, modules] = await Promise.all([
    registry.getTenantById(tenantId),
    registry.getTenantClinics(tenantId),
    registry.getEnabledModules(tenantId),
  ]);
  if (!tenant) throw new Error(`unknown tenant ${tenantId}`);
  return { tenant: { id: tenant.tenant_id, slug: tenant.slug, modules, clinics } };
}

// e.g. nightly sync across all tenants
for (const t of await registry.listTenants()) {
  const req = await tenantReq(t.tenant_id);
  await odAccess.searchPatients(req, phone); // resolves THAT tenant's connector
}
```

This keeps `odAccess` the only path to OD and preserves the COMPLY guarantee
(no global pool / no hardcoded connector; every call resolves from a tenant id)
even for background work — without a single-tenant default anywhere.

## Hard OD rules (unchanged, enforced in odAccess)

ClinicNum scoping + `requireEntitledClinic` on client-supplied clinicNum
(slot-markers); writes via the cloud API / connector service only (never direct
MySQL); cancel sets `AptStatus`, never deletes; no `SELECT *`. Any future
`procCode→CodeNum` lookups live in the wrapped client and are preserved by
delegation.

# Platform Modules — Entitlement & Gating

How the CareIN platform decides which product modules a tenant can use, and how
routes are gated. Shipped by the `feature/module-entitlement` slice so the
second module (TC) arrives gated from day one.

## Module ids

Enforced by a CHECK constraint on `tenant_module.module` (carein_control):

| id           | Product                                              | Status |
|--------------|------------------------------------------------------|--------|
| `voice`      | CareIN voice agent dashboard (formerly id `carein`)  | Live — the entire current app |
| `rcm`        | AR / RCM agent                                       | Reserved |
| `tc`         | Treatment Coordinator                                | Reserved (next module) |
| `scheduling` | Native scheduling (decided future paid add-on)       | Reserved |

The `carein` → `voice` rename lives in
`backend/migrations/1785369600000_rename_module_carein_to_voice.js`. It is a
PK-safe **merge** (`INSERT … ON CONFLICT` then delete) so it is idempotent and
safe on environments whose seed already wrote `voice`.

## Data model (shipped earlier, unchanged)

- `tenant_module (tenant_id, module) PK, enabled bool` in carein_control.
- `registry.getEnabledModules(tenantId)` returns the enabled ids.
- `tenantContext` middleware loads them onto `req.tenant.modules` per request.

## Entitling a tenant to a module

```sql
-- in carein_control
INSERT INTO tenant_module (tenant_id, module, enabled)
VALUES ('<tenant-uuid>', 'tc', true)
ON CONFLICT (tenant_id, module) DO UPDATE SET enabled = EXCLUDED.enabled;
```

Disable by setting `enabled = false` (never delete — keeps history). New
tenants get modules via `registry.createTenant(spec.modules)`. Takes effect on
the next request (modules are loaded per-request, no cache to bust).

## Backend gating

`backend/middleware/tenantContext.js` exports:

- **`requireModule(name, { exempt? })`** — Express guard, mounted AFTER
  `tenantContext()`. Unentitled module **or missing tenant context** →
  `403 { success: false, error: 'MODULE_NOT_ENTITLED', module }`. Fail-closed
  by construction: never 500, never pass-through. `exempt` takes mount-relative
  RegExps (same convention as `tenantContext({ exempt })`).
- **`isEntitledModule(req, name)`** — boolean predicate for inside a handler,
  mirroring `requireEntitledClinic`.

Usage (see the Routes block in `backend/server.js`):

```js
app.use('/api/calls', requireModule('voice'), callsRouter);
app.use('/api/mango', requireModule('voice', { exempt: [/^\/dev\/seed$/] }), mangoRouter);
// future: app.use('/api/tc', requireModule('tc'), tcRouter);
```

Gating is LOGICAL only — no URL re-pathing. Inert for entitled tenants.

## Exemption list (routes that must NEVER get a module guard)

These carry no tenant context; a module guard would 403 them:

| Route | Why exempt |
|---|---|
| `/api/retell-tools/*` | LIVE voice-agent tools, Retell HMAC-authenticated — guarding would fail the agent mid-call |
| `/api/webhooks/*` | Retell/Mango webhooks, signature-verified |
| `/api/health` | monitors |
| `/auth/*` | SSO sign-in flow (mounted outside `/api`) |
| `/api/mango/dev/seed` | staging-only synthetic seeder (tenant-exempt upstream; exempted inside the `/api/mango` guard) |
| `/api/mango/recordings/*` | static file mount registered before the auth gate |

`backend/test/moduleGateWiring.test.js` enforces this list against
`server.js` source AND behaviorally — editing the mounts inconsistently fails
`node --test`.

## /auth/me

The tenant payload now includes the enabled module ids:

```json
{ "authenticated": true, "user": {… }, "tenant": { "slug": "carein", "displayName": "…", "modules": ["voice"] } }
```

Degrades to `"modules": []` if the control DB is unreachable — auth never
depends on the modules lookup.

## Frontend

- `new-dashboard/client/src/lib/modules.ts` — module registry (id → label +
  basePath) and the pure `resolveActiveModule()` logic.
- `contexts/ModuleContext.tsx` — global selection following the OfficeContext
  pattern (sidebar control, localStorage key `carein.module`, `useModule()`
  hook). Selection is derived from entitlements, so a revoked module can never
  stay active.
- `DashboardLayout.tsx` — the switcher renders **only when the tenant has more
  than one renderable module**; a Voice-only tenant sees an unchanged shell.

UI hiding is convenience. The backend `requireModule()` 403 is always the
source of truth.

## Adding the next module (checklist)

1. Entitle the tenant (SQL above) — or ship dark: don't entitle yet.
2. Backend: mount `app.use('/api/<mod>', requireModule('<mod>'), router)`.
3. Frontend: add the module to `MODULES` in `lib/modules.ts` with its basePath,
   and render its pages under that prefix.
4. Add the new mount to the guarded list in
   `backend/test/moduleGateWiring.test.js`.
5. If the module id is genuinely new (not in voice/rcm/tc/scheduling), write a
   migration extending the `tenant_module_module_check` constraint first.

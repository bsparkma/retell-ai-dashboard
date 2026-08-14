# Platform Modules — Entitlement & Gating

How the CareIN platform decides which product modules a tenant can use, and how
routes are gated. Shipped by the `feature/module-entitlement` slice so the
second module (TC) arrives gated from day one.

## Module ids

Enforced by a CHECK constraint on `tenant_module.module` (carein_control):

| id           | Product                                              | Status |
|--------------|------------------------------------------------------|--------|
| `voice`      | CareIN voice agent dashboard (formerly id `carein`)  | Live — the entire current app |
| `rcm`        | AR / RCM agent                                       | **Mounted, ships dark** — `/api/rcm/*` + `/rcm`; no tenant entitled yet |
| `tc`         | Treatment Coordinator                                | Live (entitlement flipped in prod 2026-08-05) |
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
app.use('/api/tc', requireModule('tc'), require('./routes/tc'));
app.use('/api/rcm', requireModule('rcm'), requireReadWrite('rcm.read', 'rcm.write'), require('./routes/rcm'));
```

Gating is LOGICAL only — no URL re-pathing. Inert for entitled tenants.

### `/api/rcm` (RCM, mounted 2026-08-14 — Slice 3)

One mount for the whole surface, carrying **two** guards:

- `requireModule('rcm')` — the practice bought the product;
- `requireReadWrite('rcm.read', 'rcm.write')` — this person may do this.

The read/write pair is used even though Slice 3 mounts GETs only, so the
module's first mutation demands `rcm.write` by construction instead of
inheriting read permission from a single gate. `rcm.read`/`rcm.write` are held
by `admin` and `office`; `tc` and `hygiene` hold neither.

Endpoints: `GET /summary` (per-office counts across claims / payment batches /
posting queue) and `GET /claims` (office-scoped, paginated). Both are audited
fail-closed.

**Ordering constraint — office scoping is router-wide.**
`backend/routes/rcm/index.js` registers `router.use(requireOffice)` *before*
every route, so every present and future RCM route takes its office from the
server-validated `?office=roland|valley` query param and never from a body,
header, or default. There are **no exceptions today**, and that is the point:
TC needed one (`/cases/from-call` carries office in a frozen body contract, so
it must be registered above the router that applies `requireOffice`), and the
constraint lived only in a comment. RCM's version is pinned by
`backend/routes/rcm/rcmMountOrder.test.js`, which drives the fully-assembled
router and fails if a route is added above the guard without being listed in
that file's `OFFICE_GUARD_EXCEPTIONS` with a reason.

RCM **ships dark**: no tenant is entitled, so every route 403s
`MODULE_NOT_ENTITLED` until the entitlement is flipped from `/platform`.

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
2. Backend: mount `app.use('/api/<mod>', requireModule('<mod>'), <permission
   gate>, router)`. Both guards, not just the module one: entitlement answers
   "did this practice buy it?", permission answers "may this person do it?".
3. Add the module's actions to `backend/config/permissions.js` **and** to
   `ACTIONS` in `new-dashboard/client/src/lib/permissions.ts` — the two lists
   are compared by `tests/role-permissions.test.ts`, so they cannot drift.
4. Frontend: add the module to `MODULES` in `lib/modules.ts` with its basePath,
   give it a `NAV_BY_MODULE` group in `DashboardLayout.tsx` (a module with an
   empty nav is unreachable from the switcher), add its route prefix to
   `ROUTE_PERMISSIONS`, and render its pages under that prefix.
5. Add the new mount to the guarded list in
   `backend/test/moduleGateWiring.test.js`.
6. If the module id is genuinely new (not in voice/rcm/tc/scheduling), write a
   migration extending the `tenant_module_module_check` constraint first.
7. Write down any mount-ORDER constraint as a comment **and** a test. RCM's
   router-wide office guard (`routes/rcm/rcmMountOrder.test.js`) is the pattern:
   a comment alone is what let the TC ordering constraint stay invisible.

Watch for the entitled-but-unregistered case: a module in `/auth/me` with no
`lib/modules.ts` entry renders no tile and no nav, which is correct (the pages
don't exist yet) but looks like a bug if you're expecting one. `scheduling` is
the module currently in that state.

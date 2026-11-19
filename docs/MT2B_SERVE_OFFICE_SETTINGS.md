# MT-2b — serve the per-office settings from `office_setting`, per tenant

**Status:** the ten per-office readers SERVE `office_setting` for `(tenant, office)`.
**Since MT-2d** `office_setting` is also the only table written and the parity
tripwire is retired — see [MT2D_SINGLE_WRITER.md](MT2D_SINGLE_WRITER.md), which
supersedes the "Runbook writes" and "Rollback" sections below.
Builds on [MT2A_OFFICE_SETTINGS.md](MT2A_OFFICE_SETTINGS.md).

## What changed

| | Before (MT-2a) | Now (MT-2b) |
| --- | --- | --- |
| Stored layer served | `platform_setting[key][office]` | `office_setting(tenant, office, key)` |
| Reader signature | `isEnabled(office)` | `isEnabled(tenantSlug, office)` — tenant first, everywhere |
| Env `=true` fallback (switches) | any caller | tenant `carein` only |
| Env `=false` break-glass | forces OFF | forces OFF, for every tenant's office with that key |
| Email identity app-setting fallback | any caller | tenant `carein` only (see below) |
| A failed control-plane read | kept serving the previous read | **still** keeps serving the last good read (a blip must not flip a feature), but only while that read is younger than 3 × the refresh window (15 min) |
| Every refresh failing for more than 3 × the refresh window | served, indefinitely | not served: "nobody chose" → env fallback (carein) → OFF |
| Which keys are offices | `officeAgents.OFFICES` minus `unknown` | the tenant's ACTIVE registry rows (MT-1c); `carein` falls back to the code maps (roland, valley) when the registry cannot be read; any other tenant gets **no** offices |
| Writes | carein's map | carein only; any other tenant is refused `OFFICE_SETTING_TENANT_NOT_WRITABLE` (409) and nothing is written |
| Parity tripwire | served `platform_setting`, compared `office_setting` | served `office_setting`, compares `platform_setting` (same phrase, "office settings parity") |

The shared cache is `backend/platform/officeSettings.js`: one read of all of a
tenant's rows, fresh for `TC_SWITCH_REFRESH_MINUTES` (5), refreshed for every
active tenant by the hygiene and email-identity timers, and refreshed on demand
by every async reader and by the `/api/hyg` router before a handler runs.

## Where the tenant comes from

| Caller | Tenant |
| --- | --- |
| Request paths | `sessionTenantSlug(req)` (`backend/platform/sessionTenant.js`) — `req.tenant.slug` from `tenantContext`. Never a query param, header or body. Pinned by `platform/officeSettingsTenantSource.test.js` |
| Nurture, opportunities, nightly pipeline sync | the one active, `tc`-entitled tenant `registry.listTenants()` names (`resolveTenant`, unchanged — still refuses `AMBIGUOUS_TC_TENANT`) |
| Hygiene day warm, background refresh | every active tenant from `registry.listTenants()` (`officeSettings.activeTenantSlugs`) |
| Public referral-link pages | `TC_EMAIL_TENANT_SLUG`, attached to `req.tenant` by `attachTenant()` (MT-3 replaces this) |

## Open Dental stays carein's

The Open Dental handles (`config/odOffices.js`) are this deployment's — tenant
`carein`'s. So every path that reads Open Dental through a switch refuses any
other tenant **before** the switch is read: `odOffices.hygOdBlockReason` →
`OFFICE_NOT_OD_CONNECTED`, `autoCheckout.isOn` → off, `odPipelineSync.syncOffice`
→ `OD_NOT_TENANT_BOUND`, the opportunities pass → `OD_NOT_TENANT_BOUND`. A second
tenant with an office keyed `roland` can never reach carein's Roland chart.

## The email identity fallback is carein's

`ACS_EMAIL_REPLY_TO_<OFFICE>`, `TC_EMAIL_PRACTICE_NAME_<OFFICE>`, `…_PHONE_…`,
`…_ADDRESS_…` are keyed by office key alone. They answer for tenant `carein`
only, so another practice can never sign email with Roland's name, address or
reply-to. The FROM address (`ACS_EMAIL_FROM_<OFFICE>`) is not one of the
per-office settings and is unchanged.

## Runbook writes — READ THIS

`office_setting` is what is served now. A raw `INSERT INTO platform_setting`
alone **changes nothing** (and the tripwire warns). Use the two-table
transaction in [MT2A_OFFICE_SETTINGS.md](MT2A_OFFICE_SETTINGS.md#runbook-writes-nurture-opportunities-have-no-route),
or the console.

## Rollback

Revert this slice. `platform_setting` has been written alongside every change,
and the tripwire has been checking it is a faithful copy, so the MT-2a readers
pick up exactly what was in force.

## Known, disclosed

- `hyg_od_enabled` stored as an empty map `{}` (platform side) cannot be held
  by `office_setting`; it now reads "no rows" → the floor. The floor is `false`
  for both carein offices, so the answer is identical; pinned (with the full
  before/after snapshot) by `platform/officeSettingsCareinSnapshot.test.js`.
- `officeState(...).updatedAt / updatedBy` now report the OFFICE's own row, not
  the whole map's last write.
- The office-keyed `CHECK (office_id IN ('roland','valley'))` constraints in the
  tenant tables are untouched (MT-2b2).

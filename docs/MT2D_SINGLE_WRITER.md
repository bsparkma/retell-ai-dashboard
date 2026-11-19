# MT-2d — single writer: the ten per-office settings write `office_setting` only

**Status:** `office_setting(tenant, office, key)` is the only table the ten
per-office settings are written to and served from. `platform_setting` keeps its
three global keys (`tc_email_enabled`, `tc_sms_enabled`, `call_retention_days`),
unchanged. Builds on [MT2A_OFFICE_SETTINGS.md](MT2A_OFFICE_SETTINGS.md) (the
dual-write) and [MT2B_SERVE_OFFICE_SETTINGS.md](MT2B_SERVE_OFFICE_SETTINGS.md)
(serving `office_setting`).

## What changed

| | MT-2a / MT-2b | MT-2d |
| --- | --- | --- |
| A console / route write | read the whole `platform_setting` map, change one office, write the map AND mirror every office of it into `office_setting` (deleting rows not in the map), one transaction | `registry.setOfficeSetting(tenant, office, key, value, by)`: upsert **one** `office_setting` row, read it back, one transaction |
| The other office's row | rewritten from the `platform_setting` map on every write | never read, rewritten or deleted |
| `platform_setting` rows for the ten keys | written on every change | **inert history**: left in place, never read, never written. No migration, no deletes |
| `registry.setPlatformSetting(<one of the ten>)` | the dual-write | refused, `OFFICE_SETTING_NOT_PLATFORM` |
| Parity tripwire ("office settings parity …" log lines) | compared the two tables after every read | **retired** (module, boot arming and log lines removed). The office *registry* tripwire is untouched |
| Readers, env break-glass (`=false`), carein-only `=true` fallback | — | **unchanged** (no reader code changed) |
| Writes for a tenant other than `carein` | refused `OFFICE_SETTING_TENANT_NOT_WRITABLE` | still refused — unchanged; opening them is a separate decision |

A same-value write still re-stamps its row's `updated_by` / `updated_at`
("reaffirmed today"). A write for an office with no `office` row (a bare local
database) writes nothing and warns once, as before.

## Runbook writes (nurture, opportunities have no route) — REPLACES the MT-2a recipe

Write the one `office_setting` row. Do **not** write `platform_setting`: nothing
reads it.

```sql
INSERT INTO office_setting (tenant_id, office_key, setting_key, value, updated_by)
     SELECT t.tenant_id, 'roland', 'tc_nurture_enabled', 'true'::jsonb, '<your email>'
       FROM tenant t WHERE t.slug = 'carein'
ON CONFLICT (tenant_id, office_key, setting_key) DO UPDATE
        SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now();
```

The readers pick it up within one refresh window (5 min), or at once on the next
console save.

## Rollback — read before reverting

Reverting MT-2d alone restores the MT-2a dual-write, whose writes **read the
`platform_setting` map and mirror every office of it into `office_setting`**.
After MT-2d has been live, that map is stale for every office changed since.
So the first save after a revert would copy the stale value of the *other*
office back over its correct `office_setting` row.

Before reverting, re-sync `platform_setting` from `office_setting` for the ten
keys (carein's rows), or revert MT-2b and MT-2d together only after the same
re-sync. There is no longer a "source flip" rollback with no data step.

## Tests

- `backend/platform/officeSettingsSingleWriter.test.js` — every write route
  writes one row, `platform_setting` is never touched (no statement issued),
  the other office keeps value and provenance, failures roll back, break-glass
  pins on top of a console write, `setPlatformSetting` refuses the ten keys.
- `backend/platform/officeSettingsParityRetired.test.js` — the tripwire stays gone.
- `backend/scripts/office-settings-verify-queries.js` Part C — the same against
  real Postgres in CI.

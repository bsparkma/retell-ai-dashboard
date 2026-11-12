# MT-2a — per-office settings in `office_setting` (dark)

**Status:** dark. `platform_setting` is still what every reader serves. MT-2a only
dual-writes and compares.

## What moved

Ten per-office keys now also live in the control-plane table `office_setting`
(PK `(tenant_id, office_key, setting_key)`, FK to `office`):

| Key | Reader | Absence rule the parity check uses |
| --- | --- | --- |
| `tc_checkout_enabled`, `tc_od_sync_enabled`, `tc_auto_checkout_enabled`, `tc_referrals_enabled`, `tc_referral_email_enabled`, `tc_referral_patient_email_enabled` | `config/tcOfficeSwitch.js` | no row = nobody chose (null) |
| `hyg_od_enabled` | `config/hygPilot.js` | any row for the tenant ⇒ a missing office is `false`; no rows = null |
| `tc_nurture_enabled`, `tc_opportunities_sync` | `config/tcNurture.js`, `config/tcOpportunities.js` | ON only for a literal `true` |
| `tc_email_identity` | `config/emailIdentity.js` | the four normalized fields, each or null |

`tc_email_enabled`, `tc_sms_enabled` and `call_retention_days` stay global in
`platform_setting`. `platform_setting` is not altered.

## Migrations (control plane)

- `1789600000000_office_setting.js` — the table, closed `setting_key` vocabulary,
  value-shape CHECK. No `carein_app` grant.
- `1789600000001_backfill_office_setting.js` — copies tenant `carein`'s honoured
  entries only (frozen copy of each reader's validation). Values are bound
  parameters, never printed by the migrator.

## Dual-write

`registry.setPlatformSetting(key, …)` for any of the ten keys writes
`platform_setting` and mirrors the map into `office_setting` in **one**
transaction, reads both back, and throws `OFFICE_SETTING_READBACK_MISMATCH`
(→ 500, both rolled back) on any difference. Every console/route write goes
through it.

### Runbook writes (nurture, opportunities have no route)

A raw `INSERT INTO platform_setting` bypasses the dual-write, and the parity
tripwire will (correctly) warn. Write both, in one transaction:

```sql
BEGIN;
INSERT INTO platform_setting (key, value, updated_by)
     VALUES ('tc_nurture_enabled', '{"roland": true}'::jsonb, '<your email>')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now();
INSERT INTO office_setting (tenant_id, office_key, setting_key, value, updated_by)
     SELECT t.tenant_id, 'roland', 'tc_nurture_enabled', 'true'::jsonb, '<your email>'
       FROM tenant t WHERE t.slug = 'carein'
ON CONFLICT (tenant_id, office_key, setting_key) DO UPDATE
        SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now();
COMMIT;
```

## Parity tripwire

Armed in `server.js` at boot. Each reader, after a successful `platform_setting`
read, compares with `office_setting` (confirming against a fresh read first):

- drift: `office settings parity: '<key>' for '<office>' differs — … Serving platform_setting (MT-2a).` — once per (key, office) per process;
- clean (all ten): `office settings parity OK — 2 office(s), 10 setting(s)` — once per process.

`tc_email_identity` drift names field names only, never values.

### Known, disclosed divergence

A `hyg_od_enabled` row that is a map with **no** valid entry (e.g. `{}`) reads
`false` for every office from `platform_setting`, while `office_setting` holds
no row (null). The effective answer is identical (the hardcoded floor is
`false`), but the tripwire reports it. Pinned in
`backend/platform/officeSettingsSeed.test.js`.

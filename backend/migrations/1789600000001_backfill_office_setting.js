'use strict';

/**
 * Backfill office_setting from platform_setting, for tenant 'carein' (MT-2a).
 *
 * Paired with 1789600000000_office_setting.js, the way 1789500000000 seeds the
 * table 1789400000000 creates.
 *
 * WHAT IS COPIED. For each of the ten per-office keys, each per-office entry of
 * the stored map becomes one row, but ONLY when
 *   - the office is an existing `office` row of tenant 'carein', and
 *   - the value already passes THAT KEY'S READER'S OWN VALIDATION today.
 * Anything the reader ignores is NOT copied: a junk office key, a non-boolean
 * switch value, a map that is not a map, an identity field the reader would
 * drop. Copying an ignored entry would make office_setting answer where
 * platform_setting does not, which is the exact drift the parity tripwire
 * exists to catch.
 *
 * THE VALIDATION IS A FROZEN COPY of the readers as of this migration
 * (config/tcOfficeSwitch.js, config/hygPilot.js, config/tcNurture.js,
 * config/tcOpportunities.js, config/emailIdentity.js normalizeField), written
 * out here ON PURPOSE: a migration that required the live config would
 * silently change what it copies the next time a reader changed. Drift is
 * caught by platform/officeSettingsSeed.test.js, which runs planBackfill()
 * below against the LIVE readers on a fixture full of ignorable entries.
 *
 * platform_setting IS NEVER MODIFIED. It is only read.
 *
 * NO VALUE IS EVER PRINTED. tc_email_identity holds email addresses and
 * practice names, and node-pg-migrate prints every QUEUED statement at debug
 * level. So nothing here is queued with pgm.sql: the rows are read and written
 * with pgm.db.query and bound parameters, inside the runner's single
 * transaction (scripts/migrate.js singleTransaction: true), where the error
 * path prints the statement text only, never the parameters.
 *
 * updated_by is NULL (written by a migration) and updated_at is now(). The
 * platform row's provenance is NOT copied: it is per KEY, and stamping valley's
 * row with whoever last flipped roland would be a claim about a person that is
 * not true.
 *
 * IDEMPOTENT AND ABSENT-TENANT SAFE. ON CONFLICT DO NOTHING; no 'carein' tenant
 * or no office rows means nothing is copied rather than an error. down()
 * deletes tenant 'carein's rows for the ten keys.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

const TENANT_SLUG = 'carein';

/** The real offices as of this migration (config/officeAgents.js OFFICES minus 'unknown'). */
const REAL_OFFICES = Object.freeze(['roland', 'valley']);

/** The nine boolean per-office keys. */
const SWITCH_KEYS = Object.freeze([
  'tc_checkout_enabled',
  'tc_od_sync_enabled',
  'tc_auto_checkout_enabled',
  'tc_referrals_enabled',
  'tc_referral_email_enabled',
  'tc_referral_patient_email_enabled',
  'hyg_od_enabled',
  'tc_nurture_enabled',
  'tc_opportunities_sync',
]);

const IDENTITY_KEY = 'tc_email_identity';

/** emailIdentity's stored fields and caps, frozen. */
const IDENTITY_FIELD_MAX = Object.freeze({
  replyTo: 254,
  practiceName: 120,
  practicePhone: 40,
  referralBcc: 254,
});
const IDENTITY_EMAIL_FIELDS = Object.freeze(['replyTo', 'referralBcc']);

/** @param {unknown} v */
function isMap(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** emailIdentity.isEmailAddress, frozen. @param {string} v */
function isEmailAddress(v) {
  return v.length <= 254 && /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/.test(v);
}

/**
 * emailIdentity.normalizeField, frozen: a usable stored value, or null.
 * @param {string} field
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizeIdentityField(field, raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  const max = IDENTITY_FIELD_MAX[/** @type {keyof typeof IDENTITY_FIELD_MAX} */ (field)];
  if (!v || v.length > max) return null;
  if (/[\u0000-\u001f\u007f]/.test(v)) return null;
  if (IDENTITY_EMAIL_FIELDS.includes(field)) return isEmailAddress(v) ? v.toLowerCase() : null;
  return v;
}

/**
 * The rows the backfill writes. PURE: no database, no logging.
 *
 * @param {ReadonlyArray<{ key: string, value: unknown }>} platformRows
 * @param {ReadonlySet<string>|ReadonlyArray<string>} existingOffices office_key of tenant 'carein's office rows
 * @returns {Array<{ office_key: string, setting_key: string, value: boolean | Record<string, string> }>}
 */
function planBackfill(platformRows, existingOffices) {
  const present = new Set(existingOffices);
  /** @type {Array<{ office_key: string, setting_key: string, value: boolean | Record<string, string> }>} */
  const out = [];
  for (const row of platformRows) {
    if (!row || !isMap(row.value)) continue;
    const isSwitch = SWITCH_KEYS.includes(row.key);
    if (!isSwitch && row.key !== IDENTITY_KEY) continue;
    for (const [office, raw] of Object.entries(/** @type {Record<string, unknown>} */ (row.value))) {
      if (!REAL_OFFICES.includes(office) || !present.has(office)) continue;
      if (isSwitch) {
        if (typeof raw !== 'boolean') continue;
        out.push({ office_key: office, setting_key: row.key, value: raw });
        continue;
      }
      if (!isMap(raw)) continue;
      /** @type {Record<string, string>} */
      const identity = {};
      for (const [field, v] of Object.entries(/** @type {Record<string, unknown>} */ (raw))) {
        if (!Object.prototype.hasOwnProperty.call(IDENTITY_FIELD_MAX, field) || v === null) continue;
        const clean = normalizeIdentityField(field, v);
        if (clean !== null) identity[field] = clean;
      }
      out.push({ office_key: office, setting_key: row.key, value: identity });
    }
  }
  return out;
}

const ALL_KEYS = Object.freeze([...SWITCH_KEYS, IDENTITY_KEY]);

/**
 * Run the backfill with a query function (pgm.db.query, or a pg client's query
 * in scripts/office-settings-verify-queries.js).
 * @param {(text: string, params?: unknown[]) => Promise<{ rows: any[] }>} query
 * @returns {Promise<number>} rows inserted
 */
async function backfill(query) {
  const tenant = await query('SELECT tenant_id FROM tenant WHERE slug = $1', [TENANT_SLUG]);
  if (!tenant.rows[0]) return 0;
  const tenantId = tenant.rows[0].tenant_id;

  const offices = await query('SELECT office_key FROM office WHERE tenant_id = $1', [tenantId]);
  const settings = await query('SELECT key, value FROM platform_setting WHERE key = ANY($1::text[])', [
    ALL_KEYS,
  ]);

  const rows = planBackfill(
    settings.rows,
    offices.rows.map((r) => r.office_key)
  );
  let inserted = 0;
  for (const r of rows) {
    const res = await query(
      `INSERT INTO office_setting (tenant_id, office_key, setting_key, value, updated_by)
            VALUES ($1, $2, $3, $4::jsonb, NULL)
       ON CONFLICT (tenant_id, office_key, setting_key) DO NOTHING`,
      [tenantId, r.office_key, r.setting_key, JSON.stringify(r.value)]
    );
    inserted += res.rowCount || 0;
  }
  return inserted;
}

/**
 * @param {MigrationBuilder} pgm
 * @returns {Promise<void>}
 */
exports.up = async (pgm) => {
  await backfill((text, params) => pgm.db.query(text, params));
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {Promise<void>}
 */
exports.down = async (pgm) => {
  await pgm.db.query(
    `DELETE FROM office_setting s
      USING tenant t
      WHERE s.tenant_id = t.tenant_id
        AND t.slug = $1
        AND s.setting_key = ANY($2::text[])`,
    [TENANT_SLUG, ALL_KEYS]
  );
};

exports.TENANT_SLUG = TENANT_SLUG;
exports.REAL_OFFICES = REAL_OFFICES;
exports.SWITCH_KEYS = SWITCH_KEYS;
exports.IDENTITY_KEY = IDENTITY_KEY;
exports.ALL_KEYS = ALL_KEYS;
exports.planBackfill = planBackfill;
exports.backfill = backfill;

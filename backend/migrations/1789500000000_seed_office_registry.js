'use strict';

/**
 * Seed tenant 'carein's two offices into the office registry (MT-1a).
 *
 * THE VALUES ARE A FROZEN COPY OF THE CODE MAPS AS OF THIS MIGRATION:
 * config/officeAgents.js (OFFICES labels and order, AGENT_OFFICE, MANGO_LINE_OFFICE)
 * and config/odOffices.js (OFFICE_OD_SETTINGS). They were generated from those
 * maps and written out here as literals ON PURPOSE. A migration that require()d
 * the live config would silently rewrite its own history the next time a map
 * changed, and an already-applied migration never runs again anyway.
 *
 * Drift is caught by platform/officeRegistry.test.js, which pins SEED_OFFICES
 * against the code maps field for field. If you change a code map, that test
 * goes red and tells you the registry needs a migration too.
 *
 * Only Key Vault secret NAMES and env var NAMES appear here, never a value.
 * The DIDs are the offices' own public phone lines, not patient numbers.
 *
 * NOT SEEDED: the 'unknown' bucket. It is code-only, and the schema refuses it.
 *
 * IDEMPOTENT AND ABSENT-TENANT SAFE. Rows are inserted by tenant SLUG with
 * ON CONFLICT DO NOTHING, so a re-run changes nothing and an environment with
 * no 'carein' tenant gets no rows rather than an error. down() deletes only the
 * keys this migration seeds, for that tenant.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

const TENANT_SLUG = 'carein';

/**
 * @typedef {Object} SeedOffice
 * @property {string} office_key
 * @property {string} display_name
 * @property {number} sort_order
 * @property {string[]} retell_agent_ids
 * @property {string[]} mango_dids
 * @property {string} od_customer_key_secret
 * @property {string} od_customer_key_env
 * @property {{ call: number|null, referral: number|null }} commtype_defnums
 * @property {boolean} od_enabled
 * @property {boolean} hyg_od_enabled
 * @property {'active'|'disabled'} status
 */

/** @type {ReadonlyArray<SeedOffice>} */
const SEED_OFFICES = Object.freeze([
  {
    office_key: 'roland',
    display_name: 'Roland',
    sort_order: 1,
    retell_agent_ids: [
      'agent_3a7042b50e7c4775cd350f02b4',
      'agent_d1f762efc57db01475ad0579e8',
      'agent_063d7e3077f6dc708c54a19d20',
      'agent_89e8a68788e925aa506475393e',
      'agent_3007741dd93381f51675417edb',
      'agent_fab86b38f60a3561b16831bea8',
      'agent_4a553eece68d214e364e85d4d4',
      'agent_ace28f92effcafe7254c004713',
      'agent_8494abf7556bfd9a4cf231a1a1',
    ],
    mango_dids: ['+19189134595', '+19185036262', '+19183930353'],
    od_customer_key_secret: 'opendental-customer-key',
    od_customer_key_env: 'OPENDENTAL_CUSTOMER_KEY',
    commtype_defnums: { call: 486, referral: 491 },
    od_enabled: true,
    hyg_od_enabled: false,
    status: 'active',
  },
  {
    // Internal key 'valley' IS the Fort Smith "Riley" office; the key is frozen.
    office_key: 'valley',
    display_name: 'Valley Fort Smith',
    sort_order: 2,
    // No Retell agent is mapped to valley in code today.
    retell_agent_ids: [],
    mango_dids: ['+14797854390', '+14793166111', '+14797851419', '+14792263500', '+14797633344'],
    od_customer_key_secret: 'opendental-customer-key-valley',
    od_customer_key_env: 'OPENDENTAL_CUSTOMER_KEY_VALLEY',
    commtype_defnums: { call: 451, referral: 452 },
    od_enabled: true,
    hyg_od_enabled: false,
    status: 'active',
  },
]);

/**
 * Quote a value as a SQL literal. Every value here is a constant in this file;
 * nothing from a request or the environment reaches this function.
 * @param {string} value
 * @returns {string}
 */
function lit(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  for (const o of SEED_OFFICES) {
    pgm.sql(`
      INSERT INTO office (
        tenant_id, office_key, display_name, sort_order, retell_agent_ids, mango_dids,
        od_customer_key_secret, od_customer_key_env, commtype_defnums,
        od_enabled, hyg_od_enabled, status
      )
      SELECT t.tenant_id, ${lit(o.office_key)}, ${lit(o.display_name)}, ${Number(o.sort_order)},
             ${lit(JSON.stringify(o.retell_agent_ids))}::jsonb,
             ${lit(JSON.stringify(o.mango_dids))}::jsonb,
             ${lit(o.od_customer_key_secret)}, ${lit(o.od_customer_key_env)},
             ${lit(JSON.stringify(o.commtype_defnums))}::jsonb,
             ${o.od_enabled ? 'true' : 'false'}, ${o.hyg_od_enabled ? 'true' : 'false'},
             ${lit(o.status)}
        FROM tenant t
       WHERE t.slug = ${lit(TENANT_SLUG)}
      ON CONFLICT (tenant_id, office_key) DO NOTHING;
    `);
  }
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  const keys = SEED_OFFICES.map((o) => lit(o.office_key)).join(', ');
  pgm.sql(`
    DELETE FROM office o
     USING tenant t
     WHERE o.tenant_id = t.tenant_id
       AND t.slug = ${lit(TENANT_SLUG)}
       AND o.office_key IN (${keys});
  `);
};

exports.SEED_OFFICES = SEED_OFFICES;
exports.TENANT_SLUG = TENANT_SLUG;

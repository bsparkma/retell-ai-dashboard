'use strict';

/**
 * Rename module id 'carein' → 'voice' and pin the module id vocabulary.
 *
 * "carein" was the Phase 1 name for the voice product's tenant_module row.
 * With the second module (tc) arriving, module ids become product names:
 *
 *   voice       — the CareIN voice agent dashboard (formerly 'carein')
 *   rcm         — AR / RCM agent
 *   tc          — Treatment Coordinator
 *   scheduling  — native scheduling (decided future paid add-on; included in
 *                 the CHECK today so enabling it later needs no migration)
 *
 * The rename is a MERGE, not a bare UPDATE: on environments whose seed already
 * inserted 'voice' (fresh installs after this change), a bare UPDATE would
 * collide with the (tenant_id, module) primary key. INSERT..SELECT..ON CONFLICT
 * folds 'carein' into any existing 'voice' row (enabled wins over disabled),
 * then the old row is deleted. Idempotent: re-running with no 'carein' rows is
 * a no-op.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

const CONSTRAINT = 'tenant_module_module_check';

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.sql(`
    INSERT INTO tenant_module (tenant_id, module, enabled)
    SELECT tenant_id, 'voice', enabled
      FROM tenant_module
     WHERE module = 'carein'
    ON CONFLICT (tenant_id, module)
      DO UPDATE SET enabled = tenant_module.enabled OR EXCLUDED.enabled;
  `);
  pgm.sql(`DELETE FROM tenant_module WHERE module = 'carein';`);

  pgm.addConstraint('tenant_module', CONSTRAINT, {
    check: "module IN ('voice', 'rcm', 'tc', 'scheduling')",
  });
};

/**
 * Reverse: drop the vocabulary CHECK, fold 'voice' back into 'carein'.
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropConstraint('tenant_module', CONSTRAINT);

  pgm.sql(`
    INSERT INTO tenant_module (tenant_id, module, enabled)
    SELECT tenant_id, 'carein', enabled
      FROM tenant_module
     WHERE module = 'voice'
    ON CONFLICT (tenant_id, module)
      DO UPDATE SET enabled = tenant_module.enabled OR EXCLUDED.enabled;
  `);
  pgm.sql(`DELETE FROM tenant_module WHERE module = 'voice';`);
};

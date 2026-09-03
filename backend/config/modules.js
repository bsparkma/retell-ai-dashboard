'use strict';

/**
 * The module namespaces — the ONE place the product catalog is written down.
 *
 * Until now this list existed in three places that could disagree, and two of
 * them did: the DB CHECK constraint
 * (migrations/1785369600000_rename_module_carein_to_voice.js:46), a JSDoc line
 * in middleware/tenantContext.js, and `MODULES` in platform/provisionTenant.js
 * — which still named the PRE-RENAME 'carein' namespace and would therefore
 * have been rejected by the CHECK on the next tenant provisioned. Naming the
 * set once is what stops the platform console rendering a toggle for a module
 * the database will refuse to store.
 *
 * ADDING A MODULE IS A MIGRATION, NOT AN EDIT HERE. The CHECK constraint is the
 * real gate; this list must be widened in the same PR as the migration that
 * widens it, never ahead of one. `hyg` arrived that way: catalog entry below,
 * migrations/1788100000000_module_hyg.js, one commit.
 *
 * modules.test.js reads the EFFECTIVE constraint out of the migration sources
 * (the last one that defines it wins, exactly as Postgres sees it) rather than
 * out of one named file, so the next module widens the vocabulary in a new
 * migration without having to edit the old one.
 *
 * Order is display order: the console renders them in this sequence.
 */

/** @typedef {'voice'|'rcm'|'tc'|'hyg'|'scheduling'} ModuleName */

/**
 * @type {ReadonlyArray<{ module: ModuleName, label: string, blurb: string }>}
 */
const MODULE_CATALOG = Object.freeze([
  Object.freeze({
    module: 'voice',
    label: 'Voice',
    blurb: 'Call worklist, transcription, and chart notes',
  }),
  Object.freeze({
    module: 'tc',
    label: 'Treatment Coordinator',
    blurb: 'Case pipeline, presentations, hygiene handoff',
  }),
  Object.freeze({
    module: 'hyg',
    label: 'Hygiene',
    blurb: 'Hygiene day view, routing slip, and the handoff to TC',
  }),
  Object.freeze({
    module: 'rcm',
    label: 'RCM',
    blurb: 'Claims, denials, and AR recovery',
  }),
  Object.freeze({
    module: 'scheduling',
    label: 'Scheduling',
    blurb: 'Native scheduling (not yet built)',
  }),
]);

/** Just the names, in display order. @type {ReadonlyArray<ModuleName>} */
const MODULE_NAMES = Object.freeze(MODULE_CATALOG.map((m) => m.module));

/**
 * Is `name` a module this platform knows about?
 *
 * Total and fail-closed: a non-string, an empty string and an unknown name all
 * answer false, so a route validating a `:module` path param with this can only
 * ever narrow what reaches the database.
 *
 * @param {unknown} name
 * @returns {boolean}
 */
function isKnownModule(name) {
  return typeof name === 'string' && MODULE_NAMES.includes(/** @type {ModuleName} */ (name));
}

module.exports = { MODULE_CATALOG, MODULE_NAMES, isKnownModule };

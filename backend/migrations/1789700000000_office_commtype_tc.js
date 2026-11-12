'use strict';

/**
 * AT-2: a third commlog-type member in the office registry — `tc`, the
 * "CareIN TC" commlog type a TC activity-feed item is charted with.
 *
 * office.commtype_defnums goes from exactly {call, referral} to exactly
 * {call, referral, tc}. Same rules as the two members it joins: a positive
 * integer or JSON null, null = UNCONFIGURED (the reader refuses that write and
 * never falls back to another type or another office's number).
 *
 * THE VALUES ARE A FROZEN LITERAL, read live from each practice's Open Dental
 * on 2026-11-12 (GET /definitions?Category=27, includeHidden=true — exactly one
 * visible "CareIN TC" in each):
 *
 *     roland   "CareIN TC" = 492     (call 486, referral 491)
 *     valley   "CareIN TC" = 453     (call 451, referral 452)
 *
 * They equal config/odOffices.js's defaultTcCommTypeDefNum, and
 * platform/officeRegistry.test.js pins that (seed + this patch == code maps).
 * Written out here rather than require()d for the same reason as the seed
 * (1789500000000): an applied migration must not rewrite its own history when
 * a code map changes later.
 *
 * ORDER MATTERS in up(): the old CHECK refuses a third key, so it is dropped
 * first; every row then gains `tc` (null, so no tenant is silently configured);
 * tenant 'carein's two offices get the verified numbers; THEN the new CHECK is
 * added, so it validates every existing row. The column default gains the
 * member too, so a row inserted later is shaped right without naming it.
 *
 * down() is the exact reverse: the 3-member CHECK is dropped, the member is
 * removed from every row, the 2-member CHECK and default are restored. Rows
 * written before up() are byte-for-byte what they were.
 *
 * Absent-tenant safe: with no 'carein' tenant the UPDATE matches nothing.
 *
 * @typedef {import('node-pg-migrate').MigrationBuilder} MigrationBuilder
 */

/** @type {Record<string, string> | undefined} */
exports.shorthands = undefined;

const TENANT_SLUG = 'carein';

/** The verified "CareIN TC" DefNum per office of tenant 'carein'. Frozen literal. */
const TC_DEFNUMS = Object.freeze({ roland: 492, valley: 453 });

/** A DefNum member: JSON null, or a positive integer with no sign, decimal or exponent. */
function memberCheck(key) {
  return `(jsonb_typeof(commtype_defnums->'${key}') = 'null'
           OR (jsonb_typeof(commtype_defnums->'${key}') = 'number'
               AND (commtype_defnums->>'${key}') ~ '^[1-9][0-9]*$'))`;
}

/**
 * "Exactly these keys, each a DefNum or null". No subquery: Postgres refuses
 * one in a CHECK. Subtracting the known keys and requiring {} is the same test.
 * @param {string[]} keys
 */
function shapeCheck(keys) {
  return `
    jsonb_typeof(commtype_defnums) = 'object'
    AND commtype_defnums ?& ARRAY[${keys.map((k) => `'${k}'`).join(', ')}]
    AND (commtype_defnums${keys.map((k) => ` - '${k}'`).join('')}) = '{}'::jsonb
    AND ${keys.map(memberCheck).join('\n    AND ')}
  `;
}

const SHAPE = 'office_commtype_defnums_shape';
const KEYS_V1 = ['call', 'referral'];
const KEYS_V2 = ['call', 'referral', 'tc'];

/**
 * TESTS ONLY: the seed rows (1789500000000) as they read after this migration —
 * what the registry holds for tenant 'carein' once both have run.
 * @template {{ office_key: string, commtype_defnums: Record<string, number|null> }} T
 * @param {ReadonlyArray<T>} seedRows
 * @returns {T[]}
 */
function applyToSeed(seedRows) {
  return seedRows.map((r) => ({
    ...r,
    commtype_defnums: {
      ...r.commtype_defnums,
      tc: Object.prototype.hasOwnProperty.call(TC_DEFNUMS, r.office_key)
        ? TC_DEFNUMS[/** @type {keyof typeof TC_DEFNUMS} */ (r.office_key)]
        : null,
    },
  }));
}

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.up = (pgm) => {
  pgm.dropConstraint('office', SHAPE);
  pgm.sql(`UPDATE office SET commtype_defnums = commtype_defnums || '{"tc": null}'::jsonb;`);
  for (const [officeKey, defNum] of Object.entries(TC_DEFNUMS)) {
    pgm.sql(`
      UPDATE office o
         SET commtype_defnums = jsonb_set(o.commtype_defnums, '{tc}', '${Number(defNum)}'::jsonb)
        FROM tenant t
       WHERE o.tenant_id = t.tenant_id
         AND t.slug = '${TENANT_SLUG}'
         AND o.office_key = '${officeKey}';
    `);
  }
  pgm.addConstraint('office', SHAPE, { check: shapeCheck(KEYS_V2) });
  pgm.alterColumn('office', 'commtype_defnums', {
    default: pgm.func(`'{"call": null, "referral": null, "tc": null}'::jsonb`),
  });
};

/**
 * @param {MigrationBuilder} pgm
 * @returns {void}
 */
exports.down = (pgm) => {
  pgm.dropConstraint('office', SHAPE);
  pgm.sql(`UPDATE office SET commtype_defnums = commtype_defnums - 'tc';`);
  pgm.addConstraint('office', SHAPE, { check: shapeCheck(KEYS_V1) });
  pgm.alterColumn('office', 'commtype_defnums', {
    default: pgm.func(`'{"call": null, "referral": null}'::jsonb`),
  });
};

exports.TC_DEFNUMS = TC_DEFNUMS;
exports.TENANT_SLUG = TENANT_SLUG;
exports.applyToSeed = applyToSeed;
exports.shapeCheck = shapeCheck;

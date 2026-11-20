'use strict';

/**
 * tc_email_library_profile — one office's saved wording answers (EL-1).
 *
 * One row per office (office_id is the primary key). A save REPLACES the whole
 * answers object; there is no per-key merge, so what the page shows after a
 * save is exactly what was sent (after validation) and nothing older survives
 * in it.
 *
 * Every function takes a pg client (or Pool) the caller already holds, so the
 * route can run the upsert and its read-back inside ONE tenant transaction, and
 * scripts/tc-email-library-verify-queries.js can run these same statements
 * against the real migrated schema. Office-scoped by construction: every
 * statement filters or keys on office_id.
 *
 * No Open Dental, no messaging, no patient data: the answers are an office's
 * wording choices (which technology it has, its scheduling link, ...).
 */

const TABLE = 'tc_email_library_profile';

/** Named columns, never SELECT *. */
const READ_SQL = `SELECT office_id, answers, library_version, updated_by, updated_at FROM ${TABLE} WHERE office_id = $1`;

const UPSERT_SQL = `INSERT INTO ${TABLE} (office_id, answers, library_version, updated_by) VALUES ($1, $2, $3, $4) ON CONFLICT (office_id) DO UPDATE SET answers = EXCLUDED.answers, library_version = EXCLUDED.library_version, updated_by = EXCLUDED.updated_by, updated_at = now() RETURNING office_id`;

/**
 * @typedef {{ office: string, answers: Record<string, unknown>, libraryVersion: string, updatedBy: string, updatedAt: Date|string|null }} StoredProfile
 */

/**
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 * @param {string} office
 * @returns {Promise<StoredProfile|null>}
 */
async function readProfile(db, office) {
  const { rows } = await db.query(READ_SQL, [office]);
  const row = rows[0];
  if (!row) return null;
  return {
    office: row.office_id,
    answers: row.answers,
    libraryVersion: row.library_version,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at ?? null,
  };
}

/**
 * Replace the office's answers. The caller validates first and reads back after.
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 * @param {{ office: string, answers: Record<string, unknown>, libraryVersion: string, updatedBy: string }} p
 */
async function upsertProfile(db, { office, answers, libraryVersion, updatedBy }) {
  await db.query(UPSERT_SQL, [office, JSON.stringify(answers), libraryVersion, updatedBy]);
}

/**
 * Key-order-insensitive equality for two answers objects (jsonb does not keep
 * key order; arrays keep theirs, and the order of a list answer matters to
 * nobody but is compared exactly anyway).
 * @param {unknown} a
 * @param {unknown} b
 */
function sameAnswers(a, b) {
  return canonical(a) === canonical(b);
}

/** @param {unknown} v @returns {string} */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = /** @type {Record<string, unknown>} */ (v);
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

module.exports = { TABLE, READ_SQL, UPSERT_SQL, readProfile, upsertProfile, sameAnswers };

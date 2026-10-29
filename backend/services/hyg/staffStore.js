'use strict';

/**
 * hyg_staff in Postgres — every statement the Practice staff page and the note
 * composer run against it.
 *
 * Same rule as visitStore.js: every WHERE clause names `office`. An id from one
 * office's page can never read or change a row of the other office, because the
 * office in the clause is the route's validated one, not the row's.
 *
 * NO DELETE. A person leaves by `active = false` (see the migration's note 3).
 *
 * SIGN-IN IDS ARE UNIQUE PER OFFICE, across active and inactive rows alike. The
 * insert and the update refuse an overlap in the same statement that writes,
 * and the table's trigger is the backstop for two saves racing (its 23505 is
 * mapped to the same refusal here). Either way the caller gets SIGN_IN_TAKEN
 * with the ids that collided — ids the office manager typed, never another
 * person's name.
 *
 * Staff, not patients: nothing here is PHI.
 */

const COLUMNS = `id, office, full_name, license, sign_in_ids, active,
                 created_by, created_at, updated_by, updated_at`;

/** Hygienists print with this credential. Doctors are not in this table. */
const CREDENTIAL = 'RDH';

/** The trigger's constraint name, so only ITS 23505 is read as a collision. */
const UNIQUE_CONSTRAINT = 'hyg_staff_sign_in_ids_unique';

function iso(value) {
  if (value instanceof Date) return value.toISOString();
  return value === null || value === undefined ? '' : String(value);
}

function idsOf(value) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
}

/** A row as the API answers with it (HygStaffSchema). Never a raw row. */
function toStaff(row) {
  return {
    id: String(row.id),
    office: row.office,
    fullName: row.full_name,
    license: row.license === null || row.license === undefined ? null : String(row.license),
    signInIds: idsOf(row.sign_in_ids),
    active: row.active === true,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedBy: row.updated_by,
    updatedAt: iso(row.updated_at),
  };
}

function isCollision(err) {
  return Boolean(err && err.code === '23505' && err.constraint === UNIQUE_CONSTRAINT);
}

/**
 * Every row of this office, active first.
 * @param {{ query: Function }} pool
 * @param {string} office
 */
async function listForOffice(pool, office) {
  const res = await pool.query(
    `SELECT ${COLUMNS}
       FROM hyg_staff
      WHERE office = $1
      ORDER BY active DESC, lower(full_name), created_at`,
    [office]
  );
  return res.rows.map(toStaff);
}

/**
 * One row, or null. `id` must already be a validated uuid.
 * @param {{ query: Function }} pool
 * @param {{ office: string, id: string }} args
 */
async function getById(pool, { office, id }) {
  const res = await pool.query(
    `SELECT ${COLUMNS}
       FROM hyg_staff
      WHERE office = $1 AND id = $2`,
    [office, id]
  );
  return res.rows[0] ? toStaff(res.rows[0]) : null;
}

/**
 * Which of `signInIds` another row of this office already holds.
 * @param {{ query: Function }} pool
 * @param {{ office: string, exceptId: string|null, signInIds: string[] }} args
 */
async function takenSignInIds(pool, { office, exceptId, signInIds }) {
  const res = await pool.query(
    `SELECT sign_in_ids
       FROM hyg_staff
      WHERE office = $1 AND id IS DISTINCT FROM $2::uuid AND sign_in_ids ?| $3::text[]`,
    [office, exceptId, signInIds]
  );
  const held = new Set(res.rows.flatMap((r) => idsOf(r.sign_in_ids)));
  return signInIds.filter((id) => held.has(id));
}

async function collision(pool, office, exceptId, signInIds) {
  return {
    ok: false,
    code: 'SIGN_IN_TAKEN',
    taken: await takenSignInIds(pool, { office, exceptId, signInIds }),
  };
}

/**
 * Add a person. Returns the row AS READ BACK, so a success is a row that exists.
 *
 * @param {{ query: Function }} pool
 * @param {{ office: string, input: { fullName: string, license: string|null, signInIds: string[] }, actor: string }} args
 * @returns {Promise<{ ok: true, staff: ReturnType<typeof toStaff> }
 *   | { ok: false, code: 'SIGN_IN_TAKEN', taken: string[] }
 *   | { ok: false, code: 'NOT_CONFIRMED' }>}
 */
async function create(pool, { office, input, actor }) {
  let res;
  try {
    res = await pool.query(
      `INSERT INTO hyg_staff (office, full_name, license, sign_in_ids, created_by, updated_by)
       SELECT $1, $2, $3, $4::jsonb, $5, $5
        WHERE NOT EXISTS (
          SELECT 1 FROM hyg_staff
           WHERE office = $1 AND sign_in_ids ?| ARRAY(SELECT jsonb_array_elements_text($4::jsonb))
        )
       RETURNING id`,
      [office, input.fullName, input.license, JSON.stringify(input.signInIds), actor]
    );
  } catch (err) {
    if (isCollision(err)) return collision(pool, office, null, input.signInIds);
    throw err;
  }
  if (res.rows.length === 0) return collision(pool, office, null, input.signInIds);
  const staff = await getById(pool, { office, id: String(res.rows[0].id) });
  return staff ? { ok: true, staff } : { ok: false, code: 'NOT_CONFIRMED' };
}

/**
 * Change the three typed fields. `prior` is what the row was, for the audit's
 * "what changed".
 *
 * @param {{ query: Function }} pool
 * @param {{ office: string, id: string, input: { fullName: string, license: string|null, signInIds: string[] }, actor: string }} args
 */
async function update(pool, { office, id, input, actor }) {
  const prior = await getById(pool, { office, id });
  if (!prior) return { ok: false, code: 'NOT_FOUND' };
  let res;
  try {
    res = await pool.query(
      `UPDATE hyg_staff
          SET full_name = $3, license = $4, sign_in_ids = $5::jsonb,
              updated_by = $6, updated_at = now()
        WHERE office = $1 AND id = $2
          AND NOT EXISTS (
            SELECT 1 FROM hyg_staff o
             WHERE o.office = $1 AND o.id <> $2
               AND o.sign_in_ids ?| ARRAY(SELECT jsonb_array_elements_text($5::jsonb))
          )
       RETURNING id`,
      [office, id, input.fullName, input.license, JSON.stringify(input.signInIds), actor]
    );
  } catch (err) {
    if (isCollision(err)) return collision(pool, office, id, input.signInIds);
    throw err;
  }
  if (res.rows.length === 0) {
    // The row existed a moment ago, so zero rows is the overlap — unless it
    // vanished, which with no DELETE grant it cannot.
    return collision(pool, office, id, input.signInIds);
  }
  const staff = await getById(pool, { office, id });
  return staff ? { ok: true, staff, prior } : { ok: false, code: 'NOT_CONFIRMED' };
}

/**
 * Deactivate (active=false) or reactivate. Never a delete.
 * @param {{ query: Function }} pool
 * @param {{ office: string, id: string, active: boolean, actor: string }} args
 */
async function setActive(pool, { office, id, active, actor }) {
  const prior = await getById(pool, { office, id });
  if (!prior) return { ok: false, code: 'NOT_FOUND' };
  const res = await pool.query(
    `UPDATE hyg_staff
        SET active = $3, updated_by = $4, updated_at = now()
      WHERE office = $1 AND id = $2
     RETURNING id`,
    [office, id, active, actor]
  );
  if (res.rows.length === 0) return { ok: false, code: 'NOT_FOUND' };
  const staff = await getById(pool, { office, id });
  return staff && staff.active === active ? { ok: true, staff, prior } : { ok: false, code: 'NOT_CONFIRMED' };
}

/**
 * The roster a note's typed-name line is printed from, for one office.
 *
 * `null` when this office has NO rows at all — the caller then falls back to
 * the built-in list in backend/config/hygStaff.js, so nothing changes before
 * the office manager enters anyone. Once any row exists the table is the whole
 * answer: an inactive row is not matched, and the built-in list is not
 * consulted, so a person deactivated here cannot reappear from config.
 *
 * Matched on sign-in ids ONLY (`matchName: false`). Two staff may share a name;
 * no two share a sign-in.
 *
 * @param {{ query: Function }} pool
 * @param {string} office
 * @returns {Promise<null | Array<{ fullName: string, credential: string, license: string|null,
 *   signIn: string[], matchName: false }>>}
 */
async function signatureRoster(pool, office) {
  const rows = await listForOffice(pool, office);
  if (rows.length === 0) return null;
  return rows
    .filter((r) => r.active)
    .map((r) => ({
      fullName: r.fullName,
      credential: CREDENTIAL,
      license: r.license,
      signIn: r.signInIds,
      matchName: false,
    }));
}

module.exports = {
  listForOffice,
  getById,
  create,
  update,
  setActive,
  signatureRoster,
  toStaff,
  CREDENTIAL,
};

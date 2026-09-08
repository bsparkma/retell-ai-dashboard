'use strict';

/**
 * The hygiene visit, in Postgres — every statement this module owns.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * OFFICE IS IN EVERY WHERE CLAUSE, NOT JUST EVERY ROW
 * ═════════════════════════════════════════════════════════════════════════════
 * The migration puts `office` on all three tables with a composite FK, so a
 * child whose office disagrees with its parent cannot be stored. This module is
 * the other half: every lookup here filters on office as well as on the id, so
 * a cross-office read is refused by the QUERY too, not merely by the schema.
 *
 * That is not belt-and-braces. PatNum numbering restarts in every Open Dental
 * database — 7115 is the valley test patient AND a different, real person in
 * roland — so an item fetched by a bare uuid and then rendered beside a PatNum
 * is exactly how the wrong person's teeth end up on somebody's screen. There is
 * no function in this file that takes an id without an office beside it, and
 * `hygVisitOffice.test.js` proves a valley request cannot reach a roland row.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE STATE MACHINE IS HERE, AND SLICE 2 CAN ONLY REACH TWO OF ITS STATES
 * ═════════════════════════════════════════════════════════════════════════════
 *     Draft → Staged → Sending → Written | Failed
 *
 * Slice 2 reaches `Staged` (composing a write) and removes a staged row
 * (un-staging). `Sending`, `Written` and `Failed` belong to slice 3's send and
 * are set by the SERVER around a real Open Dental call.
 *
 * No route in this module accepts a `state` from a request body — there is no
 * such field in any request schema in shared/hyg/contract.ts — so a client
 * cannot move a row to `Written` by construction rather than by validation.
 * `CLIENT_MUTABLE_STATES` below is the second statement of the same rule: once
 * a row has left Draft/Staged it is immutable to this slice, so a re-stage
 * cannot quietly reset a write that already went to a chart.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE SLIP IS VALIDATED BEFORE IT IS STORED, AND AGAIN AFTER IT IS READ
 * ═════════════════════════════════════════════════════════════════════════════
 * `slip` and the item arrays are jsonb. A jsonb column will accept anything,
 * including yesterday's shape, so this module parses every slip through
 * `HygSlipSchema` on the way IN (the route does it first; this is the backstop)
 * and repairs a row that predates a contract change on the way OUT rather than
 * handing a component a shape it cannot render. A stored row that no longer
 * parses is reported as an empty slip with the raw value dropped — never as a
 * half-object, because a half-object is what silently loses what somebody typed.
 */

const crypto = require('node:crypto');

const contract = require('../../hyg/contract.gen.cjs');

/**
 * The states a client's request may leave a staged write in.
 *
 * Note what is NOT here: Sending, Written, Failed. See the header.
 */
const CLIENT_MUTABLE_STATES = Object.freeze(['Draft', 'Staged']);

/** Columns of hyg_treatment_item, in one place, so the SELECTs cannot drift. */
const ITEM_COLUMNS = `
  item_id, visit_id, office, teeth, whole_mouth, code, category, priority, status,
  surfaces, dx, dx_note, motivation, motivation_note, crown_type, prosthesis,
  schedule_next, note, photos, tags, item_order, created_by, created_at, updated_at
`;

const STAGED_COLUMNS = `
  staged_write_id, visit_id, office, kind, state, title, summary, preview, payload,
  error_message, written_ref, staged_by, staged_at, sent_by, sent_at, created_at, updated_at
`;

const VISIT_COLUMNS = `
  visit_id, office, apt_num, pat_num, visit_date, slip,
  created_by, created_at, updated_by, updated_at
`;

/** An ISO string, or null. Postgres hands back Date objects. */
function iso(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** A `date` column as `YYYY-MM-DD`, never a UTC-shifted instant. */
function isoDate(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

/**
 * A stored slip, made safe to render.
 *
 * A row written before a contract change may no longer parse. Returning the raw
 * value would hand a component a shape it cannot render; returning a MERGED
 * half-object would silently lose fields while looking complete. So an
 * unparseable slip becomes an empty one and says so in the log — the honest
 * answer to "we cannot read what was stored".
 * @param {unknown} raw
 * @param {string} visitId
 */
function readSlip(raw, visitId) {
  const parsed = contract.HygSlipSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  console.warn(
    `[hygvisit] visit ${visitId} holds a slip this build cannot read; rendering an empty one`
  );
  return contract.emptySlip();
}

/** A jsonb array column → a plain array, whatever the driver handed back. */
function arr(value) {
  return Array.isArray(value) ? value : [];
}

/** One hyg_treatment_item row → the contract's TreatmentItem. */
function toItem(row) {
  return {
    id: row.item_id,
    teeth: row.whole_mouth ? 'mouth' : arr(row.teeth),
    code: row.code,
    category: row.category,
    surfaces: arr(row.surfaces),
    dx: arr(row.dx),
    dxNote: row.dx_note ?? undefined,
    priority: row.priority,
    motivation: arr(row.motivation),
    motivationNote: row.motivation_note ?? undefined,
    status: row.status,
    crownType: row.crown_type ?? undefined,
    prosthesis: row.prosthesis ?? undefined,
    scheduleNext: row.schedule_next === true,
    note: row.note ?? undefined,
    photos: arr(row.photos),
    tags: arr(row.tags),
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
  };
}

/**
 * The fingerprint of a preview.
 *
 * THE PREVIEW IS THE WRITE. A send names the fingerprint of the lines the
 * hygienist read; the server recomputes it from the stored row and refuses the
 * whole send on a mismatch. So this must be a pure function of the preview and
 * of nothing else — no timestamp, no id, nothing that changes when the words do
 * not, and nothing that stays the same when they do.
 *
 * Truncated to 32 hex characters: 128 bits, against an accident rather than an
 * adversary (a caller who wanted to send unread words could simply not read
 * them). Full length would be noise in a request body.
 *
 * @param {string[]} preview
 * @returns {string}
 */
function fingerprintPreview(preview) {
  const lines = Array.isArray(preview) ? preview : [];
  return crypto.createHash('sha256').update(JSON.stringify(lines), 'utf8').digest('hex').slice(0, 32);
}

/** One hyg_staged_write row → the contract's StagedWrite. */
function toStagedWrite(row) {
  const preview = arr(row.preview);
  return {
    id: row.staged_write_id,
    kind: row.kind,
    state: row.state,
    title: row.title,
    summary: row.summary,
    preview,
    previewFingerprint: fingerprintPreview(preview),
    errorMessage: row.error_message ?? null,
    writtenRef: row.written_ref ?? null,
    stagedBy: row.staged_by ?? null,
    stagedAt: iso(row.staged_at),
    sentBy: row.sent_by ?? null,
    sentAt: iso(row.sent_at),
    updatedAt: iso(row.updated_at),
  };
}

/** The three rowsets → the contract's HygVisit. */
function toVisit(visitRow, itemRows, stagedRows) {
  return {
    visitId: visitRow.visit_id,
    office: visitRow.office,
    aptNum: Number(visitRow.apt_num),
    patNum: Number(visitRow.pat_num),
    visitDate: isoDate(visitRow.visit_date),
    slip: readSlip(visitRow.slip, visitRow.visit_id),
    items: itemRows.map(toItem),
    stagedWrites: stagedRows.map(toStagedWrite),
    createdBy: visitRow.created_by,
    createdAt: iso(visitRow.created_at),
    updatedBy: visitRow.updated_by ?? null,
    updatedAt: iso(visitRow.updated_at),
  };
}

/**
 * The visit for one appointment, or null.
 *
 * NEVER creates. A GET that created a row would mean opening a card to look at
 * it left a visit behind for a patient nobody worked on, and "which visits
 * happened" would stop being answerable.
 *
 * @param {import('pg').Pool} pool
 * @param {{ office: string, aptNum: number }} args
 * @returns {Promise<Record<string, any>|null>}
 */
async function getVisit(pool, { office, aptNum }) {
  const found = await pool.query(
    `SELECT ${VISIT_COLUMNS} FROM hyg_visit WHERE office = $1 AND apt_num = $2`,
    [office, aptNum]
  );
  if (found.rowCount === 0) return null;
  const visitRow = found.rows[0];
  return hydrate(pool, visitRow);
}

/** Load a visit row's children and shape the whole thing. */
async function hydrate(pool, visitRow) {
  const [items, staged] = await Promise.all([
    pool.query(
      `SELECT ${ITEM_COLUMNS} FROM hyg_treatment_item
        WHERE visit_id = $1 AND office = $2
        ORDER BY item_order ASC, created_at ASC`,
      [visitRow.visit_id, visitRow.office]
    ),
    pool.query(
      `SELECT ${STAGED_COLUMNS} FROM hyg_staged_write
        WHERE visit_id = $1 AND office = $2
        ORDER BY created_at ASC`,
      [visitRow.visit_id, visitRow.office]
    ),
  ]);
  return toVisit(visitRow, items.rows, staged.rows);
}

/**
 * Find the visit for this appointment, or start one.
 *
 * UPSERT on `(office, apt_num)` — the constraint the migration exists to make
 * unambiguous. Re-opening the same appointment finds the row that is already
 * there; it never starts a second one beside it, because a hygienist who
 * backgrounded the app mid-visit must not come back to an empty slip with her
 * work in a sibling row nothing renders.
 *
 * `ON CONFLICT DO UPDATE` rather than `DO NOTHING` for one reason: DO NOTHING
 * returns no row, so the caller would need a second SELECT and a race between
 * them. The update is a no-op assignment of pat_num to itself unless the
 * appointment genuinely moved patient, which Open Dental does allow.
 *
 * @param {import('pg').Pool} pool
 * @param {{ office: string, aptNum: number, patNum: number, visitDate: string|null, actor: string }} args
 */
async function openVisit(pool, { office, aptNum, patNum, visitDate, actor }) {
  const res = await pool.query(
    `INSERT INTO hyg_visit (office, apt_num, pat_num, visit_date, slip, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $6)
     ON CONFLICT (office, apt_num) DO UPDATE
       SET pat_num = EXCLUDED.pat_num,
           visit_date = COALESCE(EXCLUDED.visit_date, hyg_visit.visit_date),
           updated_at = now()
     RETURNING ${VISIT_COLUMNS}`,
    [office, aptNum, patNum, visitDate, JSON.stringify(contract.emptySlip()), actor]
  );
  return hydrate(pool, res.rows[0]);
}

/**
 * Store the slip.
 *
 * The WHOLE slip, replaced — not a merge. A merge would make "the hygienist
 * cleared this field" and "this client is an older build that does not know
 * about this field" the same request, and the one that wins is whichever the
 * server guesses. The client holds the whole form and sends the whole form.
 *
 * @returns {Promise<Record<string, any>|null>} null when there is no such visit
 */
async function saveSlip(pool, { office, aptNum, slip, actor }) {
  const parsed = contract.HygSlipSchema.parse(slip);
  const res = await pool.query(
    `UPDATE hyg_visit
        SET slip = $3::jsonb, updated_by = $4, updated_at = now()
      WHERE office = $1 AND apt_num = $2
      RETURNING ${VISIT_COLUMNS}`,
    [office, aptNum, JSON.stringify(parsed), actor]
  );
  if (res.rowCount === 0) return null;
  return hydrate(pool, res.rows[0]);
}

/**
 * Add one treatment item to a visit.
 *
 * `input` has already been parsed by the route through
 * TreatmentItemInputSchema; it is parsed AGAIN here rather than trusted,
 * because this function is also reachable from `updateItem`'s merge path and a
 * merge is where a partial body could otherwise assemble a shape the whole
 * schema would have refused.
 */
async function addItem(pool, { office, visitId, input, actor }) {
  const item = contract.TreatmentItemInputSchema.parse(input);
  const wholeMouth = item.teeth === 'mouth';
  const teeth = wholeMouth ? [] : item.teeth;

  const res = await pool.query(
    `INSERT INTO hyg_treatment_item
       (visit_id, office, teeth, whole_mouth, code, category, priority, status,
        surfaces, dx, dx_note, motivation, motivation_note, crown_type, prosthesis,
        schedule_next, note, photos, tags, item_order, created_by, updated_by)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8,
             $9::jsonb, $10::jsonb, $11, $12::jsonb, $13, $14, $15::jsonb,
             $16, $17, $18::jsonb, $19::jsonb,
             (SELECT COALESCE(MAX(item_order), 0) + 1 FROM hyg_treatment_item
               WHERE visit_id = $1 AND office = $2),
             $20, $20)
     RETURNING ${ITEM_COLUMNS}`,
    [
      visitId,
      office,
      JSON.stringify(teeth),
      wholeMouth,
      item.code,
      item.category,
      item.priority,
      item.status,
      JSON.stringify(item.surfaces ?? []),
      JSON.stringify(item.dx),
      item.dxNote ?? null,
      JSON.stringify(item.motivation),
      item.motivationNote ?? null,
      item.crownType ?? null,
      item.prosthesis ? JSON.stringify(item.prosthesis) : null,
      item.scheduleNext,
      item.note ?? null,
      JSON.stringify(item.photos),
      JSON.stringify(item.tags ?? []),
      actor,
    ]
  );
  await touchVisit(pool, { office, visitId, actor });
  return toItem(res.rows[0]);
}

/**
 * Edit one item.
 *
 * READ, MERGE, RE-VALIDATE, WRITE — in that order, on the server. The body is a
 * partial so a tooth toggle is one field on the wire, but what gets stored is
 * the whole merged item put back through the whole-object schema. A partial
 * body can therefore never assemble an item the create path would have refused.
 *
 * @returns {Promise<Record<string, any>|null>} null when there is no such item
 *   IN THIS OFFICE — the office is in the WHERE clause, so a valley request for
 *   a roland item is a not-found rather than a read.
 */
async function updateItem(pool, { office, visitId, itemId, patch, actor }) {
  const found = await pool.query(
    `SELECT ${ITEM_COLUMNS} FROM hyg_treatment_item
      WHERE item_id = $1 AND visit_id = $2 AND office = $3`,
    [itemId, visitId, office]
  );
  if (found.rowCount === 0) return null;

  const current = toItem(found.rows[0]);
  // Drop the server-owned fields before merging: a patch cannot rewrite who
  // created an item or when.
  const { id, createdBy, createdAt, ...editable } = current;
  const merged = contract.TreatmentItemInputSchema.parse({ ...editable, ...patch });
  const wholeMouth = merged.teeth === 'mouth';
  const teeth = wholeMouth ? [] : merged.teeth;

  const res = await pool.query(
    `UPDATE hyg_treatment_item
        SET teeth = $4::jsonb, whole_mouth = $5, code = $6, category = $7, priority = $8,
            status = $9, surfaces = $10::jsonb, dx = $11::jsonb, dx_note = $12,
            motivation = $13::jsonb, motivation_note = $14, crown_type = $15,
            prosthesis = $16::jsonb, schedule_next = $17, note = $18,
            photos = $19::jsonb, tags = $20::jsonb, updated_by = $21, updated_at = now()
      WHERE item_id = $1 AND visit_id = $2 AND office = $3
      RETURNING ${ITEM_COLUMNS}`,
    [
      itemId,
      visitId,
      office,
      JSON.stringify(teeth),
      wholeMouth,
      merged.code,
      merged.category,
      merged.priority,
      merged.status,
      JSON.stringify(merged.surfaces ?? []),
      JSON.stringify(merged.dx),
      merged.dxNote ?? null,
      JSON.stringify(merged.motivation),
      merged.motivationNote ?? null,
      merged.crownType ?? null,
      merged.prosthesis ? JSON.stringify(merged.prosthesis) : null,
      merged.scheduleNext,
      merged.note ?? null,
      JSON.stringify(merged.photos),
      JSON.stringify(merged.tags ?? []),
      actor,
    ]
  );
  await touchVisit(pool, { office, visitId, actor });
  return toItem(res.rows[0]);
}

/**
 * Remove one item. Office-scoped, so a valley request cannot delete a roland
 * row and be told it succeeded.
 * @returns {Promise<boolean>} whether a row was removed
 */
async function removeItem(pool, { office, visitId, itemId, actor }) {
  const res = await pool.query(
    `DELETE FROM hyg_treatment_item
      WHERE item_id = $1 AND visit_id = $2 AND office = $3`,
    [itemId, visitId, office]
  );
  if (res.rowCount === 0) return false;
  await touchVisit(pool, { office, visitId, actor });
  return true;
}

/** Record that somebody changed this visit, whatever they changed. */
async function touchVisit(pool, { office, visitId, actor }) {
  await pool.query(
    `UPDATE hyg_visit SET updated_by = $3, updated_at = now()
      WHERE visit_id = $1 AND office = $2`,
    [visitId, office, actor]
  );
}

/**
 * Stage one kind of write, composing it here from the STORED visit.
 *
 * The caller passes a kind and nothing else. Title, summary, preview and
 * payload all come from `stagedWriteComposer` reading the rows this module just
 * loaded — never from a request body. See that module's header for why.
 *
 * Re-staging an existing Draft/Staged row REPLACES it: staging the router twice
 * is an edit of what will be sent, not a second thing to send. A row that has
 * left those two states is immutable to this slice — refused rather than
 * silently reset, because resetting one would erase the record of a write that
 * already reached a chart.
 *
 * @returns {Promise<{ ok: true, staged: Record<string, any> }
 *          | { ok: false, code: string, message: string }>}
 */
async function stageWrite(pool, { office, visit, kind, actor, compose }) {
  const existing = await pool.query(
    `SELECT state FROM hyg_staged_write
      WHERE visit_id = $1 AND office = $2 AND kind = $3`,
    [visit.visitId, office, kind]
  );
  if (existing.rowCount > 0 && !CLIENT_MUTABLE_STATES.includes(existing.rows[0].state)) {
    return {
      ok: false,
      code: 'STAGED_WRITE_IMMUTABLE',
      message:
        `This ${kind} write is ${existing.rows[0].state.toLowerCase()} and cannot be re-staged. ` +
        'A write that has already been sent keeps its own record.',
    };
  }

  const composed = compose(kind, { visit, items: visit.items, actor });
  if (composed.unavailable) {
    return { ok: false, code: 'STAGED_WRITE_KIND_UNAVAILABLE', message: composed.unavailable };
  }
  if (composed.empty) {
    return { ok: false, code: 'NOTHING_TO_STAGE', message: composed.empty };
  }

  const res = await pool.query(
    `INSERT INTO hyg_staged_write
       (visit_id, office, kind, state, title, summary, preview, payload, staged_by, staged_at)
     VALUES ($1, $2, $3, 'Staged', $4, $5, $6::jsonb, $7::jsonb, $8, now())
     ON CONFLICT (visit_id, kind) DO UPDATE
       SET state = 'Staged', title = EXCLUDED.title, summary = EXCLUDED.summary,
           preview = EXCLUDED.preview, payload = EXCLUDED.payload,
           staged_by = EXCLUDED.staged_by, staged_at = now(),
           error_message = NULL, updated_at = now()
     RETURNING ${STAGED_COLUMNS}`,
    [
      visit.visitId,
      office,
      kind,
      composed.title,
      composed.summary,
      JSON.stringify(composed.preview),
      JSON.stringify(composed.payload),
      actor,
    ]
  );
  await touchVisit(pool, { office, visitId: visit.visitId, actor });
  return { ok: true, staged: toStagedWrite(res.rows[0]) };
}

/**
 * Un-stage one kind.
 *
 * Only from a state a client may hold. A `Written` row is a record of something
 * that happened and is not a client's to delete; the refusal says so rather
 * than reporting a success that erased history.
 *
 * @returns {Promise<{ ok: true } | { ok: false, code: string, message: string }>}
 */
async function unstageWrite(pool, { office, visitId, kind, actor }) {
  const found = await pool.query(
    `SELECT state FROM hyg_staged_write
      WHERE visit_id = $1 AND office = $2 AND kind = $3`,
    [visitId, office, kind]
  );
  if (found.rowCount === 0) {
    return { ok: false, code: 'STAGED_WRITE_NOT_FOUND', message: 'Nothing of that kind is staged' };
  }
  if (!CLIENT_MUTABLE_STATES.includes(found.rows[0].state)) {
    return {
      ok: false,
      code: 'STAGED_WRITE_IMMUTABLE',
      message:
        `This ${kind} write is ${found.rows[0].state.toLowerCase()} and cannot be removed. ` +
        'What already went to a chart keeps its record here.',
    };
  }
  await pool.query(
    `DELETE FROM hyg_staged_write WHERE visit_id = $1 AND office = $2 AND kind = $3`,
    [visitId, office, kind]
  );
  await touchVisit(pool, { office, visitId, actor });
  return { ok: true };
}

/**
 * One staged write, whole, for the send path.
 *
 * Office-scoped like everything else here. Returns the ROW rather than the
 * contract shape, because the sender needs `payload`, which is deliberately not
 * on the wire.
 *
 * @returns {Promise<Record<string, any>|null>}
 */
async function getStagedWrite(pool, { office, visitId, kind }) {
  const res = await pool.query(
    `SELECT ${STAGED_COLUMNS} FROM hyg_staged_write
      WHERE visit_id = $1 AND office = $2 AND kind = $3`,
    [visitId, office, kind]
  );
  return res.rowCount === 0 ? null : res.rows[0];
}

/**
 * Draft/Staged → Sending, PERSISTED BEFORE THE CALL IS MADE.
 *
 * Not bookkeeping. If the process dies between here and the read-back, the row
 * says `Sending` — which is the honest state, "we tried and do not know" —
 * rather than `Staged`, which would invite somebody to press send again on a
 * write that may already be in a chart.
 *
 * The WHERE clause re-asserts the state, so two concurrent sends cannot both
 * begin: the loser updates zero rows and is told so.
 *
 * @returns {Promise<boolean>} whether this call is the one that claimed it
 */
async function markSending(pool, { office, visitId, kind }) {
  const res = await pool.query(
    `UPDATE hyg_staged_write
        SET state = 'Sending', error_message = NULL, updated_at = now()
      WHERE visit_id = $1 AND office = $2 AND kind = $3 AND state = 'Staged'`,
    [visitId, office, kind]
  );
  return res.rowCount === 1;
}

/**
 * Sending → Written. Only ever called AFTER a read-back confirmed the write.
 *
 * `sent_by` and `sent_at` are set together — the schema refuses half an
 * attribution — and `written_ref` is the identifier the other system minted, so
 * "it was sent" can be followed to "here it is".
 */
async function markWritten(pool, { office, visitId, kind, actor, writtenRef }) {
  await pool.query(
    `UPDATE hyg_staged_write
        SET state = 'Written', sent_by = $4, sent_at = now(), written_ref = $5,
            error_message = NULL, updated_at = now()
      WHERE visit_id = $1 AND office = $2 AND kind = $3`,
    [visitId, office, kind, actor, writtenRef]
  );
}

/**
 * Sending → Failed, with the reason.
 *
 * The schema refuses a `Failed` row with no `error_message`: a failure nobody
 * can read is a failure nobody can act on. `sent_by`/`sent_at` are left alone —
 * an attempt is not a send, and stamping them would make a failed write look
 * like one somebody made.
 */
async function markFailed(pool, { office, visitId, kind, error }) {
  await pool.query(
    `UPDATE hyg_staged_write
        SET state = 'Failed', error_message = $4, written_ref = NULL, updated_at = now()
      WHERE visit_id = $1 AND office = $2 AND kind = $3`,
    [visitId, office, kind, String(error || 'Unknown failure').slice(0, 2000)]
  );
}

/**
 * Failed → Staged, so a hygienist can try again.
 *
 * Deliberately NOT a re-compose: it puts the SAME words back on the list, which
 * is what "retry" has to mean if the preview is the write. Changing the visit
 * and staging again is the other, explicit, path.
 */
async function retryStagedWrite(pool, { office, visitId, kind, actor }) {
  const res = await pool.query(
    `UPDATE hyg_staged_write
        SET state = 'Staged', error_message = NULL, staged_by = $4, staged_at = now(),
            updated_at = now()
      WHERE visit_id = $1 AND office = $2 AND kind = $3 AND state = 'Failed'`,
    [visitId, office, kind, actor]
  );
  return res.rowCount === 1;
}

module.exports = {
  CLIENT_MUTABLE_STATES,
  fingerprintPreview,
  getStagedWrite,
  markSending,
  markWritten,
  markFailed,
  retryStagedWrite,
  getVisit,
  openVisit,
  saveSlip,
  addItem,
  updateItem,
  removeItem,
  stageWrite,
  unstageWrite,
  // Exported for tests that assert the row → contract mapping directly.
  toVisit,
  toItem,
  toStagedWrite,
};

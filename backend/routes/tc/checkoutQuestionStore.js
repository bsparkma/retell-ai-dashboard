'use strict';

/**
 * tc_checkout_questions — the ask-hygiene thread on a checkout card (CO-7).
 *
 * Explicit columns, parameterized, office in every WHERE. A thread is every
 * row for one (office, handoff); a TC row is a question, a hygienist row is a
 * reply. The app role may INSERT rows and UPDATE `resolved_at` only (migration
 * 1794400000000), so nothing here rewrites or deletes a message.
 */

const { randomUUID } = require('node:crypto');

const { iso } = require('./helpers');

const COLS = ['question_id', 'office_id', 'handoff_id', 'author_email', 'author_role', 'body', 'created_at', 'resolved_at'];

/** One row → the contract's TcCheckoutQuestion. */
function toQuestion(row) {
  return {
    questionId: String(row.question_id),
    handoffId: String(row.handoff_id),
    authorEmail: String(row.author_email),
    authorRole: row.author_role === 'hygienist' ? 'hygienist' : 'tc',
    body: String(row.body),
    createdAt: iso(row.created_at),
    resolvedAt: iso(row.resolved_at),
  };
}

/** Open = a TC question not yet resolved (shared/tc/checkoutRouting.ts openQuestionCount). */
function isOpen(row) {
  return row.author_role === 'tc' && row.resolved_at == null;
}

/** Oldest first; the time, then the id, so two in one instant keep one order. */
function byTime(a, b) {
  const ta = new Date(a.created_at).getTime();
  const tb = new Date(b.created_at).getTime();
  if (ta !== tb) return ta - tb;
  return String(a.question_id).localeCompare(String(b.question_id));
}

/**
 * Write one message. The office and the handoff are the STORED card's (the
 * caller read it under the request's office); the role is the route's.
 *
 * @returns {Promise<string>} the new question id
 */
async function insertQuestion(q, { office, handoffId, authorEmail, authorRole, body, at }) {
  const questionId = randomUUID();
  await q.query(
    `INSERT INTO tc_checkout_questions (question_id, office_id, handoff_id, author_email, author_role, body, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [questionId, office, handoffId, authorEmail, authorRole, body, at]
  );
  return questionId;
}

/** Every message on these cards in one office, oldest first. One indexed read. */
async function listForHandoffs(q, office, handoffIds) {
  if (handoffIds.length === 0) return [];
  const res = await q.query(
    `SELECT ${COLS.join(', ')} FROM tc_checkout_questions
      WHERE office_id = $1 AND handoff_id = ANY($2)`,
    [office, handoffIds]
  );
  return res.rows.slice().sort(byTime);
}

/** One card's thread in the contract's shape. Pure over the rows. */
function threadOf(handoffId, rows) {
  const mine = rows.filter((r) => String(r.handoff_id) === String(handoffId)).sort(byTime);
  return { handoffId: String(handoffId), open: mine.filter(isOpen).length, messages: mine.map(toQuestion) };
}

/** handoffId → open-question count, for the cards that have any. Pure. */
function openCounts(rows) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const r of rows) {
    if (!isOpen(r)) continue;
    const k = String(r.handoff_id);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

/**
 * Resolve every open question on one card. Conditional on `resolved_at IS
 * NULL`, so a second click resolves nothing and an already-resolved question
 * keeps its first time.
 *
 * @returns {Promise<number>} how many were resolved
 */
async function resolveOpen(q, { office, handoffId, at }) {
  const res = await q.query(
    `UPDATE tc_checkout_questions SET resolved_at = $3
      WHERE office_id = $1 AND handoff_id = $2 AND author_role = 'tc' AND resolved_at IS NULL
      RETURNING question_id`,
    [office, handoffId, at]
  );
  return res.rowCount;
}

module.exports = {
  COLS,
  toQuestion,
  isOpen,
  insertQuestion,
  listForHandoffs,
  threadOf,
  openCounts,
  resolveOpen,
};

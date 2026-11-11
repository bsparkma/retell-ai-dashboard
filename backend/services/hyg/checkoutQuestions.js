'use strict';

/**
 * The ask-hygiene thread, hygiene side (CO-7): which checkout card is a visit's,
 * and the day's badges. The routes are where the module keeps its routes —
 * GET /api/hyg/day/checkout-questions (day.js, read-only) and GET + POST
 * /api/hyg/visit/:aptNum/checkout-questions[/reply] (visit.js, the module's one
 * mutating route file) — and the front desk's side is routes/tc/checkoutQuestions.js.
 * Same table (tc_checkout_questions), same store.
 *
 * WHICH CARD IS "THIS VISIT'S". Server-derived, never named by the request:
 * the visit's own checkout handoff — its source key `hyg-visit:<visitId>:
 * checkout`, the key tcHandoffClient sends, and the key a manual card takes when
 * a hygiene visit merges onto it — else the card made from that appointment on
 * today's schedule (CO-5b `origin_apt_num`). Office-scoped throughout. A card
 * added by hand that no hygiene visit merged onto has no appointment, so it has
 * no badge in the day view.
 *
 * ZERO OPEN DENTAL: CareIN's own tables only.
 */

const questionStore = require('../../routes/tc/checkoutQuestionStore');
const { sourceKeyFor } = require('./tcHandoffClient');

/** The source key the visit's checkout handoff carries (tcHandoffClient's own derivation). */
function checkoutSourceKey(visitId) {
  return sourceKeyFor({ visitId: String(visitId) }, 'checkout');
}

/**
 * AptNum → the checkout card for that visit, for the AptNums given, in one
 * office, optionally on one visit day. Office-scoped reads, no JOIN; a visit's
 * own card wins over a schedule card for the same AptNum.
 *
 * @param {{ query: Function }} q
 * @param {string} office
 * @param {number[]} aptNums
 * @param {string|null} date  'YYYY-MM-DD', or null for any day
 * @returns {Promise<Map<number, string>>} aptNum → handoffId
 */
async function cardsForAptNums(q, office, aptNums, date) {
  const out = new Map();
  if (aptNums.length === 0) return out;
  const visits = await q.query('SELECT visit_id, apt_num FROM hyg_visit WHERE office = $1 AND apt_num = ANY($2)', [
    office,
    aptNums,
  ]);
  /** @type {Map<string, number>} */
  const aptByKey = new Map();
  for (const v of visits.rows) {
    const key = checkoutSourceKey(v.visit_id);
    if (key) aptByKey.set(key, Number(v.apt_num));
  }
  const dated = date ? ' AND visit_date = $3' : '';
  if (aptByKey.size) {
    const byKey = await q.query(
      `SELECT handoff_id, source_key FROM tc_checkout_handoffs WHERE office_id = $1 AND source_key = ANY($2)${dated}`,
      date ? [office, [...aptByKey.keys()], date] : [office, [...aptByKey.keys()]]
    );
    for (const r of byKey.rows) {
      const apt = aptByKey.get(String(r.source_key));
      if (apt) out.set(apt, String(r.handoff_id));
    }
  }
  const fromSchedule = await q.query(
    `SELECT handoff_id, origin_apt_num FROM tc_checkout_handoffs WHERE office_id = $1 AND origin_apt_num = ANY($2)${dated}`,
    date ? [office, aptNums, date] : [office, aptNums]
  );
  for (const r of fromSchedule.rows) {
    const apt = Number(r.origin_apt_num);
    if (!out.has(apt)) out.set(apt, String(r.handoff_id));
  }
  return out;
}

/**
 * The day's badges: one per AptNum whose card has any message. Counts only —
 * no PatNum, no name, no message text.
 *
 * @returns {Promise<Array<{ aptNum: number, handoffId: string, open: number, total: number }>>}
 */
async function badgesForDay(q, office, aptNums, date) {
  const cards = await cardsForAptNums(q, office, aptNums, date);
  const rows = await questionStore.listForHandoffs(q, office, [...new Set(cards.values())]);
  const out = [];
  for (const [aptNum, handoffId] of cards) {
    const thread = questionStore.threadOf(handoffId, rows);
    if (thread.messages.length === 0) continue;
    out.push({ aptNum, handoffId, open: thread.open, total: thread.messages.length });
  }
  return out.sort((a, b) => a.aptNum - b.aptNum);
}

/**
 * One visit's card and its thread, or null when the visit has no card.
 *
 * @returns {Promise<{ handoffId: string, thread: { handoffId: string, open: number, messages: object[] } } | null>}
 */
async function threadForApt(q, office, aptNum) {
  const cards = await cardsForAptNums(q, office, [aptNum], null);
  const handoffId = cards.get(aptNum);
  if (!handoffId) return null;
  const rows = await questionStore.listForHandoffs(q, office, [handoffId]);
  return { handoffId, thread: questionStore.threadOf(handoffId, rows) };
}

module.exports = { cardsForAptNums, badgesForDay, threadForApt, checkoutSourceKey };

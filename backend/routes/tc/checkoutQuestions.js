'use strict';

/**
 * The ask-hygiene thread, TC side (CO-7):
 *
 *   GET  /api/tc/checkout/:id/questions           the card's thread, oldest first
 *   POST /api/tc/checkout/:id/questions           ask: { body } — a TC question
 *   POST /api/tc/checkout/:id/questions/resolve   mark every open question resolved
 *
 * The hygienist answers from the hygiene app's day view (routes/hyg/
 * checkoutQuestions.js). Same table, same store.
 *
 * RULES. tc.full (the /checkout mount), the office from `?office=`, behind the
 * checkout switch and the day sweep. The card is read under the request's
 * office first and the row is written with THE CARD'S office and id — another
 * office's card is a 404 that writes nothing. The author is the SSO identity
 * and the role is 'tc' because this is the TC app's route; the body carries
 * neither. The thread is a PHI read (the questions are free text about a
 * patient): audited even when empty. Every answer is the thread READ BACK.
 * In-app only: no Open Dental, no email, no SMS.
 */

const { contract, actorEmail, parseBody, h, auditTc } = require('./helpers');
const tenantDb = require('../../platform/tenantDb');
const checkoutStore = require('./checkoutStore');
const questionStore = require('./checkoutQuestionStore');

const { z, TcCheckoutQuestionPost } = contract;

const HandoffId = z.string().uuid();

function notFound(res) {
  return res.status(404).json({ success: false, error: 'Checkout handoff not found', code: 'NOT_FOUND' });
}

/** The card in this office, or null. */
async function cardIn(req, office, handoffId) {
  return tenantDb.withTenantDb(req, (pool) => checkoutStore.findById(pool, office, handoffId));
}

/** The card's thread, read now. */
async function readThread(req, office, handoffId) {
  const rows = await tenantDb.withTenantDb(req, (pool) => questionStore.listForHandoffs(pool, office, [handoffId]));
  return questionStore.threadOf(handoffId, rows);
}

/**
 * @param {import('express').Router} router
 * @param {{ enter: Function, clock: () => Date }} deps
 */
function mount(router, deps) {
  router.get(
    '/:id/questions',
    h(async (req, res) => {
      const id = HandoffId.safeParse(req.params.id);
      if (!id.success) return res.status(400).json({ success: false, error: 'Invalid handoff id', code: 'INVALID_ID' });
      const today = await deps.enter(req, res);
      if (today === null) return undefined;
      const office = req.tcOffice;
      if (!(await cardIn(req, office, id.data))) return notFound(res);
      const thread = await readThread(req, office, id.data);
      await auditTc(req, 'READ', 'tc_checkout_question', null, { office, sourceRef: `checkout:${id.data}` });
      return res.json({ success: true, thread });
    })
  );

  router.post(
    '/:id/questions',
    h(async (req, res) => {
      const id = HandoffId.safeParse(req.params.id);
      if (!id.success) return res.status(400).json({ success: false, error: 'Invalid handoff id', code: 'INVALID_ID' });
      const body = parseBody(res, TcCheckoutQuestionPost, req.body);
      if (!body) return undefined;
      const today = await deps.enter(req, res);
      if (today === null) return undefined;
      const office = req.tcOffice;
      const card = await cardIn(req, office, id.data);
      if (!card) return notFound(res);

      const questionId = await tenantDb.withTenantDb(req, (pool) =>
        questionStore.insertQuestion(pool, {
          office: card.office_id,
          handoffId: String(card.handoff_id),
          authorEmail: actorEmail(req),
          authorRole: 'tc',
          body: body.body,
          at: deps.clock().toISOString(),
        })
      );
      await auditTc(req, 'CREATE', 'tc_checkout_question', questionId, { office, sourceRef: `checkout:${id.data}` });

      const thread = await readThread(req, office, id.data);
      if (!thread.messages.some((m) => m.questionId === questionId)) {
        return res.status(500).json({
          success: false,
          error: 'The question could not be read back. Reload before trusting it.',
          code: 'QUESTION_NOT_PERSISTED',
        });
      }
      return res.status(201).json({ success: true, thread });
    })
  );

  router.post(
    '/:id/questions/resolve',
    h(async (req, res) => {
      const id = HandoffId.safeParse(req.params.id);
      if (!id.success) return res.status(400).json({ success: false, error: 'Invalid handoff id', code: 'INVALID_ID' });
      const today = await deps.enter(req, res);
      if (today === null) return undefined;
      const office = req.tcOffice;
      const card = await cardIn(req, office, id.data);
      if (!card) return notFound(res);

      const at = deps.clock().toISOString();
      const resolved = await tenantDb.withTenantDb(req, (pool) =>
        questionStore.resolveOpen(pool, { office: card.office_id, handoffId: String(card.handoff_id), at })
      );
      if (resolved > 0) {
        await auditTc(req, 'UPDATE', 'tc_checkout_question', String(card.handoff_id), {
          office,
          sourceRef: `checkout_questions_resolved:${resolved}`,
          priorState: 'open',
        });
      }
      // Holds when nothing asked up to the resolve is still open (a question
      // asked a moment later is a new one, and rightly stays open).
      const thread = await readThread(req, office, id.data);
      const stillOpen = thread.messages.some(
        (m) => m.authorRole === 'tc' && m.resolvedAt === null && new Date(m.createdAt).getTime() <= new Date(at).getTime()
      );
      if (stillOpen) {
        return res.status(500).json({
          success: false,
          error: 'The questions could not be read back as resolved. Reload before trusting it.',
          code: 'QUESTION_NOT_PERSISTED',
        });
      }
      return res.json({ success: true, resolved, thread });
    })
  );
}

module.exports = { mount };

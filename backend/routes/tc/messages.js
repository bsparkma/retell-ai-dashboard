'use strict';

/**
 * /api/tc/messages — patient messaging (queue item 38). Ships DARK twice over:
 * the whole /api/tc mount is requireModule('tc'), and both channel adapters are
 * stubs that refuse (FEATURE_DISABLED) until items 39 (SMS) and 40 (email).
 *
 *   GET    /?caseId=          the case's thread (outbound + inbound, oldest first)
 *   GET    /inbox             received messages not yet linked to a case
 *   GET    /consent?caseId=   per-channel readiness for the compose box
 *   POST   /draft             create a draft (address assembled from the case)
 *   PUT    /:id               edit a draft's text
 *   POST   /:id/send          THE APPROVAL CLICK — one message, one human
 *   POST   /:id/discard       delete a draft
 *   POST   /consent           record a MANUAL opt-out (never an opt-in)
 *   GET    /unseen-count      (item 39) how many received texts nobody has opened
 *   GET    /unseen            (item 39) unseen received texts linked to a case
 *   POST   /seen              (item 39) mark a case's (or the inbox's) texts seen
 *
 * OFFICE comes from the validated `?office=` (helpers.requireOffice) and every
 * statement is office_id-scoped, so another practice's message is a 404. No
 * body field can name an address: DraftMessageBody has none and is strict.
 *
 * Refusals are services/messaging MessagingError → `{ success:false, error,
 * code, ...extra }` at the error's own HTTP status. The UI switches on `code`.
 */

const express = require('express');

const { contract, requireOffice, parseBody, h, notFound } = require('./helpers');
const messaging = require('../../services/messaging');
const { MessagingError } = require('../../services/messaging/errors');

const { z, Uuid, DraftMessageBody, EditDraftBody, RecordOptOutBody } = contract;

const router = express.Router();
router.use(requireOffice);

/** h() plus the MessagingError mapping. */
function m(fn) {
  return h(async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof MessagingError) {
        return res.status(err.httpStatus).json({
          success: false,
          error: err.message,
          code: err.code,
          ...err.extra,
        });
      }
      throw err;
    }
  });
}

const CaseQuery = z.object({ office: z.string(), caseId: Uuid }).strict();
const OfficeOnly = z.object({ office: z.string() }).strict();
/** POST /seen — a case id, or null for "the unlinked inbox". */
const MarkSeenBody = z.object({ caseId: Uuid.nullable() }).strict();

router.get(
  '/',
  m(async (req, res) => {
    const query = parseBody(res, CaseQuery, req.query);
    if (!query) return;
    const messages = await messaging.listMessages(req, req.tcOffice, query.caseId);
    res.json({ success: true, messages });
  })
);

router.get(
  '/inbox',
  m(async (req, res) => {
    if (!parseBody(res, OfficeOnly, req.query)) return;
    const messages = await messaging.listInbox(req, req.tcOffice);
    res.json({ success: true, messages });
  })
);

router.get(
  '/unseen-count',
  m(async (req, res) => {
    if (!parseBody(res, OfficeOnly, req.query)) return;
    const count = await messaging.countUnseen(req, req.tcOffice);
    res.json({ success: true, count, capped: count >= messaging.UNSEEN_CAP });
  })
);

router.get(
  '/unseen',
  m(async (req, res) => {
    if (!parseBody(res, OfficeOnly, req.query)) return;
    const messages = await messaging.listUnseenOnCases(req, req.tcOffice);
    res.json({ success: true, messages });
  })
);

router.post(
  '/seen',
  m(async (req, res) => {
    const body = parseBody(res, MarkSeenBody, req.body);
    if (!body) return;
    const marked = await messaging.markSeen(req, req.tcOffice, body.caseId);
    res.json({ success: true, marked });
  })
);

router.get(
  '/consent',
  m(async (req, res) => {
    const query = parseBody(res, CaseQuery, req.query);
    if (!query) return;
    const channels = await messaging.getChannelReadiness(req, req.tcOffice, query.caseId);
    res.json({ success: true, channels });
  })
);

router.post(
  '/draft',
  m(async (req, res) => {
    const body = parseBody(res, DraftMessageBody, req.body);
    if (!body) return;
    const message = await messaging.draftMessage(req, req.tcOffice, body);
    res.status(201).json({ success: true, message });
  })
);

router.post(
  '/consent',
  m(async (req, res) => {
    const body = parseBody(res, RecordOptOutBody, req.body);
    if (!body) return;
    const consent = await messaging.recordOptOut(req, req.tcOffice, body);
    res.json({ success: true, consent });
  })
);

/** Parse `:id` or 404 — a malformed id names no message. */
function messageIdOr404(req, res) {
  const parsed = Uuid.safeParse(req.params.id);
  if (!parsed.success) {
    notFound(res, 'message');
    return null;
  }
  return parsed.data;
}

router.put(
  '/:id',
  m(async (req, res) => {
    const id = messageIdOr404(req, res);
    if (!id) return;
    const body = parseBody(res, EditDraftBody, req.body);
    if (!body) return;
    const message = await messaging.editDraft(req, req.tcOffice, id, body);
    res.json({ success: true, message });
  })
);

router.post(
  '/:id/send',
  m(async (req, res) => {
    const id = messageIdOr404(req, res);
    if (!id) return;
    // No body is read. What is sent, and to whom, is the stored draft.
    const message = await messaging.sendMessage(req, req.tcOffice, id);
    res.json({ success: true, message });
  })
);

router.post(
  '/:id/discard',
  m(async (req, res) => {
    const id = messageIdOr404(req, res);
    if (!id) return;
    await messaging.discardMessage(req, req.tcOffice, id);
    res.json({ success: true });
  })
);

module.exports = router;

'use strict';

/**
 * /api/rcm — the Revenue Cycle Management module (Slice 3: the mount).
 *
 * ONE mount in server.js, behind requireModule('rcm') + the rcm.read/rcm.write
 * permission pair. Ships DARK in the same sense TC did: no tenant is entitled
 * to 'rcm' yet, so every route below 403s MODULE_NOT_ENTITLED in every
 * environment until Beau flips the entitlement from the Platform Console.
 *
 * Slice 3 was PLUMBING. Two endpoints existed to prove the chain end to end and
 * to give Slices 4–7 a door to build behind:
 *   GET  /summary   per-office counts across claims / batches / posting queue
 *   GET  /claims    office-scoped claim list, paginated
 *
 * Slice 4 added EOB ingestion, and with it the module's first mutation:
 *   POST /eob       multipart PDF → Blob + rcm_eob_uploads row + queued extraction
 *   GET  /eob       office-scoped upload list + the extraction cost-breaker state
 *
 * Slice 5 added the machine-readable source alongside it:
 *   POST /era       multipart 835 → Blob + parsed proposals, deduplicated by
 *                   the office-scoped remittance key
 *   GET  /era       office-scoped upload list with each remittance's dedupe state
 *
 * The two are deliberately siblings rather than one endpoint: an EOB PDF must
 * be READ by a model and can be wrong, an 835 is PARSED and can only be
 * malformed. They produce the same rcm_* proposal rows and share nothing else.
 *
 * Slice 6a turned the module from an intake pipe into something a biller can
 * open. It added the review workbench and the Open Dental matching underneath
 * it — and the module's FIRST Open Dental traffic, which is GET-only:
 *   GET  /remittances[/:id]        the list and the detail
 *   POST /remittances/:id/match    sequential, paced batch match
 *   GET  /claims/:id               one claim: lines, adjustments, snapshot
 *   POST /claims/:id/match         read OD, rank candidates, store a snapshot
 *   POST /claims/:id/confirm-match a human picks one       (attributed, D-5)
 *   POST /claims/:id/review        worklist hygiene         (attributed, D-5)
 *   GET  /uploads/:id/document     the authorised source-document proxy
 *
 * ZERO OPEN DENTAL WRITES IN THIS SLICE. The only transport reachable from any
 * of the above is `apiGetRaw` on the office's own client, which has no write
 * counterpart; `rcmNoOdWrites.test.js` fails if one appears. There is no
 * approve, no enqueue and no post route, and `rcm_posting_queue` is untouched.
 *
 * NOT here, and not yet: the approval gate (6b), any Open Dental write (6c),
 * the recoupment gate (6d), reconciliation, VCC and metrics (8/9), Stedi. The
 * only tables anything under this mount touches are rcm_* and the platform
 * audit_log.
 */

const express = require('express');

const { requireOffice } = require('./helpers');

const router = express.Router();

/**
 * OFFICE SCOPING IS ROUTER-WIDE, AND THAT IS THE ORDERING CONSTRAINT.
 *
 * `requireOffice` is registered BEFORE every route mount below, so every route
 * in this module — including one added next year by someone who never read this
 * file — gets `?office=roland|valley` validated before its handler runs and
 * finds it on req.rcmOffice. Office therefore comes from the server-validated
 * query param on every RCM route, never from a body, a header, or a default.
 *
 * The TC module learned this the hard way in the opposite direction: its voice
 * handoff carries office in the BODY (a frozen external contract), so
 * `/cases/from-call` MUST be registered above the `/cases` router that applies
 * requireOffice — express matches mounts in registration order, and getting
 * that order wrong 400s a live integration. See routes/tc/index.js.
 *
 * RCM has no such exception today, and this ordering is what keeps it that way.
 * If one ever becomes necessary, it must be mounted ABOVE this line, with the
 * reason written at the mount — and `rcmMountOrder.test.js` will fail until it
 * is added to that test's documented-exception list, so the exception cannot be
 * introduced silently.
 */
router.use(requireOffice);

/**
 * THE QUEUE ROUTES — the enumerated exceptions to the mount's write gate (D-9).
 *
 * The mount is `requireReadWrite('rcm.read', 'rcm.write')`, applied by HTTP
 * METHOD, so every POST under /api/rcm demands `rcm.write` by default. These
 * three are POSTs that a read-tier reviewer must be able to press: running a
 * match reads Open Dental and changes no chart, and marking a claim reviewed
 * has no Open Dental effect at all. They are exempted from the pair at the
 * mount and each carries its own `requirePermission('rcm.queue')` instead — the
 * "a specific gate narrows the general one" idiom config/permissions.js
 * documents, used here to WIDEN by one tier rather than to narrow.
 *
 * Mount-relative and anchored: `/claims/:id/confirm-match` must not match, and
 * a new POST added under either router must not accidentally land inside one.
 * `rcmGuard.test.js` walks every route in this module and fails if a path is
 * exempted here without its own gate.
 *
 * @type {ReadonlyArray<RegExp>}
 */
const QUEUE_PATHS = Object.freeze([
  /^\/claims\/[^/]+\/match$/,
  /^\/claims\/[^/]+\/review$/,
  /^\/remittances\/[^/]+\/match$/,
]);

router.use('/summary', require('./summary'));
router.use('/claims', require('./claims'));
// Slice 4. The module's first WRITE surface — POST /eob is what the unused
// rcm.write action at the server.js mount has been waiting for. It stores a PDF
// and queues an extraction; the extraction produces PROPOSAL rows in rcm_*.
// Still no Open Dental anywhere under this mount (eobNoOdImports.test.js).
router.use('/eob', require('./eob'));
// Slice 5. The same shape for the machine-readable source: an 835 is parsed
// rather than read by a model, so it needs no extraction queue — but it lands
// in the same rcm_* proposal tables, behind the same rcm.write demanded by the
// mount's requireReadWrite for every non-GET method, and the same
// requireOffice above. Still no Open Dental (eraNoOdImports covers this one).
router.use('/era', require('./era'));
// Slice 6a — the review workbench. `/remittances` is the screen a biller opens
// a check on; `/uploads/:id/document` is the authorised proxy back to the bytes
// it was parsed from. Both sit BELOW requireOffice like everything else, so a
// cross-office read is a miss rather than a refusal somebody had to remember.
router.use('/remittances', require('./remittances'));
router.use('/uploads', require('./documents'));

module.exports = router;
module.exports.QUEUE_PATHS = QUEUE_PATHS;

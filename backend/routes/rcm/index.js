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
 * NOT here, and not yet: ERA/835 parsing (Slice 5), posting (Slice 6), the
 * review/approval UI (Slice 7), and any Open Dental client usage in ANY slice
 * of this module before 6. The only tables anything under this mount touches
 * are rcm_* and the platform audit_log.
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

router.use('/summary', require('./summary'));
router.use('/claims', require('./claims'));
// Slice 4. The module's first WRITE surface — POST /eob is what the unused
// rcm.write action at the server.js mount has been waiting for. It stores a PDF
// and queues an extraction; the extraction produces PROPOSAL rows in rcm_*.
// Still no Open Dental anywhere under this mount (eobNoOdImports.test.js).
router.use('/eob', require('./eob'));

module.exports = router;

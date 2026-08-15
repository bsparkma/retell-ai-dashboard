'use strict';

/**
 * /api/rcm — the Revenue Cycle Management module (Slice 3: the mount).
 *
 * ONE mount in server.js, behind requireModule('rcm') + the rcm.read/rcm.write
 * permission pair. Ships DARK in the same sense TC did: no tenant is entitled
 * to 'rcm' yet, so every route below 403s MODULE_NOT_ENTITLED in every
 * environment until Beau flips the entitlement from the Platform Console.
 *
 * This slice is PLUMBING. Two endpoints exist to prove the chain end to end and
 * to give Slices 4–7 a door to build behind:
 *   GET /summary   per-office counts across claims / batches / posting queue
 *   GET /claims    office-scoped claim list, paginated
 *
 * NOT here, and not in this slice: EOB upload, ERA parsing, posting, the work
 * queue UI, and any Open Dental client usage. This module writes nothing —
 * every route is a GET, and the only tables it touches are rcm_*.
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
// Slice 5: manual 835 upload. The first MUTATION in this module — it needs no
// gate of its own because the mount's requireReadWrite already demands
// rcm.write for every non-GET method, which is exactly the property the pair
// was introduced for. Office still comes from requireOffice above.
router.use('/era', require('./era'));

module.exports = router;

'use strict';

/**
 * /api/fees — the Fee Schedule module (slice 1: the scaffold, the parse, and
 * the preview).
 *
 * ONE mount in server.js, behind requireModule('fees') + the
 * fees.read/fees.write permission pair. SHIPS DARK, in the same sense TC, RCM
 * and HYG did: 'fees' exists in the tenant_module vocabulary as of migration
 * 1788700000000, no tenant is entitled to it, so every route below 403s
 * MODULE_NOT_ENTITLED in every environment until the entitlement is flipped
 * from the Platform Console.
 *
 * One route family:
 *
 *   POST /imports?office=              upload a payer fee schedule (PDF or CSV),
 *                                      parse it, persist the batch and its rows
 *   GET  /imports?office=              what this office has uploaded
 *   GET  /imports/:id?office=          one batch and every row parsed out of it
 *
 * and, as of slice 3, deciding a preview and posting it into Open Dental:
 *
 *   GET   /feescheds                   the office's fee schedules (target picker)
 *   PATCH /imports/:id/rows/:rowId     accept | exclude | reset one warned row
 *   PUT   /imports/:id/target          choose the target schedule
 *   POST  /imports/:id/post            THE HUMAN ACTION — starts the posting job
 *   GET   /imports/:id/progress        what the UI polls
 *   POST  /imports/:id/rollback        undo it
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE FILE TOUCHES OPEN DENTAL, AND IT IS NOT THIS ONE
 * ─────────────────────────────────────────────────────────────────────────────
 * Slice 1 shipped with a flat invariant: nothing under routes/fees or
 * services/fees could reach Open Dental at all. Slice 3 is the reviewed edit
 * that invariant anticipated — it is now a ONE-FILE ALLOW-LIST naming
 * `services/fees/odFeesWrites.js`, exactly as RCM's (`odPostingWrites.js`) and
 * hygiene's (`odPerioWriter.js`) did before it. Every other file in the module,
 * this one included, is still forbidden from importing the seam, and
 * `feesNoOdAccess.test.js` fails the build if a second one does.
 *
 * The `mysql2` ban stays ABSOLUTE and is not part of the allow-list. The
 * reference implementation this module's parser was ported from
 * (`RCM Project v2/fee-schedule-importer`) did all of its work in raw MySQL
 * against Open Dental: it created carriers, created insurance plans, created
 * fee schedules, deleted and re-inserted `fee` rows, and kept an in-memory
 * "backup" it could revert from. Slice 3 does the one thing on that list that
 * was worth having — writing fees — through the office-keyed cloud API, with a
 * persisted snapshot behind it. v1 writes FEES ONLY: no carrier creation, no
 * insurance-plan creation, no plan attachment (ratified 2026-09-22). A schedule
 * attached to no plan reprices nothing, which is what makes a mistaken post
 * recoverable.
 *
 * REVIEW-THEN-SEND. There is no path from parsing a file to writing a fee that
 * does not pass through a human pressing Post: the upload route does not call
 * into the posting router, and there is no scheduler, no webhook and no
 * "auto-post when clean" flag anywhere in this module.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO ORDERING FACTS
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. `requireOffice` is registered BEFORE every route mount below, so every
 *    route in this module — including one added next year by someone who never
 *    read this file — gets `?office=roland|valley` validated before its handler
 *    runs and finds it on `req.feesOffice`. RCM and HYG both do the same and
 *    document the same reason. If an exception ever becomes necessary it must
 *    be mounted ABOVE this line with the reason written at the mount.
 *
 * 2. There is no write-exemption list, and there should not be one until a
 *    route genuinely needs it. The mount's requireReadWrite('fees.read',
 *    'fees.write') applies by HTTP METHOD, so the upload demands fees.write by
 *    construction. An exemption added "for later" is an exemption nobody
 *    reviewed.
 */

const express = require('express');

const { requireOffice } = require('./helpers');

const router = express.Router();

/** Office scoping is router-wide. See note 1 above before adding a mount. */
router.use(requireOffice);

/*
 * POSTING IS MOUNTED FIRST, and the order matters.
 *
 * `./posting` owns the deeper paths — /imports/:id/post, /imports/:id/rows/:rowId,
 * /imports/:id/progress — while `./imports` owns /imports/:id itself. Express
 * matches mounts in order, so registering the specific router first means its
 * routes are reached before the general one can consider them. Reversed, a GET
 * /imports/:id/progress would still work (it falls through), but the ordering
 * would be load-bearing by accident rather than on purpose, and the first
 * route added to ./imports with a wildcard segment would silently swallow it.
 */
router.use('/', require('./posting'));
router.use('/imports', require('./imports'));

module.exports = router;

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
 *   POST /imports?office=      upload a payer fee schedule (PDF or CSV),
 *                              parse it, persist the batch and its rows
 *   GET  /imports?office=      what this office has uploaded
 *   GET  /imports/:id?office=  one batch and every row parsed out of it
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ZERO OPEN DENTAL ACCESS, AND NOT BY POLICY
 * ─────────────────────────────────────────────────────────────────────────────
 * Nothing under this mount requires config/odOffices.js, config/openDental.js,
 * or any office client — not to write, and not to read. The reference
 * implementation this module's parser was ported from
 * (`RCM Project v2/fee-schedule-importer`) did all of its work in raw MySQL
 * against Open Dental: it created carriers, created insurance plans, created
 * fee schedules, deleted and re-inserted `fee` rows, and kept an in-memory
 * "backup" it could revert from. NONE of that is ported. See
 * services/fees/README-PORT.md, deviation D10.
 *
 * What the reference got right is the parsing, and that is what slice 1 is:
 * bytes in, a preview out. Deciding that the preview is correct, and then
 * posting it into Open Dental through the office-keyed cloud API — never MySQL
 * — is a later slice, and it will introduce exactly one writer file the way
 * RCM's and HYG's did, with a one-file allow-list in the guard test.
 * `feesNoOdAccess.test.js` scans this module's whole source for an Open Dental
 * import of any kind and for a MySQL driver, and fails on either.
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

router.use('/imports', require('./imports'));

module.exports = router;

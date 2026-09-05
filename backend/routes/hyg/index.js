'use strict';

/**
 * /api/hyg — the Hygiene module (H1 slice 1: the scaffold and the day view).
 *
 * ONE mount in server.js, behind requireModule('hyg') + the hyg.read/hyg.write
 * permission pair. SHIPS DARK, in the same sense TC and RCM did: 'hyg' exists
 * in the tenant_module vocabulary as of migration 1788100000000, no tenant is
 * entitled to it, so every route below 403s MODULE_NOT_ENTITLED in every
 * environment until Beau flips the entitlement from the Platform Console.
 *
 * Two route families:
 *
 *   GET /day?office=&date=       one office's whole schedule for one day
 *   /visit/:aptNum ...           the visit workspace (H1 slice 2)
 *
 * Slice 3 adds the send: the slip as a PDF into the patient's images, the
 * unsigned visit note, and the handoff into TC.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ZERO OPEN DENTAL WRITES, AND NOT BY POLICY
 * ─────────────────────────────────────────────────────────────────────────────
 * Nothing under this mount can reach an Open Dental write verb, because the
 * only transport in scope is `apiGetRaw` on the office's own client and it has
 * no write counterpart. That stays true through slice 2: the visit routes
 * MUTATE, but everything they mutate is in this platform's own Postgres.
 * `hygNoOdWrites.test.js` drives both route families to success against a
 * client whose every write verb throws and asserts not one was called, and
 * separately scans this module's whole source for the write verb's name and for
 * a write-shaped call on any CLIENT. Slice 3 will introduce exactly one writer
 * file and that test will grow a one-file allow-list, the way RCM's did —
 * deleting the guard is how a guard stops guarding.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO ORDERING FACTS
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. `requireOffice` is registered BEFORE every route mount below, so every
 *    route in this module — including one added next year by someone who never
 *    read this file — gets `?office=roland|valley` validated before its handler
 *    runs and finds it on `req.hygOffice`. RCM does the same and documents the
 *    same reason; TC could not, because its voice handoff carries office in the
 *    BODY as a frozen external contract. Hyg has no such exception and this
 *    ordering is what keeps it that way. If one ever becomes necessary it must
 *    be mounted ABOVE this line with the reason written at the mount.
 *
 * 2. There is no QUEUE_PATHS equivalent here and there should not be one until
 *    a route genuinely needs it. The mount's requireReadWrite('hyg.read',
 *    'hyg.write') applies by HTTP METHOD, so slice 2's mutations demand
 *    hyg.write by construction rather than by whoever wrote them remembering.
 *    `hygVisitGuard.test.js` proves that for real: a read-only hygiene role
 *    gets the day and the visit, and is refused every POST, PUT and DELETE.
 *    An exemption list added "for later" is an exemption nobody reviewed.
 */

const express = require('express');

const { requireOffice } = require('./helpers');

const router = express.Router();

/** Office scoping is router-wide. See note 1 above before adding a mount. */
router.use(requireOffice);

router.use('/day', require('./day'));
router.use('/visit', require('./visit'));

module.exports = router;

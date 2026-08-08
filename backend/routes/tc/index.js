'use strict';

/**
 * /api/tc — the Treatment Coordinator module (Slice 3 backend port).
 *
 * ONE mount in server.js, behind requireModule('tc'). Ships DARK: no tenant is
 * entitled to 'tc' yet, so every route 403s (MODULE_NOT_ENTITLED) in every
 * environment until the entitlement flips — that is intentional.
 *
 * Route families (each module documents its own surface):
 *   /cases/from-call  voice → TC handoff intake (idempotent attach-or-create)
 *   /cases            case aggregate CRUD + status + phases/objections/events
 *   /followups        THE unified outreach queue (due / complete / reschedule)
 *   /hygiene-intakes  hygiene → TC handoff (submit / mine / inbox / claim)
 *   /preauth          pre-authorization CRUD + status flow
 *   /templates        email template CRUD (seed-protected)
 *   /communications   email log (send pipeline FEATURE_DISABLED until Slice 7)
 *   /gallery          before/after metadata (blob keys only)
 *   /smile-sim        smile-sim metadata (generate FEATURE_DISABLED until Slice 7)
 *   /media            entitlement-checked blob proxy (managed identity)
 *   /library          per-office library config (server-owned settings)
 *   /od               Open Dental READS (Slice 5) — patient search, treatment
 *                     plans, unaccepted finder, COB + insurance, next appointment
 *
 * NOT here: the OD commlog write (review-then-send → Slice 6). Every /od route
 * is a GET and the OD transport has no write counterpart, so this module cannot
 * write to Open Dental. No scheduling.
 */

const express = require('express');

const router = express.Router();

// MUST precede the /cases mount: express matches mounts in registration order,
// and './cases' applies requireOffice to everything under it — but the voice
// handoff carries its office in the body (frozen contract), not in ?office=.
// See intakeFromCall.js for why that is deliberate rather than a loophole.
router.use('/cases/from-call', require('./intakeFromCall'));
router.use('/cases', require('./cases'));
router.use('/followups', require('./followups'));
router.use('/hygiene-intakes', require('./hygiene'));
router.use('/preauth', require('./preauth'));
router.use('/templates', require('./templates'));
router.use('/communications', require('./communications'));
router.use('/gallery', require('./gallery'));
router.use('/smile-sim', require('./smileSim'));
router.use('/media', require('./media'));
router.use('/library', require('./library'));
router.use('/od', require('./od'));

module.exports = router;

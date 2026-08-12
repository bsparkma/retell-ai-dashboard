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

const { requirePermission } = require('../../config/permissions');

const router = express.Router();

/**
 * ROLE GATING (Roles PR A) — the /api/tc surface splits in exactly two.
 *
 *   tc.full     admin | office | tc        everything below except the next line
 *   tc.hygiene  admin | office | tc | hyg  the hygiene handoff: submit an intake,
 *                                          see my own submissions, see the inbox
 *
 * `hygiene` is the only role the split exists for: a hygienist submits findings
 * and watches them land, and has no business in the pipeline, the money fields,
 * the pre-auths, the email log, or the Open Dental reads.
 *
 * One deliberate exception INSIDE the hygiene router: POST /:caseId/claim is a
 * TC action — it assigns the caller as the case's TC and advances the status —
 * so it carries tc.full even though it lives on a Hygiene-nav page. A hygienist
 * can see the inbox; they cannot take a case out of it. See hygiene.js.
 */
const tcFull = requirePermission('tc.full');

// MUST precede the /cases mount: express matches mounts in registration order,
// and './cases' applies requireOffice to everything under it — but the voice
// handoff carries its office in the body (frozen contract), not in ?office=.
// See intakeFromCall.js for why that is deliberate rather than a loophole.
router.use('/cases/from-call', tcFull, require('./intakeFromCall'));
router.use('/cases', tcFull, require('./cases'));
router.use('/followups', tcFull, require('./followups'));
router.use('/hygiene-intakes', requirePermission('tc.hygiene'), require('./hygiene'));
router.use('/preauth', tcFull, require('./preauth'));
router.use('/templates', tcFull, require('./templates'));
router.use('/communications', tcFull, require('./communications'));
router.use('/gallery', tcFull, require('./gallery'));
router.use('/smile-sim', tcFull, require('./smileSim'));
router.use('/media', tcFull, require('./media'));
router.use('/library', tcFull, require('./library'));
router.use('/od', tcFull, require('./od'));

module.exports = router;

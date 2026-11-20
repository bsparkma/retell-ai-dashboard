'use strict';

/**
 * /api/tc/email-library — the TC patient email library as WORDING CONFIG +
 * PREVIEW (EL-1). DARK: nothing here creates a draft, a tc_messages row or a
 * send, calls Open Dental, or calls an AI model.
 *
 *   GET  /catalog?office=   library version, the clinically-approved flag, the
 *                           procedures this office provides, stages, tones,
 *                           sequences and the questionnaire (minus office_name
 *                           and office_phone)
 *   GET  /profile?office=   the saved answers; `missing` (a setting some email
 *                           still prints as its {{token}}, normally none) and
 *                           `blankOptional` (the optional settings left blank)
 *   PUT  /profile?office=   { answers } — whole-object replace. Validated (one
 *                           refusal code per failure), upserted and read back in
 *                           ONE tenant transaction, audited. Practice admins only.
 *   POST /preview?office=   { procedure_id, stage, variant, answers? } — compose
 *                           one email with the saved answers (or the supplied,
 *                           validated, never-persisted ones) and fill the merge
 *                           fields this page can honestly fill
 *
 * WHO. The mount is tc.full like every TC mount (routes/tc/index.js,
 * test/roleGateWiring.test.js). PUT additionally requires admin.all, the gate
 * MT-2c put on /api/admin/office-settings — requirePermission('admin.all'),
 * attached to the PUT route itself so reads stay open to tc.full and a non-admin
 * sees the page read-only.
 *
 * THE OFFICE comes from ?office= (requireOffice: one of the session tenant's
 * offices), never from the body.
 *
 * PREVIEW MERGE VALUES, and where each comes from:
 *   office_name, office_phone   the office's saved email identity, via
 *                               config/tcNurture officeMergeValues(tenant, office)
 *   first_name                  the fixed sample "Jordan"
 *   sender_name                 the signed-in user's display name
 *   appointment_date / _time    fixed samples
 *   doctor_name, schedule_link  the answers (since library 1.2.0 the composer
 *                               writes both into the text, so they are normally
 *                               not tokens any more; kept for any that are)
 * Anything without a value stays as its {{token}} and is listed in
 * `unresolved` — never blank, never invented. An unconfigured phone counts as
 * unset (officeMergeValues' "the office" fallback is send-time copy, and the
 * preview's job is to show the office what it has not set).
 *
 * RETIRED SAVED KEYS. A profile saved under an older library version may hold a
 * key that version retired (EMAIL_LIBRARY_RETIRED_SAVED_KEYS: review_link, gone
 * in 1.2.0). Every READ strips exactly those before validating, so the office
 * is not locked out with the STALE 409; the row is not rewritten, and the key
 * disappears at the office's next save. A PUT that sends one is still refused
 * as an unknown key, and any other unknown saved key is still STALE.
 */

const express = require('express');

const { contract, requireOffice, actorEmail, parseBody, h, auditTc, iso } = require('./helpers');
const { withTenantTx } = require('./tx');
const tenantDb = require('../../platform/tenantDb');
const { sessionTenantSlug } = require('../../platform/sessionTenant');
const { holdsPermission, requirePermission } = require('../../config/permissions');
const emailIdentity = require('../../config/emailIdentity');
const { officeMergeValues } = require('../../config/tcNurture');
const library = require('../../services/tcEmailLibrary');
const profileStore = require('../../services/tcEmailLibrary/profileStore');

const {
  EmailLibraryProfilePutRequest,
  EmailLibraryPreviewRequest,
  EMAIL_LIBRARY_PREVIEW_SAMPLES,
  EMAIL_LIBRARY_RETIRED_SAVED_KEYS,
  validateEmailLibraryAnswers,
} = contract;

const router = express.Router();
router.use(requireOffice);

/** The practice-admin gate PUT carries on top of the mount's tc.full. */
const requirePracticeAdmin = requirePermission('admin.all');

/**
 * 400 with the validator's code.
 * @param {import('express').Response} res
 * @param {{ code: string, key: string|null, message: string }} v
 */
function refuseAnswers(res, v) {
  return res.status(400).json({ success: false, error: v.message, code: v.code, field: v.key });
}

/**
 * The saved profile, or null when the office has never saved. A stored row that
 * no longer validates (a later library dropped a question) is reported, not
 * silently repaired.
 * @param {import('express').Request} req
 */
async function loadSaved(req) {
  return tenantDb.withTenantDb(req, (pool) => profileStore.readProfile(pool, req.tcOffice));
}

/**
 * A saved answers object without the keys a later library retired. Read-side
 * only: the row itself is left as it is.
 * @param {unknown} answers
 * @returns {unknown}
 */
function withoutRetiredKeys(answers) {
  if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) return answers;
  const out = { .../** @type {Record<string, unknown>} */ (answers) };
  for (const key of EMAIL_LIBRARY_RETIRED_SAVED_KEYS) delete out[key];
  return out;
}

/**
 * @param {import('express').Request} req
 * @param {Awaited<ReturnType<typeof profileStore.readProfile>>} stored
 * @param {Record<string, unknown>} answers the stored answers, validated
 */
function profileBody(req, stored, answers) {
  return {
    success: true,
    office: req.tcOffice,
    saved: Boolean(stored),
    answers,
    libraryVersion: stored ? stored.libraryVersion : null,
    updatedBy: stored ? stored.updatedBy : null,
    updatedAt: stored ? iso(stored.updatedAt) : null,
    missing: library.missingSettings(answers),
    blankOptional: library.blankOptionalSettings(answers),
    canEdit: holdsPermission(req, 'admin.all'),
  };
}

/**
 * Saved answers re-validated, after dropping the retired keys. A row is only
 * ever written validated, so a failure here means the library changed under it
 * in a way this version does not tolerate.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<{ stored: Awaited<ReturnType<typeof profileStore.readProfile>>, answers: Record<string, unknown> } | null>}
 */
async function savedAnswersOr409(req, res) {
  const stored = await loadSaved(req);
  if (!stored) return { stored: null, answers: {} };
  const v = validateEmailLibraryAnswers(withoutRetiredKeys(stored.answers));
  if (!v.ok) {
    res.status(409).json({
      success: false,
      error: "This office's saved answers no longer match the library. Review them and save again.",
      code: 'EMAIL_LIBRARY_SAVED_ANSWERS_STALE',
      field: v.key,
    });
    return null;
  }
  return { stored, answers: v.answers };
}

// ── GET /catalog ─────────────────────────────────────────────────────────────

router.get(
  '/catalog',
  h(async (req, res) => {
    const saved = await savedAnswersOr409(req, res);
    if (!saved) return;
    res.json(library.catalog(req.tcOffice, saved.answers));
  })
);

// ── GET /profile ─────────────────────────────────────────────────────────────

router.get(
  '/profile',
  h(async (req, res) => {
    const saved = await savedAnswersOr409(req, res);
    if (!saved) return;
    res.json(profileBody(req, saved.stored, saved.answers));
  })
);

// ── PUT /profile ─────────────────────────────────────────────────────────────

router.put(
  '/profile',
  requirePracticeAdmin,
  h(async (req, res) => {
    const body = parseBody(res, EmailLibraryProfilePutRequest, req.body);
    if (!body) return;
    const v = validateEmailLibraryAnswers(body.answers);
    if (!v.ok) return refuseAnswers(res, v);

    const office = req.tcOffice;
    const actor = String(actorEmail(req)).trim().toLowerCase();

    const outcome = await withTenantTx(req, async (client) => {
      const prior = await profileStore.readProfile(client, office);
      await profileStore.upsertProfile(client, {
        office,
        answers: v.answers,
        libraryVersion: library.LIBRARY_VERSION,
        updatedBy: actor,
      });
      const readBack = await profileStore.readProfile(client, office);
      if (
        !readBack ||
        !profileStore.sameAnswers(readBack.answers, v.answers) ||
        readBack.libraryVersion !== library.LIBRARY_VERSION ||
        readBack.updatedBy !== actor
      ) {
        // Throwing rolls the transaction back: nothing half-saved survives.
        const err = new Error('read-back mismatch');
        err.code = 'EMAIL_LIBRARY_READBACK_MISMATCH';
        throw err;
      }
      return { prior, readBack };
    }).catch((err) => {
      if (err && err.code === 'EMAIL_LIBRARY_READBACK_MISMATCH') return null;
      throw err;
    });

    if (!outcome) {
      return res.status(500).json({
        success: false,
        error: 'The answers could not be confirmed as saved, so nothing was changed. Try again.',
        code: 'EMAIL_LIBRARY_READBACK_MISMATCH',
      });
    }

    await auditTc(req, 'UPDATE', 'tc_email_library_profile', office, {
      office,
      priorState: outcome.prior ? 'stored' : 'unset',
    });
    return res.json(profileBody(req, outcome.readBack, v.answers));
  })
);

// ── POST /preview ────────────────────────────────────────────────────────────

router.post(
  '/preview',
  h(async (req, res) => {
    const body = parseBody(res, EmailLibraryPreviewRequest, req.body);
    if (!body) return;

    /** @type {Record<string, unknown>} */
    let answers;
    /** @type {'saved'|'unsaved'} */
    let answersSource;
    if (body.answers !== undefined) {
      const v = validateEmailLibraryAnswers(body.answers);
      if (!v.ok) return refuseAnswers(res, v);
      answers = v.answers;
      answersSource = 'unsaved';
    } else {
      const saved = await savedAnswersOr409(req, res);
      if (!saved) return;
      answers = saved.answers;
      answersSource = 'saved';
    }

    let email;
    try {
      email = library.composeOne({ procedureId: body.procedure_id, stage: body.stage, variant: body.variant }, answers);
    } catch (err) {
      if (err instanceof library.EmailLibraryError) {
        return res.status(err.status).json({ success: false, error: err.message, code: err.code });
      }
      throw err;
    }

    const tenantSlug = sessionTenantSlug(req);
    // The identity is cached process-wide; read it fresh, as GET /email-identity does.
    await emailIdentity.refreshFromDb(tenantSlug);
    const merge = officeMergeValues(tenantSlug, req.tcOffice);
    const officeName = merge.officeName && merge.officeName !== 'Unmapped' ? merge.officeName : null;
    const senderName = req.user && typeof req.user.name === 'string' ? req.user.name.trim() : '';

    const resolved = library.resolveMergeFields([email.subject, email.preheader, email.body_text], {
      first_name: EMAIL_LIBRARY_PREVIEW_SAMPLES.first_name,
      appointment_date: EMAIL_LIBRARY_PREVIEW_SAMPLES.appointment_date,
      appointment_time: EMAIL_LIBRARY_PREVIEW_SAMPLES.appointment_time,
      office_name: officeName,
      office_phone: merge.phoneConfigured ? merge.officePhone : null,
      sender_name: senderName || null,
      doctor_name: typeof answers.doctor_name === 'string' ? answers.doctor_name : null,
      schedule_link: typeof answers.schedule_link === 'string' ? answers.schedule_link : null,
    });
    const [subject, preheader, bodyText] = resolved.texts;

    return res.json({
      success: true,
      office: req.tcOffice,
      id: email.id,
      procedureId: email.procedure_id,
      procedureName: email.procedure_name,
      stage: email.stage,
      stageLabel: email.stage_label,
      variant: email.variant,
      tone: email.tone,
      answersSource,
      subject,
      preheader,
      bodyText,
      mergeFields: email.merge_fields,
      unresolved: resolved.unresolved,
      wordCount: email.word_count,
      clinicallyApproved: library.LIBRARY_CLINICALLY_APPROVED,
    });
  })
);

module.exports = router;

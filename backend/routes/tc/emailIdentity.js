'use strict';

/**
 * /api/tc/email-identity — the office's email identity, editable in the app (R5c).
 *
 *   GET  /?office=   what every email from this office uses right now, field by
 *                    field, where it comes from, and the (read-only) From address
 *   PUT  /?office=   save the office's whole identity  { replyTo, practiceName,
 *                    practicePhone }, each a string or null (null = clear, back
 *                    to the app setting)
 *
 * WHO: `tc.notification_defaults` (admin + office), applied at the mount — the
 * same people who run the office's alert defaults run what its email says.
 *
 * WHAT IT IS NOT: the From address. It is bound to the verified sending domain
 * and stays an app setting; GET shows it, nothing here can change it, and the
 * strict body refuses a `from` (or any other) key with a 400.
 *
 * THE OFFICE comes from ?office= (requireOffice), never from the body.
 *
 * HONEST STATE: every answer is read back. GET re-reads the control plane first;
 * PUT writes, re-reads FROM the database, and refuses (500) if what is stored is
 * not what was asked for.
 *
 * AUDIT: one tc_email_identity_changes row per field changed, holding the value
 * it replaced and the new one (written in the same tenant transaction as the
 * save, so a failed save leaves no history), plus one audit_log row per field
 * with prior_state `stored` | `unset` (audit_log can hold only a slug).
 *
 * Nothing here reaches Open Dental, a patient, or the send path's gates; the
 * send path reads these values through config/acsEmail.js.
 */

const express = require('express');

const { contract, requireOffice, actorEmail, parseBody, h, auditTc } = require('./helpers');
const { withTenantTx } = require('./tx');
const acsConfig = require('../../config/acsEmail');
const emailIdentity = require('../../config/emailIdentity');

const { TcEmailIdentityRequest } = contract;

/** The contract's field name -> the history table's field slug. */
const FIELD_SLUG = Object.freeze({
  replyTo: 'reply_to',
  practiceName: 'practice_name',
  practicePhone: 'practice_phone',
});

const router = express.Router();
router.use(requireOffice);

/** @param {string} office */
function stateOf(office) {
  return {
    success: true,
    office,
    fields: acsConfig.identityStateFor(office),
    from: {
      patientEmail: acsConfig.fromAddressFor(office),
      referral: acsConfig.ownFromAddressFor(office),
    },
    ...emailIdentity.meta(),
  };
}

router.get(
  '/',
  h(async (req, res) => {
    await emailIdentity.refreshFromDb();
    res.json(stateOf(req.tcOffice));
  })
);

router.put(
  '/',
  h(async (req, res) => {
    const body = parseBody(res, TcEmailIdentityRequest, req.body);
    if (!body) return undefined;
    const office = req.tcOffice;
    const actor = String(actorEmail(req)).trim().toLowerCase();

    /** @type {Record<string, string|null>} */
    const next = {};
    for (const field of emailIdentity.FIELD_NAMES) {
      const raw = body[field];
      if (raw === null) {
        next[field] = null;
        continue;
      }
      const clean = emailIdentity.normalizeField(field, raw);
      if (clean === null) {
        return res.status(400).json({ success: false, error: `${field} is not usable`, code: 'VALIDATION_ERROR' });
      }
      next[field] = clean;
    }

    let prior;
    try {
      prior = (await emailIdentity.readStoredFromDb(office)).office;
    } catch (err) {
      console.error('[tc/emailIdentity] could not read the saved identity:', err && err.message);
      return res.status(503).json({
        success: false,
        error: 'The saved email identity could not be read, so nothing was changed. Try again in a minute.',
        code: 'IDENTITY_UNAVAILABLE',
      });
    }

    const changed = emailIdentity.FIELD_NAMES.filter((f) => prior[f] !== next[f]);
    if (changed.length === 0) return res.json(stateOf(office));

    try {
      await withTenantTx(req, async (client) => {
        for (const field of changed) {
          await client.query(
            `INSERT INTO tc_email_identity_changes (office_id, field, prior_value, new_value, changed_by)
              VALUES ($1, $2, $3, $4, $5)`,
            [office, FIELD_SLUG[field], prior[field], next[field], actor]
          );
        }
        // Last inside the transaction: if the control-plane write (or its
        // read-back) fails, the history rows roll back with it.
        await emailIdentity.persist(office, next, actor);
      });
    } catch (err) {
      if (err && err.code === 'IDENTITY_READBACK_FAILED') {
        return res.status(500).json({
          success: false,
          error: 'The email identity may not have saved as entered. Reload the page to see what is in force.',
          code: 'IDENTITY_READBACK_FAILED',
        });
      }
      throw err;
    }

    for (const field of changed) {
      await auditTc(req, 'UPDATE', 'tc_email_identity', `${office}/${FIELD_SLUG[field]}`, {
        office,
        priorState: prior[field] === null ? 'unset' : 'stored',
      });
    }
    res.json(stateOf(office));
  })
);

module.exports = router;

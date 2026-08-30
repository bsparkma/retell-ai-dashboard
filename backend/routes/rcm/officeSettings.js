'use strict';

/**
 * /api/rcm/office-settings — the shadow gate's switch.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO ROUTES, ONE TIER
 * ─────────────────────────────────────────────────────────────────────────────
 *   GET  /:office   the current state, who last changed it, when   rcm.settings
 *   PUT  /:office   flip it                                        rcm.settings
 *
 * `rcm.settings` is `admin` and nothing else — narrower than `rcm.post`, which
 * `office` also holds. Deciding that a practice may post at all is a different
 * authority from pressing Drain once it may: an `office` user runs the day, an
 * `admin` decides what the day is allowed to do.
 *
 * THE READ IS GATED TOO, and that is deliberate rather than defensive. The
 * screen behind this is a control, not a status line — the Posting page and the
 * RCM inbox already tell every role whether posting is on, in the words that
 * matter to them ("Shadow"). A second, un-flippable copy of the same fact on an
 * admin screen a non-admin can open would be a control that argues with itself.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NEVER AN ENV VAR
 * ─────────────────────────────────────────────────────────────────────────────
 * The state lives in `rcm_office_settings`, one row per office, seeded `false`
 * by the tenant migration. It survives a redeploy, it is visible in the UI, and
 * flipping it leaves a name and an instant behind. An app setting could do none
 * of those three.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * OFFICE COMES FROM THE ROUTER, AND THE PATH CAN ONLY AGREE OR REFUSE
 * ─────────────────────────────────────────────────────────────────────────────
 * `requireOffice` has already validated `?office=` and put it on
 * `req.rcmOffice` before this router is reached. The `:office` path segment and
 * an `office` in the body are ASSERTIONS: they may agree with it, or the
 * request is refused. Neither can redirect the write to another practice. Same
 * property `send-to-TC` has, for the same reason.
 */

const express = require('express');

const tenantDb = require('../../platform/tenantDb');
const { audit } = require('../../platform/audit');
const { requirePermission } = require('../../config/permissions');
const postingDrain = require('../../services/rcm/postingDrain');
const postingGate = require('../../services/rcm/postingGate');
const { resolveRcmActor } = require('../../services/rcm/rcmUserMap');
const { h, OFFICES, actorEmail, auditRcmDenial, iso } = require('./helpers');

const router = express.Router();

/**
 * `:office` (and any `office` in the body) against the office the router
 * already validated.
 *
 * Returns the refusal to send, or null when everything agrees. Two distinct
 * codes because they are two distinct mistakes: a key that is not an office at
 * all is a malformed request, and a key that IS an office but not THIS one is a
 * cross-office attempt, which this platform answers with `OFFICE_MISMATCH`
 * everywhere it can happen.
 *
 * @param {import('express').Request} req
 * @returns {{ status: number, body: object }|null}
 */
function officeAssertion(req) {
  const office = req.rcmOffice;
  const named = String(req.params.office || '');

  if (!OFFICES.includes(named)) {
    return {
      status: 400,
      body: {
        success: false,
        error: `office must be one of: ${OFFICES.join(', ')}`,
        code: 'INVALID_OFFICE',
      },
    };
  }
  if (named !== office) {
    return {
      status: 409,
      body: {
        success: false,
        error: `This request names '${named}' in the path and '${office}' in the query. Nothing was changed.`,
        code: 'OFFICE_MISMATCH',
      },
    };
  }

  const bodyOffice = req.body && req.body.office;
  if (bodyOffice !== undefined && String(bodyOffice) !== office) {
    return {
      status: 409,
      body: {
        success: false,
        error: `This request names '${String(bodyOffice)}' in the body and '${office}' in the query. Nothing was changed.`,
        code: 'OFFICE_MISMATCH',
      },
    };
  }

  return null;
}

/** The wire shape, from a `postingGate.readOfficeSettings` result. */
function toSettings(office, settings) {
  return {
    office,
    /** The switch. */
    drainEnabled: settings.drainEnabled,
    /** Null on a seeded row nobody has touched — a different fact from "off since". */
    updatedAt: iso(settings.updatedAt),
    /** The D-5 crosswalk key of whoever last flipped it. Null likewise. */
    updatedBy: settings.updatedBy,
    /**
     * The CODE ceiling (D-7). Reported beside the switch because they are the
     * two conditions a drain needs, and an admin switching an office on wants to
     * know immediately if the other one is still false — otherwise the toggle
     * reads as broken.
     */
    postingEnabled: postingDrain.OFFICES_ENABLED_FOR_POSTING.includes(office),
    /**
     * True when the settings row is missing entirely (migrations not run, or a
     * row removed). The switch reads `false` regardless — this says WHY, so the
     * screen can send an admin to the migration rather than to the toggle.
     */
    rowMissing: settings.rowMissing,
    /**
     * HOW THIS OFFICE BOOKS A WRITE-OFF IT CHOSE TO MAKE (Stage B1).
     *
     * Roland books a voluntary write-off into the claimproc's own WriteOff field
     * plus a note and uses no adjustment type; other practices book the same
     * decision as a ledger adjustment. Both are correct bookkeeping and they are
     * not the same Open Dental call, so this is a fact about the practice and it
     * lives beside the practice's other posting settings.
     */
    writeoffMode: settings.writeoffMode,
    /** The AdjType NAME, never a DefNum (D-13). Null under `writeoff_field`. */
    writeoffAdjTypeName: settings.writeoffAdjTypeName,
    /** The list the PUT accepts, so a screen renders the server's own options. */
    writeoffModes: postingGate.WRITEOFF_MODES,
  };
}

/**
 * GET /:office — what the switch says, and who last said it.
 *
 * NO AUDIT ROW. This carries no patient data of any kind: an office key, a
 * boolean, a crosswalk key and an instant. Hard rule 5 audits PHI reads; a
 * configuration read is not one, and filling the trail with them would make the
 * PHI rows harder to find.
 */
router.get(
  '/:office',
  requirePermission('rcm.settings'),
  h(async (req, res) => {
    const refusal = officeAssertion(req);
    if (refusal) return res.status(refusal.status).json(refusal.body);

    const office = req.rcmOffice;
    const settings = await tenantDb.withTenantDb(req, (pool) =>
      postingGate.readOfficeSettings(pool, office)
    );
    return res.json({ success: true, settings: toSettings(office, settings) });
  })
);

/**
 * PUT /:office — flip it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT TAKES, AND WHAT IT REFUSES
 * ─────────────────────────────────────────────────────────────────────────────
 * `{ drainEnabled: boolean }`, and nothing else. A missing or non-boolean value
 * is a 400 rather than a coercion: `"false"` is a truthy string, and a switch
 * that turned posting ON because somebody sent the word "false" would be the
 * worst possible way to learn that.
 *
 * The write is an UPDATE, never an upsert. The migration seeds one row per
 * office — the office set is a migration everywhere else in this schema, and a
 * route that could mint a settings row could mint one for an office the CHECK
 * constraints refuse. A missing row is therefore a 409 that names the fix, not
 * a row this route quietly creates.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE AUDIT ROW, AND WHY THERE ARE NO NEW COLUMNS
 * ─────────────────────────────────────────────────────────────────────────────
 * `UPDATE rcm_office_settings <office>`, one row per flip, and that is the
 * append-only history of every time posting was switched on or off. The BEFORE
 * and AFTER live in the settings row itself — `drain_updated_by` and
 * `drain_updated_at` say who and when, and the boolean says what it is now.
 * `audit_log` gains no columns for this: rule 13 is one row per read and per
 * write, and a diff column would be a second schema for something two existing
 * columns already hold.
 */
router.put(
  '/:office',
  requirePermission('rcm.settings'),
  h(async (req, res) => {
    const refusal = officeAssertion(req);
    if (refusal) return res.status(refusal.status).json(refusal.body);

    const office = req.rcmOffice;
    const wanted = req.body && req.body.drainEnabled;
    if (typeof wanted !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: 'drainEnabled must be true or false',
        code: 'INVALID_SETTING',
      });
    }

    const email = actorEmail(req);
    const displayName = (req.user && (req.user.name || req.user.displayName)) || email;

    const updated = await tenantDb.withTenantDb(req, async (pool) => {
      // D-5 attribution, resolved first so the FK on `updated_by` is satisfiable
      // by the statement that sets it.
      const updatedBy = await resolveRcmActor(pool, { email, displayName });
      const { rows } = await pool.query(postingGate.QUERIES.setDrainEnabled, [
        wanted,
        updatedBy,
        office,
      ]);
      return rows[0] || null;
    });

    if (!updated) {
      await auditRcmDenial(req, 'rcm_office_settings', office, { office, result: 'ERROR' });
      return res.status(409).json({
        success: false,
        error:
          `There is no posting-settings row for '${office}'. The tenant migration seeds one ` +
          'per office — run migrations. Posting stays switched off until it exists.',
        code: 'OFFICE_SETTINGS_MISSING',
      });
    }

    /*
     * Written AFTER the fact, like every other decision audit in this module:
     * what is being recorded has already durably happened.
     */
    await audit(req, {
      action: 'UPDATE',
      resourceType: 'rcm_office_settings',
      resourceId: office,
      result: 'SUCCESS',
      office,
      sourceRef: null,
    });

    return res.json({
      success: true,
      settings: toSettings(office, fromRow(updated)),
    });
  })
);

/**
 * A RETURNING row from either UPDATE, in `readOfficeSettings`' shape.
 *
 * One mapper for both statements so a column added to the SELECT and to the
 * RETURNING cannot arrive on the GET and go missing from the PUT — which is
 * exactly what a screen that "did not save" looks like from the outside.
 */
function fromRow(row) {
  return {
    drainEnabled: row.drain_enabled === true,
    updatedAt: row.drain_updated_at,
    updatedBy: row.drain_updated_by == null ? null : String(row.drain_updated_by),
    writeoffMode: postingGate.WRITEOFF_MODES.includes(row.writeoff_mode)
      ? String(row.writeoff_mode)
      : postingGate.DEFAULT_WRITEOFF_MODE,
    writeoffAdjTypeName: row.writeoff_adjtype_name == null ? null : String(row.writeoff_adjtype_name),
    rowMissing: false,
  };
}

/**
 * PUT /:office/writeoff-mode — how this practice books a write-off it chose.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A SECOND ROUTE, NOT A WIDER BODY ON THE FIRST
 * ─────────────────────────────────────────────────────────────────────────────
 * `PUT /:office` takes `{ drainEnabled }` and nothing else, deliberately: it is
 * the switch that decides whether this practice may write to a chart at all, and
 * a body that could also carry other settings is a body where a typo in one
 * field arrives alongside a flip of the other. Two authorisations, two routes,
 * two audit rows — and the switch's own timestamp keeps meaning "when was
 * posting last switched" rather than "when did anybody last edit this row".
 *
 * Same `rcm.settings` tier (admin, and narrower than the `rcm.post` that presses
 * the post button), same office assertion, same refusal to upsert.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ADJUSTMENT TYPE IS A NAME, AND IT IS REQUIRED WITH ITS MODE (D-13)
 * ─────────────────────────────────────────────────────────────────────────────
 * DefNums are per-database: 260 is one thing in Roland and something else in
 * Riley, and a number copied between practices writes the wrong type into the
 * wrong chart. So this stores the NAME, resolved live against that office's own
 * definitions at post time — and a name that resolves to nothing there refuses
 * the claim rather than falling back to a default.
 *
 * A blank name under `adjustment_by_name` is refused HERE as well as by the
 * CHECK constraint, so the failure is a sentence at the moment of typing rather
 * than a 23514 the drain discovers.
 */
router.put(
  '/:office/writeoff-mode',
  requirePermission('rcm.settings'),
  h(async (req, res) => {
    const refusal = officeAssertion(req);
    if (refusal) return res.status(refusal.status).json(refusal.body);

    const office = req.rcmOffice;
    const mode = req.body && req.body.writeoffMode;
    if (!postingGate.WRITEOFF_MODES.includes(mode)) {
      return res.status(400).json({
        success: false,
        error: `writeoffMode must be one of: ${postingGate.WRITEOFF_MODES.join(', ')}`,
        code: 'INVALID_SETTING',
      });
    }

    const rawName = req.body && req.body.writeoffAdjTypeName;
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (mode === 'adjustment_by_name' && name.length === 0) {
      return res.status(400).json({
        success: false,
        error:
          'Name the adjustment type this practice books write-offs under, exactly as it is ' +
          "spelled in that practice's Open Dental. A number will not do — definition numbers " +
          'differ between practices.',
        code: 'ADJTYPE_NAME_REQUIRED',
      });
    }

    const updated = await tenantDb.withTenantDb(req, async (pool) => {
      const { rows } = await pool.query(postingGate.QUERIES.setWriteoffMode, [
        mode,
        // Kept when switching back to `writeoff_field`, so a practice that flips
        // to look at the other mode does not have to retype it.
        name.length > 0 ? name : null,
        office,
      ]);
      return rows[0] || null;
    });

    if (!updated) {
      await auditRcmDenial(req, 'rcm_office_settings', office, { office, result: 'ERROR' });
      return res.status(409).json({
        success: false,
        error:
          `There is no posting-settings row for '${office}'. The tenant migration seeds one ` +
          'per office — run migrations.',
        code: 'OFFICE_SETTINGS_MISSING',
      });
    }

    await audit(req, {
      action: 'UPDATE',
      resourceType: 'rcm_office_settings',
      resourceId: office,
      result: 'SUCCESS',
      office,
      sourceRef: null,
    });

    return res.json({ success: true, settings: toSettings(office, fromRow(updated)) });
  })
);

module.exports = router;

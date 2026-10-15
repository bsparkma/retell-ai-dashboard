'use strict';

/**
 * /api/tc/notification-prefs — in-app alert preferences (queue item 51).
 *
 *   GET  /                 every event's effective level for the CALLER in
 *                          this office, with where it came from
 *   PUT  /mine/:event      the caller's own override   { level | null }
 *   PUT  /office/:event    the office default (admin)  { level | null }
 *
 * Effective = the caller's override ?? the office default ?? 'banner'.
 *
 * WHO. A person's override is keyed by their sign-in email, lowercased, from
 * the session — never a request field, so nobody can set somebody else's.
 * The office default needs `admin.all` (the practice admin): it changes what
 * every user in the office hears.
 *
 * Every change is audited with `prior_state` = the level it replaced, or
 * `unset` — slugs only, so the trail stays inside the prior_state grammar.
 * Nothing here reaches Open Dental, a patient, or anything outside the tab.
 */

const express = require('express');

const { contract, requireOffice, actorEmail, parseBody, h, auditTc } = require('./helpers');
const tenantDb = require('../../platform/tenantDb');
const { holdsPermission } = require('../../config/permissions');

const {
  TcNotificationEvent,
  TcNotificationMineRequest,
  TcNotificationOfficeRequest,
  resolveNotificationLevel,
} = contract;

const router = express.Router();
router.use(requireOffice);

/** The signed-in person's key: their email, lowercased. */
function userKey(req) {
  return String(actorEmail(req) || '').trim().toLowerCase();
}

function badEvent(res, raw) {
  return res.status(400).json({
    success: false,
    error: `event must be one of: ${TcNotificationEvent.options.join(', ')} (got '${raw}')`,
    code: 'INVALID_EVENT',
  });
}

async function readState(req) {
  const office = req.tcOffice;
  const user = userKey(req);
  const [defaults, mine] = await tenantDb.withTenantDb(req, (pool) =>
    Promise.all([
      pool.query('SELECT event, level FROM tc_notification_defaults WHERE office_id = $1', [office]),
      pool.query('SELECT event, level FROM tc_notification_prefs WHERE user_email = $1', [user]),
    ])
  );
  const officeBy = new Map(defaults.rows.map((r) => [r.event, r.level]));
  const mineBy = new Map(mine.rows.map((r) => [r.event, r.level]));
  return {
    success: true,
    office,
    canEditOffice: holdsPermission(req, 'tc.notification_defaults'),
    events: TcNotificationEvent.options.map((event) => {
      const m = mineBy.get(event) ?? null;
      const o = officeBy.get(event) ?? null;
      return { event, ...resolveNotificationLevel(m, o), mine: m, officeDefault: o };
    }),
  };
}

router.get(
  '/',
  h(async (req, res) => {
    res.json(await readState(req));
  })
);

router.put(
  '/mine/:event',
  h(async (req, res) => {
    const event = TcNotificationEvent.safeParse(req.params.event);
    if (!event.success) return badEvent(res, req.params.event);
    const body = parseBody(res, TcNotificationMineRequest, req.body);
    if (!body) return undefined;
    const user = userKey(req);
    if (!user) {
      return res.status(403).json({ success: false, error: 'No signed-in user to save preferences for', code: 'NO_USER' });
    }

    const prior = await tenantDb.withTenantDb(req, async (pool) => {
      const before = await pool.query(
        'SELECT level FROM tc_notification_prefs WHERE user_email = $1 AND event = $2',
        [user, event.data]
      );
      if (body.level === null) {
        await pool.query('DELETE FROM tc_notification_prefs WHERE user_email = $1 AND event = $2', [
          user,
          event.data,
        ]);
      } else {
        await pool.query(
          `INSERT INTO tc_notification_prefs (user_email, event, level)
            VALUES ($1, $2, $3)
            ON CONFLICT (user_email, event)
            DO UPDATE SET level = EXCLUDED.level, updated_at = now()`,
          [user, event.data, body.level]
        );
      }
      return before.rows[0] ? before.rows[0].level : 'unset';
    });

    await auditTc(req, 'UPDATE', 'tc_notification_pref', event.data, { office: req.tcOffice, priorState: prior });
    res.json(await readState(req));
  })
);

router.put(
  '/office/:event',
  h(async (req, res) => {
    if (!holdsPermission(req, 'tc.notification_defaults')) {
      return res.status(403).json({
        success: false,
        error: "Only a practice admin or office manager can change the office's default alerts",
        code: 'FORBIDDEN',
      });
    }
    const event = TcNotificationEvent.safeParse(req.params.event);
    if (!event.success) return badEvent(res, req.params.event);
    const body = parseBody(res, TcNotificationOfficeRequest, req.body);
    if (!body) return undefined;
    const office = req.tcOffice;

    const prior = await tenantDb.withTenantDb(req, async (pool) => {
      const before = await pool.query(
        'SELECT level FROM tc_notification_defaults WHERE office_id = $1 AND event = $2',
        [office, event.data]
      );
      if (body.level === null) {
        await pool.query('DELETE FROM tc_notification_defaults WHERE office_id = $1 AND event = $2', [
          office,
          event.data,
        ]);
      } else {
        await pool.query(
          `INSERT INTO tc_notification_defaults (office_id, event, level, updated_by)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (office_id, event)
            DO UPDATE SET level = EXCLUDED.level, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [office, event.data, body.level, userKey(req)]
        );
      }
      return before.rows[0] ? before.rows[0].level : 'unset';
    });

    await auditTc(req, 'UPDATE', 'tc_notification_default', `${office}/${event.data}`, { office, priorState: prior });
    res.json(await readState(req));
  })
);

module.exports = router;

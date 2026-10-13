'use strict';

/**
 * /api/tc/nurture — nurture campaigns v1 (queue item 47). Behind the /api/tc
 * mount's requireModule('tc') and tc.full, like every TC route.
 *
 *   POST /enrollments                   start a track on a case
 *   POST /enrollments/:id/pause         a TC pauses it
 *   POST /enrollments/:id/resume        …and resumes it (due date recomputed from today)
 *   POST /enrollments/:id/stop          { reason } — ends it
 *   GET  /enrollments?case_id=          a case's enrollments + which tracks it can start
 *   GET  /outbox                        the office's nurture DRAFTS, grouped by track
 *   POST /outbox/:messageId/skip        a human chose not to send one
 *   GET  /config, PUT /config           the office's per-track intensity dial
 *
 * NOTHING HERE SENDS. Approving a draft is the ordinary
 * POST /api/tc/messages/:id/send (services/messaging sendMessage), which is
 * where consent and quiet hours are enforced. NOTHING HERE READS OPEN DENTAL.
 *
 * OFFICE COMES FROM THE CASE. POST /enrollments takes a case id and NO office;
 * the case row says which practice it belongs to, and the enrollment is that
 * practice's. The `?office=` every TC route carries is then an ASSERTION that
 * can only refuse (409 OFFICE_MISMATCH), never redirect — the same rule as the
 * voice → TC handoff. The enrollment-id routes take the office from the
 * enrollment row (which took it from its case) the same way.
 *
 * SHIPS DARK: starting an enrollment needs platform_setting['tc_nurture_enabled']
 * to switch the case's office on (config/tcNurture.js). Pause and stop always
 * work — that is the safe direction — and resume works too, since nothing is
 * drafted for an office that is off.
 */

const express = require('express');
const { randomUUID } = require('node:crypto');

const { contract, requireOffice, actorEmail, parseBody, h, auditTc, notFound } = require('./helpers');
const { withTenantTx } = require('./tx');
const tenantDb = require('../../platform/tenantDb');
const registry = require('../../platform/registry');
const cfg = require('../../config/tcNurture');
const nurtureStore = require('../../services/tcNurture/store');
const engine = require('../../services/tcNurture/engine');
const messaging = require('../../services/messaging');
const { MessagingError } = require('../../services/messaging/errors');
const adapters = require('../../services/messaging/adapters');
const { addressFromCase } = require('../../services/messaging/address');

const { z, Uuid, NurtureEnrollBody, NurtureStopBody, LibraryNurtureConfig } = contract;

const router = express.Router();
router.use(requireOffice);

const TERMINAL = new Set(contract.TERMINAL_CASE_STATUSES);
const CHANNELS = Object.freeze(['sms', 'email']);
const SECTION = 'nurture_config';

/** Structured refusal. */
function refuse(res, status, code, error, extra = {}) {
  return res.status(status).json({ success: false, error, code, ...extra });
}

function officeMismatch(res) {
  return refuse(
    res,
    409,
    'OFFICE_MISMATCH',
    'That case belongs to the other office. Switch offices to work on it.'
  );
}

/** The office's stored dial, or the defaults. Throws on a stored row the contract cannot read. */
async function loadConfig(q, office) {
  const res = await q.query(
    `SELECT section, value FROM tc_library_config WHERE office_id = $1 AND section = $2`,
    [office, SECTION]
  );
  if (!res.rows.length) return { config: LibraryNurtureConfig.parse({}), stored: false };
  return { config: LibraryNurtureConfig.parse(res.rows[0].value), stored: true };
}

/** Is nurture switched on for this office? Fail closed. */
async function officeOn(office) {
  try {
    return await cfg.isOfficeOn(registry, office);
  } catch {
    return false;
  }
}

/** Channels a track's preset uses at an intensity, in first-use order. */
function channelsOf(trackKey, intensity) {
  const seen = [];
  for (const s of cfg.schedule(trackKey, intensity)) {
    const ch = cfg.touch(trackKey, s.touch).channel;
    if (!seen.includes(ch)) seen.push(ch);
  }
  return seen;
}

/** Can at least one of the preset's channels reach this case? */
function reachable(tcCase, channels) {
  return channels.some((ch) => Boolean(addressFromCase(ch, tcCase)));
}

/** Enrollment rows → contract entities with their touch counts. */
async function withCounts(q, office, rows) {
  const counts = await nurtureStore.touchCounts(
    q,
    office,
    rows.map((r) => r.enrollment_id)
  );
  return rows.map((r) => nurtureStore.toEnrollment(r, counts.get(r.enrollment_id) || 0));
}

async function loadCaseById(q, caseId) {
  const res = await q.query(
    `SELECT case_id, office_id, patient_name, phone, email, status, nurture_enrolled_at
       FROM tc_cases WHERE case_id = $1`,
    [caseId]
  );
  return res.rows.length ? res.rows[0] : null;
}

/** Postgres unique violation (the one-active-per-case index). */
function isUniqueViolation(err) {
  return Boolean(err && err.code === '23505');
}

/** h() plus the MessagingError mapping (for Skip). */
function m(fn) {
  return h(async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof MessagingError) {
        return res.status(err.httpStatus).json({ success: false, error: err.message, code: err.code, ...err.extra });
      }
      throw err;
    }
  });
}

// ── POST /enrollments ───────────────────────────────────────────────────────

router.post(
  '/enrollments',
  h(async (req, res) => {
    const body = parseBody(res, NurtureEnrollBody, req.body);
    if (!body) return;
    const actor = actorEmail(req);
    const now = new Date();
    const tz = cfg.timezone();

    const result = await withTenantTx(req, async (client) => {
      const tcCase = await loadCaseById(client, body.case_id);
      if (!tcCase) return { missing: true };
      const office = tcCase.office_id;
      if (office !== req.tcOffice) return { mismatch: true };
      if (!(await officeOn(office))) return { off: true };
      if (TERMINAL.has(tcCase.status)) return { terminal: tcCase.status };
      const open = await nurtureStore.openForCase(client, office, tcCase.case_id);
      if (open.length) return { already: open[0].enrollment_id };

      const { config } = await loadConfig(client, office);
      const intensity = cfg.intensityFor(config, body.track_key);
      const steps = cfg.schedule(body.track_key, intensity);
      if (!reachable(tcCase, channelsOf(body.track_key, intensity))) return { noAddress: true };

      const enrollmentId = randomUUID();
      const firstDue = engine.firstDueAt(tz, now, steps);
      await nurtureStore.insertEnrollment(client, {
        enrollment_id: enrollmentId,
        case_id: tcCase.case_id,
        office_id: office,
        track_key: body.track_key,
        intensity_at_enroll: intensity,
        status: 'active',
        next_touch_index: 0,
        next_touch_due_at: firstDue ? firstDue.toISOString() : null,
        created_by: actor,
        created_at: now.toISOString(),
      });

      const label = nurtureStore.trackLabel(body.track_key);
      const statusChanged = tcCase.status !== 'nurture';
      if (statusChanged) {
        // The same write the status route makes for → nurture, so the
        // funnel's transition history reads the same either way.
        await client.query(
          `UPDATE tc_cases
              SET status = $3,
                  status_changed_at = $4,
                  nurture_enrolled_at = CASE WHEN $5 THEN $4::timestamptz ELSE nurture_enrolled_at END,
                  updated_at = now()
            WHERE office_id = $1 AND case_id = $2`,
          [office, tcCase.case_id, 'nurture', now.toISOString(), !tcCase.nurture_enrolled_at]
        );
        await nurtureStore.insertEvent(client, {
          office,
          caseId: tcCase.case_id,
          type: 'status_change',
          description: `${tcCase.status} → nurture: ${label} campaign`,
          actor,
          ts: now,
        });
      }
      await nurtureStore.insertEvent(client, {
        office,
        caseId: tcCase.case_id,
        type: 'nurture_enrolled',
        description: `Enrolled in ${label} (${intensity}): ${steps.length} touches, the first due ${
          firstDue ? firstDue.toISOString().slice(0, 10) : 'now'
        }. Every touch is a draft for review — nothing sends on its own.`,
        actor,
        ts: now,
      });
      const row = await nurtureStore.loadEnrollment(client, office, enrollmentId);
      return { office, enrollment: nurtureStore.toEnrollment(row, 0), statusChanged };
    }).catch((err) => {
      if (isUniqueViolation(err)) return { already: null };
      throw err;
    });

    if (result.missing) return notFound(res, 'case');
    if (result.mismatch) return officeMismatch(res);
    if (result.off) {
      return refuse(res, 501, 'FEATURE_DISABLED', 'Nurture campaigns are switched off for this office.', {
        feature: 'tc_nurture',
      });
    }
    if (result.terminal) {
      return refuse(
        res,
        409,
        'CASE_TERMINAL',
        `This case is ${result.terminal}, so it is no longer TC work. Move it back to an open status first.`
      );
    }
    if ('already' in result) {
      return refuse(res, 409, 'ALREADY_ENROLLED', 'This case already has a nurture campaign running or paused.', {
        enrollmentId: result.already,
      });
    }
    if (result.noAddress) {
      return refuse(
        res,
        409,
        'NO_ADDRESS',
        'This case has no usable phone number or email for that campaign. Add one to the case first.'
      );
    }
    await auditTc(req, 'CREATE', 'tc_nurture_enrollment', result.enrollment.enrollmentId, { office: result.office });
    if (result.statusChanged) await auditTc(req, 'UPDATE', 'tc_case', result.enrollment.caseId, { office: result.office });
    res.status(201).json({ success: true, enrollment: result.enrollment });
  })
);

// ── POST /enrollments/:id/{pause,resume,stop} ───────────────────────────────

/** Load an enrollment by id; its office (from its case) must be the asserted one. */
async function loadOwned(client, req, res) {
  const id = Uuid.safeParse(req.params.id);
  if (!id.success) {
    notFound(res, 'enrollment');
    return null;
  }
  const r = await client.query(
    `SELECT ${nurtureStore.ENROLLMENT_COLS.join(', ')} FROM tc_nurture_enrollments WHERE enrollment_id = $1`,
    [id.data]
  );
  if (!r.rows.length) {
    notFound(res, 'enrollment');
    return null;
  }
  if (r.rows[0].office_id !== req.tcOffice) {
    officeMismatch(res);
    return null;
  }
  return r.rows[0];
}

const EmptyBody = z.object({}).strict();

/**
 * One lifecycle route. `plan` decides, from the loaded row, the transition (or
 * a refusal) inside the transaction.
 */
function lifecycle(action, plan) {
  return h(async (req, res) => {
    const schema = action === 'stop' ? NurtureStopBody : EmptyBody;
    const body = parseBody(res, schema, req.body ?? {});
    if (!body) return;
    const actor = actorEmail(req);
    const now = new Date();
    const out = await withTenantTx(req, async (client) => {
      const e = await loadOwned(client, req, res);
      if (!e) return { responded: true };
      const decision = await plan({ client, e, body, now });
      if (decision.refuse) return decision;
      const row = await nurtureStore.transition(client, e.office_id, e.enrollment_id, decision.transition);
      if (!row) {
        return {
          refuse: [409, 'ENROLLMENT_NOT_IN_STATE', `This campaign is ${e.status}, so it cannot be ${decision.verb}.`],
        };
      }
      await nurtureStore.insertEvent(client, {
        office: e.office_id,
        caseId: e.case_id,
        type: decision.eventType,
        description: decision.describe(row),
        actor,
        ts: now,
      });
      const counts = await nurtureStore.touchCounts(client, e.office_id, [e.enrollment_id]);
      return { enrollment: nurtureStore.toEnrollment(row, counts.get(e.enrollment_id) || 0), office: e.office_id };
    });
    if (out.responded) return;
    if (out.refuse) return refuse(res, out.refuse[0], out.refuse[1], out.refuse[2]);
    await auditTc(req, 'UPDATE', `tc_nurture_enrollment.${action}`, out.enrollment.enrollmentId, {
      office: out.office,
    });
    res.json({ success: true, enrollment: out.enrollment });
  });
}

router.post(
  '/enrollments/:id/pause',
  lifecycle('pause', async ({ e }) => ({
    verb: 'paused',
    transition: { from: ['active'], to: 'paused', stopReason: null, nextTouchDueAt: e.next_touch_due_at ?? null },
    eventType: 'nurture_paused',
    describe: (row) => `${nurtureStore.trackLabel(row.track_key)} paused by the TC`,
  }))
);

router.post(
  '/enrollments/:id/resume',
  lifecycle('resume', async ({ client, e, now }) => {
    const tcCase = await loadCaseById(client, e.case_id);
    if (!tcCase || TERMINAL.has(tcCase.status)) {
      return {
        refuse: [
          409,
          'CASE_TERMINAL',
          `This case is ${tcCase ? tcCase.status : 'gone'}, so its campaign cannot resume.`,
        ],
      };
    }
    const steps = cfg.schedule(e.track_key, e.intensity_at_enroll);
    const index = Number(e.next_touch_index);
    // NEVER BACK-FILL: the next touch is due the preset's gap from TODAY, so a
    // long pause never releases a burst of missed touches. Past the end of
    // the schedule, it is due now and the next pass completes it.
    const due = index < steps.length ? engine.dueAfter(cfg.timezone(), now, steps, index) : now;
    return {
      verb: 'resumed',
      transition: { from: ['paused'], to: 'active', stopReason: null, nextTouchDueAt: due.toISOString() },
      eventType: 'nurture_resumed',
      describe: (row) =>
        `${nurtureStore.trackLabel(row.track_key)} resumed: next touch due ${due.toISOString().slice(0, 10)} (no missed touches are back-filled)`,
    };
  })
);

router.post(
  '/enrollments/:id/stop',
  lifecycle('stop', async ({ body }) => ({
    verb: 'stopped',
    transition: { from: ['active', 'paused'], to: 'stopped', stopReason: body.reason, nextTouchDueAt: null },
    eventType: 'nurture_stopped',
    describe: (row) => `${nurtureStore.trackLabel(row.track_key)} stopped by the TC: ${body.reason}`,
  }))
);

// ── GET /enrollments?case_id= ───────────────────────────────────────────────

const CaseQuery = z.object({ office: z.string(), case_id: Uuid }).strict();

router.get(
  '/enrollments',
  h(async (req, res) => {
    const query = parseBody(res, CaseQuery, req.query);
    if (!query) return;
    const office = req.tcOffice;
    const enabled = await officeOn(office);
    const out = await tenantDb.withTenantDb(req, async (q) => {
      const r = await q.query(
        `SELECT case_id, office_id, patient_name, phone, email, status FROM tc_cases
          WHERE office_id = $1 AND case_id = $2`,
        [office, query.case_id]
      );
      if (!r.rows.length) return null;
      const tcCase = r.rows[0];
      const rows = await nurtureStore.listForCase(q, office, tcCase.case_id);
      const enrollments = await withCounts(q, office, rows);
      const { config } = await loadConfig(q, office);
      const hasOpen = enrollments.some((x) => x.status === 'active' || x.status === 'paused');
      const tracks = cfg.TRACK_KEYS.map((trackKey) => {
        const intensity = cfg.intensityFor(config, trackKey);
        const channels = channelsOf(trackKey, intensity);
        const def = cfg.TRACKS[trackKey];
        let reason = null;
        if (!enabled) reason = 'switched_off';
        else if (TERMINAL.has(tcCase.status)) reason = 'case_terminal';
        else if (hasOpen) reason = 'already_enrolled';
        else if (!reachable(tcCase, channels)) reason = 'no_address';
        return {
          trackKey,
          label: def.label,
          goal: def.goal,
          intensity,
          touchCount: cfg.schedule(trackKey, intensity).length,
          channels,
          available: reason === null,
          reason,
        };
      });
      return { enrollments, tracks };
    });
    if (!out) return notFound(res, 'case');
    res.json({ success: true, ...contract.NurtureCaseResponse.parse({ enabled, ...out }) });
  })
);

// ── GET /outbox ─────────────────────────────────────────────────────────────

const OfficeOnly = z.object({ office: z.string() }).strict();

router.get(
  '/outbox',
  h(async (req, res) => {
    if (!parseBody(res, OfficeOnly, req.query)) return;
    const office = req.tcOffice;
    const enabled = await officeOn(office);
    const groups = await tenantDb.withTenantDb(req, async (q) => {
      const drafts = await q.query(
        `SELECT ${messaging.MESSAGE_COLS.join(', ')}, enrollment_id, touch_key, consent_blocked_hint
           FROM tc_messages
          WHERE office_id = $1 AND status = 'draft' AND enrollment_id IS NOT NULL
          ORDER BY created_at`,
        [office]
      );
      if (!drafts.rows.length) return [];
      const enrollmentIds = [...new Set(drafts.rows.map((d) => d.enrollment_id))];
      const caseIds = [...new Set(drafts.rows.map((d) => d.case_id).filter(Boolean))];
      const enr = await q.query(
        `SELECT enrollment_id, track_key FROM tc_nurture_enrollments WHERE office_id = $1 AND enrollment_id = ANY($2)`,
        [office, enrollmentIds]
      );
      const trackOf = new Map(enr.rows.map((r) => [r.enrollment_id, r.track_key]));
      const cases = caseIds.length
        ? await q.query(`SELECT case_id, patient_name FROM tc_cases WHERE office_id = $1 AND case_id = ANY($2)`, [
            office,
            caseIds,
          ])
        : { rows: [] };
      const nameOf = new Map(cases.rows.map((r) => [r.case_id, r.patient_name ?? null]));
      const byTrack = new Map();
      for (const d of drafts.rows) {
        const trackKey = trackOf.get(d.enrollment_id);
        if (!trackKey || !d.case_id) continue;
        if (!byTrack.has(trackKey)) byTrack.set(trackKey, []);
        byTrack.get(trackKey).push({
          message: messaging.toMessage(d),
          enrollmentId: d.enrollment_id,
          caseId: d.case_id,
          patientName: nameOf.get(d.case_id) ?? null,
          touchKey: d.touch_key,
          consentBlockedHint: d.consent_blocked_hint ?? null,
        });
      }
      return cfg.TRACK_KEYS.filter((k) => byTrack.has(k)).map((trackKey) => ({
        trackKey,
        label: cfg.TRACKS[trackKey].label,
        drafts: byTrack.get(trackKey),
      }));
    });
    // Message bodies and patient names left the database: on the trail.
    await auditTc(req, 'READ', 'tc_nurture_outbox', null, { office });
    const channels = CHANNELS.map((channel) => ({
      channel,
      enabled: adapters.isChannelEnabled(channel, office),
      reason: adapters.channelUnavailableReason(channel, office),
    }));
    res.json({ success: true, ...contract.NurtureOutboxResponse.parse({ enabled, channels, groups }) });
  })
);

// ── POST /outbox/:messageId/skip ────────────────────────────────────────────

router.post(
  '/outbox/:messageId/skip',
  m(async (req, res) => {
    const id = Uuid.safeParse(req.params.messageId);
    if (!id.success) return notFound(res, 'message');
    if (!parseBody(res, EmptyBody, req.body ?? {})) return;
    const message = await messaging.skipNurtureDraft(req, req.tcOffice, id.data);
    res.json({ success: true, message });
  })
);

// ── GET / PUT /config ───────────────────────────────────────────────────────

async function configResponse(q, office) {
  const { config } = await loadConfig(q, office);
  const enabled = await officeOn(office);
  return contract.NurtureConfigResponse.parse({
    enabled,
    tracks: cfg.TRACK_KEYS.map((trackKey) => ({
      trackKey,
      label: cfg.TRACKS[trackKey].label,
      intensity: cfg.intensityFor(config, trackKey),
      stored: Boolean(config.tracks && config.tracks[trackKey]),
    })),
  });
}

router.get(
  '/config',
  h(async (req, res) => {
    if (!parseBody(res, OfficeOnly, req.query)) return;
    const body = await tenantDb.withTenantDb(req, (q) => configResponse(q, req.tcOffice));
    res.json({ success: true, ...body });
  })
);

router.put(
  '/config',
  h(async (req, res) => {
    // Hand-validated so each refusal has its own code (INVALID_TRACK /
    // INVALID_INTENSITY) rather than a generic VALIDATION_FAILED.
    const raw = req.body;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some((k) => k !== 'tracks')) {
      return refuse(res, 400, 'VALIDATION_FAILED', 'Body must be { tracks: { <track>: { intensity } } }.');
    }
    const tracks = raw.tracks;
    if (!tracks || typeof tracks !== 'object' || Array.isArray(tracks)) {
      return refuse(res, 400, 'VALIDATION_FAILED', 'tracks must be an object keyed by track.');
    }
    for (const [key, value] of Object.entries(tracks)) {
      if (!cfg.TRACK_KEYS.includes(key)) {
        return refuse(res, 400, 'INVALID_TRACK', `Unknown track '${key}'. Valid: ${cfg.TRACK_KEYS.join(', ')}`, {
          track: key,
        });
      }
      const ok =
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value).length === 1 &&
        cfg.INTENSITIES.includes(/** @type {any} */ (value).intensity);
      if (!ok) {
        return refuse(
          res,
          400,
          'INVALID_INTENSITY',
          `Track '${key}' needs { intensity: ${cfg.INTENSITIES.join(' | ')} } and nothing else.`,
          { track: key }
        );
      }
    }
    const value = LibraryNurtureConfig.parse({ tracks });
    const office = req.tcOffice;
    const body = await withTenantTx(req, async (client) => {
      await client.query(
        `INSERT INTO tc_library_config (office_id, section, value)
          VALUES ($1, $2, $3)
          ON CONFLICT (office_id, section)
          DO UPDATE SET value = EXCLUDED.value, updated_at = now()
          RETURNING section, value, updated_at`,
        [office, SECTION, JSON.stringify(value)]
      );
      return configResponse(client, office);
    });
    await auditTc(req, 'UPDATE', 'tc_library_config', `${office}/${SECTION}`, { office });
    res.json({ success: true, ...body });
  })
);

module.exports = router;

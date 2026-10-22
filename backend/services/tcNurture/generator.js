'use strict';

/**
 * The nightly nurture GENERATOR for one office (queue item 47).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * IT WRITES DRAFTS. IT NEVER SENDS.
 * ═════════════════════════════════════════════════════════════════════════════
 * For each ACTIVE enrollment whose next touch is due, it renders that touch
 * and INSERTs a tc_messages row with status 'draft' — exactly the state a
 * TC-written draft is born in (1790300000000_tc_messaging.js) — then advances
 * the enrollment. A human approves each draft in the Nurture Outbox, which
 * calls the ordinary Send route; services/messaging sendMessage stays the ONLY
 * send path, and consent + quiet hours stay enforced there and only there.
 * This file does not require the messaging service or any channel adapter
 * (tcNurtureGenerator.test.js pins both, and that no send is ever invoked).
 *
 * ZERO OPEN DENTAL. Merge values are the case row's own snapshot (the
 * patient's first name) and config (office display name, office phone). The
 * draft-time consent hint reads tc_contact_consent and the case's
 * nurture_unsubscribed flag only — it cannot see OD's TxtMsgOk, which is why
 * it is an ADVISORY and the Send click is the authority.
 *
 * NO SILENT SKIPS. A touch whose channel is blocked at draft time is still
 * drafted, with `consent_blocked_hint` set, so the outbox shows it and a human
 * decides. A cap deferral moves the due date and is counted in the pass line.
 *
 * ONE TRANSACTION PER ENROLLMENT: the claim (advance), the draft and the
 * events commit together or not at all. The claim runs FIRST and is
 * conditional on (status = 'active', next_touch_index = i), so a stop that
 * lands mid-pass, or a second pass over the same row, writes no draft.
 *
 * NO AUDIT ROWS, like the opportunities sync: nobody is looking at anything at
 * 05:00, and writing a draft into our own database discloses nothing. The
 * disclosure is a person opening the outbox (audited) or clicking Send
 * (audited, fail-closed, by sendMessage). The case timeline gets a
 * `nurture_touch_queued` event per draft.
 */

const { randomUUID } = require('node:crypto');

const contract = require('../../tc/contract.gen.cjs');
const cfg = require('../../config/tcNurture');
const store = require('./store');
const engine = require('./engine');
const { addressFromCase } = require('../messaging/address');
const { getConsentRow } = require('../messaging/consent');

/** Statuses that mean an SMS from this enrollment actually left (or is leaving). */
const SMS_LEFT = new Set(['sending', 'queued', 'sent', 'delivered']);

const TERMINAL = new Set(contract.TERMINAL_CASE_STATUSES);

function isoOrNull(d) {
  return d ? d.toISOString() : null;
}

/** Run `fn(client)` in a transaction on `pool`. */
async function withTx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // the original error is the one worth surfacing
    }
    throw err;
  } finally {
    client.release();
  }
}

async function loadCase(q, office, caseId) {
  const res = await q.query(
    `SELECT case_id, office_id, patient_name, phone, email, status, nurture_unsubscribed
       FROM tc_cases WHERE office_id = $1 AND case_id = $2`,
    [office, caseId]
  );
  return res.rows.length ? res.rows[0] : null;
}

/**
 * The draft-time advisory for one channel + address. Postgres only.
 * @returns {Promise<'opted_out'|'email_unsubscribed'|'no_address'|null>}
 */
async function consentHint(q, office, channel, address, tcCase) {
  if (!address) return 'no_address';
  const row = await getConsentRow(q, office, channel, address);
  if (row && row.state === 'opted_out') return 'opted_out';
  if (channel === 'email' && tcCase.nurture_unsubscribed === true) return 'email_unsubscribed';
  return null;
}

/**
 * Process ONE due enrollment. Returns what happened, for the pass counts.
 * @returns {Promise<'queued'|'completed'|'deferred'|'stopped'|'lost_claim'>}
 */
async function processEnrollment(pool, office, e, { tz, now, merge }) {
  return withTx(pool, async (q) => {
    const tcCase = await loadCase(q, office, e.case_id);
    // Defence in depth: the status route's exit hook stops an enrollment the
    // moment its case goes terminal. A case that is gone or terminal anyway
    // is stopped here rather than drafted for.
    if (!tcCase || TERMINAL.has(tcCase.status)) {
      const row = await store.transition(q, office, e.enrollment_id, {
        from: ['active'],
        to: 'stopped',
        stopReason: cfg.STOP_CASE_TERMINAL,
        nextTouchDueAt: null,
      });
      if (row && tcCase) {
        await store.insertEvent(q, {
          office,
          caseId: e.case_id,
          type: 'nurture_stopped',
          description: `${store.trackLabel(e.track_key)} stopped: case is ${tcCase.status}`,
          actor: store.SYSTEM_ACTOR,
          ts: now,
        });
      }
      return 'stopped';
    }

    const steps = cfg.schedule(e.track_key, e.intensity_at_enroll);
    const index = Number(e.next_touch_index);
    const prior = await store.touchesOf(q, office, e.enrollment_id);

    // Exhausted, or at the per-enrollment ceiling: complete, draft nothing.
    const cap = engine.capCheck({ tz, now, priorTouches: prior.map((m) => new Date(m.created_at)) });
    if (index >= steps.length || (!cap.ok && cap.code === 'MAX_PER_ENROLLMENT')) {
      const row = await store.transition(q, office, e.enrollment_id, {
        from: ['active'],
        to: 'completed',
        stopReason: null,
        nextTouchDueAt: null,
      });
      if (row) {
        await store.insertEvent(q, {
          office,
          caseId: e.case_id,
          type: 'nurture_completed',
          description: `${store.trackLabel(e.track_key)} completed: every touch was queued`,
          actor: store.SYSTEM_ACTOR,
          ts: now,
        });
      }
      return 'completed';
    }
    if (!cap.ok) {
      await store.defer(q, office, e.enrollment_id, cap.deferUntil.toISOString());
      return 'deferred';
    }

    const step = steps[index];
    const touch = cfg.touch(e.track_key, step.touch);
    const address = addressFromCase(touch.channel, tcCase);
    const hint = await consentHint(q, office, touch.channel, address, tcCase);
    const smsAlreadyLeft = prior.some((m) => m.channel === 'sms' && SMS_LEFT.has(m.status));
    const rendered = engine.renderTouch({
      trackKey: e.track_key,
      touchKey: step.touch,
      patientName: tcCase.patient_name,
      merge,
      withStopSuffix: touch.channel === 'sms' && !smsAlreadyLeft,
    });

    const nextIndex = index + 1;
    const exhausted = nextIndex >= steps.length;
    const claimed = await store.advance(q, office, e.enrollment_id, {
      expectIndex: index,
      nextIndex,
      lastTouchAt: now.toISOString(),
      nextTouchDueAt: exhausted ? null : isoOrNull(engine.dueAfter(tz, now, steps, nextIndex)),
      status: exhausted ? 'completed' : 'active',
    });
    if (!claimed) return 'lost_claim';

    const messageId = randomUUID();
    await q.query(
      `INSERT INTO tc_messages (message_id, office_id, case_id, direction, channel, to_address, body, subject,
         template_id, status, created_by, email_blocks, email_preheader, enrollment_id, touch_key, consent_blocked_hint,
         created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [
        messageId,
        office,
        e.case_id,
        'outbound',
        rendered.channel,
        address,
        rendered.body,
        rendered.subject,
        cfg.templateId(e.track_key, step.touch),
        'draft',
        store.SYSTEM_ACTOR,
        rendered.emailBlocks ? JSON.stringify(rendered.emailBlocks) : null,
        rendered.emailBlocks ? '' : null,
        e.enrollment_id,
        step.touch,
        hint,
        // The pass's own instant, not the database clock: the caps are counted
        // from these timestamps, by the same clock that is checking them.
        now.toISOString(),
      ]
    );
    const what = touch.channel === 'sms' ? 'text' : 'email';
    await store.insertEvent(q, {
      office,
      caseId: e.case_id,
      type: 'nurture_touch_queued',
      description:
        `${store.trackLabel(e.track_key)}: ${what} draft queued for review (${step.touch}, ${nextIndex} of ${steps.length})` +
        (hint ? ` — flagged: ${hint.replace(/_/g, ' ')}` : ''),
      actor: store.SYSTEM_ACTOR,
      ts: now,
    });
    if (exhausted) {
      await store.insertEvent(q, {
        office,
        caseId: e.case_id,
        type: 'nurture_completed',
        description: `${store.trackLabel(e.track_key)} completed: every touch was queued`,
        actor: store.SYSTEM_ACTOR,
        ts: now,
      });
    }
    return 'queued';
  });
}

/**
 * One office's pass. Never throws per enrollment: one bad row is counted as
 * an error and the rest of the office still runs.
 * @param {{ pool: { query: Function, connect: Function }, office: string, now?: Date, tz?: string }} input
 */
async function runForOffice({ pool, office, now = new Date(), tz = cfg.timezone() }) {
  const started = Date.now();
  const counts = { due: 0, queued: 0, completed: 0, deferred: 0, stopped: 0, lost_claim: 0, errors: 0 };
  const merge = cfg.officeMergeValues(office);
  const due = await store.listDue(pool, office, now.toISOString());
  counts.due = due.length;
  for (const e of due) {
    try {
      const outcome = await processEnrollment(pool, office, e, { tz, now, merge });
      counts[outcome] += 1;
    } catch (err) {
      counts.errors += 1;
      // The enrollment id only — never a name, a phone or a body.
      console.error(
        `[tcNurture] office=${office} enrollment=${e.enrollment_id} failed: ${(err && err.message) || err}`
      );
    }
  }
  return { office, ...counts, phoneConfigured: merge.phoneConfigured, durationMs: Date.now() - started };
}

module.exports = { runForOffice, processEnrollment, consentHint, SMS_LEFT };

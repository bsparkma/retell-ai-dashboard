'use strict';

/**
 * Nurture EXIT HOOKS (queue item 47) — the places a running enrollment must
 * stop or pause because something happened outside the engine.
 *
 *   stopForTerminalCase   the case moved to a TERMINAL status (accepted,
 *                         partially_accepted, scheduled, started, completed,
 *                         lost — contract.TERMINAL_CASE_STATUSES). Called from
 *                         the status-transition route, inside its transaction.
 *   onInboundMessage      a patient texted in. Any running enrollment on a case
 *                         in THAT office whose phone is the sender's is PAUSED
 *                         for a human (stop_reason stays null). A STOP-family
 *                         text STOPS it instead (stop_reason 'opted_out').
 *                         Called from messaging.recordInbound, inside its
 *                         database callback. Nothing is ever sent from here.
 *   onOptOut              an opt-out was recorded some other way (a TC's
 *                         manual opt-out, an email unsubscribe link). The
 *                         consent layer is already authoritative — a blocked
 *                         address cannot be sent to — and the enrollment is
 *                         additionally marked stopped so it reads honestly.
 *
 * Every hook takes the caller's query handle, so its writes commit or roll
 * back with the caller's, and returns the enrollment ids it changed so the
 * caller can audit them (audit rows carry ids only, never PHI).
 *
 * The office is ALWAYS the caller's server-derived office: a phone or an email
 * means nothing across practices, and a sender is matched only to cases in the
 * office whose number received the text.
 */

const contract = require('../../tc/contract.gen.cjs');
const cfg = require('../../config/tcNurture');
const store = require('./store');
const { normalizeAddress } = require('../messaging/address');

const TERMINAL = new Set(contract.TERMINAL_CASE_STATUSES);

/** Is this case status one that ends a nurture enrollment? */
function isTerminalStatus(status) {
  return TERMINAL.has(status);
}

/**
 * Stop every running enrollment on a case that just went terminal.
 * @param {{ query: Function }} q
 * @param {{ office: string, caseId: string, newStatus: string, actor: string, now?: Date }} input
 * @returns {Promise<string[]>} enrollment ids stopped
 */
async function stopForTerminalCase(q, { office, caseId, newStatus, actor, now = new Date() }) {
  if (!isTerminalStatus(newStatus)) return [];
  const open = await store.openForCase(q, office, caseId);
  const stopped = [];
  for (const e of open) {
    const row = await store.transition(q, office, e.enrollment_id, {
      from: ['active', 'paused'],
      to: 'stopped',
      stopReason: cfg.STOP_CASE_TERMINAL,
      nextTouchDueAt: null,
    });
    if (!row) continue;
    stopped.push(row.enrollment_id);
    await store.insertEvent(q, {
      office,
      caseId,
      type: 'nurture_stopped',
      description: `${store.trackLabel(row.track_key)} stopped: case moved to ${newStatus}`,
      actor,
      ts: now,
    });
  }
  return stopped;
}

/**
 * Running enrollments in `office` on cases whose `channel` address normalizes
 * to `address`. Matching is in this process (the same normalizeAddress the
 * consent gate keys on), so "(918) 555-0100" on a case and "+19185550100"
 * from Twilio are the same person.
 * @returns {Promise<Array<{ enrollment: Record<string, any>, caseId: string }>>}
 */
async function runningByAddress(q, office, channel, address) {
  const res = await q.query(
    `SELECT enrollment_id, case_id, office_id, track_key, status FROM tc_nurture_enrollments
      WHERE office_id = $1 AND status = ANY($2)`,
    [office, ['active', 'paused']]
  );
  if (!res.rows.length) return [];
  const caseIds = [...new Set(res.rows.map((r) => r.case_id))];
  const cases = await q.query(
    `SELECT case_id, phone, email FROM tc_cases WHERE office_id = $1 AND case_id = ANY($2)`,
    [office, caseIds]
  );
  const field = channel === 'sms' ? 'phone' : 'email';
  const matching = new Set(
    cases.rows.filter((c) => normalizeAddress(channel, c[field]) === address).map((c) => c.case_id)
  );
  return res.rows.filter((r) => matching.has(r.case_id)).map((r) => ({ enrollment: r, caseId: r.case_id }));
}

/**
 * A patient texted in (or replied STOP).
 * @param {{ query: Function }} q
 * @param {{ office: string, channel: 'sms'|'email', fromAddress: string, stop: boolean, now?: Date }} input
 *   `fromAddress` is already normalized by recordInbound.
 * @returns {Promise<{ paused: string[], stopped: string[] }>}
 */
async function onInboundMessage(q, { office, channel, fromAddress, stop, now = new Date() }) {
  const out = { paused: [], stopped: [] };
  if (!fromAddress) return out;
  const hits = await runningByAddress(q, office, channel, fromAddress);
  for (const { enrollment, caseId } of hits) {
    if (stop) {
      const row = await store.transition(q, office, enrollment.enrollment_id, {
        from: ['active', 'paused'],
        to: 'stopped',
        stopReason: cfg.STOP_OPTED_OUT,
        nextTouchDueAt: null,
      });
      if (!row) continue;
      out.stopped.push(row.enrollment_id);
      await store.insertEvent(q, {
        office,
        caseId,
        type: 'nurture_stopped',
        description: `${store.trackLabel(row.track_key)} stopped: the patient replied STOP`,
        actor: 'system:inbound',
        ts: now,
      });
      continue;
    }
    if (enrollment.status !== 'active') continue; // already paused: nothing more to say
    const row = await store.transition(q, office, enrollment.enrollment_id, {
      from: ['active'],
      to: 'paused',
      stopReason: null,
      // Kept, not cleared: Resume recomputes it from the day it is resumed.
      nextTouchDueAt: enrollment.next_touch_due_at ?? null,
    });
    if (!row) continue;
    out.paused.push(row.enrollment_id);
    await store.insertEvent(q, {
      office,
      caseId,
      type: 'nurture_paused',
      description: `${store.trackLabel(row.track_key)} paused: the patient replied — a person should read it before more go out`,
      actor: 'system:inbound',
      ts: now,
    });
  }
  return out;
}

/**
 * An opt-out was recorded for (office, channel, address).
 * @param {{ query: Function }} q
 * @param {{ office: string, channel: 'sms'|'email', address: string, actor: string, now?: Date }} input
 * @returns {Promise<string[]>} enrollment ids stopped
 */
async function onOptOut(q, { office, channel, address, actor, now = new Date() }) {
  const stopped = [];
  if (!address) return stopped;
  const hits = await runningByAddress(q, office, channel, address);
  for (const { enrollment, caseId } of hits) {
    const row = await store.transition(q, office, enrollment.enrollment_id, {
      from: ['active', 'paused'],
      to: 'stopped',
      stopReason: cfg.STOP_OPTED_OUT,
      nextTouchDueAt: null,
    });
    if (!row) continue;
    stopped.push(row.enrollment_id);
    await store.insertEvent(q, {
      office,
      caseId,
      type: 'nurture_stopped',
      description: `${store.trackLabel(row.track_key)} stopped: the patient opted out of ${channel === 'sms' ? 'texts' : 'email'}`,
      actor,
      ts: now,
    });
  }
  return stopped;
}

module.exports = { isTerminalStatus, stopForTerminalCase, onInboundMessage, onOptOut };

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
 * LIBRARY ENROLLMENTS (EL-2). An enrollment that carries library_procedure_id
 * follows the patient email library's sequence for its track (store.stepsOf)
 * instead of the hand-written touches: each step is ONE email composed by
 * services/tcEmailLibrary renderLibraryEmail from the office's SAVED wording
 * answers, merged with the patient's first name, the office's name and phone
 * (config, as above) and the sender line. Same claim, same caps, same consent
 * hint, same events, same counts — the only differences are where the copy
 * comes from and that it is always email. A merge field with no honest value
 * (the office phone was unset after enrolling) THROWS inside the transaction:
 * no draft, no advance, counted in `errors`, and the next pass tries again.
 *
 * EL-2c — WRITTEN IN FULL, APPROVED UP FRONT. A library campaign is now
 * written ENTIRELY when it starts (routes/tc/nurture.js POST /enrollments,
 * using prepareLibraryDrafts + insertLibraryDrafts below), every email a
 * draft with a planned send time (engine.planCampaign). So the nightly pass
 * does nothing for a library enrollment, except:
 *   - one started under #359 that still has unwritten steps gets ALL of them
 *     at once, planned from today (processLibraryEnrollment), exactly once;
 *   - an active one whose emails are all sent or skipped is completed (the
 *     sweep at the end of runForOffice). It is never completed merely for
 *     being fully written: the campaign is running until its last email is
 *     settled.
 * A planned time is a date on a DRAFT. Nothing here — and nothing anywhere in
 * EL-2c — sends a draft or an approved ('scheduled') email.
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
const library = require('../tcEmailLibrary');
const { firstNameOf } = require('../messaging/templates');
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
    `SELECT case_id, office_id, patient_name, phone, email, status, nurture_unsubscribed, assigned_tc
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
 * The sender line of a library email (EL-2): the case's assigned TC, shown the
 * way the TC app shows assigned_tc (the stored string, as the case card prints
 * it) — but only when that string reads as a person's name. assigned_tc is an
 * SSO email when a route stamped it, and a patient must not see a staff email
 * address as a signature; nor a value carrying token or markup characters.
 * Anything else signs as "The team at <office name>".
 * @param {unknown} assignedTc
 * @param {string|null} officeName
 * @returns {string|null}
 */
function senderNameFor(assignedTc, officeName) {
  const name = typeof assignedTc === 'string' ? assignedTc.trim() : '';
  if (name && name.length <= 80 && /^[\p{L}\p{M}][\p{L}\p{M} .'\-]*$/u.test(name)) return name;
  return officeName ? `The team at ${officeName}` : null;
}

/**
 * The library merge values for one draft. A value this pass cannot honestly
 * fill is null, and renderLibraryEmail refuses a null (UNRESOLVED_MERGE):
 *   office_name   config's display name; the 'Unmapped' placeholder is no name
 *   office_phone  only a CONFIGURED phone (not officeMergeValues' "the office")
 */
function libraryMerge(merge, tcCase) {
  const officeName = merge.officeName && merge.officeName !== 'Unmapped' ? merge.officeName : null;
  return {
    first_name: firstNameOf(tcCase.patient_name) || 'there',
    office_name: officeName,
    office_phone: merge.phoneConfigured ? merge.officePhone : null,
    sender_name: senderNameFor(tcCase.assigned_tc, officeName),
  };
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
      // EL-2c: a stopped campaign leaves nothing that could still be sent.
      const cancelled = row
        ? await store.cancelWaiting(q, office, e.enrollment_id, { reason: 'case_terminal', actor: store.SYSTEM_ACTOR })
        : [];
      if (row && tcCase) {
        await store.insertEvent(q, {
          office,
          caseId: e.case_id,
          type: 'nurture_stopped',
          description: `${store.trackLabel(e.track_key)} stopped: case is ${tcCase.status}${store.cancelledSuffix(cancelled.length)}`,
          actor: store.SYSTEM_ACTOR,
          ts: now,
        });
      }
      return 'stopped';
    }

    // EL-2c: a library campaign is written IN FULL, never one step a night.
    if (e.library_procedure_id) return processLibraryEnrollment(q, office, e, tcCase, { tz, now, merge });

    // Hand-written preset (item 47), unchanged: one touch per due date.
    const steps = store.stepsOf(e);
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
    /** @type {'sms'|'email'} */
    const channel = touch.channel;
    const smsAlreadyLeft = prior.some((m) => m.channel === 'sms' && SMS_LEFT.has(m.status));
    const r = engine.renderTouch({
      trackKey: e.track_key,
      touchKey: step.touch,
      patientName: tcCase.patient_name,
      merge,
      withStopSuffix: touch.channel === 'sms' && !smsAlreadyLeft,
    });
    /** @type {{ channel: 'sms'|'email', body: string, subject: string|null, emailBlocks: object[]|null, preheader: string }} */
    const rendered = { ...r, preheader: '' };
    const templateId = cfg.templateId(e.track_key, step.touch);
    const address = addressFromCase(channel, tcCase);
    const hint = await consentHint(q, office, channel, address, tcCase);

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
        templateId,
        'draft',
        store.SYSTEM_ACTOR,
        rendered.emailBlocks ? JSON.stringify(rendered.emailBlocks) : null,
        rendered.emailBlocks ? rendered.preheader : null,
        e.enrollment_id,
        step.touch,
        hint,
        // The pass's own instant, not the database clock: the caps are counted
        // from these timestamps, by the same clock that is checking them.
        now.toISOString(),
      ]
    );
    const what = channel === 'sms' ? 'text' : 'email';
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

// ── EL-2c: library campaigns, written in full ──────────────────────────────

/**
 * Render steps [fromIndex, n) of a library enrollment — ALL of them before a
 * single row is written, so one step that cannot render (UNRESOLVED_MERGE,
 * stale saved answers, a procedure the office switched off) throws and
 * nothing at all is written. Content only: nothing here sends.
 * @param {{ query: Function }} q
 * @param {string} office
 * @param {Record<string, any>} e the enrollment (inserted or about to be)
 * @param {Record<string, any>} tcCase its case row (patient_name, email, nurture_unsubscribed, assigned_tc)
 * @param {ReturnType<typeof cfg.officeMergeValues>} merge
 * @param {number} fromIndex
 */
async function prepareLibraryDrafts(q, office, e, tcCase, merge, fromIndex) {
  const steps = store.stepsOf(e);
  const answers = await library.savedAnswersFor(q, office);
  const values = libraryMerge(merge, tcCase);
  const drafts = steps.slice(fromIndex).map((step, k) => {
    const email = library.renderLibraryEmail({
      office,
      answers,
      procedureId: e.library_procedure_id,
      stage: step.touch,
      variant: e.library_variant,
      merge: values,
    });
    return {
      index: fromIndex + k,
      stage: step.touch,
      day: step.day,
      body: email.bodyText.slice(0, 8000),
      subject: email.subject.slice(0, 300),
      emailBlocks: email.emailBlocks,
      preheader: email.preheader,
      templateId: contract.libraryTemplateId(e.library_procedure_id, step.touch, e.library_variant),
    };
  });
  const address = addressFromCase('email', tcCase);
  const hint = await consentHint(q, office, 'email', address, tcCase);
  return { drafts, address, hint, stepCount: steps.length };
}

/**
 * INSERT prepared library drafts, each with its planned send time. Status
 * 'draft' — a person approves each one word for word before it can be sent.
 * @param {{ query: Function }} q
 * @param {{ office: string, e: Record<string, any>, prepared: Awaited<ReturnType<typeof prepareLibraryDrafts>>, times: Date[], now: Date }} input
 */
async function insertLibraryDrafts(q, { office, e, prepared, times, now }) {
  for (let k = 0; k < prepared.drafts.length; k++) {
    const d = prepared.drafts[k];
    await q.query(
      `INSERT INTO tc_messages (message_id, office_id, case_id, direction, channel, to_address, body, subject,
         template_id, status, created_by, email_blocks, email_preheader, enrollment_id, touch_key, consent_blocked_hint,
         created_at, scheduled_for)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [
        randomUUID(),
        office,
        e.case_id,
        'outbound',
        'email',
        prepared.address,
        d.body,
        d.subject,
        d.templateId,
        'draft',
        store.SYSTEM_ACTOR,
        JSON.stringify(d.emailBlocks),
        d.preheader,
        e.enrollment_id,
        d.stage,
        prepared.hint,
        now.toISOString(),
        times[k].toISOString(),
      ]
    );
  }
}

/** "Dec 1" in the office's zone, for event text. @param {string} tz @param {Date} d */
function shortLocalDate(tz, d) {
  return d.toLocaleDateString('en-US', { timeZone: tz, month: 'short', day: 'numeric' });
}

/**
 * The nightly pass over ONE library enrollment (EL-2c).
 *   steps left to write (a campaign started under #359, which wrote one a
 *   night)  → ALL of them now, in one transaction, with planned times from
 *              today; the earlier drafts that have no planned time get one in
 *              the same re-plan, so order, gaps and caps hold across all of
 *              them. Exactly once: the claim moves the index to the end.
 *   every step written → nothing to write; it stops being listed as due, and
 *              it completes only when every email was sent or skipped.
 * @returns {Promise<'queued'|'completed'|'idle'|'lost_claim'>}
 */
async function processLibraryEnrollment(q, office, e, tcCase, { tz, now, merge }) {
  const steps = store.stepsOf(e);
  const index = Number(e.next_touch_index);
  if (index >= steps.length) {
    await store.defer(q, office, e.enrollment_id, null);
    return (await store.completeIfFinished(q, office, e.enrollment_id, { now })) ? 'completed' : 'idle';
  }

  // Render everything first: a throw here writes nothing and claims nothing.
  const prepared = await prepareLibraryDrafts(q, office, e, tcCase, merge, index);
  const rows = await store.messagesOfEnrollments(q, office, [e.enrollment_id]);
  const earlier = rows
    .filter((m) => store.WAITING_STATUSES.includes(m.status))
    .map((m) => ({ m, i: store.stepIndexOf(steps, m.touch_key) }))
    .filter((x) => x.i >= 0 && x.i < index)
    .sort((a, b) => a.i - b.i);
  // What already went out (or failed) counts against the caps; skipped never left.
  const fixed = rows
    .filter((m) => !store.WAITING_STATUSES.includes(m.status) && m.status !== 'skipped')
    .map((m) => store.dateOrNull(m.sent_at) || store.dateOrNull(m.created_at))
    .filter(Boolean);
  const pending = [
    ...earlier.map((x) => ({ day: steps[x.i].day, time: store.dateOrNull(x.m.scheduled_for) })),
    ...prepared.drafts.map((d) => ({ day: d.day, time: null })),
  ];
  const times = engine.replanForward({ tz, now, pending, fixed });
  if (!times) throw new Error('[tcNurture] library catch-up found nothing to plan');

  const claimed = await store.advance(q, office, e.enrollment_id, {
    expectIndex: index,
    nextIndex: steps.length,
    lastTouchAt: now.toISOString(),
    nextTouchDueAt: null,
    status: 'active',
  });
  if (!claimed) return 'lost_claim';

  for (let k = 0; k < earlier.length; k++) {
    await q.query(
      `UPDATE tc_messages SET scheduled_for = $3
        WHERE office_id = $1 AND message_id = $2 AND status = ANY($4)`,
      [office, earlier[k].m.message_id, times[k].toISOString(), [...store.WAITING_STATUSES]]
    );
  }
  await insertLibraryDrafts(q, { office, e, prepared, times: times.slice(earlier.length), now });
  const n = prepared.drafts.length;
  await store.insertEvent(q, {
    office,
    caseId: e.case_id,
    type: 'nurture_touch_queued',
    description:
      `${store.trackLabel(e.track_key)}: ${n} ${n === 1 ? 'email' : 'emails'} written for review at once ` +
      `(steps ${index + 1}–${steps.length} of ${steps.length}), the first planned ${shortLocalDate(tz, times[earlier.length])}. ` +
      'Nothing sends until a person approves each one.' +
      (prepared.hint ? ` — flagged: ${prepared.hint.replace(/_/g, ' ')}` : ''),
    actor: store.SYSTEM_ACTOR,
    ts: now,
  });
  return 'queued';
}

/**
 * One office's pass. Never throws per enrollment: one bad row is counted as
 * an error and the rest of the office still runs.
 * `tenantSlug` (MT-2b): the one TC tenant the scheduler resolved; its saved
 * email identity supplies the office phone in the touch copy.
 * @param {{ pool: { query: Function, connect: Function }, tenantSlug: string|null, office: string, now?: Date, tz?: string }} input
 */
async function runForOffice({ pool, tenantSlug, office, now = new Date(), tz = cfg.timezone() }) {
  const started = Date.now();
  const counts = { due: 0, queued: 0, completed: 0, deferred: 0, stopped: 0, lost_claim: 0, errors: 0 };
  const merge = cfg.officeMergeValues(tenantSlug, office);
  const due = await store.listDue(pool, office, now.toISOString());
  counts.due = due.length;
  /** @type {Set<string>} */
  const seen = new Set();
  for (const e of due) {
    seen.add(e.enrollment_id);
    try {
      const outcome = await processEnrollment(pool, office, e, { tz, now, merge });
      if (Object.prototype.hasOwnProperty.call(counts, outcome)) counts[outcome] += 1;
    } catch (err) {
      counts.errors += 1;
      // The enrollment id only — never a name, a phone or a body.
      console.error(
        `[tcNurture] office=${office} enrollment=${e.enrollment_id} failed: ${(err && err.message) || err}`
      );
    }
  }
  // EL-2c: a library campaign written in full is never "due" again; it
  // completes once every email was sent or skipped (a send in between, a
  // discard, a failure). Writes nothing else and sends nothing.
  for (const e of await store.listActiveLibrary(pool, office)) {
    if (seen.has(e.enrollment_id)) continue;
    try {
      if (await withTx(pool, (q) => store.completeIfFinished(q, office, e.enrollment_id, { now }))) counts.completed += 1;
    } catch (err) {
      counts.errors += 1;
      console.error(
        `[tcNurture] office=${office} enrollment=${e.enrollment_id} completion check failed: ${(err && err.message) || err}`
      );
    }
  }
  return { office, ...counts, phoneConfigured: merge.phoneConfigured, durationMs: Date.now() - started };
}

module.exports = {
  runForOffice,
  processEnrollment,
  consentHint,
  senderNameFor,
  libraryMerge,
  SMS_LEFT,
  // EL-2c
  prepareLibraryDrafts,
  insertLibraryDrafts,
  processLibraryEnrollment,
  shortLocalDate,
};

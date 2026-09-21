'use strict';

/**
 * The perio send — the exam in bulk where a string can say it, row by row where
 * it cannot, every site read back, and an undo (H4 item 12).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ONE MENTAL MODEL
 * ═════════════════════════════════════════════════════════════════════════════
 *   1. CONFIRM. The fingerprint of the preview she read, the exam date and the
 *      provider — all re-derived here, any difference refused. The plan
 *      (`contract.planPerioSend`) is computed from the STAGED chart and frozen
 *      onto the send row, so a resumed send writes what was confirmed.
 *   2. THE EXAM. `POST /perioexams` carrying every arch string the plan could
 *      express. A refusal creates nothing (probe finding 6): report, stop.
 *   3. THE TAIL. `POST /periomeasures` for what the strings could not carry —
 *      readings of 10+, gaps, flags with no depth, skipped teeth — READING the
 *      exam first on every step, so a retry cannot double-write.
 *   4. VERIFY. Read every measure back and compare every site to the staged
 *      chart. `Written` only on a full match. Any mismatch names the teeth and
 *      sites, and the chart goes `Failed`, loudly.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * AN INCOMPLETE PERIO CHART UNDERSTATES DISEASE
 * ═════════════════════════════════════════════════════════════════════════════
 * So an exam that exists and does not match is never "retried" as routine. It
 * is `incomplete`, the screen names what did not land, and the one real undo
 * perio has is offered: `DELETE /perioexams/{n}` removes the exam and every row
 * in it. Guarded hard (`deletePerioExamForSend`): only the exam THIS send
 * created, only while the send is unfinished, only with the number repeated by
 * the person confirming, read before and read after, audited.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * STEPS, ON THE PAGE, UNDER A LEASE
 * ═════════════════════════════════════════════════════════════════════════════
 * Every write happens inside an ordinary authenticated request the page makes —
 * never on a background thread — so each is attributed to the person who
 * confirmed it. A step holds the send's lease (perioSendStore.claimStep) for
 * its whole read-then-write, renewed before every write, so two tabs cannot
 * both read "absent" and both post a permanent row.
 *
 * Lifted from the unmerged PR #177: the three-shape write answer (ok / refused /
 * uncertain), read-before-write, "stop rather than add a second row", adopting
 * the exam that appeared since `prior_exam_nums` instead of posting another.
 * Left behind: the queue row per measurement — the bulk POST is atomic, and the
 * tail is re-planned from the frozen plan and a fresh read on every step.
 */

const crypto = require('node:crypto');

const contract = require('../../hyg/contract.gen.cjs');
const composer = require('./stagedWriteComposer');
const odPerio = require('./odPerio');
const writer = require('./odPerioWriter');
const store = require('./perioSendStore');
const visitStore = require('./visitStore');

const PAYLOAD_SCHEMA = contract.z
  .object({
    kind: contract.z.literal('perio'),
    aptNum: contract.z.number().int().positive(),
    patNum: contract.z.number().int().positive(),
    chart: contract.PerioChartSchema,
  })
  .strict();

const IN_FLIGHT = Object.freeze(['posting', 'filling']);

/**
 * How long a step's claim is honoured without renewal. Longer than one write's
 * 30s timeout plus a read, and renewed before every write, so a lapsed claim
 * belongs to a step that has stopped. Env-tunable for tests only.
 */
function leaseMs() {
  const n = Number(process.env.HYG_PERIO_SEND_LEASE_MS);
  return Number.isFinite(n) && n >= 0 ? n : 120000;
}

function refuse(status, code, error) {
  return { ok: false, status, code, error };
}

/** Open Dental's own words, ready to sit mid-sentence: trimmed, no closing full stop. */
function odWords(text) {
  return String(text || '').trim().replace(/[.\s]+$/, '');
}

/**
 * The provider the exam is filed under: the appointment's hygienist, else its
 * provider. Never defaulted — Open Dental's default is the patient's PRIMARY
 * provider, which is not who charted it.
 */
function provNumFor(appointment) {
  if (!appointment) return null;
  for (const v of [appointment.provHyg, appointment.provNum]) {
    if (Number.isInteger(v) && v > 0) return v;
  }
  return null;
}

function iso(value) {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

/** The staged chart, normalised, or null when the payload is not this visit's chart. */
function stagedChart(staged, visit) {
  const parsed = PAYLOAD_SCHEMA.safeParse(staged && staged.payload);
  if (!parsed.success || parsed.data.patNum !== visit.patNum || parsed.data.aptNum !== visit.aptNum) {
    return null;
  }
  return contract.normalizePerioChart(parsed.data.chart);
}

/** Exams that appeared since `prior`, with this send's date and provider. */
function newExams(exams, send, prior) {
  return exams.filter(
    (e) => !prior.has(e.examNum) && e.examDate === send.exam_date && e.provNum === send.prov_num
  );
}

function sameMeasure(odRow, body) {
  return writer.MEASURE_VALUE_KEYS.every((k) => Number(odRow[k]) === Number(body[k]));
}

function describeValues(values) {
  return writer.MEASURE_VALUE_KEYS.slice(1)
    .map((k) => `${k.replace('value', '')} ${Number(values[k])}`)
    .join(', ');
}

/** Open Dental's rows for one exam, grouped by (tooth, SequenceType). */
function groupRows(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = `${Number(r.IntTooth)}:${String(r.SequenceType || '').trim()}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// What the screen reads
// ─────────────────────────────────────────────────────────────────────────────

/** The send row as the contract's view. Pure. */
function sendView(send) {
  if (!send) return null;
  const plan = send.plan && typeof send.plan === 'object' ? send.plan : {};
  const rowsPlanned = Array.isArray(plan.rows) ? plan.rows.length : 0;
  const rowsWritten = Math.min(Number(send.rows_written) || 0, rowsPlanned);
  const inFlight = IN_FLIGHT.includes(send.state);
  return {
    sendId: String(send.send_id),
    state: send.state,
    examNum: send.exam_num,
    examDate: String(send.exam_date),
    provNum: Number(send.prov_num),
    arches: Array.isArray(plan.arches) ? plan.arches : [],
    rowsPlanned,
    rowsWritten,
    deepSites: Array.isArray(plan.deepSites) ? plan.deepSites.length : 0,
    mismatches: Array.isArray(send.mismatches) ? send.mismatches : [],
    errorMessage: send.error_message ?? null,
    requestsRemaining: inFlight
      ? contract.estimatePerioSendRequests({
          examCreated: send.exam_num !== null,
          rowsRemaining: rowsPlanned - rowsWritten,
        })
      : 0,
    startedBy: String(send.created_by),
    startedAt: iso(send.created_at) || '',
    finishedAt: iso(send.finished_at),
    deletedBy: send.deleted_by ?? null,
    deletedAt: iso(send.deleted_at),
    // THE UNDO IS ONLY EVER THE EXAM THIS SEND CREATED. The exam it replaces is
    // not this send's to remove except as the last step of a verified swap.
    canDelete: send.exam_num !== null && (send.state === 'filling' || send.state === 'incomplete'),
    supersedesExamNum: send.supersedes_exam_num ?? null,
    supersedesDeletedAt: iso(send.supersedes_deleted_at),
    amendDiff: Array.isArray(send.amend_diff) ? send.amend_diff : [],
    writtenChart: sendChart(send),
  };
}

/**
 * The latest send of this visit's chart, and the LIVE one — the most recent
 * send that verified, whose exam is the one in Open Dental now. Our database
 * only. A live send is what makes the next send an amendment.
 */
async function readSend(pool, { office, visit }) {
  const staged = await visitStore.getStagedWrite(pool, { office, visitId: visit.visitId, kind: 'perio' });
  if (!staged) return { staged: null, send: null, live: null };
  const send = await store.getLatestSend(pool, { office, stagedWriteId: staged.staged_write_id });
  const live = await store.getLiveSend(pool, { office, stagedWriteId: staged.staged_write_id });
  return { staged, send, live };
}

/** The chart a send wrote, if this build can read it back. */
function sendChart(send) {
  if (!send || !send.chart) return null;
  const parsed = contract.PerioChartSchema.safeParse(send.chart);
  return parsed.success ? contract.normalizePerioChart(parsed.data) : null;
}

/**
 * What Open Dental holds for one exam, as a chart.
 *
 * @returns {Promise<{ ok: true, chart: object } | { ok: false, error: string }>}
 */
async function readExamChart(odGet, examNum) {
  const read = await odPerio.readExamMeasures(odGet, { examNum });
  if (!read.ok) return { ok: false, error: read.error };
  if (read.truncated) return { ok: false, error: `only part of exam ${examNum} came back` };
  return { ok: true, chart: odPerio.chartFromMeasures(read.rows).chart };
}

// ─────────────────────────────────────────────────────────────────────────────
// Confirm
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Confirm a staged chart and record its send. Writes NOTHING to Open Dental.
 *
 * @returns {Promise<{ ok: true } | { ok: false, status: number, code: string, error: string }>}
 */
async function startPerioSend({ pool, office, visit, appointment, request, actor, odGet }) {
  const { staged, send: latest, live } = await readSend(pool, { office, visit });
  if (!staged) return refuse(409, 'NOT_STAGED', 'There is no staged perio chart on this visit.');
  if (latest && IN_FLIGHT.includes(latest.state)) {
    return refuse(409, 'PERIO_SEND_IN_PROGRESS', 'This chart is already being sent. Continue that send from the chart.');
  }
  if (latest && latest.state === 'incomplete' && latest.exam_num !== null) {
    return refuse(
      409,
      'PERIO_EXAM_EXISTS',
      `Exam ${latest.exam_num} from the last send is still in Open Dental and incomplete. Delete it, or ` +
        'correct it in Open Dental, before sending this chart again.'
    );
  }
  if (staged.state !== 'Staged') {
    return refuse(
      409,
      'NOT_STAGED',
      staged.state === 'Written'
        ? 'This chart is already in Open Dental.'
        : 'The perio chart is not staged. Stage it, read it, then send it.'
    );
  }

  // THE PREVIEW IS THE WRITE. What she read, against what is stored.
  if (visitStore.fingerprintPreview(staged.preview) !== request.previewFingerprint) {
    return refuse(
      409,
      'PREVIEW_CHANGED',
      'The perio chart changed since you read it. Nothing was sent. Read it again and confirm the version on screen now.'
    );
  }
  const chart = stagedChart(staged, visit);
  if (!chart) {
    return refuse(
      409,
      'PAYLOAD_INVALID',
      'This chart was staged by a different version of CareIN or for a different visit. Stage it again.'
    );
  }
  // …and against what is ABOUT TO BE WRITTEN: the preview recomposed from the
  // chart the plan is built from must be the preview she confirmed.
  const recomposed = composer.compose('perio', { visit, items: [], actor, draft: { chart } });
  if (!recomposed.preview || visitStore.fingerprintPreview(recomposed.preview) !== request.previewFingerprint) {
    return refuse(
      409,
      'PREVIEW_CHANGED',
      'The chart stored on this visit no longer matches the preview you confirmed. Nothing was sent.'
    );
  }

  if (!visit.visitDate || visit.visitDate !== request.examDate) {
    return refuse(
      409,
      'EXAM_DATE_CHANGED',
      `The exam date is ${visit.visitDate || 'unknown'}, not the ${request.examDate} you confirmed. Nothing was sent.`
    );
  }
  const provNum = provNumFor(appointment);
  if (provNum === null) {
    return refuse(
      409,
      'NO_PROVIDER',
      'This appointment has no provider in Open Dental. An exam sent without one is filed under the ' +
        "patient's primary provider instead of whoever charted it, so nothing was sent."
    );
  }
  if (provNum !== request.provNum) {
    return refuse(
      409,
      'PROVIDER_CHANGED',
      `The appointment's provider is now ${provNum}, not the ${request.provNum} you confirmed. Nothing was sent.`
    );
  }

  const plan = contract.planPerioSend(chart);
  if (Object.keys(plan.strings).length === 0 && plan.rows.length === 0) {
    return refuse(422, 'NOTHING_TO_SEND', 'This chart holds no readings to write.');
  }

  /*
   * ITEM 13: IS THIS A CORRECTION?
   *
   * A live send means an exam for this visit IS in Open Dental, so this send
   * REPLACES it rather than adding a second one. Before anything is written,
   * Open Dental is read back: the exam must still be there, and it must still
   * hold what the baseline says, or somebody has edited it since she pressed
   * Amend and this send would quietly revert their correction.
   */
  let supersedesExamNum = null;
  let amendDiff = [];
  if (live && live.exam_num !== null) {
    if (typeof odGet !== 'function') {
      return refuse(500, 'OD_READ_FAILED', 'A correction cannot be confirmed without reading Open Dental.');
    }
    const exams = await odPerio.readExams(odGet, { patNum: visit.patNum });
    if (!exams.ok || exams.truncated) {
      return refuse(
        502,
        'OD_READ_FAILED',
        "Open Dental did not return this patient's perio exams, so the correction was not sent."
      );
    }
    if (!exams.exams.some((e) => e.examNum === live.exam_num)) {
      return refuse(
        409,
        'AMEND_BASE_MISSING',
        `Exam ${live.exam_num} is no longer in Open Dental, so there is nothing to correct. Nothing was sent.`
      );
    }
    const odChart = await readExamChart(odGet, live.exam_num);
    if (!odChart.ok) {
      return refuse(
        502,
        'OD_READ_FAILED',
        `Open Dental did not return exam ${live.exam_num}'s readings (${odChart.error}), so the correction was not sent.`
      );
    }
    const baseline = sendChart(live) || odChart.chart;
    const drift = contract.perioChartChanges(baseline, odChart.chart);
    if (drift.length > 0) {
      const lines = drift.slice(0, 3).map(contract.perioChangeLine).join('; ');
      return refuse(
        409,
        'AMEND_BASE_CHANGED',
        `Exam ${live.exam_num} has been changed in Open Dental since this correction was started ` +
          `(${lines}${drift.length > 3 ? ` and ${drift.length - 3} more` : ''}). Nothing was sent. ` +
          'Open the chart again to start from what Open Dental holds now.'
      );
    }
    amendDiff = contract.perioChartChanges(baseline, chart);
    if (amendDiff.length === 0) {
      return refuse(
        422,
        'NOTHING_TO_SEND',
        `This chart is identical to exam ${live.exam_num} in Open Dental. There is nothing to correct.`
      );
    }
    supersedesExamNum = live.exam_num;
  }

  const claimed = await visitStore.markSending(pool, { office, visitId: visit.visitId, kind: 'perio' });
  if (!claimed) return refuse(409, 'NOT_STAGED', 'Another send started this chart first.');
  try {
    await store.createSend(pool, {
      office,
      visitId: visit.visitId,
      stagedWriteId: staged.staged_write_id,
      patNum: visit.patNum,
      examDate: request.examDate,
      provNum,
      previewFingerprint: request.previewFingerprint,
      plan,
      actor,
      supersedesExamNum,
      amendDiff,
    });
  } catch (err) {
    // Nothing reached Open Dental — the exam is only ever posted from a
    // recorded send. Put the chart back rather than strand it in Sending.
    await store.restageChart(pool, { office, visitId: visit.visitId });
    throw err;
  }
  return { ok: true, amending: supersedesExamNum !== null, supersedesExamNum, amendDiff };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step
// ─────────────────────────────────────────────────────────────────────────────

async function stopIncomplete(ctx, send, message, mismatches) {
  const undo =
    send.exam_num !== null
      ? ` An incomplete perio chart understates disease. Delete exam ${send.exam_num} from Open Dental on the perio chart page, or correct it there.`
      : ' An incomplete perio chart understates disease. Check this patient\'s perio chart in Open Dental before sending again.';
  const full = message + undo;
  await store.finishSend(ctx.pool, {
    office: ctx.office,
    sendId: send.send_id,
    state: 'incomplete',
    errorMessage: full,
    mismatches,
  });
  await visitStore.markFailed(ctx.pool, { office: ctx.office, visitId: ctx.visit.visitId, kind: 'perio', error: full });
  ctx.mismatches = mismatches.length;
}

async function adoptExam(ctx, send, examNum) {
  await store.markFilling(ctx.pool, { office: ctx.office, sendId: send.send_id, examNum });
}

async function settleExam(ctx, send) {
  const { pool, office, od, odGet } = ctx;

  const before = await odPerio.readExams(odGet, { patNum: send.pat_num });
  if (!before.ok) {
    ctx.paused = `Open Dental did not answer when asked for this patient's perio exams (${before.error}). Nothing was sent.`;
    return;
  }
  if (before.truncated) {
    ctx.paused = "Open Dental returned only part of this patient's exam list, so the exam was not sent.";
    return;
  }

  if (Array.isArray(send.prior_exam_nums)) {
    // ATTEMPTED BEFORE, AND ITS ANSWER NEVER CAME BACK. Read, do not re-post.
    const mine = newExams(before.exams, send, new Set(send.prior_exam_nums.map(Number)));
    if (mine.length === 1) return adoptExam(ctx, send, mine[0].examNum);
    if (mine.length > 1) {
      return stopIncomplete(
        ctx,
        send,
        `${mine.length} new perio exams on ${send.exam_date} for this provider appeared ` +
          `(${mine.map((e) => e.examNum).join(', ')}), and CareIN will not guess which is its own.`,
        []
      );
    }
    // None appeared: the earlier POST did not land, so posting now is not a second one.
  }

  await store.setPriorExamNums(pool, {
    office,
    sendId: send.send_id,
    priorExamNums: before.exams.map((e) => e.examNum),
  });
  if (!(await store.renewStep(pool, { office, sendId: send.send_id, token: ctx.token }))) {
    ctx.paused = 'Another tab took over this send. Nothing was sent from here.';
    return;
  }

  const res = await writer.createPerioExam(od, {
    patNum: send.pat_num,
    examDate: send.exam_date,
    provNum: send.prov_num,
    strings: send.plan.strings || {},
  });
  ctx.attempted.push({ action: 'CREATE', target: 'exam', ok: res.ok });
  if (!res.ok) {
    if (res.refused) {
      const message =
        `Open Dental refused this perio exam - ${odWords(res.error)}. Nothing was created in Open Dental, ` +
        'so there is nothing to undo.';
      await store.finishSend(pool, { office, sendId: send.send_id, state: 'refused', errorMessage: message });
      await visitStore.markFailed(pool, { office, visitId: ctx.visit.visitId, kind: 'perio', error: message });
      return;
    }
    ctx.paused =
      `Open Dental did not answer for the exam (${res.error}). CareIN will check whether it landed ` +
      'before sending it again.';
    return;
  }

  const after = await odPerio.readExams(odGet, { patNum: send.pat_num });
  if (!after.ok || after.truncated) {
    ctx.paused = 'The exam was sent and has not been read back yet. The next step reads before it sends anything.';
    return;
  }
  const appeared = newExams(after.exams, send, new Set(before.exams.map((e) => e.examNum)));
  if (appeared.length === 1) return adoptExam(ctx, send, appeared[0].examNum);
  if (appeared.length > 1) {
    return stopIncomplete(
      ctx,
      send,
      `${appeared.length} new perio exams appeared at once (${appeared.map((e) => e.examNum).join(', ')}), ` +
        'and CareIN will not guess which is its own.',
      []
    );
  }
  // Accepted and not there. NOT paused: a paused step would re-post on the next
  // one, and a second exam header is exactly what this must never do.
  return stopIncomplete(
    ctx,
    send,
    "Open Dental accepted the exam but it is not among this patient's exams when read back.",
    []
  );
}

/** Duplicate rows for one (tooth, SequenceType) — a mismatch no chart comparison can see. */
function duplicateMismatches(grouped) {
  const out = [];
  for (const [key, rows] of grouped) {
    if (rows.length < 2) continue;
    const [tooth, type] = key.split(':');
    if (!contract.PerioSendSequenceTypeSchema.options.includes(type)) continue;
    out.push({
      tooth: Number(tooth),
      surface: null,
      kind: 'duplicate',
      expected: `one ${type} row`,
      found: `${rows.length} ${type} rows`,
    });
  }
  return out;
}

async function verify(ctx, send, rows) {
  const chart = stagedChart(ctx.staged, ctx.visit);
  if (!chart || visitStore.fingerprintPreview(ctx.staged.preview) !== send.preview_fingerprint) {
    return stopIncomplete(
      ctx,
      send,
      `The staged chart no longer matches the one confirmed for exam ${send.exam_num}, so it cannot be verified.`,
      []
    );
  }
  const found = odPerio.chartFromMeasures(rows).chart;
  const mismatches = [
    ...duplicateMismatches(groupRows(rows)),
    ...contract.comparePerioReadback(chart, found),
  ];
  if (mismatches.length > 0) {
    const lines = mismatches.slice(0, 3).map(contract.perioMismatchLine).join('; ');
    const more = mismatches.length > 3 ? ` and ${mismatches.length - 3} more` : '';
    return stopIncomplete(
      ctx,
      send,
      `Exam ${send.exam_num} is in Open Dental but does not match this chart at ${mismatches.length} ` +
        `${mismatches.length === 1 ? 'place' : 'places'}: ${lines}${more}.`,
      mismatches
    );
  }

  // WHAT THIS SEND WROTE, recorded now that Open Dental agrees with it. It is
  // the baseline the next correction is diffed against, and the thing an
  // amendment re-reads Open Dental against before it writes anything.
  await store.setSendChart(ctx.pool, { office: ctx.office, sendId: send.send_id, chart });

  /*
   * ITEM 13 — THE SWAP'S LAST STEP, AND ONLY NOW.
   *
   * The corrected exam exists and every site of it has been read back, so the
   * exam it replaces may go. Never before: a window with no perio exam at all
   * is worse than a window with a wrong digit in one, and a re-create that
   * failed would leave the patient with nothing.
   *
   * If the delete does not land, the chart is still correct in Open Dental and
   * a duplicate exam is still there. That is said out loud, on the send and on
   * the screen, rather than retried silently.
   */
  let swapNote = null;
  if (send.supersedes_exam_num !== null) {
    const removal = await removeExam(ctx, send.supersedes_exam_num);
    if (removal.ok) {
      await store.markSupersededDeleted(ctx.pool, { office: ctx.office, sendId: send.send_id });
    } else {
      swapNote =
        `Exam ${send.exam_num} is correct and was read back in full. The exam it replaces, ` +
        `${send.supersedes_exam_num}, is STILL in Open Dental: ${removal.error}. Remove it from this ` +
        'page, or delete it in Open Dental.';
    }
    ctx.amend = {
      oldExam: send.supersedes_exam_num,
      newExam: send.exam_num,
      changes: Array.isArray(send.amend_diff) ? send.amend_diff : [],
      replacedRemoved: removal.ok,
    };
  }

  await store.finishSend(ctx.pool, {
    office: ctx.office,
    sendId: send.send_id,
    state: 'written',
    errorMessage: swapNote,
  });
  await visitStore.markWritten(ctx.pool, {
    office: ctx.office,
    visitId: ctx.visit.visitId,
    kind: 'perio',
    actor: send.created_by,
    // The swap's outcome is part of what the chart says it is.
    writtenRef: writtenRefFor({ ...send, supersedes_deleted_at: swapNote === null ? new Date() : null }, chart),
  });
  return undefined;
}

/**
 * What a staged write says once its exam is in Open Dental.
 *
 * ONE definition, because two places need the identical sentence: the send that
 * writes it, and a correction that is ABANDONED and has to put it back exactly
 * as it was. `hyg_staged_write_written_ref_check` is a biconditional — only a
 * `Written` row may carry a reference, and it must — so opening a correction
 * clears it and closing one restores it. The exam number itself is never lost:
 * it lives on the send row, which is the record of what is in the chart.
 */
function writtenRefFor(send, chart) {
  const counts = contract.countPerioChart(chart);
  const skipped = counts.teethSkipped.length;
  const readBack =
    `Perio exam ${send.exam_num}: ${counts.sitesCharted} sites` +
    (skipped > 0 ? ` and ${skipped} skipped ${skipped === 1 ? 'tooth' : 'teeth'}` : '') +
    ' read back and match';
  if (send.supersedes_exam_num === null || send.supersedes_exam_num === undefined) return readBack;
  return (
    `${readBack} (amended; replaced exam ${send.supersedes_exam_num}` +
    (send.supersedes_deleted_at ? ', now deleted)' : ' — STILL in Open Dental)')
  );
}

/**
 * Delete one exam and PROVE it is gone: read the patient's exams, delete, read
 * again. Never called for anything but an exam this send is entitled to remove
 * — the one it replaces, after its own exam verified.
 *
 * @returns {Promise<{ ok: true, alreadyGone: boolean } | { ok: false, error: string }>}
 */
async function removeExam(ctx, examNum) {
  const before = await odPerio.readExams(ctx.odGet, { patNum: ctx.visit.patNum });
  if (!before.ok || before.truncated) {
    return { ok: false, error: "Open Dental did not return this patient's exams" };
  }
  if (!before.exams.some((e) => e.examNum === examNum)) {
    // Somebody deleted it in Open Dental already. The swap's outcome is the same.
    return { ok: true, alreadyGone: true };
  }
  const res = await writer.deletePerioExam(ctx.od, { examNum });
  ctx.attempted.push({ action: 'DELETE', target: 'exam', ok: res.ok });
  if (!res.ok) return { ok: false, error: odWords(res.error) };

  const after = await odPerio.readExams(ctx.odGet, { patNum: ctx.visit.patNum });
  if (!after.ok || after.truncated) {
    return { ok: false, error: 'the delete was sent but Open Dental did not answer when asked again' };
  }
  if (after.exams.some((e) => e.examNum === examNum)) {
    return { ok: false, error: 'it is still listed after the delete' };
  }
  return { ok: true, alreadyGone: false };
}

async function fillAndVerify(ctx, send) {
  const { pool, office, od, odGet } = ctx;
  const examNum = send.exam_num;

  // READ BEFORE WRITE, EVERY STEP. And nothing is posted on a truncated read:
  // a row missing from half a list is not missing from the chart.
  const read = await odPerio.readExamMeasures(odGet, { examNum });
  if (!read.ok) {
    ctx.paused = `Open Dental did not answer when asked for exam ${examNum}'s rows (${read.error}). Nothing was sent.`;
    return;
  }
  if (read.truncated) {
    ctx.paused = `Open Dental returned only part of exam ${examNum}, so nothing was sent.`;
    return;
  }
  const present = groupRows(read.rows);

  const toPost = [];
  for (const row of send.plan.rows || []) {
    const hits = present.get(`${row.tooth}:${row.sequenceType}`) || [];
    if (hits.length > 1) {
      return stopIncomplete(
        ctx,
        send,
        `#${row.tooth} ${row.sequenceType}: Open Dental holds ${hits.length} rows for this tooth in exam ` +
          `${examNum}, so CareIN stopped rather than add another.`,
        duplicateMismatches(new Map([[`${row.tooth}:${row.sequenceType}`, hits]]))
      );
    }
    if (hits.length === 1) {
      if (sameMeasure(hits[0], row.body)) continue; // IT LANDED LAST TIME. Found by reading.
      return stopIncomplete(
        ctx,
        send,
        `#${row.tooth} ${row.sequenceType}: Open Dental already holds a different row for this tooth in ` +
          `exam ${examNum} (${describeValues(hits[0])}), so CareIN stopped rather than add a second.`,
        []
      );
    }
    toPost.push(row);
  }

  if (toPost.length === 0) return verify(ctx, send, read.rows);

  let posted = 0;
  try {
    for (const row of toPost.slice(0, contract.PERIO_SEND_BATCH)) {
      if (!(await store.renewStep(pool, { office, sendId: send.send_id, token: ctx.token }))) {
        ctx.paused = 'Another tab took over this send. Nothing more was sent from here.';
        return undefined;
      }
      const res = await writer.createPerioMeasure(od, {
        examNum,
        tooth: row.tooth,
        sequenceType: row.sequenceType,
        values: row.body,
      });
      ctx.attempted.push({ action: 'CREATE', target: 'measure', ok: res.ok });
      if (!res.ok) {
        if (res.refused) {
          return stopIncomplete(
            ctx,
            send,
            `#${row.tooth} ${row.sequenceType}: Open Dental refused it - ${odWords(res.error)}.`,
            []
          );
        }
        ctx.paused =
          `Open Dental did not answer for #${row.tooth} ${row.sequenceType}. CareIN will check whether it ` +
          'landed before sending it again.';
        return undefined;
      }
      posted += 1;
    }
  } finally {
    if (posted > 0) await store.addRowsWritten(pool, { office, sendId: send.send_id, count: posted });
  }
  // The next step reads what these landed as, posts what is left, and verifies
  // once nothing is.
  return undefined;
}

/**
 * One bounded step. Never throws for an Open Dental failure — a refusal or a
 * mismatch stops the send, no answer pauses it.
 *
 * @returns {Promise<{ ok: true, attempted: object[], paused: string|null }
 *          | { ok: false, status: number, code: string, error: string }>}
 */
async function stepPerioSend({ pool, office, visit, od, odGet }) {
  const startedAt = Date.now();
  const { staged, send } = await readSend(pool, { office, visit });
  if (!staged) return refuse(409, 'NOT_STAGED', 'There is no perio chart on this visit.');

  if (staged.state === 'Sending' && (!send || !IN_FLIGHT.includes(send.state))) {
    // A confirm that claimed the chart and died before recording its send. The
    // exam is only ever posted from a recorded send, so nothing reached Open Dental.
    await store.restageChart(pool, { office, visitId: visit.visitId });
    return { ok: true, attempted: [], paused: 'That send never started, and nothing was written. The chart is staged again.' };
  }
  if (!send || !IN_FLIGHT.includes(send.state)) return { ok: true, attempted: [], paused: null };

  const token = crypto.randomUUID();
  const claimed = await store.claimStep(pool, {
    office,
    sendId: send.send_id,
    token,
    leaseCutoff: new Date(Date.now() - leaseMs()),
  });
  if (!claimed) {
    return { ok: true, attempted: [], paused: 'Another tab is writing this chart right now. Nothing was sent from here.' };
  }

  const ctx = { pool, office, visit, od, odGet, staged, token, attempted: [], paused: null, mismatches: 0 };
  try {
    if (send.state === 'posting') await settleExam(ctx, send);
    const current = await store.getLatestSend(pool, { office, stagedWriteId: staged.staged_write_id });
    if (!ctx.paused && current && current.send_id === send.send_id && current.state === 'filling') {
      await fillAndVerify(ctx, current);
    }
  } finally {
    await store.releaseStep(pool, { office, sendId: send.send_id, token });
  }

  const after = await store.getLatestSend(pool, { office, stagedWriteId: staged.staged_write_id });
  const plan = (after && after.plan) || {};
  // Counts and milliseconds. Never a PatNum, never a reading.
  console.log(
    `[hygperio] office=${office} exam=${(after && after.exam_num) ?? 'none'} ` +
      `arches=${Object.keys(plan.strings || {}).length} rows=${(plan.rows || []).length} ` +
      `deep=${(plan.deepSites || []).length} ` +
      `mismatches=${Array.isArray(after && after.mismatches) ? after.mismatches.length : ctx.mismatches} ` +
      `ms=${Date.now() - startedAt}`
  );
  // `amend` is set only by a swap that completed in this step: both exam
  // numbers and the per-site changes, for the audit trail the route writes.
  return { ok: true, attempted: ctx.attempted, paused: ctx.paused, amend: ctx.amend || null };
}

// ─────────────────────────────────────────────────────────────────────────────
// The undo
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Delete the exam THIS send created, and put the chart back on the list.
 *
 * Every guard is a refusal that deletes nothing:
 *   - there is a send, and it knows the exam it created;
 *   - the number repeated in the request IS that exam;
 *   - the send is unfinished (`filling` or `incomplete`) — a written chart is
 *     corrected in Open Dental, never deleted from here;
 *   - no step of the send is running (the lease);
 *   - Open Dental lists that exam for THIS patient before the delete, and does
 *     not list it after.
 *
 * @returns {Promise<{ ok: true, attempted: object[], alreadyGone: boolean }
 *          | { ok: false, status: number, code: string, error: string, attempted?: object[] }>}
 */
async function deletePerioExamForSend({ pool, office, visit, od, odGet, request, actor }) {
  const { staged, send } = await readSend(pool, { office, visit });
  if (!staged || !send || send.exam_num === null) {
    return refuse(
      409,
      'PERIO_EXAM_NOT_DELETABLE',
      'No exam was created by a send of this chart, so there is nothing to delete.'
    );
  }
  if (send.exam_num !== request.examNum) {
    return refuse(
      409,
      'PERIO_EXAM_NOT_DELETABLE',
      `Exam ${request.examNum} is not the exam this send created (${send.exam_num}). Nothing was deleted.`
    );
  }
  if (send.state !== 'filling' && send.state !== 'incomplete') {
    return refuse(
      409,
      'PERIO_EXAM_NOT_DELETABLE',
      send.state === 'written'
        ? `Exam ${send.exam_num} was written and read back in full. A finished chart is corrected in Open Dental, not deleted from here.`
        : `Exam ${send.exam_num} has already been deleted.`
    );
  }

  const token = crypto.randomUUID();
  const claimed = await store.claimStep(pool, {
    office,
    sendId: send.send_id,
    token,
    leaseCutoff: new Date(Date.now() - leaseMs()),
  });
  if (!claimed) {
    return refuse(409, 'PERIO_SEND_BUSY', 'This send is writing right now. Let it stop, then delete the exam.');
  }

  const attempted = [];
  try {
    const before = await odPerio.readExams(odGet, { patNum: send.pat_num });
    if (!before.ok || before.truncated) {
      return refuse(
        502,
        'OD_READ_FAILED',
        "Open Dental did not return this patient's perio exams, so nothing was deleted."
      );
    }
    if (!before.exams.some((e) => e.examNum === send.exam_num)) {
      // Already gone — somebody deleted it in Open Dental. Record that, without a delete.
      await store.markDeleted(pool, { office, sendId: send.send_id, actor });
      await store.restageChart(pool, { office, visitId: visit.visitId });
      return { ok: true, attempted, alreadyGone: true };
    }
    if (!(await store.renewStep(pool, { office, sendId: send.send_id, token }))) {
      return refuse(409, 'PERIO_SEND_BUSY', 'This send is writing right now. Let it stop, then delete the exam.');
    }

    const res = await writer.deletePerioExam(od, { examNum: send.exam_num });
    attempted.push({ action: 'DELETE', target: 'exam', ok: res.ok });
    if (!res.ok) {
      return {
        ...refuse(
          res.refused ? 409 : 502,
          res.refused ? 'OD_REFUSED' : 'OD_NO_ANSWER',
          `Open Dental did not delete exam ${send.exam_num}: ${odWords(res.error)}. Nothing here changed.`
        ),
        attempted,
      };
    }

    const after = await odPerio.readExams(odGet, { patNum: send.pat_num });
    if (!after.ok || after.truncated || after.exams.some((e) => e.examNum === send.exam_num)) {
      return {
        ...refuse(
          502,
          'OD_DELETE_UNCONFIRMED',
          `The delete was sent, but exam ${send.exam_num} is ${after.ok ? 'still listed' : 'not confirmed gone'} ` +
            'in Open Dental. Nothing here changed; try again once Open Dental answers.'
        ),
        attempted,
      };
    }
    await store.markDeleted(pool, { office, sendId: send.send_id, actor });
    await store.restageChart(pool, { office, visitId: visit.visitId });
    return { ok: true, attempted, alreadyGone: false };
  } finally {
    await store.releaseStep(pool, { office, sendId: send.send_id, token });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Amending a chart that is already in Open Dental (item 13)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Open a `Written` chart for a correction. WRITES NOTHING TO OPEN DENTAL.
 *
 * The readings she starts from are the ones OPEN DENTAL HOLDS RIGHT NOW, read
 * here and loaded into the chart — not CareIN's memory of what it wrote. If
 * somebody corrected a site in Open Dental since, she sees their correction and
 * edits from it, and the count of what differed is reported so the screen can
 * say so.
 *
 * @returns {Promise<{ ok: true, examNum: number, changedInOpenDental: number }
 *          | { ok: false, status: number, code: string, error: string }>}
 */
async function beginAmendment({ pool, office, visit, odGet, actor }) {
  const { staged, send, live } = await readSend(pool, { office, visit });
  if (!staged || !live || live.exam_num === null) {
    return refuse(409, 'NOT_AMENDABLE', 'This chart is not in Open Dental, so there is nothing to correct.');
  }
  if (send && IN_FLIGHT.includes(send.state)) {
    return refuse(409, 'PERIO_SEND_IN_PROGRESS', 'This chart is being sent right now. Let it finish first.');
  }
  if (staged.state !== 'Written') {
    return refuse(
      409,
      'NOT_AMENDABLE',
      staged.state === 'Amending' || staged.state === 'Staged'
        ? 'This chart is already open for a correction.'
        : `This chart is ${String(staged.state).toLowerCase()}, not written, so there is nothing to correct yet.`
    );
  }

  const odChart = await readExamChart(odGet, live.exam_num);
  if (!odChart.ok) {
    return refuse(
      502,
      'OD_READ_FAILED',
      `Open Dental did not return exam ${live.exam_num}'s readings (${odChart.error}), so a correction ` +
        'cannot be started. Nothing changed.'
    );
  }
  const changedInOpenDental = contract.perioChartChanges(sendChart(live) || odChart.chart, odChart.chart).length;
  await store.setSendChart(pool, { office, sendId: live.send_id, chart: odChart.chart });

  const opened = await visitStore.beginPerioAmendment(pool, { office, visitId: visit.visitId });
  if (!opened) {
    return refuse(409, 'NOT_AMENDABLE', 'This chart changed while it was being opened. Open it again.');
  }
  const loaded = await visitStore.savePerioDraft(pool, {
    office,
    visit,
    chart: odChart.chart,
    actor,
    amending: true,
  });
  if (!loaded.ok) return refuse(409, loaded.code, loaded.message);
  return { ok: true, examNum: live.exam_num, changedInOpenDental };
}

/**
 * Abandon a correction: the chart goes back to the readings Open Dental holds,
 * and back to `Written`. NOTHING in Open Dental changes — it never did.
 */
async function cancelAmendment({ pool, office, visit, actor }) {
  const { staged, live } = await readSend(pool, { office, visit });
  if (!staged || !live || !['Amending', 'Staged'].includes(staged.state)) {
    return refuse(409, 'NOT_AMENDING', 'This chart is not open for a correction.');
  }
  const baseline = sendChart(live);
  if (!baseline) {
    return refuse(
      409,
      'NOT_AMENDING',
      `CareIN cannot tell what exam ${live.exam_num} holds, so it cannot put the chart back. ` +
        'Open the chart again to read it from Open Dental.'
    );
  }
  const composed = composer.compose('perio', { visit, items: [], actor, draft: { chart: baseline } });
  const closed = await visitStore.cancelPerioAmendment(pool, {
    office,
    visit,
    chart: baseline,
    composed,
    actor,
    // Put back the exact reference the send wrote: a `Written` row must carry one.
    writtenRef: writtenRefFor(live, baseline),
  });
  if (!closed) return refuse(409, 'NOT_AMENDING', 'This chart is no longer open for a correction.');
  return { ok: true, examNum: live.exam_num };
}

/**
 * The swap's last step, run again: remove the exam a verified amendment
 * replaced, when the delete did not land at the time.
 *
 * This is NOT the undo. It can only ever name the exam a send already replaced,
 * and only while that send says it is still there.
 */
async function removeReplacedExam({ pool, office, visit, od, odGet, request, actor }) {
  const { live } = await readSend(pool, { office, visit });
  if (!live || live.supersedes_exam_num === null || live.supersedes_deleted_at !== null) {
    return refuse(409, 'NOT_REPLACED', 'No replaced exam is waiting to be removed on this chart.');
  }
  if (live.supersedes_exam_num !== request.examNum) {
    return refuse(
      409,
      'PERIO_EXAM_NOT_DELETABLE',
      `Exam ${request.examNum} is not the exam this correction replaced (${live.supersedes_exam_num}). Nothing was deleted.`
    );
  }

  const token = crypto.randomUUID();
  const claimed = await store.claimStep(pool, {
    office,
    sendId: live.send_id,
    token,
    leaseCutoff: new Date(Date.now() - leaseMs()),
  });
  if (!claimed) {
    return refuse(409, 'PERIO_SEND_BUSY', 'This chart is busy right now. Try again in a moment.');
  }
  const ctx = { pool, office, visit, od, odGet, attempted: [] };
  try {
    const removal = await removeExam(ctx, live.supersedes_exam_num);
    if (!removal.ok) {
      return {
        ...refuse(
          502,
          'OD_DELETE_UNCONFIRMED',
          `Exam ${live.supersedes_exam_num} was not removed: ${removal.error}. Nothing here changed.`
        ),
        attempted: ctx.attempted,
      };
    }
    await store.markSupersededDeleted(pool, { office, sendId: live.send_id });
    return { ok: true, attempted: ctx.attempted, examNum: live.supersedes_exam_num, actor };
  } finally {
    await store.releaseStep(pool, { office, sendId: live.send_id, token });
  }
}

/**
 * May a Failed perio chart go back to Staged? Only when its last send left
 * nothing unaccounted for in Open Dental: refused (nothing created), deleted,
 * or incomplete with no exam this send could name (a person has to look).
 */
async function canRestage(pool, { office, visit }) {
  const { send } = await readSend(pool, { office, visit });
  if (!send) return true;
  if (send.state === 'refused' || send.state === 'deleted') return true;
  return send.state === 'incomplete' && send.exam_num === null;
}

module.exports = {
  startPerioSend,
  stepPerioSend,
  deletePerioExamForSend,
  beginAmendment,
  cancelAmendment,
  removeReplacedExam,
  readSend,
  sendChart,
  sendView,
  writtenRefFor,
  canRestage,
  provNumFor,
  leaseMs,
};

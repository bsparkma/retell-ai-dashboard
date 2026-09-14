'use strict';

/**
 * The perio send — resumable, confirmed, and impossible to half-lie about
 * (H4 slice 11).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY IT IS SHAPED LIKE THIS
 * ═════════════════════════════════════════════════════════════════════════════
 * One `POST /perioexams`, then one `POST /periomeasures` per (tooth,
 * SequenceType). No bulk write, one request a second on a shared credential, so
 * a full chart is minutes. And a stray Probing row is PERMANENT. So:
 *
 *   1. The chart is confirmed ONCE, against the fingerprint of the staged
 *      preview, the exam date and the provider — all re-derived here.
 *   2. The confirmation builds a QUEUE, one row per write (perioSendStore.js).
 *   3. The page drives it in STEPS — each a bounded batch inside an ordinary,
 *      authenticated, audited request, so every write is attributed to the
 *      person who approved it and none happens on a background thread nobody
 *      is watching.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * READ BEFORE WRITE, EVERY TIME — THE #152 LESSON
 * ═════════════════════════════════════════════════════════════════════════════
 * A retry must never double-write. Every step begins by READING the exam's
 * measurements from Open Dental, and only a row that read shows ABSENT may be
 * posted:
 *
 *   present, same values      → confirmed. Not posted. (It landed last time.)
 *   present, different values → HALT. Never a second row beside it.
 *   absent, and we got an OK  → HALT. Accepted-but-missing is not guessed at.
 *   absent, never answered    → posted — but only once its claim has lapsed,
 *                               so an in-flight POST is never raced.
 *
 * The exam header is the same shape: the patient's exam numbers are recorded
 * just before it is posted, and a resumed send adopts the one exam that appeared
 * since, rather than posting a second header.
 *
 * And NOTHING is posted on a truncated read. A row absent from half a list is
 * not absent from the chart.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * A CHART NEVER CLAIMS WRITTEN UNTIL EVERY ROW IS READ BACK
 * ═════════════════════════════════════════════════════════════════════════════
 * The staged write moves to Written only when the exam header and every
 * measurement row are `confirmed`. A refused row halts the send with Open
 * Dental's exact words beside that site, and the staged write goes Failed.
 */

const contract = require('../../hyg/contract.gen.cjs');
const composer = require('./stagedWriteComposer');
const odPerio = require('./odPerio');
const odPerioWriter = require('./odPerioWriter');
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

/**
 * How long a claimed row is left alone. Longer than a write's 30s timeout plus
 * its read-back, so the POST a claim covers has answered or given up before
 * anybody else reads for it. Env-tunable for tests only.
 */
function leaseMs() {
  const n = Number(process.env.HYG_PERIO_SEND_LEASE_MS);
  return Number.isFinite(n) && n >= 0 ? n : 120000;
}

function refuse(status, code, error) {
  return { ok: false, status, code, error };
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

function isFresh(row, cutoff) {
  return row.state === 'sending' && row.claimed_at && new Date(row.claimed_at) >= cutoff;
}

function minted(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function label(row) {
  return row.target === 'exam' ? 'The exam header' : `#${row.tooth} ${row.sequence_type}`;
}

/** Open Dental's rows for one exam keyed by (tooth, SequenceType); the latest wins. */
function measureMap(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = `${Number(r.IntTooth)}:${String(r.SequenceType || '').trim()}`;
    const prev = map.get(key);
    if (!prev || Number(r.PerioMeasureNum) > Number(prev.PerioMeasureNum)) map.set(key, r);
  }
  return map;
}

function sameMeasure(odRow, body) {
  return odPerioWriter.MEASURE_VALUE_KEYS.every((k) => Number(odRow[k]) === Number(body[k]));
}

function describeValues(values) {
  return odPerioWriter.MEASURE_VALUE_KEYS.slice(1)
    .map((k) => `${k.replace('value', '')} ${Number(values[k])}`)
    .join(', ');
}

/** Exams that appeared since `prior`, with this send's date and provider. */
function newExams(exams, body, prior) {
  return exams.filter(
    (e) => !prior.has(e.examNum) && e.examDate === body.ExamDate && e.provNum === body.ProvNum
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Confirm a staged chart and plan its send. Writes NOTHING to Open Dental.
 *
 * @returns {Promise<{ ok: true } | { ok: false, status: number, code: string, error: string }>}
 */
async function startPerioSend({ pool, office, visit, appointment, request, actor }) {
  const staged = await visitStore.getStagedWrite(pool, { office, visitId: visit.visitId, kind: 'perio' });
  if (!staged) return refuse(409, 'NOT_STAGED', 'There is no staged perio chart on this visit.');
  if (staged.state === 'Sending' || staged.state === 'Failed') {
    return refuse(
      409,
      'PERIO_SEND_IN_PROGRESS',
      'This chart is already being sent. Resume it rather than starting it again.'
    );
  }
  if (staged.state !== 'Staged') {
    return refuse(
      409,
      'NOT_STAGED',
      staged.state === 'Written'
        ? 'This chart is already in Open Dental.'
        : 'The perio chart is a draft. Stage it, read it, then send it.'
    );
  }

  // THE PREVIEW IS THE WRITE. What she read, against what is stored.
  if (visitStore.fingerprintPreview(staged.preview) !== request.previewFingerprint) {
    return refuse(
      409,
      'PREVIEW_CHANGED',
      'The perio chart changed since you read it. Nothing was sent. Read it again and confirm ' +
        'the version on screen now.'
    );
  }

  const parsed = PAYLOAD_SCHEMA.safeParse(staged.payload);
  if (!parsed.success || parsed.data.patNum !== visit.patNum || parsed.data.aptNum !== visit.aptNum) {
    return refuse(
      409,
      'PAYLOAD_INVALID',
      'This chart was staged by a different version of CareIN or for a different visit. Stage it again.'
    );
  }
  const chart = contract.normalizePerioChart(parsed.data.chart);

  // …and against what is ABOUT TO BE WRITTEN. The preview recomposed from the
  // chart the queue is built from must be the preview she confirmed, so a
  // payload that drifted from its own preview cannot ride a valid fingerprint.
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
      'This appointment has no provider in Open Dental. An exam sent without one is filed under ' +
        "the patient's primary provider instead of whoever charted it, so nothing was sent."
    );
  }
  if (provNum !== request.provNum) {
    return refuse(
      409,
      'PROVIDER_CHANGED',
      `The appointment's provider is now ${provNum}, not the ${request.provNum} you confirmed. Nothing was sent.`
    );
  }

  const plan = contract.perioMeasureRows(chart);
  if (plan.length === 0) {
    return refuse(422, 'NOTHING_TO_SEND', 'This chart holds no readings to write.');
  }

  // A queue nothing was attempted from is rebuilt; one with a single attempted
  // row is a record of something that may be in a chart, and is refused.
  await store.discardUnattempted(pool, { office, stagedWriteId: staged.staged_write_id });
  const leftover = await store.getRows(pool, { office, stagedWriteId: staged.staged_write_id });
  if (leftover.length > 0) {
    return refuse(
      409,
      'PERIO_SEND_IN_PROGRESS',
      'Part of this chart was already attempted. Resume that send rather than starting a new one.'
    );
  }

  await store.createQueue(pool, {
    office,
    visitId: visit.visitId,
    stagedWriteId: staged.staged_write_id,
    examBody: { PatNum: visit.patNum, ExamDate: request.examDate, ProvNum: provNum },
    measures: plan,
    actor,
  });
  const claimed = await store.markPerioSending(pool, { office, visitId: visit.visitId, from: 'Staged' });
  if (!claimed) {
    await store.discardUnattempted(pool, { office, stagedWriteId: staged.staged_write_id });
    return refuse(409, 'NOT_STAGED', 'Another send started this chart first.');
  }
  return { ok: true };
}

/**
 * Failed → Sending, with every failed row back to pending. The next step READS
 * before it posts any of them.
 */
async function resumePerioSend({ pool, office, visit }) {
  const staged = await visitStore.getStagedWrite(pool, { office, visitId: visit.visitId, kind: 'perio' });
  if (!staged) return refuse(409, 'NOT_STAGED', 'There is no perio chart on this visit.');
  if (staged.state === 'Sending') return { ok: true };
  if (staged.state !== 'Failed') {
    return refuse(409, 'NOT_STAGED', `This chart is ${String(staged.state).toLowerCase()}, not a stopped send.`);
  }
  const rows = await store.getRows(pool, { office, stagedWriteId: staged.staged_write_id });
  if (rows.length === 0) return refuse(409, 'NOT_STARTED', 'This chart was never confirmed for sending.');
  await store.resetFailed(pool, { office, stagedWriteId: staged.staged_write_id });
  const moved = await store.markPerioSending(pool, { office, visitId: visit.visitId, from: 'Failed' });
  if (!moved) return refuse(409, 'NOT_STAGED', 'Another tab resumed this send first.');
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step
// ─────────────────────────────────────────────────────────────────────────────

/** @returns {Promise<number|null>} the confirmed PerioExamNum, or null when this step stopped. */
async function settleExam(ctx, exam) {
  const { pool, office, od, odGet, outcome } = ctx;
  const body = exam.body;
  if (exam.state === 'failed') return null;
  if (isFresh(exam, ctx.cutoff)) {
    outcome.paused = 'The exam header is being written by another send right now.';
    return null;
  }

  const before = await odPerio.readExams(odGet, { patNum: body.PatNum });
  if (!before.ok) {
    outcome.paused = `Open Dental did not answer when asked for this patient's perio exams (${before.error}). Nothing was sent.`;
    return null;
  }

  const recorded = Array.isArray(exam.prior_exam_nums) ? new Set(exam.prior_exam_nums.map(Number)) : null;
  if (recorded && (exam.state === 'sending' || exam.state === 'sent')) {
    // ATTEMPTED BEFORE. Read, do not re-post.
    const mine = newExams(before.exams, body, recorded);
    if (mine.length === 1) {
      await ctx.confirm(exam, mine[0].examNum);
      return mine[0].examNum;
    }
    if (mine.length > 1) {
      await ctx.halt(exam, `The exam header: ${mine.length} new exams on ${body.ExamDate} for this provider appeared, and CareIN will not guess which is its own.`);
      return null;
    }
    if (exam.state === 'sent') {
      await ctx.halt(exam, 'The exam header: Open Dental accepted it but it is not among this patient\'s exams when read back.');
      return null;
    }
    // A lapsed claim whose POST never landed. Safe to write it now.
  }
  if (before.truncated) {
    outcome.paused = "Open Dental returned only part of this patient's exam list, so the header was not sent.";
    return null;
  }

  const claimed = await store.claimRow(pool, { office, sendRowId: exam.send_row_id, leaseCutoff: ctx.cutoff });
  if (!claimed) {
    outcome.paused = 'Another send claimed the exam header first.';
    return null;
  }
  const prior = before.exams.map((e) => e.examNum);
  await store.setPriorExamNums(pool, { office, sendRowId: exam.send_row_id, priorExamNums: prior });

  const res = await odPerioWriter.createPerioExam(od, {
    patNum: body.PatNum,
    examDate: body.ExamDate,
    provNum: body.ProvNum,
  });
  outcome.attempted.push({ target: 'exam', ok: res.ok });
  if (!res.ok) {
    if (res.refused) {
      await ctx.halt(exam, `The exam header: Open Dental refused it - ${res.error}`);
    } else {
      await store.markRow(pool, {
        office,
        sendRowId: exam.send_row_id,
        state: 'sending',
        errorMessage: `No answer from Open Dental (${res.error}). CareIN reads before it sends this again.`,
      });
      outcome.paused = 'Open Dental did not answer for the exam header. CareIN will check whether it landed before sending it again.';
    }
    return null;
  }
  await store.markRow(pool, { office, sendRowId: exam.send_row_id, state: 'sent', odRef: res.examNum });

  const after = await odPerio.readExams(odGet, { patNum: body.PatNum });
  if (!after.ok) {
    outcome.paused = 'The exam header was sent and has not been read back yet. The next step reads before it sends anything.';
    return null;
  }
  const appeared = newExams(after.exams, body, new Set(prior));
  if (appeared.length === 1) {
    await ctx.confirm(exam, appeared[0].examNum);
    return appeared[0].examNum;
  }
  await ctx.halt(
    exam,
    appeared.length > 1
      ? `The exam header: ${appeared.length} new exams appeared at once, and CareIN will not guess which is its own.`
      : "The exam header: Open Dental accepted it but it is not among this patient's exams when read back."
  );
  return null;
}

async function settleMeasures(ctx, examNum, measures) {
  const { pool, office, od, odGet, outcome } = ctx;
  const open = measures.filter((r) => r.state !== 'confirmed');
  if (open.length === 0) return;

  const read = await odPerio.readExamMeasures(odGet, { examNum });
  if (!read.ok) {
    outcome.paused = `Open Dental did not answer when asked for exam ${examNum}'s rows (${read.error}). Nothing was sent.`;
    return;
  }
  if (read.truncated) {
    outcome.paused = `Open Dental returned only part of exam ${examNum}, so nothing was sent: a row missing from half a list is not missing from the chart.`;
    return;
  }
  const present = measureMap(read.rows);

  const toPost = [];
  for (const row of open) {
    if (row.state === 'failed' || isFresh(row, ctx.cutoff)) continue;
    const hit = present.get(`${row.tooth}:${row.sequence_type}`);
    if (hit) {
      if (sameMeasure(hit, row.body) && minted(hit.PerioMeasureNum)) {
        // IT LANDED LAST TIME. Found by reading, not re-posted.
        await ctx.confirm(row, minted(hit.PerioMeasureNum));
        continue;
      }
      await ctx.halt(
        row,
        `${label(row)}: Open Dental already holds a different row for this tooth in exam ${examNum} ` +
          `(${describeValues(hit)}), so CareIN stopped rather than add a second. Probing rows cannot be ` +
          'deleted; correct it in Open Dental.'
      );
      return;
    }
    if (row.state === 'sent') {
      await ctx.halt(row, `${label(row)}: Open Dental accepted this row but it is not in exam ${examNum} when read back.`);
      return;
    }
    toPost.push(row);
  }

  const written = [];
  for (const row of toPost.slice(0, contract.PERIO_SEND_BATCH)) {
    const claimed = await store.claimRow(pool, { office, sendRowId: row.send_row_id, leaseCutoff: ctx.cutoff });
    if (!claimed) continue;
    const res = await odPerioWriter.createPerioMeasure(od, {
      examNum,
      tooth: row.tooth,
      sequenceType: row.sequence_type,
      values: row.body,
    });
    outcome.attempted.push({ target: 'measure', tooth: row.tooth, sequenceType: row.sequence_type, ok: res.ok });
    if (!res.ok) {
      if (res.refused) {
        await ctx.halt(row, `${label(row)}: Open Dental refused it - ${res.error}`);
      } else {
        await store.markRow(pool, {
          office,
          sendRowId: row.send_row_id,
          state: 'sending',
          errorMessage: `No answer from Open Dental (${res.error}). CareIN reads before it sends this again.`,
        });
        outcome.paused = `Open Dental did not answer for ${label(row)}. CareIN will check whether it landed before sending it again.`;
      }
      break;
    }
    await store.markRow(pool, { office, sendRowId: row.send_row_id, state: 'sent', odRef: res.measureNum });
    written.push(row);
  }
  if (written.length === 0) return;

  // READ-BACK. An OK is not the claim.
  const back = await odPerio.readExamMeasures(odGet, { examNum });
  if (!back.ok || back.truncated) {
    if (!outcome.paused && !ctx.halted) {
      outcome.paused = 'Rows were sent and not read back yet. The next step reads before it sends anything.';
    }
    return;
  }
  const landed = measureMap(back.rows);
  for (const row of written) {
    const hit = landed.get(`${row.tooth}:${row.sequence_type}`);
    if (hit && sameMeasure(hit, row.body) && minted(hit.PerioMeasureNum)) {
      await ctx.confirm(row, minted(hit.PerioMeasureNum));
      continue;
    }
    await ctx.halt(
      row,
      hit
        ? `${label(row)}: Open Dental holds different values than were sent (${describeValues(hit)}).`
        : `${label(row)}: Open Dental accepted this row but it is not in exam ${examNum} when read back.`
    );
  }
}

/**
 * One bounded step. Never throws for an Open Dental failure — a refusal halts,
 * no answer pauses. A throw (a database error) leaves every claimed row in
 * `sending`, which the next step reads for before posting.
 *
 * @returns {Promise<{ ok: true, attempted: object[], paused: string|null }
 *          | { ok: false, status: number, code: string, error: string }>}
 */
async function stepPerioSend({ pool, office, visit, od, odGet }) {
  const startedAt = Date.now();
  const staged = await visitStore.getStagedWrite(pool, { office, visitId: visit.visitId, kind: 'perio' });
  if (!staged) return refuse(409, 'NOT_STAGED', 'There is no perio chart on this visit.');
  if (staged.state !== 'Sending') return { ok: true, attempted: [], paused: null };

  const rows = await store.getRows(pool, { office, stagedWriteId: staged.staged_write_id });
  const exam = rows.find((r) => r.target === 'exam');
  if (!exam) return refuse(409, 'NOT_STARTED', 'This chart was never confirmed for sending.');

  const outcome = { attempted: [], paused: null };
  const ctx = {
    pool,
    office,
    od,
    odGet,
    outcome,
    cutoff: new Date(Date.now() - leaseMs()),
    halted: null,
    async halt(row, message) {
      await store.markRow(pool, { office, sendRowId: row.send_row_id, state: 'failed', errorMessage: message });
      if (!this.halted) this.halted = message;
    },
    async confirm(row, odRef) {
      await store.markRow(pool, { office, sendRowId: row.send_row_id, state: 'confirmed', odRef });
    },
  };

  const examNum = exam.state === 'confirmed' ? exam.od_ref : await settleExam(ctx, exam);
  if (examNum !== null && !ctx.halted && !outcome.paused) {
    await settleMeasures(ctx, examNum, rows.filter((r) => r.target === 'measure'));
  }

  const after = await store.getRows(pool, { office, stagedWriteId: staged.staged_write_id });
  const examAfter = after.find((r) => r.target === 'exam');
  const measures = after.filter((r) => r.target === 'measure');
  const confirmed = measures.filter((r) => r.state === 'confirmed').length;
  const failed = after.filter((r) => r.state === 'failed').length;

  if (ctx.halted) {
    await visitStore.markFailed(pool, { office, visitId: visit.visitId, kind: 'perio', error: ctx.halted });
  } else if (examAfter.state === 'confirmed' && confirmed === measures.length) {
    await visitStore.markWritten(pool, {
      office,
      visitId: visit.visitId,
      kind: 'perio',
      actor: examAfter.created_by,
      writtenRef: `Perio exam ${examAfter.od_ref}: ${measures.length} rows read back`,
    });
  }

  // Counts and milliseconds. Never a PatNum, never a reading.
  console.log(
    `[hygperio] office=${office} exam=${examAfter.od_ref ?? 'none'} rows=${measures.length} ` +
      `confirmed=${confirmed} failed=${failed} ms=${Date.now() - startedAt}`
  );
  return { ok: true, attempted: outcome.attempted, paused: outcome.paused };
}

// ─────────────────────────────────────────────────────────────────────────────
// What the screen reads
// ─────────────────────────────────────────────────────────────────────────────

const SURFACE_KEYS = ['MBvalue', 'Bvalue', 'DBvalue', 'MLvalue', 'Lvalue', 'DLvalue'];

function sitesOf(row) {
  if (row.target !== 'measure' || row.sequence_type !== 'Probing') return 0;
  return SURFACE_KEYS.filter((k) => Number(row.body && row.body[k]) >= 0).length;
}

function iso(value) {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

/** The queue as the contract's progress + rows. Pure. */
function sendView(stagedRow, rows) {
  if (!rows || rows.length === 0) return { progress: null, rows: [] };
  const exam = rows.find((r) => r.target === 'exam');
  const measures = rows.filter((r) => r.target === 'measure');
  const confirmedRows = measures.filter((r) => r.state === 'confirmed');
  const rowsRemaining = measures.length - confirmedRows.length;
  const done = Boolean(stagedRow && stagedRow.state === 'Written');
  const halted = Boolean(stagedRow && stagedRow.state === 'Failed');
  const requestsRemaining = done
    ? 0
    : contract.estimatePerioSendRequests({ examConfirmed: exam.state === 'confirmed', rowsRemaining });
  return {
    progress: {
      examNum: exam.od_ref,
      examDate: String(exam.body.ExamDate),
      provNum: Number(exam.body.ProvNum),
      rowsTotal: measures.length,
      rowsConfirmed: confirmedRows.length,
      rowsFailed: rows.filter((r) => r.state === 'failed').length,
      rowsRemaining,
      sitesTotal: measures.reduce((n, r) => n + sitesOf(r), 0),
      sitesConfirmed: confirmedRows.reduce((n, r) => n + sitesOf(r), 0),
      requestsRemaining,
      secondsRemaining: requestsRemaining * contract.OD_SECONDS_PER_REQUEST,
      done,
      halted,
      haltMessage: halted ? stagedRow.error_message ?? null : null,
      startedBy: exam.created_by ?? null,
      startedAt: iso(exam.created_at),
    },
    rows: rows.map((r) => ({
      seq: r.seq,
      target: r.target,
      tooth: r.tooth,
      sequenceType: r.sequence_type,
      state: r.state,
      odRef: r.od_ref,
      errorMessage: r.error_message ?? null,
      sites: sitesOf(r),
    })),
  };
}

module.exports = {
  startPerioSend,
  resumePerioSend,
  stepPerioSend,
  sendView,
  provNumFor,
  measureMap,
  sameMeasure,
  leaseMs,
};

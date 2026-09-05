'use strict';

/**
 * The send. Everything before this staged; this puts it in a chart.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * REVIEW-THEN-SEND, RE-VALIDATED SERVER-SIDE
 * ═════════════════════════════════════════════════════════════════════════════
 * No automatic write, ever. A human confirms, and at the moment of the write
 * this module RE-VALIDATES the whole payload and records the approving user.
 * The client's confirmation is not evidence — that is RCM audit finding F3, and
 * the whole shape of this file is the answer to it.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE PREVIEW IS THE WRITE
 * ═════════════════════════════════════════════════════════════════════════════
 * The confirm request names, per kind, the FINGERPRINT of the preview the
 * hygienist read. This module recomputes it from the stored row and refuses the
 * WHOLE send on any mismatch, BEFORE anything is written. If the payload could
 * change between the preview and the send, that is the bug — so the check
 * happens first, and it fails the batch rather than the item, because a send
 * that half-honours a stale preview is worse than one that does not start.
 *
 * The PDF is a pure function of the preview lines (services/hyg/slipPdf.js is
 * deterministic and stamps no timestamp), so this holds for the bytes too and
 * not only for the text.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * PARTIAL SUCCESS IS THE NORMAL CASE
 * ═════════════════════════════════════════════════════════════════════════════
 * The note can land and the slip fail. **A visit is never "sent" — its
 * individual writes are.** Each has its own state, its own reason when it
 * failed, and its own reference when it landed. Nothing here aggregates them
 * into a verdict; the route returns counts and the screen shows every row.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * NEVER CLAIM SUCCESS BEFORE READ-BACK
 * ═════════════════════════════════════════════════════════════════════════════
 * `Sending` is persisted BEFORE the call — so a process that dies mid-write
 * leaves "we tried and do not know", not "ready to send". `Written` is reached
 * only after `services/hyg/odWriter.js` has read the thing back out of Open
 * Dental (or TC has returned a case id). A failed send never looks sent.
 */

const contract = require('../../hyg/contract.gen.cjs');
const odWriter = require('./odWriter');
const slipPdf = require('./slipPdf');
const tcHandoff = require('./tcHandoffClient');
const visitStore = require('./visitStore');

/**
 * The order writes are attempted in, and it is not arbitrary.
 *
 * The NOTE first: it is the record that the visit happened, it is the cheapest
 * to write, and it is the one whose absence is hardest to notice later. The
 * SLIP second. The TC HANDOFF last, because it is the only one that creates
 * work for another person — if the first two are failing today, the treatment
 * coordinator is better off not receiving a case about a visit whose chart note
 * is missing.
 */
const SEND_ORDER = Object.freeze(['note', 'router', 'tc-handoff']);

/**
 * What a payload must look like before it is allowed near a chart.
 *
 * The payload was composed server-side at stage time and stored as jsonb, so
 * these schemas are guarding against a row that predates a change or was
 * touched outside this app — not against a client, which never sees it. A
 * payload that does not parse is a REFUSAL, never a partial write.
 */
const PAYLOAD_SCHEMAS = {
  note: contract.z
    .object({
      kind: contract.z.literal('note'),
      aptNum: contract.z.number().int().positive(),
      patNum: contract.z.number().int().positive(),
      isSigned: contract.z.literal(false),
      nameBlock: contract.z.string().min(1),
      text: contract.z.string().min(1).max(60000),
    })
    .strict(),
  router: contract.z
    .object({
      kind: contract.z.literal('router'),
      aptNum: contract.z.number().int().positive(),
      patNum: contract.z.number().int().positive(),
      lines: contract.z.array(contract.z.string()).min(1),
    })
    .strict(),
  'tc-handoff': contract.z
    .object({
      kind: contract.z.literal('tc-handoff'),
      aptNum: contract.z.number().int().positive(),
      patNum: contract.z.number().int().positive(),
      category: contract.HandoffCategorySchema,
      items: contract.z.array(contract.z.record(contract.z.string(), contract.z.unknown())).min(1),
    })
    .strict(),
};

/**
 * Check every confirmation against the stored rows, BEFORE any write.
 *
 * Returns the rows to send, in SEND_ORDER, or the refusal that stops the batch.
 *
 * @returns {{ ok: true, rows: object[] } | { ok: false, code: string, error: string }}
 */
function checkConfirmations(stagedRows, confirmations) {
  const byKind = new Map(stagedRows.map((r) => [r.kind, r]));
  /** @type {object[]} */
  const rows = [];

  for (const confirmation of confirmations) {
    const row = byKind.get(confirmation.kind);
    if (!row) {
      return {
        ok: false,
        code: 'NOT_STAGED',
        error: `Nothing of kind '${confirmation.kind}' is staged on this visit`,
      };
    }
    if (row.state !== 'Staged') {
      return {
        ok: false,
        code: 'NOT_STAGED',
        error:
          `The ${confirmation.kind} write is ${String(row.state).toLowerCase()}, not staged. ` +
          'A write that has already been attempted keeps its own record.',
      };
    }
    const actual = visitStore.fingerprintPreview(row.preview);
    if (actual !== confirmation.previewFingerprint) {
      // The whole batch, not this item. What was read is not what is stored, so
      // nothing on this visit can be trusted to be what was approved.
      return {
        ok: false,
        code: 'PREVIEW_CHANGED',
        error:
          `The ${confirmation.kind} write changed since you read it. Nothing was sent. ` +
          'Read it again and confirm the version on screen now.',
      };
    }
    rows.push(row);
  }

  return {
    ok: true,
    rows: rows.sort((a, b) => SEND_ORDER.indexOf(a.kind) - SEND_ORDER.indexOf(b.kind)),
  };
}

/**
 * Send one staged write. Never throws; returns the outcome to record.
 *
 * @returns {Promise<{ ok: true, writtenRef: string } | { ok: false, code: string, error: string }>}
 */
async function sendOne(row, ctx) {
  const parsed = PAYLOAD_SCHEMAS[row.kind].safeParse(row.payload);
  if (!parsed.success) {
    // Re-validation at the moment of the write, not at stage time. A row this
    // build cannot read is refused rather than partially interpreted.
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      code: 'PAYLOAD_INVALID',
      error:
        'This write was staged by a different version of CareIN and cannot be read now ' +
        `(${issue ? issue.path.join('.') || 'body' : 'body'}). Stage it again.`,
    };
  }
  const payload = parsed.data;

  // The payload's own PatNum must be the visit's. Two different answers to
  // "whose chart" is the one disagreement that must never be resolved by
  // picking one.
  if (payload.patNum !== ctx.visit.patNum || payload.aptNum !== ctx.visit.aptNum) {
    return {
      ok: false,
      code: 'PAYLOAD_MISMATCH',
      error: 'This write names a different appointment than the visit it is on',
    };
  }

  if (row.kind === 'note') return sendNote(payload, ctx);
  if (row.kind === 'router') return sendSlip(row, payload, ctx);
  return sendHandoff(ctx);
}

/** The visit note → POST /procedurelogs/GroupNote, unsigned. */
async function sendNote(payload, ctx) {
  const procedures = await odWriter.readAppointmentProcedures(ctx.odGet, ctx.visit.aptNum);
  if (!procedures.ok) return procedures;

  if (procedures.procNums.length === 0) {
    // HONEST. A GroupNote attaches to procedures; this appointment has none.
    // Creating one so the note has somewhere to live would be this module
    // inventing clinical data to satisfy its own workflow.
    return {
      ok: false,
      code: 'NO_PROCEDURES',
      error:
        'This appointment has no procedures in Open Dental, so there is nothing for a visit ' +
        'note to attach to. Add the procedures in Open Dental and send the note again.',
    };
  }

  const written = await odWriter.writeGroupNote(ctx.od, ctx.odGet, {
    aptNum: ctx.visit.aptNum,
    procNums: procedures.procNums,
    note: payload.text,
    provNum: ctx.appointment.provHyg ?? ctx.appointment.provNum ?? null,
  });
  if (!written.ok) return written;
  return {
    ok: true,
    writtenRef: `GroupNote on ${written.procNums.length} procedure${
      written.procNums.length === 1 ? '' : 's'
    } (${written.procNums.join(', ')})`,
  };
}

/** The routing slip → a deterministic PDF into the patient's images. */
async function sendSlip(row, payload, ctx) {
  const category = await odWriter.resolveSlipDocCategory(ctx.odGet, ctx.office);
  if (!category.ok) return category;

  // The PDF is built from the SAME lines the preview showed, by a deterministic
  // renderer with no timestamp in it. That is what makes "the preview is the
  // write" true of the bytes and not only of the text.
  const pdf = slipPdf.renderSlipPdf({
    title: row.title,
    subtitle: `${ctx.officeName} — ${ctx.visit.visitDate || ctx.date}`,
    lines: payload.lines,
  });

  const uploaded = await odWriter.uploadDocument(ctx.od, {
    patNum: ctx.visit.patNum,
    docCategory: category.defNum,
    description: `${row.title} — ${ctx.visit.visitDate || ctx.date}`,
    rawBase64: pdf.toString('base64'),
  });
  if (!uploaded.ok) return uploaded;
  return { ok: true, writtenRef: `Document ${uploaded.docNum} in ${category.name}` };
}

/** The treatment → TC's own hygiene-intake contract. */
async function sendHandoff(ctx) {
  const built = tcHandoff.buildIntake({
    visit: ctx.visit,
    appointment: ctx.appointment,
    handoffCategory: contract.deriveCategory(ctx.visit.items),
    date: ctx.visit.visitDate || ctx.date,
  });
  if (!built.ok) return built;

  const sent = await ctx.submitHygieneIntake(ctx.req, { office: ctx.office, body: built.body });
  if (!sent.ok) return sent;
  return { ok: true, writtenRef: `Case ${sent.caseId}` };
}

/**
 * Send the confirmed writes on one visit.
 *
 * @param {object} deps injected so tests drive the real orchestration without a
 *   network: `{ pool, od, odGet, submitHygieneIntake }`.
 * @returns {Promise<{ ok: true, outcomes: object[] } | { ok: false, status: number, code: string, error: string }>}
 */
async function sendVisit({
  req,
  pool,
  office,
  officeName,
  date,
  visit,
  appointment,
  od,
  odGet,
  actor,
  confirmations,
  submitHygieneIntake = tcHandoff.submitHygieneIntake,
}) {
  const stagedRows = [];
  for (const kind of SEND_ORDER) {
    const row = await visitStore.getStagedWrite(pool, { office, visitId: visit.visitId, kind });
    if (row) stagedRows.push(row);
  }

  const checked = checkConfirmations(stagedRows, confirmations);
  if (!checked.ok) {
    return {
      ok: false,
      status: checked.code === 'PREVIEW_CHANGED' ? 409 : 409,
      code: checked.code,
      error: checked.error,
    };
  }
  if (checked.rows.length === 0) {
    return { ok: false, status: 422, code: 'NOTHING_TO_SEND', error: 'Nothing is staged to send' };
  }

  const ctx = {
    req,
    office,
    officeName,
    date,
    visit,
    appointment,
    od,
    odGet,
    submitHygieneIntake,
  };

  /** @type {object[]} */
  const outcomes = [];
  for (const row of checked.rows) {
    // PERSISTED BEFORE THE CALL. See the header.
    const claimed = await visitStore.markSending(pool, {
      office,
      visitId: visit.visitId,
      kind: row.kind,
    });
    if (!claimed) {
      // Somebody else moved it between the check and here. Not an error — the
      // honest report is that this one was not ours to send.
      outcomes.push({
        kind: row.kind,
        state: 'Staged',
        writtenRef: null,
        errorMessage: 'Another send is already handling this write',
        code: 'NOT_STAGED',
      });
      continue;
    }

    let result;
    try {
      result = await sendOne(row, ctx);
    } catch (err) {
      // A throw is a failure like any other: the row must not be left Sending.
      result = {
        ok: false,
        code: 'SEND_THREW',
        error: (err && err.message) || String(err),
      };
    }

    if (result.ok) {
      await visitStore.markWritten(pool, {
        office,
        visitId: visit.visitId,
        kind: row.kind,
        actor,
        writtenRef: result.writtenRef,
      });
      outcomes.push({
        kind: row.kind,
        state: 'Written',
        writtenRef: result.writtenRef,
        errorMessage: null,
        code: null,
      });
    } else {
      await visitStore.markFailed(pool, {
        office,
        visitId: visit.visitId,
        kind: row.kind,
        error: result.error,
      });
      outcomes.push({
        kind: row.kind,
        state: 'Failed',
        writtenRef: null,
        errorMessage: result.error,
        code: result.code,
      });
    }
  }

  return { ok: true, outcomes };
}

module.exports = { sendVisit, checkConfirmations, SEND_ORDER, PAYLOAD_SCHEMAS };

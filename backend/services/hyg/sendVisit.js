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
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE PERIO CHART RIDES ALONG — AND IS STILL SENT BY ITS OWN MACHINERY (item 15)
 * ═════════════════════════════════════════════════════════════════════════════
 * A staged perio chart is one more unit here, with its own state, reason and
 * reference like the others. It is NOT one more writer: this file never touches
 * a perio endpoint. It calls `services/hyg/perioSend.js` — the confirm, and then
 * the first bounded step — which is the one path a chart takes to Open Dental,
 * with the arch-string plan, the read-back of every site and the undo. The rest
 * of the steps are the page's to ask for, through the chart's own step route,
 * exactly as they are when the send starts on the chart page.
 *
 * The perio CONFIRM runs before anything is written by any unit. It writes
 * nothing to Open Dental, and every refusal it can give — the fingerprint, the
 * exam date, the provider, a send already in flight — refuses the WHOLE batch,
 * the same as a stale preview does for the other kinds. A correction to a chart
 * already in Open Dental is refused here: it is sent from the chart page, which
 * shows what it changes.
 */

const contract = require('../../hyg/contract.gen.cjs');
const odWriter = require('./odWriter');
const perioSend = require('./perioSend');
const slipPdf = require('./slipPdf');
const tcHandoff = require('./tcHandoffClient');
const visitStore = require('./visitStore');
const { refuseUnlessTestPatient } = require('../../config/hygFixtureGate');

/**
 * The order writes are attempted in, and it is not arbitrary.
 *
 * The NOTE first: it is the record that the visit happened, it is the cheapest
 * to write, and it is the one whose absence is hardest to notice later. The
 * SLIP second. The TC HANDOFF third, because it is the only one that creates
 * work for another person — if the first two are failing today, the treatment
 * coordinator is better off not receiving a case about a visit whose chart note
 * is missing.
 *
 * The PERIO CHART's writes go last (item 15). It is the longest by far — an exam
 * and then, where the arch strings cannot say it, a row at a time, every site
 * read back — and appending it leaves the three units above exactly where they
 * were. Its CONFIRM does not wait for last: see the header.
 */
const SEND_ORDER = Object.freeze(['note', 'router', 'tc-handoff', 'perio']);

/** The kinds this file writes itself. Perio is written by perioSend.js. */
const DIRECT_KINDS = Object.freeze(['note', 'router', 'tc-handoff']);

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
      /**
       * WHICH auto-note template composed this, or null for the generic note.
       *
       * `.optional()` because a row staged before slice 8 has no such key and a
       * strict schema would turn it into a refusal to send a note somebody has
       * already read and approved. `.nullable()` because "no template" is a
       * real answer. Inert to the write itself — `odWriter` sends `text` — so
       * it is provenance, and it is validated rather than merely tolerated.
       */
      visitType: contract.VisitTypeSchema.nullable().optional(),
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

  // A perio confirmation is checked here like every other kind — staged, and the
  // fingerprint of what she read — and then again, in full, by perioSend's own
  // confirm before anything is written (see sendVisit below).
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
  if (row.kind === 'tc-handoff') return sendHandoff(ctx);
  // Unreachable: perio never comes through here. Said anyway, rather than
  // letting an unknown kind fall into somebody else's writer.
  return { ok: false, code: 'PAYLOAD_INVALID', error: `No writer here for '${row.kind}'` };
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
    // REQUIRED by Open Dental, and it comes from the VISIT — which took it from
    // Open Dental's own answer for the appointment, never from a request body.
    patNum: ctx.visit.patNum,
    procNums: procedures.procNums,
    note: payload.text,
    provNum: ctx.appointment.provHyg ?? ctx.appointment.provNum ?? null,
  });
  if (!written.ok) return written;
  return { ok: true, writtenRef: groupNoteRef(written) };
}

/**
 * Where the note is, in the words of the system that holds it.
 *
 * `groupProcNum` is the `~GRP~` row Open Dental minted, when the read-back
 * surface gave one — the strongest form this reference takes, because it is a
 * number the chart can be searched by rather than an echo of what we sent.
 *
 * `alreadyPresent` is said out loud. A row that reads Written because CareIN
 * found the note already on the chart is not the same event as a row that
 * reads Written because CareIN just filed it, and a reference that blurred the
 * two would quietly turn "we did not write twice" into "we wrote twice".
 *
 * @param {{ procNums: number[], groupProcNum: number | null, alreadyPresent: boolean }} written
 * @returns {string}
 */
function groupNoteRef(written) {
  const count = written.procNums.length;
  const on = `on ${count} procedure${count === 1 ? '' : 's'} (${written.procNums.join(', ')})`;
  const head = written.groupProcNum ? `GroupNote ${written.groupProcNum} ${on}` : `GroupNote ${on}`;
  return written.alreadyPresent ? `${head} — already on the chart` : head;
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
  /*
   * ITEM 20: THE TEST-PATIENT RAIL, BEFORE ANYTHING ELSE. With the gate on
   * (config/hygFixtureGate.js), a patient who is not a designated test patient
   * is refused for the WHOLE send — note, slip, TC handoff and perio alike —
   * with every unit left exactly as it was: Staged, not Failed, because nothing
   * was attempted.
   */
  const gated = refuseUnlessTestPatient({ office, patNum: visit.patNum });
  if (gated) return gated;

  const stagedRows = [];
  for (const kind of SEND_ORDER) {
    const row = await visitStore.getStagedWrite(pool, { office, visitId: visit.visitId, kind });
    if (row) stagedRows.push(row);
  }

  const checked = checkConfirmations(stagedRows, confirmations);
  if (!checked.ok) {
    return { ok: false, status: 409, code: checked.code, error: checked.error };
  }
  if (checked.rows.length === 0) {
    return { ok: false, status: 422, code: 'NOTHING_TO_SEND', error: 'Nothing is staged to send' };
  }

  /*
   * THE PERIO CONFIRM, BEFORE ANY UNIT WRITES ANYTHING.
   *
   * perioSend.startPerioSend re-derives the fingerprint, the exam date and the
   * provider, refuses a chart already mid-send or with an incomplete exam still
   * in Open Dental, freezes the plan onto a recorded send, and claims the row.
   * It writes NOTHING to Open Dental, so a refusal here refuses the whole batch
   * with nothing written by any unit — the same promise a stale note preview
   * keeps. Once it has said yes, the chart is `Sending` and no second send, from
   * this page or the chart's, can start it again.
   */
  const perioConfirmation = confirmations.find((c) => c.kind === 'perio') || null;
  let perioStarted = false;
  if (perioConfirmation) {
    const { live } = await perioSend.readSend(pool, { office, visit });
    if (live) {
      // A CORRECTION stays on the chart page, which shows every site it changes
      // and what it replaces. The visit's dialog shows neither.
      return {
        ok: false,
        status: 422,
        code: 'PERIO_SENDS_FROM_ITS_CHART',
        error:
          `This perio chart is a correction to exam ${live.exam_num}, and a correction is sent from ` +
          'the chart page, where it shows what changes. Nothing was sent.',
      };
    }
    const started = await perioSend.startPerioSend({
      pool,
      office,
      visit,
      appointment,
      request: {
        previewFingerprint: perioConfirmation.previewFingerprint,
        examDate: perioConfirmation.examDate,
        provNum: perioConfirmation.provNum,
      },
      actor,
      odGet,
    });
    if (!started.ok) {
      return { ok: false, status: started.status, code: started.code, error: started.error };
    }
    perioStarted = true;
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
  for (const row of checked.rows.filter((r) => DIRECT_KINDS.includes(r.kind))) {
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

  if (!perioStarted) return { ok: true, outcomes, perio: null };
  const perio = await sendPerioFirstStep({ pool, office, visit, od, odGet });
  outcomes.push(perio.outcome);
  return { ok: true, outcomes, perio: { attempted: perio.attempted, amend: perio.amend } };
}

/**
 * The perio chart's FIRST STEP, run by perioSend.js — and its outcome, read
 * from the row that step left behind rather than inferred from what it returned.
 *
 * A full chart the arch strings can say goes in one step: the exam, then every
 * site read back. Anything longer carries on in the page's own requests to the
 * chart's step route, which is how the chart page runs a send too.
 *
 * Never throws. A step that throws has not written anything this module can
 * see — every write is recorded before it is attempted — so the chart stays
 * `Sending` and the next step reads Open Dental before it writes anything.
 *
 * @returns {Promise<{ outcome: object, attempted: object[], amend: object|null }>}
 */
async function sendPerioFirstStep({ pool, office, visit, od, odGet }) {
  let paused = null;
  let attempted = [];
  let amend = null;
  try {
    const step = await perioSend.stepPerioSend({ pool, office, visit, od, odGet });
    if (step.ok) {
      paused = step.paused;
      attempted = step.attempted;
      amend = step.amend || null;
    } else {
      paused = step.error;
    }
  } catch (err) {
    paused =
      `The perio send stopped before Open Dental answered (${(err && err.message) || String(err)}). ` +
      'Nothing is lost: Retry reads Open Dental before it writes anything.';
  }

  const row = await visitStore.getStagedWrite(pool, { office, visitId: visit.visitId, kind: 'perio' });
  const state = row ? row.state : 'Sending';
  if (state === 'Written') {
    return {
      outcome: { kind: 'perio', state, writtenRef: row.written_ref, errorMessage: null, code: null },
      attempted,
      amend,
    };
  }
  if (state === 'Failed') {
    return {
      outcome: {
        kind: 'perio',
        state,
        writtenRef: null,
        errorMessage: row.error_message,
        code: 'PERIO_SEND_STOPPED',
      },
      attempted,
      amend,
    };
  }
  return {
    outcome: {
      kind: 'perio',
      state,
      writtenRef: null,
      errorMessage: paused,
      code: paused ? 'PERIO_PAUSED' : null,
    },
    attempted,
    amend,
  };
}

module.exports = { sendVisit, checkConfirmations, SEND_ORDER, PAYLOAD_SCHEMAS };

'use strict';

/**
 * Is the exam CareIN wrote still the exam Open Dental holds? (H4 item 14)
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE CLAIM THAT STOPS BEING TRUE
 * ═════════════════════════════════════════════════════════════════════════════
 * `Written` means every site was read back from Open Dental and matched — AT THE
 * MOMENT IT WAS READ BACK. CareIN then asserts it forever:
 *
 *     "Perio exam 2260: 192 sites read back and match"
 *
 * The Delete button sits on Open Dental's own perio chart screen. Press it, and
 * the sentence above is a false claim about a chart of record. That is worse than
 * the gap item 13 closed: item 13 was "I cannot correct a number", this is
 * "CareIN says something is in the chart when it is not".
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT ITEM 13 ALREADY BUILT, AND WHAT THIS ADDS
 * ═════════════════════════════════════════════════════════════════════════════
 * `perioSend.startPerioSend` already re-reads `/perioexams` and refuses
 * `AMEND_BASE_MISSING` / `AMEND_BASE_CHANGED` — but only when a correction is
 * SENT, and `AMEND_BASE_MISSING` is a dead end: the exam is gone, so there is
 * nothing to correct, and there was no way forward. This file moves the check to
 * when the chart is OPENED, and adds the way forward: the resend.
 *
 * Nothing here re-implements the comparison. `contract.perioChartChanges` is the
 * same diff the amendment uses, `hyg_perio_send.chart` is the same baseline, and
 * `odPerio.readPriorPerio` is the same read — see `checkDrift` for why it takes
 * that read's output instead of making its own.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THREE ANSWERS, AND ONE OF THEM MUST NOT OFFER A RESEND
 * ═════════════════════════════════════════════════════════════════════════════
 *   exam present, every site matches   → say nothing.        no resend
 *   exam NOT in /perioexams            → say it.             RESEND
 *   exam present, sites DIFFER         → say it, name them.  no resend
 *   Open Dental could not be read      → say nothing.        no resend
 *
 * "Every site" is every FAMILY a send writes — probing, flags, skips, and since
 * item 31 recession, furcation and mobility. A v2 value Open Dental holds that
 * CareIN cannot interpret is the fourth row, never the first: see `driftAnswer`.
 * ITEM 32: that one is not silent — it names the position on a quiet line, and
 * so it audits (`driftDiscloses`). A failed read stays silent and unaudited.
 *
 * The third row is the whole design. A reading that differs is A HUMAN WHO
 * CORRECTED THE CHART IN OPEN DENTAL. Resending there would create a duplicate
 * exam and bury a deliberate correction under CareIN's stale numbers. "It does
 * not match, so send it again" is the bug the table exists to prevent.
 *
 * The fourth row too. A failed read is not evidence the exam is missing — the
 * same doctrine as `NOTE_PRECHECK_UNAVAILABLE`. When CareIN cannot see, it says
 * nothing rather than something false in the other direction.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT IS DELIBERATELY NOT HERE
 * ═════════════════════════════════════════════════════════════════════════════
 * No polling, no timer, no background watcher, no notification. The check happens
 * when a person opens the chart, and nowhere else. No attempt to re-create the
 * old exam under its old number. No auto-resend under any condition.
 */

const contract = require('../../hyg/contract.gen.cjs');
const odPerio = require('./odPerio');
const perioSend = require('./perioSend');
const store = require('./perioSendStore');
const visitStore = require('./visitStore');
const { refuseUnlessTestPatient } = require('../../config/hygFixtureGate');

/** Nothing was compared, because there is no claim to check. */
const NOT_APPLICABLE = Object.freeze({ status: 'not_applicable' });

/** How many changed sites the screen is handed. A whole chart can differ at 192. */
const MAX_REPORTED_CHANGES = 24;

/**
 * ITEM 32: `unknown` because CareIN could not SEE — a failed or partial read, or
 * no baseline to compare against. Transient, and silent on screen (item 14).
 * Distinct from `uninterpretable`, where Open Dental was read and holds a value
 * somebody put there that CareIN cannot interpret.
 */
function unreadableOd(examNum) {
  return { status: 'unknown', reason: 'unreadable_od', examNum, positions: [] };
}

/**
 * Where, never what: `raw` is dropped here so the value CareIN cannot interpret
 * never reaches the screen as though it meant something. Capped like `changes`.
 */
function unreadablePositions(unreadable) {
  return unreadable
    .slice(0, MAX_REPORTED_CHANGES)
    .map((u) => ({ tooth: u.tooth, surface: u.surface, kind: u.kind }));
}

function refuse(status, code, error) {
  return { ok: false, status, code, error };
}

/**
 * Every exam this patient has on `examDate`, and whether CareIN wrote it.
 *
 * "Whether CareIN wrote it" is answered from the send rows of THIS visit's chart,
 * which is the only thing this module can honestly know. An exam CareIN wrote on
 * another visit of the same date reads as not-CareIN's, and that is the safe
 * direction: the list exists so a hygienist sees exams she might be duplicating,
 * and over-listing costs her a glance while under-listing costs a duplicate exam.
 *
 * @param {Array<{ examNum: number, examDate: string|null, provNum: number|null }>} exams
 * @param {string} examDate
 * @param {Set<number>} careinExamNums
 */
function sameDateExams(exams, examDate, careinExamNums) {
  return exams
    .filter((e) => e.examDate === examDate)
    .sort((a, b) => a.examNum - b.examNum)
    .map((e) => ({
      examNum: e.examNum,
      examDate: e.examDate,
      provNum: e.provNum,
      careinWrote: careinExamNums.has(e.examNum),
    }));
}

/**
 * What the drift check needs from OUR database, in one read: the staged-write
 * row, the send whose exam is supposed to be in Open Dental, and the exam numbers
 * CareIN's own sends created.
 *
 * Separate from `checkDrift` so the pure decision can be exercised without a
 * database, and so the route makes one call rather than three.
 *
 * @returns {Promise<{ staged: object|null, live: object|null, careinExamNums: Set<number> }>}
 */
async function readDriftContext(pool, { office, visit }) {
  const { staged, live } = await perioSend.readSend(pool, { office, visit });
  if (!staged) return { staged: null, live: null, careinExamNums: new Set() };
  const nums = await store.getSendExamNums(pool, { office, stagedWriteId: staged.staged_write_id });
  return { staged, live, careinExamNums: new Set(nums) };
}

/**
 * THE THREE-WAY ANSWER — computed from a read that has ALREADY HAPPENED.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * IT TAKES THE PRIOR READ'S OUTPUT INSTEAD OF READING FOR ITSELF
 * ═════════════════════════════════════════════════════════════════════════════
 * The perio page already reads Open Dental for the prior panel: one
 * `/perioexams?PatNum=` and one `/periomeasures?PerioExamNum=`. That first read
 * is exactly "which exams does this patient have", and on every ordinary open of
 * a chart CareIN wrote, the second is exactly "what does that exam hold" —
 * because CareIN's exam IS the newest one. So this function is handed both and
 * adds NO request in that case. It reaches Open Dental only when the live exam is
 * not the newest one, which means somebody charted a newer exam by hand.
 *
 * @param {object} args
 * @param {object|null} args.staged the visit's perio staged-write row
 * @param {object|null} args.live the send whose exam is in Open Dental
 * @param {{ ok: boolean, list: object[], error: string|null }} args.exams the list read
 * @param {{ examNum: number, chart: object }|null} args.latest the newest exam, read whole
 * @param {Function} args.odGet
 * @param {Set<number>} [args.careinExamNums] exams CareIN's sends of this chart created
 * @returns {Promise<{ drift: object, odReads: number }>}
 */
async function checkDrift({ staged, live, exams, latest, odGet, careinExamNums = new Set() }) {
  // Only a chart that CLAIMS to be in Open Dental has a claim to check. A
  // `Staged`, `Draft`, `Amending` or `Failed` chart claims nothing.
  if (!staged || staged.state !== 'Written' || !live || live.exam_num === null) {
    return { drift: NOT_APPLICABLE, odReads: 0 };
  }
  const examNum = live.exam_num;

  // A LIST THAT DID NOT COME BACK WHOLE PROVES NOTHING ABOUT PRESENCE. An exam
  // missing from half a list is not missing from the chart.
  if (!exams.ok) return { drift: unreadableOd(examNum), odReads: 0 };

  if (!exams.list.some((e) => e.examNum === examNum)) {
    return {
      drift: {
        status: 'missing',
        examNum,
        sameDateExams: sameDateExams(exams.list, String(live.exam_date), careinExamNums),
      },
      odReads: 0,
    };
  }

  /*
   * The exam is there. Does it still hold what CareIN wrote?
   *
   * Without a baseline there is nothing to compare. `chart` is only absent on a
   * send written by a build that predates item 13, and inventing a baseline from
   * Open Dental's own current readings would make every such chart "match" by
   * construction — a claim CareIN has not checked. `unknown` is the honest answer.
   */
  const baseline = perioSend.sendChart(live);
  if (!baseline) return { drift: unreadableOd(examNum), odReads: 0 };

  let odChart = latest && latest.examNum === examNum ? latest.chart : null;
  let unreadable = odChart ? latest.uninterpretable || [] : [];
  let odReads = 0;
  if (!odChart) {
    // The live exam is not the newest one — somebody charted a newer exam in Open
    // Dental. One extra read, and only here.
    const read = await odPerio.readExamMeasures(odGet, { examNum });
    odReads = read.odReads;
    if (!read.ok || read.truncated) return { drift: unreadableOd(examNum), odReads };
    ({ chart: odChart, uninterpretable: unreadable } = odPerio.chartFromMeasures(read.rows));
  }

  return { drift: driftAnswer({ examNum, baseline, odChart, unreadable }), odReads };
}

/**
 * `matches`, `changed` or `unknown`, from two charts and what could not be read.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ITEM 31: SILENCE IS EARNED ONLY WHEN EVERY COMPARED FAMILY MATCHED
 * ═════════════════════════════════════════════════════════════════════════════
 * Since item 31 the comparison covers recession, furcation and mobility as well
 * as probing. A v2 value Open Dental holds that CareIN cannot interpret
 * (`chartFromMeasures`' `uninterpretable`) sits in the chart as "nothing
 * charted", so the comparison at that position is not a comparison at all:
 *
 *   - A change reported AT an unreadable position would say "not charted", which
 *     is false — something IS charted there. Those lines are dropped.
 *   - Every other change is real and is reported: `changed`, naming them. One
 *     unreadable site does not hide a recession somebody plainly edited.
 *   - No reportable change, but something unreadable: `unknown`. NEVER `matches`
 *     — CareIN did not see that position agree, so it does not say it did.
 *     ITEM 32: with `reason: 'uninterpretable'` and the positions, so the screen
 *     can name them — unlike a failed read, this is durable and somebody's hand.
 *
 * Pure, so the three outcomes are tested without Open Dental.
 *
 * @param {{ examNum: number, baseline: object, odChart: object,
 *           unreadable: Array<{ tooth: number|null, surface: string|null, kind: string }> }} args
 */
function driftAnswer({ examNum, baseline, odChart, unreadable = [] }) {
  const blind = new Set(unreadable.map((u) => `${u.tooth}|${u.surface}|${u.kind}`));
  const changes = contract
    .perioChartChanges(baseline, odChart)
    .filter((c) => !blind.has(`${c.tooth}|${c.surface}|${c.kind}`));
  if (changes.length > 0) {
    return { status: 'changed', examNum, changes: changes.slice(0, MAX_REPORTED_CHANGES) };
  }
  if (unreadable.length > 0) {
    return { status: 'unknown', reason: 'uninterpretable', examNum, positions: unreadablePositions(unreadable) };
  }
  return { status: 'matches', examNum };
}

/**
 * ITEM 32: does this answer TELL HER something about the chart of record? Then
 * it is a disclosure and the route audits it, fail-closed.
 *
 *   missing, changed            → yes (item 14)
 *   unknown / uninterpretable   → yes: it names tooth, surface and family
 *   unknown / unreadable_od     → no: nothing is drawn, nothing is disclosed
 *   matches, not_applicable     → no
 */
function driftDiscloses(drift) {
  if (drift.status === 'missing' || drift.status === 'changed') return true;
  return drift.status === 'unknown' && drift.reason === 'uninterpretable';
}

/**
 * The audit row's `source_ref` for a disclosing drift answer.
 *
 * `perio_exam:7001` for `missing` and `changed`, exactly as item 14 wrote it.
 * For `uninterpretable`, the positions the screen named are appended:
 *
 *     perio_exam:7001;3-B:gm,30:mobility
 *
 * `tooth-surface` is the same form `hyg_perio_amend_site` uses, and the family
 * is the closed `kind` vocabulary. Identifiers only — the raw value never
 * reaches this function (`unreadablePositions` already dropped it).
 */
function driftAuditRef(drift) {
  const exam = `perio_exam:${drift.examNum}`;
  if (drift.status !== 'unknown' || drift.reason !== 'uninterpretable') return exam;
  const where = drift.positions.map(
    (p) => `${p.tooth === null ? 'x' : p.tooth}${p.surface ? '-' + p.surface : ''}:${p.kind}`
  );
  return `${exam};${where.join(',')}`;
}

/**
 * THE RESEND — the existing send path, re-armed. Writes NOTHING to Open Dental.
 *
 * It does two things and no more: it records that the exam this chart claimed is
 * gone, and it puts the chart back to `Staged`. The send itself then happens
 * through the ordinary `POST /perio/send` and its steps, from the page, with its
 * own confirmation — so the new exam is posted, filled and read back site by site
 * exactly as a first send is. It gets a NEW exam number; the old one is never
 * resurrected.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * IT RE-READS OPEN DENTAL BEFORE IT BELIEVES THE EXAM IS GONE
 * ═════════════════════════════════════════════════════════════════════════════
 * The drift check's answer came from the read made when the chart was opened,
 * which may be minutes old. Re-arming on a stale "missing" would arm a send that
 * creates a SECOND exam beside one that is still there. So the list is read again
 * here, and an exam that turns out to be present refuses.
 *
 * A read that FAILS refuses too. `PERIO_EXAM_PRESENT` and `OD_READ_FAILED` are
 * different sentences on purpose: one says the exam is there, the other says
 * CareIN cannot tell.
 *
 * @returns {Promise<{ ok: true, examNum: number }
 *          | { ok: false, status: number, code: string, error: string }>}
 */
async function resendVanishedChart({ pool, office, visit, odGet, request, actor }) {
  // Item 20: staging arms writes for the designated test patients only. The send
  // this re-arms will write to a chart, so the gate belongs here too.
  const gated = refuseUnlessTestPatient({ office, patNum: visit.patNum });
  if (gated) return gated;

  const { staged, send, live } = await perioSend.readSend(pool, { office, visit });
  if (!staged || !live || live.exam_num === null) {
    return refuse(409, 'NOT_RESENDABLE', 'This chart is not in Open Dental, so there is nothing to send again.');
  }
  if (send && ['posting', 'filling'].includes(send.state)) {
    return refuse(409, 'PERIO_SEND_IN_PROGRESS', 'This chart is being sent right now. Let it finish first.');
  }
  if (staged.state !== 'Written') {
    return refuse(
      409,
      'NOT_RESENDABLE',
      `This chart is ${String(staged.state).toLowerCase()}, not written, so there is no claim to put right.`
    );
  }
  // The exam number is repeated by the client, the same way the undo repeats it.
  if (live.exam_num !== request.examNum) {
    return refuse(
      409,
      'NOT_RESENDABLE',
      `Exam ${request.examNum} is not the exam this chart wrote (${live.exam_num}). Nothing changed.`
    );
  }

  if (typeof odGet !== 'function') {
    return refuse(500, 'OD_READ_FAILED', 'A chart cannot be sent again without reading Open Dental first.');
  }
  const exams = await odPerio.readExams(odGet, { patNum: visit.patNum });
  if (!exams.ok || exams.truncated) {
    return refuse(
      502,
      'OD_READ_FAILED',
      "Open Dental did not return this patient's perio exams, so nothing was changed. " +
        'CareIN will not send a chart again on the strength of a read it could not finish.'
    );
  }
  if (exams.exams.some((e) => e.examNum === live.exam_num)) {
    return refuse(
      409,
      'PERIO_EXAM_PRESENT',
      `Exam ${live.exam_num} IS in Open Dental. Sending this chart again would create a second exam ` +
        'for the same visit, so nothing was changed. Open the chart again to see what Open Dental holds now.'
    );
  }

  // Confirmed absent. Record it, then re-arm.
  const marked = await store.markExamGone(pool, { office, sendId: live.send_id, actor });
  if (!marked) {
    return refuse(409, 'NOT_RESENDABLE', 'This chart changed while it was being re-armed. Open it again.');
  }
  const restaged = await visitStore.restagePerioForResend(pool, { office, visitId: visit.visitId, actor });
  if (!restaged) {
    return refuse(409, 'NOT_RESENDABLE', 'This chart changed while it was being re-armed. Open it again.');
  }
  return { ok: true, examNum: live.exam_num };
}

module.exports = {
  readDriftContext,
  checkDrift,
  driftAnswer,
  driftDiscloses,
  driftAuditRef,
  resendVanishedChart,
  sameDateExams,
  unreadableOd,
  NOT_APPLICABLE,
  MAX_REPORTED_CHANGES,
};

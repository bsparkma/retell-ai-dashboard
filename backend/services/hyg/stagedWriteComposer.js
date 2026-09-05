'use strict';

/**
 * What a staged write WILL say — composed on the server, from stored data.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS SERVER-SIDE AND PURE
 * ═════════════════════════════════════════════════════════════════════════════
 * The prototype composed the preview in the browser and stored it in a Zustand
 * store: `stage({ title, summary, preview })`. Porting that shape reproduces
 * RCM audit finding F3 — "confirm gates client-side only; submit paths never
 * re-check and record NO user" — because a payload the client supplied is a
 * payload the client can change between the preview and the send.
 *
 * So the client's stage request carries ONE field, the kind. Everything a
 * hygienist then reads before confirming is built here, from the visit rows,
 * and stored on `hyg_staged_write`. Slice 3's rule — **the preview IS the
 * write** — is only expressible because of that: slice 3 sends `payload`, and
 * `payload` and `preview` were built together from the same snapshot in the
 * same call.
 *
 * Every function here is PURE: rows in, strings out. No database, no clock, no
 * `req`. That is what lets `stagedWriteComposer.test.js` state what a slip says
 * without booting anything.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE NOTE IS UNSIGNED, AND NOTHING HERE MAY SAY OTHERWISE
 * ═════════════════════════════════════════════════════════════════════════════
 * B1, locked: CareIN writes the visit note UNSIGNED with a typed name block.
 * Open Dental's own signature block is the only thing allowed to claim a
 * signature, and this app cannot produce one. The prototype's notes summary
 * said "Signed by" — that is a defect, not copy to lift.
 *
 * `NAME_BLOCK_PREFIX` below is the exact wording, in one place, and
 * `stagedWriteComposer.test.js` asserts that no composed line anywhere in this
 * module matches /\bsigned\b/i. A compliance claim is not a styling decision.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT IS NOT HERE
 * ═════════════════════════════════════════════════════════════════════════════
 * `perio` is a kind in the contract's vocabulary and composes to NOTHING in
 * slice 2. Perio charting is its own arc (H4) and carries its own contingency —
 * a stray Probing row is PERMANENT in Open Dental. Returning an empty preview
 * for it would be a screen offering to send something that does not exist, so
 * it refuses instead, and the route turns that into an honest 422.
 */

const contract = require('../../hyg/contract.gen.cjs');

/**
 * The typed name block that stands in for a signature, and is not one.
 * ONE definition — the note composer and its test read the same string.
 */
const NAME_BLOCK_PREFIX = 'Entered in CareIN by';

/** Human labels for the slip's chip ids, so a preview reads like the paper. */
const DONE_TODAY_LABELS = Object.fromEntries(
  contract.DONE_TODAY_OPTIONS.map((o) => [o.id, o.label])
);

/**
 * `#3, #14` — or "Whole mouth". Never an empty string: a treatment line whose
 * teeth silently vanished is a line somebody could act on wrongly.
 * @param {{ teeth: number[]|'mouth' }} item
 * @returns {string}
 */
function teethLabel(item) {
  if (item.teeth === 'mouth') return 'Whole mouth';
  if (!Array.isArray(item.teeth) || item.teeth.length === 0) return 'No teeth recorded';
  return item.teeth.map((t) => '#' + t).join(', ');
}

/**
 * One treatment item as one line of a slip.
 * @param {Record<string, any>} item
 * @returns {string}
 */
function itemLine(item) {
  const parts = [teethLabel(item), item.code];
  if (Array.isArray(item.surfaces) && item.surfaces.length > 0) {
    parts.push(item.surfaces.join(''));
  }
  parts.push(contract.TREATMENT_PRIORITY_LABELS[item.priority] || item.priority);
  parts.push(item.category);
  if (Array.isArray(item.dx) && item.dx.length > 0) {
    parts.push('Dx ' + item.dx.join(', '));
  }
  // The STATUS is on the line because "the doctor has confirmed this" and "the
  // hygienist proposed it" are different claims to put in front of a patient.
  parts.push(item.status);
  return parts.join(' · ');
}

/**
 * The slip's own lines — what was done, what was found, what happens next.
 * @param {{ slip: Record<string, any>, visitDate: string|null }} visit
 * @returns {string[]}
 */
function slipLines(visit) {
  const slip = visit.slip || {};
  const lines = [];

  const done = Array.isArray(slip.doneToday) ? slip.doneToday : [];
  if (done.length > 0) {
    lines.push('Done today: ' + done.map((id) => DONE_TODAY_LABELS[id] || id).join(', '));
  }
  if (slip.doneTodayNote) lines.push(slip.doneTodayNote);
  if (Array.isArray(slip.xrayTypes) && slip.xrayTypes.length > 0) {
    lines.push('X-rays: ' + slip.xrayTypes.join(', '));
  }
  if (slip.examStatus) {
    lines.push('Doctor exam: ' + (contract.EXAM_STATUS_LABELS[slip.examStatus] || slip.examStatus));
  }
  if (slip.perioStage) {
    const stage = contract.PERIO_STAGE_LABELS[slip.perioStage] || slip.perioStage;
    const grade = slip.perioGrade ? ` (Grade ${String(slip.perioGrade).toUpperCase()})` : '';
    lines.push('Perio classification: ' + stage + grade);
  }
  if (slip.patientConcerns) lines.push('Patient concerns: ' + slip.patientConcerns);
  if (slip.hygieneFindings) lines.push('Hygiene findings: ' + slip.hygieneFindings);

  const next = slip.nextVisit || {};
  const nextParts = [];
  if (next.type) nextParts.push(next.type);
  if (next.intervalMonths) nextParts.push(next.intervalMonths + ' months');
  if (next.lengthMin) nextParts.push(next.lengthMin + ' min');
  if (next.withDoctor) nextParts.push('with the doctor');
  if (nextParts.length > 0) lines.push('Next hygiene visit: ' + nextParts.join(', '));

  // The two reminder fields. They appear on the slip BECAUSE the front desk
  // reads it — which is precisely why they never gate a send: they describe
  // work somebody else does after the hygienist has finished.
  lines.push('Recare scheduled: ' + answerLabel(slip.recareScheduled));
  lines.push('Treatment entered in Open Dental: ' + answerLabel(slip.txEnteredInOd));

  if (slip.frontDeskNote) lines.push('For the front desk: ' + slip.frontDeskNote);
  if (slip.financialNote) lines.push('Financial: ' + slip.financialNote);
  if (Array.isArray(slip.productsDispensed) && slip.productsDispensed.length > 0) {
    lines.push('Products dispensed: ' + slip.productsDispensed.join(', '));
  }
  return lines;
}

/**
 * "Yes" / "No" / "not answered".
 *
 * A null prints as "not answered" rather than as "No". They are different
 * sentences, and the front desk acts on the difference.
 * @param {unknown} value
 * @returns {string}
 */
function answerLabel(value) {
  if (value === 'yes') return 'Yes';
  if (value === 'no') return 'No';
  return 'not answered';
}

/**
 * Every record the proposed treatments still NEED, with its recorded status.
 * @param {Record<string, any>[]} items
 * @param {Record<string, string>} recordsStatus
 * @returns {string[]}
 */
function recordsLines(items, recordsStatus) {
  const needed = contract.recordsNeededFor(items);
  if (needed.length === 0) return [];
  return [
    'Records for the planned treatment:',
    ...needed.map((record) => {
      const status = recordsStatus && recordsStatus[record];
      const label = status ? contract.RECORD_STATUS_LABELS[status] || status : 'Needed';
      return '  ' + record + ' — ' + label;
    }),
  ];
}

/**
 * Compose one staged write.
 *
 * @param {'router'|'perio'|'note'|'tc-handoff'} kind
 * @param {{ visit: Record<string, any>, items: Record<string, any>[], actor: string }} ctx
 * @returns {{ title: string, summary: string, preview: string[], payload: Record<string, unknown> }
 *          | { unavailable: string }
 *          | { empty: string }}
 *   `unavailable` — this kind is not built yet. `empty` — there is genuinely
 *   nothing to send, which is a refusal rather than an empty envelope.
 */
function compose(kind, { visit, items, actor }) {
  const slip = visit.slip || {};
  const dateLabel = visit.visitDate || 'today';

  if (kind === 'perio') {
    return {
      unavailable:
        'Perio charting is not built yet, so there is nothing to stage. A perio chart written ' +
        'into Open Dental cannot be deleted, so it gets its own slice rather than riding on this one.',
    };
  }

  if (kind === 'router') {
    const lines = [...slipLines(visit)];
    if (items.length > 0) {
      lines.push(`Treatment identified today (${items.length}):`);
      for (const item of items) lines.push('  ' + itemLine(item));
    }
    lines.push(...recordsLines(items, slip.recordsStatus || {}));
    return {
      title: 'Routing slip',
      summary:
        `The slip for ${dateLabel}` +
        (items.length > 0
          ? ` — ${items.length} treatment ${items.length === 1 ? 'item' : 'items'}`
          : ' — no treatment proposed'),
      preview: lines,
      // Slice 3 renders this to a PDF and files it in the patient's images.
      // Stored whole so the send needs nothing the preview did not show.
      payload: { kind: 'router', aptNum: visit.aptNum, patNum: visit.patNum, lines },
    };
  }

  if (kind === 'note') {
    const lines = [...slipLines(visit)];
    if (items.length > 0) {
      lines.push(`Treatment identified today (${items.length}):`);
      for (const item of items) lines.push('  ' + itemLine(item));
    }
    // THE NAME BLOCK, AND IT IS NOT A SIGNATURE. See the header.
    const nameBlock = `${NAME_BLOCK_PREFIX} ${actor}. Unsigned.`;
    lines.push(nameBlock);
    return {
      title: 'Visit note',
      summary: `An unsigned note for ${dateLabel}, with a typed name block`,
      preview: lines,
      payload: {
        kind: 'note',
        aptNum: visit.aptNum,
        patNum: visit.patNum,
        // Slice 3 posts this as a GroupNote with isSigned:false. The flag is in
        // the payload rather than left to the sender so the thing a hygienist
        // confirmed and the thing that goes to Open Dental carry the same fact.
        isSigned: false,
        nameBlock,
        text: lines.join('\n'),
      },
    };
  }

  if (kind === 'tc-handoff') {
    if (items.length === 0) {
      return {
        empty:
          'There is no treatment on this visit to hand off. An empty case in a treatment ' +
          "coordinator's queue is worse than no case.",
      };
    }
    // deriveCategory has already been given the answer, item by item. Asking a
    // hygienist to ALSO classify the visit is asking the same question twice
    // and accepting two answers.
    const category = contract.deriveCategory(items);
    const lines = [
      `Category: ${category}`,
      `Treatment (${items.length}):`,
      ...items.map((item) => '  ' + itemLine(item)),
    ];
    const motivations = [
      ...new Set(items.flatMap((i) => (Array.isArray(i.motivation) ? i.motivation : []))),
    ];
    if (motivations.length > 0) {
      lines.push(
        'Why the patient might say yes: ' +
          motivations.map((m) => contract.MOTIVATION_LABELS[m] || m).join(', ')
      );
    }
    lines.push(...recordsLines(items, slip.recordsStatus || {}));
    return {
      title: 'Treatment handoff',
      summary: `${items.length} ${items.length === 1 ? 'item' : 'items'} to the treatment coordinator (${category})`,
      preview: lines,
      payload: {
        kind: 'tc-handoff',
        aptNum: visit.aptNum,
        patNum: visit.patNum,
        category,
        items: items.map((item) => ({
          teeth: item.teeth,
          code: item.code,
          category: item.category,
          priority: item.priority,
          status: item.status,
          dx: item.dx,
          motivation: item.motivation,
          note: item.note ?? null,
        })),
      },
    };
  }

  // Unreachable while StagedWriteKindSchema has four members and the route
  // parses `kind` through it. Kept so a fifth kind fails loudly here rather
  // than staging an empty envelope.
  return { unavailable: `'${kind}' is not a staged write this version knows how to compose` };
}

module.exports = {
  compose,
  NAME_BLOCK_PREFIX,
  // Exported for tests and for the route's records/handoff summary.
  teethLabel,
  itemLine,
  slipLines,
  answerLabel,
};

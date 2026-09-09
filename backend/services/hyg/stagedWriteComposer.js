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
 * EVERY LINE IS OD-SAFE BEFORE IT IS FINGERPRINTED
 * ═════════════════════════════════════════════════════════════════════════════
 * `line()` runs every composed line through `utils/sanitizeForOd` — the same
 * function the voice module has used on commlog notes for months. Typographic
 * punctuation (`·`, `—`, smart quotes) becomes ASCII here, in the COMPOSER,
 * which is the only place it can go:
 *
 *   **the preview IS the write.** The fingerprint is taken over these lines and
 *   the note text is built from them. A writer that quietly rewrote the text
 *   after fingerprinting would break that guarantee from the inside — the
 *   hygienist would confirm one string and a different one would land.
 *
 * So the middot in "#30 · Crown · Urgent" is now a hyphen ON SCREEN as well as
 * in the chart, and those are the same bytes. `stagedWriteComposer.test.js`
 * asserts every composed line is inside the safe set.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE NOTE IS THE PRACTICE'S OWN AUTO NOTE (H1 slice 8)
 * ═════════════════════════════════════════════════════════════════════════════
 * When the slip carries a `visitType`, the `note` kind renders that visit
 * type's SOAP template from `shared/hyg/noteTemplates.ts` — the practice's own
 * Open Dental auto note, re-stated as data — and the treatment block and the
 * typed-name block ride along after it. That is the whole point of the slice:
 * filling in the visit IS writing the clinic note, so nobody documents twice.
 *
 * WHEN `visitType` IS NULL, THE OLD GENERIC NOTE IS WHAT COMPOSES. Not a
 * refusal, and not a guessed template: a hygienist who has not said which visit
 * this is still gets a note that says what she recorded. Choosing a template
 * for her would be choosing which sentences go in somebody's chart.
 *
 * The RENDERER is in the shared file rather than here for the same reason the
 * contract is shared: the form draws its chip rows from the same template that
 * prints them, so a row she can fill in and a row the note prints cannot drift
 * apart.
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
// THE PLATFORM'S OWN SANITIZER, not a second one. The voice module has run
// every commlog note through this for months (routes/unifiedCalls.js,
// services/openDentalSync.js); this module was the one Open Dental note path
// that did not, and the first real send came back "Invalid JSON".
const { sanitizeForOd } = require('../../utils/sanitizeForOd');

/**
 * The typed name block that stands in for a signature, and is not one.
 * ONE definition — the note composer and its test read the same string.
 */
const NAME_BLOCK_PREFIX = 'Entered in CareIN by';

/**
 * How lines are joined in the note text Open Dental receives.
 *
 * A bare LF, which is what the first real send used and what the preview shows.
 * Open Dental's own docs prefer CRLF in note fields and the probe script tests
 * both — until that has actually been run against staging, changing it would be
 * a guess, and a guess made at the same time as two real fixes is a guess
 * nobody could later attribute.
 */
const NOTE_NEWLINE = '\n';

/** Human labels for the slip's chip ids, so a preview reads like the paper. */
const DONE_TODAY_LABELS = Object.fromEntries(
  contract.DONE_TODAY_OPTIONS.map((o) => [o.id, o.label])
);

/**
 * One composed line, made safe for an Open Dental note field.
 *
 * The single choke point: every string that reaches a `preview` array goes
 * through here, so "the preview is ASCII" is a property of the composer rather
 * than of whoever remembered to call the sanitizer.
 *
 * @param {string} value
 * @returns {string}
 */
function line(value) {
  return sanitizeForOd(String(value));
}

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
 * The practice's own name for a visit type, for the summary line.
 * @param {string} visitType
 * @returns {string}
 */
function visitTypeLabel(visitType) {
  return contract.VISIT_TYPE_LABELS[visitType] || visitType;
}

/**
 * The SOAP note for this visit's type, rendered from the practice's template.
 *
 * Everything here is a straight read of the stored slip. The RENDERER lives in
 * the shared contract (`shared/hyg/noteTemplates.ts`) rather than in this file
 * because the FORM generates its chip rows from the same templates — one
 * definition, so a row she can fill in is a row the note prints.
 *
 * `recallMonths` is the slip's own next-visit interval and is NOT defaulted to
 * the template's hardcoded six. An interval nobody set is a sentence nobody
 * said.
 *
 * @param {{ slip: Record<string, any> }} visit
 * @returns {string[]}
 */
function noteTemplateLines(visit) {
  const slip = visit.slip || {};
  const next = slip.nextVisit || {};
  return contract.renderVisitNote({
    visitType: slip.visitType,
    fields: slip.noteFields || {},
    // The slip has ONE box for what the patient came in about, and the
    // templates call it the chief complaint. Two boxes asking the same question
    // and only one of them reaching the chart would be the worse design.
    chiefComplaint: typeof slip.patientConcerns === 'string' ? slip.patientConcerns : '',
    findings: typeof slip.hygieneFindings === 'string' ? slip.hygieneFindings : '',
    rtc: typeof slip.rtc === 'string' ? slip.rtc : '',
    doneToday: Array.isArray(slip.doneToday) ? slip.doneToday : [],
    xrayTypes: Array.isArray(slip.xrayTypes) ? slip.xrayTypes : [],
    productsDispensed: Array.isArray(slip.productsDispensed) ? slip.productsDispensed : [],
    recallMonths: typeof next.intervalMonths === 'number' ? next.intervalMonths : null,
    perioChartUpdated: slip.perioChartUpdated ?? null,
  });
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
function composeRaw(kind, { visit, items, actor, signature }) {
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
    // THE TEMPLATE, WHEN SHE HAS SAID WHICH ONE. A null visitType composes the
    // generic note this module wrote before templates existed — see the header.
    const lines = slip.visitType ? noteTemplateLines(visit) : [...slipLines(visit)];
    if (items.length > 0) {
      // A blank line first when a template ran, so the treatment block reads as
      // its own section rather than as one more graded row.
      if (slip.visitType) lines.push('');
      lines.push(`Treatment identified today (${items.length}):`);
      for (const item of items) lines.push('  ' + itemLine(item));
    }
    // THE TYPED-NAME BLOCK. Her name and licence and the office's supervising
    // doctors, from backend/config/hygStaff.js — never from a component, never
    // from another office, and never with a licence number we do not have.
    const block = Array.isArray(signature) ? signature.filter((l) => Boolean(l)) : [];
    if (block.length > 0) {
      lines.push('');
      for (const l of block) lines.push(l);
    }
    // AND IT IS NOT A SIGNATURE. See the header.
    const nameBlock = `${NAME_BLOCK_PREFIX} ${actor}. Unsigned.`;
    lines.push(nameBlock);
    return {
      title: 'Visit note',
      summary: slip.visitType
        ? `An unsigned ${visitTypeLabel(slip.visitType)} note for ${dateLabel}`
        : `An unsigned note for ${dateLabel}, with a typed name block`,
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
        // WHICH template produced these words, stored beside them so a question
        // a month from now is answerable from the row rather than re-derived.
        visitType: slip.visitType ?? null,
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

/**
 * Compose, then make every word of it OD-safe. THE ONLY EXPORT.
 *
 * One choke point rather than a `line()` call at forty push sites: "the preview
 * is ASCII" has to be a property of this module, not of whoever remembered. The
 * payload is sanitized in the same pass, and the note's `text` is rebuilt from
 * the sanitized lines — so the fingerprinted preview and the transmitted string
 * are the same bytes, which is what "the preview IS the write" means.
 *
 * @param {'router'|'perio'|'note'|'tc-handoff'} kind
 * @param {{ visit: Record<string, any>, items: Record<string, any>[], actor: string,
 *           signature?: string[] }} ctx
 *   `signature` is the office's typed-name block, built by the ROUTE from
 *   backend/config/hygStaff.js. It is passed in rather than read here so this
 *   module stays pure — and so a test can state what a note says without an
 *   office registry.
 */
function compose(kind, ctx) {
  const composed = composeRaw(kind, ctx);
  if (!composed || !composed.preview) return composed;

  const preview = composed.preview.map(line);
  const payload = { ...composed.payload };
  if (Array.isArray(payload.lines)) payload.lines = payload.lines.map(line);
  if (typeof payload.nameBlock === 'string') payload.nameBlock = line(payload.nameBlock);
  // REBUILT from the sanitized lines, not sanitized separately — two sanitizers
  // over two strings is two chances for them to disagree.
  if (typeof payload.text === 'string') payload.text = preview.join(NOTE_NEWLINE);

  return {
    title: line(composed.title),
    summary: line(composed.summary),
    preview,
    payload,
  };
}

module.exports = {
  compose,
  // Exported so a test can state what the sanitizer actually changed.
  composeRaw,
  NAME_BLOCK_PREFIX,
  // Exported for tests and for the route's records/handoff summary.
  noteTemplateLines,
  visitTypeLabel,
  teethLabel,
  itemLine,
  slipLines,
  answerLabel,
};

'use strict';

/**
 * THE ONLY FILE THAT MAY WRITE A PERIO CHART INTO OPEN DENTAL — OR DELETE ONE
 * (H4 item 12).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * A SIBLING OF odWriter.js, REGISTERED IN THE SAME ALLOW-LIST
 * ═════════════════════════════════════════════════════════════════════════════
 * `routes/hyg/hygNoOdWrites.test.js` names `OD_WRITE_LAYER`, and this file was
 * added to it in the same commit as the test that proves it really writes.
 * Three narrow functions over three Open Dental calls and nothing else. Whether
 * a write should happen, and whether it already did, is
 * `services/hyg/perioSend.js`, which cannot reach the transport except through
 * here.
 *
 *   createPerioExam     POST /perioexams      the header, plus the arch strings
 *   createPerioMeasure  POST /periomeasures   one row, for what a string cannot carry
 *   deletePerioExam     DELETE /perioexams/n  the undo: the exam and every row in it
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE ANSWER HAS THREE SHAPES, NOT TWO
 * ═════════════════════════════════════════════════════════════════════════════
 *   ok        Open Dental answered 2xx. NOT proof — the caller reads it back.
 *   refused   Open Dental answered with a refusal (4xx, or OD_WRITE_DISABLED).
 *             Nothing was written; the words are Open Dental's own.
 *   uncertain no answer (timeout, network, 5xx). It MAY have landed. The caller
 *             must not send it again until a read says it did not.
 *
 * Collapsing uncertain into refused is how a retry writes a permanent second
 * Probing row.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE STRINGS ARE CHECKED HERE, BEFORE THE TRANSPORT
 * ═════════════════════════════════════════════════════════════════════════════
 * The probe found that a string Open Dental accepts can still write the wrong
 * teeth: a two-digit reading shifts every later site, and no character holds a
 * place. `perioSend.js` only ever builds strings through the shared
 * `planPerioSend`. This file refuses any string that is not one digit per site,
 * each with at most one of each flag letter, no more than 48 sites, under one of
 * the four field names — so a string assembled anywhere else, by anything,
 * cannot reach Open Dental.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * SIX SEQUENCE TYPES, AND NEVER CAL
 * ═════════════════════════════════════════════════════════════════════════════
 * Probing, BleedSupPlaqCalc, SkipTooth, and item 26's GingMargin, Furcation and
 * Mobility. Anything else — above all **CAL** — is refused here, before the
 * transport, whatever the caller asked for. Open Dental derives CAL itself from
 * Probing + GingMargin, so a CAL CareIN wrote could disagree with the chart of
 * record, and the chart of record would be the one that looked wrong.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * EACH v2 TYPE HAS A SHAPE, AND OPEN DENTAL DOES NOT ENFORCE THE CLINICAL PART
 * ═════════════════════════════════════════════════════════════════════════════
 * Item 19's probe measured all of this (`docs/reports/feature-hyg-perio-v2-probe.md`):
 *
 *   GingMargin  per site. `ToothValue` MUST be -1. Surfaces are 0-19 — the
 *               §0-proven RECESSION family. Open Dental also accepts 101-119;
 *               CareIN never writes it, so it is refused here too.
 *   Furcation   per site. `ToothValue` MUST be -1. Surfaces are classes 1-3 —
 *               and **Open Dental accepted a 5**, and accepted furcation on #8, a
 *               central incisor. It does not know which teeth have roots to fork.
 *               So the class range AND the tooth list are enforced HERE.
 *   Mobility    per tooth, the grade in `ToothValue` (0-3 clinically; Open Dental
 *               would take 0-19). EVERY surface column MUST be -1 or Open Dental
 *               refuses the row outright.
 *
 * A row whose every value is -1 says nothing, and is refused rather than written:
 * Open Dental will happily store one (measured), which is exactly why the refusal
 * has to be on this side.
 *
 * `OPENDENTAL_WRITE_DISABLED=true` is enforced inside `apiWriteRaw` and
 * `apiDeleteRaw` themselves and comes back as an ordinary refusal.
 */

const contract = require('../../hyg/contract.gen.cjs');

/** The only SequenceTypes this file will post. See the header. */
const ALLOWED_SEQUENCE_TYPES = Object.freeze([
  'Probing',
  'BleedSupPlaqCalc',
  'SkipTooth',
  'GingMargin',
  'Furcation',
  'Mobility',
]);

/** The six surface columns, without ToothValue — item 26 treats the two differently. */
const SURFACE_VALUE_KEYS = Object.freeze(['MBvalue', 'Bvalue', 'DBvalue', 'MLvalue', 'Lvalue', 'DLvalue']);

/**
 * Item 26's shape rules, checked before the transport. Returns an error sentence
 * or null.
 *
 * @param {string} sequenceType @param {number} tooth @param {Record<string, number>} v
 * @returns {string|null}
 */
function v2ShapeError(sequenceType, tooth, v) {
  const surfaces = SURFACE_VALUE_KEYS.map((k) => v[k]);
  const anyMeasured = surfaces.some((n) => n !== -1);

  if (sequenceType === 'Mobility') {
    // Per TOOTH. Open Dental refuses a surface value on this type outright.
    if (!surfaces.every((n) => n === -1)) {
      return 'A Mobility row carries its grade in ToothValue; every surface must be -1';
    }
    if (v.ToothValue < 0 || v.ToothValue > contract.PERIO_MAX_MOBILITY) {
      return `Mobility is 0-${contract.PERIO_MAX_MOBILITY}`;
    }
    return null;
  }

  if (sequenceType === 'GingMargin' || sequenceType === 'Furcation') {
    if (v.ToothValue !== -1) return `A ${sequenceType} row is per site; ToothValue must be -1`;
    if (!anyMeasured) return `A ${sequenceType} row with no measurement on any surface says nothing`;
  }

  if (sequenceType === 'GingMargin') {
    // §0: recession is 0-19. 101-119 is the other family and we never write it.
    for (const n of surfaces) {
      if (n === -1) continue;
      if (n < contract.PERIO_GM_FAMILIES.recessionMin || n > contract.PERIO_GM_FAMILIES.recessionMax) {
        return (
          `A gingival margin is ${contract.PERIO_GM_FAMILIES.recessionMin}-` +
          `${contract.PERIO_GM_FAMILIES.recessionMax} mm of recession`
        );
      }
    }
    return null;
  }

  if (sequenceType === 'Furcation') {
    if (!contract.perioToothHasFurcation(tooth)) {
      return `#${tooth} is not a multi-rooted tooth and has no furcation`;
    }
    for (const n of surfaces) {
      if (n === -1) continue;
      if (n < contract.PERIO_MIN_FURCATION || n > contract.PERIO_MAX_FURCATION) {
        return `A furcation class is ${contract.PERIO_MIN_FURCATION}-${contract.PERIO_MAX_FURCATION}`;
      }
    }
    return null;
  }

  return null;
}

const WRITE_TIMEOUT_MS = 30000;

/**
 * What the exam's Note says in Open Dental. No person, no reading, nothing that
 * identifies anybody — only where the chart came from.
 */
const PERIO_EXAM_NOTE = 'Charted in CareIN.';

/** Open Dental's body keys for the six surfaces, plus the tooth-level value. */
const MEASURE_VALUE_KEYS = Object.freeze([
  'ToothValue',
  'MBvalue',
  'Bvalue',
  'DBvalue',
  'MLvalue',
  'Lvalue',
  'DLvalue',
]);

/**
 * How an unsuccessful transport answer is classified.
 * @param {{ ok?: boolean, status?: number, error?: string } | null | undefined} res
 * @returns {'refused' | 'uncertain'}
 */
function failureKind(res) {
  const text = String((res && res.error) || '');
  if (text.startsWith('OD_WRITE_DISABLED')) return 'refused';
  const status = Number(res && res.status);
  // 408 is a timeout wearing a 4xx; everything else in 4xx is Open Dental
  // saying no. 0 (no response) and 5xx may have landed.
  if (status >= 400 && status < 500 && status !== 408) return 'refused';
  return 'uncertain';
}

function failure(res, fallback) {
  const text = String((res && res.error) || '').trim();
  const kind = failureKind(res);
  return {
    ok: false,
    refused: kind === 'refused',
    code: text.startsWith('OD_WRITE_DISABLED')
      ? 'OD_WRITE_DISABLED'
      : kind === 'refused'
        ? 'OD_REFUSED'
        : 'OD_NO_ANSWER',
    error: text || fallback,
  };
}

function refusedBeforeTransport(code, error) {
  return { ok: false, refused: true, code, error };
}

/** A positive integer from a response field, or null. */
function minted(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * The exam header, carrying whichever arch strings the plan could express.
 *
 * `ProvNum` is REQUIRED — omitted, Open Dental files the exam under the
 * patient's primary provider rather than whoever charted it (H0 §2). An empty
 * `strings` is allowed: a chart that goes wholly row by row still needs its exam.
 *
 * @param {{ client: { apiWriteRaw: Function } }} od
 * @param {{ patNum: number, examDate: string, provNum: number, strings: Record<string, string> }} args
 * @returns {Promise<{ ok: true, examNum: number | null }
 *          | { ok: false, refused: boolean, code: string, error: string }>}
 */
async function createPerioExam(od, { patNum, examDate, provNum, strings }) {
  if (!Number.isInteger(patNum) || patNum <= 0) {
    return refusedBeforeTransport('BAD_EXAM', 'An exam needs a PatNum');
  }
  if (!Number.isInteger(provNum) || provNum <= 0) {
    return refusedBeforeTransport(
      'NO_PROVIDER',
      'An exam needs an explicit ProvNum, or Open Dental files it under the wrong provider'
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(examDate))) {
    return refusedBeforeTransport('BAD_EXAM', 'An exam needs a YYYY-MM-DD date');
  }

  const body = { PatNum: patNum, ExamDate: examDate, ProvNum: provNum, Note: PERIO_EXAM_NOTE };
  for (const [field, value] of Object.entries(strings || {})) {
    if (!contract.PERIO_ARCH_STRING_FIELDS.includes(field)) {
      return refusedBeforeTransport('BAD_ARCH_STRING', `${field} is not an arch string Open Dental takes`);
    }
    if (!contract.isWellFormedArchString(value)) {
      // Never "fixed" here. A malformed string is a planning bug, and sending a
      // repaired one would write readings nobody confirmed.
      return refusedBeforeTransport('BAD_ARCH_STRING', `${field} is not a well-formed arch string`);
    }
    body[field] = value;
  }

  const res = await od.client.apiWriteRaw('POST', '/perioexams', body, {
    module: 'hyg',
    timeoutMs: WRITE_TIMEOUT_MS,
  });
  if (!res || !res.ok) return failure(res, 'Open Dental refused the perio exam');
  return { ok: true, examNum: minted(res.data && res.data.PerioExamNum) };
}

/**
 * One measurement row.
 *
 * @param {{ client: { apiWriteRaw: Function } }} od
 * @param {{ examNum: number, tooth: number, sequenceType: string,
 *           values: Record<string, number> }} args
 * @returns {Promise<{ ok: true, measureNum: number | null }
 *          | { ok: false, refused: boolean, code: string, error: string }>}
 */
async function createPerioMeasure(od, { examNum, tooth, sequenceType, values }) {
  if (!ALLOWED_SEQUENCE_TYPES.includes(sequenceType)) {
    // CAL above all — refused BEFORE the transport. See the header.
    return refusedBeforeTransport(
      'SEQUENCE_TYPE_NOT_ALLOWED',
      `CareIN does not write ${String(sequenceType)} rows`
    );
  }
  if (!Number.isInteger(examNum) || examNum <= 0) {
    return refusedBeforeTransport('BAD_MEASURE', 'A measurement needs its exam');
  }
  if (!Number.isInteger(tooth) || tooth < 1 || tooth > 32) {
    return refusedBeforeTransport('BAD_MEASURE', 'A measurement needs a tooth 1-32');
  }

  const body = { PerioExamNum: examNum, SequenceType: sequenceType, IntTooth: tooth };
  for (const key of MEASURE_VALUE_KEYS) {
    const v = Number(values && values[key]);
    if (!Number.isInteger(v)) {
      return refusedBeforeTransport('BAD_MEASURE', `A measurement needs ${key} to be a whole number`);
    }
    body[key] = v;
  }

  /*
   * ITEM 26: the per-type shape and the clinical limits, BEFORE the generic
   * -1..19 floor below. Both would refuse a gingival margin of 102, but only this
   * one says "a gingival margin is 0-19 mm of recession" rather than "between -1
   * and 19" — and the sentence is what tells a hygienist what to do next.
   */
  const shape = v2ShapeError(sequenceType, tooth, body);
  if (shape !== null) return refusedBeforeTransport('BAD_MEASURE', shape);

  for (const key of MEASURE_VALUE_KEYS) {
    // -1 is "no measurement"; a surface value is 0–19 (a depth) or 0–15 (flags).
    // The floor under every type, including the three v1 ones.
    if (body[key] < -1 || body[key] > contract.PERIO_MAX_DEPTH) {
      return refusedBeforeTransport('BAD_MEASURE', `A measurement needs ${key} between -1 and 19`);
    }
  }

  const res = await od.client.apiWriteRaw('POST', '/periomeasures', body, {
    module: 'hyg',
    timeoutMs: WRITE_TIMEOUT_MS,
  });
  if (!res || !res.ok) return failure(res, 'Open Dental refused the measurement');
  return { ok: true, measureNum: minted(res.data && res.data.PerioMeasureNum) };
}

/**
 * The undo: delete one exam and, with it, every measurement row it holds.
 *
 * This function checks only that it was given an exam NUMBER. Whether this is
 * the exam the send created, that the send is unfinished, that it belongs to
 * this patient and that a person confirmed it — that is perioSend.js, and it
 * reads Open Dental before it calls here and again after.
 *
 * @param {{ client: { apiDeleteRaw: Function } }} od
 * @param {{ examNum: number }} args
 * @returns {Promise<{ ok: true } | { ok: false, refused: boolean, code: string, error: string }>}
 */
async function deletePerioExam(od, { examNum }) {
  if (!Number.isInteger(examNum) || examNum <= 0) {
    return refusedBeforeTransport('BAD_EXAM', 'A delete needs a PerioExamNum');
  }
  const res = await od.client.apiDeleteRaw(`/perioexams/${examNum}`, {
    module: 'hyg',
    timeoutMs: WRITE_TIMEOUT_MS,
  });
  if (!res || !res.ok) return failure(res, 'Open Dental refused to delete the perio exam');
  return { ok: true };
}

module.exports = {
  createPerioExam,
  createPerioMeasure,
  deletePerioExam,
  failureKind,
  ALLOWED_SEQUENCE_TYPES,
  MEASURE_VALUE_KEYS,
  PERIO_EXAM_NOTE,
};

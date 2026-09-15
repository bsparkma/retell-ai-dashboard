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
 * ONLY THREE SEQUENCE TYPES, AND NEVER CAL
 * ═════════════════════════════════════════════════════════════════════════════
 * Probing, BleedSupPlaqCalc and SkipTooth. CAL is derived by Open Dental and
 * never stored; recession, mobility and furcation are v2. Refused here, before
 * the transport, whatever the caller asked for.
 *
 * `OPENDENTAL_WRITE_DISABLED=true` is enforced inside `apiWriteRaw` and
 * `apiDeleteRaw` themselves and comes back as an ordinary refusal.
 */

const contract = require('../../hyg/contract.gen.cjs');

/** The only SequenceTypes this file will post. See the header. */
const ALLOWED_SEQUENCE_TYPES = Object.freeze(['Probing', 'BleedSupPlaqCalc', 'SkipTooth']);

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
    // CAL, GingMargin, Mobility, Furcation — refused BEFORE the transport.
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
    // -1 is "no measurement"; a surface value is 0–19 (a depth) or 0–15 (flags).
    if (!Number.isInteger(v) || v < -1 || v > contract.PERIO_MAX_DEPTH) {
      return refusedBeforeTransport('BAD_MEASURE', `A measurement needs ${key} between -1 and 19`);
    }
    body[key] = v;
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

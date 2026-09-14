'use strict';

/**
 * THE ONLY FILE THAT MAY WRITE A PERIO CHART INTO OPEN DENTAL (H4 slice 11).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * A SIBLING OF odWriter.js, REGISTERED IN THE SAME ALLOW-LIST
 * ═════════════════════════════════════════════════════════════════════════════
 * `routes/hyg/hygNoOdWrites.test.js` names `OD_WRITE_LAYER`, and this file was
 * added to it in the same commit as the test that proves it really writes. Two
 * narrow functions over two Open Dental calls, and nothing else: whether a row
 * should be written, and whether it already was, is `services/hyg/perioSend.js`,
 * which cannot reach the transport except through here.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE ANSWER HAS THREE SHAPES, NOT TWO
 * ═════════════════════════════════════════════════════════════════════════════
 *   ok        Open Dental answered 2xx. NOT proof the row exists — the caller
 *             reads it back before anything is called confirmed.
 *   refused   Open Dental answered with a refusal (4xx, or the environment's
 *             OD_WRITE_DISABLED). Nothing was written; the words are Open
 *             Dental's own and go beside the site.
 *   uncertain no answer (timeout, network, 5xx). It MAY have landed. The caller
 *             must not send it again until a read says it did not.
 *
 * Collapsing uncertain into refused is how a retry writes a permanent second
 * Probing row. That distinction is the reason this file exists.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ONLY THREE SEQUENCE TYPES, AND NEVER CAL
 * ═════════════════════════════════════════════════════════════════════════════
 * v1 writes Probing, BleedSupPlaqCalc and SkipTooth. CAL is derived by Open
 * Dental from probing and gingival margin and is never stored — a request for it
 * is refused here, before the transport, whatever the caller asked for.
 *
 * `OPENDENTAL_WRITE_DISABLED=true` is enforced inside `apiWriteRaw` itself and
 * comes back as an ordinary refusal carrying `OD_WRITE_DISABLED`.
 */

/** The only SequenceTypes this file will post. See the header. */
const ALLOWED_SEQUENCE_TYPES = Object.freeze(['Probing', 'BleedSupPlaqCalc', 'SkipTooth']);

const WRITE_TIMEOUT_MS = 30000;

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

/** A positive integer from a response field, or null. */
function minted(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * The exam header. `ProvNum` is REQUIRED here — omitted, Open Dental files the
 * exam under the patient's primary provider rather than the hygienist who
 * charted it (H0 §2).
 *
 * @param {{ client: { apiWriteRaw: Function } }} od
 * @param {{ patNum: number, examDate: string, provNum: number }} args
 * @returns {Promise<{ ok: true, examNum: number | null }
 *          | { ok: false, refused: boolean, code: string, error: string }>}
 */
async function createPerioExam(od, { patNum, examDate, provNum }) {
  if (!Number.isInteger(patNum) || patNum <= 0) {
    return { ok: false, refused: true, code: 'BAD_EXAM', error: 'An exam needs a PatNum' };
  }
  if (!Number.isInteger(provNum) || provNum <= 0) {
    return {
      ok: false,
      refused: true,
      code: 'NO_PROVIDER',
      error: 'An exam needs an explicit ProvNum, or Open Dental files it under the wrong provider',
    };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(examDate))) {
    return { ok: false, refused: true, code: 'BAD_EXAM', error: 'An exam needs a YYYY-MM-DD date' };
  }

  const res = await od.client.apiWriteRaw(
    'POST',
    '/perioexams',
    { PatNum: patNum, ExamDate: examDate, ProvNum: provNum },
    { module: 'hyg', timeoutMs: WRITE_TIMEOUT_MS }
  );
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
    return {
      ok: false,
      refused: true,
      code: 'SEQUENCE_TYPE_NOT_ALLOWED',
      error: `CareIN does not write ${String(sequenceType)} rows`,
    };
  }
  if (!Number.isInteger(examNum) || examNum <= 0) {
    return { ok: false, refused: true, code: 'BAD_MEASURE', error: 'A measurement needs its exam' };
  }
  if (!Number.isInteger(tooth) || tooth < 1 || tooth > 32) {
    return { ok: false, refused: true, code: 'BAD_MEASURE', error: 'A measurement needs a tooth 1-32' };
  }

  const body = { PerioExamNum: examNum, SequenceType: sequenceType, IntTooth: tooth };
  for (const key of MEASURE_VALUE_KEYS) {
    const v = Number(values && values[key]);
    if (!Number.isInteger(v)) {
      return { ok: false, refused: true, code: 'BAD_MEASURE', error: `A measurement needs ${key}` };
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

module.exports = {
  createPerioExam,
  createPerioMeasure,
  failureKind,
  ALLOWED_SEQUENCE_TYPES,
  MEASURE_VALUE_KEYS,
};

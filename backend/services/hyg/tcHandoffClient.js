'use strict';

/**
 * Hand a visit's treatment to the TC module — through TC's OWN intake contract.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE CONTRACT FITS, AND THAT IS NOT AN ACCIDENT
 * ═════════════════════════════════════════════════════════════════════════════
 * `POST /api/tc/hygiene-intakes` already exists and is already called "the
 * hygiene → TC handoff": it creates a case with status `hygiene_review`, stamps
 * `submitted_by` from the SSO session, and files a `tc_hygiene_intakes` row
 * against it. It is gated `tc.hygiene`, which the hygiene role holds.
 *
 * So nothing here invents a second intake and nothing reshapes TC's — TC is
 * LIVE. What this file does is TRANSLATE: a hygiene visit's vocabulary into
 * TC's. Every mapping below is lossy in a direction worth writing down, and
 * they are all in one place so the losses are reviewable rather than scattered.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * TRANSPORT: A LOOPBACK CALL, WITH THE CALLER'S OWN CREDENTIAL
 * ═════════════════════════════════════════════════════════════════════════════
 * Same shape as `services/tcCaseClient.js`, and for the same reason: forwarding
 * the caller's cookie or bearer means TC derives the same actor and the same
 * tenant, and applies its own `requireModule('tc')` and `tc.hygiene` guards. A
 * service credential would be this module deciding it may act inside TC, which
 * is exactly the authority it should not have.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * IDEMPOTENCY IS THE STAGED WRITE'S JOB, NOT TC'S
 * ═════════════════════════════════════════════════════════════════════════════
 * The voice handoff is idempotent on `source_call_id`, enforced by a unique
 * index. `/hygiene-intakes` has no such key — submitting twice creates two
 * cases. What prevents that here is the staged-write state machine: a `Written`
 * row cannot be re-sent, and un-staging one is refused. That is a weaker
 * guarantee than a unique index (it holds within this app, not against a second
 * caller) and it is worth knowing before somebody adds a retry loop above it.
 */

const contract = require('../../hyg/contract.gen.cjs');

const DEFAULT_TIMEOUT_MS = 10000;

/** Same derivation as services/tcCaseClient.js — one process, one port. */
function internalBaseUrl() {
  if (process.env.INTERNAL_API_BASE_URL) {
    return String(process.env.INTERNAL_API_BASE_URL).replace(/\/+$/, '');
  }
  const port = process.env.PORT || (process.env.NODE_ENV === 'production' ? 5003 : 5103);
  return `http://127.0.0.1:${port}`;
}

/**
 * The hygiene module's handoff category → TC's case category.
 *
 * LOSSY, IN ONE DIRECTION EACH:
 *   Perio       → quadrant   TC has no perio category; quadrant is the closest
 *                            thing a treatment coordinator's pipeline has.
 *   Restorative → single_tooth  TC's default for unclassified work, and what
 *                            its own New Case dialog picks.
 *   Other       → single_tooth  Same, and it is a starting point a TC edits —
 *                            not a claim about the dentistry.
 * The rest map onto a TC category of the same name.
 */
const CATEGORY_MAP = Object.freeze({
  Implant: 'implant',
  Ortho: 'ortho',
  Cosmetic: 'cosmetic',
  Perio: 'quadrant',
  Restorative: 'single_tooth',
  Other: 'single_tooth',
});

/** Highest priority on the visit → TC urgency. */
const URGENCY_BY_PRIORITY = Object.freeze({
  urgent: 'high',
  preventative: 'medium',
  cosmetic: 'low',
});

/**
 * The slip's AAP stage → TC's perio status.
 *
 * Stage I is "early", II is "moderate", III and IV are both "advanced": TC's
 * five-value scale has no fourth step, and collapsing III into "advanced" is
 * more honest than inventing a distinction TC cannot store. No stage recorded
 * is `unknown` — never `healthy`.
 */
const PERIO_MAP = Object.freeze({
  health: 'healthy',
  gingivitis: 'gingivitis',
  stage_i: 'early_perio',
  stage_ii: 'moderate_perio',
  stage_iii: 'advanced_perio',
  stage_iv: 'advanced_perio',
});

/** Slip x-ray chips → TC's radiograph vocabulary. */
const RADIOGRAPH_MAP = Object.freeze({
  FMX: 'FMX',
  PANO: 'PANO',
  'BW-4': 'BWX',
  'BW-2': 'BWX',
  PA: 'PA',
});

/**
 * Build TC's intake body from a hygiene visit.
 *
 * PURE. No clock, no request, no network — so `hygSendTcHandoff.test.js` can
 * state exactly what TC would receive without booting anything.
 *
 * @param {{ visit: object, appointment: object, handoffCategory: string, date: string }} ctx
 * @returns {{ ok: true, body: Record<string, unknown> }
 *          | { ok: false, code: string, error: string }}
 */
function buildIntake({ visit, appointment, handoffCategory, date }) {
  const items = Array.isArray(visit.items) ? visit.items : [];
  if (items.length === 0) {
    return {
      ok: false,
      code: 'NOTHING_TO_STAGE',
      error: 'There is no treatment on this visit to hand off',
    };
  }

  const patientName = String(appointment.patientName || '').trim();
  if (!patientName) {
    // TC requires a name to open a case with, and this module will not invent
    // one. "Unknown Patient" in a treatment coordinator's queue is a case
    // nobody can work and everybody has to check.
    return {
      ok: false,
      code: 'PATIENT_NAME_UNAVAILABLE',
      error:
        'Open Dental did not give a name for this patient, so a treatment case cannot be ' +
        'opened for them',
    };
  }

  // TC's own schema makes this required, and it is the right requirement: a
  // case with no diagnosing provider is a case nobody can present.
  const provider = String(appointment.providerName || '').trim();
  if (!provider) {
    return {
      ok: false,
      code: 'PROVIDER_UNAVAILABLE',
      error:
        'This appointment has no provider on it in Open Dental, and TC needs one to open a ' +
        'case. Set the provider on the appointment and stage the handoff again.',
    };
  }

  const slip = visit.slip || {};
  const priorities = new Set(items.map((i) => i.priority));
  const urgency = priorities.has('urgent')
    ? URGENCY_BY_PRIORITY.urgent
    : priorities.has('preventative')
      ? URGENCY_BY_PRIORITY.preventative
      : URGENCY_BY_PRIORITY.cosmetic;

  const radiographs = [
    ...new Set(
      (Array.isArray(slip.xrayTypes) ? slip.xrayTypes : [])
        .map((x) => RADIOGRAPH_MAP[x])
        .filter(Boolean)
    ),
  ];

  const done = Array.isArray(slip.doneToday) ? slip.doneToday : [];
  const recallType = done.some((d) => String(d).startsWith('srp-'))
    ? 'srp_needed'
    : done.includes('prophy')
      ? 'prophy'
      : 'none';

  const treatmentLines = items.map((item) => {
    const teeth = item.teeth === 'mouth' ? 'Whole mouth' : `#${(item.teeth || []).join(', #')}`;
    return `${teeth} ${item.code} (${item.priority})`;
  });

  return {
    ok: true,
    body: {
      patientName,
      odPatientId: visit.patNum,
      diagnosingProvider: provider,
      category: CATEGORY_MAP[handoffCategory] || 'single_tooth',
      urgency,
      caseType: '',
      // Clinical fields, all optional in TC's schema.
      operatory: String(appointment.opName || ''),
      visitDate: date,
      providerSeen: provider,
      chiefConcern: String(slip.patientConcerns || ''),
      perioStatus: PERIO_MAP[slip.perioStage] || 'unknown',
      recallType,
      radiographs: radiographs.length > 0 ? radiographs : ['none'],
      // Slice 2 and 3 have no photo path at all, so this is a fact rather than
      // a default: no intraoral photos were taken THROUGH THIS APP.
      intraoralPhotosTaken: false,
      areasOfConcern: String(slip.hygieneFindings || ''),
      suspectedTreatment: treatmentLines.join('\n'),
      hygienistRecommendation: String(slip.frontDeskNote || ''),
      insuranceNoted: String(slip.financialNote || ''),
      // Not asked anywhere in this module. `unknown` is the honest value; the
      // TC who picks the case up is the one who finds out.
      patientInterestLevel: 'unknown',
      flagUrgent: priorities.has('urgent'),
    },
  };
}

/**
 * The screening's "Interested?" → TC's interest level (item 33).
 *
 * Yes is `hot`, Maybe is `warm`, Not now is `cold`. LOSSY in one direction:
 * TC's scale has four steps and the screening three, and nothing here claims
 * more certainty than the hygienist tapped. Unanswered cannot reach this map —
 * an unanswered screening is not sendable.
 */
const INTEREST_MAP = Object.freeze({
  yes: 'hot',
  maybe: 'warm',
  not_now: 'cold',
});

/**
 * Whole years between a `YYYY-MM-DD` birthdate and a `YYYY-MM-DD` date, or null.
 *
 * Calendar arithmetic on the two strings, never Date objects: a birthdate is a
 * local calendar fact, and a UTC parse would make a patient a year younger for
 * part of their birthday. `0001-01-01` is Open Dental's "no date" and is null.
 *
 * @param {string|null|undefined} birthdate
 * @param {string} onDate
 * @returns {number|null}
 */
function ageOn(birthdate, onDate) {
  const b = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(birthdate || ''));
  const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(onDate || ''));
  if (!b || !d) return null;
  const [by, bm, bd] = [Number(b[1]), Number(b[2]), Number(b[3])];
  const [dy, dm, dd] = [Number(d[1]), Number(d[2]), Number(d[3])];
  if (by <= 1) return null;
  let age = dy - by;
  if (dm < bm || (dm === bm && dd < bd)) age -= 1;
  return age >= 0 && age <= 130 ? age : null;
}

/**
 * Build TC's intake body from a visit's ortho screening (item 33).
 *
 * PURE, like `buildIntake`. Everything about WHO comes from `snapshot` — what
 * this server recorded the last time it read the appointment from Open Dental
 * — and the visit row (office, PatNum). Nothing comes from a request.
 *
 * The case it opens: category `ortho`, caseType `Ortho screening`, urgency
 * `elective`, diagnosed by the appointment's provider. `chiefConcern` is the
 * concerns, `suspectedTreatment` is the shared summary line (so TC's text-only
 * surfaces show something useful today), and the structured screening rides in
 * `orthoScreening`.
 *
 * @param {{ visit: object, snapshot: object|null, date: string }} ctx
 * @returns {{ ok: true, body: Record<string, unknown> }
 *          | { ok: false, code: string, error: string }}
 */
function buildOrthoIntake({ visit, snapshot, date }) {
  const parsed = contract.OrthoScreeningSchema.nullable().safeParse(
    visit.slip ? visit.slip.orthoScreening : null
  );
  const screening = parsed.success ? parsed.data : null;
  if (!contract.isOrthoSendable(screening)) {
    return {
      ok: false,
      code: 'ORTHO_NOTHING_TO_SEND',
      error: 'Answer "Interested?" on the ortho screening before sending it to the TC',
    };
  }

  const snap = snapshot || {};
  const patientName = String(snap.patientName || '').trim();
  if (!patientName) {
    return {
      ok: false,
      code: 'PATIENT_NAME_UNAVAILABLE',
      error:
        'Open Dental has not given a name for this patient on this visit yet, so a TC case ' +
        'cannot be opened for them. Reload the visit and send again.',
    };
  }
  // The DIAGNOSING provider is the appointment's provider (ProvNum — the doctor
  // who examined), falling back to the provider the appointment displays when
  // Open Dental named no doctor. `providerSeen` is who the patient was with.
  const seen = String(snap.providerName || '').trim();
  const provider = String(snap.doctorName || '').trim() || seen;
  if (!provider) {
    return {
      ok: false,
      code: 'PROVIDER_UNAVAILABLE',
      error:
        'This appointment has no provider on it in Open Dental, and TC needs one to open a ' +
        'case. Set the provider on the appointment, reload the visit, and send again.',
    };
  }

  const slip = visit.slip || {};
  const phone = String(snap.phone || '').trim();
  const radiographs = new Set(
    (Array.isArray(slip.xrayTypes) ? slip.xrayTypes : [])
      .map((x) => RADIOGRAPH_MAP[x])
      .filter(Boolean)
  );
  if (screening.recordsToday.includes('pano')) radiographs.add('PANO');
  const benefit = contract.ORTHO_BENEFIT_OPTIONS.find((o) => o.id === screening.orthoBenefit);

  return {
    ok: true,
    body: {
      patientName,
      patientAge: ageOn(snap.birthdate, date),
      phone: phone ? phone.slice(0, 200) : null,
      odPatientId: visit.patNum,
      diagnosingProvider: provider,
      category: 'ortho',
      urgency: 'elective',
      caseType: 'Ortho screening',
      operatory: String(snap.opName || ''),
      visitDate: date,
      providerSeen: seen || provider,
      chiefConcern: contract.orthoConcernsText(screening),
      perioStatus: PERIO_MAP[slip.perioStage] || 'unknown',
      // A screening is not a recall decision; the treatment handoff carries that.
      recallType: 'none',
      radiographs: radiographs.size > 0 ? [...radiographs] : ['none'],
      // The screening's own answer, not a guess: "Photos" under Taken today.
      intraoralPhotosTaken: screening.recordsToday.includes('photos'),
      areasOfConcern: '',
      suspectedTreatment: contract.orthoScreeningSummary(screening),
      hygienistRecommendation: screening.noteForTc,
      insuranceNoted: benefit ? benefit.label : '',
      patientInterestLevel: INTEREST_MAP[screening.interest] || 'unknown',
      flagUrgent: false,
      orthoScreening: screening,
    },
  };
}

/**
 * Send it. NEVER THROWS — every failure is a typed refusal, so the staged write
 * can be marked Failed with a reason instead of the send claiming success.
 *
 * @returns {Promise<{ ok: true, caseId: string }
 *          | { ok: false, code: string, error: string }>}
 */
async function submitHygieneIntake(req, { office, body }, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  /** @type {Record<string,string>} */
  const headers = { 'Content-Type': 'application/json' };
  const incoming = (req && req.headers) || {};
  if (incoming.cookie) headers.Cookie = String(incoming.cookie);
  if (incoming.authorization) headers.Authorization = String(incoming.authorization);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(
      `${internalBaseUrl()}/api/tc/hygiene-intakes?office=${encodeURIComponent(office)}`,
      { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal }
    );
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.error('[hyg/tcHandoff] TC did not answer:', message);
    return { ok: false, code: 'TC_UNREACHABLE', error: 'The TC app did not respond' };
  } finally {
    clearTimeout(timer);
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message =
      (payload && typeof payload.error === 'string' && payload.error) ||
      `TC responded ${response.status}`;
    // A 403 here is TC's own entitlement or permission answer, and saying so is
    // more useful than "the handoff failed".
    const code =
      response.status === 403
        ? 'TC_FORBIDDEN'
        : response.status === 404
          ? 'TC_ENDPOINT_MISSING'
          : 'TC_ERROR';
    return { ok: false, code, error: message };
  }

  const caseId = payload && payload.case && payload.case.caseId;
  if (typeof caseId !== 'string' || caseId.length === 0) {
    // A 200 with no case in it is a REFUSAL, not a success: persisting a
    // half-known linkage would be worse than reporting that nothing landed.
    return {
      ok: false,
      code: 'TC_BAD_RESPONSE',
      error: 'TC accepted the handoff but did not return a case, so nothing can be pointed at',
    };
  }
  return { ok: true, caseId };
}

module.exports = {
  ageOn,
  buildOrthoIntake,
  INTEREST_MAP,
  buildIntake,
  submitHygieneIntake,
  CATEGORY_MAP,
  PERIO_MAP,
  RADIOGRAPH_MAP,
  URGENCY_BY_PRIORITY,
};

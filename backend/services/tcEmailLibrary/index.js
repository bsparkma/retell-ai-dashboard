'use strict';

/**
 * The TC patient email library (EL-1): WORDING CONFIG + PREVIEW. Nothing more.
 *
 *   source.json   the frozen library (36 procedure blocks x 54 stage frames x
 *                 the questionnaire). Byte-identical to the handoff file; its
 *                 sha256 is pinned by tcEmailLibrary.test.js, so a wording change
 *                 is a PR that moves the pin.
 *   compose.js    the one composer, behavior-identical to the handoff's
 *                 (golden-hash test).
 *   profileStore  one office's saved answers (tc_email_library_profile).
 *
 * WHAT THIS MODULE NEVER DOES: create a draft, a tc_messages row, or a send; call
 * Open Dental; call an AI model; touch a patient record. It requires no messaging
 * service, no channel adapter and no Open Dental client, and
 * tcEmailLibrary.test.js walks its require graph to keep it that way.
 *
 * MERGE FIELDS. compose() leaves `{{first_name}}`, `{{office_name}}`, ... in the
 * text. resolveMergeFields() fills the ones it is given a value for and leaves the
 * rest as their `{{token}}`, listed in `unresolved`. A missing value is never
 * printed as a blank and never invented.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { compose } = require('./compose');
const contract = require('../../tc/contract.gen.cjs');

const SOURCE_PATH = path.join(__dirname, 'source.json');

/**
 * Has the doctor reviewed the clinical copy? FALSE, and it flips ONLY by a PR
 * after that review (source.json's own status says "DRAFT - clinical copy
 * requires doctor review before any send"). In EL-1 nothing reads it except the
 * catalog and preview responses, which pass it to the page's banner. A future
 * send path must refuse while it is false.
 */
const LIBRARY_CLINICALLY_APPROVED = false;

/** Read once at load. The bytes are what the hash pin covers. */
const SOURCE_BYTES = fs.readFileSync(SOURCE_PATH);
const SOURCE_SHA256 = crypto.createHash('sha256').update(SOURCE_BYTES).digest('hex');
/** @type {any} */
const SOURCE = deepFreeze(JSON.parse(SOURCE_BYTES.toString('utf8')));
const LIBRARY_VERSION = String(SOURCE.version);

/** Questions never stored or offered: the email identity owns them. */
const NEVER_STORED = new Set(contract.EMAIL_LIBRARY_NEVER_STORED);
const MERGE_SETTINGS = contract.EMAIL_LIBRARY_MERGE_SETTINGS;

const PROCEDURE_IDS = new Set(SOURCE.procedure_blocks.map((/** @type {any} */ p) => p.id));
const STAGE_IDS = new Set(SOURCE.stages.map((/** @type {any} */ s) => s.id));
const VARIANT_IDS = new Set(Object.keys(SOURCE.variants));

/** @template T @param {T} o @returns {T} */
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/**
 * compose() over the whole library, memoized on the answers (a full compose is
 * ~30 ms; GET /profile and the catalog each need one). Small and bounded.
 */
const composeCache = new Map();
const COMPOSE_CACHE_MAX = 16;
/** @param {Record<string, unknown>} answers */
function composeAll(answers) {
  const key = JSON.stringify(answers);
  const hit = composeCache.get(key);
  if (hit) return hit;
  const out = compose(SOURCE, answers);
  if (composeCache.size >= COMPOSE_CACHE_MAX) composeCache.delete(composeCache.keys().next().value);
  composeCache.set(key, out);
  return out;
}

/**
 * The catalog for one office: version, approval flag, the procedures it
 * provides, the stages, tones, sequences and the questionnaire (minus
 * office_name / office_phone).
 * @param {string} office
 * @param {Record<string, unknown>} answers the office's saved answers ({} when none)
 */
function catalog(office, answers) {
  const emails = composeAll(answers);
  const off = new Set(Array.isArray(answers.services_off) ? answers.services_off : []);
  // A stage is in use when compose emits any email for it (stage_rules and
  // every block's skip list already applied).
  const used = new Set(emails.map((e) => e.stage));
  const procedure = (/** @type {any} */ p) => ({ id: p.id, name: p.name, category: p.category, audience: p.audience });
  return {
    success: true,
    office,
    libraryVersion: LIBRARY_VERSION,
    clinicallyApproved: LIBRARY_CLINICALLY_APPROVED,
    status: String(SOURCE.status),
    rulesOfUse: [...SOURCE.rules_of_use],
    procedures: SOURCE.procedure_blocks.filter((/** @type {any} */ p) => !off.has(p.id)).map(procedure),
    allProcedures: SOURCE.procedure_blocks.map(procedure),
    stages: SOURCE.stages.map((/** @type {any} */ s) => ({ id: s.id, label: s.label, phase: s.phase, use: s.use, inUse: used.has(s.id) })),
    variants: { ...SOURCE.variants },
    sequences: SOURCE.sequences.map((/** @type {any} */ q) => ({
      id: q.id,
      name: q.name,
      track: q.track,
      use: q.use,
      exit: q.exit,
      steps: q.steps.map((/** @type {any} */ st) => ({ stage: st.stage, when: st.when })),
    })),
    questions: SOURCE.questions
      .filter((/** @type {any} */ q) => !NEVER_STORED.has(q.id))
      .map((/** @type {any} */ q) => ({
        id: q.id,
        section: q.section,
        type: q.type,
        label: q.label,
        help: q.help,
        options: q.options.map((/** @type {any} */ o) => (o.phrase === undefined ? { value: o.value, label: o.label } : { value: o.value, label: o.label, phrase: o.phrase })),
        default: q.default,
        show_if: q.show_if,
        placeholder: q.placeholder,
      })),
    emailCount: emails.length,
  };
}

/** @param {Record<string, unknown>} answers @param {string} field */
function isBlank(answers, field) {
  const v = answers[field];
  return !(typeof v === 'string' && v.trim() !== '');
}

/**
 * The answer-owned settings (schedule_link, doctor_name) this office has not
 * set AND that at least one of its composed emails still prints as a
 * `{{token}}`, with the stages that print each. Since library 1.2.0 the
 * composer writes both into the text (a blank link drops the booking sentence,
 * a blank doctor reads "we"), so this is normally empty: a setting is listed
 * only when the wording would really show a hole.
 * @param {Record<string, unknown>} answers
 * @returns {Array<{ field: string, stages: string[] }>}
 */
function missingSettings(answers) {
  const emails = composeAll(answers);
  /** @type {Array<{ field: string, stages: string[] }>} */
  const out = [];
  for (const field of MERGE_SETTINGS) {
    if (!isBlank(answers, field)) continue;
    const stages = new Set();
    for (const e of emails) if (e.merge_fields.includes(field)) stages.add(e.stage);
    if (stages.size === 0) continue;
    // Source order, so the page lists them as the library does.
    out.push({ field, stages: SOURCE.stages.map((/** @type {any} */ s) => s.id).filter((/** @type {string} */ id) => stages.has(id)) });
  }
  return out;
}

/**
 * The optional settings (schedule_link, doctor_name) this office has left
 * blank, in contract order. Not a warning: the page shows one neutral line per
 * entry saying how the emails read without it.
 * @param {Record<string, unknown>} answers
 * @returns {string[]}
 */
function blankOptionalSettings(answers) {
  return MERGE_SETTINGS.filter((/** @type {string} */ field) => isBlank(answers, field));
}

class EmailLibraryError extends Error {
  /** @param {string} code @param {number} status @param {string} message */
  constructor(code, status, message) {
    super(message);
    this.name = 'EmailLibraryError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Compose ONE email. Behavior-identical to picking it out of compose(source,
 * answers): compose() handles each (block, frame) pair independently, and the
 * globals and stage rules depend only on the answers, so composing against a
 * source narrowed to that block and that frame yields the same object (pinned
 * by tcEmailLibrary.test.js against the full compose).
 * @param {{ procedureId: string, stage: string, variant: string }} pick
 * @param {Record<string, unknown>} answers already validated
 */
function composeOne({ procedureId, stage, variant }, answers) {
  if (!PROCEDURE_IDS.has(procedureId)) throw new EmailLibraryError('EMAIL_LIBRARY_UNKNOWN_PROCEDURE', 400, `Unknown procedure '${procedureId}'`);
  if (!STAGE_IDS.has(stage)) throw new EmailLibraryError('EMAIL_LIBRARY_UNKNOWN_STAGE', 400, `Unknown stage '${stage}'`);
  if (!VARIANT_IDS.has(variant)) throw new EmailLibraryError('EMAIL_LIBRARY_UNKNOWN_VARIANT', 400, `Unknown tone '${variant}'`);
  const off = Array.isArray(answers.services_off) ? answers.services_off : [];
  if (off.includes(procedureId)) {
    throw new EmailLibraryError('EMAIL_LIBRARY_SERVICE_OFF', 409, 'This office has switched that procedure off, so its emails are not in the library');
  }
  const narrowed = {
    ...SOURCE,
    procedure_blocks: SOURCE.procedure_blocks.filter((/** @type {any} */ p) => p.id === procedureId),
    frames: SOURCE.frames.filter((/** @type {any} */ f) => f.stage === stage && f.variant === variant),
  };
  const [email] = compose(narrowed, answers);
  if (!email) {
    throw new EmailLibraryError('EMAIL_LIBRARY_STAGE_NOT_USED', 409, 'That procedure has no email at that stage for this office');
  }
  return email;
}

/**
 * Fill `{{name}}` tokens from `values`. A name with no non-blank value is left as
 * its token and listed in `unresolved` (sorted, unique).
 * @param {string[]} texts
 * @param {Record<string, string|null|undefined>} values
 * @returns {{ texts: string[], unresolved: string[] }}
 */
function resolveMergeFields(texts, values) {
  const unresolved = new Set();
  const out = texts.map((text) =>
    text.replace(/\{\{(\w+)\}\}/g, (m, name) => {
      const v = Object.prototype.hasOwnProperty.call(values, name) ? values[name] : undefined;
      if (typeof v === 'string' && v.trim() !== '') return v;
      unresolved.add(name);
      return m;
    })
  );
  return { texts: out, unresolved: [...unresolved].sort() };
}

module.exports = {
  LIBRARY_CLINICALLY_APPROVED,
  LIBRARY_VERSION,
  SOURCE_SHA256,
  SOURCE_PATH,
  SOURCE,
  EmailLibraryError,
  compose,
  composeAll,
  composeOne,
  catalog,
  missingSettings,
  blankOptionalSettings,
  resolveMergeFields,
};

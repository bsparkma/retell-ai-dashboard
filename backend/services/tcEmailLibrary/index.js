'use strict';

/**
 * The TC patient email library (EL-1): WORDING CONFIG + PREVIEW, and (EL-2) the
 * library's sequences and the one renderer the nurture generator drafts from.
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
 * tcEmailLibrary.test.js walks its require graph to keep it that way. EL-2's
 * renderLibraryEmail returns CONTENT; the nurture generator is what writes it
 * into a draft, and services/messaging sendMessage is still the only send path.
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
const profileStore = require('./profileStore');
const contract = require('../../tc/contract.gen.cjs');

const SOURCE_PATH = path.join(__dirname, 'source.json');

/**
 * Has the doctor reviewed the clinical copy? TRUE since EL-2: library 1.3.0
 * (PR #358) IS the doctor's clinical review of the wording. It flips only by a
 * PR, and a library version whose wording has not been reviewed must flip it
 * back to false in the same PR that moves the source hash pin.
 *
 * What reads it: the catalog and preview responses (the page's status line),
 * and POST /api/tc/nurture/enrollments, which refuses to start a library
 * enrollment while it is false (409 LIBRARY_NOT_APPROVED).
 */
const LIBRARY_CLINICALLY_APPROVED = true;

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

// ── EL-2: the sequences, saved answers, and the nurture renderer ───────────

/**
 * The tracks the nurture generator may draft from the library. Each is ALSO the
 * id of its sequence in source.json (see LIBRARY_SEQUENCE_TRACKS in
 * shared/tc/nurture.ts for why the lookup is by id, not by `track`).
 */
const SEQUENCE_TRACKS = Object.freeze([...contract.LIBRARY_SEQUENCE_TRACKS]);

/**
 * Can a nurture track be drafted from the library? Today every NurtureTrackKey
 * can (the four keys ARE the four sequence ids), so this only says no once a
 * fifth track is added without a library sequence. The enrollment route asks
 * it through this module's exports, so its refusal (400
 * LIBRARY_TRACK_UNSUPPORTED) is testable on the real route.
 * @param {string} trackKey
 */
function isLibraryTrack(trackKey) {
  return SEQUENCE_TRACKS.includes(trackKey);
}

/**
 * "day 3" → 3. Anything else is a library this code cannot schedule.
 * @param {unknown} when @param {string} where
 */
function parseDay(when, where) {
  const m = /^day (\d+)$/.exec(String(when).trim());
  if (!m) throw new Error(`${where}: step day '${when}' is not "day N"`);
  return Number(m[1]);
}

/**
 * The source sequence for a track, or null.
 * @param {string} trackKey @param {ReadonlyArray<any>} [sequences]
 */
function sequenceSource(trackKey, sequences = SOURCE.sequences) {
  if (!SEQUENCE_TRACKS.includes(trackKey)) return null;
  return sequences.find((/** @type {any} */ q) => q.id === trackKey) || null;
}

/**
 * The library sequence for a nurture track, as [{ stage, day }] in order.
 *
 * With `procedureId`, the stages that procedure's block SKIPS are left out
 * (source.json 1.3.0: recare and new_patient skip cost_of_waiting; retainer and
 * sealants skip objection_fear), so every step that remains is one email
 * compose() really produces and "one email per step" holds. The skip list is
 * static source data, never an office answer, so an enrollment's steps never
 * move under it. Leaving a step out only widens the gaps around it, so it
 * cannot break a cap the full sequence passes (the boot check proves every
 * procedure's version anyway).
 *
 * Throws for a track the library has no sequence for: callers check
 * contract.isLibrarySequenceTrack first.
 * @param {string} trackKey
 * @param {string|null} [procedureId]
 * @returns {ReadonlyArray<{ stage: string, day: number }>}
 */
function sequenceFor(trackKey, procedureId) {
  const seq = sequenceSource(trackKey);
  if (!seq) throw new Error(`[tcEmailLibrary] no library sequence for track '${trackKey}'`);
  const block = procedureId ? SOURCE.procedure_blocks.find((/** @type {any} */ p) => p.id === procedureId) : null;
  const skip = new Set(block ? block.skip : []);
  return Object.freeze(
    seq.steps
      .filter((/** @type {any} */ st) => !skip.has(st.stage))
      .map((/** @type {any} */ st) => Object.freeze({ stage: st.stage, day: parseDay(st.when, `library/${trackKey}`) }))
  );
}

/**
 * Every way the library's sequences for the four nurture tracks break the hard
 * caps, as sentences (empty = lawful). The SAME checks the presets pass
 * (contract.scheduleCapViolations, factored out of presetViolations: ≤ 3 in any
 * rolling 7 days, ≥ 48h apart, ≤ 12), for the full sequence and for every
 * procedure's version of it, plus: every step names a real stage and says
 * "day N".
 * @param {ReadonlyArray<any>} [sequences] the source's, or a test fixture's
 * @returns {string[]}
 */
function librarySequenceViolations(sequences = SOURCE.sequences) {
  /** @type {string[]} */
  const out = [];
  for (const track of SEQUENCE_TRACKS) {
    const seq = sequenceSource(track, sequences);
    if (!seq) {
      out.push(`library/${track}: no sequence with id '${track}'`);
      continue;
    }
    /** @type {Array<{ touch: string, day: number }>} */
    let steps;
    try {
      steps = seq.steps.map((/** @type {any} */ st) => ({ touch: st.stage, day: parseDay(st.when, `library/${track}`) }));
    } catch (err) {
      out.push(/** @type {Error} */ (err).message);
      continue;
    }
    for (const st of steps) if (!STAGE_IDS.has(st.touch)) out.push(`library/${track}: unknown stage '${st.touch}'`);
    out.push(...contract.scheduleCapViolations(`library/${track}`, steps));
    for (const p of SOURCE.procedure_blocks) {
      const kept = steps.filter((st) => !p.skip.includes(st.touch));
      out.push(...contract.scheduleCapViolations(`library/${track}/${p.id}`, kept));
    }
  }
  return out;
}

/**
 * Throw (loudly, at require time) if a library sequence breaks a cap — exactly
 * like assertPresetsWithinCaps for the hand-written presets: a bad library is a
 * container that will not start, not a patient who got four emails in a week.
 * The generator checks the caps again on every touch (defence in depth).
 * @param {ReadonlyArray<any>} [sequences]
 */
function assertLibrarySequencesWithinCaps(sequences = SOURCE.sequences) {
  const v = librarySequenceViolations(sequences);
  if (v.length) {
    throw new Error(`[tcEmailLibrary] ${v.length} library sequence step(s) break the hard caps:\n  ${v.join('\n  ')}`);
  }
}

assertLibrarySequencesWithinCaps();

/**
 * A saved answers object without the keys a later library retired
 * (EMAIL_LIBRARY_RETIRED_SAVED_KEYS, #357). Read-side only: the row itself is
 * left as it is. Shared by the email library route and the nurture generator,
 * so both read a saved profile the same way.
 * @param {unknown} answers
 * @returns {unknown}
 */
function withoutRetiredKeys(answers) {
  if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) return answers;
  const out = { .../** @type {Record<string, unknown>} */ (answers) };
  for (const key of contract.EMAIL_LIBRARY_RETIRED_SAVED_KEYS) delete out[key];
  return out;
}

class LibraryRenderError extends Error {
  /**
   * @param {'UNRESOLVED_MERGE'|'SAVED_ANSWERS_STALE'} code
   * @param {string|null} token the unresolved merge field, for UNRESOLVED_MERGE
   * @param {string} message
   */
  constructor(code, token, message) {
    super(message);
    this.name = 'LibraryRenderError';
    this.code = code;
    this.token = token;
  }
}

/**
 * One office's SAVED answers, ready for compose(): retired keys stripped and
 * re-validated, the way the email library route reads them. {} when the office
 * never saved (compose() then uses every question's default, exactly as the
 * preview does). A stored row the validator refuses throws SAVED_ANSWERS_STALE:
 * drafting from answers this library cannot read would print wording nobody
 * chose.
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 * @param {string} office
 * @returns {Promise<Record<string, unknown>>}
 */
async function savedAnswersFor(db, office) {
  const stored = await profileStore.readProfile(db, office);
  if (!stored) return {};
  const v = contract.validateEmailLibraryAnswers(withoutRetiredKeys(stored.answers));
  if (!v.ok) {
    throw new LibraryRenderError('SAVED_ANSWERS_STALE', null, `SAVED_ANSWERS_STALE: ${v.code} at ${v.key}`);
  }
  return v.answers;
}

/** HTML-escape plain copy for an email text block. @param {string} s */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Plain library text → email_blocks: one `text` block per paragraph (a blank
 * line ends one). Inside a paragraph a run of "- " lines becomes one <ul>, and
 * the other lines are joined with <br>. Everything is HTML-escaped. No button
 * block: the library's own phone / reply line is already in the text.
 * @param {string} text
 */
function textToBlocks(text) {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  return paragraphs.map((para, i) => {
    /** @type {string[]} */
    const parts = [];
    /** @type {string[]} */
    let words = [];
    /** @type {string[]} */
    let items = [];
    const flushWords = () => {
      if (words.length) parts.push(`<p>${words.map(escapeHtml).join('<br>')}</p>`);
      words = [];
    };
    const flushItems = () => {
      if (items.length) parts.push(`<ul>${items.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>`);
      items = [];
    };
    for (const line of para.split('\n')) {
      if (line.startsWith('- ')) {
        flushWords();
        items.push(line.slice(2).trim());
      } else {
        flushItems();
        words.push(line);
      }
    }
    flushWords();
    flushItems();
    return contract.EmailBlock.parse({ id: `library-${i + 1}`, type: 'text', html: parts.join('') });
  });
}

/**
 * Render ONE library email for a nurture draft: compose it with the office's
 * saved answers (composeOne, behavior-identical to the full compose), fill
 * exactly the four merge fields a draft has values for, and shape the blocks.
 * CONTENT ONLY: this writes nothing and sends nothing.
 *
 * Any {{token}} left after the merge (a blank value, or a field a nurture draft
 * has no value for, such as an appointment date) THROWS UNRESOLVED_MERGE naming
 * the first one (sorted): a patient never receives "{{office_phone}}", and
 * never a blank where it was.
 *
 * Other composeOne refusals (EmailLibraryError: the office switched the
 * procedure off after enrolling, ...) propagate as they are.
 *
 * @param {{ office: string, answers: Record<string, unknown>, procedureId: string, stage: string, variant: string,
 *           merge: { first_name: string|null, office_name: string|null, office_phone: string|null, sender_name: string|null } }} input
 *        `answers` are `office`'s saved answers (savedAnswersFor); `office` is named in errors only
 * @returns {{ subject: string, preheader: string, bodyText: string, emailBlocks: object[] }}
 */
function renderLibraryEmail({ office, answers, procedureId, stage, variant, merge }) {
  const email = composeOne({ procedureId, stage, variant }, answers);
  const resolved = resolveMergeFields([email.subject, email.preheader, email.body_text], {
    first_name: merge.first_name,
    office_name: merge.office_name,
    office_phone: merge.office_phone,
    sender_name: merge.sender_name,
  });
  if (resolved.unresolved.length) {
    const token = resolved.unresolved[0];
    throw new LibraryRenderError('UNRESOLVED_MERGE', token, `UNRESOLVED_MERGE: {{${token}}} (office=${office})`);
  }
  const [subject, preheader, bodyText] = resolved.texts;
  return { subject, preheader, bodyText, emailBlocks: textToBlocks(bodyText) };
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
  SEQUENCE_TRACKS,
  isLibraryTrack,
  sequenceFor,
  librarySequenceViolations,
  assertLibrarySequencesWithinCaps,
  withoutRetiredKeys,
  savedAnswersFor,
  LibraryRenderError,
  renderLibraryEmail,
  textToBlocks,
};

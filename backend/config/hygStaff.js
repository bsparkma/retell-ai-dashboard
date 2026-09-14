'use strict';

/**
 * Who signs a hygiene note, and who supervised it — per office, as CONFIG.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A CONFIG FILE AND NOT A STRING IN A COMPONENT
 * ═════════════════════════════════════════════════════════════════════════════
 * A hygienist's note ends with a typed-name block: her name and RDH licence,
 * then the doctors who supervise the practice. Those names are real people, the
 * licence numbers are regulatory, and BOTH DIFFER PER OFFICE. A name compiled
 * into a React component is a name that cannot be corrected without a deploy,
 * and — worse — a name that can be rendered for the wrong practice, which is
 * the same class of defect as writing Roland's CommLog DefNum into Riley's
 * database.
 *
 * So the names live here, keyed by the frozen office keys, and the composer is
 * handed a block it did not author.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHERE THESE NAMES COME FROM
 * ═════════════════════════════════════════════════════════════════════════════
 * The practice's own Open Dental auto notes, vendored at
 * `docs/hyg-autonotes/autonotes.json`. Two of them ARE signature blocks — the
 * ones named `LW Signature` and `Raegan McGee ` — and they are the source of
 * every name and licence number below, verbatim apart from the punctuation
 * being made consistent.
 *
 * These are STAFF, not patients. Nothing in this file is PHI and nothing in it
 * may ever become PHI.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * A LICENCE IS NEVER INVENTED
 * ═════════════════════════════════════════════════════════════════════════════
 * `signatureBlock` looks the signed-in hygienist up by name. A hit prints
 * `Raegan McGee RDH #4251`. A MISS PRINTS THE NAME ALONE — never a blank
 * `RDH #`, never somebody else's number, and never a fabricated one. A licence
 * number is a claim about a person's registration, so the only honest answer to
 * "we do not have hers" is to say less.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * IT IS STILL UNSIGNED
 * ═════════════════════════════════════════════════════════════════════════════
 * B1, locked, and this file changes nothing about it. A typed name block is not
 * a signature; Open Dental's own signature block is the only thing allowed to
 * claim one. `stagedWriteComposer.js` appends the "Unsigned." line after the
 * block this file returns, and its test proves no composed line anywhere claims
 * otherwise.
 */

/**
 * The hygienists' licence numbers, keyed by a normalised name.
 *
 * A ROSTER, not an identity system. It answers exactly one question — "does
 * this person have an RDH number we know?" — and a name that is not here is
 * simply a name we do not have a number for. Adding a hygienist is one line.
 *
 * @type {Readonly<Record<string, { name: string, credential: string, license: string }>>}
 */
const HYGIENIST_ROSTER = Object.freeze({
  'raegan mcgee': { name: 'Raegan McGee', credential: 'RDH', license: '4251' },
  'laura williams': { name: 'Laura Williams', credential: 'RDH', license: '3667' },
});

/**
 * The supervising doctors whose names appear under a hygiene note, per office.
 *
 * Both offices currently list the same three, which is what the practice's own
 * two signature auto notes say. They are still declared PER OFFICE rather than
 * once: the day one practice adds an associate, the shape must already be the
 * one that can express it, and a shared array would have to be split under
 * pressure by whoever noticed.
 *
 * @type {Readonly<Record<string, ReadonlyArray<{ name: string, credential: string, license: string }>>>}
 */
const SUPERVISING_DOCTORS = Object.freeze({
  roland: Object.freeze([
    Object.freeze({ name: 'Beau Sparkman', credential: 'DDS', license: '6347' }),
    Object.freeze({ name: 'Blain VanNice', credential: 'DDS', license: '7971' }),
    Object.freeze({ name: 'Joe Farmer', credential: 'DDS', license: '7571' }),
  ]),
  valley: Object.freeze([
    Object.freeze({ name: 'Beau Sparkman', credential: 'DDS', license: '6347' }),
    Object.freeze({ name: 'Blain VanNice', credential: 'DDS', license: '7971' }),
    Object.freeze({ name: 'Joe Farmer', credential: 'DDS', license: '7571' }),
  ]),
});

/** `  Raegan  McGee ` and `raegan mcgee` are the same person to the roster. */
function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** `Raegan McGee RDH #4251`, or `Raegan McGee` when we have no number. */
function personLine(person) {
  if (!person.license) return person.name;
  return `${person.name} ${person.credential} #${person.license}`;
}

/**
 * The doctors this office's notes name. Frozen, and never another office's.
 *
 * An office with no entry gets an EMPTY list rather than a fallback. A note
 * naming the wrong practice's doctors would be worse than one naming none.
 *
 * @param {string} office
 * @returns {ReadonlyArray<{ name: string, credential: string, license: string }>}
 */
function supervisingDoctors(office) {
  return SUPERVISING_DOCTORS[office] || [];
}

/**
 * The doctor names the visit form offers for `Dr. ___ performed periodic exam`.
 *
 * The same list, as the strings the note prints. It goes over the wire so the
 * form and the note cannot offer and print different people.
 *
 * @param {string} office
 * @returns {string[]}
 */
function doctorOptions(office) {
  return supervisingDoctors(office).map((d) => d.name);
}

/**
 * The typed-name block for one office and one author.
 *
 * The author's line first, then the office's supervising doctors. NOT a
 * signature — the composer appends the "Unsigned." line, and nothing here says
 * otherwise.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ONE PERSON, ONE LINE
 * ═════════════════════════════════════════════════════════════════════════════
 * The author is not always a hygienist. When a doctor writes the note — Beau's
 * own walk on staging, 2026-09-09 — he appeared TWICE: once as the bare author
 * name the session gave, and again, three lines down, with his credential and
 * licence in the supervising list. A block naming the same person twice, once
 * worse than the other, reads like a defect in a chart note and is one.
 *
 * So an author who IS one of the office's doctors is printed once, as the
 * DOCTOR line — the better of the two, because it carries the credential and
 * the licence — and is left out of the list below. Best information wins, and
 * the list still names everyone else who supervises.
 *
 * A hygienist author is unaffected: she is not in the doctor list, so nothing
 * is removed and every doctor still appears.
 *
 * @param {{ office: string, hygienistName: string|null }} input
 *   `hygienistName` is the AUTHOR's name — the parameter keeps its name so
 *   every existing call site reads the same, but a doctor may be the author.
 * @returns {string[]} lines, possibly empty when we know nothing at all
 */
function signatureBlock({ office, hygienistName }) {
  const lines = [];
  const key = normalizeName(hygienistName);
  const doctors = supervisingDoctors(office);
  // Case-insensitive, and on the same normalisation the roster uses, so
  // "beau  sparkman" from a session is the same person as the config's entry.
  const authorIsDoctor = key ? doctors.find((d) => normalizeName(d.name) === key) : undefined;

  if (key) {
    // In order of how much we know: the doctor entry (name + credential +
    // licence), then the hygienist roster's, then what she signed in as. The
    // licence is only ever config's — never invented, never somebody else's.
    const known = authorIsDoctor || HYGIENIST_ROSTER[key];
    lines.push(known ? personLine(known) : String(hygienistName).trim());
  }
  for (const doctor of doctors) {
    // Already printed above, as the author. One person, one line.
    if (authorIsDoctor && doctor === authorIsDoctor) continue;
    lines.push(personLine(doctor));
  }
  return lines;
}

module.exports = {
  signatureBlock,
  supervisingDoctors,
  doctorOptions,
  // Exported for the tests and for nothing else — the roster is read through
  // signatureBlock so the "never invent a licence" rule has one home.
  HYGIENIST_ROSTER,
  SUPERVISING_DOCTORS,
  normalizeName,
  personLine,
};

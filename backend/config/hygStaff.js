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
 * The hygienists, as their note's attribution names them: FULL NAME and RDH
 * licence, the same style as the doctors' lines.
 *
 * A ROSTER, not an identity system. Each entry says how she prints
 * (`fullName`, `credential`, `license`) and how CareIN recognises her when she
 * is signed in (`signIn`: the sign-in names and emails that are her, compared
 * normalised). A sign-in that matches nothing prints as the name she signed in
 * with, and nothing else.
 *
 * FEEDBACK ROUND 1: the practice is sending the full names and licence numbers
 * for everyone. Until a number arrives, an entry carries `license: null` and
 * prints the full name ALONE — never `RDH #`, never a placeholder, never a
 * number somebody guessed.
 *
 * PRACTICE STAFF PAGE: this list is now the FALLBACK. The office manager enters
 * hygienists in the hyg_staff table (services/hyg/staffStore.js), and an
 * office with any row there prints from it alone. This list is used only for
 * an office with no rows yet, so nothing changed before anyone entered data.
 *
 * @type {ReadonlyArray<Readonly<{ fullName: string, credential: string, license: string|null, signIn: readonly string[] }>>}
 */
const HYGIENISTS = Object.freeze([
  Object.freeze({ fullName: 'Raegan McGee', credential: 'RDH', license: '4251', signIn: Object.freeze(['Raegan McGee']) }),
  Object.freeze({ fullName: 'Laura Williams', credential: 'RDH', license: '3667', signIn: Object.freeze(['Laura Williams']) }),
]);

/**
 * The roster keyed by every normalised sign-in name and email it lists, so a
 * lookup is one Map read. Built once; `signatureBlock` takes another for tests.
 *
 * An entry with `matchName: false` is matched on its sign-ins ONLY — the
 * hyg_staff rows, where two people may share a name but never a sign-in.
 *
 * @param {ReadonlyArray<{ fullName: string, credential: string, license: string|null, signIn: readonly string[], matchName?: boolean }>} list
 */
function indexRoster(list) {
  const byKey = new Map();
  for (const h of list) {
    const keys = h.matchName === false ? [...h.signIn] : [h.fullName, ...h.signIn];
    for (const key of keys) {
      const k = normalizeName(key);
      if (k) byKey.set(k, h);
    }
  }
  return byKey;
}

/**
 * Kept under its old name for the callers and tests that read it: the roster,
 * keyed by normalised name, each value in the shape `personLine` prints.
 */
const HYGIENIST_ROSTER = Object.freeze(
  Object.fromEntries(
    [...indexRoster(HYGIENISTS)].map(([k, h]) => [
      k,
      Object.freeze({ name: h.fullName, credential: h.credential, license: h.license }),
    ])
  )
);

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

/**
 * TEST SEAM — a synthetic roster in place of the real one, so no test has to
 * name real staff (Practice staff page). null restores this file's lists.
 * Production never calls it; it only ever REPLACES both lists, so a test cannot
 * end up half real and half synthetic.
 *
 * @type {null | { doctors: Readonly<Record<string, ReadonlyArray<{ name: string, credential: string, license: string }>>>,
 *                 hygienists: ReadonlyArray<{ fullName: string, credential: string, license: string|null, signIn: readonly string[] }> }}
 */
let testRoster = null;

/**
 * @param {null | { doctors: Record<string, Array<{ name: string, credential: string, license: string }>>,
 *                  hygienists: Array<{ fullName: string, credential: string, license: string|null, signIn: string[] }> }} roster
 */
function setRosterForTests(roster) {
  testRoster = roster
    ? Object.freeze({
        doctors: Object.freeze(
          Object.fromEntries(
            Object.entries(roster.doctors).map(([k, list]) => [k, Object.freeze(list.map((d) => Object.freeze({ ...d })))])
          )
        ),
        hygienists: Object.freeze(roster.hygienists.map((h) => Object.freeze({ ...h, signIn: Object.freeze([...h.signIn]) }))),
      })
    : null;
}

/** Two spellings of one name are the same person to the roster. */
function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * `Full Name RDH #1234`, or `Full Name` when we have no number. A blank
 * or whitespace licence is "no number", so a half-filled entry prints the name.
 */
function personLine(person) {
  const license = typeof person.license === 'string' ? person.license.trim() : '';
  if (!license) return person.name;
  return `${person.name} ${person.credential} #${license}`;
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
  const doctors = testRoster ? testRoster.doctors : SUPERVISING_DOCTORS;
  return doctors[office] || [];
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
 * The author's line first, then the EXAMINING doctor the slip names — not the
 * whole office list (feedback round 1; see the loop below). NOT a
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
 * A hygienist author is unaffected: she is not a doctor, so the examining
 * doctor still gets their own line.
 *
 * @param {{ office: string, hygienistName: string|null, hygienistEmail?: string|null,
 *           examiningDoctors?: readonly string[],
 *           roster?: ReadonlyArray<{ fullName: string, credential: string, license: string|null, signIn: readonly string[], matchName?: boolean }> | null }} input
 *   `hygienistName` is the AUTHOR's name — the parameter keeps its name so
 *   every existing call site reads the same, but a doctor may be the author.
 *   `hygienistEmail` is who signed in, matched against the roster's `signIn`.
 *   `examiningDoctors` is the slip's examining-doctor pick (noteFields.drs).
 *   `roster` is this office's hyg_staff roster (staffStore.signatureRoster);
 *   absent or null — an office with no rows — falls back to HYGIENISTS.
 * @returns {string[]} lines, possibly empty when we know nothing at all
 */
function signatureBlock({ office, hygienistName, hygienistEmail = null, examiningDoctors = [], roster = null }) {
  const lines = [];
  const key = normalizeName(hygienistName);
  const emailKey = normalizeName(hygienistEmail);
  const doctors = supervisingDoctors(office);
  const hygienists = indexRoster(roster || (testRoster ? testRoster.hygienists : HYGIENISTS));
  // Case-insensitive, and on the same normalisation the roster uses, so
  // "beau  sparkman" from a session is the same person as the config's entry.
  const authorIsDoctor = key ? doctors.find((d) => normalizeName(d.name) === key) : undefined;

  if (key || emailKey) {
    // In order of how much we know: the doctor entry (name + credential +
    // licence), then the hygienist roster's — by name, then by the email she
    // signed in with — then what she signed in as. The licence is only ever
    // config's: never invented, never somebody else's.
    const hyg = (key && hygienists.get(key)) || (emailKey && hygienists.get(emailKey)) || null;
    if (authorIsDoctor) lines.push(personLine(authorIsDoctor));
    else if (hyg) lines.push(personLine({ name: hyg.fullName, credential: hyg.credential, license: hyg.license }));
    else if (key) lines.push(String(hygienistName).trim());
  }

  /*
   * THE EXAMINING DOCTOR ONLY (feedback round 1).
   *
   * The block used to list every supervising doctor in the office under every
   * note, whoever examined. A note names who did the work: the doctor picked in
   * the slip's examining-doctor field (`Dr. ___ performed … exam`), and nobody
   * else. Nobody picked — or a template with no exam — names no doctor, and the
   * note is still a complete note.
   *
   * A pick is matched against THIS office's doctors, so a licence comes only
   * from this office's config. A picked name the office does not list prints
   * as the name alone, the same rule a hygienist the roster does not know gets.
   */
  const printed = new Set();
  for (const picked of Array.isArray(examiningDoctors) ? examiningDoctors : []) {
    const pk = normalizeName(picked);
    if (!pk || printed.has(pk)) continue;
    printed.add(pk);
    // Already printed above, as the author. One person, one line.
    if (authorIsDoctor && normalizeName(authorIsDoctor.name) === pk) continue;
    const doctor = doctors.find((d) => normalizeName(d.name) === pk);
    lines.push(doctor ? personLine(doctor) : String(picked).trim());
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
  HYGIENISTS,
  SUPERVISING_DOCTORS,
  normalizeName,
  personLine,
  setRosterForTests,
};

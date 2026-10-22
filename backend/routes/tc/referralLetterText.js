'use strict';

/**
 * (R5) What a referral email SAYS — the approved template, filled from the
 * referral and its directory row. Pure: no I/O, no clock of its own, no
 * config read; the caller hands in everything, so a test can pin the words.
 *
 *   SUBJECT  Referral from {office} — {first} {last initial}., {short reason}
 *   BODY     greeting to Dr. {specialist last name}
 *            one line that the referral letter follows
 *            the letter: office header, date, patient full name + DOB,
 *              "We are referring {first} for {reason}", clinical summary,
 *              teeth, urgency, the doctor's note VERBATIM when present, the
 *              attachment line, the findings/two-weeks paragraph, and the
 *              signature: Dr. {referring provider}, office, phone, reply-to.
 *
 * PLAIN TEXT ONLY. The shared renderer turns blank lines into paragraphs and
 * escapes everything; nothing here can become a link or a button.
 *
 * DOB: the referral row does not carry one, and this slice reads nothing from
 * Open Dental, so the letter says the date of birth is available on request
 * (DOB_LINE). Snapshotting it when the referral is created is a later slice.
 */

const { contract } = require('./helpers');

/** The letter's date-of-birth line until a DOB is stored with the referral. */
const DOB_LINE = 'Date of birth: available from our office on request';

/** The two-weeks paragraph, exactly as approved. */
const FINDINGS_PARAGRAPH =
  'Please send your findings and treatment summary to our office. If the patient has not scheduled within two weeks, we would appreciate a quick note — we track every referral to completion.';

/** How the "files that did not fit" line reads, exactly as approved. */
const ON_REQUEST_LEAD = 'Additional images available on request';

/** One line: no CR/LF, collapsed spaces. @param {unknown} v */
function oneLine(v) {
  return String(v ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * "Last, First Middle" or "First Last" → { first, last, full }.
 * @param {unknown} patientName
 */
function nameParts(patientName) {
  const s = oneLine(patientName);
  if (!s) return { first: '', last: '', full: '' };
  if (s.includes(',')) {
    const [lastPart, ...rest] = s.split(',');
    const given = oneLine(rest.join(' '));
    const last = oneLine(lastPart);
    const first = given.split(' ')[0] || '';
    return { first, last, full: oneLine(`${given} ${last}`) };
  }
  const words = s.split(' ');
  return { first: words[0], last: words.length > 1 ? words[words.length - 1] : '', full: s };
}

/** The specialist's last name from "Dr. Jane Rivera, DDS, MS", or ''. @param {unknown} specialistName */
function specialistLastName(specialistName) {
  const beforeCredentials = oneLine(specialistName).split(',')[0];
  const words = beforeCredentials
    .replace(/^(dr\.?|doctor)\s+/i, '')
    .split(' ')
    .filter(Boolean);
  return words.length ? words[words.length - 1] : '';
}

/** A reason short enough for a subject line, cut at a word. @param {unknown} reason */
function shortReason(reason, max = 60) {
  const s = oneLine(reason);
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `${(at > 20 ? cut.slice(0, at) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

/** "Possible cracked tooth" → "possible cracked tooth"; "TMJ pain" stays. @param {string} s */
function inSentence(s) {
  return /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}

/** [3, 14] → "#3, #14"; "mouth" → "Full mouth"; [] → "Not specified". @param {unknown} teeth */
function teethText(teeth) {
  if (teeth === 'mouth') return 'Full mouth';
  if (Array.isArray(teeth) && teeth.length) return teeth.map((t) => `#${t}`).join(', ');
  return 'Not specified';
}

/** "DOC1" → "Dr. DOC1"; "Dr. Smith" stays; "" → "". @param {unknown} provider */
function signedBy(provider) {
  const p = oneLine(provider);
  if (!p) return '';
  return /^(dr\.?|doctor)\s/i.test(p) ? p : `Dr. ${p}`;
}

/** The letter date, in the office's day. @param {Date} at @param {string} timeZone */
function letterDate(at, timeZone) {
  return new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'long', day: 'numeric' }).format(at);
}

/**
 * The subject and the plain-text body.
 *
 * @param {{
 *   referral: { patient_name: string, reason: string, narrative?: string|null, teeth: unknown,
 *               urgency: 'routine'|'soon'|'urgent', doctor_note?: string|null, referring_provider?: string|null },
 *   entry: { specialist_name?: string|null },
 *   office: { name: string, address: string|null, phone: string|null, replyTo: string },
 *   attached: string[],        file names that are attached, in upload order
 *   onRequest: string[],       file names that did not fit, in upload order
 *   at: Date,
 *   timeZone: string,
 * }} input
 * @returns {{ subject: string, text: string }}
 */
function composeReferralLetter({ referral, entry, office, attached, onRequest, at, timeZone }) {
  const patient = nameParts(referral.patient_name);
  const initial = patient.last ? `${patient.last[0].toUpperCase()}.` : '';
  const who = oneLine(`${patient.first} ${initial}`);
  const reason = oneLine(referral.reason);

  const subject = oneLine(`Referral from ${office.name} — ${who}${who ? ', ' : ''}${shortReason(reason)}`);

  const last = specialistLastName(entry.specialist_name);
  const greeting = last ? `Dear Dr. ${last},` : 'Dear Doctor,';

  const header = [office.name, office.address, office.phone].filter(Boolean).join('\n');
  const narrative = String(referral.narrative ?? '').trim();
  const doctorNote = referral.doctor_note == null ? '' : String(referral.doctor_note);

  const files = [];
  if (attached.length) files.push(`Attached: ${attached.join(', ')}`);
  if (onRequest.length) files.push(`${ON_REQUEST_LEAD}: ${onRequest.join(', ')}`);
  if (!files.length) files.push('No attachments.');

  const signature = [
    'Sincerely,',
    signedBy(referral.referring_provider),
    office.name,
    office.phone,
    `Reply to: ${office.replyTo}`,
  ]
    .filter(Boolean)
    .join('\n');

  const paragraphs = [
    greeting,
    `Please find our referral letter for ${who || 'your new patient'} below.`,
    header,
    letterDate(at, timeZone),
    [`Patient: ${patient.full}`, DOB_LINE].join('\n'),
    `We are referring ${patient.first || 'this patient'} for ${inSentence(reason)}${/[.!?]$/.test(reason) ? '' : '.'}`,
    `Clinical summary:\n${narrative || 'None provided.'}`,
    [`Teeth: ${teethText(referral.teeth)}`, `Urgency: ${contract.TC_REFERRAL_URGENCY_LABELS[referral.urgency] || referral.urgency}`].join('\n'),
    // Verbatim: the doctor's own words, as stored. Never trimmed or filled.
    ...(doctorNote.trim() ? [`Doctor's note:\n${doctorNote}`] : []),
    files.join('\n'),
    FINDINGS_PARAGRAPH,
    signature,
  ];
  return { subject, text: paragraphs.join('\n\n') };
}

module.exports = {
  DOB_LINE,
  FINDINGS_PARAGRAPH,
  ON_REQUEST_LEAD,
  nameParts,
  specialistLastName,
  shortReason,
  teethText,
  composeReferralLetter,
};

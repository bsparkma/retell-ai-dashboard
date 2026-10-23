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
 * escapes everything; nothing here can become a link or a button. (R5b) The
 * letter's two buttons, and the patient notice's one, are separate `actions`
 * the renderer draws under the text from the labels below; the text only
 * says they are there.
 *
 * R5b — THE PATIENT'S NOTICE (composePatientNotice), in the PM's approved
 * words: who they are referred to, the specialist's phone, and a button to
 * say they scheduled. Minimum necessary: the patient's FIRST name, the
 * referring doctor, the practice names and phones, and whether X-rays went.
 * Never the clinical reason, teeth, urgency, notes, DOB or file names.
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

/** (R5b) The letter's two buttons, exactly as the brief named them. */
const SPECIALIST_LINK_LABELS = Object.freeze({
  received: 'We received this referral',
  scheduled: 'The patient is scheduled',
});

/** (R5b) The line above the letter's buttons. */
const LINKS_PARAGRAPH =
  'One click lets us know where things stand: use the buttons below to tell us you received this referral, and again once the patient is scheduled. No sign-in is needed.';

/** (R5b) The patient notice's one button. */
const PATIENT_LINK_LABEL = "I've scheduled my appointment";

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
 *   withLinks?: boolean,       (R5b) say the buttons are below
 * }} input
 * @returns {{ subject: string, text: string }}
 */
function composeReferralLetter({ referral, entry, office, attached, onRequest, at, timeZone, withLinks = false }) {
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
    ...(withLinks ? [LINKS_PARAGRAPH] : []),
  ];
  return { subject, text: paragraphs.join('\n\n') };
}

/**
 * (R5b) What the patient notice says the visit is FOR. The referral's
 * `reason` is clinical shorthand written for the specialist, so it is never
 * used here. A staff-editable plain-language reason is the PM's design; until
 * that field exists, this honest generic phrase stands in.
 */
const PATIENT_REASON_FALLBACK = 'a specialist consultation';

/** (R5b) The sources a patient was SEEN for: the notice may say "as we discussed at your visit". */
const VISIT_SOURCE_KINDS = Object.freeze(['hyg_visit', 'checkout']);

/**
 * (R5b) The patient's notice, in the PM's approved words: subject, the text
 * ABOVE the button, and the text BELOW it (the renderer draws the button
 * between them).
 *
 * @param {{
 *   patientName: string,       the referral's stored name; only the first name is used
 *   referringProvider?: string|null,
 *   entry: { practice_name?: string|null, specialist_name?: string|null, phone?: string|null },
 *   office: { name: string, phone: string|null },
 *   withFiles: boolean,        files went WITH the letter (not just "on request")
 *   sourceKind: string,        where the referral was started (tc_referrals.source_kind)
 * }} input
 * @returns {{ subject: string, text: string, after: string }}
 */
function composePatientNotice({ patientName, referringProvider = null, entry, office, withFiles, sourceKind }) {
  const first = nameParts(patientName).first;
  const specialistOffice = oneLine(entry.practice_name) || oneLine(entry.specialist_name) || 'the specialist';
  const phone = oneLine(entry.phone);
  const doctor = signedBy(referringProvider);
  // "As we discussed at your visit," only where there WAS a visit behind it
  // (PM ruling): a referral started from a call, a case or by hand drops it.
  const opening = VISIT_SOURCE_KINDS.includes(sourceKind) ? 'As we discussed at your visit, ' : '';

  const subject = oneLine(`We've sent your referral to ${specialistOffice}`);
  const text = [
    first ? `Hi ${first},` : 'Hello,',
    `${opening}${doctor || office.name} has referred you to ${specialistOffice} for ${PATIENT_REASON_FALLBACK}. We've already sent them your information${withFiles ? ' and X-rays' : ''}, so they'll know exactly why you're coming.`,
    phone
      ? `Here's what to do next: call them at ${phone} to set up your appointment.`
      : `Here's what to do next: call them to set up your appointment.${office.phone ? ` If you need their number, call us at ${office.phone}.` : ''}`,
    "Already scheduled? Tap below and tell us the date — we'll make sure everything is ready on our end.",
  ].join('\n\n');
  const after = [
    `After your specialist visit, we'll follow up to plan any remaining treatment here at ${office.name}. If anything comes up in the meantime, just reply to this email${office.phone ? ` or call us at ${office.phone}` : ''}.`,
    "We're with you through the whole process.",
    office.name,
  ].join('\n\n');
  return { subject, text, after };
}

module.exports = {
  DOB_LINE,
  FINDINGS_PARAGRAPH,
  ON_REQUEST_LEAD,
  SPECIALIST_LINK_LABELS,
  LINKS_PARAGRAPH,
  PATIENT_LINK_LABEL,
  PATIENT_REASON_FALLBACK,
  VISIT_SOURCE_KINDS,
  composePatientNotice,
  nameParts,
  specialistLastName,
  shortReason,
  teethText,
  composeReferralLetter,
};

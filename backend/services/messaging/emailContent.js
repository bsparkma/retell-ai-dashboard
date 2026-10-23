'use strict';

/**
 * What a TC email says, assembled server-side (queue item 40).
 *
 * The rendering itself is shared/tc/emailRender.ts (through the contract
 * bundle), the ONE implementation. This file only decides WHICH values go in:
 *
 *   patient.firstName   the case's patient first name. The only case fact.
 *   practice.name       the office's practice name (R5c: Settings -> Email
 *                       identity, else TC_EMAIL_PRACTICE_NAME_<OFFICE>), else
 *                       its display name (config/officeAgents)
 *   practice.address    TC_EMAIL_PRACTICE_ADDRESS_<OFFICE>, optional
 *   practice.phone      the office's phone (R5c: Settings -> Email identity,
 *                       else TC_EMAIL_PRACTICE_PHONE_<OFFICE>), optional
 *   sender.name         the TC who wrote the draft (their SSO display name)
 *   sender.email        the office's Reply-To, if one is set. NEVER the TC's
 *                       own mailbox: a patient's reply should reach the
 *                       practice, not a personal inbox.
 *
 * Minimum necessary: no treatment, fee, appointment or clinical value is ever
 * pulled from a case into an email here (the case.* tokens stay unfilled; see
 * the renderer's header). The follow-up's private `talking_point` is never read.
 *
 * A template draft is a SNAPSHOT: its blocks and subject are filled when the
 * draft is written and stored on the row, so what the TC previewed is what is
 * sent, even if somebody edits the library template afterwards.
 */

const contract = require('../../tc/contract.gen.cjs');
const odOffices = require('../../config/odOffices');
const acsConfig = require('../../config/acsEmail');
const { firstNameOf } = require('./templates');

/**
 * (R5c) The name an email from this office signs with: ONE identity per
 * office, the same for a patient email and a referral letter.
 * @param {string} office
 */
function practiceNameOf(office) {
  return acsConfig.practiceNameFor(office) || odOffices.describeOffice(office).officeName;
}

/** @param {string} office */
function practiceValues(office) {
  const details = acsConfig.practiceDetailsFor(office);
  return {
    'practice.name': practiceNameOf(office),
    'practice.address': details.address,
    'practice.phone': details.phone,
    'sender.email': acsConfig.replyToFor(office),
  };
}

/**
 * Every value a render may use for this office + case.
 * @param {string} office
 * @param {{ patientName?: string|null, senderName?: string|null }} ctx
 */
function mergeValues(office, { patientName = null, senderName = null } = {}) {
  return {
    ...practiceValues(office),
    'patient.firstName': firstNameOf(patientName) || 'there',
    'sender.name': typeof senderName === 'string' ? senderName.slice(0, 120) : null,
  };
}

/** The footer every email carries. @param {string} office @param {string|null} unsubscribeUrl */
function footerFor(office, unsubscribeUrl) {
  const details = acsConfig.practiceDetailsFor(office);
  return {
    practiceName: practiceNameOf(office),
    practiceAddress: details.address,
    practicePhone: details.phone,
    unsubscribeUrl,
  };
}

/**
 * Snapshot a library template for one case: the stored draft content.
 * @param {{ subject: unknown, preheader: unknown, blocks: unknown }} template
 * @param {string} office
 * @param {{ patientName?: string|null, senderName?: string|null }} ctx
 * @returns {{ subject: string, preheader: string, blocks: unknown[], body: string }}
 */
function snapshotTemplate(template, office, ctx) {
  const values = mergeValues(office, ctx);
  const blocks = contract.fillBlockTokens(template.blocks, values);
  const subject = contract
    .fillMergeTokens(typeof template.subject === 'string' ? template.subject : '', values)
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 300);
  const preheader = contract
    .fillMergeTokens(typeof template.preheader === 'string' ? template.preheader : '', values)
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 300);
  const body = contract.emailBodyText({ kind: 'blocks', blocks }, values).slice(0, 8000);
  return { subject, preheader, blocks, body };
}

/**
 * Render a stored message row (draft or sending) to what is sent.
 * Practice values only: patient values were filled into the snapshot (or
 * typed by the TC) when the draft was written.
 * @param {{ subject?: string|null, body?: string|null, email_blocks?: unknown, email_preheader?: string|null }} row
 * @param {string} office
 * @param {string|null} unsubscribeUrl  null in a preview
 */
function renderRow(row, office, unsubscribeUrl) {
  const content =
    row.email_blocks != null
      ? { kind: 'blocks', blocks: row.email_blocks }
      : { kind: 'text', body: row.body ?? '' };
  return contract.renderEmail({
    subject: row.subject ?? '',
    preheader: row.email_preheader ?? '',
    content,
    values: practiceValues(office),
    footer: footerFor(office, unsubscribeUrl),
  });
}

/**
 * (R5) A referral letter, rendered by the same shared renderer with the same
 * system footer (practice name, address, phone, the unsubscribe link). Two
 * differences, both for who receives it: the footer says WHY a specialist's
 * office got it (it is not the practice's patient), and the body may run to
 * the renderer's ceiling, because the letter carries the clinical notes and
 * the doctor's note verbatim — cutting them at the patient-email limit would
 * drop clinical text without a word.
 *
 * The text is composed by the caller (routes/tc/referralLetterText.js); no
 * merge token is filled here.
 * (R5b) `actions` are the letter's two link buttons, drawn under the text.
 * @param {{ office: string, subject: string, text: string, unsubscribeUrl: string|null,
 *           actions?: Array<{ label: string, href: string }> }} input
 * @returns {{ subject: string, html: string, text: string }}
 */
function renderReferralLetter({ office, subject, text, unsubscribeUrl, actions = [] }) {
  const footer = footerFor(office, unsubscribeUrl);
  return contract.renderEmail({
    subject,
    preheader: '',
    content: { kind: 'text', body: text, maxChars: contract.EMAIL_TEXT_BODY_CEILING, literal: true, actions },
    values: {},
    footer: { ...footer, audience: 'referral' },
  });
}

/**
 * (R5b) The patient's notice that they were referred: the same renderer with
 * the PATIENT footer ("you are a patient of …"), the default text limit, and
 * its one button. Composed by the caller (routes/tc/referralLetterText.js);
 * no merge token is filled.
 * `after` is the closing drawn below the button.
 * @param {{ office: string, subject: string, text: string, after?: string, unsubscribeUrl: string|null,
 *           actions: Array<{ label: string, href: string }> }} input
 * @returns {{ subject: string, html: string, text: string }}
 */
function renderReferralPatientNotice({ office, subject, text, after = '', unsubscribeUrl, actions }) {
  return contract.renderEmail({
    subject,
    preheader: '',
    content: { kind: 'text', body: text, literal: true, actions, after },
    values: {},
    footer: footerFor(office, unsubscribeUrl),
  });
}

module.exports = {
  mergeValues,
  practiceValues,
  practiceNameOf,
  footerFor,
  snapshotTemplate,
  renderRow,
  renderReferralLetter,
  renderReferralPatientNotice,
};

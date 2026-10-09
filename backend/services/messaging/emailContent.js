'use strict';

/**
 * What a TC email says, assembled server-side (queue item 40).
 *
 * The rendering itself is shared/tc/emailRender.ts (through the contract
 * bundle), the ONE implementation. This file only decides WHICH values go in:
 *
 *   patient.firstName   the case's patient first name. The only case fact.
 *   practice.name       the office's display name (config/officeAgents)
 *   practice.address    TC_EMAIL_PRACTICE_ADDRESS_<OFFICE>, optional
 *   practice.phone      TC_EMAIL_PRACTICE_PHONE_<OFFICE>, optional
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

/** @param {string} office */
function practiceValues(office) {
  const details = acsConfig.practiceDetailsFor(office);
  return {
    'practice.name': odOffices.describeOffice(office).officeName,
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
    practiceName: odOffices.describeOffice(office).officeName,
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

module.exports = { mergeValues, practiceValues, footerFor, snapshotTemplate, renderRow };

'use strict';

/**
 * Follow-up message templates — plain fill-in-the-blanks, NO AI (item 38).
 *
 * A template produces a DRAFT. A human reads it, may edit it, and clicks Send;
 * nothing here sends anything.
 *
 * Deliberately NOT included in the text: the follow-up's `talking_point`. That
 * field is the TC's private prompt to herself ("mention CareCredit; husband is
 * the decision maker") and must never be pasted into a patient's phone. The
 * only case facts a template uses are the patient's FIRST name and the
 * practice's name.
 *
 * Keys are stored in tc_messages.template_id (text, no FK) so a sent message
 * says which template it started from.
 */

/** @typedef {{ key: string, sms: string, emailSubject: string, email: string }} Template */

const SMS_FOOTER = ' Reply STOP to opt out.';

/** @type {Record<string, Template>} */
const TEMPLATES = Object.freeze({
  'followup.default': {
    key: 'followup.default',
    sms:
      'Hi {firstName}, this is {officeName} following up on the treatment plan we went over. ' +
      'Do you have any questions we can help with? Reply here or give us a call.',
    emailSubject: 'Following up from {officeName}',
    email:
      'Hi {firstName},\n\nThis is {officeName} following up on the treatment plan we went over. ' +
      'If you have any questions, just reply to this email or give us a call.\n\nThank you,\n{officeName}',
  },
  'nurture.check_in': {
    key: 'nurture.check_in',
    sms: 'Hi {firstName}, {officeName} checking in. We are here whenever you are ready to talk about your treatment.',
    emailSubject: 'Checking in from {officeName}',
    email:
      'Hi {firstName},\n\nJust checking in. We are here whenever you are ready to talk about your treatment.\n\n' +
      'Thank you,\n{officeName}',
  },
  'nurture.financing': {
    key: 'nurture.financing',
    sms:
      'Hi {firstName}, this is {officeName}. We have payment options that may help with your treatment. ' +
      'Want us to walk you through them?',
    emailSubject: 'Payment options from {officeName}',
    email:
      'Hi {firstName},\n\nWe have payment options that may help with your treatment. ' +
      'Reply to this email and we would be glad to walk you through them.\n\nThank you,\n{officeName}',
  },
  'nurture.seasonal': {
    key: 'nurture.seasonal',
    sms: 'Hi {firstName}, {officeName} here. If you would like to get your treatment on the calendar, we would love to help.',
    emailSubject: 'A note from {officeName}',
    email:
      'Hi {firstName},\n\nIf you would like to get your treatment on the calendar, we would love to help.\n\n' +
      'Thank you,\n{officeName}',
  },
});

/**
 * Pick the template for a follow-up row.
 * @param {{ kind?: string, nurture_type?: string|null } | null} followup
 * @returns {Template}
 */
function templateFor(followup) {
  if (followup && followup.kind === 'nurture') {
    const key = `nurture.${followup.nurture_type || 'check_in'}`;
    if (TEMPLATES[key]) return TEMPLATES[key];
    return TEMPLATES['nurture.check_in'];
  }
  return TEMPLATES['followup.default'];
}

/** First word of a stored "First Last" or "Last, First" name; '' if none. */
function firstNameOf(patientName) {
  if (typeof patientName !== 'string') return '';
  const s = patientName.trim();
  if (!s) return '';
  if (s.includes(',')) {
    const after = s.split(',')[1];
    return after ? after.trim().split(/\s+/)[0] || '' : '';
  }
  return s.split(/\s+/)[0] || '';
}

function fill(text, vars) {
  return text.replace(/\{(\w+)\}/g, (_m, k) => (vars[k] != null ? String(vars[k]) : ''));
}

/**
 * Fill a template for one channel.
 * @param {Template} template
 * @param {'sms'|'email'} channel
 * @param {{ patientName: string, officeName: string }} ctx
 * @returns {{ templateId: string, body: string, subject: string|null }}
 */
function render(template, channel, ctx) {
  const firstName = firstNameOf(ctx.patientName) || 'there';
  const vars = { firstName, officeName: ctx.officeName };
  if (channel === 'sms') {
    return { templateId: template.key, body: fill(template.sms, vars) + SMS_FOOTER, subject: null };
  }
  return { templateId: template.key, body: fill(template.email, vars), subject: fill(template.emailSubject, vars) };
}

module.exports = { TEMPLATES, templateFor, render, firstNameOf, SMS_FOOTER };

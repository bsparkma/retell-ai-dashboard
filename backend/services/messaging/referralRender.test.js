'use strict';

/**
 * (R5) The shared renderer's two additions, through the bundled contract the
 * backend uses: the footer's audience (a specialist's office is told why it
 * got the email; a patient's footer is unchanged), and a text body's limit
 * (the default stays 8000; a referral letter may run to the ceiling and keeps
 * its `{{…}}` text verbatim with `literal`).
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const contract = require('../../tc/contract.gen.cjs');
const emailContent = require('./emailContent');

const FOOTER = { practiceName: 'Roland Family Dental', unsubscribeUrl: 'https://dashboard.example.test/u?t=x' };

test("the patient footer is unchanged; the referral footer says why a specialist's office got it", () => {
  const patient = contract.renderEmail({ subject: 's', content: { kind: 'text', body: 'b' }, values: {}, footer: FOOTER });
  assert.match(patient.text, /You are receiving this email because you are a patient of Roland Family Dental\./);
  assert.match(patient.html, /<div>You are receiving this email because you are a patient of Roland Family Dental\.<\/div>/);
  const referral = contract.renderEmail({
    subject: 's',
    content: { kind: 'text', body: 'b' },
    values: {},
    footer: { ...FOOTER, audience: 'referral' },
  });
  assert.match(referral.text, /You are receiving this email because Roland Family Dental sent your office a patient referral\./);
  assert.doesNotMatch(referral.text, /patient of/);
  assert.match(referral.html, /Unsubscribe from these emails/, 'the unsubscribe link stays');
});

test('a text body is cut at 8000 by default, at the caller limit up to the 20000 ceiling, never beyond', () => {
  const body = 'x'.repeat(25_000);
  const len = (content) =>
    contract.renderEmail({ subject: 's', content, values: {}, footer: { practiceName: '', unsubscribeUrl: null } }).text.split('\n\n')[0].length;
  assert.equal(len({ kind: 'text', body }), contract.EMAIL_TEXT_BODY_MAX);
  assert.equal(len({ kind: 'text', body, maxChars: 12_000 }), 12_000);
  assert.equal(len({ kind: 'text', body, maxChars: 99_999 }), contract.EMAIL_TEXT_BODY_CEILING);
  assert.equal(len({ kind: 'text', body, maxChars: -1 }), contract.EMAIL_TEXT_BODY_MAX);
});

test('`literal` keeps {{…}} text verbatim; without it tokens are filled or removed as before', () => {
  const body = 'Note: {{keep}} and {{practice.name}}';
  const values = { 'practice.name': 'Roland' };
  const footer = { practiceName: '', unsubscribeUrl: null };
  assert.equal(contract.renderEmail({ subject: 's', content: { kind: 'text', body }, values, footer }).text.split('\n\n')[0], 'Note:  and Roland');
  assert.equal(
    contract.renderEmail({ subject: 's', content: { kind: 'text', body, literal: true }, values, footer }).text.split('\n\n')[0],
    body
  );
});

test('renderReferralLetter: the referral footer, the practice name override, no link but unsubscribe, HTML escaped', () => {
  const saved = process.env.TC_EMAIL_PRACTICE_NAME_ROLAND;
  process.env.TC_EMAIL_PRACTICE_NAME_ROLAND = 'Roland Family Dental';
  try {
    const out = emailContent.renderReferralLetter({
      office: 'roland',
      subject: 'Referral from Roland Family Dental — Stedi T., <b>x</b>',
      text: 'Dear Dr. Example,\n\nVisit https://example.test and <script>alert(1)</script> {{keep}}',
      unsubscribeUrl: 'https://dashboard.example.test/api/webhooks/email/unsubscribe?t=abc',
    });
    assert.match(out.text, /Roland Family Dental sent your office a patient referral/);
    assert.match(out.html, /&lt;script&gt;/);
    assert.doesNotMatch(out.html, /<script>/);
    assert.match(out.html, /\{\{keep\}\}/);
    const anchors = out.html.match(/<a [^>]*>[^<]*<\/a>/g) || [];
    assert.deepEqual(anchors.map((a) => />([^<]*)</.exec(a)[1]), ['Unsubscribe from these emails']);
  } finally {
    if (saved === undefined) delete process.env.TC_EMAIL_PRACTICE_NAME_ROLAND;
    else process.env.TC_EMAIL_PRACTICE_NAME_ROLAND = saved;
  }
});

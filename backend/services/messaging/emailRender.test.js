'use strict';

/**
 * The ONE email renderer (shared/tc/emailRender.ts), exercised through the
 * committed contract bundle exactly as the backend runs it (queue item 40).
 *
 *   - every block type in shared/tc/emailBlocks.ts renders (the list is read
 *     from the zod union, so a 9th type without a renderer fails here);
 *   - TOTAL: empty, malformed and legacy-shaped input never throws;
 *   - XSS: person-supplied text is escaped, unsafe URLs are dropped;
 *   - minimum necessary: only allowlisted tokens fill; case.* never does.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const contract = require('../../tc/contract.gen.cjs');
const emailContent = require('./emailContent');

const VALUES = {
  'patient.firstName': 'MangoTest',
  'practice.name': 'Roland',
  'practice.phone': '(918) 555-0100',
  'practice.address': '1 Example St',
  'sender.name': 'TC User',
  'sender.email': 'front@roland.example.test',
};
const FOOTER = { practiceName: 'Roland', unsubscribeUrl: 'https://dashboard.example.test/api/webhooks/email/unsubscribe?t=tok' };

function render(blocks, values = VALUES) {
  return contract.renderEmail({ subject: 'Hi {{patient.firstName}}', content: { kind: 'blocks', blocks }, values, footer: FOOTER });
}

/** One VALID instance of every block type, parsed by the real schema. */
const VALID = {
  header: { id: 'h', type: 'header', logoUrl: 'https://cdn.example.test/logo.png', headline: 'Hello {{patient.firstName}}', subhead: 'From {{practice.name}}' },
  text: { id: 't', type: 'text', html: '<p>Line one</p><p>Line <b>two</b></p>' },
  image: { id: 'i', type: 'image', src: 'https://cdn.example.test/smile.png', alt: 'A smile', href: 'https://example.test' },
  button: { id: 'b', type: 'button', label: 'Call us', href: 'tel:+19185550100' },
  highlight: { id: 'hl', type: 'highlight', treatment: 'Typed by a person', totalFee: '$100' },
  signature: { id: 's', type: 'signature', source: 'tc' },
  divider: { id: 'd', type: 'divider' },
  footer: { id: 'f', type: 'footer' },
};

test('every block type in the closed union has a renderer', () => {
  const types = contract.EmailBlock.options.map((o) => o.shape.type.value).sort();
  assert.deepEqual(types, Object.keys(VALID).sort(), 'a new block type needs a renderer and a fixture here');
  for (const t of types) {
    const parsed = contract.EmailBlock.parse(VALID[t]);
    const block = contract.readBlock(parsed, VALUES);
    assert.ok(block, `${t} renders`);
    assert.equal(block.type, t);
    const { html } = render([parsed]);
    assert.ok(html.length > 500, t);
  }
});

test('the rendered email: subject, preheader, body, system footer with the unsubscribe link', () => {
  const r = contract.renderEmail({
    subject: 'Hi {{patient.firstName}}',
    preheader: 'A note from {{practice.name}}',
    content: { kind: 'blocks', blocks: Object.values(VALID) },
    values: VALUES,
    footer: FOOTER,
  });
  assert.equal(r.subject, 'Hi MangoTest');
  assert.match(r.html, /^<!doctype html>/);
  assert.match(r.html, /A note from Roland/);
  assert.match(r.html, /Hello MangoTest/);
  assert.match(r.html, /Line one/);
  assert.match(r.html, /href="tel:\+19185550100"/);
  assert.match(r.html, /href="https:\/\/dashboard\.example\.test\/api\/webhooks\/email\/unsubscribe\?t=tok"/);
  assert.match(r.html, /you are a patient of Roland/);
  assert.match(r.text, /Unsubscribe: https:\/\/dashboard\.example\.test/);
  assert.match(r.text, /TC User/);
});

test('TOTAL: empty, malformed and legacy input never throws', () => {
  const nasty = [
    undefined,
    null,
    '',
    'not an array',
    42,
    {},
    [],
    [null, undefined, 1, 'x', [], {}],
    [{ type: 'nope' }, { type: 'text' }, { type: 'text', html: 17 }, { type: 'header' }],
    [{ type: 'image' }, { type: 'image', src: 'not a url' }, { type: 'button', href: null, label: 99 }],
    [{ type: 'highlight' }, { type: 'signature', source: 'martian' }, { type: 'divider', thickness: 'thick', color: 'red' }],
    [{ type: 'footer', showAddress: 'yes', fineText: null }],
    [Object.defineProperty({ type: 'text' }, 'html', { get() { throw new Error('boom'); }, enumerable: true })],
  ];
  for (const blocks of nasty) {
    const r = render(blocks);
    assert.equal(typeof r.html, 'string');
    assert.equal(typeof r.text, 'string');
    assert.match(r.html, /Unsubscribe from these emails/, 'the footer always renders');
  }
  // Whole-input garbage too.
  for (const input of [undefined, null, {}, { content: null }, { content: { kind: 'blocks' } }, { content: { kind: 'text', body: null } }]) {
    const r = contract.renderEmail(input);
    assert.equal(typeof r.html, 'string');
  }
  assert.deepEqual(contract.readBlocks('nope', VALUES), []);
  assert.deepEqual(contract.fillBlockTokens(null, VALUES), []);
});

test('a malformed block degrades to its defaults rather than vanishing', () => {
  const b = contract.readBlock({ type: 'text', html: '<p>Hi</p>', bgColor: 'javascript:x', fontSize: 'big' }, VALUES);
  assert.equal(b.bgColor, '#ffffff');
  assert.equal(b.fontSize, 15);
  const d = contract.readBlock({ type: 'divider', thickness: 99, color: '#zzzzzz' }, VALUES);
  assert.equal(d.thickness, 8);
  assert.equal(d.color, '#e2e8f0');
});

test('XSS: text is escaped, tags are reduced to text, unsafe URLs are dropped', () => {
  const hostile = '"><script>alert(1)</script><img src=x onerror=alert(2)>';
  const r = contract.renderEmail({
    subject: hostile,
    preheader: hostile,
    content: {
      kind: 'blocks',
      blocks: [
        { type: 'header', headline: hostile, logoUrl: 'javascript:alert(1)' },
        { type: 'text', html: `<p onclick="x">${hostile}</p><iframe src="https://evil.test"></iframe>` },
        { type: 'image', src: 'data:image/png;base64,AAAA', alt: hostile },
        { type: 'image', src: 'https://cdn.example.test/a.png', alt: hostile, href: 'javascript:alert(3)' },
        { type: 'button', label: hostile, href: 'javascript:alert(4)' },
        { type: 'button', label: 'ok', href: 'https://user:pw@example.test' },
        { type: 'signature', source: 'custom', customText: hostile },
        { type: 'footer', fineText: hostile },
      ],
    },
    values: { ...VALUES, 'patient.firstName': hostile },
    footer: { practiceName: hostile, unsubscribeUrl: 'javascript:alert(5)' },
  });
  // No live markup survives: no script/iframe element, no event-handler
  // attribute inside any tag, no unsafe scheme in any href/src.
  assert.doesNotMatch(r.html, /<script|<iframe/i);
  // Blank every quoted attribute value (escapeHtml turns " into &quot;, so a
  // value cannot close itself early); what is left is real markup only.
  const markup = r.html.replace(/="[^"]*"/g, '=""');
  assert.doesNotMatch(markup, /<[^>]*\son\w+\s*=/i);
  assert.doesNotMatch(r.html, /(href|src)="(javascript|data):/i);
  assert.doesNotMatch(r.html, /user:pw/);
  assert.match(r.html, /&lt;script&gt;/, 'the hostile text is shown, escaped');
  // The data: image block and the javascript: button have nothing safe left: dropped.
  assert.equal((r.html.match(/<img /g) || []).length, 1);
  assert.equal((r.html.match(/<a href=/g) || []).length, 0, 'the only link left would be unsafe ones');
});

test('a TC-typed plain body is escaped and paragraphed', () => {
  const r = contract.renderEmail({
    subject: 'x',
    content: { kind: 'text', body: 'Hi <b>there</b>\n\nSecond & last' },
    values: VALUES,
    footer: FOOTER,
  });
  assert.match(r.html, /Hi &lt;b&gt;there&lt;\/b&gt;<\/p>/);
  assert.match(r.html, /Second &amp; last/);
});

test('minimum necessary: case.* and unknown tokens never fill; a stock highlight block is dropped', () => {
  const stock = contract.EmailBlock.parse({ id: 'hl', type: 'highlight' }); // all {{case.*}} defaults
  assert.equal(contract.readBlock(stock, VALUES), null, 'nothing left to show');
  const r = render([
    stock,
    { type: 'text', html: '<p>{{case.treatmentSummary}} {{case.totalFee}} {{doctor.name}} {{patient.lastName}} {{patient.firstName}}</p>' },
  ]);
  assert.doesNotMatch(r.html, /\{\{|case\.|Total fee/);
  assert.match(r.html, />MangoTest<\/p>/);
  assert.deepEqual([...contract.EMAIL_MERGE_TOKENS].sort(), Object.keys(VALUES).sort(), 'the allowlist is exactly these six');
});

test('emailContent: a template snapshot fills the patient first name and nothing clinical', () => {
  const snap = emailContent.snapshotTemplate(
    {
      subject: 'Hi {{patient.firstName}}, about {{case.treatmentSummary}}',
      preheader: '{{practice.name}}',
      blocks: [{ id: 't', type: 'text', html: '<p>Dear {{patient.firstName}}</p>' }, { id: 'hl', type: 'highlight' }],
    },
    'roland',
    { patientName: 'MangoTest Test', senderName: 'TC User' }
  );
  assert.equal(snap.subject, 'Hi MangoTest, about');
  assert.equal(snap.preheader, 'Roland');
  assert.equal(snap.blocks[0].html, '<p>Dear MangoTest</p>');
  assert.equal(snap.body, 'Dear MangoTest');
});

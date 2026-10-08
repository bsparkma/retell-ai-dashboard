'use strict';

/**
 * X-Twilio-Signature (queue item 39). The first vector is the one published in
 * Twilio's security documentation and pinned by the official SDKs' own tests —
 * if this implementation disagrees with it, it disagrees with Twilio.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { parseForm, computeSignature, isValidSignature } = require('./signature');

const DOC_TOKEN = '12345';
const DOC_URL = 'https://mycompany.com/myapp.php?foo=1&bar=2';
const DOC_PAIRS = [
  ['CallSid', 'CA1234567890ABCDE'],
  ['Caller', '+14158675309'],
  ['Digits', '1234'],
  ['From', '+14158675309'],
  ['To', '+18005551212'],
];
const DOC_SIGNATURE = 'RSOYDt4T1cUTdK1PDd93/VVr8B8=';

test("Twilio's documented test vector", () => {
  assert.equal(computeSignature(DOC_TOKEN, DOC_URL, DOC_PAIRS), DOC_SIGNATURE);
});

test('parameter ORDER in the body does not matter (they are sorted)', () => {
  const shuffled = [DOC_PAIRS[3], DOC_PAIRS[0], DOC_PAIRS[4], DOC_PAIRS[2], DOC_PAIRS[1]];
  assert.equal(computeSignature(DOC_TOKEN, DOC_URL, shuffled), DOC_SIGNATURE);
});

test('the raw form body parses to the same pairs (+ is a space, %2B is a plus)', () => {
  const raw = 'CallSid=CA1234567890ABCDE&Caller=%2B14158675309&Digits=1234&From=%2B14158675309&To=%2B18005551212';
  assert.deepEqual(parseForm(raw), DOC_PAIRS);
  assert.deepEqual(parseForm('Body=hi+there'), [['Body', 'hi there']]);
  assert.deepEqual(parseForm(''), []);
  assert.deepEqual(parseForm(undefined), []);
});

test('valid → true', () => {
  assert.equal(
    isValidSignature({ authToken: DOC_TOKEN, signature: DOC_SIGNATURE, url: DOC_URL, pairs: DOC_PAIRS }),
    true
  );
});

test('invalid: wrong token, tampered param, extra param, different URL, case-changed signature', () => {
  const base = { authToken: DOC_TOKEN, signature: DOC_SIGNATURE, url: DOC_URL, pairs: DOC_PAIRS };
  assert.equal(isValidSignature({ ...base, authToken: '54321' }), false);
  assert.equal(isValidSignature({ ...base, pairs: [...DOC_PAIRS.slice(0, 4), ['To', '+18005551213']] }), false);
  assert.equal(isValidSignature({ ...base, pairs: [...DOC_PAIRS, ['Body', 'x']] }), false);
  assert.equal(isValidSignature({ ...base, url: 'https://mycompany.com/myapp.php?foo=1&bar=3' }), false);
  // The URL is NOT normalized: http vs https is a different URL to Twilio.
  assert.equal(isValidSignature({ ...base, url: DOC_URL.replace('https:', 'http:') }), false);
  assert.equal(isValidSignature({ ...base, signature: DOC_SIGNATURE.toLowerCase() }), false);
});

test('missing pieces are refusals, never passes', () => {
  const base = { authToken: DOC_TOKEN, signature: DOC_SIGNATURE, url: DOC_URL, pairs: DOC_PAIRS };
  assert.equal(isValidSignature({ ...base, signature: undefined }), false);
  assert.equal(isValidSignature({ ...base, signature: '' }), false);
  assert.equal(isValidSignature({ ...base, signature: ['x'] }), false);
  assert.equal(isValidSignature({ ...base, authToken: null }), false);
  assert.equal(isValidSignature({ ...base, authToken: '' }), false);
  assert.equal(isValidSignature({ ...base, url: null }), false);
  // A signature computed with an EMPTY token must not validate against a
  // missing one.
  const emptyTokenSig = computeSignature('', DOC_URL, DOC_PAIRS);
  assert.equal(isValidSignature({ ...base, authToken: '', signature: emptyTokenSig }), false);
});

test('repeated names contribute once per value, in sorted value order', () => {
  const a = computeSignature(DOC_TOKEN, DOC_URL, [['MediaUrl', 'b'], ['MediaUrl', 'a']]);
  const b = computeSignature(DOC_TOKEN, DOC_URL, [['MediaUrl', 'a'], ['MediaUrl', 'b']]);
  assert.equal(a, b);
  assert.notEqual(a, computeSignature(DOC_TOKEN, DOC_URL, [['MediaUrl', 'a']]));
});

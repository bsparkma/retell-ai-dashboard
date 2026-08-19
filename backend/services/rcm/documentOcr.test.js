'use strict';

/**
 * The Document Intelligence transport.
 *
 * `fetch` is stubbed; nothing here reaches Azure. The one test that does is the
 * opt-in live probe in `documentOcrLive.test.js`, which is skipped unless
 * `RCM_OCR_LIVE=1`.
 *
 * What is worth asserting about a transport, and why each one is here:
 *   1. UNCONFIGURED IS A LEGAL STATE. Prod ships with no endpoint until the
 *      resource is armed, and an image-only PDF must then fail exactly the way
 *      it failed before this slice — not with a stack trace about a credential.
 *   2. IT IS A LONG-RUNNING OPERATION. Submit, then poll `Operation-Location`.
 *      A version that read the 202's body would work against a fast mock and
 *      never against the service.
 *   3. `failed` FROM AZURE IS A FAILURE OF THIS DOCUMENT, not an outage — the
 *      two get different failure codes and the panel renders them differently.
 *   4. CONFIDENCE IS WORD-WEIGHTED, and `null` when nothing reported one. "We do
 *      not know how sure the reader was" and "the reader was certain" are
 *      different facts, and a transport that collapsed them would put a 100%
 *      confidence badge on a document nobody measured.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const ocr = require('./documentOcr');

const ENDPOINT = 'https://docint-example.cognitiveservices.azure.com';

/**
 * Stub the world: `fetch`, the env, and the credential.
 *
 * `api_key` auth is used throughout so no test touches `@azure/identity` — the
 * managed-identity branch needs a real IMDS endpoint and would make this suite
 * depend on where it runs.
 *
 * @param {Array<{ status?: number, headers?: Record<string,string>, json?: unknown, throws?: Error }>} responses
 */
function harness(responses, env = {}) {
  const prior = { ...process.env };
  process.env.RCM_OCR_ENDPOINT = ENDPOINT;
  process.env.RCM_OCR_AUTH_MODE = 'api_key';
  process.env.RCM_OCR_API_KEY = 'test-key';
  // Poll instantly: the real 2s interval would make this suite take a minute.
  process.env.RCM_OCR_POLL_INTERVAL_MS = '1';
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  ocr._resetForTests();

  const calls = [];
  const originalFetch = global.fetch;
  let i = 0;
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    if (next.throws) throw next.throws;
    const status = next.status ?? 200;
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (k) => (next.headers || {})[String(k).toLowerCase()] ?? null },
      json: async () => next.json,
      text: async () => (typeof next.json === 'string' ? next.json : JSON.stringify(next.json)),
    };
  };

  return {
    calls,
    restore() {
      global.fetch = originalFetch;
      for (const k of Object.keys(process.env)) if (!(k in prior)) delete process.env[k];
      Object.assign(process.env, prior);
      ocr._resetForTests();
    },
  };
}

/** The 202 that starts a long-running operation. */
const ACCEPTED = {
  status: 202,
  headers: { 'operation-location': `${ENDPOINT}/documentintelligence/operations/abc` },
  json: {},
};

/** A succeeded poll carrying one page of two words. */
function succeeded(overrides = {}) {
  return {
    status: 200,
    json: {
      status: 'succeeded',
      analyzeResult: {
        content: 'EXAMPLE DENTAL PLAN\nCHECK TOTAL PAID: 163.00',
        pages: [
          {
            words: [
              { content: 'EXAMPLE', confidence: 0.99 },
              { content: 'DENTAL', confidence: 0.97 },
            ],
          },
        ],
        ...overrides,
      },
    },
  };
}

const PDF = Buffer.from('%PDF-1.4 pretend bytes');

test('unconfigured is a legal state, reported as one', () => {
  const prior = { ...process.env };
  delete process.env.RCM_OCR_ENDPOINT;
  try {
    assert.equal(ocr.isConfigured(), false);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in prior)) delete process.env[k];
    Object.assign(process.env, prior);
  }
});

test('analyze with no endpoint refuses with OCR_UNAVAILABLE, not a credential error', async () => {
  const prior = { ...process.env };
  delete process.env.RCM_OCR_ENDPOINT;
  try {
    await assert.rejects(() => ocr.analyze(PDF), (err) => {
      assert.equal(err.code, 'OCR_UNAVAILABLE');
      assert.match(err.message, /not configured/i);
      return true;
    });
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in prior)) delete process.env[k];
    Object.assign(process.env, prior);
  }
});

test('it submits to prebuilt-read and then POLLS the operation location', async () => {
  const h = harness([ACCEPTED, { status: 200, json: { status: 'running' } }, succeeded()]);
  try {
    const result = await ocr.analyze(PDF);

    assert.equal(h.calls.length, 3, 'submit, one running poll, one succeeded poll');

    const submit = h.calls[0];
    assert.equal(submit.options.method, 'POST');
    assert.match(submit.url, /documentModels\/prebuilt-read:analyze/);
    // `_overload=analyzeDocument` is what selects the JSON-body overload. Without
    // it the service expects raw bytes and rejects the JSON we send.
    assert.match(submit.url, /_overload=analyzeDocument/);
    assert.match(submit.url, /api-version=2024-11-30/);
    assert.equal(JSON.parse(submit.options.body).base64Source, PDF.toString('base64'));
    assert.equal(submit.options.headers['Ocp-Apim-Subscription-Key'], 'test-key');

    // The polls go to the header's URL, never to a URL we assembled ourselves.
    assert.equal(h.calls[1].url, ACCEPTED.headers['operation-location']);
    assert.equal(h.calls[2].url, ACCEPTED.headers['operation-location']);

    assert.equal(result.text, 'EXAMPLE DENTAL PLAN\nCHECK TOTAL PAID: 163.00');
    assert.equal(result.pages, 1);
    assert.equal(result.words, 2);
    assert.equal(result.model, 'prebuilt-read');
  } finally {
    h.restore();
  }
});

test('a 202 with no Operation-Location is a transport failure, not a silent empty read', async () => {
  const h = harness([{ status: 202, headers: {}, json: {} }]);
  try {
    await assert.rejects(() => ocr.analyze(PDF), (err) => {
      assert.equal(err.code, 'OCR_CALL_FAILED');
      assert.match(err.message, /Operation-Location/);
      return true;
    });
  } finally {
    h.restore();
  }
});

test('a 4xx on submit is THIS document failing; a 5xx is the service', async () => {
  const bad = harness([{ status: 415, json: { error: { message: 'UnsupportedMediaType' } } }]);
  try {
    await assert.rejects(() => ocr.analyze(PDF), (err) => {
      assert.equal(err.code, 'OCR_ANALYZE_FAILED');
      assert.match(err.message, /UnsupportedMediaType/);
      return true;
    });
  } finally {
    bad.restore();
  }

  const down = harness([{ status: 503, json: { error: { message: 'busy' } } }]);
  try {
    await assert.rejects(() => ocr.analyze(PDF), (err) => {
      // A retryable outage must not read as "your document is bad" — the two
      // produce different failure codes and different advice to the poster.
      assert.equal(err.code, 'OCR_CALL_FAILED');
      return true;
    });
  } finally {
    down.restore();
  }

  // 401/403 are auth, i.e. OUR misconfiguration, never the document's fault.
  const unauthorized = harness([{ status: 401, json: { error: { message: 'nope' } } }]);
  try {
    await assert.rejects(() => ocr.analyze(PDF), (err) => {
      assert.equal(err.code, 'OCR_CALL_FAILED');
      return true;
    });
  } finally {
    unauthorized.restore();
  }
});

test("Azure's own 'failed' status is a per-document failure with its reason", async () => {
  const h = harness([
    ACCEPTED,
    { status: 200, json: { status: 'failed', error: { message: 'InvalidContent: page 1 is corrupt' } } },
  ]);
  try {
    await assert.rejects(() => ocr.analyze(PDF), (err) => {
      assert.equal(err.code, 'OCR_ANALYZE_FAILED');
      assert.match(err.message, /InvalidContent/);
      return true;
    });
  } finally {
    h.restore();
  }
});

test('a poll that never settles is stopped, and says the document may just be long', async () => {
  const h = harness([ACCEPTED, { status: 200, json: { status: 'running' } }], {
    RCM_OCR_TIMEOUT_MS: '40',
    RCM_OCR_POLL_INTERVAL_MS: '10',
  });
  try {
    await assert.rejects(() => ocr.analyze(PDF), (err) => {
      assert.equal(err.code, 'OCR_TIMED_OUT');
      assert.match(err.message, /split it/i, 'and tells the poster what to do about it');
      return true;
    });
  } finally {
    h.restore();
  }
});

test('mean confidence is WORD-weighted across pages, not a mean of page means', async () => {
  const h = harness([
    ACCEPTED,
    {
      status: 200,
      json: {
        status: 'succeeded',
        analyzeResult: {
          content: 'x',
          pages: [
            // A two-word cover page the reader was unsure about...
            { words: [{ confidence: 0.5 }, { confidence: 0.5 }] },
            // ...and a dense claims page it read well. A mean of page means says
            // 0.75; the truth about this document is 0.958.
            { words: Array.from({ length: 22 }, () => ({ confidence: 1.0 })) },
          ],
        },
      },
    },
  ]);
  try {
    const result = await ocr.analyze(PDF);
    assert.equal(result.words, 24);
    assert.ok(Math.abs(result.meanConfidence - 23 / 24) < 1e-9);
    assert.equal(result.pages, 2);
  } finally {
    h.restore();
  }
});

test('no reported confidence is null, never 1.0', async () => {
  const h = harness([ACCEPTED, succeeded({ pages: [{ lines: [{ content: 'PLAN PAID 163.00' }] }] })]);
  try {
    const result = await ocr.analyze(PDF);
    assert.equal(result.meanConfidence, null, '"we do not know" is not "we are certain"');
    assert.equal(result.words, 0);
    assert.equal(result.pages, 1);
  } finally {
    h.restore();
  }
});

test('with no `content`, the per-page lines are the fallback', async () => {
  const h = harness([
    ACCEPTED,
    {
      status: 200,
      json: {
        status: 'succeeded',
        analyzeResult: {
          pages: [
            { lines: [{ content: 'LINE ONE' }, { content: 'LINE TWO' }], words: [] },
            { lines: [{ content: 'PAGE TWO' }], words: [] },
          ],
        },
      },
    },
  ]);
  try {
    const result = await ocr.analyze(PDF);
    assert.equal(result.text, 'LINE ONE\nLINE TWO\n\nPAGE TWO');
    assert.equal(result.pages, 2);
  } finally {
    h.restore();
  }
});

test('a response with no pages is a zero-page read, not a free one', async () => {
  const h = harness([ACCEPTED, { status: 200, json: { status: 'succeeded', analyzeResult: {} } }]);
  try {
    const result = await ocr.analyze(PDF);
    // The caller turns this into an honest refusal. What must NOT happen is a
    // page count that quietly reads as "nothing to bill".
    assert.equal(result.pages, 0);
    assert.equal(result.text, '');
    assert.equal(result.meanConfidence, null);
  } finally {
    h.restore();
  }
});

test('api_key mode with no key refuses before any request is made', async () => {
  const h = harness([ACCEPTED], { RCM_OCR_API_KEY: '' });
  try {
    await assert.rejects(() => ocr.analyze(PDF), (err) => {
      assert.equal(err.code, 'OCR_UNAVAILABLE');
      assert.match(err.message, /RCM_OCR_API_KEY/);
      return true;
    });
    assert.equal(h.calls.length, 0, 'and nothing was sent');
  } finally {
    h.restore();
  }
});

test('the model is overridable, and the URL follows it', async () => {
  const h = harness([ACCEPTED, succeeded()], { RCM_OCR_MODEL: 'prebuilt-layout' });
  try {
    const result = await ocr.analyze(PDF);
    assert.match(h.calls[0].url, /documentModels\/prebuilt-layout:analyze/);
    // Recorded on the result so a stored page count can be read back against the
    // model — and the rate — that produced it. Layout costs 6.7x Read, and a
    // silent model swap would make the cost rail under-count by that factor.
    assert.equal(result.model, 'prebuilt-layout');
  } finally {
    h.restore();
  }
});

test('an empty buffer never becomes a request', async () => {
  const h = harness([ACCEPTED]);
  try {
    await assert.rejects(() => ocr.analyze(Buffer.alloc(0)), (err) => {
      assert.equal(err.code, 'OCR_CALL_FAILED');
      return true;
    });
    assert.equal(h.calls.length, 0);
  } finally {
    h.restore();
  }
});

'use strict';

/**
 * Retell v3 list-endpoint migration.
 *
 * Retell removed the legacy list endpoints on 2026-06-15:
 *   POST /v2/list-calls        → POST /v3/list-calls
 *   GET  /list-phone-numbers   → GET  /v2/list-phone-numbers
 * (GET /list-agents is NOT part of that deprecation and stays put.)
 *
 * The versioned endpoints answer with an { items, pagination_key, has_more } envelope
 * instead of a bare array. These tests pin the two things that would otherwise fail
 * silently in production:
 *
 *  1. getCalls()/getPhoneNumbers() still hand back a plain ARRAY, because their callers
 *     (routes/calls.js, routes/unifiedCalls.js, routes/agents.js) index and .filter()
 *     the result directly. An unwrapped envelope throws a TypeError that the callers
 *     catch and answer with mock data — real calls would quietly become fake ones.
 *  2. runRetellSync() walks pagination_key and THROWS on an unexpected shape rather
 *     than returning { success: false }, so a future contract change lands in the logs
 *     instead of leaving a stale dashboard that looks like a quiet day.
 *
 * The axios instance is stubbed at retellService.client, so nothing here touches the
 * network or needs RETELL_API_KEY.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const retellService = require('../config/retell');
const syncScheduler = require('../services/syncScheduler');
const unifiedCallStore = require('../services/unifiedCallStore');

/**
 * Swap in a fake axios client, run `fn`, and always restore the real one.
 * `handlers` records every request so assertions can inspect method/url/body.
 */
async function withStubbedClient(handlers, fn) {
  const realClient = retellService.client;
  const calls = [];

  retellService.client = {
    async post(url, body) {
      calls.push({ method: 'POST', url, body });
      return handlers.post(url, body, calls.length - 1);
    },
    async get(url) {
      calls.push({ method: 'GET', url });
      return handlers.get(url, calls.length - 1);
    },
  };

  try {
    return await fn(calls);
  } finally {
    retellService.client = realClient;
  }
}

/** Silence an expected console.warn so the test output stays readable. */
async function withSilencedWarnings(fn) {
  const realWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    return await fn(warnings);
  } finally {
    console.warn = realWarn;
  }
}

// ---------------------------------------------------------------------------
// getCalls / getCallsPage — POST /v3/list-calls
// ---------------------------------------------------------------------------

test('getCalls posts to /v3/list-calls, not the removed /v2/list-calls', async () => {
  await withStubbedClient(
    { post: async () => ({ data: { items: [], has_more: false } }) },
    async (calls) => {
      await retellService.getCalls();
      assert.equal(calls.length, 1);
      assert.equal(calls[0].method, 'POST');
      assert.equal(calls[0].url, '/v3/list-calls');
    }
  );
});

test('getCalls unwraps response.data.items into a plain array', async () => {
  const items = [{ call_id: 'call_a' }, { call_id: 'call_b' }];

  await withStubbedClient(
    { post: async () => ({ data: { items, pagination_key: 'pk_1', has_more: true } }) },
    async () => {
      const result = await retellService.getCalls();
      assert.ok(Array.isArray(result), 'callers .filter()/.map() this directly');
      assert.deepEqual(result, items);
      assert.equal(result.length, 2);
    }
  );
});

test('getCalls returns [] (and warns) when the envelope has no items array', async () => {
  await withSilencedWarnings(async (warnings) => {
    await withStubbedClient(
      { post: async () => ({ data: { unexpected: true } }) },
      async () => {
        const result = await retellService.getCalls();
        assert.deepEqual(result, [], 'never undefined — callers check .length');
        assert.equal(warnings.length, 1, 'a shape change must be loud, not silent');
        assert.match(warnings[0], /unexpected shape/i);
      }
    );
  });
});

test('getCalls returns [] when the response body is missing entirely', async () => {
  await withSilencedWarnings(async () => {
    await withStubbedClient({ post: async () => ({}) }, async () => {
      assert.deepEqual(await retellService.getCalls(), []);
    });
  });
});

test('getCalls translates the legacy `offset` param to v3 `skip`', async () => {
  await withStubbedClient(
    { post: async () => ({ data: { items: [] } }) },
    async (calls) => {
      await retellService.getCalls({ offset: 40, limit: 10 });
      assert.equal(calls[0].body.skip, 40);
      assert.equal(calls[0].body.limit, 10);
      assert.ok(!('offset' in calls[0].body), 'v3 does not accept `offset`');
    }
  );
});

test('getCalls prefers an explicit `skip` over `offset`', async () => {
  await withStubbedClient(
    { post: async () => ({ data: { items: [] } }) },
    async (calls) => {
      await retellService.getCalls({ skip: 5, offset: 40 });
      assert.equal(calls[0].body.skip, 5);
    }
  );
});

test('getCalls clamps limit to the v3 maximum of 1000', async () => {
  await withStubbedClient(
    { post: async () => ({ data: { items: [] } }) },
    async (calls) => {
      await retellService.getCalls({ limit: 5000 });
      assert.equal(calls[0].body.limit, 1000, 'over-limit must clamp, not 400 the sync');
    }
  );
});

test('getCalls defaults limit to 50 and sort_order to descending', async () => {
  await withStubbedClient(
    { post: async () => ({ data: { items: [] } }) },
    async (calls) => {
      await retellService.getCalls();
      assert.equal(calls[0].body.limit, 50);
      assert.equal(calls[0].body.sort_order, 'descending');
      assert.equal(calls[0].body.skip, 0);
    }
  );
});

test('getCalls omits undefined keys rather than sending them', async () => {
  await withStubbedClient(
    { post: async () => ({ data: { items: [] } }) },
    async (calls) => {
      await retellService.getCalls();
      assert.ok(!('pagination_key' in calls[0].body));
      assert.ok(!('filter_criteria' in calls[0].body));
    }
  );
});

test('getCalls passes filter_criteria through when present', async () => {
  const filter = [{ field: 'agent_id', operator: '=', value: 'agent_1' }];

  await withStubbedClient(
    { post: async () => ({ data: { items: [] } }) },
    async (calls) => {
      await retellService.getCalls({ filter_criteria: filter });
      assert.deepEqual(calls[0].body.filter_criteria, filter);
    }
  );
});

test('a pagination_key request omits skip — v3 rejects both together', async () => {
  await withStubbedClient(
    { post: async () => ({ data: { items: [] } }) },
    async (calls) => {
      await retellService.getCalls({ pagination_key: 'pk_9', skip: 100 });
      assert.equal(calls[0].body.pagination_key, 'pk_9');
      assert.ok(!('skip' in calls[0].body), 'skip and pagination_key are mutually exclusive');
    }
  );
});

test('getCallsPage returns the full envelope unmodified', async () => {
  const envelope = { items: [{ call_id: 'call_a' }], pagination_key: 'pk_2', has_more: true };

  await withStubbedClient(
    { post: async () => ({ data: envelope }) },
    async (calls) => {
      const page = await retellService.getCallsPage({ limit: 100 });
      assert.deepEqual(page, envelope, 'pagination-aware callers need the cursor');
      assert.equal(calls[0].url, '/v3/list-calls');
    }
  );
});

// ---------------------------------------------------------------------------
// getPhoneNumbers — GET /v2/list-phone-numbers
// ---------------------------------------------------------------------------

test('getPhoneNumbers hits /v2/list-phone-numbers and returns an array', async () => {
  const items = [{ phone_number: '+15015550001', agent_id: 'agent_1' }];

  await withStubbedClient(
    { get: async () => ({ data: { items, has_more: false } }) },
    async (calls) => {
      const result = await retellService.getPhoneNumbers();
      assert.equal(calls[0].method, 'GET');
      assert.equal(calls[0].url, '/v2/list-phone-numbers');
      assert.ok(Array.isArray(result), 'routes/agents.js calls .filter() on this');
      assert.deepEqual(result, items);
      // The real consumer shape — this is what would TypeError on an envelope.
      assert.deepEqual(result.filter((pn) => pn.agent_id === 'agent_1'), items);
    }
  );
});

test('getPhoneNumbers returns [] on an unexpected shape instead of throwing', async () => {
  await withSilencedWarnings(async () => {
    await withStubbedClient({ get: async () => ({ data: { nope: 1 } }) }, async () => {
      const result = await retellService.getPhoneNumbers();
      assert.deepEqual(result, []);
      assert.ok(Array.isArray(result));
    });
  });
});

// ---------------------------------------------------------------------------
// runRetellSync — pagination + loud failure
// ---------------------------------------------------------------------------

/** Stub the store so the sync never touches the on-disk unified_calls.json. */
async function withStubbedStore(fn) {
  const realAdd = unifiedCallStore.addRetellCall;
  const realPersist = unifiedCallStore.persist;
  const added = [];

  unifiedCallStore.addRetellCall = (call) => {
    added.push(call);
    return call;
  };
  let persistCount = 0;
  unifiedCallStore.persist = async () => {
    persistCount += 1;
  };

  try {
    return await fn(added, () => persistCount);
  } finally {
    unifiedCallStore.addRetellCall = realAdd;
    unifiedCallStore.persist = realPersist;
  }
}

test('runRetellSync follows pagination_key across pages and stops on has_more:false', async () => {
  const pages = [
    { items: [{ call_id: 'call_1' }, { call_id: 'call_2' }], pagination_key: 'pk_page2', has_more: true },
    { items: [{ call_id: 'call_3' }], pagination_key: null, has_more: false },
  ];

  await withStubbedStore(async (added, persistCount) => {
    await withStubbedClient(
      { post: async (_url, _body, index) => ({ data: pages[index] }) },
      async (calls) => {
        const result = await syncScheduler.runRetellSync({ limit: 100 });

        assert.equal(calls.length, 2, 'exactly two pages requested');
        assert.ok(!('pagination_key' in calls[0].body), 'first page carries no cursor');
        assert.equal(calls[1].body.pagination_key, 'pk_page2', 'second page uses the cursor');

        assert.deepEqual(added.map((c) => c.call_id), ['call_1', 'call_2', 'call_3']);
        assert.equal(persistCount(), 1, 'persist() runs once at the end, not per page');

        assert.deepEqual(result, { success: true, added: 3, fetched: 3 });
      }
    );
  });
});

test('runRetellSync stops when has_more is true but no cursor comes back', async () => {
  // Without the cursor guard this would re-request page 1 until the page cap.
  await withStubbedStore(async () => {
    await withStubbedClient(
      { post: async () => ({ data: { items: [{ call_id: 'call_1' }], has_more: true, pagination_key: null } }) },
      async (calls) => {
        const result = await syncScheduler.runRetellSync({ limit: 10 });
        assert.equal(calls.length, 1);
        assert.equal(result.fetched, 1);
      }
    );
  });
});

test('runRetellSync caps the walk at 5 pages and says so', async () => {
  await withSilencedWarnings(async (warnings) => {
    await withStubbedStore(async () => {
      await withStubbedClient(
        {
          post: async (_url, _body, index) => ({
            data: { items: [{ call_id: `call_${index}` }], pagination_key: `pk_${index}`, has_more: true },
          }),
        },
        async (calls) => {
          const result = await syncScheduler.runRetellSync({ limit: 1000 });
          assert.equal(calls.length, 5, 'hard cap holds');
          assert.equal(result.fetched, 5);
          assert.ok(
            warnings.some((w) => /cap/i.test(w)),
            'truncation must be logged, never silent'
          );
        }
      );
    });
  });
});

test('runRetellSync THROWS on an unexpected shape instead of returning success:false', async () => {
  await withStubbedStore(async (added, persistCount) => {
    await withStubbedClient(
      { post: async () => ({ data: { calls: [{ call_id: 'call_1' }] } }) }, // legacy-ish, no items
      async () => {
        await assert.rejects(
          () => syncScheduler.runRetellSync({ limit: 10 }),
          /unexpected shape/i,
          'a silent { success:false } is what let the deprecation hide'
        );
        assert.equal(persistCount(), 0, 'nothing persisted on a failed run');
      }
    );
  });
});

test('runRetellSync propagates a transport error rather than swallowing it', async () => {
  await withStubbedStore(async () => {
    await withStubbedClient(
      {
        post: async () => {
          throw new Error('connect ETIMEDOUT');
        },
      },
      async () => {
        await assert.rejects(() => syncScheduler.runRetellSync({ limit: 10 }), /ETIMEDOUT/);
      }
    );
  });
});

test('runRetellSync handles an empty first page without error', async () => {
  await withStubbedStore(async (added, persistCount) => {
    await withStubbedClient(
      { post: async () => ({ data: { items: [], has_more: false } }) },
      async () => {
        const result = await syncScheduler.runRetellSync({ limit: 10 });
        assert.deepEqual(result, { success: true, added: 0, fetched: 0 });
        assert.equal(persistCount(), 1);
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Transcript preservation across a v3 re-add
// ---------------------------------------------------------------------------

/**
 * v3 list responses carry neither transcript nor recording_url, and addRetellCall
 * rebuilds the record while addCallInternal replaces it in the Map. Without an explicit
 * inherit, the 15-minute poller would blank both of the things the call_analyzed webhook
 * already delivered — every run, for every Retell call. These pin that it does not.
 */
test('a v3 re-add preserves the transcript and recording delivered by the webhook', () => {
  const callId = 'call_media_guard';

  // 1. The webhook lands with the full payload (v2/get-call shape).
  unifiedCallStore.addRetellCall({
    call_id: callId,
    from_number: '+15015550123',
    start_timestamp: '2026-08-10T15:00:00.000Z',
    transcript: 'Agent: Thanks for calling. User: I need to reschedule.',
    transcript_object: [{ role: 'agent', content: 'Thanks for calling.' }],
    recording_url: 'https://retell.example/recordings/call_media_guard.mp3',
    call_analysis: { call_summary: 'Caller wants to reschedule.' },
  });

  const afterWebhook = unifiedCallStore.getCall(callId);
  assert.match(afterWebhook.transcript, /reschedule/);
  assert.ok(afterWebhook.transcript_json, 'transcript_json populated from transcript_object');
  assert.match(afterWebhook.recording_url, /call_media_guard\.mp3$/);

  // 2. The poller re-adds the SAME call from a v3 list payload — no transcript, no
  //    recording_url. v3 omits both by design.
  unifiedCallStore.addRetellCall({
    call_id: callId,
    from_number: '+15015550123',
    start_timestamp: '2026-08-10T15:00:00.000Z',
    call_analysis: { call_summary: 'Caller wants to reschedule.' },
    disconnection_reason: 'user_hangup',
  });

  const afterPoll = unifiedCallStore.getCall(callId);
  assert.match(afterPoll.transcript, /reschedule/, 'transcript must survive the v3 re-add');
  assert.ok(afterPoll.transcript_json, 'transcript_json must survive too');
  assert.match(
    afterPoll.recording_url,
    /call_media_guard\.mp3$/,
    'recording_url must survive — the audio player has no other source for it'
  );
  assert.equal(afterPoll.disconnection_reason, 'user_hangup', 'and new v3 fields still land');
});

test('an incoming transcript or recording_url still wins over the stored one', () => {
  const callId = 'call_media_update';

  unifiedCallStore.addRetellCall({
    call_id: callId,
    transcript: 'first pass',
    recording_url: 'https://retell.example/old.mp3',
  });
  unifiedCallStore.addRetellCall({
    call_id: callId,
    transcript: 'corrected transcript',
    recording_url: 'https://retell.example/new.mp3',
  });

  const stored = unifiedCallStore.getCall(callId);
  assert.equal(stored.transcript, 'corrected transcript');
  assert.equal(stored.recording_url, 'https://retell.example/new.mp3', 'a re-signed URL wins');
});

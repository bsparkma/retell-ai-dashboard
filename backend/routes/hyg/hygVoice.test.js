'use strict';

/**
 * Perio voice entry (queue item 35) — the backend's one voice surface.
 *
 * Acceptance rows pinned here:
 *   1  flag off ⇒ POST /api/hyg/voice/token 404s (and /auth/me says false —
 *      routes/auth.test.js); on, it sits behind the hyg module gate, hyg.write,
 *      the auth gate and the office check like every hyg route
 *   2  the response is { success, token, region } and nothing else; the key is
 *      in no body, header or log line, and the token is in no log line
 *   3  THREE independent budgets: exhausting this one leaves the call
 *      breaker's file and the voice lab's file byte-identical, and exhausting
 *      theirs leaves this one able to mint; no source here names either
 *   5  zero Open Dental requests on any voice path, asserted on the OD fake
 *
 * Row 7 (the media-retention guard) is test/voiceMediaGuard.test.js; rows 4
 * and 6 are client-side (new-dashboard/tests/hyg-perio-voice*.test.*).
 *
 * The route table and the no-store/no-writer pin are ALSO in
 * hygNoOdWrites.test.js, where voice.js's line in the mutation allow-list is
 * argued for.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { isHygVoiceEnabled, FLAG_ENV } = require('../../config/hygVoice');
const { createHygVoiceRouter, processHygVoiceBudget } = require('./voice');
const {
  HygVoiceBudget,
  resolveCapMinutes,
  DEFAULT_CAP_MINUTES,
  SESSION_MINUTES,
  STATE_FILE,
} = require('../../services/hyg/voiceBudget');
const { VoiceLabBudget, STATE_FILE: LAB_STATE_FILE } = require('../../services/voiceLab/labBudget');
const { DurableState } = require('../../services/durableState');
const odOffices = require('../../config/odOffices');
const { FakeOd, bootHygApp, api } = require('./hygTestUtils');

// A key that is unmistakable if it leaks anywhere — response, header, log.
const SPEECH_KEY = 'TEST-HYG-SPEECH-KEY-fedcba9876543210-MUST-NEVER-LEAVE';
const REGION = 'southcentralus';
const MINTED = 'eyJ.hyg.voice.minted.token';
const STS_URL = `https://${REGION}.api.cognitive.microsoft.com/sts/v1.0/issueToken`;
const TOKEN_PATH = '/api/hyg/voice/token?office=roland';

const VOICE_ENV = Object.freeze({
  HYG_VOICE: '1',
  AZURE_SPEECH_API_KEY: SPEECH_KEY,
  AZURE_SPEECH_REGION: REGION,
});

// ── harness ─────────────────────────────────────────────────────────────────

/** Hold env vars (and a fresh CALLSTORE_DIR) for the duration of `fn`. */
async function withEnv(vars, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyg-voice-'));
  const all = { CALLSTORE_DIR: dir, ...vars };
  const saved = Object.fromEntries(Object.keys(all).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(all)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // The app's one budget caches its doc in memory; a fresh dir needs a fresh read.
  processHygVoiceBudget().state.reset();
  try {
    return await fn(dir);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    processHygVoiceBudget().state.reset();
  }
}

/**
 * Stub the global fetch: loopback requests (the test talking to its own app)
 * pass through; anything else is recorded and answered like Azure's STS.
 */
async function withStsStub({ status = 200, body = MINTED } = {}, fn) {
  const outbound = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('http://127.0.0.1')) return realFetch(url, init);
    outbound.push({ url: u, init });
    return new Response(body, { status });
  };
  try {
    return await fn(outbound);
  } finally {
    globalThis.fetch = realFetch;
  }
}

/** Capture console output for the duration of `fn`. */
async function captureLogs(fn) {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(orig)) {
    console[k] = (...args) => lines.push(args.map(String).join(' '));
  }
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    Object.assign(console, orig);
  }
}

/** A raw POST so the test sees the exact bytes and headers. */
async function rawPost(baseUrl, p, { body, anon = false } = {}) {
  const headers = anon ? {} : { Authorization: 'Bearer test-token' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(baseUrl + p, { method: 'POST', headers, body });
  return { status: res.status, raw: await res.text(), headers: JSON.stringify([...res.headers]) };
}

/** A budget in its own DurableState, read under whatever CALLSTORE_DIR is set. */
function freshBudget(env = {}, now) {
  return new HygVoiceBudget({
    env,
    state: new DurableState(STATE_FILE, { day_key: null, minutes_reserved: 0 }),
    ...(now ? { now } : {}),
  });
}

/** A bare app with just the voice router — for cases that inject a budget. */
async function bootVoiceOnly({ budget, env = VOICE_ENV, fetchImpl }) {
  const app = express();
  app.use(express.json());
  app.use('/voice', createHygVoiceRouter({ budget, env, fetchImpl }));
  app.use('*', (_req, res) => res.status(404).json({ message: 'Route not found' }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    post: (p, init = {}) => fetch(base + p, { method: 'POST', ...init }),
    close: () => new Promise((r) => server.close(r)),
  };
}

// ── 1. the switch, and the gates it sits behind ─────────────────────────────

test('row 1: the switch — only HYG_VOICE exactly "1" is on', () => {
  assert.equal(FLAG_ENV, 'HYG_VOICE');
  for (const value of [undefined, '', '0', 'true', 'TRUE', 'on', 'yes', ' 1', '1 ', '01']) {
    assert.equal(isHygVoiceEnabled({ HYG_VOICE: value }), false, JSON.stringify(value));
  }
  assert.equal(isHygVoiceEnabled({ HYG_VOICE: '1' }), true);
  // A product switch, not the lab's: no production refusal, and the lab flag is irrelevant.
  assert.equal(isHygVoiceEnabled({ HYG_VOICE: '1', NODE_ENV: 'production', AZURE_KEY_VAULT_NAME: 'kv-carein-prod' }), true);
  assert.equal(isHygVoiceEnabled({ VOICE_LAB: '1' }), false);
});

test('row 1: flag OFF ⇒ POST /api/hyg/voice/token is a 404 through the REAL hyg stack, and nothing is minted', async () => {
  await withEnv({ ...VOICE_ENV, HYG_VOICE: undefined }, async () => {
    await withStsStub({}, async (outbound) => {
      const app = await bootHygApp();
      try {
        const res = await api(app.baseUrl, 'POST', TOKEN_PATH);
        assert.equal(res.status, 404);
        // The flag is read per request: 'true' is still off.
        process.env.HYG_VOICE = 'true';
        assert.equal((await api(app.baseUrl, 'POST', TOKEN_PATH)).status, 404);
      } finally {
        await app.close();
      }
      assert.deepEqual(outbound, [], 'no token was minted');
      assert.equal(processHygVoiceBudget().snapshot().usedMinutes, 0, 'nothing reserved');
    });
  });
});

test('row 1: flag ON ⇒ the hygienist gets a token through the real stack', async () => {
  await withEnv(VOICE_ENV, async () => {
    await withStsStub({}, async (outbound) => {
      const app = await bootHygApp();
      try {
        const res = await api(app.baseUrl, 'POST', TOKEN_PATH);
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, { success: true, token: MINTED, region: REGION });
      } finally {
        await app.close();
      }
      assert.equal(outbound.length, 1);
      assert.equal(outbound[0].url, STS_URL);
    });
  });
});

test('row 1: flag ON still sits behind every hyg gate — module, hyg.write, auth, office', async () => {
  await withEnv(VOICE_ENV, async () => {
    await withStsStub({}, async (outbound) => {
      const cases = [
        { boot: { modules: ['voice'] }, path: TOKEN_PATH, status: 403, why: 'a tenant without hyg' },
        { boot: { role: 'reviewer' }, path: TOKEN_PATH, status: 403, why: 'reviewer: hyg.read but not hyg.write (POST)' },
        { boot: {}, path: TOKEN_PATH, anon: true, status: 401, why: 'an anonymous caller' },
        { boot: {}, path: '/api/hyg/voice/token', status: 400, why: 'no office' },
        { boot: {}, path: '/api/hyg/voice/token?office=elsewhere', status: 400, why: 'an unknown office' },
      ];
      for (const c of cases) {
        const app = await bootHygApp(c.boot);
        try {
          const res = await api(app.baseUrl, 'POST', c.path, { anon: c.anon === true });
          assert.equal(res.status, c.status, c.why);
        } finally {
          await app.close();
        }
      }
      assert.deepEqual(outbound, [], 'no refused request reached Azure');
      assert.equal(processHygVoiceBudget().snapshot().usedMinutes, 0, 'no refused request reserved minutes');
    });
  });
});

// ── 2. the key never leaves ─────────────────────────────────────────────────

test('row 2: the response is { success, token, region } — the key is in no body, header or log', async () => {
  await withEnv(VOICE_ENV, async () => {
    await withStsStub({}, async (outbound) => {
      const { result, lines } = await captureLogs(async () => {
        const app = await bootHygApp();
        try {
          return await rawPost(app.baseUrl, TOKEN_PATH);
        } finally {
          await app.close();
        }
      });
      assert.equal(result.status, 200);
      const body = JSON.parse(result.raw);
      assert.deepEqual(Object.keys(body).sort(), ['region', 'success', 'token']);
      assert.deepEqual(body, { success: true, token: MINTED, region: REGION });
      assert.ok(!result.raw.includes(SPEECH_KEY), 'the key is not in the body');
      assert.ok(!result.headers.includes(SPEECH_KEY), 'the key is not in a response header');
      assert.ok(lines.length > 0, 'the mint logged something, so the scan below is not vacuous');
      for (const l of lines) {
        assert.ok(!l.includes(SPEECH_KEY), 'the key is not logged: ' + l);
        assert.ok(!l.includes(MINTED), 'the token is not logged either: ' + l);
      }
      // The key went exactly where it must: one header, to the region's STS.
      assert.equal(outbound.length, 1);
      assert.equal(outbound[0].init.headers['Ocp-Apim-Subscription-Key'], SPEECH_KEY);
    });
  });
});

test('row 2: a failed mint echoes neither the key nor the STS body, and gives the minutes back', async () => {
  await withEnv(VOICE_ENV, async () => {
    await withStsStub({ status: 401, body: 'denied for key ' + SPEECH_KEY }, async () => {
      const { result, lines } = await captureLogs(async () => {
        const app = await bootHygApp();
        try {
          return await rawPost(app.baseUrl, TOKEN_PATH);
        } finally {
          await app.close();
        }
      });
      assert.equal(result.status, 502);
      assert.equal(JSON.parse(result.raw).code, 'HYG_VOICE_TOKEN_FAILED');
      assert.ok(!result.raw.includes(SPEECH_KEY));
      for (const l of lines) assert.ok(!l.includes(SPEECH_KEY), 'logged: ' + l);
      assert.ok(lines.some((l) => /STS_REFUSED HTTP 401/.test(l)), 'the log carries the code and status');
      assert.equal(processHygVoiceBudget().snapshot().usedMinutes, 0, 'the reservation was released');
    });
  });
});

test('row 2: no key or no region ⇒ 503, nothing minted, nothing reserved', async () => {
  for (const missing of ['AZURE_SPEECH_API_KEY', 'AZURE_SPEECH_REGION']) {
    await withEnv({ ...VOICE_ENV, [missing]: undefined }, async () => {
      await withStsStub({}, async (outbound) => {
        const app = await bootHygApp();
        try {
          const res = await api(app.baseUrl, 'POST', TOKEN_PATH);
          assert.equal(res.status, 503, missing);
          assert.equal(res.body.code, 'HYG_VOICE_SPEECH_UNCONFIGURED');
        } finally {
          await app.close();
        }
        assert.deepEqual(outbound, []);
        assert.equal(processHygVoiceBudget().snapshot().usedMinutes, 0);
      });
    });
  }
});

test('row 2: the route takes no body — anything said cannot ride along', async () => {
  await withEnv(VOICE_ENV, async () => {
    await withStsStub({}, async (outbound) => {
      const app = await bootHygApp();
      try {
        const res = await api(app.baseUrl, 'POST', TOKEN_PATH, { body: { heard: 'three two three bleeding' } });
        assert.equal(res.status, 400);
        assert.equal(res.body.code, 'HYG_VOICE_NO_PAYLOAD');
        // Nothing else under /voice answers either, with or without a body.
        for (const p of ['/apply', '/transcript', '/audio', '/results', '']) {
          const other = await api(app.baseUrl, 'POST', '/api/hyg/voice' + p + '?office=roland', {
            body: { heard: 'four' },
          });
          assert.equal(other.status, 404, 'POST /voice' + p);
        }
        assert.equal((await api(app.baseUrl, 'GET', TOKEN_PATH)).status, 404, 'GET /token is not a route');
        // A body express.json() does not parse (req.body stays {}) is refused all the same.
        for (const [type, raw] of [
          ['text/plain', 'three two three bleeding'],
          ['application/octet-stream', 'RIFF....WAVEfmt '],
        ]) {
          const r = await fetch(app.baseUrl + TOKEN_PATH, {
            method: 'POST',
            headers: { Authorization: 'Bearer test-token', 'Content-Type': type },
            body: raw,
          });
          assert.equal(r.status, 400, type);
          assert.equal((await r.json()).code, 'HYG_VOICE_NO_PAYLOAD');
        }
      } finally {
        await app.close();
      }
      assert.deepEqual(outbound, [], 'a request carrying content never mints');
    });
  });
});

test('row 2: the voice router has exactly ONE route — POST /token — and no router middleware', () => {
  const router = createHygVoiceRouter({ budget: freshBudget() });
  const routes = router.stack
    .filter((layer) => layer.route)
    .map((layer) => ({ path: layer.route.path, methods: Object.keys(layer.route.methods).sort() }));
  assert.deepEqual(routes, [{ path: '/token', methods: ['post'] }]);
  assert.deepEqual(router.stack.filter((layer) => !layer.route), []);
});

// ── 3. three budgets, independent ───────────────────────────────────────────

test('row 3: the cap — default 60, a positive override, and fail-closed zero for anything else', () => {
  assert.equal(DEFAULT_CAP_MINUTES, 60);
  assert.equal(SESSION_MINUTES, 10);
  assert.equal(STATE_FILE, 'hyg_voice_budget.json');
  assert.equal(resolveCapMinutes({}), 60);
  assert.equal(resolveCapMinutes({ HYG_VOICE_DAILY_MINUTES: '' }), 60);
  assert.equal(resolveCapMinutes({ HYG_VOICE_DAILY_MINUTES: '90' }), 90);
  assert.equal(resolveCapMinutes({ HYG_VOICE_DAILY_MINUTES: '0' }), 0);
  assert.equal(resolveCapMinutes({ HYG_VOICE_DAILY_MINUTES: '-10' }), 0);
  assert.equal(resolveCapMinutes({ HYG_VOICE_DAILY_MINUTES: 'plenty' }), 0);
  // It never reads either other budget's knob.
  assert.equal(resolveCapMinutes({ MAX_TRANSCRIPTION_MINUTES_PER_DAY: '999' }), 60);
  assert.equal(resolveCapMinutes({ VOICE_LAB_DAILY_MINUTES: '999' }), 60);
});

/** Seed the other two budgets' files with recognisable content, and read their bytes. */
function seedOtherBudgets(dir) {
  const callFile = path.join(dir, 'transcription_budget.json');
  const labFile = path.join(dir, LAB_STATE_FILE);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
  fs.writeFileSync(callFile, JSON.stringify({ day_key: today, minutes_used: 37.5, updated_at: 'seed' }));
  fs.writeFileSync(labFile, JSON.stringify({ day_key: today, minutes_reserved: 20, updated_at: 'seed' }));
  return {
    callFile,
    labFile,
    bytes: () => [fs.readFileSync(callFile), fs.readFileSync(labFile)],
  };
}

test('row 3: exhausting the perio voice budget refuses honestly — and BOTH other budgets are byte-identical', async () => {
  await withEnv(VOICE_ENV, async (dir) => {
    const transcriptionService = require('../../services/transcriptionService');
    const others = seedOtherBudgets(dir);
    const [callBefore, labBefore] = others.bytes();
    transcriptionService._dailyState.reset();
    transcriptionService._dailyLoaded = false;
    const callBudgetBefore = transcriptionService.checkDailyBudget();
    const lab = new VoiceLabBudget({ env: {}, state: new DurableState(LAB_STATE_FILE, {}) });
    const labBudgetBefore = lab.snapshot();
    assert.equal(labBudgetBefore.usedMinutes, 20, 'the lab seed is read, so the comparison is not vacuous');

    await withStsStub({}, async (outbound) => {
      const app = await bootHygApp();
      try {
        for (let i = 1; i <= 6; i++) {
          assert.equal((await api(app.baseUrl, 'POST', TOKEN_PATH)).status, 200, 'session ' + i + ' fits');
        }
        const refused = await api(app.baseUrl, 'POST', TOKEN_PATH);
        assert.equal(refused.status, 429);
        assert.equal(refused.body.success, false);
        assert.equal(refused.body.code, 'HYG_VOICE_BUDGET_EXHAUSTED');
        assert.equal(refused.body.usedMinutes, 60);
        assert.equal(refused.body.capMinutes, 60);
        assert.match(refused.body.error, /perio voice budget is used up/);
        assert.match(refused.body.error, /Keep charting by keyboard/);
        assert.ok(!Number.isNaN(Date.parse(refused.body.resetsAt)), 'says WHEN it resets');
      } finally {
        await app.close();
      }
      assert.equal(outbound.length, 6, 'the refused request never reached Azure');
    });

    // Its own counter, in its own file.
    const doc = JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), 'utf8'));
    assert.equal(doc.minutes_reserved, 60);

    // The other two: same bytes on disk, same numbers through their own code.
    const [callAfter, labAfter] = others.bytes();
    assert.ok(callAfter.equals(callBefore), 'transcription_budget.json was not touched');
    assert.ok(labAfter.equals(labBefore), 'voicelab_budget.json was not touched');
    transcriptionService._dailyState.reset();
    transcriptionService._dailyLoaded = false;
    const callBudgetAfter = transcriptionService.checkDailyBudget();
    assert.equal(callBudgetAfter.usedMinutes, callBudgetBefore.usedMinutes);
    assert.equal(callBudgetAfter.capMinutes, callBudgetBefore.capMinutes);
    assert.equal(callBudgetAfter.allowed, callBudgetBefore.allowed);
    const labAfterRead = new VoiceLabBudget({ env: {}, state: new DurableState(LAB_STATE_FILE, {}) }).snapshot();
    assert.equal(labAfterRead.usedMinutes, labBudgetBefore.usedMinutes);
    transcriptionService._dailyState.reset();
    transcriptionService._dailyLoaded = false;
  });
});

test('row 3: the other direction — a spent lab budget and a spent call budget do not stop perio voice', async () => {
  await withEnv(VOICE_ENV, async (dir) => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
    fs.writeFileSync(path.join(dir, LAB_STATE_FILE), JSON.stringify({ day_key: today, minutes_reserved: 9999 }));
    fs.writeFileSync(
      path.join(dir, 'transcription_budget.json'),
      JSON.stringify({ day_key: today, minutes_used: 9999 })
    );
    await withStsStub({}, async () => {
      const app = await bootHygApp();
      try {
        assert.equal((await api(app.baseUrl, 'POST', TOKEN_PATH)).status, 200);
      } finally {
        await app.close();
      }
    });
    const doc = JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), 'utf8'));
    assert.equal(doc.minutes_reserved, 10, 'perio voice counted only its own session');
  });
});

test('row 3: no voice source names either other budget — by source and by module graph', () => {
  const backend = path.join(__dirname, '..', '..');
  const files = ['routes/hyg/voice.js', 'services/hyg/voiceBudget.js', 'config/hygVoice.js'];
  for (const rel of files) {
    const src = fs
      .readFileSync(path.join(backend, rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const re of [
      /transcriptionService/,
      /MAX_TRANSCRIPTION_MINUTES_PER_DAY/,
      /transcription_budget\.json/,
      /labBudget/,
      /VoiceLabBudget/,
      /VOICE_LAB_DAILY_MINUTES/,
      /voicelab_budget\.json/,
    ]) {
      assert.ok(!re.test(src), rel + ' names ' + re);
    }
  }
  const graph = voiceModuleGraph();
  assert.ok(graph.includes('services/hyg/voiceBudget.js'), 'non-vacuous');
  assert.ok(graph.includes('services/voiceLab/speechToken.js'), 'the shared mint is the lab’s, by design');
  assert.deepEqual(
    graph.filter((f) => /transcriptionService|labBudget|routes\/voiceLab/.test(f)),
    [],
    'the voice route loads neither other budget, nor the lab route'
  );
});

test('row 3: a cap of 0 refuses the very first mint (fail closed)', async () => {
  await withEnv({}, async () => {
    const sts = [];
    const app = await bootVoiceOnly({
      budget: freshBudget({ HYG_VOICE_DAILY_MINUTES: '0' }),
      fetchImpl: async (url) => {
        sts.push(String(url));
        return new Response(MINTED, { status: 200 });
      },
    });
    try {
      const res = await app.post('/voice/token');
      assert.equal(res.status, 429);
      assert.equal((await res.json()).code, 'HYG_VOICE_BUDGET_EXHAUSTED');
      assert.deepEqual(sts, []);
    } finally {
      await app.close();
    }
  });
});

test('row 3: the budget rolls at midnight Central, not UTC', async () => {
  await withEnv({}, async () => {
    let now = new Date('2026-10-07T23:30:00-05:00'); // 11:30 PM CDT
    const budget = freshBudget({ HYG_VOICE_DAILY_MINUTES: '10' }, () => now);
    assert.equal(budget.reserve().ok, true);
    assert.equal(budget.reserve().ok, false, 'spent for the evening');
    now = new Date('2026-10-07T23:50:00-05:00'); // already the 8th in UTC
    assert.equal(budget.reserve().ok, false);
    now = new Date('2026-10-08T00:05:00-05:00'); // just past local midnight
    assert.equal(budget.reserve().ok, true, 'a new Central day hands back the budget');
  });
});

// ── 5. zero Open Dental ─────────────────────────────────────────────────────

/** Every relative module the voice route can load, transitively. */
function voiceModuleGraph() {
  const root = path.join(__dirname, '..', '..');
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      let target = path.resolve(path.dirname(file), m[1]);
      if (!target.endsWith('.js')) target += '.js';
      if (fs.existsSync(target)) visit(target);
    }
  };
  visit(path.join(__dirname, 'voice.js'));
  return [...seen].map((f) => path.relative(root, f).split(path.sep).join('/'));
}

test('row 5: the voice module graph cannot reach an Open Dental client', () => {
  const graph = voiceModuleGraph();
  assert.ok(graph.includes('routes/hyg/voice.js'), 'non-vacuous');
  const od = graph.filter((f) => /openDental|odOffices|odAccess|odClient|\/od[A-Z]|helpers\.js/.test(f));
  assert.deepEqual(od, [], 'the voice route loads no Open Dental module');
});

test('row 5: driving EVERY voice path makes ZERO Open Dental requests (asserted on the OD fake)', async () => {
  await withEnv({ ...VOICE_ENV, HYG_VOICE_DAILY_MINUTES: undefined }, async () => {
    const od = new FakeOd({});
    await withStsStub({}, async (outbound) => {
      const app = await bootHygApp({ od });
      // Wrap AFTER boot: bootHygApp installs its own stub, and this counts every
      // office handle anything asks for while the voice paths run.
      const handles = [];
      const bootStub = odOffices.getOdOffice;
      odOffices.getOdOffice = (...args) => {
        handles.push(args);
        return bootStub(...args);
      };
      try {
        // Six successes spend the default 60, then a budget refusal.
        for (let i = 0; i < 6; i++) assert.equal((await api(app.baseUrl, 'POST', TOKEN_PATH)).status, 200);
        assert.equal((await api(app.baseUrl, 'POST', TOKEN_PATH)).status, 429);
        // A payload refusal, an unknown voice path, and the off switch.
        assert.equal((await api(app.baseUrl, 'POST', TOKEN_PATH, { body: { x: 1 } })).status, 400);
        assert.equal((await api(app.baseUrl, 'POST', '/api/hyg/voice/nope?office=roland')).status, 404);
        process.env.HYG_VOICE = '0';
        assert.equal((await api(app.baseUrl, 'POST', TOKEN_PATH)).status, 404);
      } finally {
        odOffices.getOdOffice = bootStub;
        await app.close();
      }
      assert.deepEqual(od.calls, [], 'no Open Dental read');
      assert.deepEqual(od.writes, [], 'no Open Dental write');
      assert.deepEqual(handles, [], 'no Open Dental office handle was even requested');
      assert.equal(outbound.length, 6, 'the six successes reached Azure, and nothing else left the process');
      for (const o of outbound) assert.equal(o.url, STS_URL);
    });
  });
});

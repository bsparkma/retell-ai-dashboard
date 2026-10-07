'use strict';

/**
 * Voice lab (queue item 34) — the backend's one lab surface.
 *
 * Acceptance rows pinned here:
 *   1  flag off ⇒ the token route 404s; production ⇒ refused even with the flag
 *   2  the token response carries token + region only — the key string is absent
 *   3  the lab breaker is its OWN counter; exhausting it refuses honestly and the
 *      call-transcription breaker's counter is untouched
 *   6  the backend's only lab surface is POST /token (route table)
 *   7  zero Open Dental requests on any lab path, asserted on the OD fake
 *
 * Row 4 (the media-retention guard) lives in test/voiceMediaGuard.test.js.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { resolveVoiceLab, isProductionEnvironment } = require('../config/voiceLab');
const { createVoiceLabRouter, mountVoiceLab, MOUNT_PATH } = require('./voiceLab');
const {
  VoiceLabBudget,
  resolveCapMinutes,
  SESSION_MINUTES,
  DEFAULT_CAP_MINUTES,
  STATE_FILE,
} = require('../services/voiceLab/labBudget');
const { DurableState } = require('../services/durableState');
const { FakeOd } = require('./hyg/hygTestUtils');
const odOffices = require('../config/odOffices');

// A key that is unmistakable if it leaks anywhere — response, header, log.
const SPEECH_KEY = 'TEST-SPEECH-KEY-0123456789abcdef-MUST-NEVER-LEAVE';
const REGION = 'southcentralus';
const MINTED = 'eyJ.minted.token';

const STAGING = Object.freeze({
  VOICE_LAB: '1',
  NODE_ENV: 'production',
  AZURE_KEY_VAULT_NAME: 'kv-carein-staging',
  AZURE_SPEECH_API_KEY: SPEECH_KEY,
  AZURE_SPEECH_REGION: REGION,
});

/** A fresh temp dir per budget, so no test reads another's counter. */
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'voicelab-'));
}

/**
 * A budget whose DurableState lives in its own temp dir. DurableState resolves
 * its directory from CALLSTORE_DIR at each call, so the dir is held set for the
 * duration of the test by `withStateDir`.
 */
function freshBudget(env = {}) {
  return new VoiceLabBudget({ env, state: new DurableState(STATE_FILE, { day_key: null, minutes_reserved: 0 }) });
}

async function withStateDir(fn) {
  const dir = tmpDir();
  const saved = process.env.CALLSTORE_DIR;
  process.env.CALLSTORE_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (saved === undefined) delete process.env.CALLSTORE_DIR;
    else process.env.CALLSTORE_DIR = saved;
  }
}

/** A fetch that answers the STS like Azure does, and records every URL + header set. */
function fakeSts({ status = 200, body = MINTED } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(body, { status });
  };
  return { impl, calls };
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

/** Boot an app shaped like server.js's tail: lab mount, then the catch-all 404. */
async function bootApp({ env, budget, fetchImpl }) {
  const app = express();
  app.use(express.json());
  const decision = mountVoiceLab(app, { env, budget, fetchImpl });
  app.use('*', (_req, res) => res.status(404).json({ message: 'Route not found' }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    decision,
    post: (p, init = {}) => fetch(base + p, { method: 'POST', ...init }),
    get: (p) => fetch(base + p),
    close: () => new Promise((r) => server.close(r)),
  };
}

// ── 1. the switch ───────────────────────────────────────────────────────────

test('row 1: the switch — only VOICE_LAB=1 off-production turns the lab on', () => {
  const cases = [
    [{}, false, 'flag_off'],
    [{ VOICE_LAB: 'true' }, false, 'flag_off'],
    [{ VOICE_LAB: 'on' }, false, 'flag_off'],
    [{ VOICE_LAB: ' 1' }, false, 'flag_off'],
    [{ VOICE_LAB: '1', NODE_ENV: 'production', AZURE_KEY_VAULT_NAME: 'kv-carein-prod' }, false, 'production'],
    // A production process with NO vault name is still production.
    [{ VOICE_LAB: '1', NODE_ENV: 'production' }, false, 'production'],
    // A prod vault is production even if NODE_ENV says otherwise.
    [{ VOICE_LAB: '1', NODE_ENV: 'development', AZURE_KEY_VAULT_NAME: 'kv-carein-prod' }, false, 'production'],
    [{ VOICE_LAB: '1', NODE_ENV: 'production', AZURE_KEY_VAULT_NAME: 'kv-carein-staging' }, true, 'enabled'],
    [{ VOICE_LAB: '1' }, true, 'enabled'], // a developer box
  ];
  for (const [env, enabled, reason] of cases) {
    assert.deepEqual(resolveVoiceLab(env), { enabled, reason }, JSON.stringify(env));
  }
  assert.equal(isProductionEnvironment({ NODE_ENV: 'production', AZURE_KEY_VAULT_NAME: 'KV-CAREIN-PROD' }), true);
});

test('row 1: flag OFF ⇒ POST /api/voicelab/token 404s (the route does not exist)', async () => {
  const sts = fakeSts();
  const app = await bootApp({ env: { ...STAGING, VOICE_LAB: undefined }, budget: freshBudget(), fetchImpl: sts.impl });
  try {
    assert.equal(app.decision.enabled, false);
    const res = await app.post(MOUNT_PATH + '/token');
    assert.equal(res.status, 404);
    assert.equal(sts.calls.length, 0, 'no token was minted');
  } finally {
    await app.close();
  }
});

test('row 1: PRODUCTION ⇒ refused even with VOICE_LAB=1 (404, no mint)', async () => {
  const sts = fakeSts();
  const env = { ...STAGING, AZURE_KEY_VAULT_NAME: 'kv-carein-prod' };
  const { result: app, lines } = await captureLogs(() =>
    bootApp({ env, budget: freshBudget(), fetchImpl: sts.impl })
  );
  try {
    assert.deepEqual(app.decision, { enabled: false, reason: 'production' });
    assert.ok(lines.some((l) => /production — the lab is NOT mounted/.test(l)), 'the refusal is said at boot');
    const res = await app.post(MOUNT_PATH + '/token');
    assert.equal(res.status, 404);
    assert.equal(sts.calls.length, 0);
  } finally {
    await app.close();
  }
});

test('row 1: server.js mounts the lab BELOW the auth gate and tenant context', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const authGate = src.indexOf('requireDashboardAuth(');
  const tenant = src.indexOf('tenantContext({');
  const lab = src.indexOf("require('./routes/voiceLab').mountVoiceLab(app)");
  assert.ok(authGate > 0 && tenant > 0 && lab > 0, 'all three are present');
  assert.ok(lab > authGate && lab > tenant, 'an unauthenticated caller can never reach the token route');
  assert.equal(src.split('mountVoiceLab(').length - 1, 1, 'mounted exactly once');
  assert.ok(!/['"`]\/api\/voicelab/.test(src), 'server.js mounts it only through mountVoiceLab');
});

// ── 2. the key never leaves ─────────────────────────────────────────────────

test('row 2: the token response is { success, token, region } — the key is absent', async () => {
  await withStateDir(async () => {
    const sts = fakeSts();
    const { result, lines } = await captureLogs(async () => {
      const app = await bootApp({ env: STAGING, budget: freshBudget(), fetchImpl: sts.impl });
      try {
        const res = await app.post(MOUNT_PATH + '/token');
        const raw = await res.text();
        const headers = JSON.stringify([...res.headers]);
        return { status: res.status, raw, headers };
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
    for (const l of lines) {
      assert.ok(!l.includes(SPEECH_KEY), 'the key is not logged: ' + l);
      assert.ok(!l.includes(MINTED), 'the token is not logged either: ' + l);
    }

    // The key went exactly where it must: one header, to the region's STS.
    assert.equal(sts.calls.length, 1);
    assert.equal(sts.calls[0].url, `https://${REGION}.api.cognitive.microsoft.com/sts/v1.0/issueToken`);
    assert.equal(sts.calls[0].init.method, 'POST');
    assert.equal(sts.calls[0].init.headers['Ocp-Apim-Subscription-Key'], SPEECH_KEY);
  });
});

test('row 2: a failed mint does not echo the key, the STS body, or keep the reservation', async () => {
  await withStateDir(async () => {
    const budget = freshBudget();
    const sts = fakeSts({ status: 401, body: 'denied for key ' + SPEECH_KEY });
    const { result, lines } = await captureLogs(async () => {
      const app = await bootApp({ env: STAGING, budget, fetchImpl: sts.impl });
      try {
        const res = await app.post(MOUNT_PATH + '/token');
        return { status: res.status, raw: await res.text() };
      } finally {
        await app.close();
      }
    });
    assert.equal(result.status, 502);
    assert.equal(JSON.parse(result.raw).code, 'VOICE_LAB_TOKEN_FAILED');
    assert.ok(!result.raw.includes(SPEECH_KEY));
    for (const l of lines) assert.ok(!l.includes(SPEECH_KEY), 'logged: ' + l);
    assert.equal(budget.snapshot().usedMinutes, 0, 'the reservation was released');
  });
});

test('row 2: no key or no region ⇒ 503, nothing minted, nothing reserved', async () => {
  await withStateDir(async () => {
    for (const missing of ['AZURE_SPEECH_API_KEY', 'AZURE_SPEECH_REGION']) {
      const budget = freshBudget();
      const sts = fakeSts();
      const app = await bootApp({ env: { ...STAGING, [missing]: undefined }, budget, fetchImpl: sts.impl });
      try {
        const res = await app.post(MOUNT_PATH + '/token');
        assert.equal(res.status, 503, missing);
        assert.equal((await res.json()).code, 'VOICE_LAB_SPEECH_UNCONFIGURED');
        assert.equal(sts.calls.length, 0);
        assert.equal(budget.snapshot().usedMinutes, 0);
      } finally {
        await app.close();
      }
    }
  });
});

// ── 3. the lab's own breaker ────────────────────────────────────────────────

test('row 3: the cap — default 30, a positive override, and fail-closed zero for anything else', () => {
  assert.equal(DEFAULT_CAP_MINUTES, 30);
  assert.equal(SESSION_MINUTES, 10);
  assert.equal(resolveCapMinutes({}), 30);
  assert.equal(resolveCapMinutes({ VOICE_LAB_DAILY_MINUTES: '' }), 30);
  assert.equal(resolveCapMinutes({ VOICE_LAB_DAILY_MINUTES: '45' }), 45);
  // Unlike the call breaker, 0 is NOT unlimited — it refuses.
  assert.equal(resolveCapMinutes({ VOICE_LAB_DAILY_MINUTES: '0' }), 0);
  assert.equal(resolveCapMinutes({ VOICE_LAB_DAILY_MINUTES: '-5' }), 0);
  assert.equal(resolveCapMinutes({ VOICE_LAB_DAILY_MINUTES: 'lots' }), 0);
  // And it never reads the call breaker's knob.
  assert.equal(resolveCapMinutes({ MAX_TRANSCRIPTION_MINUTES_PER_DAY: '999' }), 30);
});

test('row 3: exhausting the lab budget refuses tokens honestly — and the call-transcription breaker is untouched', async () => {
  await withStateDir(async (dir) => {
    const transcriptionService = require('../services/transcriptionService');
    // Load the call breaker's state from THIS temp dir, then record it.
    transcriptionService._dailyState.reset();
    transcriptionService._dailyLoaded = false;
    const callBefore = transcriptionService.checkDailyBudget();
    const callFile = path.join(dir, 'transcription_budget.json');
    const callFileBefore = fs.existsSync(callFile) ? fs.readFileSync(callFile, 'utf8') : null;

    const budget = freshBudget(); // default 30 ⇒ three whole sessions
    const sts = fakeSts();
    const app = await bootApp({ env: STAGING, budget, fetchImpl: sts.impl });
    try {
      for (let i = 1; i <= 3; i++) {
        const ok = await app.post(MOUNT_PATH + '/token');
        assert.equal(ok.status, 200, 'session ' + i + ' fits');
      }
      const refused = await app.post(MOUNT_PATH + '/token');
      assert.equal(refused.status, 429);
      const body = await refused.json();
      assert.equal(body.success, false);
      assert.equal(body.code, 'VOICE_LAB_BUDGET_EXHAUSTED');
      assert.equal(body.usedMinutes, 30);
      assert.equal(body.capMinutes, 30);
      assert.match(body.error, /voice lab budget is used up/);
      assert.match(body.error, /Call transcription has its own budget/);
      assert.ok(!Number.isNaN(Date.parse(body.resetsAt)), 'says WHEN it resets');
      assert.equal(sts.calls.length, 3, 'the refused request never reached Azure');
    } finally {
      await app.close();
    }

    // Separate counter, separate file.
    const labDoc = JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), 'utf8'));
    assert.equal(labDoc.minutes_reserved, 30);
    assert.notEqual(STATE_FILE, 'transcription_budget.json');

    // The call breaker: same minutes, same cap, same file bytes.
    const callAfter = transcriptionService.checkDailyBudget();
    assert.equal(callAfter.usedMinutes, callBefore.usedMinutes);
    assert.equal(callAfter.capMinutes, callBefore.capMinutes);
    assert.equal(callAfter.allowed, callBefore.allowed);
    const callFileAfter = fs.existsSync(callFile) ? fs.readFileSync(callFile, 'utf8') : null;
    assert.equal(callFileAfter, callFileBefore, 'transcription_budget.json was not written by the lab');
    transcriptionService._dailyState.reset();
    transcriptionService._dailyLoaded = false;
  });
});

test('row 3: the lab budget source never names the call breaker', () => {
  for (const rel of ['../services/voiceLab/labBudget.js', './voiceLab.js', '../config/voiceLab.js']) {
    const src = fs
      .readFileSync(path.join(__dirname, rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/transcriptionService/.test(src), rel + ' requires the call transcription service');
    assert.ok(!/MAX_TRANSCRIPTION_MINUTES_PER_DAY/.test(src), rel + ' reads the call breaker cap');
    assert.ok(!/transcription_budget\.json/.test(src), rel + ' opens the call breaker doc');
  }
});

test('row 3: a cap of 0 refuses the very first mint (fail closed)', async () => {
  await withStateDir(async () => {
    const sts = fakeSts();
    const app = await bootApp({ env: STAGING, budget: freshBudget({ VOICE_LAB_DAILY_MINUTES: '0' }), fetchImpl: sts.impl });
    try {
      const res = await app.post(MOUNT_PATH + '/token');
      assert.equal(res.status, 429);
      assert.equal(sts.calls.length, 0);
    } finally {
      await app.close();
    }
  });
});

test('row 3: the lab budget rolls at midnight Central, not UTC', async () => {
  await withStateDir(async () => {
    let now = new Date('2026-10-06T23:30:00-05:00'); // 11:30 PM CDT
    const budget = new VoiceLabBudget({
      env: { VOICE_LAB_DAILY_MINUTES: '10' },
      state: new DurableState(STATE_FILE, { day_key: null, minutes_reserved: 0 }),
      now: () => now,
    });
    assert.equal(budget.reserve().ok, true);
    assert.equal(budget.reserve().ok, false, 'spent for the evening');
    // 04:40 UTC on the 7th is still the 6th in Central — no roll yet.
    now = new Date('2026-10-06T23:40:00-05:00');
    assert.equal(budget.reserve().ok, false);
    now = new Date('2026-10-07T00:05:00-05:00'); // just past local midnight
    assert.equal(budget.reserve().ok, true, 'a new Central day hands back the budget');
  });
});

// ── 6. the route table ──────────────────────────────────────────────────────

test('row 6: the lab router has exactly ONE route — POST /token', () => {
  const router = createVoiceLabRouter({ budget: freshBudget() });
  const routes = router.stack
    .filter((layer) => layer.route)
    .map((layer) => ({ path: layer.route.path, methods: Object.keys(layer.route.methods).sort() }));
  assert.deepEqual(routes, [{ path: '/token', methods: ['post'] }]);
  const nonRoute = router.stack.filter((layer) => !layer.route);
  assert.deepEqual(nonRoute, [], 'no router-level middleware (no upload parser, no static mount)');
});

test('row 6: nothing else under /api/voicelab answers, and the token route refuses a body', async () => {
  await withStateDir(async () => {
    const sts = fakeSts();
    const app = await bootApp({ env: STAGING, budget: freshBudget(), fetchImpl: sts.impl });
    try {
      for (const p of ['/results', '/transcript', '/audio', '/upload', '/runs', '/']) {
        const res = await app.post(MOUNT_PATH + p, {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ heard: 'three four five' }),
        });
        assert.equal(res.status, 404, 'POST ' + p);
      }
      assert.equal((await app.get(MOUNT_PATH + '/token')).status, 404, 'GET /token is not a route');

      const withBody = await app.post(MOUNT_PATH + '/token', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ heard: 'three four five' }),
      });
      assert.equal(withBody.status, 400);
      assert.equal((await withBody.json()).code, 'VOICE_LAB_NO_PAYLOAD');
      assert.equal(sts.calls.length, 0, 'a request carrying content never mints');
    } finally {
      await app.close();
    }
  });
});

test('row 6: no other backend file mounts or names a voicelab route', () => {
  const root = path.join(__dirname, '..');
  const allowed = new Set([
    path.join('routes', 'voiceLab.js'),
    path.join('routes', 'voiceLab.test.js'),
    path.join('routes', 'auth.js'), // the boolean on /auth/me, not a route
    path.join('server.js'),
  ]);
  const offenders = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name.endsWith('.js')) {
        const rel = path.relative(root, full);
        if (allowed.has(rel)) continue;
        if (/\/voicelab\b|voiceLab'\)|routes\/voiceLab/.test(fs.readFileSync(full, 'utf8'))) offenders.push(rel);
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders.filter((f) => !f.startsWith(path.join('test', 'voiceMediaGuard'))), []);
});

// ── 7. zero Open Dental ─────────────────────────────────────────────────────

/** Every relative module the lab route can load, transitively. */
function labModuleGraph() {
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
  visit(path.join(__dirname, 'voiceLab.js'));
  return [...seen].map((f) => path.relative(path.join(__dirname, '..'), f).split(path.sep).join('/'));
}

test('row 7: the lab module graph cannot reach an Open Dental client', () => {
  const graph = labModuleGraph();
  assert.ok(graph.includes('routes/voiceLab.js') && graph.includes('services/voiceLab/labBudget.js'), 'non-vacuous');
  const od = graph.filter((f) => /openDental|odOffices|odAccess|odClient|\/hyg\/od/i.test(f));
  assert.deepEqual(od, [], 'the lab loads no Open Dental module');
});

test('row 7: driving every lab path makes ZERO Open Dental requests (asserted on the OD fake)', async () => {
  await withStateDir(async () => {
    const od = new FakeOd({});
    const getOdOfficeCalls = [];
    const original = odOffices.getOdOffice;
    odOffices.getOdOffice = (...args) => {
      getOdOfficeCalls.push(args);
      return { officeKey: String(args[0]), officeName: 'fake', commTypeDefNum: 0, client: od };
    };
    // Every outbound request the process makes while the lab runs.
    const outbound = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.startsWith('http://127.0.0.1')) return realFetch(url, init);
      outbound.push(u);
      return new Response(MINTED, { status: 200 });
    };
    try {
      // fetchImpl omitted: the lab uses the global fetch, so the spy sees it.
      const app = await bootApp({ env: { ...STAGING, VOICE_LAB_DAILY_MINUTES: '20' }, budget: freshBudget({ VOICE_LAB_DAILY_MINUTES: '20' }) });
      try {
        assert.equal((await app.post(MOUNT_PATH + '/token')).status, 200); // success
        assert.equal((await app.post(MOUNT_PATH + '/token')).status, 200);
        assert.equal((await app.post(MOUNT_PATH + '/token')).status, 429); // budget refusal
        const body = await app.post(MOUNT_PATH + '/token', {
          headers: { 'Content-Type': 'application/json' },
          body: '{"x":1}',
        });
        assert.equal(body.status, 400); // payload refusal
        assert.equal((await app.post(MOUNT_PATH + '/nope')).status, 404);
      } finally {
        await app.close();
      }
    } finally {
      globalThis.fetch = realFetch;
      odOffices.getOdOffice = original;
    }

    assert.deepEqual(od.calls, [], 'no Open Dental read');
    assert.deepEqual(od.writes, [], 'no Open Dental write');
    assert.deepEqual(getOdOfficeCalls, [], 'no Open Dental office handle was even requested');
    assert.ok(outbound.length === 2, 'the two successes reached Azure: ' + outbound.length);
    for (const u of outbound) {
      assert.match(u, /^https:\/\/southcentralus\.api\.cognitive\.microsoft\.com\/sts\/v1\.0\/issueToken$/);
    }
  });
});

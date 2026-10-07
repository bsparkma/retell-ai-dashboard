'use strict';

/**
 * VOICE MEDIA IS NEVER RETAINED — a red-list rail, enforced by source scan.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS, AND WHY IT OUTLIVES THE VOICE LAB
 * ═════════════════════════════════════════════════════════════════════════════
 * Voice decision V-2: media is never persisted. Azure's real-time and fast
 * speech-to-text retain nothing by default. The 2026-10-06 Azure inspection
 * found the ways that changes, and every one of them is a NAME in code:
 *
 *   - the SDK's audio-logging switch (`enableAudioLogging()`, or the
 *     `SpeechServiceConnection_EnableAudioLogging` property) — 30-day retention
 *   - `storeAudio=true` on a request
 *   - a custom-model endpoint with content logging (`contentLoggingEnabled`,
 *     and the SDK's custom-model hooks `endpointId` / `fromEndpoint`)
 *   - a batch job told where to drop results (`destinationContainerUrl`)
 *   - `setServiceProperty`, the SDK's generic way to set any of the above
 *
 * So the rail is: none of those names appears in backend/ or the dashboard;
 * no code writes audio to disk or /data; the browser never records audio
 * locally (MediaRecorder); and the Speech SDK is imported in exactly ONE
 * dashboard file, the voice lab's session. Perio voice inherits this file —
 * when it needs the SDK, it changes SDK_ALLOWED below on purpose, in review.
 *
 * The scan is a function over two roots, so the "it bites" tests below can run
 * it over a planted copy and watch it fail — the same proof item 32's audit
 * test gave. A guard that has never been seen to fail proves nothing.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BACKEND_ROOT = path.join(__dirname, '..');
const DASHBOARD_ROOT = path.join(__dirname, '..', '..', 'new-dashboard');
const DASHBOARD_DIRS = ['client', 'shared', 'server'];
const SOURCE_EXT = /\.(c|m)?(j|t)sx?$/;
const SDK = 'microsoft-cognitiveservices-speech-sdk';

/** The only dashboard file allowed to import the Speech SDK (posix, relative to new-dashboard/). */
const SDK_ALLOWED = Object.freeze(['client/src/pages/voicelab/speechSession.ts']);

/** Names that turn on Azure-side retention. Case-insensitive. */
const RETENTION_NAMES = Object.freeze([
  ['enableAudioLogging', /enableAudioLogging/i],
  ['storeAudio', /storeAudio/i],
  ['contentLoggingEnabled', /contentLoggingEnabled/i],
  ['destinationContainerUrl', /destinationContainerUrl/i],
  ['setServiceProperty', /setServiceProperty/i],
  ['endpointId (custom model)', /\bendpointId\b/i],
  ['fromEndpoint (custom model)', /\bfromEndpoint\b/],
]);

/** A disk write on a line that names audio. */
const DISK_WRITE = /\b(writeFile|writeFileSync|createWriteStream|appendFile|appendFileSync)\s*\(/;
const AUDIO_WORD = /audio|recording|\.(wav|mp3|pcm|webm|ogg|m4a|opus|flac)\b/i;

/** The lab's own files may not touch persistence of any kind. */
const LAB_FILE = /(^|\/)(voiceLab|voicelab)(\/|\.|$)/;
const LAB_PERSISTENCE = Object.freeze([
  ['fs module', /require\(\s*['"](node:)?fs(\/promises)?['"]\s*\)|from\s+['"](node:)?fs/],
  ['localStorage', /\blocalStorage\b/],
  ['sessionStorage', /\bsessionStorage\b/],
  ['indexedDB', /\bindexedDB\b/],
  ['a /data path', /['"`]\/data\b/],
  ['createObjectURL', /createObjectURL/],
]);

/** Strip comments so prose explaining a rule never trips it. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

/** Every source file under `root`, skipping node_modules, build output, and dotdirs. */
function walk(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const visit = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) visit(full);
      else if (SOURCE_EXT.test(ent.name)) out.push(full);
    }
  };
  visit(root);
  return out;
}

/**
 * Scan both trees. Returns offenders as `{ file, rule }` with posix paths
 * relative to their root, prefixed `backend/` or `new-dashboard/`.
 *
 * @param {{ backendRoot: string, dashboardRoot: string, self?: string }} roots
 */
function scan({ backendRoot, dashboardRoot, self = __filename }) {
  /** @type {{ file: string, rule: string }[]} */
  const offenders = [];
  /** @type {string[]} */
  const sdkImporters = [];

  const files = [
    ...walk(backendRoot).map((f) => ({ f, tree: 'backend', root: backendRoot })),
    ...DASHBOARD_DIRS.flatMap((d) =>
      walk(path.join(dashboardRoot, d)).map((f) => ({ f, tree: 'new-dashboard', root: dashboardRoot }))
    ),
  ];

  for (const { f, tree, root } of files) {
    if (path.resolve(f) === path.resolve(self)) continue; // this file names the red list to define it
    const rel = path.relative(root, f).split(path.sep).join('/');
    const label = `${tree}/${rel}`;
    const code = stripComments(fs.readFileSync(f, 'utf8'));
    const isTest = /\.test\.(c|m)?(j|t)sx?$/.test(rel) || rel.startsWith('test/') || rel.startsWith('tests/');

    for (const [rule, re] of RETENTION_NAMES) {
      if (re.test(code)) offenders.push({ file: label, rule });
    }

    if (code.includes(SDK)) {
      if (tree === 'backend') offenders.push({ file: label, rule: 'speech SDK imported in the backend' });
      else sdkImporters.push(rel);
    }

    if (tree === 'new-dashboard' && /\bMediaRecorder\b/.test(code)) {
      offenders.push({ file: label, rule: 'MediaRecorder (local audio recording)' });
    }

    if (!isTest) {
      for (const line of code.split('\n')) {
        if (DISK_WRITE.test(line) && AUDIO_WORD.test(line)) {
          offenders.push({ file: label, rule: 'writes audio to disk' });
          break;
        }
      }
    }

    if (LAB_FILE.test(rel) && !isTest) {
      for (const [rule, re] of LAB_PERSISTENCE) {
        if (re.test(code)) offenders.push({ file: label, rule: `lab file names ${rule}` });
      }
    }
  }

  for (const rel of sdkImporters) {
    if (!SDK_ALLOWED.includes(rel)) {
      offenders.push({ file: `new-dashboard/${rel}`, rule: 'speech SDK imported outside the voice lab session' });
    }
  }

  return { offenders, sdkImporters, fileCount: files.length };
}

// ── the real tree ───────────────────────────────────────────────────────────

test('the scan is scanning something: both trees, and the one SDK file really imports it', () => {
  const { sdkImporters, fileCount } = scan({ backendRoot: BACKEND_ROOT, dashboardRoot: DASHBOARD_ROOT });
  assert.ok(fileCount > 200, 'expected hundreds of source files across both trees, found ' + fileCount);
  assert.ok(
    fs.existsSync(path.join(DASHBOARD_ROOT, 'client', 'src', 'App.tsx')),
    'the dashboard tree is present, so its half of the scan is not vacuous'
  );
  assert.deepEqual(sdkImporters, [...SDK_ALLOWED], 'the allow-listed file is the SDK importer, and the only one');
});

test('RED LIST: nothing in backend/ or the dashboard can turn on Azure-side audio or text retention', () => {
  const { offenders } = scan({ backendRoot: BACKEND_ROOT, dashboardRoot: DASHBOARD_ROOT });
  assert.deepEqual(offenders, []);
});

test('the backend does not depend on the Speech SDK at all', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(BACKEND_ROOT, 'package.json'), 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.ok(!(SDK in deps), 'backend/package.json lists ' + SDK);
});

test('the dashboard pins the Speech SDK to an exact version', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(DASHBOARD_ROOT, 'package.json'), 'utf8'));
  const spec = (pkg.dependencies || {})[SDK];
  assert.match(String(spec), /^\d+\.\d+\.\d+$/, 'expected an exact pin, found ' + spec);
});

// ── it bites ────────────────────────────────────────────────────────────────

/**
 * A planted copy: the real voice lab session file and a real backend route,
 * copied into a temp tree, with one line added. The scan must name it.
 */
function plantedTree({ sessionAppend = '', homeAppend = '', backendAppend = '', labBackendAppend = '' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-guard-'));
  const backendRoot = path.join(root, 'backend');
  const dashboardRoot = path.join(root, 'new-dashboard');
  const copy = (from, to, append) => {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, fs.readFileSync(from, 'utf8') + (append ? '\n' + append + '\n' : ''));
  };
  copy(
    path.join(DASHBOARD_ROOT, 'client', 'src', 'pages', 'voicelab', 'speechSession.ts'),
    path.join(dashboardRoot, 'client', 'src', 'pages', 'voicelab', 'speechSession.ts'),
    sessionAppend
  );
  copy(
    path.join(DASHBOARD_ROOT, 'client', 'src', 'pages', 'Home.tsx'),
    path.join(dashboardRoot, 'client', 'src', 'pages', 'Home.tsx'),
    homeAppend
  );
  copy(path.join(BACKEND_ROOT, 'routes', 'mango.js'), path.join(backendRoot, 'routes', 'mango.js'), backendAppend);
  copy(
    path.join(BACKEND_ROOT, 'routes', 'voiceLab.js'),
    path.join(backendRoot, 'routes', 'voiceLab.js'),
    labBackendAppend
  );
  return { backendRoot, dashboardRoot };
}

test('it bites: the unplanted copy is clean, so any failure below comes from the plant', () => {
  const { offenders, sdkImporters } = scan(plantedTree({}));
  assert.deepEqual(offenders, []);
  assert.deepEqual(sdkImporters, [...SDK_ALLOWED]);
});

test('it bites: enableAudioLogging planted in a copy of the lab session FAILS the guard', () => {
  const { offenders } = scan(plantedTree({ sessionAppend: 'speechConfig.enableAudioLogging();' }));
  assert.deepEqual(offenders, [
    { file: 'new-dashboard/client/src/pages/voicelab/speechSession.ts', rule: 'enableAudioLogging' },
  ]);
});

test('it bites: every red-list name is caught, in either tree', () => {
  const plants = [
    ['speechConfig.setProperty(PropertyId.SpeechServiceConnection_EnableAudioLogging, "true");', 'enableAudioLogging'],
    ['const body = { storeAudio: true };', 'storeAudio'],
    ['const props = { contentLoggingEnabled: true };', 'contentLoggingEnabled'],
    ['const job = { destinationContainerUrl: "https://x" };', 'destinationContainerUrl'],
    ['speechConfig.setServiceProperty("x", "y", 0);', 'setServiceProperty'],
    ['speechConfig.endpointId = "custom";', 'endpointId (custom model)'],
    ['SpeechConfig.fromEndpoint(new URL("https://x"));', 'fromEndpoint (custom model)'],
  ];
  for (const [line, rule] of plants) {
    const dash = scan(plantedTree({ sessionAppend: line })).offenders.map((o) => o.rule);
    assert.ok(dash.includes(rule), `dashboard plant "${line}" → ${JSON.stringify(dash)}`);
    const back = scan(plantedTree({ backendAppend: line })).offenders.map((o) => o.rule);
    assert.ok(back.includes(rule), `backend plant "${line}" → ${JSON.stringify(back)}`);
  }
});

test('it bites: importing the Speech SDK outside the lab session, or in the backend', () => {
  const dash = scan(plantedTree({ homeAppend: `import { SpeechConfig } from "${SDK}";` }));
  assert.deepEqual(dash.offenders, [
    { file: 'new-dashboard/client/src/pages/Home.tsx', rule: 'speech SDK imported outside the voice lab session' },
  ]);
  const back = scan(plantedTree({ backendAppend: `const sdk = require('${SDK}');` }));
  assert.deepEqual(back.offenders, [{ file: 'backend/routes/mango.js', rule: 'speech SDK imported in the backend' }]);
});

test('it bites: writing audio to disk or /data, and recording audio in the browser', () => {
  const disk = scan(plantedTree({ backendAppend: "fs.writeFileSync('/data/call-audio.wav', buf);" }));
  assert.deepEqual(disk.offenders, [{ file: 'backend/routes/mango.js', rule: 'writes audio to disk' }]);

  const stream = scan(plantedTree({ backendAppend: 'fs.createWriteStream(recordingPath);' }));
  assert.deepEqual(stream.offenders, [{ file: 'backend/routes/mango.js', rule: 'writes audio to disk' }]);

  const rec = scan(plantedTree({ homeAppend: 'const r = new MediaRecorder(stream);' }));
  assert.deepEqual(rec.offenders, [
    { file: 'new-dashboard/client/src/pages/Home.tsx', rule: 'MediaRecorder (local audio recording)' },
  ]);
});

test('it bites: a lab file that reaches for any persistence at all', () => {
  const ls = scan(plantedTree({ sessionAppend: 'localStorage.setItem("lastRun", "x");' })).offenders;
  assert.deepEqual(ls, [
    { file: 'new-dashboard/client/src/pages/voicelab/speechSession.ts', rule: 'lab file names localStorage' },
  ]);
  const fsReq = scan(plantedTree({ labBackendAppend: "const fs = require('fs');" })).offenders;
  assert.deepEqual(fsReq, [{ file: 'backend/routes/voiceLab.js', rule: 'lab file names fs module' }]);
  const data = scan(plantedTree({ labBackendAppend: "const out = '/data/voicelab';" })).offenders;
  assert.deepEqual(data, [{ file: 'backend/routes/voiceLab.js', rule: 'lab file names a /data path' }]);
});

test('it bites: a comment explaining a rule does not trip it, but the same name in code does', () => {
  const commented = scan(plantedTree({ sessionAppend: '// never call enableAudioLogging here' })).offenders;
  assert.deepEqual(commented, []);
  const coded = scan(plantedTree({ sessionAppend: 'const off = "enableAudioLogging";' })).offenders;
  assert.equal(coded.length, 1);
});

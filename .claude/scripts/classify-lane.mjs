#!/usr/bin/env node
// classify-lane.mjs — the build loop's mechanical lane floor (queue item 29).
//
// READ-ONLY. Path + diff based. It never edits, stages, commits or pushes anything,
// and it is not application code: nothing under backend/ or new-dashboard/ imports it.
//
// It can only push a slice TOWARD red. A GREEN from this script is NECESSARY, NOT
// SUFFICIENT: the orchestrator and the reviewer still apply the full red list in
// CLAUDE.md ("Build loop") by judgment, and either of them may call a slice RED that
// this script passed. Nothing — no flag, no argument — turns a RED here into GREEN.
// When it cannot tell, it says RED. Misclassifying red-as-green is the one
// unforgivable error; a false red costs one human click.
//
// Usage — run from the REPO ROOT of the worktree (the removed-text check greps the
// test tree relative to the current directory):
//   node .claude/scripts/classify-lane.mjs                       # diff origin/develop...HEAD
//   node .claude/scripts/classify-lane.mjs --base <ref>          # diff <ref>...HEAD
//   node .claude/scripts/classify-lane.mjs --diff-file <path>    # a saved unified git diff
//   ... [--queue <queue-file.md>]                                # also honour LANE: RED in the plan
//
// Output: `LANE: GREEN` or `LANE: RED`, then one `- <file>: <reason>` line per hit.
// Exit code: 0 = GREEN, 2 = RED, 3 = could not classify (treat as RED).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------- args
function parseArgs(argv) {
  const out = { base: 'origin/develop', diffFile: null, queue: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--base') out.base = argv[++i];
    else if (a === '--diff-file') out.diffFile = argv[++i];
    else if (a === '--queue') out.queue = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

// ---------------------------------------------------------------- path rules
// Any path matching any of these is RED regardless of content.
const PATH_RULES = [
  [/^backend\/migrations(-tenant)?\//, 'database migration (backend/migrations*/)'],
  [/(^|\/)\.github\//, 'CI / workflow config (.github/)'],
  [/^\.claude\//, 'build-loop configuration (.claude/)'],
  [/(^|\/)CLAUDE\.md$/, 'CLAUDE.md'],
  [/(^|\/)\.gitignore$/, 'ignore rules (can expose PHI paths such as data/ or recordings/)'],
  [/(^|\/)\.env(\.|$)/, 'environment / secrets file'],
  [/(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml)$/, 'dependency or lockfile change (contract bundle is byte-compared)'],
  [/(^|\/)(Dockerfile|Caddyfile|nginx\.conf|ecosystem\.config\.c?js)$|^deploy\//, 'deploy / infra config'],

  // Open Dental write paths and their guards
  [/(^|\/)od[A-Z]\w*Writ\w*\.js$/, 'Open Dental write path (od*Writ*.js)'],
  [/(^|\/)odWriter\.js$|(^|\/)odPerioWriter\.js$/, 'Open Dental write path (odWriter / odPerioWriter)'],
  [/^backend\/config\/openDental\.js$/, 'Open Dental client (apiWriteRaw / apiDeleteRaw live here)'],
  [/^backend\/(services|routes)\/openDental(Sync)?\.js$/, 'Open Dental sync / commlog write path'],
  [/^backend\/services\/commlogTypes\.js$/, 'CommType DefNums'],
  [/^backend\/routes\/webhooks\.js$/, 'webhook path (COMMLOG_AUTO_WRITE lives here; unauthenticated-by-tenant, HMAC-verified)'],
  [/^backend\/services\/rcm\/postingDrain\.js$/, 'RCM drain (posts to Open Dental)'],
  [/hygFixtureGate/, 'hygFixtureGate (test-patient write gate)'],
  [/NoOdWrites/, '*NoOdWrites* guard test'],
  [/^backend\/scripts\//, 'operator script (several of these write to Open Dental)'],

  // Office / PatNum derivation
  [/^backend\/config\/(odOffices|officeAgents)\.js$/, 'office / PatNum derivation or per-office DefNums'],

  // normalizeCall and its preservation whitelist
  [/^backend\/services\/unifiedCallStore\.js$/, 'unified call store (normalizeCall preservation whitelist)'],

  // Secrets / auth / tenancy / Key Vault
  [/^backend\/config\/(secrets|sso)\.js$/, 'secrets / SSO config'],
  [/^backend\/middleware\//, 'auth / tenant / env-guard middleware'],
  [/^backend\/routes\/auth\.js$/, 'auth route'],
  [/^backend\/platform\//, 'tenant platform seam (registry / tenantDb / odAccess)'],
  [/^backend\/server\.js$/, 'server.js (auth gate + module-guard mount table)'],
  [/^new-dashboard\/client\/src\/(lib\/auth\.ts|contexts\/AuthContext\.tsx|components\/RequireAuth\.tsx)$/, 'client auth'],

  // Transcription breaker
  [/^backend\/services\/(transcriptionService|onDemandTranscription\w*)\.js$/, 'transcription budget breaker'],
  [/^backend\/config\/mango\.js$/, 'Mango ingestion / auto-transcribe switches'],

  // Shared vocabularies (the 10/1 class of defect)
  [/(^|\/)\w*[Vv]ocabulary\.(c?js|ts)$/, 'shared vocabulary file'],
  [/^new-dashboard\/client\/src\/lib\/modules\.ts$/, 'module-name vocabulary (MODULE_IDS)'],
  [/^backend\/tc\/|^new-dashboard\/shared\//, 'shared server/client contract'],
  [/(^|\/)\w*(status|chip|label|reason|enum|constants?)\w*\.(c?js|mjs|tsx?)$/i, 'status / label / enum map (vocabulary consumer)'],
];

const TEST_FILE = /(\.test\.[cm]?[jt]sx?$)|(^|\/)tests?\//;
const CODE_FILE = /\.(c?js|mjs|tsx?|jsx|sql|json|ya?ml)$/;

// ---------------------------------------------------------------- content rules
// Applied to ADDED and REMOVED lines of code files. Any hit is RED, with the reason.
const CONTENT_RULES = [
  [/\bCHECK\s*\(/i, 'touches a CHECK constraint (shared vocabulary)'],
  [/z\.enum\s*\(|\benum\s+[A-Z]\w*/, 'touches an enum (shared vocabulary)'],
  [/(["'`])[a-z][a-z0-9_]*\1\s*\||\|\s*(["'`])[a-z][a-z0-9_]*\2/, 'touches a string-literal union (status / enum / slug)'],
  [/\b(status|reason|outcome|module|office|lane|role|flag|code|disposition)\w*["']?\s*[:=]\s*["'`][a-z][a-z0-9_]*["'`]/i, 'assigns a machine slug (status / reason / module / office / code)'],
  [/\b(router|app)\s*\.\s*(get|post|put|patch|delete|use)\s*\(/, 'route definition (machine route)'],
  [/<Route\b|\bpath\s*[:=]\s*["'`]\//, 'client route (machine route)'],
  [/process\.env\.[A-Z_]+/, 'reads an env var (switch / secret)'],
  [/DefNum/i, 'CommType / PayType / DefNum'],
  [/\b(od_patient_id|od_patient_office|odPatientId|PatNum|patNum|officeKey|office_id|target_office|getOfficeForCall|assertOfficeMatch|getOdOffice)\b/, 'office / PatNum derivation'],
  [/\b(normalizeCall|addRetellCall|addCallInternal)\b/, 'normalizeCall / preservation whitelist'],
  [/\b(apiWriteRaw|apiDeleteRaw)\b|commlog/i, 'Open Dental write'],
  [/\b(COMMLOG_AUTO_WRITE|OPENDENTAL_WRITE_DISABLED|MAX_TRANSCRIPTION_MINUTES_PER_DAY|checkDailyBudget|TRANSCRIPTION_BUDGET_EXCEEDED|MANGO_AUTO_TRANSCRIBE)\b/, 'safety switch / transcription breaker'],
  [/\b(secret|password|api_?key|bearer|KeyVault|keyvault|loadSecrets)\b/i, 'secrets / auth'],
  [/\brequireModule\b|\bMODULE_IDS\b|\bisEntitledModule\b/, 'module entitlement'],
  [/\baudit(_log)?\b.*\b(prior_state|action)\b|\bprior_state\b/, 'audit_log vocabulary'],
];

// A possible real phone number anywhere in an added line (any file). The reviewer
// must confirm it is synthetic; the script cannot, so it is RED.
const PHONE = /\b\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/;

// ---------------------------------------------------------------- diff parsing
function parseUnifiedDiff(text) {
  const files = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const head = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (head) {
      cur = { oldPath: head[1], path: head[2], status: 'M', added: [], removed: [], binary: false };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (/^new file mode/.test(line)) cur.status = 'A';
    else if (/^deleted file mode/.test(line)) cur.status = 'D';
    else if (/^rename from /.test(line)) cur.status = 'R';
    else if (/^Binary files /.test(line) || /^GIT binary patch/.test(line)) cur.binary = true;
    else if (line.startsWith('+++') || line.startsWith('---')) continue;
    else if (line.startsWith('+')) cur.added.push(line.slice(1));
    else if (line.startsWith('-')) cur.removed.push(line.slice(1));
  }
  return files;
}

function readDiff(opts) {
  if (opts.diffFile) return readFileSync(opts.diffFile, 'utf8');
  return execFileSync('git', ['diff', '-M', '--no-color', '-U0', `${opts.base}...HEAD`], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
}

// ---------------------------------------------------------------- removed text vs tests
// Every run of 4 consecutive words from removed prose / string literals. Tests usually
// match a FRAGMENT of copy (`getByText(/Choose where you want to work/)`), so the whole
// line is too strict a needle; four words is distinctive and still catches fragments.
function removedTextWindows(removed) {
  const texts = [];
  for (const raw of removed) {
    const l = raw.trim();
    for (const m of l.matchAll(/(["'`])((?:(?!\1).){8,})\1/g)) texts.push(m[2]);
    if (l.length >= 12 && !/[<>{}=;()]/.test(l)) texts.push(l); // bare JSX text
  }
  const out = new Set();
  for (const t of texts) {
    const words = t.split(/\s+/).filter(Boolean);
    if (words.length < 4) {
      if (t.length >= 12) out.add(t);
      continue;
    }
    for (let i = 0; i + 4 <= words.length; i += 1) out.add(words.slice(i, i + 4).join(' '));
  }
  return [...out].slice(0, 200);
}

// Returns matching `path:line` hits, [] for none, or null if the search itself failed.
function grepTests(needles) {
  const args = ['grep', '-n', '-I', '-F'];
  for (const n of needles) args.push('-e', n);
  args.push('--', 'new-dashboard/tests', 'backend/test', '*.test.js', '*.test.ts', '*.test.tsx', '*.test.mjs');
  try {
    const outText = execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return outText.split(/\r?\n/).filter(Boolean).map((l) => l.split(':').slice(0, 2).join(':'));
  } catch (err) {
    if (err && err.status === 1) return []; // git grep: no match
    return null;
  }
}

// ---------------------------------------------------------------- classify
function classify(files, queueText) {
  const reasons = [];
  const hit = (file, why) => reasons.push(`${file}: ${why}`);

  if (files.length === 0) hit('(diff)', 'empty or unparseable diff — nothing to classify');

  for (const f of files) {
    const paths = f.oldPath !== f.path ? [f.oldPath, f.path] : [f.path];
    for (const p of paths) {
      for (const [re, why] of PATH_RULES) if (re.test(p)) hit(p, why);
    }
    if (f.status === 'D') hit(f.path, 'deletes a file');
    if (f.status === 'R') hit(f.path, `renames ${f.oldPath} (unsure ⇒ red)`);
    if (f.binary && !/^docs\/screenshots\//.test(f.path)) hit(f.path, 'binary file outside docs/screenshots/');

    if (TEST_FILE.test(f.path) && f.status !== 'A' && f.removed.length > 0) {
      hit(f.path, 'changes or removes lines in an EXISTING test (possible assertion change)');
    }

    if (CODE_FILE.test(f.path)) {
      const lines = [...f.added.map((l) => ['+', l]), ...f.removed.map((l) => ['-', l])];
      const seen = new Set();
      for (const [sign, l] of lines) {
        for (const [re, why] of CONTENT_RULES) {
          if (re.test(l) && !seen.has(why)) {
            seen.add(why);
            hit(f.path, `${why}  [${sign}${l.trim().slice(0, 80)}]`);
          }
        }
      }
    }
    for (const l of f.added) {
      if (PHONE.test(l)) {
        hit(f.path, 'possible phone number in an added line — reviewer must confirm it is synthetic');
        break;
      }
    }
  }

  // A non-test change can still break an EXISTING test's assertion — the test file is
  // then not in the diff at all (found by the reviewer's independent run on the item-29
  // demo: a "pure copy change" whose old wording a test asserts on). So: for text a
  // non-test file REMOVES, look for it in the test tree. A hit means the slice either
  // ships a red test or must edit an existing assertion — RED either way.
  for (const f of files) {
    if (TEST_FILE.test(f.path) || !CODE_FILE.test(f.path)) continue;
    const windows = removedTextWindows(f.removed);
    if (windows.length === 0) continue;
    const found = grepTests(windows);
    if (found === null) hit(f.path, 'could not search the test tree for removed text (unsure ⇒ red)');
    else if (found.length > 0) {
      hit(f.path, `removed text is asserted on by an existing test: ${found.slice(0, 3).join('; ')}`);
    }
  }

  if (queueText && /\bLANE\s*:\s*RED\b|\bRED[- ]LANE\b/i.test(queueText)) {
    hit('(queue file)', 'the queue file itself marks this slice RED');
  }
  return reasons;
}

// ---------------------------------------------------------------- main
try {
  const opts = parseArgs(process.argv.slice(2));
  const files = parseUnifiedDiff(readDiff(opts));
  const queueText = opts.queue ? readFileSync(opts.queue, 'utf8') : null;
  const reasons = classify(files, queueText);
  const lane = reasons.length === 0 ? 'GREEN' : 'RED';
  console.log(`LANE: ${lane}`);
  console.log(`files: ${files.map((f) => `${f.status} ${f.path}`).join(', ') || '(none)'}`);
  for (const r of reasons) console.log(`- ${r}`);
  if (lane === 'GREEN') {
    console.log('note: GREEN here is necessary, not sufficient — apply the CLAUDE.md red list by judgment too.');
  }
  process.exit(lane === 'GREEN' ? 0 : 2);
} catch (err) {
  console.log('LANE: RED');
  console.log(`- (classifier): could not classify — ${err && err.message ? err.message : String(err)}`);
  process.exit(3);
}

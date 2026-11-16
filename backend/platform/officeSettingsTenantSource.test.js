'use strict';

/**
 * MT-2b INVARIANT: no reader of a per-office setting takes its tenant from
 * client input. A source scan over every route file that asks one.
 *
 *   1. platform/sessionTenant.js reads req.tenant.slug and nothing else.
 *   2. Every reader call in a route passes `sessionTenantSlug(req)`, or a
 *      `tenantSlug` that is itself held to rule 3.
 *   3. In a route, a `tenantSlug` is only ever: the session tenant
 *      (`const tenantSlug = sessionTenantSlug(req)`, `tenantSlug:
 *      sessionTenantSlug(req)`), or the parameter of a function in the same
 *      file whose every call passes the session tenant (or forwards its own).
 *   4. No route file that reads a per-office setting reads a slug, or a bare
 *      `tenant` field, from req.query / req.body / req.params / req.headers.
 *
 * The public referral-link pages (routes/referralLinkWebhooks.js) are covered
 * by 2: their req.tenant is attached from TC_EMAIL_TENANT_SLUG by attachTenant()
 * before any page renders (MT-3 replaces that), never from the request.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BACKEND = path.join(__dirname, '..');

/** Route files that read a per-office setting (MT-2b's changed routes). */
const ROUTE_FILES = [
  'routes/platform.js',
  'routes/printTemplates.js',
  'routes/referralLinkWebhooks.js',
  'routes/setupStatus.js',
  'routes/hyg/day.js',
  'routes/hyg/dayCheckoutQuestions.js',
  'routes/hyg/helpers.js',
  'routes/hyg/index.js',
  'routes/hyg/visit.js',
  'routes/tc/cases.js',
  'routes/tc/checkout.js',
  'routes/tc/checkoutPrint.js',
  'routes/tc/emailIdentity.js',
  'routes/tc/hygiene.js',
  'routes/tc/nurture.js',
  'routes/tc/odSync.js',
  'routes/tc/referralCreate.js',
  'routes/tc/referralSend.js',
  'routes/tc/referralSignoff.js',
  'routes/tc/referrals.js',
];

/** receiver.method calls that take the tenant FIRST. */
const READER_CALL = new RegExp(
  String.raw`\b(?:` +
    [
      String.raw`(?:tcCheckout|tcOdSync|tcAutoCheckout|tcReferrals|tcReferralEmail|tcReferralPatientEmail)\.(?:isEnabled|enabledFor|officeState|refreshFromDb|persist|sourceFor|ensureFresh)`,
      String.raw`hygPilot\.(?:hygEnabledFor|officeState|refreshFromDb|persistHygEnabled|settingMeta|policyKnown|sourceFor)`,
      String.raw`emailIdentity\.(?:storedValue|referralBccFor|refreshFromDb|ensureFresh|readStoredFromDb|persist|meta)`,
      String.raw`(?:acsConfig|acsEmail)\.(?:replyToFor|practiceDetailsFor|practiceNameFor|identityStateFor)`,
      String.raw`odOffices\.(?:hygOdBlockReason|isHygOdReady|hygSwitchState)`,
      String.raw`autoCheckout\.isOn`,
      String.raw`store\.prefillFor`,
      String.raw`referralSend\.emailSendStatus`,
      String.raw`referralLetter\.(?:unavailableReason|officeMissing|assertAvailable|bccFor)`,
      String.raw`officeSettings\.(?:ensureTenantFresh|ensureFresh|refreshFromDb)`,
      String.raw`(?<![.\w])realOffices`,
    ].join('|') +
    String.raw`)\(`,
  'g'
);

/** receiver.method calls whose tenant is the SECOND argument. */
const READER_CALL_SECOND = /\b(?:cfg\.(?:isOfficeOn|switchedOnOffices)|referralLetter\.(?:transport|requestBytes))\(/g;

const ALLOWED = new Set(['sessionTenantSlug(req)', 'tenantSlug']);

/**
 * The argument list of the call whose `(` is at `open`.
 * @param {string} src
 * @param {number} open
 * @returns {string[]}
 */
function argsAt(src, open) {
  let depth = 0;
  let cur = '';
  /** @type {string[]} */
  const args = [];
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
      if (depth === 1) continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) {
        args.push(cur.trim());
        return args;
      }
    }
    if (ch === ',' && depth === 1) {
      args.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  return args;
}

/**
 * A route file's source with comments blanked (block comments, and whole-line
 * `//` comments), so prose naming a reader is not scanned as a call.
 * @param {string} rel
 * @returns {string}
 */
function read(rel) {
  return fs
    .readFileSync(path.join(BACKEND, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .replace(/^\s*\/\/.*$/gm, '');
}

/** Is the match at `index` a function DECLARATION rather than a call? */
function isDeclaration(src, index) {
  return /function\s+$/.test(src.slice(Math.max(0, index - 12), index));
}

test('sessionTenantSlug reads req.tenant.slug and nothing else', () => {
  const src = read('platform/sessionTenant.js');
  assert.doesNotMatch(src, /req\.(query|body|params|headers|get\(|header\()/);
  assert.match(src, /req\.tenant\s*\?\s*req\.tenant\.slug/);
  const { sessionTenantSlug } = require('./sessionTenant');
  assert.equal(sessionTenantSlug({ tenant: { slug: 'carein' } }), 'carein');
  assert.equal(
    sessionTenantSlug(/** @type {never} */ ({ query: { tenant: 'acme' }, body: { tenant: 'acme' }, headers: { 'x-tenant': 'acme' } })),
    null
  );
  assert.equal(sessionTenantSlug(null), null);
  assert.equal(sessionTenantSlug({ tenant: { slug: '' } }), null);
});

test('every reader call in a route passes the SESSION tenant', () => {
  /** @type {string[]} */
  const bad = [];
  let calls = 0;
  for (const rel of ROUTE_FILES) {
    const src = read(rel);
    for (const m of src.matchAll(READER_CALL)) {
      const at = /** @type {number} */ (m.index);
      if (isDeclaration(src, at)) continue;
      const first = argsAt(src, at + m[0].length - 1)[0];
      calls += 1;
      if (!ALLOWED.has(first)) bad.push(`${rel}: ${m[0]}${first})`);
    }
    for (const m of src.matchAll(READER_CALL_SECOND)) {
      const at = /** @type {number} */ (m.index);
      const second = argsAt(src, at + m[0].length - 1)[1];
      calls += 1;
      if (!ALLOWED.has(second)) bad.push(`${rel}: ${m[0]}…, ${second})`);
    }
    for (const m of src.matchAll(/\bresolveHygOd\(/g)) {
      const at = /** @type {number} */ (m.index);
      if (isDeclaration(src, at)) continue;
      const first = argsAt(src, at + m[0].length - 1)[0];
      calls += 1;
      if (first !== 'req') bad.push(`${rel}: resolveHygOd(${first}`);
    }
  }
  assert.deepEqual(bad, []);
  assert.ok(calls >= 60, `scanned ${calls} reader calls — the scan has stopped matching`);
});

test("a route's `tenantSlug` is only ever the session tenant, or forwarded from it", () => {
  /** @type {string[]} */
  const bad = [];
  let helpers = 0;
  for (const rel of ROUTE_FILES) {
    const src = read(rel);
    // Positional: function name(tenantSlug, ...), and every same-file call of it.
    for (const d of src.matchAll(/function\s+(\w+)\(\s*tenantSlug\b/g)) {
      helpers += 1;
      const name = d[1];
      for (const c of src.matchAll(new RegExp(String.raw`(?<![\w.])${name}\(`, 'g'))) {
        const at = /** @type {number} */ (c.index);
        if (isDeclaration(src, at)) continue;
        const first = argsAt(src, at + c[0].length - 1)[0];
        if (!ALLOWED.has(first)) bad.push(`${rel}: ${name}(${first}`);
      }
    }
    // Destructured: function name({ tenantSlug, ... }), and every same-file call of it.
    for (const d of src.matchAll(/function\s+(\w+)\(\{\s*tenantSlug\b/g)) {
      helpers += 1;
      const name = d[1];
      for (const c of src.matchAll(new RegExp(String.raw`(?<![\w.])${name}\(\{`, 'g'))) {
        const at = /** @type {number} */ (c.index);
        if (isDeclaration(src, at)) continue;
        const body = argsAt(src, at + name.length)[0];
        if (!/tenantSlug:\s*sessionTenantSlug\(req\)/.test(body)) bad.push(`${rel}: ${name}({…}) without the session tenant`);
      }
    }
    // Named: { tenantSlug: <expr> }.
    for (const p of src.matchAll(/\btenantSlug:\s*([^,}\n]+)/g)) {
      if (p[1].trim() !== 'sessionTenantSlug(req)') bad.push(`${rel}: tenantSlug: ${p[1].trim()}`);
    }
    // Bound: const tenantSlug = <expr>. `req.tenant && req.tenant.slug` is the
    // session tenant written out (routes/printTemplates.js' logo upload, which
    // predates the helper and reads no per-office setting).
    for (const a of src.matchAll(/\b(?:const|let|var)\s+tenantSlug\s*=\s*([^;\n]+)/g)) {
      const rhs = a[1].trim();
      if (rhs !== 'sessionTenantSlug(req)' && rhs !== 'req.tenant && req.tenant.slug') {
        bad.push(`${rel}: tenantSlug = ${rhs}`);
      }
    }
  }
  assert.deepEqual(bad, []);
  assert.ok(helpers >= 5, `found ${helpers} tenantSlug helpers — the scan has stopped matching`);
});

test('no route that reads a per-office setting reads a slug or a tenant field from the request', () => {
  /** @type {string[]} */
  const bad = [];
  for (const rel of ROUTE_FILES) {
    read(rel)
      .split(/\r?\n/)
      .forEach((line, i) => {
        if (
          /(tenantSlug|\bslug\b|sessionTenant)[^;]*req\.(query|body|params|headers)\b/.test(line) ||
          /req\.(query|body|params|headers)\b[^;]*(tenantSlug|\bslug\b)/.test(line) ||
          /req\.(query|body|params|headers)(\.|\[\s*['"])tenant(['"]\s*\])?(?![\w])/i.test(line) ||
          /req\.(get|header)\(\s*['"][^'"]*tenant/i.test(line)
        ) {
          bad.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      });
  }
  assert.deepEqual(bad, []);
});

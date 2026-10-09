'use strict';

/**
 * Structural guards for the messaging layer, by source scan:
 *
 *   1. NO OPEN DENTAL WRITE. The consent gate's only OD verb is a GET
 *      (apiGetRaw). No file under services/messaging/ or the route may name a
 *      write transport.
 *   2. NO SEND WITHOUT A CLICK. Nothing under services/messaging/ schedules
 *      work (no timers, no cron) — so nothing can send on its own — and the
 *      only caller of sendMessage is the POST /:id/send route.
 *   3. NO PHI TO THE CALL STORE. The messaging layer never touches the JSON
 *      call store.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const BACKEND = path.join(__dirname, '..', '..');

function filesUnder(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) out.push(p);
  }
  return out;
}

const SOURCES = [
  ...filesUnder(path.join(BACKEND, 'services', 'messaging')),
  path.join(BACKEND, 'routes', 'tc', 'messages.js'),
].map((p) => ({ p, src: fs.readFileSync(p, 'utf8') }));

test('the scan found the messaging sources', () => {
  assert.ok(SOURCES.length >= 9, `only ${SOURCES.length} files`);
});

test('no Open Dental write transport anywhere in the messaging layer', () => {
  for (const { p, src } of SOURCES) {
    assert.doesNotMatch(src, /apiPost|apiPut|apiPatch|apiDelete|commlog/i, path.relative(BACKEND, p));
  }
});

test('nothing schedules work (no auto-send, no scheduled send)', () => {
  for (const { p, src } of SOURCES) {
    assert.doesNotMatch(src, /setInterval|setTimeout|node-cron|cron\.schedule/, path.relative(BACKEND, p));
  }
});

test('nothing writes to the JSON call store', () => {
  for (const { p, src } of SOURCES) {
    assert.doesNotMatch(src, /unifiedCallStore|durableState/, path.relative(BACKEND, p));
  }
});

test('the only caller of sendMessage in the backend is POST /:id/send', () => {
  const callers = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js') && /\bsendMessage\(/.test(fs.readFileSync(p, 'utf8'))) {
        callers.push(path.relative(BACKEND, p).replace(/\\/g, '/'));
      }
    }
  };
  walk(BACKEND);
  assert.deepEqual(callers.sort(), ['routes/tc/messages.js', 'services/messaging/index.js']);
  const route = fs.readFileSync(path.join(BACKEND, 'routes', 'tc', 'messages.js'), 'utf8');
  assert.equal((route.match(/messaging\.sendMessage\(/g) || []).length, 1);
  assert.match(route, /router\.post\(\s*'\/:id\/send'/);
});

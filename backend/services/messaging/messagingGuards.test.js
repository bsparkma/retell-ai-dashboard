'use strict';

/**
 * Structural guards for the messaging layer, by source scan:
 *
 *   1. NO OPEN DENTAL WRITE. The consent gate's only OD verb is a GET
 *      (apiGetRaw). No file under services/messaging/ or the route may name a
 *      write transport.
 *   2. NO SEND WITHOUT A CLICK. Nothing under services/messaging/ schedules
 *      work (no timers, no cron) — so nothing can send on its own — and the
 *      only callers of sendMessage are the POST /:id/send route and (item 40)
 *      the legacy POST /api/tc/communications/send wrapper, ONE call each.
 *      Item 40's ONE exception to "no timers": acs/client.js may AWAIT a
 *      pause (node:timers/promises) between two status reads inside the
 *      human's own Send request. That cannot start a send and never outlives
 *      the request; it is pinned to exactly that file and that form.
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

/** The one file allowed an awaited pause (item 40), and the one form it may take. */
const AWAITED_PAUSE_FILE = path.join('services', 'messaging', 'acs', 'client.js');

test('nothing schedules work (no auto-send, no scheduled send)', () => {
  for (const { p, src } of SOURCES) {
    const rel = path.relative(BACKEND, p);
    assert.doesNotMatch(src, /setInterval|setImmediate|node-cron|cron\.schedule/, rel);
    if (rel === AWAITED_PAUSE_FILE) {
      // Exactly one pause, awaited, from the promise API, and no callback timer.
      assert.equal((src.match(/setTimeout/g) || []).length, 1, rel);
      assert.match(src, /await timers\.setTimeout\(ms\);/, rel);
      assert.match(src, /require\('node:timers\/promises'\)/, rel);
    } else {
      assert.doesNotMatch(src, /setTimeout|timers\/promises/, rel);
    }
  }
});

test('nothing writes to the JSON call store', () => {
  for (const { p, src } of SOURCES) {
    assert.doesNotMatch(src, /unifiedCallStore|durableState/, path.relative(BACKEND, p));
  }
});

test('the only callers of sendMessage are POST /:id/send and the communications/send wrapper', () => {
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
  assert.deepEqual(callers.sort(), [
    'routes/tc/communications.js',
    'routes/tc/messages.js',
    'services/messaging/index.js',
  ]);
  const route = fs.readFileSync(path.join(BACKEND, 'routes', 'tc', 'messages.js'), 'utf8');
  assert.equal((route.match(/messaging\.sendMessage\(/g) || []).length, 1);
  assert.match(route, /router\.post\(\s*'\/:id\/send'/);
  // item 40: the wrapper calls it once, inside POST /send, on a draft it just wrote.
  const comms = fs.readFileSync(path.join(BACKEND, 'routes', 'tc', 'communications.js'), 'utf8');
  assert.equal((comms.match(/messaging\.sendMessage\(/g) || []).length, 1);
  const sendRoute = comms.indexOf("'/send'");
  assert.ok(sendRoute !== -1 && comms.indexOf('messaging.sendMessage(') > sendRoute, 'only inside POST /send');
  assert.ok(comms.indexOf('messaging.draftMessage(') > sendRoute, 'and only on the draft it wrote');
});

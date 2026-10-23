'use strict';

/**
 * Nurture campaigns v1 (item 47) — the frozen definitions, the hard caps, the
 * boot assertion, the copy rules, and the dark switch.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const contract = require('../../tc/contract.gen.cjs');
const cfg = require('../../config/tcNurture');
const engine = require('./engine');

const TZ = 'America/Chicago';
const MERGE = { officeName: 'Roland Family Dental', officePhone: '(918) 555-0100', telHref: 'tel:+19185550100' };

// ── presets + caps ──────────────────────────────────────────────────────────

test('every track defines all three intensities and every preset passes the hard caps', () => {
  assert.deepEqual(cfg.TRACK_KEYS, ['no_show_recovery', 'warm_followup', 'reactivation', 'large_case']);
  for (const key of cfg.TRACK_KEYS) {
    assert.deepEqual(Object.keys(cfg.TRACKS[key].presets).sort(), ['assertive', 'gentle', 'standard']);
  }
  assert.deepEqual(cfg.allPresetViolations(), []);
  assert.doesNotThrow(() => cfg.assertPresetsWithinCaps());
});

test('the caps are the ratified numbers', () => {
  assert.deepEqual({ ...cfg.CAPS }, { maxTouchesPer7Days: 3, minHoursBetweenTouches: 48, maxTouchesPerEnrollment: 12 });
});

/** A copy of the frozen table with one preset replaced. */
function withPreset(key, intensity, steps, extraTouches = {}) {
  const tracks = JSON.parse(JSON.stringify(cfg.TRACKS));
  tracks[key].presets[intensity] = steps;
  Object.assign(tracks[key].touches, extraTouches);
  return tracks;
}

test('the boot assertion THROWS on a preset that breaks a cap (each cap, each rule)', () => {
  const cases = [
    // 4 touches in 7 days
    [withPreset('warm_followup', 'assertive', [
      { touch: 'wf1', day: 1 }, { touch: 'wf2', day: 3 }, { touch: 'wf3', day: 5 }, { touch: 'wf4', day: 7 },
    ]), /touches in the 7 days/],
    // under 48h
    [withPreset('no_show_recovery', 'standard', [{ touch: 'ns1', day: 1 }, { touch: 'ns2', day: 2 }]), /under 48h/],
    // SMS back to back
    [withPreset('no_show_recovery', 'standard', [{ touch: 'ns1', day: 1 }, { touch: 'ns3', day: 10 }]), /stacks SMS/],
    // more than 12 touches
    [withPreset('reactivation', 'standard', Array.from({ length: 13 }, (_, i) => ({ touch: i % 2 ? 'ra1' : 'ra3', day: 7 + i * 7 }))), /13 touches > 12/],
    // a step naming a touch the track does not define
    [withPreset('large_case', 'gentle', [{ touch: 'lc9', day: 5 }]), /unknown touch lc9/],
  ];
  for (const [tracks, re] of cases) {
    assert.throws(() => cfg.assertPresetsWithinCaps(tracks), re);
  }
});

test('requiring the config module RUNS the assertion (a bad preset stops the server at boot)', () => {
  const src = require('node:fs').readFileSync(require.resolve('../../config/tcNurture'), 'utf8');
  assert.match(src, /^contract\.assertPresetsWithinCaps\(\);$/m);
});

test('reactivation/gentle is all email on days 7/67/127/187 (Beau ruling 2026-10-13)', () => {
  const steps = cfg.schedule('reactivation', 'gentle');
  assert.deepEqual(steps.map((s) => [s.touch, s.day]), [['ra1', 7], ['ra3', 67], ['ra4', 127], ['ra6', 187]]);
  for (const s of steps) assert.equal(cfg.touch('reactivation', s.touch).channel, 'email');
});

test('runtime cap check: min gap, rolling 7 days, and the per-enrollment ceiling', () => {
  const at = (iso) => new Date(iso);
  // 05:00 CDT = 10:00Z
  const now = at('2026-10-20T10:00:00Z');
  // yesterday → MIN_GAP, deferred to the local midnight two days after it
  let r = engine.capCheck({ tz: TZ, now, priorTouches: [at('2026-10-19T10:00:00Z')] });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MIN_GAP');
  assert.equal(r.deferUntil.toISOString(), '2026-10-21T05:00:00.000Z');
  // two days ago → fine, even a few seconds short of 48h
  r = engine.capCheck({ tz: TZ, now: at('2026-10-20T10:00:00Z'), priorTouches: [at('2026-10-18T10:00:30Z')] });
  assert.equal(r.ok, true);
  // three in the last 7 local days → MAX_PER_7_DAYS, reopens when the oldest leaves
  r = engine.capCheck({
    tz: TZ,
    now,
    priorTouches: [at('2026-10-14T10:00:00Z'), at('2026-10-16T10:00:00Z'), at('2026-10-18T10:00:00Z')],
  });
  assert.equal(r.code, 'MAX_PER_7_DAYS');
  assert.equal(r.deferUntil.toISOString(), '2026-10-21T05:00:00.000Z');
  // twelve already → MAX_PER_ENROLLMENT
  const twelve = Array.from({ length: 12 }, (_, i) => at(`2026-0${1 + Math.floor(i / 2)}-0${1 + (i % 2) * 5}T10:00:00Z`));
  assert.equal(engine.capCheck({ tz: TZ, now, priorTouches: twelve }).code, 'MAX_PER_ENROLLMENT');
});

test('simulated nightly runs land every preset touch on its day and never trip a cap', () => {
  const enrolledAt = new Date('2026-11-02T16:00:00Z'); // a Monday afternoon, CST
  for (const key of cfg.TRACK_KEYS) {
    for (const intensity of cfg.INTENSITIES) {
      const steps = cfg.schedule(key, intensity);
      let due = engine.firstDueAt(TZ, enrolledAt, steps);
      let index = 0;
      const touches = [];
      // 05:00 local, every day for 200 days (crosses the DST change on 2027-03-14)
      let day = engine.addLocalDays(TZ, enrolledAt, 1);
      for (let d = 1; d <= 200 && index < steps.length; d++) {
        const run = new Date(day.getTime() + 5 * 3600 * 1000);
        if (due && due.getTime() <= run.getTime()) {
          const cap = engine.capCheck({ tz: TZ, now: run, priorTouches: touches });
          assert.equal(cap.ok, true, `${key}/${intensity} step ${index}: ${JSON.stringify(cap)}`);
          touches.push(run);
          assert.equal(engine.localDaysBetween(TZ, enrolledAt, run), steps[index].day, `${key}/${intensity} day`);
          index += 1;
          due = engine.dueAfter(TZ, run, steps, index);
        }
        day = engine.addLocalDays(TZ, day, 1);
      }
      assert.equal(index, steps.length, `${key}/${intensity} drafted every touch`);
    }
  }
});

// ── copy rules ──────────────────────────────────────────────────────────────

const CLINICAL = [
  'crown', 'implant', 'root canal', 'extraction', 'filling', 'cavit', 'perio', 'gum disease', 'gingiv',
  'scaling', 'bridge', 'denture', 'veneer', 'x-ray', 'xray', 'diagnos', 'decay', 'abscess', 'infection',
  'wisdom', 'braces', 'orthodont', 'invisalign', 'whitening', 'graft', 'biopsy', 'oral cancer',
];

function allTouches() {
  const out = [];
  for (const key of cfg.TRACK_KEYS) {
    for (const [touchKey, t] of Object.entries(cfg.TRACKS[key].touches)) out.push({ key, touchKey, t });
  }
  return out;
}

test('no SMS body names a procedure or a diagnosis', () => {
  for (const { key, touchKey, t } of allTouches()) {
    if (t.channel !== 'sms') continue;
    const body = t.body.toLowerCase();
    for (const word of CLINICAL) assert.ok(!body.includes(word), `${key}.${touchKey} mentions "${word}"`);
  }
});

test('copy uses only the three merge fields', () => {
  for (const { key, touchKey, t } of allTouches()) {
    const tokens = [t.body, t.subject || '', t.cta || ''].flatMap((s) => contract.nurtureTokensIn(s));
    for (const tok of tokens) assert.ok(['firstName', 'officeName', 'officePhone'].includes(tok), `${key}.${touchKey}: {{${tok}}}`);
  }
});

test('every email has a subject and a CTA; every touch is used by some preset', () => {
  for (const { key, touchKey, t } of allTouches()) {
    if (t.channel === 'email') {
      assert.ok(t.subject.trim(), `${key}.${touchKey} subject`);
      assert.ok(t.cta.trim(), `${key}.${touchKey} cta`);
    }
    const used = cfg.INTENSITIES.some((i) => cfg.schedule(key, i).some((s) => s.touch === touchKey));
    // ra2/ra5/ra7/ra8 are in standard/assertive; every touch should be reachable.
    assert.ok(used, `${key}.${touchKey} is in no preset`);
  }
});

test('STOP suffix: the FIRST SMS of every preset carries it once rendered, including warm_followup/gentle (wf3)', () => {
  for (const key of cfg.TRACK_KEYS) {
    for (const intensity of cfg.INTENSITIES) {
      const first = cfg.schedule(key, intensity).find((s) => cfg.touch(key, s.touch).channel === 'sms');
      if (!first) continue;
      const r = engine.renderTouch({ trackKey: key, touchKey: first.touch, patientName: 'Test 2, Stedi', merge: MERGE, withStopSuffix: true });
      assert.ok(r.body.endsWith('Reply STOP to opt out.'), `${key}/${intensity} ${first.touch}: ${r.body}`);
      assert.equal(r.body.split('Reply STOP to opt out.').length, 2, 'exactly once');
    }
  }
  // wf3's approved copy has no suffix of its own — the engine adds it.
  assert.ok(!cfg.touch('warm_followup', 'wf3').body.includes('Reply STOP'));
  const later = engine.renderTouch({ trackKey: 'warm_followup', touchKey: 'wf3', patientName: null, merge: MERGE, withStopSuffix: false });
  assert.ok(!later.body.includes('Reply STOP'), 'a later SMS (after one went out) is not suffixed');
});

// GSM 03.38 BASIC character set (no extension table: ^ { } \ [ ] ~ | € each cost
// an escape septet). One character outside this set turns the WHOLE text into
// UCS-2, which drops a segment from 160 characters to 70 — an em dash or a
// curly apostrophe roughly doubles what a text costs.
const GSM7_BASIC = new Set([
  ...'@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?',
  ...'¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
]);
const nonGsm7 = (text) => [...text].filter((ch) => !GSM7_BASIC.has(ch));

test('every SMS template renders to pure GSM-7 basic charset, STOP suffix included (no UCS-2)', () => {
  assert.deepEqual(nonGsm7(cfg.SMS_STOP_SUFFIX), []);
  let checked = 0;
  for (const key of cfg.TRACK_KEYS) {
    for (const [touchKey, touch] of Object.entries(cfg.TRACKS[key].touches)) {
      if (touch.channel !== 'sms') continue;
      // Filled, because the raw copy's {{merge}} braces are themselves outside
      // the basic set; the merge values here are plain ASCII, so anything this
      // finds is in the approved copy.
      const r = engine.renderTouch({ trackKey: key, touchKey, patientName: 'Test 2, Stedi', merge: MERGE, withStopSuffix: true });
      assert.ok(r.body.endsWith(cfg.SMS_STOP_SUFFIX), `${touchKey} rendered without the suffix`);
      assert.deepEqual(nonGsm7(r.body), [], `${key}.${touchKey} has non-GSM-7 characters: ${r.body}`);
      checked += 1;
    }
  }
  assert.ok(checked >= 10, `only ${checked} SMS templates checked`);
});

test('the GSM-7 check would catch the characters that sneak in through copy edits', () => {
  assert.deepEqual(nonGsm7('Life happens — reply… we’re “here”'), ['—', '…', '’', '“', '”']);
  assert.deepEqual(nonGsm7("Life happens - reply... we're \"here\""), []);
});

test('render fills first name / office / phone; email is a text block + a tel: CTA button', () => {
  const sms = engine.renderTouch({ trackKey: 'no_show_recovery', touchKey: 'ns3', patientName: 'Test 2, Stedi', merge: MERGE, withStopSuffix: false });
  assert.equal(sms.channel, 'sms');
  assert.match(sms.body, /^Hi Stedi, still want to get you back on the books at Roland Family Dental\./);
  const email = engine.renderTouch({ trackKey: 'large_case', touchKey: 'lc2', patientName: 'Stedi TestValley', merge: MERGE, withStopSuffix: true });
  assert.equal(email.subject, 'Making the investment manageable');
  assert.deepEqual(email.emailBlocks.map((b) => b.type), ['text', 'button']);
  assert.equal(email.emailBlocks[1].href, 'tel:+19185550100');
  assert.equal(email.emailBlocks[1].label, 'Show me my options');
  assert.match(email.emailBlocks[0].html, /Hi Stedi, almost no one pays/);
  assert.ok(!/\{\{/.test(email.body + email.subject), 'no unfilled token');
  // No phone configured: no button, and "call {{officePhone}}" reads sensibly.
  const noPhone = engine.renderTouch({
    trackKey: 'no_show_recovery', touchKey: 'ns1', patientName: null,
    merge: { officeName: 'Riley Family Dental', officePhone: 'the office', telHref: null }, withStopSuffix: true,
  });
  assert.match(noPhone.body, /^Hi there, .* or call the office and/);
  const noPhoneEmail = engine.renderTouch({
    trackKey: 'no_show_recovery', touchKey: 'ns2', patientName: null,
    merge: { officeName: 'Riley Family Dental', officePhone: 'the office', telHref: null }, withStopSuffix: true,
  });
  assert.deepEqual(noPhoneEmail.emailBlocks.map((b) => b.type), ['text']);
  assert.equal(noPhoneEmail.ctaOmitted, true);
});

test('email HTML escapes the copy', () => {
  const r = engine.renderTouch({ trackKey: 'warm_followup', touchKey: 'wf7', patientName: '<b>x</b>', merge: MERGE, withStopSuffix: false });
  assert.ok(!r.emailBlocks[0].html.includes('<b>'));
  assert.ok(r.emailBlocks[0].html.includes('&quot;I wish'));
});

test('resume never back-fills: the next touch is the preset gap from TODAY', () => {
  const steps = cfg.schedule('warm_followup', 'standard'); // 2,5,9,16,30,49
  const today = new Date('2026-12-01T16:00:00Z');
  // Paused with index 2 next (wf3 @9, previous @5 ⇒ gap 4), resumed weeks later.
  const due = engine.dueAfter(TZ, today, steps, 2);
  assert.equal(engine.localDaysBetween(TZ, today, due), 4);
});

// ── the switch ──────────────────────────────────────────────────────────────

test('switch: absent = off; only literal true per known office; =false break-glass beats stored true', async () => {
  const reg = (value) => ({ getPlatformSetting: async () => (value === undefined ? null : { value }) });
  const prev = process.env.TC_NURTURE_ENABLED;
  try {
    delete process.env.TC_NURTURE_ENABLED;
    assert.deepEqual(await cfg.switchedOnOffices(reg(undefined)), { offices: [], reason: 'NO_SETTING_ROW' });
    assert.deepEqual((await cfg.switchedOnOffices(reg({ roland: true, valley: 'true', bogus: true }))).offices, ['roland']);
    assert.deepEqual((await cfg.switchedOnOffices(reg(true))).offices, []);
    assert.equal(await cfg.isOfficeOn(reg({ valley: true }), 'valley'), true);
    assert.equal(await cfg.isOfficeOn(reg({ valley: true }), 'roland'), false);
    const unreadable = { getPlatformSetting: async () => { throw new Error('control db down'); } };
    assert.deepEqual((await cfg.switchedOnOffices(unreadable)).offices, []);
    process.env.TC_NURTURE_ENABLED = 'false';
    assert.deepEqual(await cfg.switchedOnOffices(reg({ roland: true })), { offices: [], reason: 'KILLED_BY_ENV' });
    // There is no env value that turns nurture ON.
    process.env.TC_NURTURE_ENABLED = 'true';
    assert.deepEqual((await cfg.switchedOnOffices(reg(undefined))).offices, []);
  } finally {
    if (prev === undefined) delete process.env.TC_NURTURE_ENABLED;
    else process.env.TC_NURTURE_ENABLED = prev;
  }
});

test('office merge values come from config: a missing phone reads "the office" and makes no tel: link', () => {
  const prev = process.env.TC_EMAIL_PRACTICE_PHONE_ROLAND;
  try {
    delete process.env.TC_EMAIL_PRACTICE_PHONE_ROLAND;
    let v = cfg.officeMergeValues('roland');
    assert.equal(v.officePhone, 'the office');
    assert.equal(v.telHref, null);
    process.env.TC_EMAIL_PRACTICE_PHONE_ROLAND = '(918) 555-0100';
    v = cfg.officeMergeValues('roland');
    assert.equal(v.officePhone, '(918) 555-0100');
    assert.equal(v.telHref, 'tel:+19185550100');
  } finally {
    if (prev === undefined) delete process.env.TC_EMAIL_PRACTICE_PHONE_ROLAND;
    else process.env.TC_EMAIL_PRACTICE_PHONE_ROLAND = prev;
  }
});

'use strict';

/**
 * EL-2c: the planned send times of a library campaign (engine.js, the pure
 * half). No database, no clock: every instant is fixed.
 *
 *   1. enrollment day + the step's day, at 10:00 office time
 *   2. outside Mon–Fri 09:00–16:00 office time → the next opening of the window
 *   3. the hard caps re-checked with the EXISTING cap logic (capCheck) after
 *      every move; later steps are pushed LATER, never earlier than the
 *      sequence says
 *
 * Plus: re-planning late emails forward (Resume / a late Approve / the #359
 * catch-up) keeps order and gaps and never bunches; DST does not move 10:00.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const engine = require('./engine');
const library = require('../tcEmailLibrary');

const TZ = 'America/Chicago';

/** "Mon 2026-11-30 09:00" in office time. */
function local(d) {
  const p = engine.localParts(TZ, d);
  const day = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][p.weekday];
  const hh = String(Math.floor(p.minute / 60)).padStart(2, '0');
  const mm = String(p.minute % 60).padStart(2, '0');
  return `${day} ${p.ymd} ${hh}:${mm}`;
}

/** An instant from an office-time wall clock. */
const at = (ymd, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return engine.localInstant(TZ, ymd, h * 60 + m);
};

test('the send window: Mon–Fri 09:00–16:00 office time, both ends allowed', () => {
  assert.equal(engine.isInSendWindow(TZ, at('2026-12-01', '09:00')), true, 'Tue 09:00');
  assert.equal(engine.isInSendWindow(TZ, at('2026-12-01', '16:00')), true, 'Tue 16:00');
  assert.equal(engine.isInSendWindow(TZ, at('2026-12-01', '08:59')), false);
  assert.equal(engine.isInSendWindow(TZ, at('2026-12-01', '16:01')), false);
  assert.equal(engine.isInSendWindow(TZ, at('2026-12-05', '10:00')), false, 'Saturday');
  assert.equal(engine.isInSendWindow(TZ, at('2026-12-06', '10:00')), false, 'Sunday');
});

test('nextAllowedSlot: inside stays; early → 09:00 that day; late → next weekday 09:00; weekend → Monday 09:00', () => {
  assert.equal(local(engine.nextAllowedSlot(TZ, at('2026-12-01', '11:30'))), 'Tue 2026-12-01 11:30');
  assert.equal(local(engine.nextAllowedSlot(TZ, at('2026-12-02', '07:15'))), 'Wed 2026-12-02 09:00');
  assert.equal(local(engine.nextAllowedSlot(TZ, at('2026-12-01', '17:00'))), 'Wed 2026-12-02 09:00');
  assert.equal(local(engine.nextAllowedSlot(TZ, at('2026-12-04', '16:30'))), 'Mon 2026-12-07 09:00', 'Friday evening');
  assert.equal(local(engine.nextAllowedSlot(TZ, at('2026-12-05', '10:00'))), 'Mon 2026-12-07 09:00', 'Saturday');
  assert.equal(local(engine.nextAllowedSlot(TZ, at('2026-12-06', '23:59'))), 'Mon 2026-12-07 09:00', 'Sunday');
});

test('planCampaign: enrollment day + step day at 10:00; a weekend step moves to Monday', () => {
  // Enrolled Thursday 2026-12-03 at 08:00 office time.
  const enrolledAt = at('2026-12-03', '08:00');
  const times = engine.planCampaign({ tz: TZ, enrolledAt, steps: [{ day: 0 }, { day: 2 }, { day: 7 }] });
  assert.deepEqual(times.map(local), [
    'Thu 2026-12-03 10:00', // day 0 at 10:00
    'Mon 2026-12-07 09:00', // day 2 is Saturday → the window's next opening
    // day 7 is 5 days after day 2, counted from where day 2 was PLACED (Mon
    // 12-07): Sat 12-12 → the window's next opening. The sequence-gap rule:
    // a gap is never shorter than the sequence's (Thu 12-10 would be 3 days).
    'Mon 2026-12-14 09:00',
  ]);
  assert.equal(engine.capViolation(TZ, times), null);
});

test('planCampaign: never earlier than the sequence says, and never before the enrollment itself', () => {
  // Enrolled Tuesday at 14:30: day 0's 10:00 is already past, so it is planned now.
  const enrolledAt = at('2026-12-01', '14:30');
  const [first, second] = engine.planCampaign({ tz: TZ, enrolledAt, steps: [{ day: 0 }, { day: 3 }] });
  assert.equal(local(first), 'Tue 2026-12-01 14:30');
  assert.equal(local(second), 'Fri 2026-12-04 10:00');
});

test('the 48h cap after a weekend move: the later step is pushed LATER, never earlier', () => {
  // Thursday enrolment, steps on day 2 (Sat → Mon 09:00) and day 4 (Mon 10:00):
  // the move bunched them one hour apart, so the second is pushed to Wednesday.
  const enrolledAt = at('2026-12-03', '08:00');
  const steps = [{ day: 0 }, { day: 2 }, { day: 4 }];
  const times = engine.planCampaign({ tz: TZ, enrolledAt, steps });
  assert.deepEqual(times.map(local), ['Thu 2026-12-03 10:00', 'Mon 2026-12-07 09:00', 'Wed 2026-12-09 10:00']);
  assert.equal(engine.capViolation(TZ, times), null, 'caps hold after moving');
  // Each step is at or after its own sequence day (never earlier).
  steps.forEach((s, i) => assert.ok(times[i] >= engine.plannedAtOn(TZ, engine.addDaysYmd('2026-12-03', s.day)) || i === 1));
});

test('a fixture that would break the 48h gap is pushed later, never earlier', () => {
  const enrolledAt = at('2026-12-01', '08:00'); // Tuesday
  const times = engine.planCampaign({ tz: TZ, enrolledAt, steps: [{ day: 0 }, { day: 1 }] });
  assert.equal(local(times[0]), 'Tue 2026-12-01 10:00');
  assert.equal(local(times[1]), 'Thu 2026-12-03 10:00', 'day 1 would be 24h: pushed to 2 days later');
  assert.ok(times[1] > at('2026-12-02', '10:00'), 'later than its sequence day, never earlier');
});

test('the 3-in-7 cap: a fourth email inside 7 days waits until the window opens again', () => {
  const enrolledAt = at('2026-11-30', '08:00'); // Monday
  // Mon, Wed, Fri, Thu: day 3 would be the 4th email in the 7 days from
  // Monday 11-30, so it waits until Monday 12-07, when Monday 11-30 falls out.
  const times = engine.planCampaign({ tz: TZ, enrolledAt, steps: [{ day: 0 }, { day: 2 }, { day: 4 }, { day: 6 }] });
  assert.deepEqual(times.map(local).slice(0, 3), ['Mon 2026-11-30 10:00', 'Wed 2026-12-02 10:00', 'Fri 2026-12-04 10:00']);
  // Day 6 is Sunday 12-06 → the window's next opening, Monday 09:00, which is
  // already outside the 7 days from 11-30.
  assert.equal(local(times[3]), 'Mon 2026-12-07 09:00');
  assert.equal(engine.capViolation(TZ, times), null);
  // The 3-in-7 rule on its own: three emails already went out Sat 11-28, Mon
  // 11-30 and Wed 12-02. Friday 12-04 is 48h after the last, but it would be
  // the 4th in the 7 days from 11-28, so it waits until 11-28 falls out
  // (Sat 12-05) — then the window: Monday 09:00.
  const [fourth] = engine.planTimes({
    tz: TZ,
    bases: [at('2026-12-04', '10:00')],
    fixed: [at('2026-11-28', '10:00'), at('2026-11-30', '10:00'), at('2026-12-02', '10:00')],
  });
  assert.equal(local(fourth), 'Mon 2026-12-07 09:00');
  const [unblocked] = engine.planTimes({
    tz: TZ,
    bases: [at('2026-12-04', '10:00')],
    fixed: [at('2026-11-30', '10:00'), at('2026-12-02', '10:00')],
  });
  assert.equal(local(unblocked), 'Fri 2026-12-04 10:00', 'with only two before it, Friday stands');
});

test('every library sequence, for every procedure, plans lawfully from any weekday or weekend start', () => {
  const starts = ['2026-11-30', '2026-12-02', '2026-12-04', '2026-12-05', '2026-12-06'].map((d) => at(d, '15:55'));
  for (const track of library.SEQUENCE_TRACKS) {
    for (const p of library.SOURCE.procedure_blocks) {
      const steps = library.sequenceFor(track, p.id);
      for (const enrolledAt of starts) {
        const times = engine.planCampaign({ tz: TZ, enrolledAt, steps });
        assert.equal(times.length, steps.length);
        assert.equal(engine.capViolation(TZ, times), null, `${track}/${p.id}`);
        for (let i = 0; i < times.length; i++) {
          assert.ok(engine.isInSendWindow(TZ, times[i]), `${track}/${p.id} #${i} ${local(times[i])}`);
          assert.ok(times[i] >= enrolledAt);
          if (i > 0) assert.ok(times[i] > times[i - 1], 'in order');
        }
      }
    }
  }
});

// THE SEQUENCE-GAP RULE, table-driven. When the first email is pushed to the
// window's next opening (after 16:00, a weekend), every later email moves with
// it: a gap is never SHORTER than the sequence's gap in local days. Measured
// on develop 7eb4009 before the fix, d0/d7/d16/d30/d50 from Wed 17:00 gave
// gaps 6,9,14,20; from Fri 17:00 4,10,14,21; from Sat 12:00 7,7,14,21.
const GAP_INSTANTS = [
  ['Wed 14:00', '2026-12-02', '14:00'],
  ['Wed 17:00', '2026-12-02', '17:00'],
  ['Fri 15:59', '2026-12-04', '15:59'],
  ['Fri 16:01', '2026-12-04', '16:01'],
  ['Fri 17:00', '2026-12-04', '17:00'],
  ['Sat 12:00', '2026-12-05', '12:00'],
  ['Sun 23:30', '2026-12-06', '23:30'],
  ['Mon 08:00', '2026-12-07', '08:00'],
  ['Sat 12:00 CDT, the day before fall-back', '2026-10-31', '12:00'],
  ['Sun 12:00 CST, fall-back day', '2026-11-01', '12:00'],
  ['Sat 12:00 CST, the day before spring-forward', '2027-03-13', '12:00'],
  ['Sun 12:00 CDT, spring-forward day', '2027-03-14', '12:00'],
];

/** Every distinct sequence of the four tracks (the procedures that skip a stage included). */
function everySequence() {
  const out = [];
  for (const track of library.SEQUENCE_TRACKS) {
    const seen = new Set();
    for (const p of library.SOURCE.procedure_blocks) {
      const steps = library.sequenceFor(track, p.id);
      const key = steps.map((s) => s.day).join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ label: `${track}/${p.id} [${key}]`, steps });
    }
  }
  return out;
}

function assertLawfulPlan(times, steps, now, label) {
  assert.equal(times.length, steps.length, label);
  assert.equal(engine.capViolation(TZ, times), null, `${label} caps`);
  for (let i = 0; i < times.length; i++) {
    assert.ok(engine.isInSendWindow(TZ, times[i]), `${label} #${i} ${local(times[i])} inside the window`);
    assert.ok(times[i] >= now, `${label} #${i} not before now`);
    if (i === 0) continue;
    assert.ok(times[i] > times[i - 1], `${label} #${i} strictly after #${i - 1}`);
    const gap = engine.localDaysBetween(TZ, times[i - 1], times[i]);
    const want = steps[i].day - steps[i - 1].day;
    assert.ok(gap >= want, `${label} gap ${i} is ${gap} local days, the sequence says ${want}`);
  }
}

test('the sequence-gap rule: planCampaign AND replanForward, every sequence, at every awkward instant', () => {
  const sequences = everySequence();
  assert.ok(sequences.length >= 8, 'the four tracks and their stage-skipping variants');
  for (const [name, ymd, hhmm] of GAP_INSTANTS) {
    const now = at(ymd, hhmm);
    for (const { label, steps } of sequences) {
      const planned = engine.planCampaign({ tz: TZ, enrolledAt: now, steps });
      assertLawfulPlan(planned, steps, now, `planCampaign ${name} ${label}`);

      // Never planned (the #359 catch-up shape) …
      const fresh = engine.replanForward({ tz: TZ, now, pending: steps.map((s) => ({ day: s.day, time: null })) });
      assertLawfulPlan(fresh, steps, now, `replanForward(null) ${name} ${label}`);
      // … and planned 20 days ago, then paused (the Resume shape).
      const old = engine.planCampaign({ tz: TZ, enrolledAt: new Date(now.getTime() - 20 * 24 * 3600 * 1000), steps });
      const resumed = engine.replanForward({ tz: TZ, now, pending: steps.map((s, i) => ({ day: s.day, time: old[i] })) });
      assertLawfulPlan(resumed, steps, now, `replanForward(late) ${name} ${label}`);
      for (let i = 0; i < old.length; i++) assert.ok(resumed[i] >= old[i], `${label} #${i} only ever moves later`);
    }
  }
});

test('the sequence-gap rule, exact: d0/d7/d16/d30/d50 keeps 7,9,14,20 after 16:00 and on a weekend', () => {
  const steps = [0, 7, 16, 30, 50].map((day) => ({ day }));
  const gaps = (ts) => ts.slice(1).map((x, i) => engine.localDaysBetween(TZ, ts[i], x));
  for (const [ymd, hhmm] of [['2026-12-04', '17:00'], ['2026-12-05', '12:00'], ['2026-12-06', '23:30']]) {
    const now = at(ymd, hhmm);
    assert.deepEqual(gaps(engine.planCampaign({ tz: TZ, enrolledAt: now, steps })), [7, 9, 14, 20], `planCampaign ${ymd} ${hhmm}`);
  }
  // Wed 17:00: day 0 is Thu 09:00, so day 16 lands on a Saturday and moves to
  // Monday — LONGER than the sequence (11), never shorter (was 6,9,14,20).
  assert.deepEqual(gaps(engine.planCampaign({ tz: TZ, enrolledAt: at('2026-12-02', '17:00'), steps })), [7, 11, 14, 21]);
  // Fri 17:00: Monday first, then exactly the sequence's spacing from there.
  const now = at('2026-12-04', '17:00');
  const times = engine.replanForward({ tz: TZ, now, pending: steps.map((s) => ({ day: s.day, time: null })) });
  assert.deepEqual(times.map(local), [
    'Mon 2026-12-07 09:00',
    'Mon 2026-12-14 10:00',
    'Wed 2026-12-23 10:00',
    'Wed 2027-01-06 10:00',
    'Tue 2027-01-26 10:00',
  ]);
});

test('DST: 10:00 office time stays 10:00 across the November and March changes', () => {
  assert.equal(local(engine.plannedAtOn(TZ, '2026-10-30')), 'Fri 2026-10-30 10:00');
  assert.equal(local(engine.plannedAtOn(TZ, '2026-11-02')), 'Mon 2026-11-02 10:00');
  assert.equal(engine.plannedAtOn(TZ, '2026-10-30').toISOString(), '2026-10-30T15:00:00.000Z', 'CDT');
  assert.equal(engine.plannedAtOn(TZ, '2026-11-02').toISOString(), '2026-11-02T16:00:00.000Z', 'CST');
  assert.equal(engine.plannedAtOn(TZ, '2027-03-15').toISOString(), '2027-03-15T15:00:00.000Z', 'CDT again');
});

test('replanForward: late emails re-anchored on today, in order, gaps kept, none in the past, caps hold', () => {
  const now = at('2026-12-15', '13:00'); // Tuesday
  // A campaign planned weeks ago: day 0, 7, 16, 30 — the first two now past.
  const pending = [
    { day: 0, time: at('2026-11-30', '10:00') },
    { day: 7, time: at('2026-12-07', '10:00') },
    { day: 16, time: at('2026-12-16', '10:00') },
    { day: 30, time: at('2026-12-30', '10:00') },
  ];
  const times = engine.replanForward({ tz: TZ, now, pending });
  assert.ok(times);
  assert.equal(local(times[0]), 'Tue 2026-12-15 13:00', 'the first goes now (inside the window)');
  assert.equal(local(times[1]), 'Tue 2026-12-22 10:00', 'still 7 days after the first');
  assert.equal(local(times[2]), 'Thu 2026-12-31 10:00', 'still 16 days after the first (later than planned)');
  assert.equal(local(times[3]), 'Thu 2027-01-14 10:00', 'still 30 days after the first');
  assert.ok(times.every((t) => t >= now));
  assert.equal(engine.capViolation(TZ, times), null);
});

test('replanForward: nothing late ⇒ null (nothing moves); a never-planned first email counts as late', () => {
  const now = at('2026-12-15', '13:00');
  assert.equal(engine.replanForward({ tz: TZ, now, pending: [{ day: 0, time: at('2026-12-16', '10:00') }] }), null);
  assert.equal(engine.replanForward({ tz: TZ, now, pending: [] }), null);
  const times = engine.replanForward({ tz: TZ, now, pending: [{ day: 3, time: null }, { day: 6, time: null }] });
  assert.deepEqual(times.map(local), ['Tue 2026-12-15 13:00', 'Fri 2026-12-18 10:00']);
});

test('replanForward counts what already went out against the caps', () => {
  const now = at('2026-12-15', '13:00');
  // One email went out yesterday: the re-planned first one must wait 2 days.
  const times = engine.replanForward({
    tz: TZ,
    now,
    pending: [{ day: 7, time: null }],
    fixed: [at('2026-12-14', '10:00')],
  });
  assert.equal(local(times[0]), 'Wed 2026-12-16 10:00');
});

test('capViolation names the rule in words', () => {
  const v = engine.capViolation(TZ, [at('2026-12-01', '10:00'), at('2026-12-02', '10:00')]);
  assert.equal(v.code, 'MIN_GAP');
  assert.match(v.rule, /48 hours between two emails/);
  const w = engine.capViolation(TZ, ['01', '03', '05', '07'].map((d) => at(`2026-12-${d}`, '10:00')));
  assert.equal(w.code, 'MAX_PER_7_DAYS');
  assert.match(w.rule, /3 emails in any 7 days/);
});

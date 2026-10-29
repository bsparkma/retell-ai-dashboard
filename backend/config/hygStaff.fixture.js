'use strict';

/**
 * A CLEARLY SYNTHETIC staff roster for tests — no real person's name, email or
 * licence number appears in any test (Practice staff page).
 *
 * The shape is the one backend/config/hygStaff.js ships, so a test that used to
 * read the real lists reads these through `hygStaff.setRosterForTests` and
 * asserts the same rules about different people. The licence numbers are 9xxx
 * on purpose: no registration board issued them to anyone in this practice.
 *
 * Not test-discovered (node --test runs `*.test.js` and anything under a
 * `test/` folder), and required only by tests.
 */

const SYNTHETIC_DOCTORS = Object.freeze([
  Object.freeze({ name: 'Drew Example', credential: 'DDS', license: '9001' }),
  Object.freeze({ name: 'Morgan Example', credential: 'DDS', license: '9002' }),
  Object.freeze({ name: 'Quinn Example', credential: 'DDS', license: '9003' }),
]);

const SYNTHETIC_HYGIENISTS = Object.freeze([
  Object.freeze({ fullName: 'Avery Example', credential: 'RDH', license: '9101', signIn: Object.freeze(['Avery Example']) }),
  Object.freeze({ fullName: 'Jamie Example', credential: 'RDH', license: '9102', signIn: Object.freeze(['Jamie Example']) }),
]);

const SYNTHETIC_ROSTER = Object.freeze({
  doctors: Object.freeze({ roland: SYNTHETIC_DOCTORS, valley: SYNTHETIC_DOCTORS }),
  hygienists: SYNTHETIC_HYGIENISTS,
});

/**
 * Swap the synthetic roster in for the rest of this test FILE (node --test runs
 * each file in its own process) — or, given a node:test context, for one test.
 * @param {{ after: (fn: () => void) => void } | undefined} [t]
 */
function useSyntheticStaff(t) {
  const hygStaff = require('./hygStaff');
  hygStaff.setRosterForTests({
    doctors: { roland: [...SYNTHETIC_DOCTORS], valley: [...SYNTHETIC_DOCTORS] },
    hygienists: SYNTHETIC_HYGIENISTS.map((h) => ({ ...h, signIn: [...h.signIn] })),
  });
  if (t) t.after(() => hygStaff.setRosterForTests(null));
}

module.exports = { SYNTHETIC_DOCTORS, SYNTHETIC_HYGIENISTS, SYNTHETIC_ROSTER, useSyntheticStaff };

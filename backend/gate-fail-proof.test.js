'use strict';
// TEMPORARY — Phase 3 Step 3 gate-fail proof. This test fails on purpose to
// prove the CI build-test gate blocks publish/migrate/deploy. Reverted immediately.
const { test } = require('node:test');
const assert = require('node:assert');

test('INTENTIONAL gate-fail proof (revert me)', () => {
  assert.equal(1, 2, 'intentional failing test — proves the CI gate stops the pipeline');
});

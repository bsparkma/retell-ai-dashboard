'use strict';

/**
 * The Key Vault loader's one load-bearing rule: an ABSENT secret is skipped,
 * and only a real failure stops startup.
 *
 * Every optional SECRET_MAP entry (the second office's OD key, Twilio, ACS,
 * the external sign-in door's client secret, ...) relies on that split. During
 * the 2026-10-26 OD incident #270's new optional secret was suspected of
 * aborting secret loading; it had not, and these tests pin that it never can:
 *
 *   404 / SecretNotFound      → skipped; loadSecrets() resolves (startup proceeds)
 *   403 / auth / network      → loadSecrets() rejects (startup stops) — never a
 *                               half-configured process against a vault it
 *                               cannot read
 *
 * The vault client is a fake. Values are synthetic and never asserted on by
 * content beyond "was it set".
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const secrets = require('./secrets');

const EXTSSO = 'dashboard-extsso-client-secret';

/** @param {number} statusCode @param {string} code @param {string} message */
function restError(statusCode, code, message) {
  const err = new Error(message);
  Object.assign(err, { statusCode, code });
  return err;
}

/**
 * A fake vault: every mapped secret exists except those in `absent`; any name
 * in `failing` answers with `failure`.
 * @param {{ absent?: string[], failing?: string[], failure?: Error }} [opts]
 */
function fakeVault({ absent = [], failing = [], failure } = {}) {
  /** @type {string[]} */
  const asked = [];
  return {
    asked,
    async getSecret(/** @type {string} */ name) {
      asked.push(name);
      if (failing.includes(name)) throw failure;
      if (absent.includes(name)) {
        throw restError(404, 'SecretNotFound', `A secret with (name/id) ${name} was not found in this key vault.`);
      }
      return { value: `synthetic-${name}` };
    },
  };
}

/** Run `fn` as a production boot, then restore env and the loader's state. */
async function asProduction(fn) {
  const savedEnv = { ...process.env };
  const realLog = console.log;
  console.log = () => {};
  process.env.NODE_ENV = 'production';
  try {
    await fn();
  } finally {
    console.log = realLog;
    for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
    Object.assign(process.env, savedEnv);
    secrets._setVaultClientForTests(null);
  }
}

test('loadFromKeyVault: an absent optional secret (404 SecretNotFound) is SKIPPED, and the rest still load', async () => {
  await asProduction(async () => {
    const vault = fakeVault({ absent: [EXTSSO, 'opendental-customer-key-valley'] });
    const result = await secrets.loadFromKeyVault(vault);

    assert.deepEqual(vault.asked, secrets.secretNames, 'every mapped secret is asked for, in order');
    assert.ok(result.skipped.includes('DASHBOARD_EXTSSO_CLIENT_SECRET'));
    assert.ok(result.skipped.includes('OPENDENTAL_CUSTOMER_KEY_VALLEY'));
    assert.equal(result.loaded.length + result.skipped.length, secrets.secretNames.length);
    // The OD keys load regardless of what is missing elsewhere.
    for (const key of ['OPENDENTAL_DEVELOPER_KEY', 'OPENDENTAL_CUSTOMER_KEY']) {
      assert.ok(result.loaded.includes(key), `${key} loaded`);
      assert.ok(process.env[key], `${key} set on process.env`);
    }
    assert.equal(process.env.DASHBOARD_EXTSSO_CLIENT_SECRET, undefined, 'an absent secret sets nothing');
  });
});

test('loadFromKeyVault: a "not found" reported only by code, or only by message, is still a skip', async () => {
  await asProduction(async () => {
    const byCode = {
      async getSecret(/** @type {string} */ name) {
        if (name === EXTSSO) throw restError(0, 'SecretNotFound', 'gone');
        return { value: 'synthetic' };
      },
    };
    assert.ok((await secrets.loadFromKeyVault(byCode)).skipped.includes('DASHBOARD_EXTSSO_CLIENT_SECRET'));

    const byMessage = {
      async getSecret(/** @type {string} */ name) {
        if (name === EXTSSO) throw new Error(`Secret ${name} was not found`);
        return { value: 'synthetic' };
      },
    };
    assert.ok((await secrets.loadFromKeyVault(byMessage)).skipped.includes('DASHBOARD_EXTSSO_CLIENT_SECRET'));
  });
});

test('loadFromKeyVault: an empty secret value is skipped, not loaded as ""', async () => {
  await asProduction(async () => {
    const vault = {
      async getSecret(/** @type {string} */ name) {
        return { value: name === EXTSSO ? '' : 'synthetic' };
      },
    };
    const result = await secrets.loadFromKeyVault(vault);
    assert.ok(result.skipped.includes('DASHBOARD_EXTSSO_CLIENT_SECRET'));
    assert.ok(!result.loaded.includes('DASHBOARD_EXTSSO_CLIENT_SECRET'));
  });
});

test('loadSecrets (the startup call): EVERY optional secret absent → startup proceeds', async () => {
  await asProduction(async () => {
    // Worst case for "optional": the vault holds nothing at all.
    secrets._setVaultClientForTests(fakeVault({ absent: [...secrets.secretNames] }));
    await assert.doesNotReject(secrets.loadSecrets());
  });
});

test('loadSecrets (the startup call): a 403 on an OPTIONAL secret aborts startup', async () => {
  await asProduction(async () => {
    const forbidden = restError(403, 'Forbidden', 'Caller is not authorized to perform action on resource.');
    secrets._setVaultClientForTests(fakeVault({ failing: [EXTSSO], failure: forbidden }));
    await assert.rejects(secrets.loadSecrets(), (err) => err === forbidden);
  });
});

test('loadSecrets: a network failure aborts startup too, and a failed load is not remembered as done', async () => {
  await asProduction(async () => {
    const down = restError(0, 'ECONNREFUSED', 'connect ECONNREFUSED');
    secrets._setVaultClientForTests(fakeVault({ failing: ['opendental-developer-key'], failure: down }));
    await assert.rejects(secrets.loadSecrets());
    // Called again with nothing reset: it must try (and fail) again rather
    // than return as if the first attempt had loaded.
    await assert.rejects(secrets.loadSecrets());
  });
});

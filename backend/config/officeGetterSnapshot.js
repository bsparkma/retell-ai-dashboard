'use strict';

/**
 * TESTS ONLY. A snapshot of EVERY office getter's output (MT-1b).
 *
 * MT-1b moved officeAgents.js and odOffices.js from answering out of their code
 * maps to answering out of the control-plane office registry, with the code maps
 * as the fallback. The claim that made that safe is "no behavior change while
 * the registry equals the code maps". This module is how that claim is checked:
 *
 *   - __fixtures__/officeGetters.golden.json was produced by running
 *     buildSnapshot() against the PRE-FLIP code on origin/develop (7338391),
 *     before either config file was edited.
 *   - officeRegistryFlip.test.js runs it again, post-flip, twice: once with the
 *     registry never read (code maps serve) and once with a registry stub equal
 *     to the code maps (registry serves). Both must equal the golden file.
 *
 * Only exports that existed before the flip are called here, so the same file
 * runs against both versions. No network: building an OpenDentalService makes
 * no request until asked, and nothing here asks. Customer keys are SYNTHETIC
 * strings and are never written into the snapshot.
 */

const officeAgents = require('./officeAgents');
const odOffices = require('./odOffices');

/** Every env var the getters read. Saved and restored around each scenario. */
const ENV_KEYS = [
  'OPENDENTAL_CUSTOMER_KEY',
  'OPENDENTAL_CUSTOMER_KEY_VALLEY',
  'OPENDENTAL_CAREIN_COMMTYPE_DEFNUM',
  'OPENDENTAL_CAREIN_COMMTYPE_DEFNUM_VALLEY',
  'OPENDENTAL_REFERRAL_COMMTYPE_DEFNUM',
  'OPENDENTAL_REFERRAL_COMMTYPE_DEFNUM_VALLEY',
  'HYG_OD_ENABLED_ROLAND',
  'HYG_OD_ENABLED_VALLEY',
];

/**
 * The environments the snapshot is taken under.
 * `keys`  — synthetic customer keys present, so readiness reaches the DefNums.
 * `overrides` — the env DefNum overrides that outrank everything (env > registry > code),
 *               including a non-numeric one that must fall through.
 */
const SCENARIOS = {
  bare: {},
  keys: {
    OPENDENTAL_CUSTOMER_KEY: 'synthetic-roland-customer-key',
    OPENDENTAL_CUSTOMER_KEY_VALLEY: 'synthetic-valley-customer-key',
  },
  overrides: {
    OPENDENTAL_CUSTOMER_KEY: 'synthetic-roland-customer-key',
    OPENDENTAL_CUSTOMER_KEY_VALLEY: 'synthetic-valley-customer-key',
    OPENDENTAL_CAREIN_COMMTYPE_DEFNUM: '9001',
    OPENDENTAL_CAREIN_COMMTYPE_DEFNUM_VALLEY: 'not-a-number',
    OPENDENTAL_REFERRAL_COMMTYPE_DEFNUM_VALLEY: '9002',
    HYG_OD_ENABLED_VALLEY: 'false',
  },
};

const OFFICE_INPUTS = ['roland', 'valley', 'unknown', 'all', 'default', '', 'nope'];

/** Every call shape the attribution getters branch on. Synthetic or already-in-code ids only. */
function callInputs() {
  const calls = [];
  for (const did of Object.keys(officeAgents.MANGO_LINE_OFFICE)) {
    calls.push({ source: 'mango', called_number: did });
    // The same line, formatted the way a human types it.
    const d = did.slice(2);
    calls.push({ source: 'mango', called_number: `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` });
  }
  calls.push({ source: 'mango', called_number: '+15555550100' }); // unmapped line
  calls.push({ source: 'mango' }); // no line at all
  for (const id of Object.keys(officeAgents.AGENT_OFFICE)) {
    calls.push({ source: 'retell', handler_id: id });
    calls.push({ agent_id: id });
  }
  calls.push({ source: 'retell', handler_id: 'agent_synthetic_unmapped' });
  calls.push({ source: 'retell' });
  calls.push({ record_kind: 'stub', office: 'valley', source: 'mango' });
  calls.push({ record_kind: 'stub', source: 'retell' });
  return calls;
}

function agentInputs() {
  return [
    ...Object.keys(officeAgents.AGENT_OFFICE).map((id) => ({ agent_id: id })),
    { agent_id: 'agent_synthetic_unmapped' },
    { id: Object.keys(officeAgents.AGENT_OFFICE)[0] },
    {},
  ];
}

/** @param {() => unknown} fn */
function attempt(fn) {
  try {
    return { ok: fn() };
  } catch (err) {
    return { threw: err && err.code ? err.code : String(err && err.message) };
  }
}

/** @param {string} officeKey */
function handleView(officeKey) {
  return attempt(() => {
    const h = odOffices.getOdOffice(officeKey);
    return {
      officeKey: h.officeKey,
      officeName: h.officeName,
      commTypeDefNum: h.commTypeDefNum,
      referralCommTypeDefNum: h.referralCommTypeDefNum,
      hasClient: h.client != null,
      frozen: Object.isFrozen(h),
    };
  });
}

/** Snapshot under the CURRENT process.env. */
function snapshotNow() {
  odOffices.resetOdOfficeCache();
  const calls = callInputs();
  const agents = agentInputs();
  const out = {
    getAllOfficeConfigs: officeAgents.getAllOfficeConfigs(),
    getOfficeConfig: Object.fromEntries(OFFICE_INPUTS.map((k) => [k, officeAgents.getOfficeConfig(k)])),
    getOfficeForCall: calls.map((c) => [c, officeAgents.getOfficeForCall(c)]),
    isAgentAllowedForOffice: Object.fromEntries(
      OFFICE_INPUTS.map((k) => [
        k,
        [...Object.keys(officeAgents.AGENT_OFFICE), 'agent_synthetic_unmapped', null].map((id) =>
          officeAgents.isAgentAllowedForOffice(id, k)
        ),
      ])
    ),
    filterAgentsForOffice: Object.fromEntries(
      OFFICE_INPUTS.map((k) => [k, officeAgents.filterAgentsForOffice(agents, k)])
    ),
    filterCallsForOffice: Object.fromEntries(
      OFFICE_INPUTS.map((k) => [k, officeAgents.filterCallsForOffice(calls, k)])
    ),
    odBlockReason: Object.fromEntries(OFFICE_INPUTS.map((k) => [k, odOffices.odBlockReason(k)])),
    isOdReady: Object.fromEntries(OFFICE_INPUTS.map((k) => [k, odOffices.isOdReady(k)])),
    hygOdBlockReason: Object.fromEntries(OFFICE_INPUTS.map((k) => [k, odOffices.hygOdBlockReason(k)])),
    isHygOdReady: Object.fromEntries(OFFICE_INPUTS.map((k) => [k, odOffices.isHygOdReady(k)])),
    hygSwitchState: odOffices.hygSwitchState(),
    isChartTargetOffice: Object.fromEntries(OFFICE_INPUTS.map((k) => [k, odOffices.isChartTargetOffice(k)])),
    referralChartNoteBlockReason: Object.fromEntries(
      OFFICE_INPUTS.map((k) => [k, odOffices.referralChartNoteBlockReason(k)])
    ),
    describeOffice: Object.fromEntries(OFFICE_INPUTS.map((k) => [k, odOffices.describeOffice(k)])),
    getOdOffice: Object.fromEntries(OFFICE_INPUTS.map((k) => [k, handleView(k)])),
    secretNames: odOffices.secretNames,
  };
  odOffices.resetOdOfficeCache();
  // JSON round-trip: undefined → absent, exactly what the golden file stores.
  return JSON.parse(JSON.stringify(out));
}

/**
 * The full snapshot: every scenario's environment, applied in turn, then restored.
 * Console output from the getters (the unmapped-line warn-once) is muted.
 * @returns {Record<string, unknown>}
 */
function buildSnapshot() {
  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const savedWarn = console.warn;
  console.warn = () => {};
  try {
    /** @type {Record<string, unknown>} */
    const result = {};
    for (const [name, env] of Object.entries(SCENARIOS)) {
      for (const k of ENV_KEYS) delete process.env[k];
      Object.assign(process.env, env);
      result[name] = snapshotNow();
    }
    return result;
  } finally {
    console.warn = savedWarn;
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    odOffices.resetOdOfficeCache();
  }
}

module.exports = { buildSnapshot, ENV_KEYS, SCENARIOS };

// `node config/officeGetterSnapshot.js` prints the snapshot (how the golden file was made).
if (require.main === module) {
  process.stdout.write(`${JSON.stringify(buildSnapshot(), null, 2)}\n`);
}

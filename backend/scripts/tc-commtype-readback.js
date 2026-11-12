#!/usr/bin/env node
'use strict';

/**
 * AT-2 step 0 — READ-ONLY. Reads each office's commlog-type Definitions
 * (GET /definitions?Category=27&includeHidden=true) through that office's own
 * Open Dental client and checks the "CareIN TC" type with
 * services/tc/tcCommTypeVerify.js. Prints one line per office; exits 1 if any
 * check fails. Makes no write of any kind.
 *
 * Run inside a container (secrets come from Key Vault at startup), e.g.:
 *   node scripts/tc-commtype-readback.js
 *
 * Re-run it in PROD before AT-2 is enabled there: the defaults in
 * config/odOffices.js (roland 492, valley 453) were read on STAGING's
 * configuration on 2026-11-12.
 */

(async () => {
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  await require(path.join(root, 'config/secrets')).loadSecrets();
  const odOffices = require(path.join(root, 'config/odOffices'));
  const { verifyTcCommTypes } = require(path.join(root, 'services/tc/tcCommTypeVerify'));

  const lists = {};
  const known = {};
  for (const office of ['roland', 'valley']) {
    const od = odOffices.getOdOffice(office);
    const res = await od.client.apiGetRaw('/definitions', { Category: 27, includeHidden: 'true' }, { timeoutMs: 20000 });
    if (!res.ok) throw new Error(`${office}: definitions read failed (${res.status})`);
    lists[office] = res.data;
    known[office] = { call: od.commTypeDefNum, referral: od.referralCommTypeDefNum };
  }
  const out = verifyTcCommTypes(lists, known);
  for (const [office, o] of Object.entries(out.offices)) {
    console.log(
      `${office}\tTC ${o.defNum} "${o.itemName}" hidden=${o.isHidden}\tcall ${o.call.defNum} "${o.call.itemName}"\treferral ${o.referral.defNum} "${o.referral.itemName}"\tconfigured TC ${odOffices.getOdOffice(office).tcCommTypeDefNum}`
    );
  }
  for (const p of out.problems) console.log(`PROBLEM ${p}`);
  process.exit(out.ok ? 0 : 1);
})().catch((err) => {
  console.error(`ERR ${err && err.message}`);
  process.exit(1);
});

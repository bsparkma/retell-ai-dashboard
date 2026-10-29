#!/usr/bin/env node
'use strict';

/**
 * READ-ONLY. Print the dates Open Dental holds on one fixture patient's
 * referral chart notes, to check the PR #290 diagnosis (notes dated at the
 * milestone, not when they were written) against what is actually in the chart.
 *
 * WHAT IT DOES, ALL OF IT: one GET /commlogs?PatNum=<fixture> on the named
 * office's client, then prints, for each row of that office's referral
 * commlog type: CommlogNum, CommDateTime, DateTStamp, the first 70 characters
 * of the note. That GET is the only request it makes. It never changes or
 * alters anything in Open Dental or in CareIN.
 *
 * One page only (Open Dental pages at 100). If the page comes back full, the
 * script says so rather than implying it saw the whole chart.
 *
 * Fixture patients only (config/testPatients.js). Any other (office, PatNum)
 * is refused before secrets are loaded.
 *
 *   PROBE_OFFICE=roland PROBE_PATNUM=12827 node scripts/probe-referral-commlog-dates.js
 */

const { isDesignatedTestPatient, describeTestPatients } = require('../config/testPatients');

const PAGE_SIZE = 100;

async function main() {
  const office = String(process.env.PROBE_OFFICE || '').trim();
  const patNum = Number(String(process.env.PROBE_PATNUM || '').trim());
  if (!isDesignatedTestPatient(office, patNum)) {
    console.error(`Refused: PROBE_OFFICE/PROBE_PATNUM must be a designated test patient (${describeTestPatients()}).`);
    return 2;
  }

  await require('../config/secrets').loadSecrets();
  const od = require('../config/odOffices').getOdOffice(office);
  const referralType = Number(od.referralCommTypeDefNum);

  const res = await od.client.apiGetRaw('/commlogs', { PatNum: patNum }, { timeoutMs: 15000, module: 'tc' });
  if (!res.ok) {
    console.error(`Open Dental did not return the commlogs (${res.status}): ${res.error || 'unknown'}`);
    return 1;
  }
  const rows = Array.isArray(res.data) ? res.data : [];
  const referral = rows.filter((r) => Number(r.CommType) === referralType);

  console.log(`office=${office} PatNum=${patNum} referralCommType=${referralType} rows=${rows.length} referralRows=${referral.length}`);
  if (rows.length >= PAGE_SIZE) console.log(`NOTE: the page is full (${PAGE_SIZE}); older rows may exist beyond it.`);
  for (const r of referral) {
    console.log(
      JSON.stringify({
        CommlogNum: r.CommlogNum,
        CommDateTime: r.CommDateTime,
        DateTStamp: r.DateTStamp,
        note: String(r.Note ?? '').slice(0, 70),
      })
    );
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`Failed: ${err && err.message ? err.message : err}`);
    process.exit(1);
  }
);

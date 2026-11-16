'use strict';
// The fixture matrix shared by the BEFORE recording (run against 82c7a5a,
// output: mt2bCareinBefore.json) and
// the AFTER test. Synthetic values only (example.test, 555-01xx).

const SWITCHES = [
  { mod: 'tcCheckout', key: 'tc_checkout_enabled', prefix: 'TC_CHECKOUT_ENABLED_' },
  { mod: 'tcOdSync', key: 'tc_od_sync_enabled', prefix: 'TC_OD_SYNC_ENABLED_' },
  { mod: 'tcAutoCheckout', key: 'tc_auto_checkout_enabled', prefix: 'TC_AUTO_CHECKOUT_ENABLED_' },
  { mod: 'tcReferrals', key: 'tc_referrals_enabled', prefix: 'TC_REFERRALS_ENABLED_' },
  { mod: 'tcReferralEmail', key: 'tc_referral_email_enabled', prefix: 'TC_REFERRAL_EMAIL_ENABLED_' },
  { mod: 'tcReferralPatientEmail', key: 'tc_referral_patient_email_enabled', prefix: 'TC_REFERRAL_PATIENT_EMAIL_ENABLED_' },
];

/** platform_setting values (undefined = no row) */
const BOOL_VALUES = {
  none: undefined,
  rolandOn: { roland: true },
  mixed: { roland: false, valley: true },
  empty: {},
  junk: 'junk',
  partlyJunk: { roland: 'yes', valley: true, nope: true },
  bothOn: { roland: true, valley: true },
};

/** env layers: suffix -> raw value */
const ENVS = {
  unset: {},
  bothTrue: { ROLAND: 'true', VALLEY: 'true' },
  rolandFalseValleyTrue: { ROLAND: 'false', VALLEY: 'true' },
  oddCase: { ROLAND: ' TRUE ', VALLEY: 'garbage' },
};

const QUERY_OFFICES = ['roland', 'valley', 'unknown', 'nope'];

const NURTURE_KILL = { unset: {}, killed: { TC_NURTURE_ENABLED: 'false' }, notKill: { TC_NURTURE_ENABLED: 'true' } };
const OPPS_KILL = { unset: {}, killed: { TC_OPPS_SYNC_DISABLED: 'true' } };

const IDENTITY_VALUES = {
  none: undefined,
  full: {
    roland: {
      replyTo: 'Front@Roland.example.test',
      practiceName: ' Test Roland ',
      practicePhone: '555-0100',
      practiceAddress: '1 Test St\r\n\r\n  Testtown  ',
      referralBcc: 'Copies@Roland.example.test',
    },
  },
  mixed: {
    roland: { replyTo: 'not-an-email', practiceName: null },
    valley: { practiceName: 'Valley Test', practicePhone: '555-0101', extra: 'dropped' },
    unknown: { practiceName: 'never' },
  },
  junk: 'junk',
};

const IDENTITY_ENVS = {
  unset: {},
  some: {
    ACS_EMAIL_REPLY_TO_ROLAND: 'Env@Roland.example.test',
    ACS_EMAIL_REPLY_TO_VALLEY: 'env@valley.example.test',
    TC_EMAIL_PRACTICE_NAME_VALLEY: 'Env Valley',
    TC_EMAIL_PRACTICE_PHONE_ROLAND: '555-0199',
    TC_EMAIL_PRACTICE_ADDRESS_VALLEY: '2 Env Rd',
  },
};

/** Every env var name any fixture touches, so a run can clear them all. */
function allEnvNames() {
  const names = new Set();
  for (const s of SWITCHES) for (const o of ['ROLAND', 'VALLEY', 'UNKNOWN', 'NOPE']) names.add(s.prefix + o);
  for (const o of ['ROLAND', 'VALLEY', 'UNKNOWN', 'NOPE']) names.add('HYG_OD_ENABLED_' + o);
  for (const e of [...Object.values(NURTURE_KILL), ...Object.values(OPPS_KILL), ...Object.values(IDENTITY_ENVS)]) {
    for (const k of Object.keys(e)) names.add(k);
  }
  for (const f of ['ACS_EMAIL_REPLY_TO_', 'TC_EMAIL_PRACTICE_NAME_', 'TC_EMAIL_PRACTICE_PHONE_', 'TC_EMAIL_PRACTICE_ADDRESS_']) {
    for (const o of ['ROLAND', 'VALLEY', 'UNKNOWN']) names.add(f + o);
  }
  return [...names].sort();
}

module.exports = {
  SWITCHES,
  BOOL_VALUES,
  ENVS,
  QUERY_OFFICES,
  NURTURE_KILL,
  OPPS_KILL,
  IDENTITY_VALUES,
  IDENTITY_ENVS,
  allEnvNames,
};

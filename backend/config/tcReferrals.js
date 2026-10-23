'use strict';

/**
 * Referrals' per-office dark-launch switch (queue item 52, R1).
 *
 *     TC_REFERRALS_ENABLED_<OFFICE>=false               <- break-glass, OFF
 *     platform_setting['tc_referrals_enabled'][office]  <- {"roland": true}
 *     TC_REFERRALS_ENABLED_<OFFICE>=true                <- fallback only
 *     false                                             <- the floor
 *
 * Gates every /api/tc/referrals route and the TC Settings "Referrals" section.
 * Off for an office means the routes refuse (403 REFERRALS_DISABLED) and the
 * section is not shown. Switched from the platform console, like checkout. See
 * config/tcOfficeSwitch.js for the precedence rules.
 */

const { createOfficeSwitch } = require('./tcOfficeSwitch');

module.exports = createOfficeSwitch({
  settingKey: 'tc_referrals_enabled',
  envPrefix: 'TC_REFERRALS_ENABLED_',
  label: 'tcReferrals',
});

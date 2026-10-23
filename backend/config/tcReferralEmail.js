'use strict';

/**
 * Referral EMAIL's per-office dark-launch switch (R5).
 *
 *     TC_REFERRAL_EMAIL_ENABLED_<OFFICE>=false               <- break-glass, OFF
 *     platform_setting['tc_referral_email_enabled'][office]  <- {"valley": true}
 *     TC_REFERRAL_EMAIL_ENABLED_<OFFICE>=true                <- fallback only
 *     false                                                  <- the floor
 *
 * Independent of tc_referrals_enabled: referrals can be on with email off (the
 * manual marks are the only way out, as before R5). Off for an office means
 * POST /api/tc/referrals/:id/send-email refuses (403 REFERRAL_EMAIL_DISABLED), no
 * auto-send runs on approval, and the hub draws no Send button. The send
 * itself also needs the email transport connected for the office
 * (config/acsEmail.js); this switch only decides whether the office may use
 * it for referrals. Switched from the platform console, beside the referrals
 * switch. See config/tcOfficeSwitch.js for the precedence rules.
 */

const { createOfficeSwitch } = require('./tcOfficeSwitch');

module.exports = createOfficeSwitch({
  settingKey: 'tc_referral_email_enabled',
  envPrefix: 'TC_REFERRAL_EMAIL_ENABLED_',
  label: 'tcReferralEmail',
});

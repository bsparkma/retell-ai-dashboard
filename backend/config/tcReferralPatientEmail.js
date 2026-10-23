'use strict';

/**
 * The referral PATIENT NOTICE's per-office dark-launch switch (R5b).
 *
 *     TC_REFERRAL_PATIENT_EMAIL_ENABLED_<OFFICE>=false               <- break-glass, OFF
 *     platform_setting['tc_referral_patient_email_enabled'][office]  <- {"valley": true}
 *     TC_REFERRAL_PATIENT_EMAIL_ENABLED_<OFFICE>=true                <- fallback only
 *     false                                                          <- the floor
 *
 * It gates ONLY the email to the patient after a referral letter goes out
 * (routes/tc/referralSend.js notifyPatient). The specialist's letter, its
 * links and their buttons are governed by tc_referral_email_enabled
 * (config/tcReferralEmail.js) and are untouched by this switch. Off for an
 * office means no patient email, no Open Dental lookup for one, and a named
 * `patient_email_skipped` history row ("patient email is off for this
 * office"). Switched from the platform console, beside the referral email
 * switch. See config/tcOfficeSwitch.js for the precedence rules.
 */

const { createOfficeSwitch } = require('./tcOfficeSwitch');

module.exports = createOfficeSwitch({
  settingKey: 'tc_referral_patient_email_enabled',
  envPrefix: 'TC_REFERRAL_PATIENT_EMAIL_ENABLED_',
  label: 'tcReferralPatientEmail',
});

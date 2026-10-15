'use strict';

/**
 * The checkout handoff's per-office dark-launch switch (queue item 49).
 *
 *     TC_CHECKOUT_ENABLED_<OFFICE>=false              <- break-glass, OFF
 *     platform_setting['tc_checkout_enabled'][office] <- {"roland": true}
 *     TC_CHECKOUT_ENABLED_<OFFICE>=true               <- fallback only
 *     false                                           <- the floor
 *
 * It gates BOTH ends: the hygiene visit's "Alert checkout" button and the
 * visit Send's handoff (routes/hyg/visit.js), and TC's acceptance of a
 * `kind: 'checkout'` intake (routes/tc/hygiene.js). Off at either end means no
 * handoff is created. See config/tcOfficeSwitch.js for the precedence rules.
 */

const { createOfficeSwitch } = require('./tcOfficeSwitch');

module.exports = createOfficeSwitch({
  settingKey: 'tc_checkout_enabled',
  envPrefix: 'TC_CHECKOUT_ENABLED_',
  label: 'tcCheckout',
});

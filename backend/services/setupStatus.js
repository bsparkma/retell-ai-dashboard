'use strict';

/**
 * Practice setup status (OB-1) — per office, what is set up and what is not.
 *
 * READ-ONLY. Nothing here writes anywhere: no INSERT/UPDATE/DELETE, no
 * platform_setting persist, no audit row (a config read, like the Users page
 * listing), and NO Open Dental call of any kind.
 *
 * COMPUTED, NEVER TICKED. Every step asks the SAME reader the feature itself
 * reads, so "done" here means "the feature would find it", not "somebody said
 * so". If a feature changes where it reads from, this follows by import rather
 * than drifting from a copy:
 *
 *   P1 office details     services/tc/printTemplateStore.prefillFor  (the letterhead prefill)
 *   P2 team & roles       platform/registry.listTenantUsers + config/permissions.roleHasPermission
 *   P3 hygienist roster   services/hyg/staffStore.listForOffice      (what the note composer reads)
 *   P4 directories        routes/tc/providerStore.listProviders, routes/tc/referralStore.listDirectory
 *   P5 email identity     config/acsEmail.identityStateFor           (Settings → Email identity's own readout)
 *   P6 print templates    services/tc/printTemplateStore.rowsFor/stateOf, services/tc/printAssetStore.isConfigured
 *   P7 referral templates routes/tc/referralTemplateStore.listTemplates
 *   P8 hyg note templates hyg contract DRAFT_VISIT_TYPES / RETIRED_VISIT_TYPES (the picker's "(draft)" mark)
 *   P9 features           config/tcCheckout, config/tcReferrals (their isEnabled readers)
 *
 * WHAT A RESPONSE NEVER CARRIES. No patient data (nothing here reads any). No
 * email address — P2 is counts by role, P5 is field NAMES and stored/fallback,
 * never the values. No app-setting or Key Vault name, no secret value. Detail
 * strings are plain English built from counts and fixed labels only. The
 * pinning test scans the whole response for '@' and for env-var-shaped names.
 *
 * OFFICE AND TENANT are the caller's, both server-derived (the route's
 * requireOffice and req.tenant). Every office-scoped reader takes the office
 * and puts it in its WHERE clause. P2 is PRACTICE-wide on purpose: a person
 * belongs to the practice, not to an office (home office is a default, not a
 * restriction), and its detail says so.
 *
 * HONEST FAILURE. A step whose reader throws is reported needs_attention with
 * "Could not check this right now" — never done. One failed reader does not
 * hide the others.
 */

const permissions = require('../config/permissions');
const registry = require('../platform/registry');
const acsEmail = require('../config/acsEmail');
const emailIdentity = require('../config/emailIdentity');
const tcEmail = require('../config/tcEmail');
const tcCheckout = require('../config/tcCheckout');
const tcReferrals = require('../config/tcReferrals');
const tcReferralEmail = require('../config/tcReferralEmail');
const tcContract = require('../tc/contract.gen.cjs');
const hygContract = require('../hyg/contract.gen.cjs');
const printTemplateStore = require('./tc/printTemplateStore');
const printAssetStore = require('./tc/printAssetStore');
const staffStore = require('./hyg/staffStore');
const providerStore = require('../routes/tc/providerStore');
const referralStore = require('../routes/tc/referralStore');
const referralTemplateStore = require('../routes/tc/referralTemplateStore');

/** Links to the EXISTING settings screens. This slice adds no editor. */
const LINKS = Object.freeze({
  emailIdentity: '/admin/tc/settings#email_identity',
  users: '/admin/users',
  providers: '/admin/tc/settings#providers',
  referrals: '/admin/tc/settings#referrals',
  printTemplates: '/admin/print-templates',
  hygDay: '/hyg/day',
  // The feature switches are set in the Developer Console; the card shows the
  // link only to someone who can open it.
  platform: '/platform',
});

const COULD_NOT_CHECK = 'Could not check this right now. Try again in a moment.';

/** Plain-English labels for P5's fields — never the app-setting names. */
const IDENTITY_FIELD_LABELS = Object.freeze({
  replyTo: 'reply-to',
  practiceName: 'practice name',
  practicePhone: 'phone',
});

/** Role labels for P2's counts. */
const ROLE_LABELS = Object.freeze({
  admin: 'admin',
  office: 'office',
  tc: 'TC',
  hygiene: 'hygiene',
  reviewer: 'reviewer',
  rcm_biller: 'RCM biller',
  doctor: 'doctor',
});

/**
 * @typedef {'done'|'needs_attention'} StepStatus
 * @typedef {{ id: string, title: string, required: boolean, status: StepStatus, detail: string, link: string }} SetupStep
 * @typedef {{ office: string, steps: SetupStep[], doneRequired: number, totalRequired: number }} SetupStatus
 * @typedef {{ query: Function }} Pool
 */

/** "1 hygienist" / "2 hygienists". */
function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** "a", "a and b", "a, b and c". */
function listOf(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function step(id, title, required, done, detail, link) {
  return { id, title, required, status: done ? 'done' : 'needs_attention', detail, link };
}

/**
 * Run one step's reader; a throw becomes an honest needs_attention, never done.
 * @param {{ id: string, title: string, required: boolean, link: string }} meta
 * @param {() => Promise<{ done: boolean, detail: string }>} compute
 * @returns {Promise<SetupStep>}
 */
async function guarded(meta, compute) {
  try {
    const { done, detail } = await compute();
    return step(meta.id, meta.title, meta.required, done, detail, meta.link);
  } catch (err) {
    console.error(`[setupStatus] ${meta.id} could not be checked:`, err && err.message ? err.message : err);
    return step(meta.id, meta.title, meta.required, false, COULD_NOT_CHECK, meta.link);
  }
}

// ── P1 office details ───────────────────────────────────────────────────────

async function officeDetails(office) {
  // The exact prefill the print templates letterhead starts from.
  const prefill = await printTemplateStore.prefillFor(office);
  const parts = [
    ['display name', prefill.name],
    ['address', prefill.address],
    ['phone', prefill.phone],
  ];
  const missing = parts.filter(([, v]) => !String(v || '').trim()).map(([label]) => label);
  if (missing.length === 0) return { done: true, detail: 'Display name, address and phone are all set for the letterhead.' };
  return { done: false, detail: `Missing for the letterhead: ${listOf(missing)}.` };
}

// ── P2 team & roles ─────────────────────────────────────────────────────────

async function teamAndRoles(tenantId) {
  const rows = await registry.listTenantUsers(tenantId);
  const active = rows.filter((r) => r && r.status === 'active');
  /** @type {Record<string, number>} */
  const byRole = {};
  for (const r of active) byRole[r.role] = (byRole[r.role] || 0) + 1;
  const admins = byRole.admin || 0;
  // "Able to do TC work" is the permission map's answer, not a role list kept here.
  const tcCapable = active.filter((r) => permissions.roleHasPermission(r.role, 'tc.full')).length;
  const counts = permissions.TENANT_ROLES.filter((role) => byRole[role]).map(
    (role) => `${byRole[role]} ${ROLE_LABELS[role] || role}`
  );
  const summary = counts.length > 0 ? `Active across the practice: ${counts.join(', ')}.` : 'No active users in this practice.';
  const gaps = [];
  if (admins < 1) gaps.push('an admin');
  if (tcCapable < 1) gaps.push('someone who can do TC work');
  if (!byRole.doctor) gaps.push('(optional) a doctor to sign off referrals');
  const required = gaps.filter((g) => !g.startsWith('(optional)'));
  const detail = gaps.length > 0 ? `${summary} Still needs ${listOf(gaps)}.` : summary;
  return { done: required.length === 0, detail };
}

// ── P3 hygienist roster ─────────────────────────────────────────────────────

async function hygienistRoster(pool, office) {
  const rows = await staffStore.listForOffice(pool, office);
  const active = rows.filter((r) => r.active === true);
  if (active.length === 0) {
    return { done: false, detail: 'No active hygienists for this office yet.' };
  }
  const named = active.filter((r) => String(r.fullName || '').trim() && String(r.license || '').trim()).length;
  // A licence prints on a note only when the signed-in person matches a sign-in
  // id on the row (config/hygStaff.js signatureBlock), so "has a signature" is
  // a row with at least one.
  const signed = active.filter((r) => Array.isArray(r.signInIds) && r.signInIds.length > 0).length;
  const n = active.length;
  return {
    done: named === n && signed === n,
    detail: `${plural(n, 'active hygienist')}: ${named} of ${n} have a name and licence, ${signed} of ${n} have a signature.`,
  };
}

// ── P4 provider & specialist directory ──────────────────────────────────────

async function directories(pool, office) {
  const providers = await providerStore.listProviders(pool, office, { includeInactive: false });
  const specialists = await referralStore.listDirectory(pool, office, { includeInactive: false });
  const p = providers.length;
  const s = specialists.length;
  return {
    done: p > 0 && s > 0,
    detail: `${plural(p, 'active provider')} and ${plural(s, 'active specialist')} in this office's directory.`,
  };
}

// ── P5 email identity ───────────────────────────────────────────────────────

/** Is an email feature that signs with this identity switched on for the office? */
async function emailFeatureOn(office) {
  const referralEmail = await tcReferralEmail.isEnabled(office);
  return referralEmail || tcEmail.emailEnabled() === true;
}

async function emailIdentityStep(office) {
  // Settings → Email identity's own readout, re-read first as the print
  // prefill does. Only the SOURCE of each field leaves this function.
  await emailIdentity.refreshFromDb().catch(() => undefined);
  const fields = acsEmail.identityStateFor(office);
  const stored = [];
  const fallback = [];
  const none = [];
  for (const name of emailIdentity.FIELD_NAMES) {
    const label = IDENTITY_FIELD_LABELS[name] || name;
    const source = fields[name] ? fields[name].source : 'none';
    if (source === 'stored') stored.push(label);
    else if (source === 'env') fallback.push(label);
    else none.push(label);
  }
  const parts = [];
  if (stored.length) parts.push(`Saved for this office: ${listOf(stored)}.`);
  if (fallback.length) parts.push(`Only using the app settings: ${listOf(fallback)}.`);
  if (none.length) parts.push(`Not set: ${listOf(none)}.`);
  return { done: fallback.length === 0 && none.length === 0, detail: parts.join(' ') };
}

// ── P6 print templates ──────────────────────────────────────────────────────

async function printTemplates(pool, office) {
  const prefill = await printTemplateStore.prefillFor(office);
  const rows = await printTemplateStore.rowsFor(pool, office);
  const storage = printAssetStore.isConfigured();
  let done = true;
  const lines = [];
  for (const type of tcContract.PRINT_TEMPLATE_TYPE_KEYS) {
    const state = printTemplateStore.stateOf(type, rows.get(type) || null, prefill);
    const logo = state.logo.present;
    if (!state.stored || (storage && !logo)) done = false;
    const logoPart = storage ? (logo ? 'logo uploaded' : 'no logo') : 'logo n/a';
    lines.push(`${state.label}: ${state.stored ? 'wording saved' : 'default wording'}, ${logoPart}.`);
  }
  if (!storage) lines.push('Logo upload is not set up in this environment yet, so logos are not counted.');
  return { done, detail: lines.join(' ') };
}

// ── P7 referral templates ───────────────────────────────────────────────────

async function referralTemplates(pool, office) {
  const states = await referralTemplateStore.listTemplates(pool, office);
  const labels = tcContract.REFERRAL_TEMPLATE_KIND_LABELS || {};
  const saved = states.filter((s) => String(s.body || '').trim());
  const lines = states.map((s) => {
    const title = (labels[s.kind] && labels[s.kind].title) || s.kind;
    return `${title}: ${String(s.body || '').trim() ? 'saved' : 'not saved'}.`;
  });
  return { done: saved.length === states.length, detail: lines.join(' ') };
}

// ── P8 hygiene note templates ───────────────────────────────────────────────

async function hygNoteTemplates() {
  // What the visit-type picker offers today, and which of those it marks "(draft)".
  const live = hygContract.VISIT_TYPES.filter((t) => !hygContract.RETIRED_VISIT_TYPES.has(t));
  const drafts = live.filter((t) => hygContract.DRAFT_VISIT_TYPES.has(t)).length;
  return {
    done: drafts === 0,
    detail:
      drafts === 0
        ? 'Every visit type uses approved note wording.'
        : `${drafts} of ${live.length} visit types are still marked "(draft)", awaiting the practice hygienist's approval.`,
  };
}

// ── P9 features ─────────────────────────────────────────────────────────────

async function features(office) {
  const checkout = await tcCheckout.isEnabled(office);
  const referrals = await tcReferrals.isEnabled(office);
  const onOff = (v) => (v ? 'on' : 'off');
  return {
    // Informational: a switch being off is a choice, not a gap.
    done: true,
    detail: `Checkout is ${onOff(checkout)} and Referrals is ${onOff(referrals)} for this office. CareIN support sets these.`,
  };
}

// ── the whole card ──────────────────────────────────────────────────────────

/**
 * @param {{ office: string, tenantId: string, modules: readonly string[], pool: Pool }} input
 * @returns {Promise<SetupStatus>}
 */
async function computeSetupStatus({ office, tenantId, modules, pool }) {
  const hygEntitled = Array.isArray(modules) && modules.includes('hyg');

  // P5's required flag is itself read from the switches; if THEY cannot be
  // read, the step stays required — the safe direction for a status card.
  let emailOn = true;
  try {
    emailOn = await emailFeatureOn(office);
  } catch (err) {
    console.error('[setupStatus] email switches could not be read:', err && err.message ? err.message : err);
  }

  /** @type {Array<Promise<SetupStep>>} */
  const pending = [
    guarded({ id: 'P1', title: 'Office details', required: true, link: LINKS.emailIdentity }, () => officeDetails(office)),
    guarded({ id: 'P2', title: 'Team & roles', required: true, link: LINKS.users }, () => teamAndRoles(tenantId)),
  ];
  if (hygEntitled) {
    pending.push(
      guarded({ id: 'P3', title: 'Hygienist roster', required: true, link: LINKS.users }, () => hygienistRoster(pool, office))
    );
  }
  pending.push(
    guarded({ id: 'P4', title: 'Provider & specialist directory', required: false, link: LINKS.providers }, () =>
      directories(pool, office)
    ),
    guarded({ id: 'P5', title: 'Email identity', required: emailOn, link: LINKS.emailIdentity }, () =>
      emailIdentityStep(office)
    ),
    guarded({ id: 'P6', title: 'Print templates', required: true, link: LINKS.printTemplates }, () =>
      printTemplates(pool, office)
    ),
    guarded({ id: 'P7', title: 'Referral templates', required: false, link: LINKS.referrals }, () =>
      referralTemplates(pool, office)
    )
  );
  if (hygEntitled) {
    pending.push(
      guarded({ id: 'P8', title: 'Hygiene note templates', required: true, link: LINKS.hygDay }, () => hygNoteTemplates())
    );
  }
  pending.push(guarded({ id: 'P9', title: 'Features', required: false, link: LINKS.platform }, () => features(office)));

  const steps = await Promise.all(pending);
  const requiredSteps = steps.filter((s) => s.required);
  return {
    office,
    steps,
    doneRequired: requiredSteps.filter((s) => s.status === 'done').length,
    totalRequired: requiredSteps.length,
  };
}

module.exports = { computeSetupStatus, LINKS, COULD_NOT_CHECK };

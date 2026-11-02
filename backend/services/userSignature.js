'use strict';

/**
 * "Signature on notes" — the name and licence a hygiene note prints for a
 * person, entered on THEIR row of the Users page. One door per person.
 *
 *   routes/users.js     /api/users/:email/signature                          own practice
 *   routes/platform.js  /api/platform/practices/:tenantId/users/:email/signature   any practice
 *
 * WHY THIS EXISTS. The note's typed-name line (routes/hyg/visit.js signatureFor
 * → config/hygStaff.js signatureBlock) matches the SIGNED-IN user's email
 * against hyg_staff.sign_in_ids. The retired /admin/staff page took those
 * sign-ins as free text, so a typo there meant a licence that never printed.
 * Here the sign-in is not typed at all: it is the app_user row's own email,
 * read server-side. The body carries a name and a licence and nothing else.
 *
 * THE STORAGE is unchanged: hyg_staff, through services/hyg/staffStore.js. The
 * match logic, the config fallback and the note composer are untouched — a row
 * written here is indistinguishable from one the old page wrote.
 *
 *   OFFICE   the user's home office; with none, the first assignable office.
 *            Never from the request.
 *   UPSERT   the office's row holding this email is updated (and reactivated
 *            if it had been deactivated), with sign_in_ids = [email]; with no
 *            such row, one is created.
 *   CLEAR    both fields blank deactivates the row. There is no delete.
 *   RETIRE   deactivating the USER deactivates their row in every office
 *            (retireSignatures, called by services/tenantUsers.updateUser).
 *            A disabled user's signature can be cleared but not set (409
 *            USER_DISABLED), so a direct PUT cannot undo the retire.
 *
 * THE FALLBACK SWITCH (unchanged behaviour, now visible). An office with NO
 * hyg_staff rows prints licences from the built-in list in config/hygStaff.js;
 * once it has any row, the table is the whole answer (staffStore.signatureRoster).
 * So the FIRST signature saved for an office switches that office off the
 * built-in list. Every answer carries `usingBuiltInList` so the page can say
 * so before that first save. The rule itself is not changed here.
 *
 * Same guards as the rest of the Users page: the door's admin.all gate, the
 * tenant from the door (never the body), and the platform-admin rule — a
 * practice admin cannot rewrite what prints under a platform administrator's
 * name. Editing your OWN signature is allowed; it locks nobody out.
 *
 * AUDIT: one row per hyg_staff write, in the practice's own log, in the exact
 * vocabulary routes/hygStaff.js uses (resource_type 'hyg_staff', the row id,
 * the office, prior_state from create→NULL / edited:<fields> / active /
 * inactive). Never the name or licence itself. Fail closed.
 *
 * Staff, not patients: nothing here is PHI. No Open Dental call anywhere.
 */

const contract = require('../hyg/contract.gen.cjs');
const { AuditError } = require('../platform/audit');
const registry = require('../platform/registry');
const staffStore = require('./hyg/staffStore');

/**
 * @typedef {import('./tenantUsers').Outcome} UserOutcome
 * @typedef {{ query: Function }} Pool
 * @typedef {(entry: Record<string, unknown>) => Promise<unknown>} AuditWriter
 * @typedef {{ fullName: string, license: string|null } | null} Signature
 * @typedef {{ ok: true, status: number, office: string, signature: Signature, usingBuiltInList: boolean }
 *         | { ok: false, status: number, error: string, code: string, extra?: Record<string, unknown> }} Outcome
 */

/** A success answer: what prints, and whether the office is still on the built-in list. */
async function answer(pool, office, signature) {
  const rows = await staffStore.listForOffice(pool, office);
  return { ok: true, status: 200, office, signature, usingBuiltInList: rows.length === 0 };
}

function refuse(status, error, code, extra) {
  return extra ? { ok: false, status, error, code, extra } : { ok: false, status, error, code };
}

/**
 * The office a person's signature lives in. Required lazily: tenantUsers
 * requires this module, so a top-level require would be a cycle.
 * @param {{ home_office?: string|null }} userRow
 * @returns {string|null}
 */
function officeFor(userRow) {
  const { assignableOffices } = require('./tenantUsers');
  const offices = assignableOffices().map((o) => o.officeId);
  if (userRow.home_office && offices.includes(userRow.home_office)) return userRow.home_office;
  return offices[0] || null;
}

/** The app_user email as a hyg_staff sign-in id — the SAME normaliser the table uses. */
function signInOf(userRow) {
  return contract.normalizeSignInId(String(userRow.email || ''));
}

/** What a row prints as, or null when nothing prints for it. */
function toSignature(row) {
  return row && row.active ? { fullName: row.fullName, license: row.license } : null;
}

function editedSlug(prior, next) {
  const fields = [];
  if (prior.fullName !== next.fullName) fields.push('name');
  if ((prior.license || null) !== (next.license || null)) fields.push('licence');
  if (JSON.stringify(prior.signInIds) !== JSON.stringify(next.signInIds)) fields.push('sign_ins');
  return 'edited:' + (fields.length > 0 ? fields.join('_') : 'none');
}

/**
 * Find the user, or refuse. Also the platform-admin rule for writes.
 * @returns {Promise<{ row: Record<string, any> } | { refusal: Outcome }>}
 */
async function loadUser(tenantId, rawEmail) {
  const email = String(rawEmail || '').trim().toLowerCase();
  const row = await registry.getTenantUser(tenantId, email);
  if (!row) return { refusal: refuse(404, 'No such user in this practice', 'USER_NOT_FOUND') };
  return { row };
}

/**
 * GET — what prints for this person now.
 * @param {{ tenantId: string, pool: Pool, email: unknown }} input
 * @returns {Promise<Outcome>}
 */
async function getSignature({ tenantId, pool, email }) {
  const loaded = await loadUser(tenantId, email);
  if ('refusal' in loaded) return loaded.refusal;
  const office = officeFor(loaded.row);
  if (!office) return refuse(409, 'This practice has no office to sign notes in', 'NO_OFFICE');
  const row = await staffStore.findBySignIn(pool, { office, signInId: signInOf(loaded.row) });
  return answer(pool, office, toSignature(row));
}

/**
 * PUT — set, change or clear what prints for this person.
 *
 * @param {{ tenantId: string, actor: { email: string, isSuperAdmin: boolean },
 *           audit: AuditWriter, pool: Pool, email: unknown, body: unknown }} input
 * @returns {Promise<Outcome>}
 */
async function saveSignature({ tenantId, actor, audit, pool, email, body }) {
  const parsed = contract.UserSignatureInputSchema.safeParse(body ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue && issue.path.length > 0 ? issue.path.join('.') : 'body';
    return refuse(400, `${field}: ${issue ? issue.message : 'is not valid'}`, 'INVALID_BODY', { field });
  }
  const input = parsed.data;

  const loaded = await loadUser(tenantId, email);
  if ('refusal' in loaded) return loaded.refusal;
  const user = loaded.row;

  // A disabled account's signature was retired with it. Setting one would
  // quietly undo that, so only a clear is accepted.
  if (user.status === 'disabled' && input.fullName !== null) {
    return refuse(
      409,
      'This account is disabled. Re-enable it before giving it a signature on notes.',
      'USER_DISABLED'
    );
  }

  // Rule 2 of the Users page, verbatim in effect: a platform administrator's
  // row — signature included — is changed only by a platform administrator.
  if (actor.isSuperAdmin !== true) {
    const platform = await registry.getPlatformAdminByEmail(user.email);
    if (platform && platform.status === 'active') {
      return refuse(
        403,
        'That account is a platform administrator and can only be changed by one.',
        'PLATFORM_ADMIN_PROTECTED'
      );
    }
  }

  const office = officeFor(user);
  if (!office) return refuse(409, 'This practice has no office to sign notes in', 'NO_OFFICE');
  const signInId = signInOf(user);
  const existing = await staffStore.findBySignIn(pool, { office, signInId });
  const writeAudit = (entry) =>
    audit({ resourceType: 'hyg_staff', office, sourceRef: null, priorState: null, ...entry });
  /**
   * The SUCCESS row for a write that has already landed. If the audit store
   * refuses it, the answer must not read as "nothing was saved" — the row IS
   * saved — so it says that, and what to do. Same rule as routes/hygStaff.js.
   * @returns {Promise<Outcome|null>} a refusal to return, or null when audited
   */
  const auditSaved = async (entry) => {
    try {
      await writeAudit({ ...entry, result: 'SUCCESS' });
      return null;
    } catch (err) {
      if (!(err instanceof AuditError)) throw err;
      console.error('[userSignature] saved, but the audit write failed:', err.message);
      return refuse(
        500,
        'The signature was saved, but its audit entry could not be written. Reload to see it, and tell your administrator.',
        'SAVED_AUDIT_FAILED'
      );
    }
  };

  // ── CLEAR: both blank. Deactivate; there is no delete. ─────────────────
  if (input.fullName === null) {
    if (existing && existing.active) {
      const out = await staffStore.setActive(pool, { office, id: existing.id, active: false, actor: actor.email });
      if (!out.ok) return notConfirmed(writeAudit, existing.id);
      const failed = await auditSaved({ action: 'UPDATE', resourceId: existing.id, priorState: 'active' });
      if (failed) return failed;
    }
    return answer(pool, office, null);
  }

  const fields = { fullName: input.fullName, license: input.license, signInIds: [signInId] };

  // ── CREATE ─────────────────────────────────────────────────────────────
  if (!existing) {
    const out = await staffStore.create(pool, { office, input: fields, actor: actor.email });
    if (!out.ok) return storeRefusal(writeAudit, 'CREATE', null, out);
    const failed = await auditSaved({ action: 'CREATE', resourceId: out.staff.id });
    if (failed) return failed;
    return answer(pool, office, toSignature(out.staff));
  }

  // ── UPDATE (and reactivate a deactivated row) ──────────────────────────
  const out = await staffStore.update(pool, { office, id: existing.id, input: fields, actor: actor.email });
  if (!out.ok) return storeRefusal(writeAudit, 'UPDATE', existing.id, out);
  const editFailed = await auditSaved({
    action: 'UPDATE',
    resourceId: existing.id,
    priorState: editedSlug(out.prior, out.staff),
  });
  if (editFailed) return editFailed;
  let staff = out.staff;
  if (!staff.active) {
    const re = await staffStore.setActive(pool, { office, id: existing.id, active: true, actor: actor.email });
    if (!re.ok) return notConfirmed(writeAudit, existing.id);
    const reFailed = await auditSaved({ action: 'UPDATE', resourceId: existing.id, priorState: 'inactive' });
    if (reFailed) return reFailed;
    staff = re.staff;
  }
  return answer(pool, office, toSignature(staff));
}

async function notConfirmed(writeAudit, id) {
  await writeAudit({ action: 'UPDATE', resourceId: id, result: 'ERROR' });
  return refuse(
    500,
    'The signature was sent but could not be read back, so it is not confirmed. Reload to see what was saved.',
    'SAVE_NOT_CONFIRMED'
  );
}

async function storeRefusal(writeAudit, action, id, out) {
  if (out.code === 'SIGN_IN_TAKEN') {
    // Only a race can reach this: the row holding this email was looked up a
    // moment ago. Say so rather than naming anyone.
    await writeAudit({ action, resourceId: id, result: 'ERROR' });
    return refuse(409, 'Someone else saved this signature at the same moment. Reload and try again.', 'SIGN_IN_TAKEN');
  }
  return notConfirmed(writeAudit, id);
}

/**
 * Deactivate every active signature row this email holds, in every office.
 * Called when the USER is deactivated. Idempotent: a second call finds nothing
 * active and writes nothing, so a retry after a failure is safe.
 *
 * @param {{ pool: Pool, audit: AuditWriter, email: string, actor: string }} input
 * @returns {Promise<number>} how many rows were deactivated
 */
async function retireSignatures({ pool, audit, email, actor }) {
  const { assignableOffices } = require('./tenantUsers');
  const signInId = contract.normalizeSignInId(String(email || ''));
  let retired = 0;
  for (const { officeId: office } of assignableOffices()) {
    const row = await staffStore.findBySignIn(pool, { office, signInId });
    if (!row || !row.active) continue;
    const out = await staffStore.setActive(pool, { office, id: row.id, active: false, actor });
    if (!out.ok) throw new Error('signature row ' + row.id + ' could not be confirmed deactivated');
    await audit({
      action: 'UPDATE',
      resourceType: 'hyg_staff',
      resourceId: row.id,
      result: 'SUCCESS',
      office,
      sourceRef: null,
      priorState: 'active',
    });
    retired += 1;
  }
  return retired;
}

module.exports = { getSignature, saveSignature, retireSignatures };

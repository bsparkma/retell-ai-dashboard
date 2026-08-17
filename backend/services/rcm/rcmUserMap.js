'use strict';

/**
 * Decision D-5 — `rcm_user_map` auto-upserts on a staff member's first
 * attributed RCM action.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * Every actor column in the RCM schema (`created_by`, `approved_by`,
 * `posted_by`, and now `od_matched_by` / `reviewed_by`) is a FK to
 * `rcm_user_map` — a deliberate choice, because *Open Dental cannot tell us who
 * posted a payment*. Every OD API write logs `UserNum: 0` and "Created by …
 * through API." (RCM_OD_WRITES §9). `rcm_*` attribution plus the platform
 * `audit_log` are the only record that a human was ever involved.
 *
 * A FK that a route cannot satisfy is a route that cannot attribute. Slices 4
 * and 5 sidestepped it by writing NULL into `rcm_payment_batches.created_by`
 * ("the staff crosswalk is deferred to Slice 6"). Slice 6a is where that stops
 * being deferrable: **confirm-match is the module's first attributed action**,
 * and 6b's approval gate reuses this helper unchanged.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY AUTO-UPSERT RATHER THAN AN ADMIN SCREEN
 * ─────────────────────────────────────────────────────────────────────────────
 * The crosswalk's original job was resolving the standalone app's `openId` /
 * `createdBy` strings on IMPORTED rows. For a person acting NOW, the platform
 * already knows exactly who they are — Entra SSO put `req.user.email` on the
 * request and `tenantContext` fail-closed 403s without it. Requiring an
 * administrator to pre-create a row before a biller may click Confirm would
 * make the identity the platform already holds unusable, and the first
 * experience of the module a 500.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE IMPORTED-ROW COLLISION, AND HOW IT IS AVOIDED
 * ─────────────────────────────────────────────────────────────────────────────
 * Slice 2's importer may already have created a row for the same human under
 * the SOURCE app's user key (`u_7f3a`, an openId, a bare username). Minting a
 * second row keyed by their email would split one person's attribution across
 * two ids, and nothing downstream could rejoin them.
 *
 * So the lookup is BY EMAIL FIRST. An existing row whose `platform_email`
 * matches is reused whatever its `user_key` is, and only a genuinely unknown
 * email creates a row — keyed by the lowercased email, which is the only
 * durable identifier the platform has for someone with no legacy history.
 *
 * `platform_email` carries a `= lower(platform_email)` CHECK from the Slice 1
 * migration, so lowercasing here is a correctness requirement, not tidiness.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TENANT-GLOBAL, NO OFFICE
 * ─────────────────────────────────────────────────────────────────────────────
 * `rcm_user_map` is one of exactly two rcm_* tables without `office_id` — the
 * documented exception, because billing staff work across both practices. There
 * is no office parameter here, and adding one would be wrong.
 */

/**
 * Resolve the acting user to an `rcm_user_map.user_key`, creating the row on
 * first use.
 *
 * MUST be called with the same connection/transaction as the write it
 * attributes: the FK is checked at statement time, so a row committed on
 * another connection is not visible to an in-flight transaction that has
 * already begun. Every caller in this slice passes its transaction client.
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} client
 *   a pg client or pool — anything with `query`.
 * @param {{ email: string, displayName?: string }} actor the SSO identity
 * @returns {Promise<string>} the user_key to stamp on the attributed column
 */
async function resolveRcmActor(client, actor) {
  const email = String(actor && actor.email ? actor.email : '').trim().toLowerCase();
  if (!email) {
    // Never stamp '' into an attributed column. The route layer's actorEmail()
    // throws for the same reason one level up; this is the backstop for a
    // caller that reached here another way.
    throw new Error('[rcm/userMap] no SSO identity — cannot attribute an RCM action');
  }
  const displayName = String((actor && actor.displayName) || '').trim() || email;

  // 1. An existing row for this human, whatever key it was imported under.
  const existing = await client.query(
    'SELECT user_key FROM rcm_user_map WHERE platform_email = $1 ORDER BY created_at LIMIT 1',
    [email]
  );
  if (existing.rows.length > 0) return String(existing.rows[0].user_key);

  // 2. First action by an unknown person. The email IS the key.
  //
  // ON CONFLICT rather than a plain INSERT because two concurrent first actions
  // race here — a biller opening two claims and confirming both. The loser of
  // that race must get the winner's key back, not a 23505 that surfaces as a
  // failed confirmation. DO UPDATE (not DO NOTHING) so RETURNING always yields
  // a row; the update itself is a no-op refresh of the display name.
  const inserted = await client.query(
    `INSERT INTO rcm_user_map (user_key, platform_email, display_name, legacy_role, active)
     VALUES ($1, $2, $3, '', true)
     ON CONFLICT (user_key) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()
     RETURNING user_key`,
    [email, email, displayName]
  );
  return String(inserted.rows[0].user_key);
}

/**
 * Display names for a set of user keys, for rendering "confirmed by".
 *
 * Returns a plain object rather than a Map so it serialises straight onto a
 * response. An unknown key is simply absent — the UI falls back to the key,
 * which is an email or a legacy id and is still more informative than blank.
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} client
 * @param {ReadonlyArray<string|null|undefined>} userKeys
 * @returns {Promise<Record<string, { displayName: string, email: string }>>}
 */
async function describeActors(client, userKeys) {
  const keys = [...new Set((userKeys || []).filter((k) => typeof k === 'string' && k))];
  if (keys.length === 0) return {};
  const { rows } = await client.query(
    'SELECT user_key, platform_email, display_name FROM rcm_user_map WHERE user_key = ANY($1::text[])',
    [keys]
  );
  /** @type {Record<string, { displayName: string, email: string }>} */
  const out = {};
  for (const r of rows) {
    out[String(r.user_key)] = {
      displayName: String(r.display_name || r.platform_email || r.user_key),
      email: String(r.platform_email || ''),
    };
  }
  return out;
}

module.exports = { resolveRcmActor, describeActors };

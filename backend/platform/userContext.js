'use strict';

/**
 * Per-request identity lookup, cached (Roles PR A).
 *
 * ONE module owns the app_user + platform_admin read that every /api/* request
 * needs, and one 60-second in-memory cache in front of it. Two consequences,
 * both deliberate:
 *
 *  - A role change takes effect within a minute WITHOUT anyone re-logging in.
 *    Nothing role-related is minted into the SSO session JWT, so there is no
 *    stale-token window and no revocation problem: the database is the only
 *    source of truth and the cache is only ever a 60s read-through.
 *  - The control DB sees roughly one identity query per user per minute rather
 *    than one per request.
 *
 * The cache is per-process. With more than one backend replica a role change
 * propagates within TTL on each of them independently, which is the same
 * guarantee — no cross-process invalidation is needed for a 60s window.
 *
 * The cache stores NEGATIVE results too (`appUser: null`), on purpose: the
 * fallback path in tenantContext hits this for every request from an unseeded
 * user, and caching the miss keeps that from becoming a per-request query.
 */

const registry = require('./registry');

/** How long a cached identity stays fresh. Also throttles the login stamp. */
const DEFAULT_TTL_MS = 60_000;

/**
 * @typedef {Object} UserContext
 * @property {import('./registry').AppUser|null} appUser      row from app_user, or null if unseeded
 * @property {boolean}                           isSuperAdmin active platform_admin row exists
 */

/**
 * @typedef {Object} CacheEntry
 * @property {UserContext} value
 * @property {number}      expiresAt   epoch ms
 * @property {number}      stampedAt   epoch ms of the last last_login_at write (0 = never)
 */

/** @type {Map<string, CacheEntry>} */
const cache = new Map();

/** @type {Map<string, Promise<UserContext>>} in-flight loads, deduped per email */
const inflight = new Map();

let ttlMs = DEFAULT_TTL_MS;

/**
 * Emails we have already warned about (unseeded @carein.ai users hitting the
 * bootstrap fallback). One line per user for the life of the process — the
 * point is to make PR B's lockdown list obvious in the logs, not to narrate
 * every request.
 * @type {Set<string>}
 */
const warnedUnseeded = new Set();

/** Normalize an email to the cache key. */
function key(email) {
  return String(email || '').trim().toLowerCase();
}

/**
 * Load identity for `email` from the control plane, through the TTL cache.
 *
 * Never throws for a missing user — an unknown email is a valid answer
 * (`{ appUser: null, isSuperAdmin: false }`). It DOES propagate control-DB
 * failures, because tenantContext must fail closed (503) rather than serve a
 * request with an unknown role.
 *
 * @param {string} email
 * @param {{ now?: number }} [opts]
 * @returns {Promise<UserContext>}
 */
async function getUserContext(email, { now = Date.now() } = {}) {
  const k = key(email);
  if (!k) return { appUser: null, isSuperAdmin: false };

  const hit = cache.get(k);
  if (hit && hit.expiresAt > now) return hit.value;

  // Collapse concurrent misses for the same email into one query.
  const pending = inflight.get(k);
  if (pending) return pending;

  const load = (async () => {
    const [appUser, platformAdmin] = await Promise.all([
      registry.getUserByEmail(k),
      registry.getPlatformAdminByEmail(k),
    ]);
    /** @type {UserContext} */
    const value = {
      appUser: appUser || null,
      isSuperAdmin: Boolean(platformAdmin && platformAdmin.status === 'active'),
    };
    // Preserve stampedAt across refreshes so the login stamp stays throttled to
    // one write per TTL even as the identity itself is re-read.
    const previous = cache.get(k);
    cache.set(k, {
      value,
      expiresAt: Date.now() + ttlMs,
      stampedAt: previous ? previous.stampedAt : 0,
    });
    return value;
  })();

  inflight.set(k, load);
  try {
    return await load;
  } finally {
    inflight.delete(k);
  }
}

/**
 * Stamp app_user.last_login_at, at most once per TTL window per user.
 *
 * Fire-and-forget by design and BEST EFFORT by contract: a failed stamp is
 * logged and swallowed. `last_login_at` exists so PR B's Users page can show
 * "last seen"; it is not authorization data, and it must never be able to fail
 * a request. Returns whether a write was attempted (the tests assert on the
 * throttle, not on the DB).
 *
 * @param {import('./registry').AppUser|null} appUser
 * @param {{ now?: number }} [opts]
 * @returns {boolean} true if a write was issued this call
 */
function stampLoginIfDue(appUser, { now = Date.now() } = {}) {
  if (!appUser || !appUser.user_id) return false;
  const k = key(appUser.email);
  const entry = cache.get(k);
  if (!entry) return false;
  if (entry.stampedAt && now - entry.stampedAt < ttlMs) return false;

  entry.stampedAt = now;
  Promise.resolve()
    .then(() => registry.touchUserLogin(appUser.user_id, new Date(now)))
    .catch((err) => {
      console.warn(
        '[userContext] last_login_at stamp failed (ignored):',
        err && err.message ? err.message : err
      );
    });
  return true;
}

/**
 * Log ONCE per process per email that an @carein.ai user reached the app with
 * no app_user row and was degraded to 'office'.
 *
 * This is the list PR B needs: every address printed here is either a typo in
 * the seed roster or a teammate nobody told us about, and the fallback cannot
 * be flipped off until the list is empty.
 * @param {string} email
 * @returns {boolean} true if this call emitted the warning
 */
function warnUnseededOnce(email) {
  const k = key(email);
  if (!k || warnedUnseeded.has(k)) return false;
  warnedUnseeded.add(k);
  console.warn(
    `[roles] NO app_user ROW for ${k} — degraded to role 'office' by the PR A bootstrap ` +
      'fallback. Seed this address (or correct the roster) before PR B turns the ' +
      'fallback off, or this account will be locked out.'
  );
  return true;
}

/** Drop all cached identities. Tests, and any future "apply now" admin action. */
function clearCache() {
  cache.clear();
  inflight.clear();
  warnedUnseeded.clear();
}

/**
 * Override the TTL. Test seam only — production uses DEFAULT_TTL_MS.
 * @param {number} ms
 */
function _setTtlForTests(ms) {
  ttlMs = Number(ms) > 0 ? Number(ms) : DEFAULT_TTL_MS;
}

module.exports = {
  getUserContext,
  stampLoginIfDue,
  warnUnseededOnce,
  clearCache,
  DEFAULT_TTL_MS,
  _setTtlForTests,
};

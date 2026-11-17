'use strict';

/**
 * MT-3: which tenant a PUBLIC email link belongs to.
 *
 * Two halves, one table (control plane, migrations/1789800000000_public_link_index.js):
 *
 *   register(req, entries)   at MINT time, on the request path that creates the
 *                            per-tenant token, BEFORE the email can leave. If it
 *                            throws, the caller sends nothing: a link that cannot
 *                            resolve is never issued.
 *   attachLinkTenant(req, …) at the PUBLIC route: hash the presented token, look
 *                            it up, and attach the tenant it names (active, and
 *                            entitled to 'tc') to req.tenant. The route's existing
 *                            per-tenant consume logic then runs unchanged.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * NO ORACLE
 * ═════════════════════════════════════════════════════════════════════════════
 * attachLinkTenant answers one of three things:
 *
 *   'attached'     the tenant is on req.tenant; carry on.
 *   'neutral'      unknown token, expired, wrong kind, tenant not active, tenant
 *                  not entitled to 'tc'. Every one of these is ONE control-plane
 *                  query and the caller answers its existing bad-token page.
 *                  Nothing distinguishes them in body, status or query count.
 *   'unavailable'  the control plane could not be reached. That depends on the
 *                  deployment, never on the token, and stays the route's 503.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * LEGACY FALLBACK (bounded, logged)
 * ═════════════════════════════════════════════════════════════════════════════
 * Links sent before this index existed have no row. For those ONLY — a hash the
 * index does not know at all — the route falls back to TC_EMAIL_TENANT_SLUG,
 * and only when that setting is present, logging "[public-link] legacy tenant
 * fallback". A hash the index DOES know (expired, wrong kind, refused tenant)
 * never falls back.
 *
 * REMOVE-BY (dated 2026-11-16): referral links live 60 days, so the fallback
 * has nothing left to serve for them 60 days after this ships to PROD — remove
 * it on (prod deploy date + 60 days). UNSUBSCRIBE links never expire: before
 * the fallback is removed, the unsubscribe hashes already in each tenant
 * (tc_messages.unsubscribe_token_hash, tc_referral_events.unsubscribe_token_hash)
 * must be backfilled into this index, or old emails' unsubscribe links would
 * answer the neutral page without recording the opt-out.
 *
 * PHI: the index holds a hash, a tenant id, a kind and two timestamps. No log
 * line here carries a token or a hash.
 */

const crypto = require('node:crypto');

const registry = require('./registry');
const acsConfig = require('../config/acsEmail');

/** @typedef {'referral_link' | 'unsubscribe'} LinkKind */
const KINDS = Object.freeze(['referral_link', 'unsubscribe']);

/** The module a public link's tenant must be entitled to. */
const REQUIRED_MODULE = 'tc';

const FALLBACK_LOG = '[public-link] legacy tenant fallback';

class PublicLinkIndexError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'PublicLinkIndexError';
    this.code = 'PUBLIC_LINK_INDEX_FAILED';
  }
}

/** SHA-256 hex of a token: the form both the index and the tenant database hold. @param {string} token */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

// ── the backend (control-plane SQL; swappable in tests) ─────────────────────

/**
 * @typedef {{ hash: string, kind: LinkKind, expiresAt: string | null }} IndexEntry
 * @typedef {{ tenant_id: string, slug: string, status: string, kind: string, live: boolean, modules: string[] }} IndexHit
 * @typedef {{
 *   insert: (tenantId: string, entries: IndexEntry[]) => Promise<void>,
 *   lookup: (hash: string) => Promise<IndexHit | null>,
 * }} Backend
 */

/** @type {Backend} */
const sqlBackend = {
  async insert(tenantId, entries) {
    // ONE statement for every link of an email: all are registered or none is.
    const values = [];
    const params = [];
    for (const e of entries) {
      const n = params.length;
      values.push(`($${n + 1}, $${n + 2}, $${n + 3}, $${n + 4})`);
      params.push(e.hash, tenantId, e.kind, e.expiresAt);
    }
    await registry.query(
      `INSERT INTO public_link_index (token_hash, tenant_id, kind, expires_at) VALUES ${values.join(', ')}`,
      params
    );
  },

  async lookup(hash) {
    // One query for every outcome: the row, its tenant, liveness by query
    // (never by deletion) and the tenant's enabled modules.
    const { rows } = await registry.query(
      `SELECT t.tenant_id, t.slug, t.status, i.kind,
              (i.expires_at IS NULL OR i.expires_at > now()) AS live,
              ARRAY(SELECT m.module FROM tenant_module m
                     WHERE m.tenant_id = t.tenant_id AND m.enabled = true
                     ORDER BY m.module) AS modules
         FROM public_link_index i
         JOIN tenant t ON t.tenant_id = i.tenant_id
        WHERE i.token_hash = $1`,
      [hash]
    );
    return rows[0] || null;
  },
};

/** @type {Backend} */
let backend = sqlBackend;

// ── mint ────────────────────────────────────────────────────────────────────

/**
 * Register the links of ONE email under the request's tenant. Throws
 * PublicLinkIndexError on anything short of a confirmed write — no tenant on
 * the request, a malformed entry, or a failed insert — so the caller sends
 * nothing.
 * @param {{ tenant?: { id?: string } }} req
 * @param {IndexEntry[]} entries
 */
async function register(req, entries) {
  const tenantId = req && req.tenant && req.tenant.id;
  if (!tenantId) throw new PublicLinkIndexError('No tenant on the request, so the email links cannot be registered.');
  if (!Array.isArray(entries) || entries.length === 0) throw new PublicLinkIndexError('No links to register.');
  for (const e of entries) {
    if (!e || typeof e.hash !== 'string' || !/^[0-9a-f]{64}$/.test(e.hash) || !KINDS.includes(e.kind)) {
      throw new PublicLinkIndexError('A malformed link was refused before registration.');
    }
    if (e.kind === 'referral_link' ? typeof e.expiresAt !== 'string' : e.expiresAt !== null) {
      throw new PublicLinkIndexError('A link was refused before registration: wrong expiry for its kind.');
    }
  }
  try {
    await backend.insert(String(tenantId), entries);
  } catch (err) {
    console.error('[public-link] index write FAILED:', err && err.message ? err.message : err);
    throw new PublicLinkIndexError('The email links could not be registered.');
  }
}

// ── resolve ─────────────────────────────────────────────────────────────────

/**
 * @param {import('express').Request} req
 * @param {{ tenant_id: string, slug: string, modules: string[] }} t
 * @param {string} actor
 */
function attach(req, t, actor) {
  req.tenant = { id: t.tenant_id, slug: t.slug, modules: t.modules, clinics: [] };
  req.user = { email: actor };
}

/**
 * Resolve the tenant a presented token belongs to and attach it. See the
 * header for the three answers.
 * @param {import('express').Request} req
 * @param {{ token: string, kind: LinkKind, actor: string, logTag: string }} args
 * @returns {Promise<'attached' | 'neutral' | 'unavailable'>}
 */
async function attachLinkTenant(req, { token, kind, actor, logTag }) {
  if (req.tenant) return 'attached';
  let hit;
  try {
    hit = await backend.lookup(hashToken(token));
  } catch (err) {
    console.error(`${logTag} REFUSED (503): control plane unreachable:`, err && err.message ? err.message : err);
    return 'unavailable';
  }

  if (hit) {
    // The index knows this hash: it is answered from the index alone, and
    // NEVER falls back to another tenant.
    const ok =
      hit.kind === kind &&
      hit.live === true &&
      hit.status === 'active' &&
      Array.isArray(hit.modules) &&
      hit.modules.includes(REQUIRED_MODULE);
    if (!ok) return 'neutral';
    attach(req, hit, actor);
    return 'attached';
  }

  // LEGACY FALLBACK — see the header. Remove on (prod deploy date + 60 days),
  // after backfilling unsubscribe hashes. Dated 2026-11-16.
  const slug = acsConfig.tenantSlug();
  if (!slug) return 'neutral';
  console.warn(`${FALLBACK_LOG} (${logTag.replace(/^\[|\]$/g, '')})`);
  let tenant;
  let modules;
  try {
    tenant = await registry.getTenantBySlug(slug);
    modules = tenant ? await registry.getEnabledModules(tenant.tenant_id) : [];
  } catch (err) {
    console.error(`${logTag} REFUSED (503): control plane unreachable:`, err && err.message ? err.message : err);
    return 'unavailable';
  }
  if (!tenant || tenant.status !== 'active' || !Array.isArray(modules) || !modules.includes(REQUIRED_MODULE)) {
    console.warn(`${logTag} legacy fallback tenant is not found, not active, or not entitled to 'tc'`);
    return 'neutral';
  }
  attach(req, { tenant_id: tenant.tenant_id, slug: tenant.slug, modules }, actor);
  return 'attached';
}

// ── tests ───────────────────────────────────────────────────────────────────

/**
 * TESTS ONLY: an in-memory index with the table's rules (PK, kinds, expiry
 * shape, append-only). `failInsert` makes the next writes throw.
 * @param {{ tenants?: (id: string) => ({ tenant_id: string, slug: string, status: string } | null), modules?: (id: string) => string[], now?: () => Date }} [deps]
 */
function createMemoryBackend({ tenants = () => null, modules = () => [], now = () => new Date() } = {}) {
  /** @type {Map<string, { tenant_id: string, kind: LinkKind, expires_at: string | null, created_at: string }>} */
  const rows = new Map();
  const state = { failInsert: false, inserts: 0, lookups: 0 };
  /** @type {Backend & { rows: typeof rows, state: typeof state }} */
  const mem = {
    rows,
    state,
    async insert(tenantId, entries) {
      state.inserts += 1;
      if (state.failInsert) throw new Error('fake control plane: insert refused');
      for (const e of entries) if (rows.has(e.hash)) throw new Error('duplicate key value violates unique constraint "public_link_index_pkey"');
      for (const e of entries) rows.set(e.hash, { tenant_id: tenantId, kind: e.kind, expires_at: e.expiresAt, created_at: now().toISOString() });
    },
    async lookup(hash) {
      state.lookups += 1;
      const r = rows.get(hash);
      if (!r) return null;
      const t = tenants(r.tenant_id);
      if (!t) return null;
      return {
        tenant_id: t.tenant_id,
        slug: t.slug,
        status: t.status,
        kind: r.kind,
        live: r.expires_at == null || new Date(r.expires_at).getTime() > now().getTime(),
        modules: modules(t.tenant_id),
      };
    },
  };
  return mem;
}

/** TESTS ONLY. @param {Backend} b */
function setBackendForTests(b) {
  backend = b;
}

function resetBackendForTests() {
  backend = sqlBackend;
}

module.exports = {
  KINDS,
  FALLBACK_LOG,
  PublicLinkIndexError,
  hashToken,
  register,
  attachLinkTenant,
  createMemoryBackend,
  setBackendForTests,
  resetBackendForTests,
};

'use strict';

/**
 * Internal client for the TC module's cross-module case endpoint (Mango slice M6).
 *
 * The voice side never reaches into TC internals: `POST /api/tc/cases/from-call`
 * is the TC track's route and its published contract is the ONLY seam. This module
 * speaks that contract over a loopback HTTP call to our own server, forwarding the
 * caller's credentials so the TC route derives the same session actor, the same
 * tenant, and applies its own `requireModule('tc')` guard exactly as it would for
 * a direct browser request.
 *
 * Why a server-side call rather than letting the browser POST to TC directly: the
 * payload carries a PatNum and an office, and PatNum numbering restarts per Open
 * Dental database. Assembling it server-side from the STORED call record means a
 * stale or hand-rolled client cannot name one office's patient while pointing at
 * another practice's case list — the same reasoning that made resolve-patient
 * resolve the office itself (see routes/unifiedCalls.js).
 *
 * The contract (final, confirmed with the TC track 2026-08-08):
 *   request  { od_patient_id, office, call_id, call_summary, call_url,
 *              patient_name, patient_phone? }
 *   response { case_id, url, attached }
 *              attached:true  → the call joined the patient's existing open case
 *              attached:false → a new case was created
 *   idempotent on call_id; 403 when the tenant lacks the 'tc' module.
 */

/** How long to wait on the TC endpoint before calling it unreachable. */
const DEFAULT_TIMEOUT_MS = 10000;

/**
 * Base URL for the loopback call. Same process, same port as this server — see
 * the PORT default in server.js. INTERNAL_API_BASE_URL exists as an override for
 * deployments that ever split the modules across containers; unset is the norm.
 * @returns {string}
 */
function internalBaseUrl() {
  if (process.env.INTERNAL_API_BASE_URL) {
    return String(process.env.INTERNAL_API_BASE_URL).replace(/\/+$/, '');
  }
  const port = process.env.PORT || (process.env.NODE_ENV === 'production' ? 5003 : 5103);
  return `http://127.0.0.1:${port}`;
}

/**
 * @typedef {Object} TcCasePayload
 * @property {number} od_patient_id
 * @property {'roland'|'valley'} office
 * @property {string} call_id
 * @property {string|null} call_summary
 * @property {string} call_url
 * @property {string} patient_name
 * @property {string} [patient_phone]
 *
 * @typedef {{ ok: true, caseId: string, url: string, attached: boolean }} TcCaseOk
 * @typedef {{ ok: false, status: number, code: string, error: string }} TcCaseErr
 */

/**
 * Hand one call to TC. Never throws — every failure comes back as a typed
 * `{ ok: false }` so the caller can refuse honestly instead of claiming success.
 *
 * @param {import('express').Request} req the originating request (for credentials)
 * @param {TcCasePayload} payload
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<TcCaseOk|TcCaseErr>}
 */
async function createCaseFromCall(req, payload, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  /** @type {Record<string,string>} */
  const headers = { 'Content-Type': 'application/json' };
  const incoming = (req && req.headers) || {};
  // Forward whichever credential the caller used: the Entra SSO session cookie or
  // the shared dashboard bearer token. Both are accepted by the /api auth gate.
  if (incoming.cookie) headers.Cookie = String(incoming.cookie);
  if (incoming.authorization) headers.Authorization = String(incoming.authorization);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(`${internalBaseUrl()}/api/tc/cases/from-call`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    // Connection refused / DNS / abort. The TC app is not answering — nothing was
    // sent, and we must not pretend otherwise.
    const message = err && err.message ? err.message : String(err);
    console.error('[tcCaseClient] TC endpoint unreachable:', message);
    return {
      ok: false,
      status: 0,
      code: 'TC_UNREACHABLE',
      error: 'The TC app did not respond',
    };
  } finally {
    clearTimeout(timer);
  }

  /** @type {Record<string, unknown>|null} */
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const message =
      (body && typeof body.message === 'string' && body.message) ||
      (body && typeof body.error === 'string' && body.error) ||
      `TC responded ${response.status}`;
    return {
      ok: false,
      status: response.status,
      code:
        response.status === 403
          ? 'TC_MODULE_NOT_ENTITLED'
          : response.status === 404
          ? 'TC_ENDPOINT_MISSING'
          : 'TC_ERROR',
      error: message,
    };
  }

  // A 200 whose body doesn't carry a case is NOT a success — the case may or may
  // not exist, and persisting a half-known linkage would be worse than refusing.
  const rawCaseId = body && (body.case_id ?? body.caseId);
  const rawUrl = body && (body.url ?? body.case_url);
  if (rawCaseId == null || rawCaseId === '' || typeof rawUrl !== 'string' || !rawUrl) {
    console.error('[tcCaseClient] TC returned 200 without case_id/url');
    return {
      ok: false,
      status: 502,
      code: 'TC_BAD_RESPONSE',
      error: 'The TC app returned an unrecognized response',
    };
  }

  return {
    ok: true,
    caseId: String(rawCaseId),
    url: rawUrl,
    attached: body.attached === true,
  };
}

module.exports = { createCaseFromCall, internalBaseUrl };

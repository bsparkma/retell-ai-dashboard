'use strict';

/**
 * Mint a short-lived Azure Speech authorization token.
 *
 * The Speech key is a long-lived secret; the token is what the browser gets.
 * The region's Security Token Service exchanges one for the other:
 *
 *   POST https://<region>.api.cognitive.microsoft.com/sts/v1.0/issueToken
 *   Ocp-Apim-Subscription-Key: <key>
 *   → 200, body = the token (a JWT, valid 10 minutes)
 *
 * The browser SDK takes that token plus the region
 * (`SpeechConfig.fromAuthorizationToken`) and streams to Azure directly.
 *
 * THE KEY NEVER LEAVES THIS FUNCTION except in the one request header above.
 * It is not returned, not logged, and not echoed in an error — a failed mint
 * reports the HTTP status and nothing else, because an STS error body is
 * outside our control and could in principle quote the request.
 */

const STS_TIMEOUT_MS = 10_000;

/** Azure region names are lowercase letters and digits ('southcentralus'). */
const REGION_SHAPE = /^[a-z0-9]{2,40}$/;

class SpeechTokenError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number | null} [status]
   */
  constructor(code, message, status = null) {
    super(message);
    this.name = 'SpeechTokenError';
    this.code = code;
    this.status = status;
  }
}

/**
 * @param {string} region
 * @returns {string}
 */
function stsUrl(region) {
  return `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`;
}

/**
 * @param {{ key: string, region: string, fetchImpl?: typeof fetch, timeoutMs?: number }} args
 * @returns {Promise<string>} the authorization token
 */
async function mintSpeechToken({ key, region, fetchImpl = fetch, timeoutMs = STS_TIMEOUT_MS }) {
  if (!key) throw new SpeechTokenError('SPEECH_KEY_MISSING', 'No Azure Speech key is configured.');
  if (!REGION_SHAPE.test(String(region || ''))) {
    throw new SpeechTokenError('SPEECH_REGION_INVALID', 'No valid Azure Speech region is configured.');
  }

  let res;
  try {
    res = await fetchImpl(stsUrl(region), {
      method: 'POST',
      headers: { 'Ocp-Apim-Subscription-Key': key, 'Content-Length': '0' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (_err) {
    // The error object may carry the request (and so the header). Drop it.
    throw new SpeechTokenError('STS_UNREACHABLE', 'Azure Speech token service could not be reached.');
  }

  if (!res.ok) {
    throw new SpeechTokenError(
      'STS_REFUSED',
      `Azure Speech token service refused the request (HTTP ${res.status}).`,
      res.status
    );
  }

  const token = String(await res.text()).trim();
  if (!token) {
    throw new SpeechTokenError('STS_EMPTY', 'Azure Speech token service returned no token.', res.status);
  }
  return token;
}

module.exports = { mintSpeechToken, stsUrl, SpeechTokenError, REGION_SHAPE, STS_TIMEOUT_MS };

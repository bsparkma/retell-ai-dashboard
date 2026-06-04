'use strict';

/**
 * PHI scrubbing for logs.
 *
 * Patient data can leak into request URLs in two ways:
 *   - query strings, e.g. /api/opendental/patients/search?q=<name>
 *   - path params, e.g. /api/calls/patient-suggestions/<name>,
 *     /api/unified-calls/phone/<phone>
 *
 * `sanitizeUrlPath` drops the query string entirely and redacts the path
 * segment that follows a known PHI-bearing segment, so neither the structured
 * access log (data/access-log.jsonl) nor morgan's stdout output records PHI.
 * Numeric-id paths (e.g. /patients/123) are NOT redacted — an OD id is not PHI.
 */

const REDACT = '[REDACTED]';

/** A path segment whose FOLLOWING segment is free-text PHI (name/phone). */
const PHI_PARENT_SEGMENTS = new Set(['phone', 'patient-suggestions', 'search']);

/**
 * @param {string} input a URL or path (may include a query string)
 * @returns {string} query-stripped, PHI-redacted path
 */
function sanitizeUrlPath(input) {
  if (!input || typeof input !== 'string') return input;
  const path = input.split('?')[0].split('#')[0];
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) {
    if (PHI_PARENT_SEGMENTS.has(parts[i - 1]) && parts[i]) {
      parts[i] = REDACT;
    }
  }
  return parts.join('/');
}

module.exports = { sanitizeUrlPath, REDACT };

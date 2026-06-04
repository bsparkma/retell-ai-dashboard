'use strict';

/**
 * Tenant-aware unified Open Dental access layer (Slice 4).
 *
 * The ONE seam through which request-scoped code reaches Open Dental. Every
 * method takes (req, ...) and resolves req.tenant.id → the control-plane
 * tenant_connector row, then routes to the correct backend:
 *
 *   1. OD cloud API  — od_api_base + OD developer/customer keys. Wraps the
 *      EXISTING api-mode client (backend/config/openDental.js). Used for general
 *      OD reads/writes when od_primary_mode = 'api'.
 *   2. On-prem CareIN connector service — connector_url + connector API key
 *      (Key Vault secret named by kv_connector_key). This is what slot-markers
 *      uses today; it is also the 'agent' general-read path (Phase 2 — stubbed).
 *
 * od_primary_mode ('api' | 'agent') is the hint for GENERAL OD reads/writes.
 * slot-markers always uses the connector service regardless of mode.
 *
 * Hard OD rules preserved:
 *   - ClinicNum scoping + the Slice-2 requireEntitledClinic entitlement check on
 *     any client-supplied clinicNum (enforced here for slot-markers).
 *   - Writes go through the cloud API / connector service only — never direct
 *     MySQL, never a row delete (cancel sets AptStatus, it does not delete).
 *   - procCode→CodeNum lookups: none exist in this repo today; any future ones
 *     live in the wrapped cloud client and are preserved by delegation.
 *
 * Connection secrets are resolved by NAME via the secrets loader (env in dev,
 * Key Vault in prod) — no connection string or key is ever read inline, and the
 * old process.env.OD_CONNECTOR_URL || 'localhost:8444' fallback is gone.
 *
 * @typedef {import('express').Request & { tenant?: { id?: string, clinics?: Array<{clinic_num:number}> } }} TenantReq
 */

const registry = require('./registry');
const secrets = require('../config/secrets');
const audit = require('./audit');
const { requireEntitledClinic } = require('../middleware/tenantContext');

// The existing api-mode OD cloud client (singleton, configured from env). For
// CareIN (tenant #1) its env config IS the tenant's config, so delegating to it
// is behavior-preserving.
const odCloudClient = require('../config/openDental');

/**
 * Typed error so route handlers can map a failure to an HTTP status without
 * leaking internals. `code` is stable; `publicMessage` is safe to return.
 */
class OdAccessError extends Error {
  /**
   * @param {string} message internal message (logged)
   * @param {string} code stable machine code
   * @param {string} [publicMessage] safe message for the client
   */
  constructor(message, code, publicMessage) {
    super(message);
    this.name = 'OdAccessError';
    this.code = code;
    this.publicMessage = publicMessage || 'Open Dental request failed';
  }
}

/** code → HTTP status, for route handlers. */
const STATUS_BY_CODE = Object.freeze({
  TENANT_UNRESOLVED: 403,
  CLINIC_FORBIDDEN: 403,
  CONNECTOR_UNCONFIGURED: 503,
  CONNECTOR_URL_MISSING: 503,
  CONNECTOR_UNREACHABLE: 503,
  CONNECTOR_UPSTREAM_ERROR: 502,
  OD_AGENT_NOT_IMPLEMENTED: 501,
  OD_CLOUD_MULTITENANT_NOT_IMPLEMENTED: 501,
  OD_MODE_UNKNOWN: 500,
});

/**
 * Map an error (OdAccessError or otherwise) to an HTTP status.
 * @param {unknown} err
 * @returns {number}
 */
function httpStatusFor(err) {
  const code = err && /** @type {any} */ (err).code;
  return (code && STATUS_BY_CODE[code]) || 500;
}

/** @param {string} base @returns {string} */
function normalizeBase(base) {
  return String(base).trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * Resolve the calling tenant's connector config (fail closed).
 * @param {TenantReq} req
 * @returns {Promise<{ tenantId: string, connector: import('./registry').TenantConnector }>}
 */
async function resolveConnector(req) {
  const tenantId = req && req.tenant && req.tenant.id;
  if (!tenantId) {
    throw new OdAccessError(
      'odAccess called without req.tenant.id — tenant context unresolved',
      'TENANT_UNRESOLVED',
      'Tenant context required'
    );
  }
  const connector = await registry.getTenantConnector(tenantId);
  if (!connector) {
    throw new OdAccessError(
      `no tenant_connector row for tenant ${tenantId}`,
      'CONNECTOR_UNCONFIGURED',
      'Open Dental is not configured for this tenant'
    );
  }
  return { tenantId, connector };
}

/**
 * Resolve the OD cloud client for a tenant (Phase 1: the single configured
 * client). Guards that the tenant's od_api_base matches the client we have, so
 * we never talk to the wrong practice's OD.
 * @param {import('./registry').TenantConnector} connector
 * @returns {typeof odCloudClient}
 */
function getCloudClient(connector) {
  const configuredBase = odCloudClient.apiUrl;
  if (
    connector.od_api_base &&
    configuredBase &&
    normalizeBase(connector.od_api_base) !== normalizeBase(configuredBase)
  ) {
    throw new OdAccessError(
      `tenant od_api_base (${connector.od_api_base}) does not match the configured OD client (${configuredBase})`,
      'OD_CLOUD_MULTITENANT_NOT_IMPLEMENTED',
      'Per-tenant OD cloud client is not available yet'
    );
  }
  return odCloudClient;
}

/**
 * Route a GENERAL OD read/write to the correct backend based on od_primary_mode.
 * 'api' delegates to the wrapped cloud client; 'agent' is the Phase 2 connector
 * gateway (stubbed). Used by the named wrappers below.
 * @param {TenantReq} req
 * @param {string} methodName a method on the cloud client
 * @param {unknown[]} args
 * @returns {Promise<any>}
 */
async function viaPrimary(req, methodName, args) {
  const { connector } = await resolveConnector(req);
  const mode = connector.od_primary_mode;

  if (mode === 'api') {
    const client = getCloudClient(connector);
    if (typeof client[methodName] !== 'function') {
      throw new OdAccessError(`OD cloud client has no method '${methodName}'`, 'OD_MODE_UNKNOWN');
    }
    return client[methodName](...args);
  }

  if (mode === 'agent') {
    // Phase 2: per-tenant on-prem agent gateway via the connector service.
    throw new OdAccessError(
      `OD '${methodName}' via on-prem agent (connector_url=${connector.connector_url || 'unset'}) is not implemented yet (Phase 2)`,
      'OD_AGENT_NOT_IMPLEMENTED',
      'This Open Dental path is not available yet'
    );
  }

  throw new OdAccessError(`unknown od_primary_mode '${mode}'`, 'OD_MODE_UNKNOWN');
}

/**
 * Low-level call to the tenant's on-prem CareIN connector service. No localhost
 * default — a tenant with no connector_url fails closed.
 * @param {TenantReq} req
 * @param {{ path: string, method?: string, query?: Record<string, unknown>, body?: unknown, connector?: import('./registry').TenantConnector }} opts
 * @returns {Promise<Response>}
 */
async function connectorRequest(req, opts) {
  const connector = opts.connector || (await resolveConnector(req)).connector;
  const base = connector.connector_url;
  if (!base) {
    throw new OdAccessError(
      'tenant has no connector_url configured',
      'CONNECTOR_URL_MISSING',
      'Open Dental connector is not configured for this tenant'
    );
  }

  const apiKey = connector.kv_connector_key
    ? await secrets.getSecretValue(connector.kv_connector_key)
    : null;

  const url = new URL(opts.path, base);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }

  /** @type {Record<string, string>} */
  const headers = {};
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  return fetch(url.toString(), {
    method: opts.method || 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

// ===========================================================================
// Connector-service methods (always the on-prem connector, any od_primary_mode)
// ===========================================================================

/**
 * CareIN slot markers for a clinic + date range. Enforces ClinicNum entitlement
 * (Slice 2) before forwarding to the connector — the client-supplied clinicNum
 * is never trusted.
 * @param {TenantReq} req
 * @param {{ startDate: string, endDate: string, clinicNum: string|number, category?: string }} params
 * @returns {Promise<any[]>}
 */
async function getSlotMarkers(req, params) {
  const { startDate, endDate, clinicNum, category } = params;

  if (!requireEntitledClinic(req, clinicNum)) {
    throw new OdAccessError(
      `clinicNum ${clinicNum} is not one of this tenant's clinics`,
      'CLINIC_FORBIDDEN',
      `clinicNum ${clinicNum} is not one of this tenant's clinics`
    );
  }

  const { connector } = await resolveConnector(req);

  let res;
  try {
    res = await connectorRequest(req, {
      connector,
      path: '/api/slot-markers',
      method: 'GET',
      query: { startDate, endDate, clinicNum, category },
    });
  } catch (err) {
    if (err instanceof OdAccessError) throw err;
    throw new OdAccessError(
      `could not reach OD connector: ${err && err.message ? err.message : err}`,
      'CONNECTOR_UNREACHABLE',
      'Could not reach OD connector'
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error('[odAccess] slot-markers connector error:', res.status, text);
    throw new OdAccessError(
      `connector returned ${res.status}`,
      'CONNECTOR_UPSTREAM_ERROR',
      'Connector returned an error'
    );
  }

  const json = await res.json().catch(() => ({}));
  return Array.isArray(json.data) ? json.data : [];
}

// ===========================================================================
// General OD reads (od_primary_mode: 'api' → cloud client, 'agent' → Phase 2)
//
// Thin named wrappers so route code reads `odAccess.searchPatients(req, q)` and
// can never reach the raw cloud singleton directly.
// ===========================================================================

/** @param {TenantReq} req @param {string} query */
function searchPatients(req, query) {
  return viaPrimary(req, 'searchPatients', [query]);
}
/** @param {TenantReq} req @param {string|number} patientId */
function getPatientDetails(req, patientId) {
  return viaPrimary(req, 'getPatientDetails', [patientId]);
}
/** @param {TenantReq} req @param {string|number} patientId @param {boolean} [includeHistory] */
function verifyPatientAppointments(req, patientId, includeHistory = true) {
  return viaPrimary(req, 'verifyPatientAppointments', [patientId, includeHistory]);
}
/** @param {TenantReq} req @param {object} [params] */
function getCalendarAppointments(req, params = {}) {
  return viaPrimary(req, 'getCalendarAppointments', [params]);
}
/** @param {TenantReq} req @param {Date} start @param {Date} end */
function getAppointmentsForDateRange(req, start, end) {
  return viaPrimary(req, 'getAppointmentsForDateRange', [start, end]);
}
/** @param {TenantReq} req @param {string|number} appointmentId */
function getAppointmentDetails(req, appointmentId) {
  return viaPrimary(req, 'getAppointmentDetails', [appointmentId]);
}
/** @param {TenantReq} req */
function getProviders(req) {
  return viaPrimary(req, 'getProviders', []);
}
/** @param {TenantReq} req */
function getOperatories(req) {
  return viaPrimary(req, 'getOperatories', []);
}
/** @param {TenantReq} req @param {string|number} providerId @param {Date|string} date */
function getProviderWorkingHours(req, providerId, date) {
  return viaPrimary(req, 'getProviderWorkingHours', [providerId, date]);
}
/** @param {TenantReq} req @param {object} appointmentData */
function checkSchedulingConflicts(req, appointmentData) {
  return viaPrimary(req, 'checkSchedulingConflicts', [appointmentData]);
}
/** @param {TenantReq} req @param {object} appointmentData @param {object[]} conflicts */
function findAlternativeTimeSlots(req, appointmentData, conflicts) {
  return viaPrimary(req, 'findAlternativeTimeSlots', [appointmentData, conflicts]);
}
/** @param {TenantReq} req @param {object} appointmentData @param {Date} targetDate */
function findAvailableSlotsForDay(req, appointmentData, targetDate) {
  return viaPrimary(req, 'findAvailableSlotsForDay', [appointmentData, targetDate]);
}
/** @param {TenantReq} req */
function getSchedulingRules(req) {
  return viaPrimary(req, 'getSchedulingRules', []);
}
/** @param {TenantReq} req */
function performSync(req) {
  return viaPrimary(req, 'performSync', []);
}
/** @param {TenantReq} req */
function testConnection(req) {
  return viaPrimary(req, 'testConnection', []);
}

// ===========================================================================
// OD writes (api mode: cloud API client; never direct MySQL, never a delete)
// ===========================================================================

/** @param {TenantReq} req @param {object} appointmentData */
function bookAppointment(req, appointmentData) {
  return viaPrimary(req, 'bookAppointment', [appointmentData]);
}
/** @param {TenantReq} req @param {string|number} appointmentId @param {object} updateData */
function updateAppointment(req, appointmentId, updateData) {
  return viaPrimary(req, 'updateAppointment', [appointmentId, updateData]);
}
/** @param {TenantReq} req @param {string|number} appointmentId @param {string} [reason] */
function cancelAppointment(req, appointmentId, reason = '') {
  // Note: the wrapped client sets AptStatus (cancelled), it does NOT delete.
  return viaPrimary(req, 'cancelAppointment', [appointmentId, reason]);
}

/**
 * Read-only status snapshot for admin/health introspection (no OD network call).
 * Lets routes report OD service state without referencing the cloud singleton.
 * @param {TenantReq} req
 * @returns {Promise<{ enabled: boolean, useDatabase: boolean, apiBase: string|undefined, lastSyncTime: any, syncActive: boolean, conflicts: Array<any>, mode: string }>}
 */
async function getStatus(req) {
  const { connector } = await resolveConnector(req);
  const client = connector.od_primary_mode === 'api' ? getCloudClient(connector) : odCloudClient;
  return {
    enabled: client.isEnabled(),
    useDatabase: !!client.useDatabase,
    apiBase: client.apiUrl,
    lastSyncTime: client.lastSyncTime || null,
    syncActive: !!client.syncInterval,
    conflicts: client.conflicts ? Array.from(client.conflicts.entries()) : [],
    mode: connector.od_primary_mode,
  };
}

// ===========================================================================
// HIPAA audit instrumentation (Slice 6)
//
// odAccess is the only path to OD (Slice 4), so wrapping the PHI-bearing methods
// here records every OD PHI read/write in ONE place. Non-PHI reference reads
// (providers, operatories, scheduling rules, status, sync, connection test) are
// not audited. resource_id is an ID or null — NEVER a PHI value (e.g. a search
// query is dropped). See docs/AUDIT.md.
// ===========================================================================

/** @typedef {{ action:'READ'|'CREATE'|'UPDATE'|'DELETE', resourceType:string, rid:(args:any[], out:any)=>any }} AuditSpec */

/** @type {Record<string, AuditSpec>} */
const AUDIT_SPECS = {
  getSlotMarkers: { action: 'READ', resourceType: 'slot_marker', rid: (a) => (a[0] && a[0].clinicNum) || null },
  searchPatients: { action: 'READ', resourceType: 'patient', rid: () => null }, // query may be PHI → no id
  getPatientDetails: { action: 'READ', resourceType: 'patient', rid: (a) => a[0] },
  verifyPatientAppointments: { action: 'READ', resourceType: 'patient_appointments', rid: (a) => a[0] },
  getCalendarAppointments: { action: 'READ', resourceType: 'appointment', rid: () => null },
  getAppointmentsForDateRange: { action: 'READ', resourceType: 'appointment', rid: () => null },
  getAppointmentDetails: { action: 'READ', resourceType: 'appointment', rid: (a) => a[0] },
  checkSchedulingConflicts: { action: 'READ', resourceType: 'appointment', rid: (a) => (a[0] && a[0].patientId) || null },
  findAlternativeTimeSlots: { action: 'READ', resourceType: 'appointment', rid: (a) => (a[0] && a[0].patientId) || null },
  findAvailableSlotsForDay: { action: 'READ', resourceType: 'appointment', rid: (a) => (a[0] && a[0].patientId) || null },
  bookAppointment: { action: 'CREATE', resourceType: 'appointment', rid: (a, out) => (out && out.appointmentId) || (a[0] && a[0].patientId) || null },
  updateAppointment: { action: 'UPDATE', resourceType: 'appointment', rid: (a) => a[0] },
  // Cancel sets AptStatus (an UPDATE) — never a row delete; hence action UPDATE.
  cancelAppointment: { action: 'UPDATE', resourceType: 'appointment', rid: (a) => a[0] },
};

/**
 * @param {AuditSpec} spec
 * @param {any[]} args
 * @param {any} out
 * @returns {string|null}
 */
function safeResourceId(spec, args, out) {
  try {
    const v = spec.rid(args, out);
    return v == null ? null : String(v);
  } catch (_e) {
    return null;
  }
}

/**
 * Wrap a (req, ...) OD method so every call emits an audit row. Fail-closed: a
 * failed audit write on the SUCCESS path propagates, so PHI is never returned
 * without a recorded trail. Failures are best-effort audited (never masking the
 * original error).
 * @param {string} name
 * @param {Function} fn
 * @returns {Function}
 */
function withAudit(name, fn) {
  const spec = AUDIT_SPECS[name];
  if (!spec) return fn;
  return async function auditedOdMethod(req, ...args) {
    let out;
    try {
      out = await fn(req, ...args);
    } catch (err) {
      const result = err && err.code === 'TENANT_UNRESOLVED' ? 'UNAUTHORIZED' : 'ERROR';
      if (req && req.tenant && req.tenant.id) {
        try {
          await audit.audit(req, {
            action: spec.action,
            resourceType: spec.resourceType,
            resourceId: safeResourceId(spec, args, undefined),
            result,
          });
        } catch (_auditErr) {
          // Original error takes precedence; don't mask it with an audit failure.
        }
      }
      throw err;
    }

    // Success — audit BEFORE returning. If the audit write fails, propagate
    // (do NOT return PHI without a trail).
    await audit.audit(req, {
      action: spec.action,
      resourceType: spec.resourceType,
      resourceId: safeResourceId(spec, args, out),
      result: 'SUCCESS',
    });
    return out;
  };
}

module.exports = {
  OdAccessError,
  httpStatusFor,
  // connector service (PHI — audited)
  connectorRequest,
  getSlotMarkers: withAudit('getSlotMarkers', getSlotMarkers),
  // general reads (patient/appointment → audited)
  searchPatients: withAudit('searchPatients', searchPatients),
  getPatientDetails: withAudit('getPatientDetails', getPatientDetails),
  verifyPatientAppointments: withAudit('verifyPatientAppointments', verifyPatientAppointments),
  getCalendarAppointments: withAudit('getCalendarAppointments', getCalendarAppointments),
  getAppointmentsForDateRange: withAudit('getAppointmentsForDateRange', getAppointmentsForDateRange),
  getAppointmentDetails: withAudit('getAppointmentDetails', getAppointmentDetails),
  checkSchedulingConflicts: withAudit('checkSchedulingConflicts', checkSchedulingConflicts),
  findAlternativeTimeSlots: withAudit('findAlternativeTimeSlots', findAlternativeTimeSlots),
  findAvailableSlotsForDay: withAudit('findAvailableSlotsForDay', findAvailableSlotsForDay),
  // non-PHI reference reads (NOT audited)
  getProviders,
  getOperatories,
  getProviderWorkingHours,
  getSchedulingRules,
  performSync,
  testConnection,
  // writes (audited)
  bookAppointment: withAudit('bookAppointment', bookAppointment),
  updateAppointment: withAudit('updateAppointment', updateAppointment),
  cancelAppointment: withAudit('cancelAppointment', cancelAppointment),
  // introspection (NOT audited)
  getStatus,
};

'use strict';

/**
 * /api/tc/providers — the provider directory: the office's own list of
 * providers, for a referral's referring provider and a pre-auth's doctor.
 *
 *   GET  /          the office's providers (?includeInactive=true), with
 *                   `canEdit` for this caller
 *   POST /          add one by hand                          (admin + office)
 *   PUT  /:id       edit one: name, credential suffix, active (admin + office)
 *   POST /import    "Import from Open Dental": ONE read-only read of this
 *                   office's providers, merged in additively  (admin + office)
 *
 * There is NO delete, here or anywhere: a provider who left is marked
 * inactive. The app role holds no DELETE grant on the table (1792700000000).
 *
 * READS are tc.full (the mount). The doctor reads the active list through
 * /referrals/signoff/providers and the hygienist through
 * /api/hyg/visit/:aptNum/provider-directory — the same three seams the
 * specialist directory has. WRITES need tc.notification_defaults, the
 * admin + office action the office's other Settings (email identity, alert
 * defaults) already use.
 *
 * THE IMPORT
 *   - Office from `?office=` (requireOffice), never the body; the body is the
 *     empty strict object, so any field is a 400 and Open Dental is not asked.
 *   - Read through THAT office's own Open Dental client (odOffices), with
 *     assertOfficeMatch on every call — never another practice's database.
 *     GET-only by construction: the closure exposes apiGetRaw and nothing else.
 *   - Open Dental is read BEFORE any transaction opens, and a failed or
 *     truncated read writes nothing.
 *   - The merge (services/tc/providerImport.js) adds new ProvNums, updates the
 *     names of rows already linked, and never deletes or deactivates. There is
 *     no automatic sync; the button is the refresh.
 *   - (office_id, od_prov_num) is UNIQUE, so two imports racing cannot both add
 *     the same provider: the loser rolls back whole and gets a 409.
 *
 * AUDIT. Every row an import or a form adds or changes gets its own audit row
 * (CREATE / UPDATE on tc_provider_directory), written inside the transaction
 * so a failed audit write rolls the change back. A provider list is not PHI,
 * so a read is not audited (the specialist directory's rule).
 */

const express = require('express');

const { contract, requireOffice, actorEmail, parseBody, h, auditTc } = require('./helpers');
const tenantDb = require('../../platform/tenantDb');
const { holdsPermission } = require('../../config/permissions');
const odOffices = require('../../config/odOffices');
const { withTenantTx } = require('./tx');
const store = require('./providerStore');
const providerImport = require('../../services/tc/providerImport');

const { z, TcProviderInput, TcProviderImportRequest } = contract;

const router = express.Router();
router.use(requireOffice);

const ProviderId = z.string().uuid();

/** Postgres unique violation (two imports added the same ProvNum at once). */
const PG_UNIQUE_VIOLATION = '23505';

/** admin + office: the action the office's other Settings use. */
const EDIT_ACTION = 'tc.notification_defaults';

function canEdit(req) {
  return holdsPermission(req, EDIT_ACTION);
}

function forbidden(res) {
  return res.status(403).json({
    success: false,
    error: 'Only a practice admin or office manager can change the provider list.',
    code: 'FORBIDDEN',
  });
}

function badId(res) {
  return res.status(400).json({ success: false, error: 'Invalid provider id', code: 'INVALID_ID' });
}

function notFound(res) {
  return res.status(404).json({ success: false, error: 'Provider not found', code: 'NOT_FOUND' });
}

/** What changed, as an audit prior_state slug (the grammar is slugs, never prose). */
function priorState(row) {
  return row.active ? 'active' : 'inactive';
}

router.get(
  '/',
  h(async (req, res) => {
    const includeInactive = String(req.query.includeInactive || '') === 'true';
    const rows = await tenantDb.withTenantDb(req, (pool) =>
      store.listProviders(pool, req.tcOffice, { includeInactive })
    );
    res.json({ success: true, entries: rows.map(store.toEntry), canEdit: canEdit(req) });
  })
);

router.post(
  '/',
  h(async (req, res) => {
    if (!canEdit(req)) return forbidden(res);
    const input = parseBody(res, TcProviderInput, req.body);
    if (!input) return undefined;
    const office = req.tcOffice;
    const row = await withTenantTx(req, async (client) => {
      const inserted = await store.insertProvider(client, office, input, actorEmail(req));
      if (!inserted) throw new Error('provider was not stored');
      await auditTc(req, 'CREATE', 'tc_provider_directory', String(inserted.provider_id), { office });
      return inserted;
    });
    return res.status(201).json({ success: true, entry: store.toEntry(row) });
  })
);

router.put(
  '/:id',
  h(async (req, res) => {
    if (!canEdit(req)) return forbidden(res);
    const id = ProviderId.safeParse(req.params.id);
    if (!id.success) return badId(res);
    const input = parseBody(res, TcProviderInput, req.body);
    if (!input) return undefined;
    const office = req.tcOffice;
    const after = await withTenantTx(req, async (client) => {
      const before = await store.findProvider(client, office, id.data);
      if (!before) return null;
      const updated = await store.updateProvider(client, office, id.data, input, actorEmail(req));
      if (!updated) return null;
      await auditTc(req, 'UPDATE', 'tc_provider_directory', id.data, { office, priorState: priorState(before) });
      return updated;
    });
    if (!after) return notFound(res);
    return res.json({ success: true, entry: store.toEntry(after) });
  })
);

/**
 * Read THIS office's providers from its own Open Dental. Returns { rows } or
 * { refusal: [status, error, code] }. No transaction is open while it runs.
 */
async function readOfficeProviders(office) {
  let od;
  try {
    od = odOffices.assertOfficeMatch(office, odOffices.getOdOffice(office));
  } catch (err) {
    if (!(err instanceof odOffices.OdOfficeError)) throw err;
    return { refusal: [503, err.publicMessage || 'Open Dental is not connected for this office', 'OFFICE_NOT_CONNECTED'] };
  }
  // GET-only, and re-asserted per call: no other practice's client can be used.
  const odGet = (path, params, opts) =>
    odOffices.assertOfficeMatch(office, od).client.apiGetRaw(path, params, { ...(opts || {}), module: 'tc' });
  try {
    return { rows: await providerImport.readOdProviders(odGet) };
  } catch (err) {
    console.error(
      `[tc/providers] office=${office} import: providers read failed (OD status ${(err && err.odStatus) || 'n/a'}${
        err && err.truncated ? ', truncated' : ''
      })`
    );
    return { refusal: [502, 'Could not read the provider list from Open Dental. Nothing was changed.', 'OD_READ_FAILED'] };
  }
}

router.post(
  '/import',
  h(async (req, res) => {
    if (!canEdit(req)) return forbidden(res);
    const body = parseBody(res, TcProviderImportRequest, req.body && typeof req.body === 'object' ? req.body : {});
    if (!body) return undefined;
    const office = req.tcOffice;
    const actor = actorEmail(req);

    const read = await readOfficeProviders(office);
    if (read.refusal) {
      const [status, error, code] = read.refusal;
      return res.status(status).json({ success: false, error, code });
    }

    let plan;
    try {
      plan = await withTenantTx(req, async (client) => {
        const existing = await store.listProviders(client, office, { includeInactive: true });
        const p = providerImport.planImport(read.rows, existing);
        for (const ins of p.inserts) {
          const row = await store.insertProvider(
            client,
            office,
            { name: ins.name, credentialSuffix: ins.credentialSuffix, active: true, odProvNum: ins.odProvNum },
            actor
          );
          if (!row) throw new Error('imported provider was not stored');
          await auditTc(req, 'CREATE', 'tc_provider_directory', String(row.provider_id), { office });
        }
        for (const up of p.updates) {
          const row = await store.updateProviderName(client, office, up.providerId, up, actor);
          if (!row) throw new Error('imported provider update was not stored');
          await auditTc(req, 'UPDATE', 'tc_provider_directory', up.providerId, { office, priorState: priorState(row) });
        }
        return p;
      });
    } catch (err) {
      if (err && err.code === PG_UNIQUE_VIOLATION) {
        return res.status(409).json({
          success: false,
          error: 'Another import of this list was running at the same time. Nothing from this one was saved; try again.',
          code: 'IMPORT_RACE',
        });
      }
      throw err;
    }

    const rows = await tenantDb.withTenantDb(req, (pool) => store.listProviders(pool, office, { includeInactive: true }));
    return res.json({
      success: true,
      added: plan.inserts.length,
      updated: plan.updates.length,
      unchanged: plan.unchanged,
      skippedHidden: plan.skippedHidden,
      skippedHygienists: plan.skippedHygienists,
      skippedNoName: plan.skippedNoName,
      entries: rows.map(store.toEntry),
    });
  })
);

module.exports = router;

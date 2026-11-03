'use strict';

/**
 * /api/platform/print-templates — Settings → Print templates (CO-3).
 *
 *   GET  /?office=                        both templates as they print now (saved,
 *                                         or the shipped default), the office's
 *                                         letterhead prefill, the placeholder menu
 *                                         is the shared contract's
 *   PUT  /:type?office=                   save one template's text  { heading,
 *                                         letterheadName, letterheadAddress,
 *                                         letterheadPhone, body, signatureLine }
 *   POST /:type/logo?office=              upload a logo (multipart "file"; PNG or
 *                                         JPEG, ≤ 2 MB)
 *   POST /:type/logo/remove?office=       print without a logo again
 *   GET  /:type/logo?office=              the logo's bytes, for the preview
 *   PUT  /:type/styling?office=           CO-3b: save one template's styling
 *                                         { styling: {accentColor, fontPair,
 *                                         logoPlacement, logoSize, layout} | null }
 *   GET  /fonts/:file?office=             CO-3b: a bundled print font's bytes, so
 *                                         the preview draws with the very file the
 *                                         PDF embeds (allow-listed names only)
 *
 * STYLING (CO-3b) is validated against the CLOSED schema
 * (shared/tc/printStyling.ts): an unknown key, a colour that is not #rrggbb, a
 * colour too light to read on white (below 4.5 : 1), or an option not on the
 * curated list is refused 400 BY NAME (PRINT_STYLE_UNKNOWN_KEY /
 * _INVALID_COLOR / _ACCENT_TOO_LIGHT / _UNKNOWN_OPTION / _MISSING_KEY /
 * _NOT_AN_OBJECT), and nothing is stored. Audited like a wording save, inside
 * the transaction, prior_state `style_default` | `style_set`.
 *
 * THE GATE is the Practice staff page's: `requirePermission('admin.all')` at
 * the mount in server.js, ABOVE the /api/platform super_admin mount — the
 * office manager edits these. Front-desk and TC staff print; they do not edit.
 *
 * THE OFFICE is `?office=` (TC's requireOffice: roland | valley), in every
 * WHERE. A body never names an office or a type.
 *
 * THE MENU. A save whose body or signature line carries a `{{...}}` that is
 * not on the closed placeholder menu — or a placeholder in the letterhead or
 * heading, or a stray brace — is refused 400 with the problem NAMED (code
 * PRINT_TEMPLATE_UNKNOWN_PLACEHOLDER / _MALFORMED_PLACEHOLDER /
 * _PLACEHOLDER_NOT_ALLOWED_HERE). The editor runs the same validator.
 *
 * HONEST SAVE: a save answers the template AS READ BACK, and 500
 * SAVE_NOT_CONFIRMED if what is stored is not what was sent.
 *
 * AUDIT: one row per change, inside the save's transaction (a failed audit
 * write rolls the save back): resource_type 'tc_print_template', resource_id
 * '<office>:<type>', prior_state `default` (nothing saved before) | `stored`,
 * or for a logo `logo_none` | `logo_set`. Never the wording itself — the audit
 * CHECK admits slugs only. Reading the page is a config read and is not
 * audited, like the Practice staff page.
 *
 * LOGO STORAGE does not exist yet in any environment: an upload answers 503
 * PRINT_LOGO_STORAGE_UNAVAILABLE "Logo storage is not set up for this
 * environment" and stores nothing. Everything else works without a logo.
 *
 * No Open Dental, no patient data.
 */

const express = require('express');
const multer = require('multer');

const contract = require('../tc/contract.gen.cjs');
const { requireOffice, actorEmail } = require('./tc/helpers');
const { withTenantTx } = require('./tc/tx');
const tenantDb = require('../platform/tenantDb');
const { audit, AuditError } = require('../platform/audit');
const store = require('../services/tc/printTemplateStore');
const assets = require('../services/tc/printAssetStore');
const { prepareLogo, sniffLogoType, LogoImageError } = require('../services/tc/printImage');
const { fontFileFor } = require('../services/tc/printFonts');

/** A logo is a letterhead mark, not a document: 2 MB is plenty. */
const LOGO_MAX_BYTES = 2 * 1024 * 1024;

const router = express.Router();
router.use(requireOffice);

function fail(res, status, error, code, extra = {}) {
  return res.status(status).json({ success: false, error, code, ...extra });
}

/** Async handler with the platform's error shape. */
function h(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.error('[print-templates] ' + req.method + ' failed:', err && err.message ? err.message : err);
      if (res.headersSent) return;
      if (err instanceof AuditError) fail(res, 500, 'The audit trail could not be written, so nothing was saved.', 'AUDIT_FAILED');
      else fail(res, 500, 'Could not save the print template', 'INTERNAL_ERROR');
    }
  };
}

/** `:type` from the registry, or a 404 naming the menu. */
function typeFrom(req, res) {
  const type = req.params.type;
  if (contract.isPrintTemplateType(type)) return type;
  fail(res, 404, `No such print template. Templates: ${contract.PRINT_TEMPLATE_TYPE_KEYS.join(', ')}`, 'PRINT_TEMPLATE_NOT_FOUND');
  return null;
}

function auditTemplate(req, office, type, priorState) {
  return audit(req, {
    action: 'UPDATE',
    resourceType: 'tc_print_template',
    resourceId: `${office}:${type}`,
    result: 'SUCCESS',
    office,
    sourceRef: null,
    priorState,
  });
}

/** Both types' states for the office. */
async function readAll(req, office) {
  const prefill = await store.prefillFor(office);
  const rows = await tenantDb.withTenantDb(req, (pool) => store.rowsFor(pool, office));
  return {
    prefill,
    templates: contract.PRINT_TEMPLATE_TYPE_KEYS.map((type) => store.stateOf(type, rows.get(type) || null, prefill)),
  };
}

// ── GET /fonts/:file — a bundled print font, for the preview (CO-3b) ───────

router.get(
  '/fonts/:file',
  h(async (req, res) => {
    // The allow-list is the contract's list of bundled files: a request names
    // one of those or nothing — never a path.
    const file = fontFileFor(req.params.file);
    if (!file) return fail(res, 404, 'No such print font', 'PRINT_FONT_NOT_FOUND');
    res.set('Content-Type', 'font/ttf');
    res.set('Cache-Control', 'private, max-age=86400');
    return res.sendFile(file);
  })
);

// ── GET / ─────────────────────────────────────────────────────────────────

router.get(
  '/',
  h(async (req, res) => {
    const office = req.tcOffice;
    const { prefill, templates } = await readAll(req, office);
    res.json({ success: true, office, prefill, templates, logoStorageConfigured: assets.isConfigured() });
  })
);

// ── PUT /:type — save the wording ─────────────────────────────────────────

router.put(
  '/:type',
  h(async (req, res) => {
    const type = typeFrom(req, res);
    if (!type) return undefined;
    const office = req.tcOffice;
    const parsed = contract.PrintTemplateFields.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue && issue.path.length > 0 ? issue.path.join('.') : 'body';
      return fail(res, 400, `${field}: ${issue ? issue.message : 'is not valid'}`, 'INVALID_BODY', { field });
    }
    const fields = parsed.data;
    const problems = contract.validatePrintTemplate(fields);
    if (problems.length > 0) {
      return fail(res, 400, problems[0].message, problems[0].code, { field: problems[0].field, problems });
    }
    const actor = String(actorEmail(req)).trim().toLowerCase();

    await withTenantTx(req, async (client) => {
      const outcome = await store.saveFields(client, { office, type, fields, actor });
      // Inside the transaction: no trail, no save.
      await auditTemplate(req, office, type, outcome === 'created' ? 'default' : 'stored');
    });

    const prefill = await store.prefillFor(office);
    const row = await tenantDb.withTenantDb(req, (pool) => store.rowFor(pool, office, type));
    const state = row ? store.stateOf(type, row, prefill) : null;
    const same = state && JSON.stringify(state.fields) === JSON.stringify(fields);
    if (!same) {
      return fail(res, 500, 'The template could not be read back as saved. Reload before trusting it.', 'SAVE_NOT_CONFIRMED');
    }
    return res.json({ success: true, template: state });
  })
);

// ── PUT /:type/styling — save the styling (CO-3b) ─────────────────────────

router.put(
  '/:type/styling',
  h(async (req, res) => {
    const type = typeFrom(req, res);
    if (!type) return undefined;
    const office = req.tcOffice;
    const envelope = contract.PrintStylingSaveRequest.safeParse(req.body ?? {});
    if (!envelope.success || !Object.prototype.hasOwnProperty.call(req.body ?? {}, 'styling')) {
      return fail(res, 400, 'Send { "styling": { ... } } (or null for the defaults), and nothing else.', 'INVALID_BODY');
    }
    let styling = null;
    if (envelope.data.styling !== null) {
      const checked = contract.validatePrintStyling(envelope.data.styling);
      if (!checked.ok) {
        const first = checked.problems[0];
        return fail(res, 400, first.message, first.code, { field: first.field, problems: checked.problems });
      }
      styling = checked.styling;
    }
    const actor = String(actorEmail(req)).trim().toLowerCase();
    const prefill = await store.prefillFor(office);

    await withTenantTx(req, async (client) => {
      const { prior } = await store.saveStyling(client, { office, type, styling, actor, prefill });
      // Inside the transaction: no trail, no save.
      await auditTemplate(req, office, type, prior);
    });

    const row = await tenantDb.withTenantDb(req, (pool) => store.rowFor(pool, office, type));
    const state = row ? store.stateOf(type, row, prefill) : null;
    const wanted = styling || contract.PRINT_STYLING_DEFAULTS;
    if (!state || JSON.stringify(state.styling) !== JSON.stringify({ ...contract.PRINT_STYLING_DEFAULTS, ...wanted })) {
      return fail(res, 500, 'The styling could not be read back as saved. Reload before trusting it.', 'SAVE_NOT_CONFIRMED');
    }
    return res.json({ success: true, template: state });
  })
);

// ── POST /:type/logo — upload ─────────────────────────────────────────────

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: LOGO_MAX_BYTES + 1, files: 1 } });

function receiveLogo(req, res, next) {
  // Fail closed BEFORE a byte is read when there is nowhere to put it.
  if (!assets.isConfigured()) {
    return fail(res, 503, `${assets.UNAVAILABLE_MESSAGE}. Nothing was saved; the template prints without a logo.`, 'PRINT_LOGO_STORAGE_UNAVAILABLE');
  }
  return upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return fail(res, 413, 'A logo must be 2 MB or smaller.', 'LOGO_TOO_LARGE');
    return fail(res, 400, 'Send exactly one image, in a multipart field named "file".', 'INVALID_UPLOAD');
  });
}

router.post(
  '/:type/logo',
  receiveLogo,
  h(async (req, res) => {
    const type = typeFrom(req, res);
    if (!type) return undefined;
    const office = req.tcOffice;
    const file = req.file;
    if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
      return fail(res, 400, 'Choose an image to upload.', 'INVALID_UPLOAD');
    }
    const contentType = sniffLogoType(file.buffer);
    if (!contentType) return fail(res, 415, 'A logo must be a PNG or JPEG image.', 'LOGO_TYPE_NOT_ALLOWED');
    try {
      // Refused here, by name — never half-drawn at print time.
      prepareLogo(file.buffer);
    } catch (err) {
      if (err instanceof LogoImageError) return fail(res, 415, err.message, err.code);
      throw err;
    }
    const tenantSlug = req.tenant && req.tenant.slug;
    if (!tenantSlug) return fail(res, 403, 'No practice for this request', 'NO_TENANT');
    const actor = String(actorEmail(req)).trim().toLowerCase();

    let stored;
    try {
      stored = await assets.putLogo({ tenantSlug, office, data: file.buffer, contentType });
    } catch (err) {
      if (err && err.code === 'PRINT_LOGO_STORAGE_UNAVAILABLE') {
        console.error(`[print-templates] office=${office} logo storage unavailable: ${err.message}`);
        return fail(res, 503, `${assets.UNAVAILABLE_MESSAGE}. Nothing was saved; the template prints without a logo.`, 'PRINT_LOGO_STORAGE_UNAVAILABLE');
      }
      throw err;
    }
    const prefill = await store.prefillFor(office);
    try {
      await withTenantTx(req, async (client) => {
        const { prior } = await store.setLogo(client, { office, type, logoKey: stored.key, contentType, actor, prefill });
        await auditTemplate(req, office, type, prior ? 'logo_set' : 'logo_none');
      });
    } catch (err) {
      // The bytes are stored but nothing points at them. Named, so they can be found.
      console.error(`[print-templates] office=${office} logo stored at ${stored.key} but not saved: ${(err && err.message) || err}`);
      throw err;
    }
    const row = await tenantDb.withTenantDb(req, (pool) => store.rowFor(pool, office, type));
    if (!row || row.logo_key !== stored.key) {
      return fail(res, 500, 'The logo could not be read back as saved. Reload before trusting it.', 'SAVE_NOT_CONFIRMED');
    }
    return res.status(201).json({ success: true, template: store.stateOf(type, row, prefill) });
  })
);

// ── POST /:type/logo/remove ───────────────────────────────────────────────

router.post(
  '/:type/logo/remove',
  h(async (req, res) => {
    const type = typeFrom(req, res);
    if (!type) return undefined;
    const office = req.tcOffice;
    const actor = String(actorEmail(req)).trim().toLowerCase();
    const prefill = await store.prefillFor(office);
    const current = await tenantDb.withTenantDb(req, (pool) => store.rowFor(pool, office, type));
    if (!current || !current.logo_key) {
      return res.json({ success: true, template: store.stateOf(type, current, prefill) });
    }
    await withTenantTx(req, async (client) => {
      await store.setLogo(client, { office, type, logoKey: null, contentType: null, actor, prefill });
      await auditTemplate(req, office, type, 'logo_set');
    });
    const row = await tenantDb.withTenantDb(req, (pool) => store.rowFor(pool, office, type));
    if (!row || row.logo_key) {
      return fail(res, 500, 'The change could not be read back as saved. Reload before trusting it.', 'SAVE_NOT_CONFIRMED');
    }
    return res.json({ success: true, template: store.stateOf(type, row, prefill) });
  })
);

// ── GET /:type/logo — bytes for the preview ───────────────────────────────

router.get(
  '/:type/logo',
  h(async (req, res) => {
    const type = typeFrom(req, res);
    if (!type) return undefined;
    const office = req.tcOffice;
    const row = await tenantDb.withTenantDb(req, (pool) => store.rowFor(pool, office, type));
    if (!row || !row.logo_key) return fail(res, 404, 'This template has no logo', 'NO_LOGO');
    let bytes;
    try {
      bytes = await assets.getLogo(row.logo_key);
    } catch (err) {
      if (err && err.code === 'PRINT_LOGO_STORAGE_UNAVAILABLE') {
        return fail(res, 503, assets.UNAVAILABLE_MESSAGE, 'PRINT_LOGO_STORAGE_UNAVAILABLE');
      }
      throw err;
    }
    res.set('Content-Type', row.logo_content_type);
    res.set('Cache-Control', 'private, no-store');
    return res.send(bytes);
  })
);

module.exports = router;
module.exports.LOGO_MAX_BYTES = LOGO_MAX_BYTES;

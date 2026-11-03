'use strict';

/**
 * Printing from the checkout workup (CO-3): the school/work excuse and the
 * appointment card. Mounted on the checkout router (routes/tc/checkout.js), so
 * it sits behind tc.full, `?office=` and the checkout switch like everything
 * there.
 *
 *   GET  /:id/print?office=   what the print dialog starts from: the templates,
 *                             the card's own patient / day / provider and the
 *                             office (read-only), and the three values the
 *                             desk may change, pre-filled where known
 *   POST /:id/print?office=   { templateType, timeSeenRange, nextAppointmentDate,
 *                             nextAppointmentTime } → application/pdf
 *
 * WHAT FILLS THE PLACEHOLDERS — the menu and nothing else:
 *   patient_first_name / patient_full_name   the STORED record's patient name
 *   date_seen                                the record's visit day
 *   provider_name                            the record's provider (seen by, else
 *                                            the hygiene provider), as a FULL
 *                                            name — see below
 *   office_name / _address / _phone          the office's template letterhead
 *   time_seen_range                          the request (pre-filled from the
 *                                            schedule appointment's start, CO-5b)
 *   next_appointment_date / _time            the request (pre-filled from the
 *                                            Scheduled anchor, CO-4a)
 * The office is the request's (requireOffice) and the record is the one this
 * office holds under that id. The body cannot name a patient, an office, a
 * provider or a day.
 *
 * THE PROVIDER'S NAME. The record stores Open Dental's provider abbreviation
 * ("JF"); a letter signs with the name ("Dr. Jane Example"). Both the dialog
 * and the PDF resolve it through services/tc/printProviderName.js — one READ
 * (GET /providers, hour-cached per office) on the record's own office's
 * client — so what the dialog shows is what prints. If that read cannot answer,
 * the abbreviation prints exactly as before; a print never waits on it.
 *
 * NOTHING IS STORED: no row, no file, nothing on the patient, nothing in Open
 * Dental (the provider lookup is the only Open Dental call, and it is a read).
 * A printout is a DISCLOSURE, so each one
 * writes an audit row first — resource_type 'tc_checkout_print', the checkout's
 * id, the office, source_ref `template:<type>|patient:<PatNum>`, who and when —
 * and if that row cannot be written, no PDF is sent (500 PRINT_AUDIT_FAILED).
 *
 * A LOGO THAT CANNOT BE READ is left off, and the answer says so in the
 * `X-Print-Logo: omitted` header; the printout itself does not depend on it.
 */

const { z } = require('zod');

const contract = require('../../tc/contract.gen.cjs');
const { parseBody, h, notFound } = require('./helpers');
const tenantDb = require('../../platform/tenantDb');
const { audit } = require('../../platform/audit');
const checkoutStore = require('./checkoutStore');
const store = require('../../services/tc/printTemplateStore');
const assets = require('../../services/tc/printAssetStore');
const { prepareLogo } = require('../../services/tc/printImage');
const { renderPrintPdf } = require('../../services/tc/printPdf');
const { printProviderName } = require('../../services/tc/printProviderName');

const HandoffId = z.string().uuid();

/** The card's own facts, from the STORED row. Pure; `providerName` is the stored label. */
function factsOf(row) {
  const names = contract.printNameParts(String(row.patient_name || ''));
  const handoff = checkoutStore.toHandoff(row);
  const origin = handoff.scheduleAppointment;
  const anchor = handoff.appointment;
  return {
    firstName: names.first,
    fullName: names.full,
    dateSeen: handoff.visitDate ? contract.printDateLabel(handoff.visitDate) : '',
    providerName: (handoff.providerSeen || handoff.provider || '').trim(),
    // Pre-fills: the schedule appointment's start (CO-5b), the Scheduled anchor (CO-4a).
    timeSeenRange: origin && origin.dateTime ? contract.printTimeLabel(origin.dateTime) : '',
    nextAppointmentDate: anchor && anchor.dateTime ? contract.printDateLabel(anchor.dateTime.slice(0, 10), { weekday: true }) : '',
    nextAppointmentTime: anchor && anchor.dateTime ? contract.printTimeLabel(anchor.dateTime) : '',
  };
}

/**
 * factsOf, with the provider's stored label resolved to the full name it signs
 * with. Never throws; an unresolvable label is kept as stored.
 */
async function resolvedFactsOf(row, office) {
  const facts = factsOf(row);
  return { ...facts, providerName: await printProviderName(office, facts.providerName) };
}

/**
 * The values one printout is filled from: EXACTLY the menu's names. Pure.
 * @returns {Record<string, string>}
 */
function printValues(facts, template, editable) {
  return {
    patient_first_name: facts.firstName,
    patient_full_name: facts.fullName,
    date_seen: facts.dateSeen,
    time_seen_range: editable.timeSeenRange,
    next_appointment_date: editable.nextAppointmentDate,
    next_appointment_time: editable.nextAppointmentTime,
    office_name: template.letterheadName,
    office_address: template.letterheadAddress.replace(/\r?\n/g, ', '),
    office_phone: template.letterheadPhone,
    provider_name: facts.providerName,
  };
}

/**
 * @param {import('express').Router} router  the checkout router (requireOffice applied)
 * @param {{ enter: (req, res) => Promise<string|null> }} deps  checkout's gate + sweep
 */
function mount(router, { enter }) {
  async function loadRow(req, res) {
    const id = HandoffId.safeParse(req.params.id);
    if (!id.success) {
      notFound(res, 'checkout handoff');
      return null;
    }
    const row = await tenantDb.withTenantDb(req, (pool) => checkoutStore.findById(pool, req.tcOffice, id.data));
    if (!row) {
      notFound(res, 'checkout handoff');
      return null;
    }
    return row;
  }

  router.get(
    '/:id/print',
    h(async (req, res) => {
      if ((await enter(req, res)) === null) return undefined;
      const row = await loadRow(req, res);
      if (!row) return undefined;
      const office = req.tcOffice;
      const facts = await resolvedFactsOf(row, office);
      const prefill = await store.prefillFor(office);
      const saved = await tenantDb.withTenantDb(req, (pool) => store.rowFor(pool, office, 'excuse'));
      const officeName = store.effective('excuse', saved, prefill).letterheadName;
      return res.json({
        success: true,
        templates: contract.PRINT_TEMPLATE_TYPE_KEYS.map((type) => ({ type, label: contract.PRINT_TEMPLATE_TYPES[type].label })),
        fixed: { patientFullName: facts.fullName, dateSeen: facts.dateSeen, providerName: facts.providerName, officeName },
        editable: {
          timeSeenRange: facts.timeSeenRange,
          nextAppointmentDate: facts.nextAppointmentDate,
          nextAppointmentTime: facts.nextAppointmentTime,
        },
      });
    })
  );

  router.post(
    '/:id/print',
    h(async (req, res) => {
      const body = parseBody(res, contract.TcCheckoutPrintRequest, req.body);
      if (!body) return undefined;
      if ((await enter(req, res)) === null) return undefined;
      const row = await loadRow(req, res);
      if (!row) return undefined;
      const office = req.tcOffice;
      const type = body.templateType;

      const prefill = await store.prefillFor(office);
      const saved = await tenantDb.withTenantDb(req, (pool) => store.rowFor(pool, office, type));
      const template = store.effective(type, saved, prefill);
      const facts = await resolvedFactsOf(row, office);
      const doc = contract.composePrintDocument(template, printValues(facts, template, body));

      let logo = null;
      let logoState = saved && saved.logo_key ? 'included' : 'none';
      if (saved && saved.logo_key) {
        try {
          logo = prepareLogo(await assets.getLogo(saved.logo_key));
        } catch (err) {
          console.error(`[tc/checkout/print] office=${office} logo left off: ${(err && (err.code || err.message)) || err}`);
          logoState = 'omitted';
        }
      }
      // CO-3b: the template's saved styling; NULL (never styled) prints as before.
      const pdf = renderPrintPdf(doc, { logo, styling: saved ? saved.styling ?? null : null });

      // A printout is a disclosure: no trail, no printout.
      try {
        await audit(req, {
          action: 'READ',
          resourceType: 'tc_checkout_print',
          resourceId: String(row.handoff_id),
          result: 'SUCCESS',
          office,
          sourceRef: `template:${type}|patient:${row.od_patient_id}`,
        });
      } catch (err) {
        console.error(`[tc/checkout/print] office=${office} audit write failed; nothing printed: ${(err && err.message) || err}`);
        return res.status(500).json({
          success: false,
          error: 'The print could not be recorded in the audit trail, so nothing was printed. Try again in a minute.',
          code: 'PRINT_AUDIT_FAILED',
        });
      }

      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `inline; filename="${type}.pdf"`);
      res.set('Cache-Control', 'private, no-store');
      res.set('X-Print-Logo', logoState);
      return res.send(pdf);
    })
  );
}

module.exports = { mount, factsOf, resolvedFactsOf, printValues };

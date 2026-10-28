'use strict';

/**
 * /api/tc/referrals — referral foundations (queue item 52, R1).
 *
 *   GET    /status                is referrals on for this office? (never refused)
 *   GET    /directory             the office's specialists (?includeInactive=true)
 *   POST   /directory             add one
 *   PUT    /directory/:id         edit one (including active / inactive)
 *   DELETE /directory/:id         remove one that no referral names (else 409)
 *   GET    /settings              the two policies, what is in force and why
 *   PUT    /settings              change them — practice admin only
 *
 *   R2 (item 53) — the referral record and its lifecycle:
 *   GET    /                      ?caseId= | ?handoffId= | ?callId= | ?status= , newest first
 *   POST   /                      start one FROM a case or a checkout (draft), or
 *                                 (R6.2) by hand from the hub: { patNum }, re-read
 *                                 from this office's Open Dental (source `manual`)
 *   GET    /:id                   one referral, with its history
 *   PUT    /:id                   edit a draft (only a draft)
 *   POST   /:id/submit            draft → pending_signoff (or → approved when
 *                                 this office does not require sign-off)
 *   POST   /:id/withdraw          pending_signoff → draft
 *   POST   /:id/cancel            draft | pending_signoff → cancelled
 *   Approve / decline live in ./referralSignoff.js, behind tc.referral_signoff.
 *
 *   R6 (item 56) — the hub and staff edits (NOTHING SENDS, still):
 *   GET    /hub                   every referral for the office, ?status= &
 *                                 ?directoryEntryId= & ?sourceKind= & ?minAgeDays=
 *                                 (audited: a list read is a PHI read)
 *   PATCH  /:id/fields            specialist / urgency / reason / teeth, on a
 *                                 draft or one awaiting sign-off; CAS on status
 *   POST   /:id/reopen            approved → pending_signoff, with the edit in
 *                                 the same transaction ("Edit (re-approval needed)")
 *   POST   /:id/mark-sent         approved → sent, with how / where (required)  ┐ human
 *   POST   /:id/mark-acknowledged sent → acknowledged                          │ attestations;
 *   POST   /:id/mark-patient-seen acknowledged → patient_seen                  │ they send
 *   POST   /:id/close             patient_seen → closed                        ┘ nothing
 *
 *   R6.9 — the correspondence log (./referralCorrespondence.js):
 *   POST   /:id/correspondence    staff record a call / email / fax with the
 *                                 specialist or patient; any status but a draft;
 *                                 a history row, never a move; sends nothing
 *
 *   R6.10 — chart notes (./referralChartNotes.js):
 *   POST   /:id/chart-notes       a person writes ONE reached milestone's approved
 *                                 note to the patient's Open Dental chart as a
 *                                 commlog, through the voice module's writer, read
 *                                 back before it is claimed; once per milestone; a
 *                                 history row, never a move. Nothing else here
 *                                 writes to a chart, and nothing calls this but the
 *                                 click.
 *
 *   R5 — email (./referralSend.js), dark unless tc_referral_email_enabled:
 *   POST   /:id/send-email        approved → sent, ONLY after ACS accepted
 *                                 the email; a failure leaves it approved
 *
 *   R4 (item 55) — attachments (./referralAttachments.js):
 *   POST   /:id/attachments       one image or PDF (multipart "file"), ≤10 MB, ≤5
 *                                  (R6.9a: also once sent / acknowledged /
 *                                  patient seen, for what the specialist sends back)
 *   GET    /:id/attachments       the referral's files (metadata)
 *   GET    /:id/attachments/:aid  the bytes — audited on every view
 *
 * GUARDRAILS
 *   - DARK. `tc_referrals_enabled` off for the office → 403 REFERRALS_DISABLED
 *     on everything but /status, which answers `enabled: false` so the
 *     Settings page can hide the section without treating "off" as an error.
 *   - SENDING IS ONE ROUTE. Only POST /:id/send-email (and the auto-send after a
 *     doctor's approval) emails anything, through ./referralSend.js. No fax.
 *   - ONE CHART WRITE, BY HAND. The only Open Dental write is POST
 *     /:id/chart-notes (R6.10), a person's click on text they have seen.
 *   - THE PATIENT IS NEVER FROM THE REQUEST. office + PatNum + name come from
 *     the case or checkout the referral is started from, read office-scoped.
 *   - Office from `?office=` through requireOffice, in every WHERE. A body can
 *     never name an office or an entry's owner.
 *   - Every change is audited (append-only audit_log) after it persisted, and
 *     every answer is the row the database returned.
 */

const express = require('express');

const { contract, requireOffice, actorEmail, parseBody, h, auditTc } = require('./helpers');
const tenantDb = require('../../platform/tenantDb');
const { holdsPermission } = require('../../config/permissions');
const tcReferrals = require('../../config/tcReferrals');
const store = require('./referralStore');
const checkoutStore = require('./checkoutStore');
const { withTenantTx } = require('./tx');
const transitions = require('./referralTransitions');
const { createDraft, directoryProblem } = require('./referralCreate');
const attachments = require('./referralAttachments');
const referralSend = require('./referralSend');
const correspondence = require('./referralCorrespondence');
const chartNotes = require('./referralChartNotes');
const odOffices = require('../../config/odOffices');
const odReads = require('./odReads');

const {
  z,
  TcReferralDirectoryInput,
  TcReferralSettingsRequest,
  TcReferralCreateRequest,
  TcReferralInput,
  TcReferralStatus,
  TcReferralHubQuery,
  TcReferralFieldsEdit,
  TcReferralReopenRequest,
  TcReferralMarkSentRequest,
  TcReferralMarkRequest,
  TcReferralSendRequest,
  TcReferralCorrespondenceRequest,
  TcReferralChartNoteRequest,
} = contract;

const router = express.Router();
router.use(requireOffice);

const EntryId = z.string().uuid();

/** Postgres foreign-key violation (a referral named the entry in between). */
const PG_FK_VIOLATION = '23503';

router.get(
  '/status',
  h(async (req, res) => {
    const office = req.tcOffice;
    const enabled = await tcReferrals.isEnabled(office);
    // R5: referral email's own switch, and why an office with it on cannot
    // send yet. Only said when referrals itself is on; off answers as before.
    if (!enabled) return res.json({ success: true, office, enabled });
    return res.json({ success: true, office, enabled, emailSend: await referralSend.emailSendStatus(office) });
  })
);

// Everything below is dark until the office is switched on.
// (Plain middleware, not h(): h() does not pass `next`.)
router.use(async (req, res, next) => {
  try {
    if (await tcReferrals.isEnabled(req.tcOffice)) return next();
    return res.status(403).json({
      success: false,
      error: 'Referrals are not switched on for this office.',
      code: 'REFERRALS_DISABLED',
    });
  } catch (err) {
    return next(err);
  }
});

function badId(res) {
  return res.status(400).json({ success: false, error: 'Invalid directory entry id', code: 'INVALID_ID' });
}

function notFound(res) {
  return res.status(404).json({ success: false, error: 'Directory entry not found', code: 'NOT_FOUND' });
}

// ── The directory ───────────────────────────────────────────────────────────

router.get(
  '/directory',
  h(async (req, res) => {
    const includeInactive = String(req.query.includeInactive || '') === 'true';
    const rows = await tenantDb.withTenantDb(req, (pool) =>
      store.listDirectory(pool, req.tcOffice, { includeInactive })
    );
    res.json({ success: true, entries: rows.map(store.toEntry) });
  })
);

router.post(
  '/directory',
  h(async (req, res) => {
    const input = parseBody(res, TcReferralDirectoryInput, req.body);
    if (!input) return undefined;
    const row = await tenantDb.withTenantDb(req, (pool) =>
      store.insertEntry(pool, req.tcOffice, input, actorEmail(req))
    );
    if (!row) throw new Error('directory entry was not stored');
    await auditTc(req, 'CREATE', 'tc_referral_directory', String(row.entry_id), { office: req.tcOffice });
    return res.status(201).json({ success: true, entry: store.toEntry(row) });
  })
);

router.put(
  '/directory/:id',
  h(async (req, res) => {
    const id = EntryId.safeParse(req.params.id);
    if (!id.success) return badId(res);
    const input = parseBody(res, TcReferralDirectoryInput, req.body);
    if (!input) return undefined;
    const office = req.tcOffice;
    const result = await tenantDb.withTenantDb(req, async (pool) => {
      const before = await store.findEntry(pool, office, id.data);
      if (!before) return null;
      const after = await store.updateEntry(pool, office, id.data, input, actorEmail(req));
      return after ? { before, after } : null;
    });
    if (!result) return notFound(res);
    await auditTc(req, 'UPDATE', 'tc_referral_directory', id.data, {
      office,
      priorState: result.before.active ? 'active' : 'inactive',
    });
    return res.json({ success: true, entry: store.toEntry(result.after) });
  })
);

router.delete(
  '/directory/:id',
  h(async (req, res) => {
    const id = EntryId.safeParse(req.params.id);
    if (!id.success) return badId(res);
    const office = req.tcOffice;
    let result;
    try {
      result = await tenantDb.withTenantDb(req, async (pool) => {
        const before = await store.findEntry(pool, office, id.data);
        if (!before) return { missing: true };
        if (await store.entryInUse(pool, office, id.data)) return { inUse: true };
        const removed = await store.deleteEntry(pool, office, id.data);
        return removed ? { removed } : { missing: true };
      });
    } catch (err) {
      if (err && err.code === PG_FK_VIOLATION) result = { inUse: true };
      else throw err;
    }
    if (result.missing) return notFound(res);
    if (result.inUse) {
      return res.status(409).json({
        success: false,
        error: 'A referral names this specialist, so it cannot be deleted. Mark it inactive instead.',
        code: 'DIRECTORY_ENTRY_IN_USE',
      });
    }
    await auditTc(req, 'DELETE', 'tc_referral_directory', id.data, {
      office,
      priorState: result.removed.active ? 'active' : 'inactive',
    });
    return res.json({ success: true });
  })
);

// ── Settings ────────────────────────────────────────────────────────────────

async function settingsPayload(req) {
  const office = req.tcOffice;
  const row = await tenantDb.withTenantDb(req, (pool) => store.readSettingsRow(pool, office));
  const policies = store.resolvePolicies(office, row);
  return {
    success: true,
    office,
    signoffRequired: policies.signoffRequired,
    autosendOnApproval: policies.autosendOnApproval,
    canEdit: holdsPermission(req, 'admin.all'),
    updatedBy: row ? row.updated_by : null,
    updatedAt: row && row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

/** `signoff_on:autosend_off` — a slug inside audit_log's prior_state grammar. */
function settingsSlug(p) {
  return `signoff_${p.signoffRequired.value ? 'on' : 'off'}:autosend_${p.autosendOnApproval.value ? 'on' : 'off'}`;
}

router.get(
  '/settings',
  h(async (req, res) => {
    res.json(await settingsPayload(req));
  })
);

router.put(
  '/settings',
  h(async (req, res) => {
    if (!holdsPermission(req, 'admin.all')) {
      return res.status(403).json({
        success: false,
        error: 'Only a practice admin can change the referral settings.',
        code: 'FORBIDDEN',
      });
    }
    const body = parseBody(res, TcReferralSettingsRequest, req.body);
    if (!body) return undefined;
    const office = req.tcOffice;
    const before = await tenantDb.withTenantDb(req, async (pool) => {
      const row = await store.readSettingsRow(pool, office);
      // Store the OFFICE's choice: what it already chose (or the defaults),
      // with this request's changes on top. An env pin still wins on read.
      const stored = {
        signoffRequired: row ? row.signoff_required : store.POLICIES.signoffRequired.defaultValue,
        autosendOnApproval: row ? row.autosend_on_approval : store.POLICIES.autosendOnApproval.defaultValue,
      };
      const next = {
        signoffRequired: body.signoffRequired ?? stored.signoffRequired,
        autosendOnApproval: body.autosendOnApproval ?? stored.autosendOnApproval,
      };
      // Item 53 (carried from R1's review): auto-send with sign-off OFF would
      // send a referral no doctor ever read the moment it is submitted. That
      // pair is refused, not stored; sign-off back ON, or auto-send OFF.
      if (!next.signoffRequired && next.autosendOnApproval) return { unsafe: true };
      const written = await store.upsertSettings(pool, office, next, actorEmail(req));
      if (!written) throw new Error('referral settings were not stored');
      return store.resolvePolicies(office, row);
    });
    if (before.unsafe) {
      return res.status(409).json({
        success: false,
        error:
          'Auto-send needs the doctor\'s sign-off: with sign-off off, a referral would go out before any doctor read it. Turn sign-off on, or auto-send off.',
        code: 'REFERRAL_POLICY_UNSAFE',
      });
    }
    await auditTc(req, 'UPDATE', 'tc_referral_settings', office, { office, priorState: settingsSlug(before) });
    res.json(await settingsPayload(req));
  })
);

// ── R2: the referral record ─────────────────────────────────────────────────

const ReferralId = z.string().uuid();

function badReferralId(res) {
  return res.status(400).json({ success: false, error: 'Invalid referral id', code: 'INVALID_ID' });
}

/**
 * Rows → TcReferral[] with practice names and, for a draft the doctor sent
 * back, the open question (R6). A few extra queries, no JOIN.
 */
async function present(pool, office, rows, { withAttachmentCounts = false } = {}) {
  const names = await store.practiceNames(pool, office, rows);
  const returns = await store.openReturns(pool, office, rows);
  // R5: the Send button's two inputs, for the approved ones.
  const emails = await store.directoryEmails(pool, office, rows);
  const problems = await store.openSendProblems(pool, office, rows);
  // The responses the cards show without opening one: received, and the
  // patient email's outcome (read only; scheduledDate is already on the row).
  const responses = await store.responseSignals(pool, office, rows);
  const counts = withAttachmentCounts
    ? await store.attachmentCounts(pool, office, rows.map((r) => r.referral_id))
    : null;
  return rows.map((r) => {
    const out = store.toReferral(r, names.get(String(r.directory_entry_id)) ?? null);
    out.returned = returns.get(String(r.referral_id)) ?? null;
    out.specialistEmail = emails.get(String(r.directory_entry_id)) ?? null;
    out.sendProblem = problems.get(String(r.referral_id)) ?? null;
    const response = responses.get(String(r.referral_id));
    out.received = response ? response.received : null;
    out.patientEmail = response ? response.patientEmail : null;
    // R6.9: the card's "Last contact" line, from the same query.
    out.lastCorrespondence = response ? response.lastCorrespondence : null;
    if (counts) out.attachmentCount = counts.get(String(r.referral_id)) ?? 0;
    return out;
  });
}

router.get(
  '/',
  h(async (req, res) => {
    const office = req.tcOffice;
    const caseId = req.query.caseId ? ReferralId.safeParse(req.query.caseId) : null;
    const handoffId = req.query.handoffId ? ReferralId.safeParse(req.query.handoffId) : null;
    const status = req.query.status ? TcReferralStatus.safeParse(req.query.status) : null;
    // R3 (item 54): the referrals started from one call. A call id is not a
    // uuid (Mango and Retell ids differ), so it is a bounded opaque string.
    const callId = req.query.callId ? z.string().min(1).max(200).safeParse(String(req.query.callId)) : null;
    if (
      (caseId && !caseId.success) ||
      (handoffId && !handoffId.success) ||
      (status && !status.success) ||
      (callId && !callId.success)
    ) {
      return res.status(400).json({ success: false, error: 'Invalid filter', code: 'INVALID_FILTER' });
    }
    const referrals = await tenantDb.withTenantDb(req, async (pool) => {
      const rows = await store.listReferrals(pool, office, {
        caseId: caseId ? caseId.data : null,
        sourceKind: handoffId ? 'checkout' : callId ? 'call' : null,
        sourceRef: handoffId ? handoffId.data : callId ? callId.data : null,
        status: status ? status.data : null,
      });
      return present(pool, office, rows);
    });
    await auditTc(req, 'READ', 'tc_referral', null, { office });
    return res.json({ success: true, referrals });
  })
);

/**
 * R6.2: the patient of a referral started by hand, read from THIS office's
 * Open Dental (read only), before any transaction opens. The PatNum in the
 * body says only WHICH patient; existence and the name come from Open Dental,
 * through the office's own client (never another practice's: PatNum numbering
 * restarts in every database). Returns { patient } or { refusal }.
 */
async function manualPatient(office, patNum) {
  let od;
  try {
    od = odOffices.assertOfficeMatch(office, odOffices.getOdOffice(office));
  } catch (err) {
    return { refusal: [503, err.publicMessage || 'Open Dental is not connected for this office', 'OFFICE_NOT_CONNECTED'] };
  }
  const odGet = (path, params, opts) => od.client.apiGetRaw(path, params, { ...(opts || {}), module: 'tc' });
  let found;
  try {
    found = await odReads.getPatient(odGet, patNum);
  } catch {
    console.error(`[tc/referrals] office=${office} manual start: patient read failed`);
    return { refusal: [502, 'Could not read that patient from Open Dental. Nothing was saved.', 'OD_READ_FAILED'] };
  }
  if (!found.patient || odReads.EXCLUDED_PAT_STATUS.has(found.patient.status)) {
    return { refusal: [404, "That patient is not in this office's Open Dental", 'PATIENT_NOT_FOUND'] };
  }
  return {
    patient: {
      odPatientId: found.patient.patNum,
      patientName: found.patient.displayName,
      tcCaseId: null,
      sourceKind: 'manual',
      sourceRef: '',
    },
  };
}

router.post(
  '/',
  h(async (req, res) => {
    const body = parseBody(res, TcReferralCreateRequest, req.body);
    if (!body) return undefined;
    const office = req.tcOffice;
    const at = transitions.clock().toISOString();

    // R6.2: a hand start reads Open Dental first, so no transaction is held
    // open across a network call.
    let manual = null;
    if ('patNum' in body.source) {
      const m = await manualPatient(office, body.source.patNum);
      if (m.refusal) {
        const [status, error, code] = m.refusal;
        return res.status(status).json({ success: false, error, code });
      }
      manual = m.patient;
    }

    const result = await withTenantTx(req, async (client) => {
      // The patient, from the SOURCE, office-scoped. Never from the body.
      let patient;
      if (manual) {
        patient = manual;
      } else if ('caseId' in body.source) {
        const c = await client.query(
          'SELECT case_id, od_patient_id, patient_name FROM tc_cases WHERE office_id = $1 AND case_id = $2',
          [office, body.source.caseId]
        );
        const row = c.rows[0];
        if (!row) return { refusal: [404, 'Case not found', 'NOT_FOUND'] };
        if (row.od_patient_id == null) {
          return { refusal: [409, 'This case is not linked to an Open Dental patient yet', 'CASE_HAS_NO_PATIENT'] };
        }
        patient = {
          odPatientId: Number(row.od_patient_id),
          patientName: row.patient_name,
          tcCaseId: String(row.case_id),
          sourceKind: 'case',
          sourceRef: String(row.case_id),
        };
      } else {
        const h0 = await checkoutStore.findById(client, office, body.source.handoffId);
        if (!h0) return { refusal: [404, 'Checkout not found', 'NOT_FOUND'] };
        patient = {
          odPatientId: Number(h0.od_patient_id),
          patientName: h0.patient_name,
          tcCaseId: h0.case_id ? String(h0.case_id) : null,
          sourceKind: 'checkout',
          sourceRef: String(h0.handoff_id),
        };
      }
      return createDraft(req, client, { office, patient, input: body.referral, at });
    });

    if (result.refusal) {
      const [status, error, code] = result.refusal;
      return res.status(status).json({ success: false, error, code });
    }
    return res.status(201).json({ success: true, referral: await transitions.readBack(req, result.referralId) });
  })
);

// ── R6: the hub ─────────────────────────────────────────────────────────────

router.get(
  '/hub',
  h(async (req, res) => {
    const office = req.tcOffice;
    // `office` is requireOffice's; every OTHER query key must be a known filter.
    const { office: _office, ...filters } = req.query;
    const q = TcReferralHubQuery.safeParse(filters);
    if (!q.success) return res.status(400).json({ success: false, error: 'Invalid filter', code: 'INVALID_FILTER' });
    const before =
      q.data.minAgeDays !== undefined
        ? new Date(transitions.clock().getTime() - q.data.minAgeDays * 86_400_000).toISOString()
        : null;
    const referrals = await tenantDb.withTenantDb(req, async (pool) => {
      const rows = await store.listHub(pool, office, {
        status: q.data.status ?? null,
        directoryEntryId: q.data.directoryEntryId ?? null,
        sourceKind: q.data.sourceKind ?? null,
        before,
      });
      return present(pool, office, rows, { withAttachmentCounts: true });
    });
    // A list of patients is a PHI read: audited like every other list (R4).
    await auditTc(req, 'READ', 'tc_referral', null, { office, sourceRef: 'referral_hub' });
    return res.json({ success: true, referrals });
  })
);

router.get(
  '/:id',
  h(async (req, res) => {
    const id = ReferralId.safeParse(req.params.id);
    if (!id.success) return badReferralId(res);
    const referral = await transitions.readBack(req, id.data);
    if (!referral) return res.status(404).json({ success: false, error: 'Referral not found', code: 'NOT_FOUND' });
    await auditTc(req, 'READ', 'tc_referral', id.data, { office: req.tcOffice });
    return res.json({ success: true, referral });
  })
);

router.put(
  '/:id',
  h(async (req, res) => {
    const id = ReferralId.safeParse(req.params.id);
    if (!id.success) return badReferralId(res);
    const input = parseBody(res, TcReferralInput, req.body);
    if (!input) return undefined;
    const office = req.tcOffice;

    const result = await withTenantTx(req, async (client) => {
      const before = await store.findReferral(client, office, id.data);
      if (!before) return { refusal: [404, 'Referral not found', 'NOT_FOUND'] };
      if (!contract.REFERRAL_EDITABLE_STATUSES.includes(before.status)) {
        return {
          refusal: [409, 'Only a draft can be edited. Withdraw it from sign-off first.', 'REFERRAL_NOT_EDITABLE'],
        };
      }
      const problem = await directoryProblem(client, office, input.directoryEntryId);
      if (problem) return { refusal: problem };
      const after = await store.updateDraft(client, office, id.data, input);
      if (!after) {
        return {
          refusal: [409, 'Only a draft can be edited. Withdraw it from sign-off first.', 'REFERRAL_NOT_EDITABLE'],
        };
      }
      await auditTc(req, 'UPDATE', 'tc_referral', id.data, { office, priorState: 'draft' });
      return { ok: true };
    });
    if (result.refusal) {
      const [status, error, code] = result.refusal;
      return res.status(status).json({ success: false, error, code });
    }
    return res.json({ success: true, referral: await transitions.readBack(req, id.data) });
  })
);

// ── R4: attachments ─────────────────────────────────────────────────────────

const tcAttachmentOpts = { officeOf: (req) => req.tcOffice, referralIdOf: (req) => req.params.id };
// R6.9a: staff may also attach once the referral went out — the specialist's
// returned report or fax. Closed, declined and cancelled stay shut, and so
// does approved (not yet sent). The cap, the bytes rules and no-delete are
// R4's, unchanged. The doctor's sign-off route and hygiene keep R4's window.
const TC_STAFF_ATTACHABLE_STATUSES = Object.freeze([
  ...attachments.ATTACHABLE_STATUSES,
  'sent',
  'acknowledged',
  'patient_seen',
]);
router.post(
  '/:id/attachments',
  attachments.receiveFile,
  h(
    attachments.uploadHandler({
      ...tcAttachmentOpts,
      attachableStatuses: TC_STAFF_ATTACHABLE_STATUSES,
      lockedMessage:
        'Files can be added only while a referral is a draft, awaiting sign-off, sent, acknowledged, or the patient has been seen.',
    })
  )
);
router.get('/:id/attachments', h(attachments.listHandler(tcAttachmentOpts)));
router.get('/:id/attachments/:attachmentId', h(attachments.viewHandler(tcAttachmentOpts)));

// ── R6: staff edits, reopen, and the manual marks ──────────────────────────

router.patch(
  '/:id/fields',
  h(async (req, res) => {
    const id = ReferralId.safeParse(req.params.id);
    if (!id.success) return badReferralId(res);
    const fields = parseBody(res, TcReferralFieldsEdit, req.body);
    if (!fields) return undefined;
    const out = await transitions.editFields(req, { referralId: id.data, fields, kind: 'edit' });
    return res.status(out.status).json(out.body);
  })
);

router.post(
  '/:id/reopen',
  h(async (req, res) => {
    const id = ReferralId.safeParse(req.params.id);
    if (!id.success) return badReferralId(res);
    const body = parseBody(res, TcReferralReopenRequest, req.body ?? {});
    if (!body) return undefined;
    const out = await transitions.reopen(req, { referralId: id.data, fields: body.fields });
    return res.status(out.status).json(out.body);
  })
);

/**
 * The manual marks: what a PERSON says happened outside the app. Each moves
 * one status through the shared table and writes the history line; none of
 * them sends, queues or schedules anything.
 */
const MARKS = [
  { path: 'mark-sent', verb: 'mark_sent', schema: TcReferralMarkSentRequest, note: (b) => `Sent outside the app: ${b.how}` },
  { path: 'mark-acknowledged', verb: 'mark_acknowledged', schema: TcReferralMarkRequest, note: (b) => b.note || '' },
  { path: 'mark-patient-seen', verb: 'mark_patient_seen', schema: TcReferralMarkRequest, note: (b) => b.note || '' },
  { path: 'close', verb: 'close', schema: TcReferralMarkRequest, note: (b) => b.note || '' },
];
for (const mark of MARKS) {
  router.post(
    `/:id/${mark.path}`,
    h(async (req, res) => {
      const id = ReferralId.safeParse(req.params.id);
      if (!id.success) return badReferralId(res);
      const body = parseBody(res, mark.schema, req.body ?? {});
      if (!body) return undefined;
      const out = await transitions.applyVerb(req, { referralId: id.data, verb: mark.verb, note: mark.note(body) });
      return res.status(out.status).json(out.body);
    })
  );
}

// ── R6.9: the correspondence log ────────────────────────────────────────────

/**
 * POST /:id/correspondence — staff record a contact that happened outside the
 * app. A history row, never a move; it sends nothing. Strict body (any extra
 * field — an office, a status, a date — is a 400). See ./referralCorrespondence.js.
 */
router.post(
  '/:id/correspondence',
  h(async (req, res) => {
    const id = ReferralId.safeParse(req.params.id);
    if (!id.success) return badReferralId(res);
    const body = parseBody(res, TcReferralCorrespondenceRequest, req.body ?? {});
    if (!body) return undefined;
    const out = await correspondence.logCorrespondence(req, { referralId: id.data, body });
    return res.status(out.status).json(out.body);
  })
);

// ── R6.10: chart notes ──────────────────────────────────────────────────────

/**
 * POST /:id/chart-notes — a person writes one milestone's approved note to the
 * patient's Open Dental chart. THE ONLY CALLER of referralChartNotes. Strict
 * body (a PatNum, an office, a type, a date — any extra field is a 400). See
 * ./referralChartNotes.js for the order of everything else.
 */
router.post(
  '/:id/chart-notes',
  h(async (req, res) => {
    const id = ReferralId.safeParse(req.params.id);
    if (!id.success) return badReferralId(res);
    const body = parseBody(res, TcReferralChartNoteRequest, req.body ?? {});
    if (!body) return undefined;
    const out = await chartNotes.writeChartNote(req, { referralId: id.data, body });
    return res.status(out.status).json(out.body);
  })
);

// ── R5: email it to the specialist ──────────────────────────────────────────

/**
 * POST /:id/send-email — no body (strict: any field is a 400). The office is the
 * request's server-derived one, the recipient the directory row's address;
 * nothing the client sends can change either. Dark (403
 * REFERRAL_EMAIL_DISABLED) unless tc_referral_email_enabled is on for the
 * office. See ./referralSend.js for the order of everything else.
 */
router.post(
  '/:id/send-email',
  h(async (req, res) => {
    const id = ReferralId.safeParse(req.params.id);
    if (!id.success) return badReferralId(res);
    const body = parseBody(res, TcReferralSendRequest, req.body ?? {});
    if (!body) return undefined;
    const out = await referralSend.sendReferral(req, { office: req.tcOffice, referralId: id.data, trigger: 'manual' });
    return res.status(out.status).json(out.body);
  })
);

for (const verb of ['submit', 'withdraw', 'cancel']) {
  router.post(
    `/:id/${verb}`,
    h(async (req, res) => {
      const id = ReferralId.safeParse(req.params.id);
      if (!id.success) return badReferralId(res);
      const out = await transitions.applyVerb(req, { referralId: id.data, verb });
      return res.status(out.status).json(out.body);
    })
  );
}

module.exports = router;

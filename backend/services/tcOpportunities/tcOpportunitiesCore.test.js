'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const core = require('./core');
const { odProc } = require('./tcOppsTestUtils');

test('qualifyProcedure: the accept path and each exclusion reason', () => {
  const ok = core.qualifyProcedure(odProc({ procNum: 1, patNum: 12827, fee: '255.00' }), { cutoff: null });
  assert.equal(ok.ok, true);
  assert.equal(ok.procedure.feeCents, 25500);
  assert.equal(ok.procedure.code, 'D2740');
  assert.equal(core.qualifyProcedure(odProc({ procNum: 1, patNum: 12827, status: 'C' }), { cutoff: null }).reason, 'not_tp');
  assert.equal(core.qualifyProcedure(odProc({ procNum: 1, patNum: 12827, status: 'TPi' }), { cutoff: null }).reason, 'not_tp');
  assert.equal(core.qualifyProcedure(odProc({ procNum: 1, patNum: 0 }), { cutoff: null }).reason, 'no_patient');
  assert.equal(core.qualifyProcedure(odProc({ procNum: 1, patNum: 12827, aptNum: 9 }), { cutoff: null }).reason, 'on_appointment');
  assert.equal(core.qualifyProcedure(odProc({ procNum: 1, patNum: 12827, code: 'N4102' }), { cutoff: null }).reason, 'not_billable');
  assert.equal(
    core.qualifyProcedure(odProc({ procNum: 1, patNum: 12827, dateTP: '2020-01-01' }), { cutoff: '2024-10-08' }).reason,
    'too_old'
  );
  const nullDate = core.qualifyProcedure(odProc({ procNum: 1, patNum: 12827, dateTP: '0001-01-01' }), { cutoff: '2024-10-08' });
  assert.equal(nullDate.ok, true, "OD's null date is undated, not ancient");
  assert.equal(nullDate.procedure.plannedDate, null);
});

test('groupByPatient: dedupes ProcNum, sums cents, earliest date', () => {
  const q = (o) => core.qualifyProcedure(odProc(o), { cutoff: null });
  const g = core.groupByPatient(
    [
      q({ procNum: 1, patNum: 12827, fee: '10.10', dateTP: '2026-02-01' }),
      q({ procNum: 1, patNum: 12827, fee: '10.10', dateTP: '2026-02-01' }),
      q({ procNum: 2, patNum: 12827, fee: '0.20', dateTP: '2026-01-01' }),
    ].map((x) => ({ patNum: x.patNum, procedure: x.procedure }))
  );
  const c = g.get(12827);
  assert.equal(c.procedures.length, 2);
  assert.equal(c.valueCents, 1030);
  assert.equal(c.plannedDate, '2026-01-01');
});

test('hasNewProcedure: new ProcNum yes; fee change / removal no', () => {
  const p = (procNum, feeCents) => ({ procNum, feeCents });
  assert.equal(core.hasNewProcedure([p(1, 100)], [p(1, 999)]), false);
  assert.equal(core.hasNewProcedure([p(1, 100), p(2, 100)], [p(1, 100)]), false);
  assert.equal(core.hasNewProcedure([p(1, 100)], [p(1, 100), p(3, 1)]), true);
});

test('planRowChange covers every status', () => {
  const c = { procedures: [{ procNum: 1 }] };
  assert.equal(core.planRowChange({ status: 'new', procedures: [] }, c).op, 'refresh');
  assert.equal(core.planRowChange({ status: 'existing_case', claimed_case_id: null, procedures: [] }, c).op, 'refresh');
  assert.equal(core.planRowChange({ status: 'existing_case', claimed_case_id: 'x', procedures: [] }, c).op, 'touch');
  assert.equal(core.planRowChange({ status: 'claimed', claimed_case_id: 'x', procedures: [] }, c).op, 'touch');
  assert.equal(core.planRowChange({ status: 'dismissed', procedures: [{ procNum: 1 }] }, c).op, 'touch');
  assert.equal(core.planRowChange({ status: 'dismissed', procedures: [] }, c).op, 'resurrect');
  assert.equal(core.planRowChange({ status: 'new', procedures: [] }, null).op, 'clear');
  assert.equal(core.planRowChange({ status: 'new', procedures: [], cleared_at: new Date() }, null).op, 'none');
});

test('planExistingCaseFlips: both directions; a claim-attached row never flips back', () => {
  const flips = core.planExistingCaseFlips(
    [
      { opportunity_id: 'a', od_patient_id: 1, status: 'new' },
      { opportunity_id: 'b', od_patient_id: 2, status: 'existing_case', claimed_case_id: null },
      { opportunity_id: 'c', od_patient_id: 3, status: 'existing_case', claimed_case_id: 'case' },
      { opportunity_id: 'd', od_patient_id: 4, status: 'dismissed' },
    ],
    new Set([1, 4])
  );
  assert.deepEqual(flips, [
    { opportunityId: 'a', from: 'new', to: 'existing_case' },
    { opportunityId: 'b', from: 'existing_case', to: 'new' },
  ]);
});

test('verifyClaimPhases + caseUrgencyFromPhases', () => {
  const snap = [{ procNum: 1, feeCents: 100 }, { procNum: 2, feeCents: 200 }];
  const ph = (items) => [{ items }];
  assert.equal(core.verifyClaimPhases(ph([{ odProcNum: 1, feeCents: 100 }]), snap), null, 'subset ok');
  assert.equal(core.verifyClaimPhases(ph([{ odProcNum: 3, feeCents: 1 }]), snap), 'ITEM_NOT_IN_SNAPSHOT');
  assert.equal(core.verifyClaimPhases(ph([{ odProcNum: null, feeCents: 1 }]), snap), 'ITEM_NOT_IN_SNAPSHOT');
  assert.equal(core.verifyClaimPhases(ph([{ odProcNum: 1, feeCents: 100 }, { odProcNum: 1, feeCents: 100 }]), snap), 'ITEM_DUPLICATED');
  assert.equal(core.verifyClaimPhases(ph([{ odProcNum: 2, feeCents: 1 }]), snap), 'FEE_MISMATCH');
  assert.equal(core.caseUrgencyFromPhases([]), 'medium');
  assert.equal(core.caseUrgencyFromPhases([{ items: [{ urgency: 'elective' }, { urgency: 'low' }] }]), 'low');
  assert.equal(core.caseUrgencyFromPhases([{ items: [{ urgency: 'medium' }] }, { items: [{ urgency: 'high' }] }]), 'high');
});

test('cutoffDate is evaluated in the practice zone', () => {
  // 2026-10-08 03:00Z is still 2026-10-07 in Chicago.
  assert.equal(core.cutoffDate(1, new Date('2026-10-08T03:00:00Z'), 'America/Chicago'), '2026-10-06');
  assert.equal(core.cutoffDate(0, new Date(), 'America/Chicago'), null);
});

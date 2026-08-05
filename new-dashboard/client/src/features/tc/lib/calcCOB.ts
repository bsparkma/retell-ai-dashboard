// Coordination of Benefits (COB) math for dual-insurance patient out-of-pocket.
// Ported VERBATIM from TC-app client/src/lib/calcCOB.ts (tag pre-port) with its
// full regression suite (tests/tc-cob.test.ts, incl. a real Delta-on-Delta EOB
// case). All functions are pure. NOTE: this calculator operates on user-typed
// DOLLAR amounts (a scratchpad, not stored case money); persisted case money is
// integer cents per shared/tc/contract.ts and never flows through here.

export type COBMethod = "full-cob" | "standard" | "non-duplication" | "mob";
export type MobVariant = "carveout" | "coinsurance";

export interface COBPlanInput {
  allowedAmount: number;
  coveragePct: number;
  remainingDeductible: number;
  hasAnnualMax: boolean;
  remainingAnnualMax: number;
  inNetwork: boolean;
}

export interface COBLineItem {
  label: string;
  dentistFee: number;
  primaryAllowed: number;
  primaryCoveragePct: number;
  secondaryAllowed: number;
  secondaryCoveragePct: number;
  contractedFeeOverride?: number;
}

export interface COBInput {
  method: COBMethod;
  mobVariant?: MobVariant;
  secondaryWaivesDeductible: boolean;
  primary: COBPlanInput;
  secondary: COBPlanInput;
  dentistFee?: number;
  contractedFeeOverride?: number;
  lineItems?: COBLineItem[];
}

export interface COBLineResult {
  label: string;
  contractedFee: number;
  primaryPaid: number;
  secondaryPaid: number;
  writeOff: number;
  patientPortion: number;
  sNormal: number;
  notes: string[];
}

export interface COBResult {
  lines: COBLineResult[];
  totalPrimaryPaid: number;
  totalSecondaryPaid: number;
  totalInsurancePaid: number;
  totalWriteOff: number;
  totalPatientPortion: number;
  totalContractedFee: number;
  methodLabel: string;
}

export const COB_METHOD_LABELS: Record<string, string> = {
  "full-cob": "Full COB (to 100%)",
  standard: "Standard (lesser-of)",
  "non-duplication": "Non-duplication",
  "mob-carveout": "MOB · Carve-out (capped)",
  "mob-coinsurance": "MOB · Coinsurance on balance",
};

export function methodLabelFor(method: COBMethod, variant?: MobVariant): string {
  if (method === "mob") return COB_METHOD_LABELS[`mob-${variant ?? "carveout"}`];
  return COB_METHOD_LABELS[method];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function planPays(
  allowed: number,
  coveragePct: number,
  remDeductible: number,
  hasMax: boolean,
  remMax: number,
): { paid: number; deductibleConsumed: number; uncapped: number } {
  const deductibleConsumed = Math.max(0, Math.min(remDeductible, allowed));
  const base = Math.max(0, allowed - deductibleConsumed);
  const uncapped = (coveragePct / 100) * base;
  const paid = hasMax ? Math.min(uncapped, Math.max(0, remMax)) : uncapped;
  return { paid, deductibleConsumed, uncapped };
}

interface RunningPlanState {
  remainingDeductible: number;
  remainingAnnualMax: number;
  hasAnnualMax: boolean;
  inNetwork: boolean;
}

function computeLine(
  item: COBLineItem,
  primaryState: RunningPlanState,
  secondaryState: RunningPlanState,
  method: COBMethod,
  mobVariant: MobVariant | undefined,
  secondaryWaivesDeductible: boolean,
): COBLineResult {
  const notes: string[] = [];

  // A3: secondary-allowed fallback. If secondary allowed is 0/blank, fall back
  // to primary's allowed (common for same-carrier dual coverage like Delta-on-Delta).
  const effectiveSecondaryAllowed = item.secondaryAllowed > 0 ? item.secondaryAllowed : item.primaryAllowed;
  if (item.secondaryAllowed <= 0 && item.primaryAllowed > 0) {
    notes.push("Secondary allowed defaulted to primary's allowed.");
  }

  const primary = planPays(
    item.primaryAllowed,
    item.primaryCoveragePct,
    primaryState.remainingDeductible,
    primaryState.hasAnnualMax,
    primaryState.remainingAnnualMax,
  );
  const primaryPaid = primary.paid;
  if (primaryState.hasAnnualMax && primary.uncapped > primaryPaid + 0.0001) {
    notes.push("Primary's annual max is exhausted on this line.");
  }

  let contractedFee: number;
  if (item.contractedFeeOverride !== undefined && primaryState.inNetwork && secondaryState.inNetwork) {
    contractedFee = item.contractedFeeOverride;
  } else if (primaryState.inNetwork) {
    contractedFee = item.primaryAllowed;
  } else {
    contractedFee = item.dentistFee;
  }

  const writeOff = Math.max(0, item.dentistFee - contractedFee);
  const patientRemainingAfterPrimary = Math.max(0, contractedFee - primaryPaid);

  const secondary = planPays(
    effectiveSecondaryAllowed,
    item.secondaryCoveragePct,
    secondaryState.remainingDeductible,
    secondaryState.hasAnnualMax,
    secondaryState.remainingAnnualMax,
  );
  const sNormal = secondary.paid;

  let rawSecondaryPaid: number;
  switch (method) {
    case "full-cob": {
      // Pay up to 100% of the patient's remaining balance, capped only by the
      // secondary's REMAINING annual max — not by its coinsurance %.
      const secMaxCap = secondaryState.hasAnnualMax
        ? Math.max(0, secondaryState.remainingAnnualMax)
        : Infinity;
      rawSecondaryPaid = Math.min(patientRemainingAfterPrimary, secMaxCap);
      break;
    }
    case "standard":
      rawSecondaryPaid = Math.min(sNormal, patientRemainingAfterPrimary);
      break;
    case "non-duplication":
      rawSecondaryPaid = Math.max(0, sNormal - primaryPaid);
      break;
    case "mob":
      if (mobVariant === "coinsurance") {
        rawSecondaryPaid = Math.min(
          (item.secondaryCoveragePct / 100) * patientRemainingAfterPrimary,
          sNormal,
          patientRemainingAfterPrimary,
        );
      } else {
        rawSecondaryPaid = Math.min(
          Math.max(0, sNormal - primaryPaid),
          patientRemainingAfterPrimary,
        );
      }
      break;
  }

  const dedFloor = secondaryWaivesDeductible ? 0 : secondaryState.remainingDeductible;
  const cap = Math.max(0, patientRemainingAfterPrimary - dedFloor);
  const secondaryPaidPre = clamp(rawSecondaryPaid, 0, cap);

  if (secondaryPaidPre < rawSecondaryPaid && dedFloor > 0) {
    notes.push(`Secondary capped — patient still owes the ${formatDollar(dedFloor)} secondary deductible.`);
  }

  // A5: max-exhausted note when secondary's annual max binds.
  if (
    secondaryState.hasAnnualMax &&
    method === "full-cob" &&
    rawSecondaryPaid + 0.0001 < patientRemainingAfterPrimary
  ) {
    notes.push("Secondary's annual max is exhausted — patient owes the remainder.");
  }

  // A4: round to cents.
  const primaryPaidR = round2(primaryPaid);
  const secondaryPaidR = round2(secondaryPaidPre);
  const writeOffR = round2(writeOff);
  const contractedFeeR = round2(contractedFee);
  const patientPortionR = round2(Math.max(0, contractedFeeR - primaryPaidR - secondaryPaidR));

  // Decrement running plan state (use unrounded values for state continuity).
  primaryState.remainingDeductible = Math.max(0, primaryState.remainingDeductible - primary.deductibleConsumed);
  if (primaryState.hasAnnualMax) {
    primaryState.remainingAnnualMax = Math.max(0, primaryState.remainingAnnualMax - primaryPaid);
  }
  secondaryState.remainingDeductible = Math.max(0, secondaryState.remainingDeductible - secondary.deductibleConsumed);
  if (secondaryState.hasAnnualMax) {
    secondaryState.remainingAnnualMax = Math.max(0, secondaryState.remainingAnnualMax - secondaryPaidPre);
  }

  return {
    label: item.label,
    contractedFee: contractedFeeR,
    primaryPaid: primaryPaidR,
    secondaryPaid: secondaryPaidR,
    writeOff: writeOffR,
    patientPortion: patientPortionR,
    sNormal: round2(sNormal),
    notes,
  };
}

function formatDollar(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

export function calcCOB(input: COBInput): COBResult {
  const items: COBLineItem[] = input.lineItems && input.lineItems.length > 0
    ? input.lineItems
    : [{
        label: "Procedure",
        dentistFee: input.dentistFee ?? 0,
        primaryAllowed: input.primary.allowedAmount,
        primaryCoveragePct: input.primary.coveragePct,
        secondaryAllowed: input.secondary.allowedAmount,
        secondaryCoveragePct: input.secondary.coveragePct,
        contractedFeeOverride: input.contractedFeeOverride,
      }];

  const primaryState: RunningPlanState = {
    remainingDeductible: input.primary.remainingDeductible,
    remainingAnnualMax: input.primary.remainingAnnualMax,
    hasAnnualMax: input.primary.hasAnnualMax,
    inNetwork: input.primary.inNetwork,
  };
  const secondaryState: RunningPlanState = {
    remainingDeductible: input.secondary.remainingDeductible,
    remainingAnnualMax: input.secondary.remainingAnnualMax,
    hasAnnualMax: input.secondary.hasAnnualMax,
    inNetwork: input.secondary.inNetwork,
  };

  const lines: COBLineResult[] = [];
  for (const item of items) {
    lines.push(computeLine(item, primaryState, secondaryState, input.method, input.mobVariant, input.secondaryWaivesDeductible));
  }

  const rawTotals = lines.reduce(
    (acc, l) => ({
      totalPrimaryPaid: acc.totalPrimaryPaid + l.primaryPaid,
      totalSecondaryPaid: acc.totalSecondaryPaid + l.secondaryPaid,
      totalInsurancePaid: acc.totalInsurancePaid + l.primaryPaid + l.secondaryPaid,
      totalWriteOff: acc.totalWriteOff + l.writeOff,
      totalPatientPortion: acc.totalPatientPortion + l.patientPortion,
      totalContractedFee: acc.totalContractedFee + l.contractedFee,
    }),
    { totalPrimaryPaid: 0, totalSecondaryPaid: 0, totalInsurancePaid: 0, totalWriteOff: 0, totalPatientPortion: 0, totalContractedFee: 0 },
  );

  const totals = {
    totalPrimaryPaid: round2(rawTotals.totalPrimaryPaid),
    totalSecondaryPaid: round2(rawTotals.totalSecondaryPaid),
    totalInsurancePaid: round2(rawTotals.totalInsurancePaid),
    totalWriteOff: round2(rawTotals.totalWriteOff),
    totalPatientPortion: round2(rawTotals.totalPatientPortion),
    totalContractedFee: round2(rawTotals.totalContractedFee),
  };

  return {
    lines,
    ...totals,
    methodLabel: methodLabelFor(input.method, input.mobVariant),
  };
}

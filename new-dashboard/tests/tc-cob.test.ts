import { describe, expect, it } from "vitest";
import { calcCOB, type COBInput, type COBMethod, type MobVariant } from "../client/src/features/tc/lib/calcCOB";

function setupA(method: COBMethod, mobVariant?: MobVariant, secondaryWaivesDeductible = false): COBInput {
  return {
    method,
    mobVariant,
    secondaryWaivesDeductible,
    primary: {
      allowedAmount: 1000,
      coveragePct: 50,
      remainingDeductible: 0,
      hasAnnualMax: false,
      remainingAnnualMax: 0,
      inNetwork: true,
    },
    secondary: {
      allowedAmount: 1100,
      coveragePct: 60,
      remainingDeductible: 50,
      hasAnnualMax: false,
      remainingAnnualMax: 0,
      inNetwork: false,
    },
    dentistFee: 1300,
  };
}

function setupB(method: COBMethod): COBInput {
  return {
    method,
    secondaryWaivesDeductible: false,
    primary: {
      allowedAmount: 1000,
      coveragePct: 50,
      remainingDeductible: 0,
      hasAnnualMax: false,
      remainingAnnualMax: 0,
      inNetwork: true,
    },
    secondary: {
      allowedAmount: 1000,
      coveragePct: 50,
      remainingDeductible: 0,
      hasAnnualMax: false,
      remainingAnnualMax: 0,
      inNetwork: false,
    },
    dentistFee: 1300,
  };
}

describe("calcCOB — Setup A (fee $1,300; primary 1000@50% in-net, secondary 1100@60% w/ $50 ded)", () => {
  it("standard: secondary capped to $450, patient owes $50", () => {
    const r = calcCOB(setupA("standard"));
    expect(r.totalPrimaryPaid).toBe(500);
    expect(r.totalSecondaryPaid).toBe(450);
    expect(r.totalWriteOff).toBe(300);
    expect(r.totalContractedFee).toBe(1000);
    expect(r.totalPatientPortion).toBe(50);
    expect(r.lines[0].notes.join(" ")).toMatch(/secondary deductible/i);
  });

  it("non-duplication: secondary pays $130, patient owes $370", () => {
    const r = calcCOB(setupA("non-duplication"));
    expect(r.totalPrimaryPaid).toBe(500);
    expect(r.totalSecondaryPaid).toBe(130);
    expect(r.totalPatientPortion).toBe(370);
  });

  it("mob/carveout: secondary pays $130, patient owes $370", () => {
    const r = calcCOB(setupA("mob", "carveout"));
    expect(r.totalPrimaryPaid).toBe(500);
    expect(r.totalSecondaryPaid).toBe(130);
    expect(r.totalPatientPortion).toBe(370);
  });

  it("mob/coinsurance: secondary pays $300, patient owes $200", () => {
    const r = calcCOB(setupA("mob", "coinsurance"));
    expect(r.totalPrimaryPaid).toBe(500);
    expect(r.totalSecondaryPaid).toBe(300);
    expect(r.totalPatientPortion).toBe(200);
  });

  it("waives-deductible toggle on Standard flips patient out-of-pocket to $0", () => {
    const r = calcCOB(setupA("standard", undefined, true));
    expect(r.totalSecondaryPaid).toBe(500);
    expect(r.totalPatientPortion).toBe(0);
  });
});

describe("calcCOB — Setup A under full-cob (the default method)", () => {
  it("secondary pays the full remaining balance minus the deductible floor", () => {
    // Remaining after primary = $500; no secondary annual max (unlimited cap);
    // dedFloor $50 → secondary $450, patient keeps owing the $50 deductible.
    const r = calcCOB(setupA("full-cob"));
    expect(r.totalPrimaryPaid).toBe(500);
    expect(r.totalSecondaryPaid).toBe(450);
    expect(r.totalPatientPortion).toBe(50);
  });

  it("waives-deductible toggle brings the patient to $0 under full-cob", () => {
    const r = calcCOB(setupA("full-cob", undefined, true));
    expect(r.totalSecondaryPaid).toBe(500);
    expect(r.totalPatientPortion).toBe(0);
  });
});

describe("calcCOB — Setup B (no secondary deductible)", () => {
  it("standard with $0 ded: secondary pays $500, patient owes $0", () => {
    const r = calcCOB(setupB("standard"));
    expect(r.totalPrimaryPaid).toBe(500);
    expect(r.totalSecondaryPaid).toBe(500);
    expect(r.totalPatientPortion).toBe(0);
  });

  it("non-duplication with $0 ded: secondary pays $0, patient owes $500", () => {
    const r = calcCOB(setupB("non-duplication"));
    expect(r.totalPrimaryPaid).toBe(500);
    expect(r.totalSecondaryPaid).toBe(0);
    expect(r.totalPatientPortion).toBe(500);
  });
});

describe("calcCOB — full-plan mode draws down deductible + annual max across items", () => {
  it("primary deductible is consumed by item #1 and gone for item #2", () => {
    const input: COBInput = {
      method: "standard",
      secondaryWaivesDeductible: false,
      primary: {
        allowedAmount: 0,
        coveragePct: 0,
        remainingDeductible: 50,
        hasAnnualMax: true,
        remainingAnnualMax: 1000,
        inNetwork: true,
      },
      secondary: {
        allowedAmount: 0,
        coveragePct: 0,
        remainingDeductible: 0,
        hasAnnualMax: false,
        remainingAnnualMax: 0,
        inNetwork: false,
      },
      lineItems: [
        { label: "Filling", dentistFee: 200, primaryAllowed: 150, primaryCoveragePct: 80, secondaryAllowed: 0, secondaryCoveragePct: 0 },
        { label: "Crown",   dentistFee: 1400, primaryAllowed: 1000, primaryCoveragePct: 50, secondaryAllowed: 0, secondaryCoveragePct: 0 },
      ],
    };
    const r = calcCOB(input);
    // Item 1: deductible 50 eaten, 0.8 * (150-50) = 80 primary paid
    expect(r.lines[0].primaryPaid).toBe(80);
    // Item 2: deductible gone, 0.5 * 1000 = 500 primary paid (max 1000 - 80 = 920 left, fits)
    expect(r.lines[1].primaryPaid).toBe(500);
  });

  it("primary annual max caps total paid across items", () => {
    const input: COBInput = {
      method: "standard",
      secondaryWaivesDeductible: false,
      primary: {
        allowedAmount: 0,
        coveragePct: 0,
        remainingDeductible: 0,
        hasAnnualMax: true,
        remainingAnnualMax: 600,
        inNetwork: true,
      },
      secondary: {
        allowedAmount: 0,
        coveragePct: 0,
        remainingDeductible: 0,
        hasAnnualMax: false,
        remainingAnnualMax: 0,
        inNetwork: false,
      },
      lineItems: [
        { label: "Crown A", dentistFee: 1300, primaryAllowed: 1000, primaryCoveragePct: 50, secondaryAllowed: 0, secondaryCoveragePct: 0 },
        { label: "Crown B", dentistFee: 1300, primaryAllowed: 1000, primaryCoveragePct: 50, secondaryAllowed: 0, secondaryCoveragePct: 0 },
      ],
    };
    const r = calcCOB(input);
    // Item 1: 0.5*1000 = 500, but capped at remMax 600 → 500. remMax now 100.
    expect(r.lines[0].primaryPaid).toBe(500);
    // Item 2: raw 500 but only 100 left of max → 100.
    expect(r.lines[1].primaryPaid).toBe(100);
    expect(r.totalPrimaryPaid).toBe(600);
  });
});

describe("calcCOB — secondary-allowed fallback (A3) and rounding (A4)", () => {
  it("blank secondary allowed falls back to primary's allowed, with a note", () => {
    const input: COBInput = {
      method: "standard",
      secondaryWaivesDeductible: false,
      primary: {
        allowedAmount: 1000, coveragePct: 50, remainingDeductible: 0,
        hasAnnualMax: false, remainingAnnualMax: 0, inNetwork: true,
      },
      secondary: {
        allowedAmount: 0, coveragePct: 50, remainingDeductible: 0,
        hasAnnualMax: false, remainingAnnualMax: 0, inNetwork: false,
      },
      dentistFee: 1300,
    };
    const r = calcCOB(input);
    // sNormal = 0.5 × 1000 (primary's allowed) = 500 → standard pays 500, patient $0
    expect(r.lines[0].sNormal).toBe(500);
    expect(r.totalSecondaryPaid).toBe(500);
    expect(r.totalPatientPortion).toBe(0);
    expect(r.lines[0].notes.join(" ")).toMatch(/defaulted to primary/i);
  });

  it("per-line amounts are rounded to cents", () => {
    const input: COBInput = {
      method: "standard",
      secondaryWaivesDeductible: false,
      primary: {
        allowedAmount: 100.10, coveragePct: 33, remainingDeductible: 0,
        hasAnnualMax: false, remainingAnnualMax: 0, inNetwork: true,
      },
      secondary: {
        allowedAmount: 0, coveragePct: 0, remainingDeductible: 0,
        hasAnnualMax: false, remainingAnnualMax: 0, inNetwork: false,
      },
      dentistFee: 150,
    };
    const r = calcCOB(input);
    // 0.33 × 100.10 = 33.033 → 33.03, patient 100.10 − 33.03 = 67.07
    expect(r.lines[0].primaryPaid).toBe(33.03);
    expect(r.lines[0].patientPortion).toBe(67.07);
  });
});

describe("calcCOB — secondary deductible draws down across line items", () => {
  it("secondary deductible is consumed by item #1 and gone for item #2", () => {
    const input: COBInput = {
      method: "standard",
      secondaryWaivesDeductible: true, // isolate the deductible-drawdown math from the floor
      primary: {
        allowedAmount: 0, coveragePct: 0, remainingDeductible: 0,
        hasAnnualMax: false, remainingAnnualMax: 0, inNetwork: true,
      },
      secondary: {
        allowedAmount: 0, coveragePct: 0, remainingDeductible: 60,
        hasAnnualMax: false, remainingAnnualMax: 0, inNetwork: false,
      },
      lineItems: [
        // Primary covers 0% so the secondary faces the full contracted fee each line.
        { label: "Item 1", dentistFee: 100, primaryAllowed: 100, primaryCoveragePct: 0, secondaryAllowed: 100, secondaryCoveragePct: 50 },
        { label: "Item 2", dentistFee: 200, primaryAllowed: 200, primaryCoveragePct: 0, secondaryAllowed: 200, secondaryCoveragePct: 50 },
      ],
    };
    const r = calcCOB(input);
    // Item 1: ded 60 eaten → 0.5 × (100 − 60) = 20
    expect(r.lines[0].secondaryPaid).toBe(20);
    // Item 2: ded gone → 0.5 × 200 = 100
    expect(r.lines[1].secondaryPaid).toBe(100);
  });
});

describe("calcCOB — Delta-on-Delta regression (full-cob method)", () => {
  it("reproduces the real EOB: primary $1,275, secondary $950, patient $311, write-off $1,942.55", () => {
    const input: COBInput = {
      method: "full-cob",
      secondaryWaivesDeductible: false,
      primary: {
        allowedAmount: 0, coveragePct: 0,
        remainingDeductible: 50,
        hasAnnualMax: true, remainingAnnualMax: 2000,
        inNetwork: true,
      },
      secondary: {
        allowedAmount: 0, coveragePct: 0,
        remainingDeductible: 0,
        hasAnnualMax: true, remainingAnnualMax: 950,
        inNetwork: false,
      },
      lineItems: [
        { label: "30 D2740 crown",  dentistFee: 1241.00, primaryAllowed: 765.00, primaryCoveragePct: 50, secondaryAllowed: 765.00, secondaryCoveragePct: 50 },
        { label: "30 D2950 bu",     dentistFee:  299.00, primaryAllowed: 130.00, primaryCoveragePct: 50, secondaryAllowed: 130.00, secondaryCoveragePct: 50 },
        { label: "30 D0220 PA",     dentistFee:   34.00, primaryAllowed:  18.00, primaryCoveragePct: 100, secondaryAllowed:  18.00, secondaryCoveragePct: 100 },
        { label: "30 D0230 PA",     dentistFee:   29.00, primaryAllowed:  14.00, primaryCoveragePct: 100, secondaryAllowed:  14.00, secondaryCoveragePct: 100 },
        { label: "30 D3330 endo",   dentistFee: 1272.55, primaryAllowed: 682.00, primaryCoveragePct: 50, secondaryAllowed: 682.00, secondaryCoveragePct: 50 },
        { label: "31 D2740 crown",  dentistFee: 1241.00, primaryAllowed: 765.00, primaryCoveragePct: 50, secondaryAllowed: 765.00, secondaryCoveragePct: 50 },
        { label: "31 D2950 bu",     dentistFee:  299.00, primaryAllowed: 130.00, primaryCoveragePct: 50, secondaryAllowed: 130.00, secondaryCoveragePct: 50 },
        { label: "31 D0220 PA",     dentistFee:   34.00, primaryAllowed:  18.00, primaryCoveragePct: 100, secondaryAllowed:  18.00, secondaryCoveragePct: 100 },
        { label: "31 D0230 PA",     dentistFee:   29.00, primaryAllowed:  14.00, primaryCoveragePct: 100, secondaryAllowed:  14.00, secondaryCoveragePct: 100 },
      ],
    };
    const r = calcCOB(input);
    expect(r.totalPrimaryPaid).toBe(1275);
    expect(r.totalSecondaryPaid).toBe(950);
    expect(r.totalPatientPortion).toBe(311);
    expect(r.totalWriteOff).toBe(1942.55);
  });
});

describe("calcCOB — contracted-fee override applies only when both plans in-network", () => {
  it("uses override when both plans are in-network", () => {
    const input: COBInput = {
      method: "standard",
      secondaryWaivesDeductible: false,
      primary: {
        allowedAmount: 1000, coveragePct: 50, remainingDeductible: 0,
        hasAnnualMax: false, remainingAnnualMax: 0, inNetwork: true,
      },
      secondary: {
        allowedAmount: 900, coveragePct: 50, remainingDeductible: 0,
        hasAnnualMax: false, remainingAnnualMax: 0, inNetwork: true,
      },
      dentistFee: 1300,
      contractedFeeOverride: 850,
    };
    const r = calcCOB(input);
    expect(r.totalContractedFee).toBe(850);
    expect(r.totalWriteOff).toBe(450);
  });

  it("ignores override when secondary is out-of-network (uses primary allowed)", () => {
    const input: COBInput = {
      method: "standard",
      secondaryWaivesDeductible: false,
      primary: {
        allowedAmount: 1000, coveragePct: 50, remainingDeductible: 0,
        hasAnnualMax: false, remainingAnnualMax: 0, inNetwork: true,
      },
      secondary: {
        allowedAmount: 900, coveragePct: 50, remainingDeductible: 0,
        hasAnnualMax: false, remainingAnnualMax: 0, inNetwork: false,
      },
      dentistFee: 1300,
      contractedFeeOverride: 850,
    };
    const r = calcCOB(input);
    expect(r.totalContractedFee).toBe(1000);
  });
});

/**
 * THE ORTHO SCREENING'S VOCABULARY AND ITS ONE SUMMARY FUNCTION (queue item 33).
 *
 * Pure: no screen, no network. The labels below are the approved mockup's,
 * copied from the queue file's table — this file is what makes "do not rename,
 * reorder or add options" a red build rather than a review comment.
 *
 *   1  every group's options, exactly, in order; single-pick clears on a
 *      second tap; "None" in After ortho is exclusive.
 *   2  estimated months is multi-select and renders as a range:
 *      18 → `18 mo`, 18+24 → `18–24 mo`, 6+12+36 → `6–36 mo`.
 *   3  a slip saved before the screening existed still parses, and gains
 *      `orthoScreening: null`; a visit payload from an older server parses.
 */
import { describe, expect, it } from "vitest";

import {
  emptyOrthoScreening,
  formatOrthoMonths,
  isOrthoSendable,
  ORTHO_AFTER_OPTIONS,
  ORTHO_ARCH_OPTIONS,
  ORTHO_BENEFIT_OPTIONS,
  ORTHO_CONCERN_OPTIONS,
  ORTHO_CONSULT_OPTIONS,
  ORTHO_DECIDER_OPTIONS,
  ORTHO_INTEREST_OPTIONS,
  ORTHO_LOWER_APPLIANCE_OPTIONS,
  ORTHO_MODALITY_OPTIONS,
  ORTHO_MONTH_OPTIONS,
  ORTHO_MYO_OPTIONS,
  ORTHO_MYO_REASON_OPTIONS,
  ORTHO_PHASE_OPTIONS,
  ORTHO_RECORD_OPTIONS,
  ORTHO_UPPER_APPLIANCE_OPTIONS,
  OrthoScreeningSchema,
  orthoScreeningRows,
  orthoScreeningSummary,
  pickOne,
  toggleAfterOrtho,
  toggleMany,
  type OrthoOption,
  type OrthoScreening,
} from "@shared/hyg/orthoScreening";
import { emptySlip, HygSlipSchema, HygVisitSchema } from "@shared/hyg/contract";
import { TcHygieneIntake } from "@shared/tc/contract";

const labels = (options: readonly OrthoOption[]) => options.map((o) => o.label);

/** The queue file's table, verbatim. */
const TABLE: Array<[string, readonly OrthoOption[], string[]]> = [
  ["Interested?", ORTHO_INTEREST_OPTIONS, ["Yes", "Maybe", "Not now"]],
  ["Who decides?", ORTHO_DECIDER_OPTIONS, ["Patient decides", "Parent decides"]],
  [
    "Concerns",
    ORTHO_CONCERN_OPTIONS,
    [
      "Crowding",
      "Spacing",
      "Overbite",
      "Underbite",
      "Crossbite",
      "Open bite",
      "Protrusion",
      "Midline off",
      "Bite / jaw",
      "Snoring / airway",
    ],
  ],
  ["Which arches?", ORTHO_ARCH_OPTIONS, ["Upper", "Lower", "Comprehensive (both)"]],
  [
    "Aligners or braces?",
    ORTHO_MODALITY_OPTIONS,
    ["Clear aligners", "Traditional braces", "Doctor to decide"],
  ],
  ["Phase (if staged)", ORTHO_PHASE_OPTIONS, ["Phase 1", "Phase 2"]],
  [
    "Upper",
    ORTHO_UPPER_APPLIANCE_OPTIONS,
    ["Expansion / RPE", "NiTi RPE", "MDA", "RMD", "Nance", "Reverse-pull HG"],
  ],
  [
    "Lower",
    ORTHO_LOWER_APPLIANCE_OPTIONS,
    ["Expansion", "Lip bumper", "3D lingual", "FLA", "RMD", "MDA"],
  ],
  ["Myo therapy", ORTHO_MYO_OPTIONS, ["Not needed", "Before", "During", "After"]],
  [
    "Why",
    ORTHO_MYO_REASON_OPTIONS,
    ["Tongue thrust", "Mouth breathing", "Low tongue", "Asymmetry", "Airway"],
  ],
  [
    "After ortho",
    ORTHO_AFTER_OPTIONS,
    [
      "None",
      "Peg laterals",
      "Anterior bonding",
      "Implants",
      "Pontic / Maryland",
      "Smile makeover",
      "FMR",
    ],
  ],
  ["Taken today", ORTHO_RECORD_OPTIONS, ["Photos", "Pano", "Scan", "Ceph"]],
  [
    "Ortho benefit",
    ORTHO_BENEFIT_OPTIONS,
    ["Has ortho benefit", "No ortho benefit", "Not sure, TC will verify"],
  ],
  ["Consult", ORTHO_CONSULT_OPTIONS, ["In-office consult", "Phone consult", "TC to call"]],
];

describe("1: the vocabularies are the approved labels, exactly, in order", () => {
  it.each(TABLE)("%s", (_question, options, expected) => {
    expect(labels(options)).toEqual(expected);
    // Ids are unique within a group, so a stored pick is never ambiguous.
    expect(new Set(options.map((o) => o.id)).size).toBe(options.length);
  });

  it("Estimated months: 6 · 9 · 12 · 15 · 18 · 21 · 24 · 30 · 36", () => {
    expect([...ORTHO_MONTH_OPTIONS]).toEqual([6, 9, 12, 15, 18, 21, 24, 30, 36]);
  });
});

describe("1: chip rules", () => {
  it("a single-pick group clears when the picked chip is tapped again", () => {
    expect(pickOne(null, "yes")).toBe("yes");
    expect(pickOne("yes", "maybe")).toBe("maybe");
    expect(pickOne("maybe", "maybe")).toBeNull();
  });

  it("a many-pick group toggles and keeps vocabulary order", () => {
    const order = ORTHO_CONCERN_OPTIONS.map((o) => o.id);
    let picked = toggleMany([], "overbite", order);
    picked = toggleMany(picked, "crowding", order);
    expect(picked).toEqual(["crowding", "overbite"]);
    expect(toggleMany(picked, "crowding", order)).toEqual(["overbite"]);
  });

  it('"None" in After ortho is EXCLUSIVE, both ways', () => {
    let picked = toggleAfterOrtho([], "implants");
    picked = toggleAfterOrtho(picked, "fmr");
    expect(picked).toEqual(["implants", "fmr"]);
    // Picking None clears the rest…
    picked = toggleAfterOrtho(picked, "none");
    expect(picked).toEqual(["none"]);
    // …picking anything else clears None…
    expect(toggleAfterOrtho(picked, "peg_laterals")).toEqual(["peg_laterals"]);
    // …and None again un-picks itself.
    expect(toggleAfterOrtho(["none"], "none")).toEqual([]);
  });

  it("the schema refuses None with anything else, so a bad client cannot store it", () => {
    const bad = { ...emptyOrthoScreening(), afterOrtho: ["none", "implants"] };
    expect(OrthoScreeningSchema.safeParse(bad).success).toBe(false);
    expect(
      OrthoScreeningSchema.safeParse({ ...emptyOrthoScreening(), afterOrtho: ["none"] }).success,
    ).toBe(true);
  });
});

describe("2: estimated months render as a range", () => {
  it("one month → `18 mo`", () => {
    expect(formatOrthoMonths([18])).toBe("18 mo");
  });
  it("18 and 24 → `18–24 mo` (an en dash)", () => {
    expect(formatOrthoMonths([18, 24])).toBe("18–24 mo");
    expect(formatOrthoMonths([24, 18])).toBe("18–24 mo");
  });
  it("6, 12 and 36 → `6–36 mo`", () => {
    expect(formatOrthoMonths([6, 12, 36])).toBe("6–36 mo");
  });
  it("none → nothing", () => {
    expect(formatOrthoMonths([])).toBe("");
  });
  it("is multi-select in the schema, and only from the list", () => {
    const ok = OrthoScreeningSchema.safeParse({ ...emptyOrthoScreening(), months: [6, 12, 36] });
    expect(ok.success).toBe(true);
    expect(
      OrthoScreeningSchema.safeParse({ ...emptyOrthoScreening(), months: [7] }).success,
    ).toBe(false);
    expect(
      OrthoScreeningSchema.safeParse({ ...emptyOrthoScreening(), months: [18, 18] }).success,
    ).toBe(false);
  });
  it("the summary line carries the range", () => {
    const s: OrthoScreening = { ...emptyOrthoScreening(), interest: "yes", months: [18, 24] };
    expect(orthoScreeningSummary(s)).toBe("Interested: Yes · 18–24 mo");
  });
});

describe("the ONE summary function", () => {
  const full: OrthoScreening = {
    ...emptyOrthoScreening(),
    interest: "yes",
    decider: "parent",
    concerns: ["crowding", "overbite"],
    arches: "comprehensive",
    modality: "aligners",
    months: [18, 24],
    phase: "phase_1",
    upperAppliances: ["niti_rpe"],
    lowerAppliances: ["lip_bumper"],
    myo: "before",
    myoReasons: ["tongue_thrust"],
    afterOrtho: ["anterior_bonding"],
    afterOrthoTeeth: "#7, #10",
    recordsToday: ["photos", "pano"],
    orthoBenefit: "not_sure",
    consult: "phone",
    bookedFor: "2026-09-15",
    noteForTc: "kept out of the line",
  };

  it("reads every answered part, in sheet order, and leaves the note out", () => {
    expect(orthoScreeningSummary(full)).toBe(
      "Interested: Yes · Parent decides · Crowding, Overbite · Comprehensive (both) · " +
        "Clear aligners · 18–24 mo · Phase 1 · Upper: NiTi RPE · Lower: Lip bumper · " +
        "Myo: Before (Tongue thrust) · After ortho: Anterior bonding (#7, #10) · " +
        "Records today: Photos, Pano · Not sure, TC will verify · Phone consult 2026-09-15",
    );
  });

  it("an unanswered sheet is an empty line, and Not now reads as itself", () => {
    expect(orthoScreeningSummary(emptyOrthoScreening())).toBe("");
    expect(orthoScreeningSummary({ ...emptyOrthoScreening(), interest: "not_now" })).toBe(
      "Not now",
    );
  });

  it("the TC rows omit every unanswered field rather than showing it blank", () => {
    expect(orthoScreeningRows({ ...emptyOrthoScreening(), interest: "maybe" })).toEqual([
      { label: "Interested?", value: "Maybe" },
    ]);
    const rows = orthoScreeningRows(full);
    expect(rows.map((r) => r.label)).toEqual([
      "Interested?",
      "Who decides?",
      "Concerns",
      "Which arches?",
      "Aligners or braces?",
      "Estimated months",
      "Phase (if staged)",
      "Upper appliances",
      "Lower appliances",
      "Myo therapy",
      "Myo — why",
      "After ortho",
      "Which teeth",
      "Records taken today",
      "Ortho benefit",
      "Consult",
      "Booked for",
    ]);
    expect(rows.every((r) => r.value.length > 0)).toBe(true);
  });

  it("only Interested? gates the send", () => {
    expect(isOrthoSendable(null)).toBe(false);
    expect(isOrthoSendable(undefined)).toBe(false);
    expect(isOrthoSendable(emptyOrthoScreening())).toBe(false);
    expect(isOrthoSendable({ ...emptyOrthoScreening(), interest: "not_now" })).toBe(true);
  });
});

describe("3: older rows and payloads still parse", () => {
  it("a slip saved before the screening existed parses and gains orthoScreening: null", () => {
    const yesterday: Record<string, unknown> = { ...emptySlip(), patientConcerns: "kept" };
    delete yesterday.orthoScreening;
    const parsed = HygSlipSchema.parse(yesterday);
    expect(parsed.orthoScreening).toBeNull();
    expect(parsed.patientConcerns).toBe("kept");
  });

  it("a stored screening that predates a later field parses with the default", () => {
    const partial = { interest: "yes" };
    expect(OrthoScreeningSchema.parse(partial)).toEqual({
      ...emptyOrthoScreening(),
      interest: "yes",
    });
  });

  it("a visit payload from a server without orthoSend parses, as not sent", () => {
    const visit = HygVisitSchema.parse({
      visitId: "visit-0001",
      office: "roland",
      aptNum: 900001,
      patNum: 12827,
      visitDate: "2026-09-08",
      slip: emptySlip(),
      items: [],
      stagedWrites: [],
      createdBy: "hygienist@carein.ai",
      createdAt: "2026-09-08T13:00:00.000Z",
      updatedBy: null,
      updatedAt: "2026-09-08T13:00:00.000Z",
    });
    expect(visit.orthoSend).toBeNull();
  });

  it("TC's intake contract: orthoScreening is nullable and defaults to null", () => {
    const base = {
      submittedBy: "hygienist@carein.ai",
      submittedByName: "Hyg User",
      submittedAt: "2026-09-08T13:00:00.000Z",
      operatory: "",
      visitDate: null,
      providerSeen: "",
      chiefConcern: "",
      perioStatus: "unknown",
      recallType: "none",
      radiographs: ["none"],
      intraoralPhotosTaken: false,
      areasOfConcern: "",
      suspectedTreatment: "",
      hygienistRecommendation: "",
      insuranceNoted: "",
      patientInterestLevel: "unknown",
      flagUrgent: false,
    };
    expect(TcHygieneIntake.parse(base).orthoScreening).toBeNull();
    expect(
      TcHygieneIntake.parse({ ...base, orthoScreening: { interest: "yes" } }).orthoScreening
        ?.interest,
    ).toBe("yes");
  });
});

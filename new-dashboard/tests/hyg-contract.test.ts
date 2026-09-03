/**
 * The hygiene module's shared contract.
 *
 * Three things are defended here, in descending order of how quietly they would
 * go wrong:
 *
 *   1. PRIORITY AND CATEGORY CANNOT CROSS. They are different axes that share a
 *      word, and letting a category value reach a priority field would print
 *      "this can wait" on a chart because somebody picked "Cosmetic".
 *   2. P1–P4 DOES NOT SHIP. Beau replaced the prototype's numeric scale, and
 *      the way a replaced vocabulary comes back is somebody porting one more
 *      file from the prototype without reading the ruling.
 *   3. THE WIRE CONTRACT MATCHES THE BACKEND. The backend is CommonJS and does
 *      not execute these zod schemas (shared/hyg/contract.ts says why slice 1
 *      ships no second esbuild bundle), so nothing but this test stops the two
 *      drifting until slice 2 adds one.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  DX_LABELS,
  DxCodeSchema,
  HygDayResponseSchema,
  MOTIVATION_LABELS,
  MotivationCodeSchema,
  OFFICE_IDS,
  TREATMENT_PRIORITY_LABELS,
  TreatmentCategorySchema,
  TreatmentItemSchema,
  TreatmentPrioritySchema,
  TreatmentStatusSchema,
  deriveCategory,
  isOfficeId,
  type TreatmentCategory,
  type TreatmentItem,
  type TreatmentPriority,
} from "@shared/hyg/contract";
import { RECORDS_MATRIX, recordsNeededFor } from "@shared/hyg/records";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

// ─── 1. the two axes ─────────────────────────────────────────────────────────

describe("TreatmentPriority vs TreatmentCategory", () => {
  it("is the vocabulary Beau's offices actually use", () => {
    expect(TreatmentPrioritySchema.options).toEqual(["urgent", "preventative", "cosmetic"]);
  });

  it("cannot be assigned across, in either direction", () => {
    // Type-level, so the compiler is the thing enforcing it rather than a
    // runtime check somebody can forget to call.
    expectTypeOf<TreatmentPriority>().not.toMatchTypeOf<TreatmentCategory>();
    expectTypeOf<TreatmentCategory>().not.toMatchTypeOf<TreatmentPriority>();
    // And every individual member, so a union that grew a shared member later
    // fails here rather than compiling.
    expectTypeOf<"cosmetic">().not.toMatchTypeOf<TreatmentCategory>();
    expectTypeOf<"Cosmetic">().not.toMatchTypeOf<TreatmentPriority>();
  });

  it("shares NO exact string with the category vocabulary", () => {
    // This is the invariant the type-level guard above actually rests on:
    // `"cosmetic"` and `"Cosmetic"` are different literal types, so neither
    // union is assignable to the other. Lowercasing `"Cosmetic"` is an obvious
    // future tidy-up and would silently make them assignable — and THIS is
    // what fails when somebody does it, rather than a chart three months later
    // saying a cracked tooth can wait.
    const priorities = new Set<string>(TreatmentPrioritySchema.options);
    const overlap = TreatmentCategorySchema.options.filter((c) => priorities.has(c));
    expect(
      overlap,
      "a category value would now be assignable to a priority field — rename one of them",
    ).toEqual([]);
  });

  it("has exactly ONE word in common, and it is the known one", () => {
    // The pair is `cosmetic` (how soon) and `Cosmetic` (what kind), and it is
    // load-bearing enough to be written down: a SECOND shared word would mean
    // two near-collisions to keep straight, and the second one is the one
    // nobody remembers. Adding one fails here and forces the conversation.
    const priorities = new Set(TreatmentPrioritySchema.options.map((v) => v.toLowerCase()));
    const nearMisses = TreatmentCategorySchema.options
      .filter((c) => priorities.has(c.toLowerCase()))
      .map((c) => c.toLowerCase());
    expect(nearMisses).toEqual(["cosmetic"]);
  });

  it("refuses a category value where a priority belongs, at runtime too", () => {
    expect(TreatmentPrioritySchema.safeParse("Cosmetic").success).toBe(false);
    expect(TreatmentPrioritySchema.safeParse("Restorative").success).toBe(false);
    expect(TreatmentCategorySchema.safeParse("urgent").success).toBe(false);
    expect(TreatmentCategorySchema.safeParse("cosmetic").success).toBe(false);
  });

  it("labels every priority, so no screen invents its own wording", () => {
    for (const p of TreatmentPrioritySchema.options) {
      expect(TREATMENT_PRIORITY_LABELS[p]).toBeTruthy();
    }
  });
});

describe("P1-P4 does not ship", () => {
  it("refuses the prototype's numeric priorities", () => {
    for (const legacy of [1, 2, 3, 4, "1", "P1", "P4"]) {
      expect(TreatmentPrioritySchema.safeParse(legacy).success, String(legacy)).toBe(false);
    }
  });

  it("keeps 'watch' a STATUS, never a priority", () => {
    // A watch with an urgency would be two contradictory sentences on one row.
    expect(TreatmentStatusSchema.options).toContain("watch");
    expect(TreatmentPrioritySchema.safeParse("watch").success).toBe(false);
  });

  it("has no P1-P4 anywhere in the shipped hyg source", () => {
    // docs/hyg-prototype/ still contains it, and must — it is the reference.
    // The shipped tree must not.
    const files = [
      "new-dashboard/shared/hyg/contract.ts",
      "new-dashboard/shared/hyg/records.ts",
      "new-dashboard/client/src/features/hyg/day.ts",
      "new-dashboard/client/src/features/hyg/api.ts",
    ];
    for (const rel of files) {
      const src = readFileSync(path.join(repoRoot, rel), "utf8");
      // `priority: 1` / `priority: 1 | 2 | 3 | 4` — the prototype's shape.
      expect(/priority\s*:\s*(1|z\.union\(\[z\.literal\(1\))/.test(src), rel).toBe(false);
    }
  });
});

// ─── 2. the rest of the vocabulary ───────────────────────────────────────────

describe("the ported vocabularies", () => {
  it("carries every DX code from the paper slip, each with a label", () => {
    expect(DxCodeSchema.options).toHaveLength(20);
    for (const code of DxCodeSchema.options) expect(DX_LABELS[code]).toBeTruthy();
  });

  it("carries every motivation code, each with a label", () => {
    for (const code of MotivationCodeSchema.options) {
      expect(MOTIVATION_LABELS[code]).toBeTruthy();
    }
  });

  it("freezes the office keys and refuses anything else", () => {
    expect(OFFICE_IDS).toEqual(["roland", "valley"]);
    expect(isOfficeId("roland")).toBe(true);
    // `unknown` is the voice module's bucket for an unattributable call. It has
    // no Open Dental database, so it is not somewhere a day can be read from.
    expect(isOfficeId("unknown")).toBe(false);
    expect(isOfficeId("all")).toBe(false);
    expect(isOfficeId(undefined)).toBe(false);
  });
});

function item(over: Partial<TreatmentItem> = {}): TreatmentItem {
  return {
    id: "t1",
    teeth: [3],
    code: "Comp",
    category: "Restorative",
    dx: ["D"],
    priority: "urgent",
    motivation: ["pain"],
    status: "proposed",
    scheduleNext: true,
    photos: [],
    createdBy: "Hygienist A, RDH",
    createdAt: "2026-09-08T08:00:00.000Z",
    ...over,
  };
}

describe("TreatmentItemSchema", () => {
  it("accepts a whole item", () => {
    expect(TreatmentItemSchema.safeParse(item()).success).toBe(true);
  });

  it("distinguishes a whole-mouth item from one with no teeth chosen yet", () => {
    expect(TreatmentItemSchema.safeParse(item({ teeth: "mouth" })).success).toBe(true);
    expect(TreatmentItemSchema.safeParse(item({ teeth: [] })).success).toBe(true);
    // The two are DIFFERENT values, which is the whole reason "mouth" is a
    // literal rather than an empty array.
    expect(TreatmentItemSchema.parse(item({ teeth: "mouth" })).teeth).toBe("mouth");
  });

  it("refuses a perio site code where a restoration surface belongs", () => {
    // "ML" is a real perio site and not a real restoration surface. Merging the
    // two unions would let it reach a composite.
    expect(
      TreatmentItemSchema.safeParse(item({ surfaces: ["ML"] as never })).success,
    ).toBe(false);
    expect(TreatmentItemSchema.safeParse(item({ surfaces: ["M", "O", "D"] })).success).toBe(true);
  });
});

describe("deriveCategory", () => {
  it("folds implants out of Prosth and everything surgical into Restorative", () => {
    expect(deriveCategory([item({ category: "Prosth", code: "IMP" })])).toBe("Implant");
    expect(deriveCategory([item({ category: "Prosth", code: "Mini" })])).toBe("Implant");
    expect(deriveCategory([item({ category: "Prosth", code: "Denture" })])).toBe("Restorative");
    expect(deriveCategory([item({ category: "Endo", code: "RC" })])).toBe("Restorative");
    expect(deriveCategory([item({ category: "Surgery", code: "EX" })])).toBe("Restorative");
  });

  it("puts ortho first when a visit proposes several kinds of work", () => {
    expect(
      deriveCategory([
        item({ category: "Restorative", code: "Comp" }),
        item({ category: "Ortho", code: "Aligners" }),
        item({ category: "Perio", code: "SRP" }),
      ]),
    ).toBe("Ortho");
  });

  it("calls an empty visit Other rather than guessing Restorative", () => {
    // A guess here would put an empty case in a real treatment-coordinator queue.
    expect(deriveCategory([])).toBe("Other");
  });
});

describe("recordsNeededFor", () => {
  it("unions and deduplicates, in matrix order", () => {
    const needed = recordsNeededFor([{ code: "Crown" }, { code: "IMP" }]);
    expect(needed[0]).toBe("Pre-op PA");
    expect(needed.filter((r) => r === "Missing teeth note")).toHaveLength(1);
    expect(needed).toContain("CT scan");
  });

  it("says nothing about a treatment code it has never heard of", () => {
    // Codes are the office's free-text shorthand, not a closed enum. A
    // hygienist typing a new one must still be able to finish her visit.
    expect(recordsNeededFor([{ code: "SomethingNew" }])).toEqual([]);
    expect(RECORDS_MATRIX.SomethingNew).toBeUndefined();
  });

  it("returns an empty list for treatments that genuinely need nothing", () => {
    expect(recordsNeededFor([{ code: "Sealant" }, { code: "Amal" }])).toEqual([]);
  });
});

// ─── 3. agreement with the backend ───────────────────────────────────────────

describe("the day response contract matches the backend that builds it", () => {
  /** Every key the route's response literal names. */
  function backendResponseKeys(): string[] {
    const src = readFileSync(path.join(repoRoot, "backend", "routes", "hyg", "day.js"), "utf8");
    const body = src.slice(src.lastIndexOf("return res.json({"));
    return [...body.matchAll(/^\s{6}([a-zA-Z][a-zA-Z0-9]*)[,:]/gm)].map((m) => m[1]).sort();
  }

  it("names exactly the keys backend/routes/hyg/day.js returns", () => {
    // The backend does not run these schemas (no build step, no zod), so this
    // is the ONLY thing standing between the two until slice 2's request bodies
    // make the esbuild bundle worth its weight. A key added on one side and not
    // the other is a field a screen silently renders as undefined.
    const schemaKeys = Object.keys(HygDayResponseSchema.shape).sort();
    expect(backendResponseKeys()).toEqual(schemaKeys);
  });

  it("parses a payload shaped like the backend's, and rejects a truncated one", () => {
    const payload = {
      success: true as const,
      office: "roland",
      officeName: "Roland Family Dental",
      date: "2026-09-08",
      operatories: [
        { opNum: 2, name: "Hygiene 1", abbrev: "HY1", isHygiene: true, itemOrder: 1 },
      ],
      appointments: [
        {
          aptNum: 900001,
          patNum: 12827,
          patientName: "Test 2, Stedi",
          start: "2026-09-08 08:00:00",
          lengthMin: 60,
          opNum: 2,
          opName: "Hygiene 1",
          isHygiene: true,
          opIsHygiene: true,
          provNum: 1,
          provHyg: 7,
          providerName: "HYG1",
          apptTypeLabel: "Prophy Adult",
          confirmedStatus: "Confirmed",
          aptStatus: "Scheduled",
          isNewPatient: false,
          flags: {
            premed: false,
            medicalAlerts: null,
            allergies: null,
            lastPerioDate: null,
            xraysDue: null,
            examNeeded: null,
            openTcCase: null,
          },
        },
      ],
      warnings: [],
      flagSources: { premed: "od", allergies: "not_read" },
      excludedByStatus: 0,
      truncated: false,
      patientNamesTruncated: false,
    };

    expect(HygDayResponseSchema.safeParse(payload).success).toBe(true);

    // A missing `flags` object is the failure the client's parse exists to
    // catch: without it, every card would render "unknown" for everything and
    // nobody would know the backend had stopped sending them.
    const broken = structuredClone(payload) as Record<string, unknown>;
    (broken.appointments as Record<string, unknown>[])[0].flags = undefined;
    expect(HygDayResponseSchema.safeParse(broken).success).toBe(false);
  });

  it("insists every flag is nullable, so a screen cannot assume a boolean", () => {
    const flags = HygDayResponseSchema.shape.appointments.element.shape.flags;
    for (const [key, schema] of Object.entries(flags.shape)) {
      expect(schema.safeParse(null).success, `${key} must accept null`).toBe(true);
    }
  });
});

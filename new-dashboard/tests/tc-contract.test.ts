/**
 * TC Slice 1 — strict contract + legacy mapping + row round-trip tests.
 *
 * Fixtures are 100% SYNTHETIC (invented names/phones/emails) but shaped like
 * the real legacy data: multi-phase multi-item plans, BOTH legacy follow-up
 * systems plus nurture touchpoints, an OD-linked riley-located case, contact
 * attempts, hygiene intake, and the sloppiness the old `.passthrough()`
 * server accepted (float dollars, unknown extra fields, date-only strings).
 */
import { describe, expect, it } from "vitest";
import {
  CaseStatus,
  OPEN_CASE_STATUSES,
  TERMINAL_CASE_STATUSES,
  TcCase,
  TcCaseEvent,
  TcFollowup,
  LibrarySectionSchemas,
  isContactAttemptDetail,
  isVoiceHandoffDetail,
} from "../shared/tc/contract";
import {
  dollarsToCents,
  legacyCaseToTc,
  legacyLocationToOffice,
  legacyPreauthToTc,
  toIsoDate,
  toIsoTimestamp,
  unifyFollowups,
} from "../shared/tc/legacy";
import { caseFromRows, caseToRows } from "../shared/tc/rows";

let idCounter = 0;
/** Deterministic, valid UUIDv4-shaped ids for stable fixtures. */
const newId = () => {
  idCounter += 1;
  const hex = idCounter.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
};

// ── Synthetic legacy fixture (structure real, values invented) ──────────────

const SYNTHETIC_LEGACY_CASE = {
  id: "case_synth_001",
  patientName: "Testina Sampleton",
  age: 47,
  phone: "(555) 000-1111",
  email: "testina.sampleton@example.invalid",
  caseType: "Full Mouth Rehabilitation",
  category: "full_mouth_rehab",
  doctor: "Dr. Example Doc",
  tc: "holly",
  location: "riley", // legacy key for the Fort Smith office → 'valley'
  status: "considering",
  urgency: "high",
  caseValue: 28500.5, // float dollars on purpose
  readinessScore: 72,
  financingStatus: "Pre-approved (synthetic)",
  nextFollowUpDate: "2026-03-12", // deprecated → dropped
  diagnosedDate: "2026-02-28",
  odPatientId: 424242,
  nurtureCadence: "standard",
  inLongTailMode: false,
  lostReason: null,
  preferredFinancingProvider: "CareCredit",
  decisionMakers: "Spouse — supportive (synthetic)",
  financialSituation: ["Has insurance", "Interested in financing"],
  contactPreference: "text",
  bestTimeToReach: "After 3pm",
  keyMotivators: ["Synthetic motivator A", "Synthetic motivator B"],
  notes: "Synthetic clinical note.",
  phases: [
    {
      id: 1,
      name: "Phase 1 — Foundation",
      description: "Synthetic phase",
      items: [
        {
          id: "od_98765", // OD-imported item → odProcNum parses
          tooth: "14",
          procedureName: "Crown — porcelain/ceramic",
          patientDescription: "Synthetic description",
          fee: 1234.56,
          estimatedInsurance: 600.999, // rounds to 60100
          patientPortion: 633.56,
          urgency: "high",
          timeEstimate: "2 visits",
          benefits: ["Synthetic benefit"],
          risksOfDelay: ["Synthetic risk"],
          expectedOutcome: "Synthetic outcome",
        },
        {
          id: "manual_item_1",
          tooth: "N/A",
          procedureName: "Periodontal scaling",
          patientDescription: "",
          fee: 200,
          estimatedInsurance: 0,
          patientPortion: 200,
          urgency: "medium",
          timeEstimate: "",
          benefits: [],
          risksOfDelay: [],
          expectedOutcome: "",
        },
      ],
    },
    {
      id: 2,
      name: "Phase 2 — Restore",
      description: "",
      items: [
        {
          id: "od_98766",
          tooth: "15",
          procedureName: "Implant crown",
          patientDescription: "Synthetic",
          fee: 1800,
          estimatedInsurance: 0,
          patientPortion: 1800,
          urgency: "elective",
          timeEstimate: "3 visits",
          benefits: [],
          risksOfDelay: [],
          expectedOutcome: "",
        },
      ],
    },
  ],
  // Stale derived snapshots — deliberately dropped by the contract.
  financingOptions: [
    { provider: "CareCredit", termMonths: 24, apr: 0, monthlyPayment: 475, downPayment: 0, totalCost: 11400 },
  ],
  objections: [
    {
      category: "cost",
      note: "Synthetic objection note",
      patientWords: "Synthetic patient words",
      loggedAt: "2026-03-01", // date-only → normalized to timestamp
    },
  ],
  // Legacy follow-up SYSTEM 1: no ids, boolean completed.
  followUps: [
    { type: "phone_call", dueDate: "2026-03-05", note: "Legacy system-1 note", completed: true },
    { type: "email", dueDate: "2026-03-20", note: "Second legacy", completed: false },
  ],
  // Legacy follow-up SYSTEM 2: the current steps.
  followUpSteps: [
    {
      id: "fus_1",
      dueDate: "2026-03-10",
      type: "text",
      suggestedTalkingPoint: "Synthetic talking point",
      status: "completed",
      outcomeNote: "Replied",
      completedAt: "2026-03-10T15:30:00.000Z",
      source: "auto",
      patientResponded: true,
    },
    {
      id: "fus_2",
      dueDate: "2026-04-01",
      type: "phone_call",
      suggestedTalkingPoint: "",
      status: "pending",
      outcomeNote: "",
      completedAt: null,
      source: "manual",
    },
  ],
  // SYSTEM 3: nurture campaign touchpoints.
  nurtureTouchpoints: [
    {
      id: "nt_1",
      type: "financing",
      dueDate: "2026-05-01",
      status: "pending",
      channel: "call", // nurture channel vocab → 'phone_call'
      scriptTemplate: "Synthetic nurture script",
      completedAt: null,
      completedBy: null,
      note: null,
    },
  ],
  contactAttempts: [
    { id: "ca_1", date: "2026-03-02T10:00:00.000Z", type: "call", outcome: "voicemail", note: "Left VM (synthetic)" },
  ],
  caseEvents: [
    { id: "ev_1", timestamp: "2026-02-28T09:00:00.000Z", type: "case_created", description: "Case created", actor: "holly" },
  ],
  nurtureEnrolledAt: null,
  nurturePhaseChangedAt: null,
  nurtureCadenceOverride: { phase1Days: 10, phase2Days: null },
  nurtureUnsubscribed: false,
  referralSource: "hygiene",
  statusChangedAt: "2026-03-01T12:00:00.000Z",
  hygieneIntake: {
    submittedById: "hyg_1",
    submittedByName: "Hattie Hygienist (synthetic)",
    submittedAt: "2026-02-27T14:00:00.000Z",
    operatory: "OP 3",
    visitDate: "2026-02-27",
    providerSeen: "Dr. Example Doc",
    chiefConcern: "Synthetic concern",
    perioStatus: "early_perio",
    recallType: "srp_needed",
    radiographs: ["BWX", "PANO"],
    intraoralPhotosTaken: true,
    areasOfConcern: "UL quadrant (synthetic)",
    suspectedTreatment: "SRP + crowns (synthetic)",
    hygienistRecommendation: "Synthetic recommendation",
    insuranceNoted: "Synthetic carrier",
    patientInterestLevel: "warm",
    flagUrgent: true,
  },
  // The old `.passthrough()` server accepted junk like this — the legacy
  // parser must strip it, and the strict contract must never see it.
  someUnknownLegacyField: { anything: true },
};

describe("conversions", () => {
  it("dollarsToCents rounds and clamps", () => {
    expect(dollarsToCents(1234.56)).toBe(123456);
    expect(dollarsToCents(600.999)).toBe(60100);
    expect(dollarsToCents(0)).toBe(0);
    expect(dollarsToCents(-5)).toBe(0);
    expect(dollarsToCents(Number.NaN)).toBe(0);
  });

  it("legacy office keys map to frozen internal keys (riley → valley)", () => {
    expect(legacyLocationToOffice("riley")).toBe("valley");
    expect(legacyLocationToOffice("roland")).toBe("roland");
    expect(legacyLocationToOffice(undefined)).toBe("roland");
  });

  it("date normalizers handle date-only, ISO, and junk", () => {
    expect(toIsoDate("2026-03-01")).toBe("2026-03-01");
    expect(toIsoDate("2026-03-01T10:00:00.000Z")).toBe("2026-03-01");
    expect(toIsoDate("soon")).toBeNull();
    expect(toIsoTimestamp("2026-03-01")).toBe("2026-03-01T00:00:00.000Z");
    expect(toIsoTimestamp("junk")).toBeNull();
  });
});

describe("follow-up unification (three legacy systems → one queue)", () => {
  const parsed = legacyCaseToTc(SYNTHETIC_LEGACY_CASE, newId);

  it("unifies followUpSteps + followUps + nurtureTouchpoints into one list", () => {
    expect(parsed.followups).toHaveLength(5); // 2 steps + 2 legacy + 1 nurture
    const kinds = parsed.followups.map((f) => f.kind);
    expect(kinds.filter((k) => k === "nurture")).toHaveLength(1);
  });

  it("system-1 items carry source 'legacy', boolean completed → status, unknown completion time → null", () => {
    const legacyOnes = parsed.followups.filter((f) => f.source === "legacy");
    expect(legacyOnes).toHaveLength(2);
    const done = legacyOnes.find((f) => f.status === "completed");
    expect(done).toBeDefined();
    expect(done?.completedAt).toBeNull();
    expect(done?.talkingPoint).toBe("Legacy system-1 note");
    expect(done?.legacyId).toBeNull(); // system 1 had no ids
  });

  it("system-2 steps map 1:1 with ids, source and response tracking preserved", () => {
    const step = parsed.followups.find((f) => f.legacyId === "fus_1");
    expect(step?.status).toBe("completed");
    expect(step?.completedAt).toBe("2026-03-10T15:30:00.000Z");
    expect(step?.patientResponded).toBe(true);
    expect(step?.source).toBe("auto");
  });

  it("nurture touchpoints become kind 'nurture' with channel vocab normalized", () => {
    const n = parsed.followups.find((f) => f.kind === "nurture");
    expect(n?.channel).toBe("phone_call"); // 'call' → 'phone_call'
    expect(n?.nurtureType).toBe("financing");
    expect(n?.talkingPoint).toBe("Synthetic nurture script");
  });

  it("drops queue items without a parseable due date", () => {
    const unified = unifyFollowups(
      {
        followUps: [{ type: "email", dueDate: "whenever", note: "", completed: false }],
        followUpSteps: [],
        nurtureTouchpoints: [],
      },
      newId,
    );
    expect(unified).toHaveLength(0);
  });
});

describe("legacy → strict contract", () => {
  const parsed = legacyCaseToTc(SYNTHETIC_LEGACY_CASE, newId);

  it("produces a contract-valid case (strict parse, no passthrough)", () => {
    expect(() => TcCase.parse(parsed)).not.toThrow();
  });

  it("maps riley → valley and converts every money field to integer cents", () => {
    expect(parsed.officeId).toBe("valley");
    expect(parsed.caseValueCents).toBe(2850050);
    const crown = parsed.phases[0].items[0];
    expect(crown.feeCents).toBe(123456);
    expect(crown.insuranceEstCents).toBe(60100);
    expect(Number.isInteger(crown.patientPortionCents)).toBe(true);
  });

  it("parses OD proc links out of 'od_<n>' item ids", () => {
    expect(parsed.phases[0].items[0].odProcNum).toBe(98765);
    expect(parsed.phases[0].items[1].odProcNum).toBeNull();
    expect(parsed.phases[0].items[1].legacyItemId).toBe("manual_item_1");
  });

  it("folds contactAttempts into events with a typed detail payload", () => {
    const attempt = parsed.events.find((e) => e.type === "contact_attempt");
    expect(attempt?.detail).toEqual({ channel: "call", outcome: "voicemail" });
    expect(parsed.events.find((e) => e.type === "case_created")).toBeDefined();
  });

  it("carries the hygiene intake 1:0..1 (in-flight workstream accommodated)", () => {
    expect(parsed.hygieneIntake?.perioStatus).toBe("early_perio");
    expect(parsed.hygieneIntake?.radiographs).toEqual(["BWX", "PANO"]);
  });

  it("drops derived legacy state: financingOptions and nextFollowUpDate have no contract home", () => {
    const asRecord = parsed as unknown as Record<string, unknown>;
    expect(asRecord.financingOptions).toBeUndefined();
    expect(asRecord.nextFollowUpDate).toBeUndefined();
  });

  it("rejects a case that violates the contract (unknown status)", () => {
    expect(() =>
      legacyCaseToTc({ ...SYNTHETIC_LEGACY_CASE, patientName: "" }, newId),
    ).toThrow();
    // Unknown status falls back via the tolerant legacy parser (catch), but a
    // direct contract parse of a bad status must throw:
    expect(() => CaseStatus.parse("imaginary_status")).toThrow();
  });
});

describe("row mapping round-trip (contract → rows → contract)", () => {
  it("is lossless for the full aggregate", () => {
    const original = legacyCaseToTc(SYNTHETIC_LEGACY_CASE, newId);
    const rows = caseToRows(original, newId);
    const roundTripped = caseFromRows(rows);
    expect(roundTripped).toEqual(original);
  });

  it("diagnosing_provider: null on legacy import, round-trips when set at case entry", () => {
    const imported = legacyCaseToTc(SYNTHETIC_LEGACY_CASE, newId);
    expect(imported.diagnosingProvider).toBeNull(); // legacy had only free-text doctorName

    const entered = { ...imported, diagnosingProvider: "beau" }; // same identity convention as tc_legacy_user_map
    const rows = caseToRows(entered, newId);
    expect(rows.caseRow.diagnosing_provider).toBe("beau");
    expect(caseFromRows(rows).diagnosingProvider).toBe("beau");
  });

  it("stamps office_id on every child row (multi-office rule)", () => {
    const rows = caseToRows(legacyCaseToTc(SYNTHETIC_LEGACY_CASE, newId), newId);
    const all = [
      rows.caseRow.office_id,
      ...rows.phaseRows.map((r) => r.office_id),
      ...rows.itemRows.map((r) => r.office_id),
      ...rows.objectionRows.map((r) => r.office_id),
      ...rows.followupRows.map((r) => r.office_id),
      ...rows.eventRows.map((r) => r.office_id),
      rows.hygieneIntakeRow?.office_id,
    ];
    expect(all.every((o) => o === "valley")).toBe(true);
  });

  it("reorders shuffled child rows back into position order", () => {
    const original = legacyCaseToTc(SYNTHETIC_LEGACY_CASE, newId);
    const rows = caseToRows(original, newId);
    rows.phaseRows.reverse();
    rows.itemRows.reverse();
    expect(caseFromRows(rows)).toEqual(original);
  });
});

describe("pre-auth mapping", () => {
  it("maps a synthetic legacy pre-auth (no location → roland default)", () => {
    const pre = legacyPreauthToTc(
      {
        id: "pa_synth_1",
        patientName: "Percy Placeholder",
        phone: "",
        email: "",
        odPatientId: null,
        preAuthType: "treatment",
        description: "Synthetic pre-auth",
        insuranceCarrier: "Synthetic Dental Ins",
        status: "submitted",
        doctor: "Dr. Example Doc",
        createdAt: "2026-03-01T08:00:00.000Z",
        submittedDate: "2026-03-02",
        decisionDate: null,
        referenceNumber: "REF-SYNTH-1",
        notes: "",
      },
      newId,
    );
    expect(pre.officeId).toBe("roland");
    expect(pre.status).toBe("submitted");
    expect(pre.submittedDate).toBe("2026-03-02");
    expect(pre.phone).toBeNull(); // '' → null
  });
});

describe("library config sections", () => {
  it("financing_settings absorbs the legacy localStorage shape (server-owned)", () => {
    const parsed = LibrarySectionSchemas.financing_settings.parse({
      enabledProviders: { CareCredit: true, Cherry: false },
      serviceFeeEnabled: true,
      serviceFeePercent: 3,
      providerOverrides: {
        Cherry: { promoEnabled: true, promoApr: 0, regularApr: 9.99 },
      },
    });
    expect(parsed.enabledProviders.CareCredit).toBe(true);
  });

  it("crown pricing is integer cents — float dollars are rejected", () => {
    expect(() =>
      LibrarySectionSchemas.crown_pricing.parse({
        economyCents: 80000.5,
        standardCents: 110000,
        premiumCents: 150000,
        implantCents: 180000,
      }),
    ).toThrow();
  });
});

describe("case lifecycle partition (voice→TC attach-or-create law)", () => {
  it("classifies every CaseStatus exactly once", () => {
    const open = new Set<string>(OPEN_CASE_STATUSES);
    const terminal = new Set<string>(TERMINAL_CASE_STATUSES);

    for (const status of CaseStatus.options) {
      expect(open.has(status) || terminal.has(status), `${status} is unclassified`).toBe(true);
      expect(open.has(status) && terminal.has(status), `${status} is classified twice`).toBe(false);
    }
    expect(open.size + terminal.size).toBe(CaseStatus.options.length);
  });

  it("pins the exact open set a handoff may attach to", () => {
    // Changing this list changes which inbound calls join an existing case
    // instead of opening a new one — it should take a deliberate edit here.
    expect([...OPEN_CASE_STATUSES].sort()).toEqual(
      [
        "considering",
        "diagnosed",
        "financing_pending",
        "hygiene_review",
        "nurture",
        "pending_pt",
        "pending_tc",
        "presented",
      ].sort(),
    );
  });

  it("treats a decided or in-production case as terminal, and nurture as open", () => {
    expect(TERMINAL_CASE_STATUSES).toContain("accepted");
    expect(TERMINAL_CASE_STATUSES).toContain("partially_accepted");
    expect(TERMINAL_CASE_STATUSES).toContain("scheduled");
    expect(TERMINAL_CASE_STATUSES).toContain("started");
    // A long-tail case is still being pursued — an inbound call is the win.
    expect(OPEN_CASE_STATUSES).toContain("nurture");
  });
});

describe("voice_handoff event (the durable handoff artifact)", () => {
  const handoff = {
    eventId: "11111111-1111-4111-8111-111111111111",
    legacyId: null,
    ts: "2026-08-07T15:04:05.000Z",
    type: "voice_handoff",
    description: "Sent to TC from a CareIN call — new case",
    actor: "tc@carein.ai",
    detail: { callUrl: "/calls/c1", callSummary: "Asked about an implant.", attached: false },
    sourceCallId: "mango_call_1",
  };

  it("parses with a voice-handoff payload and keeps the call id", () => {
    const parsed = TcCaseEvent.parse(handoff);
    expect(parsed.sourceCallId).toBe("mango_call_1");
    expect(isVoiceHandoffDetail(parsed.detail)).toBe(true);
    expect(isContactAttemptDetail(parsed.detail)).toBe(false);
  });

  it("still parses a contact_attempt payload — the union is unambiguous", () => {
    const parsed = TcCaseEvent.parse({
      ...handoff,
      type: "contact_attempt",
      detail: { channel: "call", outcome: "voicemail" },
      sourceCallId: null,
    });
    expect(isContactAttemptDetail(parsed.detail)).toBe(true);
    expect(isVoiceHandoffDetail(parsed.detail)).toBe(false);
  });

  it("defaults sourceCallId to null so pre-existing construction sites stay valid", () => {
    const { sourceCallId, ...withoutCallId } = handoff;
    const parsed = TcCaseEvent.parse({ ...withoutCallId, detail: null, type: "note_added" });
    expect(parsed.sourceCallId).toBeNull();
  });

  it("round-trips through the row mapping without losing the call id or the summary", () => {
    const original = legacyCaseToTc(SYNTHETIC_LEGACY_CASE, newId);
    const withHandoff = TcCase.parse({
      ...original,
      events: [...original.events, TcCaseEvent.parse(handoff)],
    });
    const rows = caseToRows(withHandoff, newId);

    const eventRow = rows.eventRows.find((r) => r.type === "voice_handoff");
    expect(eventRow?.source_call_id).toBe("mango_call_1");

    expect(caseFromRows(rows)).toEqual(withHandoff);
  });

  it("rejects a malformed handoff payload — no passthrough", () => {
    expect(() =>
      TcCaseEvent.parse({ ...handoff, detail: { callUrl: "/calls/c1" } }), // no `attached`
    ).toThrow();
  });
});

describe("followup contract strictness", () => {
  it("rejects unknown channel vocabulary", () => {
    expect(() =>
      TcFollowup.parse({
        followupId: newId(),
        legacyId: null,
        kind: "followup",
        dueDate: "2026-05-01",
        channel: "carrier_pigeon",
        status: "pending",
        talkingPoint: "",
        outcomeNote: "",
        completedAt: null,
        completedBy: null,
        source: "manual",
        patientResponded: null,
        nurtureType: null,
      }),
    ).toThrow();
  });
});

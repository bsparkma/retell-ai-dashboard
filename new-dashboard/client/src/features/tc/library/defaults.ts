/**
 * Library section defaults — the seed values behind every "Set up defaults"
 * button on /tc/library. Ported from the legacy TC-app server DEFAULT_LIBRARY
 * (TC-app/server/migrations.ts) with money converted to integer cents per the
 * platform contract.
 *
 * HONESTY RULE: nothing here is ever written silently. These constants only
 * pre-fill an editor draft after the user explicitly clicks "Set up defaults";
 * the section is persisted only when they click Save.
 */
import type { z } from "zod";
import type { LibrarySection, LibrarySectionSchemas } from "@shared/tc/contract";

export type SectionValue<K extends LibrarySection> = z.infer<
  (typeof LibrarySectionSchemas)[K]
>;

export const DEFAULT_STAGES: SectionValue<"stages"> = [
  { key: "hygiene_review", label: "New from Hygiene", color: "oklch(0.70 0.17 330)", slaWarnDays: 1, slaCriticalDays: 2, order: 0, system: true },
  { key: "diagnosed", label: "Diagnosed", color: "oklch(0.62 0.12 250)", slaWarnDays: 2, slaCriticalDays: 5, order: 1, system: true },
  { key: "pending_tc", label: "Pending TC", color: "oklch(0.78 0.16 75)", slaWarnDays: 1, slaCriticalDays: 3, order: 2, system: true },
  { key: "pending_pt", label: "Pending PT", color: "oklch(0.72 0.18 55)", slaWarnDays: 2, slaCriticalDays: 5, order: 3, system: true },
  { key: "presented", label: "Presented", color: "oklch(0.62 0.14 220)", slaWarnDays: 3, slaCriticalDays: 7, order: 4, system: true },
  { key: "considering", label: "Considering", color: "oklch(0.68 0.19 42)", slaWarnDays: 5, slaCriticalDays: 14, order: 5, system: true },
  { key: "financing_pending", label: "Financing", color: "oklch(0.52 0.12 186)", slaWarnDays: 3, slaCriticalDays: 7, order: 6, system: true },
  { key: "accepted", label: "Accepted", color: "oklch(0.52 0.14 150)", slaWarnDays: 7, slaCriticalDays: 14, order: 7, system: true },
  { key: "scheduled", label: "Scheduled", color: "oklch(0.42 0.16 186)", slaWarnDays: 14, slaCriticalDays: 30, order: 8, system: true },
];

export const DEFAULT_OBJECTIONS: SectionValue<"objections"> = [
  {
    key: "cost",
    label: "It's too expensive",
    script:
      "I completely understand — this is a real investment. Before I show you any options, can I ask: what monthly payment would feel comfortable? Once I know that, I can usually find a way to make this work — whether that's financing, a phased plan, or starting with just the urgent items today.",
    suggestedFollowUpDays: 3,
  },
  {
    key: "timing",
    label: "Not the right time",
    script:
      "I hear you — life's busy. The challenge is dental issues don't pause to wait for a good time. What if we just took care of the urgent piece now and scheduled the rest for when it works better? You'd address the real risk without taking on the full plan today.",
    suggestedFollowUpDays: 7,
  },
  {
    key: "fear",
    label: "Fear / anxiety",
    script:
      "Thank you for telling me — that takes real courage. A lot of our patients felt exactly the same way before their first visit. Would it help to come in just to meet the doctor and see the room first, with no treatment? We also have nitrous and oral sedation if that would make this easier.",
    suggestedFollowUpDays: 2,
  },
  {
    key: "necessity",
    label: "Is this really necessary?",
    script:
      "That's a fair question, and I'm glad you asked it. The doctor doesn't recommend anything that isn't clinically necessary. Want me to walk you through each item on the plan and show you exactly what was seen on the X-ray? Once you see it, you can decide which items make sense to you.",
    suggestedFollowUpDays: 3,
  },
  {
    key: "second_opinion",
    label: "Wants a second opinion",
    script:
      "Absolutely — that's a smart move on a decision this size. I'll get your X-rays and treatment notes ready so you have everything you need. While you're considering, the urgent items on your plan are time-sensitive — would you be open to handling those now and deciding on the rest after?",
    suggestedFollowUpDays: 7,
  },
  {
    key: "financing",
    label: "Can't afford it",
    script:
      "Let's solve this together. What monthly payment would feel comfortable? Most patients are surprised at how affordable it gets — 0% promotional financing is often available, and we have an in-house plan if outside financing isn't a fit. The goal is to make this work for your budget, not push you into something.",
    suggestedFollowUpDays: 3,
  },
  {
    key: "insurance",
    label: "Insurance won't cover it",
    script:
      "Insurance is rarely the whole story — most plans cap around $1,500 a year and exclude exactly what you actually need. Let me show you what your benefits do cover today, then we'll layer financing on top of the rest. The goal is to land on a monthly number that works for you, regardless of what insurance covers.",
    suggestedFollowUpDays: 3,
  },
  {
    key: "not_ready",
    label: "I need to think about it",
    script:
      "Of course — this is an important decision. Before you leave today, can I ask: is there a specific concern I can help address? Sometimes 'I need to think' really means 'I have one question I haven't asked yet,' and I'd rather we settle that now than have it sit on you all weekend. If nothing else, can we at least take care of the one urgent piece today and you decide on the rest after?",
    suggestedFollowUpDays: 4,
  },
  {
    key: "spouse_family",
    label: "Need to discuss with spouse/family",
    script:
      "That makes total sense — a decision this size should include the people in your life. Want me to put together a one-page summary you can share with them tonight? And if questions come up, your spouse is welcome to call me directly — I'd rather answer their questions than have them sit unanswered. Either way, can we lock in a follow-up time so this doesn't lose momentum?",
    suggestedFollowUpDays: 4,
  },
];

export const DEFAULT_MOTIVATORS: SectionValue<"motivators"> = [
  { key: "appearance", label: "Appearance", color: null, archived: false },
  { key: "pain_relief", label: "Pain relief", color: null, archived: false },
  { key: "function", label: "Function / eating", color: null, archived: false },
  { key: "confidence", label: "Confidence", color: null, archived: false },
  { key: "wedding_event", label: "Wedding / event", color: null, archived: false },
  { key: "work_career", label: "Work / career", color: null, archived: false },
  { key: "family_photos", label: "Family photos", color: null, archived: false },
  { key: "long_term_health", label: "Long-term health", color: null, archived: false },
];

export const DEFAULT_LOST_REASONS: SectionValue<"lost_reasons"> = [
  { key: "cost", label: "Cost", color: null, archived: false },
  { key: "went_elsewhere", label: "Went to another office", color: null, archived: false },
  { key: "no_response", label: "Unresponsive", color: null, archived: false },
  { key: "not_ready", label: "Not ready", color: null, archived: false },
  { key: "moved", label: "Moved / relocated", color: null, archived: false },
  { key: "insurance_lapse", label: "Lost insurance", color: null, archived: false },
];

export const DEFAULT_REFERRAL_SOURCES: SectionValue<"referral_sources"> = [
  { key: "existing_patient", label: "Existing patient", color: null, archived: false },
  { key: "google", label: "Google", color: null, archived: false },
  { key: "facebook", label: "Facebook", color: null, archived: false },
  { key: "walk_in", label: "Walk-in", color: null, archived: false },
  { key: "insurance", label: "Insurance site", color: null, archived: false },
  { key: "referral", label: "Patient referral", color: null, archived: false },
];

export const DEFAULT_TREATMENT_CATEGORIES: SectionValue<"treatment_categories"> = [
  { key: "single_tooth", label: "Single tooth", defaultFinancingProviderKey: null },
  { key: "multi_tooth", label: "Multi-tooth / quadrant", defaultFinancingProviderKey: null },
  { key: "full_mouth", label: "Full mouth", defaultFinancingProviderKey: "proceed" },
  { key: "cosmetic", label: "Cosmetic", defaultFinancingProviderKey: "cherry" },
  { key: "ortho", label: "Ortho", defaultFinancingProviderKey: "carecredit" },
  { key: "implants", label: "Implants", defaultFinancingProviderKey: "proceed" },
];

export const DEFAULT_FINANCING_PROVIDERS: SectionValue<"financing_providers"> = [
  {
    key: "carecredit",
    label: "CareCredit",
    logo: "CC",
    color: "oklch(0.52 0.12 186)",
    description: "Healthcare credit card with 0% promotional periods",
    terms: [12, 18, 24, 36, 48, 60],
    promoTerms: [12, 18, 24],
    minAmountCents: 20000,
    promoApr: 0,
    regularApr: 26.99,
    enabled: true,
  },
  {
    key: "cherry",
    label: "Cherry",
    logo: "CH",
    color: "oklch(0.68 0.19 42)",
    description: "Flexible financing with fast approval",
    terms: [3, 6, 12, 18, 24, 36, 48],
    promoTerms: [3, 6],
    minAmountCents: 20000,
    promoApr: 0,
    regularApr: 9.9,
    enabled: true,
  },
  {
    key: "proceed",
    label: "Proceed Finance",
    logo: "PF",
    color: "oklch(0.62 0.14 220)",
    description: "Long-term financing for large cases",
    terms: [24, 36, 48, 60, 72, 84],
    promoTerms: [],
    minAmountCents: 100000,
    promoApr: 9.9,
    regularApr: 9.9,
    enabled: true,
  },
  {
    key: "sunbit",
    label: "Sunbit",
    logo: "SB",
    color: "oklch(0.72 0.12 150)",
    description: "Buy now, pay later for dental care",
    terms: [3, 6, 12, 18, 24, 36],
    promoTerms: [3, 6],
    minAmountCents: 5000,
    promoApr: 0,
    regularApr: 9.9,
    enabled: true,
  },
  {
    key: "in_house",
    label: "In-House",
    logo: "IH",
    color: "oklch(0.78 0.16 75)",
    description: "Practice-managed payment plan",
    terms: [3, 6, 12, 18, 24],
    promoTerms: [3, 6, 12],
    minAmountCents: 0,
    promoApr: 0,
    regularApr: 0,
    enabled: true,
  },
];

export const DEFAULT_CROWN_PRICING: SectionValue<"crown_pricing"> = {
  economyCents: 80000,
  standardCents: 110000,
  premiumCents: 150000,
  implantCents: 180000,
};

/**
 * Service fee percent mirrors the legacy default (3%) but ships DISABLED —
 * turning on a patient-facing fee should always be an explicit office choice.
 * Cash discount likewise starts off (legacy hardcoded 5% is dead).
 */
export const DEFAULT_FINANCING_CONFIG: SectionValue<"financing_config"> = {
  serviceFeeEnabled: false,
  serviceFeePercent: 3,
  cashDiscountEnabled: false,
  cashDiscountPercent: 5,
};

export const DEFAULT_CADENCE_CONFIG: SectionValue<"cadence_config"> = {
  tiers: [
    { key: "light", label: "Light (under $1k)", intervals: [2, 10, 21] },
    { key: "standard", label: "Standard ($1k–$5k)", intervals: [2, 7, 14, 28, 42] },
    { key: "high_touch", label: "High touch (over $5k)", intervals: [2, 5, 10, 17, 28, 42, 63, 90] },
  ],
  thresholds: { standardMinCents: 100000, highTouchMinCents: 500000 },
  highUrgencyFirstDay: 1,
  spouseFamilyMinFirstDay: 4,
};

/** Empty overrides — inherit everything from the provider catalog. */
export const DEFAULT_FINANCING_SETTINGS: SectionValue<"financing_settings"> = {
  enabledProviders: {},
  serviceFeeEnabled: false,
  serviceFeePercent: 0,
  providerOverrides: {},
};

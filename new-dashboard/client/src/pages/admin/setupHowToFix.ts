/**
 * /admin → Practice setup → "How to fix": what an office manager does about
 * each step that is not done yet.
 *
 * ONE MAP, keyed by the step id the server sends (GET /api/admin/setup-status,
 * backend/services/setupStatus.js). The panel shows, in order: the step's
 * CURRENT detail line from the server (never restated here), these 2–4 plain
 * steps, and the step's existing "Go" link.
 *
 * `go: false` means the panel (and the row) offers NO Go link: there is no
 * screen where the practice can fix it, and a link that only opens a nearby
 * page would suggest otherwise. P8 is the one such step today.
 *
 * Wording rules: written for an office manager, not a developer. No app
 * setting names, no setting keys, no codes.
 */

export interface HowToFix {
  /** 2–4 short, plain-English steps, in the order to do them. */
  steps: readonly string[];
  /** False = no Go link anywhere for this step. Default true. */
  go?: boolean;
}

export const HOW_TO_FIX: Readonly<Record<string, HowToFix>> = {
  P1: {
    steps: [
      "Click Go to open Email identity in the Treatment Coordinator settings, for the office picked above.",
      "Fill in the practice name, the phone, and the practice address: the street on the first line, then city, state and ZIP on the next.",
      "Click Save. Under each box, the In use line should now end in “(saved here)”.",
      "Come back to this page. Office details shows Done once all three are set.",
    ],
  },
  P2: {
    steps: [
      "Click Go to open Users.",
      "Make sure at least one active person is an Admin, and at least one can do Treatment Coordinator work (an Admin or a TC).",
      "Optional: add a Doctor, so referral letters can be signed off.",
    ],
  },
  P3: {
    steps: [
      "Click Go to open Users, and find each active hygienist for this office.",
      "Give each one their full name and licence number.",
      "Link each hygienist to the sign-in they use, so their notes print with their licence.",
    ],
  },
  P4: {
    steps: [
      "Click Go to open the provider and specialist directory.",
      "Add at least one provider from this office.",
      "Add at least one specialist the office refers patients to.",
    ],
  },
  P5: {
    steps: [
      "Click Go to open Email identity for this office.",
      "Enter a reply-to address that someone at the office reads, plus the practice name and phone.",
      "Click Save. A line that still says “from the app setting” is not set up for this office yet; type the value here and save it.",
    ],
  },
  P6: {
    steps: [
      "Click Go to open Print templates.",
      "Open each template, check the wording, and click Save. Saving counts even if you keep the wording as it is.",
      "If logo upload is available, add the office logo to each template (a PNG or JPEG, 2 MB or smaller).",
      "If the upload says logo storage is not set up, tell CareIN support. The templates still print without a logo.",
    ],
  },
  P7: {
    steps: [
      "Click Go to open the referral settings.",
      "Write and save both referral message templates.",
    ],
  },
  P8: {
    go: false,
    steps: [
      "A “(draft)” label means the note wording for that visit type is waiting for your practice's hygienist to approve it.",
      "The practice can't change that wording here yet.",
      "Have your hygienist review the wording, then send the reviewed wording to CareIN support. Support updates it and clears the “(draft)” label.",
    ],
  },
  P9: {
    steps: [
      "CareIN support turns these features on or off for each office.",
      "To change one, ask CareIN support.",
    ],
  },
};

/** The map's entry for a step, or null when it has none. */
export function howToFixFor(stepId: string): HowToFix | null {
  return Object.prototype.hasOwnProperty.call(HOW_TO_FIX, stepId) ? (HOW_TO_FIX[stepId] ?? null) : null;
}

/** Whether this step may show a Go link at all (the map can switch it off). */
export function stepHasGo(stepId: string): boolean {
  const entry = howToFixFor(stepId);
  return entry === null || entry.go !== false;
}

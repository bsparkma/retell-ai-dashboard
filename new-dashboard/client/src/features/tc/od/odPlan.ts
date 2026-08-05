/**
 * Turning an Open Dental treatment plan into TC case phases.
 *
 * `inferUrgency` and `groupItemsIntoPhases` are ported VERBATIM from the legacy
 * TC app (client/src/lib/odUrgency.ts and client/src/lib/openDentalParser.ts) —
 * the rules are the same rules Beau's team already reads off the presentation
 * screen, so changing them here would silently change every imported plan.
 *
 * The only adaptation is the output type: the platform's TcCasePhase carries
 * integer CENTS (features/tc/money.ts), while OD speaks dollars. The conversion
 * happens once, at the boundary, in `phasesFromOdProcedures`.
 */
import type { OdTreatmentProcedure } from "../api";
import type { TcPhaseCreate, TcItemCreate } from "../api";
import type { UrgencyId } from "../status";
import { describeCode } from "./odCodes";

/**
 * Legacy inferUrgency — ported verbatim. Code-family first, then description
 * keywords: D0140/D3/D7 (emergency, endo, surgery) → high; D2/D4/D6 (restorative,
 * perio, implant) → medium; D8 and cosmetic keywords → elective; everything else
 * → low.
 */
export function inferUrgency(code: string, description: string): UrgencyId {
  const desc = (description || "").toLowerCase();
  const c = (code || "").toUpperCase();

  if (
    c.startsWith("D0140") || c.startsWith("D7") || c.startsWith("D3") ||
    desc.includes("root canal") || desc.includes("extraction") ||
    desc.includes("emergency") || desc.includes("abscess") ||
    desc.includes("infection") || desc.includes("pain")
  ) return "high";

  if (
    c.startsWith("D2") || c.startsWith("D4") || c.startsWith("D6") ||
    desc.includes("crown") || desc.includes("filling") ||
    desc.includes("onlay") || desc.includes("inlay") ||
    desc.includes("buildup") || desc.includes("perio") ||
    desc.includes("scaling") || desc.includes("gum") ||
    desc.includes("bone graft") || desc.includes("implant")
  ) return "medium";

  if (
    c.startsWith("D8") ||
    desc.includes("veneer") || desc.includes("bleach") ||
    desc.includes("whitening") || desc.includes("aligner") ||
    desc.includes("invisalign") || desc.includes("cosmetic")
  ) return "elective";

  return "low";
}

/** Dollars → integer cents, rounded the way money.ts rounds. */
function toCents(dollars: number): number {
  if (!Number.isFinite(dollars) || dollars <= 0) return 0;
  return Math.round(dollars * 100);
}

/**
 * Legacy groupItemsIntoPhases — ported verbatim, including the phase names,
 * descriptions and the "everything in one phase" fallback when no item carries
 * a classifiable urgency.
 *
 *   high                → Phase 1 — Urgent Treatment
 *   medium | low        → Phase n — Restorative
 *   elective            → Phase n — Elective / Cosmetic
 */
export function groupItemsIntoPhases(items: TcItemCreate[]): TcPhaseCreate[] {
  const urgent = items.filter((i) => i.urgency === "high");
  const medium = items.filter((i) => i.urgency === "medium" || i.urgency === "low");
  const elective = items.filter((i) => i.urgency === "elective");

  const phases: TcPhaseCreate[] = [];

  const push = (name: string, description: string, phaseItems: TcItemCreate[]) => {
    phases.push({
      position: phases.length,
      name,
      description,
      items: phaseItems.map((item, index) => ({ ...item, position: index })),
    });
  };

  if (urgent.length > 0) {
    push("Phase 1 — Urgent Treatment", "Address urgent and high-priority conditions first", urgent);
  }
  if (medium.length > 0) {
    push(`Phase ${phases.length + 1} — Restorative`, "Restore function and prevent further damage", medium);
  }
  if (elective.length > 0) {
    push(`Phase ${phases.length + 1} — Elective / Cosmetic`, "Elective and cosmetic improvements", elective);
  }
  if (phases.length === 0 && items.length > 0) {
    push("Phase 1 — Treatment Plan", "Complete treatment plan", items);
  }

  return phases;
}

/** One imported procedure, before the user has approved it. */
export interface OdImportItem extends TcItemCreate {
  /** Kept so the review table can show what OD actually said. */
  odProcCode: string;
  odToothNum: string;
}

/**
 * OD procedures → reviewable case items. Money crosses from dollars to cents
 * exactly here; nothing downstream sees an OD dollar amount.
 */
export function itemsFromOdProcedures(procedures: OdTreatmentProcedure[]): OdImportItem[] {
  return procedures.map((p, index) => {
    const procedureName = describeCode(p.procCode, p.description);
    const feeCents = toCents(p.fee);
    const insuranceEstCents = Math.min(toCents(p.insEst), feeCents);
    return {
      position: index,
      odProcNum: p.procNum > 0 ? p.procNum : null,
      tooth: p.toothNum === "N/A" ? "" : p.toothNum,
      procedureName,
      patientDescription: "",
      feeCents,
      insuranceEstCents,
      // Recomputed rather than trusting OD's patAmt, so fee/est/portion always
      // reconcile in the case totals.
      patientPortionCents: Math.max(0, feeCents - insuranceEstCents),
      urgency: inferUrgency(p.procCode, procedureName),
      timeEstimate: "",
      benefits: [],
      risksOfDelay: [],
      expectedOutcome: "",
      odProcCode: p.procCode,
      odToothNum: p.toothNum,
    };
  });
}

/** Strip the review-only fields before the items go to the server. */
export function stripReviewFields(items: OdImportItem[]): TcItemCreate[] {
  return items.map(({ odProcCode: _code, odToothNum: _tooth, ...item }) => item);
}

/**
 * The values a referral note template's placeholders fill from — ONLY what the
 * referral form (or the referral) already shows. No patient identifier is a
 * placeholder, so none can reach a template.
 */
import { teethText } from "@shared/hyg/teeth";
import type { TcReferral, TcReferralTeeth } from "@shared/tc/referrals";
import type { ReferralTemplateValues } from "@shared/tc/referralTemplates";

/** "#3, #14", "whole mouth", or "" when none. */
export function referralTeethLabel(teeth: TcReferralTeeth | null): string {
  if (teeth === "mouth") return "whole mouth";
  return teeth && teeth.length > 0 ? teethText(teeth) : "";
}

export interface ReferralFormValues {
  /** The chosen directory entry's names, if one is chosen. */
  specialistName: string | null | undefined;
  practiceName: string | null | undefined;
  specialty: string;
  referringProvider: string;
  teeth: TcReferralTeeth | null;
  reason: string;
}

/** The specialist's own name when the directory has one, else the practice's. */
function specialistLabel(specialistName: string | null | undefined, practiceName: string | null | undefined): string {
  const s = (specialistName ?? "").trim();
  return s !== "" ? s : (practiceName ?? "").trim();
}

export function templateValuesFromForm(v: ReferralFormValues): ReferralTemplateValues {
  return {
    specialist_name: specialistLabel(v.specialistName, v.practiceName),
    specialty: v.specialty,
    referring_provider: v.referringProvider,
    teeth: referralTeethLabel(v.teeth),
    reason: v.reason,
  };
}

export function templateValuesFromReferral(r: TcReferral): ReferralTemplateValues {
  return templateValuesFromForm({
    specialistName: r.specialistName,
    practiceName: r.practiceName,
    specialty: r.specialty,
    referringProvider: r.referringProvider,
    teeth: r.teeth,
    reason: r.reason,
  });
}

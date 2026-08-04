/**
 * Case-type → gallery-category suggestion map, ported from the legacy
 * DentaFlow PrepConsult CASE_TYPE_TO_GALLERY. The platform's gallery category
 * is free text (contract TcGalleryCase.category), so suggestions match by
 * regex against BOTH the case's free-text caseType and its humanized category
 * enum (e.g. "full_arch" → "full arch"), then pick gallery cases whose
 * category matches the same regex set.
 */
import type { z } from "zod";
import type { CaseCategory, TcGalleryCase } from "@shared/tc/contract";

export const CASE_TYPE_TO_GALLERY: readonly (readonly [RegExp, string])[] = [
  [/implant/i, "Implants"],
  [/veneer|smile makeover|cosmetic/i, "Veneers"],
  [/full mouth/i, "Full Mouth Rehab"],
  [/full arch|all-on/i, "Full Arch"],
  [/crown|bridge|single tooth|quadrant/i, "Crowns"],
  [/invisalign|ortho|aligner/i, "Ortho"],
  [/whitening|bleach/i, "Whitening"],
] as const;

/** Regexes whose case-type pattern matches this case's type/category text. */
function matchingPatterns(
  caseType: string,
  category: z.infer<typeof CaseCategory>,
): RegExp[] {
  const haystacks = [caseType, category.replace(/_/g, " ")];
  return CASE_TYPE_TO_GALLERY.filter(([re]) =>
    haystacks.some((h) => re.test(h)),
  ).map(([re]) => re);
}

/**
 * Gallery cases suggested for this case: category (or title) matches one of
 * the case-type patterns, excluding already-selected ids. Order preserved.
 */
export function suggestedGalleryCases(
  caseType: string,
  category: z.infer<typeof CaseCategory>,
  gallery: readonly TcGalleryCase[],
  selectedIds: ReadonlySet<string>,
): TcGalleryCase[] {
  const patterns = matchingPatterns(caseType, category);
  if (patterns.length === 0) return [];
  return gallery.filter(
    (g) =>
      !selectedIds.has(g.galleryId) &&
      patterns.some((re) => re.test(g.category) || re.test(g.title)),
  );
}

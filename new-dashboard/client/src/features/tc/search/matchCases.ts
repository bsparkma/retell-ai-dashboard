/**
 * Case matching for the TC command palette — pure, no I/O.
 *
 * /api/tc/cases has no text-search parameter and this slice adds no backend
 * routes, so the palette fetches the office-scoped list and filters here. That
 * keeps the office boundary exactly where the API already enforces it: a
 * result can only ever be a case listCases(office) returned.
 */
import type { OfficeId } from "@shared/tc/contract";
import type { TcCaseSummary } from "../api";
import type { CaseStatusId } from "../status";

/** Below this the palette shows a prompt instead of searching. */
export const MIN_QUERY_LENGTH = 2;

/** Result rows the palette will render at most. */
export const MAX_RESULTS = 8;

/** A palette row — exactly what the UI needs, nothing else. */
export interface CaseSearchResult {
  caseId: string;
  patientName: string;
  status: CaseStatusId;
  caseValueCents: number;
  /** Secondary line: case type, doctor, or category — whichever is present. */
  subtitle: string;
  /** Which office the row came from — shown only in the all-offices view. */
  officeId: OfficeId;
}

export function normalizeQuery(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Digits only — so "4795550100" matches "(479) 555-0100". */
function digitsOf(value: string): string {
  return value.replace(/\D/g, "");
}

function matches(c: TcCaseSummary, q: string): boolean {
  if (c.patientName.toLowerCase().includes(q)) return true;
  if (c.caseType && c.caseType.toLowerCase().includes(q)) return true;
  if (c.doctorName && c.doctorName.toLowerCase().includes(q)) return true;
  if (c.assignedTc && c.assignedTc.toLowerCase().includes(q)) return true;
  if (c.email && c.email.toLowerCase().includes(q)) return true;
  if (c.phone) {
    if (c.phone.toLowerCase().includes(q)) return true;
    const qDigits = digitsOf(q);
    if (qDigits.length >= MIN_QUERY_LENGTH && digitsOf(c.phone).includes(qDigits)) {
      return true;
    }
  }
  return false;
}

/**
 * Filter + map to palette rows. Name matches rank above everything else, then
 * higher case value, then name — so typing a patient's name puts them first.
 * Returns [] for a query shorter than MIN_QUERY_LENGTH (never "everything").
 */
export function matchCases(
  cases: TcCaseSummary[],
  rawQuery: string,
  limit = MAX_RESULTS,
): CaseSearchResult[] {
  const q = normalizeQuery(rawQuery);
  if (q.length < MIN_QUERY_LENGTH) return [];
  return cases
    .filter((c) => matches(c, q))
    .sort((a, b) => {
      const aName = a.patientName.toLowerCase().includes(q) ? 0 : 1;
      const bName = b.patientName.toLowerCase().includes(q) ? 0 : 1;
      return (
        aName - bName ||
        b.caseValueCents - a.caseValueCents ||
        a.patientName.localeCompare(b.patientName)
      );
    })
    .slice(0, limit)
    .map((c) => ({
      caseId: c.caseId,
      patientName: c.patientName,
      status: c.status,
      caseValueCents: c.caseValueCents,
      subtitle: c.caseType || c.doctorName || c.category,
      officeId: c.officeId,
    }));
}

/**
 * "WHAT NEEDS ME" — the states a biller sorts work into, and one definition of
 * each.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A FILE AND NOT THREE `filter` CALLS
 * ─────────────────────────────────────────────────────────────────────────────
 * The overview's cards and the remittance list's tabs answer the same question
 * — "which of these is waiting on a match?" — and the card is a LINK to the tab.
 * If they each computed it, the day one of them drifted a card would say 4 and
 * the page it opened would show 3, and nobody would be able to tell which was
 * lying. One predicate, used by both.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT READS THE SERVER'S OWN VOCABULARY, NEVER ITS OWN IDEA OF ONE
 * ─────────────────────────────────────────────────────────────────────────────
 * `attentionReasons` (what a human owes) and `attentionObservations` (what is
 * merely true) are computed in `backend/routes/rcm/remittances.js` over the
 * remittance's whole claim set. Re-deriving "unreviewed" from a row's counters
 * here would be a second opinion about a question the server has already
 * answered — the exact drift `needsAttention` was made server-side to end.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THESE ARE CLIENT-SIDE FILTERS OVER A SERVER-PAGED SET — AND THEY SAY SO
 * ─────────────────────────────────────────────────────────────────────────────
 * `/api/rcm/remittances` takes `view=attention|all` and nothing else, and this
 * slice is front-end only. So `attention` and `all` are the SERVER'S views,
 * paged and counted over the whole office; the four states below are applied in
 * the browser to whatever page came back.
 *
 * That is precisely the arrangement Slice 6a got wrong — filtering a page while
 * the header counted the office, so "12 needing attention · 640 total" was two
 * statements about two populations. It is only acceptable here because the
 * screens SAY the population: a filtered view prints "over the newest N of M",
 * and the two server-backed tabs are untouched. `view=match|review|approve|
 * blocked` on the list endpoint is the backend ask that would retire the
 * caveat.
 */
import type { Remittance } from "@/features/rcm/api";

export const WORKLIST_FILTERS = [
  "attention",
  "match",
  "review",
  "approve",
  "blocked",
  "all",
] as const;
export type WorklistFilter = (typeof WORKLIST_FILTERS)[number];

/** The two the SERVER pages and counts. Everything else is filtered in-page. */
export const SERVER_VIEWS: ReadonlySet<WorklistFilter> = new Set<WorklistFilter>([
  "attention",
  "all",
]);

export function isWorklistFilter(value: string | null): value is WorklistFilter {
  return value !== null && (WORKLIST_FILTERS as readonly string[]).includes(value);
}

export interface FilterCopy {
  /** The tab, and the card's heading. */
  label: string;
  /** One line saying what is in here and who owes it. */
  hint: string;
  /** What an empty result means — never a bare "no rows". */
  empty: string;
}

export const FILTER_COPY: Record<WorklistFilter, FilterCopy> = {
  attention: {
    label: "Needs attention",
    hint: "Everything somebody still owes an action on.",
    empty: "Nothing needs attention here.",
  },
  match: {
    label: "Waiting on match",
    hint: "Claims nobody has looked for in Open Dental yet. Matching only reads the chart.",
    empty: "Every claim has been searched against Open Dental.",
  },
  review: {
    label: "Waiting on review",
    hint: "Claims nobody has dispositioned. A note saying 'nothing to do' is finished work.",
    empty: "Every claim has been reviewed.",
  },
  approve: {
    label: "Ready to post",
    hint: "Matched and reviewed, and waiting for somebody to approve the check for posting.",
    empty: "Nothing is waiting to be approved.",
  },
  blocked: {
    label: "Blocked",
    hint: "A claim was withheld at approval, or a posting run did not finish.",
    empty: "Nothing is blocked.",
  },
  all: {
    label: "All",
    hint: "Every remittance this practice has taken in.",
    empty: "No remittances yet. Upload an 835 or an EOB above.",
  },
};

/**
 * Does this remittance belong in that state?
 *
 * A remittance can be in more than one — a check with three unmatched claims
 * and two unreviewed ones is waiting on both, and hiding it from one queue
 * because it appears in another is how work goes missing. The states are
 * views, not a partition.
 */
export function matchesFilter(r: Remittance, filter: WorklistFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "attention":
      return r.needsAttention;
    case "match":
      return r.attentionObservations.includes("claims_unmatched");
    case "review":
      return r.attentionReasons.includes("claims_unreviewed");
    case "approve":
      return r.attentionReasons.includes("claims_awaiting_approval");
    case "blocked":
      return (
        r.attentionReasons.includes("claims_withheld") ||
        r.attentionReasons.includes("posting_failed")
      );
    default:
      return true;
  }
}

/**
 * Oldest waiting first.
 *
 * The opposite of the default listing, and deliberately: a queue is worked from
 * the end that has been waiting longest, and the newest-first order that suits
 * an archive buries the check somebody forgot about in March.
 *
 * `createdAt` is when CareIN took the file in — the moment the clock a biller
 * cares about started. A row with no `createdAt` sorts last rather than first:
 * an unknown age must not present itself as the most urgent thing on the page.
 */
export function oldestWaitingFirst(rows: Remittance[]): Remittance[] {
  return [...rows].sort((a, b) => {
    const at = a.createdAt ? Date.parse(a.createdAt) : Number.POSITIVE_INFINITY;
    const bt = b.createdAt ? Date.parse(b.createdAt) : Number.POSITIVE_INFINITY;
    if (Number.isNaN(at) && Number.isNaN(bt)) return 0;
    if (Number.isNaN(at)) return 1;
    if (Number.isNaN(bt)) return -1;
    return at - bt;
  });
}

/** How many rows fall in each state. One pass, for the inbox cards. */
export function countByFilter(rows: Remittance[]): Record<WorklistFilter, number> {
  const counts = {
    attention: 0,
    match: 0,
    review: 0,
    approve: 0,
    blocked: 0,
    all: rows.length,
  } as Record<WorklistFilter, number>;
  for (const r of rows) {
    for (const f of WORKLIST_FILTERS) {
      if (f !== "all" && matchesFilter(r, f)) counts[f] += 1;
    }
  }
  return counts;
}

/**
 * "WHAT NEEDS ME" — the states a biller sorts work into, and one definition of
 * each.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A FILE AND NOT THREE `filter` CALLS
 * ─────────────────────────────────────────────────────────────────────────────
 * Today's cards and the Checks page's tabs answer the same question — "which of
 * these is waiting on a match?" — and the card is a LINK to the tab. If they
 * each computed it, the day one of them drifted a card would say 4 and the page
 * it opened would show 3, and nobody would be able to tell which was lying. One
 * predicate, used by both.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT READS THE SERVER'S OWN VOCABULARY, NEVER ITS OWN IDEA OF ONE
 * ─────────────────────────────────────────────────────────────────────────────
 * `attentionReasons` (what a human owes) and `attentionObservations` (what is
 * merely true) are computed in `backend/routes/rcm/remittances.js` over the
 * check's whole claim set. Re-deriving "not checked over" from a row's counters
 * here would be a second opinion about a question the server has already
 * answered — the exact drift `needsAttention` was made server-side to end.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FOUR OF THESE ARE SERVER-PAGED. THE OTHER THREE SAY SO.
 * ─────────────────────────────────────────────────────────────────────────────
 * `/api/rcm/remittances` takes `view=attention|parked|set_aside|all`, applied
 * over the WHOLE office and counted there. `match`, `review` and `approve` are
 * still applied in the browser to whatever page came back, because the server
 * has no work-state view — and the screens SAY the population: a filtered view
 * prints "over the newest N of M". `view=match|review|approve|blocked` on the
 * list endpoint is the backend ask that would retire the caveat.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `set_aside` IS A PARTITION, NOT A VIEW — AND IT IS THE ONLY ONE
 * ─────────────────────────────────────────────────────────────────────────────
 * Every other state here overlaps: a check with three unmatched claims and two
 * unchecked ones is waiting on both, and hiding it from one queue because it
 * appears in another is how work goes missing. A set-aside check is different
 * in kind — a person has said on the record that nobody is coming back to it —
 * so the server's own attention predicate returns early for it and it appears in
 * exactly two places: `set_aside`, and `all`.
 */
import type { Remittance } from "@/features/rcm/api";

export const WORKLIST_FILTERS = [
  "attention",
  "match",
  "review",
  "approve",
  "blocked",
  "parked",
  "set_aside",
  "all",
] as const;
export type WorklistFilter = (typeof WORKLIST_FILTERS)[number];

/**
 * The ones the SERVER pages and counts, over the whole office.
 * Everything else is filtered in-page and says so.
 */
export const SERVER_VIEWS: ReadonlySet<WorklistFilter> = new Set<WorklistFilter>([
  "attention",
  "parked",
  "set_aside",
  "all",
]);

/**
 * THE TABS THE CHECKS PAGE DRAWS — Stage C, §3.
 *
 * Four, not eight. The eight-tab strip was a menu of every predicate the module
 * can express, and a biller reading it had to decide which of *Waiting to be
 * matched*, *Waiting for your review* and *Ready to post* her check was in
 * before she could look for it — a taxonomy question standing in front of the
 * work. Since Stage C every row carries a *Waiting on* cell that says which of
 * those it is IN WORDS, so the tabs only have to answer the four questions that
 * are about the LIST rather than about a row:
 *
 *   attention   what is waiting on somebody       (the default)
 *   parked      what I put down on purpose
 *   set_aside   what nobody is coming back to
 *   all         everything, set-aside included
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE OTHER FOUR ARE NOT DELETED, AND THAT IS DELIBERATE
 * ─────────────────────────────────────────────────────────────────────────────
 * `match`, `review`, `approve` and `blocked` stay in `WORKLIST_FILTERS`: Today's
 * *How it stands* cards link straight into them, `countByFilter` counts them,
 * and somebody may hold a `?view=blocked` link from a fortnight ago. A URL that
 * used to work and now silently shows everything is worse than one extra chip.
 *
 * So the page renders these four as TABS and, when the filter in hand is one of
 * the other four, renders it as a fifth chip beside them with a way back — the
 * "a filter with nothing in it always offers a way out" rule (§11), applied to
 * the filter rather than to the empty result.
 *
 * These four are exactly `SERVER_VIEWS`, and not by coincidence: they are the
 * populations the route pages and counts over the whole office
 * (`REMITTANCE_VIEWS` in `routes/rcm/remittances.js`), so every tab count on
 * this page is a whole-practice number rather than a number over a page.
 */
export const CHECK_TABS: readonly WorklistFilter[] = Object.freeze([
  "attention",
  "parked",
  "set_aside",
  "all",
] as const);

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
    label: "Waiting to be matched",
    hint: "Claims nobody has looked for in Open Dental yet. Matching only reads the chart.",
    empty: "Every claim has been looked for in Open Dental.",
  },
  review: {
    label: "Waiting for your review",
    hint: "Claims nobody has finished with. A note saying 'nothing to do' is finished work.",
    empty: "Every claim has been checked over.",
  },
  approve: {
    label: "Ready to post",
    hint: "Matched and checked over, waiting for somebody to approve the check and post it.",
    empty: "Nothing is waiting to be approved.",
  },
  blocked: {
    label: "Stuck — needs you",
    hint: "A claim was held back at approval, or a posting did not finish.",
    empty: "Nothing is stuck.",
  },
  parked: {
    label: "Saved for tomorrow",
    hint: "Checks somebody put down meaning to come back. Opening one puts it back on the pile.",
    empty: "Nothing is saved for tomorrow.",
  },
  set_aside: {
    label: "Set aside",
    hint: "Checks nobody is coming back to. They are out of the counts, not out of the records — put any of them back in one click.",
    empty: "Nothing has been set aside.",
  },
  all: {
    label: "All",
    hint: "Every check this practice has taken in, set-aside ones included.",
    empty: "No checks yet. Add one from Today.",
  },
};

/**
 * Does this check belong in that state?
 *
 * A check can be in more than one — see the header. The exception is
 * `set_aside`, which the server's attention predicate has already partitioned
 * out; the two clauses below just say so in the browser too, so a client-side
 * tab applied to a page cannot disagree with the server-paged view of the same
 * name.
 */
export function matchesFilter(r: Remittance, filter: WorklistFilter): boolean {
  const setAside = r.setAsideAt != null;
  switch (filter) {
    case "all":
      return true;
    case "set_aside":
      return setAside;
    case "parked":
      // A set-aside check is not "saved for tomorrow" even if somebody parked it
      // first. The stronger, later decision is the one the screen reports.
      return r.parkedAt != null && !setAside;
    case "attention":
      return r.needsAttention;
    case "match":
      return !setAside && r.attentionObservations.includes("claims_unmatched");
    case "review":
      return !setAside && r.attentionReasons.includes("claims_unreviewed");
    case "approve":
      return !setAside && r.attentionReasons.includes("claims_awaiting_approval");
    case "blocked":
      return (
        !setAside &&
        (r.attentionReasons.includes("claims_withheld") ||
          r.attentionReasons.includes("posting_failed"))
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

/**
 * Most recently put down first.
 *
 * The opposite ordering from every other queue here, and for the opposite
 * reason: "where did I leave off" means the LAST thing, and a card that led with
 * the check somebody parked three weeks ago would answer a question nobody
 * asked. A row with no stamp sorts last.
 */
export function newestParkedFirst(rows: Remittance[]): Remittance[] {
  return [...rows].sort((a, b) => {
    const at = a.parkedAt ? Date.parse(a.parkedAt) : Number.NEGATIVE_INFINITY;
    const bt = b.parkedAt ? Date.parse(b.parkedAt) : Number.NEGATIVE_INFINITY;
    if (Number.isNaN(at) && Number.isNaN(bt)) return 0;
    if (Number.isNaN(at)) return 1;
    if (Number.isNaN(bt)) return -1;
    return bt - at;
  });
}

/** How many rows fall in each state. One pass, for Today's cards. */
export function countByFilter(rows: Remittance[]): Record<WorklistFilter, number> {
  const counts = {
    attention: 0,
    match: 0,
    review: 0,
    approve: 0,
    blocked: 0,
    parked: 0,
    set_aside: 0,
    all: rows.length,
  } as Record<WorklistFilter, number>;
  for (const r of rows) {
    for (const f of WORKLIST_FILTERS) {
      if (f !== "all" && matchesFilter(r, f)) counts[f] += 1;
    }
  }
  return counts;
}

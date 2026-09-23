/**
 * /fees/imports/:batchId — the preview.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THIS SCREEN'S WHOLE JOB IS TO BE DOUBTED
 * ═════════════════════════════════════════════════════════════════════════════
 * A fee schedule is a payer contract, and the parser had to interpret parts of
 * it. The reference importer this module was ported from made those
 * interpretations SILENTLY — it took the first money token on a multi-column
 * row whatever tier the office held, and wrote one line's single amount against
 * every code on it. Nobody could have caught either, because nothing said a
 * choice had been made.
 *
 * So the design rule here is the inverse: every row the parser had to interpret
 * is visually distinct AND shows the line it came from, because the raw line is
 * the only thing that lets a reader judge whether the interpretation was right.
 * A warning without its source line is a warning nobody can act on.
 *
 * Three specifics that are not decoration:
 *
 *  1. $0.00 RENDERS AS $0.00. Never blank, never an em dash. In a fee schedule
 *     zero means not covered, bundled, or no fee — a fact the office needs. The
 *     reference discarded every zero with a `> 0` guard; drawing one as an
 *     empty cell would put that defect back one layer up.
 *
 *  2. DUPLICATE CODES ARE GROUPED, so both fees are seen side by side. A payer
 *     schedule really does list D2740 twice — a base page and an amendment
 *     page — and the two numbers being forty rows apart is how somebody scrolls
 *     past the disagreement. The schema keeps both rows on purpose (no UNIQUE
 *     on (batch_id, proc_code)); this is the half of that decision the reader
 *     actually sees.
 *
 *  3. FILE-LEVEL WARNINGS RENDER AT THE TOP, above the rows. They are facts
 *     about the upload rather than about any one fee — "line 12 named three
 *     codes, so no fees were read from it" describes something that is NOT in
 *     the table below, and putting it beside the rows would file an absence
 *     among presences.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * REVIEWING 400 ROWS: SECTIONS, A WARNING COUNTER, AND AN EDIT BOX
 * ═════════════════════════════════════════════════════════════════════════════
 * A real payer schedule is 300–500 rows. As one flat list it is unreviewable:
 * no way to find the four crowns, no way to say "restorative is checked", and
 * no way to reach the six flagged rows without scrolling past all the clean
 * ones. Three additions, each answering one of those.
 *
 *  - SECTIONS, by CDT category. Not a new organising idea — it is how every
 *    payer PDF on the office's desk is already printed, and how Open Dental
 *    groups its own fee windows. File order is preserved INSIDE a section, so a
 *    row is still where the document has it.
 *
 *  - THE WARNING CHIP counts rows nobody has answered and steps between them.
 *    It reaches zero exactly when the batch becomes postable — but it is a
 *    REFLECTION of the server's gate, never a second opinion about it. The
 *    server re-derives that gate from the rows on every post, and refuses a
 *    caller who never opened this page at all.
 *
 *  - THE FEE IS EDITABLE IN PLACE, because the commonest warned row is the
 *    multi-column one and the office knows which column their contract is in.
 *    Accepting a number they know is wrong, or dropping the code out of the
 *    schedule, were the only two answers before; both are worse than typing
 *    $920.
 *
 * AN EDIT NEVER TOUCHES THE PARSED VALUE. It goes in its own column, and this
 * screen shows both — "edited from $1,150.00" — because the file's own number
 * is the evidence the whole preview rests on.
 *
 * AND EDITING STOPS WHEN POSTING STARTS. A posting, posted or rolled-back batch
 * renders read-only: those rows are the record of what was written, and a
 * record that can still be changed is not one. The server refuses the edit too
 * (409 BATCH_NOT_EDITABLE); this is the courtesy in front of that refusal.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE BANNER IS LOAD-BEARING, AND AS OF SLICE 3 IT IS CONDITIONAL
 * ═════════════════════════════════════════════════════════════════════════════
 * Slice 2 said "Preview only — nothing has been sent to Open Dental" on every
 * batch, and its header recorded that this banner would be "the first thing
 * that must change" when posting landed, because "a reader who has learned to
 * trust it is exactly who would be misled if it were left behind".
 *
 * This is that change. The line is now shown only for a batch that has NOT been
 * posted; a posted, failed-partway or rolled-back one gets a different banner
 * and the posting panel underneath, which says what actually reached the
 * practice. `post_failed` counts as posted for this purpose — a run that
 * stopped at row 300 still put 299 fees in, and that is the worst possible
 * moment for this page to claim otherwise.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useRoute } from "wouter";
import {
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Info,
  Loader2,
  Pencil,
  XCircle,
} from "lucide-react";

import { useAuth } from "@/contexts/AuthContext";
import { useOffice, ALL_OFFICES } from "@/contexts/OfficeContext";
import { can } from "@/lib/permissions";
import {
  decideRow,
  getImport,
  groupRowsByCode,
  formatFeeCents,
  formatBytes,
  effectiveFeeCents,
  feeInputValue,
  isEdited,
  parseFeeInput,
  FeesApiError,
  FEES_OFFICE_IDS,
  FEES_OFFICE_LABELS,
  isFeesOfficeId,
  type FeesImportBatch,
  type FeesImportRow,
  type FeesOfficeId,
  type FeesRowVerdict,
} from "@/features/fees/api";
import {
  cdtSectionId,
  groupRowsByCategory,
  isUnresolved,
  unresolvedRowIds,
  type CdtSection,
} from "@/features/fees/cdt";
import { PostingPanel } from "@/features/fees/PostingPanel";
import { cn } from "@/lib/utils";

type DetailState =
  | { kind: "loading" }
  | { kind: "ready"; batch: FeesImportBatch; rows: FeesImportRow[] }
  | { kind: "error"; error: FeesApiError };

/**
 * Which offices to try for this batch id.
 *
 * Under a concrete selection, that one. Under "All", BOTH — a batch id is a
 * uuid the server minted and the detail endpoint scopes by office in the WHERE,
 * so asking the wrong office returns 404 rather than another office's data.
 * Trying both is how a link pasted from a merged list still opens; it cannot
 * leak anything, because a 404 is all the wrong office can ever produce.
 */
function officesToTry(selection: string): FeesOfficeId[] {
  if (selection === ALL_OFFICES) return [...FEES_OFFICE_IDS];
  return isFeesOfficeId(selection) ? [selection] : [...FEES_OFFICE_IDS];
}

/** A local date-time an office reads, from an ISO string. */
function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  return at.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Bring an element into view, where the environment has a view.
 *
 * jsdom does not implement `scrollIntoView`, and neither do some older mobile
 * browsers. The guard is not defensive noise: without it every test of the
 * warning navigation would fail on the scroll rather than on the behaviour it
 * is checking, and the navigation itself still works — the row is highlighted
 * either way, which is the half that carries the meaning.
 */
function bringIntoView(el: Element | null | undefined): void {
  if (el && typeof el.scrollIntoView === "function") {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

export default function FeesImportDetail() {
  const [, params] = useRoute("/fees/imports/:batchId");
  const batchId = params?.batchId ?? "";
  const { office: selection, loading: rosterLoading } = useOffice();
  const auth = useAuth();
  /**
   * UX ONLY. The server's requireReadWrite is the boundary; this decides
   * whether the Post button is offered with its reason or offered at all. A
   * reader without fees.write still opens the page and sees everything.
   */
  const canWrite = can(
    auth.status === "authenticated" ? auth.user.permissions : undefined,
    "fees.write",
  );

  const [state, setState] = useState<DetailState>({ kind: "loading" });
  /** Bumped when a decision, a post or a rollback changes what the rows say. */
  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  useEffect(() => {
    if (rosterLoading || batchId === "") return;
    const abort = new AbortController();
    // NOT a loading state on a re-read. Blanking the page every time somebody
    // accepts a row would make the list jump under the cursor they are about to
    // click again.
    if (reloadToken === 0) setState({ kind: "loading" });

    const candidates = officesToTry(selection);

    (async () => {
      let lastError: FeesApiError | null = null;
      for (const office of candidates) {
        try {
          const result = await getImport(office, batchId, abort.signal);
          if (abort.signal.aborted) return;
          setState({ kind: "ready", batch: result.batch, rows: result.rows });
          return;
        } catch (err: unknown) {
          if (abort.signal.aborted) return;
          const asApi =
            err instanceof FeesApiError
              ? err
              : new FeesApiError(
                  err instanceof Error ? err.message : "Could not load this import",
                  0,
                  null,
                );
          lastError = asApi;
          // A 404 from one office is not an answer while another is untried.
          // Anything else — 403, a network failure — is, and retrying the other
          // office would only produce the same refusal a second time.
          if (asApi.status !== 404) break;
        }
      }
      if (!abort.signal.aborted) {
        setState({
          kind: "error",
          error: lastError ?? new FeesApiError("No such import.", 404, "BATCH_NOT_FOUND"),
        });
      }
    })();

    return () => abort.abort();
  }, [batchId, selection, rosterLoading, reloadToken]);

  return (
    <div className="p-6" data-testid="fees-import-detail">
      <Link
        href="/fees"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        data-testid="fees-detail-back"
      >
        <ArrowLeft size={16} aria-hidden />
        All imports
      </Link>

      {state.kind === "loading" && (
        <div
          className="mt-6 flex items-center gap-2 text-sm text-muted-foreground"
          data-testid="fees-detail-loading"
        >
          <Loader2 size={16} className="animate-spin" aria-hidden />
          Loading this import…
        </div>
      )}

      {state.kind === "error" && (
        <div
          className="mt-6 rounded-lg border border-destructive/40 bg-destructive/5 p-4"
          data-testid="fees-detail-error"
        >
          <div className="text-sm font-medium text-foreground">{state.error.message}</div>
          {state.error.code !== null && (
            <div className="mt-1 font-mono text-xs text-muted-foreground">{state.error.code}</div>
          )}
        </div>
      )}

      {state.kind === "ready" && (
        <Preview
          batch={state.batch}
          rows={state.rows}
          canWrite={canWrite}
          onSettled={reload}
        />
      )}
    </div>
  );
}

/**
 * Statuses in which the preview-only banner would be a lie.
 *
 * `post_failed` is on this list deliberately. A run that stopped partway still
 * put fees into the practice, and a screen telling that reader "nothing has
 * been sent" is the worst moment for this page to be wrong.
 */
const POSTED_STATUSES: readonly string[] = ["posting", "posted", "post_failed", "rolled_back"];

/**
 * A batch whose rows can still be decided.
 *
 * MIRRORS the server's own precondition in routes/fees/posting.js, which
 * refuses a PATCH on anything else with 409 BATCH_NOT_EDITABLE. Every state
 * outside this list renders the rows read-only — not because the control would
 * fail, but because those rows are the record of what was written, and a record
 * that can still be edited is not one.
 */
const EDITABLE_STATUSES: readonly string[] = ["parsed", "ready"];

function Preview({
  batch,
  rows,
  canWrite,
  onSettled,
}: {
  batch: FeesImportBatch;
  rows: readonly FeesImportRow[];
  canWrite: boolean;
  onSettled: () => void;
}) {
  const decidable = EDITABLE_STATUSES.includes(batch.status) && canWrite;
  const sections = useMemo(() => groupRowsByCategory(rows), [rows]);
  const unresolved = useMemo(() => unresolvedRowIds(sections), [sections]);

  /** The row the warning navigation last moved to, so it can be pointed at. */
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});

  /**
   * Step to the next (or previous) unanswered warning.
   *
   * Computed from the CURRENT list each time rather than from a stored index.
   * The list shortens as rows are answered — usually the one being looked at —
   * and an index into a list that changed under it would skip a row or land on
   * a clean one. Deriving the position from where the reader actually is
   * survives the list changing shape.
   */
  const step = useCallback(
    (direction: 1 | -1) => {
      if (unresolved.length === 0) return;
      const at = highlighted === null ? -1 : unresolved.indexOf(highlighted);
      // Nothing focused, or the focused row has just been answered: start at
      // whichever end the reader asked to move towards.
      const next =
        at === -1
          ? direction === 1
            ? unresolved[0]
            : unresolved[unresolved.length - 1]
          : // Wraps, because this is a ring of things still to do; stopping at
            // the end would hide the ones above where the reader started.
            unresolved[(at + direction + unresolved.length) % unresolved.length];
      setHighlighted(next);
      bringIntoView(rowRefs.current[next]);
    },
    [unresolved, highlighted],
  );

  const jumpTo = useCallback((sectionId: string) => {
    bringIntoView(typeof document === "undefined" ? null : document.getElementById(sectionId));
  }, []);

  const registerRow = useCallback((rowId: string, el: HTMLDivElement | null) => {
    rowRefs.current[rowId] = el;
  }, []);

  return (
    <>
      <div className="mt-4">
        <h1
          className="text-2xl font-bold tracking-tight text-foreground"
          style={{ fontFamily: "Sora, sans-serif" }}
        >
          {batch.filename}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {FEES_OFFICE_LABELS[batch.office] ?? batch.office} · {batch.sourceType.toUpperCase()} ·{" "}
          {formatBytes(batch.fileSizeBytes)} · uploaded {formatWhen(batch.createdAt)} by{" "}
          {batch.createdBy}
        </p>
      </div>

      {/* ── The banner. See the header — this is load-bearing, and as of slice 3
             it is CONDITIONAL. "Nothing has been sent to Open Dental" was true
             of every batch while posting did not exist; it is now true only of
             one that has not been posted. A reader who has learned to trust
             this line is exactly who would be misled by leaving it up after the
             fees are in their practice's database. ─────────────────────────── */}
      {POSTED_STATUSES.includes(batch.status) ? (
        <div
          className="mt-4 flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-4"
          data-testid="fees-posted-banner"
        >
          <Info size={18} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
          <div>
            <div className="text-sm font-medium text-foreground">
              {batch.status === "rolled_back"
                ? "This import was posted and then rolled back."
                : "These fees have been written to Open Dental."}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              What is below is what CareIN read out of the file. The panel underneath says what
              actually reached the practice.
            </p>
          </div>
        </div>
      ) : (
        <div
          className="mt-4 flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-4"
          data-testid="fees-preview-banner"
        >
          <Info size={18} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
          <div>
            <div className="text-sm font-medium text-foreground">
              Preview only — nothing has been sent to Open Dental.
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              This is what CareIN read out of the file. Nothing reaches the practice until somebody
              presses Post below.
            </p>
          </div>
        </div>
      )}

      {/* The posting panel: target, Post, progress, rollback. Absent for a file
          that never parsed — there is nothing to post. */}
      {batch.status !== "failed" && (
        <PostingPanel
          office={batch.office}
          batchId={batch.batchId}
          canWrite={canWrite}
          onSettled={onSettled}
        />
      )}

      {/* ── A failed batch has no rows, and says why. ──────────────────────── */}
      {batch.status === "failed" && (
        <div
          className="mt-4 rounded-lg border border-destructive/40 bg-destructive/5 p-4"
          data-testid="fees-detail-failed"
        >
          <div className="flex items-start gap-2">
            <XCircle size={18} className="mt-0.5 shrink-0 text-destructive" aria-hidden />
            <div>
              <div className="text-sm font-medium text-foreground">
                This file could not be read.
              </div>
              <p className="mt-1 text-sm text-muted-foreground" data-testid="fees-detail-failure-reason">
                {batch.failureReason ?? "No reason was recorded."}
              </p>
              {batch.failureCode !== null && (
                <div
                  className="mt-1 font-mono text-xs text-muted-foreground"
                  data-testid="fees-detail-failure-code"
                >
                  {batch.failureCode}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── File-level warnings, above the rows. See the header, note 3. ──── */}
      {batch.warnings.length > 0 && (
        <div
          className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4"
          data-testid="fees-file-warnings"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle size={16} className="shrink-0 text-amber-600" aria-hidden />
            <span className="text-sm font-medium text-foreground">
              {batch.warnings.length} {batch.warnings.length === 1 ? "note" : "notes"} about this
              file
            </span>
          </div>
          <ul className="mt-2 space-y-1.5">
            {batch.warnings.map((warning, i) => (
              <li
                key={`${warning.code}-${i}`}
                className="text-sm text-muted-foreground"
                data-testid="fees-file-warning"
              >
                {warning.message}
                <span className="ml-2 font-mono text-xs opacity-70">{warning.code}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── The rows ──────────────────────────────────────────────────────── */}
      {batch.status !== "failed" && (
        <section className="mt-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {batch.rowCount} {batch.rowCount === 1 ? "fee" : "fees"}, in file order
            </h2>
            <WarningNav count={unresolved.length} onStep={step} />
          </div>

          {/* The jump menu is a SIBLING of the sections on desktop and a
              dropdown above them on mobile — same array either way, so a
              section can never exist without a way to reach it, and the menu
              can never name one that is not there. */}
          <div className="mt-3 lg:flex lg:items-start lg:gap-6">
            <SectionNav sections={sections} onJump={jumpTo} />

            <div className="min-w-0 flex-1 space-y-6">
              {sections.map((section) => (
                <SectionBlock
                  key={section.category.digit}
                  section={section}
                  batch={batch}
                  decidable={decidable}
                  highlighted={highlighted}
                  registerRow={registerRow}
                  onSettled={onSettled}
                />
              ))}

              {sections.length === 0 && (
                <div
                  className="rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground"
                  data-testid="fees-detail-no-rows"
                >
                  This import stored no fees.
                </div>
              )}
            </div>
          </div>
        </section>
      )}
    </>
  );
}

/**
 * The unanswered-warning counter, and the two buttons that walk them.
 *
 * AT ZERO IT SAYS SO RATHER THAN DISAPPEARING. A counter that vanishes when it
 * empties leaves the reader unsure whether they finished or whether the control
 * broke; "No warnings left to answer" is the sentence they were looking for,
 * and it is also the sentence that explains why Post has just become available.
 *
 * The count is a REFLECTION of the server's posting gate, not a second opinion.
 * The server re-derives it from the rows on every post and refuses a caller who
 * never opened this page — this chip only tells somebody why the button they
 * are looking at is disabled.
 */
function WarningNav({ count, onStep }: { count: number; onStep: (d: 1 | -1) => void }) {
  if (count === 0) {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs font-medium text-muted-foreground"
        data-testid="fees-warning-nav"
        data-unresolved="0"
      >
        No warnings left to answer
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/5 py-0.5 pl-2.5 pr-1 text-xs font-medium text-amber-700 dark:text-amber-400"
      data-testid="fees-warning-nav"
      data-unresolved={String(count)}
    >
      <AlertTriangle size={12} aria-hidden />
      <span data-testid="fees-warning-nav-count">
        {/* Both halves agree in number. "1 rows need an answer" reads as a
            typo, and a sentence that reads as a typo is one people stop
            reading. */}
        {count === 1 ? "1 row needs an answer" : `${count} rows need an answer`}
      </span>
      <button
        type="button"
        onClick={() => onStep(-1)}
        aria-label="Previous unanswered warning"
        data-testid="fees-warning-prev"
        className="ml-1 inline-flex h-7 w-7 items-center justify-center rounded-full transition-colors hover:bg-amber-500/20"
      >
        <ChevronUp size={14} aria-hidden />
      </button>
      <button
        type="button"
        onClick={() => onStep(1)}
        aria-label="Next unanswered warning"
        data-testid="fees-warning-next"
        className="inline-flex h-7 w-7 items-center justify-center rounded-full transition-colors hover:bg-amber-500/20"
      >
        <ChevronDown size={14} aria-hidden />
      </button>
    </span>
  );
}

/**
 * Jump to a CDT section.
 *
 * A sticky list on desktop, a native `<select>` on mobile. Native on purpose:
 * it is the one control every phone renders as a full-height picker a person
 * can work one-handed, and a custom dropdown here would be a worse version of
 * it for no gain.
 *
 * Both render from the SAME sections array as the page itself.
 */
function SectionNav({
  sections,
  onJump,
}: {
  sections: readonly CdtSection[];
  onJump: (sectionId: string) => void;
}) {
  if (sections.length === 0) return null;
  return (
    <>
      {/* Mobile */}
      <div className="lg:hidden" data-testid="fees-section-jump-mobile">
        <label className="sr-only" htmlFor="fees-section-jump">
          Jump to a section
        </label>
        <select
          id="fees-section-jump"
          defaultValue=""
          onChange={(e) => {
            if (e.target.value !== "") onJump(e.target.value);
          }}
          data-testid="fees-section-jump-select"
          className="min-h-[40px] w-full rounded-md border border-border bg-background px-3 text-sm text-foreground"
        >
          <option value="">Jump to a section…</option>
          {sections.map((section) => (
            <option key={section.category.digit} value={cdtSectionId(section.category)}>
              {section.category.label} ({section.rows.length}
              {section.unresolvedCount > 0 ? `, ${section.unresolvedCount} to answer` : ""})
            </option>
          ))}
        </select>
      </div>

      {/* Desktop */}
      <nav
        aria-label="Fee schedule sections"
        data-testid="fees-section-nav"
        className="hidden w-60 shrink-0 lg:sticky lg:top-6 lg:block"
      >
        <ul className="space-y-0.5 rounded-lg border border-border bg-card p-2">
          {sections.map((section) => (
            <li key={section.category.digit}>
              <button
                type="button"
                onClick={() => onJump(cdtSectionId(section.category))}
                data-testid={`fees-section-link-${section.category.digit}`}
                className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent"
              >
                <span className="truncate">{section.category.label}</span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {section.unresolvedCount > 0 && (
                    <span
                      className="rounded-full bg-amber-500/20 px-1.5 text-[11px] font-semibold text-amber-700 dark:text-amber-400"
                      data-testid={`fees-section-unresolved-${section.category.digit}`}
                    >
                      {section.unresolvedCount}
                    </span>
                  )}
                  <span className="tabular-nums text-xs text-muted-foreground">
                    {section.rows.length}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}

/** One CDT section: a sticky header and its rows, duplicates grouped. */
function SectionBlock({
  section,
  batch,
  decidable,
  highlighted,
  registerRow,
  onSettled,
}: {
  section: CdtSection;
  batch: FeesImportBatch;
  decidable: boolean;
  highlighted: string | null;
  registerRow: (rowId: string, el: HTMLDivElement | null) => void;
  onSettled: () => void;
}) {
  // Duplicates are grouped WITHIN the section, which keeps both halves of the
  // ordering promise: sections in code order, and first-appearance file order
  // inside one.
  const groups = groupRowsByCode(section.rows);

  return (
    <div data-testid="fees-section" data-section={section.category.digit}>
      <h3
        id={cdtSectionId(section.category)}
        // Sticky, so a reader forty rows into restorative still knows what they
        // are looking at. `scroll-mt` stops a jump landing the header
        // underneath itself.
        className="sticky top-0 z-10 flex scroll-mt-4 flex-wrap items-center justify-between gap-2 border-b border-border bg-background/95 py-2 backdrop-blur"
        data-testid="fees-section-header"
      >
        <span className="text-sm font-semibold text-foreground">{section.category.label}</span>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          {section.unresolvedCount > 0 && (
            <span
              className="rounded-full border border-amber-500/40 px-2 py-0.5 font-medium text-amber-700 dark:text-amber-400"
              data-testid="fees-section-header-unresolved"
            >
              {section.unresolvedCount} to answer
            </span>
          )}
          <span className="tabular-nums">
            {section.rows.length} {section.rows.length === 1 ? "fee" : "fees"}
          </span>
        </span>
      </h3>

      <ul className="mt-2 divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {groups.map((group) => {
          const duplicated = group.rows.length > 1;
          return (
            <li
              key={`${section.category.digit}-${group.procCode}`}
              data-testid="fees-row-group"
              data-proc-code={group.procCode}
              data-conflicting={group.conflicting ? "true" : "false"}
              className={cn(
                "p-4",
                // A code listed twice at two DIFFERENT fees is a decision
                // somebody has to make; twice at the same fee is only untidy.
                // Drawing them alike would spend the reader's attention on the
                // one that does not need it.
                group.conflicting && "border-l-4 border-l-amber-500 bg-amber-500/5",
              )}
            >
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-mono text-sm font-semibold text-foreground">
                  {group.procCode}
                </span>
                {duplicated && (
                  <span
                    className="rounded-full border border-amber-500/40 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400"
                    data-testid="fees-duplicate-badge"
                  >
                    {group.conflicting
                      ? `listed ${group.rows.length} times at different fees`
                      : `listed ${group.rows.length} times`}
                  </span>
                )}
              </div>

              {/* Side by side, so the disagreement is one glance rather than
                  forty rows of scrolling. */}
              <div className="mt-2 space-y-2">
                {group.rows.map((row) => (
                  <RowCard
                    key={row.rowId}
                    row={row}
                    batch={batch}
                    decidable={decidable}
                    highlighted={highlighted === row.rowId}
                    registerRow={registerRow}
                    onSettled={onSettled}
                  />
                ))}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** One parsed fee: the amount, its warnings, its raw line, and its decision. */
function RowCard({
  row,
  batch,
  decidable,
  highlighted,
  registerRow,
  onSettled,
}: {
  row: FeesImportRow;
  batch: FeesImportBatch;
  decidable: boolean;
  highlighted: boolean;
  registerRow: (rowId: string, el: HTMLDivElement | null) => void;
  onSettled: () => void;
}) {
  const warned = row.warnings.length > 0;
  return (
    <div
      ref={(el) => registerRow(row.rowId, el)}
      data-testid="fees-row"
      data-row-id={row.rowId}
      data-warned={warned ? "true" : "false"}
      data-unresolved={isUnresolved(row) ? "true" : "false"}
      data-highlighted={highlighted ? "true" : "false"}
      className={cn(
        "scroll-mt-16 rounded-md px-3 py-2",
        warned ? "border border-amber-500/40 bg-amber-500/5" : "bg-muted/40",
        // The warning navigation POINTS at a row rather than selecting it: a
        // ring sits on top of whatever the row already says, where a background
        // colour would compete with the amber that means "warned".
        highlighted && "ring-2 ring-foreground ring-offset-2 ring-offset-background",
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <FeeCell row={row} batch={batch} decidable={decidable} onSettled={onSettled} />
        {warned && (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-400">
            <AlertTriangle size={12} aria-hidden />
            {row.warnings.length === 1 ? "1 warning" : `${row.warnings.length} warnings`}
          </span>
        )}
      </div>

      {warned && (
        <>
          <ul className="mt-1.5 space-y-1">
            {row.warnings.map((warning, i) => (
              <li
                key={`${warning.code}-${i}`}
                className="text-sm text-muted-foreground"
                data-testid="fees-row-warning"
              >
                {warning.message}
                <span className="ml-2 font-mono text-xs opacity-70">{warning.code}</span>
              </li>
            ))}
          </ul>
          {/* THE RAW LINE. A warning without the line it came from is a warning
              nobody can judge — this is the whole reason the column is stored,
              and it is what somebody reads before typing a corrected fee
              above. */}
          <pre
            className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded border border-border bg-background px-2 py-1.5 font-mono text-xs text-muted-foreground"
            data-testid="fees-row-raw-line"
          >
            {row.rawLine}
          </pre>

          {/* THE DECISION. A warned row blocks the post until somebody who has
              read the line above says whether the number is the fee this office
              holds. The gate is enforced server-side; these are the controls,
              not the guard. */}
          <RowDecision
            office={batch.office}
            batchId={batch.batchId}
            row={row}
            editable={decidable}
            onDecided={onSettled}
          />
        </>
      )}
    </div>
  );
}

/**
 * The fee itself — click to correct it.
 *
 * ── WHAT IT SHOWS ──────────────────────────────────────────────────────────
 * The EFFECTIVE fee, large: the number that will actually be written. Where
 * somebody has corrected it, the parsed value follows, struck through, so both
 * are visible at once. "Edited from $1,150.00" is what makes a corrected row
 * reviewable by eye rather than only by query — and the person who edited it is
 * named, because a correction with no author is a correction nobody can ask
 * about.
 *
 * ── WHY A BUTTON, NOT AN ALWAYS-LIVE INPUT ─────────────────────────────────
 * Four hundred live inputs is four hundred things to fat-finger while
 * scrolling, on a screen whose purpose is reading. The button is the decision
 * to change something; the input appears once that decision is made.
 *
 * ── MOBILE ─────────────────────────────────────────────────────────────────
 * `inputMode="decimal"` brings up the number pad, the controls clear a 40px
 * touch target, and Save and Cancel are real buttons. Enter and Escape are the
 * fast path for somebody at a desk, not the only path: an edit box that could
 * only be committed with a key a phone keyboard hides would be unusable for
 * half the people who need it.
 *
 * ── REFUSING RATHER THAN GUESSING ──────────────────────────────────────────
 * `parseFeeInput` returns null for anything it cannot read exactly, and the box
 * says so instead of rounding. The server refuses the same values; this is the
 * courtesy that saves a round trip, not the guard.
 */
function FeeCell({
  row,
  batch,
  decidable,
  onSettled,
}: {
  row: FeesImportRow;
  batch: FeesImportBatch;
  decidable: boolean;
  onSettled: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const effective = effectiveFeeCents(row);
  const edited = isEdited(row);

  const open = () => {
    setDraft(feeInputValue(effective));
    setError(null);
    setEditing(true);
  };

  const cancel = () => {
    setEditing(false);
    setError(null);
  };

  const commit = async () => {
    const cents = parseFeeInput(draft);
    if (cents === null) {
      setError("Type an amount like 920 or 920.00.");
      return;
    }
    // Re-typing the number that is already there is not an edit. Recording one
    // would put somebody's name against a decision they did not make.
    if (edited && cents === effective) {
      cancel();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await decideRow(batch.office, batch.batchId, row.rowId, {
        decision: "edited",
        feeCents: cents,
      });
      setEditing(false);
      onSettled();
    } catch (err: unknown) {
      setError(err instanceof FeesApiError ? err.message : "Could not save that");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  if (editing) {
    return (
      <span className="flex flex-wrap items-center gap-2" data-testid="fees-fee-editor">
        <span className="text-base font-semibold text-muted-foreground">$</span>
        <input
          ref={inputRef}
          type="text"
          inputMode="decimal"
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commit();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          aria-label={`Fee for ${row.procCode}`}
          data-testid="fees-fee-input"
          className="min-h-[40px] w-28 rounded-md border border-border bg-background px-2 text-base font-semibold tabular-nums text-foreground"
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => void commit()}
          data-testid="fees-fee-save"
          className="min-h-[40px] rounded-md bg-foreground px-3 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          Save
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={cancel}
          data-testid="fees-fee-cancel"
          className="min-h-[40px] rounded-md border border-border px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
        >
          Cancel
        </button>
        {error !== null && (
          <span className="text-xs text-destructive" data-testid="fees-fee-error">
            {error}
          </span>
        )}
      </span>
    );
  }

  const amount = (
    <span
      className="text-base font-semibold tabular-nums text-foreground"
      data-testid="fees-row-amount"
    >
      {formatFeeCents(effective)}
    </span>
  );

  return (
    <span className="flex flex-wrap items-baseline gap-2" data-testid="fees-fee-cell">
      {decidable ? (
        <button
          type="button"
          onClick={open}
          aria-label={`Edit the fee for ${row.procCode}`}
          data-testid="fees-fee-edit"
          className="group inline-flex min-h-[32px] items-center gap-1.5 rounded-md px-1 transition-colors hover:bg-accent"
        >
          {amount}
          <Pencil
            size={13}
            aria-hidden
            className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
          />
        </button>
      ) : (
        amount
      )}

      {/* BOTH NUMBERS, ALWAYS. The struck-through parsed value is what makes an
          edit reviewable by somebody who did not make it. */}
      {edited && (
        <span className="text-xs text-muted-foreground" data-testid="fees-row-edited-from">
          edited from <s className="tabular-nums">{formatFeeCents(row.feeCents)}</s>
          {row.decidedBy ? ` · ${row.decidedBy}` : ""}
        </span>
      )}
    </span>
  );
}

/**
 * Accept, or exclude, ONE warned row.
 *
 * `accepted` — the reader looked at the raw line above and confirms the parsed
 *              value is the fee this office holds.
 * `edited`   — it is not, and they typed the one that is. Recorded by the fee
 *              cell above rather than by a button here, because correcting the
 *              number IS the decision; a separate Edit button would ask for the
 *              same intent twice.
 * `excluded` — it is not, and the row must never be written. The database
 *              refuses to store a FeeNum on an excluded row, so the promise is
 *              kept there rather than by a filter somebody might reorder.
 * `reset`    — offered only once a decision exists, because a decision made by
 *              mistake must be undoable BEFORE the post. Afterwards the only
 *              remedy is a rollback.
 *
 * Clean rows never render this: the gate is warned-AND-undecided, not a
 * checklist, so a hundred-row file with two flagged rows needs exactly two
 * clicks.
 */
function RowDecision({
  office,
  batchId,
  row,
  editable,
  onDecided,
}: {
  office: FeesOfficeId;
  batchId: string;
  row: FeesImportRow;
  editable: boolean;
  onDecided: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decision = row.decision ?? "pending";

  const choose = async (verdict: FeesRowVerdict) => {
    setBusy(true);
    setError(null);
    try {
      await decideRow(office, batchId, row.rowId, verdict);
      onDecided();
    } catch (err: unknown) {
      setError(err instanceof FeesApiError ? err.message : "Could not record that");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="fees-row-decision" data-decision={decision}>
      {decision === "pending" ? (
        <>
          <span className="text-xs text-muted-foreground">Is this the fee you hold?</span>
          <button
            type="button"
            disabled={!editable || busy}
            onClick={() => void choose({ decision: "accepted" })}
            data-testid="fees-row-accept"
            className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
          >
            Accept
          </button>
          <button
            type="button"
            disabled={!editable || busy}
            onClick={() => void choose({ decision: "excluded" })}
            data-testid="fees-row-exclude"
            className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
          >
            Do not post it
          </button>
          {editable && (
            <span className="text-xs text-muted-foreground">
              …or click the amount to correct it.
            </span>
          )}
        </>
      ) : (
        <>
          <span
            className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs font-medium text-foreground"
            data-testid="fees-row-decided"
          >
            {decision === "accepted" ? "Accepted" : decision === "edited" ? "Edited" : "Excluded"}
            {row.decidedBy ? ` · ${row.decidedBy}` : ""}
          </span>
          {editable && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void choose({ decision: "reset" })}
              data-testid="fees-row-reset"
              className="text-xs font-medium text-muted-foreground underline underline-offset-4 transition-colors hover:text-foreground disabled:opacity-50"
            >
              Undo
            </button>
          )}
        </>
      )}
      {error !== null && (
        <span className="text-xs text-destructive" data-testid="fees-row-decision-error">
          {error}
        </span>
      )}
    </div>
  );
}

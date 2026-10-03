/**
 * SAVE FOR TOMORROW, AND SET ASIDE — the two ways a check leaves today's list.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THREE STATES THAT LOOK ALIKE AND ARE NOT
 * ═════════════════════════════════════════════════════════════════════════════
 *   SAVED    "I am coming back to this." Still needs attention, still counted,
 *            still everywhere it was. The only thing it changes is that Today
 *            can lead with it. Opening the check UN-SAVES it, because a note
 *            saying "come back to this" has done its job the moment she is
 *            looking at it.
 *
 *   SET ASIDE "Nobody is coming back to this." Out of the attention counts, off
 *            Today, findable under its own filter, and REVERSIBLE by anybody who
 *            can set one aside. §15.2 finding 5: two checks on staging have sat
 *            in "needs attention" permanently — both matched, both checked over,
 *            both pointing at claims a walk's unwind deleted — because nothing in
 *            the product could retire them. A queue whose most important signal
 *            decays with every walk stops being read.
 *
 *   RETIRED  a POSTING's terminal state, elsewhere, on the Posting screen.
 *            Decides that money will NEVER reach a chart through CareIN, cannot
 *            be undone, and is gated on `rcm.post` beside the button that writes
 *            to charts. Nothing here can reach it.
 *
 * The visual language keeps them apart: saved is sky, set aside is muted, and
 * the rose tone on these screens belongs to "Stuck — needs you" alone — so a
 * check somebody deliberately put down never reads as a problem.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SETTING ASIDE ASKS FOR A REASON AND MEANS IT
 * ─────────────────────────────────────────────────────────────────────────────
 * The server refuses without one (400 `SET_ASIDE_REASON_REQUIRED`) and refuses
 * `Something else` without a sentence (400 `SET_ASIDE_NOTE_REQUIRED`), so this
 * dialog demands both rather than letting somebody find out by being refused. A
 * check dropped out of the one queue that means "a human is needed here", with
 * no account of why, is the queue quietly losing work nobody can later explain.
 *
 * Saving for tomorrow asks for nothing. The friction of demanding a sentence at
 * 4:55pm is exactly the friction that would stop anybody saving anything.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * BOTH PANELS ARE ANCHORED, AND NEITHER IS A MODAL (Stage C, §8)
 * ═════════════════════════════════════════════════════════════════════════════
 * They open in the normal flow, directly under the button that raised them, and
 * they push the page down rather than sitting on top of it. That is the design's
 * point and it is not a stylistic preference:
 *
 * **NEITHER MAY COVER THE CLAIM LIST UNDERNEATH.** Deciding to set a check aside
 * is deciding about the claims on it — "the claims aren't in Open Dental any
 * more" is a claim about rows a modal would have just hidden. A dialog that
 * covers its own evidence asks somebody to decide from memory.
 *
 * So: no `position: fixed`, no `absolute`, no overlay, no portal. The claim list
 * stays where it is, below, and stays readable while the panel is open.
 * `tests/rcm-stage-c.test.tsx` asserts that STRUCTURALLY — the panel carries no
 * out-of-flow positioning and the claim list follows it in document order —
 * rather than by measuring pixels, which would pass on a layout that had gone
 * wrong in a browser nobody ran the test in.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SLICE 2: EACH PANEL IS ANCHORED TO *ITS OWN* BUTTON, BY GRID COLUMN
 * ─────────────────────────────────────────────────────────────────────────────
 * Both panels used to open full-width under the whole row, so a reader watching
 * the page change saw one box appear in the same place whichever button she had
 * pressed — a moment of "did I press the right one?" every single time, on the
 * one control here that is hard to explain afterwards.
 *
 * The row is now a GRID, and the panel starts in the column of the button that
 * raised it: *Save for tomorrow* opens from the first column, *Set aside* from
 * the second, each spanning to the right edge so there is room for the copy. Its
 * left edge lines up with its button, which is the whole of what "anchored"
 * buys — the eye follows the press.
 *
 * This is layout, not positioning: `col-start` is still ordinary in-flow grid
 * placement, so every word of the paragraph above still holds and the structural
 * test still passes unchanged.
 */
import { useState } from "react";
import {
  AlertTriangle,
  Archive,
  Bookmark,
  BookmarkX,
  Loader2,
  Undo2,
  XCircle,
} from "lucide-react";
import {
  archiveRemittance,
  parkRemittance,
  restoreRemittance,
  setAsideRemittance,
  unarchiveRemittance,
  RcmApiError,
  SET_ASIDE_COPY,
  SET_ASIDE_REASONS,
  type RcmOfficeId,
  type Remittance,
  type SetAsideReason,
} from "@/features/rcm/api";
import { officeDay } from "@/features/rcm/time";
import DisabledReason from "@/components/rcm/DisabledReason";

/** The same ceiling the server enforces (`MAX_WORKLIST_NOTE`). */
const MAX_NOTE = 500;

/**
 * Does this check have posting history the SCREEN can already see?
 *
 * The server's never-archive-posted guard is the authority — it re-reads the
 * posting queue inside the archive transaction and refuses by name. This is
 * the same question answered from the row in hand, so the control can say why
 * it is greyed BEFORE a round trip rather than after: a claim somebody
 * approved (`queuedClaimCount`), a posting that ran and stopped
 * (`posting_failed`), or one that finished (`claims_posted` / `claims_queued`).
 */
function hasPostingHistory(r: Remittance): boolean {
  return (
    r.queuedClaimCount > 0 ||
    r.attentionReasons.includes("posting_failed") ||
    r.attentionObservations.includes("claims_posted") ||
    r.attentionObservations.includes("claims_queued")
  );
}

export default function CheckWorklistActions({
  office,
  remittance: r,
  onChanged,
}: {
  office: RcmOfficeId;
  remittance: Remittance;
  /** Re-read the check, so every count and chip on the page moves together. */
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<null | "park" | "aside" | "restore" | "archive" | "unarchive">(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | "park" | "aside" | "archive">(null);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState<SetAsideReason>("target_gone");
  /** The archive dialog's own required line — never shared with `note`. */
  const [archiveReason, setArchiveReason] = useState("");

  const setAside = r.setAsideAt != null;
  const archived = r.archivedAt != null;
  const postingHistory = hasPostingHistory(r);

  async function run(
    kind: "park" | "aside" | "restore" | "archive" | "unarchive",
    fn: () => Promise<unknown>,
  ) {
    setBusy(kind);
    setError(null);
    try {
      await fn();
      setDialog(null);
      setNote("");
      setArchiveReason("");
      onChanged();
    } catch (err) {
      // The server's own sentence — it names the missing field, which is the
      // only thing a person can act on.
      setError(
        err instanceof RcmApiError || err instanceof Error
          ? err.message
          : "That could not be saved.",
      );
    } finally {
      setBusy(null);
    }
  }

  // ── A check somebody has archived — off the board, one click back ─────────
  if (archived) {
    return (
      <section
        className="mt-4 rounded-xl border border-border bg-muted/30 p-4"
        data-testid="check-archived-banner"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-1.5 text-base font-semibold text-foreground">
              <Archive size={15} />
              Archived
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {r.archivedReason ?? "No reason recorded"}
              {r.archivedBy ? ` · ${r.archivedBy}` : ""}
              {r.archivedAt ? ` · ${officeDay(r.archivedAt, office)}` : ""}
            </p>
            <p className="mt-1 text-xs text-muted-foreground" data-testid="check-archived-note">
              It was never posted — only a check with no posting history can be archived. Nothing
              was deleted, and the same file can be brought in again while this sits here.
            </p>
          </div>
          <button
            onClick={() => run("unarchive", () => unarchiveRemittance(office, r.batchId))}
            disabled={busy !== null}
            data-testid="check-unarchive"
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            {busy === "unarchive" ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Undo2 size={14} />
            )}
            Bring it back
          </button>
        </div>
        {error && <Problem message={error} />}
      </section>
    );
  }

  // ── A check somebody has already set aside ────────────────────────────────
  if (setAside) {
    const copy = SET_ASIDE_COPY[r.setAsideReason as SetAsideReason];
    return (
      <section
        className="mt-4 rounded-xl border border-border bg-muted/30 p-4"
        data-testid="check-set-aside-banner"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-1.5 text-base font-semibold text-foreground">
              <XCircle size={15} />
              Set aside
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {copy ? copy.label : (r.setAsideReason ?? "No reason recorded")}
              {r.setAsideBy ? ` · ${r.setAsideBy}` : ""}
              {r.setAsideAt ? ` · ${officeDay(r.setAsideAt, office)}` : ""}
            </p>
            {r.setAsideNote && (
              <p className="mt-1 text-sm text-foreground" data-testid="check-set-aside-note">
                “{r.setAsideNote}”
              </p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">
              It is out of the attention counts, not out of the records. Setting it aside
              deleted nothing and wrote nothing to any chart.
            </p>
          </div>
          <button
            onClick={() => run("restore", () => restoreRemittance(office, r.batchId))}
            disabled={busy !== null}
            data-testid="check-restore"
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            {busy === "restore" ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Undo2 size={14} />
            )}
            Put it back
          </button>
        </div>
        {error && <Problem message={error} />}
      </section>
    );
  }

  // ── The ordinary case: three quiet actions ────────────────────────────────
  return (
    <section
      className="mt-4 grid items-start gap-2 sm:grid-cols-[max-content_max-content_max-content_minmax(0,1fr)]"
      data-testid="check-worklist-actions"
    >
      <button
        onClick={() => {
          setError(null);
          setDialog(dialog === "park" ? null : "park");
        }}
        aria-expanded={dialog === "park"}
        data-testid="check-park"
        className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
      >
        <Bookmark size={14} />
        Save for tomorrow
      </button>
      <button
        onClick={() => {
          setError(null);
          setDialog(dialog === "aside" ? null : "aside");
        }}
        aria-expanded={dialog === "aside"}
        data-testid="check-set-aside"
        className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <BookmarkX size={14} />
        Set aside
      </button>
      {/*
        ── ARCHIVE — the third action, and the narrowest ─────────────────────
        Only for a check with no posting history: the server refuses anything
        else by name, and this control greys itself on the same facts the row
        already carries so the refusal arrives before the round trip. Greyed
        with its reason beside it, per the module's disabled-controls rule.
      */}
      <div className="flex flex-col items-start gap-1">
        <button
          onClick={() => {
            setError(null);
            setDialog(dialog === "archive" ? null : "archive");
          }}
          aria-expanded={dialog === "archive"}
          disabled={postingHistory}
          data-testid="check-archive"
          className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Archive size={14} />
          Archive
        </button>
        {postingHistory && (
          /* SHORT ON PURPOSE: this renders on every check with posting
             history, so it lives inside those screens' pinned word budgets.
             The server's 409 carries the full sentence, naming the state. */
          <DisabledReason testId="check-archive-blocked">
            This check has posting history. Use Set aside instead.
          </DisabledReason>
        )}
      </div>
      <span className="self-center text-xs text-muted-foreground">
        Nothing here writes to Open Dental.
      </span>

      {/* ── Save for tomorrow — anchored under its own button (column 1) ───── */}
      {dialog === "park" && (
        <div
          className="rounded-lg border border-border bg-card p-3 sm:col-span-4 sm:col-start-1"
          data-testid="check-park-dialog"
        >
          <p className="text-sm text-muted-foreground">
            Nothing is lost and nothing is hidden. This check stays in every queue it is in —
            saving it only puts it at the top of <strong>Today</strong>, under{" "}
            <strong>Where you left off</strong>, with your line on it. It comes back in one
            click, from there or by opening it.
          </p>
          <label className="mt-2 block text-xs font-medium text-foreground" htmlFor="park-note">
            A line to yourself (optional)
          </label>
          <input
            id="park-note"
            value={note}
            maxLength={MAX_NOTE}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Waiting on the carrier to resend"
            data-testid="check-park-note"
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          />
          <div className="mt-2 flex gap-2">
            <button
              onClick={() =>
                run("park", () => parkRemittance(office, r.batchId, note.trim() || undefined))
              }
              disabled={busy !== null}
              data-testid="check-park-confirm"
              className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-sm font-semibold text-background transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy === "park" && <Loader2 size={14} className="animate-spin" />}
              Save for tomorrow
            </button>
            <button
              onClick={() => setDialog(null)}
              className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            >
              Cancel
            </button>
          </div>
          {error && <Problem message={error} />}
        </div>
      )}

      {/* ── Set aside — anchored under ITS own button (column 2) ───────────── */}
      {dialog === "aside" && (
        <div
          className="rounded-lg border border-border bg-card p-3 sm:col-span-3 sm:col-start-2"
          data-testid="check-set-aside-dialog"
        >
          <p className="text-sm text-muted-foreground">
            <strong className="font-medium text-foreground">
              This says nobody is coming back to it.
            </strong>{" "}
            It goes out of the attention counts and off Today, and it stops being work anybody is
            expected to finish. Nothing is deleted and nothing is written to a chart. It is
            reversible: it comes back from the <strong>Set aside</strong> tab on Checks, in one
            click, still carrying the reason you give it here.
          </p>
          <fieldset className="mt-2">
            <legend className="text-xs font-medium text-foreground">Why?</legend>
            <div className="mt-1 space-y-1">
              {SET_ASIDE_REASONS.map((value) => (
                <label
                  key={value}
                  className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 text-sm transition-colors hover:bg-muted/60"
                >
                  <input
                    type="radio"
                    name="set-aside-reason"
                    value={value}
                    checked={reason === value}
                    onChange={() => setReason(value)}
                    data-testid={`check-set-aside-reason-${value}`}
                    className="mt-1"
                  />
                  <span>
                    <span className="font-medium text-foreground">
                      {SET_ASIDE_COPY[value].label}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {SET_ASIDE_COPY[value].hint}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="mt-2 block text-xs font-medium text-foreground" htmlFor="aside-note">
            {reason === "other" ? "In a line, what is it? (required)" : "A line about it (optional)"}
          </label>
          <input
            id="aside-note"
            value={note}
            maxLength={MAX_NOTE}
            onChange={(e) => setNote(e.target.value)}
            data-testid="check-set-aside-note-input"
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          />
          <div className="mt-2 flex gap-2">
            <div className="flex flex-col items-start gap-1">
              <button
                onClick={() =>
                  run("aside", () =>
                    setAsideRemittance(office, r.batchId, reason, note.trim() || undefined),
                  )
                }
                // The server refuses this combination anyway; disabling it here
                // means somebody meets the rule while they can still act on it
                // rather than after a round trip.
                disabled={busy !== null || (reason === "other" && note.trim().length === 0)}
                data-testid="check-set-aside-confirm"
                className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-sm font-semibold text-background transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {busy === "aside" && <Loader2 size={14} className="animate-spin" />}
                Set it aside
              </button>
              {/*
                MOVED IN BESIDE THE BUTTON. The same sentence used to sit below
                the whole row, which reads fine and is two ancestors too far
                away for the scan to tie it to the control it explains.
              */}
              {reason === "other" && note.trim().length === 0 && (
                <DisabledReason testId="check-set-aside-needs-note">
                  “Something else” needs your own words — that is the whole of what makes
                  it readable to whoever finds this check later.
                </DisabledReason>
              )}
            </div>
            <button
              onClick={() => setDialog(null)}
              className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            >
              Cancel
            </button>
          </div>

          {error && <Problem message={error} />}
        </div>
      )}

      {/* ── Archive — anchored under ITS own button (column 3) ─────────────── */}
      {dialog === "archive" && (
        <div
          className="rounded-lg border border-border bg-card p-3 sm:col-span-2 sm:col-start-3"
          data-testid="check-archive-dialog"
        >
          <p className="text-sm text-muted-foreground">
            <strong className="font-medium text-foreground">
              This is for a check that was never real work
            </strong>{" "}
            — a test file, the wrong office&rsquo;s, a duplicate caught early. It disappears from
            Today, from these tabs and from every count, and the same file can be brought in again.
            Nothing is deleted: it waits under the <strong>Archived</strong> tab and comes back in
            one click. A check that has ever been posted or queued cannot be archived at all.
          </p>
          <label className="mt-2 block text-xs font-medium text-foreground" htmlFor="archive-reason">
            In a line, why? (required)
          </label>
          <input
            id="archive-reason"
            value={archiveReason}
            maxLength={MAX_NOTE}
            onChange={(e) => setArchiveReason(e.target.value)}
            placeholder="Test upload — not a real check"
            data-testid="check-archive-reason"
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          />
          <div className="mt-2 flex gap-2">
            <div className="flex flex-col items-start gap-1">
              <button
                onClick={() =>
                  run("archive", () => archiveRemittance(office, r.batchId, archiveReason.trim()))
                }
                // The server refuses a blank reason anyway; disabling here means
                // the rule is met while it can still be acted on.
                disabled={busy !== null || archiveReason.trim().length === 0}
                data-testid="check-archive-confirm"
                className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-sm font-semibold text-background transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {busy === "archive" && <Loader2 size={14} className="animate-spin" />}
                Archive it
              </button>
              {archiveReason.trim().length === 0 && (
                <DisabledReason testId="check-archive-needs-reason">
                  The reason is the only account of why this check left the board.
                </DisabledReason>
              )}
            </div>
            <button
              onClick={() => setDialog(null)}
              className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            >
              Cancel
            </button>
          </div>
          {error && <Problem message={error} />}
        </div>
      )}
    </section>
  );
}

function Problem({ message }: { message: string }) {
  return (
    <div
      className="mt-2 flex items-start gap-1.5 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
      data-testid="check-worklist-error"
    >
      <AlertTriangle size={12} className="mt-0.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

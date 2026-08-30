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
 */
import { useState } from "react";
import { AlertTriangle, Bookmark, BookmarkX, Loader2, Undo2, XCircle } from "lucide-react";
import {
  parkRemittance,
  restoreRemittance,
  setAsideRemittance,
  RcmApiError,
  SET_ASIDE_COPY,
  SET_ASIDE_REASONS,
  type RcmOfficeId,
  type Remittance,
  type SetAsideReason,
} from "@/features/rcm/api";
import { officeDay } from "@/features/rcm/time";

/** The same ceiling the server enforces (`MAX_WORKLIST_NOTE`). */
const MAX_NOTE = 500;

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
  const [busy, setBusy] = useState<null | "park" | "aside" | "restore">(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | "park" | "aside">(null);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState<SetAsideReason>("target_gone");

  const setAside = r.setAsideAt != null;

  async function run(kind: "park" | "aside" | "restore", fn: () => Promise<unknown>) {
    setBusy(kind);
    setError(null);
    try {
      await fn();
      setDialog(null);
      setNote("");
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
              It is out of the attention counts, not out of the records. Nothing about it was
              deleted and nothing was written to any chart.
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

  // ── The ordinary case: two quiet actions ──────────────────────────────────
  return (
    <section className="mt-4" data-testid="check-worklist-actions">
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => {
            setError(null);
            setDialog(dialog === "park" ? null : "park");
          }}
          aria-expanded={dialog === "park"}
          data-testid="check-park"
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
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
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <BookmarkX size={14} />
          Set aside
        </button>
        <span className="text-xs text-muted-foreground">
          Neither one writes anything to Open Dental.
        </span>
      </div>

      {/* ── Save for tomorrow ──────────────────────────────────────────────── */}
      {dialog === "park" && (
        <div
          className="mt-2 rounded-lg border border-border bg-card p-3"
          data-testid="check-park-dialog"
        >
          <p className="text-sm text-muted-foreground">
            This check stays in every queue it is in — saving it only puts it at the top of Today,
            under <strong>Where you left off</strong>. Opening it again puts it back on the ordinary
            pile.
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

      {/* ── Set aside ─────────────────────────────────────────────────────── */}
      {dialog === "aside" && (
        <div
          className="mt-2 rounded-lg border border-border bg-card p-3"
          data-testid="check-set-aside-dialog"
        >
          <p className="text-sm text-muted-foreground">
            This takes the check out of the attention counts and off Today. Nothing is deleted,
            nothing is written to a chart, and you or anybody else can put it back in one click.
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
            <button
              onClick={() => setDialog(null)}
              className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            >
              Cancel
            </button>
          </div>
          {reason === "other" && note.trim().length === 0 && (
            <p className="mt-1 text-xs text-muted-foreground" data-testid="check-set-aside-needs-note">
              “Something else” needs your own words — that is the whole of what makes it readable
              to whoever finds this check later.
            </p>
          )}
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

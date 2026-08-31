/**
 * DID THE APP GET THIS CHECK RIGHT? — the shadow-mode comparison (Stage C-2).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS CONTROL EXISTS
 * ═════════════════════════════════════════════════════════════════════════════
 * For the next several weeks the Roland biller works real checks with posting
 * switched off, and puts the same money into Open Dental by hand. The whole
 * point of that period is one question: does what this app worked out match what
 * she would have done?
 *
 * The go-live plan answered that with a spreadsheet she keeps by hand. That is
 * the weakest link in it — it asks a tired person at 9pm to do bookkeeping about
 * her own work, and the first thing that gets dropped is the record, not the
 * work. Then the decision to switch posting on rests on somebody's impression.
 *
 * This is one click, at the moment she already knows the answer, on the screen
 * she is already standing on.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SHE IS CHECKING THE SOFTWARE. SHE IS NOT BEING MEASURED.
 * ─────────────────────────────────────────────────────────────────────────────
 * The one rule the copy in this file keeps. No proportion, no badge, no streak,
 * no "how you did", and the run of matching checks — which IS the number the
 * decision gets made from — is deliberately not shown to her at all. It lives on
 * the admin summary. A run on her screen is a streak, and a streak is a thing
 * people protect rather than report against.
 *
 * `tests/rcm-plain-language.test.ts` holds a second, tighter banned list over
 * this file and `features/rcm/comparison.ts` for exactly that reason.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY "NO" IS AN INLINE FORM AND NOT A DIALOG
 * ─────────────────────────────────────────────────────────────────────────────
 * A modal takes the check off the screen, and the check is what she is answering
 * about — the figures she is comparing against are three inches above this
 * control. A dialog would make her remember them.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT CANNOT AFFECT POSTING
 * ─────────────────────────────────────────────────────────────────────────────
 * One POST that writes six columns on the check's own row. No chart, no money,
 * no posting state, nothing the posting run reads. The server proves it rather
 * than promising it — see `backend/routes/rcm/shadowComparison.test.js`.
 *
 * NO REAL PATIENT DATA anywhere in this file.
 */
import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Check, Loader2, Pencil, X } from "lucide-react";
import type { ComparisonReason, ComparisonTally, RcmOfficeId } from "@/features/rcm/api";
import {
  COMPARISON_COPY,
  COMPARISON_REASONS,
  getComparisonTally,
  recordComparison,
} from "@/features/rcm/api";
import { comparisonReasonLabel, tallySentence } from "@/features/rcm/comparison";
import { officeStamp } from "@/features/rcm/time";

/** The longest line the server will take, mirrored so the box says so first. */
const MAX_NOTE = 500;

export interface CheckComparisonProps {
  office: RcmOfficeId;
  batchId: string;
  /** What is on the row now. Null verdict means nobody has answered. */
  verdict: string | null;
  reason: string | null;
  note: string | null;
  answeredAt: string | null;
  answeredBy: string | null;
  /** How many times it has been answered. Above 1 means somebody changed it. */
  revision: number;
  /**
   * Has this check posted? Then the question is closed and the recorded answer
   * stands — it was an answer about a hand-posting that is now over.
   */
  closed?: boolean;
  /** Re-read the check, so the panel shows what the server actually stored. */
  onRecorded?: () => void;
}

export default function CheckComparison({
  office,
  batchId,
  verdict,
  reason,
  note,
  answeredAt,
  answeredBy,
  revision,
  closed = false,
  onRecorded,
}: CheckComparisonProps) {
  /**
   * Open the "something was off" form when there is no answer yet, or when she
   * presses Change on one. An already-`differed` answer opens PRE-FILLED, so
   * changing the note does not mean retyping the reason.
   */
  const [form, setForm] = useState<{ reason: ComparisonReason | ""; note: string } | null>(null);
  const [saving, setSaving] = useState<null | "same" | "differed">(null);
  const [error, setError] = useState<string | null>(null);
  const [tally, setTally] = useState<ComparisonTally | null>(null);

  /*
   * THE TALLY IS FAILURE-TOLERANT AND NEVER BLOCKS THE ASK.
   *
   * It is the sentence she gets back for clicking, not a precondition for
   * clicking. A read that fails leaves the panel exactly as useful as it was —
   * the question is still there and the answer still records.
   */
  const loadTally = useCallback(() => {
    let cancelled = false;
    getComparisonTally(office).then(
      (t) => {
        if (!cancelled) setTally(t);
      },
      () => {
        if (!cancelled) setTally(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [office]);

  useEffect(() => loadTally(), [loadTally]);

  const answered = verdict === "same" || verdict === "differed";

  async function save(answer: { verdict: "same" } | { verdict: "differed"; reason: ComparisonReason; note: string }) {
    setSaving(answer.verdict);
    setError(null);
    try {
      await recordComparison(office, batchId, answer);
      setForm(null);
      loadTally();
      onRecorded?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That could not be saved just now.");
    } finally {
      setSaving(null);
    }
  }

  const sentence = tally ? tallySentence(tally, office) : null;

  return (
    <section
      className="mt-4 rounded-xl border border-border bg-card p-4"
      data-testid="check-comparison"
    >
      <h3 className="text-base font-semibold text-foreground">
        Did the app get this check right?
      </h3>

      {answered ? (
        <RecordedAnswer
          office={office}
          verdict={verdict as string}
          reason={reason}
          note={note}
          answeredAt={answeredAt}
          answeredBy={answeredBy}
          revision={revision}
          closed={closed}
          onChange={() =>
            setForm(
              verdict === "differed"
                ? { reason: (reason as ComparisonReason) ?? "", note: note ?? "" }
                : { reason: "", note: "" },
            )
          }
          onSame={() => save({ verdict: "same" })}
          saving={saving}
          formOpen={form != null}
        />
      ) : (
        <>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground" data-testid="comparison-ask">
            You&rsquo;re the check on the app right now. Say so either way — it takes one click and
            it&rsquo;s how posting eventually gets switched on.
          </p>
          {form == null && (
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => save({ verdict: "same" })}
                disabled={saving != null}
                data-testid="comparison-same"
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
              >
                {saving === "same" ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Check size={14} />
                )}
                Yes — same as I did by hand
              </button>
              <button
                type="button"
                onClick={() => setForm({ reason: "", note: "" })}
                disabled={saving != null}
                data-testid="comparison-differed"
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
              >
                <X size={14} />
                No — something was off
              </button>
            </div>
          )}
        </>
      )}

      {form != null && (
        <DifferedForm
          value={form}
          onChange={setForm}
          onCancel={() => {
            setForm(null);
            setError(null);
          }}
          onSubmit={(reasonSlug, noteText) =>
            save({ verdict: "differed", reason: reasonSlug, note: noteText })
          }
          saving={saving === "differed"}
        />
      )}

      {error && (
        <p
          className="mt-2 flex items-start gap-1.5 text-sm text-amber-800 dark:text-amber-300"
          data-testid="comparison-error"
        >
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          {error}
        </p>
      )}

      {sentence && (
        <p
          className="mt-3 border-t border-border pt-3 text-sm text-muted-foreground"
          data-testid="comparison-tally"
        >
          {sentence}
        </p>
      )}
    </section>
  );
}

/**
 * WHAT SHE ALREADY SAID, and the way back to changing it.
 *
 * The stamp is here because an answer with no date is one nobody can place
 * against the evening they posted the check by hand. `revision > 1` says so out
 * loud rather than presenting the newest answer as though it were the only one.
 */
function RecordedAnswer({
  office,
  verdict,
  reason,
  note,
  answeredAt,
  answeredBy,
  revision,
  closed,
  onChange,
  onSame,
  saving,
  formOpen,
}: {
  office: RcmOfficeId;
  verdict: string;
  reason: string | null;
  note: string | null;
  answeredAt: string | null;
  answeredBy: string | null;
  revision: number;
  closed: boolean;
  onChange: () => void;
  onSame: () => void;
  saving: null | "same" | "differed";
  formOpen: boolean;
}) {
  const same = verdict === "same";
  return (
    <div className="mt-1" data-testid="comparison-answered">
      <p className="text-sm text-foreground">
        {same
          ? "You marked this the same as you did by hand."
          : `You marked this off — ${comparisonReasonLabel(reason)}.`}
      </p>
      {!same && note && (
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground" data-testid="comparison-note">
          &ldquo;{note}&rdquo;
        </p>
      )}
      <p className="mt-1 text-xs text-muted-foreground" data-testid="comparison-stamp">
        {answeredBy ? `${answeredBy} · ` : ""}
        {officeStamp(answeredAt, office)}
        {revision > 1 ? ` · changed ${revision === 2 ? "once" : `${revision - 1} times`}` : ""}
      </p>

      {closed ? (
        /*
         * THE QUESTION IS CLOSED, AND THE SCREEN SAYS WHY.
         *
         * A control that silently disappears reads as a bug. This check's money
         * is on the chart now, so there is no hand-posting left to compare it
         * against — the answer she gave while there was one is the true one.
         */
        <p className="mt-2 text-xs text-muted-foreground" data-testid="comparison-closed">
          This check has posted, so this answer stands as it is.
        </p>
      ) : (
        !formOpen && (
          <div className="mt-3 flex flex-wrap gap-2">
            {same ? (
              <button
                type="button"
                onClick={onChange}
                disabled={saving != null}
                data-testid="comparison-change"
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
              >
                <Pencil size={13} />
                Actually, something was off
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={onSame}
                  disabled={saving != null}
                  data-testid="comparison-same"
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
                >
                  {saving === "same" ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Check size={14} />
                  )}
                  Actually, it was the same
                </button>
                <button
                  type="button"
                  onClick={onChange}
                  disabled={saving != null}
                  data-testid="comparison-change"
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
                >
                  <Pencil size={13} />
                  Change what you said
                </button>
              </>
            )}
          </div>
        )
      )}
    </div>
  );
}

/**
 * WHAT WAS OFF — the short fixed list, and her own line.
 *
 * Inline, never a dialog: the figures she is comparing against are on this same
 * page, a few inches up.
 *
 * The note is REQUIRED for every reason, not only for "something else" — the
 * server refuses without it (400 COMPARISON_NOTE_REQUIRED), so the form demands
 * it here rather than letting her discover the rule by being refused. "The
 * payment amount" without the two figures is a report nobody can act on in three
 * weeks' time.
 */
function DifferedForm({
  value,
  onChange,
  onCancel,
  onSubmit,
  saving,
}: {
  value: { reason: ComparisonReason | ""; note: string };
  onChange: (next: { reason: ComparisonReason | ""; note: string }) => void;
  onCancel: () => void;
  onSubmit: (reason: ComparisonReason, note: string) => void;
  saving: boolean;
}) {
  const ready = value.reason !== "" && value.note.trim().length > 0;

  return (
    <div
      className="mt-3 rounded-lg border border-border bg-muted/30 p-3"
      data-testid="comparison-form"
    >
      <p className="text-sm font-medium text-foreground">What was off?</p>
      <div className="mt-2 space-y-1.5">
        {COMPARISON_REASONS.map((slug) => (
          <div key={slug} className="flex items-start gap-2">
            <input
              type="radio"
              id={`comparison-reason-${slug}`}
              name="comparison-reason"
              checked={value.reason === slug}
              onChange={() => onChange({ ...value, reason: slug })}
              /*
                A NATIVE RADIO, TOLD WHICH THEME IT IS IN.
                Nothing in this app sets `color-scheme`, so in dark mode Chrome
                paints native controls from the LIGHT scheme — an unchecked radio
                comes out as a solid white disc on a near-black card, which reads
                as selected. `accent-foreground` colours the dot in both themes
                and the scheme keyword fixes the disc. Scoped to this control
                rather than set on the root, because that would change every
                native control in the product and is not this slice's call.
              */
              className="mt-1 accent-foreground dark:[color-scheme:dark]"
              data-testid={`comparison-reason-${slug}`}
            />
            <label htmlFor={`comparison-reason-${slug}`} className="cursor-pointer">
              <span className="text-sm text-foreground">{COMPARISON_COPY[slug].label}</span>
              <span className="block text-xs text-muted-foreground">
                {COMPARISON_COPY[slug].hint}
              </span>
            </label>
          </div>
        ))}
      </div>

      <label
        htmlFor="comparison-note"
        className="mt-3 block text-sm font-medium text-foreground"
      >
        In a line: what did the app have, and what should it have been?
      </label>
      <textarea
        id="comparison-note"
        rows={2}
        maxLength={MAX_NOTE}
        value={value.note}
        onChange={(e) => onChange({ ...value, note: e.target.value })}
        data-testid="comparison-note-input"
        className="mt-1 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground"
      />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!ready || saving}
          onClick={() => onSubmit(value.reason as ComparisonReason, value.note.trim())}
          data-testid="comparison-submit"
          className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-sm font-semibold text-background transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {saving && <Loader2 size={14} className="animate-spin" />}
          Save this
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          data-testid="comparison-cancel"
          className="rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
        >
          Never mind
        </button>
        {!ready && (
          <span className="text-xs text-muted-foreground" data-testid="comparison-form-hint">
            Pick what was off and say it in a line.
          </span>
        )}
      </div>
    </div>
  );
}

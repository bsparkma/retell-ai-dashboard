/**
 * After-Send addenda — shown with the visit once its note is in the chart.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THIS SCREEN MAY AND MAY NOT DO
 * ═════════════════════════════════════════════════════════════════════════════
 * - ADD: anyone signed in, the SAME office-local day the visit note was sent.
 *   Adding writes nothing to Open Dental — the server composes the exact lines
 *   and stores them.
 * - SEND: a separate, human press per addendum, after the full preview is on
 *   screen, then a second press to confirm. The request names the fingerprint
 *   of the preview shown here; the server refuses anything else.
 * - NEVER EDIT: an addendum is additive. Nothing here edits the original note
 *   or an addendum once added.
 *
 * Whether the window is open is the SERVER's answer (`addendumWindow`), never a
 * clock in this component — a client clock would only be a courtesy, and the
 * server refuses on its own clock regardless.
 */
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { ADDENDUM_TEXT_MAX, type AddendumWindow, type HygAddendum } from "@shared/hyg/contract";
import { cn } from "@/lib/utils";

const STATE_LABELS: Record<HygAddendum["state"], string> = {
  Staged: "Not sent to the chart yet",
  Sending: "Sending…",
  Written: "In the chart",
  Failed: "Not sent",
};

function AddendumRow({
  addendum,
  canSend,
  busy,
  onSend,
}: {
  addendum: HygAddendum;
  canSend: boolean;
  busy: boolean;
  onSend: (a: HygAddendum) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const sendable = canSend && (addendum.state === "Staged" || addendum.state === "Failed");
  return (
    <li className="space-y-2 rounded-lg border border-border p-3" data-testid={`hyg-addendum-${addendum.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {addendum.author} · {new Date(addendum.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
        </span>
        <span
          className={cn(
            "rounded px-1.5 py-0.5 font-medium",
            addendum.state === "Written" && "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
            addendum.state === "Failed" && "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200",
          )}
          data-testid="hyg-addendum-state"
        >
          {STATE_LABELS[addendum.state]}
        </span>
      </div>
      {/* THE PREVIEW IS THE WRITE: exactly these lines go to the chart. */}
      <pre
        className="whitespace-pre-wrap break-words rounded bg-muted/50 p-2 font-sans text-sm text-foreground"
        data-testid="hyg-addendum-preview"
      >
        {addendum.preview.join("\n")}
      </pre>
      {addendum.state === "Written" && addendum.writtenRef ? (
        <div className="text-xs text-muted-foreground" data-testid="hyg-addendum-ref">{addendum.writtenRef}</div>
      ) : null}
      {addendum.state === "Failed" && addendum.errorMessage ? (
        <div className="text-xs text-red-700 dark:text-red-300" data-testid="hyg-addendum-error">{addendum.errorMessage}</div>
      ) : null}
      {sendable ? (
        confirming ? (
          <div className="flex flex-wrap items-center gap-2" data-testid="hyg-addendum-confirm">
            <span className="text-sm text-foreground">Send these lines to the Open Dental chart?</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                onSend(addendum);
              }}
              className="min-h-11 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
              data-testid="hyg-addendum-confirm-send"
            >
              Send now
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="min-h-11 rounded-lg border border-border px-4 text-sm"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirming(true)}
            className="min-h-11 w-full rounded-lg border border-primary px-4 text-sm font-medium text-primary disabled:opacity-50 sm:w-auto"
            data-testid="hyg-addendum-send"
          >
            {addendum.state === "Failed" ? "Send to chart again…" : "Send to chart…"}
          </button>
        )
      ) : null}
    </li>
  );
}

export function VisitAddenda({
  addenda,
  window,
  busy,
  onAdd,
  onSend,
}: {
  addenda: readonly HygAddendum[];
  window: AddendumWindow | null;
  busy: boolean;
  /** Resolves true when the server took it, so the box only clears on success. */
  onAdd: (text: string) => Promise<boolean>;
  onSend: (addendum: HygAddendum) => void;
}) {
  const [text, setText] = useState("");
  const open = window?.open === true;
  // Nothing to show before the note is sent and nothing was ever added.
  if (!open && addenda.length === 0) return null;

  return (
    <section className="mt-4 space-y-3 rounded-xl border border-border bg-card p-4" data-testid="hyg-addenda">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Addenda</h2>
        <p className="text-xs text-muted-foreground" data-testid="hyg-addenda-window">
          {open
            ? "Added to the visit record, after the note. The original note is never changed. Each one reaches the chart only when you send it."
            : "Addenda can only be added on the day the visit note was sent. These are read-only now."}
        </p>
      </div>

      {addenda.length > 0 ? (
        <ul className="space-y-2">
          {addenda.map((a) => (
            <AddendumRow key={a.id} addendum={a} canSend={open} busy={busy} onSend={onSend} />
          ))}
        </ul>
      ) : null}

      {open ? (
        <div className="space-y-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={ADDENDUM_TEXT_MAX}
            placeholder="What to add to today's visit record"
            aria-label="Addendum"
            className="min-h-[88px] w-full rounded-lg border border-border bg-background p-2 text-base sm:text-sm"
            data-testid="hyg-addendum-text"
          />
          <button
            type="button"
            disabled={busy || text.trim() === ""}
            onClick={() => {
              void onAdd(text).then((ok) => {
                if (ok) setText("");
              });
            }}
            className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50 sm:w-auto"
            data-testid="hyg-addendum-add"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Add addendum
          </button>
        </div>
      ) : null}
    </section>
  );
}

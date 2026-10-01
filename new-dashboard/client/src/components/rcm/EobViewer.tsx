/**
 * THE EOB, IN PLACE — one viewer, everywhere the document is offered.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * "Open the EOB" used to be `<a target="_blank">`. The reason a biller opens the
 * document is that she doubts a figure on the screen she is looking at — and a
 * new tab takes that screen away at the exact moment she needs to compare the
 * two. She then has to find her way back to a page she was halfway through.
 *
 * Worse, a new tab is where the failure the owner hit on 2026-09-30 can live
 * without leaving a trace: nothing about it is observable to this application.
 * A blocked popup, a tab that downloads instead of rendering, a bare JSON
 * refusal on a white page — all of them look identical from in here, which is
 * why the prod logs carry no record of the attempt at all. An in-page viewer
 * moves the whole exchange inside the app, where a failure has a state, a
 * sentence, and something to press next.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE COMPONENT, THREE SCREENS
 * ─────────────────────────────────────────────────────────────────────────────
 * The confirm step, the claim page and the workbench all offer the document, and
 * all three mount THIS. A biller who has learned the viewer once has learned it
 * everywhere — and a fix to how the document behaves is a fix in one file rather
 * than three that drift.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EVIDENCE, NOT A CONTROL
 * ─────────────────────────────────────────────────────────────────────────────
 * Nothing on the document is clicked to change a figure, and no colour is drawn
 * over it — red and amber are reserved for disagreement, and tinting a scan with
 * our own opinion would be this screen telling a biller what to see on her own
 * paper.
 *
 * The one link out is the escape hatch: open in a new tab, INSIDE the viewer,
 * for the biller who wants it on a second monitor. It is an escape, not the
 * default.
 */
import { useEffect, useRef, useState } from "react";
import { AlertCircle, ExternalLink, FileText, Loader2, X } from "lucide-react";

/** How long to wait for the frame before saying so. */
const LOAD_TIMEOUT_MS = 20_000;

export interface EobViewerProps {
  /** The authorised document URL, or null when this check has no document. */
  href: string | null;
  /** Page to open at, when a caller knows which one a figure came from. */
  page?: number | null;
  /** Rendered above the frame — "1 page · read 30 Sep", say. */
  caption?: string | null;
  /** Height class for the frame. The ONE scroll a side panel may own. */
  heightClass?: string;
  testId?: string;
}

/**
 * The document itself. A caller that wants it collapsible wraps it in
 * `EobViewerPanel` below; this is the frame and its honest states.
 */
export default function EobViewer({
  href,
  page = null,
  caption = null,
  heightClass = "h-[60vh]",
  testId = "eob-viewer",
}: EobViewerProps) {
  const [state, setState] = useState<"loading" | "shown" | "failed">("loading");
  const timer = useRef<number | null>(null);

  /*
   * `src` carries the page fragment, and the KEY carries it too.
   *
   * A PDF viewer does not re-navigate when only the `#page=` fragment changes,
   * so without the key the frame would silently stay on page 1 while the screen
   * claimed to be showing the selected line. Changing the key remounts it.
   */
  const src = href ? `${href}${page && page > 0 ? `#page=${page}` : ""}` : null;

  useEffect(() => {
    if (!src) return;
    setState("loading");
    /*
     * AN IFRAME THAT NEVER LOADS FIRES NO EVENT.
     *
     * `onError` does not fire for a cross-document frame that 404s, 401s, or is
     * blocked — the browser renders the error inside the frame and tells us
     * nothing. So the honest signal is a deadline: if `onLoad` has not arrived
     * by then, say the document could not be shown and offer the way out.
     * Silence is not success.
     */
    timer.current = window.setTimeout(() => setState((s) => (s === "loading" ? "failed" : s)), LOAD_TIMEOUT_MS);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [src]);

  if (!src) {
    /*
     * NO DOCUMENT IS A REAL ANSWER, not an error. An 835 was parsed, not
     * scanned; there is no picture of it and never was.
     */
    return (
      <p className="p-3 text-sm text-muted-foreground" data-testid={`${testId}-none`}>
        There is no document image on this check — it came in as a file the computer read
        directly, so there is nothing to compare against.
      </p>
    );
  }

  return (
    <div data-testid={testId}>
      <div className="flex items-center justify-between gap-2 px-1 pb-2">
        <p className="text-xs text-muted-foreground">
          <FileText size={12} className="mr-1 inline" />
          {caption ?? "The document"}
        </p>
        {/*
          THE ESCAPE HATCH, inside the viewer. Small, secondary, and never the
          default — a second monitor is a real way to work, and taking it away
          would trade one complaint for another.
        */}
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground underline hover:text-foreground"
          data-testid={`${testId}-new-tab`}
        >
          <ExternalLink size={11} />
          Open in a new tab
        </a>
      </div>

      <div className={`relative w-full overflow-hidden rounded-lg border border-border bg-background ${heightClass}`}>
        {state === "loading" ? (
          <div
            className="absolute inset-0 flex items-center justify-center bg-background"
            data-testid={`${testId}-loading`}
          >
            <Loader2 className="animate-spin text-muted-foreground" size={18} />
          </div>
        ) : null}

        {state === "failed" ? (
          /*
           * THE ERROR NAMES WHAT TO DO NEXT, never a bare failure.
           *
           * This is the state that did not exist when the document lived in a
           * new tab: the app could not know the tab had failed, so it could not
           * say anything at all. Now it can, and it says the two things that
           * actually help — try the tab, or carry on against the paper copy.
           */
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background p-6 text-center"
            data-testid={`${testId}-failed`}
          >
            <AlertCircle size={18} className="text-muted-foreground" />
            <p className="max-w-prose text-sm text-muted-foreground">
              The document did not come up here. Open it in a new tab instead — and if that does
              not work either, check the figures against your own copy and say so in the note.
            </p>
            <a
              href={src}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"
              data-testid={`${testId}-failed-new-tab`}
            >
              <ExternalLink size={12} />
              Open in a new tab
            </a>
          </div>
        ) : null}

        <iframe
          key={src}
          title="The EOB document"
          src={src}
          onLoad={() => setState("shown")}
          className="h-full w-full"
          data-testid={`${testId}-frame`}
        />
      </div>
    </div>
  );
}

/**
 * The viewer as a DRAWER — for screens whose main column is the work and whose
 * document is opened on demand (the claim page, the workbench).
 *
 * It opens BESIDE the figures rather than over them: the whole reason to look at
 * the document is to compare it with a number on the screen, and a modal that
 * covers that number would recreate the problem the new tab had.
 */
export function EobViewerPanel({
  href,
  caption,
  open,
  onClose,
  heightClass = "h-[55vh]",
  testId = "eob-panel",
}: {
  href: string | null;
  caption?: string | null;
  open: boolean;
  onClose: () => void;
  /**
   * The frame's height. The workbench passes a taller, viewport-derived class
   * when the panel rides beside the figures at ≥1280px — side by side, the
   * document gets the full column height rather than a fixed strip of it.
   */
  heightClass?: string;
  testId?: string;
}) {
  if (!open) return null;
  return (
    <aside
      className="mt-3 rounded-xl border border-border bg-card p-2"
      data-testid={testId}
      aria-label="The EOB document"
    >
      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={onClose}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          data-testid={`${testId}-close`}
        >
          <X size={12} />
          Close
        </button>
      </div>
      <EobViewer href={href} caption={caption} heightClass={heightClass} testId={`${testId}-viewer`} />
    </aside>
  );
}

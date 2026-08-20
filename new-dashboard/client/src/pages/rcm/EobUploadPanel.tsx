/**
 * The EOB upload affordance on /rcm (Slice 4).
 *
 * DELIBERATELY MINIMAL. A file picker, a drop target, and a list of what has
 * been uploaded with an honest status chip on each row. There is no review UI,
 * no claim detail, no approve button and no way to post anything — those are
 * Slice 7 and Slice 6, and a shell of them here would be a promise the module
 * cannot keep (the same reasoning the Slice 3 landing page was written under).
 *
 * The states it distinguishes, because they are genuinely different things:
 *   uploaded   stored, not yet attempted. When the daily cost cap is spent this
 *              is where a document waits — with the reason, and the reset time.
 *   processing an attempt is in flight.
 *   extracted  proposal rows exist. NOT "posted", NOT "done" — a proposal.
 *   failed     tried, on this document, and it did not work; `message` says why.
 *
 * "Extracted" says "proposal ready" on purpose. Nothing in this slice writes to
 * a patient's chart, and a chip reading "posted" would be a lie about that.
 *
 * WHY THIS POLLS (staging, 2026-08-17). Extraction is asynchronous — the POST
 * returns as soon as the document is stored, and the queue finishes a second or
 * two later. This panel fetched exactly twice, on mount and after an upload, so
 * the post-upload fetch landed ~2s BEFORE extraction committed and the chip sat
 * on "Extracting" forever. The backend was honest throughout; the page simply
 * stopped asking. A UI that keeps asserting a state it no longer knows to be
 * true is the same failure as a server that reports a send it did not make.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { AlertCircle, FileUp, Loader2, PauseCircle, RefreshCw, UploadCloud } from "lucide-react";
import {
  listEobUploads,
  uploadEob,
  RcmApiError,
  RCM_OFFICE_LABELS,
  type EobExtractionState,
  type EobUpload,
  type EobUploadStatus,
  type RcmOfficeId,
} from "@/features/rcm/api";
import { provenanceLabel } from "@/features/rcm/labels";

type LoadState =
  | { kind: "loading" }
  | {
      kind: "loaded";
      uploads: EobUpload[];
      extraction: EobExtractionState;
      /** Optional: a server that predates the OCR slice does not send it. */
      ocr: EobExtractionState | null;
    }
  | { kind: "failed"; message: string };

/** Chip styling per status. Keyed by the closed union, so a new state won't compile. */
const STATUS_CHIP: Record<EobUploadStatus, { label: string; className: string }> = {
  uploaded: {
    label: "Waiting",
    className: "bg-muted text-muted-foreground border-border",
  },
  processing: {
    label: "Extracting",
    className: "bg-blue-500/10 text-blue-600 border-blue-500/30 dark:text-blue-400",
  },
  extracted: {
    label: "Proposal ready",
    className: "bg-emerald-500/10 text-emerald-600 border-emerald-500/30 dark:text-emerald-400",
  },
  failed: {
    label: "Failed",
    className: "bg-destructive/10 text-destructive border-destructive/30",
  },
};

/**
 * Polling budget. The limiter allows 600 requests per 15 minutes PER SIGNED-IN
 * USER (backend/middleware/rateLimit.js) — ~40/min — and the RCM page renders one
 * of these panels per office. A flat 3s poll for the full five minutes would be
 * 100 requests from one panel, and two panels polling at once would eat the
 * entire sustained rate. So: 3s while the answer is plausibly seconds away, then
 * back off. Worst case is ~37 requests per panel per document instead of 100.
 *
 * The measured staging extraction was 3.7s end to end, so the fast phase is the
 * one that does the real work; the slow phase only covers a long document.
 */
const POLL_FAST_MS = 3_000;
const POLL_SLOW_MS = 10_000;
/** How long to stay at the fast interval before backing off. */
const POLL_FAST_WINDOW_MS = 30_000;
/** Hard ceiling on one polling run. Past this we stop and SAY we stopped. */
const POLL_MAX_MS = 5 * 60_000;

/**
 * How long the panel will sit on an unverified "awaiting" row before it offers
 * the manual re-check — REGARDLESS of what the browser claims about visibility.
 *
 * The ceiling above answers "we have been asking for five minutes and it is
 * still not done". This answers a different and more dangerous question: "we
 * have not managed to ASK for two minutes, so what you are reading may already
 * be false." A tab that reports itself hidden produces exactly that state, and
 * before this the user was given no way out of it at all.
 */
const STALE_AFTER_MS = 2 * 60_000;

/**
 * `visibilitychange` and `focus` routinely arrive together when a window comes
 * forward. One wake, one request — the limiter budget is shared across both
 * office panels (see the polling budget note above).
 */
const WAKE_DEBOUNCE_MS = 1_000;

/**
 * Is this row one the server is still going to act on by itself?
 *
 * `processing`  — an attempt is in flight; it resolves in seconds.
 * `uploaded`    — queued, ABOUT to run… but only when `message` is null. The
 *                 worker writes a reason there and leaves the row `uploaded`
 *                 when it declines to start at all: the daily cost cap is spent,
 *                 or no LLM is configured in this environment. Both of those
 *                 wait on a clock (local midnight) or on a deployment, and
 *                 neither gets closer by asking again every three seconds.
 *
 * `extracted` and `failed` are done. Nothing changes them without a new upload.
 */
function isAwaitingExtraction(u: EobUpload): boolean {
  if (u.status === "processing") return true;
  return u.status === "uploaded" && u.message === null;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Local time, or the raw string if it will not parse — never a fabricated date. */
function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export default function EobUploadPanel({ office }: { office: RcmOfficeId }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [gaveUpPolling, setGaveUpPolling] = useState(false);
  /** True once no successful list response has landed for STALE_AFTER_MS. */
  const [stale, setStale] = useState(false);
  const [tabVisible, setTabVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  const inputRef = useRef<HTMLInputElement | null>(null);
  /**
   * When the current polling run started. null = no run in progress.
   *
   * WALL CLOCK, and deliberately NOT paused while the tab is hidden. It used to
   * be: time spent hidden was added back so a backgrounded tab did not burn its
   * five minutes. That is why the panel could never admit it had stopped —
   * see the polling effect below. What the user needs to know is how long the
   * document has been waiting, not how long they have been watching it.
   */
  const pollStartedAt = useRef<number | null>(null);
  /** When the last SUCCESSFUL list response landed. Drives `stale`. */
  const lastPollAt = useRef<number | null>(null);
  /** Last wake, so visibilitychange + focus together make one request. */
  const lastWakeAt = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const page = await listEobUploads(office, { limit: 25 });
      // An answer landed. Whatever it says, the screen is no longer stale.
      lastPollAt.current = Date.now();
      setStale(false);
      setState({
        kind: "loaded",
        uploads: page.uploads,
        extraction: page.extraction,
        ocr: page.ocr ?? null,
      });
    } catch (err: unknown) {
      // The server's own words, the same way the summary card does it.
      const message =
        err instanceof RcmApiError && err.notEntitled
          ? "This practice is not set up for the RCM module."
          : err instanceof Error
            ? err.message
            : "Could not load uploads.";
      setState({ kind: "failed", message });
    }
  }, [office]);

  useEffect(() => {
    setState({ kind: "loading" });
    setNotice(null);
    // A different office is a different run. Never inherit the old one's clock.
    pollStartedAt.current = null;
    lastPollAt.current = null;
    setGaveUpPolling(false);
    setStale(false);
    void refresh();
  }, [refresh]);

  const awaiting = state.kind === "loaded" && state.uploads.some(isAwaitingExtraction);

  /**
   * Someone is looking again — ask NOW, not at the next tick.
   *
   * Waiting for the next 3s/10s tick was what made the incident survive the
   * user coming back to the tab: the answer was already sitting on the server
   * and the page would not ask for it. An immediate request on return is the
   * cheapest possible self-heal, and it is why this is a wake rather than a
   * resume — it does not restart the run's clock or clear a give-up.
   *
   * Only when something is actually awaiting: focus fires constantly, and a
   * panel with nothing in flight has no reason to spend a request on it.
   */
  const wake = useCallback(() => {
    if (!awaiting) return;
    const now = Date.now();
    if (now - lastWakeAt.current < WAKE_DEBOUNCE_MS) return;
    lastWakeAt.current = now;
    void refresh();
  }, [awaiting, refresh]);

  /**
   * A hidden tab is nobody looking, so it does not poll. But `visibilityState`
   * is NOT a reliable signal everywhere: in an embedded browser (Cursor's, and
   * editor webviews generally) it can report `hidden` while the pane is on
   * screen, and `visibilitychange` may never fire when the pane is focused
   * again. That is what produced the 2026-08-19 staging incident.
   *
   * So `focus` is a second, independent wake signal. It deliberately does NOT
   * assert visibility — we do not overrule the browser — it just asks once.
   * Between that, the ceiling below and `stale`, the user always ends up with
   * either the truth or a button, whatever the visibility API claims.
   */
  useEffect(() => {
    if (typeof document === "undefined") return;
    const syncVisibility = () => {
      const visible = document.visibilityState !== "hidden";
      setTabVisible(visible);
      if (visible) wake();
    };
    const onFocus = () => wake();
    document.addEventListener("visibilitychange", syncVisibility);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", syncVisibility);
      window.removeEventListener("focus", onFocus);
    };
  }, [wake]);

  /**
   * One timeout at a time, re-armed by each completed refresh — not a standing
   * interval. An interval fires whether or not the previous request came back;
   * this cannot overlap itself, and it stops dead the moment a response says
   * every row is settled. `state` is a dependency on purpose: a new response IS
   * the signal to decide whether to ask again.
   */
  useEffect(() => {
    if (!awaiting) {
      // Settled. Clear the clock so the NEXT document gets a full five minutes.
      pollStartedAt.current = null;
      if (gaveUpPolling) setGaveUpPolling(false);
      return;
    }
    if (gaveUpPolling) return;

    // The clock runs from the moment there is something to wait for, whether or
    // not anyone is watching it.
    if (pollStartedAt.current === null) pollStartedAt.current = Date.now();
    const elapsed = Date.now() - pollStartedAt.current;

    // THE CEILING IS CHECKED BEFORE THE VISIBILITY GATE, AND THAT ORDER IS THE
    // WHOLE FIX. `if (gaveUpPolling || !tabVisible) return;` used to sit above
    // it, so a hidden tab stopped polling (intended) and could never reach the
    // give-up state (not intended) — leaving the panel asserting "Extracting"
    // forever, with no escape hatch, about a document the backend had finished
    // in 6.6 seconds. Hidden and given-up must compose.
    if (elapsed >= POLL_MAX_MS) {
      setGaveUpPolling(true);
      return;
    }

    if (!tabVisible) {
      // Not polling — but still on a clock, so it can stop ON TIME and say so.
      // Returning with no timer at all is exactly how the panel used to lose the
      // ability to admit anything.
      const timer = window.setTimeout(() => setGaveUpPolling(true), POLL_MAX_MS - elapsed);
      return () => window.clearTimeout(timer);
    }

    const delay = elapsed < POLL_FAST_WINDOW_MS ? POLL_FAST_MS : POLL_SLOW_MS;
    const timer = window.setTimeout(() => void refresh(), delay);
    return () => window.clearTimeout(timer);
  }, [awaiting, gaveUpPolling, tabVisible, refresh, state]);

  /**
   * The staleness watchdog — the escape hatch that does not depend on the
   * visibility API being truthful.
   *
   * The ceiling above says "we asked for five minutes and it is still not
   * done". This says "we have not been able to ask for two minutes", which is
   * the state a mis-reporting embedded browser puts the panel in from the very
   * first tick. It offers the same manual re-check, and it clears itself the
   * moment any answer lands.
   */
  useEffect(() => {
    if (!awaiting) {
      if (stale) setStale(false);
      return;
    }
    const since = lastPollAt.current ?? Date.now();
    const elapsed = Date.now() - since;
    if (elapsed >= STALE_AFTER_MS) {
      if (!stale) setStale(true);
      return;
    }
    const timer = window.setTimeout(() => setStale(true), STALE_AFTER_MS - elapsed);
    return () => window.clearTimeout(timer);
  }, [awaiting, stale, state]);

  /** The manual escape hatch once we have stopped checking on our own. */
  const checkAgain = useCallback(() => {
    pollStartedAt.current = null;
    setGaveUpPolling(false);
    setStale(false);
    void refresh();
  }, [refresh]);

  const send = useCallback(
    async (file: File) => {
      setBusy(true);
      setNotice(null);
      // A new document is a new run, even if an earlier one timed out waiting.
      pollStartedAt.current = null;
      setGaveUpPolling(false);
      setStale(false);
      try {
        const result = await uploadEob(office, file);
        // Say which of the three things happened. "Uploaded" on a re-submission
        // of bytes we already extracted would be a small lie that costs a user
        // a confused minute looking for a second row.
        setNotice(
          result.duplicate && result.requeued
            ? "Already on file — queued for another extraction attempt."
            : result.duplicate
              ? "That exact document is already on file."
              : "Uploaded.",
        );
        await refresh();
      } catch (err: unknown) {
        setNotice(err instanceof Error ? err.message : "Upload failed.");
      } finally {
        setBusy(false);
        // Clear the input so re-picking the SAME file fires a change event.
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [office, refresh],
  );

  const extraction = state.kind === "loaded" ? state.extraction : null;
  const ocr = state.kind === "loaded" ? state.ocr : null;

  return (
    <div
      className="rounded-xl border border-border bg-card p-5 shadow-sm"
      data-testid={`rcm-eob-panel-${office}`}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-foreground">
          {RCM_OFFICE_LABELS[office]} — EOB documents
        </h3>
        {(state.kind === "loading" || busy) && (
          <Loader2 size={14} className="animate-spin text-muted-foreground" />
        )}
      </div>

      {/* The breakers, stated plainly. A paused cap is not an error — the
          document is safe and the work is waiting on a clock.

          TWO BANNERS, NEVER ONE. The two caps guard different resources on
          different meters, and either can be spent while the other is untouched.
          A single "cost cap reached" line would leave "why did my scan not read
          when there is $3 of extraction budget left?" unanswerable from the
          screen — which is the question the split exists to answer. */}
      {extraction?.paused && (
        <div
          className="mt-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400"
          data-testid={`rcm-eob-paused-${office}`}
        >
          <PauseCircle size={16} className="mt-0.5 flex-shrink-0" />
          <span>
            Extraction paused — the daily cap of {formatCents(extraction.capCents)} is used up.
            Uploads are still accepted and will extract after {formatWhen(extraction.resetsAt)}.
          </span>
        </div>
      )}

      {ocr?.paused && (
        <div
          className="mt-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400"
          data-testid={`rcm-eob-ocr-paused-${office}`}
        >
          <PauseCircle size={16} className="mt-0.5 flex-shrink-0" />
          <span>
            Scanned documents paused — the separate daily cap for reading scans (
            {formatCents(ocr.capCents)}) is used up. PDFs with a text layer still extract
            normally; scans are kept and will be read after {formatWhen(ocr.resetsAt)}.
          </span>
        </div>
      )}

      <label
        className={`mt-4 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-6 text-center transition-colors ${
          dragging ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40"
        }`}
        data-testid={`rcm-eob-dropzone-${office}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer?.files?.[0];
          if (file) void send(file);
        }}
      >
        <UploadCloud size={22} className="text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">
          Drop an EOB PDF here, or choose a file
        </span>
        <span className="text-xs text-muted-foreground">PDF only, up to 25MB</span>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          className="sr-only"
          disabled={busy}
          data-testid={`rcm-eob-input-${office}`}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void send(file);
          }}
        />
      </label>

      {notice && (
        <p className="mt-3 text-sm text-muted-foreground" data-testid={`rcm-eob-notice-${office}`}>
          {notice}
        </p>
      )}

      {state.kind === "failed" && (
        <div
          className="mt-4 flex items-start gap-2 text-sm text-destructive"
          data-testid={`rcm-eob-error-${office}`}
        >
          <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
          <span>{state.message}</span>
        </div>
      )}

      {state.kind === "loaded" &&
        (state.uploads.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground" data-testid={`rcm-eob-empty-${office}`}>
            No EOB documents uploaded for this office yet.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-border" data-testid={`rcm-eob-list-${office}`}>
            {state.uploads.map((u) => (
              <li key={u.uploadId} className="py-3" data-testid={`rcm-eob-row-${u.uploadId}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <FileUp size={14} className="flex-shrink-0 text-muted-foreground" />
                      <span className="truncate text-sm font-medium text-foreground">
                        {u.filename}
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {formatWhen(u.uploadedAt)}
                      {u.fileSizeBytes !== null && ` · ${formatBytes(u.fileSizeBytes)}`}
                      {/* HOW it was read, once there is an answer. Nothing is
                          shown before extraction: "not read yet" is the truth
                          there, and a guess would be worse than a blank. */}
                      {provenanceLabel(u) && (
                        <span data-testid={`rcm-eob-provenance-${u.uploadId}`}>
                          {" · "}
                          {provenanceLabel(u)}
                        </span>
                      )}
                    </div>
                  </div>
                  <span
                    className={`flex-shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_CHIP[u.status].className}`}
                    data-testid={`rcm-eob-status-${u.uploadId}`}
                  >
                    {STATUS_CHIP[u.status].label}
                  </span>
                </div>
                {u.message && (
                  <p
                    className={`mt-1.5 text-xs ${u.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}
                    data-testid={`rcm-eob-message-${u.uploadId}`}
                  >
                    {u.message}
                  </p>
                )}
                {/* Slice 6a: an extracted document is no longer a dead end. The
                    batch it produced is where a biller can actually work it.
                    Only shown when there IS one — an upload still waiting on the
                    cost cap has nothing to open, and a link that led nowhere
                    would be the same lie as a chip reading "Extracting" after
                    the page stopped asking. */}
                {u.resultBatchId && (
                  <Link
                    href={`/rcm/remittances/${u.resultBatchId}`}
                    className="mt-1.5 inline-block text-xs font-medium text-foreground underline-offset-2 hover:underline"
                    data-testid={`rcm-eob-open-${u.uploadId}`}
                  >
                    Open the remittance →
                  </Link>
                )}
              </li>
            ))}
          </ul>
        ))}

      {/* We stopped checking, or we have not managed to check. Either way SAY
          so, rather than leaving a chip that reads "Extracting" long after the
          page stopped knowing that to be true. Two different reasons, two
          different sentences — "we gave up waiting" and "we cannot see" are not
          the same thing to the person reading them. */}
      {awaiting && (gaveUpPolling || stale) && (
        <div
          className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 p-3"
          data-testid={`rcm-eob-stalled-${office}`}
        >
          <span className="text-xs text-muted-foreground">
            {gaveUpPolling
              ? "Still not finished after 5 minutes — this page stopped checking on its own."
              : "This page has not been able to check for a couple of minutes — what you see may be out of date."}
          </span>
          <button
            type="button"
            onClick={checkAgain}
            className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted"
            data-testid={`rcm-eob-recheck-${office}`}
          >
            <RefreshCw size={12} />
            Check again
          </button>
        </div>
      )}

      {/* Spend, shown even when neither cap is reached. A cost rail nobody can
          see is a cost rail nobody trusts — and TWO lines rather than a sum,
          because a single total would hide which one is about to stop the work.
          They are printed adjacently so the difference is obvious without
          anybody having to know there are two Azure resources behind them. */}
      {(extraction || ocr) && (
        <div className="mt-4 space-y-0.5">
          {extraction && !extraction.paused && (
            <p className="text-xs text-muted-foreground" data-testid={`rcm-eob-spend-${office}`}>
              Extraction spend today: {formatCents(extraction.usedCents)} of{" "}
              {formatCents(extraction.capCents)}.
            </p>
          )}
          {ocr && !ocr.paused && (
            <p className="text-xs text-muted-foreground" data-testid={`rcm-eob-ocr-spend-${office}`}>
              Scan-reading (OCR) spend today: {formatCents(ocr.usedCents)} of{" "}
              {formatCents(ocr.capCents)}
              {typeof ocr.pagesRead === "number" && ` · ${ocr.pagesRead} page${ocr.pagesRead === 1 ? "" : "s"} read`}. A
              separate cap from the extraction one.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

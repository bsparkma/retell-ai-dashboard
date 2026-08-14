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
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, FileUp, Loader2, PauseCircle, UploadCloud } from "lucide-react";
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

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; uploads: EobUpload[]; extraction: EobExtractionState }
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
  const inputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const page = await listEobUploads(office, { limit: 25 });
      setState({ kind: "loaded", uploads: page.uploads, extraction: page.extraction });
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
    void refresh();
  }, [refresh]);

  const send = useCallback(
    async (file: File) => {
      setBusy(true);
      setNotice(null);
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

      {/* The breaker, stated plainly. A paused cap is not an error — the
          document is safe and the work is waiting on a clock. */}
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
              </li>
            ))}
          </ul>
        ))}

      {/* Spend, shown even when the cap is not reached. A cost rail nobody can
          see is a cost rail nobody trusts. */}
      {extraction && !extraction.paused && (
        <p className="mt-4 text-xs text-muted-foreground" data-testid={`rcm-eob-spend-${office}`}>
          Extraction spend today: {formatCents(extraction.usedCents)} of{" "}
          {formatCents(extraction.capCents)}.
        </p>
      )}
    </div>
  );
}

/**
 * /fees — the fee schedule import list, and the upload that feeds it.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE ONE RULE THIS SCREEN IS BUILT AROUND
 * ═════════════════════════════════════════════════════════════════════════════
 * A file that would not parse must never look like a file that vanished.
 *
 * The server stores every upload — a failed parse becomes a `failed` batch
 * carrying the reason, the filename, the hash and who uploaded it — precisely
 * so "I uploaded it and nothing happened" cannot be the outcome. This page's
 * job is to show that. A refusal renders the server's own sentence AND its
 * code, and a 422 additionally renders the stored batch, so the reader can see
 * the thing that was recorded rather than being told to try again.
 *
 * Every other failure shape is rendered the same way, from the same fields:
 *   413 FILE_TOO_LARGE          over the 10MB ceiling
 *   415 UNSUPPORTED_FILE_TYPE   neither PDF nor CSV; refused before any parse,
 *                               so there is NO batch — and the page must not
 *                               imply one was kept
 *   422 <parse code>            a real parse failure; the batch IS kept
 *   400 NO_FILE / FILE_TOO_SMALL / INVALID_UPLOAD
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * OFFICE: THE LIST FANS OUT, THE UPLOAD DOES NOT
 * ═════════════════════════════════════════════════════════════════════════════
 * Office comes from the global OfficeContext like every other page. But the two
 * halves of this screen want different things from it, and conflating them
 * would be a bug in one direction or the other:
 *
 *   THE LIST, under "All offices", fetches BOTH and labels each row. Reading
 *   "what has this practice imported lately" across locations is a reasonable
 *   question and the answer is unambiguous, because each row says which office
 *   it belongs to.
 *
 *   THE UPLOAD always requires a concrete office. Roland and Riley hold
 *   DIFFERENT contracts with the same payers, so a schedule filed against the
 *   wrong one would eventually reprice a practice against terms it never
 *   agreed to. There is no sensible default and guessing is the expensive kind
 *   of wrong — so under "All" the upload control asks the user to pick, and
 *   stays disabled until they do. The server would refuse anyway (it takes
 *   `?office=` and validates it); this is the affordance, not the guard.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * NOTHING HERE REACHES OPEN DENTAL
 * ═════════════════════════════════════════════════════════════════════════════
 * Not to write, and not to read. Uploading a schedule parses it and stores the
 * result; posting it into a practice's fee table is a later slice. The preview
 * page says so on its face.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import {
  AlertTriangle,
  CheckCircle2,
  FileSpreadsheet,
  FileText,
  Loader2,
  Upload,
  XCircle,
} from "lucide-react";

import { useOffice, ALL_OFFICES } from "@/contexts/OfficeContext";
import {
  listImports,
  uploadImport,
  sourceTypeFromFilename,
  formatBytes,
  FeesApiError,
  FEES_OFFICE_IDS,
  FEES_OFFICE_LABELS,
  isFeesOfficeId,
  type FeesImportBatch,
  type FeesOfficeId,
} from "@/features/fees/api";
import { cn } from "@/lib/utils";

/** The server's own ceiling, restated for the hint text. Kept in one place. */
const MAX_UPLOAD_MB = 10;

type ListState =
  | { kind: "loading" }
  | { kind: "ready"; batches: FeesImportBatch[] }
  | { kind: "error"; error: FeesApiError };

/**
 * What the upload control is currently doing.
 *
 * `refused` holds the SERVER's answer, never a message this page invented — the
 * whole value of a structured refusal is lost if the client paraphrases it.
 */
type UploadState =
  | { kind: "idle" }
  | { kind: "uploading"; filename: string }
  | { kind: "done"; batch: FeesImportBatch }
  | { kind: "refused"; error: FeesApiError };

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

export default function FeesImports() {
  const { office: selection, offices, loading: rosterLoading, error: rosterError } = useOffice();

  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [upload, setUpload] = useState<UploadState>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  /**
   * The office the UPLOAD targets when the global selection is "All".
   *
   * Deliberately NOT written back to the global selection: picking a target for
   * one upload is not the same act as changing what the whole app is scoped to,
   * and quietly doing the second when somebody asked for the first is how a
   * screen surprises a person.
   */
  const [uploadOffice, setUploadOffice] = useState<FeesOfficeId | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  /** Bumped to refetch the list after a successful upload. */
  const [reloadToken, setReloadToken] = useState(0);

  const allSelected = selection === ALL_OFFICES;

  /**
   * The offices the LIST reads, in canonical order.
   *
   * Under "All" this is both; under a concrete selection it is the one. The
   * roster is intersected with the module's own frozen keys rather than trusted
   * wholesale, because the roster carries every office the platform knows about
   * (including the `unknown` bucket) and this module serves exactly two.
   */
  const listOffices = useMemo<FeesOfficeId[]>(() => {
    if (!allSelected) return isFeesOfficeId(selection) ? [selection] : [];
    const known = new Set(offices.map((o) => o.officeId));
    // An empty roster must not silently mean "no offices": FEES_OFFICE_IDS is
    // the fallback so a roster that failed to load still shows the list rather
    // than an empty state that reads as "you have never imported anything".
    const fromRoster = FEES_OFFICE_IDS.filter((id) => known.has(id));
    return fromRoster.length > 0 ? [...fromRoster] : [...FEES_OFFICE_IDS];
  }, [allSelected, selection, offices]);

  useEffect(() => {
    if (rosterLoading) return;
    if (listOffices.length === 0) {
      setState({ kind: "ready", batches: [] });
      return;
    }
    const abort = new AbortController();
    setState({ kind: "loading" });

    Promise.all(listOffices.map((office) => listImports(office, abort.signal)))
      .then((pages) => {
        if (abort.signal.aborted) return;
        // Newest first ACROSS offices — a merged list sorted per-office would
        // interleave two sorted runs and read as unsorted.
        const merged = pages
          .flatMap((page) => page.batches)
          .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
        setState({ kind: "ready", batches: merged });
      })
      .catch((err: unknown) => {
        if (abort.signal.aborted) return;
        setState({
          kind: "error",
          error:
            err instanceof FeesApiError
              ? err
              : new FeesApiError(
                  err instanceof Error ? err.message : "Could not load imports",
                  0,
                  null,
                ),
        });
      });

    return () => abort.abort();
  }, [listOffices, rosterLoading, reloadToken]);

  /** Which office an upload would go to, or null when the user must still pick. */
  const targetOffice: FeesOfficeId | null = allSelected
    ? uploadOffice
    : isFeesOfficeId(selection)
      ? selection
      : null;

  const send = useCallback(
    async (file: File) => {
      if (targetOffice === null) return;

      // A COURTESY check, not the guard. The server refuses an .xlsx with 415
      // and that refusal is the real one; this only saves a round trip and says
      // the same thing in the same words.
      if (sourceTypeFromFilename(file.name) === null) {
        setUpload({
          kind: "refused",
          error: new FeesApiError(
            `"${file.name}" is neither a PDF nor a CSV. Upload the schedule as one of those.`,
            415,
            "UNSUPPORTED_FILE_TYPE",
          ),
        });
        return;
      }

      setUpload({ kind: "uploading", filename: file.name });
      try {
        const result = await uploadImport(targetOffice, file);
        setUpload({ kind: "done", batch: result.batch });
        setReloadToken((n) => n + 1);
      } catch (err: unknown) {
        setUpload({
          kind: "refused",
          error:
            err instanceof FeesApiError
              ? err
              : new FeesApiError(err instanceof Error ? err.message : "Upload failed", 0, null),
        });
        // A parse failure still created a batch, so the list has something new
        // to show. Refetching is what makes the stored failure visible in the
        // place somebody will look for it tomorrow.
        setReloadToken((n) => n + 1);
      }
    },
    [targetOffice],
  );

  const onPick = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Cleared so picking the SAME file twice still fires a change event — the
    // natural thing to do after a failure you have just fixed.
    event.target.value = "";
    if (file) void send(file);
  };

  const uploadDisabled = targetOffice === null || upload.kind === "uploading";

  return (
    <div className="p-6" data-testid="fees-imports">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1
            className="text-2xl font-bold tracking-tight text-foreground"
            style={{ fontFamily: "Sora, sans-serif" }}
          >
            Fee Schedules
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Upload a payer's fee schedule and read what the file actually says. Nothing is sent to
            Open Dental.
          </p>
        </div>
      </div>

      {/* ── Upload ──────────────────────────────────────────────────────── */}
      <section className="mt-6" data-testid="fees-upload">
        {allSelected && (
          <div
            className="mb-3 rounded-lg border border-border bg-muted/40 p-4"
            data-testid="fees-upload-office-picker"
          >
            <div className="text-sm font-medium text-foreground">
              Which office is this schedule for?
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Roland and Riley hold different contracts with the same payers, so an import belongs
              to one of them. Pick one before uploading.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {FEES_OFFICE_IDS.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setUploadOffice(id)}
                  data-testid={`fees-upload-office-${id}`}
                  aria-pressed={uploadOffice === id}
                  className={cn(
                    "rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
                    uploadOffice === id
                      ? "border-foreground bg-foreground text-background"
                      : "border-border text-foreground hover:bg-accent",
                  )}
                >
                  {FEES_OFFICE_LABELS[id]}
                </button>
              ))}
            </div>
          </div>
        )}

        <div
          onDragOver={(e) => {
            e.preventDefault();
            if (!uploadDisabled) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (uploadDisabled) return;
            const file = e.dataTransfer.files?.[0];
            if (file) void send(file);
          }}
          data-testid="fees-dropzone"
          className={cn(
            "rounded-xl border-2 border-dashed p-8 text-center transition-colors",
            dragging ? "border-foreground bg-accent" : "border-border bg-card",
            uploadDisabled && "opacity-60",
          )}
        >
          <Upload size={24} className="mx-auto text-muted-foreground" aria-hidden />
          <div className="mt-3 text-sm font-medium text-foreground">
            Drop a fee schedule here, or choose a file
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            PDF or CSV, up to {MAX_UPLOAD_MB}MB.
            {targetOffice !== null && (
              <>
                {" "}
                Importing for{" "}
                <span className="font-medium text-foreground">
                  {FEES_OFFICE_LABELS[targetOffice]}
                </span>
                .
              </>
            )}
          </p>

          <input
            ref={fileInput}
            type="file"
            accept=".pdf,.csv,application/pdf,text/csv"
            className="hidden"
            onChange={onPick}
            data-testid="fees-file-input"
          />
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={uploadDisabled}
            data-testid="fees-upload-button"
            className="mt-4 inline-flex min-h-[40px] items-center gap-2 rounded-md border border-border bg-background px-4 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            {upload.kind === "uploading" ? (
              <>
                <Loader2 size={16} className="animate-spin" aria-hidden />
                Parsing {upload.filename}…
              </>
            ) : (
              "Choose a file"
            )}
          </button>

          {targetOffice === null && (
            <p className="mt-3 text-sm text-muted-foreground" data-testid="fees-upload-needs-office">
              Pick an office above to enable the upload.
            </p>
          )}
        </div>

        {/* The server's answer, verbatim. */}
        {upload.kind === "refused" && (
          <div
            className="mt-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4"
            data-testid="fees-upload-error"
          >
            <div className="flex items-start gap-2">
              <XCircle size={18} className="mt-0.5 shrink-0 text-destructive" aria-hidden />
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground">
                  {upload.error.message}
                </div>
                {upload.error.code !== null && (
                  <div
                    className="mt-1 font-mono text-xs text-muted-foreground"
                    data-testid="fees-upload-error-code"
                  >
                    {upload.error.code}
                  </div>
                )}
                {/* A 422 kept the batch. A 415 did not — and saying "we kept a
                    record" when nothing was stored would be the same dishonesty
                    in the other direction. */}
                {upload.error.batch !== null && (
                  <div
                    className="mt-3 rounded-md border border-border bg-card p-3"
                    data-testid="fees-upload-error-batch"
                  >
                    <div className="text-sm text-foreground">
                      This upload was recorded as a failed import, so you can find it again.
                    </div>
                    <Link
                      href={`/fees/imports/${upload.error.batch.batchId}`}
                      className="mt-1 inline-block text-sm font-medium text-foreground underline underline-offset-4"
                      data-testid="fees-upload-error-batch-link"
                    >
                      {upload.error.batch.filename}
                    </Link>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {formatBytes(upload.error.batch.fileSizeBytes)} ·{" "}
                      {FEES_OFFICE_LABELS[upload.error.batch.office] ?? upload.error.batch.office}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {upload.kind === "done" && (
          <div
            className="mt-3 rounded-lg border border-border bg-card p-4"
            data-testid="fees-upload-done"
          >
            <div className="flex items-start gap-2">
              <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-foreground" aria-hidden />
              <div>
                <div className="text-sm font-medium text-foreground">
                  Parsed {upload.batch.rowCount} {upload.batch.rowCount === 1 ? "fee" : "fees"} from{" "}
                  {upload.batch.filename}.
                </div>
                <Link
                  href={`/fees/imports/${upload.batch.batchId}`}
                  className="mt-1 inline-block text-sm font-medium text-foreground underline underline-offset-4"
                  data-testid="fees-upload-done-link"
                >
                  Read the preview
                </Link>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* ── The list ────────────────────────────────────────────────────── */}
      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Imports
        </h2>

        {rosterError !== null && (
          <p className="mt-2 text-sm text-muted-foreground" data-testid="fees-roster-error">
            The office list did not load ({rosterError}), so this is showing both offices.
          </p>
        )}

        {state.kind === "loading" && (
          <div
            className="mt-3 flex items-center gap-2 text-sm text-muted-foreground"
            data-testid="fees-imports-loading"
          >
            <Loader2 size={16} className="animate-spin" aria-hidden />
            Loading imports…
          </div>
        )}

        {state.kind === "error" && (
          <div
            className="mt-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4"
            data-testid="fees-imports-error"
          >
            <div className="text-sm font-medium text-foreground">{state.error.message}</div>
            {state.error.code !== null && (
              <div className="mt-1 font-mono text-xs text-muted-foreground">
                {state.error.code}
              </div>
            )}
            <button
              type="button"
              onClick={() => setReloadToken((n) => n + 1)}
              data-testid="fees-imports-retry"
              className="mt-3 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            >
              Try again
            </button>
          </div>
        )}

        {/* An EMPTY list says it loaded. The same argument the hygiene day view
            makes: nothing-yet and could-not-load must not look alike. */}
        {state.kind === "ready" && state.batches.length === 0 && (
          <div
            className="mt-3 rounded-xl border border-dashed border-border bg-card p-8 text-center"
            data-testid="fees-imports-empty"
          >
            <div className="text-sm font-medium text-foreground">No imports yet</div>
            <p className="mt-1 text-sm text-muted-foreground">
              Upload a payer fee schedule above and it will appear here.
            </p>
          </div>
        )}

        {state.kind === "ready" && state.batches.length > 0 && (
          <ul className="mt-3 space-y-2" data-testid="fees-imports-list">
            {state.batches.map((batch) => (
              <li key={batch.batchId}>
                <Link
                  href={`/fees/imports/${batch.batchId}`}
                  data-testid="fees-import-row"
                  data-batch-status={batch.status}
                  className="block rounded-lg border border-border bg-card p-4 transition-colors hover:bg-accent"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        {batch.sourceType === "pdf" ? (
                          <FileText size={16} className="shrink-0 text-muted-foreground" aria-hidden />
                        ) : (
                          <FileSpreadsheet
                            size={16}
                            className="shrink-0 text-muted-foreground"
                            aria-hidden
                          />
                        )}
                        <span className="truncate text-sm font-medium text-foreground">
                          {batch.filename}
                        </span>
                        <span className="rounded border border-border px-1.5 py-0.5 text-[11px] font-medium uppercase text-muted-foreground">
                          {batch.sourceType}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {formatWhen(batch.createdAt)} · {batch.createdBy}
                        {/* The office label is on EVERY row, not only under
                            "All". A row that says which practice it belongs to
                            is unambiguous wherever it is read. */}
                        {" · "}
                        <span data-testid="fees-import-row-office">
                          {FEES_OFFICE_LABELS[batch.office] ?? batch.office}
                        </span>
                      </div>
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      {batch.status === "failed" ? (
                        <span
                          className="inline-flex items-center gap-1 rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive"
                          data-testid="fees-import-failed-badge"
                        >
                          <XCircle size={12} aria-hidden />
                          Failed
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {batch.rowCount} {batch.rowCount === 1 ? "fee" : "fees"}
                        </span>
                      )}

                      {batch.warningCount > 0 && (
                        <span
                          className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400"
                          data-testid="fees-import-warning-badge"
                        >
                          <AlertTriangle size={12} aria-hidden />
                          {batch.warningCount}{" "}
                          {batch.warningCount === 1 ? "warning" : "warnings"}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* The reason rides on the row itself. A "Failed" badge whose
                      why is one click away is a badge somebody learns to
                      ignore. */}
                  {batch.status === "failed" && batch.failureReason !== null && (
                    <p
                      className="mt-2 text-sm text-muted-foreground"
                      data-testid="fees-import-failure-reason"
                    >
                      {batch.failureReason}
                      {batch.failureCode !== null && (
                        <span className="ml-2 font-mono text-xs">{batch.failureCode}</span>
                      )}
                    </p>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

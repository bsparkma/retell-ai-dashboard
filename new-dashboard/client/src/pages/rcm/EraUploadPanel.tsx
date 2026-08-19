/**
 * The ERA (835) upload affordance and remittance list, per office (Slice 5).
 *
 * Same shape as Slice 4's EobUploadPanel and sitting beside it: one panel per
 * office, labelled with that office. Office is a correctness boundary in this
 * module, not a filter, and a single upload control with an office dropdown
 * beside it is exactly the shape that lets someone file Roland's check under
 * Valley. One control per office cannot be aimed at the wrong one.
 *
 * Honest states, in the order they are checked:
 *   uploading       → the button says so and refuses a second file
 *   duplicate (409) → the refusal, naming what already exists — NOT an error
 *   failed          → the server's own message
 *   uploaded        → what was created, INCLUDING what was flagged
 *   list empty      → "nothing uploaded yet", never a spinner that never ends
 *
 * A duplicate is rendered as information, not as a failure: the operator did
 * nothing wrong, the system already has this check, and the useful next move is
 * to go and look at the batch it became. There is no retry button, because
 * there is no override to retry with.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, CheckCircle2, FileUp, Info, Loader2 } from "lucide-react";
import {
  listEraUploads,
  uploadEra,
  RcmApiError,
  RCM_OFFICE_LABELS,
  type DuplicateRemittance,
  type EraUpload,
  type EraUploadResult,
  type RcmOfficeId,
} from "@/features/rcm/api";
import { REVIEW_LABELS, FLAG_LABELS, isBlockingReason, label, reviewLabel } from "@/features/rcm/labels";

/** Integer cents → "$1,234.56". Formatting is the component's job, not the API's. */
function money(cents: number): string {
  return (cents / 100).toLocaleString(undefined, { style: "currency", currency: "USD" });
}


type UploadState =
  | { kind: "idle" }
  | { kind: "uploading"; filename: string }
  | { kind: "done"; result: EraUploadResult }
  | { kind: "duplicate"; remittances: DuplicateRemittance[]; message: string }
  | { kind: "failed"; message: string };

export default function EraUploadPanel({ office }: { office: RcmOfficeId }) {
  const [state, setState] = useState<UploadState>({ kind: "idle" });
  const [uploads, setUploads] = useState<EraUpload[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    listEraUploads(office, { limit: 5 })
      .then((page) => {
        setUploads(page.uploads);
        setListError(null);
      })
      .catch((err: unknown) => {
        setUploads([]);
        setListError(
          err instanceof RcmApiError && err.notEntitled
            ? "This practice is not set up for the RCM module."
            : err instanceof Error
              ? err.message
              : "Could not load uploads.",
        );
      });
  }, [office]);

  useEffect(refresh, [refresh]);

  async function onPick(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Clear immediately so picking the SAME file again still fires a change —
    // which an operator will do, and which must produce the honest duplicate
    // refusal rather than nothing happening at all.
    event.target.value = "";
    if (!file) return;

    setState({ kind: "uploading", filename: file.name });
    try {
      const result = await uploadEra(office, file);
      setState({ kind: "done", result });
      refresh();
    } catch (err: unknown) {
      if (err instanceof RcmApiError && err.alreadyProcessed) {
        setState({
          kind: "duplicate",
          remittances: err.duplicateRemittances,
          message: err.message,
        });
        return;
      }
      setState({
        kind: "failed",
        message: err instanceof Error ? err.message : "The upload failed.",
      });
    }
  }

  const busy = state.kind === "uploading";

  return (
    <div
      className="rounded-xl border border-border bg-card p-5 shadow-sm"
      data-testid={`rcm-era-panel-${office}`}
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-foreground">
            {RCM_OFFICE_LABELS[office]} — remittance files
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Uploads land in {RCM_OFFICE_LABELS[office]}. Nothing is posted to Open Dental.
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          data-testid={`rcm-era-upload-${office}`}
          className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <FileUp size={14} />}
          {busy ? "Uploading…" : "Upload 835"}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".edi,.txt,text/plain,application/edi-x12"
          className="hidden"
          onChange={onPick}
          data-testid={`rcm-era-input-${office}`}
        />
      </div>

      {state.kind === "done" && <UploadResult result={state.result} office={office} />}
      {state.kind === "duplicate" && (
        <DuplicateNotice message={state.message} remittances={state.remittances} office={office} />
      )}
      {state.kind === "failed" && (
        <Banner
          tone="error"
          icon={<AlertTriangle size={14} />}
          testId={`rcm-era-error-${office}`}
          title="The upload was refused"
          body={state.message}
        />
      )}

      <RecentUploads uploads={uploads} error={listError} office={office} />
    </div>
  );
}

/** What an accepted upload created — and what it flagged. */
function UploadResult({ result, office }: { result: EraUploadResult; office: RcmOfficeId }) {
  const { counts } = result;
  // Array.from rather than spreading the Set — the project's tsconfig target
  // does not allow iterating one directly.
  const flagged = Array.from(new Set(result.remittances.flatMap((r) => r.flags)));
  const review = Array.from(
    new Set(result.remittances.flatMap((r) => r.claims.flatMap((c) => c.needsReviewReasons))),
  );

  return (
    <div
      className="mt-3 rounded-lg border border-border bg-muted/30 p-3"
      data-testid={`rcm-era-result-${office}`}
    >
      <div className="flex items-start gap-2 text-sm text-foreground">
        <CheckCircle2 size={15} className="mt-0.5 flex-shrink-0 text-emerald-600" />
        <div>
          <div className="font-medium">
            {counts.batches} remittance{counts.batches === 1 ? "" : "s"}, {counts.claims} claim
            {counts.claims === 1 ? "" : "s"}, {counts.lines} line{counts.lines === 1 ? "" : "s"}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Proposals only — a person still decides what gets posted.
          </p>
        </div>
      </div>

      <ul className="mt-3 space-y-1.5">
        {result.remittances.map((r) => (
          // Slice 6a: an upload is no longer a dead end. Every remittance this
          // file produced links to the screen where a biller can actually work
          // it — which is the whole reason the workbench was built first.
          <li key={r.batchId} className="text-xs text-muted-foreground">
            <Link
              href={`/rcm/remittances/${r.batchId}`}
              className="font-medium text-foreground underline-offset-2 hover:underline"
              data-testid={`rcm-era-open-${r.batchId}`}
            >
              {r.payer}
            </Link>{" "}
            · {r.checkNumber} ·{" "}
            {r.paymentDate} · <span className="tabular-nums">{money(r.totalAmountCents)}</span> ·{" "}
            {r.claims.length} claim{r.claims.length === 1 ? "" : "s"} ·{" "}
            <StatusChip status={r.status} />
          </li>
        ))}
      </ul>

      {(flagged.length > 0 || review.length > 0) && (
        <div className="mt-3 border-t border-border/60 pt-2" data-testid={`rcm-era-flags-${office}`}>
          <div className="text-xs font-medium text-foreground">Held for review</div>
          {/*
            D-11's split, applied here too. Amber will WITHHOLD the claim at the
            approval gate; grey is true and changes nothing about what to post.
            Colouring every flag amber — as this panel did — meant a downcode
            and a truncated envelope looked equally alarming, which is how a
            biller learns to read past both.
          */}
          <ul className="mt-1 space-y-0.5">
            {flagged.map((f) => (
              <li
                key={f}
                data-testid={`era-flag-${f}`}
                className={`text-xs ${
                  isBlockingReason(f)
                    ? "text-amber-700 dark:text-amber-500"
                    : "text-muted-foreground"
                }`}
              >
                • {label(FLAG_LABELS, f)}
              </li>
            ))}
            {review.map((r) => (
              <li
                key={r}
                data-testid={`era-reason-${r}`}
                className={`text-xs ${
                  isBlockingReason(r)
                    ? "text-amber-700 dark:text-amber-500"
                    : "text-muted-foreground"
                }`}
              >
                • {reviewLabel(r)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * The duplicate refusal. Blue, not red — nothing went wrong, and the system
 * already holds this check.
 */
function DuplicateNotice({
  message,
  remittances,
  office,
}: {
  message: string;
  remittances: DuplicateRemittance[];
  office: RcmOfficeId;
}) {
  return (
    <Banner
      tone="info"
      icon={<Info size={14} />}
      testId={`rcm-era-duplicate-${office}`}
      title="Already processed — nothing was created"
      body={message}
    >
      <ul className="mt-2 space-y-1">
        {remittances.map((r) => (
          <li key={r.remittanceKey} className="text-xs">
            <code className="break-all rounded bg-background/60 px-1 py-0.5">{r.remittanceKey}</code>
            <span className="ml-1.5 text-muted-foreground">
              {r.status === "pending"
                ? // 'pending' blocks as firmly as 'posted': a run is in flight,
                  // or died mid-flight, and until someone confirms what landed
                  // the safe reading of "we may have done this" is that we did.
                  "a run is in flight or did not finish — check before re-sending"
                : r.processedAt
                  ? `processed ${r.processedAt.slice(0, 10)}`
                  : "already processed"}
            </span>
            {/* The useful next move after a duplicate is to go and LOOK at the
                batch it already became, which was impossible before 6a. */}
            {r.batchId && (
              <Link
                href={`/rcm/remittances/${r.batchId}`}
                className="ml-1.5 font-medium text-foreground underline-offset-2 hover:underline"
                data-testid={`rcm-era-duplicate-open-${r.batchId}`}
              >
                open it
              </Link>
            )}
          </li>
        ))}
      </ul>
    </Banner>
  );
}

function RecentUploads({
  uploads,
  error,
  office,
}: {
  uploads: EraUpload[] | null;
  error: string | null;
  office: RcmOfficeId;
}) {
  if (error) {
    return (
      <p className="mt-3 text-xs text-destructive" data-testid={`rcm-era-list-error-${office}`}>
        {error}
      </p>
    );
  }
  if (uploads === null) {
    return (
      <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 size={12} className="animate-spin" />
        Loading uploads…
      </p>
    );
  }
  if (uploads.length === 0) {
    return (
      <p className="mt-3 text-xs text-muted-foreground" data-testid={`rcm-era-empty-${office}`}>
        Nothing uploaded yet.
      </p>
    );
  }

  return (
    <ul className="mt-3 space-y-2" data-testid={`rcm-era-list-${office}`}>
      {uploads.map((u) => (
        <li key={u.uploadId} className="rounded-lg border border-border/60 bg-muted/20 p-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-xs font-medium text-foreground">{u.filename}</span>
            <span className="flex-shrink-0 text-[11px] text-muted-foreground">
              {u.uploadedAt?.slice(0, 10)}
            </span>
          </div>
          {u.remittances.map((r) => (
            <div key={r.batchId} className="mt-1 text-[11px] text-muted-foreground">
              <Link
                href={`/rcm/remittances/${r.batchId}`}
                className="font-medium text-foreground underline-offset-2 hover:underline"
                data-testid={`rcm-era-history-open-${r.batchId}`}
              >
                {r.payer}
              </Link>{" "}
              · {r.checkNumber ?? r.eftNumber ?? r.traceNumber} ·{" "}
              <span className="tabular-nums">{money(r.totalAmountCents)}</span> · {r.claimCount}{" "}
              claim{r.claimCount === 1 ? "" : "s"} · <StatusChip status={r.status} />
              {r.dedupeStatus === "posted" && (
                <span className="ml-1.5" title={r.remittanceKey ?? undefined}>
                  · re-upload will be refused
                </span>
              )}
            </div>
          ))}
        </li>
      ))}
    </ul>
  );
}

/** `ready` is the only status that claims a person can act now. */
function StatusChip({ status }: { status: string }) {
  const ready = status === "ready";
  return (
    <span
      className={
        ready
          ? "rounded bg-emerald-500/10 px-1.5 py-0.5 font-medium text-emerald-700 dark:text-emerald-400"
          : "rounded bg-amber-500/10 px-1.5 py-0.5 font-medium text-amber-700 dark:text-amber-500"
      }
    >
      {ready ? "ready" : status}
    </span>
  );
}

function Banner({
  tone,
  icon,
  title,
  body,
  testId,
  children,
}: {
  tone: "info" | "error";
  icon: React.ReactNode;
  title: string;
  body: string;
  testId: string;
  children?: React.ReactNode;
}) {
  const toneClass =
    tone === "info"
      ? "border-sky-500/40 bg-sky-500/5 text-sky-900 dark:text-sky-200"
      : "border-destructive/40 bg-destructive/5 text-destructive";
  return (
    <div className={`mt-3 rounded-lg border p-3 ${toneClass}`} data-testid={testId}>
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex-shrink-0">{icon}</span>
        <div className="min-w-0">
          <div className="text-sm font-medium">{title}</div>
          <p className="mt-0.5 break-words text-xs opacity-90">{body}</p>
          {children}
        </div>
      </div>
    </div>
  );
}

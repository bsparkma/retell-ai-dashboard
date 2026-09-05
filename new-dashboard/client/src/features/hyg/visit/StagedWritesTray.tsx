/**
 * What is staged to be written, what it will say, and what happened to it.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE CONFIRM STEP IS THE PREVIEW, NOT A SUMMARY OF IT
 * ═════════════════════════════════════════════════════════════════════════════
 * The dialog shows the EXACT lines that will be written, and the button carries
 * the fingerprint of those lines back to the server, which recomputes it and
 * refuses the whole send if anything changed. A confirmation over a summary
 * would be a confirmation of something else.
 *
 * The preview lines came from the server. This component does not build one and
 * could not: a payload the client composed is a payload the client can change
 * between the preview and the send, which is RCM audit finding F3.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * A VISIT IS NEVER "SENT". ITS WRITES ARE.
 * ═════════════════════════════════════════════════════════════════════════════
 * Partial success is the normal case — the note can land and the slip fail — so
 * there is no single success banner anywhere on this screen. Every row carries
 * its own state, its own reason when it failed, and its own reference to where
 * it landed when it did. A failed row offers a retry that re-sends the SAME
 * words.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * NOTHING HERE MAY SAY "SIGNED"
 * ═════════════════════════════════════════════════════════════════════════════
 * CareIN writes the visit note UNSIGNED, with a typed name block. Open Dental's
 * own signature block is the only thing allowed to claim a signature. The
 * prototype's notes summary said "Signed by" — a defect, not copy to lift.
 */
import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  Loader2,
  RotateCcw,
  Send,
  Stethoscope,
  Trash2,
  UserPlus,
} from "lucide-react";

import {
  StagedWriteKindSchema,
  type HandoffCategory,
  type SendConfirmation,
  type StagedWrite,
  type StagedWriteKind,
} from "@shared/hyg/contract";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const TAP = "min-h-11 rounded-lg border px-3 text-sm font-medium transition-colors";

const KIND_LABELS: Record<StagedWriteKind, string> = {
  router: "Routing slip",
  perio: "Perio chart",
  note: "Visit note",
  "tc-handoff": "Treatment handoff",
};

const KIND_BLURBS: Record<StagedWriteKind, string> = {
  router: "The slip, filed into this patient's images.",
  perio: "Not built yet — perio charting has its own slice.",
  note: "An unsigned note on today's appointment, with your name typed in it.",
  "tc-handoff": "The treatment, to the treatment coordinator.",
};

const KIND_ICONS: Record<StagedWriteKind, typeof FileText> = {
  router: FileText,
  perio: Stethoscope,
  note: FileText,
  "tc-handoff": UserPlus,
};

/** Which kinds this release can compose. `perio` refuses server-side too. */
const AVAILABLE: StagedWriteKind[] = ["router", "note", "tc-handoff"];

function StatePill({ state }: { state: StagedWrite["state"] }) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-xs font-semibold",
        state === "Written"
          ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300"
          : state === "Failed"
            ? "bg-red-100 text-red-900 dark:bg-red-950/60 dark:text-red-300"
            : "bg-muted text-muted-foreground",
      )}
      data-testid={`hyg-staged-state-${state}`}
    >
      {state}
    </span>
  );
}

/**
 * The confirmation. It shows every line of every write being sent, because
 * that is what is being confirmed.
 */
function ConfirmSend({
  writes,
  patientName,
  busy,
  onCancel,
  onConfirm,
}: {
  writes: StagedWrite[] | null;
  patientName: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={writes !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent
        className="max-h-[80vh] overflow-y-auto sm:max-w-2xl"
        data-testid="hyg-confirm-send"
      >
        {writes && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Send className="h-4 w-4" />
                Send {writes.length} {writes.length === 1 ? "thing" : "things"} to Open Dental?
              </DialogTitle>
              <DialogDescription asChild>
                <div className="space-y-3" data-testid="hyg-confirm-send-body">
                  <p>
                    This writes to <strong>{patientName}</strong>&apos;s chart. Below is exactly
                    what will be written — if any of it changes before you confirm, nothing is
                    sent and you will be asked to read it again.
                  </p>
                  {writes.map((write) => (
                    <div
                      key={write.kind}
                      className="rounded-lg border border-border p-3"
                      data-testid={`hyg-confirm-${write.kind}`}
                    >
                      <div className="text-sm font-semibold text-foreground">{write.title}</div>
                      <div className="text-xs">{write.summary}</div>
                      <ul className="mt-1.5 space-y-0.5 text-xs">
                        {write.preview.map((line, i) => (
                          <li key={i} className={cn(line.startsWith("  ") && "pl-3")}>
                            {line.trim()}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <button
                type="button"
                onClick={onCancel}
                disabled={busy}
                className={cn(TAP, "border-transparent text-muted-foreground")}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onConfirm}
                disabled={busy}
                data-testid="hyg-confirm-send-accept"
                className={cn(TAP, "border-primary bg-primary text-primary-foreground")}
              >
                {busy ? <Loader2 className="mr-1.5 inline h-3.5 w-3.5 animate-spin" /> : null}
                Send to Open Dental
              </button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function StagedWritesTray({
  staged,
  handoffCategory,
  patientName,
  busy,
  sending,
  onStage,
  onUnstage,
  onSend,
  onRetry,
  refusal,
}: {
  staged: StagedWrite[];
  handoffCategory: HandoffCategory;
  patientName: string;
  busy: boolean;
  sending: boolean;
  onStage: (kind: StagedWriteKind) => void;
  onUnstage: (kind: StagedWriteKind) => void;
  onSend: (confirm: SendConfirmation[]) => void;
  onRetry: (kind: StagedWriteKind) => void;
  /** The server's last refusal, in its own words. `kind: null` = the send. */
  refusal: { kind: StagedWriteKind | null; message: string } | null;
}) {
  const [confirming, setConfirming] = useState<StagedWrite[] | null>(null);
  const byKind = new Map(staged.map((w) => [w.kind, w]));
  const ready = staged.filter((w) => w.state === "Staged");

  return (
    <section className="space-y-3" data-testid="hyg-staged-tray">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Ready to send
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Nothing is written until you confirm, and you confirm the exact words below.
        </p>
      </div>

      <div className="space-y-2">
        {StagedWriteKindSchema.options.map((kind: StagedWriteKind) => {
          const write = byKind.get(kind);
          const Icon = KIND_ICONS[kind];
          const available = AVAILABLE.includes(kind);
          return (
            <div
              key={kind}
              className={cn(
                "rounded-xl border p-3",
                write?.state === "Written"
                  ? "border-emerald-500/40 bg-emerald-500/5"
                  : write?.state === "Failed"
                    ? "border-destructive/40 bg-destructive/5"
                    : write
                      ? "border-primary/40 bg-primary/5"
                      : "border-border bg-card",
              )}
              data-testid={`hyg-staged-${kind}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <Icon size={14} className="shrink-0 text-muted-foreground" />
                    <span className="text-sm font-semibold text-foreground">
                      {KIND_LABELS[kind]}
                    </span>
                    {write ? <StatePill state={write.state} /> : null}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {write ? write.summary : KIND_BLURBS[kind]}
                  </p>
                  {kind === "tc-handoff" && !write ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      It will go in as <strong>{handoffCategory}</strong> — worked out from the
                      items, so you are not asked to classify the visit twice.
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {write?.state === "Staged" ? (
                    <button
                      type="button"
                      onClick={() => onUnstage(kind)}
                      disabled={busy || sending}
                      aria-label={`Take ${KIND_LABELS[kind]} off the list`}
                      data-testid={`hyg-unstage-${kind}`}
                      className={cn(TAP, "border-border text-destructive hover:bg-destructive/10")}
                    >
                      <Trash2 size={16} />
                    </button>
                  ) : write?.state === "Failed" ? (
                    <button
                      type="button"
                      onClick={() => onRetry(kind)}
                      disabled={busy || sending}
                      data-testid={`hyg-retry-${kind}`}
                      className={cn(TAP, "border-border text-foreground hover:bg-accent/50")}
                    >
                      <RotateCcw size={14} className="mr-1 inline" />
                      Retry
                    </button>
                  ) : write ? null : (
                    <button
                      type="button"
                      onClick={() => onStage(kind)}
                      disabled={busy || sending || !available}
                      data-testid={`hyg-stage-${kind}`}
                      className={cn(
                        TAP,
                        available
                          ? "border-border text-foreground hover:bg-accent/50"
                          : "cursor-not-allowed border-border text-muted-foreground/60",
                      )}
                    >
                      {available ? "Stage" : "Not yet"}
                    </button>
                  )}
                </div>
              </div>

              {write && write.state !== "Written" ? (
                <ul
                  className="mt-2 space-y-0.5 border-t border-border/60 pt-2 text-xs text-muted-foreground"
                  data-testid={`hyg-staged-preview-${kind}`}
                >
                  {write.preview.map((line, i) => (
                    <li key={i} className={cn(line.startsWith("  ") && "pl-3")}>
                      {line.trim()}
                    </li>
                  ))}
                </ul>
              ) : null}

              {/* WHERE IT LANDED. "It was sent" and "here it is" are different
                  claims, and only the second one can be checked later. */}
              {write?.state === "Written" && write.writtenRef ? (
                <p
                  className="mt-2 flex items-start gap-1.5 text-xs text-emerald-700 dark:text-emerald-400"
                  data-testid={`hyg-written-${kind}`}
                >
                  <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
                  <span>
                    {write.writtenRef}
                    {write.sentBy ? ` · sent by ${write.sentBy}` : ""}
                  </span>
                </p>
              ) : null}

              {write?.state === "Failed" && write.errorMessage ? (
                <p
                  className="mt-2 flex items-start gap-1.5 text-xs text-destructive"
                  data-testid={`hyg-failed-${kind}`}
                >
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  {write.errorMessage}
                </p>
              ) : null}

              {refusal && refusal.kind === kind ? (
                <p
                  className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400"
                  data-testid={`hyg-stage-refused-${kind}`}
                >
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  {refusal.message}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="rounded-xl border border-dashed border-border p-3">
        <button
          type="button"
          disabled={busy || sending || ready.length === 0}
          onClick={() => setConfirming(ready)}
          data-testid="hyg-send-all"
          className={cn(
            TAP,
            "flex w-full items-center justify-center gap-2",
            ready.length === 0
              ? "cursor-not-allowed border-border text-muted-foreground"
              : "border-primary bg-primary text-primary-foreground",
          )}
        >
          {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
          {sending
            ? "Sending…"
            : ready.length === 0
              ? "Nothing staged to send"
              : `Send ${ready.length} to Open Dental`}
        </button>
        <p className="mt-2 text-xs text-muted-foreground" data-testid="hyg-send-all-reason">
          {ready.length === 0
            ? "Stage the slip, the note or the handoff above, then send them together."
            : "You will see exactly what is written before anything is sent."}
        </p>
        {/* A refusal about the SEND rather than about one write — the stale
            preview case, which stops everything on purpose. */}
        {refusal && refusal.kind === null ? (
          <p
            className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400"
            data-testid="hyg-send-refused"
          >
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            {refusal.message}
          </p>
        ) : null}
      </div>

      <ConfirmSend
        writes={confirming}
        patientName={patientName}
        busy={sending}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          const confirm = (confirming ?? []).map((w) => ({
            kind: w.kind,
            // THE FINGERPRINT OF WHAT IS ON SCREEN. The server recomputes it
            // from its own row and refuses the whole send if they disagree.
            previewFingerprint: w.previewFingerprint,
          }));
          setConfirming(null);
          onSend(confirm);
        }}
      />
    </section>
  );
}

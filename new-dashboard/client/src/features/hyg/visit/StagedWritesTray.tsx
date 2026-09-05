/**
 * What is staged to be written, and what it will say.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * SLICE 2 STAGES. SLICE 3 SENDS. THE SCREEN SAYS SO.
 * ═════════════════════════════════════════════════════════════════════════════
 * There IS a Send affordance here and it is disabled — with the reason written
 * beside it, in words, permanently visible. The alternative was to render no
 * Send at all, and that is worse: a hygienist who has staged three writes and
 * can see no way to send them concludes the app is broken rather than
 * unfinished. A disabled control that says why it is disabled teaches the true
 * thing.
 *
 * It is NOT disabled by anything about the visit. Nothing here is gated on a
 * completeness check — not the unanswered front-desk questions, not the records
 * list. The only reason it is disabled is that the code to send does not exist
 * yet, and that reason is the same for every visit.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE PREVIEW IS THE SERVER'S WORDS
 * ═════════════════════════════════════════════════════════════════════════════
 * Every line below came from `hyg_staged_write.preview`, composed on the server
 * from the stored visit. This component does not build a preview and could not:
 * a payload the client composed is a payload the client can change between the
 * preview and the send, which is exactly RCM audit finding F3. Slice 3 sends
 * the row this is rendering.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * NOTHING HERE MAY SAY "SIGNED"
 * ═════════════════════════════════════════════════════════════════════════════
 * CareIN writes the visit note UNSIGNED, with a typed name block. Open Dental's
 * own signature block is the only thing allowed to claim a signature. The
 * prototype's notes summary said "Signed by" — a defect, not copy to lift. The
 * word appears nowhere in this file and `hyg-visit.test.tsx` asserts it.
 */
import { AlertTriangle, FileText, Lock, Send, Stethoscope, Trash2, UserPlus } from "lucide-react";

import {
  StagedWriteKindSchema,
  type HandoffCategory,
  type StagedWrite,
  type StagedWriteKind,
} from "@shared/hyg/contract";
import { cn } from "@/lib/utils";

const TAP = "min-h-11 rounded-lg border px-3 text-sm font-medium transition-colors";

/** What each kind is, in the words a hygienist would use. */
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

/** Which kinds this slice can compose. `perio` refuses server-side too. */
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
      data-testid="hyg-staged-state"
    >
      {state}
    </span>
  );
}

export function StagedWritesTray({
  staged,
  handoffCategory,
  busy,
  onStage,
  onUnstage,
  refusal,
}: {
  staged: StagedWrite[];
  handoffCategory: HandoffCategory;
  busy: boolean;
  onStage: (kind: StagedWriteKind) => void;
  onUnstage: (kind: StagedWriteKind) => void;
  /** The server's last refusal to stage something, in its own words. */
  refusal: { kind: StagedWriteKind; message: string } | null;
}) {
  const byKind = new Map(staged.map((w) => [w.kind, w]));

  return (
    <section className="space-y-3" data-testid="hyg-staged-tray">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Ready to send
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Staged here, sent in the next release. Nothing on this page has written to Open Dental.
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
                write ? "border-primary/40 bg-primary/5" : "border-border bg-card",
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
                  {write ? (
                    <button
                      type="button"
                      onClick={() => onUnstage(kind)}
                      disabled={busy || write.state !== "Staged"}
                      aria-label={`Take ${KIND_LABELS[kind]} off the list`}
                      data-testid={`hyg-unstage-${kind}`}
                      className={cn(TAP, "border-border text-destructive hover:bg-destructive/10")}
                    >
                      <Trash2 size={16} />
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onStage(kind)}
                      disabled={busy || !available}
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

              {write ? (
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

              {write && write.state === "Failed" && write.errorMessage ? (
                <p className="mt-2 flex items-start gap-1.5 text-xs text-destructive">
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
          disabled
          data-testid="hyg-send-all"
          className={cn(
            TAP,
            "flex w-full cursor-not-allowed items-center justify-center gap-2 border-border text-muted-foreground",
          )}
        >
          <Send size={16} />
          Send to Open Dental
        </button>
        {/* The reason, permanently visible. A disabled control with no reason
            is a control somebody taps three times and then distrusts. */}
        <p
          className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground"
          data-testid="hyg-send-all-reason"
        >
          <Lock size={14} className="mt-0.5 shrink-0" />
          Sending is not built yet. It is not waiting on anything you have filled in — the
          routing slip, the note and the handoff all go in the next release.
        </p>
      </div>
    </section>
  );
}

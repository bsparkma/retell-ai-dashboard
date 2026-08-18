/**
 * Follow up / Mark done / Reopen — the two ways to finish a call that write nowhere.
 *
 * This used to live privately inside CallWorklist, which meant the only place a call
 * could be triaged was the list. The team reads the call on the DETAIL page and then
 * had to navigate back to close it out. One component, two shapes:
 *
 *   variant="icon"     the worklist row. A row can offer five actions at once, and when
 *                      each wore a word the patient's name was squeezed to a few
 *                      characters (PR #53). State survives as the filled variant plus
 *                      the tooltip; the outcome is rendered by the row's signal chips.
 *
 *   variant="labeled"  the call-detail header, where the row has room and the whole
 *                      point is that the action is FINDABLE. Same handlers, same
 *                      popover, same outcomes — only the trigger is wider.
 *
 * The buttons are UX only. `PATCH /api/unified-calls/:id/triage` is gated on
 * `voice.write` server-side; a caller who hides nothing here still gets a 403.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CheckCircle2, PhoneForwarded, RotateCcw } from "lucide-react";
import { ActionTooltip, IconAction, ACTION_HEIGHT, ICON_ACTION_CLASS } from "@/components/calls/IconAction";
import { OUTCOMES, outcomeLabel } from "@/lib/triage";
import { formatTimeAgo } from "@/lib/utils";
import type { UnifiedCall, TriageOutcome } from "@/lib/api";

/** Which shape the controls take. See the header. */
export type TriageActionsVariant = "icon" | "labeled";

interface TriageActionsProps {
  call: UnifiedCall;
  onFollowUp: () => void;
  /** Signature kept as the worklist has always called it: (call, 'done', outcome, note?). */
  onDone: (call: UnifiedCall, status: "done", outcome: TriageOutcome, note?: string) => void;
  onReopen: () => void;
  /** Defaults to the worklist's icon-only shape — the caller that must not change. */
  variant?: TriageActionsVariant;
}

export function TriageActions({
  call, onFollowUp, onDone, onReopen, variant = "icon",
}: TriageActionsProps) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const labeled = variant === "labeled";

  if (call.triageStatus === "done") {
    const label = "Reopen this call";
    return labeled ? (
      <Button
        size="sm"
        variant="outline"
        onClick={onReopen}
        title={label}
        aria-label={label}
        className={`${ACTION_HEIGHT} gap-1.5 text-xs`}
        data-testid="triage-reopen"
      >
        <RotateCcw size={13} /> Reopen
      </Button>
    ) : (
      <IconAction label={label} icon={<RotateCcw size={13} />} variant="ghost" onClick={onReopen} />
    );
  }

  const followingUp = call.triageStatus === "needs_action";
  // The label stays "Follow up" in both shapes: it names the ACTION. That the call is
  // already flagged is state, carried by the filled variant and the tooltip here, and
  // by the pill beside it on the detail page.
  const followUpLabel = followingUp
    ? "Following up — click to keep it flagged"
    : "Flag for follow up";
  const doneLabel = "Mark done — choose an outcome";

  return (
    <>
      {labeled ? (
        <Button
          size="sm"
          variant={followingUp ? "secondary" : "outline"}
          onClick={onFollowUp}
          title={followUpLabel}
          aria-label={followUpLabel}
          className={`${ACTION_HEIGHT} gap-1.5 text-xs`}
          data-testid="triage-follow-up"
        >
          <PhoneForwarded size={13} /> Follow up
        </Button>
      ) : (
        <IconAction
          label={followUpLabel}
          icon={<PhoneForwarded size={13} />}
          variant={followingUp ? "secondary" : "outline"}
          onClick={onFollowUp}
        />
      )}

      <Popover open={open} onOpenChange={setOpen}>
        {labeled ? (
          <PopoverTrigger asChild>
            <Button
              size="sm"
              aria-label={doneLabel}
              title={doneLabel}
              className={`${ACTION_HEIGHT} gap-1.5 text-xs`}
              data-testid="triage-mark-done"
            >
              <CheckCircle2 size={13} /> Mark done
            </Button>
          </PopoverTrigger>
        ) : (
          <ActionTooltip label={doneLabel}>
            <PopoverTrigger asChild>
              <Button size="sm" className={ICON_ACTION_CLASS} aria-label={doneLabel}>
                <CheckCircle2 size={13} />
              </Button>
            </PopoverTrigger>
          </ActionTooltip>
        )}
        <PopoverContent align="end" className="w-56 p-2">
          <div className="text-xs font-semibold text-muted-foreground px-1 pb-1.5">Outcome</div>
          <div className="space-y-0.5">
            {OUTCOMES.map((o) => (
              <button
                key={o.value}
                onClick={() => { onDone(call, "done", o.value, note.trim() || undefined); setOpen(false); setNote(""); }}
                className="w-full text-left text-sm px-2 py-1.5 rounded hover:bg-muted transition-colors"
              >
                {o.label}
              </button>
            ))}
          </div>
          <Input
            placeholder="Optional note…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={280}
            className="mt-2 h-8 text-xs"
          />
        </PopoverContent>
      </Popover>
    </>
  );
}

/**
 * Where this call stands, as a fact rather than a control.
 *
 * The detail page needs this in a way the worklist row does not: the row's chips
 * already carry the resolved outcome, and its buttons stand in a column whose meaning
 * is obvious. On the detail page the buttons sit among Download and Add Callback, so
 * without a pill "Follow up" reads as an offer rather than as a description of a call
 * somebody already flagged.
 *
 * Renders nothing for an untouched call — "new" is the absence of a decision, and a
 * chip saying so would be noise on every call that has never been worked.
 */
export function TriageStatePill({ call }: { call: UnifiedCall }) {
  if (call.triageStatus !== "done" && call.triageStatus !== "needs_action") return null;

  const done = call.triageStatus === "done";
  const tone = done
    ? "text-emerald-700 bg-emerald-500/10"
    : "text-amber-700 bg-amber-500/10";
  const muted = done ? "text-emerald-700/70" : "text-amber-700/70";

  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full ${tone}`}
      data-testid="triage-state-pill"
      data-triage-status={call.triageStatus}
    >
      {done ? <CheckCircle2 size={13} /> : <PhoneForwarded size={13} />}
      {done ? `Done · ${outcomeLabel(call.triageOutcome)}` : "Following up"}
      {/* Who and when, when the record carries it. A call triaged before attribution
          existed carries neither, and inventing "by someone" would be worse than the
          silence. */}
      {call.triageBy?.name && (
        <span className={`${muted} font-normal`}>
          by {call.triageBy.name}{call.triageAt ? ` · ${formatTimeAgo(call.triageAt)}` : ""}
        </span>
      )}
    </span>
  );
}

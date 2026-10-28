/**
 * "Chart note" (R6.10) — a referral milestone written to the patient's Open
 * Dental chart as a commlog, ONLY when a person presses "Write to chart" on
 * text they can see.
 *
 * One row per milestone the referral has reached (referralChartMilestones —
 * the same pure rule the server refuses by). A written one shows when, by
 * whom, the Open Dental note number and the words. An unwritten one opens to a
 * drafted note the person may edit; the FINAL text — exactly what will be
 * stored, OD-safe — sits immediately above the button. Nothing here writes on
 * its own: no effect, timer or status change calls the route; only the click.
 *
 * The hub's detail panel draws it for a tc.full viewer through the hub's own
 * routes (hubCanWriteChartNotes). When the office cannot take a note (no
 * "Referral" type configured, writes switched off), the button is disabled
 * and the server's named reason is shown beside it. The server re-checks all
 * of it.
 */
import { useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, ClipboardPen, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { tcErrorMessage } from "@/features/tc/api";
import { writeReferralChartNote } from "@/features/tc/referrals/referralsApi";
import type { OfficeId } from "@shared/tc/contract";
import {
  TC_REFERRAL_CHART_MILESTONE_LABELS,
  TC_REFERRAL_CHART_NOTE_MAX,
  referralChartMilestones,
  referralChartNoteDraft,
  referralChartNoteOdSafe,
  type TcReferral,
  type TcReferralChartMilestoneState,
} from "@shared/tc/referrals";

/** Shown when the detail read did not say (an older server): fail closed. */
export const CHART_NOTES_UNKNOWN_COPY = "Can't tell whether this office's charts can take a note right now.";

/** The text that will be stored for what the person typed: trimmed, OD-safe. Pure. */
export function chartNoteFinalText(typed: string): string {
  return referralChartNoteOdSafe(typed.trim());
}

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function WrittenRow({ state }: { state: TcReferralChartMilestoneState & { written: NonNullable<TcReferralChartMilestoneState["written"]> } }) {
  return (
    <li className="space-y-0.5" data-testid={`tc-chart-note-written-${state.milestone}`}>
      <p className="flex items-center gap-1.5 text-sm">
        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" aria-hidden />
        <span className="font-medium">{TC_REFERRAL_CHART_MILESTONE_LABELS[state.milestone]}</span>
        <span className="text-muted-foreground">
          · written to the chart {when(state.written.at)} by {state.written.actor} (Open Dental note {state.written.commLogNum})
        </span>
      </p>
      <p className="text-xs text-muted-foreground whitespace-pre-wrap pl-5">{state.written.note}</p>
    </li>
  );
}

function OpenRow({
  office,
  referral: r,
  state,
  blockedReason,
  onWritten,
}: {
  office: OfficeId;
  referral: TcReferral;
  state: TcReferralChartMilestoneState;
  /** Why the button is disabled for this office; null when it is not. */
  blockedReason: string | null;
  onWritten: (next: TcReferral) => void;
}) {
  const draft = referralChartNoteDraft(state.milestone, r, state.eventNote);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const final = chartNoteFinalText(text);
  const tooLong = final.length > TC_REFERRAL_CHART_NOTE_MAX;
  const id = `tc-chart-note-${state.milestone}`;

  async function writeIt() {
    setBusy(true);
    setError(null);
    try {
      // What is sent is what is shown above the button — nothing else.
      const { referral: next, commLogNum } = await writeReferralChartNote(office, r.referralId, {
        milestone: state.milestone,
        note: final,
      });
      toast.success(`Written to the chart (Open Dental note ${commLogNum})`);
      onWritten(next);
    } catch (e) {
      // Nothing reads as written: the server's own sentence, the text kept as typed.
      setError(tcErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="space-y-1.5" data-testid={id}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{TC_REFERRAL_CHART_MILESTONE_LABELS[state.milestone]}</span>
        {!open && (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)} data-testid={`${id}-review`}>
            <ClipboardPen className="w-3.5 h-3.5 mr-1.5" /> Review note
          </Button>
        )}
      </div>
      {open && (
        <div className="space-y-1.5 rounded-md border border-border p-2">
          <Label htmlFor={`${id}-text`} className="text-xs">
            Note (edit before writing)
          </Label>
          <Textarea
            id={`${id}-text`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            data-testid={`${id}-text`}
          />
          <p className="text-xs text-muted-foreground">This exact text will be written to the patient's Open Dental chart:</p>
          <pre
            className="whitespace-pre-wrap rounded bg-muted px-2 py-1.5 text-xs font-sans"
            data-testid={`${id}-final`}
          >
            {final || "—"}
          </pre>
          {tooLong && (
            <p className="text-xs text-destructive">
              {final.length} of {TC_REFERRAL_CHART_NOTE_MAX} characters — shorten it to write it.
            </p>
          )}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => void writeIt()}
              disabled={busy || blockedReason !== null || final.length === 0 || tooLong}
              data-testid={`${id}-write`}
            >
              {busy && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
              Write to chart
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setText(draft);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
          {blockedReason !== null && (
            <p className="text-xs text-muted-foreground" data-testid={`${id}-blocked`}>
              {blockedReason}
            </p>
          )}
          {error && (
            <p className="text-xs text-destructive" data-testid={`${id}-error`}>
              {error}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

export function ChartNotes({
  office,
  referral: r,
  onWritten,
}: {
  /** The office the referral was read from — the call goes there. */
  office: OfficeId;
  referral: TcReferral;
  /** The server's read-back after a note was written and confirmed. */
  onWritten: (next: TcReferral) => void;
}) {
  const milestones = referralChartMilestones(r.events);
  if (milestones.length === 0) return null;
  const blockedReason = !r.chartNotes
    ? CHART_NOTES_UNKNOWN_COPY
    : r.chartNotes.available
      ? null
      : (r.chartNotes.reason ?? CHART_NOTES_UNKNOWN_COPY);

  return (
    <div className="space-y-1.5" data-testid="tc-chart-notes">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Chart note</h3>
      <ul className="space-y-2">
        {milestones.map((m) =>
          m.written ? (
            <WrittenRow key={m.milestone} state={{ ...m, written: m.written }} />
          ) : (
            <OpenRow
              key={m.milestone}
              office={office}
              referral={r}
              state={m}
              blockedReason={blockedReason}
              onWritten={onWritten}
            />
          ),
        )}
      </ul>
    </div>
  );
}

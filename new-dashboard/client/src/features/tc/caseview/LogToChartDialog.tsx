/**
 * "Log to chart" (AT-2) — one Activity-tab item written to the patient's Open
 * Dental chart as a commlog, ONLY when a person presses Confirm on text they
 * can see.
 *
 * Opens to the server's preview: may it be charted, a drafted note the person
 * may edit, the office, and the commlog type ("Open Dental chart note — CareIN
 * TC"). The FINAL text — exactly what will be stored: trimmed, OD-safe, plus
 * the "[Conversation date: …]" line when a date is picked — sits directly
 * above Confirm, and that is what is sent. Nothing here writes on its own: no
 * effect, timer or status change calls the route; only the Confirm click.
 *
 * When the office cannot take a note (no "CareIN TC" type configured, writes
 * switched off) Confirm is disabled and the server's named reason is shown.
 * The server re-checks all of it.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { OfficeId } from "@shared/tc/contract";
import {
  activityChartFinalText,
  type TcActivityChartPreview,
  type TcActivityChartWritten,
} from "@shared/tc/activity";
import { referralChartNoteOdSafe } from "@shared/tc/referrals";
import { getActivityChartPreview, logActivityToChart, tcErrorMessage } from "../api";

/** What will be stored for what the person typed: trimmed, OD-safe, plus the date line. Pure. */
export function logToChartFinalText(typed: string, conversationDate: string): string {
  return activityChartFinalText(referralChartNoteOdSafe(typed.trim()), conversationDate || null);
}

/** Today as YYYY-MM-DD in the browser's zone — the date picker's ceiling. */
function todayYmd(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

type Load =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; preview: TcActivityChartPreview };

export interface LogToChartDialogProps {
  office: OfficeId;
  caseId: string;
  itemId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The server's confirmation after the note was written AND read back. */
  onWritten: (written: TcActivityChartWritten) => void;
}

export function LogToChartDialog({ office, caseId, itemId, open, onOpenChange, onWritten }: LogToChartDialogProps) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [text, setText] = useState("");
  const [conversationDate, setConversationDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoad({ kind: "loading" });
    setError(null);
    setConversationDate("");
    getActivityChartPreview(office, caseId, itemId)
      .then((preview) => {
        if (!live) return;
        setText(preview.defaultText ?? "");
        setLoad({ kind: "ready", preview });
      })
      .catch((e: unknown) => {
        if (live) setLoad({ kind: "error", message: tcErrorMessage(e) });
      });
    return () => {
      live = false;
    };
  }, [open, office, caseId, itemId]);

  const preview = load.kind === "ready" ? load.preview : null;
  const final = logToChartFinalText(text, conversationDate);
  const max = preview?.maxLength ?? 2000;
  const tooLong = final.length > max;
  const blockedReason: string | null = !preview
    ? null
    : !preview.chartable.eligible
      ? (preview.chartable.reason ?? "This item can't be charted.")
      : !preview.availability.available
        ? (preview.availability.message ?? "This office's charts can't take a note right now.")
        : !preview.hasPatient
          ? "This case is not linked to an Open Dental patient."
          : null;
  const canConfirm = preview !== null && blockedReason === null && !busy && text.trim().length > 0 && !tooLong;

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      // What is sent is what is shown above the button — nothing else.
      const written = await logActivityToChart(office, caseId, itemId, {
        text: referralChartNoteOdSafe(text.trim()),
        ...(conversationDate ? { conversationDate } : {}),
      });
      toast.success(`Written to the chart (Open Dental note ${written.commLogNum})`);
      onWritten(written);
      onOpenChange(false);
    } catch (e) {
      // Nothing reads as written: the server's own sentence, the text kept as typed.
      setError(tcErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-lg" data-testid="tc-log-to-chart-dialog">
        <DialogHeader>
          <DialogTitle>Log to chart</DialogTitle>
          <DialogDescription>
            {preview
              ? `${preview.office.name} · Open Dental chart note — ${preview.commType.name}`
              : "Open Dental chart note — CareIN TC"}
          </DialogDescription>
        </DialogHeader>

        {load.kind === "loading" && <p className="text-sm text-muted-foreground">Loading…</p>}
        {load.kind === "error" && (
          <p role="alert" className="text-sm text-destructive">
            {load.message}
          </p>
        )}

        {preview && (
          <div className="space-y-3">
            {preview.onChart && (
              <p className="text-sm text-muted-foreground" data-testid="tc-log-to-chart-already">
                Already on the chart (Open Dental note {preview.onChart.commLogNum}) — written by {preview.onChart.writtenBy}.
              </p>
            )}
            {preview.chartable.eligible && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="tc-log-to-chart-text" className="text-xs">
                    Note (edit before writing)
                  </Label>
                  <Textarea
                    id="tc-log-to-chart-text"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    rows={6}
                    data-testid="tc-log-to-chart-text"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="tc-log-to-chart-date" className="text-xs">
                    Conversation date (optional — goes into the note text only)
                  </Label>
                  <Input
                    id="tc-log-to-chart-date"
                    type="date"
                    max={todayYmd()}
                    value={conversationDate}
                    onChange={(e) => setConversationDate(e.target.value)}
                    className="w-44"
                    data-testid="tc-log-to-chart-date"
                  />
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">
                    This exact text will be written to the patient's Open Dental chart in {preview.office.name}, dated
                    now:
                  </p>
                  <pre
                    className="whitespace-pre-wrap break-words rounded bg-muted px-2 py-1.5 text-xs font-sans"
                    data-testid="tc-log-to-chart-final"
                  >
                    {final || "—"}
                  </pre>
                  {tooLong && (
                    <p className="text-xs text-destructive">
                      {final.length} of {max} characters — shorten it to write it.
                    </p>
                  )}
                </div>
              </>
            )}
            {blockedReason !== null && (
              <p className="text-xs text-muted-foreground" data-testid="tc-log-to-chart-blocked">
                {blockedReason}
              </p>
            )}
            {error && (
              <p className="text-xs text-destructive" data-testid="tc-log-to-chart-error">
                {error}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void confirm()} disabled={!canConfirm} data-testid="tc-log-to-chart-confirm">
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

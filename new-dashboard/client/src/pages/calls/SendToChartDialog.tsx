/**
 * Send to Chart dialog (Slice B.1 — review-then-send, with editable notes).
 *
 * The single "review/edit → send" surface for EVERY path to the chart: an
 * auto-matched call (patient known) and the Pick Patient flow (patient just
 * chosen) both land here. The generated note is pre-filled into an editable
 * textarea; what the user sends is exactly what's written (server sanitizes for
 * OD). "Reset to generated" restores the original. Nothing is written until Send.
 */
import { useEffect, useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Send, Loader2, RotateCcw, Building2 } from "lucide-react";
import { api, normalizeUnifiedCall, type UnifiedCall, type OfficeConfig } from "@/lib/api";
import { toast } from "sonner";

interface SendToChartDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  call: UnifiedCall;
  /** The patient to write to (matched patient, or the one just picked). */
  patientId: number;
  patientName: string;
  /**
   * The send succeeded. `updated` is the server's COMPLETE post-send call record
   * (normalized), or null when the response carried none. Render from it rather
   * than patching the fields you think changed: the send also sets
   * od_patient_name, which "Send to TC" visibility depends on, and a hand-rolled
   * patch that forgets it leaves that button disabled until a page refresh.
   */
  onSent: (updated: UnifiedCall | null) => void;
  /**
   * What to write (item 4): 'summary' (compact block, default) or 'transcript'
   * (full transcript — a large note, the user's deliberate choice). The contextual
   * buttons on the call-detail page set this; the worklist-row Send omits it (summary).
   */
  contentType?: "summary" | "transcript";
}

export function SendToChartDialog({ open, onOpenChange, call, patientId, patientName, onSent, contentType = "summary" }: SendToChartDialogProps) {
  const [generated, setGenerated] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [sending, setSending] = useState(false);
  // Which practice's chart this note is headed for, per the server.
  const [office, setOffice] = useState<OfficeConfig | null>(null);

  useEffect(() => {
    if (!open) return;
    setGenerated(null);
    setText("");
    setOffice(null);
    setLoadingPreview(true);
    let cancelled = false;
    api.getCommlogPreview(call.id, contentType)
      .then((res) => {
        if (cancelled) return;
        setGenerated(res.note);
        setText(res.note);
        setOffice(res.office ?? null);
      })
      .catch(() => { if (!cancelled) { setGenerated(null); setText(""); } })
      .finally(() => { if (!cancelled) setLoadingPreview(false); });
    return () => { cancelled = true; };
  }, [open, call.id, contentType]);

  const edited = generated != null && text.trim() !== generated.trim();

  const send = async () => {
    if (!patientId) { toast.error("No patient selected to send to", { duration: 8000 }); return; }
    if (!text.trim()) { toast.error("Note is empty", { duration: 8000 }); return; }
    setSending(true);
    try {
      const res = await api.resolvePatient(call.id, {
        patientId,
        note: text,
        content_type: contentType,
        // Assert the office the UI thinks it is writing to. The server resolves the
        // real one from the call and refuses on a mismatch, so a stale screen can
        // never send a note to the wrong practice — it gets an error instead.
        ...(office ? { office_id: office.officeId } : {}),
      });
      if (res.success) {
        const where = office ? `${patientName}'s chart at ${office.officeName}` : `${patientName}'s chart`;
        toast.success(res.alreadySynced ? `Already on ${where}` : `Sent to ${where}`);
        // Hand back what the SERVER says the call now is — including the matched
        // patient's name, which is what makes "Send to TC" become usable without
        // a reload.
        onSent(res.call ? normalizeUnifiedCall(res.call) : null);
        onOpenChange(false);
      } else {
        toast.error("Could not send to chart", { duration: 8000 });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send to chart", { duration: 8000 });
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{contentType === "transcript" ? "Send full transcript to chart" : "Send summary to chart"}</DialogTitle>
          <DialogDescription>
            Writes this {contentType === "transcript" ? "full transcript" : "summary"} to{" "}
            <span className="font-medium text-foreground">{patientName}</span>'s Open Dental chart.
            Review or edit it first — nothing is written until you confirm.
          </DialogDescription>
        </DialogHeader>

        {/* WHICH practice's chart. PatNum numbering restarts per Open Dental database,
            so the patient name alone doesn't say where this note lands. */}
        {office && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground rounded-md border border-border/60 px-2.5 py-1.5">
            <Building2 size={12} className="flex-shrink-0" />
            <span>
              Writing to <span className="font-medium text-foreground">{office.officeName}</span>
              {patientId ? <> · PatNum {patientId}</> : null}
            </span>
          </div>
        )}

        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Chart note {edited && <span className="text-sky-600 normal-case font-medium">· edited</span>}
          </span>
          <button
            type="button"
            onClick={() => { if (generated != null) setText(generated); }}
            disabled={!edited || loadingPreview}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            <RotateCcw size={11} /> Reset to generated
          </button>
        </div>

        {loadingPreview ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-8 justify-center">
            <Loader2 size={13} className="animate-spin" /> Building note…
          </div>
        ) : (
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="min-h-56 max-h-72 text-[11px] leading-relaxed font-mono"
            spellCheck={false}
          />
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={sending}>
            Cancel
          </Button>
          <Button size="sm" className="gap-1.5" onClick={send} disabled={sending || loadingPreview || !text.trim()}>
            {sending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
            Send to chart
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

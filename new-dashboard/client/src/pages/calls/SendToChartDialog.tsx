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
import { Send, Loader2, RotateCcw } from "lucide-react";
import { api, type UnifiedCall } from "@/lib/api";
import { toast } from "sonner";

interface SendToChartDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  call: UnifiedCall;
  /** The patient to write to (matched patient, or the one just picked). */
  patientId: number;
  patientName: string;
  onSent: () => void;
}

export function SendToChartDialog({ open, onOpenChange, call, patientId, patientName, onSent }: SendToChartDialogProps) {
  const [generated, setGenerated] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setGenerated(null);
    setText("");
    setLoadingPreview(true);
    let cancelled = false;
    api.getCommlogPreview(call.id)
      .then((res) => { if (!cancelled) { setGenerated(res.note); setText(res.note); } })
      .catch(() => { if (!cancelled) { setGenerated(null); setText(""); } })
      .finally(() => { if (!cancelled) setLoadingPreview(false); });
    return () => { cancelled = true; };
  }, [open, call.id]);

  const edited = generated != null && text.trim() !== generated.trim();

  const send = async () => {
    if (!patientId) { toast.error("No patient selected to send to", { duration: 8000 }); return; }
    if (!text.trim()) { toast.error("Note is empty", { duration: 8000 }); return; }
    setSending(true);
    try {
      const res = await api.resolvePatient(call.id, { patientId, note: text });
      if (res.success) {
        toast.success(res.alreadySynced ? `Already on ${patientName}'s chart` : `Sent to ${patientName}'s chart`);
        onSent();
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
          <DialogTitle>Send to chart</DialogTitle>
          <DialogDescription>
            Writes this note to <span className="font-medium text-foreground">{patientName}</span>'s Open Dental chart.
            Review or edit it first — nothing is written until you confirm.
          </DialogDescription>
        </DialogHeader>

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

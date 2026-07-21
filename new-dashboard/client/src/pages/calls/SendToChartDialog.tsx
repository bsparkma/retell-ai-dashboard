/**
 * Send to Chart dialog (Slice B.1 — review-then-send).
 *
 * For an auto-MATCHED call (patient known, nothing written yet). Shows a faithful
 * PREVIEW of the exact commlog note that will be written, then on confirm drives
 * the same idempotent resolve/send path (audited, attributed sent_by/sent_at).
 * Nothing is written to the chart until the human clicks Send.
 */
import { useEffect, useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Send, Loader2 } from "lucide-react";
import { api, type UnifiedCall } from "@/lib/api";
import { toast } from "sonner";

interface SendToChartDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  call: UnifiedCall;
  onSent: () => void;
}

export function SendToChartDialog({ open, onOpenChange, call, onSent }: SendToChartDialogProps) {
  const [note, setNote] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [sending, setSending] = useState(false);

  const patientLabel = call.odPatientName || (call.odPatientId ? `PatNum ${call.odPatientId}` : "matched patient");

  useEffect(() => {
    if (!open) return;
    setNote(null);
    setLoadingPreview(true);
    let cancelled = false;
    api.getCommlogPreview(call.id)
      .then((res) => { if (!cancelled) setNote(res.note); })
      .catch(() => { if (!cancelled) setNote(null); })
      .finally(() => { if (!cancelled) setLoadingPreview(false); });
    return () => { cancelled = true; };
  }, [open, call.id]);

  const send = async () => {
    if (!call.odPatientId) {
      toast.error("No matched patient to send", { duration: 8000 });
      return;
    }
    setSending(true);
    try {
      const res = await api.resolvePatient(call.id, { patientId: Number(call.odPatientId) });
      if (res.success) {
        toast.success(res.alreadySynced ? `Already on ${patientLabel}'s chart` : `Sent to ${patientLabel}'s chart`);
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
            Writes this note to <span className="font-medium text-foreground">{patientLabel}</span>'s Open Dental chart.
            Nothing is written until you confirm.
          </DialogDescription>
        </DialogHeader>

        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Note preview</div>
        <div className="max-h-72 overflow-y-auto rounded-md border bg-muted/40 p-3">
          {loadingPreview ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-4 justify-center">
              <Loader2 size={13} className="animate-spin" /> Building preview…
            </div>
          ) : note ? (
            <pre className="text-[11px] leading-relaxed whitespace-pre-wrap font-mono text-foreground">{note}</pre>
          ) : (
            <p className="text-xs text-muted-foreground py-4 text-center">Preview unavailable.</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={sending}>
            Cancel
          </Button>
          <Button size="sm" className="gap-1.5" onClick={send} disabled={sending || loadingPreview || !note}>
            {sending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
            Send to chart
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

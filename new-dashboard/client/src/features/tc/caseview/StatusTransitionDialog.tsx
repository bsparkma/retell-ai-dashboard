/**
 * Status transition dialog — THE way a case changes status from the case view.
 *
 * Mirrors the backend guard client-side via validateTransition (lost requires
 * lostReason) so bad submits never leave the dialog. Confirmed-save: success
 * toast fires only after transitionCase resolves; rejections keep the dialog
 * open with values intact.
 */
import { useEffect, useState } from "react";
import type { OfficeId, TcCase } from "@shared/tc/contract";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";
import { tcErrorMessage, transitionCase } from "../api";
import {
  ALL_CASE_STATUSES,
  CASE_STATUSES,
  LOST_REASON_LABELS,
  validateTransition,
} from "../status";
import type { CaseStatusId, LostReasonId } from "../status";

const LOST_REASON_IDS = Object.keys(LOST_REASON_LABELS) as LostReasonId[];

export interface StatusTransitionDialogProps {
  office: OfficeId;
  tcCase: TcCase;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Receives the server's persisted case (also when changed:false). */
  onSuccess: (updated: TcCase) => void;
}

export function StatusTransitionDialog({
  office,
  tcCase,
  open,
  onOpenChange,
  onSuccess,
}: StatusTransitionDialogProps) {
  const [status, setStatus] = useState<CaseStatusId>(tcCase.status);
  const [lostReason, setLostReason] = useState<LostReasonId | null>(tcCase.lostReason);
  const [note, setNote] = useState("");
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Reset the form to the case's current state each time the dialog opens.
  useEffect(() => {
    if (open) {
      setStatus(tcCase.status);
      setLostReason(tcCase.lostReason);
      setNote("");
      setInlineError(null);
      setSubmitting(false);
    }
  }, [open, tcCase.status, tcCase.lostReason]);

  const pickStatus = (next: CaseStatusId) => {
    setStatus(next);
    if (next !== "lost") setLostReason(null);
    setInlineError(null);
  };

  const submit = async () => {
    const effectiveReason = status === "lost" ? lostReason : null;
    const check = validateTransition(status, effectiveReason);
    if (!check.ok) {
      setInlineError(check.message);
      return;
    }
    setInlineError(null);
    setSubmitting(true);
    try {
      const result = await transitionCase(office, tcCase.caseId, {
        status,
        lostReason: effectiveReason,
        note: note.trim(),
      });
      // changed:false is still success — the server case is authoritative.
      toast.success(result.changed ? "Status updated" : "Status unchanged");
      onSuccess(result.case);
      onOpenChange(false);
    } catch (e) {
      toast.error(tcErrorMessage(e));
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !submitting && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change status</DialogTitle>
          <DialogDescription>
            {tcCase.patientName} — currently {CASE_STATUSES[tcCase.status].label}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="tc-status-select">New status</Label>
            <Select value={status} onValueChange={(v) => pickStatus(v as CaseStatusId)}>
              <SelectTrigger id="tc-status-select" aria-label="New status" className="w-full">
                <SelectValue placeholder="Pick a status" />
              </SelectTrigger>
              <SelectContent>
                {ALL_CASE_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {CASE_STATUSES[s].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {status === "lost" && (
            <div className="space-y-1.5">
              <Label htmlFor="tc-lost-reason-select">Lost reason</Label>
              <Select
                value={lostReason ?? undefined}
                onValueChange={(v) => {
                  setLostReason(v as LostReasonId);
                  setInlineError(null);
                }}
              >
                <SelectTrigger
                  id="tc-lost-reason-select"
                  aria-label="Lost reason"
                  className="w-full"
                >
                  <SelectValue placeholder="Why was this case lost?" />
                </SelectTrigger>
                <SelectContent>
                  {LOST_REASON_IDS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {LOST_REASON_LABELS[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="tc-status-note">Note (optional)</Label>
            <Textarea
              id="tc-status-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Context for this change…"
              rows={3}
            />
          </div>

          {inlineError && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {inlineError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={submitting}>
            {submitting && <Loader2 className="animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Status transition dialog — THE way a case changes status from the case view.
 *
 * Mirrors the backend guard client-side via validateTransition (lost requires
 * lostReason) so bad submits never leave the dialog. Confirmed-save: success
 * toast fires only after transitionCase resolves; rejections keep the dialog
 * open with values intact.
 *
 * Next touch: moving a case INTO an open status requires a next-touch date and
 * owner (defaults: the signed-in person, two business days out) unless the
 * case already has a pending follow-up. The server enforces the same rule
 * (409 NEXT_TOUCH_REQUIRED). If the case changed under the dialog, that 409
 * reveals the fields instead of failing.
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
import { isAcceptedStatus, useWinCelebration } from "@/features/tc/wins/WinCelebrationProvider";
import { isOpenCaseStatus, pickNextTouch } from "@shared/tc/nextTouch";
import {
  defaultNextTouchValues,
  isNextTouchRequired,
  NextTouchFields,
  nextTouchValuesError,
  useCurrentUserEmail,
  type NextTouchValues,
} from "../nextTouch/NextTouch";
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
  const { celebrateWin } = useWinCelebration();
  const me = useCurrentUserEmail();
  const [touch, setTouch] = useState<NextTouchValues>(() => defaultNextTouchValues(me));
  /** The server said this move needs a next touch even though the case looked covered. */
  const [serverWantsTouch, setServerWantsTouch] = useState(false);

  // Reset the form to the case's current state each time the dialog opens.
  useEffect(() => {
    if (open) {
      setStatus(tcCase.status);
      setLostReason(tcCase.lostReason);
      setNote("");
      setInlineError(null);
      setSubmitting(false);
      setTouch(defaultNextTouchValues(me));
      setServerWantsTouch(false);
    }
  }, [open, tcCase.status, tcCase.lostReason, me]);

  const pickStatus = (next: CaseStatusId) => {
    setStatus(next);
    if (next !== "lost") setLostReason(null);
    setInlineError(null);
  };

  // Same status selected: the only thing Save can do is keep the note, so the
  // button says so — and with no note there is nothing to save at all.
  const sameStatus = status === tcCase.status;
  const hasNote = note.trim() !== "";
  const nothingToSave = sameStatus && !hasNote;
  const saveLabel = sameStatus && hasNote ? "Save note" : "Save";
  const hasPendingTouch = pickNextTouch(tcCase.followups) !== null;
  const needsNextTouch =
    !sameStatus && isOpenCaseStatus(status) && (!hasPendingTouch || serverWantsTouch);

  const submit = async () => {
    if (nothingToSave) return;
    const effectiveReason = status === "lost" ? lostReason : null;
    const check = validateTransition(status, effectiveReason);
    if (!check.ok) {
      setInlineError(check.message);
      return;
    }
    if (needsNextTouch) {
      const problem = nextTouchValuesError(touch);
      if (problem) {
        setInlineError(problem);
        return;
      }
    }
    setInlineError(null);
    setSubmitting(true);
    try {
      const result = await transitionCase(office, tcCase.caseId, {
        status,
        lostReason: effectiveReason,
        note: note.trim(),
        // Only on a move that needs one: the server refuses it otherwise.
        ...(needsNextTouch
          ? { nextTouch: { dueDate: touch.dueDate, owner: touch.owner.trim(), channel: touch.channel } }
          : {}),
      });
      // changed:false is still success — the server case is authoritative.
      toast.success(
        result.changed ? "Status updated" : result.noteAdded ? "Note saved" : "Status unchanged",
      );
      // Celebrate only a real, server-confirmed move into the accepted family.
      if (result.changed && isAcceptedStatus(result.case.status)) {
        celebrateWin(
          {
            caseId: result.case.caseId,
            patientName: result.case.patientName,
            caseValueCents: result.case.caseValueCents,
            // The persisted case's office: the overlay asks THAT office's
            // funnel for its served acceptance rate.
            office: result.case.officeId,
          },
          null,
        );
      }
      onSuccess(result.case);
      onOpenChange(false);
    } catch (e) {
      if (isNextTouchRequired(e) && !needsNextTouch) {
        // The case lost its pending follow-up since it loaded: ask, don't fail.
        setServerWantsTouch(true);
        setInlineError("This case has no next step anymore. Set a next touch to move it.");
      } else {
        toast.error(tcErrorMessage(e));
      }
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !submitting && onOpenChange(o)}>
      <DialogContent className={needsNextTouch ? "sm:max-w-lg" : "sm:max-w-md"}>
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

          {needsNextTouch && (
            <div className="space-y-2 rounded-lg border border-border p-3">
              <p className="text-xs text-muted-foreground">
                {CASE_STATUSES[status].label} is open work, so the case needs a next touch: when,
                and who makes it.
              </p>
              <NextTouchFields
                value={touch}
                onChange={(v) => {
                  setTouch(v);
                  setInlineError(null);
                }}
                disabled={submitting}
              />
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
          <Button onClick={() => void submit()} disabled={submitting || nothingToSave}>
            {submitting && <Loader2 className="animate-spin" />}
            {saveLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

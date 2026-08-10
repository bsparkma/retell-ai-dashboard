/**
 * Confirmation shown before a transcription that would spend budget on something we
 * arguably already have. Two reasons, one dialog (Mango slices M4 and M7).
 *
 * WHY THIS EXISTS. Most refusals are free — a spent budget, a recording that isn't
 * published yet, a call already being transcribed: nothing was charged, so clicking again
 * costs nothing and needs no ceremony. Two cases are not free:
 *
 *   `rebill` (M4)        Azure Speech billed for the audio and returned nothing, so a
 *                        retry is a FRESH charge for the same silent recording.
 *   `duplicate_leg` (M7) this is the PBX copy of a call the AI answered end to end. The
 *                        transcript already exists on the linked Retell row, so
 *                        transcribing this one pays to produce a second copy of it. This
 *                        had already happened twice on production before twins were
 *                        linked.
 *
 * Both are deliberately CONFIRMATIONS AND NOT LOCKOUTS. Somebody may have a real reason —
 * a recording that was still uploading, a genuinely quiet call worth a second look, a
 * question about the PBX-side audio — and these slices exist to put that judgement in a
 * human's hands, not to take it away. The duplicate-leg variant additionally offers
 * somewhere better to go: a link straight to the call that already has the transcript.
 *
 * Shared by both button placements so the wording can only be changed in one place.
 */

import { Link } from "wouter";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  REBILL_CONFIRM_TITLE, REBILL_CONFIRM_BODY, REBILL_CONFIRM_ACCEPT, REBILL_CONFIRM_CANCEL,
  DUPLICATE_LEG_CONFIRM_TITLE, DUPLICATE_LEG_CONFIRM_BODY, DUPLICATE_LEG_CONFIRM_ACCEPT,
  DUPLICATE_LEG_CONFIRM_CANCEL, DUPLICATE_LEG_JUMP_LABEL,
} from "@/lib/transcribe";
import type { TranscribeConfirmKind } from "@/hooks/useTranscribeCall";

export interface TranscribeRebillDialogProps {
  open: boolean;
  /**
   * Why we're asking. Defaults to the M4 re-bill wording so existing call sites that
   * only ever raise that case keep working unchanged.
   */
  kind?: TranscribeConfirmKind | null;
  /**
   * The linked Retell call that already holds the transcript. Only meaningful for
   * `duplicate_leg`; when present the dialog offers a link to it.
   */
  linkedCallId?: string | null;
  /** The user said yes — spend the budget. */
  onConfirm: () => void;
  /** The user said no, or dismissed. Nothing is spent. */
  onCancel: () => void;
}

export function TranscribeRebillDialog({
  open, kind = "rebill", linkedCallId, onConfirm, onCancel,
}: TranscribeRebillDialogProps) {
  const isDuplicate = kind === "duplicate_leg";
  const title = isDuplicate ? DUPLICATE_LEG_CONFIRM_TITLE : REBILL_CONFIRM_TITLE;
  const body = isDuplicate ? DUPLICATE_LEG_CONFIRM_BODY : REBILL_CONFIRM_BODY;
  const accept = isDuplicate ? DUPLICATE_LEG_CONFIRM_ACCEPT : REBILL_CONFIRM_ACCEPT;
  const cancel = isDuplicate ? DUPLICATE_LEG_CONFIRM_CANCEL : REBILL_CONFIRM_CANCEL;

  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        {/* The better answer to "I want this transcript" is the row that already has it.
            Dismisses the dialog on the way out so we don't navigate behind a modal. */}
        {isDuplicate && linkedCallId && (
          <Link
            href={`/calls/${linkedCallId}`}
            onClick={onCancel}
            className="text-sm font-medium text-primary underline underline-offset-4"
          >
            {DUPLICATE_LEG_JUMP_LABEL}
          </Link>
        )}
        <AlertDialogFooter>
          {/* Cancel is the safe default: dismissing costs nothing. */}
          <AlertDialogCancel onClick={onCancel}>{cancel}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{accept}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

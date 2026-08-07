/**
 * Re-bill confirmation for a call whose last transcription found no speech
 * (Mango slice M4).
 *
 * WHY THIS EXISTS. Every other refusal is free — a spent budget, a recording that isn't
 * published yet, a call already being transcribed: nothing was charged, so clicking again
 * costs nothing and needs no ceremony. `no_speech` is the exception. Azure Speech billed
 * for the audio and returned nothing, so a retry is a FRESH charge for the same silent
 * recording. Left unguarded, a row that looks idle re-bills on every misclick, which
 * breaks the promise the whole button makes: an existing result is never re-billed.
 *
 * Deliberately a confirmation and NOT a lockout. Somebody may have a real reason to retry
 * — a recording that was still uploading, a genuinely quiet call worth a second look — and
 * this slice exists to put that judgement in a human's hands, not to take it away.
 *
 * Shared by both button placements so the wording can only be changed in one place.
 */

import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  REBILL_CONFIRM_TITLE, REBILL_CONFIRM_BODY, REBILL_CONFIRM_ACCEPT, REBILL_CONFIRM_CANCEL,
} from "@/lib/transcribe";

export interface TranscribeRebillDialogProps {
  open: boolean;
  /** The user said yes — spend the budget. */
  onConfirm: () => void;
  /** The user said no, or dismissed. Nothing is spent. */
  onCancel: () => void;
}

export function TranscribeRebillDialog({ open, onConfirm, onCancel }: TranscribeRebillDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{REBILL_CONFIRM_TITLE}</AlertDialogTitle>
          <AlertDialogDescription>{REBILL_CONFIRM_BODY}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {/* Cancel is the safe default: dismissing costs nothing. */}
          <AlertDialogCancel onClick={onCancel}>{REBILL_CONFIRM_CANCEL}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{REBILL_CONFIRM_ACCEPT}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

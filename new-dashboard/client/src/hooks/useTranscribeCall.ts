/**
 * useTranscribeCall — the shared runner behind both "Transcribe & Summarize" buttons
 * (worklist row action + call detail primary action), Mango slice M4.
 *
 * Owns exactly two things: which calls are in flight right now, and turning the outcome
 * into the one message defined in lib/transcribe.ts. Everything else — dedup, the daily
 * breaker, recording freshness — is the server's decision, reported honestly.
 *
 * The in-flight set is a ref, not state: it is a GUARD (a second click must be a no-op
 * before any render happens), while the mirrored array is what components render from.
 * Guarding on state alone would let a fast double-click through between renders.
 */

import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { api, type TranscribeResult } from "@/lib/api";
import { transcribeFeedback, toastDuration } from "@/lib/transcribe";

export interface UseTranscribeCall {
  /** Is this specific call being transcribed right now? */
  isRunning: (callId: string) => boolean;
  /** Kick off a transcription. Resolves with the outcome, or null if already running. */
  run: (callId: string) => Promise<TranscribeResult | null>;
}

/**
 * @param onResult called after every completed request (any outcome) so the caller can
 *                 refresh the row / page. Not called when the click was a no-op.
 */
export function useTranscribeCall(
  onResult?: (callId: string, result: TranscribeResult) => void,
): UseTranscribeCall {
  const inFlight = useRef<Set<string>>(new Set());
  const [running, setRunning] = useState<string[]>([]);

  const run = useCallback(
    async (callId: string): Promise<TranscribeResult | null> => {
      // Second click while this call is running: do nothing. Never an error toast — the
      // button is already disabled, so this is belt-and-braces, not a user-facing state.
      if (inFlight.current.has(callId)) return null;
      inFlight.current.add(callId);
      setRunning((prev) => (prev.includes(callId) ? prev : [...prev, callId]));

      try {
        const result = await api.transcribeMangoCall(callId);
        const feedback = transcribeFeedback(result);
        toast[feedback.kind](feedback.text, { duration: toastDuration(feedback.kind) });
        onResult?.(callId, result);
        return result;
      } catch {
        // Network/parse failure — the request never produced a typed answer. Report the
        // generic error state; the call stays transcribable.
        const result: TranscribeResult = { status: "error" };
        const feedback = transcribeFeedback(result);
        toast.error(feedback.text, { duration: toastDuration("error") });
        onResult?.(callId, result);
        return result;
      } finally {
        inFlight.current.delete(callId);
        setRunning((prev) => prev.filter((id) => id !== callId));
      }
    },
    [onResult],
  );

  const isRunning = useCallback((callId: string) => running.includes(callId), [running]);

  return { isRunning, run };
}

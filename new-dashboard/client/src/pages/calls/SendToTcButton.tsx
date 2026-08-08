/**
 * "Send to TC" — the voice side of the cross-module handoff (Mango slice M6).
 *
 * One component for both surfaces (the call-detail patient panel and the worklist
 * row), so WHEN it appears and WHAT it says can't drift between them. The decision
 * itself lives in lib/sendToTc.ts; this file is the states a human sees.
 *
 * Honest states, per the platform rule:
 *   idle     → "Send to TC"
 *   in-flight→ disabled, "Sending…"
 *   success  → a toast that distinguishes a NEW case from one it was ADDED to,
 *              with an "Open in TC" action, then the button becomes a passive
 *              "In TC" link. The server is idempotent on call_id, but a button
 *              that still looks sendable invites a click that does nothing new.
 *   failure  → never optimistic. Nothing is marked sent unless the server said so.
 */
import { useState } from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { KanbanSquare, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError, type UnifiedCall } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { hasModule } from "@/lib/modules";
import {
  sendToTcState, tcErrorMessage, tcPatientLabel, tcSuccessMessage,
} from "@/lib/sendToTc";

export interface SendToTcResult {
  caseId: string;
  caseUrl: string | null;
}

interface SendToTcButtonProps {
  call: UnifiedCall;
  /** Called after the server confirms the handoff, so the page can reflect it. */
  onSent: (result: SendToTcResult) => void;
  /**
   * "row" = the compact worklist affordance; "panel" = the full-width button in
   * the call-detail patient card, next to Send to chart.
   */
  variant?: "row" | "panel";
}

export function SendToTcButton({ call, onSent, variant = "row" }: SendToTcButtonProps) {
  const auth = useAuth();
  const [, navigate] = useLocation();
  const [sending, setSending] = useState(false);

  const tcEntitled = hasModule(
    auth.status === "authenticated" ? auth.user.tenant?.modules : undefined,
    "tc",
  );
  const state = sendToTcState(call, tcEntitled);

  if (state.kind === "hidden") return null;

  const compact = variant === "row";
  const className = compact
    ? "h-7 gap-1 text-[11px] px-2 flex-shrink-0"
    : "w-full gap-1.5 text-xs";

  // Already in TC → a link to the case, not a button. When the stored url is
  // somehow missing we still say "In TC" (the linkage is real) but don't offer a
  // dead link.
  if (state.kind === "sent") {
    const label = (
      <span className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded-full text-violet-700 bg-violet-500/10">
        <KanbanSquare size={11} /> In TC
      </span>
    );
    if (!state.caseUrl) {
      return <span title="This call is on a TC case">{label}</span>;
    }
    return (
      <Link href={state.caseUrl} className="hover:underline" title="Open this call's TC case">
        {label}
      </Link>
    );
  }

  const disabledReason = state.kind === "disabled" ? state.reason : null;

  const send = async () => {
    setSending(true);
    const patientName = tcPatientLabel(call);
    try {
      const res = await api.sendCallToTc(call.id, {
        // Assert the office this screen believes the call belongs to. The server
        // resolves the real one and refuses on a mismatch — this can only cause a
        // refusal, never file the case under another practice.
        ...(call.officeId ? { office_id: call.officeId } : {}),
      });
      if (!res.success || !res.caseId) {
        toast.error(tcErrorMessage(null, null), { duration: 8000 });
        return;
      }
      const caseUrl = res.url ?? null;
      toast.success(
        tcSuccessMessage(patientName, res.alreadySent ? null : res.attached),
        caseUrl ? { action: { label: "Open in TC", onClick: () => navigate(caseUrl) } } : undefined,
      );
      onSent({ caseId: res.caseId, caseUrl });
    } catch (err) {
      const status = err instanceof ApiError ? err.status : null;
      const code = err instanceof ApiError ? err.code : null;
      toast.error(tcErrorMessage(status, code), { duration: 8000 });
    } finally {
      setSending(false);
    }
  };

  return (
    <Button
      size="sm"
      variant="outline"
      className={className}
      disabled={sending || disabledReason !== null}
      onClick={send}
      title={disabledReason ?? "Open or update this patient's Treatment Coordinator case"}
    >
      {sending
        ? <><Loader2 size={compact ? 11 : 12} className="animate-spin" /> Sending…</>
        : <><KanbanSquare size={compact ? 11 : 12} /> Send to TC</>}
    </Button>
  );
}

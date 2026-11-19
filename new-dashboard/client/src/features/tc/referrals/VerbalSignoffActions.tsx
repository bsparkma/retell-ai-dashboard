/**
 * Verbal sign-off (mode 'verbal', referral-verbal-signoff): on a referral
 * awaiting sign-off, a tc.full user RECORDS a doctor's verbal answer — Approve,
 * Decline (a reason is required) or Send back (a question is required) — with
 * the doctor PICKED from the office's active provider directory. There is no
 * free-text doctor: no pick, no button.
 *
 *   approve  POST /tc/referrals/:id/verbal-approve  { providerId, note? }
 *   decline  POST /tc/referrals/:id/verbal-decline  { providerId, reason }
 *   return   POST /tc/referrals/:id/verbal-return   { providerId, comment }
 *
 * The server decides: it reads the office's mode inside the move and refuses
 * 409 unless it is 'verbal'. The hub draws this only in verbal mode, for a
 * tc.full viewer (see hubVerbalVerbs).
 *
 * APPROVING CAN EMAIL IT — exactly as the doctor's own approve: unless the
 * office's auto-send policy is READ as off, Approve asks first.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Check, CornerUpLeft, Loader2, Phone, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { tcErrorMessage } from "@/features/tc/api";
import { listActiveProviders } from "@/features/tc/providers/providersApi";
import { verbalSignoff, type VerbalSignoffBody } from "@/features/tc/referrals/referralsApi";
import { REFERRAL_LONG_TEXT_CLASS } from "@/features/tc/referrals/longText";
import { SIGNOFF_AUTOSEND_ON_COPY, SIGNOFF_AUTOSEND_UNKNOWN_COPY } from "@/features/tc/referrals/SignoffActions";
import type { OfficeId } from "@shared/tc/contract";
import type { TcProviderEntry } from "@shared/tc/providers";
import {
  REFERRAL_READY_TO_SEND_COPY,
  verbalDoctorLabel,
  type TcReferral,
  type TcReferralVerbalVerb,
} from "@shared/tc/referrals";

export const VERBAL_SIGNOFF_HINT =
  "This office takes the doctor's OK verbally. Record who gave it — the history shows the doctor and you.";
export const VERBAL_NO_PROVIDERS_COPY =
  "No active providers are set up for this office, so there is no doctor to name. An admin can add them under Providers.";

type Mode = null | "declining" | "returning" | "confirm_approve";

export function VerbalSignoffActions({
  office,
  referral: r,
  verbs,
  autosend,
  onSigned,
}: {
  office: OfficeId;
  referral: TcReferral;
  /** The verbal moves offered (empty draws nothing). */
  verbs: readonly TcReferralVerbalVerb[];
  /** The office's auto-send-on-approval policy; null = could not be read. */
  autosend: boolean | null;
  /** Approved, declined or sent back — the server's read-back. */
  onSigned: (next: TcReferral) => void;
}) {
  const [providers, setProviders] = useState<TcProviderEntry[] | null>(null);
  const [providerId, setProviderId] = useState("");
  const [mode, setMode] = useState<Mode>(null);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (verbs.length === 0) return;
    let live = true;
    listActiveProviders(office)
      .then((p) => live && setProviders(p))
      .catch(() => live && setProviders([]));
    return () => {
      live = false;
    };
  }, [office, verbs.length]);

  if (verbs.length === 0) return null;
  const can = (v: TcReferralVerbalVerb) => verbs.includes(v);
  const doctor = providers?.find((p) => p.providerId === providerId) ?? null;
  const picked = doctor !== null;

  async function run(move: VerbalSignoffBody, done: (next: TcReferral) => void) {
    if (!doctor) return;
    setBusy(true);
    try {
      const next = await verbalSignoff(office, r.referralId, doctor.providerId, move);
      setMode(null);
      setNote("");
      setReason("");
      setQuestion("");
      done(next);
      onSigned(next);
    } catch (e) {
      toast.error(tcErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function approve() {
    const dr = doctor ? verbalDoctorLabel(doctor.name) : "the doctor";
    void run({ verb: "approve", ...(note.trim() ? { note: note.trim() } : {}) }, (next) => {
      if (next.status === "sent") toast.success(`Approved (verbal OK from ${dr}) and emailed to ${next.practiceName ?? "the specialist"}.`);
      else if (next.sendProblem) toast.error(`Approved (verbal OK from ${dr}) — but the automatic email did not go out. ${next.sendProblem.note}`);
      else toast.success(`Approved (verbal OK from ${dr}). ${REFERRAL_READY_TO_SEND_COPY}`);
    });
  }

  function pressApprove() {
    // The "may email" confirm, as on the doctor's approve: only a policy READ as off approves in one click.
    if (autosend === false) approve();
    else setMode("confirm_approve");
  }

  return (
    <div className="space-y-3 rounded-lg border border-border p-3" data-testid="tc-hub-verbal-signoff">
      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <Phone className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> {VERBAL_SIGNOFF_HINT}
      </p>
      {providers !== null && providers.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="tc-hub-verbal-no-providers">
          {VERBAL_NO_PROVIDERS_COPY}
        </p>
      ) : (
        <div className="space-y-1">
          <Label htmlFor="verbal-doctor">Which doctor gave the OK?</Label>
          <select
            id="verbal-doctor"
            className="w-full h-9 rounded-md border border-input bg-background px-2 text-sm"
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
            disabled={busy || providers === null}
            data-testid="tc-hub-verbal-doctor"
          >
            <option value="">{providers === null ? "Loading providers…" : "Pick the doctor"}</option>
            {(providers ?? []).map((p) => (
              <option key={p.providerId} value={p.providerId}>
                {verbalDoctorLabel(p.name)}
                {p.credentialSuffix ? `, ${p.credentialSuffix}` : ""}
              </option>
            ))}
          </select>
        </div>
      )}

      {mode === null && can("approve") && (
        <div className="space-y-1">
          <Label htmlFor="verbal-note">Note (optional)</Label>
          <Textarea
            id="verbal-note"
            rows={2}
            className={REFERRAL_LONG_TEXT_CLASS}
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. OK'd between patients, 2:15"
          />
        </div>
      )}
      {mode === "declining" && (
        <div className="space-y-1">
          <Label htmlFor="verbal-reason">Why did the doctor decline?</Label>
          <Textarea id="verbal-reason" rows={2} className={REFERRAL_LONG_TEXT_CLASS} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      )}
      {mode === "returning" && (
        <div className="space-y-1">
          <Label htmlFor="verbal-question">What does the doctor need?</Label>
          <Textarea
            id="verbal-question"
            rows={2}
            className={REFERRAL_LONG_TEXT_CLASS}
            maxLength={1000}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">It goes back to a draft, with the doctor's question.</p>
        </div>
      )}
      {mode === "confirm_approve" && (
        <p
          className="rounded-md bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200"
          data-testid="tc-hub-verbal-approve-confirm"
        >
          {autosend === true ? SIGNOFF_AUTOSEND_ON_COPY : SIGNOFF_AUTOSEND_UNKNOWN_COPY}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {mode !== null ? (
          <>
            <Button size="sm" variant="outline" onClick={() => setMode(null)} disabled={busy}>
              Back
            </Button>
            {mode === "declining" && (
              <Button
                size="sm"
                variant="destructive"
                onClick={() => void run({ verb: "decline", reason: reason.trim() }, () => toast.success("Declined (verbal)"))}
                disabled={busy || !picked || !reason.trim()}
              >
                Record decline
              </Button>
            )}
            {mode === "returning" && (
              <Button
                size="sm"
                onClick={() => void run({ verb: "return", comment: question.trim() }, () => toast.success("Sent back with the doctor's question"))}
                disabled={busy || !picked || !question.trim()}
              >
                Send back
              </Button>
            )}
            {mode === "confirm_approve" && (
              <Button size="sm" onClick={approve} disabled={busy || !picked} data-testid="tc-hub-verbal-approve-confirmed">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                {autosend === true ? "Record approval and email" : "Record approval"}
              </Button>
            )}
          </>
        ) : (
          <>
            {can("return") && (
              <Button size="sm" variant="outline" onClick={() => setMode("returning")} disabled={busy || !picked}>
                <CornerUpLeft className="w-4 h-4" /> Send back with a question
              </Button>
            )}
            {can("decline") && (
              <Button size="sm" variant="outline" onClick={() => setMode("declining")} disabled={busy || !picked}>
                <X className="w-4 h-4" /> Decline
              </Button>
            )}
            {can("approve") && (
              <Button size="sm" onClick={pressApprove} disabled={busy || !picked} data-testid="tc-hub-verbal-approve">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Record verbal approval
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

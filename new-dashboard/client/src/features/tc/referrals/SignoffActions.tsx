/**
 * The doctor's moves on a referral awaiting sign-off — Approve, Decline (a
 * reason is required), Send back (a question is required) — and the doctor's
 * edit with its file upload. Moved here from the retired "Awaiting sign-off"
 * page (items 53, R6, R6.2) when sign-off moved into the Referrals hub; the
 * hub's detail panel draws it for a tc.referral_signoff holder only (see
 * hubActions). Every call is an EXISTING sign-off route, to the office the
 * referral was read from:
 *
 *   approve  POST  /signoff/:id/approve
 *   decline  POST  /signoff/:id/decline       { reason }
 *   return   POST  /signoff/:id/return        { comment }
 *   edit     PATCH /signoff/:id/fields        (with the doctor's note)
 *   files    POST  /signoff/:id/attachments   (only while it awaits sign-off)
 *
 * APPROVING CAN EMAIL IT. Where the office emails on approval (R5), the server
 * sends right after the approval commits. So Approve asks first — "approving
 * will email the specialist now" — whenever that may happen: when the office's
 * auto-send policy is on, and also when this page could not read the policy (a
 * doctor cannot: the settings route is tc.full). Only a policy READ as off
 * approves in one click. The answer is read back after any auto-send, and the
 * toast says what really happened: emailed, approved but the email did not go
 * out, or ready to send.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Check, CornerUpLeft, Loader2, Pencil, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { tcErrorMessage } from "@/features/tc/api";
import { listSignoffProviders } from "@/features/tc/providers/providersApi";
import {
  approveReferral,
  declineReferral,
  doctorEditReferral,
  listSignoffDirectory,
  returnReferral,
  uploadReferralAttachment,
} from "@/features/tc/referrals/referralsApi";
import { AddAttachments } from "@/features/tc/referrals/AddAttachments";
import { ReferralFieldsForm, type ReferralFieldsChange } from "@/features/tc/referrals/ReferralFieldsForm";
import type { HubSignoffVerb } from "@/features/tc/referrals/hubActions";
import type { OfficeId } from "@shared/tc/contract";
import type { TcProviderEntry } from "@shared/tc/providers";
import {
  REFERRAL_DOCTOR_EDITABLE_STATUSES,
  REFERRAL_READY_TO_SEND_COPY,
  TC_REFERRAL_STATUS_LABELS,
  type TcReferral,
  type TcReferralDirectoryEntry,
} from "@shared/tc/referrals";

export const SIGNOFF_AUTOSEND_ON_COPY =
  "This office emails referrals when they are approved — approving will email the specialist now.";
export const SIGNOFF_AUTOSEND_UNKNOWN_COPY =
  "Approving may email the specialist now: if this office emails referrals when they are approved, it goes out as soon as you approve.";

/** The one-line result after a sign-off move, from the referral the server read back. Pure. */
export function signoffDoneLine(r: TcReferral): string {
  const head =
    r.status === "draft"
      ? `${r.patientName}: sent back with your question.`
      : `${r.patientName}: ${TC_REFERRAL_STATUS_LABELS[r.status].toLowerCase()}.`;
  const approved =
    r.status === "approved"
      ? r.sendProblem
        ? " The automatic email did not go out — it is waiting in Referrals to be sent again."
        : ` ${REFERRAL_READY_TO_SEND_COPY}`
      : "";
  const sent = r.status === "sent" ? ` Emailed to ${r.practiceName ?? "the specialist"}.` : "";
  return `${head}${approved}${sent}`;
}

/** R5: the toast for an approval, from the referral read back AFTER any auto-send. */
function toastApproved(r: TcReferral) {
  if (r.status === "sent") {
    toast.success(`Approved and emailed to ${r.practiceName ?? "the specialist"}.`);
  } else if (r.sendProblem?.kind === "failed") {
    toast.error(`Approved — but the automatic email did not go out. ${r.sendProblem.note} It is waiting in Referrals to be sent again.`);
  } else if (r.sendProblem?.kind === "conflict") {
    toast.error(`Approved. ${r.sendProblem.note}`);
  } else {
    toast.success(`Approved. ${REFERRAL_READY_TO_SEND_COPY}`);
  }
}

type Mode = null | "editing" | "declining" | "returning" | "confirm_approve";

export function SignoffActions({
  office,
  referral: r,
  verbs,
  autosend,
  doctorEdit,
  filesAttached,
  onFilesChanged,
  onEdited,
  onSigned,
}: {
  /** The office the referral was read from — every call goes there. */
  office: OfficeId;
  referral: TcReferral;
  /** The doctor's moves the plan offers (empty draws nothing). */
  verbs: readonly HubSignoffVerb[];
  /** The office's auto-send-on-approval policy; null = could not be read. */
  autosend: boolean | null;
  /** Offer the doctor's edit (and its upload) through the sign-off routes. */
  doctorEdit: boolean;
  filesAttached: number;
  /** Re-read the stored files after an upload. */
  onFilesChanged: () => void;
  /** The doctor's edit landed; still awaiting sign-off. */
  onEdited: (next: TcReferral) => void;
  /** Approved, declined or sent back — the server's read-back. */
  onSigned: (next: TcReferral) => void;
}) {
  const [mode, setMode] = useState<Mode>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const [question, setQuestion] = useState("");
  const [entries, setEntries] = useState<TcReferralDirectoryEntry[]>([]);
  // Provider directory: null until (and unless) it answers — free text meanwhile.
  const [providers, setProviders] = useState<TcProviderEntry[] | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  if (verbs.length === 0) return null;
  const can = (v: HubSignoffVerb) => verbs.includes(v);
  const editing = mode === "editing";

  async function run(call: () => Promise<TcReferral>, after: (next: TcReferral) => void) {
    setBusy(true);
    try {
      const next = await call();
      setMode(null);
      setReason("");
      setQuestion("");
      after(next);
      onSigned(next);
    } catch (e) {
      toast.error(tcErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function approve() {
    void run(() => approveReferral(office, r.referralId), toastApproved);
  }

  function pressApprove() {
    // Only a policy READ as off approves in one click.
    if (autosend === false) approve();
    else setMode("confirm_approve");
  }

  function startEdit() {
    setEditError(null);
    setMode("editing");
    listSignoffDirectory(office)
      .then(setEntries)
      .catch(() => setEntries([]));
    listSignoffProviders(office)
      .then(setProviders)
      .catch(() => setProviders(null));
  }

  /** The doctor's edit. The card shows what the server stored, nothing sooner. */
  async function saveEdit(change: ReferralFieldsChange) {
    setBusy(true);
    setEditError(null);
    try {
      const next = await doctorEditReferral(office, r.referralId, change);
      setMode(null);
      onEdited(next);
      toast.success("Changes saved — still awaiting your sign-off");
    } catch (e) {
      setEditError(tcErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3" data-testid="tc-hub-signoff-actions">
      {editing && (
        <ReferralFieldsForm
          referral={r}
          entries={entries}
          providers={providers}
          withDoctorNote
          saving={busy}
          serverError={editError}
          saveLabel="Save changes"
          hint="Your changes are saved to the referral and recorded in its history. It still waits for your sign-off."
          onSave={(c) => void saveEdit(c)}
          onCancel={() => {
            setMode(null);
            setEditError(null);
          }}
        />
      )}
      {/* R6.2: the doctor may add a file while editing — only while it awaits sign-off. */}
      {editing && REFERRAL_DOCTOR_EDITABLE_STATUSES.includes(r.status) && (
        <AddAttachments
          alreadyAttached={filesAttached}
          upload={(f) => uploadReferralAttachment(office, r.referralId, f, true)}
          onDone={onFilesChanged}
          disabled={busy}
        />
      )}

      {mode === "declining" && (
        <div className="space-y-1">
          <Label htmlFor="so-reason">Why decline?</Label>
          <Textarea id="so-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      )}
      {mode === "returning" && (
        <div className="space-y-1">
          <Label htmlFor="so-question">What do you need from them?</Label>
          <Textarea
            id="so-question"
            rows={2}
            maxLength={1000}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="e.g. Which tooth — 3 or 14? Please attach the PA."
          />
          <p className="text-xs text-muted-foreground">It goes back to whoever submitted it as a draft, with your question.</p>
        </div>
      )}
      {mode === "confirm_approve" && (
        <p
          className="rounded-md bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200"
          data-testid="tc-hub-approve-confirm"
        >
          {autosend === true ? SIGNOFF_AUTOSEND_ON_COPY : SIGNOFF_AUTOSEND_UNKNOWN_COPY}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {mode === "returning" ? (
          <>
            <Button size="sm" variant="outline" onClick={() => setMode(null)} disabled={busy}>
              Back
            </Button>
            <Button
              size="sm"
              onClick={() => void run(() => returnReferral(office, r.referralId, question.trim()), () => toast.success("Sent back with your question"))}
              disabled={busy || !question.trim()}
            >
              Send back
            </Button>
          </>
        ) : mode === "declining" ? (
          <>
            <Button size="sm" variant="outline" onClick={() => setMode(null)} disabled={busy}>
              Back
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => void run(() => declineReferral(office, r.referralId, reason.trim()), () => toast.success("Declined"))}
              disabled={busy || !reason.trim()}
            >
              Decline referral
            </Button>
          </>
        ) : mode === "confirm_approve" ? (
          <>
            <Button size="sm" variant="outline" onClick={() => setMode(null)} disabled={busy}>
              Back
            </Button>
            <Button size="sm" onClick={approve} disabled={busy} data-testid="tc-hub-approve-confirmed">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              {autosend === true ? "Approve and email" : "Approve"}
            </Button>
          </>
        ) : (
          <>
            {!editing && doctorEdit && (
              <Button size="sm" variant="ghost" onClick={startEdit} disabled={busy}>
                <Pencil className="w-4 h-4" /> Edit
              </Button>
            )}
            {!editing && can("return") && (
              <Button size="sm" variant="outline" onClick={() => setMode("returning")} disabled={busy}>
                <CornerUpLeft className="w-4 h-4" /> Send back with a question
              </Button>
            )}
            {can("decline") && (
              <Button size="sm" variant="outline" onClick={() => setMode("declining")} disabled={busy || editing}>
                <X className="w-4 h-4" /> Decline
              </Button>
            )}
            {can("approve") && (
              <Button size="sm" onClick={pressApprove} disabled={busy || editing} data-testid="tc-hub-approve">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Approve
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * /tc/referrals/signoff — "Awaiting sign-off" (queue item 53, R2).
 *
 * The doctor's whole TC surface (a `doctor` holds tc.referral_signoff and
 * nothing else; an admin sees it too). Referrals waiting on the doctor, oldest
 * first; open one to read it — specialist, reason, teeth, how soon, the notes
 * for the specialist, its history — then Approve, or Decline with a reason.
 *
 * NOTHING SENDS. Approving says so honestly: "Ready to send — sending ships in
 * a later update." Every state shown is the server's answer after the change.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Check, Loader2, RefreshCw, X } from "lucide-react";

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
import { Textarea } from "@/components/ui/textarea";
import { tcErrorMessage } from "@/features/tc/api";
import { TcOfficeGate, TcPageHeader, useTcOffice } from "@/features/tc/components/TcShell";
import {
  approveReferral,
  declineReferral,
  getSignoffReferral,
  listReferralAttachments,
  listSignoffQueue,
  openReferralAttachment,
} from "@/features/tc/referrals/referralsApi";
import {
  AttachmentList,
  ReferralStatusBadge,
  teethLabel,
  viewAttachment,
} from "@/features/tc/referrals/ReferralsPanel";
import type { OfficeId } from "@shared/tc/contract";
import {
  REFERRAL_READY_TO_SEND_COPY,
  TC_REFERRAL_STATUS_LABELS,
  TC_REFERRAL_URGENCY_LABELS,
  type TcReferral,
  type TcReferralAttachment,
} from "@shared/tc/referrals";

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export default function TcReferralSignoff() {
  const office = useTcOffice();
  if (!office) {
    return (
      <div className="p-6">
        <TcOfficeGate />
      </div>
    );
  }
  return <SignoffInner key={office} office={office} />;
}

export function SignoffInner({ office }: { office: OfficeId }) {
  const [queue, setQueue] = useState<TcReferral[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<TcReferral | null>(null);
  const [busy, setBusy] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [done, setDone] = useState<TcReferral | null>(null);
  const [openFiles, setOpenFiles] = useState<TcReferralAttachment[]>([]);

  const load = useCallback(() => {
    setError(null);
    listSignoffQueue(office)
      .then(setQueue)
      .catch((e: unknown) => setError(tcErrorMessage(e)));
  }, [office]);

  useEffect(() => {
    load();
  }, [load]);

  async function openOne(r: TcReferral) {
    setDone(null);
    setOpenFiles([]);
    try {
      setOpen(await getSignoffReferral(office, r.referralId));
      // The X-rays the TC or hygienist attached (item 55). Each view is audited.
      setOpenFiles(await listReferralAttachments(office, r.referralId, true).catch(() => []));
    } catch (e) {
      toast.error(tcErrorMessage(e));
    }
  }

  async function approve() {
    if (!open) return;
    setBusy(true);
    try {
      const r = await approveReferral(office, open.referralId);
      setDone(r);
      setOpen(null);
      toast.success(`Approved. ${REFERRAL_READY_TO_SEND_COPY}`);
    } catch (e) {
      toast.error(tcErrorMessage(e));
    } finally {
      setBusy(false);
      load();
    }
  }

  async function decline() {
    if (!open) return;
    if (!reason.trim()) return;
    setBusy(true);
    try {
      const r = await declineReferral(office, open.referralId, reason.trim());
      setDone(r);
      setOpen(null);
      setDeclining(false);
      setReason("");
      toast.success("Declined");
    } catch (e) {
      toast.error(tcErrorMessage(e));
    } finally {
      setBusy(false);
      load();
    }
  }

  return (
    <div className="p-6 space-y-4">
      <TcPageHeader title="Awaiting sign-off" subtitle="Referrals waiting for the doctor. Nothing is sent from here yet." />

      {done && (
        <div
          className="rounded-lg border border-border bg-card p-3 text-sm flex items-center justify-between gap-2"
          data-testid="tc-signoff-done"
        >
          <span>
            {done.patientName}: {TC_REFERRAL_STATUS_LABELS[done.status].toLowerCase()}.
            {done.status === "approved" ? ` ${REFERRAL_READY_TO_SEND_COPY}` : ""}
          </span>
          <ReferralStatusBadge status={done.status} />
        </div>
      )}

      {error ? (
        <div className="flex flex-col items-center gap-3 py-12 text-center">
          <p className="text-sm text-muted-foreground">{error}</p>
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="w-4 h-4 mr-1" /> Retry
          </Button>
        </div>
      ) : queue === null ? (
        <div className="flex items-center gap-2 py-12 justify-center text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin" /> Loading…
        </div>
      ) : queue.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground" data-testid="tc-signoff-empty">
          Nothing is waiting for sign-off.
        </p>
      ) : (
        <ul className="space-y-2" data-testid="tc-signoff-queue">
          {queue.map((r) => (
            <li key={r.referralId}>
              <button
                type="button"
                onClick={() => void openOne(r)}
                className="w-full text-left rounded-lg border border-border bg-card p-3 hover:bg-muted/50"
                data-testid="tc-signoff-row"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-foreground">{r.patientName}</span>
                  <span className="text-xs text-muted-foreground">{TC_REFERRAL_URGENCY_LABELS[r.urgency]}</span>
                </div>
                <p className="text-sm text-muted-foreground">
                  {[r.practiceName ?? "No specialist chosen", r.specialty, teethLabel(r.teeth)].filter(Boolean).join(" · ")}
                </p>
                <p className="text-sm text-foreground line-clamp-1">{r.reason}</p>
              </button>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={open !== null} onOpenChange={(o) => (!o ? setOpen(null) : undefined)}>
        <DialogContent className="max-w-xl" data-testid="tc-signoff-detail">
          {open && (
            <>
              <DialogHeader>
                <DialogTitle>{open.patientName}</DialogTitle>
                <DialogDescription>
                  Referral to {open.practiceName ?? "a specialist not yet chosen"}
                  {open.specialty ? ` (${open.specialty})` : ""}.
                </DialogDescription>
              </DialogHeader>
              <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Reason</dt>
                <dd>{open.reason}</dd>
                <dt className="text-muted-foreground">Teeth</dt>
                <dd>{teethLabel(open.teeth) || "—"}</dd>
                <dt className="text-muted-foreground">How soon</dt>
                <dd>{TC_REFERRAL_URGENCY_LABELS[open.urgency]}</dd>
                <dt className="text-muted-foreground">Referring</dt>
                <dd>{open.referringProvider || "—"}</dd>
                <dt className="text-muted-foreground">Notes</dt>
                <dd className="whitespace-pre-wrap">{open.narrative || "—"}</dd>
              </dl>
              <AttachmentList
                attachments={openFiles}
                onView={(a) =>
                  void viewAttachment(() => openReferralAttachment(office, open.referralId, a.attachmentId, true))
                }
              />
              {open.events && open.events.length > 0 && (
                <ol className="text-xs text-muted-foreground space-y-0.5 border-t border-border pt-2">
                  {open.events.map((e) => (
                    <li key={e.eventId}>
                      {when(e.at)} · {TC_REFERRAL_STATUS_LABELS[e.toStatus]} · {e.actor}
                      {e.note ? ` · ${e.note}` : ""}
                    </li>
                  ))}
                </ol>
              )}
              {declining ? (
                <div className="space-y-1">
                  <Label htmlFor="so-reason">Why decline?</Label>
                  <Textarea id="so-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
                </div>
              ) : null}
              <DialogFooter className="gap-2">
                {declining ? (
                  <>
                    <Button variant="outline" onClick={() => setDeclining(false)} disabled={busy}>
                      Back
                    </Button>
                    <Button variant="destructive" onClick={() => void decline()} disabled={busy || !reason.trim()}>
                      Decline referral
                    </Button>
                  </>
                ) : (
                  <>
                    <Button variant="outline" onClick={() => setDeclining(true)} disabled={busy}>
                      <X className="w-4 h-4" /> Decline
                    </Button>
                    <Button onClick={() => void approve()} disabled={busy}>
                      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Approve
                    </Button>
                  </>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

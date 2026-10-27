/**
 * /tc/referrals/signoff — "Awaiting sign-off" (queue item 53, R2).
 *
 * The doctor's whole TC surface (a `doctor` holds tc.referral_signoff and
 * nothing else; an admin sees it too). Referrals waiting on the doctor, oldest
 * first; open one to read it — specialist, reason, teeth, how soon, the notes
 * for the specialist, its history — then Approve, or Decline with a reason.
 *
 * Approving sends nothing from this page. Where the office emails referrals on
 * approval (R5), the server tries right after the approval commits, and the
 * referral it reads back says what happened: `sent`, or a send problem (the
 * approval stands either way). Otherwise approving says "Ready to send —
 * sending ships in a later update." Every state shown is the server's answer
 * after the change.
 *
 * R6 (item 56): the doctor may EDIT what they are signing — specialist, how
 * soon, reason, teeth — and add their own note, and may SEND IT BACK with a
 * question instead of approving or declining. The submitter sees
 * "Returned by Dr. — <question>". Approve's rules are unchanged.
 *
 * R6.2: while editing, the doctor may also ADD files (the R4 upload, through
 * the sign-off route), only while the referral awaits sign-off. Nothing removes
 * a stored file.
 *
 * Pre-IA fix F5: the page fans out across every office in scope, like
 * Checkout — the nav badge counts every office, so "All offices" now lists
 * every office's referrals (each badged) instead of asking to pick one. Every
 * read and write after that goes to the office the referral was LISTED from.
 * The arrival alert's link (?office=&referral=) opens that referral, the way
 * Checkout's ?office=&handoff= opens its sidebar; an office outside the scope
 * is ignored.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearch } from "wouter";
import { toast } from "sonner";
import { Check, CornerUpLeft, Loader2, Pencil, RefreshCw, X } from "lucide-react";

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
import { TcOfficeGate, TcPageHeader, TcPartialDataNotice } from "@/features/tc/components/TcShell";
import { OfficeBadge } from "@/features/tc/components/OfficeBadge";
import {
  fanOutOfficeRows,
  hardErrorMessage,
  officeScopeKey,
  partialNotice,
  useTcOfficeScope,
  type WithOffice,
} from "@/features/tc/officeScope";
import {
  approveReferral,
  declineReferral,
  doctorEditReferral,
  getSignoffReferral,
  listReferralAttachments,
  listSignoffDirectory,
  listSignoffQueue,
  openReferralAttachment,
  returnReferral,
  uploadReferralAttachment,
} from "@/features/tc/referrals/referralsApi";
import { listSignoffProviders } from "@/features/tc/providers/providersApi";
import type { TcProviderEntry } from "@shared/tc/providers";
import { AddAttachments } from "@/features/tc/referrals/AddAttachments";
import { ReferralFieldsForm, type ReferralFieldsChange } from "@/features/tc/referrals/ReferralFieldsForm";
import { referralEventLabel } from "@/features/tc/referrals/ReferralTimeline";
import {
  AttachmentList,
  ReferralStatusBadge,
  teethLabel,
  viewAttachment,
} from "@/features/tc/referrals/ReferralsPanel";
import type { OfficeId } from "@shared/tc/contract";
import {
  REFERRAL_DOCTOR_EDITABLE_STATUSES,
  REFERRAL_READY_TO_SEND_COPY,
  TC_REFERRAL_STATUS_LABELS,
  TC_REFERRAL_URGENCY_LABELS,
  type TcReferral,
  type TcReferralAttachment,
  type TcReferralDirectoryEntry,
} from "@shared/tc/referrals";

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export default function TcReferralSignoff() {
  const scope = useTcOfficeScope();
  if (scope.offices.length === 0) {
    return (
      <div className="p-6">
        <TcOfficeGate loading={scope.loading} />
      </div>
    );
  }
  return (
    <SignoffQueue
      key={officeScopeKey(scope.offices)}
      offices={scope.offices}
      showOfficeBadges={scope.showOfficeBadges}
    />
  );
}

/** One office's queue — the shape the page had before F5. */
export function SignoffInner({ office }: { office: OfficeId }) {
  return <SignoffQueue offices={[office]} showOfficeBadges={false} />;
}

/** True when `v` is one of the offices a referral can live in. */
function isOfficeId(v: string | null): v is OfficeId {
  return v === "roland" || v === "valley";
}

export function SignoffQueue({ offices, showOfficeBadges }: { offices: OfficeId[]; showOfficeBadges: boolean }) {
  const search = useSearch();
  const query = useMemo(() => new URLSearchParams(search), [search]);
  const [queue, setQueue] = useState<WithOffice<TcReferral>[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState<TcReferral | null>(null);
  /** The office the open referral was listed from — where every read and write for it goes. */
  const [office, setOffice] = useState<OfficeId | null>(null);
  const loadSeq = useRef(0);
  const [busy, setBusy] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [done, setDone] = useState<TcReferral | null>(null);
  const [openFiles, setOpenFiles] = useState<TcReferralAttachment[]>([]);
  // R6: the doctor's edit, and "send back with a question".
  const [editing, setEditing] = useState(false);
  const [entries, setEntries] = useState<TcReferralDirectoryEntry[]>([]);
  // Provider directory: null until (and unless) it answers — free text meanwhile.
  const [providers, setProviders] = useState<TcProviderEntry[] | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [returning, setReturning] = useState(false);
  const [question, setQuestion] = useState("");

  const load = useCallback(() => {
    const seq = ++loadSeq.current;
    setError(null);
    void fanOutOfficeRows(offices, (o) => listSignoffQueue(o)).then((res) => {
      if (seq !== loadSeq.current) return;
      // Each office answers oldest first; keep that across the merge.
      setQueue([...res.rows].sort((a, b) => a.statusChangedAt.localeCompare(b.statusChangedAt)));
      setError(hardErrorMessage(res));
      setNotice(partialNotice(res));
    });
  }, [offices]);

  useEffect(() => {
    load();
  }, [load]);

  function resetPanel() {
    setDeclining(false);
    setReason("");
    setEditing(false);
    setEditError(null);
    setReturning(false);
    setQuestion("");
  }

  const openOne = useCallback(async (from: OfficeId, referralId: string) => {
    setDone(null);
    setOpenFiles([]);
    resetPanel();
    try {
      const r = await getSignoffReferral(from, referralId);
      setOffice(from);
      setOpen(r);
      // The X-rays the TC or hygienist attached (item 55). Each view is audited.
      setOpenFiles(await listReferralAttachments(from, referralId, true).catch(() => []));
    } catch (e) {
      toast.error(tcErrorMessage(e));
    }
  }, []);

  // The arrival alert links here with ?office=&referral= — open that referral,
  // as Checkout opens its sidebar. Only an office this page is showing.
  useEffect(() => {
    const referralId = query.get("referral");
    const from = query.get("office");
    if (referralId && isOfficeId(from) && offices.includes(from)) void openOne(from, referralId);
  }, [query, offices, openOne]);

  async function approve() {
    if (!open || !office) return;
    setBusy(true);
    try {
      const r = await approveReferral(office, open.referralId);
      setDone(r);
      setOpen(null);
      // R5: the referral as read back AFTER any auto-send says what it did.
      if (r.status === "sent") {
        toast.success(`Approved and emailed to ${r.practiceName ?? "the specialist"}.`);
      } else if (r.sendProblem?.kind === "failed") {
        toast.error(`Approved — but the automatic email did not go out. ${r.sendProblem.note} It is waiting in Referrals to be sent again.`);
      } else if (r.sendProblem?.kind === "conflict") {
        toast.error(`Approved. ${r.sendProblem.note}`);
      } else {
        toast.success(`Approved. ${REFERRAL_READY_TO_SEND_COPY}`);
      }
    } catch (e) {
      toast.error(tcErrorMessage(e));
    } finally {
      setBusy(false);
      load();
    }
  }

  async function decline() {
    if (!open || !office) return;
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

  function startEdit() {
    if (!open || !office) return;
    setEditError(null);
    setEditing(true);
    listSignoffDirectory(office)
      .then(setEntries)
      .catch(() => setEntries([]));
    listSignoffProviders(office)
      .then(setProviders)
      .catch(() => setProviders(null));
  }

  /** The doctor's edit. The card shows what the server stored, nothing sooner. */
  async function saveEdit(change: ReferralFieldsChange) {
    if (!open || !office) return;
    setBusy(true);
    setEditError(null);
    try {
      const r = await doctorEditReferral(office, open.referralId, change);
      setOpen(r);
      setEditing(false);
      toast.success("Changes saved — still awaiting your sign-off");
    } catch (e) {
      setEditError(tcErrorMessage(e));
    } finally {
      setBusy(false);
      load();
    }
  }

  async function sendBack() {
    if (!open || !office || !question.trim()) return;
    setBusy(true);
    try {
      const r = await returnReferral(office, open.referralId, question.trim());
      setDone(r);
      setOpen(null);
      resetPanel();
      toast.success("Sent back with your question");
    } catch (e) {
      toast.error(tcErrorMessage(e));
    } finally {
      setBusy(false);
      load();
    }
  }

  return (
    <div className="p-6 space-y-4">
      <TcPageHeader
        title="Awaiting sign-off"
        subtitle={
          showOfficeBadges
            ? "Referrals waiting for the doctor, from every office. Nothing is sent from here yet."
            : "Referrals waiting for the doctor. Nothing is sent from here yet."
        }
      />

      {notice && <TcPartialDataNotice message={notice} />}

      {done && (
        <div
          className="rounded-lg border border-border bg-card p-3 text-sm flex items-center justify-between gap-2"
          data-testid="tc-signoff-done"
        >
          <span>
            {done.status === "draft"
              ? `${done.patientName}: sent back with your question.`
              : `${done.patientName}: ${TC_REFERRAL_STATUS_LABELS[done.status].toLowerCase()}.`}
            {done.status === "approved"
              ? done.sendProblem
                ? ` The automatic email did not go out — it is waiting in Referrals to be sent again.`
                : ` ${REFERRAL_READY_TO_SEND_COPY}`
              : ""}
            {done.status === "sent" ? ` Emailed to ${done.practiceName ?? "the specialist"}.` : ""}
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
                onClick={() => void openOne(r.officeId, r.referralId)}
                className="w-full text-left rounded-lg border border-border bg-card p-3 hover:bg-muted/50"
                data-testid="tc-signoff-row"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <span className="font-medium text-foreground">{r.patientName}</span>
                    {showOfficeBadges && <OfficeBadge officeId={r.officeId} />}
                  </span>
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
          {open && office && (
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
                <dt className="text-muted-foreground">For the patient</dt>
                <dd data-testid="tc-signoff-patient-reason">{open.patientReason || "a specialist consultation (nothing written)"}</dd>
                <dt className="text-muted-foreground">Teeth</dt>
                <dd>{teethLabel(open.teeth) || "—"}</dd>
                <dt className="text-muted-foreground">How soon</dt>
                <dd>{TC_REFERRAL_URGENCY_LABELS[open.urgency]}</dd>
                <dt className="text-muted-foreground">Referring</dt>
                <dd>{open.referringProvider || "—"}</dd>
                <dt className="text-muted-foreground">Notes</dt>
                <dd className="whitespace-pre-wrap">{open.narrative || "—"}</dd>
                {open.doctorNote && (
                  <>
                    <dt className="text-muted-foreground">Your note</dt>
                    <dd className="whitespace-pre-wrap" data-testid="tc-signoff-doctor-note">
                      {open.doctorNote}
                    </dd>
                  </>
                )}
              </dl>
              {editing && (
                <ReferralFieldsForm
                  referral={open}
                  entries={entries}
                  providers={providers}
                  withDoctorNote
                  saving={busy}
                  serverError={editError}
                  saveLabel="Save changes"
                  hint="Your changes are saved to the referral and recorded in its history. It still waits for your sign-off."
                  onSave={(c) => void saveEdit(c)}
                  onCancel={() => {
                    setEditing(false);
                    setEditError(null);
                  }}
                />
              )}
              {/* R6.2: the doctor may add a file while editing — only while it awaits sign-off. */}
              {editing && REFERRAL_DOCTOR_EDITABLE_STATUSES.includes(open.status) && (
                <AddAttachments
                  alreadyAttached={openFiles.length}
                  upload={(f) => uploadReferralAttachment(office, open.referralId, f, true)}
                  onDone={() => {
                    listReferralAttachments(office, open.referralId, true)
                      .then(setOpenFiles)
                      .catch(() => undefined);
                  }}
                  disabled={busy}
                />
              )}
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
                      {when(e.at)} · {referralEventLabel(e)} · {e.actor}
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
              {returning ? (
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
                  <p className="text-xs text-muted-foreground">
                    It goes back to whoever submitted it as a draft, with your question.
                  </p>
                </div>
              ) : null}
              <DialogFooter className="gap-2 flex-wrap">
                {returning ? (
                  <>
                    <Button variant="outline" onClick={() => setReturning(false)} disabled={busy}>
                      Back
                    </Button>
                    <Button onClick={() => void sendBack()} disabled={busy || !question.trim()}>
                      Send back
                    </Button>
                  </>
                ) : declining ? (
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
                    {!editing && (
                      <>
                        <Button variant="ghost" onClick={startEdit} disabled={busy}>
                          <Pencil className="w-4 h-4" /> Edit
                        </Button>
                        <Button variant="outline" onClick={() => setReturning(true)} disabled={busy}>
                          <CornerUpLeft className="w-4 h-4" /> Send back with a question
                        </Button>
                      </>
                    )}
                    <Button variant="outline" onClick={() => setDeclining(true)} disabled={busy || editing}>
                      <X className="w-4 h-4" /> Decline
                    </Button>
                    <Button onClick={() => void approve()} disabled={busy || editing}>
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

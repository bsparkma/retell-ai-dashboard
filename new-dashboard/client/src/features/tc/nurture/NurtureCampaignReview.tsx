/**
 * "Review campaign" (EL-2c) — a patient email library campaign, written in
 * full when it was started, reviewed email by email.
 *
 * Beau, 2026-11-25: "Nothing sends that a human has not approved word for
 * word. Approved emails send on their scheduled date unless a stop condition
 * fires." Each email shows its planned date and time (office time), its stage,
 * its subject, the rendered email (the server's one renderer, in a sandboxed
 * frame), and a status chip. A person can Approve it, Edit it (a draft only),
 * Change its date, Skip it, or Unapprove it (an approved email must be
 * unapproved before it can be edited or sent by hand).
 *
 * HONEST: there is no automatic sender yet, so the screen says so in words —
 * an approved email waits. Nothing on this screen sends anything.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CalendarClock, Check, CheckCheck, Eye, EyeOff, Info, Loader2, Pencil, SkipForward, Undo2 } from "lucide-react";
import type { OfficeId } from "@shared/tc/contract";
import {
  NURTURE_AUTOMATIC_SENDING_NOTE,
  NURTURE_TRACKS,
  nurtureEmailTextProblem,
  type NurtureCampaignEmail,
  type NurtureCampaignResponse,
} from "@shared/tc/nurture";
import type { RenderedEmailResult } from "@shared/tc/messaging";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { EmailPreview } from "../email/EmailPreview";
import { editDraft, renderEmail } from "../messaging/messagingApi";
import { tcErrorMessage } from "../api";
import {
  approveAllNurtureEmails,
  approveNurtureEmail,
  getNurtureCampaign,
  rescheduleNurtureEmail,
  unapproveNurtureEmail,
  skipNurtureDraft,
} from "./campaignApi";
import {
  LIBRARY_TONE_LABEL,
  REVIEW_CHIP_TONE,
  officeDateTimeParts,
  plannedLabel,
  reviewChipText,
} from "./campaignCopy";
import { libraryProcedureName, libraryStageLabel, useLibraryCatalog } from "./useLibraryCatalog";

const CHIP_CLASS: Record<(typeof REVIEW_CHIP_TONE)[keyof typeof REVIEW_CHIP_TONE], string> = {
  attention: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/50 dark:text-amber-200",
  approved: "border-violet-300 bg-violet-50 text-violet-900 dark:border-violet-700 dark:bg-violet-950/50 dark:text-violet-200",
  done: "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-200",
  muted: "border-border bg-muted text-muted-foreground",
  bad: "border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/50 dark:text-red-200",
};

const TEXT_PROBLEM_COPY = {
  EMPTY: "The email text can't be empty.",
  TOO_LONG: "The email text is too long.",
  MERGE_TOKEN: 'Take out the "{{" merge token and write the words instead.',
  FORBIDDEN_CHARACTER: "There's an invisible or control character in the text (pasted from somewhere?). Retype that part.",
} as const;

export interface NurtureCampaignReviewProps {
  office: OfficeId;
  enrollmentId: string | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Something changed (an approval, a skip): let the strip / outbox refresh. */
  onChanged?: () => void;
}

export function NurtureCampaignReview({ office, enrollmentId, open, onOpenChange, onChanged }: NurtureCampaignReviewProps) {
  const [data, setData] = useState<NurtureCampaignResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const library = useLibraryCatalog(office, open);

  const load = useCallback(async () => {
    if (!enrollmentId) return;
    setError(null);
    try {
      setData(await getNurtureCampaign(office, enrollmentId));
    } catch (e) {
      setError(tcErrorMessage(e));
    }
  }, [office, enrollmentId]);

  useEffect(() => {
    if (open) {
      setConfirmAll(false);
      void load();
    }
  }, [open, load]);

  const run = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try {
      await fn();
      toast.success(done);
      await load();
      onChanged?.();
    } catch (e) {
      toast.error(tcErrorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const e = data?.enrollment ?? null;
  const drafts = useMemo(() => (data ? data.emails.filter((x) => x.message.status === "draft") : []), [data]);
  const approved = data ? data.emails.filter((x) => x.message.status === "scheduled").length : 0;
  const total = e ? e.stepCount : 0;
  const running = e ? e.status === "active" : false;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl [&>*]:min-w-0" data-testid="nurture-review">
        <DialogHeader>
          <DialogTitle>Review campaign</DialogTitle>
          <DialogDescription>
            {e
              ? `${NURTURE_TRACKS[e.trackKey].label} · Library: ${libraryProcedureName(library.catalog, e.libraryProcedureId ?? "")} · ${
                  LIBRARY_TONE_LABEL[e.libraryVariant ?? "A"]
                }${data?.patientName ? ` · ${data.patientName}` : ""}`
              : "Loading the campaign…"}
          </DialogDescription>
        </DialogHeader>

        <p
          className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
          data-testid="nurture-auto-send-note"
        >
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {NURTURE_AUTOMATIC_SENDING_NOTE}
        </p>

        {error ? (
          <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
            {error}
            <Button size="sm" variant="ghost" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        ) : !data || !e ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-[10rem] flex-1">
                <p className="text-sm font-medium text-foreground" data-testid="nurture-review-progress">
                  {approved} of {total} approved
                </p>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-violet-600 dark:bg-violet-400"
                    style={{ width: `${total ? Math.round((approved / total) * 100) : 0}%` }}
                  />
                </div>
              </div>
              {drafts.length > 0 && running && !confirmAll && (
                <Button size="sm" className="gap-1" onClick={() => setConfirmAll(true)} disabled={busy !== null} data-testid="nurture-approve-all">
                  <CheckCheck className="h-3.5 w-3.5" /> Approve all {drafts.length}
                </Button>
              )}
              {confirmAll && (
                <div
                  className="flex flex-wrap items-center gap-2 rounded-md border border-violet-300 bg-violet-50 px-3 py-2 text-sm text-violet-950 dark:border-violet-700 dark:bg-violet-950/40 dark:text-violet-100"
                  data-testid="nurture-approve-all-confirm"
                >
                  Approve all {drafts.length} exactly as written? Each waits for its planned time.
                  <Button
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => {
                      setConfirmAll(false);
                      void run("all", () => approveAllNurtureEmails(office, e.enrollmentId), `${drafts.length} emails approved. They wait for their planned times.`);
                    }}
                  >
                    Approve all {drafts.length}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmAll(false)}>
                    Cancel
                  </Button>
                </div>
              )}
            </div>
            {!running && (
              <p className="text-xs text-muted-foreground" data-testid="nurture-review-not-running">
                This campaign is {e.status}
                {e.status === "paused" ? ": emails can't be approved until it's resumed. Nothing is cancelled." : "."}
              </p>
            )}

            <ol className="space-y-3" data-testid="nurture-review-emails">
              {data.emails.map((x) => (
                <EmailRow
                  key={x.message.messageId}
                  office={office}
                  email={x}
                  total={total}
                  stageLabel={libraryStageLabel(library.catalog, x.stage)}
                  running={running}
                  busy={busy}
                  onApprove={() =>
                    void run(x.message.messageId, async () => {
                      const r = await approveNurtureEmail(office, x.message.messageId);
                      if (r.replanned > 0) toast.success(`Its planned time had passed: it and ${r.replanned} more moved forward from today.`);
                    }, "Approved. It waits for its planned time.")
                  }
                  onUnapprove={() =>
                    void run(x.message.messageId, () => unapproveNurtureEmail(office, x.message.messageId), "Back to a draft. Edit it, or send it by hand from the Messages tab.")
                  }
                  onSkip={() =>
                    void run(x.message.messageId, () => skipNurtureDraft(office, x.message.messageId), "Skipped. It won't be sent.")
                  }
                  onReschedule={(when) =>
                    void run(x.message.messageId, () => rescheduleNurtureEmail(office, x.message.messageId, when), "Planned time changed.")
                  }
                  onEdit={(body, subject) =>
                    void run(x.message.messageId, () => editDraft(office, x.message.messageId, { body, subject }), "Saved.")
                  }
                />
              ))}
            </ol>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function EmailRow({
  office,
  email,
  total,
  stageLabel,
  running,
  busy,
  onApprove,
  onUnapprove,
  onSkip,
  onReschedule,
  onEdit,
}: {
  office: OfficeId;
  email: NurtureCampaignEmail;
  total: number;
  stageLabel: string;
  running: boolean;
  busy: string | null;
  onApprove: () => void;
  onUnapprove: () => void;
  onSkip: () => void;
  onReschedule: (when: { date: string; time: string }) => void;
  onEdit: (body: string, subject: string) => void;
}) {
  const m = email.message;
  const [mode, setMode] = useState<"none" | "edit" | "date">("none");
  const [preview, setPreview] = useState<RenderedEmailResult | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [body, setBody] = useState(m.body);
  const [subject, setSubject] = useState(m.subject ?? "");
  const parts = officeDateTimeParts(m.scheduledFor);
  const [date, setDate] = useState(parts.date);
  const [time, setTime] = useState(parts.time);
  const working = busy === m.messageId || busy === "all";
  const waiting = m.status === "draft" || m.status === "scheduled";
  const problem = nurtureEmailTextProblem(body);

  const togglePreview = async () => {
    if (showPreview) {
      setShowPreview(false);
      return;
    }
    setShowPreview(true);
    setPreviewError(null);
    try {
      setPreview(await renderEmail(office, { messageId: m.messageId }));
    } catch (e) {
      setPreviewError(tcErrorMessage(e));
    }
  };

  // A fresh render after an edit.
  useEffect(() => {
    setPreview(null);
    setShowPreview(false);
    setBody(m.body);
    setSubject(m.subject ?? "");
  }, [m.body, m.subject]);

  return (
    <li className="rounded-lg border border-border bg-card p-3" data-testid="nurture-review-email" data-status={m.status}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          Email {email.stepIndex + 1} of {total}
        </span>
        <span>· {stageLabel}</span>
        <span className="flex items-center gap-1" data-testid="nurture-review-planned">
          · <CalendarClock className="h-3 w-3" aria-hidden /> {plannedLabel(m.scheduledFor)}
        </span>
        <span
          className={`ml-auto rounded-full border px-2 py-0.5 font-medium ${CHIP_CLASS[REVIEW_CHIP_TONE[m.status]]}`}
          data-testid="nurture-review-chip"
        >
          {reviewChipText(m)}
        </span>
      </div>
      <p className="mt-1 text-sm font-semibold text-foreground">{m.subject}</p>

      {mode === "edit" ? (
        <div className="mt-2 space-y-2">
          <label className="block text-xs text-muted-foreground">
            Subject
            <Input value={subject} onChange={(ev) => setSubject(ev.target.value)} maxLength={300} className="mt-1" />
          </label>
          <label className="block text-xs text-muted-foreground">
            Email text
            <Textarea value={body} onChange={(ev) => setBody(ev.target.value)} rows={10} className="mt-1 font-mono text-xs" />
          </label>
          {problem && (
            <p className="text-xs text-red-600 dark:text-red-400" data-testid="nurture-review-text-problem">
              {TEXT_PROBLEM_COPY[problem]}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setMode("none")}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={working || problem !== null || !subject.trim()}
              onClick={() => {
                setMode("none");
                onEdit(body, subject.trim());
              }}
            >
              Save
            </Button>
          </div>
        </div>
      ) : (
        <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-sm text-muted-foreground">{m.body}</p>
      )}

      {mode === "date" && (
        <div className="mt-2 flex flex-wrap items-end gap-2" data-testid="nurture-review-date-form">
          <label className="text-xs text-muted-foreground">
            Date
            <Input type="date" value={date} onChange={(ev) => setDate(ev.target.value)} className="mt-1 w-40" />
          </label>
          <label className="text-xs text-muted-foreground">
            Time (office)
            <Input type="time" value={time} onChange={(ev) => setTime(ev.target.value)} className="mt-1 w-32" />
          </label>
          <p className="basis-full text-xs text-muted-foreground">Monday to Friday, 9:00 AM to 4:00 PM office time.</p>
          <Button size="sm" variant="ghost" onClick={() => setMode("none")}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={working || !date || !time}
            onClick={() => {
              setMode("none");
              onReschedule({ date, time });
            }}
          >
            Save date
          </Button>
        </div>
      )}

      {showPreview && (
        <div className="mt-2" data-testid="nurture-review-preview">
          {previewError ? (
            <p className="text-xs text-red-600 dark:text-red-400">Couldn't render it: {previewError}</p>
          ) : preview ? (
            <EmailPreview subject={preview.subject} html={preview.html} />
          ) : (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Rendering…
            </p>
          )}
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center justify-end gap-1.5">
        <Button size="sm" variant="ghost" className="gap-1" onClick={() => void togglePreview()} data-testid="nurture-review-preview-toggle">
          {showPreview ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />} {showPreview ? "Hide email" : "Show email"}
        </Button>
        {m.status === "scheduled" && (
          <span className="mr-1 text-xs text-muted-foreground" data-testid="nurture-review-unapprove-hint">
            Unapprove to edit it or send it by hand.
          </span>
        )}
        {m.status === "draft" && (
          <>
            <Button size="sm" variant="ghost" className="gap-1" disabled={working} onClick={() => setMode(mode === "edit" ? "none" : "edit")}>
              <Pencil className="h-3.5 w-3.5" /> Edit
            </Button>
            <Button size="sm" className="gap-1" disabled={working || !running} onClick={onApprove} data-testid="nurture-review-approve">
              {working ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Approve
            </Button>
          </>
        )}
        {m.status === "scheduled" && (
          <Button size="sm" variant="outline" className="gap-1" disabled={working} onClick={onUnapprove} data-testid="nurture-review-unapprove">
            <Undo2 className="h-3.5 w-3.5" /> Unapprove
          </Button>
        )}
        {waiting && (
          <>
            <Button size="sm" variant="ghost" className="gap-1" disabled={working} onClick={() => setMode(mode === "date" ? "none" : "date")}>
              <CalendarClock className="h-3.5 w-3.5" /> Change date
            </Button>
            <Button size="sm" variant="ghost" className="gap-1" disabled={working} onClick={onSkip} data-testid="nurture-review-skip">
              <SkipForward className="h-3.5 w-3.5" /> Skip
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

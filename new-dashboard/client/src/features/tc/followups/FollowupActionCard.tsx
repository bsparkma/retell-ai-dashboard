/**
 * Follow-up action card — one due/overdue patient touch in the daily queue.
 *
 * Restyled port of the legacy FollowUpActionCard onto the platform contract:
 * joined case context (status/urgency/value), escalation tier from
 * lib/followups, and the three queue actions (Complete / Skip / Reschedule)
 * wired to the /api/tc followup endpoints. Confirmed-save rule: success toasts
 * fire only after the API resolves; failures keep the dialog open with the
 * typed values and toast the server message.
 */
import { useId, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import {
  CalendarClock,
  CheckCircle2,
  Loader2,
  Mail,
  MessageSquare,
  Phone,
  SkipForward,
  User,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { OfficeId } from "@shared/tc/contract";
import {
  completeFollowup,
  rescheduleFollowup,
  skipFollowup,
  tcErrorMessage,
  type TcDueFollowup,
} from "../api";
import { formatCents } from "../money";
import { CaseStatusBadge, UrgencyBadge } from "../components/TcShell";
import { OfficeBadge } from "../components/OfficeBadge";
import {
  getDaysOverdue,
  getEscalationClass,
  getEscalationLabel,
  getEscalationTier,
} from "../lib/followups";

type ChannelId = TcDueFollowup["channel"];

const CHANNEL_META: Record<ChannelId, { label: string; Icon: typeof Phone }> = {
  phone_call: { label: "Call", Icon: Phone },
  text: { label: "Text", Icon: MessageSquare },
  email: { label: "Email", Icon: Mail },
  in_person: { label: "In person", Icon: User },
};

const KIND_LABELS: Record<TcDueFollowup["kind"], string> = {
  followup: "Follow-up",
  nurture: "Nurture",
};

export interface FollowupActionCardProps {
  /** The office that owns this row — writes go here (row.officeId in fan-out). */
  office: OfficeId;
  followup: TcDueFollowup;
  /** All-offices view: show which office the patient belongs to. */
  showOfficeBadge?: boolean;
  /** YYYY-MM-DD reference date for escalation math (deterministic in tests). */
  today: string;
  /** Called after the API confirms — parent removes the row. */
  onCompleted: (followupId: string) => void;
  onSkipped: (followupId: string) => void;
  /** Called with the merged row after a confirmed reschedule. */
  onRescheduled: (updated: TcDueFollowup) => void;
}

export function FollowupActionCard({
  office,
  followup,
  showOfficeBadge = false,
  today,
  onCompleted,
  onSkipped,
  onRescheduled,
}: FollowupActionCardProps) {
  const noteId = useId();
  const respondedId = useId();
  const dateId = useId();

  const [completeOpen, setCompleteOpen] = useState(false);
  const [skipOpen, setSkipOpen] = useState(false);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [outcomeNote, setOutcomeNote] = useState("");
  const [patientResponded, setPatientResponded] = useState(false);
  const [newDueDate, setNewDueDate] = useState(followup.dueDate);
  const [saving, setSaving] = useState(false);

  const daysOverdue = getDaysOverdue(followup.dueDate, today);
  const tier = getEscalationTier(followup.dueDate, today);
  const escalationLabel = getEscalationLabel(tier, daysOverdue);
  const { label: channelLabel, Icon: ChannelIcon } = CHANNEL_META[followup.channel];

  const handleComplete = async () => {
    setSaving(true);
    try {
      await completeFollowup(office, followup.followupId, {
        ...(outcomeNote.trim() ? { outcomeNote: outcomeNote.trim() } : {}),
        patientResponded,
      });
      toast.success(`Follow-up completed for ${followup.patientName}`);
      setCompleteOpen(false);
      onCompleted(followup.followupId);
    } catch (e) {
      // Keep the dialog open with the typed values.
      toast.error(tcErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const handleSkip = async () => {
    setSaving(true);
    try {
      await skipFollowup(office, followup.followupId);
      toast.success(`Follow-up skipped for ${followup.patientName}`);
      setSkipOpen(false);
      onSkipped(followup.followupId);
    } catch (e) {
      toast.error(tcErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const handleReschedule = async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newDueDate)) {
      toast.error("Pick a valid date.");
      return;
    }
    setSaving(true);
    try {
      const updated = await rescheduleFollowup(office, followup.followupId, newDueDate);
      toast.success(`Rescheduled ${followup.patientName} to ${newDueDate}`);
      setRescheduleOpen(false);
      // The reschedule endpoint returns the bare followup row — keep the
      // joined case context from the queue row.
      onRescheduled({ ...followup, ...updated });
    } catch (e) {
      toast.error(tcErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className={`rounded-xl border bg-card p-4 shadow-sm ${
        tier === "critical"
          ? "border-red-300 dark:border-red-900"
          : tier === "overdue"
            ? "border-orange-300 dark:border-orange-900"
            : "border-border"
      }`}
    >
      {/* Header: patient + badges + value */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Link
              href={`/tc/cases/${followup.caseId}`}
              className="text-sm font-semibold text-foreground hover:underline truncate"
            >
              {followup.patientName}
            </Link>
            <Badge variant="outline" className={`border-transparent ${getEscalationClass(tier)}`}>
              {escalationLabel}
            </Badge>
            <CaseStatusBadge status={followup.caseStatus} />
            <UrgencyBadge urgency={followup.caseUrgency} />
            {showOfficeBadge && <OfficeBadge officeId={followup.officeId} />}
          </div>
          <div className="flex items-center gap-2 flex-wrap mt-1.5 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-muted font-medium">
              <ChannelIcon className="w-3 h-3" /> {channelLabel}
            </span>
            <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-muted font-medium">
              {KIND_LABELS[followup.kind]}
            </span>
            <span>Due {followup.dueDate}</span>
            {followup.assignedTc && <span>· {followup.assignedTc}</span>}
          </div>
        </div>
        <div className="text-sm font-semibold text-foreground shrink-0">
          {formatCents(followup.caseValueCents)}
        </div>
      </div>

      {/* Talking point */}
      {followup.talkingPoint && (
        <div className="mt-3 rounded-lg bg-muted/50 p-3">
          <p className="text-xs font-semibold text-muted-foreground mb-0.5">Talking point</p>
          <p className="text-xs text-foreground leading-relaxed">{followup.talkingPoint}</p>
        </div>
      )}

      {/* Phone + actions */}
      <div className="flex items-center justify-between gap-3 mt-3 pt-3 border-t border-border">
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
          <Phone className="w-3.5 h-3.5 shrink-0" />
          {followup.casePhone ? (
            <span className="font-medium text-foreground truncate">{followup.casePhone}</span>
          ) : (
            <span className="italic">No phone on file</span>
          )}
        </span>
        <div className="flex items-center gap-1.5 shrink-0">
          <Button size="sm" className="gap-1.5" onClick={() => setCompleteOpen(true)}>
            <CheckCircle2 className="w-3.5 h-3.5" /> Complete
          </Button>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setSkipOpen(true)}>
            <SkipForward className="w-3.5 h-3.5" /> Skip
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={() => {
              setNewDueDate(followup.dueDate);
              setRescheduleOpen(true);
            }}
          >
            <CalendarClock className="w-3.5 h-3.5" /> Reschedule
          </Button>
        </div>
      </div>

      {/* Complete dialog */}
      <Dialog open={completeOpen} onOpenChange={(open) => !saving && setCompleteOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Complete follow-up</DialogTitle>
            <DialogDescription>
              Log the outcome for {followup.patientName}. The note lands on the case timeline.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor={noteId}>Outcome note</Label>
              <Textarea
                id={noteId}
                value={outcomeNote}
                onChange={(e) => setOutcomeNote(e.target.value)}
                placeholder="Optional — what happened?"
                className="resize-none h-20"
              />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id={respondedId}
                checked={patientResponded}
                onCheckedChange={(v) => setPatientResponded(v === true)}
              />
              <Label htmlFor={respondedId} className="font-normal">
                Patient responded?
              </Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={saving} onClick={() => setCompleteOpen(false)}>
              Cancel
            </Button>
            <Button disabled={saving} onClick={() => void handleComplete()}>
              {saving && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
              Mark complete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Skip confirm dialog */}
      <Dialog open={skipOpen} onOpenChange={(open) => !saving && setSkipOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Skip this follow-up?</DialogTitle>
            <DialogDescription>
              {followup.patientName} will drop off today&apos;s queue without an outcome. You can
              always add a new follow-up from the case.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={saving} onClick={() => setSkipOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={saving} onClick={() => void handleSkip()}>
              {saving && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
              Skip follow-up
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reschedule dialog */}
      <Dialog open={rescheduleOpen} onOpenChange={(open) => !saving && setRescheduleOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reschedule follow-up</DialogTitle>
            <DialogDescription>
              Pick a new due date for {followup.patientName}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor={dateId}>New due date</Label>
            <Input
              id={dateId}
              type="date"
              value={newDueDate}
              onChange={(e) => setNewDueDate(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={saving} onClick={() => setRescheduleOpen(false)}>
              Cancel
            </Button>
            <Button disabled={saving} onClick={() => void handleReschedule()}>
              {saving && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
              Reschedule
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

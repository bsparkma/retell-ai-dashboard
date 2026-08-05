/**
 * Follow-ups tab — the case's unified outreach queue (followup + nurture),
 * sorted by due date with legacy escalation tiers. Mutations go through the
 * /tc/followups endpoints and then the page re-fetches the case from the
 * server so the followups AND their emitted events stay true.
 */
import { useState } from "react";
import type { OfficeId, TcCase, TcFollowup } from "@shared/tc/contract";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Check, Loader2, Plus, SkipForward } from "lucide-react";
import { completeFollowup, createFollowup, skipFollowup, tcErrorMessage } from "../api";
import {
  getDaysOverdue,
  getEscalationClass,
  getEscalationLabel,
  getEscalationTier,
  todayIsoDate,
} from "../lib/followups";

type FollowupKindId = TcFollowup["kind"];
type FollowupChannelId = TcFollowup["channel"];
type NurtureTypeId = NonNullable<TcFollowup["nurtureType"]>;

const KIND_LABELS: Record<FollowupKindId, string> = {
  followup: "Follow-up",
  nurture: "Nurture",
};

const CHANNEL_LABELS: Record<FollowupChannelId, string> = {
  phone_call: "Phone call",
  text: "Text",
  email: "Email",
  in_person: "In person",
};

const NURTURE_TYPE_LABELS: Record<NurtureTypeId, string> = {
  check_in: "Check-in",
  seasonal: "Seasonal",
  life_event: "Life event",
  financing: "Financing",
};

const STATUS_BADGE: Record<TcFollowup["status"], string> = {
  pending: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  completed: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  skipped: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
};

export interface FollowupsTabProps {
  office: OfficeId;
  tcCase: TcCase;
  /** Re-fetch the case from the server (getCase) — called after any mutation. */
  refreshCase: () => Promise<void>;
}

export function FollowupsTab({ office, tcCase, refreshCase }: FollowupsTabProps) {
  const [addOpen, setAddOpen] = useState(false);
  const [outcomeTarget, setOutcomeTarget] = useState<{
    followup: TcFollowup;
    action: "complete" | "skip";
  } | null>(null);

  const today = todayIsoDate();
  const followups = [...tcCase.followups].sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  const refresh = () =>
    refreshCase().catch((e: unknown) => toast.error(tcErrorMessage(e)));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {followups.length === 0
            ? "No follow-ups on this case."
            : `${followups.filter((f) => f.status === "pending").length} pending of ${followups.length}`}
        </p>
        <Button variant="outline" onClick={() => setAddOpen(true)}>
          <Plus size={14} />
          Add follow-up
        </Button>
      </div>

      {followups.map((f) => {
        const tier = getEscalationTier(f.dueDate, today);
        return (
          <Card key={f.followupId}>
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-foreground">{f.dueDate}</span>
                    <Badge variant="outline" className="border-transparent bg-muted text-muted-foreground">
                      {KIND_LABELS[f.kind]}
                      {f.nurtureType ? ` · ${NURTURE_TYPE_LABELS[f.nurtureType]}` : ""}
                    </Badge>
                    <Badge variant="outline" className="border-transparent bg-muted text-muted-foreground">
                      {CHANNEL_LABELS[f.channel]}
                    </Badge>
                    <Badge variant="outline" className={`border-transparent ${STATUS_BADGE[f.status]}`}>
                      {f.status}
                    </Badge>
                    {f.status === "pending" && (
                      <Badge variant="outline" className={`border-transparent ${getEscalationClass(tier)}`}>
                        {getEscalationLabel(tier, getDaysOverdue(f.dueDate, today))}
                      </Badge>
                    )}
                  </div>
                  {f.talkingPoint && (
                    <p className="text-sm text-muted-foreground">{f.talkingPoint}</p>
                  )}
                  {f.outcomeNote && (
                    <p className="text-xs text-muted-foreground italic">Outcome: {f.outcomeNote}</p>
                  )}
                </div>
                {f.status === "pending" && (
                  <div className="flex gap-2 flex-shrink-0">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setOutcomeTarget({ followup: f, action: "complete" })}
                    >
                      <Check size={14} />
                      Complete
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setOutcomeTarget({ followup: f, action: "skip" })}
                    >
                      <SkipForward size={14} />
                      Skip
                    </Button>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        );
      })}

      <OutcomeDialog
        key={outcomeTarget ? `${outcomeTarget.followup.followupId}-${outcomeTarget.action}` : "closed"}
        office={office}
        target={outcomeTarget}
        onClose={() => setOutcomeTarget(null)}
        onDone={refresh}
      />

      <AddFollowupDialog
        key={addOpen ? "add-open" : "add-closed"}
        office={office}
        caseId={tcCase.caseId}
        open={addOpen}
        onOpenChange={setAddOpen}
        onDone={refresh}
      />
    </div>
  );
}

// ── Complete / skip with optional outcome note ──────────────────────────────

function OutcomeDialog({
  office,
  target,
  onClose,
  onDone,
}: {
  office: OfficeId;
  target: { followup: TcFollowup; action: "complete" | "skip" } | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [outcomeNote, setOutcomeNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!target) return;
    setSubmitting(true);
    try {
      const input = outcomeNote.trim() ? { outcomeNote: outcomeNote.trim() } : undefined;
      if (target.action === "complete") {
        await completeFollowup(office, target.followup.followupId, input);
      } else {
        await skipFollowup(office, target.followup.followupId, input);
      }
      toast.success(target.action === "complete" ? "Follow-up completed" : "Follow-up skipped");
      onClose();
      onDone();
    } catch (e) {
      toast.error(tcErrorMessage(e));
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && !submitting && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {target?.action === "complete" ? "Complete follow-up" : "Skip follow-up"}
          </DialogTitle>
          <DialogDescription>
            {target ? `Due ${target.followup.dueDate} · ${CHANNEL_LABELS[target.followup.channel]}` : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="tc-outcome-note">Outcome note (optional)</Label>
          <Textarea
            id="tc-outcome-note"
            value={outcomeNote}
            rows={3}
            placeholder="What happened?"
            onChange={(e) => setOutcomeNote(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={submitting}>
            {submitting && <Loader2 className="animate-spin" />}
            {target?.action === "complete" ? "Complete" : "Skip"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Add follow-up ───────────────────────────────────────────────────────────

const KIND_IDS = Object.keys(KIND_LABELS) as FollowupKindId[];
const CHANNEL_IDS = Object.keys(CHANNEL_LABELS) as FollowupChannelId[];
const NURTURE_TYPE_IDS = Object.keys(NURTURE_TYPE_LABELS) as NurtureTypeId[];

function AddFollowupDialog({
  office,
  caseId,
  open,
  onOpenChange,
  onDone,
}: {
  office: OfficeId;
  caseId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [kind, setKind] = useState<FollowupKindId>("followup");
  const [dueDate, setDueDate] = useState("");
  const [channel, setChannel] = useState<FollowupChannelId>("phone_call");
  const [talkingPoint, setTalkingPoint] = useState("");
  const [nurtureType, setNurtureType] = useState<NurtureTypeId>("check_in");
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      setInlineError("Pick a due date.");
      return;
    }
    setInlineError(null);
    setSubmitting(true);
    try {
      await createFollowup(office, {
        caseId,
        kind,
        dueDate,
        channel,
        talkingPoint: talkingPoint.trim(),
        nurtureType: kind === "nurture" ? nurtureType : null,
        source: "manual",
      });
      toast.success("Follow-up added");
      onOpenChange(false);
      onDone();
    } catch (e) {
      toast.error(tcErrorMessage(e));
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !submitting && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add follow-up</DialogTitle>
          <DialogDescription>Schedule the next touch on this case.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="tc-fu-kind">Kind</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as FollowupKindId)}>
                <SelectTrigger id="tc-fu-kind" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KIND_IDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {KIND_LABELS[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tc-fu-due">Due date</Label>
              <Input
                id="tc-fu-due"
                type="date"
                value={dueDate}
                onChange={(e) => {
                  setDueDate(e.target.value);
                  setInlineError(null);
                }}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="tc-fu-channel">Channel</Label>
              <Select value={channel} onValueChange={(v) => setChannel(v as FollowupChannelId)}>
                <SelectTrigger id="tc-fu-channel" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CHANNEL_IDS.map((c) => (
                    <SelectItem key={c} value={c}>
                      {CHANNEL_LABELS[c]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {kind === "nurture" && (
              <div className="space-y-1.5">
                <Label htmlFor="tc-fu-nurture-type">Nurture type</Label>
                <Select value={nurtureType} onValueChange={(v) => setNurtureType(v as NurtureTypeId)}>
                  <SelectTrigger id="tc-fu-nurture-type" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {NURTURE_TYPE_IDS.map((n) => (
                      <SelectItem key={n} value={n}>
                        {NURTURE_TYPE_LABELS[n]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="tc-fu-talking-point">Talking point</Label>
            <Textarea
              id="tc-fu-talking-point"
              value={talkingPoint}
              rows={3}
              placeholder="What to say when you reach out…"
              onChange={(e) => setTalkingPoint(e.target.value)}
            />
          </div>

          {inlineError && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {inlineError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={submitting}>
            {submitting && <Loader2 className="animate-spin" />}
            Add follow-up
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

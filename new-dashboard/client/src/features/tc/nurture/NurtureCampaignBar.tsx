/**
 * The case page's nurture-campaign strip (queue item 47).
 *
 *   No campaign running   "Start Nurture" → a picker of the four fixed tracks.
 *                         Each shows the office's intensity for it; a track
 *                         that cannot start says why (greyed, with the reason).
 *   Running or paused     a chip: track, status, the next touch and when it is
 *                         due, with Pause / Resume and Stop (Stop asks why).
 *
 * The cadence is not editable here or anywhere: the office's dial picks one of
 * three frozen schedules. Every touch the campaign produces is a DRAFT that a
 * person approves in the Nurture Outbox (Texts page) — the copy says so at the
 * moment of starting one, so nobody believes they just scheduled sends.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { Loader2, Pause, Play, Sprout, Square } from "lucide-react";
import type { OfficeId } from "@shared/tc/contract";
import {
  NURTURE_TRACKS,
  nurtureSchedule,
  type NurtureCaseResponse,
  type NurtureTrackAvailability,
  type TcNurtureEnrollment,
} from "@shared/tc/nurture";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { CHANNEL_LABEL } from "../messaging/copy";
import { getCaseNurture, pauseNurture, resumeNurture, startNurture, stopNurture } from "./campaignApi";
import {
  ENROLLMENT_STATUS_LABEL,
  INTENSITY_LABEL,
  UNAVAILABLE_COPY,
  nurtureErrorText,
  shortDate,
} from "./campaignCopy";

export interface NurtureCampaignBarProps {
  office: OfficeId;
  caseId: string;
  /** The case's status / events changed (enroll moves it to nurture): re-fetch the case. */
  onCaseChanged: () => void;
}

export function NurtureCampaignBar({ office, caseId, onCaseChanged }: NurtureCampaignBarProps) {
  const [data, setData] = useState<NurtureCaseResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [stopOpen, setStopOpen] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await getCaseNurture(office, caseId));
    } catch (e) {
      setError(nurtureErrorText(e));
    }
  }, [office, caseId]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = data?.enrollments.find((e) => e.status === "active" || e.status === "paused") ?? null;

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(done);
      await load();
      onCaseChanged();
    } catch (e) {
      toast.error(nurtureErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <div className="flex items-center gap-2 text-xs text-red-600 dark:text-red-400" data-testid="nurture-bar-error">
        Couldn't load nurture campaigns: {error}
        <Button size="sm" variant="ghost" onClick={() => void load()}>
          Retry
        </Button>
      </div>
    );
  }
  if (!data) return null;

  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm"
      data-testid="nurture-bar"
    >
      <Sprout className="h-4 w-4 text-violet-600 dark:text-violet-400" />
      {open ? (
        <EnrollmentChip
          enrollment={open}
          busy={busy}
          onPause={() => void act(() => pauseNurture(office, open.enrollmentId), "Campaign paused. No new drafts until it's resumed.")}
          onResume={() =>
            void act(() => resumeNurture(office, open.enrollmentId), "Campaign resumed. The next draft is scheduled from today.")
          }
          onStop={() => setStopOpen(true)}
        />
      ) : (
        <>
          <span className="text-muted-foreground">
            {data.enabled ? "No nurture campaign on this case." : "Nurture campaigns are switched off for this office."}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto gap-1"
            onClick={() => setPickerOpen(true)}
            disabled={busy}
            data-testid="start-nurture"
          >
            Start Nurture
          </Button>
        </>
      )}

      <TrackPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        tracks={data.tracks}
        busy={busy}
        onPick={(t) => {
          setPickerOpen(false);
          void act(
            () => startNurture(office, caseId, t.trackKey),
            `${t.label} started. Each touch will wait in the Nurture Outbox for someone to approve it — nothing sends on its own.`,
          );
        }}
      />

      {open && (
        <StopDialog
          open={stopOpen}
          onOpenChange={setStopOpen}
          busy={busy}
          onStop={(reason) => {
            setStopOpen(false);
            void act(() => stopNurture(office, open.enrollmentId, reason), "Campaign stopped.");
          }}
        />
      )}
    </div>
  );
}

function EnrollmentChip({
  enrollment,
  busy,
  onPause,
  onResume,
  onStop,
}: {
  enrollment: TcNurtureEnrollment;
  busy: boolean;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}) {
  const total = nurtureSchedule(enrollment.trackKey, enrollment.intensityAtEnroll).length;
  const paused = enrollment.status === "paused";
  return (
    <>
      <span className="font-medium text-foreground" data-testid="nurture-chip">
        {trackLabelOf(enrollment)}
      </span>
      <Badge variant={paused ? "outline" : "secondary"}>{ENROLLMENT_STATUS_LABEL[enrollment.status]}</Badge>
      <span className="text-xs text-muted-foreground">
        {INTENSITY_LABEL[enrollment.intensityAtEnroll]} · {enrollment.touchCount} of {total} drafted
        {enrollment.nextTouchKey
          ? paused
            ? " · next draft waits until resumed"
            : ` · next draft ${shortDate(enrollment.nextTouchDueAt)}`
          : ""}
      </span>
      {paused && (
        <span className="text-xs text-amber-700 dark:text-amber-400">
          No drafts until someone resumes it. If the patient replied, read the thread first.
        </span>
      )}
      <div className="ml-auto flex items-center gap-1">
        <Link href="/tc/texts" className="text-xs text-primary underline-offset-2 hover:underline">
          Outbox
        </Link>
        {paused ? (
          <Button size="sm" variant="outline" className="gap-1" disabled={busy} onClick={onResume}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} Resume
          </Button>
        ) : (
          <Button size="sm" variant="outline" className="gap-1" disabled={busy} onClick={onPause}>
            <Pause className="h-3.5 w-3.5" /> Pause
          </Button>
        )}
        <Button size="sm" variant="ghost" className="gap-1" disabled={busy} onClick={onStop}>
          <Square className="h-3.5 w-3.5" /> Stop
        </Button>
      </div>
    </>
  );
}

function trackLabelOf(e: TcNurtureEnrollment): string {
  return NURTURE_TRACKS[e.trackKey].label;
}

function TrackPicker({
  open,
  onOpenChange,
  tracks,
  busy,
  onPick,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  tracks: NurtureTrackAvailability[];
  busy: boolean;
  onPick: (t: NurtureTrackAvailability) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Start a nurture campaign</DialogTitle>
          <DialogDescription>
            Pick one of the four campaigns. Its pace is set per office. Every touch is written as a draft for someone to
            approve in the Nurture Outbox — nothing sends on its own.
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-2">
          {tracks.map((t) => (
            <li key={t.trackKey}>
              <button
                type="button"
                disabled={!t.available || busy}
                onClick={() => onPick(t)}
                className="w-full rounded-lg border border-border p-3 text-left transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
                data-testid={`track-${t.trackKey}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-foreground">{t.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {INTENSITY_LABEL[t.intensity]} · {t.touchCount} touches · {t.channels.map((c) => CHANNEL_LABEL[c]).join(" + ")}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">{t.goal}</p>
                {!t.available && t.reason && (
                  <p className="mt-1 text-xs text-amber-700 dark:text-amber-400" data-testid={`track-reason-${t.trackKey}`}>
                    {UNAVAILABLE_COPY[t.reason]}
                  </p>
                )}
              </button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

function StopDialog({
  open,
  onOpenChange,
  busy,
  onStop,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  busy: boolean;
  onStop: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (open) setReason("");
  }, [open]);
  const trimmed = reason.trim();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Stop this campaign?</DialogTitle>
          <DialogDescription>
            No more drafts will be written for it. Drafts already in the outbox stay there until someone approves or skips
            them. A stopped campaign can't be resumed — start a new one if needed.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={200}
          placeholder="Why? (e.g. patient called to schedule)"
          aria-label="Reason for stopping"
        />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Keep it running
          </Button>
          <Button disabled={!trimmed || busy} onClick={() => onStop(trimmed)}>
            Stop campaign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

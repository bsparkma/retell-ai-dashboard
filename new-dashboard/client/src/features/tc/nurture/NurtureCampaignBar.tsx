/**
 * The case page's nurture-campaign strip (queue item 47).
 *
 *   No campaign running   "Start Nurture" → a picker of the four fixed tracks.
 *                         Each shows the office's intensity for it; a track
 *                         that cannot start says why (greyed, with the reason).
 *   Running or paused     a chip: track, status, the next touch and when it is
 *                         due, with Pause / Resume and Stop (Stop asks why).
 *
 * EL-2 — THE PATIENT EMAIL LIBRARY. The picker's optional "Use the patient
 * email library for…" section picks a procedure (this office's catalog, by
 * category) and a tone. A track started that way drafts the library's own
 * email sequence instead of the hand-written touches: email only, one cadence
 * (the office's dial does not apply). Whether each track can start from the
 * library on this case is the SERVER's answer (libraryAvailable, with its
 * reason in words); the picker only shows it. The strip then names the
 * procedure and tone.
 *
 * EL-2c — APPROVE UP FRONT. Starting from the library writes the WHOLE
 * campaign at once and opens "Review campaign" (NurtureCampaignReview), where a
 * person approves each email word for word. The strip then reads "Library:
 * Dental Crown · Warm · 3 of 10 approved · 0 sent · next Dec 1", with Review
 * and "Patient replied" (email replies never reach the app, so a person marks
 * it: the campaign pauses and nothing is cancelled), and says in words that
 * automatic sending is not switched on: approved emails wait.
 *
 * The cadence is not editable here or anywhere: the office's dial picks one of
 * three frozen schedules. Every touch the campaign produces is a DRAFT that a
 * person approves in the Nurture Outbox (Texts page) — the copy says so at the
 * moment of starting one, so nobody believes they just scheduled sends.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { BookOpen, ClipboardCheck, Loader2, MessageCircleReply, Pause, Play, Sprout, Square } from "lucide-react";
import type { OfficeId } from "@shared/tc/contract";
import type { EmailLibraryCatalogResponse } from "@shared/tc/emailLibrary";
import {
  isLibrarySequenceTrack,
  NURTURE_AUTOMATIC_SENDING_NOTE,
  NURTURE_PAUSE_PATIENT_REPLIED,
  NURTURE_TRACKS,
  NurtureLibraryVariant,
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
import {
  getCaseNurture,
  markPatientReplied,
  pauseNurture,
  resumeNurture,
  startNurture,
  stopNurture,
  type LibraryChoice,
} from "./campaignApi";
import {
  ENROLLMENT_STATUS_LABEL,
  INTENSITY_LABEL,
  LIBRARY_TONE_LABEL,
  UNAVAILABLE_COPY,
  nurtureErrorText,
  officeShortDate,
  shortDate,
} from "./campaignCopy";
import { libraryProcedureName, useLibraryCatalog } from "./useLibraryCatalog";
import { NurtureCampaignReview } from "./NurtureCampaignReview";

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
  /** EL-2c: the library campaign whose Review screen is open. */
  const [reviewId, setReviewId] = useState<string | null>(null);

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
  // The library catalog: for the picker, and for the strip of a library enrollment.
  const library = useLibraryCatalog(office, pickerOpen || Boolean(open?.libraryProcedureId));

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
          catalog={library.catalog}
          busy={busy}
          onPause={() => void act(() => pauseNurture(office, open.enrollmentId), "Campaign paused. No new drafts until it's resumed.")}
          onResume={() =>
            void act(() => resumeNurture(office, open.enrollmentId), "Campaign resumed. The next draft is scheduled from today.")
          }
          onStop={() => setStopOpen(true)}
          onReview={() => setReviewId(open.enrollmentId)}
          onReplied={() =>
            void act(
              () => markPatientReplied(office, open.enrollmentId),
              "Marked: the patient replied. The campaign is paused; nothing was cancelled. Resume it when you're ready.",
            )
          }
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
        catalog={library.catalog}
        catalogError={library.error}
        busy={busy}
        onPick={(t, choice) => {
          setPickerOpen(false);
          if (choice) {
            const what = `${libraryProcedureName(library.catalog, choice.procedureId)}, ${LIBRARY_TONE_LABEL[choice.variant].toLowerCase()}`;
            // EL-2c: the whole campaign is written now; open Review campaign
            // so a person can read and approve each email.
            void act(async () => {
              const started = await startNurture(office, caseId, t.trackKey, choice);
              if (started && started.enrollmentId) setReviewId(started.enrollmentId);
            }, `${t.label} started from the patient email library (${what}). Every email is written as a draft — review and approve each one. Nothing sends on its own.`);
            return;
          }
          void act(
            () => startNurture(office, caseId, t.trackKey),
            `${t.label} started. Each touch will wait in the Nurture Outbox for someone to approve it — nothing sends on its own.`,
          );
        }}
      />

      <NurtureCampaignReview
        office={office}
        enrollmentId={reviewId}
        open={reviewId !== null}
        onOpenChange={(v) => !v && setReviewId(null)}
        onChanged={() => void load()}
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
  catalog,
  busy,
  onPause,
  onResume,
  onStop,
  onReview,
  onReplied,
}: {
  enrollment: TcNurtureEnrollment;
  catalog: EmailLibraryCatalogResponse | null;
  busy: boolean;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onReview: () => void;
  onReplied: () => void;
}) {
  // The server's count (preset or library sequence); the preset's for an older server.
  const total =
    typeof enrollment.stepCount === "number"
      ? enrollment.stepCount
      : nurtureSchedule(enrollment.trackKey, enrollment.intensityAtEnroll).length;
  const paused = enrollment.status === "paused";
  const fromLibrary = enrollment.libraryProcedureId && enrollment.libraryVariant;
  // A library enrollment runs the library's one cadence: its pace is the
  // procedure and tone, not the office dial.
  const pace = fromLibrary
    ? `Library: ${libraryProcedureName(catalog, enrollment.libraryProcedureId ?? "")} · ${
        LIBRARY_TONE_LABEL[enrollment.libraryVariant ?? "A"]
      }`
    : INTENSITY_LABEL[enrollment.intensityAtEnroll];
  // EL-2c: a library campaign is written in full at Start, so its progress is
  // APPROVALS and SENDS, not drafts. (An older server sends no counts: the
  // item-47 "N of M drafted" line stands.)
  const approveUpFront = Boolean(fromLibrary) && typeof enrollment.approvedCount === "number";
  const replied = paused && enrollment.stopReason === NURTURE_PAUSE_PATIENT_REPLIED;
  return (
    <>
      <span className="font-medium text-foreground" data-testid="nurture-chip">
        {trackLabelOf(enrollment)}
      </span>
      <Badge variant={paused ? "outline" : "secondary"}>{ENROLLMENT_STATUS_LABEL[enrollment.status]}</Badge>
      {approveUpFront ? (
        <span className="text-xs text-muted-foreground" data-testid="nurture-chip-pace">
          {pace} · {enrollment.approvedCount} of {total} approved · {enrollment.sentCount} sent
          {enrollment.nextSendAt ? ` · next ${officeShortDate(enrollment.nextSendAt)}` : ""}
        </span>
      ) : (
        <span className="text-xs text-muted-foreground" data-testid="nurture-chip-pace">
          {pace} · {enrollment.touchCount} of {total} drafted
          {enrollment.nextTouchKey
            ? paused
              ? " · next draft waits until resumed"
              : ` · next draft ${shortDate(enrollment.nextTouchDueAt)}`
            : ""}
        </span>
      )}
      {paused && (
        <span className="text-xs text-amber-700 dark:text-amber-400" data-testid="nurture-chip-paused">
          {approveUpFront
            ? `${replied ? "Paused: the patient replied." : "Paused."} Its emails wait as they are and nothing is cancelled. Read the reply before resuming.`
            : "No drafts until someone resumes it. If the patient replied, read the thread first."}
        </span>
      )}
      {approveUpFront && (
        <span className="basis-full text-xs text-muted-foreground" data-testid="nurture-strip-auto-note">
          {NURTURE_AUTOMATIC_SENDING_NOTE}
        </span>
      )}
      <div className="ml-auto flex items-center gap-1">
        {approveUpFront ? (
          <>
            <Button size="sm" variant="outline" className="gap-1" disabled={busy} onClick={onReview} data-testid="nurture-review-open">
              <ClipboardCheck className="h-3.5 w-3.5" /> Review
            </Button>
            {!replied && (
              <Button size="sm" variant="ghost" className="gap-1" disabled={busy} onClick={onReplied} data-testid="nurture-replied">
                <MessageCircleReply className="h-3.5 w-3.5" /> Patient replied
              </Button>
            )}
          </>
        ) : (
          <Link href="/tc/texts" className="text-xs text-primary underline-offset-2 hover:underline">
            Outbox
          </Link>
        )}
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

const TONES = NurtureLibraryVariant.options;

function TrackPicker({
  open,
  onOpenChange,
  tracks,
  catalog,
  catalogError,
  busy,
  onPick,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  tracks: NurtureTrackAvailability[];
  catalog: EmailLibraryCatalogResponse | null;
  catalogError: string | null;
  busy: boolean;
  onPick: (t: NurtureTrackAvailability, library: LibraryChoice | null) => void;
}) {
  const [useLibrary, setUseLibrary] = useState(false);
  const [procedureId, setProcedureId] = useState("");
  const [variant, setVariant] = useState<NurtureLibraryVariant>("A");
  useEffect(() => {
    if (open) {
      setUseLibrary(false);
      setProcedureId("");
      setVariant("A");
    }
  }, [open]);

  // The library section is offered only for the tracks the library has a sequence for.
  const libraryTracks = tracks.filter((t) => isLibrarySequenceTrack(t.trackKey));
  const anyLibrary = libraryTracks.some((t) => t.libraryAvailable === true);
  // Procedures by category, in the catalog's order (this office's, after services_off).
  const groups = useMemo(() => {
    const out: Array<{ category: string; procedures: Array<{ id: string; name: string }> }> = [];
    for (const p of catalog?.procedures ?? []) {
      const g = out.find((x) => x.category === p.category);
      if (g) g.procedures.push({ id: p.id, name: p.name });
      else out.push({ category: p.category, procedures: [{ id: p.id, name: p.name }] });
    }
    return out;
  }, [catalog]);
  const choice: LibraryChoice | null = useLibrary && procedureId ? { procedureId, variant } : null;

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

        {libraryTracks.length > 0 && (
          <div className="space-y-2 rounded-lg border border-border bg-muted/40 p-3" data-testid="nurture-library-section">
            <label className="flex items-center gap-2 text-sm font-medium text-foreground">
              <input
                type="checkbox"
                className="h-4 w-4 accent-violet-600"
                checked={useLibrary}
                disabled={!anyLibrary || busy}
                onChange={(e) => setUseLibrary(e.target.checked)}
                data-testid="nurture-library-toggle"
              />
              <BookOpen className="h-4 w-4 text-violet-600 dark:text-violet-400" aria-hidden />
              Use the patient email library for…
            </label>
            {!anyLibrary && (
              <p className="text-xs text-muted-foreground" data-testid="nurture-library-unavailable">
                {libraryTracks[0]?.libraryBlockedReason ?? "The patient email library is not available for this case."}
              </p>
            )}
            {useLibrary && (
              <div className="space-y-2 pl-6">
                {catalogError ? (
                  <p className="text-xs text-red-600 dark:text-red-400" data-testid="nurture-library-catalog-error">
                    Couldn't load the email library: {catalogError}
                  </p>
                ) : (
                  <label className="block text-xs text-muted-foreground">
                    Procedure
                    <select
                      className="mt-1 block w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground"
                      value={procedureId}
                      onChange={(e) => setProcedureId(e.target.value)}
                      disabled={!catalog || busy}
                      data-testid="nurture-library-procedure"
                    >
                      <option value="">{catalog ? "Choose a procedure" : "Loading…"}</option>
                      {groups.map((g) => (
                        <optgroup key={g.category} label={g.category}>
                          {g.procedures.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </label>
                )}
                <div className="text-xs text-muted-foreground">
                  Tone
                  <div className="mt-1 flex gap-1" role="radiogroup" aria-label="Tone">
                    {TONES.map((v) => (
                      <button
                        key={v}
                        type="button"
                        role="radio"
                        aria-checked={variant === v}
                        onClick={() => setVariant(v)}
                        disabled={busy}
                        className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                          variant === v
                            ? "border-violet-500 bg-violet-50 text-violet-900 dark:border-violet-400 dark:bg-violet-950 dark:text-violet-100"
                            : "border-border bg-background text-foreground hover:bg-muted"
                        }`}
                        data-testid={`nurture-library-tone-${v}`}
                      >
                        {LIBRARY_TONE_LABEL[v]}
                      </button>
                    ))}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Email only, on the library's own day-by-day sequence — the office's pace does not apply. Each email is
                  written from this office's saved wording, as a draft for review.
                </p>
              </div>
            )}
          </div>
        )}

        <ul className="space-y-2">
          {tracks.map((t) => {
            const viaLibrary = useLibrary && isLibrarySequenceTrack(t.trackKey);
            const libraryBlocked = viaLibrary && t.libraryAvailable !== true;
            const disabled = !t.available || busy || (viaLibrary && (libraryBlocked || !choice));
            return (
              <li key={t.trackKey}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onPick(t, viaLibrary ? choice : null)}
                  className="w-full rounded-lg border border-border p-3 text-left transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
                  data-testid={`track-${t.trackKey}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-foreground">{t.label}</span>
                    <span className="text-xs text-muted-foreground">
                      {viaLibrary
                        ? "Library sequence · Email"
                        : `${INTENSITY_LABEL[t.intensity]} · ${t.touchCount} touches · ${t.channels.map((c) => CHANNEL_LABEL[c]).join(" + ")}`}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">{t.goal}</p>
                  {!t.available && t.reason ? (
                    <p className="mt-1 text-xs text-amber-700 dark:text-amber-400" data-testid={`track-reason-${t.trackKey}`}>
                      {UNAVAILABLE_COPY[t.reason]}
                    </p>
                  ) : libraryBlocked ? (
                    <p
                      className="mt-1 text-xs text-amber-700 dark:text-amber-400"
                      data-testid={`track-library-reason-${t.trackKey}`}
                    >
                      {t.libraryBlockedReason ?? "The patient email library is not available for this track."}
                    </p>
                  ) : null}
                </button>
              </li>
            );
          })}
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
            No more drafts will be written for it, and every message it has still waiting — drafts and approved emails —
            is cancelled, so nothing from it can go out. A stopped campaign can't be resumed — start a new one if needed.
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

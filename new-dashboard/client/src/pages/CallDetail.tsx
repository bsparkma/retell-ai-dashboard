/**
 * CallDetail — Individual call view with transcript, recording, patient link, and analysis
 */
import { useParams, Link } from "wouter";
import { useState, useEffect, useRef, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ArrowLeft, Bot, Users, Play, Pause, Download, FileText,
  User, Calendar, Phone, Tag, AlertTriangle, CheckCircle2, Clock, Send, UserCheck
} from "lucide-react";
import {
  api, type UnifiedCall, type OdPatient, type OdPatientAddress, type NotAPatientReason,
  type CallActor, type OdSyncStatus,
} from "@/lib/api";
import { formatDuration, formatTimeAgo } from "@/lib/utils";
import { toast } from "sonner";
import { PickPatientModal } from "./calls/PickPatientModal";
import { SendToChartDialog } from "./calls/SendToChartDialog";

type PatientMatchSource = "id" | "phone" | "none";

function buildTranscript(call: UnifiedCall) {
  if (call.transcript_object && call.transcript_object.length > 0) {
    return call.transcript_object.map((u, i) => ({
      role: (u.role === "agent" || u.role === "assistant") ? "agent" : "patient" as "agent" | "patient",
      text: (u.content ?? "") as string,
      ts: i * 5,
    }));
  }
  if (typeof call.transcript === "string" && call.transcript.trim()) {
    return call.transcript.trim().split("\n").filter(Boolean).map((line, i) => ({
      role: (i % 2 === 0 ? "agent" : "patient") as "agent" | "patient",
      text: line,
      ts: i * 5,
    }));
  }
  return null;
}

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:5000/api";

function resolveRecordingUrl(url: string | undefined): string | null {
  if (!url) return null;
  if (url.startsWith("http")) return url;
  // Relative URL — prepend API base (strip trailing /api if present since url may already include path)
  const base = API_BASE.replace(/\/api\/?$/, "");
  return `${base}${url.startsWith("/") ? "" : "/"}${url}`;
}

function formatAudioTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatDob(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getFullYear()}`;
}

function formatLastVisit(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatBalance(amount: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
}

function formatPatientAddress(addr: OdPatientAddress | undefined): string | null {
  if (!addr) return null;
  const street = addr.street?.trim() ?? "";
  const city = addr.city?.trim() ?? "";
  const state = addr.state?.trim() ?? "";
  const zip = addr.zip?.trim() ?? "";
  if (!street && !city && !state && !zip) return null;
  const cityState = [city, state].filter(Boolean).join(", ");
  const tail = [cityState, zip].filter(Boolean).join(" ");
  return [street, tail].filter(Boolean).join(", ");
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((n) => n[0]?.toUpperCase() ?? "")
    .join("")
    .slice(0, 2);
}

interface CallPatientPanelProps {
  patient: OdPatient | null;
  loading: boolean;
  source: PatientMatchSource;
  callerName: string;
  callerPhone: string;
  notAPatient: boolean;
  notAPatientReason: NotAPatientReason | null;
  onLinkPatient: () => void;
  /** Slice B.1 chart-note state, driven by od_* (independent of the phone/id lookup). */
  syncStatus: OdSyncStatus;
  odPatientId: number | string | null;
  odPatientName: string | null;
  sentBy: CallActor | null;
  onSend: () => void;
}

function CallPatientPanel({
  patient, loading, source, callerName, callerPhone, notAPatient, notAPatientReason, onLinkPatient,
  syncStatus, odPatientId, odPatientName, sentBy, onSend,
}: CallPatientPanelProps) {
  const matchedName = odPatientName || (odPatientId ? `PatNum ${odPatientId}` : "matched patient");
  const sent = syncStatus === "synced";
  const matchedUnsent = !sent && odPatientId != null;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <User size={14} className="text-primary" /> Patient Record
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Chart-note status / send action (review-then-send) */}
        {sent && (
          <div className="rounded-lg bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700">
            <div className="flex items-center gap-1.5 font-medium">
              <CheckCircle2 size={13} /> Sent to chart · {matchedName}
            </div>
            {sentBy?.name && <div className="text-emerald-700/70 mt-0.5">by {sentBy.name}</div>}
          </div>
        )}
        {matchedUnsent && (
          <div className="rounded-lg bg-sky-500/10 px-3 py-2 space-y-2">
            <div className="flex items-center gap-1.5 text-xs font-medium text-sky-700">
              <UserCheck size={13} /> Matched: {matchedName}
            </div>
            <p className="text-[11px] text-sky-700/80">Auto-matched — review the note before it's written to the chart.</p>
            <Button size="sm" className="w-full gap-1.5 text-xs" onClick={onSend}>
              <Send size={12} /> Send to chart
            </Button>
          </div>
        )}

        {loading ? (
          <div className="space-y-2" aria-label="Loading patient record">
            <div className="flex items-center gap-3">
              <Skeleton className="h-10 w-10 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-2/3" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-3/4" />
          </div>
        ) : patient ? (
          <PatientFoundView patient={patient} source={source} />
        ) : odPatientId == null ? (
          <PatientNoMatchView
            callerName={callerName}
            callerPhone={callerPhone}
            notAPatient={notAPatient}
            notAPatientReason={notAPatientReason}
            onLinkPatient={onLinkPatient}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

function PatientNoMatchView({
  callerName, callerPhone, notAPatient, notAPatientReason, onLinkPatient,
}: {
  callerName: string;
  callerPhone: string;
  notAPatient: boolean;
  notAPatientReason: NotAPatientReason | null;
  onLinkPatient: () => void;
}) {
  const initials = initialsOf(callerName) || "?";
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/40">
        <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center font-semibold text-muted-foreground">
          {initials}
        </div>
        <div className="min-w-0">
          <div className="font-medium text-sm truncate">{callerName || "Unknown caller"}</div>
          <div className="text-xs text-muted-foreground font-mono">{callerPhone || "—"}</div>
        </div>
      </div>
      {notAPatient ? (
        <p className="text-xs text-muted-foreground">
          Marked not a patient{notAPatientReason ? ` · ${notAPatientReason.replace("_", " ")}` : ""}
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">No matching Open Dental patient found</p>
          <Button size="sm" className="w-full text-xs" onClick={onLinkPatient}>
            Link to Patient
          </Button>
        </>
      )}
    </div>
  );
}

function PatientFoundView({ patient, source }: { patient: OdPatient; source: PatientMatchSource }) {
  const fullName = patient.fullName?.trim()
    ? patient.fullName
    : `${patient.firstName ?? ""} ${patient.lastName ?? ""}`.trim();
  const displayName = fullName || "Patient";
  const initials = initialsOf(displayName) || "?";

  const preferred = patient.preferredName?.trim();
  const goesBy = preferred && preferred !== patient.firstName ? preferred : null;

  const dob = formatDob(patient.dateOfBirth);
  const phone = patient.phone?.trim() ? patient.phone : null;
  const email = patient.email?.trim() ? patient.email : null;
  const address = formatPatientAddress(patient.address);
  const primaryIns = patient.insurance?.primary?.trim() ? patient.insurance.primary : null;
  const secondaryIns = patient.insurance?.secondary?.trim() ? patient.insurance.secondary : null;
  const lastVisitLabel = patient.lastVisit ? formatLastVisit(patient.lastVisit) ?? "No visits on record" : "No visits on record";
  const showBalance = typeof patient.balance === "number" && patient.balance !== 0;
  const showInactive = patient.isActive === false;

  const sourceBadge: { text: string; tone: "muted" | "warning" } | null =
    source === "id"
      ? { text: "Matched by patient ID", tone: "muted" }
      : source === "phone"
      ? { text: "Matched by phone number — verify identity", tone: "warning" }
      : null;

  const fields: Array<{ label: string; value: React.ReactNode }> = [];
  if (goesBy) fields.push({ label: "Goes by", value: goesBy });
  if (dob) fields.push({ label: "Date of birth", value: dob });
  if (phone) fields.push({ label: "Phone", value: <span className="font-mono">{phone}</span> });
  if (email) fields.push({ label: "Email", value: <span className="break-all">{email}</span> });
  if (address) fields.push({ label: "Address", value: address });
  if (primaryIns) fields.push({ label: "Primary insurance", value: primaryIns });
  if (secondaryIns) fields.push({ label: "Secondary insurance", value: secondaryIns });
  fields.push({ label: "Last visit", value: lastVisitLabel });
  if (showBalance) {
    fields.push({
      label: "Balance",
      value: <span className="font-mono">{formatBalance(patient.balance)}</span>,
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/40">
        <div className="w-10 h-10 rounded-full bg-primary/15 flex items-center justify-center font-semibold text-primary flex-shrink-0">
          {initials}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="font-medium text-sm truncate">{displayName}</div>
            {showInactive && (
              <Badge
                variant="outline"
                className="text-[10px] border-destructive/40 text-destructive bg-destructive/10"
              >
                Inactive
              </Badge>
            )}
          </div>
          {sourceBadge && (
            <div
              className={`text-[11px] mt-0.5 ${
                sourceBadge.tone === "warning"
                  ? "text-amber-600 dark:text-amber-500"
                  : "text-muted-foreground"
              }`}
            >
              {sourceBadge.text}
            </div>
          )}
        </div>
      </div>

      {fields.length > 0 && (
        <div className="space-y-2 text-sm">
          {fields.map(({ label, value }) => (
            <div key={label} className="flex items-start justify-between gap-2">
              <span className="text-muted-foreground text-xs">{label}</span>
              <span className="text-xs font-medium text-right">{value}</span>
            </div>
          ))}
        </div>
      )}

      <Button
        variant="outline"
        size="sm"
        className="w-full text-xs"
        onClick={() => toast.info("Open Dental deep-link coming soon")}
      >
        Open in Open Dental
      </Button>
    </div>
  );
}

export default function CallDetail() {
  const { id } = useParams<{ id: string }>();
  const [call, setCall] = useState<UnifiedCall | null | "loading">("loading");
  const [error, setError] = useState<string | null>(null);

  const [patient, setPatient] = useState<OdPatient | null>(null);
  const [patientLoading, setPatientLoading] = useState(false);
  const [patientSource, setPatientSource] = useState<PatientMatchSource>("none");
  const [pickOpen, setPickOpen] = useState(false);
  const [sendTarget, setSendTarget] = useState<{ patientId: number; patientName: string } | null>(null);
  // What the next send writes (item 4): summary (compact) or full transcript.
  const [contentType, setContentType] = useState<"summary" | "transcript">("summary");

  // Contextual send (item 4): pick the content, then either open the review dialog
  // (patient already matched) or the Pick Patient modal first (which hands back here).
  const startSend = useCallback((ct: "summary" | "transcript") => {
    setContentType(ct);
    setCall((prev) => {
      if (prev && prev !== "loading" && prev.odPatientId != null && prev.odPatientId !== "") {
        setSendTarget({
          patientId: Number(prev.odPatientId),
          patientName: prev.odPatientName || `PatNum ${prev.odPatientId}`,
        });
      } else {
        setPickOpen(true);
      }
      return prev;
    });
  }, []);

  // After the chart note is sent, reflect synced + refresh the panel to the patient.
  const handleSent = useCallback((patientId: number) => {
    setCall((prev) => (prev && prev !== "loading"
      ? { ...prev, odPatientId: patientId, odSyncStatus: "synced", sentAt: new Date().toISOString() }
      : prev));
    setPatientLoading(true);
    api.getOpenDentalPatient(patientId)
      .then((p) => { setPatient(p); setPatientSource("id"); })
      .catch(() => { /* keep prior view; toast already fired */ })
      .finally(() => setPatientLoading(false));
  }, []);

  // Picker chose a patient → hand off to the review/edit → send dialog.
  const handleChoosePatient = useCallback((patientId: number, patientName: string) => {
    setPickOpen(false);
    setSendTarget({ patientId, patientName });
  }, []);

  const handleNotPatient = useCallback((reason: NotAPatientReason) => {
    setCall((prev) => (prev && prev !== "loading" ? { ...prev, notAPatient: true, notAPatientReason: reason } : prev));
  }, []);

  // Audio player state
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
    } else {
      audio.play().catch(() => toast.error("Unable to play recording"));
    }
  }, [isPlaying]);

  const handleSeek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio || !audioDuration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audio.currentTime = pct * audioDuration;
  }, [audioDuration]);

  useEffect(() => {
    if (!id) return;
    setCall("loading");
    setError(null);
    api.getUnifiedCall(id)
      .then(setCall)
      .catch(() => { setCall(null); setError("Call not found"); });
  }, [id]);

  useEffect(() => {
    if (!call || call === "loading") return;

    let cancelled = false;

    const rawPatientId = call.patientId;
    const parsedPatientId = rawPatientId ? Number(rawPatientId) : NaN;
    const patientId = Number.isFinite(parsedPatientId) && parsedPatientId > 0 ? parsedPatientId : null;
    const phone = call.fromNumber && call.fromNumber !== "Unknown" ? call.fromNumber : "";

    setPatient(null);
    setPatientSource("none");
    setPatientLoading(true);

    const lookup: Promise<OdPatient | null> = patientId
      ? api.getOpenDentalPatient(patientId).then((p) => {
          if (!cancelled) setPatientSource("id");
          return p;
        })
      : phone
      ? api.searchPatientByPhone(phone).then((p) => {
          if (!cancelled) setPatientSource(p ? "phone" : "none");
          return p;
        })
      : Promise.resolve(null);

    lookup
      .then((p) => {
        if (!cancelled) setPatient(p);
      })
      .catch(() => {
        if (!cancelled) setPatient(null);
      })
      .finally(() => {
        if (!cancelled) setPatientLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [call]);

  if (call === "loading") {
    return (
      <div className="p-6 flex items-center justify-center min-h-[200px] text-muted-foreground">
        Loading call…
      </div>
    );
  }
  if (call === null) {
    return (
      <div className="p-6 space-y-4">
        <Link href="/calls"><Button variant="ghost" size="sm">← Back to Calls</Button></Link>
        <p className="text-muted-foreground">{error ?? "Call not found."}</p>
      </div>
    );
  }

  const displayCall = call;

  const transcript = buildTranscript(displayCall);
  const analysis = {
    summary: displayCall.summary || "",
    outcome: displayCall.outcome || "",
    sentiment: displayCall.sentiment,
  };

  return (
    <div className="p-6 space-y-6">
      {/* Shared Pick Patient modal — candidates-first / OD search, then hands off
          to the review/edit → send dialog (same flow as the worklist). */}
      <PickPatientModal
        open={pickOpen}
        onOpenChange={setPickOpen}
        call={displayCall}
        onChoosePatient={handleChoosePatient}
        onNotPatient={handleNotPatient}
      />

      {/* Review/edit → send confirm dialog (matched calls and picked patients). */}
      {sendTarget && (
        <SendToChartDialog
          open={sendTarget !== null}
          onOpenChange={(o) => { if (!o) setSendTarget(null); }}
          call={displayCall}
          patientId={sendTarget.patientId}
          patientName={sendTarget.patientName}
          contentType={contentType}
          onSent={() => handleSent(sendTarget.patientId)}
        />
      )}

      {/* Back + header */}
      <div className="flex items-start gap-4">
        <Link href="/calls">
          <Button variant="ghost" size="sm" className="gap-1.5 -ml-1">
            <ArrowLeft size={14} /> Back to Calls
          </Button>
        </Link>
      </div>

      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold text-foreground" style={{ fontFamily: "Outfit, sans-serif" }}>
              {displayCall.patientName}
            </h1>
            {displayCall.isEmergency && (
              <span className="flex items-center gap-1 px-2 py-1 rounded-lg text-sm font-bold bg-destructive/15 text-destructive">
                <AlertTriangle size={14} /> Emergency
              </span>
            )}
            <span
              className="text-sm font-medium px-2.5 py-1 rounded-full"
              style={displayCall.source === "retell"
                ? { backgroundColor: "oklch(0.55 0.18 210 / 0.12)", color: "oklch(0.40 0.18 210)" }
                : { backgroundColor: "oklch(0.78 0.17 75 / 0.12)", color: "oklch(0.50 0.17 75)" }
              }
            >
              {displayCall.source === "retell" ? "AI · Rover" : "Staff · Mango"}
            </span>
          </div>
          <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground flex-wrap">
            <span className="font-mono">{displayCall.fromNumber}</span>
            <span>·</span>
            <span>{formatTimeAgo(displayCall.date)}</span>
            <span>·</span>
            <span className="font-mono">{formatDuration(displayCall.duration)}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {displayCall.recording_url ? (
            <a
              href={resolveRecordingUrl(displayCall.recording_url) ?? "#"}
              download
              className="inline-flex items-center"
            >
              <Button variant="outline" size="sm" asChild>
                <span><Download size={14} className="mr-1.5" /> Download</span>
              </Button>
            </a>
          ) : (
            <Button variant="outline" size="sm" disabled>
              <Download size={14} className="mr-1.5" /> No Recording
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => toast.info("Adding to callback queue...")}>
            Add Callback
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Left: Transcript + Recording */}
        <div className="xl:col-span-2 space-y-6">
          {/* Recording player */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <Play size={14} className="text-primary" /> Recording
              </CardTitle>
            </CardHeader>
            <CardContent>
              {displayCall.recording_url ? (
                <>
                  <audio
                    ref={audioRef}
                    src={resolveRecordingUrl(displayCall.recording_url) ?? undefined}
                    preload="metadata"
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => setIsPlaying(false)}
                    onEnded={() => setIsPlaying(false)}
                    onTimeUpdate={() => setCurrentTime(audioRef.current?.currentTime ?? 0)}
                    onLoadedMetadata={() => setAudioDuration(audioRef.current?.duration ?? 0)}
                  />
                  <div className="flex items-center gap-4 p-4 bg-muted/40 rounded-lg">
                    <Button
                      size="sm"
                      className="w-9 h-9 rounded-full p-0 flex-shrink-0"
                      onClick={togglePlay}
                    >
                      {isPlaying ? <Pause size={14} /> : <Play size={14} />}
                    </Button>
                    <div className="flex-1">
                      <div
                        className="h-2 bg-border rounded-full overflow-hidden cursor-pointer"
                        onClick={handleSeek}
                      >
                        <div
                          className="h-full rounded-full transition-[width] duration-100"
                          style={{
                            backgroundColor: "oklch(0.55 0.18 210)",
                            width: audioDuration > 0 ? `${(currentTime / audioDuration) * 100}%` : "0%",
                          }}
                        />
                      </div>
                      <div className="flex justify-between mt-1 text-xs font-mono text-muted-foreground">
                        <span>{formatAudioTime(currentTime)}</span>
                        <span>{audioDuration > 0 ? formatAudioTime(audioDuration) : formatDuration(displayCall.duration)}</span>
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="flex items-center justify-center p-6 bg-muted/40 rounded-lg">
                  <p className="text-sm text-muted-foreground">No recording available</p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Transcript */}
          {transcript && transcript.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-base font-semibold flex items-center gap-2">
                    <FileText size={14} className="text-primary" /> Transcript
                  </CardTitle>
                  {/* Contextual send (item 4): full transcript = a large note, deliberate. */}
                  {displayCall.odSyncStatus !== "synced" && !displayCall.notAPatient && (
                    <Button variant="outline" size="sm" className="h-7 gap-1 text-[11px] px-2"
                      onClick={() => startSend("transcript")}>
                      <Send size={11} /> Send full transcript to chart
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {transcript.map((line, i) => (
                    <div key={i} className={`flex gap-3 ${line.role === "patient" ? "flex-row-reverse" : ""}`}>
                      <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 ${
                        line.role === "agent" ? "bg-primary/15" : "bg-muted"
                      }`}>
                        {line.role === "agent" ? (
                          <Bot size={12} className="text-primary" />
                        ) : (
                          <User size={12} className="text-muted-foreground" />
                        )}
                      </div>
                      <div className="max-w-[80%]">
                        <div className="text-xs text-muted-foreground mb-1 font-mono">
                          {line.role === "agent" ? "Rover (AI)" : displayCall.patientName} · {line.ts}s
                        </div>
                        <div className={`text-sm px-3 py-2 rounded-lg ${
                          line.role === "agent"
                            ? "bg-primary/8 text-foreground rounded-tl-none"
                            : "bg-muted text-foreground rounded-tr-none"
                        }`}>
                          {line.text}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Right: Analysis + Patient + Actions */}
        <div className="space-y-6">
          {/* AI Analysis */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-base font-semibold flex items-center gap-2">
                  <Bot size={14} className="text-primary" /> AI Analysis
                </CardTitle>
                {/* Contextual send (item 4): the compact summary block. */}
                {analysis.summary && displayCall.odSyncStatus !== "synced" && !displayCall.notAPatient && (
                  <Button variant="outline" size="sm" className="h-7 gap-1 text-[11px] px-2"
                    onClick={() => startSend("summary")}>
                    <Send size={11} /> Send summary to chart
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {analysis.summary ? (
                <div>
                  <div className="text-xs text-muted-foreground mb-1.5">Call Summary</div>
                  <p className="text-sm text-foreground leading-relaxed">{analysis.summary}</p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No analysis available for this call.</p>
              )}

              {analysis.outcome && (
                <div className="p-3 rounded-lg bg-muted/40">
                  <div className="text-xs text-muted-foreground mb-1">Outcome</div>
                  <div className="flex items-center gap-1.5">
                    <CheckCircle2 size={12} className="text-green-500" />
                    <span className="text-sm font-medium">{analysis.outcome}</span>
                  </div>
                </div>
              )}

              <div>
                <div className="text-xs text-muted-foreground mb-1.5">Sentiment</div>
                <div className="flex items-center gap-2">
                  <div
                    className="w-3 h-3 rounded-full"
                    style={{
                      backgroundColor: displayCall.sentiment === "positive"
                        ? "oklch(0.65 0.18 155)"
                        : displayCall.sentiment === "negative"
                        ? "oklch(0.62 0.22 25)"
                        : "oklch(0.52 0.015 240)",
                    }}
                  />
                  <span className="text-sm capitalize">{displayCall.sentiment}</span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Patient record */}
          <CallPatientPanel
            patient={patient}
            loading={patientLoading}
            source={patientSource}
            callerName={displayCall.patientName ?? "Unknown"}
            callerPhone={displayCall.fromNumber ?? ""}
            notAPatient={displayCall.notAPatient}
            notAPatientReason={displayCall.notAPatientReason}
            onLinkPatient={() => setPickOpen(true)}
            syncStatus={displayCall.odSyncStatus}
            odPatientId={displayCall.odPatientId}
            odPatientName={displayCall.odPatientName}
            sentBy={displayCall.sentBy}
            onSend={() => startSend("summary")}
          />

          {/* Call metadata */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold">Call Details</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2.5 text-sm">
                {[
                  { label: "Call ID", value: displayCall.id, mono: true },
                  { label: "Date", value: new Date(displayCall.date).toLocaleString() },
                  { label: "Duration", value: formatDuration(displayCall.duration), mono: true },
                  { label: "Agent", value: displayCall.agentName || "Staff" },
                  { label: "Source", value: displayCall.source === "retell" ? "Retell AI" : "Mango Voice" },
                  { label: "Intent", value: displayCall.intent || "—" },
                ].map(({ label, value, mono }) => (
                  <div key={label} className="flex items-start justify-between gap-2">
                    <span className="text-muted-foreground text-xs">{label}</span>
                    <span className={`text-xs font-medium text-right ${mono ? "font-mono" : ""}`}>{value}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

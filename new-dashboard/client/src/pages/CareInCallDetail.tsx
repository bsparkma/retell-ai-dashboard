/**
 * CareInCallDetail — Detail view for a CareIN-ingested call.
 *
 * Shows: caller, office, tag, routing, transcript, AI summary, sentiment,
 * quality score, and Open Dental commlog write status.
 *
 * Linked from the CareIN Log tab in Calls.tsx (/carein-calls/:id).
 */
import { useParams, Link } from "wouter";
import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ArrowLeft, Bot, User, FileText, AlertTriangle, Building2,
  Tag, RefreshCw, CheckCircle2, Clock, XCircle,
} from "lucide-react";
import { careInApi, type CareInCall } from "@/lib/api";
import { formatDuration, formatTimeAgo } from "@/lib/utils";
import { toast } from "sonner";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sentimentColor(s: CareInCall["sentiment"]): string {
  if (s === "positive") return "oklch(0.55 0.18 155)";
  if (s === "negative") return "oklch(0.62 0.22 25)";
  return "oklch(0.52 0.015 240)";
}

const TAG_LABELS: Record<string, string> = {
  appointment_scheduled:   "Appointment Scheduled",
  appointment_cancelled:   "Appointment Cancelled",
  appointment_rescheduled: "Appointment Rescheduled",
  new_patient_inquiry:     "New Patient Inquiry",
  billing_inquiry:         "Billing Inquiry",
  insurance_inquiry:       "Insurance Inquiry",
  emergency:               "Emergency",
  voicemail:               "Voicemail",
  transferred:             "Transferred",
  completed:               "Call Completed",
  unresolved:              "Unresolved",
};

const COMMLOG_CONFIG: Record<CareInCall["commlogStatus"], {
  label: string; color: string; bg: string; Icon: React.ElementType;
}> = {
  written: { label: "Written",  color: "oklch(0.40 0.18 155)", bg: "oklch(0.65 0.18 155 / 0.12)", Icon: CheckCircle2 },
  pending: { label: "Pending",  color: "oklch(0.42 0.12 280)", bg: "oklch(0.55 0.15 280 / 0.12)", Icon: Clock },
  failed:  { label: "Failed",   color: "oklch(0.52 0.22 25)",  bg: "oklch(0.62 0.22 25  / 0.12)", Icon: XCircle },
};

// ---------------------------------------------------------------------------
// Commlog card
// ---------------------------------------------------------------------------

function CommlogCard({ call, onRetry }: { call: CareInCall; onRetry: () => void }) {
  const cfg = COMMLOG_CONFIG[call.commlogStatus];
  const CommlogIcon = cfg.Icon;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <FileText size={14} className="text-primary" /> Open Dental Commlog
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div
          className="flex items-center gap-2.5 p-3 rounded-lg"
          style={{ backgroundColor: cfg.bg }}
          role="status"
          aria-live="polite"
        >
          <CommlogIcon size={16} style={{ color: cfg.color, flexShrink: 0 }} aria-hidden />
          <div>
            <div className="text-sm font-semibold" style={{ color: cfg.color }}>
              {cfg.label}
            </div>
            {call.commlogStatus === "written" && call.commlogWrittenAt && (
              <div className="text-xs text-muted-foreground mt-0.5">
                Written {formatTimeAgo(call.commlogWrittenAt)}
              </div>
            )}
            {call.commlogStatus === "pending" && (
              <div className="text-xs text-muted-foreground mt-0.5">
                Awaiting write to Open Dental
              </div>
            )}
            {call.commlogStatus === "failed" && call.commlogError && (
              <div className="text-xs text-muted-foreground mt-0.5">
                {call.commlogError}
              </div>
            )}
          </div>
        </div>

        {(call.commlogStatus === "failed" || call.commlogStatus === "pending") && (
          <Button
            size="sm"
            variant="outline"
            className="w-full text-xs gap-1.5"
            onClick={onRetry}
            aria-label="Retry Open Dental commlog write"
          >
            <RefreshCw size={12} /> Retry Commlog Write
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Transcript display
// ---------------------------------------------------------------------------

function TranscriptCard({ call }: { call: CareInCall }) {
  const turns = call.transcriptObject.length > 0
    ? call.transcriptObject
    : call.transcript
      ? call.transcript.split("\n").filter(Boolean).map((line, i) => ({
          role: i % 2 === 0 ? "agent" : "user",
          content: line,
        }))
      : [];

  if (turns.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <FileText size={14} className="text-primary" /> Transcript
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3" role="log" aria-label="Call transcript">
          {turns.map((turn, i) => {
            const isAgent = turn.role === "agent";
            return (
              <div key={i} className={`flex gap-3 ${!isAgent ? "flex-row-reverse" : ""}`}>
                <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 ${
                  isAgent ? "bg-primary/15" : "bg-muted"
                }`} aria-hidden>
                  {isAgent ? <Bot size={12} className="text-primary" /> : <User size={12} className="text-muted-foreground" />}
                </div>
                <div className="max-w-[80%]">
                  <div className="text-xs text-muted-foreground mb-1 font-mono">
                    {isAgent ? "Rover (AI)" : call.callerName}
                  </div>
                  <div className={`text-sm px-3 py-2 rounded-lg ${
                    isAgent
                      ? "bg-primary/8 text-foreground rounded-tl-none"
                      : "bg-muted text-foreground rounded-tr-none"
                  }`}>
                    {turn.content}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function CareInCallDetail() {
  const { id } = useParams<{ id: string }>();
  const [call, setCall] = useState<CareInCall | null | "loading">("loading");
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(() => {
    if (!id) return;
    setCall("loading");
    setError(null);
    careInApi.getCall(id)
      .then(setCall)
      .catch(() => {
        setCall(null);
        setError("Call not found in CareIN log.");
      });
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const handleRetry = async () => {
    if (!call || call === "loading") return;
    setRetrying(true);
    try {
      const res = await careInApi.retryCommlog(call.id);
      if (res.success) {
        setCall(res.call);
        toast.success("Commlog written successfully");
      } else {
        setCall(res.call);
        toast.error(res.error ?? "Commlog write failed");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Retry failed");
    } finally {
      setRetrying(false);
    }
  };

  if (call === "loading") {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-8 w-40" />
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          <div className="xl:col-span-2 space-y-4">
            <Skeleton className="h-48 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
          <div className="space-y-4">
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        </div>
      </div>
    );
  }

  if (call === null) {
    return (
      <div className="p-6 space-y-4" role="alert">
        <Link href="/calls">
          <Button variant="ghost" size="sm" className="gap-1.5">
            <ArrowLeft size={14} /> Back to Calls
          </Button>
        </Link>
        <p className="text-muted-foreground">{error ?? "Call not found."}</p>
        <p className="text-xs text-muted-foreground">
          Make sure the CareIN server is running and the call ID is correct.
        </p>
      </div>
    );
  }

  const qualityColor =
    call.qualityScore >= 80 ? "oklch(0.55 0.18 155)"
    : call.qualityScore >= 60 ? "oklch(0.65 0.17 75)"
    : "oklch(0.62 0.22 25)";

  return (
    <div className="p-6 space-y-6">
      {/* Back button */}
      <Link href="/calls">
        <Button variant="ghost" size="sm" className="gap-1.5 -ml-1">
          <ArrowLeft size={14} /> Back to Calls
        </Button>
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold text-foreground" style={{ fontFamily: "Outfit, sans-serif" }}>
              {call.callerName}
            </h1>
            {call.isEmergency && (
              <span className="flex items-center gap-1 px-2 py-1 rounded-lg text-sm font-bold bg-destructive/15 text-destructive">
                <AlertTriangle size={14} aria-hidden /> Emergency
              </span>
            )}
            <span
              className="text-sm font-medium px-2.5 py-1 rounded-full"
              style={{ backgroundColor: "oklch(0.55 0.18 210 / 0.12)", color: "oklch(0.40 0.18 210)" }}
            >
              CareIN · Rover (AI)
            </span>
          </div>
          <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground flex-wrap">
            <span className="font-mono">{call.callerNumber}</span>
            <span>·</span>
            <span>{formatTimeAgo(call.startedAt)}</span>
            <span>·</span>
            <span className="font-mono">{formatDuration(call.durationSeconds)}</span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Left — Transcript + Summary */}
        <div className="xl:col-span-2 space-y-6">
          {/* AI Summary */}
          {call.summary && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base font-semibold flex items-center gap-2">
                  <Bot size={14} className="text-primary" /> AI Summary
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-foreground leading-relaxed">{call.summary}</p>
                {call.outcome && (
                  <div className="mt-3 p-2.5 rounded-lg bg-muted/40">
                    <div className="text-xs text-muted-foreground mb-0.5">Outcome</div>
                    <div className="flex items-center gap-1.5 text-sm font-medium">
                      <CheckCircle2 size={12} className="text-green-500" aria-hidden />
                      {call.outcome}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          <TranscriptCard call={call} />
        </div>

        {/* Right — Call metadata + Commlog */}
        <div className="space-y-6">
          {/* Call details */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold">Call Details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="space-y-2.5 text-sm">
                {[
                  { label: "Call ID", value: call.id, mono: true },
                  { label: "Date", value: new Date(call.startedAt).toLocaleString() },
                  { label: "Duration", value: formatDuration(call.durationSeconds), mono: true },
                  { label: "Routed to", value: call.routedTo },
                ].map(({ label, value, mono }) => (
                  <div key={label} className="flex items-start justify-between gap-2">
                    <dt className="text-muted-foreground text-xs shrink-0">{label}</dt>
                    <dd className={`text-xs font-medium text-right ${mono ? "font-mono" : ""}`}>{value}</dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>

          {/* Office + Tag */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold">Classification</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-2.5">
                <Building2 size={14} className="text-muted-foreground shrink-0" aria-hidden />
                <div>
                  <div className="text-xs text-muted-foreground">Office</div>
                  <div className="text-sm font-medium">{call.office}</div>
                </div>
              </div>
              <div className="flex items-center gap-2.5">
                <Tag size={14} className="text-muted-foreground shrink-0" aria-hidden />
                <div>
                  <div className="text-xs text-muted-foreground">Tag / Disposition</div>
                  <div className="text-sm font-medium">{TAG_LABELS[call.tag] ?? call.tag}</div>
                </div>
              </div>

              {/* Sentiment + Quality */}
              <div className="grid grid-cols-2 gap-3 pt-1">
                <div className="p-2.5 rounded-lg bg-muted/40">
                  <div className="text-xs text-muted-foreground mb-1">Sentiment</div>
                  <div className="flex items-center gap-1.5">
                    <div
                      className="w-2.5 h-2.5 rounded-full"
                      style={{ backgroundColor: sentimentColor(call.sentiment) }}
                      aria-hidden
                    />
                    <span className="text-sm capitalize">{call.sentiment}</span>
                  </div>
                </div>
                <div className="p-2.5 rounded-lg bg-muted/40">
                  <div className="text-xs text-muted-foreground mb-1">Quality</div>
                  <div className="text-sm font-semibold" style={{ color: qualityColor }}>
                    {call.qualityScore}/100
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Commlog status */}
          <CommlogCard
            call={call}
            onRetry={retrying ? () => void 0 : handleRetry}
          />
        </div>
      </div>
    </div>
  );
}

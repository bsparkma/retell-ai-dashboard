/**
 * LiveMonitor — Real-time call monitoring
 * Shows active calls with live transcripts, sentiment, waveforms, and emergency alerts
 */
import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  PhoneOff, AlertTriangle, Bot, Users, Mic, MicOff,
  PhoneForwarded, Volume2, Clock, Activity, UserPlus
} from "lucide-react";
import { formatDuration } from "@/lib/utils";
import { useLiveCalls } from "@/contexts/SocketContext";
import type { LiveCall } from "@/contexts/SocketContext";
import NewPatientIntake, { type NewPatientPrefill } from "@/components/NewPatientIntake";
import { toast } from "sonner";

const WAVEFORM_BG = "https://d2xsxph8kpxj0f.cloudfront.net/310419663031054856/K6tiRwvhaJ5eVuqkxBJoTR/carein-live-monitor-bg-QqTk48PEyGVWGj96PjFLZR.webp";

function SentimentBadge({ sentiment }: { sentiment: string }) {
  const map: Record<string, { label: string; style: React.CSSProperties }> = {
    positive: { label: "Positive", style: { backgroundColor: "oklch(0.65 0.18 155 / 0.15)", color: "oklch(0.45 0.18 155)" } },
    neutral: { label: "Neutral", style: { backgroundColor: "oklch(0.50 0.01 240 / 0.12)", color: "oklch(0.45 0.01 240)" } },
    negative: { label: "Negative", style: { backgroundColor: "oklch(0.62 0.22 25 / 0.15)", color: "oklch(0.50 0.22 25)" } },
  };
  const s = map[sentiment] || map.neutral;
  return (
    <span className="text-xs font-medium px-2 py-0.5 rounded-full" style={s.style}>
      {s.label}
    </span>
  );
}

function LiveWaveform({ active }: { active: boolean }) {
  const bars = [3, 7, 12, 8, 15, 6, 11, 9, 14, 5, 10, 7, 13, 4, 8];
  return (
    <div className="flex items-center gap-0.5 h-8">
      {bars.map((h, i) => (
        <div
          key={i}
          className="w-1 rounded-full"
          style={{
            height: active ? `${h}px` : "3px",
            backgroundColor: "oklch(0.60 0.16 210)",
            animation: active ? `waveform ${0.8 + i * 0.05}s ease-in-out infinite` : "none",
            animationDelay: `${i * 0.08}s`,
            transition: "height 0.3s ease",
          }}
        />
      ))}
    </div>
  );
}

function TranscriptPanel({ call }: { call: LiveCall }) {
  return (
    <div className="space-y-2 max-h-48 overflow-y-auto">
      {call.transcript?.map((line, i) => (
        <div key={i} className={`flex gap-2 ${line.role === "agent" ? "" : "flex-row-reverse"}`}>
          <div
            className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 ${
              line.role === "agent" ? "bg-primary/20" : "bg-muted"
            }`}
          >
            {line.role === "agent" ? (
              <Bot size={10} className="text-primary" />
            ) : (
              <Users size={10} className="text-muted-foreground" />
            )}
          </div>
          <div
            className={`text-xs px-3 py-2 rounded-lg max-w-[85%] ${
              line.role === "agent"
                ? "bg-primary/10 text-foreground rounded-tl-none"
                : "bg-muted text-foreground rounded-tr-none"
            }`}
          >
            {line.text}
          </div>
        </div>
      ))}
      {(!call.transcript || call.transcript.length === 0) && (
        <p className="text-xs text-muted-foreground italic text-center py-4">Transcript loading...</p>
      )}
    </div>
  );
}

export default function LiveMonitor() {
  const calls = useLiveCalls();
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [intakePrefill, setIntakePrefill] = useState<NewPatientPrefill | undefined>();

  useEffect(() => {
    if (calls.length > 0 && (!selectedCallId || !calls.some((c) => c.id === selectedCallId))) {
      setSelectedCallId(calls[0].id);
    } else if (calls.length === 0) setSelectedCallId(null);
  }, [calls, selectedCallId]);

  const openIntake = (call?: LiveCall) => {
    if (call) {
      setIntakePrefill({
        patientName: call.patientName !== "Unknown" ? call.patientName : undefined,
        fromNumber: call.fromNumber,
        callId: call.id,
        source: call.source === "retell" ? "ai_call" : "staff_call",
        agentName: call.agentName,
        intent: call.intent,
      });
    } else {
      setIntakePrefill(undefined);
    }
    setIntakeOpen(true);
  };
  const [durations, setDurations] = useState<Record<string, number>>({});

  useEffect(() => {
    const timer = setInterval(() => {
      setDurations(prev => {
        const next = { ...prev };
        calls.forEach(c => { next[c.id] = (next[c.id] || 0) + 1; });
        return next;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [calls]);

  const selectedCall = calls.find(c => c.id === selectedCallId);
  const emergencies = calls.filter(c => c.isEmergency);

  return (
    <div className="flex flex-col h-full">
      {/* Header banner */}
      <div
        className="relative px-6 py-5 overflow-hidden"
        style={{ background: "oklch(0.16 0.055 245)" }}
      >
        <div
          className="absolute inset-0 opacity-20"
          style={{ backgroundImage: `url(${WAVEFORM_BG})`, backgroundSize: "cover", backgroundPosition: "center" }}
        />
        <div className="relative flex items-center justify-between">
          <div>
            <div className="flex items-center gap-3">
              <span className="live-dot" />
              <h1 className="text-xl font-bold text-white" style={{ fontFamily: "Outfit, sans-serif" }}>
                Live Monitor
              </h1>
              <Badge className="text-xs" style={{ backgroundColor: "oklch(0.65 0.18 155 / 0.3)", color: "oklch(0.80 0.18 155)", border: "none" }}>
                {calls.length} Active
              </Badge>
            </div>
            <p className="text-sm mt-1" style={{ color: "oklch(0.65 0.06 240)" }}>
              Real-time call monitoring · Socket.IO connected
            </p>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-center">
              <div className="text-2xl font-bold text-white" style={{ fontFamily: "Outfit, sans-serif" }}>{calls.length}</div>
              <div className="text-xs" style={{ color: "oklch(0.65 0.06 240)" }}>Active</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold" style={{ color: "oklch(0.62 0.22 25)", fontFamily: "Outfit, sans-serif" }}>{emergencies.length}</div>
              <div className="text-xs" style={{ color: "oklch(0.65 0.06 240)" }}>Emergency</div>
            </div>
            <Button
              size="sm"
              onClick={() => openIntake()}
              className="gap-1.5"
              style={{ backgroundColor: "oklch(0.55 0.18 210)", color: "white" }}
            >
              <UserPlus size={14} />
              New Patient
            </Button>
          </div>
        </div>
      </div>

      {/* Emergency alert */}
      {emergencies.length > 0 && (
        <div className="mx-6 mt-4 flex items-center gap-3 p-3 rounded-lg border border-destructive/40 bg-destructive/8">
          <AlertTriangle size={16} className="text-destructive flex-shrink-0" />
          <div className="flex-1">
            <span className="text-sm font-semibold text-destructive">Emergency Call Active — </span>
            <span className="text-sm text-foreground">{emergencies[0].patientName} · {emergencies[0].fromNumber}</span>
          </div>
          <Button size="sm" variant="destructive" onClick={() => toast.error("Escalating to on-call staff...")}>
            Escalate
          </Button>
        </div>
      )}

      <div className="flex-1 overflow-hidden p-6 pt-4">
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 h-full">
          {/* Call list */}
          <div className="lg:col-span-2 space-y-3 overflow-y-auto">
            {calls.map((call) => (
              <div
                key={call.id}
                onClick={() => setSelectedCallId(call.id)}
                className={`p-4 rounded-xl border cursor-pointer transition-all duration-200 ${
                  selectedCallId === call.id
                    ? "border-primary/50 bg-primary/5 call-active-ring"
                    : call.isEmergency
                    ? "emergency-flash border-destructive/30"
                    : "border-border bg-card hover:border-primary/30 hover:bg-muted/30"
                }`}
              >
                <div className="flex items-start gap-3">
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${
                    call.source === "retell" ? "bg-primary/15" : "bg-amber-500/15"
                  }`}>
                    {call.source === "retell" ? (
                      <Bot size={16} className="text-primary" />
                    ) : (
                      <Users size={16} className="text-amber-600" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-sm text-foreground">{call.patientName}</span>
                      {call.isEmergency && (
                        <span className="text-xs font-bold text-destructive">⚠ EMERGENCY</span>
                      )}
                    </div>
                    <div className="text-xs font-mono text-muted-foreground mt-0.5">{call.fromNumber}</div>
                    <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                      <span className={`text-xs px-1.5 py-0.5 rounded ${
                        call.source === "retell" ? "bg-primary/10 text-primary" : "bg-amber-500/10 text-amber-700"
                      }`}>
                        {call.source === "retell" ? "AI · Rover" : "Staff"}
                      </span>
                      {call.sentiment && <SentimentBadge sentiment={call.sentiment} />}
                    </div>
                    {call.intent && (
                      <div className="text-xs text-muted-foreground mt-1">{call.intent}</div>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-1 flex-shrink-0">
                    <LiveWaveform active={true} />
                    <span className="text-xs font-mono text-muted-foreground">
                      {formatDuration(durations[call.id] || call.duration)}
                    </span>
                  </div>
                </div>
              </div>
            ))}

            {calls.length === 0 && (
              <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                <PhoneOff size={40} className="mb-3 opacity-30" />
                <p className="text-sm font-medium">No active calls</p>
                <p className="text-xs mt-1">Waiting for incoming calls...</p>
              </div>
            )}
          </div>

          {/* Call detail panel */}
          <div className="lg:col-span-3">
            {selectedCall ? (
              <Card className="h-full flex flex-col">
                <CardHeader className="pb-3 border-b">
                  <div className="flex items-start justify-between">
                    <div>
                      <CardTitle className="text-lg font-semibold flex items-center gap-2">
                        {selectedCall.patientName}
                        {selectedCall.isEmergency && (
                          <AlertTriangle size={16} className="text-destructive" />
                        )}
                      </CardTitle>
                      <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground">
                        <span className="font-mono">{selectedCall.fromNumber}</span>
                        <span>·</span>
                        <span>{selectedCall.source === "retell" ? `AI · ${selectedCall.agentName}` : "Staff Call"}</span>
                        <span>·</span>
                        <span className="font-mono">{formatDuration(durations[selectedCall.id] || selectedCall.duration)}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {selectedCall.sentiment && <SentimentBadge sentiment={selectedCall.sentiment} />}
                    </div>
                  </div>

                  {/* Call actions */}
                  <div className="flex items-center gap-2 mt-3 flex-wrap">
                    <Button size="sm" variant="outline" className="gap-1.5 text-xs" onClick={() => toast.info("Listening in...")}>
                      <Volume2 size={12} /> Listen In
                    </Button>
                    <Button size="sm" variant="outline" className="gap-1.5 text-xs" onClick={() => toast.info("Transfer initiated...")}>
                      <PhoneForwarded size={12} /> Transfer
                    </Button>
                    <Button size="sm" variant="outline" className="gap-1.5 text-xs" onClick={() => toast.info("Adding note...")}>
                      Add Note
                    </Button>
                    <Button size="sm" variant="destructive" className="gap-1.5 text-xs ml-auto" onClick={() => toast.error("Ending call...")}>
                      <PhoneOff size={12} /> End Call
                    </Button>
                  </div>
                </CardHeader>

                <CardContent className="flex-1 overflow-y-auto pt-4 space-y-4">
                  {/* Call info */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="p-3 rounded-lg bg-muted/40">
                      <div className="text-xs text-muted-foreground mb-1">Intent</div>
                      <div className="text-sm font-medium">{selectedCall.intent || "Analyzing..."}</div>
                    </div>
                    <div className="p-3 rounded-lg bg-muted/40">
                      <div className="text-xs text-muted-foreground mb-1">Duration</div>
                      <div className="text-sm font-mono font-medium">{formatDuration(durations[selectedCall.id] || selectedCall.duration)}</div>
                    </div>
                  </div>

                  {/* Live transcript */}
                  <div>
                    <div className="flex items-center gap-2 mb-3">
                      <Activity size={14} className="text-primary" />
                      <span className="text-sm font-semibold">Live Transcript</span>
                      <span className="live-dot" style={{ width: 6, height: 6 }} />
                    </div>
                    <TranscriptPanel call={selectedCall} />
                  </div>

                  {/* Patient lookup */}
                  <div className="p-3 rounded-lg border border-dashed border-border">
                    <div className="text-xs text-muted-foreground mb-2">Patient Record</div>
                    <div className="flex items-center gap-2">
                      <div className="text-sm text-muted-foreground">
                        {selectedCall.patientName === "Unknown"
                          ? "No patient record found"
                          : `Searching Open Dental for "${selectedCall.patientName}"...`}
                      </div>
                      <div className="flex items-center gap-2 ml-auto">
                        <Button size="sm" variant="outline" className="text-xs" onClick={() => toast.info("Opening patient record...")}>
                          Link Patient
                        </Button>
                        {(selectedCall.patientName === "Unknown" || selectedCall.intent?.toLowerCase().includes("new patient")) && (
                          <Button
                            size="sm"
                            className="text-xs gap-1"
                            onClick={() => openIntake(selectedCall)}
                          >
                            <UserPlus size={11} /> New Patient
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ) : (
              <div className="flex items-center justify-center h-full text-muted-foreground">
                <div className="text-center">
                  <Mic size={40} className="mx-auto mb-3 opacity-30" />
                  <p className="text-sm">Select a call to view details</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      <NewPatientIntake open={intakeOpen} onClose={() => setIntakeOpen(false)} prefill={intakePrefill} />
    </div>
  );
}

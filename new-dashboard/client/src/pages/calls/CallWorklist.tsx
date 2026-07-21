/**
 * Call Worklist (Slice B) — turns the call log into a worklist you work.
 *
 * Default "Needs attention" view (triage != done AND not a spam/close-out),
 * office scoping (real agent→office config, remembered in localStorage), a
 * patient-identity cell that surfaces Slice-A od_sync_status + the Pick Patient
 * modal, per-row triage with outcome flavors + SSO attribution, and disposition
 * chips that double as filters.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
import {
  Search, Bot, Users, RefreshCw, AlertTriangle, CalendarCheck, UserPlus, Shield,
  CheckCircle2, PhoneForwarded, UserSearch, UserCheck, CircleSlash, ChevronDown, Loader2, PlugZap, Clock, Send,
} from "lucide-react";
import {
  api, type UnifiedCall, type TriageOutcome, type NotAPatientReason,
} from "@/lib/api";
import { formatDuration, formatTimeAgo } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";
import { useOffice, ALL_OFFICES } from "@/contexts/OfficeContext";
import { toast } from "sonner";
import { PickPatientModal } from "./PickPatientModal";
import { SendToChartDialog } from "./SendToChartDialog";

const OUTCOMES: { value: TriageOutcome; label: string }[] = [
  { value: "scheduled", label: "Scheduled" },
  { value: "called_back", label: "Called back" },
  { value: "left_voicemail", label: "Left voicemail" },
  { value: "no_answer", label: "No answer" },
  { value: "no_action_needed", label: "No action needed" },
];
const OUTCOME_LABEL: Record<TriageOutcome, string> = Object.fromEntries(
  OUTCOMES.map((o) => [o.value, o.label])
) as Record<TriageOutcome, string>;

const SORT_STORAGE_KEY = "carein.worklist.sort";
/** Surface the "oldest unhandled" hint once the backlog age crosses this. */
const OLDEST_UNHANDLED_HINT_DAYS = 2; // ~48h

interface Chip {
  key: string;
  label: string;
  icon: React.ElementType;
  color: string;
  bg: string;
  match: (c: UnifiedCall) => boolean;
}
const CHIPS: Chip[] = [
  { key: "emergency", label: "Emergency", icon: AlertTriangle, color: "oklch(0.55 0.20 25)", bg: "oklch(0.62 0.22 25 / 0.12)", match: (c) => c.isEmergency },
  { key: "booked", label: "Booked", icon: CalendarCheck, color: "oklch(0.48 0.16 155)", bg: "oklch(0.65 0.18 155 / 0.12)", match: (c) => c.appointmentBooked },
  { key: "new", label: "New patient", icon: UserPlus, color: "oklch(0.45 0.16 260)", bg: "oklch(0.55 0.18 260 / 0.12)", match: (c) => c.isNewPatient },
  { key: "insurance", label: "Insurance", icon: Shield, color: "oklch(0.48 0.13 210)", bg: "oklch(0.55 0.18 210 / 0.12)", match: (c) => c.insuranceMentioned },
];

/** Short first-name + clock attribution, e.g. "Sarah, 9:14a". */
function formatAttribution(name: string | null | undefined, iso: string | null | undefined): string {
  const first = (name ?? "").trim().split(/\s+/)[0] || "Someone";
  if (!iso) return first;
  const d = new Date(iso);
  let h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, "0");
  const ap = h < 12 ? "a" : "p";
  h = h % 12 || 12;
  return `${first}, ${h}:${m}${ap}`;
}

interface CallWorklistProps {
  /** Reports the current "needs attention" count so the parent can badge the tab. */
  onNeedsAttentionCount?: (n: number) => void;
}

export function CallWorklist({ onNeedsAttentionCount }: CallWorklistProps) {
  const auth = useAuth();
  // Office scope comes from the global app-shell selector (sidebar), not this page.
  const { office, selected: selectedOffice } = useOffice();
  const [calls, setCalls] = useState<UnifiedCall[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const [view, setView] = useState<"needs" | "all">("needs");
  const [search, setSearch] = useState("");
  const [activeChips, setActiveChips] = useState<Set<string>>(new Set());
  // Front-desk mental model: newest-first by default; toggle persists per browser.
  const [sortDir, setSortDir] = useState<"newest" | "oldest">(() => {
    try { return localStorage.getItem(SORT_STORAGE_KEY) === "oldest" ? "oldest" : "newest"; } catch { return "newest"; }
  });

  const [pickCall, setPickCall] = useState<UnifiedCall | null>(null);
  const [sendTarget, setSendTarget] = useState<{ call: UnifiedCall; patientId: number; patientName: string } | null>(null);

  const setSort = (dir: "newest" | "oldest") => {
    setSortDir(dir);
    try { localStorage.setItem(SORT_STORAGE_KEY, dir); } catch { /* ignore */ }
  };

  const load = useCallback(() => {
    setLoading(true);
    api.getUnifiedCalls({ limit: 1000, office_id: office === ALL_OFFICES ? undefined : office })
      .then(({ calls: list }) => setCalls(list))
      .catch(() => setCalls([]))
      .finally(() => setLoading(false));
  }, [office]);

  useEffect(() => { load(); }, [load]);

  const officeOdConnected = office === ALL_OFFICES ? true : (selectedOffice?.odConnected ?? true);

  const patchCall = useCallback((id: string, patch: Partial<UnifiedCall>) => {
    setCalls((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }, []);

  const applyTriage = async (
    call: UnifiedCall,
    status: "needs_action" | "done",
    outcome?: TriageOutcome,
    note?: string,
  ) => {
    const actor = auth.status === "authenticated"
      ? { name: auth.user.name, email: auth.user.email }
      : null;
    // Optimistic update.
    patchCall(call.id, {
      triageStatus: status,
      triageOutcome: outcome ?? null,
      triageBy: actor,
      triageAt: new Date().toISOString(),
      triageNote: note ?? null,
    });
    try {
      await api.triageCall(call.id, {
        triage_status: status,
        ...(outcome ? { triage_outcome: outcome } : {}),
        ...(note ? { triage_note: note } : {}),
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save triage", { duration: 8000 });
      load(); // reconcile with the server on failure
    }
  };

  const reopen = (call: UnifiedCall) => applyTriage(call, "needs_action");

  const onNotPatient = (call: UnifiedCall, reason: NotAPatientReason) => {
    patchCall(call.id, { notAPatient: true, notAPatientReason: reason });
  };

  const onSent = (call: UnifiedCall, patientId: number) => {
    const actor = auth.status === "authenticated" ? { name: auth.user.name, email: auth.user.email } : null;
    patchCall(call.id, { odSyncStatus: "synced", odPatientId: patientId, sentBy: actor, sentAt: new Date().toISOString() });
  };

  // A patient was chosen in the picker → hand off to the review/edit → send dialog.
  const chooseThenSend = (call: UnifiedCall, patientId: number, patientName: string) => {
    setPickCall(null);
    setSendTarget({ call, patientId, patientName });
  };

  // ---- filtering ----------------------------------------------------------
  const needsAttention = (c: UnifiedCall) => c.triageStatus !== "done" && !c.notAPatient;
  const needsAttentionCount = useMemo(() => calls.filter(needsAttention).length, [calls]);

  useEffect(() => { onNeedsAttentionCount?.(needsAttentionCount); }, [needsAttentionCount, onNeedsAttentionCount]);

  // Age (in days) of the oldest un-triaged call — powers the "nothing slips" hint
  // so a newest-first default can't bury an aging backlog item.
  const oldestUnhandledDays = useMemo(() => {
    const pending = calls.filter(needsAttention);
    if (pending.length === 0) return 0;
    const oldest = Math.min(...pending.map((c) => new Date(c.date).getTime()));
    return Math.floor((Date.now() - oldest) / 86_400_000);
  }, [calls]);

  const visibleCalls = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = view === "needs" ? calls.filter(needsAttention) : calls;
    if (q) {
      list = list.filter((c) =>
        c.patientName.toLowerCase().includes(q) ||
        c.fromNumber.includes(search) ||
        c.summary.toLowerCase().includes(q)
      );
    }
    if (activeChips.size > 0) {
      const keys = Array.from(activeChips);
      list = list.filter((c) => keys.every((k) => CHIPS.find((chip) => chip.key === k)?.match(c)));
    }
    return [...list].sort((a, b) =>
      sortDir === "oldest"
        ? new Date(a.date).getTime() - new Date(b.date).getTime()
        : new Date(b.date).getTime() - new Date(a.date).getTime()
    );
  }, [calls, view, search, activeChips, sortDir]);

  const toggleChip = (key: string) =>
    setActiveChips((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await api.syncRetell({ limit: 1000 });
      toast.success(res.message ?? "Sync complete");
      load();
    } catch {
      toast.error("Sync failed", { duration: 8000 });
    } finally {
      setSyncing(false);
    }
  };

  const GRID = "2.2fr 1.7fr 1.3fr 1.9fr";

  return (
    <>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        {/* View toggle */}
        <div className="flex items-center gap-1 bg-muted rounded-md p-1">
          {([
            { key: "needs" as const, label: "Needs attention", count: needsAttentionCount },
            { key: "all" as const, label: "All calls", count: null as number | null },
          ]).map((v) => (
            <button
              key={v.key}
              onClick={() => setView(v.key)}
              aria-pressed={view === v.key}
              className="px-3 py-1.5 rounded text-xs font-medium transition-all flex items-center gap-1.5"
              style={{
                backgroundColor: view === v.key ? "white" : "transparent",
                color: view === v.key ? "oklch(0.18 0.02 240)" : "oklch(0.52 0.015 240)",
                boxShadow: view === v.key ? "0 1px 3px oklch(0 0 0 / 0.1)" : "none",
              }}
            >
              {v.label}
              {v.count != null && v.count > 0 && (
                <Badge variant="destructive" className="text-[10px] px-1.5 py-0">{v.count}</Badge>
              )}
            </button>
          ))}
        </div>

        {/* Oldest-unhandled hint — so newest-first can't bury an aging backlog item */}
        {oldestUnhandledDays >= OLDEST_UNHANDLED_HINT_DAYS && (
          <button
            onClick={() => { setView("needs"); setSort("oldest"); }}
            title="Show the oldest un-triaged calls first"
            className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full"
            style={{ color: "oklch(0.50 0.16 45)", backgroundColor: "oklch(0.75 0.16 60 / 0.15)" }}
          >
            <Clock size={12} /> Oldest unhandled: {oldestUnhandledDays}d
          </button>
        )}

        <div className="relative flex-1 min-w-48">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search name, number, summary…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-9 text-sm"
          />
        </div>

        {/* Sort toggle */}
        <div className="flex items-center gap-1 bg-muted rounded-md p-1">
          {([
            { key: "newest" as const, label: "Newest" },
            { key: "oldest" as const, label: "Oldest" },
          ]).map((s) => (
            <button
              key={s.key}
              onClick={() => setSort(s.key)}
              aria-pressed={sortDir === s.key}
              className="px-2.5 py-1.5 rounded text-xs font-medium transition-all"
              style={{
                backgroundColor: sortDir === s.key ? "white" : "transparent",
                color: sortDir === s.key ? "oklch(0.18 0.02 240)" : "oklch(0.52 0.015 240)",
                boxShadow: sortDir === s.key ? "0 1px 3px oklch(0 0 0 / 0.1)" : "none",
              }}
            >
              {s.label}
            </button>
          ))}
        </div>

        <Button variant="outline" size="sm" onClick={handleSync} disabled={syncing}>
          <RefreshCw size={14} className={`mr-1.5 ${syncing ? "animate-spin" : ""}`} /> {syncing ? "Syncing…" : "Sync"}
        </Button>
      </div>

      {/* Disposition chips (also filters) */}
      <div className="flex flex-wrap items-center gap-2">
        {CHIPS.map((chip) => {
          const active = activeChips.has(chip.key);
          const Icon = chip.icon;
          return (
            <button
              key={chip.key}
              onClick={() => toggleChip(chip.key)}
              aria-pressed={active}
              className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full border transition-all"
              style={{
                color: chip.color,
                backgroundColor: active ? chip.bg : "transparent",
                borderColor: active ? chip.color : "oklch(0.85 0.01 240)",
              }}
            >
              <Icon size={12} /> {chip.label}
            </button>
          );
        })}
        {activeChips.size > 0 && (
          <button onClick={() => setActiveChips(new Set())} className="text-xs text-muted-foreground underline">
            Clear
          </button>
        )}
      </div>

      {/* List */}
      <Card>
        <CardHeader className="pb-3 border-b">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base font-semibold">
              {visibleCalls.length} {view === "needs" ? "to work" : "calls"}
            </CardTitle>
            <span className="text-xs text-muted-foreground">
              {sortDir === "oldest" ? "Oldest first" : "Newest first"}
            </span>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div
            className="grid gap-3 px-4 py-2.5 border-b bg-muted/30 text-xs font-semibold text-muted-foreground uppercase tracking-wide"
            style={{ gridTemplateColumns: GRID }}
          >
            <div>Caller</div>
            <div>Patient</div>
            <div>Signals</div>
            <div>Triage</div>
          </div>

          {loading ? (
            <div className="text-center py-12 text-muted-foreground text-sm">Loading calls…</div>
          ) : !officeOdConnected && visibleCalls.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <PlugZap size={30} className="mx-auto mb-2 opacity-40" />
              <p className="text-sm">OD not connected for this office yet.</p>
            </div>
          ) : visibleCalls.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <CheckCircle2 size={30} className="mx-auto mb-2 opacity-30" />
              <p className="text-sm">
                {view === "needs" ? "Nothing needs attention. Nice." : "No calls match the current filters."}
              </p>
            </div>
          ) : (
            visibleCalls.map((call) => (
              <div
                key={call.id}
                className="grid gap-3 px-4 py-3 border-b border-border/50 hover:bg-muted/20 transition-colors items-center"
                style={{ gridTemplateColumns: GRID }}
              >
                {/* Caller */}
                <Link href={`/calls/${call.id}`} className="min-w-0 flex items-center gap-2.5 cursor-pointer">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${call.source === "retell" ? "bg-primary/10" : "bg-amber-500/10"}`}>
                    {call.source === "retell" ? <Bot size={13} className="text-primary" /> : <Users size={13} className="text-amber-600" />}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground truncate">{call.patientName}</div>
                    <div className="text-xs font-mono text-muted-foreground">{call.fromNumber}</div>
                    <div className="text-[11px] text-muted-foreground/70">
                      {formatDuration(call.duration)} · {formatTimeAgo(call.date)}
                    </div>
                  </div>
                </Link>

                {/* Patient identity */}
                <div className="min-w-0">
                  <PatientIdentityCell
                    call={call}
                    officeOdConnected={officeOdConnected}
                    onPick={() => setPickCall(call)}
                    onSend={() => setSendTarget({
                      call,
                      patientId: Number(call.odPatientId),
                      patientName: call.odPatientName || `PatNum ${call.odPatientId}`,
                    })}
                  />
                </div>

                {/* Signals (disposition chips) */}
                <div className="flex flex-wrap gap-1">
                  {CHIPS.filter((chip) => chip.match(call)).map((chip) => {
                    const Icon = chip.icon;
                    return (
                      <span
                        key={chip.key}
                        className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded-full"
                        style={{ color: chip.color, backgroundColor: chip.bg }}
                        title={chip.label}
                      >
                        <Icon size={10} /> {chip.label}
                      </span>
                    );
                  })}
                </div>

                {/* Triage */}
                <div>
                  <TriageCell call={call} onFollowUp={() => applyTriage(call, "needs_action")} onDone={applyTriage} onReopen={() => reopen(call)} />
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {pickCall && (
        <PickPatientModal
          open={pickCall !== null}
          onOpenChange={(o) => { if (!o) setPickCall(null); }}
          call={pickCall}
          onChoosePatient={(patientId, patientName) => chooseThenSend(pickCall, patientId, patientName)}
          onNotPatient={(reason) => onNotPatient(pickCall, reason)}
        />
      )}

      {sendTarget && (
        <SendToChartDialog
          open={sendTarget !== null}
          onOpenChange={(o) => { if (!o) setSendTarget(null); }}
          call={sendTarget.call}
          patientId={sendTarget.patientId}
          patientName={sendTarget.patientName}
          onSent={() => onSent(sendTarget.call, sendTarget.patientId)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function PatientIdentityCell({
  call, officeOdConnected, onPick, onSend,
}: { call: UnifiedCall; officeOdConnected: boolean; onPick: () => void; onSend: () => void }) {
  if (!officeOdConnected) {
    return <span className="text-xs text-muted-foreground/70 italic">OD not connected for this office yet</span>;
  }
  if (call.notAPatient) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
        <CircleSlash size={11} /> Not a patient{call.notAPatientReason ? ` · ${call.notAPatientReason.replace("_", " ")}` : ""}
      </span>
    );
  }
  // Sent = the chart note was written (od_sync_status 'synced').
  if (call.odSyncStatus === "synced") {
    return (
      <Link href={`/calls/${call.id}`} className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 hover:underline">
        <CheckCircle2 size={12} className="text-emerald-600" />
        Sent · {call.odPatientName || (call.odPatientId ? `PatNum ${call.odPatientId}` : "chart")}
      </Link>
    );
  }
  // Matched but NOT sent (review-then-send): a patient is linked (od_patient_id) but
  // no chart note has been written. Surface the match + a Send button (opens the
  // confirm-preview dialog). Nothing is written until the human confirms.
  if (call.odPatientId) {
    return (
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="inline-flex items-center gap-1 text-xs font-medium text-sky-700 truncate" title="Auto-matched — review before sending">
          <UserCheck size={12} className="text-sky-600 flex-shrink-0" />
          Matched: {call.odPatientName || `PatNum ${call.odPatientId}`}
        </span>
        <Button size="sm" className="h-7 gap-1 text-[11px] px-2 flex-shrink-0" onClick={onSend}>
          <Send size={11} /> Send to chart
        </Button>
      </div>
    );
  }
  // No linked patient → actionable. Stored candidates (Slice-A needs_review) label as
  // "Needs match (N)"; everything else (incl. pull-synced calls) is "Unmatched". The
  // button opens the modal, which offers BOTH Pick Patient and the not-a-patient close-out.
  const n = call.odMatchCandidates?.length ?? 0;
  return (
    <button
      onClick={onPick}
      title="Match to a patient or mark not a patient"
      className="inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-md border transition-colors hover:bg-amber-500/10"
      style={{ color: "oklch(0.52 0.14 75)", borderColor: "oklch(0.75 0.14 75 / 0.5)" }}
    >
      <UserSearch size={12} />
      {n > 0 ? `Needs match (${n})` : "Unmatched"}
    </button>
  );
}

function TriageCell({
  call, onFollowUp, onDone, onReopen,
}: {
  call: UnifiedCall;
  onFollowUp: () => void;
  onDone: (call: UnifiedCall, status: "done", outcome: TriageOutcome, note?: string) => void;
  onReopen: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");

  if (call.triageStatus === "done") {
    return (
      <div className="flex items-center gap-2 min-w-0">
        <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 truncate">
          <CheckCircle2 size={12} className="text-emerald-600 flex-shrink-0" />
          {call.triageOutcome ? OUTCOME_LABEL[call.triageOutcome] : "Done"}
          {call.triageBy && <span className="text-muted-foreground font-normal">— {formatAttribution(call.triageBy.name, call.triageAt)}</span>}
        </span>
        <button onClick={onReopen} className="text-[11px] text-muted-foreground underline flex-shrink-0">Reopen</button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <Button
        size="sm"
        variant={call.triageStatus === "needs_action" ? "secondary" : "outline"}
        className="h-8 gap-1.5 text-xs"
        onClick={onFollowUp}
      >
        <PhoneForwarded size={12} /> {call.triageStatus === "needs_action" ? "Following up" : "Follow up"}
      </Button>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button size="sm" className="h-8 gap-1 text-xs">
            <CheckCircle2 size={12} /> Done <ChevronDown size={12} />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-56 p-2">
          <div className="text-xs font-semibold text-muted-foreground px-1 pb-1.5">Outcome</div>
          <div className="space-y-0.5">
            {OUTCOMES.map((o) => (
              <button
                key={o.value}
                onClick={() => { onDone(call, "done", o.value, note.trim() || undefined); setOpen(false); setNote(""); }}
                className="w-full text-left text-sm px-2 py-1.5 rounded hover:bg-muted transition-colors"
              >
                {o.label}
              </button>
            ))}
          </div>
          <Input
            placeholder="Optional note…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={280}
            className="mt-2 h-8 text-xs"
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

/**
 * Call Worklist (Slice B) — turns the call log into a worklist you work.
 *
 * Default "Needs attention" view (triage != done AND not a spam/close-out AND not
 * dispositioned), office scoping (real agent→office config, remembered in
 * localStorage), a patient-identity cell that surfaces Slice-A od_sync_status +
 * the Pick Patient modal, per-row triage with outcome flavors + SSO attribution,
 * signal chips that double as filters, and per-call dispositions + notes.
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
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Search, Bot, Users, RefreshCw, AlertTriangle, CalendarCheck, UserPlus, Shield,
  CheckCircle2, PhoneForwarded, UserSearch, UserCheck, CircleSlash, Loader2, PlugZap, Clock, Send,
  FileText, VolumeX, RotateCcw, MessageSquare,
} from "lucide-react";
import { ActionTooltip, IconAction, ACTION_HEIGHT, ICON_ACTION_CLASS } from "@/components/calls/IconAction";
import { DispositionBadge, DispositionPicker } from "@/components/calls/DispositionControl";
import { CallNotesPanel } from "@/components/calls/CallNotesPanel";
import {
  DISPOSITIONS, matchesDispositionFilter, type DispositionFilter,
} from "@/lib/dispositions";
import {
  api, type UnifiedCall, type TriageOutcome, type NotAPatientReason, type MangoWorklistMode,
  type TranscribeResult, type SyncStatus, type CallDisposition, normalizeCallNotes,
} from "@/lib/api";
import { syncToast, syncCaption, SYNC_COOLDOWN_SECONDS } from "@/lib/sync";
import { useTranscribeCall } from "@/hooks/useTranscribeCall";
import { needsRebillConfirm, ANSWERED_BY_AI_BADGE } from "@/lib/transcribe";
import { TranscribeRebillDialog } from "@/components/calls/TranscribeRebillDialog";
import { callNeedsAttention, isAiDuplicateLeg, rowPrimaryAction } from "@/lib/worklist";
import { can } from "@/lib/permissions";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { usePolling } from "@/hooks/usePolling";
import { formatDuration, formatTimeAgo } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";
import { useOffice, ALL_OFFICES } from "@/contexts/OfficeContext";
import { toast } from "sonner";
import { PickPatientModal } from "./PickPatientModal";
import { SendToChartDialog } from "./SendToChartDialog";
import { SendToTcButton, type SendToTcResult } from "./SendToTcButton";

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
const SIGNAL_CHIPS: Chip[] = [
  { key: "emergency", label: "Emergency", icon: AlertTriangle, color: "oklch(0.55 0.20 25)", bg: "oklch(0.62 0.22 25 / 0.12)", match: (c) => c.isEmergency },
  { key: "booked", label: "Booked", icon: CalendarCheck, color: "oklch(0.48 0.16 155)", bg: "oklch(0.65 0.18 155 / 0.12)", match: (c) => c.appointmentBooked },
  { key: "new", label: "New patient", icon: UserPlus, color: "oklch(0.45 0.16 260)", bg: "oklch(0.55 0.18 260 / 0.12)", match: (c) => c.isNewPatient },
  { key: "insurance", label: "Insurance", icon: Shield, color: "oklch(0.45 0.11 186)", bg: "oklch(0.52 0.12 186 / 0.12)", match: (c) => c.insuranceMentioned },
  // M7. The one chip that surfaces rows the default view hides, which is exactly why it
  // exists: "hidden" must never mean "unreachable". Toggling it also switches to "All
  // calls" (see toggleChip) — in the attention view it would always return nothing.
  { key: "ai_duplicate", label: ANSWERED_BY_AI_BADGE, icon: Bot, color: "oklch(0.45 0.16 260)", bg: "oklch(0.55 0.18 260 / 0.12)", match: isAiDuplicateLeg },
];
/** Chips that only make sense outside the "Needs attention" view. */
const ALL_CALLS_ONLY_CHIPS = new Set(["ai_duplicate"]);

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
  const { office, offices, selected: selectedOffice } = useOffice();
  const [calls, setCalls] = useState<UnifiedCall[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  /** Freshness caption data (null until the first /sync-status read lands). */
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  /** Seconds left on the manual-sync cooldown; 0 = the button is live. */
  const [cooldown, setCooldown] = useState(0);

  const [view, setView] = useState<"needs" | "all">("needs");
  const [search, setSearch] = useState("");
  const [activeChips, setActiveChips] = useState<Set<string>>(new Set());
  // Source filter (All / CareIN AI / Staff·Mango). Mango calls arrived with the slice.
  const [sourceFilter, setSourceFilter] = useState<"all" | "retell" | "mango">("all");
  // Disposition filter: any / none / dispositioned / one of the seven.
  const [dispositionFilter, setDispositionFilter] = useState<DispositionFilter>("any");
  // Backend-owned worklist behaviour for Mango calls (PRD D1); default 'all'.
  const [mangoWorklistMode, setMangoWorklistMode] = useState<MangoWorklistMode>("all");
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
      .then(({ calls: list, mangoWorklistMode: mode }) => {
        setCalls(list);
        setMangoWorklistMode(mode);
      })
      .catch(() => setCalls([]))
      .finally(() => setLoading(false));
  }, [office]);

  useEffect(() => { load(); }, [load]);

  // Freshness caption. Polled on a slow interval so "next auto 1:15 PM" stays true after
  // an automatic pull lands — nobody presses Sync now just to find out the list is fresh.
  // A failed read leaves the previous caption rather than blanking it; the data is a
  // nicety, and an empty toolbar mid-shift reads like something broke.
  //
  // usePolling, not setInterval: this ran in every background tab and was one of the
  // pollers that exhausted the API rate limit on 2026-08-12. A caption nobody is looking
  // at does not need refreshing.
  const readSyncStatus = useCallback(() => {
    api.getSyncStatus()
      .then((s) => setSyncStatus(s))
      .catch(() => { /* keep the last known caption */ });
  }, []);

  usePolling(readSyncStatus, 60_000);

  // Cooldown countdown — one tick per second while the server would refuse another sync.
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  /**
   * Open Dental connectivity PER CALL, not per selected tab.
   *
   * The old rule read the SELECTED office, so the "All calls" view offered the full
   * action set on every row — including Riley rows and unmapped-line rows that have
   * nowhere to write. Each call now answers for itself, from the office the SERVER
   * resolved for it. An office absent from the roster (notably the 'unknown' bucket,
   * which is deliberately not offered as a tab) is not connected.
   */
  const odConnectedForCall = useCallback(
    (call: UnifiedCall) =>
      Boolean(call.officeId) &&
      (offices.find((o) => o.officeId === call.officeId)?.odConnected ?? false),
    [offices],
  );

  /** Does the CURRENT view have any OD-connected office at all (for the empty state)? */
  const officeOdConnected =
    office === ALL_OFFICES ? offices.some((o) => o.odConnected) : (selectedOffice?.odConnected ?? false);

  const patchCall = useCallback((id: string, patch: Partial<UnifiedCall>) => {
    setCalls((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }, []);

  /** The signed-in user as the store records an actor, or null. */
  const actor = auth.status === "authenticated"
    ? { name: auth.user.name, email: auth.user.email }
    : null;
  // May this person delete somebody ELSE's note? Same action the server checks
  // (admin.all) — UI hiding only; the 403 is the boundary. `can()` is the shared
  // helper, so a session that predates the permissions field reads as "not admin"
  // (hide) rather than throwing.
  const actorIsAdmin = auth.status === "authenticated"
    && (auth.user.isSuperAdmin || can(auth.user.permissions, "admin.all"));

  const applyTriage = async (
    call: UnifiedCall,
    status: "needs_action" | "done",
    outcome?: TriageOutcome,
    note?: string,
  ) => {
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

  /**
   * Set or clear a call's disposition — the third way to finish a call, and the
   * only one that writes nowhere.
   *
   * Optimistic like triage, and reconciled the same way: a failure toasts and
   * reloads, so a call cannot sit there looking handled because the request died.
   * Rethrows so the picker stops spinning and keeps itself open.
   */
  const applyDisposition = async (call: UnifiedCall, disposition: CallDisposition | null) => {
    const previous = {
      disposition: call.disposition,
      dispositionBy: call.dispositionBy,
      dispositionAt: call.dispositionAt,
    };
    patchCall(call.id, {
      disposition,
      dispositionBy: disposition ? actor : null,
      dispositionAt: disposition ? new Date().toISOString() : null,
    });
    try {
      await api.setCallDisposition(call.id, disposition);
    } catch (err) {
      patchCall(call.id, previous);
      toast.error(err instanceof Error ? err.message : "Failed to save the disposition", { duration: 8000 });
      load();
      throw err;
    }
  };

  /**
   * Append a note. NOT optimistic: the server owns the note's id, author and
   * timestamp, so the row shows the note it actually stored rather than a local
   * guess that might differ from what a reload would show.
   */
  const addNote = async (call: UnifiedCall, text: string) => {
    try {
      const { call: updated } = await api.addCallNote(call.id, text);
      patchCall(call.id, { notes: normalizeCallNotes(updated.notes) });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add the note", { duration: 8000 });
      throw err;
    }
  };

  const deleteNote = async (call: UnifiedCall, noteId: string) => {
    try {
      const { call: updated } = await api.deleteCallNote(call.id, noteId);
      patchCall(call.id, { notes: normalizeCallNotes(updated.notes) });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete the note", { duration: 8000 });
      throw err;
    }
  };

  // (M4) On-demand transcription. Auto-transcription is off, so a Mango call arrives with
  // metadata only until somebody decides it's worth reading. NOTHING is patched optimistically
  // — the row only gains a transcript/summary once the server says it is persisted.
  const onTranscribed = useCallback((callId: string, result: TranscribeResult) => {
    if (result.status === "completed" || result.status === "exists") {
      patchCall(callId, {
        hasTranscript: true,
        transcript: result.transcript ?? undefined,
        summary: result.summary ?? "",
        transcribeLastOutcome: result.status,
      });
      return;
    }
    // An attempt that found no speech SPENT budget. Remember it on the row so the next
    // click has to be confirmed — without this the row looks idle again and re-bills on
    // a misclick. The server persists the same thing, so it survives a reload too.
    if (result.status === "no_speech") {
      patchCall(callId, { transcribeLastOutcome: "no_speech" });
    }
  }, [patchCall]);
  const transcribe = useTranscribeCall(onTranscribed);

  const onNotPatient = (call: UnifiedCall, reason: NotAPatientReason) => {
    patchCall(call.id, { notAPatient: true, notAPatientReason: reason });
  };

  // `updated` is the server's complete post-send record. Prefer it over patching the
  // fields we think changed: resolving a patient also sets od_patient_name, and the
  // "Send to TC" button is hidden/disabled without it — patching only id + status is
  // why that button used to need a page refresh before it became usable.
  const onSent = (call: UnifiedCall, patientId: number, updated: UnifiedCall | null) => {
    if (updated) {
      patchCall(call.id, updated);
      return;
    }
    const actor = auth.status === "authenticated" ? { name: auth.user.name, email: auth.user.email } : null;
    patchCall(call.id, { odSyncStatus: "synced", odPatientId: patientId, sentBy: actor, sentAt: new Date().toISOString() });
  };

  // (M6) TC took the call — flip the row to the passive "In TC" link. Driven by the
  // server's response; the store keeps tc_* through re-ingest so a refresh agrees.
  const onSentToTc = (call: UnifiedCall, result: SendToTcResult) => {
    patchCall(call.id, {
      tcCaseId: result.caseId,
      tcCaseUrl: result.caseUrl,
      tcSentAt: new Date().toISOString(),
    });
  };

  // The picker LINKED a patient — no chart note was written. The row moves to
  // 'matched', where "Send to chart" and "Send to TC" become separate choices.
  // It used to jump straight into the send dialog, which made a chart note the
  // price of identifying a caller.
  const onLinked = (call: UnifiedCall, updated: UnifiedCall) => {
    setPickCall(null);
    patchCall(call.id, updated);
  };

  // ---- filtering ----------------------------------------------------------
  // Base rule: not resolved and not a spam/close-out. PRD D1: in 'flagged' mode a Mango
  // staff call only demands attention if it's an emergency / requested an appointment /
  // needs a callback — otherwise it stays in "All calls" (still sendable) but drops out
  // of the attention count + default view. Retell calls are unaffected by the mode.
  const needsAttention = useCallback(
    (c: UnifiedCall) => callNeedsAttention(c, mangoWorklistMode),
    [mangoWorklistMode],
  );
  const needsAttentionCount = useMemo(() => calls.filter(needsAttention).length, [calls, needsAttention]);

  useEffect(() => { onNeedsAttentionCount?.(needsAttentionCount); }, [needsAttentionCount, onNeedsAttentionCount]);

  // Age (in days) of the oldest un-triaged call — powers the "nothing slips" hint
  // so a newest-first default can't bury an aging backlog item.
  const oldestUnhandledDays = useMemo(() => {
    const pending = calls.filter(needsAttention);
    if (pending.length === 0) return 0;
    const oldest = Math.min(...pending.map((c) => new Date(c.date).getTime()));
    return Math.floor((Date.now() - oldest) / 86_400_000);
  }, [calls, needsAttention]);

  const visibleCalls = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = view === "needs" ? calls.filter(needsAttention) : calls;
    if (sourceFilter !== "all") {
      list = list.filter((c) => c.source === sourceFilter);
    }
    if (dispositionFilter !== "any") {
      list = list.filter((c) => matchesDispositionFilter(c, dispositionFilter));
    }
    if (q) {
      list = list.filter((c) =>
        c.patientName.toLowerCase().includes(q) ||
        c.fromNumber.includes(search) ||
        c.summary.toLowerCase().includes(q)
      );
    }
    if (activeChips.size > 0) {
      const keys = Array.from(activeChips);
      list = list.filter((c) => keys.every((k) => SIGNAL_CHIPS.find((chip) => chip.key === k)?.match(c)));
    }
    return [...list].sort((a, b) =>
      sortDir === "oldest"
        ? new Date(a.date).getTime() - new Date(b.date).getTime()
        : new Date(b.date).getTime() - new Date(a.date).getTime()
    );
  }, [calls, view, search, activeChips, sortDir, sourceFilter, dispositionFilter, needsAttention]);

  const toggleChip = (key: string) => {
    // Turning on a chip that only matches rows the attention view hides has to take you
    // somewhere those rows exist, or the filter reads as broken (M7).
    if (ALL_CALLS_ONLY_CHIPS.has(key) && !activeChips.has(key)) setView("all");
    setActiveChips((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  // "Sync now" pulls BOTH sources. A refusal is not a failure: the cooldown parks the
  // button with a countdown, and a source that is off or already mid-run says so.
  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await api.syncNow();

      if (res.kind === "cooldown") {
        // Deliberately no error toast — the button already tells the story.
        setCooldown(res.retryAfter);
        setSyncStatus((prev) => (prev ? { ...prev, lastSyncedAt: res.lastSyncedAt } : prev));
        return;
      }

      const t = syncToast(res);
      if (t.kind === "error") toast.error(t.message, { duration: 8000 });
      else toast.success(t.message);

      setSyncStatus((prev) => ({
        lastSyncedAt: res.lastSyncedAt,
        nextAutoSync: res.nextAutoSync,
        // The run itself reveals whether Mango is live here, so the tooltip is right
        // immediately rather than after the next poll. A source error proves nothing
        // about the switch, so that case keeps what we already knew. The 'off' vs
        // 'disabled' nuance is reconciled by the poll and is identical to the UI.
        mangoMode:
          res.mango.status === "off" ? "off"
            : res.mango.status === "error" ? (prev?.mangoMode ?? "api")
              : "api",
      }));
      // The server refuses another run for a minute; show that rather than let the
      // next click bounce off a 429.
      setCooldown(SYNC_COOLDOWN_SECONDS);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sync failed", { duration: 8000 });
    } finally {
      setSyncing(false);
    }
  };

  const caption = useMemo(
    () => syncCaption(syncStatus?.lastSyncedAt ?? null, syncStatus?.nextAutoSync ?? null),
    [syncStatus],
  );

  // Column template. Patient gets a real MINIMUM rather than a share of whatever is left,
  // because the previous `1.7fr` share was routinely spent by the buttons that used to sit
  // beside the name.
  //
  // Actions is a FIXED width, not `max-content`. Every row is its own grid container, so a
  // content-sized last column makes each row solve for different column widths — the
  // Patient column then starts at a different x on every row, and a tidy table reads as a
  // broken one. A fixed track is wide enough for the worst case (one labeled button plus
  // four icons) and identical on every row; rows with fewer actions right-align inside it.
  //
  // Below ~1100px Signals folds into the Patient cell (as chips under the name) instead of
  // all four columns crushing each other. Inline gridTemplateColumns can't carry a media
  // query, so the layout has to know the width in JS.
  const wide = useMediaQuery("(min-width: 1100px)");
  const GRID = wide
    ? "minmax(180px,2fr) minmax(220px,1.8fr) minmax(90px,1fr) 17rem"
    : "minmax(160px,2fr) minmax(200px,1.8fr) 17rem";

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
                backgroundColor: view === v.key ? "var(--card)" : "transparent",
                color: view === v.key ? "var(--foreground)" : "var(--muted-foreground)",
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
                color: sortDir === s.key ? "oklch(0.18 0.02 240)" : "var(--muted-foreground)",
                boxShadow: sortDir === s.key ? "0 1px 3px oklch(0 0 0 / 0.1)" : "none",
              }}
            >
              {s.label}
            </button>
          ))}
        </div>

        {/* Source filter — AI (Retell) vs Staff (Mango). Both flow the same worklist. */}
        <div className="flex items-center gap-1 bg-muted rounded-md p-1">
          {([
            { key: "all" as const, label: "All", icon: null },
            { key: "retell" as const, label: "CareIN AI", icon: Bot },
            { key: "mango" as const, label: "Staff", icon: Users },
          ]).map((s) => (
            <button
              key={s.key}
              onClick={() => setSourceFilter(s.key)}
              aria-pressed={sourceFilter === s.key}
              title={s.key === "mango" ? "Staff-answered calls (Mango)" : s.key === "retell" ? "CareIN AI calls (Retell)" : "All sources"}
              className="px-2.5 py-1.5 rounded text-xs font-medium transition-all inline-flex items-center gap-1"
              style={{
                backgroundColor: sourceFilter === s.key ? "white" : "transparent",
                color: sourceFilter === s.key ? "oklch(0.18 0.02 240)" : "var(--muted-foreground)",
                boxShadow: sourceFilter === s.key ? "0 1px 3px oklch(0 0 0 / 0.1)" : "none",
              }}
            >
              {s.icon ? <s.icon size={12} /> : null}
              {s.label}
            </button>
          ))}
        </div>

        {/* Disposition filter. "No disposition" is the one that matters day to day: it
            is the true backlog, now that a dispositioned call stops demanding attention. */}
        <Select
          value={dispositionFilter}
          onValueChange={(v) => setDispositionFilter(v as DispositionFilter)}
        >
          <SelectTrigger
            className="h-9 w-[170px] text-xs"
            aria-label="Filter by disposition"
            title="Filter by what kind of call it was"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Any disposition</SelectItem>
            <SelectItem value="none">No disposition</SelectItem>
            <SelectItem value="dispositioned">Dispositioned</SelectItem>
            {DISPOSITIONS.map((d) => (
              <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Sync now + freshness. The caption is what lets someone answer "is this list
            current?" without pressing anything. */}
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleSync}
            disabled={syncing || cooldown > 0}
            title={
              cooldown > 0
                ? "A sync just ran — give it a moment"
                : syncStatus && syncStatus.mangoMode !== "api"
                  // Say it before the click, not only after: in an environment where
                  // Mango is dark this button can only ever pull Retell.
                  ? "Pull new calls from Retell now (Mango ingestion is off in this environment)"
                  : "Pull new calls from Mango and Retell now"
            }
          >
            <RefreshCw size={14} className={`mr-1.5 ${syncing ? "animate-spin" : ""}`} />
            {syncing
              ? "Syncing…"
              : cooldown > 0
                ? `Synced ${Math.max(1, SYNC_COOLDOWN_SECONDS - cooldown)}s ago`
                : "Sync now"}
          </Button>
          {caption && (
            <span className="text-xs text-muted-foreground whitespace-nowrap">{caption}</span>
          )}
        </div>
      </div>

      {/* Signal chips (also filters). These are FACTS the analyzer found — emergency,
          booked, new patient — not the call's disposition, which lives per row. */}
      <div className="flex flex-wrap items-center gap-2">
        {SIGNAL_CHIPS.map((chip) => {
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
            {wide && <div>Signals</div>}
            <div className="text-right">Actions</div>
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
                data-testid="worklist-row"
                data-disposition={call.disposition ?? ""}
                // A dispositioned call reads as handled at a glance: dimmed, badged, and
                // still THERE. It is never removed from the list — it drops out of the
                // attention count (see callNeedsAttention) but "All calls" and the
                // disposition filter both still show it, and clearing takes one click.
                // Full opacity returns on hover so a dim row is still readable.
                className={`grid gap-3 px-4 py-3 border-b border-border/50 hover:bg-muted/20 transition-colors items-center ${
                  call.disposition ? "opacity-60 hover:opacity-100" : ""
                }`}
                style={{ gridTemplateColumns: GRID }}
              >
                {/* Caller */}
                <Link href={`/calls/${call.id}`} className="min-w-0 flex items-center gap-2.5 cursor-pointer">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${call.source === "retell" ? "bg-primary/10" : "bg-amber-500/10"}`}>
                    {call.source === "retell" ? <Bot size={13} className="text-primary" /> : <Users size={13} className="text-amber-600" />}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground truncate flex items-center gap-1.5">
                      {/* title so a name too long for the cell is still readable on hover —
                          truncation is the last resort, never the only reading. */}
                      <span className="truncate" title={call.patientName}>{call.patientName}</span>
                      <span
                        className={`inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded-full flex-shrink-0 ${call.source === "retell" ? "text-primary bg-primary/10" : "text-amber-700 bg-amber-500/10"}`}
                        title={call.source === "retell" ? "CareIN AI (Retell)" : "Staff-answered (Mango)"}
                      >
                        {call.source === "retell" ? "CareIN AI" : "Staff · Mango"}
                      </span>
                    </div>
                    <div className="text-xs font-mono text-muted-foreground">{call.fromNumber}</div>
                    <div className="text-[11px] text-muted-foreground/70">
                      {formatDuration(call.duration)} · {formatTimeAgo(call.date)}
                    </div>
                    {/* M7 — the PBX copy of a call the AI answered end to end. Says so
                        plainly, and links to the row that actually holds the transcript.
                        stopPropagation so the jump-link isn't swallowed by the row link. */}
                    {isAiDuplicateLeg(call) && (
                      <Link
                        href={`/calls/${call.linkedCallId}`}
                        onClick={(e) => e.stopPropagation()}
                        className="mt-0.5 inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded-full text-primary bg-primary/10 hover:underline"
                        title="This call was answered by the AI agent — open the AI call to see its transcript"
                      >
                        <Bot size={10} /> {ANSWERED_BY_AI_BADGE}
                      </Link>
                    )}
                    {/* Unmapped Mango line: never lost — surface the dialed DID so an admin
                        can see which number to add to MANGO_LINE_OFFICE. */}
                    {call.source === "mango" && call.officeId === "unknown" && (
                      <div
                        className="mt-0.5 inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded-full text-amber-700 bg-amber-500/10"
                        title="This office phone line isn't mapped to an office yet — add its number to MANGO_LINE_OFFICE"
                      >
                        <AlertTriangle size={10} /> Unmapped line: {call.calledNumber || "unknown"}
                      </div>
                    )}
                  </div>
                </Link>

                {/* Patient identity — the name has this cell to itself. Every action that
                    used to sit on this line moved to the Actions column. */}
                <div className="min-w-0">
                  <PatientIdentityCell
                    call={call}
                    officeOdConnected={odConnectedForCall(call)}
                    officeName={offices.find((o) => o.officeId === call.officeId)?.officeName ?? null}
                    onPick={() => setPickCall(call)}
                  />
                  {/* Narrow viewports: signals live under the name rather than as a fourth
                      column squeezing it. */}
                  {!wide && <RowSignals call={call} className="mt-1.5" />}
                </div>

                {/* Signals (disposition chips + passive indicators) */}
                {wide && <RowSignals call={call} />}

                {/* Actions — every row control, right-aligned, one label at most */}
                <RowActions
                  call={call}
                  odConnected={odConnectedForCall(call)}
                  transcribeRunning={transcribe.isRunning(call.id)}
                  onTranscribe={() => transcribe.request(call.id, call.transcribeLastOutcome, call.linkRole)}
                  onSend={() => setSendTarget({
                    call,
                    patientId: Number(call.odPatientId),
                    patientName: call.odPatientName || `PatNum ${call.odPatientId}`,
                  })}
                  onSentToTc={(result) => onSentToTc(call, result)}
                  onFollowUp={() => applyTriage(call, "needs_action")}
                  onDone={applyTriage}
                  onReopen={() => reopen(call)}
                  onDisposition={(disposition) => applyDisposition(call, disposition)}
                  onAddNote={(text) => addNote(call, text)}
                  onDeleteNote={(noteId) => deleteNote(call, noteId)}
                  actorEmail={actor?.email ?? null}
                  actorIsAdmin={actorIsAdmin}
                />
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* (M4) Re-billing a call that already came back silent, or (M7) transcribing the
          PBX copy of a call the AI already transcribed, needs a deliberate yes. */}
      <TranscribeRebillDialog
        open={transcribe.pendingConfirm !== null}
        kind={transcribe.pendingConfirmKind}
        linkedCallId={calls.find((c) => c.id === transcribe.pendingConfirm)?.linkedCallId ?? null}
        onConfirm={transcribe.confirm}
        onCancel={transcribe.cancelConfirm}
      />

      {pickCall && (
        <PickPatientModal
          open={pickCall !== null}
          onOpenChange={(o) => { if (!o) setPickCall(null); }}
          call={pickCall}
          onLinked={(updated) => onLinked(pickCall, updated)}
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
          onSent={(updated) => onSent(sendTarget.call, sendTarget.patientId, updated)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

/**
 * The passive half of a row: signal chips, the disposition badge, the transcript
 * indicator, and the resolved triage outcome. Everything here states a FACT about the
 * call — nothing is clickable, so none of it competes with the patient's name or the
 * Actions column.
 *
 * Rendered as its own column on wide viewports and folded under the name below ~1100px.
 */
function RowSignals({ call, className = "" }: { call: UnifiedCall; className?: string }) {
  return (
    <div className={`flex flex-wrap items-center gap-1 ${className}`}>
      {/* The disposition goes FIRST: on a dispositioned row it is the thing that
          explains why the row looks finished. The action that sets it lives in the
          Actions column; this is only the resulting state. */}
      {call.disposition && (
        <DispositionBadge
          disposition={call.disposition}
          title={call.dispositionBy
            ? `${call.disposition} · ${formatAttribution(call.dispositionBy.name, call.dispositionAt)}`
            : undefined}
        />
      )}

      {/* Filter-only chips are excluded here — "Answered by CareIN AI" already
          renders as its own linked badge next to the caller, and showing it
          twice on the same row would just be noise. */}
      {SIGNAL_CHIPS.filter((chip) => !ALL_CALLS_ONLY_CHIPS.has(chip.key) && chip.match(call)).map((chip) => {
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

      {/* Attribution for the disposition, on its own line for the same reason the
          triage attribution below is: a long name must not push chips out of the
          column. Only shown when the row is not ALSO showing "Done · someone". */}
      {call.disposition && call.dispositionBy && call.triageStatus !== "done" && (
        <span className="w-full text-[10px] text-muted-foreground">
          {formatAttribution(call.dispositionBy.name, call.dispositionAt)}
        </span>
      )}

      {/* (M4) A staff call that has already been read. The ACTION that produces it lives
          in the Actions column; this is only the resulting state. */}
      {call.source === "mango" && call.hasTranscript && (
        <span
          className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded-full text-muted-foreground bg-muted"
          title="This call has a transcript"
        >
          <FileText size={10} /> Transcript
        </span>
      )}

      {/* Resolved triage. This used to live in the Triage column beside the Follow up /
          Done buttons; the buttons became icons in Actions, and the outcome — which is a
          fact, not an action — belongs with the other facts. */}
      {call.triageStatus === "done" && (
        <>
          <span className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded-full text-emerald-700 bg-emerald-500/10">
            <CheckCircle2 size={10} />
            {call.triageOutcome ? OUTCOME_LABEL[call.triageOutcome] : "Done"}
          </span>
          {/* w-full puts attribution on its own line inside the wrapping chip row, so a
              long name can't push the chips out of the column. */}
          {call.triageBy && (
            <span className="w-full text-[10px] text-muted-foreground">
              {formatAttribution(call.triageBy.name, call.triageAt)}
            </span>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Notes on a row: the count, and the panel to read and write them.
 *
 * Deliberately a popover rather than a link to the call page. Jotting "lab says the
 * crown is ready Thursday" is a five-second act done while looking at the list; making
 * it cost a page navigation and a trip back is how a notes field goes unused. The same
 * panel component renders on the call-detail page, so there is one affordance to learn.
 */
function NotesAction({
  call, onAdd, onDelete, actorEmail, actorIsAdmin,
}: {
  call: UnifiedCall;
  onAdd: (text: string) => Promise<void>;
  onDelete: (noteId: string) => Promise<void>;
  actorEmail: string | null;
  actorIsAdmin: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Defensive default: every server record carries `notes` (normalizeUnifiedCall
  // guarantees an array), but hand-built fixtures in the test suites do not, and a
  // row that throws is a worse outcome than a row showing zero notes.
  const notes = call.notes ?? [];
  const count = notes.length;
  const label = count === 0
    ? "Add a note about this call"
    : `${count} note${count === 1 ? "" : "s"} — read or add`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <ActionTooltip label={label}>
        <PopoverTrigger asChild>
          <Button
            size="sm"
            variant={count > 0 ? "secondary" : "outline"}
            className={`${ICON_ACTION_CLASS} relative`}
            aria-label={label}
            data-testid="notes-action"
          >
            <MessageSquare size={13} />
            {/* The count rides the icon rather than taking a column of its own —
                the Actions track is a fixed width and already full. */}
            {count > 0 && (
              <span
                className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-[3px] rounded-full text-[9px] font-semibold leading-[14px] text-primary-foreground bg-primary"
                aria-hidden="true"
              >
                {count > 9 ? "9+" : count}
              </span>
            )}
          </Button>
        </PopoverTrigger>
      </ActionTooltip>
      <PopoverContent align="end" className="w-80 p-3">
        <div className="text-xs font-semibold text-muted-foreground pb-2">
          Notes · internal only
        </div>
        <CallNotesPanel
          notes={notes}
          onAdd={onAdd}
          onDelete={onDelete}
          actorEmail={actorEmail}
          actorIsAdmin={actorIsAdmin}
          maxListHeight="14rem"
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * Every action a row offers, in one right-aligned column, in a stable order:
 * Send to chart · Transcribe · Send to TC · Notes · Disposition · Follow up · Done
 * (or Reopen).
 *
 * AT MOST ONE carries a word — `rowPrimaryAction` picks it from the call's state. The
 * rest are icons with tooltips. This is purely about width: the guards, handlers and
 * confirmations below are the same ones the old Patient / Signals / Triage cells used.
 *
 * Notes and Disposition are offered on EVERY row, including rows with no Open Dental
 * connection and close-outs. That is the point of them — they are the two things that
 * work when nothing else on the row does.
 */
function RowActions({
  call, odConnected, transcribeRunning, onTranscribe, onSend, onSentToTc, onFollowUp, onDone, onReopen,
  onDisposition, onAddNote, onDeleteNote, actorEmail, actorIsAdmin,
}: {
  call: UnifiedCall;
  odConnected: boolean;
  transcribeRunning: boolean;
  onTranscribe: () => void;
  onSend: () => void;
  /** (M6) The call was handed to Treatment Coordinator. */
  onSentToTc: (result: SendToTcResult) => void;
  onFollowUp: () => void;
  onDone: (call: UnifiedCall, status: "done", outcome: TriageOutcome, note?: string) => void;
  onReopen: () => void;
  onDisposition: (disposition: CallDisposition | null) => Promise<void>;
  onAddNote: (text: string) => Promise<void>;
  onDeleteNote: (noteId: string) => Promise<void>;
  actorEmail: string | null;
  actorIsAdmin: boolean;
}) {
  const primary = rowPrimaryAction(call, odConnected);

  // Same conditions the old cells used, unchanged.
  //  - a chart write needs an OD-connected office, a live (non-close-out) call, a matched
  //    patient, and a note not already sent;
  //  - SendToTcButton decides its own visibility (sendToTcState) but was only ever
  //    reachable from an OD-connected, non-close-out row, so that gate is preserved here;
  //  - transcription is offered for staff calls with no transcript yet.
  const canSendToChart =
    odConnected && !call.notAPatient && call.odSyncStatus !== "synced" && Boolean(call.odPatientId);
  const canOfferTc = odConnected && !call.notAPatient;
  const canTranscribe = call.source === "mango" && !call.hasTranscript;
  // An attempt that BILLED and found nothing. Still clickable — that is a human's call —
  // but the click goes through a confirmation, because a retry is a fresh charge for the
  // same silent recording.
  const noSpeech = needsRebillConfirm(call.transcribeLastOutcome);
  const transcribeLabel = transcribeRunning
    ? "Transcribing…"
    : noSpeech
      ? "No speech was found last time — transcribing again will spend budget again"
      : "Transcribe and summarize this call (uses the daily transcription budget)";
  const transcribeIcon = transcribeRunning
    ? <Loader2 size={13} className="animate-spin" />
    : noSpeech ? <VolumeX size={13} /> : <FileText size={13} />;

  return (
    <div className="flex items-center justify-end gap-1.5" data-testid="row-actions">
      {canSendToChart && (
        <Button size="sm" className={`${ACTION_HEIGHT} gap-1 text-[11px] px-2.5 flex-shrink-0`} onClick={onSend}>
          <Send size={12} /> Send to chart
        </Button>
      )}

      {canTranscribe && (
        primary === "transcribe" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={transcribeRunning}
            onClick={onTranscribe}
            title={transcribeLabel}
            className={`${ACTION_HEIGHT} gap-1 text-[11px] px-2.5 flex-shrink-0 ${noSpeech ? "text-muted-foreground" : ""}`}
          >
            {transcribeIcon}
            {transcribeRunning ? "Transcribing…" : noSpeech ? "No speech detected" : "Transcribe"}
          </Button>
        ) : (
          <IconAction label={transcribeLabel} icon={transcribeIcon} disabled={transcribeRunning} onClick={onTranscribe} />
        )
      )}

      {canOfferTc && <SendToTcButton call={call} onSent={onSentToTc} variant="icon" />}

      <NotesAction
        call={call}
        onAdd={onAddNote}
        onDelete={onDeleteNote}
        actorEmail={actorEmail}
        actorIsAdmin={actorIsAdmin}
      />

      <DispositionPicker current={call.disposition} onPick={onDisposition} />

      <TriageActions call={call} onFollowUp={onFollowUp} onDone={onDone} onReopen={onReopen} />
    </div>
  );
}

function PatientIdentityCell({
  call, officeOdConnected, officeName, onPick,
}: {
  call: UnifiedCall;
  officeOdConnected: boolean;
  /** Display name of this call's office; null when the office isn't in the roster. */
  officeName: string | null;
  onPick: () => void;
}) {
  // No Open Dental for THIS call's office → no chart actions, and an honest reason.
  // Two distinct situations, because the answer to "what do I do about it?" differs:
  // an unmapped line needs its DID added; a known office needs OD switched on.
  if (!officeOdConnected) {
    const message =
      call.officeId === "unknown" || !officeName
        ? "Can't connect this call to a chart — its office is unknown"
        : `OD not connected for ${officeName} yet`;
    return (
      <span className="text-xs text-muted-foreground/70 italic" title={message}>
        {message}
      </span>
    );
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
    const name = call.odPatientName || (call.odPatientId ? `PatNum ${call.odPatientId}` : "chart");
    return (
      <Link
        href={`/calls/${call.id}`}
        className="flex items-center gap-1 text-xs font-medium text-emerald-700 hover:underline min-w-0"
        title={`Sent to ${name}'s chart`}
      >
        <CheckCircle2 size={12} className="text-emerald-600 flex-shrink-0" />
        <span className="truncate">Sent · {name}</span>
      </Link>
    );
  }
  // Matched but NOT sent (review-then-send): a patient is linked (od_patient_id) but no
  // chart note has been written. The Send button that used to sit on this line — and take
  // most of it — is now the row's one labeled action in the Actions column. Nothing about
  // the flow changed: nothing is written until the human confirms in the dialog.
  if (call.odPatientId) {
    const name = call.odPatientName || `PatNum ${call.odPatientId}`;
    return (
      <span
        className="flex items-center gap-1 text-xs font-medium text-sky-700 min-w-0"
        title={`${name} — auto-matched, review before sending`}
      >
        <UserCheck size={12} className="text-sky-600 flex-shrink-0" />
        <span className="truncate">Matched: {name}</span>
      </span>
    );
  }
  // No linked patient → actionable. Stored candidates (Slice-A needs_review) label as
  // "Needs match (N)"; everything else (incl. pull-synced calls) is "Unmatched". The
  // button opens the modal, which offers BOTH Pick Patient and the not-a-patient close-out.
  const n = call.odMatchCandidates?.length ?? 0;
  const label = n > 0 ? `Needs match (${n})` : "Unmatched";
  return (
    <button
      onClick={onPick}
      title="Match to a patient or mark not a patient"
      // ACTION_HEIGHT so this status chip lines up with the buttons across the row —
      // the old mix of 28px chips and 32px buttons is what made rows read as noisy.
      className={`inline-flex ${ACTION_HEIGHT} items-center gap-1 text-xs font-medium px-2 rounded-md border transition-colors hover:bg-amber-500/10`}
      style={{ color: "oklch(0.52 0.14 75)", borderColor: "oklch(0.75 0.14 75 / 0.5)" }}
    >
      <UserSearch size={12} className="flex-shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

/**
 * Follow up / Done / Reopen — ALWAYS icon-only.
 *
 * These fire on every row regardless of state, so they are exactly the labels a row can't
 * afford. The "Following up" distinction survives as the button's filled variant plus its
 * tooltip, and the resolved outcome is rendered by RowSignals.
 */
function TriageActions({
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
      <IconAction
        label="Reopen this call"
        icon={<RotateCcw size={13} />}
        variant="ghost"
        onClick={onReopen}
      />
    );
  }

  const followingUp = call.triageStatus === "needs_action";

  return (
    <>
      <IconAction
        label={followingUp ? "Following up — click to keep it flagged" : "Flag for follow up"}
        icon={<PhoneForwarded size={13} />}
        variant={followingUp ? "secondary" : "outline"}
        onClick={onFollowUp}
      />

      <Popover open={open} onOpenChange={setOpen}>
        <ActionTooltip label="Mark done — choose an outcome">
          <PopoverTrigger asChild>
            <Button size="sm" className={ICON_ACTION_CLASS} aria-label="Mark done — choose an outcome">
              <CheckCircle2 size={13} />
            </Button>
          </PopoverTrigger>
        </ActionTooltip>
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
    </>
  );
}

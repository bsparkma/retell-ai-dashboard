/**
 * Activity feed (AT-1) — the case view's Activity tab. A merged, paged list of
 * every note and communication source for this case, newest first, from
 * GET /api/tc/cases/:caseId/activity. It looks like the old ActivityTimeline
 * (icon rail, label, time, actor, text) and adds:
 *
 *  - source filter chips (over what has loaded so far),
 *  - an Internal / Patient-facing / External badge on every row,
 *  - an "On chart" marker where the item reached the Open Dental chart,
 *  - a "Current value" marker on sources that are overwritten in place — the
 *    row is what the record says NOW, not a history of it,
 *  - a "This patient (other cases)" toggle that asks for scope=patient.
 *
 * The one write (AT-2): a "Log to chart" button on chart-worthy items opens
 * LogToChartDialog, and ONLY its Confirm click writes — one item, the exact
 * text shown, to that office's Open Dental chart. Nothing else here writes.
 * "Load more" pages with the server's cursor (keyset), so rows that arrive
 * while you read never shift or repeat what is already on screen.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OfficeId } from "@shared/tc/contract";
import type {
  ActivityAudience,
  ActivityChartWrite,
  ActivityScope,
  ActivitySource,
  TcActivityChartWritten,
  TcActivityItem,
} from "@shared/tc/activity";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ArrowRightLeft,
  ClipboardCheck,
  FileSignature,
  Headphones,
  History,
  Loader2,
  Mail,
  MessageSquare,
  MessageSquareWarning,
  Send,
  ShieldCheck,
  Stethoscope,
  StickyNote,
  CalendarClock,
  ClipboardPen,
} from "lucide-react";
import { getCaseActivity, tcErrorMessage } from "../api";
import { LogToChartDialog } from "./LogToChartDialog";

const PAGE_SIZE = 50;

const SOURCE_META: Record<ActivitySource, { label: string; icon: typeof StickyNote; iconClass: string }> = {
  case_event: { label: "Timeline", icon: ArrowRightLeft, iconClass: "text-blue-600 dark:text-blue-400" },
  case_notes: { label: "Notes box", icon: StickyNote, iconClass: "text-slate-500 dark:text-slate-400" },
  objection: { label: "Objections", icon: MessageSquareWarning, iconClass: "text-amber-600 dark:text-amber-400" },
  followup: { label: "Follow-ups", icon: CalendarClock, iconClass: "text-emerald-600 dark:text-emerald-400" },
  hygiene_intake: { label: "Hygiene", icon: Stethoscope, iconClass: "text-teal-600 dark:text-teal-400" },
  checkout: { label: "Checkout", icon: ClipboardCheck, iconClass: "text-purple-600 dark:text-purple-400" },
  message: { label: "Messages", icon: MessageSquare, iconClass: "text-cyan-600 dark:text-cyan-400" },
  email_log: { label: "Email log", icon: Mail, iconClass: "text-cyan-600 dark:text-cyan-400" },
  referral_event: { label: "Referrals", icon: Send, iconClass: "text-violet-600 dark:text-violet-400" },
  preauth: { label: "Pre-auths", icon: FileSignature, iconClass: "text-orange-600 dark:text-orange-400" },
  voice_call: { label: "Calls", icon: Headphones, iconClass: "text-primary" },
  consent: { label: "Consent", icon: ShieldCheck, iconClass: "text-slate-500 dark:text-slate-400" },
};

const AUDIENCE_LABEL: Record<ActivityAudience, string> = {
  internal: "Internal",
  patient_facing: "Patient-facing",
  external: "External",
};

const AUDIENCE_CLASS: Record<ActivityAudience, string> = {
  internal: "border-transparent bg-muted text-muted-foreground",
  patient_facing: "border-transparent bg-cyan-50 text-cyan-800 dark:bg-cyan-950 dark:text-cyan-200",
  external: "border-transparent bg-violet-50 text-violet-800 dark:bg-violet-950 dark:text-violet-200",
};

const CHART_VIA_LABEL = { voice: "call note", referral: "referral note", hygiene: "hygiene", tc: "TC note" } as const;

export interface ActivityFeedProps {
  office: OfficeId;
  caseId: string;
  /** Changes whenever the case changes on this page, so the feed re-reads. */
  refreshKey?: string;
}

type Load = { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string };

export function ActivityFeed({ office, caseId, refreshKey = "" }: ActivityFeedProps) {
  const [scope, setScope] = useState<ActivityScope>("case");
  const [items, setItems] = useState<TcActivityItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [hidden, setHidden] = useState<ReadonlySet<ActivitySource>>(new Set());
  // AT-2: whether this office's charts can take a TC note right now (from the first page).
  const [chartWrite, setChartWrite] = useState<ActivityChartWrite | null>(null);
  const [charting, setCharting] = useState<string | null>(null);
  // Each first-page read gets a number; a slower, older answer never overwrites a newer one.
  const generation = useRef(0);

  const loadFirst = useCallback(async () => {
    const gen = ++generation.current;
    setLoad({ kind: "loading" });
    setItems([]);
    setNextCursor(null);
    try {
      const page = await getCaseActivity(office, caseId, { scope, limit: PAGE_SIZE });
      if (gen !== generation.current) return;
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setChartWrite(page.chartWrite ?? null);
      setLoad({ kind: "idle" });
    } catch (e) {
      if (gen !== generation.current) return;
      setLoad({ kind: "error", message: tcErrorMessage(e) });
    }
  }, [office, caseId, scope]);

  /** The server confirmed (and read back) a chart note: mark that row On chart, no button. */
  const markCharted = (written: TcActivityChartWritten) =>
    setItems((prev) =>
      prev.map((i) =>
        i.id === written.itemId
          ? {
              ...i,
              chart: written.chart,
              chartable: { eligible: false, code: "ALREADY_ON_CHART", reason: "Already on the chart." },
            }
          : i,
      ),
    );

  useEffect(() => {
    void loadFirst();
  }, [loadFirst, refreshKey]);

  const loadMore = async () => {
    if (!nextCursor) return;
    const gen = generation.current;
    setLoad({ kind: "loading" });
    try {
      const page = await getCaseActivity(office, caseId, { scope, limit: PAGE_SIZE, before: nextCursor });
      if (gen !== generation.current) return;
      setItems((prev) => {
        const seen = new Set(prev.map((i) => i.id));
        return prev.concat(page.items.filter((i) => !seen.has(i.id)));
      });
      setNextCursor(page.nextCursor);
      setLoad({ kind: "idle" });
    } catch (e) {
      if (gen !== generation.current) return;
      setLoad({ kind: "error", message: tcErrorMessage(e) });
    }
  };

  const presentSources = useMemo(() => {
    const set = new Set(items.map((i) => i.source));
    return (Object.keys(SOURCE_META) as ActivitySource[]).filter((s) => set.has(s));
  }, [items]);

  const visible = useMemo(() => items.filter((i) => !hidden.has(i.source)), [items, hidden]);

  const toggleSource = (s: ActivitySource) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  return (
    <div className="space-y-3" data-testid="tc-activity-feed">
      <div className="flex flex-wrap items-center gap-2">
        {presentSources.length > 1 &&
          presentSources.map((s) => {
            const on = !hidden.has(s);
            return (
              <Button
                key={s}
                type="button"
                size="sm"
                variant={on ? "secondary" : "outline"}
                aria-pressed={on}
                className="h-7 rounded-full px-3 text-xs"
                onClick={() => toggleSource(s)}
              >
                {SOURCE_META[s].label}
              </Button>
            );
          })}
        <Button
          type="button"
          size="sm"
          variant={scope === "patient" ? "secondary" : "outline"}
          aria-pressed={scope === "patient"}
          className="h-7 rounded-full px-3 text-xs sm:ml-auto"
          onClick={() => setScope((s) => (s === "patient" ? "case" : "patient"))}
        >
          This patient (other cases)
        </Button>
      </div>

      {load.kind === "error" && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          Couldn’t load activity: {load.message}
        </p>
      )}

      {load.kind === "loading" && items.length === 0 ? (
        <p className="text-sm text-muted-foreground py-6">Loading activity…</p>
      ) : visible.length === 0 && load.kind !== "error" ? (
        <p className="text-sm text-muted-foreground py-6">
          {items.length === 0 ? "No activity yet." : "Nothing from the selected sources."}
        </p>
      ) : (
        <ol className="space-y-0">
          {visible.map((it, idx) => (
            <ActivityRow
              key={it.id}
              item={it}
              last={idx === visible.length - 1}
              chartWrite={chartWrite}
              onLogToChart={() => setCharting(it.id)}
            />
          ))}
        </ol>
      )}

      {nextCursor && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={load.kind === "loading"}
          onClick={() => void loadMore()}
        >
          {load.kind === "loading" && <Loader2 className="animate-spin" />}
          Load more
        </Button>
      )}

      {charting !== null && (
        <LogToChartDialog
          office={office}
          caseId={caseId}
          itemId={charting}
          open
          onOpenChange={(o) => {
            if (!o) setCharting(null);
          }}
          onWritten={markCharted}
        />
      )}
    </div>
  );
}

function ActivityRow({
  item,
  last,
  chartWrite,
  onLogToChart,
}: {
  item: TcActivityItem;
  last: boolean;
  /** Null when the server did not say (an older server): no button at all. */
  chartWrite: ActivityChartWrite | null;
  onLogToChart: () => void;
}) {
  // Only chart-worthy items get the button; one already on the chart never does.
  const showChartButton = chartWrite !== null && item.chartable?.eligible === true && !item.chart.onChart;
  const chartBlocked = chartWrite !== null && !chartWrite.available;
  const meta = SOURCE_META[item.source];
  const Icon = item.completeness === "current_value_only" ? History : meta.icon;
  return (
    <li className="flex gap-3" data-testid="tc-activity-row" data-source={item.source}>
      <div className="flex flex-col items-center">
        <div className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-full bg-muted flex-shrink-0">
          <Icon size={14} className={meta.iconClass} />
        </div>
        {!last && <div className="w-px flex-1 bg-border my-1" />}
      </div>
      <div className="pb-5 min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-foreground break-words">{item.title}</span>
          <Badge variant="outline" className={AUDIENCE_CLASS[item.audience]}>
            {AUDIENCE_LABEL[item.audience]}
          </Badge>
          {item.completeness === "current_value_only" && (
            <Badge variant="outline" className="border-dashed text-muted-foreground" title="Overwritten in place — this is what it says now, not a history">
              Current value
            </Badge>
          )}
          {item.chart.onChart && (
            <Badge
              variant="outline"
              className="border-transparent bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
            >
              On chart{item.chart.via ? ` · ${CHART_VIA_LABEL[item.chart.via]}` : ""}
            </Badge>
          )}
          {item.scope === "patient" && (
            <Badge variant="outline" className="text-muted-foreground">
              Other case / patient
            </Badge>
          )}
          <span className="text-xs text-muted-foreground">
            {item.completeness === "current_value_only" ? "as of " : ""}
            {new Date(item.at).toLocaleString()}
          </span>
          {!item.actor.system && item.actor.display && item.actor.display !== "Not recorded" && (
            <span className="text-xs text-muted-foreground">· {item.actor.display}</span>
          )}
        </div>
        {item.body !== null && (
          <p className="text-sm text-foreground mt-1 whitespace-pre-line break-words">{item.body}</p>
        )}
        {showChartButton && (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              disabled={chartBlocked}
              title={chartBlocked ? (chartWrite?.message ?? undefined) : undefined}
              onClick={onLogToChart}
              data-testid="tc-activity-log-to-chart"
            >
              <ClipboardPen className="mr-1 h-3.5 w-3.5" /> Log to chart
            </Button>
            {chartBlocked && chartWrite?.message && (
              <span className="text-xs text-muted-foreground" data-testid="tc-activity-log-to-chart-blocked">
                {chartWrite.message}
              </span>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

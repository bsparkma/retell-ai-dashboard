/**
 * /hyg/visit/:aptNum/perio — the perio chart (H4 slice 10) and its send (item 12).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ENTER, STAGE, CONFIRM — AND ONLY THE CONFIRM REACHES A CHART
 * ═════════════════════════════════════════════════════════════════════════════
 * A perio chart is entered here, stored on the visit, and STAGED whole. A staged
 * chart can then be sent from this page: the confirm dialog shows exactly how each
 * arch goes in (one request where the arch strings can say it; row by row where a
 * reading of 10 or more, a gap, or a flag with no depth means they cannot), and
 * the server writes, then reads EVERY site back. Written means read back and
 * matching; anything else is named on screen, loudly, with the delete-the-exam
 * undo beside it. A chart that is sending, stopped or written takes no more
 * readings.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE KEYBOARD IS THE FAST PATH, AND THE ORDER IS THE ONE SAID OUT LOUD
 * ═════════════════════════════════════════════════════════════════════════════
 * Focus lands on the grid. A digit is a depth and the cursor moves to the next
 * site in charting order — features/hyg/perio/entry.ts owns what every key
 * does, and shared/hyg/perio.ts owns the order. The keypad under the grid does
 * the same things by touch and hands focus back to the grid after every tap.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE CHART AND THE LAST EXAM ARE TWO REQUESTS
 * ═════════════════════════════════════════════════════════════════════════════
 * The chart comes from our database and paints at once. The last exam is two
 * paged Open Dental reads on a credential three modules share; it fills in
 * underneath each site when it arrives. Until then the page says it is reading;
 * afterwards it says found, none, or unavailable — four displays, because those
 * are four different facts.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE SERVER HOLDS THE CHART, AND THE SEND RUNS FROM THIS PAGE
 * ═════════════════════════════════════════════════════════════════════════════
 * Every change is stored after a short pause, one save at a time, in order. The
 * send is a loop of steps this page asks for, so every write happens inside a
 * request the person who confirmed it made. Leaving the page stops asking; the
 * server's record survives, and Continue reads Open Dental before it writes.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent } from "react";
import { Link, useParams, useSearch } from "wouter";
import { AlertTriangle, ArrowLeft, Loader2, Pencil, RefreshCw, Send } from "lucide-react";

import { isOfficeId, type StagedWrite } from "@shared/hyg/contract";
import {
  PERIO_FLAGS,
  PERIO_FLAG_KEYS,
  PERIO_FLAG_LABELS,
  PERIO_SEGMENTS,
  countPerioChart,
  emptyPerioChart,
  normalizePerioChart,
  perioProgressLabel,
  perioSideOf,
  perioSite,
  perioTooth,
  type HygPerioPriorResponse,
  type HygPerioResponse,
  type PerioChart,
} from "@shared/hyg/perio";
import { perioChartChanges, type HygPerioSendResponse } from "@shared/hyg/perioSend";
import {
  beginPerioAmendment,
  cancelPerioAmendment,
  removePerioReplacedExam,
  deletePerioSendExam,
  fetchPerio,
  fetchPerioPrior,
  fetchPerioSend,
  HygApiError,
  openVisit,
  retryStagedWrite,
  savePerio,
  stageWrite,
  startPerioSend,
  stepPerioSend,
} from "@/features/hyg/api";
import { todayIso } from "@/features/hyg/day";
import {
  flagTarget,
  initialPerioEntry,
  keyToPerioAction,
  reducePerioEntry,
  type PerioEntryAction,
} from "@/features/hyg/perio/entry";
import { PerioGrid } from "@/features/hyg/perio/PerioGrid";
import { PerioSendConfirm } from "@/features/hyg/perio/PerioSendConfirm";
import { PerioDeleteExamDialog, PerioSendPanel, perioMismatchTeeth } from "@/features/hyg/perio/PerioSendPanel";
import { cn } from "@/lib/utils";

/** How long after the last key the chart is stored. */
const SAVE_DEBOUNCE_MS = 600;

const TAP = "min-h-11 rounded-lg border px-3 text-sm font-medium transition-colors";

type PriorState =
  | { phase: "loading" }
  | { phase: "loaded"; res: HygPerioPriorResponse }
  | { phase: "failed"; error: HygApiError };

type SaveState = "idle" | "saving" | "saved" | "failed";

function chartKey(chart: PerioChart): string {
  return JSON.stringify(normalizePerioChart(chart));
}

/**
 * The provider an exam is filed under: the hygienist, else the provider. The
 * SAME rule the server applies (services/hyg/perioSend.js provNumFor); the
 * confirm carries this number and the server refuses if its own differs.
 */
function provNumOf(appointment: { provHyg: number | null; provNum: number | null }): number | null {
  if (appointment.provHyg !== null && appointment.provHyg > 0) return appointment.provHyg;
  if (appointment.provNum !== null && appointment.provNum > 0) return appointment.provNum;
  return null;
}

function isInFlight(res: HygPerioSendResponse): boolean {
  return res.send !== null && (res.send.state === "posting" || res.send.state === "filling");
}

/** Found / none / unavailable / not read yet / refused — each drawn its own way. */
function PriorPanel({
  prior,
  onRetry,
  skipSuggestion,
  onSkipTeeth,
}: {
  prior: PriorState;
  onRetry: () => void;
  skipSuggestion: number[];
  onSkipTeeth: (teeth: number[]) => void;
}) {
  if (prior.phase === "loading") {
    return (
      <div
        className="flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm text-muted-foreground"
        data-testid="hyg-perio-prior-loading"
        aria-busy="true"
      >
        <Loader2 size={14} className="animate-spin" /> Reading the last perio exam from Open Dental…
      </div>
    );
  }

  if (prior.phase === "failed") {
    const { error } = prior;
    return (
      <div
        className="rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm"
        data-testid="hyg-perio-prior-failed"
      >
        <p className="font-medium text-destructive">{error.message}</p>
        {error.code ? <p className="mt-0.5 text-xs text-muted-foreground">{error.code}</p> : null}
        {/* A setting cannot be retried into working. */}
        {error.officeNotReady ? null : (
          <button
            type="button"
            onClick={onRetry}
            className={cn(TAP, "mt-2 inline-flex items-center gap-1.5 border-border")}
          >
            <RefreshCw size={14} /> Try again
          </button>
        )}
      </div>
    );
  }

  const p = prior.res.prior;
  if (p.status === "none") {
    return (
      <div
        className="rounded-xl border border-dashed border-border px-3 py-2 text-sm text-muted-foreground"
        data-testid="hyg-perio-prior-none"
      >
        <span className="font-medium text-foreground">No perio exam on file</span> in Open Dental for
        this patient. There is nothing to compare against, so the grid shows no old numbers — not
        zeros.
      </div>
    );
  }

  if (p.status === "unavailable") {
    return (
      <div
        className="rounded-xl border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm"
        data-testid="hyg-perio-prior-unavailable"
      >
        <p className="flex items-start gap-1.5 font-medium text-amber-800 dark:text-amber-300">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          {p.message} This is not the same as no history.
        </p>
        {p.detail ? <p className="mt-0.5 text-xs text-muted-foreground">{p.detail}</p> : null}
        <button
          type="button"
          onClick={onRetry}
          className={cn(TAP, "mt-2 inline-flex items-center gap-1.5 border-border")}
          data-testid="hyg-perio-prior-retry"
        >
          <RefreshCw size={14} /> Try again
        </button>
      </div>
    );
  }

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-muted/30 px-3 py-2 text-sm"
      data-testid="hyg-perio-prior-found"
    >
      <p className="text-muted-foreground">
        <span className="font-medium text-foreground">
          Last charted {p.examDate ?? "on an exam with no date"}
        </span>{" "}
        in Open Dental — the small grey number under each site. {perioProgressLabel(p.counts)}.
        {p.truncated ? (
          <span className="ml-1 font-medium text-amber-700 dark:text-amber-400">
            Only part of that exam could be read; some old numbers are missing.
          </span>
        ) : null}
      </p>
      {skipSuggestion.length > 0 ? (
        <button
          type="button"
          onClick={() => onSkipTeeth(skipSuggestion)}
          className={cn(TAP, "border-border")}
          data-testid="hyg-perio-skip-like-last"
        >
          Skip {skipSuggestion.map((t) => "#" + t).join(", ")} like last time
        </button>
      ) : null}
    </div>
  );
}

function StagedPill({ write }: { write: StagedWrite }) {
  return (
    <span
      className={cn(
        "rounded-full px-2.5 py-1 text-xs font-semibold",
        write.state === "Failed"
          ? "bg-destructive/15 text-destructive"
          : write.state === "Written"
            ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300"
            : "bg-muted text-muted-foreground",
      )}
      data-testid={`hyg-perio-state-${write.state}`}
    >
      {write.state}
    </span>
  );
}

export default function HygPerio() {
  const params = useParams<{ aptNum: string }>();
  const search = useSearch();
  const aptNum = Number(params.aptNum);
  const query = useMemo(() => new URLSearchParams(search), [search]);
  const office = query.get("office");
  const date = query.get("date") ?? todayIso();

  const [entry, dispatch] = useReducer(reducePerioEntry, undefined, () =>
    initialPerioEntry(emptyPerioChart()),
  );
  const [stored, setStored] = useState<HygPerioResponse | null>(null);
  const [loadError, setLoadError] = useState<HygApiError | null>(null);
  const [prior, setPrior] = useState<PriorState>({ phase: "loading" });
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [staging, setStaging] = useState(false);
  const [stageMessage, setStageMessage] = useState<string | null>(null);
  // THE SEND (item 12).
  const [send, setSend] = useState<HygPerioSendResponse | null>(null);
  const [sendRunning, setSendRunning] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  /** Item 13: an amend or cancel request is in flight. */
  const [amending, setAmending] = useState(false);
  /** Stops the step loop when the page goes away — leaving pauses, it does not lose. */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  /** A chart that is sending, stopped or written takes no more readings. */
  const lockedRef = useRef(false);

  const gridRef = useRef<HTMLDivElement | null>(null);
  /** The chart the server last answered with, normalised. */
  const lastSaved = useRef<string | null>(null);
  const visitStarted = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Saves run one at a time, in order — two PUTs racing could land the older one last. */
  const inFlight = useRef<Promise<boolean>>(Promise.resolve(true));
  const latestChart = useRef<PerioChart>(entry.chart);
  latestChart.current = entry.chart;

  /** A send answer is also the chart's staged-write state; both move together. */
  const applySend = useCallback((res: HygPerioSendResponse) => {
    setSend(res.send ? res : null);
    setStored((prev) => (prev ? { ...prev, stagedWrite: res.stagedWrite } : prev));
  }, []);

  const loadChart = useCallback(
    async (signal?: AbortSignal) => {
      if (!isOfficeId(office)) return;
      try {
        const res = await fetchPerio(office, aptNum, signal);
        visitStarted.current = res.visitStarted;
        lastSaved.current = chartKey(res.chart);
        dispatch({ type: "load", chart: res.chart });
        setStored(res);
        setLoadError(null);
        setSaveState(res.visitStarted ? "saved" : "idle");
        if (res.visitStarted) {
          // Where a send stands, if one was ever started. Our database only, and a
          // failure here costs the send panel, not the chart.
          try {
            const progress = await fetchPerioSend(office, aptNum, signal);
            setSend(progress.send ? progress : null);
          } catch {
            /* the chart still loads; the panel appears once a send answers */
          }
        }
      } catch (err) {
        if (signal?.aborted) return;
        setLoadError(
          err instanceof HygApiError ? err : new HygApiError("Could not load the perio chart", 0, null),
        );
      }
    },
    [office, aptNum],
  );

  const loadPrior = useCallback(
    async (signal?: AbortSignal) => {
      if (!isOfficeId(office)) return;
      setPrior({ phase: "loading" });
      try {
        setPrior({ phase: "loaded", res: await fetchPerioPrior(office, aptNum, date, signal) });
      } catch (err) {
        if (signal?.aborted) return;
        setPrior({
          phase: "failed",
          error:
            err instanceof HygApiError
              ? err
              : new HygApiError("Could not read the last perio exam", 0, null),
        });
      }
    },
    [office, aptNum, date],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadChart(controller.signal);
    void loadPrior(controller.signal);
    return () => controller.abort();
  }, [loadChart, loadPrior]);

  // Focus the grid in the same commit that puts it on screen: the first key should
  // be a number. A LAYOUT effect, not a passive one — a passive effect runs after the
  // browser paints, so for a frame (longer on a busy iPad) the grid is visible but
  // <body> has focus and the keys typed then are dropped.
  const chartReady = stored !== null;
  useLayoutEffect(() => {
    if (chartReady) gridRef.current?.focus();
  }, [chartReady]);

  /** Store whatever is on screen NOW, after any save already running. */
  const save = useCallback((): Promise<boolean> => {
    const run = inFlight.current.then(async () => {
      if (!isOfficeId(office)) return false;
      const chart = latestChart.current;
      if (chartKey(chart) === lastSaved.current) {
        setSaveState("saved");
        return true;
      }
      setSaveState("saving");
      try {
        if (!visitStarted.current) {
          await openVisit(office, aptNum, date);
          visitStarted.current = true;
        }
        const res = await savePerio(office, aptNum, chart);
        lastSaved.current = chartKey(res.chart);
        setStored(res);
        setSaveError(null);
        setSaveState(chartKey(latestChart.current) === lastSaved.current ? "saved" : "saving");
        return true;
      } catch (err) {
        setSaveState("failed");
        setSaveError(err instanceof HygApiError ? err.message : "Could not save the perio chart");
        return false;
      }
    });
    inFlight.current = run;
    return run;
  }, [office, aptNum, date]);

  // Every change is stored after a pause. `stored` is a dependency so a reading
  // typed during a save is picked up once that save answers.
  useEffect(() => {
    if (stored === null) return;
    if (chartKey(entry.chart) === lastSaved.current) return;
    setSaveState("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void save();
    }, SAVE_DEBOUNCE_MS);
  }, [entry.chart, stored, save]);

  // Leaving the page does not drop the last few readings.
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
        void save();
      }
    },
    [save],
  );

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (lockedRef.current) return;
    const action = keyToPerioAction(e);
    if (!action) return;
    e.preventDefault();
    dispatch(action);
  }, []);

  /** A tap does what its key does, and gives the keyboard back. */
  const act = useCallback((action: PerioEntryAction) => {
    if (lockedRef.current && action.type !== "select") return;
    dispatch(action);
    gridRef.current?.focus();
  }, []);

  const onStage = useCallback(async () => {
    if (!isOfficeId(office)) return;
    setStaging(true);
    setStageMessage(null);
    try {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      // The stage composes from what is STORED, so what is on screen goes first.
      if (!(await save())) return;
      const res = await stageWrite(office, aptNum, "perio");
      const write = res.visit.stagedWrites.find((w) => w.kind === "perio") ?? null;
      setStored((prev) => (prev ? { ...prev, stagedWrite: write } : prev));
    } catch (err) {
      setStageMessage(err instanceof HygApiError ? err.message : "Could not stage the chart");
    } finally {
      setStaging(false);
    }
  }, [office, aptNum, save]);

  /**
   * Run a send: the first call, then steps until it finishes, stops or pauses.
   *
   * The loop lives on this page on purpose — every write happens inside a request
   * this person made. Leaving stops asking for steps; Continue reads before it writes.
   */
  const runSend = useCallback(
    async (first: () => Promise<HygPerioSendResponse>) => {
      if (!isOfficeId(office)) return;
      setSendRunning(true);
      setSendError(null);
      try {
        let res = await first();
        if (mounted.current) applySend(res);
        while (mounted.current && isInFlight(res) && res.paused === null) {
          res = await stepPerioSend(office, aptNum);
          if (mounted.current) applySend(res);
        }
      } catch (err) {
        if (mounted.current) {
          setSendError(
            err instanceof HygApiError
              ? err.message
              : "The send stopped before Open Dental answered. Nothing is lost; Continue reads before it writes.",
          );
        }
      } finally {
        if (mounted.current) setSendRunning(false);
      }
    },
    [office, aptNum, applySend],
  );

  const onDeleteExam = useCallback(
    async (examNum: number) => {
      if (!isOfficeId(office)) return;
      setDeleting(true);
      setDeleteError(null);
      try {
        applySend(await deletePerioSendExam(office, aptNum, examNum));
        setDeleteOpen(false);
      } catch (err) {
        setDeleteError(err instanceof HygApiError ? err.message : "Could not delete the exam. Nothing here changed.");
      } finally {
        setDeleting(false);
      }
    },
    [office, aptNum, applySend],
  );

  const onRestage = useCallback(async () => {
    if (!isOfficeId(office)) return;
    setSendError(null);
    try {
      const res = await retryStagedWrite(office, aptNum, "perio");
      const write = res.visit.stagedWrites.find((w) => w.kind === "perio") ?? null;
      setStored((prev) => (prev ? { ...prev, stagedWrite: write } : prev));
      setSend((prev) => (prev ? { ...prev, stagedWrite: write } : prev));
    } catch (err) {
      setSendError(err instanceof HygApiError ? err.message : "Could not put the chart back on the list");
    }
  }, [office, aptNum]);

  /**
   * ITEM 13: open a sent chart for a correction, abandon one, or finish a swap
   * whose delete did not land. NONE of the first two write to Open Dental.
   *
   * Both reload the chart afterwards, because the server decides what the
   * readings are: opening loads what OPEN DENTAL holds, and abandoning puts
   * those same readings back.
   */
  const onAmend = useCallback(async () => {
    if (!isOfficeId(office)) return;
    setAmending(true);
    setSendError(null);
    try {
      applySend(await beginPerioAmendment(office, aptNum));
      await loadChart();
    } catch (err) {
      setSendError(
        err instanceof HygApiError ? err.message : "Could not open this chart for a correction.",
      );
    } finally {
      setAmending(false);
    }
  }, [office, aptNum, applySend, loadChart]);

  const onCancelAmend = useCallback(async () => {
    if (!isOfficeId(office)) return;
    setAmending(true);
    setSendError(null);
    try {
      applySend(await cancelPerioAmendment(office, aptNum));
      await loadChart();
    } catch (err) {
      setSendError(err instanceof HygApiError ? err.message : "Could not put the chart back.");
    } finally {
      setAmending(false);
    }
  }, [office, aptNum, applySend, loadChart]);

  const onRemoveReplaced = useCallback(
    async (examNum: number) => {
      if (!isOfficeId(office)) return;
      setSendError(null);
      try {
        applySend(await removePerioReplacedExam(office, aptNum, examNum));
      } catch (err) {
        setSendError(
          err instanceof HygApiError
            ? err.message
            : `Could not remove exam ${examNum}. Nothing here changed.`,
        );
      }
    },
    [office, aptNum, applySend],
  );

  const visitHref = `/hyg/visit/${aptNum}?office=${office ?? ""}&date=${date}`;

  if (!isOfficeId(office)) {
    return (
      <div className="p-6" data-testid="hyg-perio-no-office">
        <Link href="/hyg/day" className="inline-flex min-h-11 items-center gap-1.5 text-sm text-muted-foreground">
          <ArrowLeft size={16} /> Back to the day
        </Link>
        <h1 className="mt-4 text-xl font-semibold text-foreground">Which office is this?</h1>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">
          A perio chart belongs to one location. Open it from the visit and it brings the office
          with it.
        </p>
      </div>
    );
  }

  if (loadError && stored === null) {
    return (
      <div className="p-6" data-testid="hyg-perio-error">
        <Link href={visitHref} className="inline-flex min-h-11 items-center gap-1.5 text-sm text-muted-foreground">
          <ArrowLeft size={16} /> Back to the visit
        </Link>
        <div className="mt-4 max-w-2xl rounded-2xl border border-destructive/40 bg-destructive/5 p-4">
          <p className="text-sm font-medium text-destructive">{loadError.message}</p>
          {loadError.code ? <p className="mt-1 text-xs text-muted-foreground">{loadError.code}</p> : null}
          <button
            type="button"
            onClick={() => void loadChart()}
            className={cn(TAP, "mt-3 inline-flex items-center gap-1.5 border-border")}
          >
            <RefreshCw size={14} /> Try again
          </button>
        </div>
      </div>
    );
  }

  if (stored === null) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground" data-testid="hyg-perio-loading" aria-busy="true">
        <Loader2 size={16} className="animate-spin" /> Loading the perio chart…
      </div>
    );
  }

  const counts = countPerioChart(entry.chart);
  const { cursor } = entry;
  const target = flagTarget(entry);
  const targetSite = perioSite(entry.chart, target.tooth, target.surface);
  const cursorSkipped = perioTooth(entry.chart, cursor.tooth).skipped;
  const found = prior.phase === "loaded" && prior.res.prior.status === "found" ? prior.res.prior : null;
  const priorChart = found ? found.chart : null;
  const priorAtCursor = priorChart ? perioSite(priorChart, cursor.tooth, cursor.surface).depth : null;
  const skipSuggestion = priorChart
    ? countPerioChart(priorChart).teethSkipped.filter((t) => !perioTooth(entry.chart, t).skipped)
    : [];
  const appointment = prior.phase === "loaded" ? prior.res.appointment : null;
  const staged = stored.stagedWrite;
  const locked =
    staged !== null && (staged.state === "Sending" || staged.state === "Failed" || staged.state === "Written");
  lockedRef.current = locked;
  const isStaged = staged?.state === "Staged" && saveState !== "saving";
  const provNum = appointment ? provNumOf(appointment) : null;
  const providerLabel = appointment
    ? `${appointment.providerName ?? "Provider"} (ProvNum ${provNum ?? "none"})`
    : "Reading the appointment…";
  const sendBlockedReason = !appointment
    ? "Waiting for the appointment from Open Dental before this can be sent."
    : provNum === null
      ? "This appointment has no provider in Open Dental, so an exam cannot be filed under the right one."
      : null;
  const sendBlocked = !isStaged || provNum === null || sendRunning;
  const mismatchTeeth = perioMismatchTeeth(send?.send ?? null);

  /*
   * ITEM 13: the exam in Open Dental NOW, and the correction being prepared for it.
   *
   * `live` is the send that verified, which is what a correction replaces and
   * what it is diffed against. It stays put while a correction is prepared or
   * has failed, which the latest send does not.
   */
  const live = send?.live ?? null;
  const correcting = live !== null && (staged?.state === "Amending" || staged?.state === "Staged");
  const corrections =
    correcting && live?.writtenChart ? perioChartChanges(live.writtenChart, entry.chart) : [];
  const canAmend = staged?.state === "Written" && live !== null && !sendRunning && !amending;
  const replacedStillThere =
    live !== null && live.supersedesExamNum !== null && live.supersedesDeletedAt === null;

  const saveLabel =
    saveState === "saving"
      ? "Saving…"
      : saveState === "failed"
        ? "Not saved"
        : saveState === "saved"
          ? "Saved on this visit"
          : "Nothing saved yet";

  const stageNote =
    staged?.state === "Written"
      ? live !== null
        ? `In Open Dental as exam ${live.examNum}, every site read back. Correct it with Amend chart — nothing changes in Open Dental until you send the correction.`
        : "In Open Dental and read back. This chart can no longer be changed here."
      : staged?.state === "Amending"
        ? `Correcting exam ${live?.examNum ?? ""}. These are the readings Open Dental holds; change what is wrong and stage it. NOTHING changes in Open Dental until you send.`
        : correcting && isStaged
          ? sendBlockedReason ??
            `Staged as a correction to exam ${live?.examNum ?? ""}. Sending writes a corrected exam, reads every site back, and only then deletes the old one.`
          : staged?.state === "Failed"
        ? "The send stopped. The readings are locked until what reached Open Dental is dealt with below."
        : locked
          ? "Being written to Open Dental. The readings are locked."
          : isStaged
            ? sendBlockedReason ??
              "Staged. Send it from here: every site is read back from Open Dental. Changing a reading takes it off the list until you stage it again."
            : counts.empty
              ? "Nothing to stage until there is a reading."
              : "Staging spells out every reading. Nothing is written to Open Dental until you confirm a send.";

  return (
    <div className="p-6" data-testid="hyg-perio">
      <div className="flex items-center justify-between gap-3">
        <Link
          href={visitHref}
          className="inline-flex min-h-11 items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={16} /> Back to the visit
        </Link>
        <span
          className={cn("text-xs", saveState === "failed" ? "text-destructive" : "text-muted-foreground")}
          data-testid="hyg-perio-save-state"
        >
          {saveLabel}
        </span>
      </div>

      <header className="mt-1 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-foreground" style={{ fontFamily: "Sora, sans-serif" }}>
            Perio chart
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground" data-testid="hyg-perio-patient">
            {appointment ? (
              appointment.patientName ?? <span className="italic">Name unavailable</span>
            ) : prior.phase === "loading" ? (
              "Reading the appointment…"
            ) : (
              <span className="italic">Patient not shown</span>
            )}
            <span aria-hidden> · </span>
            {date}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "rounded-full px-3 py-1 text-sm font-semibold",
              counts.complete
                ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300"
                : "bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-300",
            )}
            data-testid="hyg-perio-progress"
          >
            {perioProgressLabel(counts)}
          </span>
          {staged ? <StagedPill write={staged} /> : null}
          {locked ? null : (
            <button
              type="button"
              onClick={() => void onStage()}
              disabled={staging || counts.empty || isStaged}
              data-testid="hyg-perio-stage"
              className={cn(
                TAP,
                "inline-flex items-center gap-1.5",
                staging || counts.empty || isStaged
                  ? "cursor-not-allowed border-border text-muted-foreground"
                  : "border-primary bg-primary text-primary-foreground",
              )}
            >
              {staging ? <Loader2 size={14} className="animate-spin" /> : null}
              {/* The pill beside this already says Staged; the button does not repeat it. */}
              Stage chart
            </button>
          )}
          {isStaged && !locked ? (
            <button
              type="button"
              onClick={() => setConfirmOpen(true)}
              disabled={sendBlocked}
              data-testid="hyg-perio-send-open"
              className={cn(
                TAP,
                "inline-flex items-center gap-1.5",
                sendBlocked
                  ? "cursor-not-allowed border-border text-muted-foreground"
                  : "border-primary bg-primary text-primary-foreground",
              )}
            >
              {sendRunning ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              {correcting ? "Send correction" : "Send to Open Dental"}
            </button>
          ) : null}
          {/* ITEM 13: a sent chart is corrected, not unlocked. */}
          {canAmend ? (
            <button
              type="button"
              onClick={() => void onAmend()}
              disabled={amending}
              data-testid="hyg-perio-amend"
              className={cn(TAP, "inline-flex items-center gap-1.5 border-primary text-foreground")}
            >
              <Pencil size={14} /> Amend chart
            </button>
          ) : null}
          {correcting ? (
            <button
              type="button"
              onClick={() => void onCancelAmend()}
              disabled={amending || sendRunning}
              data-testid="hyg-perio-amend-cancel"
              className={cn(TAP, "inline-flex items-center gap-1.5 border-border text-muted-foreground")}
            >
              Cancel correction
            </button>
          ) : null}
        </div>
      </header>

      <p className="mt-1 text-xs text-muted-foreground" data-testid="hyg-perio-stage-note">
        {stageNote}
      </p>
      {stageMessage ? (
        <p className="mt-1 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400" data-testid="hyg-perio-stage-refused">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          {stageMessage}
        </p>
      ) : null}
      {saveError ? (
        <p className="mt-1 text-xs text-destructive" data-testid="hyg-perio-save-error">
          {saveError} — the readings on screen are not stored yet.
        </p>
      ) : null}

      {send?.send ? (
        <div className="mt-3">
          <PerioSendPanel
            response={send}
            running={sendRunning}
            error={sendError}
            canRestage={staged?.state === "Failed"}
            onContinue={() => void runSend(() => stepPerioSend(office, aptNum))}
            onDelete={() => {
              setDeleteError(null);
              setDeleteOpen(true);
            }}
            onRestage={() => void onRestage()}
            onRemoveReplaced={
              replacedStillThere ? () => void onRemoveReplaced(live.supersedesExamNum as number) : null
            }
          />
        </div>
      ) : sendError ? (
        <p className="mt-2 text-xs text-destructive" data-testid="hyg-perio-send-error">
          {sendError}
        </p>
      ) : null}

      <div className="mt-3">
        <PriorPanel
          prior={prior}
          onRetry={() => void loadPrior()}
          skipSuggestion={skipSuggestion}
          onSkipTeeth={(teeth) => act({ type: "skipTeeth", teeth })}
        />
      </div>

      <div className="mt-3">
        <PerioGrid
          chart={entry.chart}
          prior={priorChart}
          cursor={cursor}
          lastEntered={entry.lastEntered}
          onSelect={(c) => act({ type: "select", cursor: c })}
          onKeyDown={onKeyDown}
          gridRef={gridRef}
          failedTeeth={mismatchTeeth}
        />
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-[1.4fr_1fr_1fr]">
        <section className="rounded-xl border border-border p-3" data-testid="hyg-perio-keypad">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-sm font-semibold text-foreground" data-testid="hyg-perio-cursor">
              #{cursor.tooth} {cursor.surface}{" "}
              <span className="font-normal text-muted-foreground">{perioSideOf(cursor.surface)}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              {cursorSkipped
                ? `#${cursor.tooth} is skipped — X to chart it`
                : priorChart
                  ? `Last exam: ${priorAtCursor ?? "-"}`
                  : null}
            </p>
          </div>
          <div className="mt-2 grid grid-cols-10 gap-1">
            {Array.from({ length: 20 }, (_, depth) => (
              <button
                key={depth}
                type="button"
                onClick={() => act({ type: "depth", depth })}
                disabled={cursorSkipped || locked}
                data-testid={`hyg-perio-key-${depth}`}
                className={cn(
                  "h-11 rounded-md border border-border text-sm font-semibold tabular-nums hover:bg-accent/50 disabled:opacity-40",
                  depth >= 10 && "text-xs text-muted-foreground",
                )}
              >
                {depth}
              </button>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button type="button" onClick={() => act({ type: "move", step: -1 })} className={cn(TAP, "border-border")}>
              ← Back
            </button>
            <button type="button" onClick={() => act({ type: "move", step: 1 })} className={cn(TAP, "border-border")}>
              Next →
            </button>
            <button type="button" onClick={() => act({ type: "erase" })} disabled={locked} className={cn(TAP, "border-border disabled:opacity-40")}>
              Undo last
            </button>
            <button
              type="button"
              onClick={() => act({ type: "toggleSkip" })}
              disabled={locked}
              className={cn(TAP, "border-border disabled:opacity-40")}
              data-testid="hyg-perio-toggle-skip"
            >
              {cursorSkipped ? `Chart #${cursor.tooth}` : `Skip #${cursor.tooth}`}
            </button>
          </div>
        </section>

        <section className="rounded-xl border border-border p-3" data-testid="hyg-perio-flags">
          <p className="text-sm font-semibold text-foreground">Flags</p>
          <p className="text-xs text-muted-foreground" data-testid="hyg-perio-flag-target">
            On #{target.tooth} {target.surface}
            {entry.lastEntered ? " — the reading just entered" : ""}
          </p>
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            {PERIO_FLAGS.map((flag) => (
              <button
                key={flag}
                type="button"
                aria-pressed={targetSite[flag]}
                onClick={() => act({ type: "flag", flag })}
                disabled={locked}
                data-testid={`hyg-perio-flag-${flag}`}
                className={cn(
                  TAP,
                  "flex items-center justify-between disabled:opacity-60",
                  targetSite[flag]
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground",
                )}
              >
                {PERIO_FLAG_LABELS[flag]}
                <kbd className="rounded border border-border px-1 text-[10px]">{PERIO_FLAG_KEYS[flag]}</kbd>
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
            Keys: 0–9 depth · Shift+0–9 for 10–19 · → or Space next · ← back · Backspace undo · X skip
            tooth. Recession, mobility, furcation and CAL are not charted here.
          </p>
        </section>

        <section className="rounded-xl border border-border p-3" data-testid="hyg-perio-sweep">
          <p className="text-sm font-semibold text-foreground">Entry order</p>
          <p className="text-xs text-muted-foreground">Which way each sweep moves across the screen.</p>
          <div className="mt-2 space-y-1.5">
            {PERIO_SEGMENTS.map((segment) => (
              <div key={segment.id} className="flex items-center justify-between gap-2">
                <span className="text-sm text-foreground">{segment.label}</span>
                <div className="flex gap-1">
                  {(["ltr", "rtl"] as const).map((direction) => (
                    <button
                      key={direction}
                      type="button"
                      aria-pressed={entry.chart.sweep[segment.id] === direction}
                      onClick={() => act({ type: "sweep", segment: segment.id, direction })}
                      disabled={locked}
                      data-testid={`hyg-perio-sweep-${segment.id}-${direction}`}
                      aria-label={`${segment.label}: ${direction === "ltr" ? "left to right" : "right to left"}`}
                      className={cn(
                        "h-11 w-11 rounded-md border text-base disabled:opacity-60",
                        entry.chart.sweep[segment.id] === direction
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border text-muted-foreground",
                      )}
                    >
                      {direction === "ltr" ? "→" : "←"}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      {staged && isStaged ? (
        <PerioSendConfirm
          open={confirmOpen}
          write={staged}
          chart={entry.chart}
          patientName={appointment?.patientName ?? "this patient"}
          examDate={date}
          providerLabel={providerLabel}
          busy={sendRunning}
          // Item 13: a correction names what it changes, and what it replaces.
          replacesExamNum={correcting ? live?.examNum ?? null : null}
          changes={corrections}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => {
            if (provNum === null) return;
            setConfirmOpen(false);
            const fingerprint = staged.previewFingerprint;
            void runSend(() =>
              startPerioSend(office, aptNum, date, { previewFingerprint: fingerprint, examDate: date, provNum }),
            );
          }}
        />
      ) : null}

      {send?.send && send.send.canDelete ? (
        <PerioDeleteExamDialog
          open={deleteOpen}
          send={send.send}
          busy={deleting}
          error={deleteError}
          onCancel={() => setDeleteOpen(false)}
          onConfirm={(examNum) => void onDeleteExam(examNum)}
        />
      ) : null}
    </div>
  );
}

/**
 * /hyg/visit/:aptNum — the visit workspace (H1 slice 2).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * DESIGNED FOR AN iPAD IN LANDSCAPE, HELD AT ARM'S LENGTH, STANDING UP
 * ═════════════════════════════════════════════════════════════════════════════
 * 1180 × 820. Two columns: the work on the left, what will be written on the
 * right. Not tabs — the prototype's six tabs meant a hygienist could stage a
 * slip without ever seeing what was on it, and the thing being composed here
 * ends up in somebody's chart. Every touch target is at least 44px.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * NOTHING IS RENDERED THAT WAS NOT FETCHED AND AUDITED
 * ═════════════════════════════════════════════════════════════════════════════
 * The patient header comes from THIS page's own request, which wrote its own
 * audit rows server-side. Slice 1's placeholder deliberately showed no patient
 * details for exactly this reason: the day view has the name in memory and
 * passing it through would have put PHI on a screen with no trail behind it.
 *
 * The flags are the day view's flags, with the same three states. A `null`
 * renders as "unknown" and never as "no" — this is the last screen before
 * somebody puts instruments in a mouth.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE SERVER OWNS THE VISIT. THIS PAGE RENDERS WHAT IT ANSWERS.
 * ═════════════════════════════════════════════════════════════════════════════
 * Every mutation returns the whole visit, read back from the database, and that
 * is what goes into state — never the value that was sent. A save that silently
 * did nothing must not look like a save that worked.
 *
 * The visit ROW is created lazily, on the first change. A GET creates nothing,
 * so glancing at a card leaves no visit behind for a patient nobody worked on.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ONE THING ON THIS PAGE REACHES A CHART (H1 slice 3)
 * ═════════════════════════════════════════════════════════════════════════════
 * The Send button, and only after a confirmation that shows the exact lines
 * being written. What goes back to the server is a FINGERPRINT of those lines,
 * never a payload — the server recomputes it from its own rows and refuses the
 * whole send if they differ, so a second tab or a second device cannot make
 * this page confirm words nobody read.
 *
 * A 200 from that call does not mean everything landed. Partial success is
 * normal, and the tray renders each write's own state.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * A STAGED PERIO CHART RIDES THE SAME SEND (item 15)
 * ═════════════════════════════════════════════════════════════════════════════
 * One dialog, one Send. The server runs the chart's confirm before any unit
 * writes and its first step in the same request; if the chart needs more steps
 * (readings of 10+, gaps), this page asks for them through the chart's own step
 * route, exactly as the chart page does — so every write still happens inside a
 * request the confirming person made. Leaving stops asking; Retry carries on the
 * same send, and it reads Open Dental before it writes anything.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE ORTHO SCREENING IS A SECOND TAB, AND IT SENDS ON ITS OWN (item 33)
 * ═════════════════════════════════════════════════════════════════════════════
 * The work column has two tabs: the visit (note, slip, treatment — unchanged)
 * and the ortho screening. The tray stays beside both, so nothing that reaches
 * a chart is ever composed out of sight. The screening reaches no chart: its
 * "Send to TC" button sends immediately, because the TC may want to catch the
 * patient before they leave. It flushes the slip's pending autosave first, so
 * the sheet TC gets is the sheet on screen, and it renders "Sent" only from the
 * server's `orthoSend`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearch } from "wouter";
import { AlertTriangle, ArrowLeft, HelpCircle, Loader2, RefreshCw } from "lucide-react";

import {
  emptySlip,
  isOfficeId,
  type HygSlip,
  type SendConfirmation,
  type StagedWrite,
  type StagedWriteKind,
  type TreatmentItemInput,
} from "@shared/hyg/contract";
import {
  addTreatmentItem,
  fetchExistingTx,
  fetchPerio,
  fetchPerioSend,
  fetchVisit,
  HygApiError,
  openVisit,
  removeTreatmentItem,
  retryStagedWrite,
  saveExistingTxBatch,
  saveExistingTxDisposition,
  saveSlip,
  sendOrthoScreening,
  alertCheckout,
  finalizeCheckout,
  sendVisit,
  stageWrite,
  stepPerioSend,
  unstageWrite,
  updateTreatmentItem,
  type HygVisitMutation,
  type HygVisitPage,
} from "@/features/hyg/api";
import { formatClock, formatLength, todayIso, visibleFlags } from "@/features/hyg/day";
import { suggestVisitType } from "@shared/hyg/noteTemplates";
import type { PerioCounts } from "@shared/hyg/perio";
import type { HygPerioSendResponse } from "@shared/hyg/perioSend";
import { perioProvNumOf } from "@/features/hyg/perio/PerioSendConfirm";
import { RouterSlip } from "@/features/hyg/visit/RouterSlip";
import { VisitNoteFields } from "@/features/hyg/visit/VisitNoteFields";
import { StagedWritesTray, type TrayPerio } from "@/features/hyg/visit/StagedWritesTray";
import { TreatmentItems } from "@/features/hyg/visit/TreatmentItems";
import { ExistingTreatment, type ExistingTxState } from "@/features/hyg/visit/ExistingTreatment";
import {
  countNotDiscussed,
  type ExistingTxDisposition,
  type ExistingTxDispositionInput,
} from "@shared/hyg/existingTx";
import { OrthoScreening } from "@/features/hyg/visit/OrthoScreening";
import { CheckoutAlert } from "@/features/hyg/visit/CheckoutAlert";
import type { OrthoScreening as OrthoScreeningValue } from "@shared/hyg/orthoScreening";
import type { CheckoutDelivery } from "@shared/hyg/contract";
import { cn } from "@/lib/utils";
import { VisitReferral } from "@/features/hyg/visit/VisitReferral";

/** How long after the last keystroke the slip is stored. */
const SAVE_DEBOUNCE_MS = 800;

/** Slice 2a: the section's failure sentence, whatever failed. */
const EXISTING_TX_UNAVAILABLE = "Couldn't load existing treatment from Open Dental";
/** The staged-write states that lock the existing-treatment answers (the server's rule). */
const EXISTING_TX_LOCKING: ReadonlySet<string> = new Set(["Sending", "Written", "Failed", "Amending"]);
/** The staged writes that carry the existing-treatment answers (the server's FREEZING_KINDS). */
const EXISTING_TX_CARRIERS: ReadonlySet<string> = new Set(["router", "note", "tc-handoff"]);

function Chip({ label, tone }: { label: string; tone: "alert" | "unknown" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium",
        tone === "alert"
          ? "bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-300"
          : // Deliberately not green and not the same as any "fine" styling
            // anywhere in this app. Unknown is a question, not a pass.
            "border border-dashed border-muted-foreground/40 text-muted-foreground",
      )}
      data-testid={`hyg-visit-flag-${tone}`}
    >
      {tone === "alert" ? <AlertTriangle size={12} /> : <HelpCircle size={12} />}
      {label}
    </span>
  );
}

/**
 * The visit type, pre-picked from the appointment when it maps cleanly.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THIS ONLY EVER TOUCHES THE DRAFT, AND A STORED ANSWER ALWAYS WINS
 * ═════════════════════════════════════════════════════════════════════════════
 * When the appointment type reads cleanly the type comes up already chosen and
 * marked `auto`, and the form says where it came from — that is most of the
 * "eight taps" this slice is for.
 *
 * It is NOT saved on its own. A GET creates no visit row (see the header
 * above), and auto-saving a suggestion would leave a visit behind for every
 * card somebody merely glanced at. It rides in the draft and is stored with
 * her first real edit.
 *
 * A slip that already carries a `visitType` is returned untouched: her answer
 * is never re-derived from an appointment label, not even when they disagree.
 * `suggestVisitType` is the same function the backend parity tests state the
 * whole mapping with — one rule, not two.
 */
function withSuggestedType(slip: HygSlip, appointment: HygVisitPage["appointment"]): HygSlip {
  if (slip.visitType !== null) return slip;
  const suggested = suggestVisitType({
    apptTypeLabel: appointment.apptTypeLabel,
    isNewPatient: appointment.isNewPatient,
  });
  return suggested === null
    ? slip
    : { ...slip, visitType: suggested, visitTypeSource: "auto" };
}

function VisitHeader({ page }: { page: HygVisitPage }) {
  const appt = page.appointment;
  const flags = visibleFlags(appt.flags);
  const alerts = flags.filter((f) => f.tone === "alert");
  const unknowns = flags.filter((f) => f.tone === "unknown");
  const clock = formatClock(appt.start);
  const length = formatLength(appt.lengthMin);

  return (
    <header
      className="flex flex-wrap items-start justify-between gap-3"
      data-testid="hyg-visit-header"
    >
      <div className="min-w-0">
        <h1
          className="text-2xl font-bold tracking-tight text-foreground"
          style={{ fontFamily: "Sora, sans-serif" }}
        >
          {appt.patientName ?? (
            <span className="font-normal italic text-muted-foreground">Name unavailable</span>
          )}
        </h1>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-muted-foreground">
          <span className="tabular-nums">{clock ?? "Time not recorded"}</span>
          {length ? <span aria-hidden>·</span> : null}
          {length ? <span>{length}</span> : null}
          <span aria-hidden>·</span>
          <span>{appt.apptTypeLabel ?? "Visit type not recorded"}</span>
          <span aria-hidden>·</span>
          <span>{page.officeName}</span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {alerts.map((f) => (
          <Chip key={f.key} label={f.label} tone="alert" />
        ))}
        {unknowns.length > 0 ? (
          // Collapsed into ONE chip rather than five: five dashed chips on
          // every visit would train everyone to stop reading the row.
          <Chip
            label={
              unknowns.length === 1 ? `${unknowns[0].label} unknown` : `${unknowns.length} unknown`
            }
            tone="unknown"
          />
        ) : null}
      </div>
    </header>
  );
}

export default function HygVisit() {
  const params = useParams<{ aptNum: string }>();
  const search = useSearch();
  const aptNum = Number(params.aptNum);

  // Office and date come off the query string the day view links with. They are
  // an INPUT here, validated server-side against the frozen office list before
  // anything is read — the same shape the day route uses, and for the same
  // reason: a visit has no origin, somebody is asking to see one.
  const query = useMemo(() => new URLSearchParams(search), [search]);
  const office = query.get("office");
  const date = query.get("date") ?? todayIso();

  const [page, setPage] = useState<HygVisitPage | null>(null);
  const [error, setError] = useState<HygApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  /** `kind: null` means the refusal is about the SEND, not one write. */
  const [refusal, setRefusal] = useState<{
    kind: StagedWriteKind | null;
    message: string;
  } | null>(null);
  /** The slip being edited, which may be a keystroke ahead of what is stored. */
  const [draft, setDraft] = useState<HygSlip>(emptySlip());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * ITEM 33: the slip the debounce has not stored yet, and the save in flight.
   * The ortho send reads the STORED screening, so it must not race either.
   */
  const pendingSlip = useRef<HygSlip | null>(null);
  const saveInFlight = useRef<Promise<void> | null>(null);
  const [tab, setTab] = useState<"visit" | "ortho">("visit");
  const [orthoSending, setOrthoSending] = useState(false);
  const [orthoError, setOrthoError] = useState<string | null>(null);
  /** Item 49: the checkout alert's own request, and what the last Send said about it. */
  const [checkoutSending, setCheckoutSending] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [checkoutDelivery, setCheckoutDelivery] = useState<CheckoutDelivery | null>(null);
  /**
   * The tray, so the end of the form can point at it.
   *
   * Beau, at the bottom of the page: "I do not know where to go or what to do
   * next." On iPad landscape the tray is beside the form and sticky, so it is
   * already in view; narrower than that it is below, and this is how the form
   * ends up pointing somewhere instead of stopping.
   */
  const trayRef = useRef<HTMLElement | null>(null);

  /**
   * ITEM 15: the perio chart's own record — where its send stands, whether it is
   * a correction, and how many sites it charts. Our database only, read when the
   * visit has a chart on it.
   */
  const [perioSend, setPerioSend] = useState<HygPerioSendResponse | null>(null);
  const [perioCounts, setPerioCounts] = useState<PerioCounts | null>(null);
  const [perioRunning, setPerioRunning] = useState(false);
  const [perioPaused, setPerioPaused] = useState<string | null>(null);
  /** Stops the step loop when the page goes away — leaving pauses, it does not lose. */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!isOfficeId(office)) return;
      try {
        const next = await fetchVisit(office, aptNum, date, signal);
        setPage(next);
        setDraft(
          withSuggestedType(next.visit ? next.visit.slip : emptySlip(), next.appointment),
        );
        setError(null);
      } catch (err) {
        if (signal?.aborted) return;
        setError(
          err instanceof HygApiError ? err : new HygApiError("Could not load the visit", 0, null),
        );
      }
    },
    [office, aptNum, date],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

  /** Adopt a mutation's readback. The SERVER's answer, never the value sent. */
  const adopt = useCallback((res: HygVisitMutation) => {
    setPage((prev) =>
      prev
        ? {
            ...prev,
            visit: res.visit,
            recordsNeeded: res.recordsNeeded,
            handoffCategory: res.handoffCategory,
          }
        : prev,
    );
  }, []);

  /**
   * The perio row as a step answered it. The step's `stagedWrite` IS the row, read
   * back — so the tray's pill moves with the chart's own record, never ahead of it.
   */
  const applyPerioStep = useCallback((res: HygPerioSendResponse) => {
    setPerioSend(res);
    setPerioPaused(res.paused);
    const write = res.stagedWrite;
    if (!write) return;
    setPage((prev) =>
      prev && prev.visit
        ? {
            ...prev,
            visit: {
              ...prev.visit,
              stagedWrites: prev.visit.stagedWrites.map((w) => (w.kind === "perio" ? write : w)),
            },
          }
        : prev,
    );
  }, []);

  // Where the chart's send stands, and its counts, whenever its row moves. A
  // failure here costs the perio line, not the visit: without it the chart
  // simply does not ride Send, and the tray says it is still checking.
  const perioWrite = page?.visit?.stagedWrites.find((w) => w.kind === "perio") ?? null;
  const perioKey = perioWrite ? `${perioWrite.state}|${perioWrite.updatedAt}` : null;
  useEffect(() => {
    if (!isOfficeId(office) || perioKey === null) {
      setPerioSend(null);
      setPerioCounts(null);
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const [progress, chart] = await Promise.all([
          fetchPerioSend(office, aptNum, controller.signal),
          fetchPerio(office, aptNum, controller.signal),
        ]);
        if (controller.signal.aborted) return;
        setPerioSend(progress);
        setPerioCounts(chart.counts);
      } catch {
        /* the tray says it is still checking; Send leaves the chart out */
      }
    })();
    return () => controller.abort();
  }, [office, aptNum, perioKey]);

  /**
   * Ask for the chart's next steps until it finishes, stops or pauses — the chart
   * page's loop, run from here. Every step is its own request by this person.
   */
  const runPerioSteps = useCallback(async () => {
    if (!isOfficeId(office)) return;
    setPerioRunning(true);
    setPerioPaused(null);
    try {
      for (;;) {
        const res = await stepPerioSend(office, aptNum);
        if (!mounted.current) return;
        applyPerioStep(res);
        const inFlight = res.send !== null && (res.send.state === "posting" || res.send.state === "filling");
        if (!inFlight || res.paused !== null) break;
      }
    } catch (err) {
      if (mounted.current) {
        setPerioPaused(
          err instanceof HygApiError
            ? err.message
            : "The perio send stopped before Open Dental answered. Nothing is lost; Retry reads before it writes.",
        );
      }
    } finally {
      if (mounted.current) setPerioRunning(false);
    }
  }, [office, aptNum, applyPerioStep]);

  /**
   * SLICE 2a: the existing treatment from Open Dental, and this visit's answers.
   *
   * ONE READ PER VISIT OPEN, keyed on the visit row — the server reads whose
   * plan it is off that row, so there is nothing to read until it exists — plus
   * the section's own Retry. The server caches its read for up to ten minutes, so
   * a reload of this page is not a second trip to the practice either.
   */
  const [existingTx, setExistingTx] = useState<ExistingTxState>({ status: "not_started" });
  const [existingSaving, setExistingSaving] = useState<ReadonlySet<number>>(new Set());
  const [existingErrors, setExistingErrors] = useState<Record<number, string>>({});
  const visitId = page?.visit?.visitId ?? null;

  /**
   * WHICH VISIT A RESPONSE BELONGS TO. A ProcNum is only unique within one
   * patient's chart in one office, so an answer that comes back after the page
   * moved to another visit must not land on a row that happens to share the
   * number. Every read and save checks this before it touches state.
   */
  const existingContext = `${office}|${aptNum}|${visitId ?? ""}`;
  const existingContextRef = useRef(existingContext);
  existingContextRef.current = existingContext;
  /** The newest read wins; an older Retry that answers late is dropped. */
  const existingReadSeq = useRef(0);
  /** One row's saves go out IN ORDER, each after the last has answered. */
  const existingChains = useRef(new Map<number, Promise<void>>());
  const existingPending = useRef(new Map<number, number>());

  const loadExistingTx = useCallback(
    async (refresh: boolean, signal?: AbortSignal) => {
      if (!isOfficeId(office)) return;
      const seq = ++existingReadSeq.current;
      const context = existingContextRef.current;
      const current = () =>
        !signal?.aborted && seq === existingReadSeq.current && context === existingContextRef.current;
      setExistingTx({ status: "loading" });
      try {
        const data = await fetchExistingTx(office, aptNum, { refresh }, signal);
        if (!current()) return;
        setExistingTx({ status: "ready", data });
        setExistingErrors({});
      } catch {
        if (!current()) return;
        // The same sentence whatever failed: the list is not known, and that
        // is the one thing the section must not paper over with "none".
        setExistingTx({ status: "error", message: EXISTING_TX_UNAVAILABLE });
      }
    },
    [office, aptNum],
  );

  useEffect(() => {
    // A different visit starts clean: nothing pending, no row errors.
    existingChains.current = new Map();
    existingPending.current = new Map();
    setExistingSaving(new Set());
    setExistingErrors({});
    if (visitId === null) {
      setExistingTx({ status: "not_started" });
      return;
    }
    const controller = new AbortController();
    void loadExistingTx(false, controller.signal);
    return () => controller.abort();
  }, [visitId, loadExistingTx]);

  /** "Show existing treatment" before the visit exists: start it, then the effect reads. */
  const onStartExistingTx = useCallback(async () => {
    if (!isOfficeId(office)) return;
    setExistingTx({ status: "loading" });
    try {
      adopt(await openVisit(office, aptNum, date));
    } catch {
      setExistingTx({ status: "error", message: EXISTING_TX_UNAVAILABLE });
    }
  }, [office, aptNum, date, adopt]);

  /**
   * The out-of-date flags as the server read them back after an answer was
   * saved. The tray's "Out of date" is the SERVER's digest comparison, carried
   * here — never worked out on this page.
   *
   * ONLY THE FLAGS, AND ONLY ONTO THE SAME ROW. A save is not serialized against
   * Stage or Remove, so its read-back may predate a stage that answered first;
   * replacing the list with it would drop or rewind that row. A flag is copied
   * only onto the row it was computed for — same id, same updatedAt — and the
   * rows themselves stay whatever the page last adopted.
   */
  const adoptStagedWrites = useCallback((stagedWrites: StagedWrite[]) => {
    const seen = new Map(stagedWrites.map((w) => [w.id, w]));
    setPage((prev) =>
      prev && prev.visit
        ? {
            ...prev,
            visit: {
              ...prev.visit,
              stagedWrites: prev.visit.stagedWrites.map((w) => {
                const read = seen.get(w.id);
                return read && read.updatedAt === w.updatedAt && read.existingTxStale !== undefined
                  ? { ...w, existingTxStale: read.existingTxStale }
                  : w;
              }),
            },
          }
        : prev,
    );
  }, []);

  /**
   * Store answers — one row, or many at once (a group answered together, or the
   * "Select" bulk answer). The rows show the SERVER's read-back, never the tap.
   *
   * QUEUED PER ROW. A save waits for every earlier save of each row it touches,
   * so quick taps reach the server in the order they were made and the last one
   * is what is stored — whether it went alone or in a batch. One row goes
   * through the single PUT; several go through the bulk PUT, which the server
   * stores all or nothing.
   */
  const queueExistingTx = useCallback(
    (entries: { procNum: number; input: ExistingTxDispositionInput }[]) => {
      if (!isOfficeId(office) || entries.length === 0) return;
      const chains = existingChains.current;
      const pending = existingPending.current;
      const context = existingContextRef.current;
      // A queue from before a visit change: nothing it says applies any more.
      const live = () => chains === existingChains.current && context === existingContextRef.current;
      const procNums = entries.map((e) => e.procNum);

      for (const procNum of procNums) pending.set(procNum, (pending.get(procNum) ?? 0) + 1);
      setExistingSaving((prev) => {
        const next = new Set(prev);
        for (const procNum of procNums) next.add(procNum);
        return next;
      });

      const saveAll = async () => {
        if (!live()) return;
        setExistingErrors((prev) => {
          const next = { ...prev };
          for (const procNum of procNums) delete next[procNum];
          return next;
        });
        try {
          const stored = new Map<number, ExistingTxDisposition>();
          let stagedWrites: StagedWrite[];
          if (entries.length === 1) {
            const res = await saveExistingTxDisposition(office, aptNum, entries[0].procNum, entries[0].input);
            stored.set(res.procNum, res.disposition);
            stagedWrites = res.stagedWrites;
          } else {
            const res = await saveExistingTxBatch(
              office,
              aptNum,
              entries.map((e) => ({ procNum: e.procNum, ...e.input })),
            );
            for (const row of res.items) stored.set(row.procNum, row.disposition);
            stagedWrites = res.stagedWrites;
          }
          if (!live()) return;
          setExistingTx((prev) =>
            prev.status === "ready"
              ? {
                  ...prev,
                  data: {
                    ...prev.data,
                    items: prev.data.items.map((i) => {
                      const d = stored.get(i.procNum);
                      return d ? { ...i, disposition: d } : i;
                    }),
                  },
                }
              : prev,
          );
          adoptStagedWrites(stagedWrites);
        } catch (err) {
          if (!live()) return;
          if (err instanceof HygApiError && err.code === "EXISTING_TX_FROZEN") {
            setExistingTx((prev) =>
              prev.status === "ready" ? { ...prev, data: { ...prev.data, frozen: true } } : prev,
            );
          }
          const message =
            err instanceof HygApiError
              ? err.message
              : entries.length === 1
                ? "That answer was not saved. Try again."
                : "Those answers were not saved. Try again.";
          setExistingErrors((prev) => {
            const next = { ...prev };
            for (const procNum of procNums) next[procNum] = message;
            return next;
          });
        } finally {
          const done: number[] = [];
          for (const procNum of procNums) {
            const left = (pending.get(procNum) ?? 1) - 1;
            pending.set(procNum, left);
            if (left === 0) done.push(procNum);
          }
          if (done.length > 0 && live()) {
            setExistingSaving((prev) => {
              const next = new Set(prev);
              for (const procNum of done) next.delete(procNum);
              return next;
            });
          }
        }
      };
      const before = Promise.all(procNums.map((n) => chains.get(n) ?? Promise.resolve()));
      const mine = before.then(saveAll);
      for (const procNum of procNums) chains.set(procNum, mine);
    },
    [office, aptNum, adoptStagedWrites],
  );

  const onSaveExistingTx = useCallback(
    (procNum: number, input: ExistingTxDispositionInput) => queueExistingTx([{ procNum, input }]),
    [queueExistingTx],
  );

  /**
   * Run a mutation, making sure the visit exists first.
   *
   * `open` is idempotent by the database's own UNIQUE (office, apt_num), so
   * calling it before a mutation cannot produce a second visit — which is what
   * lets this page create lazily without tracking whether it already has.
   */
  const run = useCallback(
    async (fn: () => Promise<HygVisitMutation>) => {
      if (!isOfficeId(office) || !page) return;
      setBusy(true);
      setRefusal(null);
      try {
        if (!page.visit) await openVisit(office, aptNum, date);
        const res = await fn();
        adopt(res);
        // Through the same helper: adding a treatment item before touching the
        // slip must not silently un-pick the visit type she can see.
        setDraft(withSuggestedType(res.visit.slip, page.appointment));
      } catch (err) {
        if (err instanceof HygApiError) setError(err);
      } finally {
        setBusy(false);
      }
    },
    [office, aptNum, date, page, adopt],
  );

  /** Store the slip after a pause, so every keystroke is not a round trip. */
  const onSlipChange = useCallback(
    (next: HygSlip) => {
      setDraft(next);
      pendingSlip.current = next;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        if (!isOfficeId(office)) return;
        pendingSlip.current = null;
        setSaving(true);
        const saving = (async () => {
          try {
            if (!page?.visit) await openVisit(office, aptNum, date);
            adopt(await saveSlip(office, aptNum, next));
          } catch (err) {
            if (err instanceof HygApiError) setError(err);
          } finally {
            setSaving(false);
          }
        })();
        saveInFlight.current = saving;
        void saving.finally(() => {
          if (saveInFlight.current === saving) saveInFlight.current = null;
        });
      }, SAVE_DEBOUNCE_MS);
    },
    [office, aptNum, date, page, adopt],
  );

  /** A screening change is a slip change: it autosaves exactly like the rest. */
  const onOrthoChange = useCallback(
    (next: OrthoScreeningValue) => onSlipChange({ ...draft, orthoScreening: next }),
    [draft, onSlipChange],
  );

  /**
   * Send the screening to TC, NOW (item 33).
   *
   * First the slip: a debounced save that has not fired is stored here, and one
   * in flight is waited for — the server sends the STORED screening, so sending
   * before the store would file a case from a sheet one tap behind the screen.
   * Then the send, whose answer is the visit read back: "Sent" is
   * `visit.orthoSend`, set only after TC answered with a case.
   */
  const onOrthoSend = useCallback(async () => {
    if (!isOfficeId(office) || !page) return;
    setOrthoSending(true);
    setOrthoError(null);
    try {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = null;
      if (saveInFlight.current) await saveInFlight.current;
      const unsaved = pendingSlip.current;
      pendingSlip.current = null;
      if (!page.visit) await openVisit(office, aptNum, date);
      if (unsaved) adopt(await saveSlip(office, aptNum, unsaved));
      const res = await sendOrthoScreening(office, aptNum);
      adopt(res);
      setDraft(withSuggestedType(res.visit.slip, page.appointment));
    } catch (err) {
      // TC down, a refusal, a timeout: said here, beside the button, in words.
      // The sheet stays as it is on screen and stays editable.
      setOrthoError(
        err instanceof HygApiError
          ? err.message
          : "The screening was not sent to the TC. It is saved here; try again.",
      );
    } finally {
      setOrthoSending(false);
    }
  }, [office, aptNum, date, page, adopt]);

  /**
   * "Alert checkout", NOW (item 49).
   *
   * The ortho send's order, for the ortho send's reason: the server builds the
   * snapshot from the STORED visit, so a debounced save that has not fired is
   * stored first and one in flight is waited for. "Alerted" renders from
   * `visit.checkoutSend`, written only after TC answered with a handoff.
   */
  const onCheckoutAlert = useCallback(async () => {
    if (!isOfficeId(office) || !page) return;
    setCheckoutSending(true);
    setCheckoutError(null);
    try {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = null;
      if (saveInFlight.current) await saveInFlight.current;
      const unsaved = pendingSlip.current;
      pendingSlip.current = null;
      if (!page.visit) await openVisit(office, aptNum, date);
      if (unsaved) adopt(await saveSlip(office, aptNum, unsaved));
      adopt(await alertCheckout(office, aptNum));
    } catch (err) {
      setCheckoutError(
        err instanceof HygApiError
          ? err.message
          : "Checkout was not alerted. Nothing is lost on this visit; try again.",
      );
    } finally {
      setCheckoutSending(false);
    }
  }, [office, aptNum, date, page, adopt]);

  /** Re-send ONLY the final checkout snapshot, after a Send whose update did not land. */
  const onCheckoutRetryFinal = useCallback(async () => {
    if (!isOfficeId(office)) return;
    setCheckoutSending(true);
    setCheckoutError(null);
    try {
      adopt(await finalizeCheckout(office, aptNum));
      setCheckoutDelivery(null);
    } catch (err) {
      setCheckoutError(
        err instanceof HygApiError
          ? err.message
          : "Checkout still did not get your final notes. Try again.",
      );
    } finally {
      setCheckoutSending(false);
    }
  }, [office, aptNum, adopt]);

  const onStage = useCallback(
    async (kind: StagedWriteKind) => {
      if (!isOfficeId(office) || !page) return;
      setBusy(true);
      setRefusal(null);
      try {
        if (!page.visit) await openVisit(office, aptNum, date);
        adopt(await stageWrite(office, aptNum, kind));
      } catch (err) {
        // A refusal to stage is about the CONTENT — there is nothing of that
        // kind to send, or it has already gone — so it belongs beside the thing
        // that was refused, not as a page-level error that hides the visit.
        if (err instanceof HygApiError && (err.status === 422 || err.status === 409)) {
          setRefusal({ kind, message: err.message });
        } else if (err instanceof HygApiError) {
          setError(err);
        }
      } finally {
        setBusy(false);
      }
    },
    [office, aptNum, date, page, adopt],
  );

  /**
   * Send the confirmed writes.
   *
   * A 200 is NOT "it worked" — partial success is the normal case, and the tray
   * renders each write's own state from the readback. The only thing handled
   * specially here is the 409 the server answers when the preview changed, which
   * stopped everything and belongs beside the Send button rather than on a row.
   */
  const onSend = useCallback(
    async (confirm: SendConfirmation[]) => {
      if (!isOfficeId(office) || !page) return;
      setSending(true);
      setRefusal(null);
      let perioContinues = false;
      try {
        const res = await sendVisit(office, aptNum, date, confirm);
        adopt(res);
        // Item 49: the handoff rode the Send; say what happened to it.
        setCheckoutDelivery(res.checkout);
        // THE CHART'S FIRST STEP RAN IN THAT REQUEST. If it is still Sending, the
        // rest are ours to ask for — unless it paused, which the row now says.
        const perio = res.outcomes.find((o) => o.kind === "perio");
        if (perio && perio.state === "Sending") {
          if (perio.code === "PERIO_PAUSED") setPerioPaused(perio.errorMessage);
          else perioContinues = true;
        }
      } catch (err) {
        // 409 and 422 are both refusals of the WHOLE send — a stale preview, a
        // changed exam date or provider, a correction — and nothing was written.
        if (err instanceof HygApiError && (err.status === 409 || err.status === 422)) {
          setRefusal({ kind: null, message: err.message });
          // Re-read: the server refused because its rows differ from what this
          // page is showing, so what this page is showing is the stale half.
          await load();
        } else if (err instanceof HygApiError) {
          setError(err);
        }
      } finally {
        setSending(false);
      }
      if (perioContinues) await runPerioSteps();
    },
    [office, aptNum, date, page, adopt, load, runPerioSteps],
  );

  /**
   * Retry on the perio row. Two different acts behind one word, chosen by the
   * row's state, and neither can put a second exam in Open Dental:
   *   Sending — the SAME send carries on: its next step reads Open Dental first,
   *             so an exam the interrupted send created is adopted, not re-posted.
   *   Failed  — the chart goes back on the list, which the server allows only when
   *             that send left nothing in Open Dental. A refusal says so here.
   */
  const onRetryPerio = useCallback(async () => {
    if (!isOfficeId(office)) return;
    const write = page?.visit?.stagedWrites.find((w) => w.kind === "perio");
    if (!write) return;
    setRefusal(null);
    if (write.state === "Sending") {
      await runPerioSteps();
      return;
    }
    setBusy(true);
    try {
      adopt(await retryStagedWrite(office, aptNum, "perio"));
    } catch (err) {
      if (err instanceof HygApiError && (err.status === 409 || err.status === 422)) {
        setRefusal({ kind: "perio", message: err.message });
      } else if (err instanceof HygApiError) {
        setError(err);
      }
    } finally {
      setBusy(false);
    }
  }, [office, aptNum, page, adopt, runPerioSteps]);

  const backHref = `/hyg/day${office ? `?office=${office}&date=${date}` : ""}`;

  if (!isOfficeId(office)) {
    return (
      <div className="p-6" data-testid="hyg-visit-no-office">
        <Link
          href="/hyg/day"
          className="inline-flex min-h-11 items-center gap-1.5 text-sm text-muted-foreground"
        >
          <ArrowLeft size={16} /> Back to the day
        </Link>
        <h1 className="mt-4 text-xl font-semibold text-foreground">Which office is this?</h1>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">
          A visit belongs to one location — an appointment number means a different appointment
          in each practice&apos;s Open Dental database. Open this from the day view and it brings
          the office with it.
        </p>
      </div>
    );
  }

  if (error && page === null) {
    return (
      <div className="p-6" data-testid="hyg-visit-error">
        <Link
          href={backHref}
          className="inline-flex min-h-11 items-center gap-1.5 text-sm text-muted-foreground"
        >
          <ArrowLeft size={16} /> Back to the day
        </Link>
        <div className="mt-4 max-w-2xl rounded-2xl border border-destructive/40 bg-destructive/5 p-4">
          <p className="text-sm font-medium text-destructive">{error.message}</p>
          {error.code ? <p className="mt-1 text-xs text-muted-foreground">{error.code}</p> : null}
          <button
            type="button"
            onClick={() => void load()}
            className="mt-3 inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 text-sm"
            data-testid="hyg-visit-retry"
          >
            <RefreshCw size={14} /> Try again
          </button>
        </div>
      </div>
    );
  }

  if (page === null) {
    return (
      <div
        className="flex items-center gap-2 p-6 text-sm text-muted-foreground"
        data-testid="hyg-visit-loading"
        aria-busy="true"
      >
        <Loader2 size={16} className="animate-spin" /> Loading the visit…
      </div>
    );
  }

  const items = page.visit?.items ?? [];
  const staged = page.visit?.stagedWrites ?? [];

  // The answers lock the moment the note, slip or TC handoff — the three writes
  // that carry them — leaves Draft/Staged. Read off the tray's own rows, so a
  // Send pressed on this page locks them without a re-read. The server refuses
  // an edit (409) either way; this is the screen saying so first.
  const existingLocked = staged.some(
    (w) => EXISTING_TX_CARRIERS.has(w.kind) && EXISTING_TX_LOCKING.has(w.state),
  );
  const existingTxShown: ExistingTxState =
    existingTx.status === "ready" && existingLocked && !existingTx.data.frozen
      ? { ...existingTx, data: { ...existingTx.data, frozen: true } }
      : existingTx;

  // ITEM 15: can the staged chart ride Send? Only when its own record has been
  // read (a correction and an in-flight send are both on it), and only with a
  // provider to file the exam under.
  const perioProvNum = perioProvNumOf(page.appointment);
  const perioExamDate = page.visit?.visitDate ?? date;
  const perioLive = perioSend?.live ?? null;
  const perioInFlight =
    perioSend?.send != null && (perioSend.send.state === "posting" || perioSend.send.state === "filling");
  const perioBlocked =
    perioSend === null
      ? null
      : perioLive !== null
        ? null
        : perioInFlight
          ? "This chart is already being sent. Open the chart to follow it."
          : perioProvNum === null
            ? "This appointment has no provider in Open Dental, so the exam cannot be filed under whoever charted it. Send leaves the chart here."
            : null;
  const trayPerio: TrayPerio = {
    sendable:
      perioWrite?.state === "Staged" && perioSend !== null && perioLive === null && perioBlocked === null,
    blockedReason: perioBlocked,
    correctionOf: perioLive?.examNum ?? null,
    sitesCharted: perioCounts?.sitesCharted ?? null,
    sitesExpected: perioCounts?.sitesExpected ?? null,
    examDate: perioExamDate,
    provNum: perioProvNum,
    providerLabel: `${page.appointment.providerName ?? "Provider"} (ProvNum ${perioProvNum ?? "none"})`,
    running: perioRunning,
    paused: perioPaused,
  };
  // Recomputed for the form's own wording ("chosen from the appointment type"),
  // from the appointment this page already fetched. It never overrides `draft`.
  const suggestion = suggestVisitType({
    apptTypeLabel: page.appointment.apptTypeLabel,
    isNewPatient: page.appointment.isNewPatient,
  });

  return (
    <div className="p-6" data-testid="hyg-visit">
      <div className="flex items-center justify-between gap-3">
        <Link
          href={backHref}
          className="inline-flex min-h-11 items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={16} /> Back to the day
        </Link>
        <span className="text-xs text-muted-foreground" data-testid="hyg-visit-save-state">
          {saving ? "Saving…" : page.visit ? "Saved" : "Nothing saved yet"}
        </span>
      </div>

      <div className="mt-3">
        <VisitHeader page={page} />
      </div>

      {error ? (
        <div
          className="mt-3 rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
          data-testid="hyg-visit-inline-error"
        >
          {error.message}
        </div>
      ) : null}

      <div className="mt-4 flex flex-col gap-4 lg:flex-row">
        <div className="min-w-0 flex-1 space-y-6">
          {page.checkoutEnabled ? (
            <CheckoutAlert
              sent={page.visit?.checkoutSend ?? null}
              sending={checkoutSending}
              error={checkoutError}
              delivery={checkoutDelivery}
              onAlert={() => void onCheckoutAlert()}
              onRetryFinal={() => void onCheckoutRetryFinal()}
            />
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
          <div
            role="tablist"
            aria-label="Visit sections"
            className="inline-flex rounded-xl border border-border p-1"
            data-testid="hyg-visit-tabs"
          >
            {(
              [
                ["visit", "Note & treatment"],
                ["ortho", "Ortho screening"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={cn(
                  "min-h-11 rounded-lg px-4 text-sm font-medium transition-colors",
                  tab === id
                    ? "bg-primary/10 text-foreground"
                    : "text-muted-foreground hover:bg-accent/40",
                )}
                data-testid={`hyg-visit-tab-${id}`}
              >
                {label}
                {id === "ortho" && page.visit?.orthoSend ? " · Sent" : ""}
              </button>
            ))}
          </div>
          {/* Item 54: start a referral chairside. Renders nothing while
              referrals is off for the office, or before the visit is open. */}
          {isOfficeId(office) && page.visit ? <VisitReferral office={office} aptNum={aptNum} /> : null}
          </div>

          {tab === "ortho" ? (
            <OrthoScreening
              screening={draft.orthoScreening}
              sent={page.visit?.orthoSend ?? null}
              sending={orthoSending}
              error={orthoError}
              onChange={onOrthoChange}
              onSend={() => void onOrthoSend()}
            />
          ) : (
            <>
              <VisitNoteFields
                slip={draft}
                doctorOptions={page.doctorOptions}
                suggestion={suggestion}
                onChange={onSlipChange}
              />
              <RouterSlip slip={draft} recordsNeeded={page.recordsNeeded} onChange={onSlipChange} />
              <ExistingTreatment
                state={existingTxShown}
                saving={existingSaving}
                rowErrors={existingErrors}
                onStart={() => void onStartExistingTx()}
                onRetry={() => void loadExistingTx(true)}
                onSave={(procNum, input) => void onSaveExistingTx(procNum, input)}
                onSaveMany={(entries) => void queueExistingTx(entries)}
                asOf={page.visit?.visitDate ?? date}
              />
              <TreatmentItems
                items={items}
                plannedInOd={existingTx.status === "ready" ? existingTx.data.items : []}
                busy={busy}
                onAdd={(input: TreatmentItemInput) =>
                  void run(() => addTreatmentItem(office, aptNum, input))
                }
                onPatch={(itemId, patch) =>
                  void run(() => updateTreatmentItem(office, aptNum, itemId, patch))
                }
                onRemove={(itemId) => void run(() => removeTreatmentItem(office, aptNum, itemId))}
                onReviewAndSend={() =>
                  trayRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
                }
              />
            </>
          )}
        </div>

        {/* STICKY on a wide screen, so the tray is in view while she works the
            form rather than a scroll away at the bottom of it. */}
        <aside
          ref={trayRef}
          className="w-full shrink-0 lg:sticky lg:top-6 lg:w-[340px] lg:self-start"
        >
          <StagedWritesTray
            staged={staged}
            handoffCategory={page.handoffCategory}
            patientName={page.appointment.patientName ?? "this patient"}
            itemCount={items.length}
            existingNotDiscussed={
              existingTxShown.status === "ready" ? countNotDiscussed(existingTxShown.data.items) : 0
            }
            busy={busy}
            sending={sending}
            onStage={(kind) => void onStage(kind)}
            onUnstage={(kind) => void run(() => unstageWrite(office, aptNum, kind))}
            onSend={(confirm) => void onSend(confirm)}
            onRetry={(kind) =>
              kind === "perio"
                ? void onRetryPerio()
                : void run(() => retryStagedWrite(office, aptNum, kind))
            }
            refusal={refusal}
            perioHref={`/hyg/visit/${aptNum}/perio?office=${office}&date=${date}`}
            perio={trayPerio}
            onResumePerio={() => void onRetryPerio()}
          />
        </aside>
      </div>
    </div>
  );
}

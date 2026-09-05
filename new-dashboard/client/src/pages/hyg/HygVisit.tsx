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
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearch } from "wouter";
import { AlertTriangle, ArrowLeft, HelpCircle, Loader2, RefreshCw } from "lucide-react";

import {
  emptySlip,
  isOfficeId,
  type HygSlip,
  type StagedWriteKind,
  type TreatmentItemInput,
} from "@shared/hyg/contract";
import {
  addTreatmentItem,
  fetchVisit,
  HygApiError,
  openVisit,
  removeTreatmentItem,
  saveSlip,
  stageWrite,
  unstageWrite,
  updateTreatmentItem,
  type HygVisitMutation,
  type HygVisitPage,
} from "@/features/hyg/api";
import { formatClock, formatLength, todayIso, visibleFlags } from "@/features/hyg/day";
import { RouterSlip } from "@/features/hyg/visit/RouterSlip";
import { StagedWritesTray } from "@/features/hyg/visit/StagedWritesTray";
import { TreatmentItems } from "@/features/hyg/visit/TreatmentItems";
import { cn } from "@/lib/utils";

/** How long after the last keystroke the slip is stored. */
const SAVE_DEBOUNCE_MS = 800;

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
  const [refusal, setRefusal] = useState<{ kind: StagedWriteKind; message: string } | null>(null);
  /** The slip being edited, which may be a keystroke ahead of what is stored. */
  const [draft, setDraft] = useState<HygSlip>(emptySlip());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!isOfficeId(office)) return;
      try {
        const next = await fetchVisit(office, aptNum, date, signal);
        setPage(next);
        setDraft(next.visit ? next.visit.slip : emptySlip());
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
        setDraft(res.visit.slip);
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
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        if (!isOfficeId(office)) return;
        setSaving(true);
        void (async () => {
          try {
            if (!page?.visit) await openVisit(office, aptNum, date);
            adopt(await saveSlip(office, aptNum, next));
          } catch (err) {
            if (err instanceof HygApiError) setError(err);
          } finally {
            setSaving(false);
          }
        })();
      }, SAVE_DEBOUNCE_MS);
    },
    [office, aptNum, date, page, adopt],
  );

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
          <RouterSlip slip={draft} recordsNeeded={page.recordsNeeded} onChange={onSlipChange} />
          <TreatmentItems
            items={items}
            busy={busy}
            onAdd={(input: TreatmentItemInput) =>
              void run(() => addTreatmentItem(office, aptNum, input))
            }
            onPatch={(itemId, patch) =>
              void run(() => updateTreatmentItem(office, aptNum, itemId, patch))
            }
            onRemove={(itemId) => void run(() => removeTreatmentItem(office, aptNum, itemId))}
          />
        </div>

        <aside className="w-full shrink-0 lg:w-[340px]">
          <StagedWritesTray
            staged={staged}
            handoffCategory={page.handoffCategory}
            busy={busy}
            onStage={(kind) => void onStage(kind)}
            onUnstage={(kind) => void run(() => unstageWrite(office, aptNum, kind))}
            refusal={refusal}
          />
        </aside>
      </div>
    </div>
  );
}

/**
 * EXISTING TREATMENT (from Open Dental) — hygiene Slice 2a.
 *
 * The patient's treatment-planned procedures, each with two questions the
 * hygienist answers with a tap: "Anything changed clinically?" and "What did
 * the patient say?". The list is the SERVER's Open Dental read for the office
 * and PatNum on the stored visit; the answers are stored in CareIN only.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * FOUR STATES, AND ONLY ONE OF THEM MAY LOOK LIKE "NONE"
 * ═════════════════════════════════════════════════════════════════════════════
 * Not started, loading, failed, loaded. A failed read says so with a Retry; it
 * is never an empty list, because an empty list is a claim that this patient
 * has nothing planned. Only a loaded, empty answer says that.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * "NOT DISCUSSED" IS NOT AN ANSWER, AND IS NEVER STYLED LIKE ONE
 * ═════════════════════════════════════════════════════════════════════════════
 * It is the default, drawn grey and dashed whether or not it is the current
 * value. Every real answer is drawn the way the rest of the visit draws a
 * picked chip.
 *
 * Rows are divs with buttons inside — no nested interactive elements — and
 * every tap target is at least 44px (min-h-11), as on the rest of the visit.
 */
import { useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";

import {
  EXISTING_TX_CLINICAL,
  EXISTING_TX_CLINICAL_LABELS,
  EXISTING_TX_NOTE_MAX,
  EXISTING_TX_PATIENT,
  EXISTING_TX_PATIENT_LABELS,
  EXISTING_TX_WAIT,
  EXISTING_TX_WAIT_LABELS,
  type ExistingTxClinical,
  type ExistingTxDispositionInput,
  type ExistingTxItem,
  type ExistingTxLastDiscussed,
  type ExistingTxPatient,
  type ExistingTxResponse,
  type ExistingTxWait,
} from "@shared/hyg/existingTx";
import { cn } from "@/lib/utils";

export type ExistingTxState =
  | { status: "not_started" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: ExistingTxResponse };

const TAP = "min-h-11 rounded-lg border px-3 text-sm font-medium transition-colors";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "1 May 2026" from 'YYYY-MM-DD'. Read out of the digits rather than through a
 * Date, so no device zone or locale can move the day.
 */
export function formatPlainDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d || m > 12) return iso;
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** "#30 MO", "#3", or "" when Open Dental names no tooth. */
function toothLabel(item: Pick<ExistingTxItem, "tooth" | "surface">): string {
  if (!item.tooth) return item.surface;
  return item.surface ? `#${item.tooth} ${item.surface}` : `#${item.tooth}`;
}

/** "Last discussed 1 Jun 2026: Wants to wait (6 months)". */
export function lastDiscussedLine(last: ExistingTxLastDiscussed): string {
  const said = EXISTING_TX_PATIENT_LABELS[last.patient];
  const wait = last.waitTimeframe ? ` (${EXISTING_TX_WAIT_LABELS[last.waitTimeframe]})` : "";
  return `Last discussed ${formatPlainDate(last.visitDate)}: ${said}${wait}`;
}

/** The answer a row starts from when nobody has tapped anything yet. */
function currentInput(item: ExistingTxItem): ExistingTxDispositionInput {
  const d = item.disposition;
  return d
    ? { clinical: d.clinical, patient: d.patient, waitTimeframe: d.waitTimeframe, note: d.note }
    : { clinical: null, patient: "not_discussed", waitTimeframe: null, note: null };
}

function AnswerChip({
  label,
  active,
  disabled,
  onClick,
  testId,
  quiet = false,
}: {
  label: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  testId: string;
  /** The "not discussed" chip: dashed and grey, picked or not. */
  quiet?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      data-testid={testId}
      className={cn(
        TAP,
        "disabled:cursor-not-allowed disabled:opacity-60",
        quiet
          ? cn(
              "border-dashed border-muted-foreground/40 text-muted-foreground",
              active ? "bg-muted/40" : "hover:bg-accent/40",
            )
          : active
            ? "border-primary bg-primary/10 text-foreground"
            : "border-border text-muted-foreground hover:bg-accent/40",
      )}
    >
      {label}
    </button>
  );
}

function Question({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-semibold text-foreground">{text}</div>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function ExistingTxRow({
  item,
  frozen,
  saving,
  error,
  onSave,
}: {
  item: ExistingTxItem;
  frozen: boolean;
  saving: boolean;
  error: string | null;
  onSave: (input: ExistingTxDispositionInput) => void;
}) {
  const input = currentInput(item);
  const [note, setNote] = useState(input.note ?? "");
  // A read-back that changed the stored note wins over the box.
  useEffect(() => setNote(item.disposition?.note ?? ""), [item.disposition?.note]);

  /**
   * THE LAST ANSWER SENT, which the next tap builds on.
   *
   * Every PUT carries the WHOLE disposition, so a tap merged onto the stored
   * read-back while an earlier save is still in flight would send the older
   * answer back and undo it — typing a note and then tapping a chip is exactly
   * that sequence (blur saves the note, the tap lands a moment later). The
   * parent sends one row's saves in order; this is what makes each one carry
   * everything before it. It re-syncs to the server only when nothing is
   * pending, so a read-back can never rewind a tap that is still on its way.
   */
  const latest = useRef(input);
  useEffect(() => {
    if (!saving) latest.current = currentInput(item);
  }, [saving, item]);

  // Only a sent visit locks the row. A save in flight does not: a tap made
  // while it is on its way is queued behind it, not swallowed.
  const disabled = frozen;
  const urgent = input.clinical === "worse_urgent";
  const tooth = toothLabel(item);
  const id = item.procNum;

  function save(next: Partial<ExistingTxDispositionInput>) {
    const merged = { ...latest.current, ...next };
    // A timeframe belongs to "wants to wait" only; changing the answer clears it.
    if (merged.patient !== "wants_to_wait") merged.waitTimeframe = null;
    latest.current = merged;
    onSave(merged);
  }

  return (
    <div
      className="space-y-3 rounded-xl border border-border bg-card p-3"
      data-testid={`hyg-existing-tx-row-${id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground">
            {item.code || "No code"}
            {item.description ? (
              <span className="font-normal text-muted-foreground"> · {item.description}</span>
            ) : null}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
            {tooth ? <span data-testid={`hyg-existing-tx-tooth-${id}`}>{tooth}</span> : null}
            <span>
              {item.dateTp ? `Planned ${formatPlainDate(item.dateTp)}` : "Planned date not recorded"}
            </span>
          </div>
          {item.lastDiscussed ? (
            <div className="mt-0.5 text-xs text-muted-foreground" data-testid={`hyg-existing-tx-last-${id}`}>
              {lastDiscussedLine(item.lastDiscussed)}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {urgent ? (
            <span
              className="rounded-full bg-red-600 px-2 py-0.5 text-xs font-semibold text-white dark:bg-red-500"
              data-testid={`hyg-existing-tx-urgent-${id}`}
            >
              Urgent
            </span>
          ) : null}
          {item.scheduled ? (
            <span
              className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"
              data-testid={`hyg-existing-tx-scheduled-${id}`}
            >
              Already scheduled
            </span>
          ) : null}
        </div>
      </div>
      {urgent ? (
        <p className="text-xs text-red-700 dark:text-red-400">
          Changes the priority here, not in Open Dental.
        </p>
      ) : null}

      <Question text="Anything changed clinically?">
        {EXISTING_TX_CLINICAL.map((value: ExistingTxClinical) => (
          <AnswerChip
            key={value}
            label={EXISTING_TX_CLINICAL_LABELS[value]}
            active={input.clinical === value}
            disabled={disabled}
            // Tapping the picked answer again takes it back.
            onClick={() => save({ clinical: latest.current.clinical === value ? null : value })}
            testId={`hyg-existing-tx-clinical-${id}-${value}`}
          />
        ))}
      </Question>

      <Question text="What did the patient say?">
        {EXISTING_TX_PATIENT.map((value: ExistingTxPatient) => (
          <AnswerChip
            key={value}
            label={EXISTING_TX_PATIENT_LABELS[value]}
            active={input.patient === value}
            disabled={disabled}
            quiet={value === "not_discussed"}
            onClick={() => save({ patient: value })}
            testId={`hyg-existing-tx-patient-${id}-${value}`}
          />
        ))}
      </Question>

      {input.patient === "wants_to_wait" ? (
        <Question text="How long do they want to wait?">
          {EXISTING_TX_WAIT.map((value: ExistingTxWait) => (
            <AnswerChip
              key={value}
              label={EXISTING_TX_WAIT_LABELS[value]}
              active={input.waitTimeframe === value}
              disabled={disabled}
              onClick={() => save({ waitTimeframe: latest.current.waitTimeframe === value ? null : value })}
              testId={`hyg-existing-tx-wait-${id}-${value}`}
            />
          ))}
        </Question>
      ) : null}

      <label className="block space-y-1.5">
        <span className="text-xs font-semibold text-foreground">Note (optional)</span>
        <input
          type="text"
          value={note}
          maxLength={EXISTING_TX_NOTE_MAX}
          disabled={disabled}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => {
            const next = note.trim() === "" ? null : note.trim();
            if (next !== (latest.current.note ?? null)) save({ note: next });
          }}
          className="min-h-11 w-full rounded-lg border border-border bg-background px-3 text-sm disabled:opacity-60"
          data-testid={`hyg-existing-tx-note-${id}`}
        />
      </label>

      {saving ? (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 size={12} className="animate-spin" /> Saving…
        </div>
      ) : null}
      {error ? (
        <div className="text-xs text-destructive" data-testid={`hyg-existing-tx-error-${id}`}>
          {error}
        </div>
      ) : null}
    </div>
  );
}

export function ExistingTreatment({
  state,
  saving,
  rowErrors,
  onStart,
  onRetry,
  onSave,
}: {
  state: ExistingTxState;
  /** ProcNums with a save in flight. */
  saving: ReadonlySet<number>;
  rowErrors: Readonly<Record<number, string>>;
  /** Start the visit, which is what lets the server read whose plan this is. */
  onStart: () => void;
  onRetry: () => void;
  onSave: (procNum: number, input: ExistingTxDispositionInput) => void;
}) {
  const ready = state.status === "ready" ? state.data : null;
  const planned = ready ? ready.items.filter((i) => !i.watch) : [];
  const watch = ready ? ready.items.filter((i) => i.watch) : [];

  const row = (item: ExistingTxItem) => (
    <ExistingTxRow
      key={item.procNum}
      item={item}
      frozen={ready?.frozen ?? true}
      saving={saving.has(item.procNum)}
      error={rowErrors[item.procNum] ?? null}
      onSave={(input) => onSave(item.procNum, input)}
    />
  );

  return (
    <section className="space-y-3" data-testid="hyg-existing-tx">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Existing treatment (from Open Dental)
        </h2>
        {state.status === "ready" ? (
          <button
            type="button"
            onClick={onRetry}
            // Not while a save is on its way: a re-read remounts the rows, and a
            // row rebuilt from an answer older than the one being saved would
            // build the next tap on it.
            disabled={saving.size > 0}
            className={cn(TAP, "inline-flex items-center gap-1.5 border-transparent text-muted-foreground hover:bg-accent/40 disabled:opacity-60")}
            data-testid="hyg-existing-tx-refresh"
          >
            <RefreshCw size={14} /> Refresh
          </button>
        ) : null}
      </div>

      {state.status === "not_started" ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-border p-3 text-sm text-muted-foreground">
          <span>The treatment already planned in Open Dental shows once the visit is started.</span>
          <button
            type="button"
            onClick={onStart}
            className={cn(TAP, "border-border text-foreground hover:bg-accent/40")}
            data-testid="hyg-existing-tx-start"
          >
            Show existing treatment
          </button>
        </div>
      ) : null}

      {state.status === "loading" ? (
        <div
          className="flex items-center gap-2 rounded-xl border border-border p-3 text-sm text-muted-foreground"
          data-testid="hyg-existing-tx-loading"
        >
          <Loader2 size={14} className="animate-spin" /> Loading existing treatment from Open Dental…
        </div>
      ) : null}

      {state.status === "error" ? (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/40 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-300"
          data-testid="hyg-existing-tx-error"
        >
          <span>{state.message}</span>
          <button
            type="button"
            onClick={onRetry}
            className={cn(TAP, "inline-flex items-center gap-1.5 border-amber-600/40 bg-background text-foreground")}
            data-testid="hyg-existing-tx-retry"
          >
            <RefreshCw size={14} /> Retry
          </button>
        </div>
      ) : null}

      {ready ? (
        <>
          {ready.frozen ? (
            <p className="text-xs text-muted-foreground" data-testid="hyg-existing-tx-frozen">
              This visit has been sent, so these answers are locked.
            </p>
          ) : null}
          {ready.items.length === 0 ? (
            <p className="rounded-xl border border-border p-3 text-sm text-muted-foreground" data-testid="hyg-existing-tx-none">
              Open Dental has no treatment planned for this patient.
            </p>
          ) : null}
          {planned.length > 0 ? <div className="space-y-2">{planned.map(row)}</div> : null}
          {watch.length > 0 ? (
            <div className="space-y-2" data-testid="hyg-existing-tx-watch">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Watch</h3>
              {watch.map(row)}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

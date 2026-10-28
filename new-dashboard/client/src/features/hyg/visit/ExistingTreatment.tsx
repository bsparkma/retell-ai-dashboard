/**
 * EXISTING TREATMENT (from Open Dental) — hygiene Slice 2a, compact since the
 * stale-staging round.
 *
 * The patient's treatment-planned procedures, each with two questions the
 * hygienist answers with a tap: "What did the patient say?" and "Anything
 * changed clinically?". The list is the SERVER's Open Dental read for the office
 * and PatNum on the stored visit; the answers are stored in CareIN only.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ONE ROW PER TOOTH, COLLAPSED — A 30-ITEM PLAN IN TWO SCREENS
 * ═════════════════════════════════════════════════════════════════════════════
 * Grouped by tooth set (TreatmentItems' groupByTooth), in tooth order, quadrant
 * and arch items after, the whole mouth last. Each group is one row: tooth,
 * procedures, planned date, Already scheduled / Watch, and what was answered.
 * Tapping a row opens its editor in place — one at a time. A group's answer
 * applies to every procedure in it unless "Answer separately" is on.
 *
 * WHAT IS SHOWN FIRST: everything planned in the last 24 months, plus anything
 * on Watch, urgent, or already answered — whatever its age. Older items sit
 * behind "Show N older items", and items Open Dental already has on a scheduled
 * appointment behind "Already scheduled (N)". Hidden is never deleted: every
 * item is one tap away, and the header counts them all.
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
 * value — on the chip and in a row's summary. Every real answer is drawn the way
 * the rest of the visit draws a picked chip.
 *
 * Rows are divs with buttons inside — no nested interactive elements — and
 * every tap target is at least 44px (min-h-11), as on the rest of the visit.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Loader2, RefreshCw } from "lucide-react";

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
import { groupByTooth, toothGroupLabel } from "./TreatmentItems";
import { odToothNumbers } from "./ToothPicker";

export type ExistingTxState =
  | { status: "not_started" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: ExistingTxResponse };

type Entry = { procNum: number; input: ExistingTxDispositionInput };

const TAP = "min-h-11 rounded-lg border px-3 text-sm font-medium transition-colors";

/** At or below this many items the section opens by itself. */
const AUTO_EXPAND_MAX = 8;
/** Older than this, unanswered and unflagged, and an item waits behind "Show older". */
const RECENT_MONTHS = 24;

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

/** Anything at all was said — "Not discussed" with no clinical answer is nothing. */
function isAnswered(item: ExistingTxItem): boolean {
  const d = item.disposition;
  return d !== null && (d.patient !== "not_discussed" || d.clinical !== null);
}

function isUrgent(item: ExistingTxItem): boolean {
  return item.disposition?.clinical === "worse_urgent";
}

// ─────────────────────────────────────────────────────────────────────────────
// Grouping and the default view — pure, exported for the tests
// ─────────────────────────────────────────────────────────────────────────────

export type ExistingTxGroup = { key: string; label: string; items: ExistingTxItem[] };

/** Where a group sorts: teeth first by their lowest number, then areas, the whole mouth last. */
function groupRank(key: string): [number, number] {
  if (key === "mouth") return [3, 0];
  if (key.startsWith("area:") || key.startsWith("od:")) return [2, 0];
  const first = Number(key.split(",")[0]);
  return [1, Number.isFinite(first) ? first : 999];
}

/**
 * Items grouped by tooth set. Teeth through groupByTooth (the visit's own rule:
 * by the SET, so one item spanning #3 and #14 appears once); a quadrant or arch
 * with no tooth groups by that area; the whole mouth comes last. Within a group
 * the server's order is kept.
 */
export function groupExistingTx(items: readonly ExistingTxItem[]): ExistingTxGroup[] {
  const byTeeth: { teeth: number[] | "mouth"; item: ExistingTxItem }[] = [];
  const other = new Map<string, ExistingTxGroup>();
  for (const item of items) {
    const teeth = odToothNumbers(item.tooth);
    const area = item.surface.trim();
    if (teeth === "mouth" && area !== "") {
      const key = `area:${area}`;
      const g = other.get(key) ?? { key, label: area, items: [] };
      g.items.push(item);
      other.set(key, g);
    } else if (teeth === null) {
      const key = `od:${item.tooth.trim()}`;
      const g = other.get(key) ?? { key, label: `#${item.tooth.trim()}`, items: [] };
      g.items.push(item);
      other.set(key, g);
    } else {
      byTeeth.push({ teeth, item });
    }
  }
  const toothGroups = groupByTooth(byTeeth).map((g) => ({
    key: g.key,
    label: toothGroupLabel(g.key),
    items: g.items.map((w) => w.item),
  }));
  return [...toothGroups, ...Array.from(other.values())].sort((a, b) => {
    const [ra, na] = groupRank(a.key);
    const [rb, nb] = groupRank(b.key);
    return ra !== rb ? ra - rb : na - nb;
  });
}

/** 'YYYY-MM-DD' RECENT_MONTHS before `asOf`, from the digits. */
export function recentCutoff(asOf: string): string {
  const [y, m, d] = asOf.split("-");
  return `${Number(y) - RECENT_MONTHS / 12}-${m}-${d}`;
}

/**
 * The three places an item can sit: the main list, "Already scheduled", or
 * behind "Show older". An item with no planned date is shown — "not recorded" is
 * not the same as "old", and hiding it would be a guess.
 */
export function splitExistingTx(
  items: readonly ExistingTxItem[],
  asOf: string,
): { main: ExistingTxItem[]; scheduled: ExistingTxItem[]; older: ExistingTxItem[]; cutoff: string } {
  const cutoff = recentCutoff(asOf);
  const main: ExistingTxItem[] = [];
  const scheduled: ExistingTxItem[] = [];
  const older: ExistingTxItem[] = [];
  for (const item of items) {
    if (item.scheduled) scheduled.push(item);
    else if (
      item.dateTp !== null &&
      item.dateTp < cutoff &&
      !item.watch &&
      !isUrgent(item) &&
      !isAnswered(item)
    )
      older.push(item);
    else main.push(item);
  }
  return { main, scheduled, older, cutoff };
}

const WAIT_SHORT: Record<ExistingTxWait, string> = {
  "1_month": "1 mo",
  "3_months": "3 mo",
  "6_months": "6 mo",
  next_recall: "next recall",
};
const CLINICAL_SHORT: Record<Exclude<ExistingTxClinical, "worse_urgent">, string> = {
  no_change: "No change",
  re_evaluate: "Re-evaluate",
  no_longer_needed: "No longer needed",
};
const PATIENT_SHORT: Record<Exclude<ExistingTxPatient, "not_discussed">, string> = {
  ready_to_schedule: "Ready to schedule",
  wants_to_wait: "Wait",
  see_plan_again: "See plan again",
  cost_questions: "Cost questions",
  declined: "Declined",
};

/** "Wait 3 mo", "No change · Declined" — the words after the Urgent pill. [] = not discussed. */
export function answerWords(input: ExistingTxDispositionInput): string[] {
  const words: string[] = [];
  if (input.clinical && input.clinical !== "worse_urgent") words.push(CLINICAL_SHORT[input.clinical]);
  if (input.patient === "wants_to_wait") {
    words.push(input.waitTimeframe ? `Wait ${WAIT_SHORT[input.waitTimeframe]}` : "Wait");
  } else if (input.patient !== "not_discussed") {
    words.push(PATIENT_SHORT[input.patient]);
  }
  return words;
}

/** "Crown" from "Crown - porcelain/ceramic", "Core buildup" from "Core buildup, including any pins". */
function shortDescription(description: string): string {
  const head = description.split(/ - |, /)[0].trim();
  return head.length > 28 ? `${head.slice(0, 27)}…` : head;
}

/** "Planned 20 Jun 2026", or the span of a group's dates. */
function plannedText(items: readonly ExistingTxItem[]): string {
  const dates = Array.from(new Set(items.map((i) => i.dateTp).filter((d): d is string => d !== null))).sort();
  if (dates.length === 0) return "Planned date not recorded";
  if (dates.length === 1) return `Planned ${formatPlainDate(dates[0])}`;
  return `Planned ${formatPlainDate(dates[0])} – ${formatPlainDate(dates[dates.length - 1])}`;
}

/** One value shared by every input, or undefined when they differ. */
function shared<K extends keyof ExistingTxDispositionInput>(
  inputs: readonly ExistingTxDispositionInput[],
  key: K,
): ExistingTxDispositionInput[K] | undefined {
  if (inputs.length === 0) return undefined;
  const first = inputs[0][key];
  return inputs.every((i) => i[key] === first) ? first : undefined;
}

/** Merge a change onto the last answer sent; a timeframe goes only with "wants to wait". */
function merged(current: ExistingTxDispositionInput, next: Partial<ExistingTxDispositionInput>) {
  const out = { ...current, ...next };
  if (out.patient !== "wants_to_wait") out.waitTimeframe = null;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pieces
// ─────────────────────────────────────────────────────────────────────────────

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
    <div className="space-y-1">
      <div className="text-xs font-semibold text-foreground">{text}</div>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function UrgentPill({ testId }: { testId: string }) {
  return (
    <span
      className="rounded-full bg-red-600 px-2 py-0.5 text-xs font-semibold text-white dark:bg-red-500"
      data-testid={testId}
    >
      Urgent
    </span>
  );
}

/** The answers, as a row shows them: Urgent pill, then words — or a dashed "Not discussed". */
function AnswerSummary({ items, testId }: { items: readonly ExistingTxItem[]; testId: string }) {
  const inputs = items.map(currentInput);
  const urgent = items.some(isUrgent);
  const words = inputs.map((i) => answerWords(i).join(" · "));
  const same =
    words.every((w) => w === words[0]) && inputs.every((i) => i.clinical === inputs[0].clinical);
  const answered = items.filter(isAnswered).length;
  return (
    <span className="flex shrink-0 flex-wrap items-center gap-1.5 text-xs" data-testid={testId}>
      {urgent ? <UrgentPill testId={`${testId}-urgent`} /> : null}
      {same ? (
        words[0] ? (
          <span className="font-medium text-foreground">{words[0]}</span>
        ) : urgent ? null : (
          <span className="rounded-full border border-dashed border-muted-foreground/40 px-2 py-0.5 text-muted-foreground">
            Not discussed
          </span>
        )
      ) : (
        <span className="text-muted-foreground">
          Answers differ · {answered} of {items.length} answered
        </span>
      )}
    </span>
  );
}

/**
 * One procedure's answers — a single-procedure group, or a group answered
 * separately. Every PUT carries the WHOLE disposition, built on `latest` (the
 * last answer sent), so a tap made while an earlier save is in flight cannot
 * send an older answer back.
 */
function ProcedureEditor({
  item,
  showHeader,
  frozen,
  saving,
  error,
  latest,
  onSave,
}: {
  item: ExistingTxItem;
  /** In a group answered separately: say which procedure this is. */
  showHeader: boolean;
  frozen: boolean;
  saving: boolean;
  error: string | null;
  latest: () => ExistingTxDispositionInput;
  onSave: (input: ExistingTxDispositionInput) => void;
}) {
  const input = currentInput(item);
  const [note, setNote] = useState(input.note ?? "");
  const [noteOpen, setNoteOpen] = useState(Boolean(input.note));
  // A read-back that changed the stored note wins over the box.
  useEffect(() => setNote(item.disposition?.note ?? ""), [item.disposition?.note]);

  const id = item.procNum;
  const urgent = input.clinical === "worse_urgent";
  const save = (next: Partial<ExistingTxDispositionInput>) => onSave(merged(latest(), next));

  return (
    <div className="space-y-2.5" data-testid={`hyg-existing-tx-row-${id}`}>
      {showHeader ? (
        <div className="text-sm font-semibold text-foreground">
          {item.code || "No code"}
          {item.description ? (
            <span className="font-normal text-muted-foreground"> · {item.description}</span>
          ) : null}
          {toothLabel(item) ? (
            <span className="ml-2 text-xs font-normal text-muted-foreground" data-testid={`hyg-existing-tx-tooth-${id}`}>
              {toothLabel(item)}
            </span>
          ) : null}
        </div>
      ) : null}
      {urgent || item.scheduled || item.lastDiscussed ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {urgent ? <UrgentPill testId={`hyg-existing-tx-urgent-${id}`} /> : null}
          {item.scheduled ? (
            <span
              className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"
              data-testid={`hyg-existing-tx-scheduled-${id}`}
            >
              Already scheduled
            </span>
          ) : null}
          {item.lastDiscussed ? (
            <span data-testid={`hyg-existing-tx-last-${id}`}>{lastDiscussedLine(item.lastDiscussed)}</span>
          ) : null}
        </div>
      ) : null}
      {urgent ? (
        <p className="text-xs text-red-700 dark:text-red-400">Changes the priority here, not in Open Dental.</p>
      ) : null}

      <Question text="What did the patient say?">
        {EXISTING_TX_PATIENT.map((value: ExistingTxPatient) => (
          <AnswerChip
            key={value}
            label={EXISTING_TX_PATIENT_LABELS[value]}
            active={input.patient === value}
            disabled={frozen}
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
              disabled={frozen}
              onClick={() => save({ waitTimeframe: latest().waitTimeframe === value ? null : value })}
              testId={`hyg-existing-tx-wait-${id}-${value}`}
            />
          ))}
        </Question>
      ) : null}

      <Question text="Anything changed clinically?">
        {EXISTING_TX_CLINICAL.map((value: ExistingTxClinical) => (
          <AnswerChip
            key={value}
            label={EXISTING_TX_CLINICAL_LABELS[value]}
            active={input.clinical === value}
            disabled={frozen}
            // Tapping the picked answer again takes it back.
            onClick={() => save({ clinical: latest().clinical === value ? null : value })}
            testId={`hyg-existing-tx-clinical-${id}-${value}`}
          />
        ))}
      </Question>

      {noteOpen ? (
        <label className="block space-y-1">
          <span className="text-xs font-semibold text-foreground">Note (optional)</span>
          <input
            type="text"
            value={note}
            maxLength={EXISTING_TX_NOTE_MAX}
            disabled={frozen}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => {
              const next = note.trim() === "" ? null : note.trim();
              if (next !== (latest().note ?? null)) save({ note: next });
            }}
            className="min-h-11 w-full rounded-lg border border-border bg-background px-3 text-sm disabled:opacity-60"
            data-testid={`hyg-existing-tx-note-${id}`}
          />
        </label>
      ) : (
        <button
          type="button"
          onClick={() => setNoteOpen(true)}
          disabled={frozen}
          className={cn(TAP, "border-transparent text-muted-foreground hover:bg-accent/40 disabled:opacity-60")}
          data-testid={`hyg-existing-tx-add-note-${id}`}
        >
          + note
        </button>
      )}

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

/**
 * A multi-procedure group answered TOGETHER: each tap applies to every
 * procedure in it. A chip reads as picked only when every procedure has that
 * answer; the note shows only when every procedure has the same one.
 */
function GroupEditor({
  group,
  frozen,
  saving,
  error,
  latest,
  onSaveAll,
}: {
  group: ExistingTxGroup;
  frozen: boolean;
  saving: boolean;
  error: string | null;
  latest: (item: ExistingTxItem) => ExistingTxDispositionInput;
  onSaveAll: (entries: Entry[]) => void;
}) {
  const inputs = group.items.map(currentInput);
  const patient = shared(inputs, "patient");
  const clinical = shared(inputs, "clinical");
  const wait = shared(inputs, "waitTimeframe");
  const commonNote = shared(inputs, "note");
  const notesDiffer = commonNote === undefined;
  const [note, setNote] = useState(commonNote ?? "");
  const [noteOpen, setNoteOpen] = useState(Boolean(commonNote) || notesDiffer);
  useEffect(() => setNote(commonNote ?? ""), [commonNote]);
  const k = group.key;
  const n = group.items.length;

  const saveAll = (next: Partial<ExistingTxDispositionInput>) =>
    onSaveAll(group.items.map((item) => ({ procNum: item.procNum, input: merged(latest(item), next) })));

  return (
    <div className="space-y-2.5" data-testid={`hyg-existing-tx-geditor-${k}`}>
      {group.items.some((i) => i.lastDiscussed) ? (
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          {group.items.map((i) =>
            i.lastDiscussed ? (
              <li key={i.procNum} data-testid={`hyg-existing-tx-last-${i.procNum}`}>
                {i.code}: {lastDiscussedLine(i.lastDiscussed)}
              </li>
            ) : null,
          )}
        </ul>
      ) : null}
      {clinical === "worse_urgent" ? (
        <p className="text-xs text-red-700 dark:text-red-400">Changes the priority here, not in Open Dental.</p>
      ) : null}

      <Question text={`What did the patient say? (all ${n})`}>
        {EXISTING_TX_PATIENT.map((value: ExistingTxPatient) => (
          <AnswerChip
            key={value}
            label={EXISTING_TX_PATIENT_LABELS[value]}
            active={patient === value}
            disabled={frozen}
            quiet={value === "not_discussed"}
            onClick={() => saveAll({ patient: value })}
            testId={`hyg-existing-tx-gpatient-${k}-${value}`}
          />
        ))}
      </Question>

      {patient === "wants_to_wait" ? (
        <Question text="How long do they want to wait?">
          {EXISTING_TX_WAIT.map((value: ExistingTxWait) => (
            <AnswerChip
              key={value}
              label={EXISTING_TX_WAIT_LABELS[value]}
              active={wait === value}
              disabled={frozen}
              onClick={() => saveAll({ waitTimeframe: wait === value ? null : value })}
              testId={`hyg-existing-tx-gwait-${k}-${value}`}
            />
          ))}
        </Question>
      ) : null}

      <Question text={`Anything changed clinically? (all ${n})`}>
        {EXISTING_TX_CLINICAL.map((value: ExistingTxClinical) => (
          <AnswerChip
            key={value}
            label={EXISTING_TX_CLINICAL_LABELS[value]}
            active={clinical === value}
            disabled={frozen}
            // Picked on every procedure: a tap takes it back from all of them.
            onClick={() => saveAll({ clinical: clinical === value ? null : value })}
            testId={`hyg-existing-tx-gclinical-${k}-${value}`}
          />
        ))}
      </Question>

      {noteOpen ? (
        notesDiffer ? (
          <p className="text-xs text-muted-foreground" data-testid={`hyg-existing-tx-gnote-differ-${k}`}>
            Each procedure has its own note. Answer separately to change one.
          </p>
        ) : (
          <label className="block space-y-1">
            <span className="text-xs font-semibold text-foreground">Note for all {n} (optional)</span>
            <input
              type="text"
              value={note}
              maxLength={EXISTING_TX_NOTE_MAX}
              disabled={frozen}
              onChange={(e) => setNote(e.target.value)}
              onBlur={() => {
                const next = note.trim() === "" ? null : note.trim();
                if (next !== (commonNote ?? null)) saveAll({ note: next });
              }}
              className="min-h-11 w-full rounded-lg border border-border bg-background px-3 text-sm disabled:opacity-60"
              data-testid={`hyg-existing-tx-gnote-${k}`}
            />
          </label>
        )
      ) : (
        <button
          type="button"
          onClick={() => setNoteOpen(true)}
          disabled={frozen}
          className={cn(TAP, "border-transparent text-muted-foreground hover:bg-accent/40 disabled:opacity-60")}
          data-testid={`hyg-existing-tx-gadd-note-${k}`}
        >
          + note
        </button>
      )}

      {saving ? (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 size={12} className="animate-spin" /> Saving…
        </div>
      ) : null}
      {error ? (
        <div className="text-xs text-destructive" data-testid={`hyg-existing-tx-gerror-${k}`}>
          {error}
        </div>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The section
// ─────────────────────────────────────────────────────────────────────────────

export function ExistingTreatment({
  state,
  saving,
  rowErrors,
  onStart,
  onRetry,
  onSave,
  onSaveMany,
  asOf,
}: {
  state: ExistingTxState;
  /** ProcNums with a save in flight. */
  saving: ReadonlySet<number>;
  rowErrors: Readonly<Record<number, string>>;
  /** Start the visit, which is what lets the server read whose plan this is. */
  onStart: () => void;
  onRetry: () => void;
  onSave: (procNum: number, input: ExistingTxDispositionInput) => void;
  /** Several procedures at once: a group answered together, or the Select bulk answer. */
  onSaveMany: (entries: Entry[]) => void;
  /** The visit's date, 'YYYY-MM-DD': what "the last 24 months" counts back from. */
  asOf: string;
}) {
  const ready = state.status === "ready" ? state.data : null;
  const items = useMemo(() => ready?.items ?? [], [ready]);
  const frozen = ready?.frozen ?? true;

  const [expandedChoice, setExpandedChoice] = useState<boolean | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [separate, setSeparate] = useState<ReadonlySet<string>>(new Set());
  const [showOlder, setShowOlder] = useState(false);
  const [showScheduled, setShowScheduled] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulkPatient, setBulkPatient] = useState<ExistingTxPatient | null>(null);
  const [bulkClinical, setBulkClinical] = useState<ExistingTxClinical | null>(null);
  const [bulkWait, setBulkWait] = useState<ExistingTxWait | null>(null);

  /**
   * THE LAST ANSWER SENT for each procedure, which the next tap builds on.
   * Every PUT carries the WHOLE disposition, so a tap merged onto the stored
   * read-back while an earlier save is still in flight would send the older
   * answer back and undo it. Re-synced to the server only when nothing is
   * pending for that procedure, so a read-back can never rewind a tap on its way.
   */
  const latestRef = useRef(new Map<number, ExistingTxDispositionInput>());
  useEffect(() => {
    for (const item of items) {
      if (!saving.has(item.procNum)) latestRef.current.set(item.procNum, currentInput(item));
    }
  }, [items, saving]);
  const latest = (item: ExistingTxItem) => latestRef.current.get(item.procNum) ?? currentInput(item);

  const split = useMemo(() => splitExistingTx(items, asOf), [items, asOf]);
  const mainGroups = useMemo(() => groupExistingTx(split.main), [split.main]);
  const olderGroups = useMemo(() => groupExistingTx(split.older), [split.older]);
  const scheduledGroups = useMemo(() => groupExistingTx(split.scheduled), [split.scheduled]);

  const answeredCount = items.filter(isAnswered).length;
  const urgentCount = items.filter(isUrgent).length;
  const expanded = expandedChoice ?? items.length <= AUTO_EXPAND_MAX;

  /** Rows are keyed by section too: one tooth can be both recent and older. */
  const rowId = (section: string, key: string) => `${section}:${key}`;
  const sections: [string, ExistingTxGroup[]][] = [
    ["main", mainGroups],
    ["older", showOlder ? olderGroups : []],
    ["scheduled", showScheduled ? scheduledGroups : []],
  ];

  function saveEntries(entries: Entry[]) {
    if (entries.length === 0) return;
    for (const e of entries) latestRef.current.set(e.procNum, e.input);
    if (entries.length === 1) onSave(entries[0].procNum, entries[0].input);
    else onSaveMany(entries);
  }

  function applyBulk() {
    if (bulkPatient === null) return;
    const entries: Entry[] = [];
    for (const [section, groups] of sections) {
      for (const g of groups) {
        if (!selected.has(rowId(section, g.key))) continue;
        for (const item of g.items) {
          entries.push({
            procNum: item.procNum,
            input: merged(latest(item), {
              patient: bulkPatient,
              waitTimeframe: bulkPatient === "wants_to_wait" ? bulkWait : null,
              // Optional: each row keeps its own clinical answer unless one was picked.
              ...(bulkClinical ? { clinical: bulkClinical } : {}),
            }),
          });
        }
      }
    }
    saveEntries(entries);
    setSelecting(false);
    setSelected(new Set());
    setBulkPatient(null);
    setBulkClinical(null);
    setBulkWait(null);
  }

  const groupRow = (raw: ExistingTxGroup, section: string) => {
    const id = rowId(section, raw.key);
    // Test ids are unique on the page: a tooth with old AND recent items has two rows.
    const k = section === "main" ? raw.key : `${section}-${raw.key}`;
    const group = { ...raw, key: k };
    const open = !selecting && openKey === id;
    const isSelected = selected.has(id);
    const anySaving = group.items.some((i) => saving.has(i.procNum));
    const firstError = group.items.map((i) => rowErrors[i.procNum]).find(Boolean) ?? null;
    const apart = group.items.length > 1 && separate.has(id);
    const only = group.items.length === 1 ? group.items[0] : null;
    return (
      <div
        key={id}
        className={cn("rounded-xl border bg-card", isSelected ? "border-primary" : "border-border")}
        data-testid={`hyg-existing-tx-group-${k}`}
      >
        <button
          type="button"
          onClick={() => {
            if (selecting) {
              setSelected((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              });
            } else {
              setOpenKey(open ? null : id);
            }
          }}
          aria-expanded={selecting ? undefined : open}
          aria-pressed={selecting ? isSelected : undefined}
          className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 py-1.5 text-left hover:bg-accent/30"
          data-testid={`hyg-existing-tx-toggle-${k}`}
        >
          {selecting ? (
            <span
              className={cn(
                "flex h-5 w-5 shrink-0 items-center justify-center rounded border",
                isSelected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/50",
              )}
              aria-hidden
            >
              {isSelected ? <Check size={14} /> : null}
            </span>
          ) : open ? (
            <ChevronDown size={16} className="shrink-0 text-muted-foreground" aria-hidden />
          ) : (
            <ChevronRight size={16} className="shrink-0 text-muted-foreground" aria-hidden />
          )}
          <span className="w-20 shrink-0 text-sm font-semibold text-foreground" data-testid={`hyg-existing-tx-gtooth-${k}`}>
            {group.label}
          </span>
          <span className="flex min-w-0 flex-1 flex-wrap gap-x-3 text-sm">
            {group.items.map((i) => (
              <span key={i.procNum} className="truncate" data-testid={`hyg-existing-tx-proc-${i.procNum}`}>
                <span className="font-medium text-foreground">{i.code || "No code"}</span>
                {i.description ? <span className="text-muted-foreground"> {shortDescription(i.description)}</span> : null}
                {i.surface && i.tooth ? <span className="text-muted-foreground"> {i.surface}</span> : null}
              </span>
            ))}
          </span>
          <span className="hidden shrink-0 text-xs text-muted-foreground md:inline" data-testid={`hyg-existing-tx-gdate-${k}`}>
            {plannedText(group.items)}
          </span>
          {group.items.some((i) => i.watch) ? (
            <span
              className="shrink-0 rounded-full border border-amber-500/50 px-2 py-0.5 text-xs text-amber-800 dark:text-amber-300"
              data-testid={`hyg-existing-tx-gwatch-${k}`}
            >
              Watch
            </span>
          ) : null}
          {group.items.some((i) => i.scheduled) ? (
            <span
              className="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"
              data-testid={`hyg-existing-tx-gscheduled-${k}`}
            >
              Already scheduled
            </span>
          ) : null}
          <AnswerSummary items={group.items} testId={`hyg-existing-tx-summary-${k}`} />
          {anySaving ? <Loader2 size={14} className="shrink-0 animate-spin text-muted-foreground" /> : null}
        </button>

        {open ? (
          <div className="space-y-3 border-t border-border/60 px-3 pb-3 pt-2" data-testid={`hyg-existing-tx-editor-${k}`}>
            <p className="text-xs text-muted-foreground md:hidden">{plannedText(group.items)}</p>
            {only ? (
              <ProcedureEditor
                item={only}
                showHeader={false}
                frozen={frozen}
                saving={saving.has(only.procNum)}
                error={rowErrors[only.procNum] ?? null}
                latest={() => latest(only)}
                onSave={(input) => saveEntries([{ procNum: only.procNum, input }])}
              />
            ) : (
              <>
                <button
                  type="button"
                  onClick={() =>
                    setSeparate((prev) => {
                      const next = new Set(prev);
                      if (next.has(id)) next.delete(id);
                      else next.add(id);
                      return next;
                    })
                  }
                  aria-pressed={apart}
                  className={cn(TAP, "border-border text-foreground hover:bg-accent/40")}
                  data-testid={`hyg-existing-tx-separate-${k}`}
                >
                  {apart ? "Answer all together" : "Answer separately"}
                </button>
                {apart ? (
                  <div className="space-y-3 divide-y divide-border/60">
                    {group.items.map((item) => (
                      <div key={item.procNum} className="pt-3 first:pt-0">
                        <ProcedureEditor
                          item={item}
                          showHeader
                          frozen={frozen}
                          saving={saving.has(item.procNum)}
                          error={rowErrors[item.procNum] ?? null}
                          latest={() => latest(item)}
                          onSave={(input) => saveEntries([{ procNum: item.procNum, input }])}
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <GroupEditor
                    group={group}
                    frozen={frozen}
                    saving={anySaving}
                    error={firstError}
                    latest={latest}
                    onSaveAll={saveEntries}
                  />
                )}
              </>
            )}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <section className="space-y-3" data-testid="hyg-existing-tx">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {ready && items.length > 0 ? (
          <button
            type="button"
            onClick={() => setExpandedChoice(!expanded)}
            aria-expanded={expanded}
            className="flex min-h-11 items-center gap-1.5 rounded-lg text-left text-muted-foreground"
            data-testid="hyg-existing-tx-collapse"
          >
            {expanded ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}
            <h2 className="text-sm font-semibold uppercase tracking-wide" data-testid="hyg-existing-tx-heading">
              Existing treatment ({items.length}) · {answeredCount} answered · {urgentCount} urgent
            </h2>
            <span className="text-xs">from Open Dental</span>
          </button>
        ) : (
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Existing treatment (from Open Dental)
          </h2>
        )}
        <div className="flex items-center gap-1.5">
          {ready && expanded && !frozen && items.length > 1 ? (
            <button
              type="button"
              onClick={() => {
                setSelecting((s) => !s);
                setSelected(new Set());
                setOpenKey(null);
              }}
              aria-pressed={selecting}
              className={cn(TAP, "border-border text-foreground hover:bg-accent/40")}
              data-testid="hyg-existing-tx-select-mode"
            >
              {selecting ? "Done selecting" : "Select"}
            </button>
          ) : null}
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
          {items.length === 0 ? (
            <p className="rounded-xl border border-border p-3 text-sm text-muted-foreground" data-testid="hyg-existing-tx-none">
              Open Dental has no treatment planned for this patient.
            </p>
          ) : null}

          {expanded && items.length > 0 ? (
            <div className="space-y-1.5" data-testid="hyg-existing-tx-list">
              {mainGroups.map((g) => groupRow(g, "main"))}

              {olderGroups.length > 0 ? (
                showOlder ? (
                  <div className="space-y-1.5 pt-1" data-testid="hyg-existing-tx-older">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Planned before {formatPlainDate(split.cutoff)}
                    </h3>
                    {olderGroups.map((g) => groupRow(g, "older"))}
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setShowOlder(true)}
                    className={cn(TAP, "w-full border-dashed border-border text-muted-foreground hover:bg-accent/40")}
                    data-testid="hyg-existing-tx-show-older"
                  >
                    Show {split.older.length} older {split.older.length === 1 ? "item" : "items"} (planned
                    before {formatPlainDate(split.cutoff)})
                  </button>
                )
              ) : null}

              {scheduledGroups.length > 0 ? (
                <div className="space-y-1.5 pt-1" data-testid="hyg-existing-tx-scheduled-section">
                  <button
                    type="button"
                    onClick={() => setShowScheduled((s) => !s)}
                    aria-expanded={showScheduled}
                    className={cn(TAP, "flex w-full items-center gap-1.5 border-transparent text-left text-muted-foreground hover:bg-accent/40")}
                    data-testid="hyg-existing-tx-show-scheduled"
                  >
                    {showScheduled ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
                    Already scheduled ({split.scheduled.length})
                  </button>
                  {showScheduled ? scheduledGroups.map((g) => groupRow(g, "scheduled")) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {selecting ? (
            <div
              className="sticky bottom-2 z-10 space-y-2 rounded-xl border border-primary/50 bg-background p-3 shadow-lg"
              data-testid="hyg-existing-tx-bulk"
            >
              <div className="text-xs font-semibold text-foreground">
                {selected.size === 0
                  ? "Tick the rows to answer together."
                  : `${selected.size} ${selected.size === 1 ? "row" : "rows"} selected`}
              </div>
              <Question text="What did the patient say?">
                {EXISTING_TX_PATIENT.map((value: ExistingTxPatient) => (
                  <AnswerChip
                    key={value}
                    label={EXISTING_TX_PATIENT_LABELS[value]}
                    active={bulkPatient === value}
                    disabled={false}
                    quiet={value === "not_discussed"}
                    onClick={() => setBulkPatient(value)}
                    testId={`hyg-existing-tx-bulk-patient-${value}`}
                  />
                ))}
              </Question>
              {bulkPatient === "wants_to_wait" ? (
                <Question text="How long do they want to wait?">
                  {EXISTING_TX_WAIT.map((value: ExistingTxWait) => (
                    <AnswerChip
                      key={value}
                      label={EXISTING_TX_WAIT_LABELS[value]}
                      active={bulkWait === value}
                      disabled={false}
                      onClick={() => setBulkWait(bulkWait === value ? null : value)}
                      testId={`hyg-existing-tx-bulk-wait-${value}`}
                    />
                  ))}
                </Question>
              ) : null}
              <Question text="Anything changed clinically? (optional — each row keeps its own if none)">
                {EXISTING_TX_CLINICAL.map((value: ExistingTxClinical) => (
                  <AnswerChip
                    key={value}
                    label={EXISTING_TX_CLINICAL_LABELS[value]}
                    active={bulkClinical === value}
                    disabled={false}
                    onClick={() => setBulkClinical(bulkClinical === value ? null : value)}
                    testId={`hyg-existing-tx-bulk-clinical-${value}`}
                  />
                ))}
              </Question>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={applyBulk}
                  disabled={selected.size === 0 || bulkPatient === null}
                  className={cn(
                    TAP,
                    "border-primary bg-primary text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50",
                  )}
                  data-testid="hyg-existing-tx-bulk-apply"
                >
                  Apply to {selected.size} {selected.size === 1 ? "row" : "rows"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSelecting(false);
                    setSelected(new Set());
                  }}
                  className={cn(TAP, "border-transparent text-muted-foreground")}
                  data-testid="hyg-existing-tx-bulk-cancel"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

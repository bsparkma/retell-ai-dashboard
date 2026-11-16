/**
 * The treatment a hygienist proposes: add it, edit it, take it off.
 *
 * Hygienists enter this on a PHONE, mid-appointment. Every control here works
 * at ~390px wide with a 44px tap target (the code grid is 48px); nothing needs
 * a hover to explain itself.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * PRIORITY AND CATEGORY ARE TWO CONTROLS BECAUSE THEY ARE TWO QUESTIONS
 * ═════════════════════════════════════════════════════════════════════════════
 * Priority is HOW SOON — urgent, preventative, cosmetic. Category is WHAT KIND
 * — Restorative, Endo, Perio, Cosmetic and so on. They share the word
 * "cosmetic", and a screen that put them in one row of chips would be inviting
 * the mix-up that ends with "this can wait" printed on a chart.
 *
 * So they are separate labelled groups, with the question written above each
 * one in words rather than as a noun. Priority sits ON the card ("How soon?",
 * one tap, no Edit); category lives under More ("What kind of work?"). The
 * database enforces the same split with two CHECK constraints; this is the half
 * a person sees.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE SELECTION RULES: ONE TOOTH (DEFAULT) OR SEVERAL TEETH
 * ═════════════════════════════════════════════════════════════════════════════
 * Beau: after adding work to one tooth, picking the next tooth left the first
 * one selected, so the next tap added work to BOTH unless she unselected first.
 *
 * ONE TOOTH (the default). Tapping a tooth REPLACES the selection; tapping the
 * picked tooth clears it. The selection still SURVIVES an add — #30 → Build-up
 * → Crown → RC is three items in three taps, the reason the selection was made
 * sticky in the first place (a crown prep nearly always carries a build-up, and
 * often endo under both). It moves only when she taps another tooth, taps
 * Clear, or switches dentition.
 *
 * SEVERAL TEETH. Tapping toggles teeth in and out. A second switch picks how an
 * add spreads: "Add to each tooth" (default — sealants on four teeth are four
 * items) or "One item across teeth" (a bridge — one item spanning the set).
 * After an add in this mode the selection CLEARS, and the confirmation says so.
 * Switching back to One tooth keeps only the tooth tapped last.
 *
 * NOTHING CLEARS SILENTLY. Every clear is either her tap or stated in the
 * confirmation. A selection that vanished on its own would leave the next tap
 * adding a whole-mouth item, or nothing, with no way to tell which.
 *
 * **Three items, not one item with three codes.** Each procedure carries its
 * own diagnosis, its own priority (a crown can be urgent while a veneer on the
 * same tooth is cosmetic) and its own status.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE CONFIRMATION IS THE SERVER'S WORD, AND IT CAN BE UNDONE
 * ═════════════════════════════════════════════════════════════════════════════
 * After every add or remove a non-blocking line says what happened, with Undo,
 * for about six seconds. It appears only after the server answered: `onAdd`
 * resolves to the visit's items (or null when it failed), `onRemove` to whether
 * it went through. An add-to-each that half-failed names the teeth on each side
 * and never claims all. Undo uses the same create/remove calls — an add's Undo
 * removes exactly the items that add created; a remove's Undo re-creates the
 * item with the same fields.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * NO NESTED INTERACTIVE ELEMENTS
 * ═════════════════════════════════════════════════════════════════════════════
 * A <button> inside a <button> is invalid HTML and React 19 renders it in a way
 * that guts the outer element's hit area — a lesson this repo paid for once in
 * the RCM UX pass. Every card here is a plain <div> with its own buttons inside,
 * never a button wrapping buttons.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowDown, Trash2, X } from "lucide-react";

import {
  DX_LABELS,
  MOTIVATION_LABELS,
  TREATMENT_PRIORITY_LABELS,
  TreatmentCategorySchema,
  TreatmentPrioritySchema,
  TreatmentStatusSchema,
  ToothSurfaceLabelSchema,
  type DxCode,
  type MotivationCode,
  type TreatmentCategory,
  type TreatmentItem,
  type TreatmentItemInput,
  type TreatmentPriority,
  type TreatmentStatus,
  type ToothSurfaceLabel,
} from "@shared/hyg/contract";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { odToothNumbers, teethText, ToothPicker, toothText, type Dentition } from "./ToothPicker";
import {
  addMessage,
  codeWithSurfaces,
  isPromiseLike,
  itemPhrase,
  itemToInput,
  modeHint,
  nextSelection,
  orderSurfaces,
  requestTeeth,
  selectionForMode,
  SURFACE_CODES,
  targetText,
  type SelectionMode,
  type SpreadMode,
} from "./treatmentEntry";
import type { ExistingTxItem } from "@shared/hyg/existingTx";

/**
 * The key an item is grouped under: its tooth set, exactly.
 *
 * By the SET rather than by each tooth, so a single item spanning #3 and #14
 * appears once rather than twice. The common case — one tooth, several
 * procedures — groups the way Beau asked for: #30's build-up, crown and root
 * canal read as one clinical story.
 */
export function toothGroupKey(item: Pick<TreatmentItem, "teeth">): string {
  if (item.teeth === "mouth") return "mouth";
  return [...item.teeth].sort((a, b) => a - b).join(",");
}

/** "#30", "#3, #14", "Whole mouth". */
export function toothGroupLabel(key: string): string {
  if (key === "mouth") return "Whole mouth";
  if (key === "") return "No teeth recorded";
  return key
    .split(",")
    .map((t) => toothText(Number(t)))
    .join(", ");
}

/**
 * Items grouped by tooth set, in the order the groups first appear.
 *
 * Order matters: a hygienist adds #30's three procedures together, so keeping
 * first-appearance order keeps her own sequence rather than re-sorting her work
 * into tooth-number order she never chose.
 */
export function groupByTooth<T extends Pick<TreatmentItem, "teeth">>(
  items: readonly T[],
): { key: string; label: string; items: T[] }[] {
  const groups: { key: string; label: string; items: T[] }[] = [];
  const index = new Map<string, number>();
  for (const item of items) {
    const key = toothGroupKey(item);
    const at = index.get(key);
    if (at === undefined) {
      index.set(key, groups.length);
      groups.push({ key, label: toothGroupLabel(key), items: [item] });
    } else {
      groups[at].items.push(item);
    }
  }
  return groups;
}

/** The office's own shorthand, grouped the way the paper slip groups it. */
const CODE_GROUPS: { label: string; category: TreatmentCategory; codes: string[] }[] = [
  // SSC (stainless steel crown) — feedback round 1. A TOOTH item, on primary
  // and permanent teeth alike, so it is NOT in MOUTH_LEVEL below.
  { label: "Restorative", category: "Restorative", codes: ["Comp", "Amal", "Crown", "SSC", "PFM", "Onlay", "Build-up", "Veneer"] },
  { label: "Endo", category: "Endo", codes: ["RC", "Retreat", "Pulpotomy", "Pulp cap"] },
  { label: "Surgery", category: "Surgery", codes: ["EX", "AB"] },
  { label: "Perio", category: "Perio", codes: ["SRP", "Perio maint", "Graft ½", "Muco"] },
  { label: "Prosth", category: "Prosth", codes: ["IMP", "Mini", "Bridge", "PO", "Denture", "Partial"] },
  { label: "Ortho", category: "Ortho", codes: ["Ortho", "Aligners", "Myobrace"] },
  { label: "Cosmetic", category: "Cosmetic", codes: ["Whitening", "Smile makeover"] },
  { label: "Other", category: "Other", codes: ["Watch", "Sealant", "TMJ", "Sleep apnea"] },
];

/** Codes that describe the whole mouth rather than a tooth. */
const MOUTH_LEVEL = new Set(["Whitening", "Smile makeover", "Ortho", "Aligners", "Myobrace", "Sleep apnea", "TMJ"]);

/** How long the confirmation (and its Undo) stays up. */
const NOTICE_MS = 6000;

const TAP = "min-h-11 rounded-lg border px-3 text-sm font-medium transition-colors";

/** Today's priority colours, now on the card's segmented control. */
const PRIORITY_ACTIVE: Record<TreatmentPriority, string> = {
  urgent: "border-red-300 bg-red-100 text-red-900 dark:border-red-900 dark:bg-red-950/60 dark:text-red-300",
  preventative:
    "border-amber-300 bg-amber-100 text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300",
  cosmetic: "border-border bg-muted text-foreground",
};

function Chip({
  label,
  active,
  onClick,
  testId,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      data-testid={testId}
      className={cn(
        TAP,
        active
          ? "border-primary bg-primary/10 text-foreground"
          : "border-border text-muted-foreground hover:bg-accent/40",
      )}
    >
      {label}
    </button>
  );
}

/** A two-button switch: the shape of every either/or above the chart. */
function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  testIdPrefix,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
  testIdPrefix: string;
}) {
  return (
    <div role="group" aria-label={label} className="grid grid-cols-2 gap-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          data-testid={`${testIdPrefix}-${o.value}`}
          className={cn(
            TAP,
            value === o.value
              ? "border-primary bg-primary/10 text-foreground"
              : "border-border text-muted-foreground hover:bg-accent/40",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function ItemCard({
  item,
  busy,
  onPatch,
  onRemove,
}: {
  item: TreatmentItem;
  busy: boolean;
  onPatch: (patch: Partial<TreatmentItemInput>) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const teeth = item.teeth === "mouth" ? "Whole mouth" : teethText(item.teeth);

  return (
    <div
      className="rounded-xl border border-border bg-card p-3"
      data-testid={`hyg-item-${item.id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-base font-semibold text-foreground">{item.code}</span>
            <span className="text-sm tabular-nums text-muted-foreground">{teeth}</span>
            {item.surfaces && item.surfaces.length > 0 ? (
              <span className="text-sm font-medium text-muted-foreground">
                {item.surfaces.join("")}
              </span>
            ) : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
              {item.category}
            </span>
            <span className="text-xs text-muted-foreground">{item.status}</span>
            {item.dx.length > 0 ? (
              <span className="text-xs text-muted-foreground">Dx {item.dx.join(", ")}</span>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className={cn(TAP, "border-border text-muted-foreground hover:bg-accent/40")}
            data-testid={`hyg-item-edit-${item.id}`}
            aria-expanded={open}
          >
            {open ? "Done" : "More"}
          </button>
          <button
            type="button"
            onClick={onRemove}
            disabled={busy}
            aria-label={`Remove ${item.code}`}
            data-testid={`hyg-item-remove-${item.id}`}
            className={cn(TAP, "border-border px-3 text-destructive hover:bg-destructive/10")}
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      {/*
        HOW SOON? — ON THE CARD, ONE TAP. The question most often changed after
        an add, so it does not hide behind More. Category stays under More with
        its own question (see the header): two questions, two controls.
      */}
      <div className="mt-2" data-testid={`hyg-item-priority-${item.id}`}>
        <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          How soon?
        </div>
        <div role="group" aria-label="How soon?" className="grid grid-cols-3 gap-1">
          {TreatmentPrioritySchema.options.map((p: TreatmentPriority) => {
            const active = item.priority === p;
            return (
              <button
                key={p}
                type="button"
                onClick={() => {
                  if (!active) onPatch({ priority: p });
                }}
                disabled={busy}
                aria-pressed={active}
                data-testid={`hyg-item-${item.id}-priority-${p}`}
                className={cn(
                  TAP,
                  "px-1",
                  active ? PRIORITY_ACTIVE[p] : "border-border text-muted-foreground hover:bg-accent/40",
                )}
              >
                {TREATMENT_PRIORITY_LABELS[p]}
              </button>
            );
          })}
        </div>
      </div>

      {open ? (
        <div className="mt-3 space-y-3 border-t border-border pt-3">
          {/* TWO QUESTIONS, TWO CONTROLS. See the header. */}
          <Field label="What kind of work?" hint="Category. Not the urgency.">
            {TreatmentCategorySchema.options.map((c: TreatmentCategory) => (
              <Chip
                key={c}
                label={c}
                active={item.category === c}
                onClick={() => onPatch({ category: c })}
                testId={`hyg-item-${item.id}-category-${c}`}
              />
            ))}
          </Field>
          <Field label="Where is it?">
            {TreatmentStatusSchema.options.map((st: TreatmentStatus) => (
              <Chip
                key={st}
                label={st}
                active={item.status === st}
                onClick={() => onPatch({ status: st })}
              />
            ))}
          </Field>
          {item.teeth !== "mouth" ? (
            <Field label="Surfaces">
              {ToothSurfaceLabelSchema.options.map((s: ToothSurfaceLabel) => {
                const active = (item.surfaces ?? []).includes(s);
                return (
                  <Chip
                    key={s}
                    label={s}
                    active={active}
                    onClick={() =>
                      onPatch({
                        surfaces: active
                          ? (item.surfaces ?? []).filter((x) => x !== s)
                          : [...(item.surfaces ?? []), s],
                      })
                    }
                  />
                );
              })}
            </Field>
          ) : null}
          <Field label="Diagnosis">
            {(Object.keys(DX_LABELS) as DxCode[]).map((dx) => {
              const active = item.dx.includes(dx);
              return (
                <Chip
                  key={dx}
                  label={dx}
                  active={active}
                  onClick={() =>
                    onPatch({ dx: active ? item.dx.filter((x) => x !== dx) : [...item.dx, dx] })
                  }
                />
              );
            })}
          </Field>
          <Field label="Why the patient might say yes">
            {(Object.keys(MOTIVATION_LABELS) as MotivationCode[]).map((m) => {
              const active = item.motivation.includes(m);
              return (
                <Chip
                  key={m}
                  label={MOTIVATION_LABELS[m]}
                  active={active}
                  onClick={() =>
                    onPatch({
                      motivation: active
                        ? item.motivation.filter((x) => x !== m)
                        : [...item.motivation, m],
                    })
                  }
                />
              );
            })}
          </Field>
          <label className="flex min-h-11 items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              className="h-5 w-5"
              checked={item.scheduleNext}
              onChange={(e) => onPatch({ scheduleNext: e.target.checked })}
              data-testid={`hyg-item-${item.id}-schedule-next`}
            />
            Schedule this at the next restorative visit
          </label>
          <textarea
            className="min-h-[72px] w-full rounded-lg border border-border bg-background p-2 text-sm"
            placeholder="Anything else about this item"
            defaultValue={item.note ?? ""}
            onBlur={(e) => onPatch({ note: e.target.value })}
            data-testid={`hyg-item-${item.id}-note`}
          />
        </div>
      ) : null}
    </div>
  );
}

/** One add, before it is split into requests. */
type AddPlan = {
  code: string;
  category: TreatmentCategory;
  surfaces: ToothSurfaceLabel[];
  mouth: boolean;
};

/** The confirmation line. `undo` resolves to the sentence that replaces it. */
type Notice = {
  id: number;
  text: string;
  tone: "ok" | "warn";
  undo?: () => Promise<string>;
};

export function TreatmentItems({
  items,
  busy,
  onAdd,
  onPatch,
  onRemove,
  onReviewAndSend,
  plannedInOd = [],
}: {
  items: TreatmentItem[];
  busy: boolean;
  /**
   * The procedures Open Dental already has planned (the existing-treatment
   * read). Only for the hint below — it never blocks an add.
   */
  plannedInOd?: readonly Pick<ExistingTxItem, "procNum" | "tooth" | "code" | "description">[];
  /**
   * Create one item. Resolve to the visit's items as the SERVER returned them,
   * or null when the create failed — that is what the confirmation is built
   * from. A handler that returns nothing gets no confirmation: this screen
   * does not claim what it was not told.
   */
  onAdd: (input: TreatmentItemInput) => Promise<readonly TreatmentItem[] | null> | void;
  onPatch: (itemId: string, patch: Partial<TreatmentItemInput>) => void;
  /** Remove one item. Resolve to whether the server removed it. */
  onRemove: (itemId: string) => Promise<boolean> | void;
  /** The end of the form points somewhere. See the page. */
  onReviewAndSend?: () => void;
}) {
  const [dentition, setDentition] = useState<Dentition>("adult");
  const [selected, setSelected] = useState<number[]>([]);
  const [mode, setMode] = useState<SelectionMode>("one");
  const [spread, setSpread] = useState<SpreadMode>("each");
  const [tab, setTab] = useState<string>(CODE_GROUPS[0].label);
  /** Comp / Amal on one tooth: which surfaces, before the add. */
  const [surfaceStep, setSurfaceStep] = useState<{
    code: string;
    category: TreatmentCategory;
    surfaces: ToothSurfaceLabel[];
  } | null>(null);
  /**
   * A Several-teeth add (or an Undo) in flight. Holds the grid and the chart
   * still, so the selection the confirmation talks about is the one she sees.
   */
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeSeq = useRef(0);
  const lastTapped = useRef<number | null>(null);
  /** The selection as of now, for a sentence composed after an await. */
  const selectedRef = useRef<number[]>(selected);
  selectedRef.current = selected;

  /** A pending add that would duplicate something already on the list. */
  const [confirmDuplicate, setConfirmDuplicate] = useState<{
    plan: AddPlan;
    label: string;
  } | null>(null);

  const groups = useMemo(() => groupByTooth(items), [items]);

  // The confirmation steps aside on its own after a few seconds. Keyed by id,
  // so a newer notice is never dismissed by an older one's timer.
  useEffect(() => {
    if (!notice) return;
    const id = notice.id;
    const timer = setTimeout(() => setNotice((n) => (n?.id === id ? null : n)), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  function showNotice(text: string, tone: Notice["tone"], undo?: Notice["undo"]) {
    noticeSeq.current += 1;
    setNotice({ id: noticeSeq.current, text, tone, undo });
  }

  /**
   * ALREADY PLANNED IN OPEN DENTAL, for the teeth picked right now: "#30 already
   * has planned in Open Dental: Crown (D2740), Build-up (D2950)". A HINT, never a
   * block — re-proposing something planned is sometimes exactly right, and the
   * hygienist decides. Whole-mouth items name no tooth, so they hint nothing.
   */
  const odHints = useMemo(() => {
    const out: { tooth: number; text: string }[] = [];
    for (const tooth of [...selected].sort((a, b) => a - b)) {
      const planned = plannedInOd.filter((p) => {
        const teeth = odToothNumbers(p.tooth);
        return Array.isArray(teeth) && teeth.includes(tooth);
      });
      if (planned.length === 0) continue;
      const names = planned.map((p) => {
        const name = p.description.split(/ - |, /)[0].trim() || p.code;
        return p.code && name !== p.code ? `${name} (${p.code})` : name;
      });
      out.push({ tooth, text: `${toothText(tooth)} already has planned in Open Dental: ${names.join(", ")}` });
    }
    return out;
  }, [selected, plannedInOd]);

  const counts = useMemo(() => {
    const out: Record<number, number> = {};
    for (const item of items) {
      if (item.teeth === "mouth") continue;
      for (const tooth of item.teeth) out[tooth] = (out[tooth] ?? 0) + 1;
    }
    return out;
  }, [items]);

  function changeSelection(next: number[]) {
    setSelected(next);
    // A surfaces step belongs to the tooth it was opened for.
    setSurfaceStep(null);
  }

  function onToothTap(tooth: number) {
    if (working) return;
    lastTapped.current = tooth;
    changeSelection(nextSelection(mode, selected, tooth));
  }

  function onModeChange(next: SelectionMode) {
    if (next === mode || working) return;
    setMode(next);
    changeSelection(selectionForMode(next, selected, lastTapped.current));
  }

  /**
   * Is this add already on the list for exactly these teeth? Returns the teeth
   * it collides on, for the dialog, or null. Per tooth for an add-to-each.
   */
  function duplicateLabel(plan: AddPlan): string | null {
    const sets = requestTeeth(plan.mouth, selected, mode, spread);
    const hits = sets.filter((teeth) => {
      const key = toothGroupKey({ teeth });
      return items.some((item) => item.code === plan.code && toothGroupKey(item) === key);
    });
    if (hits.length === 0) return null;
    if (plan.mouth) return "the whole mouth";
    return hits.map((teeth) => toothGroupLabel(toothGroupKey({ teeth }))).join(", ");
  }

  async function commit(plan: AddPlan) {
    const sets = requestTeeth(plan.mouth, selected, mode, spread);
    const perTooth = !plan.mouth && mode === "several" && spread === "each";
    // A Several-teeth add CONSUMES the selection; a whole-mouth add never does.
    const consumes = !plan.mouth && mode === "several";
    const label = codeWithSurfaces(plan.code, plan.surfaces);

    const known = new Set(items.map((i) => i.id));
    const created: TreatmentItem[] = [];
    const added: (number[] | "mouth")[] = [];
    const failed: (number[] | "mouth")[] = [];
    let reported = true;

    if (consumes) setWorking(true);
    try {
      // ONE AT A TIME, so each answer can be told apart from the next and a
      // partial failure can name exactly which teeth did not land.
      for (const teeth of sets) {
        const result = onAdd({
          teeth,
          code: plan.code,
          category: plan.category,
          surfaces: plan.surfaces,
          dx: [],
          // The DEFAULT is preventative, not urgent. A default of "urgent" would
          // make the word mean nothing by the end of the first week.
          priority: "preventative",
          motivation: [],
          status: "proposed",
          scheduleNext: false,
          photos: [],
        });
        if (!isPromiseLike<readonly TreatmentItem[] | null>(result)) {
          reported = false;
          continue;
        }
        let after: readonly TreatmentItem[] | null;
        try {
          after = await result;
        } catch {
          after = null;
        }
        if (after === null) {
          failed.push(teeth);
          continue;
        }
        added.push(teeth);
        for (const item of after) {
          if (!known.has(item.id)) {
            known.add(item.id);
            created.push(item);
          }
        }
      }
    } finally {
      if (consumes) setWorking(false);
    }

    // The handler said nothing about what the server did, so neither do we.
    if (!reported) return;

    /*
     * ONE TOOTH: THE SELECTION SURVIVES THE ADD. #30 → Build-up → Crown → RC is
     * three items in three taps. SEVERAL TEETH: it clears — but only the teeth
     * that landed; a tooth whose add failed stays picked so she can try again.
     * Either way the sentence below says which.
     */
    let after: Parameters<typeof addMessage>[0]["after"] = { kind: "kept", selected: selectedRef.current };
    if (consumes && added.length > 0) {
      const left = failed.flatMap((t) => (t === "mouth" ? [] : t));
      changeSelection(left);
      after = failed.length > 0 ? { kind: "kept", selected: left } : { kind: "cleared" };
    }

    const text = addMessage({ label, added, failed, perTooth, after });
    showNotice(
      text,
      failed.length > 0 ? "warn" : "ok",
      created.length > 0 ? () => undoAdd(created, label) : undefined,
    );
  }

  /** Undo an add: remove exactly the items it created, and say how that went. */
  async function undoAdd(created: readonly TreatmentItem[], label: string): Promise<string> {
    let removed = 0;
    setWorking(true);
    try {
      for (const item of created) {
        const result = onRemove(item.id);
        if (!isPromiseLike<boolean>(result)) continue;
        try {
          if (await result) removed += 1;
        } catch {
          // Counted as not removed; said below.
        }
      }
    } finally {
      setWorking(false);
    }
    const what = created.length === 1 ? itemPhrase(created[0]) : `${label} on ${created.length} teeth`;
    if (removed === created.length) return `Undone. Removed ${what}.`;
    if (removed === 0) return `Undo did not go through — ${what} is still on the list.`;
    return `Undo removed ${removed} of ${created.length} (${label}); the rest are still on the list.`;
  }

  async function remove(item: TreatmentItem) {
    const result = onRemove(item.id);
    if (!isPromiseLike<boolean>(result)) return;
    let ok = false;
    try {
      ok = await result;
    } catch {
      ok = false;
    }
    if (!ok) {
      showNotice(`${itemPhrase(item)} was not removed.`, "warn");
      return;
    }
    showNotice(`Removed ${itemPhrase(item)}.`, "ok", () => undoRemove(item));
  }

  /** Undo a remove: create the same item again, same fields. */
  async function undoRemove(item: TreatmentItem): Promise<string> {
    const result = onAdd(itemToInput(item));
    if (!isPromiseLike<readonly TreatmentItem[] | null>(result)) return "Undo sent.";
    let after: readonly TreatmentItem[] | null = null;
    setWorking(true);
    try {
      after = await result;
    } catch {
      after = null;
    } finally {
      setWorking(false);
    }
    return after
      ? `Put back ${itemPhrase(item)}.`
      : `Undo did not go through — ${itemPhrase(item)} was not put back.`;
  }

  async function runUndo(n: Notice) {
    if (!n.undo) return;
    // The Undo button goes away the moment it is tapped: one tap, one undo.
    setNotice({ id: n.id, text: "Undoing…", tone: "ok" });
    const text = await n.undo();
    showNotice(text, /did not|removed \d+ of/.test(text) ? "warn" : "ok");
  }

  function request(plan: AddPlan) {
    const dup = duplicateLabel(plan);
    if (dup) {
      // A CONFIRM, NOT A BLOCK. Two crowns on one tooth is usually a slip and
      // occasionally a retreat, and only the person holding the mirror knows
      // which. Refusing outright would make the app wrong about a real case.
      setConfirmDuplicate({ plan, label: dup });
      return;
    }
    void commit(plan);
  }

  function tapCode(code: string, category: TreatmentCategory) {
    const mouth = MOUTH_LEVEL.has(code);
    if (!mouth && selected.length === 0) return;
    if (!mouth && mode === "one" && SURFACE_CODES.has(code)) {
      // Comp and Amal are written with surfaces. On one tooth, ask now — it is
      // optional, and the card can still change them afterwards.
      setSurfaceStep({ code, category, surfaces: [] });
      return;
    }
    request({ code, category, surfaces: [], mouth });
  }

  const target = targetText(selected);
  const activeGroup = CODE_GROUPS.find((g) => g.label === tab) ?? CODE_GROUPS[0];

  return (
    <section className="space-y-3" data-testid="hyg-treatment">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Treatment identified today
      </h2>

      {/* SELECTION MODE — above the chart, because it changes what a tap on the chart does. */}
      <div className="space-y-1.5" data-testid="hyg-select-mode">
        <Segmented<SelectionMode>
          label="How tooth taps work"
          value={mode}
          onChange={onModeChange}
          testIdPrefix="hyg-select-mode"
          options={[
            { value: "one", label: "One tooth" },
            { value: "several", label: "Several teeth" },
          ]}
        />
        {mode === "several" ? (
          <Segmented<SpreadMode>
            label="How an add spreads across the teeth"
            value={spread}
            onChange={(v) => {
              if (!working) setSpread(v);
            }}
            testIdPrefix="hyg-spread"
            options={[
              { value: "each", label: "Add to each tooth" },
              { value: "across", label: "One item across teeth" },
            ]}
          />
        ) : null}
        <p className="text-xs text-muted-foreground" data-testid="hyg-select-mode-hint">
          {modeHint(mode, spread)}
        </p>
      </div>

      <ToothPicker
        dentition={dentition}
        selected={selected}
        counts={counts}
        onToggle={onToothTap}
        onDentitionChange={(d) => {
          if (working) return;
          setDentition(d);
          // Switching dentition changes what the numbers MEAN, so a selection
          // carried across would be a selection of different teeth.
          changeSelection([]);
        }}
      />

      <div className="rounded-xl border border-dashed border-border p-3">
        {/* THE TARGET, ALWAYS: what the next tap on a code lands on. */}
        <div className="mb-2 flex min-h-11 items-center justify-between gap-2">
          <span
            className={cn(
              "text-sm font-semibold tabular-nums",
              selected.length > 0 ? "text-foreground" : "text-muted-foreground",
            )}
            data-testid="hyg-add-selection"
          >
            {target}
          </span>
          {selected.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                if (!working) changeSelection([]);
              }}
              className={cn(TAP, "border-border text-muted-foreground hover:bg-accent/40")}
              data-testid="hyg-clear-selection"
            >
              <X size={14} className="mr-1 inline" />
              Clear
            </button>
          ) : null}
        </div>
        {odHints.length > 0 ? (
          <ul className="mb-2 space-y-0.5 text-xs text-amber-800 dark:text-amber-300" data-testid="hyg-od-planned-hint">
            {odHints.map((h) => (
              <li key={h.tooth} data-testid={`hyg-od-planned-hint-${h.tooth}`}>
                {h.text}
              </li>
            ))}
          </ul>
        ) : null}

        {/* CATEGORY TABS — one row that scrolls sideways on a phone, never wraps into a second. */}
        <div
          role="tablist"
          aria-label="Kind of work"
          className="-mx-1 mb-2 flex gap-1.5 overflow-x-auto px-1 pb-1"
          data-testid="hyg-code-tabs"
        >
          {CODE_GROUPS.map((group) => {
            const active = group.label === activeGroup.label;
            return (
              <button
                key={group.label}
                type="button"
                role="tab"
                id={`hyg-code-tab-${group.label}`}
                aria-selected={active}
                aria-controls={`hyg-code-panel-${group.label}`}
                onClick={() => setTab(group.label)}
                data-testid={`hyg-code-tab-${group.label}`}
                className={cn(
                  TAP,
                  "shrink-0 whitespace-nowrap",
                  active
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground hover:bg-accent/40",
                )}
              >
                {group.label}
              </button>
            );
          })}
        </div>

        {/*
          ONE PANEL PER GROUP, the inactive ones hidden (the ARIA tabs pattern),
          so every code keeps one stable control whichever tab is showing.
        */}
        {CODE_GROUPS.map((group) => {
          const needsTooth = selected.length === 0 && group.codes.some((c) => !MOUTH_LEVEL.has(c));
          return (
            <div
              key={group.label}
              role="tabpanel"
              id={`hyg-code-panel-${group.label}`}
              aria-labelledby={`hyg-code-tab-${group.label}`}
              hidden={group.label !== activeGroup.label}
              data-testid={`hyg-code-panel-${group.label}`}
            >
              {needsTooth ? (
                <p className="mb-1.5 text-xs text-muted-foreground" data-testid={`hyg-code-panel-hint-${group.label}`}>
                  Pick a tooth first.{" "}
                  {group.codes.some((c) => MOUTH_LEVEL.has(c)) ? "Whole-mouth items need none." : ""}
                </p>
              ) : null}
              <div className="grid grid-cols-3 gap-1.5">
                {group.codes.map((code) => {
                  const mouth = MOUTH_LEVEL.has(code);
                  const disabled = busy || working || (!mouth && selected.length === 0);
                  return (
                    <button
                      key={code}
                      type="button"
                      disabled={disabled}
                      onClick={() => tapCode(code, group.category)}
                      data-testid={`hyg-add-${code}`}
                      className={cn(
                        "flex min-h-12 flex-col items-center justify-center rounded-lg border px-1 text-sm font-medium leading-tight transition-colors",
                        surfaceStep?.code === code
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border",
                        disabled
                          ? "cursor-not-allowed text-muted-foreground/50"
                          : "text-foreground hover:bg-accent/50",
                      )}
                      // A disabled control that does not say why is a control
                      // somebody taps three times and then distrusts.
                      title={disabled && !mouth ? "Pick a tooth first" : undefined}
                    >
                      <span>{code}</span>
                      {mouth ? (
                        <span className="text-[11px] font-normal text-muted-foreground">whole mouth</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}

        {surfaceStep && selected.length === 1 ? (
          <div
            className="mt-3 space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-3"
            data-testid="hyg-surfaces-step"
          >
            <div className="text-sm font-semibold text-foreground">
              {surfaceStep.code} on {toothText(selected[0])}: which surfaces?
            </div>
            <div role="group" aria-label="Surfaces" className="grid grid-cols-5 gap-1">
              {ToothSurfaceLabelSchema.options.map((s: ToothSurfaceLabel) => {
                const active = surfaceStep.surfaces.includes(s);
                return (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={active}
                    onClick={() =>
                      setSurfaceStep({
                        ...surfaceStep,
                        surfaces: active
                          ? surfaceStep.surfaces.filter((x) => x !== s)
                          : orderSurfaces([...surfaceStep.surfaces, s]),
                      })
                    }
                    data-testid={`hyg-surface-${s}`}
                    className={cn(
                      TAP,
                      "px-0",
                      active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border text-foreground hover:bg-accent/40",
                    )}
                  >
                    {s}
                  </button>
                );
              })}
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => setSurfaceStep(null)}
                className={cn(TAP, "border-border text-muted-foreground hover:bg-accent/40")}
                data-testid="hyg-surfaces-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy || working}
                onClick={() => {
                  const step = surfaceStep;
                  setSurfaceStep(null);
                  request({
                    code: step.code,
                    category: step.category,
                    surfaces: orderSurfaces(step.surfaces),
                    mouth: false,
                  });
                }}
                className={cn(TAP, "border-primary bg-primary text-primary-foreground")}
                data-testid="hyg-surfaces-add"
              >
                Add {codeWithSurfaces(surfaceStep.code, surfaceStep.surfaces)}
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="hyg-treatment-empty">
          Nothing proposed yet. A visit with no treatment on it is a normal visit.
        </p>
      ) : (
        // GROUPED BY TOOTH, so #30's build-up, crown and root canal read as one
        // clinical story rather than three unrelated rows.
        <div className="space-y-3" data-testid="hyg-treatment-groups">
          {groups.map((group) => (
            <div key={group.key} data-testid={`hyg-tooth-group-${group.key}`}>
              <div className="mb-1 flex items-baseline gap-2">
                <span className="text-sm font-semibold text-foreground">{group.label}</span>
                <span className="text-xs text-muted-foreground">
                  {group.items.length} {group.items.length === 1 ? "procedure" : "procedures"}
                </span>
              </div>
              <div className="space-y-2">
                {group.items.map((item) => (
                  <ItemCard
                    key={item.id}
                    item={item}
                    busy={busy || working}
                    onPatch={(patch) => onPatch(item.id, patch)}
                    onRemove={() => void remove(item)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/*
        THE END OF THE FORM POINTS SOMEWHERE.
        Beau, at the bottom of the page: "I do not know where to go or what to
        do next." If the founder cannot find Send, a hygienist mid-appointment
        cannot either. On a wide screen the tray is beside this and sticky; on a
        narrow one it is below, and this is how you get there.
      */}
      {onReviewAndSend ? (
        <button
          type="button"
          onClick={onReviewAndSend}
          className={cn(
            TAP,
            "flex w-full items-center justify-center gap-2 border-primary bg-primary/10 text-foreground",
          )}
          data-testid="hyg-review-and-send"
        >
          Review &amp; send
          <ArrowDown size={16} className="lg:hidden" />
        </button>
      ) : null}

      {/*
        THE CONFIRMATION. Non-blocking: pinned to the bottom of the screen where
        a thumb already is, nothing behind it is covered for long, and it never
        takes focus away from the chart.
      */}
      {notice ? (
        <div
          role="status"
          aria-live="polite"
          className={cn(
            "fixed inset-x-4 bottom-4 z-40 mx-auto flex max-w-md items-center gap-3 rounded-xl border p-3 shadow-lg",
            notice.tone === "warn"
              ? "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
              : "border-border bg-card text-foreground",
          )}
          data-testid="hyg-treatment-notice"
        >
          <span className="min-w-0 flex-1 text-sm" data-testid="hyg-treatment-notice-text">
            {notice.text}
          </span>
          {notice.undo ? (
            <button
              type="button"
              onClick={() => void runUndo(notice)}
              className={cn(TAP, "shrink-0 border-primary text-foreground")}
              data-testid="hyg-treatment-undo"
            >
              Undo
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="Dismiss"
            className={cn(TAP, "shrink-0 border-transparent px-2 text-muted-foreground")}
            data-testid="hyg-treatment-notice-dismiss"
          >
            <X size={16} />
          </button>
        </div>
      ) : null}

      <Dialog
        open={confirmDuplicate !== null}
        onOpenChange={(open) => !open && setConfirmDuplicate(null)}
      >
        <DialogContent data-testid="hyg-duplicate-confirm">
          {confirmDuplicate && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-500" />
                  {confirmDuplicate.plan.code} is already on the list for {confirmDuplicate.label}
                </DialogTitle>
                <DialogDescription>
                  Adding it again gives this visit two of them. That is right for a retreat and
                  usually a slip otherwise — your call.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <button
                  type="button"
                  onClick={() => setConfirmDuplicate(null)}
                  className={cn(TAP, "border-transparent text-muted-foreground")}
                  data-testid="hyg-duplicate-cancel"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const { plan } = confirmDuplicate;
                    setConfirmDuplicate(null);
                    void commit(plan);
                  }}
                  className={cn(TAP, "border-primary bg-primary text-primary-foreground")}
                  data-testid="hyg-duplicate-accept"
                >
                  Add it again
                </button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

/**
 * The treatment a hygienist proposes: add it, edit it, take it off.
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
 * one in words rather than as a noun. The database enforces the same split with
 * two CHECK constraints; this is the half a person sees.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * NO NESTED INTERACTIVE ELEMENTS
 * ═════════════════════════════════════════════════════════════════════════════
 * A <button> inside a <button> is invalid HTML and React 19 renders it in a way
 * that guts the outer element's hit area — a lesson this repo paid for once in
 * the RCM UX pass. Every card here is a plain <div> with its own buttons inside,
 * never a button wrapping buttons.
 */
import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";

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
import { cn } from "@/lib/utils";
import { ToothPicker, toothLabel, type Dentition } from "./ToothPicker";

/** The office's own shorthand, grouped the way the paper slip groups it. */
const CODE_GROUPS: { label: string; category: TreatmentCategory; codes: string[] }[] = [
  { label: "Restorative", category: "Restorative", codes: ["Comp", "Amal", "Crown", "PFM", "Onlay", "Build-up", "Veneer"] },
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

const TAP = "min-h-11 rounded-lg border px-3 text-sm font-medium transition-colors";

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
  const teeth = item.teeth === "mouth" ? "Whole mouth" : item.teeth.map(toothLabel).map((t) => `#${t}`).join(", ");

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
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-xs font-semibold",
                item.priority === "urgent"
                  ? "bg-red-100 text-red-900 dark:bg-red-950/60 dark:text-red-300"
                  : item.priority === "preventative"
                    ? "bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-300"
                    : "bg-muted text-muted-foreground",
              )}
              data-testid={`hyg-item-priority-${item.id}`}
            >
              {TREATMENT_PRIORITY_LABELS[item.priority]}
            </span>
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
            {open ? "Done" : "Edit"}
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

      {open ? (
        <div className="mt-3 space-y-3 border-t border-border pt-3">
          {/* TWO QUESTIONS, TWO CONTROLS. See the header. */}
          <Field label="How soon?" hint="Urgency. Not the kind of work.">
            {TreatmentPrioritySchema.options.map((p: TreatmentPriority) => (
              <Chip
                key={p}
                label={TREATMENT_PRIORITY_LABELS[p]}
                active={item.priority === p}
                onClick={() => onPatch({ priority: p })}
                testId={`hyg-item-${item.id}-priority-${p}`}
              />
            ))}
          </Field>
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

export function TreatmentItems({
  items,
  busy,
  onAdd,
  onPatch,
  onRemove,
}: {
  items: TreatmentItem[];
  busy: boolean;
  onAdd: (input: TreatmentItemInput) => void;
  onPatch: (itemId: string, patch: Partial<TreatmentItemInput>) => void;
  onRemove: (itemId: string) => void;
}) {
  const [dentition, setDentition] = useState<Dentition>("adult");
  const [selected, setSelected] = useState<number[]>([]);

  const counts = useMemo(() => {
    const out: Record<number, number> = {};
    for (const item of items) {
      if (item.teeth === "mouth") continue;
      for (const tooth of item.teeth) out[tooth] = (out[tooth] ?? 0) + 1;
    }
    return out;
  }, [items]);

  function add(code: string, category: TreatmentCategory) {
    const mouth = MOUTH_LEVEL.has(code);
    if (!mouth && selected.length === 0) return;
    onAdd({
      teeth: mouth ? "mouth" : [...selected].sort((a, b) => a - b),
      code,
      category,
      surfaces: [],
      dx: [],
      // The DEFAULT is preventative, not urgent. A default of "urgent" would
      // make the word mean nothing by the end of the first week.
      priority: "preventative",
      motivation: [],
      status: "proposed",
      scheduleNext: false,
      photos: [],
    });
    setSelected([]);
  }

  return (
    <section className="space-y-3" data-testid="hyg-treatment">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Treatment identified today
      </h2>

      <ToothPicker
        dentition={dentition}
        selected={selected}
        counts={counts}
        onToggle={(tooth) =>
          setSelected((prev) =>
            prev.includes(tooth) ? prev.filter((t) => t !== tooth) : [...prev, tooth],
          )
        }
        onDentitionChange={(d) => {
          setDentition(d);
          setSelected([]);
        }}
      />

      <div className="rounded-xl border border-dashed border-border p-3">
        <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
          <Plus size={16} />
          {selected.length > 0 ? (
            <span data-testid="hyg-add-selection">
              {selected.map((t) => `#${toothLabel(t)}`).join(", ")} — pick the work
            </span>
          ) : (
            <span data-testid="hyg-add-selection">
              Pick teeth above, then the work. Whole-mouth items need no teeth.
            </span>
          )}
        </div>
        <div className="space-y-2">
          {CODE_GROUPS.map((group) => (
            <div key={group.label} className="flex flex-wrap items-center gap-1.5">
              <span className="w-24 shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {group.label}
              </span>
              {group.codes.map((code) => {
                const mouth = MOUTH_LEVEL.has(code);
                const disabled = busy || (!mouth && selected.length === 0);
                return (
                  <button
                    key={code}
                    type="button"
                    disabled={disabled}
                    onClick={() => add(code, group.category)}
                    data-testid={`hyg-add-${code}`}
                    className={cn(
                      TAP,
                      "border-border",
                      disabled
                        ? "cursor-not-allowed text-muted-foreground/50"
                        : "text-foreground hover:bg-accent/50",
                    )}
                    // A disabled control that does not say why is a control
                    // somebody taps three times and then distrusts.
                    title={disabled && !mouth ? "Pick a tooth first" : undefined}
                  >
                    {code}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="hyg-treatment-empty">
          Nothing proposed yet. A visit with no treatment on it is a normal visit.
        </p>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <ItemCard
              key={item.id}
              item={item}
              busy={busy}
              onPatch={(patch) => onPatch(item.id, patch)}
              onRemove={() => onRemove(item.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

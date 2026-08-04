/**
 * COB calculator UI — DentaFlow COBView arrangement (TC-app FloatingCalc.tsx
 * lines ~1294–1654) rebuilt on platform semantic tokens.
 *
 * DOLLARS DOMAIN: this is a pure scratchpad over user-typed dollar amounts.
 * calcCOB (ported verbatim, regression-tested — DO NOT modify the math) takes
 * and returns dollars, so results render through this component's own Intl
 * formatter — NOT formatCents. No case money flows through here.
 *
 * Platform adaptations vs DentaFlow:
 *  - Dark "display" panels use the var(--sidebar) family so dark mode works.
 *
 * Slice 5 brings the legacy "Pull from Open Dental" panel and the OD cross-check
 * pill live (see od/OdCobPull). The pull pre-fills REMAINING max and deductible
 * from the patient's year-to-date usage, and states the basis of those numbers —
 * the OD Cloud API cannot see claimproc, so the basis is genuinely narrower than
 * the legacy MySQL query's and the user is told exactly how.
 *
 * State can be lifted (state/onStateChange) so FloatingCalc preserves inputs
 * across dialog open/close; the page uses it uncontrolled.
 */
import { useMemo, useState } from "react";
import type { OfficeId } from "@shared/tc/contract";
import { CopyPlus, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { OdCobPull, type OdCobPullResult } from "../od/OdCobPull";
import { describeCode } from "../od/odCodes";
import {
  calcCOB,
  type COBInput,
  type COBMethod,
  type COBPlanInput,
  type MobVariant,
} from "../lib/calcCOB";

// ── State (string drafts — user-typed dollars) ──────────────────────────────

export interface CobPlanDraft {
  allowed: string;
  pct: string;
  ded: string;
  hasMax: boolean;
  max: string;
  inNetwork: boolean;
}

export interface CobLineDraft {
  id: string;
  label: string;
  fee: string;
  pAllowed: string;
  pPct: string;
  sAllowed: string;
  sPct: string;
  /** Per-line contracted fee override — only used when both plans in-network. */
  contracted: string;
}

export interface CobCalcState {
  method: COBMethod;
  mobVariant: MobVariant;
  subMode: "single" | "line-items";
  secondaryWaivesDeductible: boolean;
  primary: CobPlanDraft;
  secondary: CobPlanDraft;
  dentistFee: string;
  contractedFeeOverride: string;
  lineItems: CobLineDraft[];
}

let idCounter = 0;
function newId(): string {
  idCounter += 1;
  return `line-${idCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Legacy FloatingCalc's starting scenario (Crown, Delta-on-Delta-ish). */
export function defaultCobCalcState(): CobCalcState {
  return {
    method: "full-cob",
    mobVariant: "carveout",
    subMode: "single",
    secondaryWaivesDeductible: false,
    primary: { allowed: "1000", pct: "50", ded: "0", hasMax: true, max: "1500", inNetwork: true },
    secondary: { allowed: "1100", pct: "60", ded: "50", hasMax: true, max: "1500", inNetwork: false },
    dentistFee: "1300",
    contractedFeeOverride: "",
    lineItems: [
      {
        id: newId(),
        label: "Crown",
        fee: "1300",
        pAllowed: "1000",
        pPct: "50",
        sAllowed: "1100",
        sPct: "60",
        contracted: "",
      },
    ],
  };
}

// ── Dollars-domain parsing/formatting (deliberately NOT money.ts) ───────────

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function fmt(n: number): string {
  return Number.isFinite(n) ? usd.format(n) : "—";
}

function toAmount(s: string): number {
  const cleaned = s.replace(/[$,\s]/g, "");
  if (cleaned === "") return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function toPct(s: string): number {
  const cleaned = s.replace(/[%,\s]/g, "");
  if (cleaned === "") return 0;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

function sanitizeNumeric(raw: string): string {
  return raw.replace(/[^0-9.,]/g, "");
}

/** Map string-draft state → calcCOB input. Exported so FloatingCalc can build
 * the COB copy-text from the same lifted state without duplicating parsing. */
export function cobInputFromState(st: CobCalcState): COBInput {
  const bothInNetwork = st.primary.inNetwork && st.secondary.inNetwork;
  const overrideAmount = toAmount(st.contractedFeeOverride);
  const planInput = (p: CobPlanDraft): COBPlanInput => ({
    allowedAmount: toAmount(p.allowed),
    coveragePct: toPct(p.pct),
    remainingDeductible: toAmount(p.ded),
    hasAnnualMax: p.hasMax,
    remainingAnnualMax: toAmount(p.max),
    inNetwork: p.inNetwork,
  });
  return {
    method: st.method,
    mobVariant: st.mobVariant,
    secondaryWaivesDeductible: st.secondaryWaivesDeductible,
    primary: planInput(st.primary),
    secondary: planInput(st.secondary),
    ...(st.subMode === "single" ? { dentistFee: toAmount(st.dentistFee) } : {}),
    ...(st.subMode === "single" && bothInNetwork && overrideAmount > 0
      ? { contractedFeeOverride: overrideAmount }
      : {}),
    ...(st.subMode === "line-items"
      ? {
          lineItems: st.lineItems.map((l) => {
            const contracted = toAmount(l.contracted);
            return {
              label: l.label,
              dentistFee: toAmount(l.fee),
              primaryAllowed: toAmount(l.pAllowed),
              primaryCoveragePct: toPct(l.pPct),
              secondaryAllowed: toAmount(l.sAllowed),
              secondaryCoveragePct: toPct(l.sPct),
              ...(bothInNetwork && contracted > 0
                ? { contractedFeeOverride: contracted }
                : {}),
            };
          }),
        }
      : {}),
  };
}

const FORMULA_DESCRIPTION: Record<string, string> = {
  "full-cob":
    "Secondary pays the patient's full remaining balance, capped only by its remaining annual max. Matches how Delta-on-Delta and most full-COB carriers actually adjudicate.",
  standard:
    "Secondary pays the lesser of (a) what it would pay as primary, and (b) the balance after primary.",
  "non-duplication":
    "Secondary pays only the difference between what it would have paid and what primary paid (often $0 when plans are similar).",
  "mob-carveout": "Secondary pays the difference, capped at the balance after primary.",
  "mob-coinsurance":
    "Secondary pays its coverage % of the balance after primary, capped at what it would pay as primary.",
};

// ── Small building blocks (DentaFlow field/chip styling, semantic tokens) ───

function CalcField({
  label,
  value,
  onChange,
  percent = false,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  percent?: boolean;
  hint?: string;
}) {
  return (
    <label className="block rounded-lg bg-background border border-border px-2.5 py-2 cursor-text focus-within:border-primary focus-within:ring-1 focus-within:ring-primary/30 transition-colors">
      <span className="block text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
        {label}
      </span>
      <span className="flex items-baseline gap-1 mt-0.5">
        {!percent && <span className="text-sm text-muted-foreground">$</span>}
        <input
          inputMode="decimal"
          className="flex-1 min-w-0 border-0 outline-none bg-transparent text-lg font-bold text-foreground tabular-nums"
          value={value}
          onChange={(e) => onChange(sanitizeNumeric(e.target.value))}
        />
        {percent && <span className="text-sm text-muted-foreground">%</span>}
      </span>
      {hint && <span className="block text-[10px] text-muted-foreground mt-0.5">{hint}</span>}
    </label>
  );
}

function MethodChip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full text-[11px] font-semibold px-3 py-1.5 border transition-colors ${
        active
          ? "bg-primary text-primary-foreground border-primary"
          : "bg-card text-muted-foreground border-border hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );
}

function PlanCard({
  title,
  plan,
  onPatch,
  showAllowedAndPct,
}: {
  title: string;
  plan: CobPlanDraft;
  onPatch: (p: Partial<CobPlanDraft>) => void;
  showAllowedAndPct: boolean;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-3 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-bold text-foreground">{title}</p>
        <button
          type="button"
          onClick={() => onPatch({ inNetwork: !plan.inNetwork })}
          className={`text-[10px] font-semibold rounded-full px-2 py-0.5 border transition-colors ${
            plan.inNetwork
              ? "bg-primary text-primary-foreground border-primary"
              : "bg-muted text-muted-foreground border-border"
          }`}
        >
          {plan.inNetwork ? "In-network" : "Out-of-network"}
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {showAllowedAndPct && (
          <CalcField
            label="Allowed Amount"
            value={plan.allowed}
            onChange={(v) => onPatch({ allowed: v })}
          />
        )}
        {showAllowedAndPct && (
          <CalcField
            label="Coverage %"
            percent
            value={plan.pct}
            onChange={(v) => onPatch({ pct: v })}
          />
        )}
        <CalcField label="Ded Remaining" value={plan.ded} onChange={(v) => onPatch({ ded: v })} />
        <div>
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground pt-1">
            <Switch
              checked={plan.hasMax}
              onCheckedChange={(checked) => onPatch({ hasMax: checked })}
            />
            {plan.hasMax ? "Remaining annual max" : "Annual max — unlimited"}
          </label>
          {plan.hasMax && (
            <div className="mt-1.5">
              <CalcField
                label="Max Remaining"
                value={plan.max}
                onChange={(v) => onPatch({ max: v })}
                hint="Enter what's LEFT for the year, not the plan's full max."
              />
            </div>
          )}
        </div>
      </div>
      {!showAllowedAndPct && (
        <p className="text-[10px] text-muted-foreground">
          Allowed amount &amp; coverage % are set per line below. Annual max here
          caps this plan&apos;s <em>total</em> payout across all lines.
        </p>
      )}
    </div>
  );
}

// ── Component ───────────────────────────────────────────────────────────────

/**
 * Build a calculator state from a pulled Open Dental patient.
 *
 * Ported from the legacy FloatingCalc pre-fill. Two things matter:
 *  - REMAINING max/deductible go into the fields (the fields mean "what's left",
 *    per their own hint text), computed server-side from year-to-date usage.
 *  - a value Open Dental did not give us is left as the user typed it, never
 *    zeroed. A blank field invites a correction; a confident 0 does not.
 */
export function cobStateFromOdPull(current: CobCalcState, pull: OdCobPullResult): CobCalcState {
  const primary = pull.insurance.plans.find((p) => p.role === "primary") ?? null;
  const secondary = pull.insurance.plans.find((p) => p.role === "secondary") ?? null;

  const planDraft = (
    base: CobPlanDraft,
    plan: typeof primary,
  ): CobPlanDraft => {
    if (!plan) return base;
    const remainingMax = plan.remainingMax;
    const remainingDed = plan.remainingDeductible;
    const pct = plan.coinsurance[0]?.percent;
    return {
      ...base,
      pct: pct != null ? String(pct) : base.pct,
      ded: remainingDed != null ? String(remainingDed) : base.ded,
      hasMax: plan.annualMax != null ? true : base.hasMax,
      max: remainingMax != null ? String(remainingMax) : base.max,
      // PPO/Copay plans are the in-network case; "" (percentage) is not.
      inNetwork: plan.planType === "p" || plan.planType === "f" ? true : base.inNetwork,
    };
  };

  const lineItems: CobLineDraft[] = pull.cob.procs.map((p) => ({
    id: newId(),
    label: describeCode(p.procCode, p.description),
    fee: String(p.fee),
    // Allowed amounts are the billed fee whenever OD could not give a contracted
    // one; OdCobPull surfaces the count so the user knows to override.
    pAllowed: String(p.primaryAllowed),
    pPct: primary?.coinsurance[0]?.percent != null ? String(primary.coinsurance[0].percent) : "",
    sAllowed: p.secondaryAllowed != null ? String(p.secondaryAllowed) : String(p.fee),
    sPct: secondary?.coinsurance[0]?.percent != null ? String(secondary.coinsurance[0].percent) : "",
    contracted: "",
  }));

  const firstFee = pull.cob.procs[0]?.fee;

  return {
    ...current,
    primary: planDraft(current.primary, primary),
    secondary: planDraft(current.secondary, secondary),
    // Line items only when OD actually returned procedures — an empty plan must
    // not wipe what the user already typed.
    ...(lineItems.length > 0
      ? { subMode: "line-items" as const, lineItems, dentistFee: String(firstFee ?? current.dentistFee) }
      : {}),
  };
}

export function CobCalculator({
  compact = false,
  office,
  state,
  onStateChange,
}: {
  compact?: boolean;
  /**
   * Office for the Open Dental pull. Omitted → the pull panel is not rendered
   * (the calculator is pure math and still works standalone).
   */
  office?: OfficeId;
  /** Controlled state (FloatingCalc lifts it to survive dialog close). */
  state?: CobCalcState;
  onStateChange?: (next: CobCalcState) => void;
}) {
  const [inner, setInner] = useState<CobCalcState>(defaultCobCalcState);
  const [odPull, setOdPull] = useState<OdCobPullResult | null>(null);
  const st = state ?? inner;

  function apply(next: CobCalcState) {
    if (state !== undefined && onStateChange) onStateChange(next);
    else setInner(next);
  }
  const patch = (p: Partial<CobCalcState>) => apply({ ...st, ...p });
  const patchPrimary = (p: Partial<CobPlanDraft>) =>
    apply({ ...st, primary: { ...st.primary, ...p } });
  const patchSecondary = (p: Partial<CobPlanDraft>) =>
    apply({ ...st, secondary: { ...st.secondary, ...p } });
  const patchLine = (id: string, p: Partial<CobLineDraft>) =>
    apply({
      ...st,
      lineItems: st.lineItems.map((l) => (l.id === id ? { ...l, ...p } : l)),
    });
  const duplicateLine = (id: string) => {
    const idx = st.lineItems.findIndex((l) => l.id === id);
    const src = st.lineItems[idx];
    if (!src) return;
    const copy: CobLineDraft = { ...src, id: newId(), label: `${src.label} (copy)` };
    apply({
      ...st,
      lineItems: [...st.lineItems.slice(0, idx + 1), copy, ...st.lineItems.slice(idx + 1)],
    });
  };

  const bothInNetwork = st.primary.inNetwork && st.secondary.inNetwork;

  const result = useMemo(() => calcCOB(cobInputFromState(st)), [st]);

  const formulaKey = st.method === "mob" ? `mob-${st.mobVariant}` : st.method;
  const gridCols = "1.4fr 0.8fr 0.8fr 0.8fr 0.8fr 0.8fr";

  return (
    <div className="space-y-3">
      {/* (1) Pull from Open Dental — live for offices with an OD connection */}
      {office ? (
        <OdCobPull
          office={office}
          pulled={odPull}
          onPulled={(result) => {
            setOdPull(result);
            apply(cobStateFromOdPull(st, result));
          }}
          onClear={() => {
            setOdPull(null);
            apply(defaultCobCalcState());
          }}
        />
      ) : (
        <div className="flex items-center justify-end rounded-xl border border-border bg-card p-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => apply(defaultCobCalcState())}
            className="text-muted-foreground"
          >
            <RotateCcw className="w-4 h-4 mr-1" /> Clear
          </Button>
        </div>
      )}

      {/* (2) COB method chips + formula line */}
      <div className="rounded-xl border border-border bg-card p-3 space-y-2">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          COB Method
        </p>
        <div className="flex flex-wrap gap-1.5">
          <MethodChip
            active={st.method === "full-cob"}
            label="Full COB (to 100%)"
            onClick={() => patch({ method: "full-cob" })}
          />
          <MethodChip
            active={st.method === "standard"}
            label="Standard (lesser-of)"
            onClick={() => patch({ method: "standard" })}
          />
          <MethodChip
            active={st.method === "non-duplication"}
            label="Non-duplication"
            onClick={() => patch({ method: "non-duplication" })}
          />
          <MethodChip
            active={st.method === "mob"}
            label="MOB"
            onClick={() => patch({ method: "mob" })}
          />
        </div>
        {st.method === "mob" && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            <MethodChip
              active={st.mobVariant === "carveout"}
              label="Carve-out (capped)"
              onClick={() => patch({ mobVariant: "carveout" })}
            />
            <MethodChip
              active={st.mobVariant === "coinsurance"}
              label="Coinsurance on balance"
              onClick={() => patch({ mobVariant: "coinsurance" })}
            />
            <p className="basis-full text-[10px] text-muted-foreground mt-1">
              Carve-out: secondary pays the *difference* (capped). Coinsurance:
              secondary pays its % of whatever the patient still owes.
            </p>
          </div>
        )}
        <p className="text-[11px] text-muted-foreground pt-1">{FORMULA_DESCRIPTION[formulaKey]}</p>
      </div>

      {/* (3) Sub-mode segmented toggle */}
      <div className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5 gap-0.5">
        {(
          [
            { id: "single", label: "Single procedure" },
            { id: "line-items", label: "Full plan" },
          ] as const
        ).map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => patch({ subMode: m.id })}
            className={`px-3 py-1 rounded-md text-xs font-semibold transition-colors ${
              st.subMode === m.id
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* (4) Plan cards */}
      <div className={compact ? "grid grid-cols-1 sm:grid-cols-2 gap-2.5" : "grid grid-cols-1 md:grid-cols-2 gap-2.5"}>
        <PlanCard
          title="Primary plan"
          plan={st.primary}
          onPatch={patchPrimary}
          showAllowedAndPct={st.subMode === "single"}
        />
        <div className="space-y-2">
          <PlanCard
            title="Secondary plan"
            plan={st.secondary}
            onPatch={patchSecondary}
            showAllowedAndPct={st.subMode === "single"}
          />
          <label className="flex items-center gap-2 text-xs text-muted-foreground px-1">
            <Switch
              checked={st.secondaryWaivesDeductible}
              onCheckedChange={(checked) => patch({ secondaryWaivesDeductible: checked })}
            />
            Waives deductible as secondary
          </label>
          <p className="text-[10px] text-muted-foreground px-1">
            Most plans do NOT waive — leave off unless you know this payer waives
            its deductible when secondary.
          </p>
        </div>
      </div>

      {/* (5a) Single-procedure fee card */}
      {st.subMode === "single" && (
        <div
          className={`rounded-xl border border-border bg-card p-3 grid gap-2.5 ${
            bothInNetwork ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1"
          }`}
        >
          <CalcField
            label="Dentist Fee"
            value={st.dentistFee}
            onChange={(v) => patch({ dentistFee: v })}
          />
          {bothInNetwork && (
            <CalcField
              label="Contracted Fee (both in-network)"
              value={st.contractedFeeOverride}
              onChange={(v) => patch({ contractedFeeOverride: v })}
              hint="Enter the patient's contracted fee — not the full fee. Leave blank to use primary's allowed."
            />
          )}
        </div>
      )}

      {/* (5b) Full-plan line items */}
      {st.subMode === "line-items" && (
        <div className="rounded-xl border border-border bg-card p-3 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              Line items
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                patch({
                  lineItems: [
                    ...st.lineItems,
                    {
                      id: newId(),
                      label: "New procedure",
                      fee: "",
                      pAllowed: "",
                      pPct: "50",
                      sAllowed: "",
                      sPct: "50",
                      contracted: "",
                    },
                  ],
                })
              }
            >
              <Plus className="w-4 h-4 mr-1" /> Add line
            </Button>
          </div>
          {st.lineItems.length === 0 && (
            <p className="text-xs text-muted-foreground py-2">
              No lines yet — add one to start the estimate.
            </p>
          )}
          {st.lineItems.map((l) => (
            <div key={l.id} className="rounded-lg border border-border bg-muted/30 p-2 space-y-2">
              <div className="flex items-center gap-2">
                <input
                  className="flex-1 min-w-0 text-xs font-semibold bg-transparent border-0 outline-none text-foreground"
                  value={l.label}
                  onChange={(e) => patchLine(l.id, { label: e.target.value })}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-primary"
                  title="Duplicate this line"
                  aria-label={`Duplicate ${l.label}`}
                  onClick={() => duplicateLine(l.id)}
                >
                  <CopyPlus className="w-3.5 h-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                  title="Remove this line"
                  aria-label={`Remove ${l.label}`}
                  onClick={() =>
                    patch({ lineItems: st.lineItems.filter((x) => x.id !== l.id) })
                  }
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
              <div className={`grid gap-2 ${compact ? "grid-cols-2 sm:grid-cols-3" : "grid-cols-2 sm:grid-cols-3"}`}>
                <CalcField label="Fee" value={l.fee} onChange={(v) => patchLine(l.id, { fee: v })} />
                <CalcField
                  label="P. Allowed"
                  value={l.pAllowed}
                  onChange={(v) => patchLine(l.id, { pAllowed: v })}
                />
                <CalcField
                  label="P. %"
                  percent
                  value={l.pPct}
                  onChange={(v) => patchLine(l.id, { pPct: v })}
                />
                <CalcField
                  label="S. Allowed"
                  value={l.sAllowed}
                  onChange={(v) => patchLine(l.id, { sAllowed: v })}
                />
                <CalcField
                  label="S. %"
                  percent
                  value={l.sPct}
                  onChange={(v) => patchLine(l.id, { sPct: v })}
                />
                {bothInNetwork && (
                  <CalcField
                    label="Contracted"
                    value={l.contracted}
                    onChange={(v) => patchLine(l.id, { contracted: v })}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* (6) Dark result panel — sidebar surface so dark mode works */}
      <div className="rounded-xl bg-sidebar px-5 py-5">
        <p className="text-[10px] uppercase tracking-[0.25em] text-sidebar-foreground/60">
          Patient Out-of-Pocket
        </p>
        <p
          className="font-bold leading-none mt-1.5 text-4xl sm:text-5xl tabular-nums"
          style={{ color: "var(--sidebar-primary-foreground)", letterSpacing: "-0.02em" }}
        >
          {fmt(result.totalPatientPortion)}
        </p>
        <p className="mt-2 text-xs text-sidebar-foreground/70">
          {result.methodLabel} · Primary {fmt(result.totalPrimaryPaid)} · Secondary{" "}
          {fmt(result.totalSecondaryPaid)} · Write-off {fmt(result.totalWriteOff)}
        </p>
        <p className="mt-1 text-[10px] text-sidebar-foreground/60">
          {FORMULA_DESCRIPTION[formulaKey]}
        </p>

        {/* OD cross-check pill — ported from legacy FloatingCalc. Compares what
            this calculator says the plans pay against Open Dental's OWN estimate
            for the same procedures. A mismatch is information, not an error: it
            usually means the plan settings here differ from OD's. Only shown
            when OD actually gave an estimate — never a "✓ matches" against a
            silent zero. */}
        {odPull?.odEstimateTotal != null &&
          (() => {
            const ours = result.totalPrimaryPaid + result.totalSecondaryPaid;
            const odTotal = odPull.odEstimateTotal as number;
            const diff = ours - odTotal;
            const matches = Math.abs(diff) < 1; // within a dollar
            return (
              <div
                className={`mt-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] ${
                  matches
                    ? "bg-emerald-500/20 text-emerald-100"
                    : "bg-amber-500/20 text-amber-100"
                }`}
                data-testid="od-cross-check"
              >
                {matches
                  ? `✓ Matches Open Dental's estimate (${fmt(odTotal)})`
                  : `Differs from OD by ${fmt(Math.abs(diff))} — OD says ${fmt(odTotal)}`}
              </div>
            );
          })()}
      </div>

      {/* (7) Per-line breakdown (full plan, >1 line) */}
      {st.subMode === "line-items" && result.lines.length > 1 && (
        <div className="rounded-xl border border-border bg-card overflow-x-auto">
          <div className="min-w-[560px]">
            <div
              className="px-3 py-2 grid gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground border-b border-border"
              style={{ gridTemplateColumns: gridCols }}
            >
              <span>Item</span>
              <span className="text-right">Fee</span>
              <span className="text-right">Primary</span>
              <span className="text-right">Secondary</span>
              <span className="text-right">Write-off</span>
              <span className="text-right">Patient</span>
            </div>
            {result.lines.map((l, i) => (
              <div
                key={i}
                className={`px-3 py-2 grid gap-2 text-xs text-foreground ${
                  i < result.lines.length - 1 ? "border-b border-border" : ""
                }`}
                style={{ gridTemplateColumns: gridCols }}
              >
                <span className="truncate">{l.label}</span>
                <span className="text-right tabular-nums">{fmt(l.contractedFee)}</span>
                <span className="text-right tabular-nums">{fmt(l.primaryPaid)}</span>
                <span className="text-right tabular-nums">{fmt(l.secondaryPaid)}</span>
                <span className="text-right tabular-nums">{fmt(l.writeOff)}</span>
                <span className="text-right tabular-nums font-semibold">{fmt(l.patientPortion)}</span>
              </div>
            ))}
            <div
              className="px-3 py-2 grid gap-2 text-xs font-bold bg-muted/40 text-foreground"
              style={{ gridTemplateColumns: gridCols }}
            >
              <span>Total</span>
              <span className="text-right tabular-nums">{fmt(result.totalContractedFee)}</span>
              <span className="text-right tabular-nums">{fmt(result.totalPrimaryPaid)}</span>
              <span className="text-right tabular-nums">{fmt(result.totalSecondaryPaid)}</span>
              <span className="text-right tabular-nums">{fmt(result.totalWriteOff)}</span>
              <span className="text-right tabular-nums">{fmt(result.totalPatientPortion)}</span>
            </div>
          </div>
        </div>
      )}

      {/* (8) Notes strip */}
      {result.lines.some((l) => l.notes.length > 0) && (
        <div className="rounded-lg p-2 text-[11px] space-y-1 bg-primary/10 border border-primary/30 text-foreground">
          {result.lines.flatMap((l, i) =>
            l.notes.map((n, j) => <div key={`${i}-${j}`}>· {n}</div>),
          )}
        </div>
      )}
    </div>
  );
}

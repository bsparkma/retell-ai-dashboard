/**
 * COB calculator UI — faithful port of the legacy FloatingCalc COB view
 * (TC-app FloatingCalc.tsx), restyled on platform tokens.
 *
 * DOLLARS DOMAIN: this is a pure scratchpad over user-typed dollar amounts.
 * calcCOB (ported verbatim, regression-tested) takes and returns dollars, so
 * results render through this component's own Intl formatter — NOT
 * formatCents. No case money flows through here.
 *
 * State can be lifted (state/onStateChange) so FloatingCalc preserves inputs
 * across sheet open/close; the page uses it uncontrolled.
 */
import { useMemo, useState } from "react";
import { Download, Info, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { DisabledFeatureButton } from "../components/TcShell";
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

// ── Small fields ────────────────────────────────────────────────────────────

function NumField({
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
    <div>
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <div className="relative mt-0.5">
        {!percent && (
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
            $
          </span>
        )}
        <Input
          inputMode="decimal"
          className={`h-8 text-sm tabular-nums ${percent ? "pr-7" : "pl-6"}`}
          value={value}
          onChange={(e) => onChange(sanitizeNumeric(e.target.value))}
        />
        {percent && (
          <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
            %
          </span>
        )}
      </div>
      {hint && <p className="text-[10px] text-muted-foreground mt-0.5">{hint}</p>}
    </div>
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
        <p className="text-xs font-semibold text-foreground">{title}</p>
        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Switch
            checked={plan.inNetwork}
            onCheckedChange={(checked) => onPatch({ inNetwork: checked })}
          />
          {plan.inNetwork ? "In-network" : "Out-of-network"}
        </label>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {showAllowedAndPct && (
          <NumField
            label="Allowed amount"
            value={plan.allowed}
            onChange={(v) => onPatch({ allowed: v })}
          />
        )}
        {showAllowedAndPct && (
          <NumField
            label="Coverage %"
            percent
            value={plan.pct}
            onChange={(v) => onPatch({ pct: v })}
          />
        )}
        <NumField
          label="Deductible remaining"
          value={plan.ded}
          onChange={(v) => onPatch({ ded: v })}
        />
        <div>
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground pt-1">
            <Switch
              checked={plan.hasMax}
              onCheckedChange={(checked) => onPatch({ hasMax: checked })}
            />
            {plan.hasMax ? "Annual max" : "Annual max — unlimited"}
          </label>
          {plan.hasMax && (
            <div className="mt-1.5">
              <NumField
                label="Max remaining"
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

export function CobCalculator({
  compact = false,
  state,
  onStateChange,
}: {
  compact?: boolean;
  /** Controlled state (FloatingCalc lifts it to survive sheet close). */
  state?: CobCalcState;
  onStateChange?: (next: CobCalcState) => void;
}) {
  const [inner, setInner] = useState<CobCalcState>(defaultCobCalcState);
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

  const bothInNetwork = st.primary.inNetwork && st.secondary.inNetwork;

  const planInput = (p: CobPlanDraft): COBPlanInput => ({
    allowedAmount: toAmount(p.allowed),
    coveragePct: toPct(p.pct),
    remainingDeductible: toAmount(p.ded),
    hasAnnualMax: p.hasMax,
    remainingAnnualMax: toAmount(p.max),
    inNetwork: p.inNetwork,
  });

  const result = useMemo(() => {
    const overrideAmount = toAmount(st.contractedFeeOverride);
    const input: COBInput = {
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
            lineItems: st.lineItems.map((l) => ({
              label: l.label,
              dentistFee: toAmount(l.fee),
              primaryAllowed: toAmount(l.pAllowed),
              primaryCoveragePct: toPct(l.pPct),
              secondaryAllowed: toAmount(l.sAllowed),
              secondaryCoveragePct: toPct(l.sPct),
            })),
          }
        : {}),
    };
    return calcCOB(input);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st, bothInNetwork]);

  const formulaKey = st.method === "mob" ? `mob-${st.mobVariant}` : st.method;
  const planGrid = compact ? "grid grid-cols-1 gap-2.5" : "grid grid-cols-1 md:grid-cols-2 gap-2.5";

  return (
    <div className="space-y-3">
      {/* Toolbar: OD pull (dark in this slice) + clear */}
      <div className="flex items-center justify-between gap-2">
        <DisabledFeatureButton reason="slice5_od" size="sm">
          <Download className="w-4 h-4 mr-1" /> Pull from Open Dental
        </DisabledFeatureButton>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => apply(defaultCobCalcState())}
          className="text-muted-foreground"
        >
          <RotateCcw className="w-4 h-4 mr-1" /> Clear
        </Button>
      </div>

      {/* Method */}
      <div className="rounded-xl border border-border bg-card p-3 space-y-2">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label className="text-[11px] text-muted-foreground">COB method</Label>
            <Select
              value={st.method}
              onValueChange={(v) => patch({ method: v as COBMethod })}
            >
              <SelectTrigger className="h-8 w-56 text-xs mt-0.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="full-cob">Full COB (to 100%)</SelectItem>
                <SelectItem value="standard">Standard (lesser-of)</SelectItem>
                <SelectItem value="non-duplication">Non-duplication</SelectItem>
                <SelectItem value="mob">MOB</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {st.method === "mob" && (
            <div>
              <Label className="text-[11px] text-muted-foreground">MOB variant</Label>
              <Select
                value={st.mobVariant}
                onValueChange={(v) => patch({ mobVariant: v as MobVariant })}
              >
                <SelectTrigger className="h-8 w-56 text-xs mt-0.5">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="carveout">Carve-out (capped)</SelectItem>
                  <SelectItem value="coinsurance">Coinsurance on balance</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">{FORMULA_DESCRIPTION[formulaKey]}</p>
      </div>

      {/* Sub-mode */}
      <div className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5 gap-0.5">
        {(
          [
            { id: "single", label: "Single procedure" },
            { id: "line-items", label: "Line items" },
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

      {/* Plans */}
      <div className={planGrid}>
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

      {/* Single-procedure inputs */}
      {st.subMode === "single" && (
        <div
          className={`rounded-xl border border-border bg-card p-3 grid gap-2.5 ${
            bothInNetwork && !compact ? "grid-cols-2" : "grid-cols-1"
          }`}
        >
          <NumField
            label="Dentist fee"
            value={st.dentistFee}
            onChange={(v) => patch({ dentistFee: v })}
          />
          {bothInNetwork && (
            <NumField
              label="Contracted fee (both in-network)"
              value={st.contractedFeeOverride}
              onChange={(v) => patch({ contractedFeeOverride: v })}
              hint="Enter the patient's contracted fee — not the full fee. Leave blank to use primary's allowed."
            />
          )}
        </div>
      )}

      {/* Line items */}
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
                <Input
                  className="h-8 flex-1 text-xs font-semibold"
                  value={l.label}
                  onChange={(e) => patchLine(l.id, { label: e.target.value })}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                  aria-label={`Remove ${l.label}`}
                  onClick={() =>
                    patch({ lineItems: st.lineItems.filter((x) => x.id !== l.id) })
                  }
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
              <div className={`grid gap-2 ${compact ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-5"}`}>
                <NumField label="Fee" value={l.fee} onChange={(v) => patchLine(l.id, { fee: v })} />
                <NumField
                  label="P. allowed"
                  value={l.pAllowed}
                  onChange={(v) => patchLine(l.id, { pAllowed: v })}
                />
                <NumField
                  label="P. %"
                  percent
                  value={l.pPct}
                  onChange={(v) => patchLine(l.id, { pPct: v })}
                />
                <NumField
                  label="S. allowed"
                  value={l.sAllowed}
                  onChange={(v) => patchLine(l.id, { sAllowed: v })}
                />
                <NumField
                  label="S. %"
                  percent
                  value={l.sPct}
                  onChange={(v) => patchLine(l.id, { sPct: v })}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Headline result */}
      <div className="rounded-xl border border-border bg-card p-4">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          Patient out-of-pocket
        </p>
        <p className="text-4xl font-bold text-foreground tabular-nums mt-1">
          {fmt(result.totalPatientPortion)}
        </p>
        <p className="text-xs text-muted-foreground mt-2">
          {result.methodLabel} · Primary {fmt(result.totalPrimaryPaid)} · Secondary{" "}
          {fmt(result.totalSecondaryPaid)} · Write-off {fmt(result.totalWriteOff)}
        </p>
      </div>

      {/* Per-line breakdown */}
      <div className="rounded-xl border border-border bg-card overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-xs">Item</TableHead>
              <TableHead className="text-xs text-right">Contracted</TableHead>
              <TableHead className="text-xs text-right">Primary</TableHead>
              <TableHead className="text-xs text-right">Secondary</TableHead>
              <TableHead className="text-xs text-right">Write-off</TableHead>
              <TableHead className="text-xs text-right">Patient</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.lines.map((l, i) => (
              <TableRow key={i}>
                <TableCell className="text-xs">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="truncate max-w-48">{l.label}</span>
                    {l.notes.length > 0 && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            aria-label="Line notes"
                            className="text-muted-foreground hover:text-foreground"
                          >
                            <Info className="w-3.5 h-3.5" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          <div className="space-y-1">
                            {l.notes.map((n, j) => (
                              <p key={j} className="text-xs">
                                {n}
                              </p>
                            ))}
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </span>
                </TableCell>
                <TableCell className="text-xs text-right tabular-nums">
                  {fmt(l.contractedFee)}
                </TableCell>
                <TableCell className="text-xs text-right tabular-nums">
                  {fmt(l.primaryPaid)}
                </TableCell>
                <TableCell className="text-xs text-right tabular-nums">
                  {fmt(l.secondaryPaid)}
                </TableCell>
                <TableCell className="text-xs text-right tabular-nums">{fmt(l.writeOff)}</TableCell>
                <TableCell className="text-xs text-right tabular-nums font-semibold">
                  {fmt(l.patientPortion)}
                </TableCell>
              </TableRow>
            ))}
            <TableRow className="bg-muted/40">
              <TableCell className="text-xs font-bold">Total</TableCell>
              <TableCell className="text-xs text-right tabular-nums font-bold">
                {fmt(result.totalContractedFee)}
              </TableCell>
              <TableCell className="text-xs text-right tabular-nums font-bold">
                {fmt(result.totalPrimaryPaid)}
              </TableCell>
              <TableCell className="text-xs text-right tabular-nums font-bold">
                {fmt(result.totalSecondaryPaid)}
              </TableCell>
              <TableCell className="text-xs text-right tabular-nums font-bold">
                {fmt(result.totalWriteOff)}
              </TableCell>
              <TableCell className="text-xs text-right tabular-nums font-bold">
                {fmt(result.totalPatientPortion)}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

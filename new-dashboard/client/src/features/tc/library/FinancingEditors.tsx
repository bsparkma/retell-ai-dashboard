/**
 * Financing library editors — three server sections render on one page:
 *  - financing_providers: the office's provider catalog (cards, add/remove);
 *  - financing_config: service fee + pay-in-full cash discount (the server
 *    truth that replaced the legacy hardcoded 5% — honesty-debt fix);
 *  - financing_settings: the "Overrides" panel that absorbed the old
 *    per-browser localStorage FinancingSettings.
 * Each section saves independently via a whole-section PUT.
 */
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { z } from "zod";
import type {
  LibraryFinancingConfig,
  LibraryFinancingProvider,
  LibraryFinancingSettings,
  OfficeId,
} from "@shared/tc/contract";
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
import { Textarea } from "@/components/ui/textarea";
import { centsToDollarsInput, dollarsInputToCents } from "../money";
import {
  DEFAULT_FINANCING_CONFIG,
  DEFAULT_FINANCING_PROVIDERS,
  DEFAULT_FINANCING_SETTINGS,
} from "./defaults";
import {
  FieldError,
  IssueList,
  SLUG_RE,
  SaveBar,
  SectionCard,
  SectionEmptyState,
  numFromInput,
  parseIntList,
  useSectionSave,
} from "./fields";

type FinancingProvider = z.infer<typeof LibraryFinancingProvider>;
type FinancingSettings = z.infer<typeof LibraryFinancingSettings>;

function deepEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ═══ Providers ══════════════════════════════════════════════════════════════

interface ProviderRow {
  key: string;
  label: string;
  logo: string;
  color: string;
  description: string;
  terms: string;
  promoTerms: string;
  minAmount: string; // dollars
  promoApr: string;
  regularApr: string;
  enabled: boolean;
}

function toProviderRows(v: FinancingProvider[]): ProviderRow[] {
  return v.map((p) => ({
    key: p.key,
    label: p.label,
    logo: p.logo,
    color: p.color,
    description: p.description,
    terms: p.terms.join(", "),
    promoTerms: p.promoTerms.join(", "),
    minAmount: centsToDollarsInput(p.minAmountCents),
    promoApr: String(p.promoApr),
    regularApr: String(p.regularApr),
    enabled: p.enabled,
  }));
}

function providerRowErrors(r: ProviderRow): Partial<Record<keyof ProviderRow, string>> {
  const errs: Partial<Record<keyof ProviderRow, string>> = {};
  if (r.label.trim() === "" || r.label.length > 80) errs.label = "Label must be 1–80 characters.";
  if (r.logo.length > 8) errs.logo = "Logo is a short badge (max 8 characters).";
  if (r.color.trim() === "" || r.color.length > 64) errs.color = "Color is required (max 64 chars).";
  if (parseIntList(r.terms, { min: 1, max: 120, maxLen: 20 }) === null)
    errs.terms = "Comma-separated month counts, 1–120 (max 20 entries).";
  if (parseIntList(r.promoTerms, { min: 1, max: 120, maxLen: 20 }) === null)
    errs.promoTerms = "Comma-separated month counts, 1–120 (max 20 entries).";
  if (dollarsInputToCents(r.minAmount) === null) errs.minAmount = "Enter a valid dollar amount.";
  if (numFromInput(r.promoApr, 0, 100) === null) errs.promoApr = "APR must be 0–100.";
  if (numFromInput(r.regularApr, 0, 100) === null) errs.regularApr = "APR must be 0–100.";
  return errs;
}

export function ProvidersEditor({
  office,
  value,
  onSaved,
}: {
  office: OfficeId;
  value: FinancingProvider[] | undefined;
  onSaved: (v: FinancingProvider[]) => void;
}) {
  const [rows, setRows] = useState<ProviderRow[] | null>(() =>
    value ? toProviderRows(value) : null,
  );
  const [baseline, setBaseline] = useState<ProviderRow[] | null>(() =>
    value ? toProviderRows(value) : null,
  );
  const [newKey, setNewKey] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const { saving, issues, save } = useSectionSave(
    office,
    "financing_providers",
    "Financing providers",
    onSaved,
  );

  const dirty = rows !== null && !deepEq(rows, baseline);

  function patch(idx: number, p: Partial<ProviderRow>) {
    if (!rows) return;
    setRows(rows.map((r, i) => (i === idx ? { ...r, ...p } : r)));
  }

  function addRow() {
    if (!rows) return;
    const key = newKey.trim();
    if (!SLUG_RE.test(key) || key.length > 60) {
      setAddError("Key must be a short slug: lowercase letters, digits, - or _ (max 60).");
      return;
    }
    if (rows.some((r) => r.key === key)) {
      setAddError("That provider key already exists.");
      return;
    }
    if (newLabel.trim() === "") {
      setAddError("Label is required.");
      return;
    }
    setRows([
      ...rows,
      {
        key,
        label: newLabel.trim(),
        logo: "",
        color: "oklch(0.52 0.12 186)",
        description: "",
        terms: "",
        promoTerms: "",
        minAmount: "0",
        promoApr: "0",
        regularApr: "0",
        enabled: true,
      },
    ]);
    setNewKey("");
    setNewLabel("");
    setAddError(null);
  }

  async function handleSave() {
    if (!rows) return;
    if (rows.some((r) => Object.keys(providerRowErrors(r)).length > 0)) return;
    const next: FinancingProvider[] = rows.map((r) => ({
      key: r.key,
      label: r.label.trim(),
      logo: r.logo,
      color: r.color.trim(),
      description: r.description,
      terms: parseIntList(r.terms, { min: 1, max: 120, maxLen: 20 }) ?? [],
      promoTerms: parseIntList(r.promoTerms, { min: 1, max: 120, maxLen: 20 }) ?? [],
      minAmountCents: dollarsInputToCents(r.minAmount) ?? 0,
      promoApr: numFromInput(r.promoApr, 0, 100) ?? 0,
      regularApr: numFromInput(r.regularApr, 0, 100) ?? 0,
      enabled: r.enabled,
    }));
    const persisted = await save(next);
    if (persisted) {
      setRows(toProviderRows(persisted));
      setBaseline(toProviderRows(persisted));
    }
  }

  return (
    <SectionCard
      title="Financing providers"
      description="The provider catalog shown on financing views and patient presentations. Term lists are months, comma-separated."
    >
      {rows === null ? (
        <SectionEmptyState
          what="financing providers"
          onSeed={() => setRows(toProviderRows(DEFAULT_FINANCING_PROVIDERS))}
        />
      ) : (
        <div className="space-y-4">
          <IssueList issues={issues} />
          <div className="space-y-3">
            {rows.map((r, idx) => {
              const errs = providerRowErrors(r);
              return (
                <div key={r.key} className="p-3 rounded-lg border border-border space-y-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <div
                      className="w-8 h-8 rounded-md flex items-center justify-center text-[10px] font-bold text-white shrink-0"
                      style={{ background: r.color }}
                    >
                      {r.logo || r.label.slice(0, 2).toUpperCase()}
                    </div>
                    <Input
                      className="h-8 flex-1 min-w-40 text-sm font-medium"
                      value={r.label}
                      onChange={(e) => patch(idx, { label: e.target.value })}
                    />
                    <span className="text-[10px] text-muted-foreground font-mono">{r.key}</span>
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Switch
                        checked={r.enabled}
                        onCheckedChange={(checked) => patch(idx, { enabled: checked })}
                      />
                      Enabled
                    </label>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      aria-label={`Remove ${r.label}`}
                      onClick={() => setRows(rows.filter((_, i) => i !== idx))}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                  <FieldError msg={errs.label} />
                  <Textarea
                    rows={1}
                    className="text-xs"
                    placeholder="Short description shown to patients…"
                    value={r.description}
                    onChange={(e) => patch(idx, { description: e.target.value })}
                  />
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
                    <div>
                      <Label className="text-[11px] text-muted-foreground">Logo badge</Label>
                      <Input
                        className="h-8 text-xs mt-0.5"
                        value={r.logo}
                        onChange={(e) => patch(idx, { logo: e.target.value })}
                      />
                      <FieldError msg={errs.logo} />
                    </div>
                    <div>
                      <Label className="text-[11px] text-muted-foreground">Color</Label>
                      <Input
                        className="h-8 text-xs mt-0.5"
                        value={r.color}
                        onChange={(e) => patch(idx, { color: e.target.value })}
                      />
                      <FieldError msg={errs.color} />
                    </div>
                    <div>
                      <Label className="text-[11px] text-muted-foreground">Terms (months)</Label>
                      <Input
                        className="h-8 text-xs mt-0.5"
                        placeholder="12, 24, 36"
                        value={r.terms}
                        onChange={(e) => patch(idx, { terms: e.target.value })}
                      />
                      <FieldError msg={errs.terms} />
                    </div>
                    <div>
                      <Label className="text-[11px] text-muted-foreground">Promo terms (months)</Label>
                      <Input
                        className="h-8 text-xs mt-0.5"
                        placeholder="6, 12"
                        value={r.promoTerms}
                        onChange={(e) => patch(idx, { promoTerms: e.target.value })}
                      />
                      <FieldError msg={errs.promoTerms} />
                    </div>
                    <div>
                      <Label className="text-[11px] text-muted-foreground">Minimum amount</Label>
                      <div className="relative mt-0.5">
                        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                          $
                        </span>
                        <Input
                          className="h-8 pl-6 text-xs"
                          inputMode="decimal"
                          value={r.minAmount}
                          onChange={(e) => patch(idx, { minAmount: e.target.value })}
                        />
                      </div>
                      <FieldError msg={errs.minAmount} />
                    </div>
                    <div>
                      <Label className="text-[11px] text-muted-foreground">Promo APR %</Label>
                      <Input
                        className="h-8 text-xs mt-0.5"
                        inputMode="decimal"
                        value={r.promoApr}
                        onChange={(e) => patch(idx, { promoApr: e.target.value })}
                      />
                      <FieldError msg={errs.promoApr} />
                    </div>
                    <div>
                      <Label className="text-[11px] text-muted-foreground">Regular APR %</Label>
                      <Input
                        className="h-8 text-xs mt-0.5"
                        inputMode="decimal"
                        value={r.regularApr}
                        onChange={(e) => patch(idx, { regularApr: e.target.value })}
                      />
                      <FieldError msg={errs.regularApr} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex flex-wrap items-end gap-2 pt-1 border-t border-border">
            <div>
              <Label className="text-[11px] text-muted-foreground">New key (slug)</Label>
              <Input
                className="h-8 w-40 text-xs mt-0.5"
                placeholder="e.g. sunbit"
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-[11px] text-muted-foreground">Label</Label>
              <Input
                className="h-8 w-56 text-xs mt-0.5"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
              />
            </div>
            <Button variant="outline" size="sm" onClick={addRow}>
              <Plus className="w-4 h-4 mr-1" /> Add provider
            </Button>
          </div>
          <FieldError msg={addError} />
          <SaveBar
            dirty={dirty}
            saving={saving}
            onSave={handleSave}
            onDiscard={() => setRows(baseline)}
          />
        </div>
      )}
    </SectionCard>
  );
}

// ═══ Financing config (service fee + cash discount) ═════════════════════════

interface ConfigDraft {
  serviceFeeEnabled: boolean;
  serviceFeePercent: string;
  cashDiscountEnabled: boolean;
  cashDiscountPercent: string;
}

function toConfigDraft(v: LibraryFinancingConfig): ConfigDraft {
  return {
    serviceFeeEnabled: v.serviceFeeEnabled,
    serviceFeePercent: String(v.serviceFeePercent),
    cashDiscountEnabled: v.cashDiscountEnabled,
    cashDiscountPercent: String(v.cashDiscountPercent),
  };
}

export function FinancingConfigEditor({
  office,
  value,
  onSaved,
}: {
  office: OfficeId;
  value: LibraryFinancingConfig | undefined;
  onSaved: (v: LibraryFinancingConfig) => void;
}) {
  const [draft, setDraft] = useState<ConfigDraft | null>(() =>
    value ? toConfigDraft(value) : null,
  );
  const [baseline, setBaseline] = useState<ConfigDraft | null>(() =>
    value ? toConfigDraft(value) : null,
  );
  const { saving, issues, save } = useSectionSave(
    office,
    "financing_config",
    "Financing settings",
    onSaved,
  );

  const dirty = draft !== null && !deepEq(draft, baseline);

  async function handleSave() {
    if (!draft) return;
    const serviceFeePercent = numFromInput(draft.serviceFeePercent, 0, 15);
    const cashDiscountPercent = numFromInput(draft.cashDiscountPercent, 0, 50);
    if (serviceFeePercent === null || cashDiscountPercent === null) return;
    const persisted = await save({
      serviceFeeEnabled: draft.serviceFeeEnabled,
      serviceFeePercent,
      cashDiscountEnabled: draft.cashDiscountEnabled,
      cashDiscountPercent,
    });
    if (persisted) {
      setDraft(toConfigDraft(persisted));
      setBaseline(toConfigDraft(persisted));
    }
  }

  return (
    <SectionCard
      title="Fees & discounts"
      description="Office-wide financing adjustments. These are the server truth — nothing is hardcoded in the app anymore."
    >
      {draft === null ? (
        <SectionEmptyState
          what="fees & discounts"
          onSeed={() => setDraft(toConfigDraft(DEFAULT_FINANCING_CONFIG))}
        />
      ) : (
        <div className="space-y-4">
          <IssueList issues={issues} />
          <div className="p-3 rounded-lg border border-border space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-foreground">Service fee</p>
                <p className="text-xs text-muted-foreground">
                  Added on top of the financed amount when applied in the calculator.
                </p>
              </div>
              <Switch
                checked={draft.serviceFeeEnabled}
                onCheckedChange={(checked) => setDraft({ ...draft, serviceFeeEnabled: checked })}
              />
            </div>
            {draft.serviceFeeEnabled && (
              <div className="w-32">
                <Label className="text-[11px] text-muted-foreground">Percent (0–15)</Label>
                <Input
                  className="h-8 text-xs mt-0.5"
                  inputMode="decimal"
                  value={draft.serviceFeePercent}
                  onChange={(e) => setDraft({ ...draft, serviceFeePercent: e.target.value })}
                />
                <FieldError
                  msg={
                    numFromInput(draft.serviceFeePercent, 0, 15) === null
                      ? "Must be a number from 0 to 15."
                      : null
                  }
                />
              </div>
            )}
          </div>
          <div className="p-3 rounded-lg border border-border space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-foreground">Pay-in-full cash discount</p>
                <p className="text-xs text-muted-foreground">
                  Shown on financing views and patient presentations when enabled.
                </p>
              </div>
              <Switch
                checked={draft.cashDiscountEnabled}
                onCheckedChange={(checked) => setDraft({ ...draft, cashDiscountEnabled: checked })}
              />
            </div>
            {draft.cashDiscountEnabled && (
              <div className="w-32">
                <Label className="text-[11px] text-muted-foreground">Percent (0–50)</Label>
                <Input
                  className="h-8 text-xs mt-0.5"
                  inputMode="decimal"
                  value={draft.cashDiscountPercent}
                  onChange={(e) => setDraft({ ...draft, cashDiscountPercent: e.target.value })}
                />
                <FieldError
                  msg={
                    numFromInput(draft.cashDiscountPercent, 0, 50) === null
                      ? "Must be a number from 0 to 50."
                      : null
                  }
                />
              </div>
            )}
          </div>
          <SaveBar
            dirty={dirty}
            saving={saving}
            onSave={handleSave}
            onDiscard={() => setDraft(baseline)}
          />
        </div>
      )}
    </SectionCard>
  );
}

// ═══ Overrides (financing_settings) ═════════════════════════════════════════

const INHERIT = "__inherit__";

interface AprOverrideDraft {
  promoEnabled: boolean;
  promoApr: string;
  regularApr: string;
}

interface OverridesDraft {
  serviceFeeEnabled: boolean;
  serviceFeePercent: string;
  /** INHERIT | "on" | "off" per provider key. */
  enabled: Record<string, string>;
  apr: Record<string, AprOverrideDraft>;
}

function toOverridesDraft(v: FinancingSettings, providerKeys: string[]): OverridesDraft {
  const enabled: Record<string, string> = {};
  const keys = Array.from(
    new Set([...providerKeys, ...Object.keys(v.enabledProviders), ...Object.keys(v.providerOverrides)]),
  );
  for (const k of keys) {
    enabled[k] = k in v.enabledProviders ? (v.enabledProviders[k] ? "on" : "off") : INHERIT;
  }
  const apr: Record<string, AprOverrideDraft> = {};
  for (const [k, o] of Object.entries(v.providerOverrides)) {
    apr[k] = {
      promoEnabled: o.promoEnabled,
      promoApr: String(o.promoApr),
      regularApr: String(o.regularApr),
    };
  }
  return {
    serviceFeeEnabled: v.serviceFeeEnabled,
    serviceFeePercent: String(v.serviceFeePercent),
    enabled,
    apr,
  };
}

export function FinancingOverridesEditor({
  office,
  value,
  providers,
  onSaved,
}: {
  office: OfficeId;
  value: FinancingSettings | undefined;
  providers: FinancingProvider[] | undefined;
  onSaved: (v: FinancingSettings) => void;
}) {
  const providerKeys = (providers ?? []).map((p) => p.key);
  const [draft, setDraft] = useState<OverridesDraft | null>(() =>
    value ? toOverridesDraft(value, providerKeys) : null,
  );
  const [baseline, setBaseline] = useState<OverridesDraft | null>(() =>
    value ? toOverridesDraft(value, providerKeys) : null,
  );
  const { saving, issues, save } = useSectionSave(
    office,
    "financing_settings",
    "Financing overrides",
    onSaved,
  );

  const dirty = draft !== null && !deepEq(draft, baseline);
  const providerList = providers ?? [];
  const allKeys = draft
    ? Array.from(new Set([...providerKeys, ...Object.keys(draft.enabled), ...Object.keys(draft.apr)]))
    : providerKeys;

  function aprError(o: AprOverrideDraft): string | null {
    if (numFromInput(o.promoApr, 0, 100) === null) return "Promo APR must be 0–100.";
    if (numFromInput(o.regularApr, 0, 100) === null) return "Regular APR must be 0–100.";
    return null;
  }

  async function handleSave() {
    if (!draft) return;
    const serviceFeePercent = numFromInput(draft.serviceFeePercent, 0, 15);
    if (serviceFeePercent === null) return;
    if (Object.values(draft.apr).some((o) => aprError(o) !== null)) return;
    const enabledProviders: Record<string, boolean> = {};
    for (const [k, mode] of Object.entries(draft.enabled)) {
      if (mode === "on") enabledProviders[k] = true;
      if (mode === "off") enabledProviders[k] = false;
    }
    const providerOverrides: FinancingSettings["providerOverrides"] = {};
    for (const [k, o] of Object.entries(draft.apr)) {
      providerOverrides[k] = {
        promoEnabled: o.promoEnabled,
        promoApr: numFromInput(o.promoApr, 0, 100) ?? 0,
        regularApr: numFromInput(o.regularApr, 0, 100) ?? 0,
      };
    }
    const persisted = await save({
      enabledProviders,
      serviceFeeEnabled: draft.serviceFeeEnabled,
      serviceFeePercent,
      providerOverrides,
    });
    if (persisted) {
      setDraft(toOverridesDraft(persisted, providerKeys));
      setBaseline(toOverridesDraft(persisted, providerKeys));
    }
  }

  return (
    <SectionCard
      title="Overrides"
      description="Per-provider enable and APR overrides layered on top of the catalog above. This panel absorbed the old per-browser settings — they used to live in each workstation's browser storage; now they're saved on the server so every workstation sees the same configuration."
    >
      {draft === null ? (
        <SectionEmptyState
          what="financing overrides"
          onSeed={() => setDraft(toOverridesDraft(DEFAULT_FINANCING_SETTINGS, providerKeys))}
        />
      ) : (
        <div className="space-y-4">
          <IssueList issues={issues} />
          {allKeys.length === 0 && (
            <p className="text-xs text-muted-foreground">
              Configure financing providers above first — overrides apply per provider.
            </p>
          )}
          <div className="space-y-2">
            {allKeys.map((key) => {
              const provider = providerList.find((p) => p.key === key);
              const aprOverride = draft.apr[key];
              return (
                <div key={key} className="p-3 rounded-lg border border-border space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-foreground flex-1 min-w-32">
                      {provider?.label ?? key}
                      {!provider && (
                        <span className="text-[10px] text-muted-foreground ml-1">
                          (not in catalog)
                        </span>
                      )}
                    </span>
                    <Label className="text-[11px] text-muted-foreground">Enabled</Label>
                    <Select
                      value={draft.enabled[key] ?? INHERIT}
                      onValueChange={(v) =>
                        setDraft({ ...draft, enabled: { ...draft.enabled, [key]: v } })
                      }
                    >
                      <SelectTrigger className="h-8 w-36 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={INHERIT}>Inherit from catalog</SelectItem>
                        <SelectItem value="on">Enabled</SelectItem>
                        <SelectItem value="off">Disabled</SelectItem>
                      </SelectContent>
                    </Select>
                    {aprOverride ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs"
                        onClick={() => {
                          const next = { ...draft.apr };
                          delete next[key];
                          setDraft({ ...draft, apr: next });
                        }}
                      >
                        Remove APR override
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-xs"
                        onClick={() =>
                          setDraft({
                            ...draft,
                            apr: {
                              ...draft.apr,
                              [key]: {
                                promoEnabled: true,
                                promoApr: String(provider?.promoApr ?? 0),
                                regularApr: String(provider?.regularApr ?? 0),
                              },
                            },
                          })
                        }
                      >
                        Override APRs
                      </Button>
                    )}
                  </div>
                  {aprOverride && (
                    <div className="flex flex-wrap items-end gap-3 pl-1">
                      <label className="flex items-center gap-1.5 text-xs text-muted-foreground pb-1.5">
                        <Switch
                          checked={aprOverride.promoEnabled}
                          onCheckedChange={(checked) =>
                            setDraft({
                              ...draft,
                              apr: { ...draft.apr, [key]: { ...aprOverride, promoEnabled: checked } },
                            })
                          }
                        />
                        Promo enabled
                      </label>
                      <div>
                        <Label className="text-[11px] text-muted-foreground">Promo APR %</Label>
                        <Input
                          className="h-8 w-24 text-xs mt-0.5"
                          inputMode="decimal"
                          value={aprOverride.promoApr}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              apr: {
                                ...draft.apr,
                                [key]: { ...aprOverride, promoApr: e.target.value },
                              },
                            })
                          }
                        />
                      </div>
                      <div>
                        <Label className="text-[11px] text-muted-foreground">Regular APR %</Label>
                        <Input
                          className="h-8 w-24 text-xs mt-0.5"
                          inputMode="decimal"
                          value={aprOverride.regularApr}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              apr: {
                                ...draft.apr,
                                [key]: { ...aprOverride, regularApr: e.target.value },
                              },
                            })
                          }
                        />
                      </div>
                      <FieldError msg={aprError(aprOverride)} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="p-3 rounded-lg border border-border space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-foreground">Service fee (override)</p>
                <p className="text-xs text-muted-foreground">
                  The legacy per-browser settings carried their own service-fee copy;
                  it lives here now.
                </p>
              </div>
              <Switch
                checked={draft.serviceFeeEnabled}
                onCheckedChange={(checked) => setDraft({ ...draft, serviceFeeEnabled: checked })}
              />
            </div>
            {draft.serviceFeeEnabled && (
              <div className="w-32">
                <Label className="text-[11px] text-muted-foreground">Percent (0–15)</Label>
                <Input
                  className="h-8 text-xs mt-0.5"
                  inputMode="decimal"
                  value={draft.serviceFeePercent}
                  onChange={(e) => setDraft({ ...draft, serviceFeePercent: e.target.value })}
                />
                <FieldError
                  msg={
                    numFromInput(draft.serviceFeePercent, 0, 15) === null
                      ? "Must be a number from 0 to 15."
                      : null
                  }
                />
              </div>
            )}
          </div>
          <SaveBar
            dirty={dirty}
            saving={saving}
            onSave={handleSave}
            onDiscard={() => setDraft(baseline)}
          />
        </div>
      )}
    </SectionCard>
  );
}

/**
 * Library section editors (non-financing): crown pricing, stages, objections,
 * tag lists, treatment categories, cadence. Financing editors live in
 * FinancingEditors.tsx.
 *
 * Every editor follows the same contract:
 *  - edits a LOCAL draft; nothing persists until Save;
 *  - Save PUTs the WHOLE section (backend validates strictly) and resets the
 *    draft from the value the server RETURNED (confirmed-save rule);
 *  - failures keep the form dirty; VALIDATION_FAILED issues render inline.
 */
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { z } from "zod";
import type {
  LibraryCadenceConfig,
  LibraryCrownPricing,
  LibraryFinancingProvider,
  LibraryObjection,
  LibraryStage,
  LibraryTag,
  LibraryTreatmentCategory,
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
  DEFAULT_CADENCE_CONFIG,
  DEFAULT_CROWN_PRICING,
  DEFAULT_LOST_REASONS,
  DEFAULT_MOTIVATORS,
  DEFAULT_OBJECTIONS,
  DEFAULT_REFERRAL_SOURCES,
  DEFAULT_STAGES,
  DEFAULT_TREATMENT_CATEGORIES,
} from "./defaults";
import {
  FieldError,
  IssueList,
  SLUG_RE,
  SaveBar,
  SectionCard,
  SectionEmptyState,
  intFromInput,
  parseIntList,
  useSectionSave,
} from "./fields";

type Stage = z.infer<typeof LibraryStage>;
type Tag = z.infer<typeof LibraryTag>;
type Objection = z.infer<typeof LibraryObjection>;
type TreatmentCategory = z.infer<typeof LibraryTreatmentCategory>;
type FinancingProvider = z.infer<typeof LibraryFinancingProvider>;
type CrownPricing = z.infer<typeof LibraryCrownPricing>;
type CadenceConfig = z.infer<typeof LibraryCadenceConfig>;

function deepEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ═══ Crown pricing ══════════════════════════════════════════════════════════

interface PricingDraft {
  economy: string;
  standard: string;
  premium: string;
  implant: string;
}

function toPricingDraft(v: CrownPricing): PricingDraft {
  return {
    economy: centsToDollarsInput(v.economyCents),
    standard: centsToDollarsInput(v.standardCents),
    premium: centsToDollarsInput(v.premiumCents),
    implant: centsToDollarsInput(v.implantCents),
  };
}

const PRICING_TIERS: { field: keyof PricingDraft; label: string }[] = [
  { field: "economy", label: "Economy crown" },
  { field: "standard", label: "Standard crown" },
  { field: "premium", label: "Premium crown" },
  { field: "implant", label: "Implant crown" },
];

export function PricingEditor({
  office,
  value,
  onSaved,
}: {
  office: OfficeId;
  value: CrownPricing | undefined;
  onSaved: (v: CrownPricing) => void;
}) {
  const [draft, setDraft] = useState<PricingDraft | null>(() =>
    value ? toPricingDraft(value) : null,
  );
  const [baseline, setBaseline] = useState<PricingDraft | null>(() =>
    value ? toPricingDraft(value) : null,
  );
  const { saving, issues, save } = useSectionSave(office, "crown_pricing", "Pricing", onSaved);

  const dirty = draft !== null && !deepEq(draft, baseline);

  async function handleSave() {
    if (!draft) return;
    const cents = {
      economyCents: dollarsInputToCents(draft.economy),
      standardCents: dollarsInputToCents(draft.standard),
      premiumCents: dollarsInputToCents(draft.premium),
      implantCents: dollarsInputToCents(draft.implant),
    };
    if (
      cents.economyCents === null ||
      cents.standardCents === null ||
      cents.premiumCents === null ||
      cents.implantCents === null
    ) {
      return; // per-field errors are already visible inline
    }
    const persisted = await save({
      economyCents: cents.economyCents,
      standardCents: cents.standardCents,
      premiumCents: cents.premiumCents,
      implantCents: cents.implantCents,
    });
    if (persisted) {
      setDraft(toPricingDraft(persisted));
      setBaseline(toPricingDraft(persisted));
    }
  }

  return (
    <SectionCard
      title="Crown pricing"
      description="Per-tier crown fees for this office. These drive the Value Engineering panel on the Treatment tab."
    >
      {draft === null ? (
        <SectionEmptyState
          what="crown pricing"
          onSeed={() => setDraft(toPricingDraft(DEFAULT_CROWN_PRICING))}
        />
      ) : (
        <div className="space-y-4">
          <IssueList issues={issues} />
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {PRICING_TIERS.map(({ field, label }) => (
              <div key={field}>
                <Label className="text-xs text-muted-foreground">{label}</Label>
                <div className="relative mt-1">
                  <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                    $
                  </span>
                  <Input
                    inputMode="decimal"
                    className="pl-6"
                    value={draft[field]}
                    onChange={(e) => setDraft({ ...draft, [field]: e.target.value })}
                  />
                </div>
                <FieldError
                  msg={
                    dollarsInputToCents(draft[field]) === null
                      ? "Enter a valid dollar amount."
                      : null
                  }
                />
              </div>
            ))}
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

// ═══ Stages ═════════════════════════════════════════════════════════════════

interface StageRow {
  key: string;
  label: string;
  color: string;
  warn: string;
  critical: string;
  order: number;
  system: boolean;
}

function toStageRows(v: Stage[]): StageRow[] {
  return v
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((s) => ({
      key: s.key,
      label: s.label,
      color: s.color,
      warn: String(s.slaWarnDays),
      critical: String(s.slaCriticalDays),
      order: s.order,
      system: s.system,
    }));
}

export function StagesEditor({
  office,
  value,
  onSaved,
}: {
  office: OfficeId;
  value: Stage[] | undefined;
  onSaved: (v: Stage[]) => void;
}) {
  const [rows, setRows] = useState<StageRow[] | null>(() =>
    value ? toStageRows(value) : null,
  );
  const [baseline, setBaseline] = useState<StageRow[] | null>(() =>
    value ? toStageRows(value) : null,
  );
  const { saving, issues, save } = useSectionSave(office, "stages", "Stages", onSaved);

  const dirty = rows !== null && !deepEq(rows, baseline);

  function patch(key: string, p: Partial<StageRow>) {
    if (!rows) return;
    setRows(rows.map((r) => (r.key === key ? { ...r, ...p } : r)));
  }

  function rowError(r: StageRow): string | null {
    if (r.label.trim() === "" || r.label.length > 40) return "Label must be 1–40 characters.";
    if (r.color.trim() === "" || r.color.length > 64) return "Color is required (max 64 chars).";
    if (intFromInput(r.warn, 0, 365) === null) return "Warn days must be 0–365.";
    if (intFromInput(r.critical, 0, 365) === null) return "Critical days must be 0–365.";
    return null;
  }

  async function handleSave() {
    if (!rows) return;
    if (rows.some((r) => rowError(r) !== null)) return;
    const next: Stage[] = rows.map((r) => ({
      key: r.key,
      label: r.label.trim(),
      color: r.color.trim(),
      slaWarnDays: intFromInput(r.warn, 0, 365) ?? 0,
      slaCriticalDays: intFromInput(r.critical, 0, 365) ?? 0,
      order: r.order,
      system: r.system,
    }));
    const persisted = await save(next);
    if (persisted) {
      setRows(toStageRows(persisted));
      setBaseline(toStageRows(persisted));
    }
  }

  return (
    <SectionCard
      title="Pipeline stages"
      description="Label, color, and aging thresholds per stage. Warning turns cases amber; Critical turns them red."
    >
      {rows === null ? (
        <SectionEmptyState what="pipeline stages" onSeed={() => setRows(toStageRows(DEFAULT_STAGES))} />
      ) : (
        <div className="space-y-4">
          <IssueList issues={issues} />
          <div className="space-y-2">
            {rows.map((r) => (
              <div key={r.key} className="p-3 rounded-lg border border-border space-y-2">
                <div className="flex items-center gap-2">
                  <div
                    className="w-3 h-3 rounded-full shrink-0 border border-border"
                    style={{ background: r.color }}
                  />
                  <Input
                    className="flex-1 h-8 text-sm font-medium"
                    value={r.label}
                    onChange={(e) => patch(r.key, { label: e.target.value })}
                  />
                  <span className="text-[10px] text-muted-foreground font-mono shrink-0">
                    {r.key}
                  </span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <div>
                    <Label className="text-[11px] text-muted-foreground">Color</Label>
                    <Input
                      className="h-8 text-xs mt-0.5"
                      value={r.color}
                      onChange={(e) => patch(r.key, { color: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label className="text-[11px] text-muted-foreground">Warn after (days)</Label>
                    <Input
                      className="h-8 text-xs mt-0.5"
                      inputMode="numeric"
                      value={r.warn}
                      onChange={(e) => patch(r.key, { warn: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label className="text-[11px] text-muted-foreground">Critical after (days)</Label>
                    <Input
                      className="h-8 text-xs mt-0.5"
                      inputMode="numeric"
                      value={r.critical}
                      onChange={(e) => patch(r.key, { critical: e.target.value })}
                    />
                  </div>
                </div>
                <FieldError msg={rowError(r)} />
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Adding or removing stages isn&apos;t supported: the stage set is wired
            to case statuses across the pipeline, and changing it would require
            migrating every existing case (legacy rule carried forward).
          </p>
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

// ═══ Objections ═════════════════════════════════════════════════════════════

interface ObjectionRow {
  key: string;
  label: string;
  script: string;
  days: string;
}

function toObjectionRows(v: Objection[]): ObjectionRow[] {
  return v.map((o) => ({
    key: o.key,
    label: o.label,
    script: o.script,
    days: String(o.suggestedFollowUpDays),
  }));
}

export function ObjectionsEditor({
  office,
  value,
  onSaved,
}: {
  office: OfficeId;
  value: Objection[] | undefined;
  onSaved: (v: Objection[]) => void;
}) {
  const [rows, setRows] = useState<ObjectionRow[] | null>(() =>
    value ? toObjectionRows(value) : null,
  );
  const [baseline, setBaseline] = useState<ObjectionRow[] | null>(() =>
    value ? toObjectionRows(value) : null,
  );
  const [newKey, setNewKey] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const { saving, issues, save } = useSectionSave(office, "objections", "Objections", onSaved);

  const dirty = rows !== null && !deepEq(rows, baseline);

  function rowError(r: ObjectionRow): string | null {
    if (r.label.trim() === "" || r.label.length > 120) return "Label must be 1–120 characters.";
    if (r.script.length > 8000) return "Script is too long (max 8000 characters).";
    if (intFromInput(r.days, 0, 90) === null) return "Follow-up days must be 0–90.";
    return null;
  }

  function addRow() {
    if (!rows) return;
    const key = newKey.trim();
    if (!SLUG_RE.test(key) || key.length > 40) {
      setAddError("Key must be a short slug: lowercase letters, digits, - or _ (max 40).");
      return;
    }
    if (rows.some((r) => r.key === key)) {
      setAddError("That key already exists.");
      return;
    }
    if (newLabel.trim() === "") {
      setAddError("Label is required.");
      return;
    }
    setRows([...rows, { key, label: newLabel.trim(), script: "", days: "3" }]);
    setNewKey("");
    setNewLabel("");
    setAddError(null);
  }

  async function handleSave() {
    if (!rows) return;
    if (rows.some((r) => rowError(r) !== null)) return;
    const next: Objection[] = rows.map((r) => ({
      key: r.key,
      label: r.label.trim(),
      script: r.script,
      suggestedFollowUpDays: intFromInput(r.days, 0, 90) ?? 0,
    }));
    const persisted = await save(next);
    if (persisted) {
      setRows(toObjectionRows(persisted));
      setBaseline(toObjectionRows(persisted));
    }
  }

  return (
    <SectionCard
      title="Objection library"
      description="Response scripts the team can lean on when a patient hesitates, plus the suggested follow-up interval per objection."
    >
      {rows === null ? (
        <SectionEmptyState
          what="the objection library"
          onSeed={() => setRows(toObjectionRows(DEFAULT_OBJECTIONS))}
        />
      ) : (
        <div className="space-y-4">
          <IssueList issues={issues} />
          <div className="space-y-3">
            {rows.map((r, idx) => (
              <div key={r.key} className="p-3 rounded-lg border border-border space-y-2">
                <div className="flex items-center gap-2">
                  <Input
                    className="flex-1 h-8 text-sm font-medium"
                    value={r.label}
                    onChange={(e) =>
                      setRows(rows.map((x, i) => (i === idx ? { ...x, label: e.target.value } : x)))
                    }
                  />
                  <span className="text-[10px] text-muted-foreground font-mono shrink-0">
                    {r.key}
                  </span>
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
                <Textarea
                  rows={3}
                  className="text-sm"
                  placeholder="Suggested response script…"
                  value={r.script}
                  onChange={(e) =>
                    setRows(rows.map((x, i) => (i === idx ? { ...x, script: e.target.value } : x)))
                  }
                />
                <div className="flex items-center gap-2">
                  <Label className="text-[11px] text-muted-foreground">
                    Suggested follow-up (days)
                  </Label>
                  <Input
                    className="h-8 w-20 text-xs"
                    inputMode="numeric"
                    value={r.days}
                    onChange={(e) =>
                      setRows(rows.map((x, i) => (i === idx ? { ...x, days: e.target.value } : x)))
                    }
                  />
                </div>
                <FieldError msg={rowError(r)} />
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-end gap-2 pt-1 border-t border-border">
            <div>
              <Label className="text-[11px] text-muted-foreground">New key (slug)</Label>
              <Input
                className="h-8 w-40 text-xs mt-0.5"
                placeholder="e.g. warranty"
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-[11px] text-muted-foreground">Label</Label>
              <Input
                className="h-8 w-56 text-xs mt-0.5"
                placeholder="What the patient says"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
              />
            </div>
            <Button variant="outline" size="sm" onClick={addRow}>
              <Plus className="w-4 h-4 mr-1" /> Add objection
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

// ═══ Tag lists (motivators / lost reasons / referral sources) ═══════════════

type TagSection = "motivators" | "lost_reasons" | "referral_sources";

const TAG_DEFAULTS: Record<TagSection, Tag[]> = {
  motivators: DEFAULT_MOTIVATORS,
  lost_reasons: DEFAULT_LOST_REASONS,
  referral_sources: DEFAULT_REFERRAL_SOURCES,
};

interface TagRow {
  key: string;
  label: string;
  color: string; // "" ⇒ null on save
  archived: boolean;
}

function toTagRows(v: Tag[]): TagRow[] {
  return v.map((t) => ({
    key: t.key,
    label: t.label,
    color: t.color ?? "",
    archived: t.archived,
  }));
}

export function TagSectionEditor({
  office,
  section,
  title,
  description,
  value,
  onSaved,
}: {
  office: OfficeId;
  section: TagSection;
  title: string;
  description: string;
  value: Tag[] | undefined;
  onSaved: (v: Tag[]) => void;
}) {
  const [rows, setRows] = useState<TagRow[] | null>(() => (value ? toTagRows(value) : null));
  const [baseline, setBaseline] = useState<TagRow[] | null>(() =>
    value ? toTagRows(value) : null,
  );
  const [newKey, setNewKey] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const { saving, issues, save } = useSectionSave(office, section, title, onSaved);

  const dirty = rows !== null && !deepEq(rows, baseline);

  function rowError(r: TagRow): string | null {
    if (r.label.trim() === "" || r.label.length > 80) return "Label must be 1–80 characters.";
    if (r.color.length > 64) return "Color is too long (max 64 chars).";
    return null;
  }

  function addRow() {
    if (!rows) return;
    const key = newKey.trim();
    if (!SLUG_RE.test(key) || key.length > 60) {
      setAddError("Key must be a short slug: lowercase letters, digits, - or _ (max 60).");
      return;
    }
    if (rows.some((r) => r.key === key)) {
      setAddError("That key already exists.");
      return;
    }
    if (newLabel.trim() === "") {
      setAddError("Label is required.");
      return;
    }
    setRows([...rows, { key, label: newLabel.trim(), color: "", archived: false }]);
    setNewKey("");
    setNewLabel("");
    setAddError(null);
  }

  async function handleSave() {
    if (!rows) return;
    if (rows.some((r) => rowError(r) !== null)) return;
    const next: Tag[] = rows.map((r) => ({
      key: r.key,
      label: r.label.trim(),
      color: r.color.trim() === "" ? null : r.color.trim(),
      archived: r.archived,
    }));
    const persisted = await save(next);
    if (persisted) {
      setRows(toTagRows(persisted));
      setBaseline(toTagRows(persisted));
    }
  }

  return (
    <SectionCard title={title} description={description}>
      {rows === null ? (
        <SectionEmptyState
          what={title.toLowerCase()}
          onSeed={() => setRows(toTagRows(TAG_DEFAULTS[section]))}
        />
      ) : (
        <div className="space-y-4">
          <IssueList issues={issues} />
          <div className="space-y-2">
            {rows.map((r, idx) => (
              <div key={r.key} className="p-2.5 rounded-lg border border-border space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    className="h-8 flex-1 min-w-40 text-sm"
                    value={r.label}
                    onChange={(e) =>
                      setRows(rows.map((x, i) => (i === idx ? { ...x, label: e.target.value } : x)))
                    }
                  />
                  <Input
                    className="h-8 w-40 text-xs"
                    placeholder="Color (optional)"
                    value={r.color}
                    onChange={(e) =>
                      setRows(rows.map((x, i) => (i === idx ? { ...x, color: e.target.value } : x)))
                    }
                  />
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Switch
                      checked={r.archived}
                      onCheckedChange={(checked) =>
                        setRows(rows.map((x, i) => (i === idx ? { ...x, archived: checked } : x)))
                      }
                    />
                    Archived
                  </label>
                  <span className="text-[10px] text-muted-foreground font-mono">{r.key}</span>
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
                <FieldError msg={rowError(r)} />
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-end gap-2 pt-1 border-t border-border">
            <div>
              <Label className="text-[11px] text-muted-foreground">New key (slug)</Label>
              <Input
                className="h-8 w-40 text-xs mt-0.5"
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
              <Plus className="w-4 h-4 mr-1" /> Add
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

// ═══ Treatment categories ═══════════════════════════════════════════════════

const NO_PROVIDER = "__none__";

interface CategoryRow {
  key: string;
  label: string;
  provider: string; // NO_PROVIDER ⇒ null on save
}

function toCategoryRows(v: TreatmentCategory[]): CategoryRow[] {
  return v.map((c) => ({
    key: c.key,
    label: c.label,
    provider: c.defaultFinancingProviderKey ?? NO_PROVIDER,
  }));
}

export function TreatmentCategoriesEditor({
  office,
  value,
  providers,
  onSaved,
}: {
  office: OfficeId;
  value: TreatmentCategory[] | undefined;
  providers: FinancingProvider[] | undefined;
  onSaved: (v: TreatmentCategory[]) => void;
}) {
  const [rows, setRows] = useState<CategoryRow[] | null>(() =>
    value ? toCategoryRows(value) : null,
  );
  const [baseline, setBaseline] = useState<CategoryRow[] | null>(() =>
    value ? toCategoryRows(value) : null,
  );
  const [newKey, setNewKey] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const { saving, issues, save } = useSectionSave(
    office,
    "treatment_categories",
    "Treatment categories",
    onSaved,
  );

  const dirty = rows !== null && !deepEq(rows, baseline);
  const providerKeys = (providers ?? []).map((p) => ({ key: p.key, label: p.label }));

  function providerOptions(current: string): { key: string; label: string }[] {
    // Keep a referenced-but-missing provider selectable so editing another
    // field can't silently drop it.
    if (current !== NO_PROVIDER && !providerKeys.some((p) => p.key === current)) {
      return [...providerKeys, { key: current, label: `${current} (missing)` }];
    }
    return providerKeys;
  }

  function rowError(r: CategoryRow): string | null {
    if (r.label.trim() === "" || r.label.length > 80) return "Label must be 1–80 characters.";
    return null;
  }

  function addRow() {
    if (!rows) return;
    const key = newKey.trim();
    if (!SLUG_RE.test(key) || key.length > 60) {
      setAddError("Key must be a short slug: lowercase letters, digits, - or _ (max 60).");
      return;
    }
    if (rows.some((r) => r.key === key)) {
      setAddError("That key already exists.");
      return;
    }
    if (newLabel.trim() === "") {
      setAddError("Label is required.");
      return;
    }
    setRows([...rows, { key, label: newLabel.trim(), provider: NO_PROVIDER }]);
    setNewKey("");
    setNewLabel("");
    setAddError(null);
  }

  async function handleSave() {
    if (!rows) return;
    if (rows.some((r) => rowError(r) !== null)) return;
    const next: TreatmentCategory[] = rows.map((r) => ({
      key: r.key,
      label: r.label.trim(),
      defaultFinancingProviderKey: r.provider === NO_PROVIDER ? null : r.provider,
    }));
    const persisted = await save(next);
    if (persisted) {
      setRows(toCategoryRows(persisted));
      setBaseline(toCategoryRows(persisted));
    }
  }

  return (
    <SectionCard
      title="Treatment categories"
      description="Case categorization plus the financing provider suggested first for each category."
    >
      {rows === null ? (
        <SectionEmptyState
          what="treatment categories"
          onSeed={() => setRows(toCategoryRows(DEFAULT_TREATMENT_CATEGORIES))}
        />
      ) : (
        <div className="space-y-4">
          <IssueList issues={issues} />
          <div className="space-y-2">
            {rows.map((r, idx) => (
              <div key={r.key} className="p-2.5 rounded-lg border border-border space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    className="h-8 flex-1 min-w-40 text-sm"
                    value={r.label}
                    onChange={(e) =>
                      setRows(rows.map((x, i) => (i === idx ? { ...x, label: e.target.value } : x)))
                    }
                  />
                  <Select
                    value={r.provider}
                    onValueChange={(v) =>
                      setRows(rows.map((x, i) => (i === idx ? { ...x, provider: v } : x)))
                    }
                  >
                    <SelectTrigger className="h-8 w-48 text-xs">
                      <SelectValue placeholder="Default financing" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_PROVIDER}>No default provider</SelectItem>
                      {providerOptions(r.provider).map((p) => (
                        <SelectItem key={p.key} value={p.key}>
                          {p.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="text-[10px] text-muted-foreground font-mono">{r.key}</span>
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
                <FieldError msg={rowError(r)} />
              </div>
            ))}
          </div>
          {providerKeys.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No financing providers configured yet — set them up under Financing
              to pick per-category defaults.
            </p>
          )}
          <div className="flex flex-wrap items-end gap-2 pt-1 border-t border-border">
            <div>
              <Label className="text-[11px] text-muted-foreground">New key (slug)</Label>
              <Input
                className="h-8 w-40 text-xs mt-0.5"
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
              <Plus className="w-4 h-4 mr-1" /> Add category
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

// ═══ Cadence ════════════════════════════════════════════════════════════════

interface CadenceDraft {
  tiers: { key: CadenceConfig["tiers"][number]["key"]; label: string; intervals: string }[];
  standardMin: string; // dollars
  highTouchMin: string; // dollars
  highUrgencyFirstDay: string;
  spouseFamilyMinFirstDay: string;
}

function toCadenceDraft(v: CadenceConfig): CadenceDraft {
  return {
    tiers: v.tiers.map((t) => ({
      key: t.key,
      label: t.label,
      intervals: t.intervals.join(", "),
    })),
    standardMin: centsToDollarsInput(v.thresholds.standardMinCents),
    highTouchMin: centsToDollarsInput(v.thresholds.highTouchMinCents),
    highUrgencyFirstDay: String(v.highUrgencyFirstDay),
    spouseFamilyMinFirstDay: String(v.spouseFamilyMinFirstDay),
  };
}

export function CadenceEditor({
  office,
  value,
  onSaved,
}: {
  office: OfficeId;
  value: CadenceConfig | undefined;
  onSaved: (v: CadenceConfig) => void;
}) {
  const [draft, setDraft] = useState<CadenceDraft | null>(() =>
    value ? toCadenceDraft(value) : null,
  );
  const [baseline, setBaseline] = useState<CadenceDraft | null>(() =>
    value ? toCadenceDraft(value) : null,
  );
  const { saving, issues, save } = useSectionSave(office, "cadence_config", "Cadence", onSaved);

  const dirty = draft !== null && !deepEq(draft, baseline);

  function tierError(intervals: string): string | null {
    return parseIntList(intervals, { min: 0, max: 365, maxLen: 12, minLen: 1 }) === null
      ? "Enter 1–12 comma-separated day offsets (0–365), e.g. 2, 7, 14."
      : null;
  }

  async function handleSave() {
    if (!draft) return;
    const standardMinCents = dollarsInputToCents(draft.standardMin);
    const highTouchMinCents = dollarsInputToCents(draft.highTouchMin);
    const highUrgency = intFromInput(draft.highUrgencyFirstDay, 0, 30);
    const spouseFamily = intFromInput(draft.spouseFamilyMinFirstDay, 0, 30);
    const tiers = draft.tiers.map((t) => ({
      key: t.key,
      label: t.label.trim(),
      intervals: parseIntList(t.intervals, { min: 0, max: 365, maxLen: 12, minLen: 1 }),
    }));
    if (
      standardMinCents === null ||
      highTouchMinCents === null ||
      highUrgency === null ||
      spouseFamily === null ||
      tiers.some((t) => t.intervals === null || t.label === "" || t.label.length > 40)
    ) {
      return;
    }
    const next: CadenceConfig = {
      tiers: tiers.map((t) => ({
        key: t.key,
        label: t.label,
        intervals: t.intervals ?? [],
      })),
      thresholds: { standardMinCents, highTouchMinCents },
      highUrgencyFirstDay: highUrgency,
      spouseFamilyMinFirstDay: spouseFamily,
    };
    const persisted = await save(next);
    if (persisted) {
      setDraft(toCadenceDraft(persisted));
      setBaseline(toCadenceDraft(persisted));
    }
  }

  return (
    <SectionCard
      title="Follow-up cadence"
      description="Day offsets per value tier, the dollar thresholds that pick the tier, and the first-touch modifiers."
    >
      {draft === null ? (
        <SectionEmptyState
          what="the follow-up cadence"
          onSeed={() => setDraft(toCadenceDraft(DEFAULT_CADENCE_CONFIG))}
        />
      ) : (
        <div className="space-y-4">
          <IssueList issues={issues} />
          <div className="space-y-2">
            {draft.tiers.map((t, idx) => (
              <div key={t.key} className="p-3 rounded-lg border border-border space-y-2">
                <div className="flex items-center gap-2">
                  <Input
                    className="h-8 w-56 text-sm font-medium"
                    value={t.label}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        tiers: draft.tiers.map((x, i) =>
                          i === idx ? { ...x, label: e.target.value } : x,
                        ),
                      })
                    }
                  />
                  <span className="text-[10px] text-muted-foreground font-mono">{t.key}</span>
                </div>
                <div>
                  <Label className="text-[11px] text-muted-foreground">
                    Touch days after presentation (comma-separated)
                  </Label>
                  <Input
                    className="h-8 text-xs mt-0.5"
                    value={t.intervals}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        tiers: draft.tiers.map((x, i) =>
                          i === idx ? { ...x, intervals: e.target.value } : x,
                        ),
                      })
                    }
                  />
                  <FieldError msg={tierError(t.intervals)} />
                  <FieldError
                    msg={
                      t.label.trim() === "" || t.label.length > 40
                        ? "Tier label must be 1–40 characters."
                        : null
                    }
                  />
                </div>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <Label className="text-[11px] text-muted-foreground">Standard tier starts at</Label>
              <div className="relative mt-0.5">
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                  $
                </span>
                <Input
                  className="h-8 pl-6 text-xs"
                  inputMode="decimal"
                  value={draft.standardMin}
                  onChange={(e) => setDraft({ ...draft, standardMin: e.target.value })}
                />
              </div>
              <FieldError
                msg={dollarsInputToCents(draft.standardMin) === null ? "Enter a valid amount." : null}
              />
            </div>
            <div>
              <Label className="text-[11px] text-muted-foreground">High touch starts at</Label>
              <div className="relative mt-0.5">
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                  $
                </span>
                <Input
                  className="h-8 pl-6 text-xs"
                  inputMode="decimal"
                  value={draft.highTouchMin}
                  onChange={(e) => setDraft({ ...draft, highTouchMin: e.target.value })}
                />
              </div>
              <FieldError
                msg={dollarsInputToCents(draft.highTouchMin) === null ? "Enter a valid amount." : null}
              />
            </div>
            <div>
              <Label className="text-[11px] text-muted-foreground">
                High-urgency first touch (day)
              </Label>
              <Input
                className="h-8 text-xs mt-0.5"
                inputMode="numeric"
                value={draft.highUrgencyFirstDay}
                onChange={(e) => setDraft({ ...draft, highUrgencyFirstDay: e.target.value })}
              />
              <FieldError
                msg={
                  intFromInput(draft.highUrgencyFirstDay, 0, 30) === null
                    ? "Must be 0–30."
                    : null
                }
              />
            </div>
            <div>
              <Label className="text-[11px] text-muted-foreground">
                Spouse/family min first touch (day)
              </Label>
              <Input
                className="h-8 text-xs mt-0.5"
                inputMode="numeric"
                value={draft.spouseFamilyMinFirstDay}
                onChange={(e) => setDraft({ ...draft, spouseFamilyMinFirstDay: e.target.value })}
              />
              <FieldError
                msg={
                  intFromInput(draft.spouseFamilyMinFirstDay, 0, 30) === null
                    ? "Must be 0–30."
                    : null
                }
              />
            </div>
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

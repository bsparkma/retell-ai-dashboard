/**
 * /admin/print-templates — Settings → Print templates (CO-3): the school/work
 * excuse and the appointment card the front desk prints from the checkout
 * workup. Under /admin, so admin.all is the gate (ROUTE_PERMISSIONS), and the
 * server enforces the same gate on every call.
 *
 * WHAT THE SERVER OWNS: what is saved (every save answers the template as read
 * back), the placeholder menu (a save carrying an unknown `{{...}}` is refused
 * by name — this page runs the same validator as you type, so you see it
 * first), and whether a logo can be stored at all.
 *
 * THE PREVIEW is the same composition the PDF is drawn from, filled with
 * clearly synthetic sample values (`samplePrintValues`) — never a patient.
 *
 * THE OFFICE comes from the app's office picker, never typed. "All offices"
 * offers one office at a time here, since each office has its own letterhead.
 *
 * A THIRD TYPE is a registry entry (shared/tc/printTemplates.ts): the tabs are
 * the server's list.
 *
 * STYLE (CO-3b; Beau's ruling 2026-11-02: curated options only, no free-form
 * designer): accent colour, font pair, logo placement and size, and one of
 * three layouts, per office per template. The editor runs the server's own
 * validator as you choose (an accent too light to read on white is named and
 * Save is off), and the preview is drawn from the same layout engine as the
 * PDF, in the same font files. "Standard" is today's printout, and a template
 * left on it prints exactly as before.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ImagePlus, Loader2, Printer, RefreshCw, RotateCcw, Save, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ALL_OFFICES, useOffice } from "@/contexts/OfficeContext";
import { tcErrorMessage } from "@/features/tc/api";
import { PrintPreview, type PreviewLogo } from "@/features/tc/print/PrintPreview";
import { usePrintFonts, type PrintFontStatus } from "@/features/tc/print/usePrintFonts";
import {
  fetchPrintLogoUrl,
  getPrintTemplates,
  removePrintLogo,
  savePrintStyling,
  savePrintTemplate,
  uploadPrintLogo,
} from "@/features/tc/print/printApi";
import {
  ACCENT_MIN_CONTRAST,
  PRINT_FONT_PAIRS,
  PRINT_LAYOUTS,
  PRINT_LOGO_PLACEMENTS,
  PRINT_LOGO_SIZES,
  PRINT_STYLING_DEFAULTS,
  effectivePrintStyling,
  isDefaultStyling,
  validatePrintStyling,
  type PrintFontPair,
  type PrintLayout,
  type PrintLogoPlacement,
  type PrintLogoSize,
  type PrintStyling,
  type PrintStylingProblem,
} from "@shared/tc/printStyling";
import {
  PRINT_PLACEHOLDERS,
  PRINT_PLACEHOLDER_LABELS,
  composePrintDocument,
  defaultPrintTemplate,
  samplePrintValues,
  validatePrintTemplate,
  type PrintPlaceholder,
  type PrintTemplateFields,
  type PrintTemplateState,
  type PrintTemplatesResponse,
  type PrintTemplateType,
} from "@shared/tc/printTemplates";
import type { OfficeId } from "@shared/tc/contract";

const PRINT_OFFICES: readonly OfficeId[] = ["roland", "valley"];

/** The two fields a placeholder may go in; the picker inserts into the one last focused. */
type PlaceholderField = "body" | "signatureLine";

function sameFields(a: PrintTemplateFields, b: PrintTemplateFields): boolean {
  return (Object.keys(a) as Array<keyof PrintTemplateFields>).every((k) => a[k] === b[k]);
}

function sameStyling(a: PrintStyling, b: PrintStyling): boolean {
  return (Object.keys(PRINT_STYLING_DEFAULTS) as Array<keyof PrintStyling>).every((k) => a[k] === b[k]);
}

/** A row of curated choices; the chosen one is pressed. */
function Choice<K extends string>({
  name,
  options,
  value,
  onChange,
  hint,
}: {
  name: string;
  options: Record<K, string>;
  value: K;
  onChange: (v: K) => void;
  hint?: Partial<Record<K, string>>;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={name}>
      {(Object.keys(options) as K[]).map((k) => (
        <button
          key={k}
          type="button"
          aria-pressed={value === k}
          title={hint?.[k]}
          onClick={() => onChange(k)}
          className={`rounded-md border px-2.5 py-1 text-xs font-medium ${
            value === k ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background hover:bg-muted"
          }`}
          data-testid={`print-style-${name}-${k}`}
        >
          {options[k]}
        </button>
      ))}
    </div>
  );
}

function labelsOf<K extends string>(o: Record<K, { label: string }>): Record<K, string> {
  return Object.fromEntries(Object.entries<{ label: string }>(o).map(([k, v]) => [k, v.label])) as Record<K, string>;
}

/** CO-3b: the curated style options. */
function StyleControls({
  style,
  onChange,
  problems,
  hasLogo,
  fontStatus,
}: {
  style: PrintStyling;
  onChange: (next: PrintStyling) => void;
  problems: PrintStylingProblem[];
  hasLogo: boolean;
  fontStatus: PrintFontStatus;
}) {
  const set = <K extends keyof PrintStyling>(k: K, v: PrintStyling[K]) => onChange({ ...style, [k]: v });
  const [hexDraft, setHexDraft] = useState(style.accentColor);
  useEffect(() => setHexDraft(style.accentColor), [style.accentColor]);
  const colorProblem = problems.find((p) => p.field === "accentColor");
  const layoutHints = Object.fromEntries(Object.entries(PRINT_LAYOUTS).map(([k, v]) => [k, v.hint])) as Record<PrintLayout, string>;
  return (
    <fieldset className="space-y-3 rounded-lg border border-border p-3" data-testid="print-style">
      <legend className="px-1 text-xs font-medium text-muted-foreground">Style</legend>

      <div className="space-y-1">
        <div className="text-xs font-medium text-muted-foreground">Layout</div>
        <Choice<PrintLayout>
          name="layout"
          options={labelsOf<PrintLayout>(PRINT_LAYOUTS)}
          hint={layoutHints}
          value={style.layout}
          onChange={(v) => set("layout", v)}
        />
        <p className="text-xs text-muted-foreground">{PRINT_LAYOUTS[style.layout].hint}. A layout moves things; it never changes the wording.</p>
      </div>

      <label className="block space-y-1 text-xs font-medium text-muted-foreground">
        Fonts (heading and text)
        <select
          value={style.fontPair}
          onChange={(e) => set("fontPair", e.target.value as PrintFontPair)}
          className="block w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          data-testid="print-style-fontPair"
        >
          {(Object.keys(PRINT_FONT_PAIRS) as PrintFontPair[]).map((k) => (
            <option key={k} value={k}>
              {PRINT_FONT_PAIRS[k].label}
            </option>
          ))}
        </select>
        {fontStatus === "loading" ? <span className="block font-normal">Loading the font for the preview…</span> : null}
        {fontStatus === "unavailable" ? (
          <span className="block font-normal text-amber-800 dark:text-amber-300" data-testid="print-style-font-unavailable">
            This browser could not show the font in the preview. Positions are exact; the printout embeds the font.
          </span>
        ) : null}
      </label>

      <div className="space-y-1">
        <div className="text-xs font-medium text-muted-foreground">
          Accent colour (the letterhead and the rule under it; the letter&apos;s text stays black)
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="color"
            value={/^#[0-9a-f]{6}$/i.test(style.accentColor) ? style.accentColor.toLowerCase() : "#000000"}
            onChange={(e) => set("accentColor", e.target.value.toLowerCase())}
            className="h-8 w-10 cursor-pointer rounded border border-border bg-background p-0.5"
            aria-label="Accent colour"
            data-testid="print-style-accent"
          />
          <Input
            value={hexDraft}
            maxLength={7}
            onChange={(e) => {
              setHexDraft(e.target.value);
              // Lower-cased as the server stores it, so "#1F4E79" is not a change from "#1f4e79".
              set("accentColor", e.target.value.trim().toLowerCase());
            }}
            className="h-8 w-28 font-mono text-xs"
            aria-label="Accent colour as a hex code"
            data-testid="print-style-accent-hex"
          />
          <Button size="sm" variant="ghost" className="text-xs" onClick={() => set("accentColor", PRINT_STYLING_DEFAULTS.accentColor)}>
            Black
          </Button>
        </div>
        {colorProblem ? (
          <p role="alert" className="text-xs text-red-700 dark:text-red-300" data-testid="print-style-problem">
            {colorProblem.message}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Colours with less than {ACCENT_MIN_CONTRAST} : 1 contrast against white paper are refused, so the letterhead stays readable.
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <div className="text-xs font-medium text-muted-foreground">Logo placement</div>
          <Choice<PrintLogoPlacement>
            name="logoPlacement"
            options={PRINT_LOGO_PLACEMENTS}
            value={style.logoPlacement}
            onChange={(v) => set("logoPlacement", v)}
          />
        </div>
        <div className="space-y-1">
          <div className="text-xs font-medium text-muted-foreground">Logo size</div>
          <Choice<PrintLogoSize> name="logoSize" options={labelsOf<PrintLogoSize>(PRINT_LOGO_SIZES)} value={style.logoSize} onChange={(v) => set("logoSize", v)} />
        </div>
      </div>
      {!hasLogo ? (
        <p className="text-xs text-muted-foreground" data-testid="print-style-no-logo">
          No logo uploaded: the printout simply has no logo, wherever it is placed.
        </p>
      ) : null}

      <Button
        size="sm"
        variant="ghost"
        className="gap-1.5 text-xs"
        disabled={isDefaultStyling(style)}
        onClick={() => onChange({ ...PRINT_STYLING_DEFAULTS })}
        data-testid="print-style-reset"
      >
        <RotateCcw className="h-3.5 w-3.5" /> Back to the standard style (as printed today)
      </Button>
    </fieldset>
  );
}

function TemplateEditor({
  office,
  state,
  prefill,
  logoStorageConfigured,
  onSaved,
}: {
  office: OfficeId;
  state: PrintTemplateState;
  prefill: PrintTemplatesResponse["prefill"];
  logoStorageConfigured: boolean;
  onSaved: (next: PrintTemplateState) => void;
}) {
  const [draft, setDraft] = useState<PrintTemplateFields>(state.fields);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [logoSize, setLogoSize] = useState<{ width: number; height: number } | null>(null);
  const savedStyle = useMemo(() => effectivePrintStyling(state.styling), [state.styling]);
  const [style, setStyle] = useState<PrintStyling>(savedStyle);
  const savedStyleRef = useRef(savedStyle);
  const fontStatus = usePrintFonts(office, style.fontPair);
  const target = useRef<PlaceholderField>("body");
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const sigRef = useRef<HTMLInputElement | null>(null);

  /*
   * Take the server's wording only when the SAVED WORDING changed. A logo
   * upload or removal answers a new state with the same wording, and must not
   * throw away what is typed but not yet saved.
   */
  const savedFields = useRef(state.fields);
  useEffect(() => {
    if (!sameFields(savedFields.current, state.fields)) setDraft(state.fields);
    savedFields.current = state.fields;
    // The same for the style: a wording save must not undo an unsaved style.
    const nextStyle = effectivePrintStyling(state.styling);
    if (!sameStyling(savedStyleRef.current, nextStyle)) setStyle(nextStyle);
    savedStyleRef.current = nextStyle;
  }, [state]);

  // The logo's pixel size, so the preview lays it out as the PDF does. Until it
  // is known the logo is laid out square.
  useEffect(() => {
    setLogoSize(null);
    if (!logoUrl || typeof Image === "undefined") return undefined;
    let live = true;
    const img = new Image();
    img.onload = () => {
      if (live && img.naturalWidth > 0 && img.naturalHeight > 0) setLogoSize({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.src = logoUrl;
    return () => {
      live = false;
    };
  }, [logoUrl]);

  // The stored logo, for the preview. Revoked when it changes or the editor goes.
  useEffect(() => {
    if (!state.logo.present) {
      setLogoUrl(null);
      return undefined;
    }
    let url: string | null = null;
    let live = true;
    fetchPrintLogoUrl(office, state.type)
      .then((u) => {
        url = u;
        if (live) setLogoUrl(u);
        else URL.revokeObjectURL(u);
      })
      .catch((e) => live && setLogoError(tcErrorMessage(e)));
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [office, state.type, state.logo.present, state.updatedAt]);

  const problems = useMemo(() => validatePrintTemplate(draft), [draft]);
  const doc = useMemo(() => composePrintDocument(draft, samplePrintValues(draft)), [draft]);
  const dirty = !sameFields(draft, state.fields);
  const styleCheck = useMemo(() => validatePrintStyling(style), [style]);
  const styleProblems = styleCheck.ok ? [] : styleCheck.problems;
  const styleDirty = !sameStyling(style, savedStyle);
  // What the preview draws: the style as chosen, or — while a colour is half
  // typed — the last one that validated.
  const lastValidStyle = useRef(savedStyle);
  useEffect(() => {
    if (styleCheck.ok) lastValidStyle.current = styleCheck.styling;
  }, [styleCheck]);
  const previewStyle = styleCheck.ok ? styleCheck.styling : lastValidStyle.current;
  const previewLogo = useMemo<PreviewLogo | null>(
    () => (logoUrl ? { url: logoUrl, width: logoSize?.width ?? 1, height: logoSize?.height ?? 1 } : null),
    [logoUrl, logoSize],
  );

  const set = (k: keyof PrintTemplateFields) => (v: string) => {
    setSavedNote(null);
    setDraft((d) => ({ ...d, [k]: v }));
  };

  const insert = (p: PrintPlaceholder) => {
    const token = `{{${p}}}`;
    const field = target.current;
    const el = field === "body" ? bodyRef.current : sigRef.current;
    // The selection is read ONCE, before the update: after React re-renders the
    // field the browser has moved the caret to the end.
    const value = draft[field];
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    setDraft((d) => ({ ...d, [field]: value.slice(0, start) + token + value.slice(end) }));
    setSavedNote(null);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (dirty) onSaved(await savePrintTemplate(office, state.type, draft));
      // CO-3b: the standard style is stored as "no styling" — it prints as before.
      if (styleDirty && styleCheck.ok) {
        onSaved(await savePrintStyling(office, state.type, isDefaultStyling(styleCheck.styling) ? null : styleCheck.styling));
      }
      setSavedNote("Saved.");
    } catch (e) {
      setError(tcErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const onLogo = async (file: File | null) => {
    if (!file) return;
    setLogoBusy(true);
    setLogoError(null);
    try {
      onSaved(await uploadPrintLogo(office, state.type, file));
    } catch (e) {
      setLogoError(tcErrorMessage(e));
    } finally {
      setLogoBusy(false);
    }
  };

  const onRemoveLogo = async () => {
    setLogoBusy(true);
    setLogoError(null);
    try {
      onSaved(await removePrintLogo(office, state.type));
    } catch (e) {
      setLogoError(tcErrorMessage(e));
    } finally {
      setLogoBusy(false);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2" data-testid={`print-editor-${state.type}`}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          {state.stored ? (
            <Badge variant="outline">Edited{state.updatedBy ? ` by ${state.updatedBy}` : ""}</Badge>
          ) : (
            <Badge variant="outline" data-testid="print-default-badge">
              Shipped wording
            </Badge>
          )}
          {dirty || styleDirty ? <Badge variant="outline">Unsaved changes</Badge> : null}
          {!isDefaultStyling(savedStyle) ? (
            <Badge variant="outline" data-testid="print-styled-badge">
              Custom style
            </Badge>
          ) : null}
        </div>

        <fieldset className="space-y-2 rounded-lg border border-border p-3">
          <legend className="px-1 text-xs font-medium text-muted-foreground">Letterhead</legend>
          <label className="block text-xs font-medium text-muted-foreground">
            Practice name
            <Input value={draft.letterheadName} maxLength={120} onChange={(e) => set("letterheadName")(e.target.value)} data-testid="print-field-letterheadName" />
          </label>
          <label className="block text-xs font-medium text-muted-foreground">
            Address
            <Textarea rows={2} value={draft.letterheadAddress} maxLength={300} onChange={(e) => set("letterheadAddress")(e.target.value)} data-testid="print-field-letterheadAddress" />
          </label>
          <label className="block text-xs font-medium text-muted-foreground">
            Phone
            <Input value={draft.letterheadPhone} maxLength={40} onChange={(e) => set("letterheadPhone")(e.target.value)} data-testid="print-field-letterheadPhone" />
          </label>
          <div className="space-y-1 pt-1">
            <div className="text-xs font-medium text-muted-foreground">Logo (optional, PNG or JPEG, up to 2 MB)</div>
            {!logoStorageConfigured ? (
              <p className="text-xs text-amber-800 dark:text-amber-300" data-testid="print-logo-unavailable">
                Logo storage is not set up for this environment. Templates print without a logo until it is.
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <label className={`inline-flex ${logoStorageConfigured && !logoBusy ? "cursor-pointer" : "pointer-events-none opacity-50"}`}>
                <input
                  type="file"
                  accept="image/png,image/jpeg"
                  className="sr-only"
                  disabled={!logoStorageConfigured || logoBusy}
                  onChange={(e) => {
                    void onLogo(e.target.files?.[0] ?? null);
                    e.target.value = "";
                  }}
                  data-testid="print-logo-input"
                />
                <span className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium">
                  {logoBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />}
                  {state.logo.present ? "Replace logo" : "Upload logo"}
                </span>
              </label>
              {state.logo.present ? (
                <Button size="sm" variant="ghost" className="gap-1.5 text-xs" disabled={logoBusy} onClick={() => void onRemoveLogo()}>
                  <Trash2 className="h-3.5 w-3.5" /> Print without a logo
                </Button>
              ) : null}
            </div>
            {logoError ? (
              <p role="alert" className="text-xs text-red-700 dark:text-red-300" data-testid="print-logo-error">
                {logoError}
              </p>
            ) : null}
          </div>
        </fieldset>

        <StyleControls
          style={style}
          onChange={(next) => {
            setSavedNote(null);
            setStyle(next);
          }}
          problems={styleProblems}
          hasLogo={state.logo.present}
          fontStatus={fontStatus}
        />

        <label className="block text-xs font-medium text-muted-foreground">
          Heading
          <Input value={draft.heading} maxLength={120} onChange={(e) => set("heading")(e.target.value)} data-testid="print-field-heading" />
        </label>

        <div className="space-y-1">
          <div className="text-xs font-medium text-muted-foreground">Insert a placeholder (into the body, or the signature line if that is where you are typing)</div>
          <div className="flex flex-wrap gap-1.5" data-testid="print-placeholder-menu">
            {PRINT_PLACEHOLDERS.map((p) => (
              <button
                key={p}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => insert(p)}
                className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs hover:bg-muted"
                data-testid={`print-insert-${p}`}
              >
                {PRINT_PLACEHOLDER_LABELS[p]}
              </button>
            ))}
          </div>
        </div>

        <label className="block text-xs font-medium text-muted-foreground">
          Body
          <Textarea
            ref={bodyRef}
            rows={10}
            value={draft.body}
            maxLength={4000}
            onFocus={() => (target.current = "body")}
            onChange={(e) => set("body")(e.target.value)}
            className="font-mono text-xs"
            data-testid="print-field-body"
          />
        </label>
        <label className="block text-xs font-medium text-muted-foreground">
          Signature line (leave empty for none)
          <Input
            ref={sigRef}
            value={draft.signatureLine}
            maxLength={200}
            onFocus={() => (target.current = "signatureLine")}
            onChange={(e) => set("signatureLine")(e.target.value)}
            data-testid="print-field-signatureLine"
          />
        </label>

        {problems.length > 0 ? (
          <ul role="alert" className="space-y-1 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200" data-testid="print-problems">
            {problems.map((p, i) => (
              <li key={i} className="flex items-start gap-1.5">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {p.message}
              </li>
            ))}
          </ul>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300" data-testid="print-save-error">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={() => void save()}
            disabled={saving || problems.length > 0 || styleProblems.length > 0 || !(dirty || styleDirty)}
            className="gap-1.5"
            data-testid="print-save"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save
          </Button>
          <Button
            variant="ghost"
            className="gap-1.5"
            onClick={() => {
              setSavedNote(null);
              setDraft(defaultPrintTemplate(state.type, prefill));
            }}
            data-testid="print-restore-default"
          >
            <RotateCcw className="h-4 w-4" /> Restore the shipped wording
          </Button>
          {savedNote ? (
            <span className="text-sm text-emerald-700 dark:text-emerald-300" data-testid="print-saved">
              {savedNote}
            </span>
          ) : null}
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-xs font-medium text-muted-foreground">Preview — sample patient, not a real one</div>
        <PrintPreview doc={doc} styling={previewStyle} logo={previewLogo} />
      </div>
    </div>
  );
}

function OfficeTemplates({ office }: { office: OfficeId }) {
  const [data, setData] = useState<PrintTemplatesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [type, setType] = useState<PrintTemplateType>("excuse");

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await getPrintTemplates(office));
    } catch (e) {
      setError(tcErrorMessage(e));
    }
  }, [office]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  if (error) {
    return (
      <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
        <span>Could not load the print templates: {error}</span>
        <Button size="sm" variant="outline" onClick={() => void load()}>
          Retry
        </Button>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex justify-center py-10 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }
  const current = data.templates.find((t) => t.type === type) ?? data.templates[0];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2" role="tablist">
        {data.templates.map((t) => (
          <Button
            key={t.type}
            role="tab"
            aria-selected={t.type === current.type}
            size="sm"
            variant={t.type === current.type ? "default" : "outline"}
            onClick={() => setType(t.type)}
            data-testid={`print-tab-${t.type}`}
          >
            {t.label}
          </Button>
        ))}
      </div>
      <TemplateEditor
        key={`${office}:${current.type}`}
        office={office}
        state={current}
        prefill={data.prefill}
        logoStorageConfigured={data.logoStorageConfigured}
        onSaved={(next) => setData((d) => (d ? { ...d, templates: d.templates.map((t) => (t.type === next.type ? next : t)) } : d))}
      />
    </div>
  );
}

export default function AdminPrintTemplates() {
  const { office, offices, loading, error } = useOffice();
  const inScope = PRINT_OFFICES.filter((o) => offices.some((r) => r.officeId === o));
  const [chosen, setChosen] = useState<OfficeId | null>(null);
  const [generation, setGeneration] = useState(0);
  const nameOf = (id: string) => offices.find((o) => o.officeId === id)?.officeName ?? id;

  const active: OfficeId | null =
    office === ALL_OFFICES ? (chosen && inScope.includes(chosen) ? chosen : inScope[0] ?? null) : PRINT_OFFICES.includes(office as OfficeId) ? (office as OfficeId) : null;

  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-foreground">
            <Printer className="h-5 w-5 text-muted-foreground" aria-hidden /> Print templates
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            The school/work excuse and the appointment card the front desk prints from a patient&apos;s checkout. Each
            office has its own. Nothing printed is stored on the patient or written to Open Dental.
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setGeneration((n) => n + 1)} className="gap-1.5">
          <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Refresh
        </Button>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading offices…</p>
      ) : error ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          Could not load the office list: {error}
        </p>
      ) : !active ? (
        <p className="text-sm text-muted-foreground" data-testid="print-no-office">
          Print templates are kept per office. Choose an office in the office menu.
        </p>
      ) : (
        <div className="space-y-4" key={generation}>
          {office === ALL_OFFICES && inScope.length > 1 ? (
            <div className="flex flex-wrap items-center gap-2" data-testid="print-office-choice">
              <span className="text-xs text-muted-foreground">Office:</span>
              {inScope.map((o) => (
                <Button key={o} size="sm" variant={o === active ? "default" : "outline"} onClick={() => setChosen(o)}>
                  {nameOf(o)}
                </Button>
              ))}
            </div>
          ) : null}
          <OfficeTemplates key={active} office={active} />
        </div>
      )}
    </div>
  );
}

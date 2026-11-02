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
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ImagePlus, Loader2, Printer, RefreshCw, RotateCcw, Save, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ALL_OFFICES, useOffice } from "@/contexts/OfficeContext";
import { tcErrorMessage } from "@/features/tc/api";
import { PrintPreview } from "@/features/tc/print/PrintPreview";
import {
  fetchPrintLogoUrl,
  getPrintTemplates,
  removePrintLogo,
  savePrintTemplate,
  uploadPrintLogo,
} from "@/features/tc/print/printApi";
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
  const target = useRef<PlaceholderField>("body");
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const sigRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setDraft(state.fields);
  }, [state]);

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

  const set = (k: keyof PrintTemplateFields) => (v: string) => {
    setSavedNote(null);
    setDraft((d) => ({ ...d, [k]: v }));
  };

  const insert = (p: PrintPlaceholder) => {
    const token = `{{${p}}}`;
    const field = target.current;
    const el = field === "body" ? bodyRef.current : sigRef.current;
    setDraft((d) => {
      const value = d[field];
      const start = el?.selectionStart ?? value.length;
      const end = el?.selectionEnd ?? value.length;
      return { ...d, [field]: value.slice(0, start) + token + value.slice(end) };
    });
    setSavedNote(null);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const at = (el.selectionStart ?? 0) + token.length;
      el.setSelectionRange(at, at);
    });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await savePrintTemplate(office, state.type, draft);
      onSaved(next);
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
          {dirty ? <Badge variant="outline">Unsaved changes</Badge> : null}
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
          <Button onClick={() => void save()} disabled={saving || problems.length > 0 || !dirty} className="gap-1.5" data-testid="print-save">
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
        <PrintPreview doc={doc} logoUrl={logoUrl} />
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

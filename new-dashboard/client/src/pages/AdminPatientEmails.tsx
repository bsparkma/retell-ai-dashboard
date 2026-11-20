/**
 * /admin/patient-emails — the TC patient email library's wording, per office
 * (EL-1). WORDING CONFIG + PREVIEW ONLY: nothing on this page sends, drafts or
 * schedules an email, and the server has no route that would.
 *
 * LEFT: the questionnaire, grouped as the library groups it. The answers change
 * what the emails SAY (which technology the office has, its scheduling link,
 * which treatments it does not offer), never who is contacted or when.
 * RIGHT: a live preview of one email — procedure, stage and tone — composed by
 * the SERVER from the answers on screen (debounced). Merge fields with no value
 * stay as their {{token}}, highlighted, and are listed: never a blank, never an
 * invented value.
 *
 * WHO. The page is tc.full (its own ROUTE_PERMISSIONS entry; longest prefix
 * beats /admin's admin.all), so a TC or office user can read it. Saving needs
 * admin.all, enforced by the server; for anyone else the questionnaire is
 * read-only and there is no Save button.
 *
 * HONEST SAVE STATE. "Saved" appears only after the server answered with its
 * read-back, and the form then shows exactly what was read back.
 *
 * While the library is not clinically approved, the page says so on top. The
 * flag comes from the server and flips only by PR after the doctor's review.
 *
 * Office name and phone are not questions here: they come from the office's
 * email identity (Practice info), server-side.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Lock, Mail, RefreshCw, Save } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ALL_OFFICES, useOffice } from "@/contexts/OfficeContext";
import { tcErrorMessage } from "@/features/tc/api";
import {
  getEmailLibraryCatalog,
  getEmailLibraryProfile,
  previewEmailLibrary,
  saveEmailLibraryProfile,
} from "@/features/tc/emailLibrary/emailLibraryApi";
import { asOfficeKey, servedOfficeKeys } from "@/lib/officeKeys";
import type { OfficeId } from "@shared/tc/contract";
import {
  EMAIL_LIBRARY_LINK_MAX,
  EMAIL_LIBRARY_TEXT_MAX,
  validateEmailLibraryAnswers,
  type EmailLibraryAnswers,
  type EmailLibraryCatalogResponse,
  type EmailLibraryPreviewResponse,
  type EmailLibraryProfileResponse,
  type EmailLibraryQuestion,
} from "@shared/tc/emailLibrary";

/** The answers being edited: loose until validated (a text box can hold anything). */
type Draft = Record<string, unknown>;

const PREVIEW_DEBOUNCE_MS = 400;

/** Who fills each merge field, for the "not set" list. */
const MERGE_FIELD_HELP: Record<string, string> = {
  first_name: "the patient's first name (a sample here)",
  office_name: "the office name, from Practice info",
  office_phone: "the office phone, from Practice info",
  sender_name: "the team member sending it (your display name)",
  doctor_name: "Doctor name, on this page",
  schedule_link: "Online scheduling link, on this page",
  review_link: "Review link, on this page",
  appointment_date: "the appointment date (a sample here)",
  appointment_time: "the appointment time (a sample here)",
};

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .sort()
        .map((k) => [k, sortKeys(o[k])]),
    );
  }
  return v;
}

/** Is a question shown, given its show_if and the draft? (show_if names a yes/no answer.) */
function shown(q: EmailLibraryQuestion, draft: Draft): boolean {
  if (!q.show_if) return true;
  return draft[q.show_if] === true;
}

/** Text with {{tokens}} highlighted. */
function WithTokens({ text, testId }: { text: string; testId?: string }) {
  const parts = text.split(/(\{\{\w+\}\})/g);
  return (
    <span data-testid={testId}>
      {parts.map((p, i) =>
        /^\{\{\w+\}\}$/.test(p) ? (
          <mark
            key={i}
            className="rounded bg-amber-100 px-1 font-mono text-[0.85em] text-amber-900 dark:bg-amber-900/50 dark:text-amber-100"
            data-testid="patient-emails-unresolved-token"
          >
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </span>
  );
}

function QuestionField({
  q,
  draft,
  setAnswer,
  readOnly,
  error,
  catalog,
}: {
  q: EmailLibraryQuestion;
  draft: Draft;
  setAnswer: (key: string, value: unknown) => void;
  readOnly: boolean;
  error: string | null;
  catalog: EmailLibraryCatalogResponse;
}) {
  const id = `el-q-${q.id}`;
  const value = draft[q.id];
  const label = (
    <label htmlFor={q.type === "text" || q.type === "select" ? id : undefined} className="text-sm font-medium text-foreground">
      {q.label}
    </label>
  );
  const help = q.help ? <p className="text-xs text-muted-foreground">{q.help}</p> : null;
  const err = error ? (
    <p className="text-xs text-red-700 dark:text-red-300" role="alert" data-testid={`patient-emails-error-${q.id}`}>
      {error}
    </p>
  ) : null;

  if (q.type === "yesno") {
    return (
      <div className="flex items-start justify-between gap-3" data-testid={`patient-emails-q-${q.id}`}>
        <div className="space-y-0.5">
          {label}
          {help}
        </div>
        <input
          id={id}
          type="checkbox"
          aria-label={q.label}
          className="mt-1 h-4 w-4 accent-primary"
          checked={value === true}
          disabled={readOnly}
          onChange={(e) => setAnswer(q.id, e.target.checked)}
        />
      </div>
    );
  }

  if (q.type === "select") {
    const fallback = q.options.find((o) => o.value === q.default)?.label;
    return (
      <div className="space-y-1" data-testid={`patient-emails-q-${q.id}`}>
        {label}
        {help}
        <select
          id={id}
          className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground disabled:opacity-70"
          value={typeof value === "string" ? value : ""}
          disabled={readOnly}
          onChange={(e) => setAnswer(q.id, e.target.value === "" ? undefined : e.target.value)}
        >
          <option value="">{fallback ? `Library default (${fallback})` : "Not set"}</option>
          {q.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {err}
      </div>
    );
  }

  if (q.type === "multi" || q.type === "procedures") {
    const options =
      q.type === "procedures" ? catalog.allProcedures.map((p) => ({ value: p.id, label: p.name })) : q.options;
    const picked = Array.isArray(value) ? (value as unknown[]) : [];
    const toggle = (v: string, on: boolean) => {
      const next = on ? [...picked.filter((x) => x !== v), v] : picked.filter((x) => x !== v);
      setAnswer(q.id, next.length > 0 ? next : undefined);
    };
    return (
      <fieldset className="space-y-1" data-testid={`patient-emails-q-${q.id}`}>
        <legend className="text-sm font-medium text-foreground">{q.label}</legend>
        {help}
        <div className={q.type === "procedures" ? "grid grid-cols-1 gap-1 sm:grid-cols-2" : "flex flex-wrap gap-x-4 gap-y-1"}>
          {options.map((o) => (
            <label key={o.value} className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={picked.includes(o.value)}
                disabled={readOnly}
                onChange={(e) => toggle(o.value, e.target.checked)}
                data-testid={`patient-emails-opt-${q.id}-${o.value}`}
              />
              {o.label}
            </label>
          ))}
        </div>
        {err}
      </fieldset>
    );
  }

  const max =
    q.id === "schedule_link" || q.id === "review_link"
      ? EMAIL_LIBRARY_LINK_MAX
      : (EMAIL_LIBRARY_TEXT_MAX as Record<string, number>)[q.id] ?? 8;
  return (
    <div className="space-y-1" data-testid={`patient-emails-q-${q.id}`}>
      {label}
      {help}
      <Input
        id={id}
        value={typeof value === "string" ? value : ""}
        placeholder={q.default ? `Library default: ${q.default}` : q.placeholder}
        maxLength={max}
        disabled={readOnly}
        aria-invalid={error ? true : undefined}
        onChange={(e) => setAnswer(q.id, e.target.value === "" ? undefined : e.target.value)}
      />
      {err}
    </div>
  );
}

function OfficeEmailLibrary({ office }: { office: OfficeId }) {
  const [catalog, setCatalog] = useState<EmailLibraryCatalogResponse | null>(null);
  const [profile, setProfile] = useState<EmailLibraryProfileResponse | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const [procedureId, setProcedureId] = useState<string>("");
  const [stage, setStage] = useState<string>("");
  const [variant, setVariant] = useState<string>("A");
  const [preview, setPreview] = useState<EmailLibraryPreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const previewSeq = useRef(0);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [c, p] = await Promise.all([getEmailLibraryCatalog(office), getEmailLibraryProfile(office)]);
      setCatalog(c);
      setProfile(p);
      setDraft({ ...p.answers });
      setProcedureId((cur) => (cur && c.procedures.some((x) => x.id === cur) ? cur : c.procedures[0]?.id ?? ""));
      setStage((cur) => (cur && c.stages.some((x) => x.id === cur) ? cur : c.stages[0]?.id ?? ""));
    } catch (e) {
      setLoadError(tcErrorMessage(e));
    }
  }, [office]);

  useEffect(() => {
    void load();
  }, [load]);

  const validation = useMemo(() => validateEmailLibraryAnswers(draft), [draft]);
  // Compare normalized to normalized, so list order alone never reads as an edit.
  const savedNormalized = useMemo(() => {
    if (!profile) return null;
    const v = validateEmailLibraryAnswers(profile.answers);
    return v.ok ? v.answers : profile.answers;
  }, [profile]);
  const dirty = savedNormalized !== null && !(validation.ok ? sameJson(validation.answers, savedNormalized) : false);
  const readOnly = !profile?.canEdit;

  // The server composes the preview from what is on screen, debounced.
  useEffect(() => {
    if (!catalog || !profile || !procedureId || !stage) return;
    if (!validation.ok) {
      setPreviewError("Fix the highlighted answer to update the preview.");
      return;
    }
    const seq = ++previewSeq.current;
    const answers: EmailLibraryAnswers | undefined = dirty ? validation.answers : undefined;
    const timer = window.setTimeout(() => {
      setPreviewing(true);
      previewEmailLibrary(office, { procedure_id: procedureId, stage, variant, ...(answers ? { answers } : {}) })
        .then((r) => {
          if (seq !== previewSeq.current) return;
          setPreview(r);
          setPreviewError(null);
        })
        .catch((e: unknown) => {
          if (seq !== previewSeq.current) return;
          setPreview(null);
          setPreviewError(tcErrorMessage(e));
        })
        .finally(() => {
          if (seq === previewSeq.current) setPreviewing(false);
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [catalog, profile, procedureId, stage, variant, office, dirty, validation]);

  const setAnswer = useCallback((key: string, value: unknown) => {
    setSavedAt(null);
    setSaveError(null);
    setDraft((d) => {
      const next = { ...d };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });
  }, []);

  const save = async () => {
    if (!validation.ok) return;
    setSaving(true);
    setSaveError(null);
    try {
      const readBack = await saveEmailLibraryProfile(office, validation.answers);
      setProfile(readBack);
      setDraft({ ...readBack.answers });
      setSavedAt(readBack.updatedAt);
      // The catalog follows the saved services_off and stage rules.
      setCatalog(await getEmailLibraryCatalog(office));
    } catch (e) {
      setSaveError(tcErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  if (loadError) {
    return (
      <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
        <span className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden /> {loadError}
        </span>
        <Button size="sm" variant="outline" onClick={() => void load()}>
          Retry
        </Button>
      </div>
    );
  }
  if (!catalog || !profile) {
    return (
      <div className="flex justify-center py-10 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" aria-label="Loading" />
      </div>
    );
  }

  const sections: Array<{ name: string; questions: EmailLibraryQuestion[] }> = [];
  for (const q of catalog.questions) {
    const s = sections.find((x) => x.name === q.section);
    if (s) s.questions.push(q);
    else sections.push({ name: q.section, questions: [q] });
  }
  const fieldError = (key: string) => (!validation.ok && validation.key === key ? validation.message : null);
  const stageLabel = (id: string) => catalog.stages.find((s) => s.id === id)?.label ?? id;

  return (
    <div className="space-y-5">
    {!catalog.clinicallyApproved && <DraftBanner />}
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      {/* ── Questionnaire ─────────────────────────────────────────────── */}
      <section className="space-y-5" aria-label="Questionnaire" data-testid="patient-emails-questionnaire">
        {readOnly && (
          <p className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground" data-testid="patient-emails-read-only">
            <Lock className="h-4 w-4 shrink-0" aria-hidden /> Only a practice admin can change these answers.
          </p>
        )}
        {profile.missing.length > 0 && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100" data-testid="patient-emails-missing">
            <p className="font-medium">Not set yet, and printed in some emails:</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {profile.missing.map((m) => (
                <li key={m.field} data-testid={`patient-emails-missing-${m.field}`}>
                  <span className="font-mono text-xs">{`{{${m.field}}}`}</span> in {m.stages.length} stage
                  {m.stages.length === 1 ? "" : "s"}: {m.stages.map(stageLabel).join(", ")}
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          <Mail className="mr-1 inline h-3.5 w-3.5" aria-hidden />
          The office name and phone come from Practice info, not from here.
        </p>
        {sections.map((s) => (
          <fieldset key={s.name} className="space-y-3 rounded-xl border border-border p-4" data-testid={`patient-emails-section-${s.name}`}>
            <legend className="px-1 text-sm font-semibold text-foreground">{s.name}</legend>
            {s.questions
              .filter((q) => shown(q, draft))
              .map((q) => (
                <QuestionField
                  key={q.id}
                  q={q}
                  draft={draft}
                  setAnswer={setAnswer}
                  readOnly={readOnly}
                  error={fieldError(q.id)}
                  catalog={catalog}
                />
              ))}
          </fieldset>
        ))}
        {!readOnly && (
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void save()} disabled={!dirty || !validation.ok || saving} className="gap-1.5" data-testid="patient-emails-save">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Save className="h-4 w-4" aria-hidden />}
              Save answers
            </Button>
            {savedAt && !dirty && (
              <span className="flex items-center gap-1 text-sm text-emerald-700 dark:text-emerald-300" data-testid="patient-emails-saved">
                <CheckCircle2 className="h-4 w-4" aria-hidden /> Saved
              </span>
            )}
            {dirty && !saving && <span className="text-sm text-muted-foreground">Unsaved changes</span>}
            {saveError && (
              <span role="alert" className="text-sm text-red-700 dark:text-red-300" data-testid="patient-emails-save-error">
                Not saved: {saveError}
              </span>
            )}
          </div>
        )}
      </section>

      {/* ── Preview ───────────────────────────────────────────────────── */}
      <section className="space-y-3 lg:sticky lg:top-4 lg:self-start" aria-label="Preview" data-testid="patient-emails-preview">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="space-y-1 text-xs text-muted-foreground">
            Procedure
            <select
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
              value={procedureId}
              onChange={(e) => setProcedureId(e.target.value)}
              data-testid="patient-emails-procedure"
            >
              {catalog.procedures.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            Stage
            <select
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
              value={stage}
              onChange={(e) => setStage(e.target.value)}
              data-testid="patient-emails-stage"
            >
              {catalog.stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.phase}: {s.label}
                  {s.inUse ? "" : " (not used by this office)"}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Tone">
          {Object.entries(catalog.variants).map(([k, tone]) => (
            <button
              key={k}
              type="button"
              aria-pressed={variant === k}
              onClick={() => setVariant(k)}
              className={`rounded-md border px-2.5 py-1 text-xs font-medium ${
                variant === k ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-foreground hover:bg-muted"
              }`}
              data-testid={`patient-emails-tone-${k}`}
            >
              {tone}
            </button>
          ))}
        </div>

        <div className="rounded-xl border border-border bg-card" data-testid="patient-emails-preview-card">
          {previewError ? (
            <p className="p-4 text-sm text-amber-800 dark:text-amber-200" role="status" data-testid="patient-emails-preview-error">
              {previewError}
            </p>
          ) : !preview ? (
            <div className="flex justify-center py-10 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" aria-label="Composing preview" />
            </div>
          ) : (
            <div className={`space-y-3 p-4 ${previewing ? "opacity-60" : ""}`}>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{preview.stageLabel}</Badge>
                <Badge variant="outline">{preview.tone}</Badge>
                {preview.answersSource === "unsaved" && (
                  <Badge variant="secondary" data-testid="patient-emails-preview-unsaved">
                    Unsaved answers
                  </Badge>
                )}
                <span className="text-xs text-muted-foreground">{preview.wordCount} words</span>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Subject</p>
                <p className="font-semibold text-foreground">
                  <WithTokens text={preview.subject} testId="patient-emails-subject" />
                </p>
                <p className="text-sm text-muted-foreground">
                  <WithTokens text={preview.preheader} />
                </p>
              </div>
              <div className="whitespace-pre-wrap border-t border-border pt-3 text-sm leading-relaxed text-foreground">
                <WithTokens text={preview.bodyText} testId="patient-emails-body" />
              </div>
              {preview.unresolved.length > 0 && (
                <div className="border-t border-border pt-3 text-xs text-muted-foreground" data-testid="patient-emails-unresolved">
                  <p className="font-medium text-foreground">Shown as a placeholder because it has no value yet:</p>
                  <ul className="mt-1 space-y-0.5">
                    {preview.unresolved.map((f) => (
                      <li key={f}>
                        <span className="font-mono">{`{{${f}}}`}</span> — {MERGE_FIELD_HELP[f] ?? "not set"}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="border-t border-border pt-3 text-xs text-muted-foreground">
                Sample values: the patient is &ldquo;Jordan&rdquo; and appointment details are made up. The postal address and
                unsubscribe link are added when an email is sent.
              </p>
            </div>
          )}
        </div>
      </section>
    </div>
    </div>
  );
}

export default function AdminPatientEmails() {
  const { office, offices, loading, error } = useOffice();
  const inScope = servedOfficeKeys(offices);
  const [chosen, setChosen] = useState<OfficeId | null>(null);
  const [generation, setGeneration] = useState(0);
  const nameOf = (id: string) => offices.find((o) => o.officeId === id)?.officeName ?? id;
  const active: OfficeId | null =
    office === ALL_OFFICES ? (chosen && inScope.includes(chosen) ? chosen : inScope[0] ?? null) : asOfficeKey(office);

  return (
    <div className="mx-auto max-w-7xl space-y-5 p-6" data-testid="admin-patient-emails">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-foreground">
            <Mail className="h-5 w-5 text-muted-foreground" aria-hidden /> Patient emails
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            The wording of the treatment follow-up email library, for each office. Your answers change what the emails
            say. They never change who is contacted or when.
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
        <p className="text-sm text-muted-foreground" data-testid="patient-emails-no-office">
          The email wording is kept per office. Choose an office in the office menu.
        </p>
      ) : (
        <div className="space-y-4" key={generation}>
          {office === ALL_OFFICES && inScope.length > 1 ? (
            <div className="flex flex-wrap items-center gap-2" data-testid="patient-emails-office-choice">
              <span className="text-xs text-muted-foreground">Office:</span>
              {inScope.map((o) => (
                <Button key={o} size="sm" variant={o === active ? "default" : "outline"} onClick={() => setChosen(o)}>
                  {nameOf(o)}
                </Button>
              ))}
            </div>
          ) : null}
          <OfficeEmailLibrary key={active} office={active} />
        </div>
      )}
    </div>
  );
}

/**
 * Shown while the server says the library is not clinically approved (the flag
 * flips only by PR after the doctor's review). This page sends nothing either way.
 */
function DraftBanner() {
  return (
    <div
      role="note"
      className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm font-medium text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
      data-testid="patient-emails-draft-banner"
    >
      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
      Draft wording, pending doctor review. Nothing is sent from this page.
    </div>
  );
}

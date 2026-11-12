/**
 * Settings → Referrals → "Referral templates" — per-office starting wording
 * for two fields (Beau's ruling: both places, per-office wording):
 *
 *  - the message to the specialist (prefills "Notes for the specialist" on a
 *    new or edited referral; it goes into the letter);
 *  - the correspondence note (prefills "Log correspondence").
 *
 * Blank = no prefill. Placeholders come from a CLOSED menu, inserted with the
 * buttons; the same validator the server refuses a save with runs as you type,
 * and the live preview fills them with obviously-sample values. Editing takes
 * the same permission as the referral policies above it (a practice admin);
 * everyone else sees what is in force.
 *
 * Nothing sends from here and nothing reads or writes Open Dental. A shown
 * template is what the server answered after it stored it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { tcErrorMessage } from "@/features/tc/api";
import { getReferralTemplates, saveReferralTemplate } from "@/features/tc/referrals/referralsApi";
import type { OfficeId } from "@shared/tc/contract";
import {
  REFERRAL_TEMPLATE_BODY_MAX,
  REFERRAL_TEMPLATE_KIND_LABELS,
  REFERRAL_TEMPLATE_KINDS,
  REFERRAL_TEMPLATE_PLACEHOLDER_LABELS,
  REFERRAL_TEMPLATE_PLACEHOLDERS,
  REFERRAL_TEMPLATE_SAMPLE_VALUES,
  fillReferralTemplate,
  validateReferralTemplate,
  type ReferralTemplateKind,
  type ReferralTemplateState,
} from "@shared/tc/referralTemplates";

function savedLine(t: ReferralTemplateState | undefined): string | null {
  if (!t || !t.updatedAt) return null;
  const when = new Date(t.updatedAt);
  const date = Number.isNaN(when.getTime()) ? t.updatedAt : when.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `Saved${t.updatedBy ? ` by ${t.updatedBy}` : ""} on ${date}`;
}

function TemplateEditor({
  office,
  kind,
  stored,
  canEdit,
  onSaved,
}: {
  office: OfficeId;
  kind: ReferralTemplateKind;
  stored: ReferralTemplateState | undefined;
  canEdit: boolean;
  onSaved: (t: ReferralTemplateState) => void;
}) {
  const storedBody = stored?.body ?? "";
  const [body, setBody] = useState(storedBody);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  /*
   * Take the stored wording only when it CHANGED (a save's read-back). Not on
   * the first run: useState already holds it, and a mount-time setBody lands
   * AFTER anything typed before the effect flushed — wiping the typed text.
   */
  const seenStored = useRef(storedBody);
  useEffect(() => {
    if (seenStored.current === storedBody) return;
    seenStored.current = storedBody;
    setBody(storedBody);
    setError(null);
  }, [storedBody]);

  const problems = validateReferralTemplate(body);
  const dirty = body !== storedBody;
  const labels = REFERRAL_TEMPLATE_KIND_LABELS[kind];
  const id = `ref-template-${kind}`;

  function insert(name: string) {
    const token = `{${name}}`;
    const el = ref.current;
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? body.length;
    const next = (body.slice(0, start) + token + body.slice(end)).slice(0, REFERRAL_TEMPLATE_BODY_MAX);
    setBody(next);
    setError(null);
    requestAnimationFrame(() => {
      if (!ref.current) return;
      ref.current.focus();
      ref.current.setSelectionRange(start + token.length, start + token.length);
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const saved = await saveReferralTemplate(office, kind, body);
      onSaved(saved);
      toast.success(saved.body === "" ? "Template cleared — no prefill" : "Template saved");
    } catch (e) {
      setError(tcErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2 py-3" data-testid={`tc-ref-template-${kind}`}>
      <div>
        <Label htmlFor={id} className="text-sm font-medium">
          {labels.title}
        </Label>
        <p className="text-xs text-muted-foreground">{labels.help}</p>
      </div>
      <Textarea
        id={id}
        ref={ref}
        rows={4}
        maxLength={REFERRAL_TEMPLATE_BODY_MAX}
        value={body}
        disabled={!canEdit || saving}
        placeholder="Blank: the field starts empty."
        onChange={(e) => {
          setBody(e.target.value);
          setError(null);
        }}
        data-testid={`tc-ref-template-${kind}-input`}
      />
      {canEdit && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">Insert:</span>
          {REFERRAL_TEMPLATE_PLACEHOLDERS.map((p) => (
            <Button
              key={p}
              type="button"
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[11px]"
              disabled={saving}
              onClick={() => insert(p)}
              data-testid={`tc-ref-template-${kind}-insert-${p}`}
            >
              {REFERRAL_TEMPLATE_PLACEHOLDER_LABELS[p]}
            </Button>
          ))}
        </div>
      )}
      {problems.map((p) => (
        <p key={p.code + (p.token ?? "")} className="text-xs text-destructive" role="alert" data-testid={`tc-ref-template-${kind}-problem`}>
          {p.message}
        </p>
      ))}
      <div className="rounded-md border border-border bg-muted/40 p-2">
        <p className="text-[11px] font-medium text-muted-foreground">Preview (sample values)</p>
        <p className="whitespace-pre-wrap text-sm" data-testid={`tc-ref-template-${kind}-preview`}>
          {body.trim() === "" ? <span className="text-muted-foreground">No prefill: the field starts empty.</span> : fillReferralTemplate(body, REFERRAL_TEMPLATE_SAMPLE_VALUES)}
        </p>
      </div>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-muted-foreground">{savedLine(stored) ?? "Not set for this office yet."}</p>
        {canEdit && (
          <Button
            size="sm"
            onClick={() => void save()}
            disabled={saving || !dirty || problems.length > 0}
            data-testid={`tc-ref-template-${kind}-save`}
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" />} Save
          </Button>
        )}
      </div>
    </div>
  );
}

export function ReferralTemplatesCard({ office }: { office: OfficeId }) {
  const [templates, setTemplates] = useState<ReferralTemplateState[] | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    setTemplates(null);
    Promise.resolve()
      .then(() => getReferralTemplates(office))
      .then((res) => {
        setTemplates(res.templates);
        setCanEdit(res.canEdit);
      })
      .catch((e: unknown) => setError(tcErrorMessage(e)));
  }, [office]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Card data-testid="tc-referral-templates">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">Referral templates</CardTitle>
        <p className="text-xs text-muted-foreground">
          Starting wording for this office. Staff can change it before they save or send.
          {templates && !canEdit ? " A practice admin can change them." : ""}
        </p>
      </CardHeader>
      <CardContent className="divide-y divide-border">
        {error ? (
          <div className="flex items-center gap-2 py-4">
            <p className="text-sm text-muted-foreground">{error}</p>
            <Button variant="outline" size="sm" onClick={load}>
              <RefreshCw className="w-4 h-4 mr-1" aria-hidden /> Retry
            </Button>
          </div>
        ) : !templates ? (
          <div className="flex items-center gap-2 py-4 text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
            <span className="text-sm">Loading templates…</span>
          </div>
        ) : (
          REFERRAL_TEMPLATE_KINDS.map((kind) => (
            <TemplateEditor
              key={kind}
              office={office}
              kind={kind}
              stored={templates.find((t) => t.kind === kind)}
              canEdit={canEdit}
              onSaved={(saved) => setTemplates((list) => (list ?? []).map((t) => (t.kind === saved.kind ? saved : t)))}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}

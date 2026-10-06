/**
 * The ortho screening — the hygienist's green sheet, as taps (queue item 33).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * SPEED IS THE DESIGN CONSTRAINT
 * ═════════════════════════════════════════════════════════════════════════════
 * The hygienist fills this while the doctor examines. Every answer is a chip
 * (44px+, the house TAP size) except two short optional text boxes, and the
 * question is written above each group in words — the TreatmentItems pattern.
 * Nothing is required except "Interested?": a screening with only that answered
 * is still sendable, because the TC calls for the rest.
 *
 * Single-pick groups clear on a second tap. "None" under After ortho is
 * exclusive. Both rules are the shared pure helpers in shared/hyg/orthoScreening
 * so they are tested without a screen.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THE TC WILL GET — ONE FUNCTION
 * ═════════════════════════════════════════════════════════════════════════════
 * The line above the button is `orthoScreeningSummary`, the same function the
 * TC case renders and the server puts in the case's `suspectedTreatment`.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * HONEST STATES
 * ═════════════════════════════════════════════════════════════════════════════
 * "Sent to TC" renders from `sent` — the visit's `orthoSend`, which the server
 * writes only after TC answered with a case. A refusal shows here, in words,
 * and the sheet stays editable and saved. Once sent, the chips go read-only:
 * the server freezes the sent sheet, and a chip that looked tappable but did
 * nothing would be a lie of its own.
 */
import { CheckCircle2, Loader2, Send } from "lucide-react";

import {
  emptyOrthoScreening,
  isOrthoSendable,
  ORTHO_AFTER_OPTIONS,
  ORTHO_AFTER_TEETH_MAX,
  ORTHO_ARCH_OPTIONS,
  ORTHO_BENEFIT_OPTIONS,
  ORTHO_CONCERN_OPTIONS,
  ORTHO_CONSULT_OPTIONS,
  ORTHO_DECIDER_OPTIONS,
  ORTHO_INTEREST_OPTIONS,
  ORTHO_LOWER_APPLIANCE_OPTIONS,
  ORTHO_MODALITY_OPTIONS,
  ORTHO_MONTH_OPTIONS,
  ORTHO_MYO_OPTIONS,
  ORTHO_MYO_REASON_OPTIONS,
  ORTHO_NOTE_MAX,
  ORTHO_PHASE_OPTIONS,
  ORTHO_RECORD_OPTIONS,
  ORTHO_UPPER_APPLIANCE_OPTIONS,
  orthoScreeningSummary,
  pickOne,
  toggleAfterOrtho,
  toggleMany,
  type OrthoOption,
  type OrthoScreening as OrthoScreeningValue,
} from "@shared/hyg/orthoScreening";
import type { OrthoSend } from "@shared/hyg/contract";
import { cn } from "@/lib/utils";

const TAP = "min-h-11 min-w-11 rounded-lg border px-3 text-sm font-medium transition-colors";

/** Only what universal tooth numbering uses survives a keystroke. */
const TEETH_KEEP = /[^0-9A-Ta-t#,\s-]/g;

function Chip({
  label,
  active,
  disabled,
  onClick,
  testId,
}: {
  label: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      data-testid={testId}
      className={cn(
        TAP,
        active
          ? "border-primary bg-primary/10 text-foreground"
          : "border-border text-muted-foreground hover:bg-accent/40",
        disabled && "cursor-default opacity-70 hover:bg-transparent",
      )}
    >
      {label}
    </button>
  );
}

/** One question, written above its chips in words. */
function Question({
  label,
  hint,
  testId,
  children,
}: {
  label: string;
  hint?: string;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5" data-testid={testId} role="group" aria-label={label}>
      <div className="text-sm font-medium text-foreground">{label}</div>
      {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-2xl border border-border p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** "9:42 AM" in the office's own reading of the instant. */
function sentClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Chicago",
  });
}

export function OrthoScreening({
  screening,
  sent,
  sending,
  error,
  onChange,
  onSend,
}: {
  /** The draft. `null` until the hygienist taps something. */
  screening: OrthoScreeningValue | null;
  /** The visit's `orthoSend` — set by the server only after TC answered with a case. */
  sent: OrthoSend | null;
  sending: boolean;
  /** Why the last send did not land, in words. */
  error: string | null;
  onChange: (next: OrthoScreeningValue) => void;
  onSend: () => void;
}) {
  const s = screening ?? emptyOrthoScreening();
  const locked = sent !== null || sending;
  const set = (patch: Partial<OrthoScreeningValue>) => onChange({ ...s, ...patch });

  /** A single-pick group over one option list. */
  function one<K extends keyof OrthoScreeningValue>(
    key: K,
    label: string,
    options: readonly OrthoOption[],
    testId: string,
  ) {
    const current = s[key] as string | null;
    return (
      <Question label={label} testId={testId}>
        {options.map((o) => (
          <Chip
            key={o.id}
            label={o.label}
            active={current === o.id}
            disabled={locked}
            onClick={() => set({ [key]: pickOne(current, o.id) } as Partial<OrthoScreeningValue>)}
            testId={`${testId}-${o.id}`}
          />
        ))}
      </Question>
    );
  }

  /** A many-pick group over one option list. */
  function many<K extends keyof OrthoScreeningValue>(
    key: K,
    label: string,
    options: readonly OrthoOption[],
    testId: string,
  ) {
    const current = s[key] as readonly string[];
    const order = options.map((o) => o.id);
    return (
      <Question label={label} testId={testId}>
        {options.map((o) => (
          <Chip
            key={o.id}
            label={o.label}
            active={current.includes(o.id)}
            disabled={locked}
            onClick={() =>
              set({ [key]: toggleMany(current, o.id, order) } as Partial<OrthoScreeningValue>)
            }
            testId={`${testId}-${o.id}`}
          />
        ))}
      </Question>
    );
  }

  const summary = orthoScreeningSummary(s);
  const sendable = isOrthoSendable(screening);

  return (
    <section className="space-y-4" data-testid="hyg-ortho-screening">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Ortho screening
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Tap what applies while the doctor examines. Only &ldquo;Interested?&rdquo; is needed —
          the TC calls for the rest.
        </p>
      </div>

      <Section title="Interest">
        {one("interest", "Interested?", ORTHO_INTEREST_OPTIONS, "ortho-interest")}
        {one("decider", "Who decides?", ORTHO_DECIDER_OPTIONS, "ortho-decider")}
      </Section>

      <Section title="What bothers them">
        {many("concerns", "Concerns", ORTHO_CONCERN_OPTIONS, "ortho-concerns")}
      </Section>

      <Section title="Doctor's call">
        {one("arches", "Which arches?", ORTHO_ARCH_OPTIONS, "ortho-arches")}
        {one("modality", "Aligners or braces?", ORTHO_MODALITY_OPTIONS, "ortho-modality")}
        <Question label="Estimated months" hint="Pick every one the doctor said." testId="ortho-months">
          {ORTHO_MONTH_OPTIONS.map((m) => (
            <Chip
              key={m}
              label={String(m)}
              active={s.months.includes(m)}
              disabled={locked}
              onClick={() => set({ months: toggleMany(s.months, m, ORTHO_MONTH_OPTIONS) })}
              testId={`ortho-months-${m}`}
            />
          ))}
        </Question>
        {one("phase", "Phase (if staged)", ORTHO_PHASE_OPTIONS, "ortho-phase")}
      </Section>

      <Section title="Possible appliances">
        {many("upperAppliances", "Upper", ORTHO_UPPER_APPLIANCE_OPTIONS, "ortho-upper")}
        {many("lowerAppliances", "Lower", ORTHO_LOWER_APPLIANCE_OPTIONS, "ortho-lower")}
      </Section>

      <Section title="Myo">
        {one("myo", "Myo therapy", ORTHO_MYO_OPTIONS, "ortho-myo")}
        {many("myoReasons", "Why", ORTHO_MYO_REASON_OPTIONS, "ortho-myo-why")}
      </Section>

      <Section title="Work after ortho">
        <Question label="After ortho" testId="ortho-after">
          {ORTHO_AFTER_OPTIONS.map((o) => (
            <Chip
              key={o.id}
              label={o.label}
              active={s.afterOrtho.includes(o.id)}
              disabled={locked}
              onClick={() => set({ afterOrtho: toggleAfterOrtho(s.afterOrtho, o.id) })}
              testId={`ortho-after-${o.id}`}
            />
          ))}
        </Question>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-foreground">Which teeth</span>
          <span className="block text-xs text-muted-foreground">
            Optional. Universal numbers, e.g. #7, #10.
          </span>
          <input
            type="text"
            value={s.afterOrthoTeeth}
            maxLength={ORTHO_AFTER_TEETH_MAX}
            disabled={locked}
            onChange={(e) => set({ afterOrthoTeeth: e.target.value.replace(TEETH_KEEP, "") })}
            className="min-h-11 w-full max-w-xs rounded-lg border border-border bg-background px-3 text-sm text-foreground"
            data-testid="ortho-after-teeth"
          />
        </label>
      </Section>

      <Section title="Records today">
        {many("recordsToday", "Taken today", ORTHO_RECORD_OPTIONS, "ortho-records")}
      </Section>

      <Section title="Insurance">
        {one("orthoBenefit", "Ortho benefit", ORTHO_BENEFIT_OPTIONS, "ortho-benefit")}
      </Section>

      <Section title="Next step">
        {one("consult", "Consult", ORTHO_CONSULT_OPTIONS, "ortho-consult")}
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-foreground">Booked for</span>
          <span className="block text-xs text-muted-foreground">Optional.</span>
          <input
            type="date"
            value={s.bookedFor ?? ""}
            disabled={locked}
            onChange={(e) => set({ bookedFor: e.target.value === "" ? null : e.target.value })}
            className="min-h-11 rounded-lg border border-border bg-background px-3 text-sm text-foreground"
            data-testid="ortho-booked-for"
          />
        </label>
      </Section>

      <Section title="Note for the TC">
        <label className="block space-y-1.5">
          <span className="sr-only">Note for the TC</span>
          <textarea
            value={s.noteForTc}
            maxLength={ORTHO_NOTE_MAX}
            disabled={locked}
            rows={3}
            onChange={(e) => set({ noteForTc: e.target.value })}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
            placeholder="Optional"
            data-testid="ortho-note"
          />
          <span className="block text-right text-xs tabular-nums text-muted-foreground">
            {s.noteForTc.length}/{ORTHO_NOTE_MAX}
          </span>
        </label>
      </Section>

      <div
        className="space-y-3 rounded-2xl border border-border bg-muted/30 p-4"
        data-testid="ortho-tc-preview"
      >
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          What the TC will get
        </div>
        <p className="text-sm text-foreground" data-testid="ortho-summary">
          {summary || (
            <span className="italic text-muted-foreground">
              Nothing yet — answer &ldquo;Interested?&rdquo; to send.
            </span>
          )}
        </p>
        {s.noteForTc.trim() ? (
          <p className="text-sm text-muted-foreground">Note: {s.noteForTc.trim()}</p>
        ) : null}

        {error ? (
          <div
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
            data-testid="ortho-send-error"
          >
            {error}
          </div>
        ) : null}

        {sent ? (
          <div
            className="flex min-h-11 items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-400"
            data-testid="ortho-sent"
          >
            <CheckCircle2 size={18} aria-hidden />
            Sent to TC at {sentClock(sent.sentAt)}
          </div>
        ) : (
          <button
            type="button"
            onClick={onSend}
            disabled={!sendable || sending}
            className={cn(
              "inline-flex min-h-11 items-center gap-2 rounded-lg px-4 text-sm font-semibold",
              "bg-primary text-primary-foreground disabled:opacity-50",
            )}
            data-testid="ortho-send"
          >
            {sending ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Send size={16} aria-hidden />}
            {sending ? "Sending to TC…" : "Send to TC"}
          </button>
        )}
      </div>
    </section>
  );
}

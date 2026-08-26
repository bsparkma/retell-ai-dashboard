/**
 * WHERE AM I, AND WHAT IS THE NEXT CLICK.
 *
 * The same seven steps on every remittance-scoped screen — the remittance, the
 * claim, and a posting plan's expanded detail — so a biller who has learned the
 * shape once has learned all three.
 *
 *   Upload → Match → Confirm → Review → Approve → Post → Deposit
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE MARKS MEAN
 * ─────────────────────────────────────────────────────────────────────────────
 *   ✓ done        happened. A statement of fact, never an optimistic label.
 *   ● current     the work in front of you, and the CTA below does it.
 *   ! blocked     red, with the blocking reason underneath in biller words.
 *   ? unknown     this screen cannot see it. Not the same as "no".
 *   ○ todo        a later step.
 *   ⋯ unavailable drawn and not built (Deposit). Never reads as a failure.
 *
 * `unknown` earns its own mark. The claim screen knows a plan exists and cannot
 * see whether it drained; drawing that as `todo` would be the screen asserting
 * "not posted" about something it never asked. That is the same failure the four
 * honest match states exist to prevent one level down.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE CTA, COMPUTED, NEVER TWO
 * ─────────────────────────────────────────────────────────────────────────────
 * `features/rcm/flow.ts` picks it: the first step that is current or blocked. A
 * blocked step still renders the button, disabled, with the reason beside it —
 * a greyed control with no explanation is §15.2's fourth finding and the thing
 * `DisabledReason` exists to make impossible.
 *
 * A CTA whose work lives on another screen is a LINK; one this page owns fires
 * `onAction`. A page that does not handle a verb passes no handler and the
 * stepper falls back to the link, so the button is never dead.
 */
import { Link } from "wouter";
import { AlertTriangle, ArrowRight, Check, CircleDashed, CircleHelp, Clock } from "lucide-react";
import type { RcmAction, RcmFlow, StepState, StepView } from "@/features/rcm/flow";
import DisabledReason from "@/components/rcm/DisabledReason";

const TONE: Record<StepState, { dot: string; text: string }> = {
  done: {
    dot: "border-emerald-500 bg-emerald-500 text-white dark:border-emerald-500 dark:bg-emerald-500",
    text: "text-foreground",
  },
  current: {
    dot: "border-foreground bg-foreground text-background",
    text: "text-foreground font-semibold",
  },
  blocked: {
    dot: "border-rose-500 bg-rose-500 text-white",
    text: "text-rose-700 dark:text-rose-400 font-semibold",
  },
  unknown: {
    dot: "border-border bg-muted text-muted-foreground",
    text: "text-muted-foreground",
  },
  todo: {
    dot: "border-border bg-background text-muted-foreground",
    text: "text-muted-foreground",
  },
  unavailable: {
    dot: "border-dashed border-border bg-background text-muted-foreground/60",
    text: "text-muted-foreground/60",
  },
};

function Mark({ state }: { state: StepState }) {
  switch (state) {
    case "done":
      return <Check size={12} strokeWidth={3} />;
    case "blocked":
      return <AlertTriangle size={11} strokeWidth={2.5} />;
    case "unknown":
      return <CircleHelp size={11} strokeWidth={2.5} />;
    case "unavailable":
      return <Clock size={11} strokeWidth={2.5} />;
    case "current":
      return <CircleDashed size={11} strokeWidth={3} />;
    default:
      return <span className="block h-1.5 w-1.5 rounded-full bg-current" />;
  }
}

export default function RcmStepper({
  flow,
  onAction,
  /** Which step this screen IS, so the stepper can mark "you are here". */
  here,
  testId = "rcm-stepper",
}: {
  flow: RcmFlow;
  /**
   * Verbs this page owns. A CTA whose action is absent from this map renders as
   * a link to where the step lives instead — never as a button that does
   * nothing.
   */
  onAction?: Partial<Record<RcmAction, () => void>>;
  here?: StepView["step"];
  testId?: string;
}) {
  return (
    <section
      className="mt-4 rounded-xl border border-border bg-card p-4"
      data-testid={testId}
      aria-label="Where this remittance is"
    >
      <ol className="flex flex-wrap items-start gap-x-1 gap-y-3">
        {flow.steps.map((step, i) => (
          <Step
            key={step.step}
            step={step}
            last={i === flow.steps.length - 1}
            isHere={here === step.step}
          />
        ))}
      </ol>

      {/* The blocking reasons and the live step's own line, under the rail
          rather than inside it: a seven-across strip cannot hold a sentence at
          1024px without wrapping into illegibility. */}
      <Notes flow={flow} />

      {flow.cta && <Cta cta={flow.cta} onAction={onAction} />}
    </section>
  );
}

function Step({ step, last, isHere }: { step: StepView; last: boolean; isHere: boolean }) {
  const tone = TONE[step.state];
  const body = (
    <span className="flex items-center gap-1.5">
      <span
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] ${tone.dot}`}
        aria-hidden
      >
        <Mark state={step.state} />
      </span>
      <span className={`whitespace-nowrap text-xs ${tone.text}`}>{step.title}</span>
    </span>
  );

  // A DONE step is navigable — that is how a biller gets back to where a
  // decision was made. A todo one is not: sending somebody to a screen that
  // cannot yet do anything is the navigation problem, not a fix for it.
  const linkable = step.href !== null && (step.state === "done" || step.state === "blocked") && !isHere;

  return (
    <li className="flex items-center gap-1" data-testid={`step-${step.step}`} data-state={step.state}>
      {linkable ? (
        <Link
          href={step.href as string}
          className="rounded px-1 py-0.5 underline-offset-4 transition-colors hover:bg-muted hover:underline"
          data-testid={`step-link-${step.step}`}
          title={step.detail ?? undefined}
        >
          {body}
        </Link>
      ) : (
        <span className="px-1 py-0.5" title={step.detail ?? undefined}>
          {body}
        </span>
      )}
      {!last && <span className="text-muted-foreground/40" aria-hidden>›</span>}
    </li>
  );
}

/**
 * What the live step and every blocked step have to say.
 *
 * Blocked steps are always shown, in order. The current step is shown too, so
 * the page never leaves "where am I" to be inferred from a filled dot alone.
 */
function Notes({ flow }: { flow: RcmFlow }) {
  const notable = flow.steps.filter(
    (s) => (s.state === "blocked" || s.state === "current" || s.state === "unknown") && s.detail,
  );
  if (notable.length === 0) return null;

  return (
    <ul className="mt-3 space-y-1 border-t border-border pt-3 text-xs">
      {notable.map((s) => (
        <li
          key={s.step}
          className="flex items-start gap-1.5"
          data-testid={`step-note-${s.step}`}
        >
          <span
            className={`mt-0.5 shrink-0 font-semibold ${
              s.state === "blocked" ? "text-rose-700 dark:text-rose-400" : "text-foreground"
            }`}
          >
            {s.title}
          </span>
          <span
            className={
              s.state === "blocked" ? "text-rose-700 dark:text-rose-400" : "text-muted-foreground"
            }
          >
            {s.detail}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Cta({
  cta,
  onAction,
}: {
  cta: NonNullable<RcmFlow["cta"]>;
  onAction?: Partial<Record<RcmAction, () => void>>;
}) {
  const handler = cta.action ? onAction?.[cta.action] : undefined;
  const solid =
    "inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-sm font-semibold text-background transition-opacity hover:opacity-90";
  const dead =
    "inline-flex cursor-not-allowed items-center gap-1.5 rounded-md bg-muted px-3 py-1.5 text-sm font-semibold text-muted-foreground";

  return (
    <div className="mt-3 flex flex-col items-start gap-1 border-t border-border pt-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Next
      </div>

      {cta.disabled ? (
        <>
          <button type="button" disabled className={dead} data-testid="rcm-cta">
            {cta.label}
          </button>
          {/* ALWAYS. `flow.ts` guarantees a blocked CTA carries its reason, and
              this is where a biller reads it. */}
          <DisabledReason tone="warn" testId="rcm-cta-reason">
            {cta.reason ?? "This step cannot be done yet."}
          </DisabledReason>
        </>
      ) : handler ? (
        <button type="button" onClick={handler} className={solid} data-testid="rcm-cta">
          {cta.label}
          <ArrowRight size={14} />
        </button>
      ) : cta.href ? (
        <Link href={cta.href} className={solid} data-testid="rcm-cta">
          {cta.label}
          <ArrowRight size={14} />
        </Link>
      ) : (
        // A verb this page does not own and nowhere to send anybody. Rendered
        // as a disabled control with a reason rather than as nothing, so the
        // stepper never quietly drops the next step.
        <>
          <button type="button" disabled className={dead} data-testid="rcm-cta">
            {cta.label}
          </button>
          <DisabledReason testId="rcm-cta-reason">
            {cta.note ?? "This step is done on another screen."}
          </DisabledReason>
        </>
      )}

      {!cta.disabled && cta.note && (
        <span className="text-xs text-muted-foreground" data-testid="rcm-cta-note">
          {cta.note}
        </span>
      )}
    </div>
  );
}

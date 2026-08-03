/**
 * Presentation-mode slides (Slice 4) — the patient-facing deck.
 *
 * Everything here is shown to a PATIENT on a chairside screen, so the rules
 * differ from the rest of the module: big type, warm plain language,
 * patientDescription over clinical names, no statuses/urgency/internal
 * jargon, and money appears ONLY on the Investment slide.
 *
 * Honesty-debt fix vs legacy: the pay-in-full card shows the ACTUAL
 * discounted figure from server config (cashDiscountCents), and no cash line
 * renders at all when the office hasn't enabled the discount. No insurance
 * snapshot slide — the legacy OD pull is omitted entirely.
 */
import { CalendarCheck, CheckCircle2, Clock, Heart, MessageCircleQuestion, Shield, Smile, Star } from "lucide-react";
import type { OfficeId, TcCase, TcCaseItem, TcCasePhase, TcGalleryCase } from "@shared/tc/contract";
import { formatCents } from "../money";
import type { CashDiscountCents, MonthlyOptionCents } from "../lib/financing";
import { TcMediaPair } from "../gallery/GalleryGrid";

// ── Derivations ─────────────────────────────────────────────────────────────

/**
 * The case total the patient is asked to invest: the sum of per-item
 * patientPortionCents when itemized, else the case-level caseValueCents.
 */
export function casePatientPortionCents(c: TcCase): number {
  const itemized = c.phases.reduce(
    (sum, p) => sum + p.items.reduce((s, i) => s + i.patientPortionCents, 0),
    0,
  );
  return itemized > 0 ? itemized : c.caseValueCents;
}

/**
 * The 2–4 monthly options worth showing a patient: eligible only, promo terms
 * first, then cheapest monthly payment.
 */
export function pickPresentationOptions(options: MonthlyOptionCents[]): MonthlyOptionCents[] {
  return options
    .filter((o) => o.eligible && o.monthlyCents > 0)
    .sort((a, b) => {
      if (a.isPromo !== b.isPromo) return a.isPromo ? -1 : 1;
      return a.monthlyCents - b.monthlyCents;
    })
    .slice(0, 4);
}

/** Patient-facing display text for an item: patientDescription over the clinical name. */
function itemPatientText(item: TcCaseItem): string {
  const desc = item.patientDescription.trim();
  return desc || item.procedureName;
}

// ── Shared shell ────────────────────────────────────────────────────────────

export function SlideHeading({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="text-center">
      <h1
        className="text-3xl sm:text-4xl font-bold text-foreground mb-3"
        style={{ fontFamily: "Outfit, sans-serif" }}
      >
        {title}
      </h1>
      {subtitle && <p className="text-lg sm:text-xl text-muted-foreground">{subtitle}</p>}
    </div>
  );
}

// ── (a) Welcome ─────────────────────────────────────────────────────────────

export function WelcomeSlide({
  patientName,
  practiceName,
  doctorName,
}: {
  patientName: string;
  practiceName: string;
  doctorName: string;
}) {
  const firstName = patientName.trim().split(/\s+/)[0] ?? patientName;
  const initials = patientName
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((n) => n[0] ?? "")
    .join("")
    .toUpperCase();
  return (
    <div className="w-full max-w-2xl mx-auto text-center space-y-8">
      <div className="w-24 h-24 rounded-full mx-auto flex items-center justify-center bg-primary text-primary-foreground text-3xl font-bold">
        {initials || <Smile className="w-10 h-10" />}
      </div>
      <SlideHeading
        title={`Welcome, ${firstName}`}
        subtitle={`We're so glad you're here at ${practiceName}.`}
      />
      <div className="rounded-2xl bg-primary/10 p-6 sm:p-8 text-left">
        <p className="text-base sm:text-lg leading-relaxed text-foreground">
          Today we'll walk through everything
          {doctorName ? ` ${doctorName}` : " your doctor"} found, what it means
          for your health, and the options available to you — clearly and at
          your pace. There's no pressure here, just answers.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-6 text-sm sm:text-base text-muted-foreground">
        <span className="flex items-center gap-2">
          <Shield className="w-5 h-5 text-emerald-500" /> No pressure
        </span>
        <span className="flex items-center gap-2">
          <Heart className="w-5 h-5 text-rose-500" /> Your health first
        </span>
        <span className="flex items-center gap-2">
          <Star className="w-5 h-5 text-amber-500" /> Clear options
        </span>
      </div>
    </div>
  );
}

// ── (b) Treatment plan overview ─────────────────────────────────────────────

export function PlanOverviewSlide({ tcCase }: { tcCase: TcCase }) {
  const phases = tcCase.phases;
  return (
    <div className="w-full max-w-3xl mx-auto space-y-8">
      <SlideHeading
        title="Your treatment plan"
        subtitle={
          phases.length > 1
            ? `We've organized everything into ${phases.length} clear, comfortable steps.`
            : "We've organized everything into one clear, comfortable plan."
        }
      />
      {phases.length === 0 ? (
        <p className="text-center text-lg text-muted-foreground">
          We'll walk through your plan together today.
        </p>
      ) : (
        <div className="space-y-4">
          {phases.map((phase, idx) => (
            <div
              key={phase.phaseId}
              className="rounded-2xl border border-border bg-card p-5 sm:p-6"
            >
              <div className="flex items-center gap-4 mb-3">
                <div className="w-10 h-10 rounded-full flex items-center justify-center text-base font-bold bg-primary text-primary-foreground flex-shrink-0">
                  {idx + 1}
                </div>
                <div>
                  <div
                    className="text-lg font-semibold text-foreground"
                    style={{ fontFamily: "Outfit, sans-serif" }}
                  >
                    {phase.name}
                  </div>
                  {phase.description && (
                    <p className="text-sm text-muted-foreground mt-0.5">{phase.description}</p>
                  )}
                </div>
              </div>
              {phase.items.length > 0 && (
                <ul className="space-y-2 pl-2">
                  {phase.items.map((item) => (
                    <li key={item.itemId} className="flex items-start gap-2.5">
                      <CheckCircle2 className="w-4 h-4 text-emerald-500 mt-1 flex-shrink-0" />
                      <span className="text-base text-foreground leading-relaxed line-clamp-2">
                        {itemPatientText(item)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── (c) Per-phase detail ────────────────────────────────────────────────────

export function PhaseDetailSlide({
  phase,
  index,
  total,
}: {
  phase: TcCasePhase;
  index: number;
  total: number;
}) {
  return (
    <div className="w-full max-w-3xl mx-auto space-y-8">
      <SlideHeading
        title={phase.name}
        subtitle={
          phase.description ||
          (total > 1 ? `Step ${index + 1} of ${total} in your plan.` : undefined)
        }
      />
      <div className="space-y-5">
        {phase.items.map((item) => (
          <div key={item.itemId} className="rounded-2xl border border-border bg-card overflow-hidden">
            <div className="p-5 sm:p-6 space-y-4">
              <div className="flex items-start gap-3">
                {item.tooth && (
                  <span className="rounded-lg bg-primary/10 px-2.5 py-1 text-sm font-semibold text-primary flex-shrink-0">
                    {item.tooth}
                  </span>
                )}
                <p className="text-base sm:text-lg text-foreground leading-relaxed">
                  {itemPatientText(item)}
                </p>
              </div>

              {(item.benefits.length > 0 || item.risksOfDelay.length > 0) && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {item.benefits.length > 0 && (
                    <div>
                      <div className="text-sm font-semibold text-emerald-600 dark:text-emerald-400 mb-2">
                        How this helps you
                      </div>
                      <ul className="space-y-1.5">
                        {item.benefits.slice(0, 4).map((b, i) => (
                          <li key={i} className="flex items-start gap-2 text-sm text-foreground">
                            <CheckCircle2 className="w-4 h-4 text-emerald-500 mt-0.5 flex-shrink-0" />
                            <span className="leading-relaxed">{b}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {item.risksOfDelay.length > 0 && (
                    <div>
                      <div className="text-sm font-semibold text-amber-600 dark:text-amber-400 mb-2">
                        If we wait
                      </div>
                      <ul className="space-y-1.5">
                        {item.risksOfDelay.slice(0, 4).map((r, i) => (
                          <li key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
                            <span className="mt-0.5 flex-shrink-0">•</span>
                            <span className="leading-relaxed">{r}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {item.expectedOutcome && (
                <div className="rounded-xl bg-primary/10 p-4">
                  <div className="text-sm font-semibold text-primary mb-1">What you can expect</div>
                  <p className="text-sm sm:text-base text-foreground leading-relaxed">
                    {item.expectedOutcome}
                  </p>
                </div>
              )}
            </div>
            {item.timeEstimate && (
              <div className="px-5 sm:px-6 py-3 border-t border-border bg-muted/40 flex items-center gap-2 text-sm text-muted-foreground">
                <Clock className="w-4 h-4" /> {item.timeEstimate}
              </div>
            )}
          </div>
        ))}
        {phase.items.length === 0 && (
          <p className="text-center text-lg text-muted-foreground">
            We'll go over this step together.
          </p>
        )}
      </div>
    </div>
  );
}

// ── (d) Investment ──────────────────────────────────────────────────────────

export function InvestmentSlide({
  totalCents,
  options,
  cash,
}: {
  totalCents: number;
  /** Pre-picked via pickPresentationOptions — 0 to 4 entries. */
  options: MonthlyOptionCents[];
  cash: CashDiscountCents;
}) {
  return (
    <div className="w-full max-w-3xl mx-auto space-y-8">
      <SlideHeading
        title="Your investment"
        subtitle="Let's find the option that feels most comfortable for you."
      />
      <div className="text-center">
        <div className="text-sm sm:text-base text-muted-foreground mb-1">Total for your plan</div>
        <div
          className="text-5xl font-bold text-primary"
          style={{ fontFamily: "Outfit, sans-serif" }}
        >
          {formatCents(totalCents)}
        </div>
      </div>

      {options.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {options.map((opt, i) => (
            <div
              key={`${opt.providerKey}-${opt.months}-${opt.isPromo ? "p" : "r"}`}
              className={`rounded-2xl border-2 p-5 sm:p-6 text-center ${
                i === 0 ? "border-primary bg-primary/5" : "border-border bg-card"
              }`}
            >
              {opt.isPromo && (
                <div className="inline-block rounded-full bg-primary px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-primary-foreground mb-2">
                  Special terms
                </div>
              )}
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                {opt.providerLabel}
              </div>
              <div
                className="text-4xl font-bold text-foreground"
                style={{ fontFamily: "Outfit, sans-serif" }}
              >
                {formatCents(opt.monthlyCents)}
                <span className="text-base font-normal text-muted-foreground">/mo</span>
              </div>
              <div className="mt-2 text-sm text-muted-foreground">
                {opt.months} months · {opt.apr === 0 ? "0% interest" : `${opt.apr}% APR`}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Cash line renders ONLY when the office enabled the discount, and it
          shows the ACTUAL discounted figure — never an undiscounted number
          with a "% discount available" caption. */}
      {cash.enabled && (
        <div className="rounded-2xl border-2 border-emerald-500/50 bg-emerald-50 dark:bg-emerald-950/40 p-5 sm:p-6 text-center">
          <div className="text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300 mb-1">
            Pay in full today
          </div>
          <div
            className="text-4xl font-bold text-emerald-700 dark:text-emerald-300"
            style={{ fontFamily: "Outfit, sans-serif" }}
          >
            {formatCents(cash.discountedCents)}
          </div>
          <div className="mt-1 text-sm text-emerald-700/80 dark:text-emerald-300/80">
            One payment · you save {formatCents(cash.savingsCents)}
          </div>
        </div>
      )}

      <p className="text-center text-base text-muted-foreground">
        Which of these feels most comfortable? We can adjust things together.
      </p>
    </div>
  );
}

// ── (e) Before & After ──────────────────────────────────────────────────────

export function BeforeAfterSlide({
  office,
  pairs,
}: {
  office: OfficeId;
  /** Gallery cases whose images preloaded successfully — max 6. */
  pairs: TcGalleryCase[];
}) {
  return (
    <div className="w-full max-w-4xl mx-auto space-y-8">
      <SlideHeading
        title="Real smiles from our practice"
        subtitle="Results from patients who started right where you are."
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {pairs.map((g) => (
          <div key={g.galleryId} className="overflow-hidden rounded-2xl border border-border bg-card">
            <TcMediaPair
              office={office}
              beforeKey={g.beforeBlobKey}
              afterKey={g.afterBlobKey}
              beforeLabel="Before"
              afterLabel="After"
              altBase={g.category || "Smile transformation"}
              heightClass="h-36"
            />
            {g.category && (
              <div className="px-3 py-2 text-sm font-medium text-foreground">{g.category}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── (f) Closing ─────────────────────────────────────────────────────────────

export function ClosingSlide({ practiceName }: { practiceName: string }) {
  return (
    <div className="w-full max-w-2xl mx-auto text-center space-y-8">
      <div className="w-24 h-24 rounded-full mx-auto flex items-center justify-center bg-primary/10">
        <MessageCircleQuestion className="w-12 h-12 text-primary" />
      </div>
      <SlideHeading
        title="What questions do you have?"
        subtitle="This is your plan and your pace — ask us anything."
      />
      <div className="space-y-3 text-left">
        {[
          {
            icon: MessageCircleQuestion,
            label: "Ask anything",
            desc: "No question is too small — we want you to feel completely clear.",
          },
          {
            icon: CalendarCheck,
            label: "When you're ready, we'll schedule",
            desc: "We'll find times that work around your life.",
          },
          {
            icon: Heart,
            label: "We're with you the whole way",
            desc: `The whole team at ${practiceName} is here to help.`,
          },
        ].map((s) => (
          <div
            key={s.label}
            className="flex items-start gap-4 rounded-2xl border border-border bg-card p-5"
          >
            <s.icon className="w-6 h-6 text-primary mt-0.5 flex-shrink-0" />
            <div>
              <div className="text-base font-semibold text-foreground">{s.label}</div>
              <div className="text-sm text-muted-foreground mt-0.5">{s.desc}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

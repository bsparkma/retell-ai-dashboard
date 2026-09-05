/**
 * The routing slip — the paper form, as a screen.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * "RECARE SCHEDULED" AND "TX ENTERED IN OD" ARE ORDINARY FIELDS
 * ═════════════════════════════════════════════════════════════════════════════
 * The prototype's Finish tab disabled "Send all to Open Dental" until both were
 * answered, and drew them in destructive red when they were not. Beau's ruling,
 * verbatim: *"the hygienist should be able to send the treatment to the tc
 * app."*
 *
 * Both describe work the FRONT DESK does after the hygienist has finished, so
 * gating on them makes her wait on somebody else's task with a patient in the
 * chair. Here they carry an unobtrusive reminder when unanswered — the same
 * muted tone as everything else on the form, not an alarm — and they disable
 * nothing anywhere in this module.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT IS DELIBERATELY NOT ON THIS FORM
 * ═════════════════════════════════════════════════════════════════════════════
 * The prototype's router carries about sixty fields across pre-visit checks,
 * records-taken-today, an admin block and a full ortho workup. This is the
 * subset a hygienist fills AT THE CHAIR about THIS visit. The pre-visit checks
 * (insurance verified, balance to collect) belong to the front desk; the ortho
 * workup is its own arc; perio charting is H4 and carries its own contingency.
 * Adding them here would be adding fields nobody is standing in front of.
 */
import {
  DONE_TODAY_OPTIONS,
  EXAM_STATUS_LABELS,
  ExamStatusSchema,
  PERIO_STAGE_LABELS,
  PerioGradeSchema,
  PerioStageSchema,
  RECORD_STATUS_LABELS,
  RecordStatusSchema,
  XRAY_OPTIONS,
  YesNoSchema,
  type ExamStatus,
  type HygSlip,
  type PerioGrade,
  type PerioStage,
  type RecordStatus,
  type YesNo,
} from "@shared/hyg/contract";
import { cn } from "@/lib/utils";

const TAP = "min-h-11 rounded-lg border px-3 text-sm font-medium transition-colors";

function Chip({
  label,
  active,
  onClick,
  testId,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      data-testid={testId}
      className={cn(
        TAP,
        active
          ? "border-primary bg-primary/10 text-foreground"
          : "border-border text-muted-foreground hover:bg-accent/40",
      )}
    >
      {label}
    </button>
  );
}

function Row({
  label,
  hint,
  children,
  testId,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <div className="space-y-1.5" data-testid={testId}>
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

/** One of the two front-desk questions. A reminder, never a gate. */
function FrontDeskAnswer({
  label,
  value,
  onChange,
  testId,
}: {
  label: string;
  value: YesNo | null;
  onChange: (v: YesNo) => void;
  testId: string;
}) {
  return (
    <div className="space-y-1.5" data-testid={testId}>
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {YesNoSchema.options.map((v: YesNo) => (
          <Chip
            key={v}
            label={v === "yes" ? "Yes" : "No"}
            active={value === v}
            onClick={() => onChange(v)}
            testId={`${testId}-${v}`}
          />
        ))}
        {value === null ? (
          // MUTED, not red. It is a note that the front desk still has this to
          // do — it stops nothing, here or anywhere else in this module.
          <span className="text-xs text-muted-foreground" data-testid={`${testId}-reminder`}>
            Not answered yet — the front desk usually fills this in. It does not stop you
            sending anything.
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function RouterSlip({
  slip,
  recordsNeeded,
  onChange,
}: {
  slip: HygSlip;
  recordsNeeded: string[];
  onChange: (next: HygSlip) => void;
}) {
  const set = <K extends keyof HygSlip>(key: K, value: HygSlip[K]) =>
    onChange({ ...slip, [key]: value });

  const toggle = (key: "doneToday" | "xrayTypes" | "productsDispensed", value: string) => {
    const current = slip[key];
    set(key, current.includes(value) ? current.filter((v) => v !== value) : [...current, value]);
  };

  return (
    <section className="space-y-4" data-testid="hyg-router-slip">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        The routing slip
      </h2>

      <Row label="Done today" testId="hyg-slip-done-today">
        {DONE_TODAY_OPTIONS.map((option) => (
          <Chip
            key={option.id}
            label={option.label}
            active={slip.doneToday.includes(option.id)}
            onClick={() => toggle("doneToday", option.id)}
            testId={`hyg-slip-done-${option.id}`}
          />
        ))}
      </Row>

      <Row label="X-rays taken">
        {XRAY_OPTIONS.map((x) => (
          <Chip
            key={x}
            label={x}
            active={slip.xrayTypes.includes(x)}
            onClick={() => toggle("xrayTypes", x)}
          />
        ))}
      </Row>

      <Row label="Doctor exam">
        {ExamStatusSchema.options.map((e: ExamStatus) => (
          <Chip
            key={e}
            label={EXAM_STATUS_LABELS[e]}
            active={slip.examStatus === e}
            onClick={() => set("examStatus", slip.examStatus === e ? null : e)}
          />
        ))}
      </Row>

      <Row label="Perio classification" hint="Stage, and grade if you have one.">
        {PerioStageSchema.options.map((st: PerioStage) => (
          <Chip
            key={st}
            label={PERIO_STAGE_LABELS[st]}
            active={slip.perioStage === st}
            onClick={() => set("perioStage", slip.perioStage === st ? null : st)}
          />
        ))}
        <span className="mx-1 w-px self-stretch bg-border" aria-hidden />
        {PerioGradeSchema.options.map((g: PerioGrade) => (
          <Chip
            key={g}
            label={`Grade ${g.toUpperCase()}`}
            active={slip.perioGrade === g}
            onClick={() => set("perioGrade", slip.perioGrade === g ? null : g)}
          />
        ))}
      </Row>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Patient concerns
          </span>
          <textarea
            className="min-h-[72px] w-full rounded-lg border border-border bg-background p-2 text-sm"
            defaultValue={slip.patientConcerns}
            onBlur={(e) => set("patientConcerns", e.target.value)}
            data-testid="hyg-slip-concerns"
          />
        </label>
        <label className="space-y-1.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Hygiene findings
          </span>
          <textarea
            className="min-h-[72px] w-full rounded-lg border border-border bg-background p-2 text-sm"
            defaultValue={slip.hygieneFindings}
            onBlur={(e) => set("hygieneFindings", e.target.value)}
            data-testid="hyg-slip-findings"
          />
        </label>
      </div>

      <Row label="Next hygiene visit">
        {["3", "4", "6", "12"].map((months) => (
          <Chip
            key={months}
            label={`${months} mo`}
            active={slip.nextVisit.intervalMonths === Number(months)}
            onClick={() =>
              set("nextVisit", {
                ...slip.nextVisit,
                intervalMonths:
                  slip.nextVisit.intervalMonths === Number(months) ? null : Number(months),
              })
            }
            testId={`hyg-slip-interval-${months}`}
          />
        ))}
        <span className="mx-1 w-px self-stretch bg-border" aria-hidden />
        {["30", "45", "60", "90"].map((mins) => (
          <Chip
            key={mins}
            label={`${mins} min`}
            active={slip.nextVisit.lengthMin === Number(mins)}
            onClick={() =>
              set("nextVisit", {
                ...slip.nextVisit,
                lengthMin: slip.nextVisit.lengthMin === Number(mins) ? null : Number(mins),
              })
            }
          />
        ))}
        <Chip
          label="With the doctor"
          active={slip.nextVisit.withDoctor}
          onClick={() =>
            set("nextVisit", { ...slip.nextVisit, withDoctor: !slip.nextVisit.withDoctor })
          }
        />
      </Row>

      {recordsNeeded.length > 0 ? (
        <div className="space-y-1.5" data-testid="hyg-slip-records">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Records the planned treatment needs
          </div>
          {/* A PROMPT, not a gate. RECORDS_MATRIX is the office's own standard
              and nothing in this module refuses a send because of it. */}
          <div className="text-xs text-muted-foreground">
            Nothing here stops you sending. It is the list that stops a case stalling later.
          </div>
          <div className="space-y-1.5">
            {recordsNeeded.map((record) => (
              <div key={record} className="flex flex-wrap items-center gap-1.5">
                <span className="w-48 shrink-0 text-sm text-foreground">{record}</span>
                {RecordStatusSchema.options.map((st: RecordStatus) => (
                  <Chip
                    key={st}
                    label={RECORD_STATUS_LABELS[st]}
                    active={slip.recordsStatus[record] === st}
                    onClick={() =>
                      set("recordsStatus", { ...slip.recordsStatus, [record]: st })
                    }
                    testId={`hyg-slip-record-${record}-${st}`}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <FrontDeskAnswer
          label="Recare scheduled?"
          value={slip.recareScheduled}
          onChange={(v) => set("recareScheduled", v)}
          testId="hyg-slip-recare"
        />
        <FrontDeskAnswer
          label="Treatment entered in Open Dental?"
          value={slip.txEnteredInOd}
          onChange={(v) => set("txEnteredInOd", v)}
          testId="hyg-slip-tx-entered"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            For the front desk
          </span>
          <textarea
            className="min-h-[60px] w-full rounded-lg border border-border bg-background p-2 text-sm"
            defaultValue={slip.frontDeskNote}
            onBlur={(e) => set("frontDeskNote", e.target.value)}
            data-testid="hyg-slip-front-desk"
          />
        </label>
        <label className="space-y-1.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Financial
          </span>
          <textarea
            className="min-h-[60px] w-full rounded-lg border border-border bg-background p-2 text-sm"
            defaultValue={slip.financialNote}
            onBlur={(e) => set("financialNote", e.target.value)}
            data-testid="hyg-slip-financial"
          />
        </label>
      </div>
    </section>
  );
}

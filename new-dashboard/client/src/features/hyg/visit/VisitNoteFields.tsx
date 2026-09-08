/**
 * The clinic note, as a form — the practice's auto note with its pick-lists.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE ROWS ARE GENERATED FROM THE TEMPLATE THE NOTE PRINTS
 * ═════════════════════════════════════════════════════════════════════════════
 * `controlsFor(visitType)` walks the same template `renderVisitNote` walks, in
 * the same order. Nothing here holds a hand-written list of rows, because a
 * hand-written list is one a template change leaves behind — and the shape of
 * that bug is a chip a hygienist fills in that no note ever prints.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * EVERY ROW HAS A SUFFIX, AND THAT IS THE POINT
 * ═════════════════════════════════════════════════════════════════════════════
 * Their real notes do not say "Calculus: Slight". They say *"Calculus:
 * Slight-mod Lower ant and U post"* — a grade and WHERE. A form that only took
 * the grade would be a form that made every note worse than the one it replaced,
 * so the free-text box beside each row is not an extra: it is half the content.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * A SUGGESTED VISIT TYPE SAYS THAT IT IS ONE
 * ═════════════════════════════════════════════════════════════════════════════
 * When the appointment type maps cleanly the row comes up pre-picked, and the
 * line under it names where that came from. One tap changes it. When it does
 * not map, nothing is picked and the row says so — a wrong template is a wrong
 * chart note, so an ambiguous label is a question rather than a guess.
 *
 * The doctor list is a PROP. It arrives from the server, per office, from
 * `backend/config/hygStaff.js`; a name compiled into this file is a name that
 * eventually renders for the wrong practice.
 */
import {
  controlLabel,
  controlsFor,
  emptyNoteField,
  hasPerioChartLine,
  NOTE_CONTROLS,
  VISIT_TYPE_LABELS,
  VISIT_TYPES,
  type NoteControlId,
  type NoteField,
  type VisitType,
} from "@shared/hyg/noteTemplates";
import { YesNoSchema, type HygSlip, type YesNo } from "@shared/hyg/contract";
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

/**
 * One graded row: the picks, then where.
 *
 * A single-answer row toggles (tapping the active chip clears it, because an
 * answer given by accident must be removable — an unanswered row is a legible
 * state and a wrong one is not). A multi-answer row adds and removes.
 */
function GradeRow({
  id,
  label,
  options,
  multi,
  value,
  onChange,
}: {
  id: NoteControlId;
  label: string;
  options: readonly string[];
  multi: boolean;
  value: NoteField;
  onChange: (next: NoteField) => void;
}) {
  const toggle = (option: string) => {
    const picked = value.grades.includes(option);
    if (multi) {
      onChange({
        ...value,
        grades: picked
          ? value.grades.filter((g) => g !== option)
          : // Kept in the template's own order, so `RD, XD` never comes out
            // `XD, RD` because of the order she happened to tap them.
            options.filter((o) => o === option || value.grades.includes(o)).map((o) => o),
      });
      return;
    }
    onChange({ ...value, grades: picked ? [] : [option] });
  };

  return (
    <div className="space-y-1.5" data-testid={`hyg-note-row-${id}`}>
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {options.map((option) => (
          <Chip
            key={option}
            label={option}
            active={value.grades.includes(option)}
            onClick={() => toggle(option)}
            testId={`hyg-note-${id}-${option.replace(/\s+/g, "-").toLowerCase()}`}
          />
        ))}
        {options.length === 0 ? (
          // Only reachable for the doctor row before an office has answered.
          <span className="text-xs italic text-muted-foreground">
            No doctors are configured for this office.
          </span>
        ) : null}
        <input
          type="text"
          // The half of the line their notes actually carry.
          placeholder="where / detail"
          defaultValue={value.detail}
          onBlur={(e) => onChange({ ...value, detail: e.target.value })}
          data-testid={`hyg-note-${id}-detail`}
          className="min-h-11 min-w-[10rem] flex-1 rounded-lg border border-border bg-background px-3 text-sm"
        />
      </div>
    </div>
  );
}

export function VisitNoteFields({
  slip,
  doctorOptions,
  suggestion,
  onChange,
}: {
  slip: HygSlip;
  /** This office's supervising doctors, from the server. Never a constant. */
  doctorOptions: string[];
  /** What the appointment type mapped to, or null when it did not map. */
  suggestion: VisitType | null;
  onChange: (next: HygSlip) => void;
}) {
  const set = <K extends keyof HygSlip>(key: K, value: HygSlip[K]) =>
    onChange({ ...slip, [key]: value });

  const pickType = (type: VisitType) => {
    // Tapping is always a DECISION, even when it lands on what was suggested:
    // the note then carries a type somebody chose rather than one nothing
    // disagreed with.
    onChange(
      slip.visitType === type
        ? { ...slip, visitType: null, visitTypeSource: null }
        : { ...slip, visitType: type, visitTypeSource: "manual" },
    );
  };

  const setField = (id: NoteControlId, next: NoteField) =>
    set("noteFields", { ...slip.noteFields, [id]: next });

  const visitType = slip.visitType;

  return (
    <section className="space-y-4" data-testid="hyg-note-fields">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        The clinic note
      </h2>

      <div className="space-y-1.5" data-testid="hyg-note-visit-type">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Visit type
        </div>
        <div className="flex flex-wrap gap-1.5">
          {VISIT_TYPES.map((type) => (
            <Chip
              key={type}
              label={VISIT_TYPE_LABELS[type]}
              active={visitType === type}
              onClick={() => pickType(type)}
              testId={`hyg-note-type-${type}`}
            />
          ))}
        </div>
        {visitType === null ? (
          <p className="text-xs text-muted-foreground" data-testid="hyg-note-type-unpicked">
            {suggestion === null
              ? "This appointment’s type did not say which note this is, so nobody has picked one. Until you do, the visit note is a plain summary of what you recorded rather than your usual template."
              : "Pick one and the note CareIN writes reads like your auto note."}
          </p>
        ) : slip.visitTypeSource === "auto" ? (
          <p className="text-xs text-muted-foreground" data-testid="hyg-note-type-auto">
            Chosen from the appointment type. Tap a different one if it is wrong.
          </p>
        ) : null}
      </div>

      {visitType === null ? null : (
        <>
          {controlsFor(visitType).map((id) => (
            <GradeRow
              key={id}
              id={id}
              label={id === "drs" ? "Doctor who examined" : controlLabel(visitType, id)}
              options={id === "drs" ? doctorOptions : NOTE_CONTROLS[id].options}
              multi={NOTE_CONTROLS[id].multi}
              value={slip.noteFields[id] ?? emptyNoteField()}
              onChange={(next) => setField(id, next)}
            />
          ))}

          {hasPerioChartLine(visitType) ? (
            <div className="space-y-1.5" data-testid="hyg-note-perio-chart">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Perio chart updated
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {YesNoSchema.options.map((v: YesNo) => (
                  <Chip
                    key={v}
                    label={v === "yes" ? "Yes" : "No"}
                    active={slip.perioChartUpdated === v}
                    onClick={() =>
                      set("perioChartUpdated", slip.perioChartUpdated === v ? null : v)
                    }
                    testId={`hyg-note-perio-chart-${v}`}
                  />
                ))}
                {slip.perioChartUpdated === null ? (
                  // Their template asserts this flatly. CareIN cannot see a
                  // perio chart, so unanswered stays unanswered on the note too.
                  <span className="text-xs text-muted-foreground">
                    Unanswered prints as a blank on the note, not as “updated”.
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}

          <label className="block space-y-1.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              RTC
            </span>
            <input
              type="text"
              defaultValue={slip.rtc}
              onBlur={(e) => set("rtc", e.target.value)}
              placeholder="6 mo recall"
              data-testid="hyg-note-rtc"
              className="min-h-11 w-full rounded-lg border border-border bg-background px-3 text-sm"
            />
          </label>
        </>
      )}
    </section>
  );
}

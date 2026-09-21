/**
 * Pure helpers behind the hygiene Day View.
 *
 * Everything a component would otherwise do inline lives here so it can be
 * tested without React, a provider tree or a backend. The rules that matter are
 * all about not lying: an unknown flag renders as "unknown" and never as "no",
 * a missing duration renders as nothing and never as a guess, and a chair with
 * no appointments does not become a column that implies it was closed.
 */
import { OFFICE_TIME_ZONE } from "@shared/hyg/contract";
import type { HygAppointment, HygDayResponse, HygOperatory } from "@shared/hyg/contract";

// ─────────────────────────────────────────────────────────────────────────────
// Dates
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Today, as the OFFICE's calendar date — Central, always.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * NEITHER UTC NOR THE DEVICE'S ZONE
 * ═════════════════════════════════════════════════════════════════════════════
 * `toISOString().slice(0,10)` is the obvious version and it is wrong for
 * exactly the hours that matter: it is UTC, so during the Central evening it
 * has already flipped to tomorrow and a hygienist would be handed tomorrow's
 * schedule.
 *
 * Building the string from the DEVICE's local parts fixes that one and opens
 * the mirror of it. "Which day is it?" is a question about the practice, not
 * about whoever is holding the iPad: a device east of Central rolls over
 * early, one west of it rolls over late, and a device whose clock zone is
 * simply wrong is wrong all day. All three look completely normal on screen.
 *
 * So the day is resolved in `OFFICE_TIME_ZONE`. `en-CA` is the locale because
 * it formats as `YYYY-MM-DD` natively, and `Intl` carries the zone database so
 * the boundary follows DST with nobody maintaining an offset table — the same
 * two decisions, for the same two reasons, as `backend/services/localDayClock.js`.
 */
export function todayIso(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: OFFICE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * `date` shifted by whole days.
 *
 * PURE CALENDAR ARITHMETIC, in UTC, on a string that carries no time and no
 * zone. `2026-09-08` plus one day is `2026-09-09` in every zone on earth, so
 * involving a zone here can only introduce a way to get it wrong — which the
 * previous version did: it built a DEVICE-local noon and then formatted that
 * instant in the OFFICE's zone, so on an iPad far enough east or west the
 * stepper would skip or repeat a day.
 *
 * UTC also removes the DST hazard outright rather than papering it with noon:
 * UTC has no transitions, so `+1` is always exactly one calendar day.
 */
export function shiftIsoDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const base = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  base.setUTCDate(base.getUTCDate() + days);
  const yy = base.getUTCFullYear();
  const mm = String(base.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(base.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * Which date the Day View should show once the office day has rolled over.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE BUG THIS CLOSES: A DEVICE THAT IS NEVER CLOSED
 * ═════════════════════════════════════════════════════════════════════════════
 * The page picks its date ONCE, when it mounts. This module is built for an
 * iPad in landscape propped at a chair, and that device is not shut down at
 * night — so a page opened on Monday is still showing MONDAY's schedule on
 * Tuesday morning, under Tuesday's own "Today" button, with every card and
 * every link pointing at the wrong day. Nothing on screen says so.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * IT ONLY MOVES A DATE NOBODY CHOSE
 * ═════════════════════════════════════════════════════════════════════════════
 * A hygienist who stepped to tomorrow to look at it must not have that snatched
 * back at midnight, so the roll is refused unless she is sitting on exactly the
 * day that HAD been today. Moving a date somebody deliberately picked is a
 * worse bug than the one being fixed.
 *
 * Pure, so the rule can be stated without a clock or a DOM event.
 *
 * @param displayed the date currently on screen
 * @param wasToday  what this page last believed "today" was
 * @param isToday   what "today" is now, in the office's zone
 */
export function rollToNewDay(displayed: string, wasToday: string, isToday: string): string {
  if (wasToday === isToday) return displayed;
  if (displayed !== wasToday) return displayed;
  return isToday;
}

/** "Tuesday, 8 September" — the heading a hygienist reads to check she is on the right day. */
export function formatDayHeading(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  return new Date(y, m - 1, d, 12).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

/**
 * The clock time on a card, from Open Dental's `YYYY-MM-DD HH:mm:ss`.
 *
 * That string is Open Dental LOCAL time — the office's own clock — and is
 * deliberately not parsed into a Date. `new Date("2026-09-08 08:00:00")` is
 * interpreted in the BROWSER's zone, so an iPad that has travelled, or a
 * screenshot rendered in CI under UTC, would show a different time than the
 * schedule on the wall. Reading the digits out of the string cannot drift.
 */
export function formatClock(start: string | null): string | null {
  if (typeof start !== "string") return null;
  const m = start.match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const hour24 = Number(m[1]);
  if (!Number.isFinite(hour24)) return null;
  const minutes = m[2];
  const suffix = hour24 >= 12 ? "pm" : "am";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${minutes} ${suffix}`;
}

/** Sortable minutes-from-midnight for an Open Dental local timestamp. */
export function startMinutes(start: string | null): number {
  if (typeof start !== "string") return Number.MAX_SAFE_INTEGER;
  const m = start.match(/(\d{1,2}):(\d{2})/);
  if (!m) return Number.MAX_SAFE_INTEGER;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** "60 min", or null. NEVER a default — see HygAppointment.lengthMin. */
export function formatLength(lengthMin: number | null): string | null {
  return typeof lengthMin === "number" && lengthMin > 0 ? `${lengthMin} min` : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Columns
// ─────────────────────────────────────────────────────────────────────────────

export interface DayColumn {
  opNum: number | null;
  /** The chair's name, or null when Open Dental would not tell us. */
  name: string | null;
  isHygiene: boolean | null;
  appointments: HygAppointment[];
}

/**
 * Group a day into one column per chair, hygiene chairs first.
 *
 * ONLY CHAIRS WITH APPOINTMENTS GET A COLUMN. A practice has two dozen
 * operatories and a hygiene day fills two or three of them; rendering all
 * twenty-four would push the real ones off an iPad screen, and an empty column
 * for a chair nobody booked says nothing a hygienist needs.
 *
 * An appointment whose `opNum` is not in the roster still gets a column — with
 * a null name — rather than being dropped. Losing a patient because a chair was
 * missing from `/operatories` is the worse failure, and it is exactly what
 * happens when `/operatories` fails and the appointments read succeeds.
 */
export function groupByOperatory(
  appointments: readonly HygAppointment[],
  operatories: readonly HygOperatory[],
): DayColumn[] {
  const meta = new Map(operatories.map((o) => [o.opNum, o]));
  const byOp = new Map<number | null, HygAppointment[]>();

  for (const appt of appointments) {
    const key = appt.opNum;
    const bucket = byOp.get(key);
    if (bucket) bucket.push(appt);
    else byOp.set(key, [appt]);
  }

  const columns: DayColumn[] = [];
  // Array.from rather than iterating the Map directly: this package's tsconfig
  // has no `target` and defaults to ES5, so a for..of over a Map is a type error.
  for (const [opNum, appts] of Array.from(byOp.entries())) {
    const op = opNum === null ? undefined : meta.get(opNum);
    columns.push({
      opNum,
      name: op?.name ?? null,
      // The CHAIR's flag. The appointment carries its own, and they can
      // disagree; this one is about the column, so it is the chair's.
      isHygiene: op?.isHygiene ?? appts[0]?.opIsHygiene ?? null,
      appointments: [...appts].sort((a, b) => startMinutes(a.start) - startMinutes(b.start)),
    });
  }

  return columns.sort((a, b) => {
    // Hygiene chairs first — this is a hygiene day view, and the hygienist's own
    // chair should not be the third column across. An UNKNOWN isHygiene sorts
    // with the non-hygiene chairs rather than being promoted on a guess.
    const aHyg = a.isHygiene === true ? 0 : 1;
    const bHyg = b.isHygiene === true ? 0 : 1;
    if (aHyg !== bHyg) return aHyg - bHyg;
    // Then Open Dental's own ItemOrder, via the roster's order.
    const aOrder = operatories.findIndex((o) => o.opNum === a.opNum);
    const bOrder = operatories.findIndex((o) => o.opNum === b.opNum);
    if (aOrder !== bOrder) return (aOrder < 0 ? Number.MAX_SAFE_INTEGER : aOrder) -
      (bOrder < 0 ? Number.MAX_SAFE_INTEGER : bOrder);
    return (a.opNum ?? Number.MAX_SAFE_INTEGER) - (b.opNum ?? Number.MAX_SAFE_INTEGER);
  });
}

/** The label for a column header: the chair's name, or an honest fallback. */
export function columnLabel(column: DayColumn): string {
  if (column.name) return column.name;
  if (column.opNum !== null) return `Op ${column.opNum}`;
  // Open Dental gave the appointment no operatory at all. "Op null" would read
  // as a chair; "No chair" says what is actually true.
  return "No chair";
}

// ─────────────────────────────────────────────────────────────────────────────
// The summary strip
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The day's appointments in time order — the LIST view's whole layout rule.
 *
 * The paper routing slip is a list and the day reads as one, which is what Beau
 * said the first time a real schedule was on this screen. An appointment with
 * no start time sorts LAST rather than being dropped or floated to 8am: a visit
 * whose time Open Dental would not give us is still a visit somebody is coming
 * to, and putting it first would be a guess printed as a fact.
 */
export function byStartTime(
  appointments: readonly HygAppointment[],
): HygAppointment[] {
  return [...appointments].sort((a, b) => {
    const aKnown = a.start !== null;
    const bKnown = b.start !== null;
    if (aKnown !== bKnown) return aKnown ? -1 : 1;
    return startMinutes(a.start) - startMinutes(b.start);
  });
}

/**
 * Every provider name on the day, for the hygienist picker.
 *
 * DISPLAY-ONLY, and it has to be: Open Dental has no provider filter on
 * `/appointments`, so the whole day comes down in one paged pull whatever this
 * picker says (H0 §5, and the header of services/hyg/odDay.js). There is
 * nothing to push this filter into.
 *
 * A null provider name is not offered as an option — "unknown" is not a person
 * to filter by — but those appointments are never hidden either: see
 * `filterByProvider`.
 */
export function providersOnDay(appointments: readonly HygAppointment[]): string[] {
  const names = new Set<string>();
  for (const appt of appointments) {
    if (appt.providerName) names.add(appt.providerName);
  }
  // Array.from, not a spread: this package's tsconfig has no `target` and
  // defaults to ES5, where spreading a Set is a type error. `groupByOperatory`
  // documents the same constraint.
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

/**
 * The appointments for one provider, or all of them.
 *
 * ⚠️ AN APPOINTMENT WITH NO PROVIDER IS ALWAYS SHOWN. ⚠️ Filtering it out would
 * mean a patient disappears because Open Dental did not label their visit,
 * which is the same silent loss the hygiene lens is careful about one level up.
 * A hygienist filtering to her own name would rather see one extra card than
 * miss one.
 */
export function filterByProvider(
  appointments: readonly HygAppointment[],
  provider: string | null,
): HygAppointment[] {
  if (provider === null) return [...appointments];
  return appointments.filter((a) => a.providerName === null || a.providerName === provider);
}

export interface DaySummary {
  /** Every appointment on the day. */
  total: number;
  /** Those flagged hygiene ON THE APPOINTMENT — the authoritative flag. */
  hygiene: number;
  /**
   * Appointments carrying at least one flag we KNOW is true. Never counts a
   * null: "3 need premed" must mean three, not three-plus-however-many-we-
   * could-not-read.
   */
  flagged: number;
  /**
   * Appointments with at least one flag we could not determine. Shown beside
   * `flagged` rather than folded into it, because "we do not know about 4 of
   * these" is the more actionable of the two numbers.
   */
  unknownFlags: number;
}

export function summarise(day: Pick<HygDayResponse, "appointments">): DaySummary {
  let hygiene = 0;
  let flagged = 0;
  let unknownFlags = 0;

  for (const appt of day.appointments) {
    if (appt.isHygiene === true) hygiene += 1;
    const values = Object.values(appt.flags);
    if (values.some((v) => v === true)) flagged += 1;
    if (values.some((v) => v === null)) unknownFlags += 1;
  }

  return { total: day.appointments.length, hygiene, flagged, unknownFlags };
}

// ─────────────────────────────────────────────────────────────────────────────
// Flags
// ─────────────────────────────────────────────────────────────────────────────

export type FlagKey = keyof HygAppointment["flags"];

/** How each flag is written on a card, in the order a hygienist scans them. */
export const FLAG_LABELS: Record<FlagKey, string> = {
  premed: "Premed",
  medicalAlerts: "Medical alert",
  allergies: "Allergies",
  lastPerioDate: "Last perio",
  xraysDue: "X-rays due",
  examNeeded: "Exam needed",
  openTcCase: "Open TC case",
};

export const FLAG_ORDER: FlagKey[] = [
  "premed",
  "medicalAlerts",
  "allergies",
  "xraysDue",
  "examNeeded",
  "lastPerioDate",
  "openTcCase",
];

export type FlagTone = "alert" | "clear" | "unknown";

/**
 * Three tones, because there are three states.
 *
 * `alert` — we asked and the answer is yes.
 * `clear` — we asked and the answer is no.
 * `unknown` — we could not find out, OR this slice does not read this flag at
 *             all. Both render as "unknown", and neither may ever be drawn the
 *             same as `clear`. That is the whole rule.
 */
export function flagTone(value: boolean | string | null): FlagTone {
  if (value === null) return "unknown";
  if (value === false) return "clear";
  return "alert";
}

/**
 * The flags worth putting on a card: anything true, and anything unknown.
 *
 * A `clear` flag is deliberately NOT shown. Seven green chips on every card
 * would bury the one amber one, and the absence of a chip already means "no" on
 * a card where unknown has its own visible marker.
 */
export function visibleFlags(
  flags: HygAppointment["flags"],
): { key: FlagKey; label: string; tone: FlagTone; value: boolean | string | null }[] {
  return FLAG_ORDER.map((key) => ({
    key,
    label: FLAG_LABELS[key],
    tone: flagTone(flags[key]),
    value: flags[key],
  })).filter((f) => f.tone !== "clear");
}

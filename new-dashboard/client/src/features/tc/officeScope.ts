/**
 * TC office scoping — the all-offices ("both") view ported from DentaFlow.
 *
 * The backend has NO all-offices query: every /api/tc route runs through
 * requireOffice, which rejects anything that isn't a concrete office id. So
 * "All Offices" is implemented purely client-side as a fan-out — call each
 * real office with the existing per-office API functions, tag every row with
 * the office it came from, and merge. No new routes, no signature changes.
 *
 * Error semantics (deliberately partial-tolerant): one office failing must
 * never blank the page. `fanOut*` resolves with whatever loaded plus a typed
 * per-office error list; callers surface `partialNotice()` as a warning banner
 * and only fall back to a hard error state when EVERY office failed.
 */
import { useMemo } from "react";
import { OfficeId } from "@shared/tc/contract";
import { useOffice, ALL_OFFICES } from "@/contexts/OfficeContext";

// ── Labels ──────────────────────────────────────────────────────────────────

/** Short office labels for badges/notices (roster names are too long for a chip). */
export const TC_OFFICE_LABELS: Record<OfficeId, string> = {
  roland: "Roland",
  valley: "Valley",
};

export function tcOfficeLabel(officeId: OfficeId): string {
  return TC_OFFICE_LABELS[officeId];
}

// ── Selections (what list components accept as a prop) ──────────────────────

/**
 * What an office-scoped list component is pointed at: one office, or several
 * for the all-offices view. Keeping the single form as a bare OfficeId means
 * existing callers/tests (office="roland") are unchanged and the per-office
 * api functions are still called with exactly that office.
 */
export type TcOfficeSelection = OfficeId | OfficeId[];

export function officesOf(selection: TcOfficeSelection): OfficeId[] {
  return Array.isArray(selection) ? [...selection] : [selection];
}

/** Badges only make sense when a surface is showing more than one office. */
export function showsOfficeBadges(selection: TcOfficeSelection): boolean {
  return Array.isArray(selection) && selection.length > 1;
}

// ── Scope resolution ────────────────────────────────────────────────────────

/**
 * What a TC surface may query. `offices` is always concrete — an empty array
 * means "nothing usable is selected" and the caller renders <TcOfficeGate />.
 */
export interface TcOfficeScope {
  /** Concrete offices to fan out over, in roster order. */
  offices: OfficeId[];
  /** The global picker is on "All Offices". */
  isAllOffices: boolean;
  /** Show per-row location badges (all-offices AND more than one office). */
  showOfficeBadges: boolean;
  /** The one office in scope, or null when the selection spans several. */
  office: OfficeId | null;
  /** Office roster still loading — don't gate yet, wait. */
  loading: boolean;
}

/** Anything roster-shaped; only the id matters here. */
export interface OfficeRosterEntry {
  officeId: string;
}

/**
 * Pure resolver so the fan-out rules are testable without React or providers.
 * The roster is the source of truth for WHICH offices exist; TC only ever
 * queries roster offices that parse as a contract OfficeId.
 */
export function resolveTcOfficeScope(input: {
  /** Current OfficeContext selection: an officeId or the ALL_OFFICES sentinel. */
  selection: string;
  roster: readonly OfficeRosterEntry[];
  loading?: boolean;
}): TcOfficeScope {
  const { selection, roster, loading = false } = input;
  const tcRoster = roster
    .map((o) => OfficeId.safeParse(o.officeId))
    .flatMap((p) => (p.success ? [p.data] : []));

  if (selection === ALL_OFFICES) {
    const offices = dedupe(tcRoster);
    return {
      offices,
      isAllOffices: true,
      showOfficeBadges: offices.length > 1,
      office: offices.length === 1 ? (offices[0] as OfficeId) : null,
      loading,
    };
  }

  const parsed = OfficeId.safeParse(selection);
  if (!parsed.success) {
    // A non-TC office is selected (e.g. a voice-only location) — nothing to show.
    return { offices: [], isAllOffices: false, showOfficeBadges: false, office: null, loading };
  }
  return {
    offices: [parsed.data],
    isAllOffices: false,
    showOfficeBadges: false,
    office: parsed.data,
    loading,
  };
}

function dedupe(offices: readonly OfficeId[]): OfficeId[] {
  return offices.filter((o, i) => offices.indexOf(o) === i);
}

/** React binding of resolveTcOfficeScope over the global OfficeContext. */
export function useTcOfficeScope(): TcOfficeScope {
  const { office, offices, loading } = useOffice();
  return useMemo(
    () => resolveTcOfficeScope({ selection: office, roster: offices, loading }),
    [office, offices, loading],
  );
}

/**
 * Stable remount/refetch key for a scope — pages use it as a React `key` so
 * switching Roland → All Offices resets page state the same way a single
 * office switch does.
 */
export function officeScopeKey(offices: readonly OfficeId[]): string {
  return [...offices].sort().join("+");
}

// ── Fan-out ─────────────────────────────────────────────────────────────────

/** A row tagged with the office it was fetched from. */
export type WithOffice<T> = T & { officeId: OfficeId };

export interface OfficeFanOutError {
  officeId: OfficeId;
  message: string;
}

interface FanOutStatus {
  /** Offices that failed. Empty on a clean load. */
  errors: OfficeFanOutError[];
  /** Some offices loaded and some failed — the page shows data + a notice. */
  partial: boolean;
  /** Every queried office failed — the page shows a hard error. */
  failed: boolean;
}

export interface OfficeRowsFanOut<T> extends FanOutStatus {
  rows: WithOffice<T>[];
}

export interface OfficeValuesFanOut<T> extends FanOutStatus {
  values: { officeId: OfficeId; value: T }[];
}

/** Stamp the queried office onto every row (authoritative over any row field). */
export function tagOffice<T>(rows: readonly T[], officeId: OfficeId): WithOffice<T>[] {
  return rows.map((row) => ({ ...row, officeId }) as WithOffice<T>);
}

function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Something went wrong.";
}

function summarize(errors: OfficeFanOutError[], attempted: number): FanOutStatus {
  return {
    errors,
    partial: errors.length > 0 && errors.length < attempted,
    failed: attempted > 0 && errors.length === attempted,
  };
}

/**
 * Run a per-office fetch across every office in scope and return one merged,
 * office-tagged row list. Offices are queried in parallel; a rejection is
 * captured per office instead of failing the whole load.
 *
 * @param fetchOne the EXISTING per-office api function, e.g. (o) => listCases(o)
 */
export async function fanOutOfficeRows<T>(
  offices: readonly OfficeId[],
  fetchOne: (office: OfficeId) => Promise<T[]>,
): Promise<OfficeRowsFanOut<T>> {
  const settled = await Promise.allSettled(offices.map((office) => fetchOne(office)));
  const rows: WithOffice<T>[] = [];
  const errors: OfficeFanOutError[] = [];
  settled.forEach((result, i) => {
    const officeId = offices[i] as OfficeId;
    if (result.status === "fulfilled") rows.push(...tagOffice(result.value, officeId));
    else errors.push({ officeId, message: toMessage(result.reason) });
  });
  return { rows, ...summarize(errors, offices.length) };
}

/**
 * Same fan-out, but each office yields ONE value instead of a row list — for
 * surfaces (the dashboard) that need several lists per office and merge them
 * themselves.
 */
export async function fanOutOfficeValues<T>(
  offices: readonly OfficeId[],
  fetchOne: (office: OfficeId) => Promise<T>,
): Promise<OfficeValuesFanOut<T>> {
  const settled = await Promise.allSettled(offices.map((office) => fetchOne(office)));
  const values: { officeId: OfficeId; value: T }[] = [];
  const errors: OfficeFanOutError[] = [];
  settled.forEach((result, i) => {
    const officeId = offices[i] as OfficeId;
    if (result.status === "fulfilled") values.push({ officeId, value: result.value });
    else errors.push({ officeId, message: toMessage(result.reason) });
  });
  return { values, ...summarize(errors, offices.length) };
}

/**
 * Honest one-liner for a partially-loaded fan-out ("Valley didn't load — …"),
 * or null when everything loaded. When EVERY office failed the caller should
 * use `hardErrorMessage` and render its normal error state instead.
 */
export function partialNotice(status: FanOutStatus): string | null {
  if (!status.partial) return null;
  const names = status.errors.map((e) => tcOfficeLabel(e.officeId)).join(", ");
  const first = status.errors[0];
  return `Showing partial data — ${names} didn't load${first ? ` (${first.message})` : ""}.`;
}

/** The message to show when the whole fan-out failed, else null. */
export function hardErrorMessage(status: FanOutStatus): string | null {
  if (!status.failed) return null;
  const first = status.errors[0];
  return first ? first.message : "Something went wrong.";
}

// ── Shared routes (DentaFlow SHARED_ROUTES port) ─────────────────────────────

/**
 * TC routes whose content isn't scoped by the global office picker, so the
 * picker is hidden on them (DentaFlow hid it on financing / gallery / tc-guide
 * / email / settings / reports / patient sub-routes).
 *
 * Each entry is a PREFIX. "/tc/cases/" keeps its trailing slash so it matches
 * case detail + prep + post-consult but never the pipeline list at "/tc".
 * "/tc/cob" is deliberately NOT here: the COB calculator reads the selected
 * office's financing config, so switching offices there is meaningful.
 */
export const TC_SHARED_ROUTES = [
  "/tc/financing",
  "/tc/gallery",
  "/tc/guide",
  "/tc/templates",
  "/tc/communications",
  "/tc/library",
  "/tc/settings",
  "/tc/reports",
  "/tc/cases/",
] as const;

/** True when the office picker should be hidden for this location. */
export function isTcSharedRoute(location: string): boolean {
  return TC_SHARED_ROUTES.some((prefix) => location.startsWith(prefix));
}

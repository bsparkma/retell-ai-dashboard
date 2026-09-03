/**
 * /rcm/bring-in — THE ONE PLACE A CHECK GETS INTO CAREIN (ruling D-16).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A PAGE AND NOT A SECTION ON TODAY
 * ═════════════════════════════════════════════════════════════════════════════
 * Stage A ended the two-doors problem — the Upload button used to be on Today
 * AND on the Checks page, and the practice owner got lost going round the loop
 * live (RCM_POSTING §15.2 finding 6). It put the one door on Today, under *Get
 * work in*.
 *
 * That fixed the bouncing and left a second problem: Today is the screen a
 * biller reads to find out what is waiting on her, and it opened with two file
 * drop zones and a cost breaker. The first act of the morning is not "what came
 * in overnight" for everybody — a practice that scans its own EOBs starts by
 * adding one — but for the reader of Today it is, and the upload machinery was
 * furniture in the way of it.
 *
 * So the door moved to a page of its own and is FIRST-CLASS in the nav, after
 * Checks. Today's *Get work in* is one card that navigates here; the Checks
 * page's button navigates here; the empty state navigates here. There is still
 * exactly one door, and now it is a room.
 *
 * `tests/rcm-shell.test.tsx` reads the source of every RCM page and fails if a
 * second one imports an upload panel — the same assertion Stage A wrote,
 * pointed at this file instead of at Today.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ALL SIX SOURCES ARE ON THE PAGE. THREE OF THEM CANNOT BE PRESSED.
 * ═════════════════════════════════════════════════════════════════════════════
 * A biller holding a piece of paper needs to know whether this product has a
 * place for it. Hiding the three that are not built answers that with silence,
 * and silence reads as "you are holding it wrong": she goes looking, finds
 * nothing, and concludes it cannot be done at all.
 *
 * So a not-yet tile RENDERS — greyed, labelled *Not yet*, with a line saying
 * what is actually true today — and it contains no button, no link and no file
 * input, so there is no broken state to click into. `features/rcm/sources.ts`
 * owns the list and `tests/rcm-bring-in.test.tsx` asserts both halves over it.
 *
 * One of the three is not waiting on anything: *Checks and cards*. A paper
 * cheque needs no file, and its tile says so permanently rather than implying a
 * feature that has slipped.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHICH ENDPOINT EACH LIVE TILE CALLS — no new lane in this stage
 * ═════════════════════════════════════════════════════════════════════════════
 *   835 / ERA file          POST /api/rcm/era?office=…   (`EraUploadPanel`)
 *   Scanned EOB             POST /api/rcm/eob?office=…   (`EobUploadPanel`)
 *   Payer portal download   POST /api/rcm/eob?office=…   — the SAME lane
 *
 * The portal tile is separate because that is where a biller looks for it, and
 * the same lane because a PDF from a portal and a PDF from a scanner are the
 * same file to everything downstream. Two endpoints for one thing would be the
 * two-doors mistake again, one level down.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * "BROUGHT IN RECENTLY" ADDS NO STORE
 * ═════════════════════════════════════════════════════════════════════════════
 * It reads the two upload lists that already exist — `GET /api/rcm/era` and
 * `GET /api/rcm/eob` — and merges them newest-first over the last seven days.
 * Nothing is written, nothing is cached, and a lane that fails to load says so
 * on its own rather than emptying the table: half an answer labelled as half an
 * answer beats a whole answer that is quietly missing a lane.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Clock,
  FileText,
  Inbox,
  Loader2,
  Lock,
  Upload,
} from "lucide-react";
import { useOffice } from "@/contexts/OfficeContext";
import { useRcmOfficeScope } from "@/features/rcm/officeScope";
import EobUploadPanel from "./EobUploadPanel";
import EraUploadPanel from "./EraUploadPanel";
import {
  listEobUploads,
  listEraUploads,
  RcmApiError,
  RCM_OFFICE_LABELS,
  type RcmOfficeId,
} from "@/features/rcm/api";
import { money, withinLastDays } from "@/features/rcm/format";
import { remittanceHref } from "@/features/rcm/flow";
import { officeStamp } from "@/features/rcm/time";
import { LIVE_SOURCES, NOT_YET_SOURCES, SOURCE_TILES, type SourceTile } from "@/features/rcm/sources";

/** What "recently" means on the table below. Practice days, not 168 hours. */
const RECENT_DAYS = 7;

/** How many rows the table shows before it stops naming them. */
const RECENT_LIMIT = 12;

/** How deep each lane's list is read. Both endpoints cap well above this. */
const SCAN = 25;

export default function BringIn() {
  const scope = useRcmOfficeScope();
  const { reload } = useOffice();
  /** Which live tile is open. Only one at a time — see `openTile`. */
  const [open, setOpen] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  /**
   * Opening a tile scrolls its panel into view.
   *
   * ONE OPEN AT A TIME, deliberately: two drop zones on screen is the shape
   * Today had, and the whole point of a tile is that she chooses what she is
   * holding before she is shown a place to put it.
   */
  function openTile(id: string) {
    setOpen((current) => (current === id ? null : id));
  }

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => {
      panelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 60);
    return () => window.clearTimeout(t);
  }, [open]);

  if (scope.loading) {
    return (
      <div
        className="flex items-center gap-2 p-6 text-sm text-muted-foreground"
        data-testid="bring-in-loading"
      >
        <Loader2 size={16} className="animate-spin" />
        Loading offices…
      </div>
    );
  }

  if (scope.error) {
    return (
      <div className="p-6" data-testid="bring-in-roster-error">
        <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center">
          <div className="text-sm font-medium text-foreground">Could not load the office list</div>
          <p className="mt-1 text-sm text-muted-foreground">{scope.error}</p>
          <button
            onClick={reload}
            className="mt-4 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  const tile = LIVE_SOURCES.find((s) => s.id === open) ?? null;

  return (
    <div className="p-6" data-testid="rcm-bring-in">
      <Link
        href="/rcm"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft size={14} />
        Today
      </Link>

      <h1
        className="mt-4 text-2xl font-bold tracking-tight text-foreground"
        style={{ fontFamily: "Sora, sans-serif" }}
      >
        Bring in
      </h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        Everything a carrier payment can arrive as, and what happens to each one. Whatever you add
        here becomes a <strong>proposal</strong> — claims and procedure lines waiting for a person.
        Nothing added here is posted to a patient chart.
      </p>

      {scope.offices.length === 0 ? (
        <div
          className="mt-6 rounded-xl border border-dashed border-border bg-card p-8 text-center"
          data-testid="bring-in-no-offices"
        >
          <div className="text-sm font-medium text-foreground">No RCM offices</div>
          <p className="mt-1 text-sm text-muted-foreground">
            None of this practice's offices are set up for revenue cycle work yet.
          </p>
        </div>
      ) : (
        <>
          {/* ── The six sources ──────────────────────────────────────────── */}
          <div
            className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
            data-testid="bring-in-tiles"
          >
            {SOURCE_TILES.map((source) => (
              <SourceCard
                key={source.id}
                source={source}
                open={open === source.id}
                onOpen={() => openTile(source.id)}
              />
            ))}
          </div>

          {/* ── The lane the chosen tile opens ───────────────────────────── */}
          {tile && (
            <div className="mt-5 scroll-mt-6" ref={panelRef} data-testid={`bring-in-panel-${tile.id}`}>
              <h2
                className="flex items-center gap-2 text-lg font-semibold tracking-tight text-foreground"
                style={{ fontFamily: "Sora, sans-serif" }}
              >
                <Upload size={17} />
                {tile.title}
              </h2>
              <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{tile.detail}</p>
              {scope.offices.map((office) => (
                <div key={office} className="mt-4">
                  {scope.offices.length > 1 && (
                    <h3 className="mb-2 text-sm font-semibold text-foreground">
                      {RCM_OFFICE_LABELS[office]}
                    </h3>
                  )}
                  {/*
                    THE EXISTING PANELS, UNCHANGED. This page chooses which lane
                    is on screen and nothing else — a tile that re-implemented an
                    upload would be a second ingest path wearing a new label.
                  */}
                  {tile.lane === "era" ? (
                    <EraUploadPanel office={office} />
                  ) : (
                    <EobUploadPanel office={office} />
                  )}
                </div>
              ))}
            </div>
          )}

          {/* ── Brought in recently ──────────────────────────────────────── */}
          <div className="mt-10">
            <h2
              className="flex items-center gap-2 text-lg font-semibold tracking-tight text-foreground"
              style={{ fontFamily: "Sora, sans-serif" }}
            >
              <Clock size={17} />
              Brought in recently
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              The last {RECENT_DAYS} days, newest first — every file this practice took in and what
              came of it.
            </p>
            {scope.offices.map((office) => (
              <RecentlyBroughtIn key={office} office={office} showOffice={scope.offices.length > 1} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * One source.
 *
 * A LIVE tile is a `<button>`. A not-yet tile is a `<div>` with no interactive
 * child at all — not a disabled button, which is still a control a person can
 * tab to and press hopefully. There is nothing behind it, so it offers nothing.
 */
function SourceCard({
  source,
  open,
  onOpen,
}: {
  source: SourceTile;
  open: boolean;
  onOpen: () => void;
}) {
  if (!source.live) {
    return (
      <div
        data-testid={`bring-in-source-${source.id}`}
        data-live="false"
        className="rounded-xl border border-dashed border-border bg-muted/20 p-4"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="text-sm font-semibold text-muted-foreground">{source.title}</div>
          <span
            className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
            data-testid={`bring-in-not-yet-${source.id}`}
          >
            <Lock size={10} className="mr-1 inline align-[-1px]" />
            Not yet
          </span>
        </div>
        <div className="mt-0.5 text-xs font-medium text-muted-foreground/80">{source.promise}</div>
        <p className="mt-2 text-xs text-muted-foreground">{source.detail}</p>
        {/* WHAT IS ACTUALLY TRUE TODAY — never a bare "coming soon", which is a
            date nobody promised. */}
        <p
          className="mt-2 text-xs font-medium text-foreground/70"
          data-testid={`bring-in-not-yet-note-${source.id}`}
        >
          {source.notYet}
        </p>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-expanded={open}
      data-testid={`bring-in-source-${source.id}`}
      data-live="true"
      className={`group rounded-xl border p-4 text-left transition-colors ${
        open
          ? "border-foreground/40 bg-muted/50"
          : "border-border bg-card hover:border-foreground/25 hover:bg-muted/40"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-semibold text-foreground">{source.title}</div>
        <ArrowRight
          size={14}
          className="mt-0.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
        />
      </div>
      <div className="mt-0.5 text-xs font-medium text-foreground/70">{source.promise}</div>
      <p className="mt-2 text-xs text-muted-foreground">{source.detail}</p>
      <p className="mt-2 font-mono text-[11px] text-muted-foreground/80">{source.accepts}</p>
    </button>
  );
}

/** One row of the recent table, whichever lane it came in on. */
interface RecentRow {
  key: string;
  filename: string;
  /** Which tile brought it in, in the words the tile uses. */
  sourceLabel: string;
  at: string | null;
  payer: string | null;
  amountCents: number | null;
  claims: number | null;
  state: string;
  /** Where to go to work it. Null when there is nothing to open yet. */
  href: string | null;
}

/**
 * The two upload lists, merged.
 *
 * Each lane is loaded and REPORTED separately: a lane that fails says so in its
 * own line and the other lane's rows still render. A table that emptied because
 * one of two reads failed would be hiding work behind a fault, which is exactly
 * the failure the honest-states rule exists for.
 */
function RecentlyBroughtIn({ office, showOffice }: { office: RcmOfficeId; showOffice: boolean }) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "loaded"; rows: RecentRow[]; failures: string[] }
    | { kind: "failed"; message: string }
  >({ kind: "loading" });

  const load = useCallback(() => {
    let cancelled = false;
    setState({ kind: "loading" });

    const say = (err: unknown, fallback: string) =>
      err instanceof RcmApiError && err.notEntitled
        ? "This practice is not set up for the RCM module."
        : err instanceof Error
          ? err.message
          : fallback;

    Promise.all([
      listEraUploads(office, { limit: SCAN }).then(
        (page) => ({ ok: true as const, page }),
        (err: unknown) => ({ ok: false as const, message: say(err, "The 835 list could not be read.") }),
      ),
      listEobUploads(office, { limit: SCAN }).then(
        (page) => ({ ok: true as const, page }),
        (err: unknown) => ({ ok: false as const, message: say(err, "The EOB list could not be read.") }),
      ),
    ]).then(([era, eob]) => {
      if (cancelled) return;

      const rows: RecentRow[] = [];
      const failures: string[] = [];

      if (era.ok) {
        for (const up of era.page.uploads) {
          if (!withinLastDays(up.uploadedAt, RECENT_DAYS)) continue;
          /*
           * ONE 835 CAN CARRY SEVERAL CHECKS. Each becomes its own row, because
           * the thing a biller works is a check — a row per FILE would make a
           * five-check transmission look like one piece of work.
           */
          if (up.remittances.length === 0) {
            rows.push({
              key: `era-${up.uploadId}`,
              filename: up.filename,
              sourceLabel: "835 / ERA file",
              at: up.uploadedAt,
              payer: null,
              amountCents: null,
              claims: null,
              state: up.status === "processed" ? "Read, no checks in it" : eraStateLabel(up.status),
              href: null,
            });
            continue;
          }
          for (const r of up.remittances) {
            rows.push({
              key: `era-${up.uploadId}-${r.batchId}`,
              filename: up.filename,
              sourceLabel: "835 / ERA file",
              at: up.uploadedAt,
              payer: r.payer,
              amountCents: r.totalAmountCents,
              claims: r.claimCount,
              state:
                r.dedupeStatus === "duplicate"
                  ? "Already in — the same check had come in before"
                  : r.status === "ready"
                    ? "Ready to work"
                    : "Needs a person",
              href: remittanceHref(r.batchId),
            });
          }
        }
      } else {
        failures.push(era.message);
      }

      if (eob.ok) {
        for (const up of eob.page.uploads) {
          if (!withinLastDays(up.uploadedAt, RECENT_DAYS)) continue;
          rows.push({
            key: `eob-${up.uploadId}`,
            filename: up.filename,
            /*
             * BOTH PDF TILES REPORT AS "SCANNED EOB", and that is honest rather
             * than lossy: nothing on the wire records which tile a PDF was
             * dropped on, because the two are one lane. A column that guessed
             * would be inventing provenance.
             */
            sourceLabel: "Scanned EOB",
            at: up.uploadedAt,
            payer: null,
            amountCents: null,
            claims: null,
            state: eobStateLabel(up.status),
            href: up.resultBatchId ? remittanceHref(up.resultBatchId) : null,
          });
        }
      } else {
        failures.push(eob.message);
      }

      rows.sort((a, b) => Date.parse(b.at ?? "") - Date.parse(a.at ?? ""));
      setState({ kind: "loaded", rows: rows.slice(0, RECENT_LIMIT), failures });
    });

    return () => {
      cancelled = true;
    };
  }, [office]);

  useEffect(load, [load]);

  return (
    <section className="mt-3" data-testid={`bring-in-recent-${office}`}>
      {showOffice && (
        <h3 className="mb-2 text-sm font-semibold text-foreground">{RCM_OFFICE_LABELS[office]}</h3>
      )}

      {state.kind === "loading" ? (
        <div className="flex items-center gap-2 rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
          <Loader2 size={14} className="animate-spin" />
          Loading…
        </div>
      ) : state.kind === "failed" ? (
        <div className="flex items-start gap-2 rounded-xl border border-border bg-card p-5 text-sm text-destructive">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>{state.message}</span>
        </div>
      ) : (
        <>
          {/* A LANE THAT FAILED SAYS SO, above rows the other lane still has. */}
          {state.failures.map((message) => (
            <p
              key={message}
              className="mb-2 flex items-start gap-1.5 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
              data-testid={`bring-in-recent-partial-${office}`}
            >
              <AlertCircle size={12} className="mt-0.5 shrink-0" />
              <span>{message} What is below is the rest.</span>
            </p>
          ))}

          {state.rows.length === 0 ? (
            <div
              className="rounded-xl border border-dashed border-border bg-card p-8 text-center"
              data-testid={`bring-in-recent-empty-${office}`}
            >
              <Inbox size={20} className="mx-auto text-muted-foreground/50" />
              <p className="mt-2 text-sm text-muted-foreground">
                Nothing has come in for {RCM_OFFICE_LABELS[office]} in the last {RECENT_DAYS} days.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Pick a source above and add the first one.
              </p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              <div className="hidden grid-cols-[minmax(10rem,1.4fr)_8rem_minmax(8rem,1fr)_7rem_4rem_minmax(9rem,1.2fr)] gap-3 border-b border-border px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground md:grid">
                <span>File</span>
                <span>Came in as</span>
                <span>Payer</span>
                <span className="text-right">Amount</span>
                <span className="text-right">Claims</span>
                <span>State</span>
              </div>
              {state.rows.map((row) => (
                <RecentCell key={row.key} row={row} office={office} />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function RecentCell({ row, office }: { row: RecentRow; office: RcmOfficeId }) {
  const body = (
    <>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <FileText size={12} className="shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium text-foreground">{row.filename}</span>
        </div>
        <div className="text-xs text-muted-foreground">
          {row.at ? officeStamp(row.at, office) : "no time recorded"}
        </div>
      </div>
      <span className="text-xs text-muted-foreground">{row.sourceLabel}</span>
      <span className="truncate text-sm text-foreground">{row.payer ?? "—"}</span>
      <span className="text-right font-mono text-sm tabular-nums text-foreground">
        {row.amountCents === null ? "—" : money(row.amountCents)}
      </span>
      <span className="text-right font-mono text-sm tabular-nums text-muted-foreground">
        {row.claims ?? "—"}
      </span>
      <span className="text-xs text-muted-foreground">{row.state}</span>
    </>
  );

  const grid =
    "grid grid-cols-1 items-center gap-3 border-b border-border px-4 py-3 last:border-b-0 md:grid-cols-[minmax(10rem,1.4fr)_8rem_minmax(8rem,1fr)_7rem_4rem_minmax(9rem,1.2fr)]";

  return row.href ? (
    <Link href={row.href} data-testid={`bring-in-recent-row-${row.key}`} className={`${grid} transition-colors hover:bg-muted/40`}>
      {body}
    </Link>
  ) : (
    <div data-testid={`bring-in-recent-row-${row.key}`} className={grid}>
      {body}
    </div>
  );
}

/**
 * An 835 upload's state, in words.
 *
 * A slug this build does not know renders as itself rather than as "unknown" —
 * an ugly string is a bug report; a friendly one is a bug nobody notices.
 */
function eraStateLabel(status: string): string {
  switch (status) {
    case "processed":
      return "Read";
    case "duplicate":
      return "Already in — the same file had come in before";
    case "failed":
      return "Could not be read";
    case "uploaded":
      return "Waiting to be read";
    default:
      return status;
  }
}

/** An EOB upload's state, in words. See `eraStateLabel` on unknown slugs. */
function eobStateLabel(status: string): string {
  switch (status) {
    case "processed":
      return "Read — check the figures";
    case "extracting":
      return "Being read";
    case "uploaded":
      return "Waiting to be read";
    case "failed":
      return "Could not be read";
    default:
      return status;
  }
}

/** Exported so the tests and the nav can agree on where this page lives. */
export const BRING_IN_PATH = "/rcm/bring-in";

/** Every source, for a test that wants the catalogue without importing twice. */
export { SOURCE_TILES, LIVE_SOURCES, NOT_YET_SOURCES };

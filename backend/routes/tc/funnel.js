'use strict';

/**
 * The TC conversion funnel (queue item 42) — computed SERVER-SIDE from the
 * transition history in tc_case_events, never from current-status summaries.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT COUNTS AS A RELIABLE TRANSITION (the evidence base)
 * ─────────────────────────────────────────────────────────────────────────────
 * A status ENTRY is "case X entered status S at time T". Exactly two sources
 * produce one honestly:
 *
 *  1. A SERVER-WRITTEN status_change event. Since the Slice 3 port, the only
 *     paths that change tc_cases.status are POST /cases/:id/status and the
 *     hygiene claim (POST /hygiene-intakes/:id/claim); both write the event in
 *     the same transaction, with ts = the server clock and a description that
 *     begins `<from> → <to>` (both frozen CaseStatus slugs). The client cannot
 *     forge one: POST /cases/:id/events accepts only note_added and
 *     contact_attempt.
 *
 *  2. A NATIVE case's case_created event (tc_cases.legacy_id IS NULL). A case
 *     created on the platform can be created directly into any status, so its
 *     creation is an entry into its INITIAL status — which is the `from` of its
 *     earliest server transition, or its current status if it has none (no
 *     status can change without writing a transition, so that is exact).
 *
 * Deliberately NOT evidence:
 *  - IMPORTED legacy events (the Slice 2 importer copies the legacy app's
 *    caseEvents[]). The legacy app wrote status changes as free text —
 *    "Moved to <status with spaces>" or "Accepted — moved forward" — with NO
 *    from-status, from a client clock. They never match the `<slug> → <slug>`
 *    shape, so the parse below excludes them structurally; `legacy_id IS NULL`
 *    is a second guard, not the first (an imported event whose legacy id was
 *    empty lands with legacy_id NULL — see shared/tc/legacy.ts).
 *  - An imported case's creation. Its entry into its import-time status
 *    happened in the legacy app at an unknown time.
 *
 * So the funnel's history STARTS at the oldest reliable entry for the office.
 * That instant is returned as `coverageStartsAt`, and any requested window
 * that begins earlier is clamped to it rather than reported as if all-time.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE COUNTING RULES (each one stated, because each one is a choice)
 * ─────────────────────────────────────────────────────────────────────────────
 *  ACCEPTED       = an entry into any of ACCEPTED_FAMILY: the patient said yes
 *                   (fully or partly), including a case that skipped straight
 *                   to scheduled.
 *  CREDITED ONCE  = a case is credited with acceptance exactly once, at its
 *                   FIRST reliable entry into the accepted family. A reopened
 *                   case (accepted → considering → accepted) is ONE win, dated
 *                   at the first acceptance; the re-acceptance adds nothing,
 *                   and a later loss does not retract the win.
 *  ACCEPTANCE RATE (presented → accepted) is a COHORT rate: the denominator is
 *                   the cases whose first entry into `presented` falls in the
 *                   window; the numerator is those of them with an acceptance
 *                   at or after that entry and before the window's end. Each
 *                   case counts at most once on each side. A case carried in
 *                   from before coverage (e.g. imported while already
 *                   presented) has no presented entry and is not in the cohort.
 *  VALUE          = tc_cases.case_value_cents as it stands NOW (the event log
 *                   does not snapshot value). Stated in the UI.
 *  STAGE CONVERSION for each of the 9 board stages: of the cases that entered
 *                   the stage in the window, how many later (before the window
 *                   ends) entered a status further along STAGE_RANK; how many
 *                   later entered `lost`.
 *  DAYS IN STAGE  = one sample per completed STAY (entry → the case's next
 *                   entry), counted when the stay ENDS inside the window. Open
 *                   stays are counted, not timed — a guessed end is no end.
 *  LOST BY REASON = cases with an entry into `lost` in the window, once each.
 *                   The reason lives only on tc_cases (the event does not carry
 *                   it), so a case that has since left `lost` reports a null
 *                   reason: "no longer lost — reason not kept".
 *  NURTURE REACTIVATION = a case credited with a win in the window whose
 *                   history before that win shows nurture → (an open,
 *                   non-nurture status) → accepted.
 *
 * Every percentage is null when its denominator is zero — never 0%, never NaN.
 * Deleting a case cascades its events, so a deleted case leaves the funnel.
 */

/** Frozen CaseStatus vocabulary (mirror of shared/tc/contract.ts CaseStatus). */
const CASE_STATUSES = Object.freeze([
  'hygiene_review',
  'diagnosed',
  'pending_tc',
  'pending_pt',
  'presented',
  'considering',
  'financing_pending',
  'accepted',
  'partially_accepted',
  'scheduled',
  'started',
  'completed',
  'lost',
  'nurture',
]);

/** The 9 pipeline-board stages, in board order (client features/tc/status.ts BOARD_STATUSES). */
const BOARD_STAGES = Object.freeze([
  'diagnosed',
  'pending_tc',
  'pending_pt',
  'presented',
  'considering',
  'financing_pending',
  'accepted',
  'partially_accepted',
  'scheduled',
]);

/** "Further along" order for stage conversion: the board, then the clinical tail. */
const STAGE_RANK = Object.freeze([...BOARD_STAGES, 'started', 'completed']);

/** The patient said yes (fully or partly). See CREDITED ONCE above. */
const ACCEPTED_FAMILY = Object.freeze([
  'accepted',
  'partially_accepted',
  'scheduled',
  'started',
  'completed',
]);

/** Open statuses other than nurture — the middle step of a reactivation. */
const REACTIVATION_OPEN = Object.freeze([
  'hygiene_review',
  'diagnosed',
  'pending_tc',
  'pending_pt',
  'presented',
  'considering',
  'financing_pending',
]);

/** Lost reasons (mirror of shared/tc/contract.ts LostReason). */
const LOST_REASONS = Object.freeze([
  'moved',
  'chose_another_provider',
  'declined_permanently',
  'unresponsive',
  'other',
]);

/**
 * The shape of a server-written status_change description: `<from> → <to>`,
 * optionally followed by ` (claimed)` or `: <note>`. Written by
 * routes/tc/cases.js (POST /:caseId/status) and routes/tc/hygiene.js (claim);
 * tcFunnel.test.js drives both real routes and holds their output to this.
 */
const TRANSITION_PATTERN = '^([a-z_]+) → ([a-z_]+)';

/** Longest window one request may ask for, in days (inclusive of both ends). */
const MAX_WINDOW_DAYS = 366;
/** Default window when `from` is omitted: the 365 days ending at `to`. */
const DEFAULT_WINDOW_DAYS = 365;

/**
 * Shared prelude. Every statement takes the SAME eight parameters, all cast in
 * `p` so Postgres can type a parameter a given statement does not otherwise use.
 *   $1 office  $2 statuses  $3 from_ts  $4 to_ts  $5 accepted family
 *   $6 stage rank  $7 time zone  $8 reactivation-open statuses
 */
const PRELUDE = `
WITH p AS (
  SELECT $1::text        AS office,
         $2::text[]      AS statuses,
         $3::timestamptz AS from_ts,
         $4::timestamptz AS to_ts,
         $5::text[]      AS accepted_family,
         $6::text[]      AS stage_rank,
         $7::text        AS tz,
         $8::text[]      AS reactivation_open
),
parsed AS (
  SELECT e.case_id, e.event_id, e.ts,
         regexp_match(e.description, '${TRANSITION_PATTERN}') AS m
    FROM tc_case_events e
    CROSS JOIN p
   WHERE e.office_id = p.office
     AND e.type = 'status_change'
     AND e.legacy_id IS NULL
),
transitions AS (
  SELECT parsed.case_id, parsed.event_id, parsed.ts,
         parsed.m[1] AS from_status, parsed.m[2] AS to_status
    FROM parsed
    CROSS JOIN p
   WHERE parsed.m IS NOT NULL
     AND parsed.m[1] = ANY(p.statuses)
     AND parsed.m[2] = ANY(p.statuses)
),
entries AS (
  SELECT t.case_id, t.ts, t.to_status AS status, 1 AS ord, t.event_id
    FROM transitions t
  UNION ALL
  SELECT ce.case_id, ce.ts, COALESCE(ft.from_status, c.status) AS status, 0 AS ord, ce.event_id
    FROM tc_case_events ce
    CROSS JOIN p
    JOIN tc_cases c ON c.case_id = ce.case_id AND c.office_id = ce.office_id
    LEFT JOIN LATERAL (
      SELECT t.from_status
        FROM transitions t
       WHERE t.case_id = ce.case_id
       ORDER BY t.ts, t.event_id
       LIMIT 1
    ) ft ON true
   WHERE ce.office_id = p.office
     AND ce.type = 'case_created'
     AND ce.legacy_id IS NULL
     AND c.legacy_id IS NULL
),
first_accept AS (
  SELECT en.case_id, MIN(en.ts) AS accepted_at
    FROM entries en
    CROSS JOIN p
   WHERE en.status = ANY(p.accepted_family)
   GROUP BY en.case_id
),
wins AS (
  SELECT fa.case_id, fa.accepted_at
    FROM first_accept fa
    CROSS JOIN p
   WHERE fa.accepted_at >= p.from_ts AND fa.accepted_at < p.to_ts
),
cohort AS (
  SELECT pr.case_id, pr.presented_at,
         EXISTS (
           SELECT 1
             FROM entries a
            WHERE a.case_id = pr.case_id
              AND a.status = ANY(p.accepted_family)
              AND a.ts >= pr.presented_at
              AND a.ts < p.to_ts
         ) AS accepted
    FROM (
      SELECT en.case_id, MIN(en.ts) AS presented_at
        FROM entries en
        CROSS JOIN p
       WHERE en.status = 'presented' AND en.ts >= p.from_ts AND en.ts < p.to_ts
       GROUP BY en.case_id
    ) pr
    CROSS JOIN p
)`;

/** The statements, by name. Each is PRELUDE + one SELECT; no SELECT *. */
const QUERIES = Object.freeze({
  /** Oldest reliable entry for the office — independent of the window. */
  coverage: `${PRELUDE}
SELECT MIN(en.ts) AS coverage_starts_at, COUNT(*)::int AS reliable_entries
  FROM entries en`,

  acceptance: `${PRELUDE}
SELECT COUNT(*)::int                                                   AS presented_cases,
       COUNT(*) FILTER (WHERE co.accepted)::int                         AS accepted_cases,
       COALESCE(SUM(c.case_value_cents), 0)::bigint                     AS presented_value_cents,
       COALESCE(SUM(c.case_value_cents) FILTER (WHERE co.accepted), 0)::bigint AS accepted_value_cents
  FROM cohort co
  CROSS JOIN p
  JOIN tc_cases c ON c.case_id = co.case_id AND c.office_id = p.office`,

  wins: `${PRELUDE}
SELECT COUNT(*)::int AS won_cases, COALESCE(SUM(c.case_value_cents), 0)::bigint AS won_value_cents
  FROM wins w
  CROSS JOIN p
  JOIN tc_cases c ON c.case_id = w.case_id AND c.office_id = p.office`,

  stages: `${PRELUDE},
stage_entry AS (
  SELECT en.case_id, en.status, MIN(en.ts) AS entered_at
    FROM entries en
    CROSS JOIN p
   WHERE en.ts >= p.from_ts AND en.ts < p.to_ts
     AND en.status = ANY(p.stage_rank[1:9])
   GROUP BY en.case_id, en.status
)
SELECT se.status,
       COUNT(*)::int AS entered,
       COUNT(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM entries x
          WHERE x.case_id = se.case_id
            AND x.ts > se.entered_at AND x.ts < p.to_ts
            AND array_position(p.stage_rank, x.status) > array_position(p.stage_rank, se.status)
       ))::int AS progressed,
       COUNT(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM entries x
          WHERE x.case_id = se.case_id
            AND x.ts > se.entered_at AND x.ts < p.to_ts
            AND x.status = 'lost'
       ))::int AS lost_after
  FROM stage_entry se
  CROSS JOIN p
 GROUP BY se.status`,

  timeInStage: `${PRELUDE},
stays AS (
  SELECT en.status, en.ts AS entered_at,
         LEAD(en.ts) OVER (PARTITION BY en.case_id ORDER BY en.ts, en.ord, en.event_id) AS left_at
    FROM entries en
)
SELECT s.status,
       COUNT(*) FILTER (WHERE s.left_at >= p.from_ts AND s.left_at < p.to_ts)::int AS completed_stays,
       COUNT(*) FILTER (WHERE s.entered_at < p.to_ts AND (s.left_at IS NULL OR s.left_at >= p.to_ts))::int AS open_stays,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (s.left_at - s.entered_at)) / 86400.0)
         FILTER (WHERE s.left_at >= p.from_ts AND s.left_at < p.to_ts) AS median_days,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (s.left_at - s.entered_at)) / 86400.0)
         FILTER (WHERE s.left_at >= p.from_ts AND s.left_at < p.to_ts) AS p90_days
  FROM stays s
  CROSS JOIN p
 WHERE s.status = ANY(p.stage_rank[1:9])
 GROUP BY s.status`,

  acceptedByWeek: `${PRELUDE},
weeks AS (
  SELECT generate_series(
           date_trunc('week', p.from_ts AT TIME ZONE p.tz),
           date_trunc('week', (p.to_ts - interval '1 microsecond') AT TIME ZONE p.tz),
           interval '1 week'
         ) AS week_start
    FROM p
   WHERE p.from_ts < p.to_ts
)
SELECT to_char(wk.week_start, 'YYYY-MM-DD') AS week_start,
       COUNT(w.case_id)::int AS won_cases,
       COALESCE(SUM(c.case_value_cents), 0)::bigint AS won_value_cents
  FROM weeks wk
  CROSS JOIN p
  LEFT JOIN wins w ON date_trunc('week', w.accepted_at AT TIME ZONE p.tz) = wk.week_start
  LEFT JOIN tc_cases c ON c.case_id = w.case_id AND c.office_id = p.office
 GROUP BY wk.week_start
 ORDER BY wk.week_start`,

  lostByReason: `${PRELUDE},
lost AS (
  SELECT DISTINCT en.case_id
    FROM entries en
    CROSS JOIN p
   WHERE en.status = 'lost' AND en.ts >= p.from_ts AND en.ts < p.to_ts
)
SELECT CASE WHEN c.status = 'lost' THEN c.lost_reason ELSE NULL END AS lost_reason,
       COUNT(*)::int AS lost_cases
  FROM lost l
  CROSS JOIN p
  JOIN tc_cases c ON c.case_id = l.case_id AND c.office_id = p.office
 GROUP BY 1`,

  byAssignedTc: `${PRELUDE}
SELECT c.assigned_tc AS name,
       COUNT(*)::int AS presented_cases,
       COUNT(*) FILTER (WHERE co.accepted)::int AS accepted_cases,
       COALESCE(SUM(c.case_value_cents) FILTER (WHERE co.accepted), 0)::bigint AS accepted_value_cents
  FROM cohort co
  CROSS JOIN p
  JOIN tc_cases c ON c.case_id = co.case_id AND c.office_id = p.office
 GROUP BY c.assigned_tc
 ORDER BY accepted_value_cents DESC, name`,

  byDoctor: `${PRELUDE}
SELECT c.doctor_name AS name,
       COUNT(*)::int AS presented_cases,
       COUNT(*) FILTER (WHERE co.accepted)::int AS accepted_cases,
       COALESCE(SUM(c.case_value_cents) FILTER (WHERE co.accepted), 0)::bigint AS accepted_value_cents
  FROM cohort co
  CROSS JOIN p
  JOIN tc_cases c ON c.case_id = co.case_id AND c.office_id = p.office
 GROUP BY c.doctor_name
 ORDER BY accepted_value_cents DESC, name`,

  nurtureReactivations: `${PRELUDE}
SELECT COUNT(*)::int AS reactivated_cases,
       COALESCE(SUM(c.case_value_cents), 0)::bigint AS reactivated_value_cents
  FROM wins w
  CROSS JOIN p
  JOIN tc_cases c ON c.case_id = w.case_id AND c.office_id = p.office
 WHERE EXISTS (
   SELECT 1
     FROM entries n
     JOIN entries o ON o.case_id = n.case_id
    WHERE n.case_id = w.case_id
      AND n.status = 'nurture'
      AND o.status = ANY(p.reactivation_open)
      AND o.ts > n.ts
      AND o.ts < w.accepted_at
 )`,
});

/** Window resolution: local calendar dates → instants, in the office time zone. */
const BOUNDS_SQL = `
SELECT to_char(b.from_d, 'YYYY-MM-DD') AS from_date,
       to_char(b.to_d, 'YYYY-MM-DD')   AS to_date,
       (b.from_d::timestamp AT TIME ZONE $1)       AS from_ts,
       ((b.to_d + 1)::timestamp AT TIME ZONE $1)   AS to_ts,
       (b.to_d - b.from_d + 1)::int                AS span_days
  FROM (
    SELECT t.to_d, COALESCE($2::date, t.to_d - ${DEFAULT_WINDOW_DAYS - 1}) AS from_d
      FROM (SELECT COALESCE($3::date, (now() AT TIME ZONE $1)::date) AS to_d) t
  ) b`;

/** The office time zone for calendar days and week buckets. */
function funnelTimeZone() {
  const tz = (process.env.OFFICE_TIMEZONE || '').trim();
  return /^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(tz) ? tz : 'America/Chicago';
}

/**
 * Validate `?from=&to=` (both optional, `YYYY-MM-DD`). Returns the parsed
 * dates or an error the route turns into a 400 — a malformed window is the
 * caller's mistake, never a 500.
 * @param {unknown} from
 * @param {unknown} to
 * @returns {{ ok: true, from: string|null, to: string|null } | { ok: false, code: string, error: string }}
 */
function parseWindowQuery(from, to) {
  const out = { from: null, to: null };
  for (const [key, raw] of [['from', from], ['to', to]]) {
    if (raw === undefined || raw === '') continue;
    if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      return { ok: false, code: 'INVALID_DATE', error: `${key} must be a date (YYYY-MM-DD)` };
    }
    const d = new Date(`${raw}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) {
      return { ok: false, code: 'INVALID_DATE', error: `${key} is not a real calendar date` };
    }
    out[key] = raw;
  }
  if (out.from && out.to && out.from > out.to) {
    return { ok: false, code: 'INVALID_RANGE', error: 'from must be on or before to' };
  }
  return { ok: true, ...out };
}

/** a/b as a one-decimal percentage, or null when b is 0 (never NaN, never 0%). */
function pct(a, b) {
  if (!b) return null;
  return Math.round((a / b) * 1000) / 10;
}

/** pg numeric/bigint → number (pg returns bigint as string). */
function n(v) {
  if (v == null) return 0;
  return typeof v === 'number' ? v : Number(v);
}

/** One-decimal day figure, or null. */
function days(v) {
  if (v == null) return null;
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? Math.round(x * 10) / 10 : null;
}

function iso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

/**
 * Compute the funnel for one office. Read-only: SELECTs only.
 * @param {{ query: (text: string, params: unknown[]) => Promise<{ rows: any[] }> }} db
 * @param {{ office: string, from: string|null, to: string|null, timeZone?: string }} opts
 */
async function computeFunnel(db, { office, from, to, timeZone = funnelTimeZone() }) {
  const bounds = (await db.query(BOUNDS_SQL, [timeZone, from, to])).rows[0];
  if (!bounds || n(bounds.span_days) < 1) {
    return { error: { code: 'INVALID_RANGE', message: 'from must be on or before to' } };
  }
  if (n(bounds.span_days) > MAX_WINDOW_DAYS) {
    return {
      error: { code: 'RANGE_TOO_LONG', message: `the window may span at most ${MAX_WINDOW_DAYS} days` },
    };
  }

  const requestedFromTs = new Date(bounds.from_ts);
  const toTs = new Date(bounds.to_ts);

  const coverageParams = [
    office,
    [...CASE_STATUSES],
    requestedFromTs.toISOString(),
    toTs.toISOString(),
    [...ACCEPTED_FAMILY],
    [...STAGE_RANK],
    timeZone,
    [...REACTIVATION_OPEN],
  ];
  const cov = (await db.query(QUERIES.coverage, coverageParams)).rows[0] || {};
  const coverageStartsAt = cov.coverage_starts_at ? new Date(cov.coverage_starts_at) : null;

  // Clamp the window to coverage. With no coverage at all, the window keeps
  // its requested start and every figure below comes back zero.
  const clamped = coverageStartsAt !== null && coverageStartsAt > requestedFromTs;
  const fromTs = clamped ? coverageStartsAt : requestedFromTs;
  const params = [...coverageParams];
  params[2] = fromTs.toISOString();

  // SEQUENTIAL, not Promise.all: nine statements at once would take nine of
  // the tenant pool's connections for one page load. They are small.
  const run = (text) => db.query(text, params);
  const acceptance = await run(QUERIES.acceptance);
  const wins = await run(QUERIES.wins);
  const stages = await run(QUERIES.stages);
  const timeInStage = await run(QUERIES.timeInStage);
  const weeks = await run(QUERIES.acceptedByWeek);
  const lost = await run(QUERIES.lostByReason);
  const byTc = await run(QUERIES.byAssignedTc);
  const byDoctor = await run(QUERIES.byDoctor);
  const nurture = await run(QUERIES.nurtureReactivations);

  return { funnel: shapeFunnel({ office, timeZone, bounds, fromTs, toTs, clamped, coverageStartsAt, cov, acceptance, wins, stages, timeInStage, weeks, lost, byTc, byDoctor, nurture }) };
}

/** Rows → the response body. Pure; exported for tests. */
function shapeFunnel({ office, timeZone, bounds, fromTs, toTs, clamped, coverageStartsAt, cov, acceptance, wins, stages, timeInStage, weeks, lost, byTc, byDoctor, nurture }) {
  const a = (acceptance && acceptance.rows[0]) || {};
  const presented = n(a.presented_cases);
  const accepted = n(a.accepted_cases);
  const presentedValue = n(a.presented_value_cents);
  const acceptedValue = n(a.accepted_value_cents);
  const w = (wins && wins.rows[0]) || {};

  const stageRows = new Map((stages ? stages.rows : []).map((r) => [r.status, r]));
  const timeRows = new Map((timeInStage ? timeInStage.rows : []).map((r) => [r.status, r]));

  const lostRows = lost ? lost.rows : [];
  const lostTotal = lostRows.reduce((s, r) => s + n(r.lost_cases), 0);
  const byReason = new Map(lostRows.map((r) => [r.lost_reason == null ? null : r.lost_reason, n(r.lost_cases)]));

  const person = (rows) =>
    rows.map((r) => ({
      name: r.name == null ? '' : String(r.name),
      presentedCases: n(r.presented_cases),
      acceptedCases: n(r.accepted_cases),
      acceptedValueCents: n(r.accepted_value_cents),
      acceptanceRatePercent: pct(n(r.accepted_cases), n(r.presented_cases)),
    }));

  const nr = (nurture && nurture.rows[0]) || {};
  const hasCoverage = coverageStartsAt !== null;

  return {
    office,
    timeZone,
    window: {
      requestedFrom: bounds.from_date,
      to: bounds.to_date,
      fromTs: fromTs.toISOString(),
      toTs: toTs.toISOString(),
      clampedToCoverage: clamped,
    },
    coverageStartsAt: hasCoverage ? iso(coverageStartsAt) : null,
    coverageNote: hasCoverage
      ? clamped
        ? 'Transition history starts here; the window was shortened to begin at the first reliably recorded status change.'
        : null
      : 'No reliably recorded status changes yet for this office — imported legacy history carries no from-status, so there is nothing to compute a funnel from.',
    reliableEntries: n(cov.reliable_entries),
    acceptance: {
      presentedCases: presented,
      acceptedCases: accepted,
      acceptanceRatePercent: pct(accepted, presented),
      presentedValueCents: presentedValue,
      acceptedValueCents: acceptedValue,
      valueAcceptanceRatePercent: pct(acceptedValue, presentedValue),
    },
    stages: BOARD_STAGES.map((status) => {
      const s = stageRows.get(status) || {};
      const t = timeRows.get(status) || {};
      const entered = n(s.entered);
      const progressed = n(s.progressed);
      return {
        status,
        entered,
        progressed,
        lostAfter: n(s.lost_after),
        conversionPercent: pct(progressed, entered),
        completedStays: n(t.completed_stays),
        openStays: n(t.open_stays),
        medianDays: days(t.median_days),
        p90Days: days(t.p90_days),
      };
    }),
    acceptedByWeek: (weeks ? weeks.rows : []).map((r) => ({
      weekStart: r.week_start,
      wonCases: n(r.won_cases),
      wonValueCents: n(r.won_value_cents),
    })),
    winLoss: {
      wonCases: n(w.won_cases),
      wonValueCents: n(w.won_value_cents),
      lostCases: lostTotal,
      winRatePercent: pct(n(w.won_cases), n(w.won_cases) + lostTotal),
      byLostReason: [...LOST_REASONS, null]
        .map((reason) => ({ reason, lostCases: byReason.get(reason) || 0 }))
        .filter((r) => r.lostCases > 0),
    },
    byAssignedTc: person(byTc ? byTc.rows : []),
    byDoctor: person(byDoctor ? byDoctor.rows : []),
    nurtureReactivations: {
      cases: n(nr.reactivated_cases),
      valueCents: n(nr.reactivated_value_cents),
    },
  };
}

module.exports = {
  TRANSITION_PATTERN,
  CASE_STATUSES,
  BOARD_STAGES,
  STAGE_RANK,
  ACCEPTED_FAMILY,
  REACTIVATION_OPEN,
  LOST_REASONS,
  MAX_WINDOW_DAYS,
  QUERIES,
  BOUNDS_SQL,
  funnelTimeZone,
  parseWindowQuery,
  computeFunnel,
  shapeFunnel,
  pct,
};

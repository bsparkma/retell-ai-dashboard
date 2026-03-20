/**
 * Analytics API Route
 *
 * Provides a GET /summary endpoint that computes call analytics KPIs,
 * call volume by source, intent breakdown, sentiment trend, and hourly
 * volume over a configurable date range.
 */

const express = require('express');
const router = express.Router();
const unifiedCallStore = require('../services/unifiedCallStore');

const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Format an hour number (0-23) as a display string like "8AM", "12PM", "1PM".
 */
function formatHour(hour) {
  if (hour === 0) return '12AM';
  if (hour < 12) return `${hour}AM`;
  if (hour === 12) return '12PM';
  return `${hour - 12}PM`;
}

/**
 * Build a map of date keys (short day name) for every day in the range,
 * so we can zero-fill days with no calls.
 * Returns an array of { key, date } ordered chronologically.
 */
function buildDateBuckets(startDate, endDate) {
  const buckets = [];
  const current = new Date(startDate);
  current.setHours(0, 0, 0, 0);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);

  while (current <= end) {
    const dayName = SHORT_DAYS[current.getDay()];
    const iso = current.toISOString().slice(0, 10);
    buckets.push({ key: dayName, iso });
    current.setDate(current.getDate() + 1);
  }
  return buckets;
}

/**
 * GET /summary
 *
 * Query params:
 *   days      — number of days to look back (default 7)
 *   office_id — optional office filter
 *
 * Returns KPIs, call volume by source, intent breakdown, sentiment trend,
 * and hourly volume for the requested period.
 */
router.get('/summary', async (req, res) => {
  try {
    const days = Math.max(1, parseInt(req.query.days, 10) || 7);
    const officeId = req.query.office_id || undefined;

    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - (days - 1));
    startDate.setHours(0, 0, 0, 0);

    const startIso = startDate.toISOString();
    const endIso = endDate.toISOString();

    // Fetch all calls in the window (use a high limit to get everything)
    const fetchOptions = {
      start_date: startIso,
      end_date: endIso,
      limit: 10000,
      offset: 0
    };
    if (officeId) {
      fetchOptions.office_id = officeId;
    }

    const { calls } = await unifiedCallStore.getCalls(fetchOptions);

    // ── Date buckets for zero-filling ──
    const dateBuckets = buildDateBuckets(startDate, endDate);

    // ── KPIs ──
    const totalCalls = calls.length;
    let aiHandled = 0;
    let staffHandled = 0;
    let totalDuration = 0;
    let emergencyCalls = 0;
    let missedCalls = 0;

    // ── Accumulators ──
    // callVolume: iso -> { retell, mango }
    const volumeByDate = {};
    // sentimentTrend: iso -> { positive, neutral, negative }
    const sentimentByDate = {};
    // intentBreakdown: intentName -> count
    const intentCounts = {};
    // hourlyVolume: hour (0-23) -> count
    const hourlyCounts = {};

    // Initialise zero-fill structures
    for (const bucket of dateBuckets) {
      volumeByDate[bucket.iso] = { retell: 0, mango: 0 };
      sentimentByDate[bucket.iso] = { positive: 0, neutral: 0, negative: 0 };
    }
    for (let h = 0; h < 24; h++) {
      hourlyCounts[h] = 0;
    }

    // ── Process each call ──
    for (const call of calls) {
      // Source counting
      if (call.source === 'retell') {
        aiHandled++;
      } else {
        staffHandled++;
      }

      // Duration
      if (typeof call.duration_seconds === 'number') {
        totalDuration += call.duration_seconds;
      }

      // Emergency detection
      const meta = call.metadata || {};
      if (
        meta.is_emergency === true ||
        meta.is_emergency === 'true' ||
        (typeof call.call_summary === 'string' &&
          call.call_summary.toLowerCase().includes('emergency'))
      ) {
        emergencyCalls++;
      }

      // Missed call detection
      if (
        meta.outcome === 'missed' ||
        meta.missed === true ||
        (typeof call.duration_seconds === 'number' && call.duration_seconds === 0)
      ) {
        missedCalls++;
      }

      // Parse call date
      const callDate = new Date(call.call_date);
      const dateIso = callDate.toISOString().slice(0, 10);
      const hour = callDate.getHours();

      // Call volume by date and source
      if (volumeByDate[dateIso]) {
        if (call.source === 'retell') {
          volumeByDate[dateIso].retell++;
        } else {
          volumeByDate[dateIso].mango++;
        }
      }

      // Sentiment by date
      const sentiment = (call.sentiment || 'neutral').toLowerCase();
      if (sentimentByDate[dateIso]) {
        if (sentiment === 'positive') {
          sentimentByDate[dateIso].positive++;
        } else if (sentiment === 'negative') {
          sentimentByDate[dateIso].negative++;
        } else {
          sentimentByDate[dateIso].neutral++;
        }
      }

      // Intent breakdown
      const intent = (meta.intent) ? meta.intent : 'General';
      intentCounts[intent] = (intentCounts[intent] || 0) + 1;

      // Hourly volume
      hourlyCounts[hour] = (hourlyCounts[hour] || 0) + 1;
    }

    // ── Build response arrays ──
    const callVolume = dateBuckets.map((b) => ({
      date: b.key,
      retell: volumeByDate[b.iso].retell,
      mango: volumeByDate[b.iso].mango
    }));

    const sentimentTrend = dateBuckets.map((b) => ({
      date: b.key,
      positive: sentimentByDate[b.iso].positive,
      neutral: sentimentByDate[b.iso].neutral,
      negative: sentimentByDate[b.iso].negative
    }));

    const intentBreakdown = Object.entries(intentCounts)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);

    const hourlyVolume = [];
    for (let h = 0; h < 24; h++) {
      hourlyVolume.push({
        hour: formatHour(h),
        calls: hourlyCounts[h]
      });
    }

    const avgDurationSec = totalCalls > 0
      ? Math.round(totalDuration / totalCalls)
      : 0;

    const aiHandledPct = totalCalls > 0
      ? Math.round((aiHandled / totalCalls) * 100)
      : 0;

    res.json({
      success: true,
      period: {
        days,
        startDate: startIso,
        endDate: endIso
      },
      kpis: {
        totalCalls,
        aiHandled,
        staffHandled,
        aiHandledPct,
        avgDurationSec,
        emergencyCalls,
        missedCalls
      },
      callVolume,
      intentBreakdown,
      sentimentTrend,
      hourlyVolume
    });
  } catch (err) {
    console.error('[Analytics] Error computing summary:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to compute analytics summary',
      code: 'ANALYTICS_ERROR'
    });
  }
});

module.exports = router;

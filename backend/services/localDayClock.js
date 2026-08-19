'use strict';

/**
 * The accounting day, in an office's LOCAL timezone.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * Three daily cost rails need the same two answers — "which day is it?" and
 * "when does that day end?" — and all three had their own copy:
 *
 *   services/transcriptionService.js   (voice, Azure Speech minutes)
 *   services/rcm/extractionBudget.js   (RCM, Azure OpenAI tokens)
 *   services/rcm/ocrBudget.js          (RCM, Document Intelligence pages)
 *
 * Each copy was tested, so nothing was broken. What was wrong is that a future
 * DST or timezone fix had three places to land and no way to know it, and the
 * copies had already begun to drift in their surrounding code. This is the one
 * implementation; each rail keeps its own counters, cap, persistence and env
 * names, because those genuinely differ.
 *
 * **`transcriptionService.js` still has its own copy** — it is on the voice
 * path, and moving it in an RCM change would put a live PHI-adjacent rail's
 * blast radius inside a billing slice's review. That is a main-line follow-up:
 * replace `_todayKey`/`nextBudgetResetIso` there with these two functions.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY LOCAL AND NOT UTC
 * ─────────────────────────────────────────────────────────────────────────────
 * UTC midnight is early evening in Central. A UTC-keyed counter therefore rolls
 * the budget MID-SHIFT and spends tomorrow's money on tonight's work — which is
 * exactly the failure the voice rail was rebuilt to close.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY Intl AND NOT AN OFFSET
 * ─────────────────────────────────────────────────────────────────────────────
 * A fixed -5/-6 is wrong half the year. `Intl` carries the zone database, so
 * the day boundary follows DST without anyone maintaining a table.
 */

/**
 * The local day as `YYYY-MM-DD`.
 *
 * `en-CA` is used because it formats as `YYYY-MM-DD` natively — the key is
 * compared and persisted as a string, so a locale that emits `19/08/2026` would
 * sort wrongly and read wrongly in the state file.
 *
 * @param {string} timeZone IANA zone, e.g. 'America/Chicago'
 * @param {Date} [now] injectable for tests
 * @returns {string}
 */
function localDayKey(timeZone, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * The instant the local day next rolls over — the NEXT midnight in `timeZone`.
 *
 * THE ALGORITHM, AND WHY IT ITERATES. Jump forward by the remaining wall-clock
 * seconds of the local day, then re-read the local time at that instant and
 * correct. On an ordinary day one pass lands exactly on 00:00:00. On a
 * spring-forward day the naive jump overshoots to 01:00 and on a fall-back day
 * it undershoots to 23:00 the previous day; the correction pulls it back to
 * midnight either way. Two corrections are always enough — the third iteration
 * is a backstop, not a routine step.
 *
 * Ported from `transcriptionService.nextBudgetResetIso`, which is where the DST
 * behaviour was first got right.
 *
 * @param {string} timeZone IANA zone
 * @param {Date} [now] injectable for tests
 * @returns {string} ISO-8601
 */
function nextLocalMidnightIso(timeZone, now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const localSeconds = (d) => {
    const [h, m, s] = fmt.format(d).split(':').map(Number);
    return h * 3600 + m * 60 + s;
  };
  const DAY = 24 * 3600;
  let ms = now.getTime() + (DAY - localSeconds(now)) * 1000;
  for (let i = 0; i < 3; i++) {
    const off = localSeconds(new Date(ms));
    if (off === 0) break;
    ms += (off > DAY / 2 ? DAY - off : -off) * 1000;
  }
  return new Date(ms).toISOString();
}

module.exports = { localDayKey, nextLocalMidnightIso };

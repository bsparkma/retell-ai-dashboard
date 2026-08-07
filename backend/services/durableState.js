/**
 * Durable operational state — tiny JSON docs that must survive a container restart.
 *
 * Used for small, high-frequency-read / low-frequency-write counters that are NOT call
 * data: the Mango ingestion watermark and the daily transcription-budget accounting.
 * Both were previously in-memory only, which meant a restart silently reset them
 * (diagnosis H11: a mid-day restart hands back a fresh 120 audio-minutes).
 *
 * LOCATION: the same directory the unified call store uses — CALLSTORE_DIR when set
 * (prod: /data, the AzureFile volume), otherwise <app>/data next to the code.
 *
 * DEGRADES GRACEFULLY: staging has no /data volume. If the directory cannot be created
 * or written, this falls back to in-memory state and logs ONE line saying so. It must
 * never throw out of a read/write and never block startup.
 *
 * Reads/writes are synchronous on purpose: callers (the circuit breaker) are synchronous
 * and the docs are a few hundred bytes. Writes are atomic (tmp file + rename).
 */

const fs = require('fs');
const path = require('path');

/** Directory small state docs live in. Resolved lazily so tests can point CALLSTORE_DIR. */
function stateDir() {
  return process.env.CALLSTORE_DIR
    ? process.env.CALLSTORE_DIR
    : path.join(__dirname, '../../data');
}

class DurableState {
  /**
   * @param {string} filename  e.g. 'mango_ingestion_watermark.json'
   * @param {object} defaults  the doc returned when nothing has been persisted yet
   */
  constructor(filename, defaults = {}) {
    this.filename = filename;
    this.defaults = defaults;
    this.durable = null;   // null = not probed yet; true = on disk; false = memory only
    this._memory = null;   // in-memory doc, used both as cache and as the fallback store
    this._warned = false;
  }

  /** Absolute path of the doc. Recomputed each call so CALLSTORE_DIR changes are honored. */
  get filePath() {
    return path.join(stateDir(), this.filename);
  }

  /** Forget cached state (tests only — lets a suite re-point CALLSTORE_DIR). */
  reset() {
    this.durable = null;
    this._memory = null;
    this._warned = false;
  }

  /** Log the "no durable volume" line at most once per process. */
  _degrade(reason) {
    this.durable = false;
    if (!this._warned) {
      this._warned = true;
      console.warn(
        `⚠️ Durable state '${this.filename}' is IN-MEMORY ONLY (${reason}). ` +
        'It will reset on restart. Set CALLSTORE_DIR to a mounted volume (prod uses /data) to persist it.'
      );
    }
  }

  /**
   * Read the doc. Returns a shallow copy merged over the defaults — never null, never throws.
   * @returns {object}
   */
  read() {
    if (this._memory) return { ...this._memory };

    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      let parsed = null;
      try {
        parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      } catch (e) {
        // ENOENT is the normal cold start; anything else means a corrupt doc we discard.
        if (e.code !== 'ENOENT') {
          console.warn(`⚠️ Durable state '${this.filename}' unreadable (${e.message}) — starting fresh.`);
        }
      }
      this.durable = true;
      this._memory = { ...this.defaults, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
    } catch (e) {
      this._degrade(e.message);
      this._memory = { ...this.defaults };
    }

    return { ...this._memory };
  }

  /**
   * Persist the doc (atomic tmp + rename). Best-effort: a write failure degrades this
   * instance to in-memory rather than propagating. Always updates the in-memory copy.
   * @param {object} doc
   */
  write(doc) {
    // Probe the directory BEFORE caching, or the cache short-circuits read()'s probe.
    if (this.durable === null) this.read();

    const next = { ...doc, updated_at: new Date().toISOString() };
    this._memory = { ...next };

    if (this.durable === false) return next; // memory-only mode; nothing more to do

    const tmp = `${this.filePath}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(next), 'utf-8');
      fs.renameSync(tmp, this.filePath);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      this._degrade(e.message);
    }
    return next;
  }
}

module.exports = { DurableState, stateDir };

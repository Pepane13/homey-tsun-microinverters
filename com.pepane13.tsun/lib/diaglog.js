'use strict';

/**
 * Diagnostic log shared by all devices of the app.
 * - Ring buffer of the most recent entries, persisted in the app settings so it survives restarts.
 * - Four levels: error < warn < info < debug. Entries below the configured level are dropped.
 * - Writes to the settings store are throttled to limit flash wear.
 */

const LEVELS = ['error', 'warn', 'info', 'debug'];
const STORE_KEY = 'diag_log';
const LEVEL_KEY = 'log_level';
const DEFAULT_LEVEL = 'info';
const MAX_ENTRIES = 1500;
const PERSIST_DELAY_MS = 60 * 1000;

class DiagLog {
  /**
   * @param {object} homey Homey app instance (`this.homey` of the App)
   * @param {object} [opts]
   * @param {(...args) => void} [opts.log] console logger (App.log)
   */
  constructor(homey, { log } = {}) {
    this.homey = homey;
    this.consoleLog = log || (() => {});
    this.timer = null;
    this.dirty = false;
    const stored = homey.settings.get(STORE_KEY);
    this.entries = Array.isArray(stored) ? stored.slice(-MAX_ENTRIES) : [];
  }

  static get LEVELS() { return LEVELS; }

  get level() {
    const l = this.homey.settings.get(LEVEL_KEY);
    return LEVELS.includes(l) ? l : DEFAULT_LEVEL;
  }

  enabled(level) {
    return LEVELS.indexOf(level) <= LEVELS.indexOf(this.level);
  }

  /**
   * Adds an entry.
   * @param {string} level error | warn | info | debug
   * @param {string} source device name (or 'app')
   * @param {string} category comm | panel | grid | inverter | energy | day | app
   * @param {string} message human-readable message (already translated)
   */
  add(level, source, category, message) {
    if (!this.enabled(level)) return;
    const entry = { t: new Date().toISOString(), l: level, s: source, c: category, m: message };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    if (level === 'error' || level === 'warn') this.consoleLog(`[${level}] ${source}: ${message}`);
    this._schedulePersist(level === 'error' ? 5000 : PERSIST_DELAY_MS);
  }

  /** Entries at or above the given level, newest last. */
  get(level = 'debug', limit = MAX_ENTRIES) {
    const max = LEVELS.indexOf(LEVELS.includes(level) ? level : 'debug');
    return this.entries.filter((e) => LEVELS.indexOf(e.l) <= max).slice(-limit);
  }

  clear() {
    this.entries = [];
    this._persistNow();
  }

  _schedulePersist(delay) {
    this.dirty = true;
    if (this.timer) return;
    this.timer = this.homey.setTimeout(() => this._persistNow(), delay);
  }

  _persistNow() {
    if (this.timer) this.homey.clearTimeout(this.timer);
    this.timer = null;
    this.dirty = false;
    try {
      this.homey.settings.set(STORE_KEY, this.entries);
    } catch (err) {
      this.consoleLog('Diagnostic log persist failed:', err.message);
    }
  }

  /** Flushes pending entries (call from App.onUninit). */
  flush() {
    if (this.dirty) this._persistNow();
  }
}

module.exports = { DiagLog, LEVELS };

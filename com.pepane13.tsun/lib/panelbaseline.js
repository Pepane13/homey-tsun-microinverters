'use strict';

/**
 * Learned production profile of each panel (pure logic, no Homey dependency).
 *
 * Intraday: the day is split into 15-minute slots (local time). For each slot and panel the
 * baseline keeps the panel's usual share of production, expressed as its power divided by the
 * mean power of all panels (1.00 = average, 0.70 = usually 30 % below average at that time,
 * e.g. because of a shadow). The share is an exponential moving average, so it follows the
 * slow seasonal change of the sun path. A slot is "ready" once it has been learned on enough
 * distinct days.
 *
 * Daily: the usual share of each panel in the daily yield, used to detect slow degradation.
 */

const SLOT_MIN = 15;
const SLOTS = (24 * 60) / SLOT_MIN;
const MIN_DAYS = 3; // a slot is used for alerts once learned on 3 different days
const ALPHA_MIN = 0.01; // intraday EMA: ~100 samples (~3 days of a slot at 30 s polling)
const DAILY_MIN_DAYS = 7; // daily degradation check starts after 7 learned days
const DAILY_ALPHA_MIN = 0.05; // daily EMA: ~20 days

class PanelBaseline {
  /**
   * @param {number} panels number of panels
   * @param {object} [data] previously saved data (toJSON())
   */
  constructor(panels, data) {
    this.panels = panels;
    this.reset();
    if (data && data.v === 1 && Array.isArray(data.slots) && data.slots.length === SLOTS) {
      this.slots = data.slots;
      if (data.daily && Array.isArray(data.daily.share) && data.daily.share.length === panels) this.daily = data.daily;
      this.since = data.since || null;
    }
  }

  static get SLOT_MIN() { return SLOT_MIN; }
  static get MIN_DAYS() { return MIN_DAYS; }
  static get DAILY_MIN_DAYS() { return DAILY_MIN_DAYS; }

  reset() {
    // slots[s] = null | { r: [share per panel], n: samples, days: distinct days, last: 'YYYY-MM-DD' }
    this.slots = Array.from({ length: SLOTS }, () => null);
    this.daily = { share: Array(this.panels).fill(1), days: 0 };
    this.since = null;
  }

  /** Slot index (0..95) for a date, in the given time zone. */
  static slotOf(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(date));
    const h = Number(parts.find((p) => p.type === 'hour').value);
    const m = Number(parts.find((p) => p.type === 'minute').value);
    return Math.floor((h * 60 + m) / SLOT_MIN);
  }

  /** Current shares (power / mean of all panels), or null if the mean is zero. */
  static shares(powers) {
    const mean = powers.reduce((s, p) => s + p, 0) / powers.length;
    return mean > 0 ? powers.map((p) => p / mean) : null;
  }

  /**
   * Learns one sample.
   * @param {number} slot
   * @param {number[]} powers
   * @param {string} day YYYY-MM-DD
   * @param {boolean[]} [skip] panels not to learn (anomaly in progress)
   */
  learn(slot, powers, day, skip = []) {
    const sh = PanelBaseline.shares(powers);
    if (!sh) return;
    let e = this.slots[slot];
    if (!e) {
      // A panel skipped on the very first sample (anomaly) stays unknown (null) until a sound sample
      e = { r: sh.map((x, i) => (skip[i] ? null : x)), n: 0, days: 0, last: null };
      this.slots[slot] = e;
    }
    e.n += 1;
    const alpha = Math.max(1 / e.n, ALPHA_MIN);
    for (let i = 0; i < this.panels; i++) {
      if (skip[i]) continue;
      if (e.r[i] === null) e.r[i] = sh[i];
      else e.r[i] += alpha * (sh[i] - e.r[i]);
    }
    if (e.last !== day) { e.days += 1; e.last = day; }
    if (!this.since) this.since = day;
  }

  /** True if the slot has been learned on enough distinct days. */
  ready(slot) {
    const e = this.slots[slot];
    return !!e && e.days >= MIN_DAYS;
  }

  /**
   * Expected share of each panel for a slot, falling back to the neighbouring slots
   * (±15 min) when the slot itself is not ready yet. Null if nothing usable; a panel whose
   * share is still unknown is null in the array.
   * @returns {(number|null)[]|null}
   */
  expected(slot) {
    if (this.ready(slot)) return this.slots[slot].r.slice();
    const near = [slot - 1, slot + 1].filter((s) => s >= 0 && s < SLOTS && this.ready(s));
    if (!near.length) return null;
    return Array.from({ length: this.panels }, (_, i) => {
      const vals = near.map((s) => this.slots[s].r[i]).filter((v) => v !== null);
      return vals.length ? vals.reduce((a, v) => a + v, 0) / vals.length : null;
    });
  }

  /**
   * Daily check and learning (call once per day with yesterday's yield per panel).
   * @param {number[]} energies kWh per panel
   * @param {number} thresholdPct alert when a panel is this much below its usual share
   * @returns {{ ready: boolean, deviations: (number|null)[], expectedShare: number[], learned: boolean[] }}
   */
  checkDay(energies, thresholdPct) {
    const sh = PanelBaseline.shares(energies);
    const d = this.daily;
    const ready = d.days >= DAILY_MIN_DAYS;
    const expectedShare = d.share.slice();
    const deviations = sh ? sh.map((s, i) => (ready && expectedShare[i] > 0 ? ((s - expectedShare[i]) / expectedShare[i]) * 100 : null)) : [];
    const learned = Array(this.panels).fill(false);
    if (!sh) return { ready, deviations, expectedShare, learned };
    d.days += 1;
    const alpha = Math.max(1 / d.days, DAILY_ALPHA_MIN);
    for (let i = 0; i < this.panels; i++) {
      const anomalous = deviations[i] !== null && deviations[i] <= -thresholdPct;
      if (!anomalous) { d.share[i] += alpha * (sh[i] - d.share[i]); learned[i] = true; }
    }
    return { ready, deviations, expectedShare, learned };
  }

  /** Summary for the diagnostic page and report: hourly average share per panel. */
  summary() {
    const learnedSlots = this.slots.filter(Boolean).length;
    const readySlots = this.slots.filter((e) => e && e.days >= MIN_DAYS).length;
    const hours = [];
    for (let h = 0; h < 24; h++) {
      const es = this.slots.slice(h * 4, h * 4 + 4).filter(Boolean);
      if (!es.length) continue;
      const ratios = Array.from({ length: this.panels }, (_, i) => {
        const vals = es.map((e) => e.r[i]).filter((v) => v !== null);
        return vals.length ? Math.round((100 * vals.reduce((s, v) => s + v, 0)) / vals.length) : null;
      });
      hours.push({ hour: h, ratios, ready: es.every((e) => e.days >= MIN_DAYS), days: Math.min(...es.map((e) => e.days)) });
    }
    return {
      since: this.since,
      learnedSlots,
      readySlots,
      hours,
      daily: { days: this.daily.days, ready: this.daily.days >= DAILY_MIN_DAYS, share: this.daily.share.map((s) => Math.round(s * 100)) },
    };
  }

  toJSON() {
    const round = (x) => Math.round(x * 10000) / 10000;
    return {
      v: 1,
      since: this.since,
      slots: this.slots.map((e) => (e ? { ...e, r: e.r.map((x) => (x === null ? null : round(x))) } : null)),
      daily: { share: this.daily.share.map(round), days: this.daily.days },
    };
  }
}

module.exports = { PanelBaseline };

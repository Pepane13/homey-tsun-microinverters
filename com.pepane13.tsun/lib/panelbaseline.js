'use strict';

/**
 * Learned production profile of each panel (pure logic, no Homey dependency).
 *
 * Intraday: the day is split into 15-minute slots of SOLAR time (UTC), so that summer/winter
 * time changes do not shift the learned shadows by one hour. For each slot and panel the
 * baseline keeps the panel's usual share of production, expressed as its power divided by the
 * power of the best panel at that moment (1.00 = full sun, 0.10 = usually in deep shade at that
 * time). Being relative to the best panel, a panel's share does not depend on how many other
 * panels are shaded. The share is an exponential moving average, so it follows the seasonal
 * drift of the shadows.
 *
 * Only sunny moments are learned and checked: shadows only exist in direct sun, and an overcast
 * sky makes all panels equal. A moment is sunny when the best panel produces at least 60 % of
 * the slot's recent peak (decaying maximum).
 *
 * Daily: the usual share of each panel in the daily yield, used to detect slow degradation.
 */

const SLOT_MIN = 15;
const SLOTS = (24 * 60) / SLOT_MIN;
const MIN_DAYS = 3; // a slot is used for alerts once learned on 3 different sunny days
const ALPHA_MIN = 0.01; // intraday EMA: ~100 samples (~3 days of a slot at 30 s polling)
const TOLERANCE_SLOTS = 2; // shadows move from day to day: ±30 min tolerance on the expected share
const SUNNY_RATIO = 0.6; // best panel >= 60 % of the slot peak: direct sun
const PEAK_DECAY = 0.95; // slot peak lowered by 5 % per new day (follows the season)
const PEAK_JUMP = 1.5; // first real sun after learning in cloudy conditions: the slot restarts
const DAILY_MIN_DAYS = 7; // daily degradation check starts after 7 learned days
const DAILY_ALPHA_MIN = 0.05; // daily EMA: ~20 days
const VERSION = 2; // v1: local time, shares relative to the mean (intraday part discarded)

class PanelBaseline {
  /**
   * @param {number} panels number of panels
   * @param {object} [data] previously saved data (toJSON())
   */
  constructor(panels, data) {
    this.panels = panels;
    this.reset();
    this.migrated = false;
    if (!data) return;
    if (data.daily && Array.isArray(data.daily.share) && data.daily.share.length === panels) this.daily = data.daily;
    if (data.v === VERSION && Array.isArray(data.slots) && data.slots.length === SLOTS) {
      this.slots = data.slots;
      this.since = data.since || null;
    } else if (data.v === 1) {
      this.migrated = true; // intraday profile restarts (solar time, new share definition); daily kept
    }
  }

  static get SLOT_MIN() { return SLOT_MIN; }
  static get MIN_DAYS() { return MIN_DAYS; }
  static get DAILY_MIN_DAYS() { return DAILY_MIN_DAYS; }

  reset() {
    // slots[s] = null | { r: [share per panel], n, days, last: 'YYYY-MM-DD', peak: W }
    this.slots = Array.from({ length: SLOTS }, () => null);
    this.daily = { share: Array(this.panels).fill(1), days: 0 };
    this.since = null;
  }

  /** Slot index (0..95) in solar time (UTC). The time zone argument is ignored (kept for compatibility). */
  static slotOf(date) {
    const minutes = Math.floor(new Date(date).getTime() / 60000);
    return Math.floor((((minutes % 1440) + 1440) % 1440) / SLOT_MIN);
  }

  /** Shares relative to the mean of all panels (daily check), or null if the mean is zero. */
  static shares(powers) {
    const mean = powers.reduce((s, p) => s + p, 0) / powers.length;
    return mean > 0 ? powers.map((p) => p / mean) : null;
  }

  /** Shares relative to the best panel (intraday profile), or null if all panels are at zero. */
  static sharesOfBest(powers) {
    const best = Math.max(...powers);
    return best > 0 ? powers.map((p) => p / best) : null;
  }

  /** True if the best panel is in direct sun for this slot (or the slot has no reference yet). */
  sunny(slot, powers) {
    const e = this.slots[slot];
    const best = Math.max(...powers);
    return !e || !e.peak || best >= SUNNY_RATIO * e.peak;
  }

  /**
   * Learns one sample (sunny moments only).
   * @param {number} slot
   * @param {number[]} powers
   * @param {string} day YYYY-MM-DD
   * @param {boolean[]} [skip] panels not to learn (anomaly in progress)
   * @returns {boolean} true if the sample was learned
   */
  learn(slot, powers, day, skip = []) {
    const sh = PanelBaseline.sharesOfBest(powers);
    if (!sh) return false;
    const best = Math.max(...powers);
    let e = this.slots[slot];
    if (e) {
      if (e.peakDay !== day && e.peak) { e.peak *= PEAK_DECAY; e.peakDay = day; } // once per day
      if (e.peak && best > PEAK_JUMP * e.peak) e = null; // learned under clouds only: restart in real sun
    }
    if (!e) {
      // A panel skipped on the very first sample (anomaly) stays unknown (null) until a sound sample
      e = { r: sh.map((x, i) => (skip[i] ? null : x)), n: 0, days: 0, last: null, peak: best, peakDay: day };
      this.slots[slot] = e;
    }
    if (best > (e.peak || 0)) e.peak = best;
    if (best < SUNNY_RATIO * e.peak) return false; // cloudy moment: not learned
    e.n += 1;
    const alpha = Math.max(1 / e.n, ALPHA_MIN);
    for (let i = 0; i < this.panels; i++) {
      if (skip[i]) continue;
      if (e.r[i] === null) e.r[i] = sh[i];
      else e.r[i] += alpha * (sh[i] - e.r[i]);
    }
    if (e.last !== day) { e.days += 1; e.last = day; }
    if (!this.since) this.since = day;
    return true;
  }

  /** True if the slot has been learned on enough distinct sunny days. */
  ready(slot) {
    const e = this.slots[slot];
    return !!e && e.days >= MIN_DAYS;
  }

  /**
   * Expected share of each panel (relative to the best panel) for a slot. Shadows move a few
   * minutes from day to day (and with the seasons), so the lowest share of the ready slots within
   * ±30 min is used: a shadow arriving or leaving up to 30 min off its usual time is not reported. Null if nothing usable, or if it is not sunny now (powers given and below the slot
   * peak): no comparison under clouds. A panel whose share is still unknown is null.
   * @param {number} slot
   * @param {number[]} [powers] current powers, to skip cloudy moments
   * @returns {(number|null)[]|null}
   */
  expected(slot, powers) {
    if (powers && !this.sunny(slot, powers)) return null;
    const near = [];
    for (let k = -TOLERANCE_SLOTS; k <= TOLERANCE_SLOTS; k++) {
      const s = (slot + k + SLOTS) % SLOTS;
      if (this.ready(s)) near.push(s);
    }
    if (!near.length) return null;
    return Array.from({ length: this.panels }, (_, i) => {
      const vals = near.map((s) => this.slots[s].r[i]).filter((v) => v !== null);
      return vals.length ? Math.min(...vals) : null;
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

  /**
   * Summary for the diagnostic page and report: hourly average share per panel (100 % = like the
   * best panel), by LOCAL hour.
   * @param {number} [offsetMin] current offset of the local time from UTC, in minutes
   */
  summary(offsetMin = 0) {
    const learnedSlots = this.slots.filter(Boolean).length;
    const readySlots = this.slots.filter((e) => e && e.days >= MIN_DAYS).length;
    const hours = [];
    for (let h = 0; h < 24; h++) {
      const first = Math.round((((h * 60 - offsetMin) % 1440) + 1440) % 1440 / SLOT_MIN);
      const es = [0, 1, 2, 3].map((k) => this.slots[(first + k) % SLOTS]).filter(Boolean);
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
      v: VERSION,
      since: this.since,
      slots: this.slots.map((e) => (e ? {
        ...e, r: e.r.map((x) => (x === null ? null : round(x))), peak: e.peak ? Math.round(e.peak * 10) / 10 : e.peak,
      } : null)),
      daily: { share: this.daily.share.map(round), days: this.daily.days },
    };
  }
}

module.exports = { PanelBaseline };

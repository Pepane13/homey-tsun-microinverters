'use strict';

/**
 * Solar production forecast (pure logic, no Homey dependency).
 *
 * Input: an hourly weather forecast of the global tilted irradiance (GTI, W/m², mean over the
 * hour) on the plane of the panels, and the air temperature (Open-Meteo, see lib/openmeteo.js).
 *
 * Raw model, per hour:  E_raw = GTI / 1000 × peak power (kWp) × 0.85 × temperature factor
 *
 * Calibration on the installation's own production: after each hour, the energy actually
 * produced is compared with the raw model for that hour. The app learns, for each hour of the
 * day, a correction factor = moving average of the measured energy / moving average of the raw
 * energy (ratio of averages, so sunny hours weigh more than dull ones). It absorbs everything
 * the weather model does not know: real peak power and losses, recurring shadows, orientation
 * approximations, systematic bias of the weather model at that hour. While an hour has been
 * learned on fewer than 7 days, its factor is blended with the global factor (all hours).
 *
 * Hours are UTC hours (the weather series is hourly in UTC); the factor of an hour is indexed
 * by the local hour of its start, so it follows the user's day. The AC output is capped at the
 * inverter rated power.
 */

const HOUR_MS = 3600 * 1000;
const PR0 = 0.85; // initial performance ratio (wiring, inverter, dirt) before any calibration
const TEMP_COEF = -0.004; // power temperature coefficient of crystalline panels, per °C
const CELL_RISE = 0.03; // cell temperature rise above the air, °C per W/m² (about 30 °C at 1000 W/m²)
const HOUR_ALPHA_MIN = 0.1; // per-hour moving average: about 10 days, follows the seasons
const GLOBAL_ALPHA_MIN = 0.02; // global moving average: about 50 hourly samples (5 sunny days)
const HOUR_FULL_DAYS = 7; // an hour's own factor is fully trusted after 7 learned days
const LEARN_MIN_FRACTION = 0.03; // hours below 3 % of the peak power are not learned (dawn, dusk)
const CLIP_MARGIN = 0.95; // hours close to the inverter limit are not learned (clipping)
const RATIO_MIN = 0.02; // measured / raw below this: fault, snow or outage, not learned
const RATIO_MAX = 4; // measured / raw above this: inconsistent sample, not learned
const FACTOR_MIN = 0.1;
const FACTOR_MAX = 2.5;
const ACCURACY_MIN_KWH = 1; // day-ahead accuracy only on days with at least 1 kWh
const ACCURACY_ALPHA_MIN = 0.1; // day-ahead error moving average: about 10 days
const SERIES_MAX_AGE_MS = 2 * 24 * HOUR_MS; // forecast entries older than this are dropped

const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const formatters = new Map(); // one formatter per time zone (creating one is costly)

/** Local date (YYYY-MM-DD), hour and minute of the day for a timestamp in a time zone. */
function localParts(t, timeZone) {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    formatters.set(timeZone, fmt);
  }
  const parts = fmt.formatToParts(new Date(t));
  const g = (type) => parts.find((p) => p.type === type).value;
  const hour = Number(g('hour'));
  const minute = Number(g('minute'));
  return { day: `${g('year')}-${g('month')}-${g('day')}`, hour, minute: hour * 60 + minute };
}

/** Next calendar day of a YYYY-MM-DD key. */
function nextDay(day) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** 'HH:mm' -> minutes of the day; '24:00' and '00:00' as an end time mean the end of the day. */
function parseTime(s, isEnd = false) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(s));
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  if (v > 24 * 60) return null;
  if (isEnd && (v === 0 || v === 24 * 60)) return 24 * 60;
  return v;
}

function emptyHour() {
  return { a: 0, r: 0, n: 0, days: 0, last: null };
}

class SolarForecast {
  /** @param {object} [data] previously saved data (toJSON()) */
  constructor(data) {
    this.reset();
    if (data && data.v === 1) {
      if (Array.isArray(data.hours) && data.hours.length === 24) this.hours = data.hours.map((h) => ({ ...emptyHour(), ...h }));
      if (data.global) this.global = { ...this.global, ...data.global };
      if (data.accuracy) this.accuracy = { ...this.accuracy, ...data.accuracy };
      if (data.dayAhead && typeof data.dayAhead === 'object') this.dayAhead = { ...data.dayAhead };
      if (Array.isArray(data.series)) this.series = data.series.filter((e) => e && typeof e.t === 'number');
      this.fetchedAt = data.fetchedAt || null;
      this.since = data.since || null;
    }
  }

  static get HOUR_MS() { return HOUR_MS; }
  static get HOUR_FULL_DAYS() { return HOUR_FULL_DAYS; }

  reset() {
    this.resetCalibration();
    this.series = []; // [{ t: start of the UTC hour (ms), gti: W/m² mean over the hour, temp: °C }]
    this.fetchedAt = null;
    this.dayAhead = {}; // { 'YYYY-MM-DD': kWh forecast the day before }
    this.accuracy = { days: 0, mape: null, bias: null, last: null };
  }

  /** Forgets the learned factors (after a change of orientation, tilt or peak power). */
  resetCalibration() {
    this.hours = Array.from({ length: 24 }, emptyHour);
    this.global = { a: 0, r: 0, n: 0 };
    this.since = null;
  }

  // ---------- Weather data ----------

  /**
   * Parses an Open-Meteo answer requested with timeformat=unixtime. Hourly radiation values
   * are the mean over the PRECEDING hour: the value stamped t covers [t − 1 h, t).
   * @returns {{ t: number, gti: number, temp: number|null }[]}
   */
  static parse(json) {
    const h = json && json.hourly;
    if (!h || !Array.isArray(h.time) || !Array.isArray(h.global_tilted_irradiance)) {
      const reason = json && json.reason ? `: ${json.reason}` : '';
      throw new Error(`Invalid forecast answer${reason}`);
    }
    const temps = Array.isArray(h.temperature_2m) ? h.temperature_2m : [];
    const out = [];
    h.time.forEach((ts, i) => {
      const gti = h.global_tilted_irradiance[i];
      if (typeof ts !== 'number' || typeof gti !== 'number' || !Number.isFinite(gti)) return;
      const temp = typeof temps[i] === 'number' ? temps[i] : null;
      out.push({ t: ts * 1000 - HOUR_MS, gti: Math.max(0, gti), temp });
    });
    if (!out.length) throw new Error('Empty forecast answer');
    return out;
  }

  /** Replaces the forecast series (entries older than 2 days are dropped). */
  setSeries(series, now = Date.now()) {
    this.series = series.filter((e) => e.t >= now - SERIES_MAX_AGE_MS).sort((a, b) => a.t - b.t);
    this.fetchedAt = now;
  }

  entryAt(t) {
    return this.series.find((e) => t >= e.t && t < e.t + HOUR_MS) || null;
  }

  // ---------- Model ----------

  /** Raw energy of an hour (kWh) before calibration. */
  static raw(entry, peakKw) {
    const gti = entry.gti || 0;
    if (gti <= 0 || !(peakKw > 0)) return 0;
    const cell = (typeof entry.temp === 'number' ? entry.temp : 15) + CELL_RISE * gti;
    const tf = clamp(1 + TEMP_COEF * (cell - 25), 0.7, 1.12);
    return (gti / 1000) * peakKw * PR0 * tf;
  }

  globalFactor() {
    const g = this.global;
    return g.n > 0 && g.r > 0 ? clamp(g.a / g.r, FACTOR_MIN, FACTOR_MAX) : 1;
  }

  /** Calibration factor for a local hour (0-23). */
  factor(hour) {
    const g = this.globalFactor();
    const h = this.hours[hour];
    if (!h || !h.n || !(h.r > 0)) return g;
    const own = clamp(h.a / h.r, FACTOR_MIN, FACTOR_MAX);
    const w = Math.min(1, h.days / HOUR_FULL_DAYS);
    return w * own + (1 - w) * g;
  }

  /**
   * Calibrated AC energy of a forecast hour (kWh), capped at the inverter rated power.
   * @param {{ peakKw: number, ratedKw: number, timeZone: string }} ctx
   */
  energy(entry, ctx) {
    const raw = SolarForecast.raw(entry, ctx.peakKw);
    if (!raw) return 0;
    const e = raw * this.factor(localParts(entry.t, ctx.timeZone).hour);
    return ctx.ratedKw > 0 ? Math.min(e, ctx.ratedKw) : e;
  }

  // ---------- Results ----------

  /** True if the series covers the given local day (at least 20 of its hours). */
  covers(day, timeZone) {
    return this.series.filter((e) => localParts(e.t, timeZone).day === day).length >= 20;
  }

  /**
   * Forecast energy (kWh) of a local day between two local times, partial hours pro rata.
   * Null if the forecast does not cover that day.
   */
  window(day, startMin, endMin, ctx) {
    if (!this.covers(day, ctx.timeZone)) return null;
    let sum = 0;
    for (const e of this.series) {
      const p = localParts(e.t, ctx.timeZone);
      if (p.day !== day) continue;
      const from = Math.max(p.minute, startMin);
      const to = Math.min(p.minute + 60, endMin);
      if (to > from) sum += this.energy(e, ctx) * ((to - from) / 60);
    }
    return sum;
  }

  dayTotal(day, ctx) {
    return this.window(day, 0, 24 * 60, ctx);
  }

  /** Forecast energy (kWh) from now to the end of the local day. Null if not covered. */
  remaining(now, ctx) {
    const today = localParts(now, ctx.timeZone).day;
    if (!this.covers(today, ctx.timeZone)) return null;
    let sum = 0;
    for (const e of this.series) {
      if (localParts(e.t, ctx.timeZone).day !== today || e.t + HOUR_MS <= now) continue;
      const share = e.t >= now ? 1 : (e.t + HOUR_MS - now) / HOUR_MS;
      sum += this.energy(e, ctx) * share;
    }
    return sum;
  }

  /** Forecast mean AC power (W) of the current hour. Null if not covered. */
  powerAt(now, ctx) {
    const e = this.entryAt(now);
    return e ? this.energy(e, ctx) * 1000 : null;
  }

  // ---------- Calibration ----------

  /**
   * Learns one finished hour.
   * @param {number} hourStart start of the UTC hour (ms)
   * @param {number} actual energy measured during that hour (kWh)
   * @param {{ peakKw: number, ratedKw: number, timeZone: string }} ctx
   * @returns {{ learned: boolean, reason?: string, hour?: number, raw?: number, forecast?: number, factor?: number }}
   */
  learnHour(hourStart, actual, ctx) {
    const e = this.series.find((x) => x.t === hourStart);
    if (!e) return { learned: false, reason: 'no_forecast' };
    const { day, hour } = localParts(hourStart, ctx.timeZone);
    const raw = SolarForecast.raw(e, ctx.peakKw);
    const forecast = this.energy(e, ctx);
    const base = { hour, raw: round(raw, 3), forecast: round(forecast, 3) };
    if (raw < LEARN_MIN_FRACTION * ctx.peakKw) return { learned: false, reason: 'low', ...base };
    if (ctx.ratedKw > 0 && (raw * this.factor(hour) > CLIP_MARGIN * ctx.ratedKw || actual > CLIP_MARGIN * ctx.ratedKw)) {
      return { learned: false, reason: 'clipping', ...base };
    }
    const ratio = actual / raw;
    if (!(ratio >= RATIO_MIN && ratio <= RATIO_MAX)) return { learned: false, reason: 'outlier', ...base };

    const h = this.hours[hour];
    h.n += 1;
    const a = Math.max(1 / h.n, HOUR_ALPHA_MIN);
    h.a += a * (actual - h.a);
    h.r += a * (raw - h.r);
    if (h.last !== day) { h.days += 1; h.last = day; }

    const g = this.global;
    g.n += 1;
    const ag = Math.max(1 / g.n, GLOBAL_ALPHA_MIN);
    g.a += ag * (actual - g.a);
    g.r += ag * (raw - g.r);
    if (!this.since) this.since = day;
    return { learned: true, ...base, factor: round(this.factor(hour), 3) };
  }

  // ---------- Day-ahead accuracy ----------

  /** Keeps the forecast made for a day (call it the day before; the last call of the day wins). */
  recordDayAhead(day, kWh) {
    if (typeof kWh !== 'number' || !Number.isFinite(kWh)) return;
    this.dayAhead[day] = round(kWh, 2);
    const keys = Object.keys(this.dayAhead).sort();
    while (keys.length > 3) delete this.dayAhead[keys.shift()];
  }

  /**
   * Compares the day-ahead forecast of a finished day with the measured yield.
   * @returns {{ forecast: number, actual: number, error: number|null }|null} error in % (null on dull days)
   */
  checkDay(day, actual) {
    const fc = this.dayAhead[day];
    delete this.dayAhead[day];
    if (typeof fc !== 'number') return null;
    if (!(actual >= ACCURACY_MIN_KWH)) return { forecast: fc, actual: round(actual, 2), error: null };
    const err = ((fc - actual) / actual) * 100;
    const acc = this.accuracy;
    acc.days += 1;
    const a = Math.max(1 / acc.days, ACCURACY_ALPHA_MIN);
    acc.mape = acc.mape === null ? Math.abs(err) : acc.mape + a * (Math.abs(err) - acc.mape);
    acc.bias = acc.bias === null ? err : acc.bias + a * (err - acc.bias);
    acc.last = day;
    return { forecast: fc, actual: round(actual, 2), error: round(err, 1) };
  }

  // ---------- Summary and persistence ----------

  summary() {
    return {
      fetchedAt: this.fetchedAt ? new Date(this.fetchedAt).toISOString() : null,
      since: this.since,
      samples: this.global.n,
      globalFactor: round(this.globalFactor(), 3),
      hours: this.hours.map((h, i) => ({ hour: i, days: h.days, factor: h.n ? round(this.factor(i), 2) : null }))
        .filter((h) => h.days > 0),
      accuracy: {
        days: this.accuracy.days,
        mape: this.accuracy.mape === null ? null : round(this.accuracy.mape, 1),
        bias: this.accuracy.bias === null ? null : round(this.accuracy.bias, 1),
      },
    };
  }

  toJSON() {
    const r = (x) => Math.round(x * 100000) / 100000;
    return {
      v: 1,
      since: this.since,
      fetchedAt: this.fetchedAt,
      hours: this.hours.map((h) => ({ ...h, a: r(h.a), r: r(h.r) })),
      global: { ...this.global, a: r(this.global.a), r: r(this.global.r) },
      accuracy: this.accuracy,
      dayAhead: this.dayAhead,
      series: this.series.map((e) => ({ t: e.t, gti: Math.round(e.gti * 10) / 10, temp: e.temp })),
    };
  }
}

module.exports = {
  SolarForecast, localParts, nextDay, parseTime,
};

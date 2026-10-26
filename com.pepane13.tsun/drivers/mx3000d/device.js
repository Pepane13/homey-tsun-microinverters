'use strict';

const Homey = require('homey');
const { SolarmanV5Client } = require('../../lib/solarmanv5');
const { readAll } = require('../../lib/mx3000d');
const { maskSerial } = require('../../lib/diagreport');
const { PanelBaseline } = require('../../lib/panelbaseline');

const PANELS = 6;
const STANDBY_AFTER_FAILURES = 3; // consecutive failures before the inverter is considered in standby
const STANDBY_POLL_S = 300; // polling interval in standby (night)
const PRODUCING_W = 30; // above this AC power the inverter is clearly on: a read failure is abnormal
const SLOW_RESPONSE_MS = 3000; // full read cycle slower than this: logger busy (or weak Wi-Fi if the connection is slow too)
const SLOW_CONNECT_MS = 1000; // TCP connection slower than this: weak Wi-Fi
const CONFIRM_FAILURES = 2; // consecutive failed cycles before a warning (an isolated failure is a collision)
const RETRY_RATE_WARN = 20; // % of cycles needing a retry over 1 h above which the serial link is reported
const COMM_WINDOW_MS = 60 * 60 * 1000; // window for the communication success rate
const FREQ_MIN = 49.8;
const FREQ_MAX = 50.2;
const EFFICIENCY_MIN = 0.85; // AC/DC ratio below this (with DC > 300 W) is suspicious
const EFFICIENCY_MIN_DC_W = 300;
const RATE_LIMIT_MIN = 30; // repeated warnings of the same kind are logged at most every 30 min
const BASELINE_SAVE_MS = 15 * 60 * 1000; // learned panel profile saved at most every 15 min
const DAILY_MIN_KWH = 1; // daily degradation check only on days with at least 1 kWh
const DAY_STATS_SAVE_MS = 5 * 60 * 1000; // daily statistics are saved at most every 5 min (and on key events)
const UNREACHABLE_POLL_S = 60; // polling interval while unreachable during production (night standby: 5 min)
const LAST_OK_MAX_AGE_MS = 30 * 60 * 1000; // last reading restored after a restart if younger than this
const STARTUP_GRACE_MS = 15 * 60 * 1000; // no 'communication lost' alert during the first 15 min (network restarting)
const TEMP_ALERT_DEFAULT = 90; // °C, default of the temperature alert setting (80 before v1.5.1)
// Thermal derating: the inverter moves its operating point towards the open-circuit voltage,
// so the panel power falls while the panel voltage rises (a cloud lowers power without raising voltage)
const DERATE_WINDOW_MS = 5 * 60 * 1000; // comparison over 5 min
const DERATE_POWER_DROP = 0.10; // DC power down by at least 10 %...
const DERATE_VOLTAGE_RISE = 0.04; // ...while the voltage rises by at least 4 %...
const DERATE_MIN_PANELS = 4; // ...on at least 4 of the 6 panels
const DERATE_MIN_DC_W = 600; // only with a significant production
const DERATE_TEMP_MARGIN = 15; // and an inverter temperature within 15 °C of the alert limit

// Capabilities from earlier versions, replaced by tsun_* capabilities
// (Homey Energy must only see one measure_power and one meter_power)
const OBSOLETE_CAPABILITIES = ['meter_power.today', 'tsun_energy_today', 'tsun_energy.total',
  // v1.2.0 and earlier: system capabilities replaced by tsun_* sub-capabilities, which Homey
  // Insights lists reliably (and measure_temperature no longer skews the zone temperature)
  'measure_voltage', 'measure_current', 'measure_frequency', 'measure_temperature',
  ...Array.from({ length: PANELS }, (_, i) => `measure_power.pv${i + 1}`)];

const round = (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

/**
 * Inverter status label. Only code 1 (normal production) is reliably documented
 * for the MX3000D; other codes are shown as raw values.
 * @param {(key: string) => string} __ Homey translation function
 */
function statusLabel({ status, alarms, faults }, __) {
  if (faults) return `${__('status.fault')} 0x${faults.toString(16).padStart(4, '0')}`;
  if (alarms) return `${__('status.alarm')} 0x${alarms.toString(16).padStart(4, '0')}`;
  if (status === 1) return __('status.normal');
  return `${__('status.code')} ${status}`;
}

/**
 * Classifies a communication error to tell Wi-Fi/network problems apart from
 * logger or inverter problems.
 * @returns {string} cause key (see locales diag.cause.*)
 */
function classifyError(err) {
  const code = err && err.code;
  if (code === 'ESERIAL') return 'serial';
  if (code === 'EV5') return 'inverter_silent';
  if (['ECHECKSUM', 'ECRC', 'EFRAMETYPE'].includes(code)) return 'corrupt';
  if (code === 'ECONNREFUSED') return 'port_closed';
  if (err && err.phase === 'connect') {
    if (['ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN', 'ECONNRESET'].includes(code)) return 'unreachable';
  }
  if (code === 'ECLOSED' || code === 'ECONNRESET') return 'closed';
  if (code === 'ETIMEDOUT') return 'no_response';
  return 'other';
}

function newDayStats() {
  return {
    ok: 0,
    fail: 0,
    okProducing: 0,
    failProducing: 0,
    latSum: 0,
    latMax: 0,
    retries: 0,
    retryCauses: {},
    isolated: 0,
    slowBusy: 0,
    outages: 0,
    outageMin: 0,
    peak: 0,
    peakAt: null,
    vmin: null,
    vmax: null,
    tmax: null,
    wake: null,
    sleep: null,
  };
}

module.exports = class Mx3000dDevice extends Homey.Device {
  async onInit() {
    this.failures = 0;
    this.standby = false;
    this.polling = false;
    this.timer = null;
    this.lastStatus = null;
    // Per-panel tracking: { since: ms|null, flagged: bool }
    this.panelWatch = Array.from({ length: PANELS }, () => ({ since: null, flagged: false }));
    this.zeroWatch = Array.from({ length: PANELS }, () => ({ since: null, flagged: false }));
    // Communication tracking
    this.comm = { window: [], lastOk: null, outage: null, lastError: null, lastLatency: null };
    this.startedAt = Date.now();
    this.history = []; // recent readings for the thermal derating check: { t, temp, panels: [{ p, v }] }
    this._restoreLastOk();
    this.dayStats = newDayStats();
    this.dayStatsSavedAt = 0;
    this.rateLimit = {};
    this._restoreDayStats();
    this.baseline = new PanelBaseline(PANELS, this.getStoreValue('panelBaseline'));
    this.baselineSavedAt = Date.now();

    await this._migrateCapabilities();
    await this._migrateSettings();

    this.triggerUnderperforming = this.homey.flow.getDeviceTriggerCard('panel_underperforming');
    this.triggerRecovered = this.homey.flow.getDeviceTriggerCard('panel_recovered');
    this.triggerNotProducing = this.homey.flow.getDeviceTriggerCard('panel_not_producing');
    this.triggerStatus = this.homey.flow.getDeviceTriggerCard('status_changed');
    this.triggerCommLost = this.homey.flow.getDeviceTriggerCard('comm_lost');
    this.triggerCommRestored = this.homey.flow.getDeviceTriggerCard('comm_restored');

    this._diag('info', 'app', `${this._t('diag.device_started')} ${this.getSetting('host')}`);
    this._schedule(1);
  }

  async _migrateCapabilities() {
    for (const cap of OBSOLETE_CAPABILITIES) {
      if (this.hasCapability(cap)) await this.removeCapability(cap).catch(this.error);
    }
    for (const cap of this.driver.manifest.capabilities) {
      if (!this.hasCapability(cap)) await this.addCapability(cap).catch(this.error);
    }
  }

  /** v1.5.1: the default temperature alert goes from 80 to 90 °C (80 °C is reached on any sunny day). */
  async _migrateSettings() {
    if (this.getStoreValue('settingsVersion') >= 2) return;
    if (Number(this.getSetting('temp_alert')) === 80) {
      await this.setSettings({ temp_alert: TEMP_ALERT_DEFAULT }).catch(this.error);
      this._diag('info', 'app', this._t('diag.temp_default_changed', { limit: TEMP_ALERT_DEFAULT }));
    }
    await this.setStoreValue('settingsVersion', 2).catch(this.error);
  }

  /**
   * Last successful reading, kept across restarts: after a Homey restart in daytime, a failed
   * first read must be handled as an outage during production, not as the night standby.
   */
  _restoreLastOk() {
    const saved = this.getStoreValue('lastOk');
    if (!saved || typeof saved.t !== 'number' || Date.now() - saved.t > LAST_OK_MAX_AGE_MS) return;
    this.comm.lastOk = { t: saved.t, power: Number(saved.power) || 0 };
  }

  async _saveLastOk() {
    if (!this.comm.lastOk) return;
    await this.setStoreValue('lastOk', this.comm.lastOk).catch((err) => this.error('lastOk save:', err.message));
  }

  /** Used by the 'a panel is underperforming' condition card. */
  isUnderperforming() {
    return this.panelWatch.some((w) => w.flagged) || this.zeroWatch.some((w) => w.flagged);
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('host') && !/^\d{1,3}(\.\d{1,3}){3}$/.test(String(newSettings.host).trim())) {
      throw new Error(this.homey.__('errors.invalid_ip'));
    }
    if (changedKeys.includes('logger_sn') && !/^\d{6,10}$/.test(String(newSettings.logger_sn).trim())) {
      throw new Error(this.homey.__('errors.invalid_sn'));
    }
    if (changedKeys.some((k) => k.startsWith('underperf_'))) {
      for (const w of [...this.panelWatch, ...this.zeroWatch]) w.since = null; // restart the duration measurement
    }
    this._diag('info', 'app', this._t('diag.settings_changed', { keys: changedKeys.join(', ') }));
    this.failures = 0;
    this.standby = false;
    this._schedule(2);
  }

  async onUninit() {
    this._clear();
    await this._saveDayStats(true);
    await this._saveBaseline(true);
  }

  async onDeleted() {
    this._clear();
  }

  _clear() {
    if (this.timer) this.homey.clearTimeout(this.timer);
    this.timer = null;
  }

  _schedule(seconds) {
    this._clear();
    this.timer = this.homey.setTimeout(() => this._poll(), seconds * 1000);
  }

  _todayKey() {
    const tz = this.homey.clock.getTimezone();
    return new Date().toLocaleDateString('sv-SE', { timeZone: tz }); // YYYY-MM-DD
  }

  async _set(cap, value) {
    if (value === null || value === undefined || Number.isNaN(value)) return;
    if (!this.hasCapability(cap)) return;
    if (this.getCapabilityValue(cap) === value) return;
    await this.setCapabilityValue(cap, value).catch((err) => this.error(`${cap}:`, err.message));
  }

  // ---------- Diagnostics helpers ----------

  /** Translation with {placeholder} substitution. */
  _t(key, vars = {}) {
    let s = this.homey.__(key);
    if (typeof s !== 'string') s = key;
    return s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
  }

  _diag(level, category, message) {
    const diag = this.homey.app && this.homey.app.diag;
    if (diag) diag.add(level, this.getName(), category, message);
    else if (level === 'error' || level === 'warn') this.log(`[${level}] ${message}`);
  }

  /** Logs a message at most once every `minutes` for a given key. */
  _diagOnce(key, minutes, level, category, message) {
    const now = Date.now();
    if (this.rateLimit[key] && now - this.rateLimit[key] < minutes * 60000) return false;
    this.rateLimit[key] = now;
    this._diag(level, category, message);
    return true;
  }

  /** Homey timeline notification, if enabled in the app settings. */
  async _notify(settingKey, message, defaultOn = true) {
    const v = this.homey.settings.get(settingKey);
    if (v === false || (v == null && !defaultOn)) return;
    await this.homey.notifications.createNotification({ excerpt: `${this.getName()} : ${message}` })
      .catch((err) => this.error('Notification:', err.message));
  }

  _time(t) {
    if (!t) return '—';
    const tz = this.homey.clock.getTimezone();
    return new Date(t).toLocaleTimeString('fr-FR', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
  }

  _successRate(now = Date.now()) {
    this.comm.window = this.comm.window.filter((e) => now - e.t <= COMM_WINDOW_MS);
    const n = this.comm.window.length;
    if (!n) return null;
    return round((100 * this.comm.window.filter((e) => e.ok).length) / n, 1);
  }

  /** Snapshot for the app settings page. */
  getDiagStatus() {
    const now = Date.now();
    const o = this.comm.outage;
    const lat = this.dayStats.ok ? Math.round(this.dayStats.latSum / this.dayStats.ok) : null;
    return {
      name: this.getName(),
      host: this.getSetting('host'),
      available: this.getAvailable(),
      standby: this.standby,
      status: this.getCapabilityValue('tsun_status'),
      power: this.getCapabilityValue('measure_power'),
      lastOk: this.comm.lastOk ? new Date(this.comm.lastOk.t).toISOString() : null,
      latencyLast: this.comm.lastLatency,
      latencyAvgToday: lat,
      latencyMaxToday: this.dayStats.latMax || null,
      successRate1h: this._successRate(now),
      readsToday: { ok: this.dayStats.ok, failed: this.dayStats.fail },
      retriesToday: this.dayStats.retries,
      isolatedToday: this.dayStats.isolated,
      outagesToday: { count: this.dayStats.outages, minutes: round(this.dayStats.outageMin, 1) },
      currentOutage: o ? {
        since: new Date(o.start).toISOString(),
        minutes: round((now - o.start) / 60000, 1),
        cause: this._t(`diag.cause.${o.cause}`),
        duringProduction: o.powerBefore >= PRODUCING_W,
      } : null,
      lastError: this.comm.lastError,
      panelsUnderperforming: this.panelWatch.map((w, i) => (w.flagged ? i + 1 : null)).filter(Boolean),
      panelsNotProducing: this.zeroWatch.map((w, i) => (w.flagged ? i + 1 : null)).filter(Boolean),
    };
  }

  /** Full snapshot for the exported diagnostic report (logger serial masked). */
  getDiagReport() {
    const settings = { ...this.getSettings() };
    settings.logger_sn = maskSerial(settings.logger_sn);
    settings.inverter_sn = maskSerial(settings.inverter_sn);
    const values = {};
    for (const cap of this.getCapabilities()) {
      const v = this.getCapabilityValue(cap);
      values[cap] = v;
    }
    return {
      name: this.getName(),
      status: this.getDiagStatus(),
      settings,
      values,
      baseline: this.getBaselineSummary(),
      today: {
        ...this.dayStats,
        peakAt: this.dayStats.peakAt ? new Date(this.dayStats.peakAt).toISOString() : null,
        wake: this.dayStats.wake ? new Date(this.dayStats.wake).toISOString() : null,
        sleep: this.dayStats.sleep ? new Date(this.dayStats.sleep).toISOString() : null,
      },
    };
  }

  // ---------- Daily statistics persistence ----------
  // Statistics of the current day survive app updates and Homey restarts, so that the
  // midnight summary covers the whole day.

  _restoreDayStats() {
    const saved = this.getStoreValue('dayStats');
    if (!saved || saved.day !== this._todayKey() || !saved.stats) return;
    this.dayStats = { ...newDayStats(), ...saved.stats };
    this._diag('info', 'day', this._t('diag.stats_restored', { ok: this.dayStats.ok, fail: this.dayStats.fail }));
  }

  async _saveDayStats(force = false) {
    const now = Date.now();
    if (!force && now - this.dayStatsSavedAt < DAY_STATS_SAVE_MS) return;
    this.dayStatsSavedAt = now;
    await this.setStoreValue('dayStats', { day: this._todayKey(), stats: this.dayStats })
      .catch((err) => this.error('Day stats save:', err.message));
    await this._saveLastOk();
  }

  // ---------- Daily counters ----------
  // The inverter's daily counters (total and per panel) are only reset when it restarts in the
  // morning. After midnight, each counter's value from the previous day is stored and 0 is shown
  // as long as the inverter still returns that value (or more).

  _todayCaps() {
    return {
      ac: 'tsun_energy.today',
      ...Object.fromEntries(Array.from({ length: PANELS }, (_, i) => [`pv${i + 1}`, `tsun_panel_energy.pv${i + 1}`])),
    };
  }

  async _handleDayChange() {
    const today = this._todayKey();
    const lastDay = this.getStoreValue('day');
    if (lastDay === today) return;
    await this.setStoreValue('day', today);
    if (!lastDay) return;

    this._logDailySummary(lastDay);
    await this._checkDailyShares(lastDay);

    const stale = {};
    for (const [key, cap] of Object.entries(this._todayCaps())) {
      const v = this.getCapabilityValue(cap) || 0;
      if (v > 0) stale[key] = v; // no production the day before: nothing to ignore
      await this._set(cap, 0);
    }
    await this.setStoreValue('staleToday', stale);
    this.dayStats = newDayStats();
    await this._saveDayStats(true);
    this._diag('info', 'day', this._t('diag.day_reset', { day: today }));
  }

  _logDailySummary(day) {
    const s = this.dayStats;
    const val = (cap) => this.getCapabilityValue(cap) || 0;
    const panels = Array.from({ length: PANELS }, (_, i) => round(val(`tsun_panel_energy.pv${i + 1}`), 2)).join(' / ');
    const prodReads = s.okProducing + s.failProducing;
    this._diag('info', 'day', this._t('diag.summary', {
      day,
      energy: round(val('tsun_energy.today'), 2),
      panels,
      peak: Math.round(s.peak),
      peakTime: this._time(s.peakAt),
      wake: this._time(s.wake),
      sleep: this._time(s.sleep),
      vmin: s.vmin ?? '—',
      vmax: s.vmax ?? '—',
      tmax: s.tmax ?? '—',
      ok: s.ok,
      fail: s.fail,
      rate: prodReads ? round((100 * s.okProducing) / prodReads, 1) : '—',
      lavg: s.ok ? Math.round(s.latSum / s.ok) : '—',
      lmax: s.latMax || '—',
      retries: s.retries,
      crc: s.retryCauses.corrupt || 0,
      silent: (s.retryCauses.inverter_silent || 0) + (s.retryCauses.no_response || 0),
      isolated: s.isolated,
      slow: s.slowBusy,
      outages: s.outages,
      outageMin: round(s.outageMin, 1),
    }));
  }

  /** Daily value to display for a counter, taking the previous day's value into account. */
  _freshToday(stale, key, raw) {
    const s = stale[key];
    if (typeof s === 'number' && s > 0) {
      if (raw > 0 && raw >= s) return 0; // previous day's value still held by the inverter
      delete stale[key]; // the inverter has reset its counter
      if (key === 'ac') this._diag('info', 'day', this._t('diag.counter_reset'));
    }
    return raw;
  }

  // ---------- Polling cycle ----------

  async _poll() {
    if (this.polling) return;
    this.polling = true;
    const interval = Math.max(10, Number(this.getSetting('poll_interval')) || 30);
    let next = interval;

    const client = new SolarmanV5Client({
      host: String(this.getSetting('host')).trim(),
      serial: Number(String(this.getSetting('logger_sn')).trim()),
      timeout: 8000,
    });

    let d = null;
    const t0 = Date.now();
    let connectMs = null;
    try {
      await this._handleDayChange();
      await client.connect();
      connectMs = Date.now() - t0;
      this.cycleRetries = 0;
      d = await readAll(client, {
        tempOffset: Number(this.getSetting('temp_offset')) || 0,
        onRetry: (err, attempt) => this._onRetry(err, attempt),
        retryDelayMs: this.retryDelayMs,
      });
    } catch (err) {
      client.close();
      await this._onReadFailure(err);
      if (this.failures >= STANDBY_AFTER_FAILURES) {
        const night = !this.comm.outage || this.comm.outage.powerBefore < PRODUCING_W;
        next = Math.max(interval, night ? STANDBY_POLL_S : UNREACHABLE_POLL_S);
      }
    } finally {
      client.close();
    }

    if (d) {
      try {
        await this._onReadSuccess(d, Date.now() - t0, connectMs);
      } catch (err) {
        this._diag('error', 'app', `${this._t('diag.update_failed')} ${err.message}`);
      }
    }
    this.polling = false;
    this._schedule(next);
  }

  async _onReadSuccess(d, latency, connectMs) {
    const now = Date.now();
    const s = this.dayStats;
    this.comm.lastLatency = latency;
    this.comm.window.push({ t: now, ok: true, retried: this.cycleRetries > 0 });
    s.ok += 1;
    s.latSum += latency;
    s.latMax = Math.max(s.latMax, latency);
    if (d.power >= PRODUCING_W) s.okProducing += 1;

    // End of an outage or of the night standby
    const o = this.comm.outage;
    if (o) {
      const minutes = round((now - o.start) / 60000, 1);
      if (o.powerBefore >= PRODUCING_W) {
        s.outages += 1;
        s.outageMin += minutes;
        const vars = { minutes, count: o.count, cause: this._t(`diag.cause.${o.cause}`) };
        if (o.alerted) {
          this._diag('warn', 'comm', this._t('diag.comm_restored', vars));
          await this.triggerCommRestored.trigger(this, { minutes }).catch(this.error);
          await this._notify('notify_comm', this._t('diag.comm_restored', vars));
        } else if (o.count >= CONFIRM_FAILURES) {
          this._diag('warn', 'comm', this._t('diag.micro_cut', vars));
        } else {
          s.isolated += 1;
          this._diag('debug', 'comm', this._t('diag.isolated', vars));
        }
      } else {
        if (!s.wake) s.wake = now;
        this._diag('info', 'comm', this._t('diag.wake', { time: this._time(now), hours: round(minutes / 60, 1) }));
      }
      this.comm.outage = null;
      await this._saveDayStats(true);
    }
    const wasProducing = this.comm.lastOk && this.comm.lastOk.power >= PRODUCING_W;
    this.comm.lastOk = { t: now, power: d.power };
    if (wasProducing !== (d.power >= PRODUCING_W)) await this._saveLastOk();

    if (connectMs > SLOW_CONNECT_MS) {
      // the TCP connection itself is slow: weak Wi-Fi
      this._diagOnce('slow', RATE_LIMIT_MIN, 'warn', 'comm', this._t('diag.slow', { ms: latency, connect: connectMs }));
    } else if (latency > SLOW_RESPONSE_MS) {
      // fast connection but slow answer: the logger was busy with the inverter (cloud polling)
      s.slowBusy += 1;
      this._diag('debug', 'comm', this._t('diag.slow_busy', { ms: latency, connect: connectMs }));
    }
    this._checkRetryRate(now);
    this._diag('debug', 'comm', this._t('diag.poll_ok', {
      ms: latency,
      connect: connectMs,
      power: d.power,
      voltage: d.voltage,
      temp: d.temperature,
      panels: d.panels.map((p) => Math.round(p.power)).join('/'),
    }));

    await this._set('tsun_latency.logger', latency);
    await this._set('tsun_ratio.comm', this._successRate(now));

    if (this.failures > 0 || this.standby) this.log('Inverter reachable again');
    this.failures = 0;
    if (this.standby) {
      this.standby = false;
      await this.unsetWarning().catch(this.error);
    }
    if (!this.getAvailable()) await this.setAvailable().catch(this.error);

    await this._update(d);
    await this._saveDayStats();
  }

  async _onReadFailure(err) {
    const now = Date.now();
    const cause = classifyError(err);
    const causeText = this._t(`diag.cause.${cause}`);
    const lastPower = this.comm.lastOk ? this.comm.lastOk.power : 0;
    const producing = lastPower >= PRODUCING_W;
    this.failures += 1;
    this.dayStats.fail += 1;
    if (producing) {
      this.dayStats.failProducing += 1;
      this.comm.window.push({ t: now, ok: false }); // failures while stopped are normal: not counted
    }
    this.comm.lastError = {
      t: new Date(now).toISOString(), cause, text: causeText, code: err.code || null, message: err.message,
    };
    const vars = { power: lastPower, cause: causeText, code: err.code || '?', message: err.message, n: this.failures };

    // Configuration problems: always worth a warning
    if (cause === 'serial' || cause === 'port_closed') {
      this._diagOnce(`cfg_${cause}`, RATE_LIMIT_MIN, 'warn', 'comm', this._t('diag.read_fail_day', vars));
    }

    let o = this.comm.outage;
    if (!o) {
      o = { start: now, powerBefore: lastPower, cause, count: 0, alerted: false };
      this.comm.outage = o;
      // first failed cycle: only a trace (usually an isolated collision); a warning if it persists
      this._diag(producing ? 'debug' : 'info', 'comm',
        this._t(producing ? 'diag.read_fail_day' : 'diag.read_fail_night', vars));
    }
    o.count += 1;
    o.cause = cause;
    if (o.powerBefore >= PRODUCING_W && o.count === CONFIRM_FAILURES) {
      this._diag('warn', 'comm', this._t('diag.read_fail_repeated', { ...vars, count: o.count }));
    }
    this._diag('debug', 'comm', this._t('diag.read_fail_detail', vars));

    // Prolonged outage while the inverter was producing: alert
    const delayMin = Number(this.getSetting('comm_alert_delay')) || 10;
    const minutes = round((now - o.start) / 60000, 1);
    const starting = now - this.startedAt < STARTUP_GRACE_MS;
    if (o.powerBefore >= PRODUCING_W && !o.alerted && minutes >= delayMin && starting && !o.graceLogged) {
      o.graceLogged = true;
      this._diag('info', 'comm', this._t('diag.startup_grace', { minutes }));
    }
    if (o.powerBefore >= PRODUCING_W && !o.alerted && minutes >= delayMin && !starting) {
      o.alerted = true;
      const msg = this._t('diag.comm_lost', { minutes, cause: causeText });
      this._diag('error', 'comm', msg);
      await this.triggerCommLost.trigger(this, { minutes, cause: causeText }).catch(this.error);
      await this._notify('notify_comm', msg);
    }

    const rate = this._successRate(now);
    if (rate !== null) await this._set('tsun_ratio.comm', rate);
    await this._saveDayStats(this.failures === STANDBY_AFTER_FAILURES);

    if (this.failures >= STANDBY_AFTER_FAILURES && !this.standby) {
      this.standby = true;
      if (o.powerBefore < PRODUCING_W) {
        this.dayStats.sleep = this.dayStats.sleep || now;
        this._diag('info', 'comm', this._t('diag.sleep', { time: this._time(now), power: o.powerBefore }));
      }
      // Night standby (normal) or loss of communication while producing (abnormal)
      const night = o.powerBefore < PRODUCING_W;
      this.log(night ? 'Inverter considered in standby' : 'Inverter unreachable while producing');
      await this._zeroPower();
      await this._setStatus(this.homey.__(night ? 'status.standby' : 'status.unreachable'), 0);
      for (const w of [...this.panelWatch, ...this.zeroWatch]) w.since = null;
      await this.setWarning(this.homey.__(night ? 'warning.standby' : 'warning.unreachable')).catch(this.error);
    }
  }

  /** A request failed with a transient error and is retried within the same cycle. */
  _onRetry(err, attempt) {
    const cause = classifyError(err);
    this.cycleRetries = (this.cycleRetries || 0) + 1;
    this.dayStats.retries += 1;
    this.dayStats.retryCauses[cause] = (this.dayStats.retryCauses[cause] || 0) + 1;
    this._diag('debug', 'comm', this._t('diag.retry', {
      attempt, cause: this._t(`diag.cause.${cause}`), code: err.code || '?',
    }));
  }

  /** Warns (at most hourly) when many cycles needed a retry over the last hour. */
  _checkRetryRate(now) {
    const w = this.comm.window.filter((e) => now - e.t <= COMM_WINDOW_MS);
    if (w.length < 60) return; // at least ~30 min of data
    const retried = w.filter((e) => e.retried || !e.ok).length;
    const pct = round((100 * retried) / w.length, 1);
    if (pct >= RETRY_RATE_WARN) {
      this._diagOnce('retry_rate', 60, 'warn', 'comm', this._t('diag.retry_rate', { pct, n: retried, total: w.length }));
    }
  }

  async _zeroPower() {
    await this._set('measure_power', 0);
    await this._set('tsun_power.ac', 0);
    await this._set('tsun_current.grid', 0);
    for (let n = 1; n <= PANELS; n++) await this._set(`tsun_panel_power.pv${n}`, 0);
  }

  async _setStatus(label, code) {
    await this._set('tsun_status', label);
    if (this.lastStatus === null) {
      this.lastStatus = label; // first known state after start-up: no trigger
      this._diag('info', 'inverter', this._t('diag.status', { status: label }));
      return;
    }
    if (label === this.lastStatus) return;
    this.lastStatus = label;
    this._diag('info', 'inverter', this._t('diag.status', { status: label }));
    await this.triggerStatus.trigger(this, { status: label, code }).catch(this.error);
  }

  async _update(d) {
    // measure_power feeds Homey Energy (not Insights); tsun_power.ac is its Insights chart
    await this._set('measure_power', d.power);
    await this._set('tsun_power.ac', d.power);
    await this._set('tsun_voltage.grid', d.voltage);
    await this._set('tsun_current.grid', d.current);
    await this._set('tsun_frequency.grid', d.frequency);
    await this._set('tsun_temperature.inverter', d.temperature);
    await this._set('alarm_generic', (d.alarms !== 0) || (d.faults !== 0));
    await this._setStatus(statusLabel(d, (k) => this.homey.__(k)), d.status);

    // Total meter (Homey Energy): must never decrease (zero readings at start-up)
    const total = this.getCapabilityValue('meter_power');
    if (d.energyTotal > 0 && (total === null || d.energyTotal >= total)) {
      await this._set('meter_power', d.energyTotal);
    }

    // Daily counters, total and per panel
    const storedStale = this.getStoreValue('staleToday');
    const stale = (storedStale && typeof storedStale === 'object') ? { ...storedStale } : {};
    const before = Object.keys(stale).length;
    await this._set('tsun_energy.today', this._freshToday(stale, 'ac', d.energyToday));
    for (let n = 0; n < PANELS; n++) {
      await this._set(`tsun_panel_power.pv${n + 1}`, d.panels[n].power);
      await this._set(`tsun_panel_energy.pv${n + 1}`, this._freshToday(stale, `pv${n + 1}`, d.panels[n].energyToday));
    }
    if (Object.keys(stale).length !== before) await this.setStoreValue('staleToday', stale);

    await this._checkInverter(d);
    await this._checkPanels(d.panels.map((p) => p.power), Date.now(), d.panels.map((p) => p.voltage));

    // Dashboard widget: keep the last reading and notify open widgets
    this.lastReading = { ...d, t: Date.now() };
    try { this.homey.api.realtime('tsun_update', { id: this.getData().id }); } catch (err) { /* no listener */ }
  }

  // ---------- Grid and inverter checks ----------

  async _checkInverter(d) {
    const s = this.dayStats;
    const now = Date.now();
    if (d.power > s.peak) { s.peak = d.power; s.peakAt = now; }
    if (d.power >= PRODUCING_W) {
      s.vmin = s.vmin === null ? d.voltage : Math.min(s.vmin, d.voltage);
      s.vmax = s.vmax === null ? d.voltage : Math.max(s.vmax, d.voltage);
    }
    s.tmax = s.tmax === null ? d.temperature : Math.max(s.tmax, d.temperature);

    const vMax = Number(this.getSetting('voltage_max')) || 253;
    const vMin = Number(this.getSetting('voltage_min')) || 207;
    if (d.voltage > vMax) {
      const msg = this._t('diag.voltage_high', { voltage: d.voltage, limit: vMax });
      if (this._diagOnce('vhigh', RATE_LIMIT_MIN, 'warn', 'grid', msg)) await this._notify('notify_grid', msg, false);
    } else if (d.voltage > 0 && d.voltage < vMin) {
      const msg = this._t('diag.voltage_low', { voltage: d.voltage, limit: vMin });
      if (this._diagOnce('vlow', RATE_LIMIT_MIN, 'warn', 'grid', msg)) await this._notify('notify_grid', msg, false);
    }
    if (d.frequency > 0 && (d.frequency < FREQ_MIN || d.frequency > FREQ_MAX)) {
      this._diagOnce('freq', RATE_LIMIT_MIN, 'warn', 'grid', this._t('diag.freq', { freq: d.frequency }));
    }

    const tLimit = Number(this.getSetting('temp_alert')) || TEMP_ALERT_DEFAULT;
    if (d.temperature >= tLimit) {
      const msg = this._t('diag.temp', { temp: d.temperature, limit: tLimit });
      if (this._diagOnce('temp', RATE_LIMIT_MIN, 'warn', 'inverter', msg)) await this._notify('notify_alarm', msg);
    }

    await this._checkDerating(d, now, tLimit);

    const dc = d.panels.reduce((sum, p) => sum + p.power, 0);
    if (dc > EFFICIENCY_MIN_DC_W && d.power / dc < EFFICIENCY_MIN) {
      this._diagOnce('eff', RATE_LIMIT_MIN, 'warn', 'inverter', this._t('diag.efficiency', {
        eff: round((100 * d.power) / dc, 1), dc: Math.round(dc), ac: Math.round(d.power),
      }));
    }

    const alarmKey = `${d.alarms}/${d.faults}`;
    if ((d.alarms || d.faults) && this.lastAlarmKey !== alarmKey) {
      const msg = this._t('diag.alarm', { status: statusLabel(d, (k) => this.homey.__(k)) });
      this._diag('error', 'inverter', msg);
      await this._notify('notify_alarm', msg);
    }
    this.lastAlarmKey = alarmKey;
  }

  /**
   * Thermal derating check. When hot, the inverter limits its power by moving the panels'
   * operating point towards the open-circuit voltage: the power falls and the voltage rises at
   * the same time on most panels. A passing cloud lowers the power without raising the voltage.
   * Compared with the reading closest to 5 minutes earlier.
   */
  async _checkDerating(d, now, tLimit) {
    this.history.push({ t: now, temp: d.temperature, panels: d.panels.map((p) => ({ p: p.power, v: p.voltage })) });
    this.history = this.history.filter((h) => now - h.t <= DERATE_WINDOW_MS * 2);
    if (d.temperature < tLimit - DERATE_TEMP_MARGIN) return false;
    const ref = this.history.find((h) => now - h.t >= DERATE_WINDOW_MS);
    if (!ref) return false;
    const dcNow = d.panels.reduce((s, p) => s + p.power, 0);
    const dcRef = ref.panels.reduce((s, p) => s + p.p, 0);
    if (dcRef < DERATE_MIN_DC_W || dcNow > dcRef * (1 - DERATE_POWER_DROP)) return false;
    const signature = d.panels.filter((p, i) => {
      const r = ref.panels[i];
      return r.p > 0 && r.v > 0 && p.power <= r.p * (1 - DERATE_POWER_DROP) && p.voltage >= r.v * (1 + DERATE_VOLTAGE_RISE);
    }).length;
    if (signature < DERATE_MIN_PANELS) return false;
    const msg = this._t('diag.derating', {
      temp: d.temperature, before: Math.round(dcRef), after: Math.round(dcNow), panels: signature,
    });
    if (this._diagOnce('derate', RATE_LIMIT_MIN, 'warn', 'inverter', msg)) await this._notify('notify_alarm', msg);
    return true;
  }

  // ---------- Panel checks ----------
  // Two modes:
  // - adaptive (default): each panel is compared with its own learned share of production for the
  //   current 15-minute slot (lib/panelbaseline.js), so recurring shadows and orientation
  //   differences are not reported. No underperformance alert until the slot has been learned.
  // - simple: each panel is compared with the average of the other 5.
  // Not producing (below 5 % of the others, min 5 W) is checked in both modes, except in adaptive
  // mode when the panel is usually almost fully shaded at that time.
  // Alerts need the deviation to last the minimum duration; back to normal above -threshold/2.

  _adaptive() {
    return this.getSetting('underperf_mode') !== 'simple';
  }

  async _checkPanels(powers, now = Date.now(), voltages = []) {
    const threshold = Number(this.getSetting('underperf_threshold')) || 15;
    const delayMs = (Number(this.getSetting('underperf_delay')) || 15) * 60000;
    const minPower = Number(this.getSetting('underperf_min_power')) || 80;
    const adaptive = this._adaptive();

    const sum = powers.reduce((s, p) => s + p, 0);
    const mean = sum / PANELS;
    if (mean < minPower) {
      for (const w of [...this.panelWatch, ...this.zeroWatch]) w.since = null; // not enough sun to assess
      return;
    }

    const slot = PanelBaseline.slotOf(now, this.homey.clock.getTimezone());
    const expectedShares = adaptive ? this.baseline.expected(slot) : null;
    const skipLearning = Array(PANELS).fill(false);

    for (let i = 0; i < PANELS; i++) {
      const others = (sum - powers[i]) / (PANELS - 1);
      const panel = i + 1;
      let deviation;
      let expected;
      const expShare = expectedShares ? expectedShares[i] : null;
      if (adaptive) {
        expected = expShare !== null ? expShare * mean : null;
        deviation = expected ? ((powers[i] - expected) / expected) * 100 : null;
      } else {
        expected = others;
        deviation = others > 0 ? ((powers[i] - others) / others) * 100 : 0;
      }

      // Not producing at all. Adaptive mode: skipped when the panel is usually almost fully shaded
      // now; while the time slot is not learned yet, only a panel below 5 W (disconnected) counts.
      const z = this.zeroWatch[i];
      let isZero;
      if (!adaptive) isZero = powers[i] < Math.max(5, others * 0.05);
      else if (expShare === null) isZero = powers[i] < 5;
      else isZero = expShare >= 0.2 && powers[i] < Math.max(5, others * 0.05);
      if (isZero) {
        skipLearning[i] = true;
        if (z.since === null) z.since = now;
        if (!z.flagged && now - z.since >= delayMs) {
          z.flagged = true;
          const v = voltages[i];
          const hint = typeof v === 'number'
            ? (v < 5 ? this._t('diag.panel_zero_hint_v0') : this._t('diag.panel_zero_hint_v', { voltage: v }))
            : '';
          const msg = this._t('diag.panel_zero', { panel, power: round(powers[i]), avg: round(others), hint }).trim();
          this._diag('error', 'panel', msg);
          await this.triggerNotProducing.trigger(this, { panel, average: round(others) }).catch(this.error);
          await this._notify('notify_panel', msg);
        }
      } else {
        z.since = null;
        if (z.flagged && powers[i] > others * 0.5) {
          z.flagged = false;
          this._diag('info', 'panel', this._t('diag.panel_ok', { panel }));
        }
      }

      // Underperforming
      const w = this.panelWatch[i];
      if (deviation === null) { // adaptive mode, slot not learned yet
        w.since = null;
        continue;
      }
      if (deviation <= -threshold) {
        skipLearning[i] = true; // never learn an anomaly as normal
        if (w.since === null) w.since = now;
        if (!w.flagged && now - w.since >= delayMs) {
          w.flagged = true;
          const vars = {
            panel, power: round(powers[i]), avg: round(others), expected: round(expected), dev: round(deviation),
          };
          const msg = this._t(adaptive ? 'diag.panel_under_adaptive' : 'diag.panel_under', vars);
          this._diag('warn', 'panel', msg);
          await this.triggerUnderperforming.trigger(this, {
            panel, power: round(powers[i]), average: round(others), expected: round(expected), deviation: round(deviation),
          }).catch(this.error);
          if (!isZero) await this._notify('notify_panel', msg);
        }
      } else {
        w.since = null;
        if (w.flagged && deviation > -threshold / 2) {
          w.flagged = false;
          this._diag('info', 'panel', this._t('diag.panel_ok', { panel }));
          await this.triggerRecovered.trigger(this, { panel }).catch(this.error);
        }
      }
    }

    // Learning (both modes, so that switching to adaptive mode is immediately useful)
    this.panelWatch.forEach((w, i) => { if (w.flagged) skipLearning[i] = true; });
    this.zeroWatch.forEach((w, i) => { if (w.flagged) skipLearning[i] = true; });
    this.baseline.learn(slot, powers, this._todayKey(), skipLearning);
    await this._saveBaseline();
  }

  // ---------- Learned profile: persistence, daily check, page and report ----------

  async _saveBaseline(force = false) {
    const now = Date.now();
    if (!force && now - (this.baselineSavedAt || 0) < BASELINE_SAVE_MS) return;
    this.baselineSavedAt = now;
    await this.setStoreValue('panelBaseline', this.baseline.toJSON())
      .catch((err) => this.error('Baseline save:', err.message));
  }

  /** Daily degradation check, with yesterday's yield per panel (called at the day change). */
  async _checkDailyShares(day) {
    const energies = Array.from({ length: PANELS }, (_, i) => this.getCapabilityValue(`tsun_panel_energy.pv${i + 1}`) || 0);
    const total = energies.reduce((s, e) => s + e, 0);
    if (total < DAILY_MIN_KWH) return; // too little sun to compare
    const threshold = Number(this.getSetting('daily_threshold')) || 10;
    const res = this.baseline.checkDay(energies, threshold);
    if (!res.ready) {
      this._diag('info', 'panel', this._t('diag.daily_learning', {
        days: this.baseline.daily.days, min: PanelBaseline.DAILY_MIN_DAYS,
      }));
    } else if (this._adaptive()) {
      const mean = total / PANELS;
      for (let i = 0; i < PANELS; i++) {
        const dev = res.deviations[i];
        if (dev !== null && dev <= -threshold) {
          const msg = this._t('diag.panel_daily', {
            day, panel: i + 1, energy: round(energies[i], 2), dev: Math.abs(round(dev)), expected: round(res.expectedShare[i] * mean, 2),
          });
          this._diag('warn', 'panel', msg);
          await this._notify('notify_panel', msg);
        }
      }
    }
    await this._saveBaseline(true);
  }

  /** Data for the dashboard widget (lib/../widgets/production). */
  getWidgetData() {
    const v = (cap) => this.getCapabilityValue(cap);
    const d = this.lastReading;
    const now = Date.now();
    const panels = Array.from({ length: PANELS }, (_, i) => {
      const p = d ? d.panels[i] : null;
      let state = 'ok';
      if (this.standby) state = 'off';
      else if (this.zeroWatch[i].flagged) state = 'zero';
      else if (this.panelWatch[i].flagged) state = 'under';
      return {
        n: i + 1,
        power: v(`tsun_panel_power.pv${i + 1}`),
        energy: v(`tsun_panel_energy.pv${i + 1}`),
        voltage: p && !this.standby ? p.voltage : null,
        current: p && !this.standby ? p.current : null,
        total: p ? p.energyTotal : null,
        state,
      };
    });
    // Expected power of each panel at this time (adaptive profile), when available
    const powers = panels.map((p) => p.power || 0);
    const mean = powers.reduce((s, x) => s + x, 0) / PANELS;
    if (!this.standby && mean > 0 && this._adaptive()) {
      const exp = this.baseline.expected(PanelBaseline.slotOf(now, this.homey.clock.getTimezone()));
      if (exp) panels.forEach((p, i) => { p.expected = exp[i] !== null ? round(exp[i] * mean) : null; });
    }
    const dc = d && !this.standby ? round(d.panels.reduce((s, p) => s + p.power, 0)) : null;
    const power = v('measure_power');
    return {
      id: this.getData().id,
      name: this.getName(),
      status: v('tsun_status'),
      standby: this.standby,
      unreachable: !!(this.comm.outage && this.comm.outage.powerBefore >= PRODUCING_W),
      alarm: v('alarm_generic'),
      power,
      ratedPower: d && d.ratedPower ? d.ratedPower : 3000,
      today: v('tsun_energy.today'),
      total: v('meter_power'),
      voltage: v('tsun_voltage.grid'),
      current: v('tsun_current.grid'),
      frequency: v('tsun_frequency.grid'),
      temperature: v('tsun_temperature.inverter'),
      latency: v('tsun_latency.logger'),
      successRate: v('tsun_ratio.comm'),
      dc,
      efficiency: dc && dc > 50 && power ? round((100 * power) / dc, 1) : null,
      peak: this.dayStats.peak ? Math.round(this.dayStats.peak) : null,
      peakAt: this.dayStats.peakAt ? this._time(this.dayStats.peakAt) : null,
      lastRead: this.comm.lastOk ? this._time(this.comm.lastOk.t) : null,
      panels,
    };
  }

  getBaselineSummary() {
    return {
      id: this.getData().id,
      name: this.getName(),
      mode: this._adaptive() ? 'adaptive' : 'simple',
      ...this.baseline.summary(),
    };
  }

  async resetBaseline() {
    this.baseline.reset();
    for (const w of this.panelWatch) { w.since = null; w.flagged = false; }
    await this._saveBaseline(true);
    this._diag('info', 'panel', this._t('diag.baseline_reset'));
  }
};

module.exports.statusLabel = statusLabel;
module.exports.classifyError = classifyError;

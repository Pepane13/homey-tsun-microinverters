// Production forecast tests: Open-Meteo parsing, raw model, windows, hourly calibration on the
// measured production, day-ahead accuracy, device integration and Flow cards.
// Run: node test/forecast.test.js
const Module = require('module');
const path = require('path');

const _rf = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  return r === 'homey' ? path.join(__dirname, 'homey-mock.js') : _rf.call(this, r, ...a);
};

const APP = process.env.APP || path.join(__dirname, '..', 'com.pepane13.tsun');
const mock = require('./homey-mock');
const appJson = require(`${APP}/app.json`);
const en = require(`${APP}/locales/en.json`);
const fr = require(`${APP}/locales/fr.json`);
const {
  SolarForecast, localParts, nextDay, parseTime,
} = require(`${APP}/lib/forecast`);
const { buildPath } = require(`${APP}/lib/openmeteo`);
const { buildReport } = require(`${APP}/lib/diagreport`);
const D = require(`${APP}/drivers/mx3000d/device.js`);
const Driver = require(`${APP}/drivers/mx3000d/driver.js`);

let failures = 0;
const ok = (c, m) => { if (!c) failures += 1; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };
const near = (a, b, tol) => typeof a === 'number' && Math.abs(a - b) <= tol;
const TZ = 'Europe/Paris';
const H = 3600 * 1000;
const ctx = { peakKw: 3, ratedKw: 3, timeZone: TZ };
const logs = () => mock._homey.app.diag.get('debug');
const lastLog = (re) => logs().filter((e) => re.test(e.m)).pop();
const trig = (id) => mock._trig.filter((t) => t.id === id);

/**
 * Open-Meteo-like answer (timeformat=unixtime): hourly values stamped at the END of the hour.
 * Clear-sky bell between 06:00 and 16:00 UTC (07:00-17:00 Paris in winter time), peak `peak` W/m².
 * @param {number} startUtc first hour start (ms)
 * @param {number} hours
 * @param {(t: number) => number} [cloud] multiplier per hour start
 */
function weather(startUtc, hours, peak = 800, cloud = () => 1) {
  const time = []; const gti = []; const temp = [];
  for (let k = 0; k < hours; k++) {
    const t = startUtc + k * H;
    const mid = new Date(t).getUTCHours() + 0.5;
    const g = mid > 6 && mid < 16 ? peak * Math.sin((Math.PI * (mid - 6)) / 10) * cloud(t) : 0;
    time.push((t + H) / 1000);
    gti.push(Math.round(g * 10) / 10);
    temp.push(12);
  }
  return { hourly: { time, global_tilted_irradiance: gti, temperature_2m: temp } };
}

(async () => {
  // ---------- Library ----------
  const d0 = Date.parse('2026-11-10T00:00:00Z');
  const series = SolarForecast.parse(weather(d0 - 24 * H, 96));
  ok(series[0].t === d0 - 24 * H && series.length === 96, 'parse: value stamped at the end of the hour is attached to the hour start');
  ok(SolarForecast.parse({ hourly: { time: [1, 2], global_tilted_irradiance: [-3, null] } }).length === 1, 'parse: negative GTI clamped to 0, null values skipped');
  let threw = null;
  try { SolarForecast.parse({ error: true, reason: 'Parameter tilt out of range' }); } catch (e) { threw = e.message; }
  ok(/tilt out of range/.test(threw), 'parse: Open-Meteo error reason reported');

  const p = buildPath({ lat: 43.35671, lon: 5.31234, tilt: 30, azimuth: 225, model: 'meteofrance_seamless' });
  ok(/latitude=43\.36&longitude=5\.31/.test(p), 'request: location rounded to 2 decimals (about 1 km)');
  ok(/azimuth=45&/.test(p) && /tilt=30/.test(p), 'request: compass 225° (SW) -> Open-Meteo azimuth 45');
  ok(/azimuth=-90/.test(buildPath({ lat: 1, lon: 1, tilt: 0, azimuth: 90 })) && /azimuth=0&/.test(buildPath({ lat: 1, lon: 1, tilt: 0, azimuth: 180 })), 'request: east -90, south 0');
  ok(!/models=/.test(buildPath({ lat: 1, lon: 1, tilt: 0, azimuth: 180 })) && /models=meteofrance_seamless/.test(p), 'request: model only sent when not best_match');
  ok(/timeformat=unixtime/.test(p) && /past_days=1/.test(p) && /forecast_days=3/.test(p), 'request: unix time, yesterday + 3 days');

  ok(parseTime('06:30') === 390 && parseTime('00:00', true) === 1440 && parseTime('25:00') === null && parseTime('x') === null, 'parseTime');
  ok(nextDay('2026-12-31') === '2027-01-01' && nextDay('2026-10-24') === '2026-10-25', 'nextDay');
  ok(localParts(Date.parse('2026-11-10T11:30:00Z'), TZ).minute === 12 * 60 + 30, 'localParts: Paris winter time');

  const hot = SolarForecast.raw({ gti: 1000, temp: 35 }, 3);
  const cold = SolarForecast.raw({ gti: 1000, temp: 0 }, 3);
  ok(hot < cold && near(cold, 3 * 0.85 * (1 + 0.004 * -5), 0.001), `raw model: temperature effect (${hot.toFixed(2)} vs ${cold.toFixed(2)} kWh at 1000 W/m²)`);

  const f = new SolarForecast();
  f.setSeries(series, d0);
  const total = f.dayTotal('2026-11-10', ctx);
  const morning = f.window('2026-11-10', 0, 12 * 60, ctx);
  const afternoon = f.window('2026-11-10', 12 * 60, 1440, ctx);
  ok(total > 10 && near(morning + afternoon, total, 1e-9), `window: morning ${morning.toFixed(2)} + afternoon ${afternoon.toFixed(2)} = day ${total.toFixed(2)} kWh`);
  const halfHour = f.window('2026-11-10', 12 * 60, 12 * 60 + 30, ctx);
  ok(near(halfHour, f.energy(f.entryAt(Date.parse('2026-11-10T11:00:00Z')), ctx) / 2, 1e-9), 'window: partial hour pro rata');
  ok(f.dayTotal('2026-11-13', ctx) === null && f.dayTotal('2026-11-12', ctx) !== null, 'window: null for a day not covered');
  const now = Date.parse('2026-11-10T11:30:00Z');
  ok(near(f.remaining(now, ctx), f.window('2026-11-10', 12 * 60 + 30, 1440, ctx), 1e-9), 'remaining = window from now to midnight');
  ok(f.powerAt(Date.parse('2026-11-10T02:00:00Z'), ctx) === 0, 'night: forecast power 0');

  // Inverter limit: a 6 kWp field on a 3 kW inverter is capped at 3 kWh per hour
  const big = { peakKw: 6, ratedKw: 3, timeZone: TZ };
  ok(Math.max(...f.series.map((e) => f.energy(e, big))) <= 3, 'AC output capped at the inverter rated power');

  // ---------- Calibration ----------
  // Real installation: 72 % of the raw model, and a chimney shadow at 15-16 h local (14 UTC): 35 %
  const truth = (e, k) => SolarForecast.raw(e, 3) * (new Date(e.t).getUTCHours() === 14 ? 0.35 : 0.72) * k;
  const c = new SolarForecast();
  c.setSeries(series, d0);
  let res = c.learnHour(Date.parse('2026-11-10T03:00:00Z'), 0, ctx);
  ok(!res.learned && res.reason === 'low', 'calibration: night hour not learned');
  res = c.learnHour(Date.parse('2026-11-10T10:00:00Z'), 0.001, ctx);
  ok(!res.learned && res.reason === 'outlier', 'calibration: near-zero production while sunny (fault, snow) not learned');
  res = c.learnHour(Date.parse('2026-11-20T10:00:00Z'), 1, ctx);
  ok(!res.learned && res.reason === 'no_forecast', 'calibration: hour without forecast not learned');

  for (let day = 0; day < 14; day++) {
    // same weather shape every day, ±10 % noise on the measured value
    for (const e of c.series.filter((x) => x.t >= d0 && x.t < d0 + 24 * H)) {
      const k = 1 + 0.1 * Math.sin(day * 7 + e.t / H);
      const r = c.learnHour(e.t, truth(e, k), ctx);
      if (r.learned) c.hours[r.hour].last = `d${day}`; // simulate distinct days (same series reused)
    }
    c.hours.forEach((h) => { if (h.last && h.last.startsWith('d')) h.last = `d${day}`; });
  }
  const sum = c.summary();
  ok(near(sum.globalFactor, 0.69, 0.06), `calibration: global factor ${sum.globalFactor} (truth 0.72 outside the shadow)`);
  ok(near(c.factor(15), 0.35, 0.05), `calibration: shaded hour 15h learned on its own, factor ${c.factor(15).toFixed(2)}`);
  ok(near(c.factor(11), 0.72, 0.05), `calibration: sunny hour 11h factor ${c.factor(11).toFixed(2)}`);
  const truthDay = c.series.filter((x) => localParts(x.t, TZ).day === '2026-11-10').reduce((s, e) => s + truth(e, 1), 0);
  const fcDay = c.dayTotal('2026-11-10', ctx);
  ok(near(fcDay, truthDay, truthDay * 0.05), `calibrated day forecast ${fcDay.toFixed(2)} kWh vs real ${truthDay.toFixed(2)} kWh`);
  ok(sum.hours.length >= 8 && sum.hours.every((h) => h.days >= 1), 'summary: learned hours listed');

  // Clipping: hours at the inverter limit are not learned (they would lower the factor)
  const clip = new SolarForecast();
  clip.setSeries(SolarForecast.parse(weather(d0, 24, 1100)), d0);
  res = clip.learnHour(Date.parse('2026-11-10T10:00:00Z'), 2.9, { peakKw: 4, ratedKw: 3, timeZone: TZ });
  ok(!res.learned && res.reason === 'clipping', 'calibration: clipped hour not learned');

  // Blending: a hour learned on 1 day is mostly the global factor
  const bl = new SolarForecast();
  bl.global = { a: 0.7, r: 1, n: 50 };
  bl.hours[9] = { a: 0.2, r: 1, n: 1, days: 1, last: 'x' };
  ok(near(bl.factor(9), (1 / 7) * 0.2 + (6 / 7) * 0.7, 1e-9), 'calibration: hour factor blended with the global one until 7 days');

  // Persistence
  const c2 = new SolarForecast(JSON.parse(JSON.stringify(c.toJSON())));
  ok(near(c2.factor(15), c.factor(15), 0.001) && c2.series.length === c.series.length, 'persistence: calibration and series restored');
  c2.resetCalibration();
  ok(c2.globalFactor() === 1 && c2.series.length === c.series.length, 'resetCalibration keeps the weather series');

  // Day-ahead accuracy
  const acc = new SolarForecast();
  acc.recordDayAhead('2026-11-10', 9);
  acc.recordDayAhead('2026-11-10', 10); // last forecast of the day before wins
  let r = acc.checkDay('2026-11-10', 8);
  ok(r.forecast === 10 && r.error === 25 && acc.accuracy.mape === 25, 'accuracy: +25 % on the first day');
  acc.recordDayAhead('2026-11-11', 7.5);
  r = acc.checkDay('2026-11-11', 10);
  ok(r.error === -25 && acc.accuracy.days === 2 && near(acc.accuracy.mape, 25, 1e-9) && near(acc.accuracy.bias, 0, 1e-9), 'accuracy: average |error| 25 %, bias 0');
  acc.recordDayAhead('2026-11-12', 0.4);
  r = acc.checkDay('2026-11-12', 0.3);
  ok(r.error === null && acc.accuracy.days === 2, 'accuracy: dull day not counted');
  ok(acc.checkDay('2026-11-13', 5) === null, 'accuracy: no day-ahead forecast -> nothing');
  ['a', 'b', 'c', 'd', 'e'].forEach((k, i) => acc.recordDayAhead(`2026-12-0${i + 1}`, 1));
  ok(Object.keys(acc.dayAhead).length === 3, 'accuracy: only the last 3 day-ahead forecasts kept');

  // ---------- Manifest and translations ----------
  const drv = appJson.drivers[0];
  const grp = drv.settings.find((g) => g.label.en === 'Production forecast');
  ok(grp && ['forecast_enabled', 'forecast_tilt', 'forecast_azimuth', 'forecast_peak', 'forecast_model'].every((id) => grp.children.some((s) => s.id === id)), 'manifest: forecast settings group');
  ok(grp && grp.children.find((s) => s.id === 'forecast_enabled').value === false, 'manifest: forecast off by default (opt-in, location sent to Open-Meteo)');
  ok(appJson.permissions.includes('homey:manager:geolocation'), 'manifest: geolocation permission');
  ok(appJson.flow.triggers.some((t) => t.id === 'forecast_updated') && appJson.flow.conditions.some((t) => t.id === 'forecast_window_above')
    && ['forecast_get_window', 'forecast_refresh'].every((id) => appJson.flow.actions.some((a) => a.id === id)), 'manifest: forecast Flow cards');
  ok(!drv.capabilities.some((cap) => /forecast/.test(cap)), 'manifest: forecast capabilities not added for users who do not enable it');
  const keys = (o, pre = '') => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' ? keys(v, `${pre}${k}.`) : [`${pre}${k}`]));
  const missing = keys(en).filter((k) => !keys(fr).includes(k));
  ok(missing.length === 0, `translations: every English key exists in French${missing.length ? ` (missing ${missing.join(', ')})` : ''}`);

  // ---------- Device ----------
  const realNow = Date.now;
  let clock = Date.parse('2026-11-10T06:00:00Z');
  Date.now = () => clock;
  mock._settings.log_level = 'debug';
  const settings = {
    host: '127.0.0.1', logger_sn: '1234567890', poll_interval: 30, temp_offset: 40,
    underperf_threshold: 15, underperf_delay: 15, underperf_min_power: 80, daily_threshold: 10,
    comm_alert_delay: 10, voltage_max: 253, voltage_min: 207, temp_alert: 90,
    forecast_enabled: false, forecast_tilt: 30, forecast_azimuth: 180, forecast_peak: 0, forecast_model: 'best_match',
  };
  const dev = new D(drv, settings);
  let day = '2026-11-10';
  dev._todayKey = () => day;
  let answer = weather(d0 - 24 * H, 96);
  const paths = [];
  dev._getForecastJson = async (pth) => { paths.push(pth); if (answer instanceof Error) throw answer; return answer; };
  await dev.onInit();
  dev._clear();
  ok(!dev.hasCapability('tsun_energy.forecast_today') && dev.forecastTimer === null, 'disabled: no forecast capability, no request');
  threw = null;
  try { dev.forecastWindow('today', '06:00', '12:00'); } catch (e) { threw = e.message; }
  ok(/forecast is off/.test(threw), 'disabled: Flow card ends with an explanatory error');

  // Enable
  settings.forecast_enabled = true;
  await dev._forecastSetup();
  ok(['tsun_energy.forecast_today', 'tsun_energy.forecast_remaining', 'tsun_energy.forecast_tomorrow', 'tsun_power.forecast'].every((cap) => dev.hasCapability(cap)), 'enabled: forecast capabilities added');
  ok(dev.capOptions['tsun_energy.forecast_today'].title.fr === 'Prévision du jour', 'enabled: capability titles set');
  ok(dev.forecastTimer && dev.forecastTimer.ms === 3000, 'enabled: first request scheduled');
  mock._trig.length = 0;
  ok(await dev._fetchForecast() === true, 'fetch: success');
  ok(/latitude=43\.36&longitude=5\.31/.test(paths[0]), 'fetch: Homey location rounded');
  ok(dev.forecastTimer.ms === 60 * 60 * 1000, 'fetch: next refresh in 1 h');
  const today = dev.getCapabilityValue('tsun_energy.forecast_today');
  const tomorrow = dev.getCapabilityValue('tsun_energy.forecast_tomorrow');
  ok(today > 10 && near(tomorrow, today, 0.01), `capabilities: today ${today} kWh, tomorrow ${tomorrow} kWh`);
  ok(near(dev.getCapabilityValue('tsun_energy.forecast_remaining'), today, 0.01) && dev.getCapabilityValue('tsun_power.forecast') > 0, 'capabilities: remaining (sunrise) and power of the hour');
  const t = trig('forecast_updated');
  ok(t.length === 1 && t[0].tokens.today === today && t[0].tokens.tomorrow === tomorrow, 'trigger: forecast updated with tokens');
  ok(dev.forecast.dayAhead['2026-11-11'] === tomorrow, 'day-ahead forecast of tomorrow recorded');
  ok(!!lastLog(/Forecast updated: today/), 'log: forecast update (debug)');

  // Flow cards through the driver
  const driver = new Driver();
  driver.homey = mock._homey;
  driver.log = () => {};
  await driver.onInit();
  const L = mock._listeners;
  const win = await L['action:forecast_get_window']({ device: dev, day: 'today', start: '07:00', end: '12:00' });
  ok(near(win.energy, dev.forecast.window('2026-11-10', 420, 720, dev._forecastCtx()), 0.01), `action: forecast 07:00-12:00 = ${win.energy} kWh (token)`);
  ok(await L['condition:forecast_window_above']({ device: dev, day: 'tomorrow', start: '00:00', end: '00:00', threshold: 5 }) === true, 'condition: tomorrow all day above 5 kWh');
  ok(await L['condition:forecast_window_above']({ device: dev, day: 'today', start: '17:00', end: '00:00', threshold: 0.5 }) === false, 'condition: after sunset not above 0.5 kWh');
  threw = null;
  try { dev.forecastWindow('today', '12:00', '08:00'); } catch (e) { threw = e.message; }
  ok(/Invalid time range/.test(threw), 'condition: invalid range rejected');

  // Hourly learning from the daily counter
  const read = async (iso, kwh) => { clock = Date.parse(iso); dev.caps['tsun_energy.today'] = kwh; await dev._forecastMeter(clock); };
  dev.dayStats.wake = Date.parse('2026-11-10T06:40:00Z');
  await read('2026-11-10T06:45:00Z', 0.05); // woke up during this hour: counter started from 0
  ok(dev.forecastMeter.valid && dev.forecastMeter.value === 0, 'meter: inverter woke up this hour -> hour start = 0 kWh');
  await read('2026-11-10T07:00:20Z', 0.31);
  ok(dev.forecast.hours[7].n === 1, 'meter: hour 07h learned from the counter (0.31 kWh)');
  await read('2026-11-10T07:30:00Z', 0.7);
  await read('2026-11-10T08:00:15Z', 1.2);
  ok(dev.forecast.hours[8].n === 1 && !!lastLog(/Calibration 8h: 0\.89 kWh produced/), 'meter: hour 08h learned (0.89 kWh), logged');
  await read('2026-11-10T10:05:00Z', 3.5); // gap (outage over 09h): hour 9 skipped
  await read('2026-11-10T11:00:10Z', 4.4);
  ok(dev.forecast.hours[9].n === 0 && dev.forecast.hours[10].n === 0, 'meter: hours spanned by a communication gap not learned');
  await read('2026-11-10T12:00:10Z', 5.3);
  ok(dev.forecast.hours[12].n === 1, 'meter: learning resumes after the gap');

  // Settings change of the plane: calibration restarted
  await dev.onSettings({ newSettings: { ...settings, forecast_azimuth: 200 }, changedKeys: ['forecast_azimuth'] });
  ok(dev.forecast.global.n === 0 && !!lastLog(/calibration restarted/), 'settings: orientation change restarts the calibration');
  ok(dev.forecast.series.length > 0, 'settings: weather series kept');

  // Status, report, widget
  const st = dev.getDiagStatus();
  ok(st.forecast && st.forecast.today === today && st.forecast.error === null, 'status page: forecast block');
  const rep = buildReport({ generated: new Date(clock).toISOString(), timeZone: TZ, devices: [dev.getDiagReport()], log: [] });
  ok(/Production forecast: today/.test(rep.text) && /Forecast calibration:/.test(rep.text), 'report: forecast section');
  const wd = dev.getWidgetData();
  ok(wd.forecast && wd.forecast.tomorrow === dev.getCapabilityValue('tsun_energy.forecast_tomorrow') && wd.forecast.today > 0, 'widget: forecast values');

  // Download failure: logged once, values kept, retry in 15 min, refresh action fails explicitly
  answer = new Error('getaddrinfo ENOTFOUND api.open-meteo.com');
  ok(await dev._fetchForecast() === false, 'fetch failure: reported');
  ok(dev.forecastTimer.ms === 15 * 60 * 1000 && /ENOTFOUND/.test(dev.forecastError.message), 'fetch failure: retry in 15 min, error kept for the status page');
  ok(!!lastLog(/Weather forecast download failed/) && dev.getCapabilityValue('tsun_energy.forecast_tomorrow') === tomorrow, 'fetch failure: warning logged, last forecast still used');
  threw = null;
  try { await L['action:forecast_refresh']({ device: dev }); } catch (e) { threw = e.message; }
  ok(/ENOTFOUND/.test(threw), 'refresh action: error returned to the Flow');
  answer = weather(d0 - 24 * H, 96);
  ok(await L['action:forecast_refresh']({ device: dev }) === true && !!lastLog(/downloaded again/), 'refresh action: success, recovery logged');

  // Day change: day-ahead accuracy in the log
  dev.forecast.recordDayAhead('2026-11-10', 9);
  dev.caps['tsun_energy.today'] = 7.5;
  await dev._forecastDayCheck('2026-11-10');
  ok(!!lastLog(/Forecast of 2026-11-10 \(made the day before\): 9 kWh, produced 7\.5 kWh \(\+20 %\)/), 'day change: day-ahead accuracy logged');

  // Restart: calibration and series restored from the store
  await dev._saveForecast(true);
  const dev2 = new D(drv, settings);
  dev2.store = JSON.parse(JSON.stringify(dev.store));
  dev2._todayKey = () => day;
  dev2._getForecastJson = async () => answer;
  await dev2.onInit();
  dev2._clear();
  ok(dev2.forecast.series.length === dev.forecast.series.length && dev2.forecast.accuracy.days === 1, 'restart: forecast state restored');
  ok(dev2.forecastWindow('tomorrow', '00:00', '00:00') > 0, 'restart: forecast usable before the next download');

  // Disable: capabilities removed, no more requests
  settings.forecast_enabled = false;
  await dev._forecastSetup();
  ok(!dev.hasCapability('tsun_energy.forecast_today') && dev.forecastTimer === null, 'disabled again: capabilities removed, refresh stopped');

  Date.now = realNow;
  console.log(failures ? `\n${failures} FAILED` : '\nAll forecast tests passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

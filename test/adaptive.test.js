// Adaptive panel monitoring tests: learned profile per 15-min slot, recurring shadows,
// real anomalies, usually-shaded panels, daily degradation check. Run: node test/adaptive.test.js
const Module = require('module');
const path = require('path');

const _rf = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  return r === 'homey' ? path.join(__dirname, 'homey-mock.js') : _rf.call(this, r, ...a);
};

const APP = process.env.APP || path.join(__dirname, '..', 'com.pepane13.tsun');
const mock = require('./homey-mock');
const { PanelBaseline } = require(`${APP}/lib/panelbaseline`);
const { buildReport } = require(`${APP}/lib/diagreport`);
const manifest = require(`${APP}/app.json`).drivers[0];
const D = require(`${APP}/drivers/mx3000d/device.js`);

let failures = 0;
const ok = (c, m) => { if (!c) failures += 1; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };
const trig = (id) => mock._trig.filter((t) => t.id === id);
const logs = () => mock._homey.app.diag.get('debug');
const lastLog = (re) => logs().filter((e) => re.test(e.m)).pop();
const at = (day, hhmm) => Date.parse(`${day}T${hhmm}:00+02:00`); // October 2026 = CEST (UTC+2)

(async () => {
  mock._settings.log_level = 'info';

  // ---------- PanelBaseline unit tests ----------
  ok(PanelBaseline.slotOf(at('2026-10-10', '16:20'), 'Europe/Paris') === 65, 'slot: 16:20 Paris -> slot 65');
  ok(PanelBaseline.slotOf(Date.parse('2026-12-10T15:20:00Z'), 'Europe/Paris') === 65, 'slot: winter time (UTC+1) handled');
  const b = new PanelBaseline(6);
  const shaded = [350, 245, 350, 350, 350, 350]; // PV2 at 70 % of the others
  ['2026-10-01', '2026-10-02'].forEach((day) => { for (let k = 0; k < 30; k++) b.learn(65, shaded, day); });
  ok(!b.ready(65) && b.expected(65) === null, 'baseline: not ready after 2 days');
  for (let k = 0; k < 30; k++) b.learn(65, shaded, '2026-10-03');
  const e = b.expected(65);
  ok(b.ready(65) && Math.abs(e[1] - 245 / 332.5) < 0.001, `baseline: ready after 3 days, PV2 share ${e[1].toFixed(3)}`);
  ok(b.expected(66) !== null && Math.abs(b.expected(66)[1] - e[1]) < 1e-9, 'baseline: neighbour slot (+15 min) used as fallback');
  ok(b.expected(70) === null, 'baseline: no fallback beyond ±15 min');
  const b2 = new PanelBaseline(6, JSON.parse(JSON.stringify(b.toJSON())));
  ok(b2.ready(65) && Math.abs(b2.expected(65)[1] - e[1]) < 0.0001, 'baseline: saved and restored');
  const sum = b.summary();
  ok(sum.learnedSlots === 1 && sum.readySlots === 1 && sum.hours[0].hour === 16 && sum.hours[0].ratios[1] === 74, 'baseline: hourly summary (PV2 74 % at 16 h)');

  // ---------- Device, adaptive mode ----------
  const settings = {
    host: '127.0.0.1', logger_sn: '1234567890', poll_interval: 30, temp_offset: 40,
    underperf_threshold: 15, underperf_delay: 15, underperf_min_power: 80, daily_threshold: 10,
    comm_alert_delay: 10, voltage_max: 253, voltage_min: 207, temp_alert: 80,
  }; // underperf_mode not set: adaptive by default
  const d = new D(manifest, settings);
  let day = '2026-10-10';
  d._todayKey = () => day;
  await d.onInit();
  d._clear();

  // 3 days with the same recurring shadow on PV2 from 16:00 to 16:45: no alert
  const runShadow = async (dd, powers, from = '16:00', minutes = 45) => {
    day = dd;
    const t0 = at(dd, from);
    for (let m = 0; m <= minutes; m++) await d._checkPanels(powers, t0 + m * 60000);
  };
  for (const dd of ['2026-10-10', '2026-10-11', '2026-10-12']) await runShadow(dd, shaded);
  ok(trig('panel_underperforming').length === 0, 'learning days: recurring shadow never reported');
  await runShadow('2026-10-13', shaded);
  ok(trig('panel_underperforming').length === 0, 'learned: same shadow on day 4 -> no alert');

  // Same profile in simple mode would alert
  settings.underperf_mode = 'simple';
  await runShadow('2026-10-13', shaded, '16:00', 20);
  ok(trig('panel_underperforming').length === 1, 'simple mode: the same shadow is reported (-30 % vs the others)');
  d.panelWatch.forEach((w) => { w.flagged = false; w.since = null; });
  delete settings.underperf_mode;
  mock._trig.length = 0;

  // Real anomaly: PV2 drops to 45 % at a time when it usually produces 74 %
  const sharesBefore = d.baseline.slots[64].r[1];
  await runShadow('2026-10-14', [350, 157, 350, 350, 350, 350], '16:00', 20);
  const t = trig('panel_underperforming');
  ok(t.length === 1 && t[0].tokens.panel === 2, 'anomaly vs learned profile: PV2 reported');
  ok(t.length === 1 && Math.abs(t[0].tokens.expected - 233.1) < 2 && t[0].tokens.deviation < -30, `alert tokens: expected ${t[0] && t[0].tokens.expected} W, deviation ${t[0] && t[0].tokens.deviation} %`);
  ok(/for 23\d(\.\d)? W expected at this time/.test(lastLog(/Panel 2 underperforming/).m), 'adaptive message mentions the expected power');
  ok(Math.abs(d.baseline.slots[64].r[1] - sharesBefore) < 1e-9, 'anomaly not learned as normal');
  await runShadow('2026-10-14', shaded, '16:21', 2);
  ok(!d.panelWatch[1].flagged && trig('panel_recovered').length === 1, 'back to its usual shadow: recovered');

  // Slot not learned yet (morning): no underperformance alert, only learning
  mock._trig.length = 0;
  await runShadow('2026-10-14', [350, 100, 350, 350, 350, 350], '10:00', 30);
  ok(trig('panel_underperforming').length === 0, 'unlearned time slot: no underperformance alert');

  // Usually fully shaded panel: 0 W is not reported as "not producing"
  const deep = [350, 350, 10, 350, 350, 350];
  for (const dd of ['2026-10-15', '2026-10-16', '2026-10-17']) await runShadow(dd, deep, '18:00', 30);
  mock._trig.length = 0;
  await runShadow('2026-10-18', [350, 350, 0, 350, 350, 350], '18:00', 20);
  ok(trig('panel_not_producing').length === 0, 'panel usually fully shaded at that time: 0 W not reported');
  await runShadow('2026-10-18', [350, 350, 0, 350, 350, 350], '13:00', 20);
  ok(trig('panel_not_producing').length === 1, 'same panel at 0 W at another time: reported (below 5 W while learning)');
  ok(d.baseline.slots[52].r[2] === null, 'faulty panel on the first sample of a slot: share kept unknown, not 0');

  // ---------- Daily degradation check ----------
  mock._notifications.length = 0;
  const setEnergy = (arr) => arr.forEach((v, i) => { d.caps[`tsun_panel_energy.pv${i + 1}`] = v; });
  for (let k = 0; k < 7; k++) { setEnergy([1.5, 1.2, 1.5, 1.5, 1.6, 1.5]); await d._checkDailyShares(`2026-10-0${k + 1}`); }
  ok(!!lastLog(/being learned \(day 7 of 7\)/), 'daily check: learning phase logged (7 days)');
  setEnergy([1.5, 1.2, 1.5, 1.2, 1.6, 1.5]); // PV4 -20 %
  await d._checkDailyShares('2026-10-08');
  ok(/panel 4 produced 1\.2 kWh, 17\.2 % below/.test(lastLog(/produced/).m) && mock._notifications.some((n) => /panel 4 produced/.test(n)), 'daily check: PV4 degradation reported and notified');
  ok(!lastLog(/panel 2 produced/), 'daily check: PV2 usual lower share not reported');
  setEnergy([0.1, 0.1, 0.1, 0.1, 0.1, 0.1]);
  const daysBefore = d.baseline.daily.days;
  await d._checkDailyShares('2026-10-09');
  ok(d.baseline.daily.days === daysBefore, 'daily check: dull day (< 1 kWh) ignored');

  // ---------- Summary, persistence, reset, report ----------
  const s = d.getBaselineSummary();
  ok(s.mode === 'adaptive' && s.readySlots >= 6 && s.id === 'T0000000000TEST1', `summary: ${s.learnedSlots} slots learned, ${s.readySlots} usable`);
  const h16 = s.hours.find((h) => h.hour === 16);
  ok(h16 && h16.ready && h16.ratios[1] === 74, 'summary: PV2 shown at 74 % at 16 h');
  await d._saveBaseline(true);
  const dd2 = new D(manifest, settings);
  dd2.store = JSON.parse(JSON.stringify(d.store));
  dd2._todayKey = () => day;
  await dd2.onInit();
  dd2._clear();
  ok(dd2.getBaselineSummary().readySlots === s.readySlots, 'restart: learned profile restored');
  const r = buildReport({ generated: new Date().toISOString(), timeZone: 'Europe/Paris', devices: [d.getDiagReport()], log: [] });
  ok(/Learned panel profile \(adaptive\)/.test(r.text) && /16h  10\d  74/.test(r.text) && /13h  12\d 12\d   —/.test(r.text), 'report: learned profile table included');
  await d.resetBaseline();
  ok(d.getBaselineSummary().learnedSlots === 0 && !!lastLog(/profile reset/), 'reset: profile cleared and logged');

  console.log(failures ? `\n${failures} FAILED` : '\nAll adaptive tests passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

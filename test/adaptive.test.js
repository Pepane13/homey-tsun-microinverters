// Adaptive panel monitoring tests: learned profile per 15-min slot of solar time, recurring and
// drifting shadows, cloudy days, real anomalies, usually-shaded panels, daily degradation check.
// Run: node test/adaptive.test.js
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
const utc = (day, hhmm) => Date.parse(`${day}T${hhmm}:00Z`);

(async () => {
  mock._settings.log_level = 'info';

  // ---------- PanelBaseline unit tests ----------
  ok(PanelBaseline.slotOf(utc('2026-10-10', '14:20')) === 57, 'slot: 14:20 UTC -> slot 57 (solar time)');
  ok(PanelBaseline.slotOf(utc('2026-10-24', '14:20')) === PanelBaseline.slotOf(utc('2026-10-26', '14:20')),
    'slot: same sun position before/after the time change (16:20 summer = 15:20 winter) -> same slot');
  const b = new PanelBaseline(6);
  const shaded = [350, 245, 350, 350, 350, 350]; // PV2 at 70 % of the best panel
  ['2026-10-01', '2026-10-02'].forEach((day) => { for (let k = 0; k < 30; k++) b.learn(57, shaded, day); });
  ok(!b.ready(57) && b.expected(57) === null, 'baseline: not ready after 2 days');
  for (let k = 0; k < 30; k++) b.learn(57, shaded, '2026-10-03');
  const e = b.expected(57);
  ok(b.ready(57) && Math.abs(e[1] - 0.7) < 0.001 && Math.abs(e[0] - 1) < 0.001, `baseline: ready after 3 days, PV2 share ${e[1].toFixed(3)} of the best panel`);
  ok(b.expected(59) !== null && b.expected(60) === null, 'baseline: ±30 min tolerance (slot +2 uses it, slot +3 does not)');
  ok(b.expected(57, [60, 42, 60, 60, 60, 60]) === null, 'cloudy moment (best panel at 17 % of the slot peak): no comparison');
  ok(!b.learn(57, [60, 60, 60, 60, 60, 60], '2026-10-04') && Math.abs(b.slots[57].r[1] - 0.7) < 1e-9, 'cloudy moment not learned (overcast makes all panels equal)');
  const b2 = new PanelBaseline(6, JSON.parse(JSON.stringify(b.toJSON())));
  ok(b2.ready(57) && Math.abs(b2.expected(57)[1] - 0.7) < 0.0001, 'baseline: saved and restored');
  const sum = b.summary(120);
  ok(sum.learnedSlots === 1 && sum.readySlots === 1 && sum.hours[0].hour === 16 && sum.hours[0].ratios[1] === 70, 'summary in local time: 14:15 UTC shown at 16 h with summer time');
  ok(b.summary(60).hours[0].hour === 15, 'summary in local time: shown at 15 h with winter time');
  const old = new PanelBaseline(6, { v: 1, slots: Array(96).fill(null), daily: { share: [1, 0.8, 1, 1, 1, 1], days: 9 } });
  ok(old.migrated && old.daily.days === 9 && old.slots.every((x) => x === null), 'v1 profile: intraday part restarts, daily part kept');
  const c = new PanelBaseline(6);
  for (const day of ['2026-10-01', '2026-10-02']) for (let k = 0; k < 30; k++) c.learn(40, [80, 80, 80, 80, 80, 80], day);
  for (let k = 0; k < 30; k++) c.learn(40, [350, 100, 350, 350, 350, 350], '2026-10-03');
  ok(c.slots[40].days === 1 && Math.abs(c.slots[40].r[1] - 100 / 350) < 1e-9, 'first real sun after cloudy days: the slot restarts in direct sun');

  // ---------- Device, adaptive mode ----------
  const settings = {
    host: '127.0.0.1', logger_sn: '1234567890', poll_interval: 30, temp_offset: 40,
    underperf_threshold: 15, underperf_delay: 20, underperf_min_power: 80, daily_threshold: 10,
    comm_alert_delay: 10, voltage_max: 253, voltage_min: 207, temp_alert: 90,
  }; // underperf_mode not set: adaptive by default
  const d = new D(manifest, settings);
  let day = '2026-10-10';
  d._todayKey = () => day;
  await d.onInit();
  d._clear();

  const run = async (dd, powers, from, minutes) => {
    day = dd;
    const t0 = utc(dd, from);
    for (let m = 0; m <= minutes; m++) await d._checkPanels(typeof powers === 'function' ? powers(m) : powers, t0 + m * 60000);
  };
  // 3 days with the same recurring shadow on PV2 from 14:00 to 14:45 UTC: no alert
  for (const dd of ['2026-10-10', '2026-10-11', '2026-10-12']) await run(dd, shaded, '14:00', 45);
  ok(trig('panel_underperforming').length === 0, 'learning days: recurring shadow never reported');
  await run('2026-10-13', shaded, '14:00', 45);
  ok(trig('panel_underperforming').length === 0, 'learned: same shadow on day 4 -> no alert');

  // Shadow arriving 25 min earlier than learned (seasonal drift / time change): tolerated
  const deep = [350, 60, 350, 350, 350, 350];
  for (const dd of ['2026-10-14', '2026-10-15', '2026-10-16']) {
    await run(dd, (m) => (m < 30 ? [350, 350, 350, 350, 350, 350] : deep), '10:00', 75);
  }
  await run('2026-10-17', (m) => (m < 5 ? [350, 350, 350, 350, 350, 350] : deep), '10:00', 75);
  ok(trig('panel_underperforming').length === 0, 'deep shadow starting 25 min earlier than on previous days: no alert (±30 min tolerance)');

  // Cloudy day: all panels low, no comparison
  mock._trig.length = 0;
  await run('2026-10-18', [60, 58, 61, 60, 59, 60], '14:00', 45);
  ok(trig('panel_underperforming').length === 0, 'overcast day: no alert');

  // Simple mode would alert on the learned shadow
  settings.underperf_mode = 'simple';
  await run('2026-10-19', shaded, '14:00', 25);
  ok(trig('panel_underperforming').length === 1, 'simple mode: the same shadow is reported (-30 % vs the others)');
  d.panelWatch.forEach((w) => { w.flagged = false; w.since = null; });
  delete settings.underperf_mode;
  mock._trig.length = 0;

  // Real anomaly: PV4 at 50 % at a time when it is usually in full sun
  await run('2026-10-20', [350, 245, 350, 175, 350, 350], '14:00', 25);
  const t = trig('panel_underperforming');
  ok(t.length === 1 && t[0].tokens.panel === 4, 'anomaly vs learned profile: PV4 reported');
  ok(t.length === 1 && t[0].tokens.expected >= 300 && t[0].tokens.deviation <= -40, `alert tokens: expected ${t[0] && t[0].tokens.expected} W, deviation ${t[0] && t[0].tokens.deviation} %`);
  ok(/for 3\d\d(\.\d)? W expected at this time/.test(lastLog(/Panel 4 below its usual/).m), 'adaptive message mentions the expected power');
  ok(!mock._notifications.some((n) => /Panel 4/.test(n)), 'adaptive real-time deviation: Flow card only, no notification (left to the evening verdict)');
  const shareFlagged = d.baseline.slots[57].r[3];
  await run('2026-10-20', [350, 245, 350, 175, 350, 350], '14:26', 10);
  ok(Math.abs(d.baseline.slots[57].r[3] - shareFlagged) < 1e-9, 'confirmed anomaly not learned as normal');
  await run('2026-10-20', shaded, '14:37', 2);
  ok(!d.panelWatch[3].flagged && trig('panel_recovered').length === 1, 'back to normal: recovered');

  // Slot not learned yet (morning): no underperformance alert, only learning
  mock._trig.length = 0;
  await run('2026-10-20', [350, 100, 350, 350, 350, 350], '08:00', 30);
  ok(trig('panel_underperforming').length === 0, 'unlearned time slot: no underperformance alert');

  // Usually fully shaded panel: 0 W is not reported as "not producing"
  const dark = [350, 350, 10, 350, 350, 350];
  for (const dd of ['2026-10-21', '2026-10-22', '2026-10-23']) await run(dd, dark, '16:00', 30);
  mock._trig.length = 0;
  await run('2026-10-24', [350, 350, 0, 350, 350, 350], '16:00', 25);
  ok(trig('panel_not_producing').length === 0, 'panel usually fully shaded at that time: 0 W not reported');
  await run('2026-10-24', [350, 350, 0, 350, 350, 350], '12:30', 25);
  ok(trig('panel_not_producing').length === 1, 'same panel at 0 W at another time: reported (below 5 W while learning)');
  ok(d.baseline.slots[50].r[2] === null, 'faulty panel on the first sample of a slot: share kept unknown, not 0');

  // ---------- Daily degradation check ----------
  mock._notifications.length = 0;
  const setEnergy = (arr) => arr.forEach((v, i) => { d.caps[`tsun_panel_energy.pv${i + 1}`] = v; });
  for (let k = 0; k < 7; k++) { setEnergy([1.5, 1.2, 1.5, 1.5, 1.6, 1.5]); await d._checkDailyShares(`2026-10-0${k + 1}`); }
  ok(!!lastLog(/being learned \(day 7 of 7\)/), 'daily check: learning phase logged (7 days)');
  setEnergy([1.5, 1.2, 1.5, 1.2, 1.6, 1.5]); // PV4 -20 %
  await d._checkDailyShares('2026-10-08');
  ok(/panel 4 produced 1\.2 kWh, 17\.2 % below/.test(lastLog(/produced/).m) && !mock._notifications.some((n) => /panel 4 produced/.test(n)), 'daily yield share: logged for information, not notified (depends on clouds and seasonal shadows)');
  ok(!lastLog(/panel 2 produced/), 'daily check: PV2 usual lower share not reported');
  setEnergy([0.1, 0.1, 0.1, 0.1, 0.1, 0.1]);
  const daysBefore = d.baseline.daily.days;
  await d._checkDailyShares('2026-10-09');
  ok(d.baseline.daily.days === daysBefore, 'daily check: dull day (< 1 kWh) ignored');

  // ---------- Day verdict (best share of the day) ----------
  {
    const v = new PanelBaseline(6);
    const sunnyDay = (dd, at) => { // 10 slots (2.5 h) of direct sun, 10 samples each
      for (let sl = 40; sl < 50; sl++) for (let k = 0; k < 10; k++) v.learn(sl, at(sl), dd);
    };
    // PV2 shaded until slot 45 (deeper every day: seasonal shadow), then in full sun
    const shadow = (depth) => (sl) => (sl < 45 ? [350, 350 * depth, 350, 340, 350, 345] : [350, 345, 350, 340, 350, 345]);
    let res;
    for (let k = 0; k < 5; k++) { sunnyDay(`2026-11-0${k + 1}`, shadow(0.8 - k * 0.1)); res = v.verdict(`2026-11-0${k + 1}`, 10); }
    ok(!res.ready && v.best.days === 5, 'verdict: learning on the first 5 sunny days');
    sunnyDay('2026-11-06', shadow(0.1));
    res = v.verdict('2026-11-06', 10);
    ok(res.ready && res.panels.every((p) => p.state === 'ok'), 'verdict: a shadow growing every day (seasonal) is never reported, the panel reaches its usual best share later');
    ok(v.verdict('2026-11-06', 10).done, 'verdict: only once per day');
    // cloudy day: not enough direct sun
    for (let k = 0; k < 10; k++) v.learn(40, [350, 345, 350, 340, 350, 345], '2026-11-07');
    ok(!v.verdict('2026-11-07', 10).sunny, 'verdict: day with too little direct sun not judged');
    // real defect: PV4 at 66 % all day (bypass diode)
    const diode = () => [350, 345, 350, 231, 350, 345];
    sunnyDay('2026-11-08', diode);
    res = v.verdict('2026-11-08', 10);
    ok(res.panels[3].state === 'new' && res.panels[3].dev < -30 && res.panels.filter((p) => p.state !== 'ok').length === 1, `verdict: PV4 defect reported (${res.panels[3].dev.toFixed(1)} %)`);
    const ref4 = v.best.ref[3];
    sunnyDay('2026-11-09', diode);
    res = v.verdict('2026-11-09', 10);
    ok(res.panels[3].state === 'ongoing' && v.best.ref[3] === ref4, 'verdict: anomaly in progress not learned, not notified again');
    for (let k = 10; k <= 14; k++) { sunnyDay(`2026-11-${k}`, diode); res = v.verdict(`2026-11-${k}`, 10); }
    ok(res.panels[3].state === 'accepted' && Math.abs(v.best.ref[3] - 231 / 350) < 1e-6, 'verdict: change confirmed 7 sunny days -> accepted as the new normal');
    sunnyDay('2026-11-15', diode);
    ok(v.verdict('2026-11-15', 10).panels[3].state === 'ok', 'verdict: no more alert at the accepted level');
    // irregular panel: learned spread widens its own threshold
    const w = new PanelBaseline(6);
    const irr = [0.98, 0.84, 0.97, 0.85, 0.99, 0.86];
    irr.forEach((x, k) => { for (let sl = 40; sl < 50; sl++) for (let n = 0; n < 10; n++) w.learn(sl, [350, 350 * x, 350, 350, 350, 350], `2026-12-0${k + 1}`); w.verdict(`2026-12-0${k + 1}`, 10); });
    for (let sl = 40; sl < 50; sl++) for (let n = 0; n < 10; n++) w.learn(sl, [350, 350 * 0.82, 350, 350, 350, 350], '2026-12-07');
    res = w.verdict('2026-12-07', 10);
    ok(res.panels[1].threshold > 10 && res.panels[1].state === 'ok', `verdict: naturally irregular panel -> threshold widened to ${res.panels[1].threshold.toFixed(1)} %, no false alert`);
    const v2 = new PanelBaseline(6, JSON.parse(JSON.stringify(v.toJSON())));
    ok(v2.best.days === v.best.days && Math.abs(v2.best.ref[3] - v.best.ref[3]) < 1e-4, 'verdict: learned values saved and restored');
    // today's accumulation survives a restart
    for (let k = 0; k < 10; k++) v.learn(42, [350, 345, 350, 340, 350, 345], '2026-11-16');
    const v3 = new PanelBaseline(6, JSON.parse(JSON.stringify(v.toJSON())));
    ok(v3.today.day === '2026-11-16' && v3.today.slots[42].n === 10, 'verdict: today\'s samples kept across an app restart');
  }

  // Device: notification at the evening verdict
  {
    mock._notifications.length = 0;
    const dv = new D(manifest, { ...settings });
    let dday = '2026-11-01';
    dv._todayKey = () => dday;
    await dv.onInit();
    dv._clear();
    const sunny = async (dd, powers) => {
      dday = dd;
      for (let m = 0; m < 150; m++) await dv._checkPanels(powers, utc(dd, '10:00') + m * 60000);
    };
    for (let k = 1; k <= 5; k++) { await sunny(`2026-11-0${k}`, [350, 345, 350, 340, 350, 345]); await dv._panelVerdict(`2026-11-0${k}`); }
    ok(!!lastLog(/verdict being learned \(sunny day 5 of 5\)/), 'device verdict: learning logged');
    await sunny('2026-11-06', [350, 345, 350, 340, 350, 345]);
    await dv._panelVerdict('2026-11-06');
    ok(!!lastLog(/Panel verdict for 2026-11-06: all normal/) && mock._notifications.length === 0, 'device verdict: normal day, no notification');
    await sunny('2026-11-07', [350, 345, 350, 220, 350, 345]);
    await dv._panelVerdict('2026-11-07');
    ok(mock._notifications.filter((n) => /Panel 4: on 2026-11-07, in direct sun, it did not exceed 63 %/.test(n)).length === 1, 'device verdict: PV4 defect notified once in the evening');
    await dv._panelVerdict('2026-11-07');
    ok(mock._notifications.length === 1, 'device verdict: not repeated (evening sleep then day change)');
  }

  // ---------- Summary, persistence, migration, reset, report ----------
  const off = d._utcOffsetMin();
  const h14 = String(14 + off / 60).padStart(2, '0');
  const s = d.getBaselineSummary();
  ok(s.mode === 'adaptive' && s.readySlots >= 6 && s.id === 'T0000000000TEST1', `summary: ${s.learnedSlots} slots learned, ${s.readySlots} usable`);
  const hRow = s.hours.find((h) => h.hour === 14 + off / 60);
  ok(hRow && hRow.ready && hRow.ratios[1] <= 70, `summary: PV2 shown at ${hRow && hRow.ratios[1]} % at ${h14} h local`);
  await d._saveBaseline(true);
  const dd2 = new D(manifest, settings);
  dd2.store = JSON.parse(JSON.stringify(d.store));
  dd2._todayKey = () => day;
  await dd2.onInit();
  dd2._clear();
  ok(dd2.getBaselineSummary().readySlots === s.readySlots, 'restart: learned profile restored');
  const dv1 = new D(manifest, { ...settings, underperf_delay: 15 });
  dv1.store = { panelBaseline: { v: 1, slots: Array(96).fill(null), daily: { share: [1, 1, 1, 1, 1, 1], days: 4 } } };
  dv1._todayKey = () => day;
  await dv1.onInit();
  dv1._clear();
  ok(!!lastLog(/learning restarts in solar time/) && dv1.store.panelBaseline.v === 2 && dv1.baseline.daily.days === 4, 'upgrade from v1: profile migrated and logged');
  ok(dv1.settings.underperf_delay === 30 && !!lastLog(/raised from 15 to 30 min/), 'upgrade: minimum duration 15 -> 30 min');
  const r = buildReport({ generated: new Date().toISOString(), timeZone: 'Europe/Paris', devices: [d.getDiagReport()], log: [] });
  ok(/Learned panel profile \(adaptive\)/.test(r.text) && new RegExp(`${h14}h  100  ..`).test(r.text), 'report: learned profile table included');
  await d.resetBaseline();
  ok(d.getBaselineSummary().learnedSlots === 0 && !!lastLog(/profile reset/), 'reset: profile cleared and logged');

  console.log(failures ? `\n${failures} FAILED` : '\nAll adaptive tests passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

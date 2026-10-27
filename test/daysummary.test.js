// v1.6.1 tests: daily summary built from real-life sequences (reports of 24-27 October 2026):
// inverter restarting or answering 0 at dusk, dawn and dusk flapping, Homey restarts at night.
// Run: node test/daysummary.test.js
const Module = require('module');
const path = require('path');

const _rf = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  return r === 'homey' ? path.join(__dirname, 'homey-mock.js') : _rf.call(this, r, ...a);
};

const APP = process.env.APP || path.join(__dirname, '..', 'com.pepane13.tsun');
const mock = require('./homey-mock');
const manifest = require(`${APP}/app.json`).drivers[0];
const SV = require(`${APP}/lib/solarmanv5`);
const C0 = SV.SolarmanV5Client;
SV.SolarmanV5Client = class extends C0 { constructor(o) { super({ ...o, port: 18902 }); } };
const D = require(`${APP}/drivers/mx3000d/device.js`);
const { state, srv } = require('./fakelogger');

let failures = 0;
const ok = (c, m) => { if (!c) failures += 1; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };
const logs = () => mock._homey.app.diag.get('debug');
const lastLog = (re) => logs().filter((e) => re.test(e.m)).pop();

function setRegs({
  ac = 1500, today = 5, pvDay = [0.8, 0.8, 0.8, 0.8, 0.8, 0.8], status = 1,
}) {
  const r = {};
  r[0x1100] = status; r[0x1105] = 0; r[0x1106] = 0; r[0x1200] = 2340; r[0x1201] = 640; r[0x1202] = Math.round(ac * 10);
  r[0x1209] = 5000; r[0x1210] = 3000; r[0x1212] = Math.round(today * 100); r[0x1213] = 0; r[0x1214] = 13600; r[0x1218] = 90;
  for (let n = 0; n < 6; n++) {
    const b = 0x1302 + 7 * n;
    const dd = Math.round(pvDay[n] * 100);
    r[b] = 306; r[b + 1] = 100; r[b + 2] = Math.round((ac / 6) * 10); r[b + 3] = dd >> 16; r[b + 4] = dd & 0xffff; r[b + 5] = 0; r[b + 6] = 13600;
  }
  state.regs = r;
}

const realNow = Date.now;
let clock = 0;
const at = (day, hhmm) => { clock = Date.parse(`${day}T${hhmm}:00+01:00`); }; // Paris, winter time (UTC+1)
const settings = {
  host: '127.0.0.1', logger_sn: '1234567890', poll_interval: 30, temp_offset: 40,
  underperf_threshold: 15, underperf_delay: 15, underperf_min_power: 80, comm_alert_delay: 10,
  voltage_max: 253, voltage_min: 207, temp_alert: 90, daily_threshold: 10,
};
let day = '2026-10-28';
const newDevice = async (store = {}, caps = null) => {
  const d = new D(manifest, settings);
  d.store = store;
  if (caps) d.caps = { ...caps }; // Homey keeps capability values across app restarts
  d._todayKey = () => day;
  await d.onInit();
  d._clear();
  return d;
};
const poll = async (d) => { await d._poll(); d._clear(); };
const standby = async (d) => { state.up = false; for (let k = 0; k < 3; k++) await poll(d); state.up = true; };

(async () => {
  await new Promise((r) => srv.listen(18902, '127.0.0.1', r));
  Date.now = () => clock;
  mock._settings.log_level = 'debug';

  // ---------- Day 1: dawn flapping, production, dusk restart of the inverter ----------
  at('2026-10-28', '06:52');
  const d = await newDevice({ day: '2026-10-28' });
  setRegs({ ac: 2, today: 0, pvDay: [0, 0, 0, 0, 0, 0], status: 2 });
  await poll(d); // first answer at dawn
  ok(d.dayStats.wake === clock, 'first answer of the day: active from 06:52');
  at('2026-10-28', '06:54');
  await standby(d); // dawn flapping: inverter off again
  ok(d.dayStats.sleep === Date.parse('2026-10-28T06:52:00+01:00'), 'dawn flap: standby recorded at the last answer');
  at('2026-10-28', '06:59');
  await poll(d);
  ok(d.dayStats.sleep === null && d.dayStats.wake === Date.parse('2026-10-28T06:52:00+01:00'), 'answers again: the dawn standby is not the end of the day');

  at('2026-10-28', '13:00');
  setRegs({ ac: 2100, today: 6.2, pvDay: [1.1, 0.8, 1.1, 1, 1.1, 1.1] });
  await poll(d);
  at('2026-10-28', '17:45');
  setRegs({ ac: 20, today: 10.08, pvDay: [1.9, 1.46, 1.9, 1.67, 1.73, 1.9], status: 1 });
  await poll(d);
  ok(d.caps['tsun_energy.today'] === 10.08, 'evening: 10.08 kWh');
  // Dusk: the inverter shuts down (code 2) and answers with its daily counters at 0
  at('2026-10-28', '17:50');
  setRegs({ ac: 0, today: 0, pvDay: [0, 0, 0, 0, 0, 0], status: 2 });
  await poll(d);
  ok(d.caps['tsun_energy.today'] === 10.08 && d.caps['tsun_panel_energy.pv2'] === 1.46, 'dusk: counters at 0 from the inverter, the day\'s yield is kept');
  ok(!!lastLog(/went back to 0 kWh .* 10\.08 kWh is kept/), 'dusk: counter drop logged once');
  // ...restarts and counts a few Wh again
  at('2026-10-28', '17:52');
  setRegs({ ac: 3, today: 0.01, pvDay: [0, 0, 0, 0, 0, 0], status: 2 });
  await poll(d);
  ok(d.caps['tsun_energy.today'] === 10.08, 'dusk restart: still 10.08 kWh');
  at('2026-10-28', '17:54');
  await standby(d);
  ok(d.dayStats.sleep === Date.parse('2026-10-28T17:52:00+01:00'), 'evening standby at the last answer (17:52)');
  ok(!!lastLog(/in standby at 17:52/), 'standby time logged at 17:52');
  // Dusk flapping: wakes up once more, then off
  at('2026-10-28', '18:02');
  await poll(d);
  at('2026-10-28', '18:04');
  await standby(d);
  ok(d.dayStats.sleep === Date.parse('2026-10-28T18:02:00+01:00'), 'dusk flap: end of the day moved to the last answer (18:02)');

  // Homey restart at night: no answer, the end of the day is unchanged
  await d._saveDayStats(true);
  at('2026-10-28', '20:12');
  const store = JSON.parse(JSON.stringify(d.store));
  const d2 = await newDevice(store, d.caps);
  ok(d2.dayStats.sleep === Date.parse('2026-10-28T18:02:00+01:00'), 'restart at night: day statistics restored');
  state.up = false;
  for (let k = 0; k < 3; k++) await poll(d2);
  state.up = true;
  ok(d2.standby && d2.dayStats.sleep === Date.parse('2026-10-28T18:02:00+01:00'), 'restart at night: standby time not overwritten (not 20:14)');
  ok(!!lastLog(/not answering since the app started/), 'restart at night: explained in the log');

  // ---------- Midnight: summary ----------
  day = '2026-10-29';
  at('2026-10-29', '00:02');
  state.up = false;
  await poll(d2);
  state.up = true;
  const sum = lastLog(/^Summary 2026-10-28/);
  ok(!!sum && /10\.08 kWh/.test(sum.m) && /active 06:52 to 18:02/.test(sum.m), `summary: ${sum ? sum.m.slice(0, 110) : 'missing'}`);
  ok(d2.caps['tsun_energy.today'] === 0 && d2.store.staleToday.ac === 10.08, 'new day: counters at 0, yesterday 10.08 kWh remembered');

  // ---------- Day 2 morning: the inverter has already reset its counter in the evening ----------
  at('2026-10-29', '07:00');
  setRegs({ ac: 15, today: 0.01, pvDay: [0, 0, 0, 0, 0, 0] });
  await poll(d2);
  ok(d2.caps['tsun_energy.today'] === 0.01 && d2.dayStats.wake === clock, 'next morning: small counter accepted, active from 07:00');
  at('2026-10-29', '07:30');
  setRegs({ ac: 300, today: 0.1, pvDay: [0.02, 0.02, 0.02, 0.01, 0.02, 0.01] });
  await poll(d2);
  ok(d2.caps['tsun_energy.today'] === 0.1, 'next morning: counting normally');

  Date.now = realNow;
  srv.close();
  console.log(failures ? `\n${failures} FAILED` : '\nAll daily summary tests passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { Date.now = realNow; console.error(err); process.exit(1); });

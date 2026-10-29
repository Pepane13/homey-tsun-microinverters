// v1.5.1 tests: restart in daytime (last reading restored, no false night standby, fast polling
// while unreachable), temperature default, thermal derating signature. Run: node test/restart.test.js
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
SV.SolarmanV5Client = class extends C0 { constructor(o) { super({ ...o, port: 18901 }); } };
const D = require(`${APP}/drivers/mx3000d/device.js`);
const { state, srv } = require('./fakelogger');

let failures = 0;
const ok = (c, m) => { if (!c) failures += 1; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };
const logs = () => mock._homey.app.diag.get('debug');
const lastLog = (re) => logs().filter((e) => re.test(e.m)).pop();
const settings = () => ({
  host: '127.0.0.1', logger_sn: '1234567890', poll_interval: 30, temp_offset: 40,
  underperf_threshold: 15, underperf_delay: 15, underperf_min_power: 80, comm_alert_delay: 10,
  voltage_max: 253, voltage_min: 207, temp_alert: 90,
});
const newDevice = async (store = {}) => {
  const d = new D(manifest, settings());
  d.store = store;
  d._todayKey = () => '2026-10-26';
  await d.onInit();
  d._clear();
  return d;
};
const reading = (temp, panels) => ({
  power: panels.reduce((s, p) => s + p[0], 0) * 0.95, temperature: temp, voltage: 235, frequency: 50,
  panels: panels.map(([power, voltage]) => ({ power, voltage })),
});

(async () => {
  await new Promise((r) => srv.listen(18901, '127.0.0.1', r));
  mock._settings.log_level = 'debug';
  state.up = false; // logger unreachable (network still restarting)

  // ---------- Restart in daytime: last reading restored ----------
  const d = await newDevice({ lastOk: { t: Date.now() - 3 * 60000, power: 2230 } });
  ok(d.comm.lastOk && d.comm.lastOk.power === 2230, 'restart: last reading (2230 W, 3 min old) restored');
  for (let k = 0; k < 3; k++) await d._poll();
  d._clear();
  ok(d.caps.tsun_status === 'Unreachable' && d.caps.tsun_status !== 'Standby (night)', `restart in daytime: status "${d.caps.tsun_status}", not night standby`);
  await d._poll();
  ok(d.timer && d.timer.ms === 60000, `unreachable during production: next read in ${d.timer && d.timer.ms / 1000} s (not 300 s)`);
  d._clear();
  d.comm.outage.start -= 11 * 60000;
  await d._poll();
  d._clear();
  ok(mock._trig.filter((t) => t.id === 'comm_lost').length === 0 && !!lastLog(/just after the app started/), 'restart: no communication-lost alert while the network restarts');

  // ---------- Old last reading (Homey off for hours): night standby ----------
  const n = await newDevice({ lastOk: { t: Date.now() - 2 * 3600000, power: 2230 } });
  ok(n.comm.lastOk === null, 'last reading older than 30 min: ignored');
  for (let k = 0; k < 3; k++) await n._poll();
  n._clear();
  await n._poll();
  ok(n.caps.tsun_status === 'Standby (night)' && n.timer.ms === 300000, 'no recent reading: night standby, read every 5 min');
  n._clear();

  // ---------- Last reading saved when production starts/stops ----------
  state.up = true;
  const regs = {};
  regs[0x1100] = 1; regs[0x1200] = 2337; regs[0x1201] = 171; regs[0x1202] = 3995; regs[0x1209] = 5001; regs[0x1210] = 3000; regs[0x1218] = 59;
  for (let i = 0; i < 6; i++) { const b = 0x1302 + 7 * i; regs[b] = 306; regs[b + 1] = 215; regs[b + 2] = 660; }
  state.regs = regs;
  await n._poll();
  n._clear();
  ok(n.store.lastOk && n.store.lastOk.power === 399.5, `production detected: last reading saved (${n.store.lastOk && n.store.lastOk.power} W)`);

  // ---------- Thermal derating signature ----------
  const t0 = Date.parse('2026-10-26T12:00:00Z');
  const min = (m) => t0 + m * 60000;
  const before = Array(6).fill([375, 30.0]);
  const derated = [[320, 33.0], [318, 32.9], [322, 33.1], [330, 32.6], [319, 33.0], [360, 30.3]]; // -12 %, voltage +10 % on 5 panels
  const t = await newDevice();
  ok(!(await t._checkDerating(reading(88, before), min(0), 90)), 'derating: no reference yet');
  ok(!(await t._checkDerating(reading(88, derated), min(5.5), 90)) && !!t.derateCandidate, 'derating: drop with a clear voltage rise at 88 °C -> watched, not reported yet');
  let reported = false;
  for (let m = 6; m <= 11; m++) reported = (await t._checkDerating(reading(88, derated), min(m), 90)) || reported;
  ok(reported && /Probable thermal derating at 88 °C: DC power down from 2250 to 1969 W and capped for 5 min/.test(lastLog(/thermal derating/).m), 'derating: power capped on a 5-min plateau -> reported');

  // 29/10 13:08 (real case): cloud, -54 % in 5 min with the voltage up on 4 panels, back to full power 10 min later
  const c = await newDevice();
  const shade = [[160, 33.2], [165, 33.1], [158, 33.3], [170, 33.0], [190, 31.0], [150, 30.2]];
  await c._checkDerating(reading(88, before), min(0), 90);
  await c._checkDerating(reading(88, shade), min(5.5), 90);
  await c._checkDerating(reading(87, shade), min(7), 90);
  ok(!(await c._checkDerating(reading(86, before), min(10), 90)) && !c.derateCandidate && !!lastLog(/passing cloud, not derating/), '29/10 13:08: drop then recovery -> passing cloud, not reported');
  // 29/10 12:26 (real case): power flickering under thin clouds
  const f = await newDevice();
  await f._checkDerating(reading(88, before), min(0), 90);
  await f._checkDerating(reading(88, derated), min(5.5), 90);
  let fr = false;
  for (const [k, ratio] of [[6, 0.80], [7, 0.93], [8, 0.78], [9, 0.92], [10, 0.80], [11, 0.90]]) {
    fr = (await f._checkDerating(reading(88, before.map(([p, v]) => [p * ratio, v * 1.09])), min(k), 90)) || fr;
  }
  ok(!fr && !!lastLog(/not followed by a plateau/), '29/10 12:26: flickering power -> no plateau, not reported');
  // Small voltage rise (cooling panels under a cloud) is not a derating signature any more
  const g = await newDevice();
  await g._checkDerating(reading(88, before), min(0), 90);
  await g._checkDerating(reading(88, Array(6).fill([320, 31.5])), min(5.5), 90);
  ok(!g.derateCandidate, 'voltage +5 % only (cooling panels) -> not watched');
  // Too far below the alert limit
  const cool = await newDevice();
  await cool._checkDerating(reading(79, before), min(0), 90);
  await cool._checkDerating(reading(79, derated), min(5.5), 90);
  ok(!cool.derateCandidate, 'same signature at 79 °C (more than 5 °C below the 90 °C limit) -> ignored');

  srv.close();
  console.log(failures ? `\n${failures} FAILED` : '\nAll restart tests passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

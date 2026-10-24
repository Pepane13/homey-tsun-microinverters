// Diagnostics tests: error classification, diagnostic log, communication analysis,
// panel / grid / inverter alerts and daily summary. Run: node test/diagnostics.test.js
const Module = require('module');
const path = require('path');

const _rf = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  return r === 'homey' ? path.join(__dirname, 'homey-mock.js') : _rf.call(this, r, ...a);
};

const APP = process.env.APP || path.join(__dirname, '..', 'com.pepane13.tsun');
process.env.APP = APP;
const mock = require('./homey-mock');
const { DiagLog } = require(`${APP}/lib/diaglog`);
const { buildReport, maskSerial } = require(`${APP}/lib/diagreport`);
const manifest = require(`${APP}/app.json`).drivers[0];
const SV = require(`${APP}/lib/solarmanv5`);
const C0 = SV.SolarmanV5Client;
SV.SolarmanV5Client = class extends C0 { constructor(o) { super({ ...o, port: 18899 }); } };
const D = require(`${APP}/drivers/mx3000d/device.js`);
const { state, srv } = require('./fakelogger');

let failures = 0;
const ok = (c, m) => { if (!c) failures += 1; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };
const logs = (level) => mock._homey.app.diag.get(level || 'debug');
const lastLog = (re) => logs().filter((e) => re.test(e.m)).pop();
const trig = (id) => mock._trig.filter((t) => t.id === id);

function setRegs({
  ac = 2004, v = 236.5, temp = 73, today = 5.73, total = 1321.1, alarms = 0,
  pv = [348.7, 359.7, 348.7, 346.2, 373.1, 344.1], pvV = [30.6, 30.6, 30.7, 30.7, 30.2, 30.2],
}) {
  const r = {};
  r[0x1100] = 1; r[0x1105] = alarms; r[0x1106] = 0;
  r[0x1200] = Math.round(v * 10); r[0x1201] = 847; r[0x1202] = Math.round(ac * 10); r[0x1209] = 5003; r[0x1210] = 3000;
  r[0x1212] = Math.round(today * 100);
  const t = Math.round(total * 100); r[0x1213] = t >> 16; r[0x1214] = t & 0xffff;
  r[0x1218] = temp + 40;
  pv.forEach((p, n) => {
    const b = 0x1302 + 7 * n;
    r[b] = Math.round(pvV[n] * 10); r[b + 1] = 1139; r[b + 2] = Math.round(p * 10);
    r[b + 3] = 0; r[b + 4] = 100; r[b + 5] = 0; r[b + 6] = 21926;
  });
  state.regs = r;
}

(async () => {
  // ---------- classifyError ----------
  const cl = D.classifyError;
  ok(cl({ code: 'ETIMEDOUT', phase: 'connect' }) === 'unreachable', 'classify: connect timeout -> unreachable (Wi-Fi)');
  ok(cl({ code: 'EHOSTUNREACH', phase: 'connect' }) === 'unreachable', 'classify: EHOSTUNREACH -> unreachable');
  ok(cl({ code: 'ECONNREFUSED', phase: 'connect' }) === 'port_closed', 'classify: ECONNREFUSED -> port_closed');
  ok(cl({ code: 'ETIMEDOUT', phase: 'read' }) === 'no_response', 'classify: read timeout -> no_response');
  ok(cl({ code: 'ECLOSED', phase: 'read' }) === 'closed', 'classify: ECLOSED -> closed');
  ok(cl({ code: 'EV5' }) === 'inverter_silent', 'classify: V5 exception -> inverter_silent');
  ok(cl({ code: 'ECRC' }) === 'corrupt', 'classify: CRC -> corrupt');
  ok(cl({ code: 'ESERIAL' }) === 'serial', 'classify: wrong serial -> serial');

  // ---------- DiagLog ----------
  const store = {};
  const h = { settings: { get: (k) => store[k] ?? null, set: (k, v) => { store[k] = v; } }, setTimeout: () => ({}), clearTimeout() {} };
  const dl = new DiagLog(h);
  dl.add('debug', 'x', 'comm', 'hidden at info level');
  dl.add('info', 'x', 'comm', 'kept');
  ok(dl.get().length === 1, 'log: debug entries dropped at default level (info)');
  store.log_level = 'debug';
  dl.add('debug', 'x', 'comm', 'kept at debug level');
  ok(dl.get().length === 2 && dl.get('info').length === 1, 'log: level setting and read filter');
  for (let i = 0; i < 1600; i++) dl.add('info', 'x', 'comm', `n${i}`);
  ok(dl.get().length === 1500 && dl.get().pop().m === 'n1599', 'log: ring buffer capped at 1500 entries');
  dl.flush();
  ok(Array.isArray(store.diag_log) && store.diag_log.length === 1500, 'log: persisted to app settings on flush');
  ok(new DiagLog(h).get().length === 1500, 'log: restored after restart');

  // ---------- Device ----------
  await new Promise((r) => srv.listen(18899, '127.0.0.1', r));
  mock._settings.log_level = 'debug';
  const d = new D(manifest, {
    host: '127.0.0.1', logger_sn: '1234567890', poll_interval: 30, temp_offset: 40,
    underperf_threshold: 15, underperf_delay: 15, underperf_min_power: 80, underperf_mode: 'simple',
    comm_alert_delay: 10, voltage_max: 253, voltage_min: 207, temp_alert: 80,
  });
  let day = '2026-10-23';
  d._todayKey = () => day;
  await d.onInit();
  ok(manifest.capabilities.includes('tsun_latency.logger') && 'tsun_ratio.comm' in d.caps, 'capabilities: response time and communication success added');

  setRegs({});
  await d._poll();
  ok(typeof d.caps['tsun_latency.logger'] === 'number' && d.caps['tsun_ratio.comm'] === 100, `poll OK: response time ${d.caps['tsun_latency.logger']} ms, success 100 %`);
  ok(!!lastLog(/^OK \d+ ms/), 'debug level: every read is logged');

  // Short drop during production (1 failure, then OK)
  state.up = false;
  await d._poll();
  ok(/producing 2004 W/.test(lastLog(/Read failed while/).m), 'daytime failure logged as warning with last power');
  ok(d.caps['tsun_ratio.comm'] === 50, `success rate counts daytime failures (${d.caps['tsun_ratio.comm']} %)`);
  state.up = true;
  await d._poll();
  ok(!!lastLog(/Isolated failed read, recovered/) && !lastLog(/Short communication drop/), 'isolated failure (1 cycle): debug trace only, no warning');
  ok(!logs('warn').some((e) => /Read failed while/.test(e.m)), 'first failed cycle is not a warning');
  ok(trig('comm_lost').length === 0 && mock._notifications.length === 0, 'short drop: no alert, no notification');

  // Collisions on the logger–inverter link: retried within the cycle
  d.retryDelayMs = 50;
  const r0 = d.dayStats.retries;
  state.corrupt = 1;
  await d._poll();
  ok(d.dayStats.retries === r0 + 1 && d.comm.outage === null && d.caps['tsun_ratio.comm'] > 0, 'corrupted answer: retried, cycle OK, no failure');
  ok(/Retry #1 after a transient error: corrupted answer on the logger–inverter link/.test(lastLog(/Retry #/).m), 'retry logged (debug) with the serial-link cause');
  state.silent = 2;
  await d._poll();
  ok(d.dayStats.retries === r0 + 3 && d.comm.outage === null, 'inverter not answering twice: 2 retries, cycle OK');
  state.corrupt = 3; // more than the 2 retries: the cycle fails
  await d._poll();
  ok(d.comm.outage && d.comm.outage.cause === 'corrupt' && !logs('warn').some((e) => /consecutive failed reads/.test(e.m)), 'cycle failed after 2 retries: no warning yet');
  state.corrupt = 3;
  await d._poll();
  ok(logs('warn').some((e) => /2 consecutive failed reads while the inverter was producing/.test(e.m)), '2 consecutive failed cycles: warning');
  await d._poll();
  ok(!!lastLog(/Short communication drop of .* \(2 failed reads/), 'drop of 2 cycles: warning when it comes back');
  // Slow answer with a fast connection: logger busy, not Wi-Fi
  state.delayMs = 1100; // 3 requests -> > 3 s
  const slow0 = d.dayStats.slowBusy;
  await d._poll();
  state.delayMs = 0;
  ok(d.dayStats.slowBusy === slow0 + 1 && /logger busy with the inverter, not a Wi-Fi issue/.test(lastLog(/Slow answer/).m), 'slow answer, fast connection: logger busy (debug), not Wi-Fi');
  ok(!logs('warn').some((e) => /Slow logger connection/.test(e.m)), 'no Wi-Fi warning for a busy logger');
  // Retry rate over the last hour
  const nowT = Date.now();
  d.comm.window = Array.from({ length: 80 }, (_, k) => ({ t: nowT - k * 30000, ok: true, retried: k % 3 === 0 }));
  d._checkRetryRate(nowT);
  ok(/Logger–inverter link disturbed: 33\.8 %/.test((lastLog(/link disturbed/) || {}).m), 'retry rate >= 20 % over 1 h: warning');
  d.comm.window = [];

  // Long outage during production -> alert after the delay
  state.up = false;
  await d._poll();
  d.comm.outage.start -= 11 * 60000; // simulate 11 minutes
  await d._poll();
  ok(trig('comm_lost').length === 1 && /closed by the logger/.test(trig('comm_lost')[0].tokens.cause), 'outage > 10 min during production: comm_lost Flow with cause');
  ok(mock._notifications.some((n) => /unreachable for 11 min/.test(n)), 'outage: timeline notification sent');
  ok(logs('error').some((e) => /unreachable for 11 min/.test(e.m)), 'outage: error entry in the log');
  await d._poll();
  ok(trig('comm_lost').length === 1, 'outage: alert sent only once');
  ok(d.caps.tsun_status === 'Unreachable' && /Wi-Fi/.test(d.warning) && d.caps.measure_power === 0, 'outage during production: status Unreachable, not night standby');
  const st = d.getDiagStatus();
  ok(st.currentOutage && st.currentOutage.duringProduction && st.lastError.cause === 'closed', 'status page: current outage and last error');
  state.up = true;
  await d._poll();
  ok(trig('comm_restored').length === 1 && mock._notifications.some((n) => /restored after/.test(n)), 'restore: comm_restored Flow and notification');
  ok(d.dayStats.outages === 3, 'daily stats: 3 drops during production');

  // Notifications can be disabled
  mock._settings.notify_comm = false;
  state.up = false;
  await d._poll();
  d.comm.outage.start -= 11 * 60000;
  const n0 = mock._notifications.length;
  await d._poll();
  ok(trig('comm_lost').length === 2 && mock._notifications.length === n0, 'notify_comm off: Flow still triggered, no notification');
  mock._settings.notify_comm = true;
  state.up = true;
  await d._poll();

  // Evening: low power then standby -> no alert
  setRegs({ ac: 12, pv: [2, 2, 2, 2, 2, 2] });
  await d._poll();
  state.up = false;
  const lost = trig('comm_lost').length;
  for (let i = 0; i < 3; i++) await d._poll();
  d.comm.outage.start -= 10 * 3600000;
  await d._poll();
  ok(d.standby && trig('comm_lost').length === lost, 'night standby: no communication alert');
  ok(d.caps.tsun_status === 'Standby (night)', 'night: status Standby (night)');
  ok(!!lastLog(/in standby at/), 'standby time logged');
  ok(!!lastLog(/Read failed, inverter probably stopped/), 'night failure logged as info');

  // Daily summary at midnight, then wake-up
  day = '2026-10-24';
  state.up = true;
  setRegs({ ac: 40, today: 0.01, pv: [7, 7, 7, 7, 7, 7] });
  await d._poll();
  const sum = lastLog(/^Summary 2026-10-23/);
  ok(!!sum && /5\.73 kWh/.test(sum.m) && /peak 2004 W/.test(sum.m) && /drops during production: 4/.test(sum.m) && /retries 7 \(corrupted 5, no answer 2\)/.test(sum.m), 'daily summary logged at day change');
  if (sum) console.log(`     ${sum.m}`);
  ok(!!lastLog(/awake at .* after 10/), 'wake-up time logged after the night');

  // Grid, temperature, efficiency, alarm
  const n1 = mock._notifications.length;
  setRegs({ v: 255.2 });
  await d._poll();
  await d._poll();
  ok(logs('warn').filter((e) => /Grid voltage high: 255.2 V/.test(e.m)).length === 1, 'grid overvoltage logged once (rate limited)');
  ok(mock._notifications.length === n1, 'grid notification off by default');
  setRegs({ temp: 85 });
  await d._poll();
  ok(!!lastLog(/High inverter temperature: 85/) && mock._notifications.some((n) => /85/.test(n)), 'high temperature: warning and notification');
  setRegs({ ac: 1500 });
  await d._poll();
  ok(!!lastLog(/Low conversion efficiency: 70\.7 %/), 'low DC→AC efficiency logged');
  setRegs({ alarms: 4 });
  await d._poll();
  ok(logs('error').some((e) => /reports Alarm 0x0004/.test(e.m)) && mock._notifications.some((n) => /Alarm 0x0004/.test(n)), 'inverter alarm: error and notification');

  // Panel not producing (0 V -> disconnected)
  const t0 = Date.now();
  for (let m = 0; m <= 16; m++) await d._checkPanels([350, 355, 0, 348, 370, 345], t0 + m * 60000, [30, 30, 0, 30, 30, 30]);
  ok(trig('panel_not_producing').length === 1 && trig('panel_not_producing')[0].tokens.panel === 3, 'panel 3 not producing: Flow triggered');
  ok(/disconnected/.test(lastLog(/Panel 3 is not producing/).m), 'panel at 0 V: disconnection hint');
  ok(mock._notifications.filter((n) => /Panel 3/.test(n)).length === 1, 'panel not producing: one notification (no duplicate underperformance notification)');
  ok(d.getDiagStatus().panelsNotProducing.join() === '3' && d.isUnderperforming(), 'status page and Flow condition report panel 3');
  await d._checkPanels([350, 355, 340, 348, 370, 345], t0 + 20 * 60000, [30, 30, 30, 30, 30, 30]);
  ok(!d.isUnderperforming() && !!lastLog(/Panel 3 back to normal/), 'panel back to normal logged');

  // Underperforming panel with voltage present
  for (let m = 0; m <= 16; m++) await d._checkPanels([350, 355, 250, 348, 370, 345], t0 + (30 + m) * 60000);
  ok(!!lastLog(/Panel 3 underperforming: 250 W/) && mock._notifications.some((n) => /Panel 3 underperforming/.test(n)), 'underperforming panel: warning and notification');

  // ---------- Diagnostic report ----------
  ok(maskSerial('3400000001') === '******0001' && maskSerial('T0000000000TEST1') === '************EST1', 'report: serial numbers masked');
  const rep = d.getDiagReport();
  ok(rep.settings.logger_sn === '******7890' && rep.settings.host === '127.0.0.1', 'report: device settings with masked logger serial');
  ok(typeof rep.values['tsun_latency.logger'] === 'number' && rep.today.ok > 0, 'report: current values and daily stats included');
  const r = buildReport({
    generated: '2026-10-24T09:30:00.000Z', timeZone: 'Europe/Paris', appVersion: '1.3.1', homeyVersion: '13.5.3',
    appSettings: { log_level: 'debug', notify_grid: true }, devices: [rep], log: logs(),
  });
  ok(/^TSUN Micro-inverters — diagnostic report/.test(r.text) && /Generated: 2026-10-24 11:30:00 \(Europe\/Paris\)/.test(r.text), 'report: header with Homey time zone');
  ok(/grid on/.test(r.text) && /== Device: TSUN test ==/.test(r.text) && /serial \*\*\*\*\*\*7890/.test(r.text), 'report: settings and device section');
  ok(new RegExp(`Diagnostic log \\(${logs().length} entries`).test(r.text) && /ERROR \[comm\] TSUN test: Inverter unreachable/.test(r.text), 'report: whole log, one line per entry');
  const raw = JSON.parse(r.text.slice(r.text.indexOf('== Raw data (JSON) ==') + 22));
  ok(raw.log.length === logs().length && raw.devices[0].settings.logger_sn === '******7890', 'report: raw JSON part is valid and complete');
  ok(r.filename === 'tsun-diagnostic-2026-10-24-11-30.txt', `report: file name ${r.filename}`);
  ok(!/1234567890/.test(r.text), 'report: full logger serial never appears');

  // ---------- Daily statistics survive a restart ----------
  await d._saveDayStats(true);
  const okBefore = d.dayStats.ok;
  const d2 = new D(manifest, d.settings);
  d2.caps = { ...d.caps };
  d2.store = JSON.parse(JSON.stringify(d.store));
  d2._todayKey = () => day;
  await d2.onInit();
  ok(d2.dayStats.ok === okBefore && d2.dayStats.peak === d.dayStats.peak && d2.dayStats.outages === d.dayStats.outages, `restart: today's statistics restored (${okBefore} reads OK)`);
  ok(!!lastLog(/statistics restored after a restart/), 'restart: restoration logged');
  const d3 = new D(manifest, d.settings);
  d3.caps = { ...d.caps };
  d3.store = JSON.parse(JSON.stringify(d.store));
  d3._todayKey = () => '2026-10-25';
  await d3.onInit();
  ok(d3.dayStats.ok === 0, 'restart on another day: statistics not restored');
  ok(/^\d{4}-\d{2}-\d{2}T/.test(d.getDiagReport().today.peakAt), 'report: daily times in ISO format');

  srv.close();
  console.log(failures ? `\n${failures} FAILED` : '\nAll diagnostics tests passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

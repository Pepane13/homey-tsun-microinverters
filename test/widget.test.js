// Dashboard widget tests: data returned by the device and the app, realtime event,
// manifest entry, and rendering of the widget page in Chromium. Run: node test/widget.test.js
const Module = require('module');
const path = require('path');
const fs = require('fs');

const _rf = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  return r === 'homey' ? path.join(__dirname, 'homey-mock.js') : _rf.call(this, r, ...a);
};

const APP = process.env.APP || path.join(__dirname, '..', 'com.pepane13.tsun');
const mock = require('./homey-mock');
const appJson = require(`${APP}/app.json`);
const SV = require(`${APP}/lib/solarmanv5`);
const C0 = SV.SolarmanV5Client;
SV.SolarmanV5Client = class extends C0 { constructor(o) { super({ ...o, port: 18900 }); } };
const D = require(`${APP}/drivers/mx3000d/device.js`);
const TsunApp = require(`${APP}/app.js`);
const { state, srv } = require('./fakelogger');

let failures = 0;
const ok = (c, m) => { if (!c) failures += 1; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };

function setRegs(pv) {
  const r = {};
  r[0x1100] = 1; r[0x1105] = 0; r[0x1106] = 0; r[0x1200] = 2337; r[0x1201] = 171; r[0x1202] = 3995; r[0x1209] = 5001; r[0x1210] = 3000;
  r[0x1212] = 152; r[0x1213] = 0; r[0x1214] = 40000; r[0x1218] = 59;
  pv.forEach((p, n) => {
    const b = 0x1302 + 7 * n;
    r[b] = 306; r[b + 1] = 215; r[b + 2] = Math.round(p * 10); r[b + 3] = 0; r[b + 4] = 25; r[b + 5] = 0; r[b + 6] = 21926;
  });
  state.regs = r;
}

(async () => {
  await new Promise((r) => srv.listen(18900, '127.0.0.1', r));

  // ---------- Manifest ----------
  const w = appJson.widgets && appJson.widgets.production;
  ok(!!w && w.api && w.api.getData && w.api.getData.path === '/', 'manifest: widget "production" with GET / endpoint');
  ['public/index.html', 'api.js', 'preview-light.png', 'preview-dark.png'].forEach((f) => ok(fs.existsSync(`${APP}/widgets/production/${f}`), `widget file ${f}`));
  const re = new RegExp(w.settings.find((s) => s.id === 'order').pattern);
  ok(re.test('5,4,2,6,1,3') && re.test('1 2 3') && !re.test('7,1') && !re.test('a'), 'order setting pattern');

  // ---------- Device data ----------
  const d = new D(appJson.drivers[0], {
    host: '127.0.0.1', logger_sn: '1234567890', poll_interval: 30, temp_offset: 40,
    underperf_threshold: 15, underperf_delay: 15, underperf_min_power: 80, underperf_mode: 'simple',
  });
  d._todayKey = () => '2026-10-24';
  await d.onInit();
  setRegs([65.8, 61.4, 74.2, 69.1, 74.5, 77.5]);
  await d._poll();
  ok(mock._realtime.some((e) => e.event === 'tsun_update' && e.data.id === 'T0000000000TEST1'), 'realtime "tsun_update" emitted after a read');
  const wd = d.getWidgetData();
  ok(wd.power === 399.5 && wd.voltage === 233.7 && wd.frequency === 50.01 && wd.temperature === 19, `values: ${wd.power} W, ${wd.voltage} V, ${wd.frequency} Hz, ${wd.temperature} °C`);
  ok(wd.ratedPower === 3000 && wd.today === 1.52 && wd.dc === 422.5 && Math.abs(wd.efficiency - 94.6) < 0.1, `rated ${wd.ratedPower} W, today ${wd.today} kWh, DC ${wd.dc} W, efficiency ${wd.efficiency} %`);
  ok(wd.panels.length === 6 && wd.panels[4].power === 74.5 && wd.panels[4].voltage === 30.6 && wd.panels.every((p) => p.state === 'ok'), 'six panels with power, voltage and state');
  ok(!wd.unreachable && !wd.standby && typeof wd.lastRead === 'string', `status flags, last read ${wd.lastRead}`);
  d.zeroWatch[2].flagged = true; d.panelWatch[1].flagged = true;
  const wd2 = d.getWidgetData();
  ok(wd2.panels[2].state === 'zero' && wd2.panels[1].state === 'under', 'panel states: zero and under');
  d.zeroWatch[2].flagged = false; d.panelWatch[1].flagged = false;

  // ---------- App endpoint ----------
  const app = Object.create(TsunApp.prototype);
  app.homey = { ...mock._homey, drivers: { getDriver: () => ({ getDevices: () => [d] }) } };
  const ad = app.getWidgetData('0');
  ok(ad.count === 1 && ad.device.id === 'T0000000000TEST1' && ad.labels.today === 'Today', 'app: widget data and labels');
  ok(app.getWidgetData(5).device.id === 'T0000000000TEST1', 'app: index beyond range uses the last inverter');
  app.homey = { ...mock._homey, drivers: { getDriver: () => ({ getDevices: () => [] }) } };
  ok(app.getWidgetData(0).device === null, 'app: no inverter -> device null');

  // ---------- Rendering ----------
  let chromium;
  try { ({ chromium } = require('playwright')); } catch (e) { console.log('SKIP rendering (playwright not available)'); }
  if (chromium) {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 360, height: 900 } });
    const html = fs.readFileSync(`${APP}/widgets/production/public/index.html`, 'utf8');
    await page.setContent(html.replace('<body', '<body style="padding:16px"'));
    const data = { device: wd, count: 1, labels: require(`${APP}/locales/en.json`).widget };
    await page.evaluate((payload) => {
      window.__h = null;
      window.onHomeyReady({
        getSettings: () => ({ order: '5,4,2,6,1,3', columns: '3', panel_max: 500, device: 1 }),
        ready: ({ height }) => { window.__h = height; },
        setHeight: (h) => { window.__h = h; },
        api: () => Promise.resolve(payload),
        on: () => {},
      });
    }, data);
    await page.waitForFunction(() => window.__h !== null);
    const r = await page.evaluate(() => ({
      h: window.__h,
      names: [...document.querySelectorAll('.panel .name span:first-child')].map((e) => e.textContent),
      chips: document.querySelectorAll('.chip').length,
      power: document.querySelector('.power .val').textContent,
    }));
    ok(r.names.join(',') === 'PV5,PV4,PV2,PV6,PV1,PV3', `panels in the configured order: ${r.names.join(',')}`);
    ok(r.chips === 8 && /400|399/.test(r.power), `top band: ${r.chips} values, power ${r.power}`);
    ok(r.h > 300 && r.h < 800, `widget height reported to Homey: ${r.h} px`);

    // Forecast enabled: one more value in the top band, after the total
    await page.setContent(html.replace('<body', '<body style="padding:16px"'));
    const fdata = { ...data, device: { ...wd, forecast: { today: 9.4, remaining: 3.1, tomorrow: 11.2 } } };
    await page.evaluate((payload) => {
      window.__h = null;
      window.onHomeyReady({
        getSettings: () => ({ order: '1,2,3,4,5,6', columns: '3', panel_max: 500, device: 1 }),
        ready: ({ height }) => { window.__h = height; },
        setHeight: (h) => { window.__h = h; },
        api: () => Promise.resolve(payload),
        on: () => {},
      });
    }, fdata);
    await page.waitForFunction(() => window.__h !== null);
    const rf = await page.evaluate(() => ({
      h: window.__h,
      chips: [...document.querySelectorAll('.chip')].map((c) => c.textContent.replace(/\s+/g, ' ').trim()),
    }));
    ok(rf.chips.length === 9 && /Forecast.*3[.,]1 \/ 9[.,]4 kWh/.test(rf.chips[2]), `forecast in the top band: "${rf.chips[2]}"`);
    ok(rf.h > 300 && rf.h < 800, `widget height with the forecast: ${rf.h} px`);
    if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });
    await browser.close();
  }

  srv.close();
  console.log(failures ? `\n${failures} FAILED` : '\nAll widget tests passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

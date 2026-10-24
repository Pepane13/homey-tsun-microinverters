'use strict';
// Local reading of a TSUN MX3000D micro-inverter using the Homey app code.
// Usage:  node tsun_compare.js <logger_ip> <logger_sn> [interval_s]
//   ex.    node tsun_compare.js 192.168.1.50 3400000000        -> single reading
//          node tsun_compare.js 192.168.1.50 3400000000 30     -> one reading every 30 s
const { SolarmanV5Client } = require('./com.pepane13.tsun/lib/solarmanv5');
const { readAll } = require('./com.pepane13.tsun/lib/mx3000d');

const [HOST, SN, EVERY] = process.argv.slice(2);
if (!HOST || !/^\d{6,10}$/.test(SN || '')) {
  console.log('Usage: node tsun_compare.js <logger_ip> <logger_sn> [interval_s]');
  process.exit(1);
}
const SERIAL = Number(SN);
const every = Number(EVERY) || 0;
const f = (v, d = 1) => v.toFixed(d).padStart(8);

async function once() {
  const c = new SolarmanV5Client({ host: HOST, serial: SERIAL, timeout: 8000 });
  try {
    await c.connect();
    const d = await readAll(c);
    const dc = d.panels.reduce((s, p) => s + p.power, 0);
    const dcDay = d.panels.reduce((s, p) => s + p.energyToday, 0);
    console.log(`\n=== ${new Date().toLocaleString()} ===`);
    console.log(`AC: ${d.power} W | ${d.voltage} V | ${d.current} A | ${d.frequency} Hz | ${d.temperature} °C | status ${d.status}`);
    console.log(`Inverter today: ${d.energyToday} kWh | Total: ${d.energyTotal} kWh`);
    console.log('Panel     Voltage  Current  Power W   V×I W Today kWh  Total kWh');
    d.panels.forEach((p, i) => console.log(
      `  PV${i + 1}  ${f(p.voltage)} ${f(p.current, 2)} ${f(p.power)} ${f(p.voltage * p.current)} ${f(p.energyToday, 2)} ${f(p.energyTotal, 2).padStart(10)}`));
    console.log(`  DC sum: ${dc.toFixed(1)} W (efficiency ${(100 * d.power / dc).toFixed(1)} %) | panels today: ${dcDay.toFixed(2)} kWh`);
  } catch (e) {
    console.log(`${new Date().toLocaleTimeString()} ERROR ${e.code || ''} ${e.message}`);
  } finally { c.close(); }
}

(async () => { await once(); if (every) setInterval(once, every * 1000); })();

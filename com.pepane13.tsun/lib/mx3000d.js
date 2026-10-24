'use strict';

/**
 * Register map of TSUN 6-in-1 micro-inverters (MX3000D),
 * based on the tsun-gen3-proxy wiki, validated on a real installation
 * (32-bit values: high word first).
 */

const u32 = (hi, lo) => (hi * 65536) + lo;
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

function decodeSerial(regs) {
  let s = '';
  for (const r of regs) {
    for (const c of [r >> 8, r & 0xff]) {
      if (c >= 32 && c < 127) s += String.fromCharCode(c);
    }
  }
  return s.trim();
}

async function readIdentity(client) {
  const r = await client.readHoldingRegisters(0x1000, 8);
  return { inverterSerial: decodeSerial(r) };
}

// Errors caused by a collision on the logger–inverter serial link (the logger polls the inverter
// for the TSUN cloud at the same time): retried after a short pause on the same connection.
const TRANSIENT_CODES = ['ECRC', 'ECHECKSUM', 'EFRAMETYPE', 'EV5', 'ETIMEDOUT'];
const RETRY_DELAY_MS = 1500;
const MAX_RETRIES = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readWithRetry(client, address, quantity, { onRetry, retryDelayMs = RETRY_DELAY_MS } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.readHoldingRegisters(address, quantity);
    } catch (err) {
      const retries = err.code === 'ETIMEDOUT' ? 1 : MAX_RETRIES; // a timeout already took 8 s
      if (attempt >= retries || !TRANSIENT_CODES.includes(err.code) || !client.socket) throw err;
      if (onRetry) onRetry(err, attempt + 1);
      await sleep(retryDelayMs);
    }
  }
}

/**
 * Reads all measurements.
 * @param {import('./solarmanv5').SolarmanV5Client} client
 * @param {object} [opts]
 * @param {number} [opts.tempOffset=40]
 * @param {(err: Error, attempt: number) => void} [opts.onRetry] called before each retry
 * @param {number} [opts.retryDelayMs]
 */
async function readAll(client, { tempOffset = 40, onRetry, retryDelayMs } = {}) {
  const o = { onRetry, retryDelayMs };
  const st = await readWithRetry(client, 0x1100, 7, o);
  const g = await readWithRetry(client, 0x1200, 0x19, o);
  const pv = await readWithRetry(client, 0x1302, 42, o);

  const panels = [];
  for (let n = 0; n < 6; n++) {
    const b = n * 7;
    panels.push({
      voltage: round(pv[b] * 0.1, 1),
      current: round(pv[b + 1] * 0.01),
      power: round(pv[b + 2] * 0.1, 1),
      energyToday: round(u32(pv[b + 3], pv[b + 4]) * 0.01),
      energyTotal: round(u32(pv[b + 5], pv[b + 6]) * 0.01),
    });
  }

  return {
    status: st[0],
    alarms: st[5],
    faults: st[6],
    voltage: round(g[0x00] * 0.1, 1),
    current: round(g[0x01] * 0.01),
    power: round(g[0x02] * 0.1, 1),
    frequency: round(g[0x09] * 0.01),
    ratedPower: g[0x10],
    energyToday: round(g[0x12] * 0.01),
    energyTotal: round(u32(g[0x13], g[0x14]) * 0.01),
    temperature: g[0x18] - tempOffset,
    panels,
  };
}

module.exports = { readAll, readIdentity, decodeSerial, TRANSIENT_CODES };

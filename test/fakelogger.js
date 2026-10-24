// Fake Solarman V5 logger: returns the registers provided in state.regs.
// Collision simulation: state.corrupt = n -> the next n answers have a wrong Modbus CRC;
// state.silent = n -> the next n answers are a V5 "AcknowledgeError" (inverter not answering);
// state.delayMs -> extra delay before each answer (busy logger).
const net = require('net');
const path = require('path');
const { crc16modbus, v5Checksum } = require(path.join(process.env.APP || path.join(__dirname, '..', 'com.pepane13.tsun'), 'lib', 'solarmanv5'));

const state = { regs: {}, up: true, corrupt: 0, silent: 0, delayMs: 0, requests: 0 };

function frame(req, mb) {
  const seq = req[5];
  const serial = req.readUInt32LE(7);
  const h = Buffer.alloc(11);
  h[0] = 0xa5; h.writeUInt16LE(14 + mb.length, 1); h.writeUInt16LE(0x1510, 3); h[5] = seq; h[6] = 0; h.writeUInt32LE(serial, 7);
  const p = Buffer.alloc(14); p[0] = 2; p[1] = 1;
  const f = Buffer.concat([h, p, mb, Buffer.from([0, 0x15])]);
  f[f.length - 2] = v5Checksum(f);
  return f;
}

function resp(req) {
  state.requests += 1;
  if (state.silent > 0) { state.silent -= 1; return frame(req, Buffer.from([0x05, 0x00])); } // V5 AcknowledgeError
  const m = req.subarray(26, req.length - 2);
  const addr = m.readUInt16BE(2);
  const qty = m.readUInt16BE(4);
  const data = Buffer.alloc(qty * 2);
  for (let i = 0; i < qty; i++) data.writeUInt16BE((state.regs[addr + i] || 0) & 0xffff, i * 2);
  let mb = Buffer.concat([Buffer.from([1, 3, qty * 2]), data]);
  const c = Buffer.alloc(2);
  c.writeUInt16LE(crc16modbus(mb));
  if (state.corrupt > 0) { state.corrupt -= 1; c[0] ^= 0xff; }
  mb = Buffer.concat([mb, c]);
  return frame(req, mb);
}

const srv = net.createServer((s) => {
  if (!state.up) { s.destroy(); return; }
  s.on('data', (d) => {
    const f = resp(d);
    setTimeout(() => {
      if (s.destroyed) return;
      s.write(f.subarray(0, 10));
      setTimeout(() => { if (!s.destroyed) s.write(f.subarray(10)); }, 5);
    }, state.delayMs);
  });
});
module.exports = { state, srv };

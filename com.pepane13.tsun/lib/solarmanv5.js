'use strict';

/**
 * Minimal Solarman V5 client (LSW-3/LSW-5 loggers, TCP port 8899).
 * Wraps Modbus RTU frames. Read-only: function 0x03 only.
 * Frame format aligned with pysolarmanv5.
 */

const net = require('net');

const V5_START = 0xa5;
const V5_END = 0x15;
const CTRL_REQUEST = 0x4510;
const CTRL_RESPONSE = 0x1510;
const CTRL_COUNTER = 0x4710; // "counter"/heartbeat frame sent by some loggers, ignored

// V5 error codes (Modbus payload shorter than 5 bytes), see pysolarmanv5
const V5_ERRORS = {
  0x05: 'AcknowledgeError',
  0x06: 'SlaveBusyError',
};

function crc16modbus(buf) {
  let crc = 0xffff;
  for (const b of buf) {
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 1) ? ((crc >>> 1) ^ 0xa001) : (crc >>> 1);
    }
  }
  return crc;
}

function v5Checksum(frame) {
  let sum = 0;
  for (let i = 1; i < frame.length - 2; i++) sum += frame[i];
  return sum & 0xff;
}

function buildModbusRead(slaveId, address, quantity) {
  const pdu = Buffer.alloc(6);
  pdu.writeUInt8(slaveId, 0);
  pdu.writeUInt8(0x03, 1);
  pdu.writeUInt16BE(address, 2);
  pdu.writeUInt16BE(quantity, 4);
  const crc = Buffer.alloc(2);
  crc.writeUInt16LE(crc16modbus(pdu), 0);
  return Buffer.concat([pdu, crc]);
}

function buildV5Frame(loggerSerial, sequence, modbusFrame) {
  const header = Buffer.alloc(11);
  header.writeUInt8(V5_START, 0);
  header.writeUInt16LE(15 + modbusFrame.length, 1);
  header.writeUInt16LE(CTRL_REQUEST, 3);
  header.writeUInt16LE(sequence & 0xff, 5);
  header.writeUInt32LE(loggerSerial >>> 0, 7);

  const payloadHeader = Buffer.alloc(15); // frametype(1)=0x02, sensortype(2), 3 x time(4)
  payloadHeader.writeUInt8(0x02, 0);

  const trailer = Buffer.from([0x00, V5_END]);
  const frame = Buffer.concat([header, payloadHeader, modbusFrame, trailer]);
  frame[frame.length - 2] = v5Checksum(frame);
  return frame;
}

class SolarmanV5Error extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SolarmanV5Error';
    this.code = code;
  }
}

class SolarmanV5Client {
  /**
   * @param {object} opts
   * @param {string} opts.host
   * @param {number} opts.serial  logger serial number (10 digits)
   * @param {number} [opts.port=8899]
   * @param {number} [opts.slaveId=1]
   * @param {number} [opts.timeout=8000] ms
   */
  constructor({ host, serial, port = 8899, slaveId = 1, timeout = 8000 }) {
    this.host = host;
    this.serial = Number(serial);
    this.port = port;
    this.slaveId = slaveId;
    this.timeout = timeout;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = null;
    this.sequence = Math.floor(Math.random() * 0xfe) + 1;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      const timer = setTimeout(() => {
        socket.destroy();
        const err = new SolarmanV5Error(`Connection to ${this.host}:${this.port} timed out`, 'ETIMEDOUT');
        err.phase = 'connect';
        reject(err);
      }, this.timeout);

      socket.once('connect', () => {
        clearTimeout(timer);
        socket.setNoDelay(true);
        this.socket = socket;
        resolve();
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        if (!this.socket) {
          err.phase = 'connect';
          reject(err);
        }
      });
      socket.on('data', (chunk) => this._onData(chunk));
      socket.on('error', (err) => this._fail(err));
      socket.on('close', () => {
        this.socket = null;
        this._fail(new SolarmanV5Error('Connection closed by the logger', 'ECLOSED'));
      });
    });
  }

  close() {
    if (this.socket) {
      this.socket.removeAllListeners('close');
      this.socket.destroy();
      this.socket = null;
    }
  }

  _fail(err) {
    if (!err.phase) err.phase = 'read';
    if (this.pending) {
      const { reject, timer } = this.pending;
      clearTimeout(timer);
      this.pending = null;
      reject(err);
    }
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    // Extract all complete frames from the buffer
    for (;;) {
      const start = this.buffer.indexOf(V5_START);
      if (start < 0) { this.buffer = Buffer.alloc(0); return; }
      if (start > 0) this.buffer = this.buffer.subarray(start);
      if (this.buffer.length < 3) return;
      const len = 13 + this.buffer.readUInt16LE(1);
      if (this.buffer.length < len) return;
      const frame = this.buffer.subarray(0, len);
      this.buffer = this.buffer.subarray(len);
      this._handleFrame(frame);
    }
  }

  _handleFrame(frame) {
    if (frame[frame.length - 1] !== V5_END) return;
    const ctrl = frame.readUInt16LE(3);
    if (ctrl === CTRL_COUNTER) return; // ignore
    if (!this.pending) return;

    try {
      if (frame[frame.length - 2] !== v5Checksum(frame)) throw new SolarmanV5Error('Invalid V5 checksum', 'ECHECKSUM');
      if (ctrl !== CTRL_RESPONSE) return; // other frame type, wait for the next one
      if (frame[5] !== this.pending.sequence) return; // response to another request
      if (frame.readUInt32LE(7) !== (this.serial >>> 0)) throw new SolarmanV5Error('Wrong logger serial number in response', 'ESERIAL');
      if (frame[11] !== 0x02) throw new SolarmanV5Error('Invalid V5 frame type', 'EFRAMETYPE');

      const modbus = frame.subarray(25, frame.length - 2);
      const result = this._parseModbus(modbus);
      const { resolve, timer } = this.pending;
      clearTimeout(timer);
      this.pending = null;
      resolve(result);
    } catch (err) {
      this._fail(err);
    }
  }

  _parseModbus(m) {
    if (m.length < 5) {
      const name = V5_ERRORS[m[0]] || `V5 error 0x${(m[0] || 0).toString(16)}`;
      throw new SolarmanV5Error(`V5 Modbus EXCEPTION: ${name}`, 'EV5');
    }
    if (m[1] & 0x80) {
      throw new SolarmanV5Error(`Modbus exception 0x${m[2].toString(16)}`, 'EMODBUS');
    }
    const crc = m.readUInt16LE(m.length - 2);
    if (crc !== crc16modbus(m.subarray(0, m.length - 2))) {
      throw new SolarmanV5Error('Invalid Modbus CRC', 'ECRC');
    }
    const byteCount = m[2];
    const regs = [];
    for (let i = 0; i < byteCount; i += 2) regs.push(m.readUInt16BE(3 + i));
    return regs;
  }

  /**
   * Reads holding registers (function 0x03).
   * @returns {Promise<number[]>}
   */
  readHoldingRegisters(address, quantity) {
    if (!this.socket) return Promise.reject(new SolarmanV5Error('Not connected', 'ENOTCONN'));
    if (this.pending) return Promise.reject(new SolarmanV5Error('Request already in progress', 'EBUSY'));

    this.sequence = (this.sequence + 1) & 0xff;
    const sequence = this.sequence;
    const frame = buildV5Frame(this.serial, sequence, buildModbusRead(this.slaveId, address, quantity));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        const err = new SolarmanV5Error(`No response for 0x${address.toString(16)}`, 'ETIMEDOUT');
        err.phase = 'read';
        reject(err);
      }, this.timeout);
      this.pending = { resolve, reject, timer, sequence };
      this.socket.write(frame);
    });
  }
}

module.exports = {
  SolarmanV5Client,
  SolarmanV5Error,
  buildV5Frame,
  buildModbusRead,
  crc16modbus,
  v5Checksum,
};

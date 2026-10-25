// Minimal Homey SDK mock for the device tests (app settings, notifications, Flow cards, diagnostic log).
const path = require('path');
const en = require('../com.pepane13.tsun/locales/en.json');

const trig = [];
const notifications = [];
const appSettings = {};
const realtime = [];
const settingsListeners = [];
const settings = {
  get: (k) => (k in appSettings ? appSettings[k] : null),
  set: (k, v) => { appSettings[k] = v; settingsListeners.forEach((f) => f(k)); },
  on: (ev, f) => settingsListeners.push(f),
};
const homey = {
  trig,
  __: (k) => k.split('.').reduce((o, x) => o && o[x], en) ?? k,
  clock: { getTimezone: () => 'Europe/Paris' },
  setTimeout: (f, ms) => ({ f, ms }),
  clearTimeout() {},
  settings,
  notifications: { createNotification: async ({ excerpt }) => notifications.push(excerpt) },
  flow: { getDeviceTriggerCard: (id) => ({ trigger: async (dev, tokens) => trig.push({ id, tokens }) }) },
  manifest: { version: 'test' },
  api: { realtime: (event, data) => realtime.push({ event, data }) },
};

class Device {
  constructor(manifest, deviceSettings) {
    this.caps = {}; this.store = {}; this.settings = deviceSettings; this.available = true; this.warning = null;
    this.driver = { manifest };
    this.homey = homey;
  }

  getName() { return 'TSUN test'; }
  getData() { return { id: 'T0000000000TEST1' }; }
  hasCapability(c) { return c in this.caps; }
  async addCapability(c) { this.caps[c] = null; }
  async removeCapability(c) { delete this.caps[c]; }
  getCapabilityValue(c) { return this.caps[c] ?? null; }
  async setCapabilityValue(c, v) { if (!(c in this.caps)) throw new Error(`nocap ${c}`); this.caps[c] = v; }
  getStoreValue(k) { return this.store[k]; }
  async setStoreValue(k, v) { this.store[k] = JSON.parse(JSON.stringify(v)); }
  async unsetStoreValue(k) { delete this.store[k]; }
  getSetting(k) { return this.settings[k]; }
  getSettings() { return { ...this.settings }; }
  getCapabilities() { return Object.keys(this.caps); }
  getAvailable() { return this.available; }
  async setAvailable() { this.available = true; }
  async setWarning(w) { this.warning = w; }
  async unsetWarning() { this.warning = null; }
  log(...a) { if (process.env.VERBOSE) console.log('   [log]', ...a); }
  error(...a) { console.log('   [err]', ...a); }
}

// The app instance and its diagnostic log, as created by app.js
const { DiagLog } = require(path.join(__dirname, '..', 'com.pepane13.tsun', 'lib', 'diaglog'));
homey.app = { diag: new DiagLog(homey) };

module.exports = { Device, Driver: class {}, App: class {}, _trig: trig, _notifications: notifications, _homey: homey, _settings: appSettings, _realtime: realtime };

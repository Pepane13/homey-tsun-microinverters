'use strict';

const Homey = require('homey');
const { DiagLog } = require('./lib/diaglog');
const { buildReport } = require('./lib/diagreport');

module.exports = class TsunApp extends Homey.App {
  async onInit() {
    this.diag = new DiagLog(this.homey, { log: (...a) => this.log(...a) });
    this.diag.add('info', 'app', 'app', `${this.homey.__('diag.app_started')} ${this.homey.manifest.version}`);
    this.homey.settings.on('set', (key) => {
      if (key === 'log_level') this.diag.add('info', 'app', 'app', `${this.homey.__('diag.level_changed')} ${this.diag.level}`);
    });
    this.log('TSUN Micro-inverters started');
  }

  async onUninit() {
    if (this.diag) this.diag.flush();
  }

  /** Full diagnostic report (text + JSON), for the settings page and the PC export script. */
  getReport() {
    const driver = this.homey.drivers.getDriver('mx3000d');
    const appSettings = {};
    ['log_level', 'notify_comm', 'notify_panel', 'notify_alarm', 'notify_grid']
      .forEach((k) => { appSettings[k] = this.homey.settings.get(k); });
    this.diag.add('info', 'app', 'app', this.homey.__('diag.report_exported'));
    return buildReport({
      generated: new Date().toISOString(),
      timeZone: this.homey.clock.getTimezone(),
      appVersion: this.homey.manifest.version,
      homeyVersion: this.homey.version,
      appSettings,
      devices: driver.getDevices().map((d) => d.getDiagReport()),
      log: this.diag.get('debug'),
    });
  }

  /** Learned panel profile of every device, for the settings page. */
  getBaselines() {
    return this.homey.drivers.getDriver('mx3000d').getDevices().map((d) => d.getBaselineSummary());
  }

  async resetBaseline(id) {
    const device = this.homey.drivers.getDriver('mx3000d').getDevices().find((d) => d.getData().id === id);
    if (!device) throw new Error(`Unknown device ${id}`);
    await device.resetBaseline();
    return device.getBaselineSummary();
  }

  /** Snapshot of every device, for the settings page. */
  getStatus() {
    const driver = this.homey.drivers.getDriver('mx3000d');
    return driver.getDevices().map((d) => d.getDiagStatus());
  }
};

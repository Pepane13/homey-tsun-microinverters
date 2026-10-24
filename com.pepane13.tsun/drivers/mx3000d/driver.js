'use strict';

const Homey = require('homey');
const { SolarmanV5Client } = require('../../lib/solarmanv5');
const { readIdentity } = require('../../lib/mx3000d');

module.exports = class Mx3000dDriver extends Homey.Driver {
  async onInit() {
    this.homey.flow.getConditionCard('any_underperforming')
      .registerRunListener(({ device }) => device.isUnderperforming());
    this.log('MX3000D driver initialised');
  }

  async onPair(session) {
    session.setHandler('test', async ({ host, loggerSn }) => {
      host = String(host || '').trim();
      loggerSn = String(loggerSn || '').trim();
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) throw new Error(this.homey.__('errors.invalid_ip'));
      if (!/^\d{6,10}$/.test(loggerSn)) throw new Error(this.homey.__('errors.invalid_sn'));

      const client = new SolarmanV5Client({ host, serial: Number(loggerSn), timeout: 8000 });
      try {
        await client.connect();
        const { inverterSerial } = await readIdentity(client);
        if (!inverterSerial) throw new Error(this.homey.__('errors.empty_response'));
        return {
          name: 'TSUN MX3000D',
          data: { id: inverterSerial },
          settings: { host, logger_sn: loggerSn, inverter_sn: inverterSerial },
        };
      } catch (err) {
        this.error('Pairing test failed:', err.message);
        if (err.code === 'ETIMEDOUT' || err.code === 'ECONNREFUSED' || err.code === 'EHOSTUNREACH') {
          throw new Error(`${this.homey.__('errors.unreachable')} ${err.message}`);
        }
        throw new Error(`${this.homey.__('errors.read_failed')} ${err.message}`);
      } finally {
        client.close();
      }
    });
  }
};

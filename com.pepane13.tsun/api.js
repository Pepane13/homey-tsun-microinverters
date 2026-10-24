'use strict';

// Web API used by the app settings page (settings/index.html).

module.exports = {
  async getLog({ homey, query }) {
    return homey.app.diag.get(query && query.level, query && query.limit ? Number(query.limit) : undefined);
  },

  async clearLog({ homey }) {
    homey.app.diag.clear();
    homey.app.diag.add('info', 'app', 'app', homey.__('diag.log_cleared'));
    return true;
  },

  async getReport({ homey }) {
    return homey.app.getReport();
  },

  async getBaseline({ homey }) {
    return homey.app.getBaselines();
  },

  async resetBaseline({ homey, body }) {
    return homey.app.resetBaseline(body && body.id);
  },

  async getStatus({ homey }) {
    return homey.app.getStatus();
  },
};

'use strict';

// Web API of the "Solar production" dashboard widget.

module.exports = {
  async getData({ homey, query }) {
    return homey.app.getWidgetData(query && query.device);
  },
};

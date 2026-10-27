'use strict';

/**
 * Open-Meteo weather forecast client (free for non-commercial use, no API key).
 * Only the rounded location (2 decimals, about 1 km) and the panel plane are sent.
 */

const https = require('https');

const HOST = 'api.open-meteo.com';
const MODELS = ['best_match', 'meteofrance_seamless', 'icon_seamless', 'ecmwf_ifs025', 'gfs_seamless'];

/**
 * @param {object} p
 * @param {number} p.lat
 * @param {number} p.lon
 * @param {number} p.tilt panel tilt, 0 (flat) to 90 (vertical)
 * @param {number} p.azimuth panel orientation as a compass bearing: 180 = south, 90 = east, 270 = west
 * @param {string} [p.model]
 * @returns {string} request path (with query string)
 */
function buildPath({ lat, lon, tilt, azimuth, model = 'best_match' }) {
  const q = new URLSearchParams({
    latitude: (Math.round(lat * 100) / 100).toFixed(2),
    longitude: (Math.round(lon * 100) / 100).toFixed(2),
    hourly: 'global_tilted_irradiance,temperature_2m',
    tilt: String(Math.min(90, Math.max(0, Number(tilt) || 0))),
    // Open-Meteo: 0 = south, -90 = east, 90 = west
    azimuth: String(((((Number(azimuth) || 0) - 180) % 360) + 540) % 360 - 180),
    timeformat: 'unixtime',
    timezone: 'GMT',
    past_days: '1',
    forecast_days: '3',
  });
  if (model && model !== 'best_match' && MODELS.includes(model)) q.set('models', model);
  return `/v1/forecast?${q.toString()}`;
}

/** GET https://api.open-meteo.com<path>, parsed JSON. */
function getJson(path, { timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get({ host: HOST, path, headers: { 'User-Agent': 'Homey com.pepane13.tsun' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(new Error('Answer too large')); });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (e) { /* not JSON */ }
        if (res.statusCode !== 200) {
          const err = new Error(`HTTP ${res.statusCode}${json && json.reason ? `: ${json.reason}` : ''}`);
          err.code = `HTTP${res.statusCode}`;
          reject(err);
          return;
        }
        if (!json) { reject(new Error('Invalid JSON answer')); return; }
        resolve(json);
      });
    });
    req.setTimeout(timeout, () => req.destroy(Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
  });
}

module.exports = {
  buildPath, getJson, HOST, MODELS,
};

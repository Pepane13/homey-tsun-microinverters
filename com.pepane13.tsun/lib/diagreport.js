'use strict';

/**
 * Builds the diagnostic report exported from the app settings page (and by the
 * PC export script): a readable text part followed by the raw data in JSON.
 * Pure function, no Homey dependency, so it can be tested on its own.
 */

/** Masks a serial number, keeping only the last 4 characters. */
function maskSerial(sn) {
  const s = String(sn || '');
  return s.length > 4 ? `${'*'.repeat(s.length - 4)}${s.slice(-4)}` : s;
}

function fmtDate(iso, timeZone) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('sv-SE', { timeZone }); // YYYY-MM-DD HH:MM:SS
  } catch (e) {
    return String(iso);
  }
}

/**
 * @param {object} p
 * @param {string} p.generated ISO date
 * @param {string} p.timeZone Homey time zone
 * @param {string} p.appVersion
 * @param {string} p.homeyVersion
 * @param {object} p.appSettings { log_level, notify_* }
 * @param {object[]} p.devices from Device#getDiagReport()
 * @param {object[]} p.log diagnostic log entries { t, l, s, c, m }, oldest first
 * @returns {{ text: string, data: object, filename: string }}
 */
function buildReport(p) {
  const tz = p.timeZone || 'UTC';
  const L = [];
  const onOff = (v, def) => ((v === null || v === undefined ? def : v) ? 'on' : 'off');
  const s = p.appSettings || {};

  L.push('TSUN Micro-inverters — diagnostic report');
  L.push(`Generated: ${fmtDate(p.generated, tz)} (${tz})`);
  L.push(`App version: ${p.appVersion || '?'} | Homey: ${p.homeyVersion || '?'}`);
  L.push(`Log level: ${s.log_level || 'info'} | Notifications: communication ${onOff(s.notify_comm, true)}, `
    + `panels ${onOff(s.notify_panel, true)}, inverter ${onOff(s.notify_alarm, true)}, grid ${onOff(s.notify_grid, false)}`);

  for (const d of p.devices || []) {
    const st = d.status || {};
    const set = d.settings || {};
    const o = st.currentOutage;
    L.push('');
    L.push(`== Device: ${d.name} ==`);
    L.push(`Logger: ${set.host || '?'} | serial ${set.logger_sn || '?'} | inverter ${set.inverter_sn || '?'} | polling ${set.poll_interval || '?'} s`);
    L.push(`Status: ${st.status || '?'}${st.standby ? ' (standby)' : ''} | available: ${st.available}`);
    L.push(`Last successful read: ${fmtDate(st.lastOk, tz)}`);
    L.push(`Response time: last ${st.latencyLast ?? '—'} ms, today avg ${st.latencyAvgToday ?? '—'} ms, max ${st.latencyMaxToday ?? '—'} ms`);
    L.push(`Communication success (1 h): ${st.successRate1h ?? '—'} %`);
    if (st.readsToday) L.push(`Reads today: ${st.readsToday.ok} OK / ${st.readsToday.failed} failed | retries ${st.retriesToday ?? 0} | isolated failures ${st.isolatedToday ?? 0}`);
    if (st.outagesToday) L.push(`Drops during production today: ${st.outagesToday.count} (${st.outagesToday.minutes} min)`);
    L.push(`Current outage: ${o ? `${o.minutes} min since ${fmtDate(o.since, tz)}, ${o.duringProduction ? 'during production' : 'night/standby'}, cause: ${o.cause}` : 'none'}`);
    L.push(`Last error: ${st.lastError ? `${fmtDate(st.lastError.t, tz)} ${st.lastError.text} [${st.lastError.code || '?'}] ${st.lastError.message || ''}` : 'none'}`);
    const pz = st.panelsNotProducing || [];
    const pu = st.panelsUnderperforming || [];
    L.push(`Panels not producing: ${pz.length ? pz.join(', ') : 'none'} | underperforming: ${pu.length ? pu.join(', ') : 'none'}`);
    if (d.values) {
      L.push('Current values:');
      Object.entries(d.values).forEach(([k, v]) => L.push(`  ${k}: ${v === null || v === undefined ? '—' : v}`));
    }
    const bl = d.baseline;
    if (bl) {
      L.push(`Learned panel profile (${bl.mode}): ${bl.learnedSlots} slots learned, ${bl.readySlots} usable, since ${bl.since || '—'}; `
        + `daily share ${bl.daily.share.join('/')} % (${bl.daily.days} days)`);
      bl.hours.forEach((h) => L.push(`  ${String(h.hour).padStart(2, '0')}h ${h.ratios.map((v) => String(v ?? '—').padStart(4)).join('')}${h.ready ? '' : '  (learning)'}`));
    }
    const other = Object.entries(set).filter(([k]) => !['host', 'logger_sn', 'inverter_sn', 'poll_interval'].includes(k));
    if (other.length) L.push(`Settings: ${other.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }

  const log = p.log || [];
  L.push('');
  L.push(`== Diagnostic log (${log.length} entries, oldest first) ==`);
  for (const e of log) {
    L.push(`${fmtDate(e.t, tz)} ${String(e.l).toUpperCase().padEnd(5)} [${e.c}] ${e.s}: ${e.m}`);
  }

  const data = {
    generated: p.generated,
    timeZone: tz,
    appVersion: p.appVersion,
    homeyVersion: p.homeyVersion,
    appSettings: s,
    devices: p.devices || [],
    log,
  };
  L.push('');
  L.push('== Raw data (JSON) ==');
  L.push(JSON.stringify(data, null, 1));

  const stamp = fmtDate(p.generated, tz).replace(/[: ]/g, '-').slice(0, 16);
  return { text: L.join('\n'), data, filename: `tsun-diagnostic-${stamp}.txt` };
}

module.exports = { buildReport, maskSerial };

# TSUN Micro-inverters (v1.6.0) — Homey app for TSUN MX3000D micro-inverters

**Fully local** monitoring of the MX3000D through its Solarman logger (V5 protocol, TCP/8899), with no cloud and no proxy. Read-only: no command is ever sent to the inverter.

## Exposed capabilities

| Homey capability | Source | Unit |
|---|---|---|
| Production (`measure_power`) — Homey Energy | 0x1202 | W |
| Total yield (`meter_power`) — Homey Energy | 0x1213-0x1214 | kWh |
| Yield today (`tsun_energy.today`) | 0x1212 | kWh |
| Inverter status (`tsun_status`) | 0x1100 / 0x1105 / 0x1106 | text |
| AC power, chart (`tsun_power.ac`) | 0x1202 | W |
| Grid voltage / current / frequency (`tsun_voltage.grid`, `tsun_current.grid`, `tsun_frequency.grid`) | 0x1200 / 0x1201 / 0x1209 | V / A / Hz |
| Inverter temperature (`tsun_temperature.inverter`) | 0x1218 − 40 | °C |
| Inverter alarm (`alarm_generic`) | 0x1105 / 0x1106 ≠ 0 | yes/no |
| Logger response time, Wi-Fi (`tsun_latency.logger`) | measured | ms |
| Communication success over 1 h (`tsun_ratio.comm`) | measured | % |
| Panels 1 to 6, power (`tsun_panel_power.pv1..6`) | 0x1304 + 7·n | W |
| Panels 1 to 6, yield today (`tsun_panel_energy.pv1..6`) | 0x1305-0x1306 + 7·n | kWh |
| Forecast today / remaining today / tomorrow (`tsun_energy.forecast_today`, `.forecast_remaining`, `.forecast_tomorrow`) — only when the forecast is enabled | Open-Meteo + calibration | kWh |
| Forecast power of the current hour (`tsun_power.forecast`) — only when the forecast is enabled | Open-Meteo + calibration | W |

### Insights charts

Homey does not keep an Insights log of `measure_power` for this Energy device, so the AC power is mirrored in `tsun_power.ac` to get a chart. The total yield chart comes from `meter_power`. The inverter temperature uses an app-specific capability so that it does not skew the temperature of the Homey zone.

### Homey Energy

Class `solarpanel`, a single `measure_power` (AC production, positive) and a single `meter_power` (inverter cumulative meter): the device appears as a **solar panel** in the Energy tab. Per-panel and daily measurements use app-specific capabilities so they are not counted twice.

### Status

"Normal" (code 1), "Alarm 0x…" / "Fault 0x…" (raw codes from registers 0x1105 / 0x1106), "Standby (night)" when the inverter no longer responds, "Code n" for an undocumented status. Labels follow the Homey language (English or French).

## Flow cards

| Card | Type | Tokens |
|---|---|---|
| A panel is underperforming | Trigger | panel, power, expected power, average of the others, deviation % |
| A panel is back to normal | Trigger | panel |
| The inverter status changed | Trigger | status, code |
| A panel is not producing | Trigger | panel, average of the others |
| Communication with the inverter was lost | Trigger | minutes, probable cause |
| Communication with the inverter was restored | Trigger | outage duration (min) |
| A panel is / is not underperforming | Condition | — |
| The production forecast was updated | Trigger | forecast today, remaining today, tomorrow (kWh) |
| Forecast production [today/tomorrow] from [time] to [time] is / is not above [kWh] | Condition | — |
| Get the forecast production [today/tomorrow] from [time] to [time] | Action (Advanced Flows) | forecast energy (kWh) |
| Refresh the production forecast | Action | — |

Detection, device settings "Panel monitoring":

- **Adaptive mode (default)**: the app learns, for each 15-minute slot of the day, the usual share of each panel (its power divided by the average of all panels). A panel is reported only when it falls below **its own usual share for that time** by the threshold (15 %) for the minimum duration (15 min). Recurring shadows (tree, chimney) and orientation differences are therefore not reported. A slot is used once learned on 3 different days (±15 min neighbouring slots are used meanwhile); before that, no underperformance alert. Samples showing an anomaly are never learned. The learned share follows the seasonal change of the sun path (moving average).
- **Simple mode**: each panel is compared with the average of the other 5 (previous behaviour).
- **Not producing**: below 5 % of the others (min 5 W) for the minimum duration, except when the panel is usually almost fully shaded at that time; while a slot is not learned, only a panel below 5 W (disconnected) is reported.
- **Daily degradation check** (adaptive mode, after 7 days with at least 1 kWh): at midnight, a panel whose share of the daily yield is 10 % (adjustable) below its usual share is reported (dirt, new shadow, ageing).
- The app settings page shows the **learned profile** (hour by hour, per panel) and a **reset** button, to use after a change (pruned tree, cleaned or replaced panel).

Minimum average power (80 W): no check at dawn or under heavy clouds. Back to normal above half the threshold (hysteresis).

## Production forecast (optional)

Off by default. Device settings **Production forecast**: enable it, then set the panel **tilt** (0° flat, 90° vertical), **orientation** (compass bearing: 90 east, 180 south, 270 west), optionally the **peak power** of the panels (0 = inverter rated power) and the **weather model** (*Best match* or Météo-France, ECMWF, ICON, GFS).

How it works:

- Every hour the app downloads from [Open-Meteo](https://open-meteo.com) the hourly forecast of the **global tilted irradiance** (sunlight on the plane of the panels, mean over the hour) and the air temperature, for yesterday, today and the next two days.
- Raw model per hour: irradiance / 1000 × peak power × 0.85 × temperature factor (−0.4 %/°C of cell temperature), capped at the inverter rated power.
- **Calibration on your own production**: at each hour change, the energy produced during the past hour (difference of the inverter daily counter) is compared with the raw model for that hour. For each hour of the day the app keeps a correction factor = moving average of the produced energy / moving average of the raw energy (about 10 days, so it follows the seasons). It absorbs the real peak power and losses, recurring shadows, orientation approximations and the systematic bias of the weather model at that hour. Until an hour has been learned on 7 days its factor is blended with the global factor. Not learned: night and dawn hours (< 3 % of the peak power), hours at the inverter limit (clipping), inconsistent samples (fault, snow), hours spanned by a communication gap.
- **Day-ahead accuracy**: at midnight the forecast made the day before is compared with the yield (log category *forecast*); the average error is shown in the app settings and in the diagnostic report.
- Changing the tilt, orientation or peak power restarts the calibration.

Typical use with a home battery and EDF Tempo: on the eve of a red day, *Get the forecast production tomorrow from 06:00 to 22:00*, then charge the battery from the grid during off-peak hours only by the difference between the expected consumption and that forecast.

Privacy: only the Homey location rounded to 2 decimals (about 1 km), the tilt, the orientation and the model are sent to `api.open-meteo.com` (free for non-commercial use, no account, no API key). Expect ±10–15 % on clear days and ±30 % or more with variable cloud cover.

## Diagnostics

Open **Apps → TSUN Micro-inverters → Configure app**:

- **Current state** of each inverter: status, last successful read, logger response time (last / today's average / max), communication success over the last hour, reads and drops today, current outage with its probable cause, last error, panels to check.
- **Timeline notifications** (each can be switched off): communication lost / restored during production, panel not producing or underperforming, inverter alarm / fault / high temperature, grid voltage out of range (off by default).
- **Diagnostic log** (last 1,500 entries, kept across restarts), with a recording level (errors, warnings, normal, detailed) and a copy button.
- **Export for diagnosis**: a full report as a text file (download, or display to copy on the mobile app): app and Homey versions, app settings, each inverter's settings (serial numbers masked), state, current values and daily statistics, the whole log, then the same data in JSON. Also available through the app Web API (`GET /api/app/com.pepane13.tsun/report`), used by the `homey-export.js` PC script.

What is logged:

| Category | Content |
|---|---|
| comm | Every failed read with its probable cause; short drops and outages during production with duration; slow responses (> 3 s, weak Wi-Fi); morning wake-up and evening standby times. In detailed mode, every read with its response time. |
| panel | Panel not producing (with a hint: 0 V = disconnected, voltage present = input fault or full shade), underperforming, back to normal. |
| grid | Voltage above / below the limits (default 253 / 207 V, EN 50160), frequency outside 49.8–50.2 Hz. |
| inverter | Status changes, alarm and fault codes, high temperature, low DC→AC efficiency (< 85 % above 300 W). |
| day | Daily summary at midnight (today's statistics are kept across app updates and Homey restarts): yield (total and per panel), peak power, active hours, grid voltage range, max temperature, reads OK / failed, response time, drops during production. |

Probable causes of a failed read: logger unreachable on the network (Wi-Fi drop, logger off, IP changed), port 8899 refused, connected but no answer in time (logger busy or weak Wi-Fi), connection closed by the logger, corrupted answer or no answer on the **logger–inverter serial link**, wrong logger serial number.

The logger also polls the inverter for the TSUN cloud. When a request collides with that polling, the answer is corrupted (Modbus CRC error: TCP guarantees integrity over Wi-Fi, so this happens on the serial link) or missing (V5 AcknowledgeError), or simply late. Handling:

- each request failing with such a transient error is **retried** up to twice, 1.5 s later, on the same connection (debug trace, counted in the daily summary);
- a cycle that still fails once is an **isolated failure** (debug trace): a warning is only logged after 2 consecutive failed cycles;
- a slow answer (> 3 s) with a fast TCP connection is attributed to a **busy logger** (debug); a **weak Wi-Fi** warning needs a slow connection (> 1 s);
- a warning is logged (at most hourly) when 20 % or more of the reads of the last hour needed a retry or failed.

A failure is only treated as abnormal when the inverter was producing (> 30 W) just before: the night standby never raises an alert. If the inverter becomes unreachable while producing, its status shows "Unreachable" instead of "Standby (night)". Device settings, "Diagnostics and alerts" group: communication loss alert delay (10 min), grid voltage limits, temperature alert (80 °C).

## Behaviour

- Polling every 30 s (adjustable from 10 to 600 s). One TCP connection per cycle, closed immediately, so as not to interfere with the upload to the TSUN cloud.
- **At night** the inverter switches off: after 3 consecutive failures, power values drop to 0, a "standby" warning is shown and polling slows down to every 5 min. Automatic recovery in the morning.
- The total meter never decreases (protection against zero readings).
- Daily yields (total and per panel) are reset to 0 at midnight (Homey time zone); the previous day's values, which the inverter keeps until it restarts in the morning, are ignored.

## Installation (Homey Pro, from a Windows PC)

**Quickest:** double-click `install.cmd` at the root of the repository (steps 1 to 3 below, run from cmd so the PowerShell execution policy cannot block the Homey CLI).

If PowerShell answers *"running scripts is disabled on this system"* when you type `homey`, either use `install.cmd`, call `homey.cmd` instead of `homey`, or allow local scripts once: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

1. Install Node.js LTS:
   ```powershell
   winget install OpenJS.NodeJS.LTS
   ```
   then close and reopen PowerShell.
2. Install the Homey CLI and sign in:
   ```powershell
   npm install -g homey
   homey login
   homey select
   ```
   (`homey select`: choose your Homey Pro.)
3. From the `com.pepane13.tsun` folder:
   ```powershell
   homey app install
   ```
4. In the Homey app: **Add device → TSUN Micro-inverters → TSUN MX3000D**. Enter the logger IP address and serial number (10 digits). Add the device **during daytime**, while the inverter is producing.

To follow the logs live during tests: `homey app run --remote` (the app runs on the Homey as long as the command is active).

## Network prerequisites

- Static DHCP lease for the logger.
- If the inverter sits in an IoT VLAN: allow Homey → logger on TCP/8899.

## Advanced settings

- **Temperature offset** (default 40): adjust if the temperature read at morning start-up does not match the ambient temperature.

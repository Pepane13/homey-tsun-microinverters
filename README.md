# TSUN Micro-inverters — local monitoring of TSUN MX3000D micro-inverters in Homey

Fully local (cloud-free) monitoring of a TSUN TSOL-MX3000D micro-inverter through its Solarman LSW-5 Wi-Fi logger, using the Solarman V5 protocol (encapsulated Modbus RTU, TCP/8899). Read-only.

## Features (v1.6.2)

- Solar panel in the Homey **Energy** tab (live production and cumulative meter)
- Live power and daily yield **per panel**
- Self-learning panel alerts: each evening, each panel must have reached its usual best share of the day in direct sun; shadows (even seasonal ones) are never reported, the threshold adapts to each panel's natural spread and a lasting change becomes the new normal after 7 sunny days. Real-time comparison with the learned profile in solar time for Flow cards
- Dashboard widget: panels drawn in their roof layout with live production, plus a top band with power, daily and total yield, peak, grid, temperature, DC→AC efficiency and logger link
- Flow cards: panel underperforming / back to normal, inverter status changed
- Optional production forecast: hourly Open-Meteo irradiance forecast on the panel plane, calibrated hour by hour on the measured production, with Flow cards (forecast between two times, number token for Advanced Flows)
- Detailed status (normal, alarm, fault, night standby)
- Insights charts for every measurement
- Diagnostics: log viewer and report export in the app settings, Wi-Fi analysis with probable cause, communication / panel / grid / inverter alerts, daily summary
- English and French user interface

## Repository content

| Path | Purpose |
|---|---|
| `com.pepane13.tsun/` | Homey Pro app (SDK 3) "TSUN Micro-inverters" — see its README |
| `com.pepane13.tsun/lib/solarmanv5.js` | Dependency-free Solarman V5 client for Node.js |
| `com.pepane13.tsun/lib/mx3000d.js` | TSUN 6-in-1 register map decoder |
| `test/device.test.js` | Device tests (Homey mock + local fake V5 logger): `node test/device.test.js` |
| `test/adaptive.test.js` | Adaptive panel monitoring tests (learned profile, shadows, anomalies, daily check): `node test/adaptive.test.js` |
| `test/diagnostics.test.js` | Diagnostics tests (error classification, log, alerts, daily summary): `node test/diagnostics.test.js` |
| `test/restart.test.js` | Restart and inverter checks (daytime restart, startup grace, thermal derating): `node test/restart.test.js` |
| `test/daysummary.test.js` | Daily summary tests on real sequences (dusk counter reset, dawn/dusk flapping, restart at night): `node test/daysummary.test.js` |
| `test/forecast.test.js` | Production forecast tests (Open-Meteo parsing, calibration, accuracy, Flow cards): `node test/forecast.test.js` |
| `test/widget.test.js` | Dashboard widget tests (data, manifest, rendering in Chromium if Playwright is installed): `node test/widget.test.js` |
| `.github/workflows/` | `tests.yml`: tests and App Store validation on every push; `publish.yml`: manual publication to the Homey App Store (secret `HOMEY_PAT`) |
| `install.cmd` | Windows installer: Node.js and Homey CLI checks, git pull, `homey app install`, optional `homey app publish` (double-click; `publish` / `nopublish` options) |
| `tsun_compare.js` | Detailed command-line reading using the app code: `node tsun_compare.js <logger_ip> <logger_sn> [interval_s]` |

## Registers used (function 0x03, slave 1)

| Register | Content | Scale |
|---|---|---|
| 0x1000-0x1007 | Inverter serial number (ASCII) | — |
| 0x1100 / 0x1105 / 0x1106 | Status / alarms / faults | — |
| 0x1200 / 0x1201 / 0x1202 | AC voltage / current / power | 0.1 V / 0.01 A / 0.1 W |
| 0x1209 | Frequency | 0.01 Hz |
| 0x1212 | Daily yield | 0.01 kWh |
| 0x1213-0x1214 | Total yield (u32, high word first) | 0.01 kWh |
| 0x1218 | Temperature | °C, offset −40 |
| 0x1302 + 7·n | PVn: voltage, current, power, daily (u32), total (u32) | 0.1 V, 0.01 A, 0.1 W, 0.01 kWh |

Register map taken from the [tsun-gen3-proxy](https://github.com/s-allius/tsun-gen3-proxy) wiki and validated on a real installation (V×I consistency, DC→AC efficiency ≈ 94.5 %, DC/AC totals ≈ 95 %).

## Installing the app

On Windows, double-click **`install.cmd`** at the root of the repository: it checks Node.js (24 or later, required by the current Homey CLI; installed or updated with winget), installs or updates the Homey CLI to the latest version, runs `git pull` on a git clone, then `homey app install` (with `homey login` / `homey select` when needed). It runs in cmd, so the PowerShell execution policy ("running scripts is disabled on this system") does not get in the way.

Manual equivalent:

```powershell
npm install -g homey
homey login
homey select
cd com.pepane13.tsun
homey app install
```

## Publishing to the Homey App Store

### From GitHub (recommended, no PC needed)

1. Once: create a personal access token at https://tools.developer.homey.app/me and add it to the repository as the Actions secret **`HOMEY_PAT`** (Settings → Secrets and variables → Actions → New repository secret).
2. Raise the version in `com.pepane13.tsun/app.json` and `package.json` and add its entry to `.homeychangelog.json` (English required, French optional).
3. Actions tab → **Publish to the Homey App Store** → **Run workflow**. The workflow refuses a version already tagged, runs the tests, publishes the build with `homey app publish` in headless mode, then tags the commit `vX.Y.Z` and creates the GitHub release with the changelog.

Every push also runs **Tests & validation** (unit tests + `homey app validate --level publish`).

### From a PC

`install.cmd` ends with an optional publish step: after installing on your Homey it asks whether to publish (no answer within 60 s = no). `install.cmd publish` publishes without asking, `install.cmd nopublish` only installs. The CLI runs in headless mode: the version number comes from `app.json` (never bumped by the CLI), the changelog from `.homeychangelog.json`, and on a git clone the published version is tagged `vX.Y.Z` and the tag pushed.

Manual equivalent:

```powershell
cd com.pepane13.tsun
homey app publish
```

Then, on tools.developer.homey.app → Apps: release to **Test** (install link, no review), then **Submit for certification** for the Live channel. Store description: `README.txt` (English) and `README.fr.txt` (French).

## Security

The logger's port 8899 is protected only by the logger serial number: isolate the device (IoT VLAN, Homey → logger TCP/8899 only), change the default web credentials and secure the logger's access point.

## License

Copyright (C) 2026 Stéphane Renaudet (Pepane13)

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the [LICENSE](LICENSE) file for details.

This app is not affiliated with or endorsed by TSUN or Solarman. Register map based on the [tsun-gen3-proxy](https://github.com/s-allius/tsun-gen3-proxy) project.

## Contributing

Issues and pull requests are welcome. When reporting a problem, attach the diagnostic report from the app settings (*Export for diagnosis*); serial numbers are masked in it. Run the tests before submitting a change:

```
node test/device.test.js
node test/diagnostics.test.js
node test/adaptive.test.js
node test/widget.test.js
node test/forecast.test.js
node test/daysummary.test.js
node test/restart.test.js
```

## Image credits

- App image: photo by an Unsplash contributor ([photo-1655300256335](https://unsplash.com/photos/a-house-with-solar-panels-Ja8t8nJN2I4)), Unsplash License.
- Driver image: TSUN MX3000D product visual (TSUNESS), background removed, used to identify the supported device.

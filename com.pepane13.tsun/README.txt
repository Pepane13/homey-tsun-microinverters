Monitor your TSUN micro-inverter directly from Homey, over your local network, without the TSUN cloud.

The app talks to the inverter's Solarman Wi-Fi logger (LSW-3 / LSW-5, TCP port 8899) and reads the measurements every 30 seconds. It is read-only: no command is ever sent to the inverter.

What you get:
- Homey Energy integration: the inverter appears as a solar panel, with live production and a total yield meter
- Grid voltage, current and frequency, inverter temperature, alarm indicator and detailed status
- Live power and daily yield for each of the 6 panels
- Dashboard widget: your panels drawn in their roof layout (order and columns adjustable) with live production and usual production at that time, plus a top band with power, daily and total yield, peak of the day, grid, temperature, DC→AC efficiency and logger link
- Flow cards: a panel is underperforming (compared with the average of the others, with adjustable threshold and duration), a panel is back to normal, the inverter status changed
- Diagnostics in the app settings: Wi-Fi analysis with probable cause, logger response time chart, communication loss alerts, panels not producing, grid voltage and temperature warnings, daily summary, and a diagnostic log you can copy
- Adaptive panel monitoring: each panel is compared with its own usual production at that time of day, learned automatically, so recurring shadows do not raise alerts
- Optional production forecast: hourly weather forecast of the sunlight on your panels (Open-Meteo), calibrated automatically on your own production. Forecast today, remaining today and tomorrow, plus Flow cards to act on it (e.g. charge a home battery from the grid only when the sun will not do it)

Compatibility: validated on the TSUN TSOL-MX3000D (6 inputs). Other TSUN 6-in-1 models using the same register map should work but have not been tested.

Before adding the device:
- Find the logger IP address in your router and give it a fixed address (static DHCP lease)
- Note the 10-digit logger serial number ("Device serial number" on the logger label or web page)
- Add the device during daytime: the inverter is powered by the panels and switches off at night

At night the inverter is unreachable: production drops to 0, the status shows "Standby (night)" and the app polls every 5 minutes until the morning.

The production forecast is off by default. When you enable it, the Homey location rounded to about 1 km and the panel tilt and orientation are sent once an hour to api.open-meteo.com (free weather service, no account); nothing else leaves your network.

Security tip: the logger port is only protected by its serial number. Keep the logger on a trusted network or an IoT VLAN that only allows Homey to reach it on TCP 8899, and change the logger web interface default password.

This app is not affiliated with or endorsed by TSUN or Solarman.

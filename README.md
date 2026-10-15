# Mia's Almanac

A free weather app for friends: forecast, snow totals, a daily fishing rating, radar, and spots shared with the group. One page, no accounts, no ads.

## Files

- `index.html` is the whole app. The Firebase settings and starting spots are at the top of the script.
- `firestore.rules` holds the database rules for the shared Firebase project (Mangia Mangia + this app). Paste all of it into Firebase → Firestore Database → Rules → Publish.
- `sw.js` and `manifest.json` let the app install to a phone home screen and open without signal.

## Where the data comes from (all free, no keys)

- **Open-Meteo**: hourly and 10-day forecast, wind, pressure, UV, sunrise/sunset, town search, and the GFS / European / Canadian model comparison
- **National Weather Service**: official snow totals, alerts, forecaster discussion (US only)
- **RainViewer**: radar loop; map tiles from CARTO / OpenStreetMap
- **Firebase (Firestore)**: shared spots (`weather_spots`) and the accuracy scorecard (`weather_log`)
- **Calculated in the page**: moon phase, solunar times, pressure trend, fishing rating

## Hosting

Repo → Settings → Pages → Source: "Deploy from a branch", Branch: `main`, folder `/ (root)` → Save.

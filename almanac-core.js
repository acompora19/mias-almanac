// almanac-core.js: the weather math shared by the app (index.html) and the notifier (notify/notify.mjs).
// Pure functions only: no page, no network.
const HOUR = 3600000, DAY = 86400000;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r0 = v => Math.round(v);
function LT(t, off) { return new Date(t + off * 1000); } // read with getUTC*
function fmtHour(t, off) { const d = LT(t, off); let h = d.getUTCHours(); const ap = h < 12 ? "a" : "p"; h = h % 12 || 12; return h + ap; }
function fmtClock(t, off) { const d = LT(t, off); let h = d.getUTCHours(); const m = d.getUTCMinutes(); const ap = h < 12 ? "AM" : "PM"; h = h % 12 || 12; return `${h}:${String(m).padStart(2,"0")} ${ap}`; }
const DN = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
function dayName(t, off) { return DN[LT(t, off).getUTCDay()]; }
function dayKey(t, off) { const d = LT(t, off); return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`; }
function compass(deg) { return ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"][Math.round(((deg % 360) + 360) % 360 / 22.5) % 16]; }
function fmtIn(v) { return v < 0.95 ? v.toFixed(1).replace(/^0/, "") : v.toFixed(v < 10 ? 1 : 0); }

function sunTimes(localMidnightT, lat, lon) {
  const rad = Math.PI / 180;
  const Jnoon = (localMidnightT + 12 * HOUR) / DAY + 2440587.5;
  const n = Math.round(Jnoon - 2451545.0008);
  const Js = n - lon / 360;
  const M = (357.5291 + 0.98560028 * Js) % 360;
  const C = 1.9148 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 0.0003 * Math.sin(3 * M * rad);
  const lam = (M + C + 180 + 102.9372) % 360;
  const Jt = 2451545 + Js + 0.0053 * Math.sin(M * rad) - 0.0069 * Math.sin(2 * lam * rad);
  const dec = Math.asin(Math.sin(lam * rad) * Math.sin(23.44 * rad));
  const cw = (Math.sin(-0.833 * rad) - Math.sin(lat * rad) * Math.sin(dec)) / (Math.cos(lat * rad) * Math.cos(dec));
  if (cw < -1 || cw > 1) return null;
  const w = Math.acos(cw) / rad;
  const toT = J => (J - 2440587.5) * DAY;
  return { rise: toT(Jt - w / 360), set: toT(Jt + w / 360) };
}
function moon(t) {
  const P = 29.530588853;
  const age = (((t - Date.UTC(2000, 0, 6, 18, 14)) / DAY) % P + P) % P;
  const illum = (1 - Math.cos(2 * Math.PI * age / P)) / 2;
  const names = ["New moon","Waxing crescent","First quarter","Waxing gibbous","Full moon","Waning gibbous","Last quarter","Waning crescent"];
  const idx = Math.floor(((age / P) * 8) + 0.5) % 8;
  const toFull = ((P / 2 - age) % P + P) % P, toNew = P - age;
  return { age, illum, name: names[idx], waxing: age < P / 2, toFull, toNew, P };
}
function parseLocal(s, off) { const [d, tm = "00:00"] = s.split("T"); const [y, mo, da] = d.split("-").map(Number); const [h, mi] = tm.split(":").map(Number); return Date.UTC(y, mo - 1, da, h, mi) - off * 1000; }
function derive(fc) {
  const now = Date.now();
  const startIdx = Math.max(0, fc.hours.findIndex(h => h.t + HOUR > now));
  const cur = fc.hours[startIdx];
  const next48 = fc.hours.slice(startIdx, startIdx + 48);
  const next72 = fc.hours.slice(startIdx, startIdx + 72);
  // days
  const byDay = new Map();
  for (const h of fc.hours) {
    if (h.t < now - 12 * HOUR && dayKey(h.t, fc.off) !== dayKey(now, fc.off)) continue;
    const k = dayKey(h.t, fc.off);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(h);
  }
  const days = [...byDay.values()].filter(a => a.length >= 12).slice(0, 10).map(a => {
    const hi = Math.max(...a.map(h => h.temp)), lo = Math.min(...a.map(h => h.temp));
    const pop = Math.max(...a.map(h => h.pop)), precip = a.reduce((s, h) => s + h.precip, 0), snow = a.reduce((s, h) => s + h.snow, 0);
    let code;
    if (snow >= 0.1) code = snow > 2 ? 73 : 71;
    else if (a.some(h => h.code >= 95)) code = 95;
    else if (precip >= 0.1) code = 63;
    else if (precip >= 0.02) code = 61;
    else { const d = a.filter(h => { const hr = LT(h.t, fc.off).getUTCHours(); return hr >= 9 && hr <= 17; }).map(h => Math.min(h.code, 3)); code = d.length ? Math.round(d.reduce((s, x) => s + x, 0) / d.length) : 2; }
    return { t: a[0].t, hi, lo, pop, precip, snow, code, gust: Math.max(...a.map(h => h.gust)) };
  });
  // pressure trend: now vs 3h ago
  const p3 = fc.hours[startIdx - 3]?.pres ?? cur.pres;
  const dp = cur.pres - p3;
  const trend = dp <= -0.06 ? ["down","Falling fast","↓↓"] : dp <= -0.02 ? ["down","Falling","↓"] : dp >= 0.06 ? ["up","Rising fast","↑↑"] : dp >= 0.02 ? ["up","Rising","↑"] : ["flat","Steady","→"];
  // snow
  const model72 = next72.reduce((s, h) => s + h.snow, 0);
  const nws = fc.nwsSnow72 != null ? fc.nwsSnow72 : (fc.sampleNws ? model72 * 1.25 : null);
  const bins = [];
  for (let b = 0; b < 12; b++) { const seg = next72.slice(b * 6, b * 6 + 6); bins.push({ t: seg[0]?.t, v: seg.reduce((s, h) => s + h.snow, 0) }); }
  const firstSnow = next72.find(h => h.snow >= 0.02);
  return { now, startIdx, cur, next48, days, dp, trend, model72, nws, bins, firstSnow };
}

// Tony's "Beaver Weather Gear": pick the outfit for the current hour.
const GEAR = {
  extreme: "Bitter cold: heavy coat & goggles", snowy: "Cold & snowy: trapper hat & scarf",
  rainy: "Rainy: rain jacket, hood up", windy: "Windy: windbreaker & cap",
  hot: "Hot: tank top, sun hat & water", sunny: "Sunny & warm: sun hat & shades",
  fall: "Fall: flannel & beanie", spring: "Spring: light jacket & cap",
};
function gearFor(h, off) {
  const snowing = (h.code >= 71 && h.code <= 77) || h.code === 85 || h.code === 86;
  const raining = !snowing && h.code >= 51;
  if (h.temp <= 15 || h.feels <= 5) return "extreme";
  if (snowing || h.temp <= 34) return "snowy";
  if (raining) return "rainy";
  if (h.gust >= 28 || h.wind >= 18) return "windy";
  if (h.temp >= 86) return "hot";
  if (h.temp >= 72 && h.code <= 2) return "sunny";
  const m = LT(h.t, off).getUTCMonth();               // 0 = January
  if (m >= 2 && m <= 4) return "spring";
  if (m >= 5 && m <= 7) return h.temp >= 62 ? "sunny" : "spring";
  if (m >= 8 && m <= 10) return "fall";
  return h.temp <= 42 ? "snowy" : "fall";             // December to February
}
function moonAlt(t, lat, lon) {
  const rad = Math.PI / 180, d = t / DAY + 2440587.5 - 2451545;
  const Lm = (218.316 + 13.176396 * d) * rad, Mm = (134.963 + 13.064993 * d) * rad, F = (93.272 + 13.229350 * d) * rad;
  const l = Lm + 6.289 * rad * Math.sin(Mm), b = 5.128 * rad * Math.sin(F), e = 23.4397 * rad;
  const ra = Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
  const dec = Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
  const H = (280.16 + 360.9856235 * d) * rad + lon * rad - ra, phi = lat * rad;
  return Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H)) / rad;
}
function solunar(start, lat, lon) {
  const step = 10 * 60000, pts = [];
  for (let t = start - step; t <= start + DAY + step; t += step) pts.push([t, moonAlt(t, lat, lon)]);
  const majors = [], minors = [];
  for (let k = 1; k < pts.length - 1; k++) {
    const [t, a] = pts[k], a0 = pts[k - 1][1], a1 = pts[k + 1][1];
    if (a > a0 && a >= a1) majors.push({ t, kind: "overhead" });
    if (a < a0 && a <= a1) majors.push({ t, kind: "underfoot" });
    if ((a0 <= 0) !== (a <= 0)) { const f = a0 / (a0 - a); minors.push({ t: pts[k - 1][0] + f * step, kind: a > 0 ? "rises" : "sets" }); }
  }
  const inDay = e => e.t >= start && e.t < start + DAY;
  return { majors: majors.filter(inDay), minors: minors.filter(inDay) };
}

const FIRST_HR = 5, LAST_HR = 21;
function fishHour(fc, i, sun, sol, mphase) {
  const h = fc.hours[i], mid = h.t + 30 * 60000;
  if (h.code >= 95) return { s: 5, thunder: true };
  let s = 36, f = {};
  const p3 = fc.hours[i - 3]?.pres, p12 = fc.hours[i - 12]?.pres;
  const dp = p3 != null ? h.pres - p3 : 0;
  if (dp <= -0.06) { s += 6; f.pres = "downfast"; }
  else if (dp <= -0.02) { s += 12; f.pres = "down"; }
  else if (dp >= 0.05) { s -= 15; f.pres = "upfast"; }
  else if (dp >= 0.02) { s -= 3; f.pres = "up"; }
  else { s += 4; f.pres = "flat"; }
  if (p12 != null && h.pres - p12 >= 0.12) { s -= 10; f.postfront = true; }
  const w = h.wind;
  s += w < 5 ? 0 : w <= 12 ? 8 : w <= 18 ? -6 : w <= 25 ? -20 : -40;
  if (sun && (Math.abs(mid - sun.rise) <= 75 * 60000 || Math.abs(mid - sun.set) <= 75 * 60000)) { s += 12; f.lowlight = true; }
  else if (h.code === 2 || h.code === 3) s += 4;
  else if (h.code <= 1 && h.isDay) { const hr = LT(h.t, fc.off).getUTCHours(); if (hr >= 11 && hr <= 16) s -= 6; }
  if (sol.majors.some(e => Math.abs(mid - e.t) <= 60 * 60000)) { s += 15; f.major = true; }
  else if (sol.minors.some(e => Math.abs(mid - e.t) <= 40 * 60000)) { s += 8; f.minor = true; }
  if (mphase) s += 4;
  if (h.precip > 0.08) s -= 10; else if (h.precip > 0) s += 3;
  const prev = fc.hours[i - 24]?.temp;
  if (prev != null && prev - h.temp > 12) s -= 6;
  return { s: clamp(Math.round(s), 0, 100), f };
}
function fishDay(d, fc, now) {
  const off = fc.off;
  const midnight = d.t - LT(d.t, off).getUTCHours() * HOUR - LT(d.t, off).getUTCMinutes() * 60000;
  const sun = fc.suns.find(s => s && s.rise >= midnight - HOUR && s.rise < midnight + DAY) || null;
  const sol = solunar(midnight, fc.lat, fc.lon);
  const m = moon(midnight + 12 * HOUR);
  const mphase = Math.min(m.age, m.P - m.age) < 2.5 || Math.abs(m.age - m.P / 2) < 2.5;
  const t0 = fc.hours[0].t, hrs = [];
  for (let hr = FIRST_HR; hr <= LAST_HR; hr++) {
    const t = midnight + hr * HOUR, i = Math.round((t - t0) / HOUR);
    if (i < 0 || i >= fc.hours.length) continue;
    if (sun && (t + HOUR < sun.rise - HOUR || t > sun.set + HOUR)) continue; // daylight fishing, with an hour on each end
    hrs.push({ t, i, past: t + HOUR <= now, ...fishHour(fc, i, sun, sol, mphase) });
  }
  const live = hrs.filter(h => !h.past);
  const pool = live.length >= 2 ? live : hrs;
  if (!pool.length) return null;
  const top = [...pool].sort((a, b) => b.s - a.s);
  const score = top.slice(0, 4).reduce((a, h) => a + h.s, 0) / Math.min(4, top.length);
  const rating = score >= 72 ? 5 : score >= 60 ? 4 : score >= 48 ? 3 : score >= 35 ? 2 : 1;
  // best windows: runs near the top score
  const thr = Math.max(top[0].s - 8, 50), runs = [];
  let cur = null;
  for (const h of pool) {
    if (h.s >= thr) { if (cur && h.i === cur.end.i + 1) { cur.end = h; cur.hs.push(h); } else { cur = { start: h, end: h, hs: [h] }; runs.push(cur); } }
    else cur = null;
  }
  const windows = runs.map(r => ({ ...r, mean: r.hs.reduce((a, h) => a + h.s, 0) / r.hs.length }))
    .sort((a, b) => b.mean - a.mean).slice(0, 2).sort((a, b) => a.start.t - b.start.t);
  // reasons, in plain words
  const reasons = [];
  const best = top[0];
  if (pool.some(h => h.thunder)) reasons.push(["b", "Lightning in the forecast. Stay off the water while storms are around."]);
  const pr = best.f?.pres;
  if (pr === "down") reasons.push(["g", "Pressure is easing down ahead of a change. Fish often feed hard before a front."]);
  else if (pr === "downfast") reasons.push(["n", "Pressure is dropping fast. The bite can be good early, then shut off when the front hits."]);
  else if (pr === "flat") reasons.push(["g", "Steady pressure. Fish should be on their usual patterns."]);
  else if (pr === "upfast" || pool.some(h => h.f?.postfront)) reasons.push(["b", "Clear, rising pressure behind a cold front. Fish tend to go tight-lipped for a day or so."]);
  else if (pr === "up") reasons.push(["n", "Pressure creeping up. Usually a so-so bite."]);
  const winds = pool.map(h => fc.hours[h.i].wind), wAvg = winds.reduce((a, v) => a + v, 0) / winds.length, wMax = Math.max(...pool.map(h => fc.hours[h.i].gust));
  if (wAvg > 25 || wMax > 35) reasons.push(["b", `Dangerous wind for small boats, gusting to ${r0(wMax)} mph.`]);
  else if (wAvg > 18) reasons.push(["b", `Windy (around ${r0(wAvg)} mph). Rough water and tough boat control.`]);
  else if (wAvg > 12) reasons.push(["n", `Breezy (around ${r0(wAvg)} mph). Try the wind-blown banks.`]);
  else if (wAvg >= 5) reasons.push(["g", `Light breeze (around ${r0(wAvg)} mph) puts a good chop on the water.`]);
  else reasons.push(["n", "Calm, glassy water. Fish can spook, so low light is your friend."]);
  const maj = sol.majors.filter(e => { const hr = (e.t - midnight) / HOUR; return hr >= FIRST_HR && hr <= LAST_HR + 1; });
  if (maj.length) reasons.push(["g", `Moon ${maj[0].kind} at ${fmtClock(maj[0].t, off)}, a major solunar period.`]);
  if (mphase) reasons.push(["g", `${m.name} week. Solunar periods tend to run stronger.`]);
  if (sun) reasons.push(["n", `Low light: sunrise ${fmtClock(sun.rise, off)}, sunset ${fmtClock(sun.set, off)}.`]);
  return { midnight, score, rating, windows, reasons, hrs, sol, sun };
}
const VERDICT = { 5: ["Great day to fish", "", "Great"], 4: ["Good day to fish", "", "Good"], 3: ["Fair, worth a try", "", "Fair"], 2: ["Slow day", "", "Slow"], 1: ["Better stay home", "", "Poor"] };
// Turn an Open-Meteo forecast response into the hours/sun list the app works with.
function parseOpenMeteo(om, now = Date.now()) {
  const off = om.utc_offset_seconds, H = om.hourly;
  const hours = H.time.map((s, i) => ({
    t: parseLocal(s, off), temp: H.temperature_2m[i], feels: H.apparent_temperature[i],
    pop: H.precipitation_probability[i] ?? 0, precip: H.precipitation[i] ?? 0, snow: H.snowfall[i] ?? 0,
    code: H.weather_code[i], wind: H.wind_speed_10m[i], gust: H.wind_gusts_10m[i], dir: H.wind_direction_10m[i],
    pres: (H.surface_pressure[i] ?? 0) * 0.02953, uv: H.uv_index[i] ?? 0, isDay: !!H.is_day[i]
  })).filter(h => h.temp != null);
  const dIdx = om.daily.time.map((s, i) => i);
  const suns = dIdx.map(i => ({ rise: parseLocal(om.daily.sunrise[i], off), set: parseLocal(om.daily.sunset[i], off) }))
    .filter(s => s.set > now - DAY).slice(0, 10);
  return { off, hours, suns };
}

// "Beavy says to wear…": a kid-friendly outfit line that matches her gear, plus one heads-up for later today.
const WEAR = {
  extreme: "her biggest puffy coat, a warm hat, mittens, and boots. Brrr, stay cozy!",
  snowy: "a winter coat, hat, mittens, and snow boots.",
  rainy: "a raincoat and rain boots. Puddle jumping allowed!",
  windy: "a zipped-up jacket. Hold on to your hat, it's breezy!",
  hot: "shorts, a t-shirt, sunscreen, and lots of water.",
  sunny: "a t-shirt and sunglasses. Don't forget sunscreen!",
  fall: "long sleeves and a cozy sweatshirt.",
  spring: "a light jacket. Mornings can be chilly!",
};
function wearFor(gear, fc, now = Date.now()) {
  let line = WEAR[gear] || WEAR.fall;
  const i0 = Math.max(0, fc.hours.findIndex(h => h.t + HOUR > now));
  const next = fc.hours.slice(i0, i0 + 12);
  if (!next.length) return line;
  const cur = next[0];
  const wetLater = next.slice(2).some(h => h.pop >= 50 && h.precip >= 0.02);
  const snowLater = next.slice(2).some(h => h.snow >= 0.1);
  const lowLater = Math.min(...next.map(h => h.temp));
  const uv = Math.max(...next.map(h => h.uv || 0));
  if (snowLater && gear !== "snowy" && gear !== "extreme") line += " Snow is coming later, so bring boots!";
  else if (wetLater && gear !== "rainy") line += " Rain later, so pack the rain boots.";
  else if (cur.temp - lowLater >= 15 && lowLater < 55) line += " It gets chilly later, so grab a jacket.";
  else if (uv >= 7 && gear !== "sunny" && gear !== "hot") line += " Strong sun today: sunscreen!";
  return line;
}

export { WEAR, wearFor, DAY, DN, FIRST_HR, GEAR, HOUR, LAST_HR, LT, VERDICT, clamp, compass, dayKey, dayName, derive, fishDay, fishHour, fmtClock, fmtHour, fmtIn, gearFor, moon, moonAlt, parseLocal, parseOpenMeteo, r0, solunar, sunTimes };

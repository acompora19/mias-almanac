// Mia's Almanac notifier: runs every 30 minutes on GitHub Actions and sends push notifications
// through ntfy (free app). Uses the same weather math as the app (almanac-core.js).
//
//   NTFY_TOPIC   the private topic name everyone subscribes to in the ntfy app (repo secret)
//   STATE_FILE   where we remember what was already sent (kept between runs by the workflow)
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  HOUR, DAY, LT, fmtClock, fmtHour, dayKey, dayName, r0, moon,
  parseOpenMeteo, derive, fishDay, gearFor, wearFor, GEAR,
} from "../almanac-core.js";

export const HOME = { name: "Canal Winchester, OH", lat: 39.8437, lon: -82.8046 };
export const APP_URL = "https://acompora19.github.io/mias-almanac/";
const QUIET = { from: 21.5, to: 6.5 };   // no non-urgent pushes 9:30 PM to 6:30 AM
// ntfy turns these tag names into the emoji at the front of the title
const EMOJI = { evening: "crescent_moon", frost: "cold_face", air: "mask", moon: "full_moon", meteor: "comet", aurora: "milky_way", morning: "sunny", rain: "umbrella", snow: "snowflake", fish: "fishing_pole_and_fish", severe: "rotating_light", advisory: "warning", test: "white_check_mark" };
// ntfy priority: 1 min, 2 low (silent), 3 default, 4 high, 5 max (can break through Do Not Disturb on Android)
const PRI = { min: 1, low: 2, normal: 3, high: 4, max: 5 };
// latest radar image from the Wilmington, OH radar that covers central Ohio
const RADAR_IMG = "https://radar.weather.gov/ridge/standard/KILN_0.gif";

const hourly = "temperature_2m,apparent_temperature,precipitation_probability,precipitation,snowfall,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,surface_pressure,uv_index,is_day";

async function getJSON(fetchFn, url) {
  const r = await fetchFn(url, { headers: { "User-Agent": "MiasAlmanac (github.com/acompora19/mias-almanac)", Accept: "application/geo+json, application/json" } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

const ampm = (t, off) => fmtHour(t, off).replace("a", " AM").replace("p", " PM");

/** Decide what to send. Pure apart from the fetches; returns { messages, state }. */
export async function run({ fetchFn = fetch, now = Date.now(), state = {}, place = HOME, topic = "" } = {}) {
  const messages = [];
  state = { alerts: {}, ...state };

  // ---------- forecast ----------
  const om = await getJSON(fetchFn, `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}&hourly=${hourly}&daily=sunrise,sunset&forecast_days=10&past_days=1&timezone=auto&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch`);
  const { off, hours, suns } = parseOpenMeteo(om, now);
  const fc = { mode: "live", lat: place.lat, lon: place.lon, off, hours, suns };
  const D = derive({ ...fc });
  const local = LT(now, off), hourNow = local.getUTCHours() + local.getUTCMinutes() / 60;
  const today = dayKey(now, off);
  const quiet = hourNow >= QUIET.from || hourNow < QUIET.to;
  const c = D.cur;

  // "Snooze today" button: it posts to <topic>-snooze; any post since local midnight pauses non-urgent pushes
  let snoozed = false;
  if (topic) {
    try {
      const r = await fetchFn(`https://ntfy.sh/${topic}-snooze/json?poll=1&since=24h`);
      const lines = (await r.text()).split("\n").filter(Boolean).map(l => JSON.parse(l));
      snoozed = lines.some(m => m.event === "message" && dayKey(m.time * 1000, off) === today);
    } catch {}
  }

  // ---------- 1. weather warnings (any time of day) ----------
  let alerts = [];
  try {
    const a = await getJSON(fetchFn, `https://api.weather.gov/alerts/active?point=${place.lat},${place.lon}`);
    alerts = (a.features || []).map(f => f.properties);
  } catch { /* weather service down: try again next run */ }
  for (const p of alerts) {
    const id = p.id || p["@id"] || p.headline;
    if (state.alerts[id]) continue;
    const sev = p.severity;
    if (quiet && sev !== "Extreme" && sev !== "Severe") continue;   // minor advisories wait for morning
    messages.push({
      title: p.event,
      message: (`${p.headline || ""}\n\n${(p.description || "").replace(/\s+/g, " ").slice(0, 600)}`.trim()) +
        (/frost|freeze/i.test(p.event) ? `\n\n${frostTips(/hard freeze/i.test(p.event) ? 26 : /freeze/i.test(p.event) ? 30 : 34)}` : ""),
      priority: /tornado warning/i.test(p.event) || sev === "Extreme" ? PRI.max : sev === "Severe" ? PRI.high : PRI.normal,
      tags: [sev === "Extreme" || sev === "Severe" ? EMOJI.severe : EMOJI.advisory],
      attach: /thunderstorm|tornado|flood|rain|wind/i.test(p.event) ? RADAR_IMG : undefined,
      buttons: ["app", "radar"],
    });
    state.alerts[id] = Date.parse(p.expires || p.ends || "") || now + DAY;
  }
  for (const [id, exp] of Object.entries(state.alerts)) if (exp < now - DAY) delete state.alerts[id];

  // ---------- 2. morning summary (from 5:30 AM, once a day) ----------
  if (hourNow >= 5.4 && hourNow < 9 && state.morning !== today) {
    const d0 = D.days[0];
    const rest = hours.filter(h => h.t >= now && dayKey(h.t, off) === today);
    const wetHour = rest.find(h => h.pop >= 50 && h.precip >= 0.02);
    const snowToday = rest.reduce((s, h) => s + h.snow, 0);
    let sky;
    if (snowToday >= 0.5) sky = `Snow today, about ${Math.round(snowToday)}″${wetHour ? ` starting around ${ampm(wetHour.t, off)}` : ""}.`;
    else if (wetHour) sky = `Rain likely around ${ampm(wetHour.t, off)} (${r0(wetHour.pop)}%).`;
    else sky = "No rain expected.";
    const gear = gearFor(c, off, hours.filter(h => dayKey(h.t, off) === today));
    messages.push({
      title: `Good morning! ${r0(c.temp)}° now, high ${r0(d0.hi)}°`,
      message: `${place.name}: high ${r0(d0.hi)}°, low ${r0(d0.lo)}°. ${sky}` +
        (alerts.length ? ` ⚠ ${alerts.map(a => a.event).join(", ")}.` : "") +
        `\n\nBeavy says to wear ${wearFor(gear, fc, now)}`,
      priority: PRI.normal, tags: [EMOJI.morning],
      attach: `${APP_URL}notify/img/gear-${gear}.jpg`, filename: `beavy-${gear}.jpg`,
      buttons: ["app", "snooze"],
    });
    state.morning = today;
  }

  // ---------- 3. rain / snow heads-up ----------
  if (!quiet && !snoozed) {
    const next = hours.filter(h => h.t + HOUR > now).slice(0, 4);
    const dryNow = next[0] && next[0].precip < 0.01 && next[0].code < 51;
    const start = next.slice(1).find(h => h.pop >= 60 && (h.precip >= 0.02 || h.snow >= 0.05));
    const recently = state.precipSentAt && now - state.precipSentAt < 5 * HOUR;
    if (dryNow && start && !recently) {
      const snowy = start.snow >= 0.05;
      messages.push({
        title: snowy ? "Snow on the way" : "Rain on the way",
        message: `${snowy ? "Snow" : "Rain"} starting around ${ampm(start.t, off)} in ${place.name} (${r0(start.pop)}% chance).`,
        priority: PRI.normal, tags: [snowy ? EMOJI.snow : EMOJI.rain],
        attach: RADAR_IMG, filename: "radar.gif", buttons: ["radar", "snooze"],
      });
      state.precipSentAt = now;
    }
    // a real snowfall (an inch or more in the next 24 hours): once per day
    const snow24 = hours.filter(h => h.t + HOUR > now).slice(0, 24).reduce((s, h) => s + h.snow, 0);
    if (snow24 >= 1 && state.snowDay !== today) {
      const lo = Math.max(1, Math.floor(snow24)), hi = Math.ceil(snow24 * 1.3);
      const first = hours.find(h => h.t + HOUR > now && h.snow >= 0.05);
      messages.push({
        title: `${lo}–${hi}″ of snow coming`,
        message: `About ${lo}–${hi} inches in ${place.name} over the next 24 hours${first ? `, starting around ${ampm(first.t, off)} ${dayName(first.t, off)}` : ""}.`,
        priority: PRI.high, tags: [EMOJI.snow], attach: RADAR_IMG, filename: "radar.gif", buttons: ["app", "radar"],
      });
      state.snowDay = today;
    }
  }

  // ---------- 3b. evening preview of tomorrow (7:45 to 9:30 PM, once a day) ----------
  if (hourNow >= 19.75 && hourNow < 21.5 && state.evening !== today && D.days[1]) {
    const d1 = D.days[1];
    const tmrw = dayKey(d1.t + 12 * HOUR, off);
    const tHours = hours.filter(h => dayKey(h.t, off) === tmrw);
    const morning = tHours.find(h => LT(h.t, off).getUTCHours() === 8) || tHours[0];
    const awake = tHours.filter(h => { const hr = LT(h.t, off).getUTCHours(); return hr >= 6 && hr <= 22; });
    const wet = awake.find(h => h.pop >= 50 && h.precip >= 0.02);
    const snow = tHours.reduce((a, h) => a + h.snow, 0);
    const gust = Math.max(...awake.map(h => h.gust));
    let sky;
    if (snow >= 0.5) sky = `Snow, about ${Math.max(1, Math.round(snow))}″${wet ? ` starting around ${ampm(wet.t, off)}` : ""}.`;
    else if (wet) sky = `Rain likely around ${ampm(wet.t, off)} (${r0(wet.pop)}%).`;
    else sky = "Dry all day.";
    if (gust >= 30) sky += ` Windy, gusts to ${r0(gust)} mph.`;
    const gear = gearFor(morning, off, tHours);
    const f = fishDay(d1, fc, now);
    const fishLine = f ? ` Fishing: ${f.rating} of 5 fish${f.rating >= 4 && f.windows.length ? `, best ${f.windows.map(w => `${ampm(w.start.t, off)}–${ampm(w.end.t + HOUR, off)}`).join(" and ")}` : ""}.` : "";
    messages.push({
      title: `Tomorrow: high ${r0(d1.hi)}°, low ${r0(d1.lo)}°`,
      message: `${dayName(d1.t + 12 * HOUR, off)} in ${place.name}: ${sky}${fishLine}` +
        `\n\nFor the morning, Beavy says to wear ${wearFor(gear, fc, morning.t)}`,
      priority: PRI.normal, tags: [EMOJI.evening],
      attach: `${APP_URL}notify/img/gear-${gear}.jpg`, filename: `beavy-${gear}.jpg`,
      buttons: ["app"],
    });
    state.evening = today;
    if (f && f.rating === 5) state.fish = today;   // the preview already covers the 5-fish day
  }

  // ---------- 4. great fishing tomorrow (evening, once a day) ----------
  if (hourNow >= 18 && hourNow < 21 && state.fish !== today && !snoozed && D.days[1]) {
    const f = fishDay(D.days[1], fc, now);
    if (f && f.rating === 5) {
      const fmtW = w => `${ampm(w.start.t, off)}–${ampm(w.end.t + HOUR, off)}`;
      messages.push({
        title: "Tomorrow is a 5-fish day",
        message: `Great fishing ${dayName(D.days[1].t + 12 * HOUR, off)} at ${place.name}.` +
          (f.windows.length ? ` Best times: ${f.windows.map(fmtW).join(" and ")}.` : "") +
          (f.reasons[0] ? ` ${f.reasons[0][1]}` : ""),
        priority: PRI.normal, tags: [EMOJI.fish], buttons: ["app", "snooze"],
      });
    }
    state.fish = today;
  }

  // ---------- 5. frost and freeze (evening, once a night) ----------
  const nwsFrost = alerts.some(a => /frost|freeze/i.test(a.event));
  if (hourNow >= 17 && hourNow < 21 && state.frost !== today && !nwsFrost) {
    const tonight = hours.filter(h => h.t > now && h.t < now + 16 * HOUR);
    const low = Math.min(...tonight.map(h => h.temp));
    if (low <= 36) {
      const year = LT(now, off).getUTCFullYear();
      const first = LT(now, off).getUTCMonth() >= 7 && state.firstFrostYear !== year;
      const kind = low <= 28 ? "Hard freeze" : low <= 32 ? "Freeze" : "Frost";
      messages.push({
        title: `${first ? "First frost of the season: " : ""}${kind} tonight, low ${r0(low)}°`,
        message: `${place.name} drops to about ${r0(low)}° tonight.\n\n${frostTips(low)}`,
        priority: low <= 28 ? PRI.high : PRI.normal, tags: [EMOJI.frost], buttons: ["app"],
      });
      if (first) state.firstFrostYear = year;
    }
    state.frost = today;
  }

  // ---------- 6. air quality (once a day, when it turns unhealthy) ----------
  if (!quiet && state.airDay !== today) {
    try {
      const aq = await getJSON(fetchFn, `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${place.lat}&longitude=${place.lon}&hourly=us_aqi&timezone=auto&forecast_days=2`);
      const next = aq.hourly.time.map((t, i) => ({ t: parseLocalTime(t, off), aqi: aq.hourly.us_aqi[i] }))
        .filter(h => h.aqi != null && h.t + HOUR > now && h.t < now + 12 * HOUR);
      const worst = next.reduce((m, h) => (h.aqi > (m?.aqi ?? -1) ? h : m), null);
      if (worst && worst.aqi >= 101) {
        const lvl = airLevel(worst.aqi);
        messages.push({
          title: `Air quality: ${lvl.name} (AQI ${r0(worst.aqi)})`,
          message: `Worst around ${ampm(worst.t, off)} in ${place.name}. ${lvl.advice}`,
          priority: worst.aqi >= 151 ? PRI.high : PRI.normal, tags: [EMOJI.air], buttons: ["app", "snooze"],
        });
        state.airDay = today;
      }
    } catch { /* air-quality service down: try next run */ }
  }

  // ---------- 7. night sky: full moon, meteor showers, northern lights (evening, once each) ----------
  if (hourNow >= 17 && hourNow < 21.5) {
    const local = LT(now, off), y = local.getUTCFullYear(), mo = local.getUTCMonth(), dd = local.getUTCDate();
    const t21 = now + (21 - hourNow) * HOUR;
    let clouds = null;
    const skyClouds = async () => {
      if (clouds !== null) return clouds;
      try {
        const cc = await getJSON(fetchFn, `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}&hourly=cloud_cover&timezone=auto&forecast_days=2`);
        const vals = cc.hourly.time.map((t, i) => ({ t: parseLocalTime(t, off), c: cc.hourly.cloud_cover[i] }))
          .filter(h => h.t >= t21 && h.t <= t21 + 8 * HOUR).map(h => h.c);
        clouds = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      } catch { clouds = null; }
      return clouds;
    };
    const cloudLine = c => c == null ? "" : c < 30 ? "Skies look mostly clear." : c < 65 ? "Some clouds around; you may get breaks." : "Clouds will probably hide it, sorry.";

    // full moon (with its traditional name)
    const m = moon(t21), mNext = moon(t21 + DAY);
    const closest = Math.abs(m.age - m.P / 2) <= Math.abs(mNext.age - mNext.P / 2);   // tonight beats tomorrow
    if (Math.abs(m.age - m.P / 2) <= 0.6 && closest && state.fullMoon !== `${y}-${mo}`) {
      const c = await skyClouds();
      messages.push({
        title: `Full ${MOON_NAMES[mo]} tonight`,
        message: `${MOON_NOTES[mo] ? MOON_NOTES[mo] + " " : ""}Look east after sunset to see it rise. ${cloudLine(c)}`,
        priority: PRI.normal, tags: [EMOJI.moon], buttons: ["app"],
      });
      state.fullMoon = `${y}-${mo}`;
    }

    // meteor showers: the night of the peak
    const shower = SHOWERS.find(sh => sh.m === mo && sh.d === dd);
    if (shower && state.shower !== `${y}-${shower.name}`) {
      const c = await skyClouds();
      const moonBright = m.illum > 0.5;
      messages.push({
        title: `${shower.name} meteor shower tonight`,
        message: `Up to about ${shower.rate} meteors an hour at the peak. ${shower.when} Find a dark spot away from lights, let your eyes adjust for 20 minutes, and look up.` +
          (moonBright ? " The bright moon will wash out the fainter ones." : " The moon won't get in the way much.") + ` ${cloudLine(c)}`,
        priority: PRI.normal, tags: [EMOJI.meteor], buttons: ["app"],
      });
      state.shower = `${y}-${shower.name}`;
    }

    // northern lights: a strong geomagnetic storm (Kp 7+) is what it takes this far south
    if (state.aurora !== today) {
      try {
        const rows = await getJSON(fetchFn, "https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json");
        const kps = kpTonight(rows, t21);
        if (kps >= 7) {
          const c = await skyClouds();
          messages.push({
            title: `Northern lights possible tonight (Kp ${kps})`,
            message: `A strong space-weather storm is forecast. Look low on the northern horizon from somewhere dark, best between 10 PM and 2 AM. Your phone camera (night mode) often sees the colors before your eyes do. ${cloudLine(c)}`,
            priority: PRI.high, tags: [EMOJI.aurora], buttons: ["app"],
          });
          state.aurora = today;
        }
      } catch { /* space-weather service down */ }
    }
  }

  return { messages, state, snoozed };
}

// ---------- helpers for the checks above ----------
function frostTips(low) {
  if (low <= 28) return "Hard freeze: bring in or cover anything you want to keep, disconnect and drain the hoses, and open the cabinet doors under sinks on outside walls.";
  if (low <= 32) return "Freeze: cover tender plants or bring pots inside, and bring the hose in.";
  return "Frost: cover tender plants and bring potted ones inside for the night.";
}
function airLevel(aqi) {
  if (aqi >= 201) return { name: "Very unhealthy", advice: "Everyone should stay indoors as much as possible; keep windows closed." };
  if (aqi >= 151) return { name: "Unhealthy", advice: "Keep outdoor play short for everyone, especially kids, and skip hard exercise outside." };
  return { name: "Unhealthy for sensitive groups", advice: "Kids, older adults, and anyone with asthma should take it easy outside." };
}
// Open-Meteo local time string -> ms (same convention as the forecast)
function parseLocalTime(s, off) {
  const [d, tm = "00:00"] = s.split("T"); const [Y, M, D] = d.split("-").map(Number); const [h, mi] = tm.split(":").map(Number);
  return Date.UTC(Y, M - 1, D, h, mi) - off * 1000;
}
function kpTonight(rows, t21) {
  // the feed is a table (first row is the header) or a list of objects, depending on version
  let list = rows;
  if (Array.isArray(rows[0])) { const hdr = rows[0]; list = rows.slice(1).map(r => Object.fromEntries(hdr.map((k, i) => [k, r[i]]))); }
  const from = t21 - 2 * HOUR, to = t21 + 8 * HOUR;
  return list.reduce((mx, r) => {
    const t = Date.parse(String(r.time_tag).replace(" ", "T") + (String(r.time_tag).endsWith("Z") ? "" : "Z"));
    const kp = parseFloat(r.kp ?? r.Kp);
    return t >= from && t <= to && isFinite(kp) ? Math.max(mx, Math.round(kp)) : mx;
  }, 0);
}
const MOON_NAMES = ["Wolf Moon", "Snow Moon", "Worm Moon", "Pink Moon", "Flower Moon", "Strawberry Moon", "Buck Moon", "Sturgeon Moon", "Harvest Moon", "Hunter's Moon", "Beaver Moon", "Cold Moon"];
const MOON_NOTES = { 10: "It's Beavy's moon! It's named for when beavers finish their dams and lodges for winter." };
// Peak nights (evening of). Dates drift a day or so year to year.
const SHOWERS = [
  { name: "Quadrantid", m: 0, d: 3, rate: 100, when: "Best in the hours before dawn." },
  { name: "Lyrid", m: 3, d: 22, rate: 18, when: "Best after midnight." },
  { name: "Eta Aquariid", m: 4, d: 5, rate: 30, when: "Best in the hour or two before dawn." },
  { name: "Perseid", m: 7, d: 12, rate: 100, when: "Best after midnight, but you can see some from about 10 PM." },
  { name: "Orionid", m: 9, d: 21, rate: 20, when: "Best after midnight." },
  { name: "Leonid", m: 10, d: 17, rate: 15, when: "Best after midnight." },
  { name: "Geminid", m: 11, d: 13, rate: 120, when: "Good from about 9 PM on, best around 2 AM." },
];

// Buttons under a notification. "Snooze today" posts to the snooze topic (no server needed).
function buttonsFor(keys = [], topic) {
  const all = {
    app: { action: "view", label: "Open app", url: APP_URL, clear: true },
    radar: { action: "view", label: "See radar", url: APP_URL + "#radar", clear: true },
    snooze: { action: "http", label: "Snooze today", url: `https://ntfy.sh/${topic}-snooze`, method: "POST", body: "snooze", clear: true },
  };
  return keys.map(k => all[k]).filter(Boolean);
}

export async function send(fetchFn, topic, m) {
  const r = await fetchFn("https://ntfy.sh/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      topic, title: m.title, message: m.message, priority: m.priority, tags: m.tags,
      click: APP_URL, icon: APP_URL + "icon-180.png",
      ...(m.attach ? { attach: m.attach + (m.attach === RADAR_IMG ? `?t=${Date.now()}` : ""), filename: m.filename } : {}),
      actions: buttonsFor(m.buttons, topic),
    }),
  });
  if (!r.ok) throw new Error(`ntfy ${r.status}: ${await r.text()}`);
}

// ---------- when run by the workflow ----------
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) { console.error("NTFY_TOPIC is not set; nothing to do."); process.exit(0); }
  const file = process.env.STATE_FILE || "notify-state.json";
  let state = {};
  try { state = JSON.parse(readFileSync(file, "utf8")); } catch {}
  const test = process.argv.includes("--test");
  const out = await run({ state, topic });
  if (test) out.messages.unshift({
    title: "Mia's Almanac is set up", message: "Notifications are working. Beavy will let you know about the weather.\n\nTry the buttons below.",
    priority: PRI.normal, tags: [EMOJI.test], attach: `${APP_URL}notify/img/gear-fall.jpg`, filename: "beavy.jpg", buttons: ["app", "radar", "snooze"],
  });
  if (out.snoozed) console.log("snoozed today: only warnings go out");
  for (const m of out.messages) { await send(fetch, topic, m); console.log("sent:", m.title); }
  if (!out.messages.length) console.log("nothing to send");
  writeFileSync(file, JSON.stringify(out.state));
}

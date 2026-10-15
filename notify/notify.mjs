// Mia's Almanac notifier: runs every 30 minutes on GitHub Actions and sends push notifications
// through ntfy (free app). Uses the same weather math as the app (almanac-core.js).
//
//   NTFY_TOPIC   the private topic name everyone subscribes to in the ntfy app (repo secret)
//   STATE_FILE   where we remember what was already sent (kept between runs by the workflow)
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  HOUR, DAY, LT, fmtClock, fmtHour, dayKey, dayName, r0,
  parseOpenMeteo, derive, fishDay, gearFor, wearFor, GEAR,
} from "../almanac-core.js";

export const HOME = { name: "Canal Winchester, OH", lat: 39.8437, lon: -82.8046 };
export const APP_URL = "https://acompora19.github.io/mias-almanac/";
const QUIET = { from: 21.5, to: 6.5 };   // no non-urgent pushes 9:30 PM to 6:30 AM
// ntfy turns these tag names into the emoji at the front of the title
const EMOJI = { morning: "sunny", rain: "umbrella", snow: "snowflake", fish: "fishing_pole_and_fish", severe: "rotating_light", advisory: "warning", test: "white_check_mark" };
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
      message: `${p.headline || ""}\n\n${(p.description || "").replace(/\s+/g, " ").slice(0, 600)}`.trim(),
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
    const gear = gearFor(c, off);
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

  return { messages, state, snoozed };
}

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

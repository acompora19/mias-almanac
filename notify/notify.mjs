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

const hourly = "temperature_2m,apparent_temperature,precipitation_probability,precipitation,snowfall,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,surface_pressure,uv_index,is_day";

async function getJSON(fetchFn, url) {
  const r = await fetchFn(url, { headers: { "User-Agent": "MiasAlmanac (github.com/acompora19/mias-almanac)", Accept: "application/geo+json, application/json" } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

const ampm = (t, off) => fmtHour(t, off).replace("a", " AM").replace("p", " PM");

/** Decide what to send. Pure apart from the fetches; returns { messages, state }. */
export async function run({ fetchFn = fetch, now = Date.now(), state = {}, place = HOME } = {}) {
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
      priority: sev === "Extreme" ? 5 : sev === "Severe" ? 4 : 3,
      tags: [sev === "Extreme" || sev === "Severe" ? "rotating_light" : "warning"],
    });
    state.alerts[id] = Date.parse(p.expires || p.ends || "") || now + DAY;
  }
  for (const [id, exp] of Object.entries(state.alerts)) if (exp < now - DAY) delete state.alerts[id];

  // ---------- 2. morning summary (6:30 to 9 AM, once a day) ----------
  if (hourNow >= 6.5 && hourNow < 9 && state.morning !== today) {
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
      priority: 3, tags: ["sunrise"],
    });
    state.morning = today;
  }

  // ---------- 3. rain / snow heads-up ----------
  if (!quiet) {
    const next = hours.filter(h => h.t + HOUR > now).slice(0, 4);
    const dryNow = next[0] && next[0].precip < 0.01 && next[0].code < 51;
    const start = next.slice(1).find(h => h.pop >= 60 && (h.precip >= 0.02 || h.snow >= 0.05));
    const recently = state.precipSentAt && now - state.precipSentAt < 5 * HOUR;
    if (dryNow && start && !recently) {
      const snowy = start.snow >= 0.05;
      messages.push({
        title: snowy ? "Snow on the way" : "Rain on the way",
        message: `${snowy ? "Snow" : "Rain"} starting around ${ampm(start.t, off)} in ${place.name} (${r0(start.pop)}% chance).`,
        priority: 3, tags: [snowy ? "snowflake" : "umbrella"],
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
        priority: 4, tags: ["snowflake"],
      });
      state.snowDay = today;
    }
  }

  // ---------- 4. great fishing tomorrow (evening, once a day) ----------
  if (hourNow >= 18 && hourNow < 21 && state.fish !== today && D.days[1]) {
    const f = fishDay(D.days[1], fc, now);
    if (f && f.rating === 5) {
      const fmtW = w => `${ampm(w.start.t, off)}–${ampm(w.end.t + HOUR, off)}`;
      messages.push({
        title: "Tomorrow is a 5-fish day 🎣",
        message: `Great fishing ${dayName(D.days[1].t + 12 * HOUR, off)} at ${place.name}.` +
          (f.windows.length ? ` Best times: ${f.windows.map(fmtW).join(" and ")}.` : "") +
          (f.reasons[0] ? ` ${f.reasons[0][1]}` : ""),
        priority: 3, tags: ["fish"],
      });
    }
    state.fish = today;
  }

  return { messages, state };
}

export async function send(fetchFn, topic, m) {
  const r = await fetchFn("https://ntfy.sh/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic, title: m.title, message: m.message, priority: m.priority, tags: m.tags, click: APP_URL, icon: APP_URL + "icon-180.png" }),
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
  const out = await run({ state });
  if (test) out.messages.unshift({ title: "Mia's Almanac is set up", message: "Notifications are working. Beavy will let you know about the weather.", priority: 3, tags: ["white_check_mark"] });
  for (const m of out.messages) { await send(fetch, topic, m); console.log("sent:", m.title); }
  if (!out.messages.length) console.log("nothing to send");
  writeFileSync(file, JSON.stringify(out.state));
}

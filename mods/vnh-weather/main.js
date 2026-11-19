// Weather for where you are, at the bottom of the VNH sidebar, drawn like the sidebar itself:
// theme colors, monochrome icons, two lines. Line 1: icon, temperature, condition and city, today's
// high / low. Line 2: the next four hours. The tooltip has feels-like, humidity, wind and the next
// three days; a click opens the full forecast on yr.no.
//
// Location: from the IP address (get.geojs.io, kept 6 h). Forecast: MET Norway's
// locationforecast (no key; it asks for a User-Agent), Open-Meteo if that fails. One fetch
// at start, then every 15 min while the Herdr window is active. Nothing about you is sent
// beyond the request itself (the services see the IP address).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, window, checking } from "herdr";

const UA = "herdr-weather/1.0 (Herdr desktop mod)";
const WEATHER_MS = 15 * 60 * 1000, PLACE_MS = 6 * 60 * 60 * 1000;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// MET symbol_code without its _day/_night, to an icon (day, night) and words.
const KINDS = {
  clear: { day: "sun", night: "moon", text: "Clear" },
  fair: { day: "sun", night: "moon", text: "Mostly clear" },
  partly: { day: "cloud-sun", night: "cloud-moon", text: "Partly cloudy" },
  cloudy: { day: "cloud", night: "cloud", text: "Cloudy" },
  fog: { day: "cloud-fog", night: "cloud-fog", text: "Fog" },
  drizzle: { day: "cloud-drizzle", night: "cloud-drizzle", text: "Light rain" },
  rain: { day: "cloud-rain", night: "cloud-rain", text: "Rain" },
  heavy: { day: "cloud-rain", night: "cloud-rain", text: "Heavy rain" },
  showers: { day: "cloud-rain", night: "cloud-rain", text: "Showers" },
  storm: { day: "cloud-lightning", night: "cloud-lightning", text: "Thunderstorm" },
  sleet: { day: "cloud-snow", night: "cloud-snow", text: "Sleet" },
  snow: { day: "cloud-snow", night: "cloud-snow", text: "Snow" },
};

function kindOf(symbol) {
  const s = String(symbol ?? "").replace(/_(day|night|polartwilight)$/, "");
  if (/thunder/.test(s)) return "storm";
  if (/snow/.test(s)) return "snow";
  if (/sleet/.test(s)) return "sleet";
  if (/showers/.test(s)) return "showers";
  if (/^heavyrain/.test(s)) return "heavy";
  if (/^lightrain/.test(s)) return "drizzle";
  if (/rain/.test(s)) return "rain";
  if (s === "fog") return "fog";
  if (s === "cloudy") return "cloudy";
  if (s === "partlycloudy") return "partly";
  if (s === "fair") return "fair";
  return "clear";
}

// WMO weather codes (Open-Meteo) to the same kinds.
function kindOfWmo(code) {
  if (code === 0) return "clear";
  if (code === 1) return "fair";
  if (code === 2) return "partly";
  if (code === 3) return "cloudy";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if (code === 61 || code === 66) return "drizzle";
  if (code === 63) return "rain";
  if (code === 65 || code === 67) return "heavy";
  if (code >= 71 && code <= 77) return "snow";
  if (code >= 80 && code <= 82) return "showers";
  if (code === 85 || code === 86) return "snow";
  if (code >= 95) return "storm";
  return "cloudy";
}

// Apparent temperature (Steadman, as the Australian BoM gives it), from air, humidity, wind (m/s).
function feelsLike(ta, rh, ws) {
  if (typeof ta !== "number") return null;
  const e = (rh ?? 50) / 100 * 6.105 * Math.exp(17.27 * ta / (237.7 + ta));
  return ta + 0.33 * e - 0.7 * (ws ?? 0) - 4;
}

const deg = (n) => (typeof n === "number" ? `${Math.round(n)}°` : "–");
const hour2 = (d) => String(d.getHours()).padStart(2, "0");
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

async function getJson(url) {
  const r = await fetch(url, { headers: { Accept: "application/json", "User-Agent": UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function locate() {
  const j = await getJson("https://get.geojs.io/v1/ip/geo.json");
  const lat = Number(j.latitude), lon = Number(j.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("no location");
  return { lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100, city: j.city || j.region || "Here", country: j.country || "" };
}

// MET Norway: hourly for two days, then every 6 h. -> { now, hours[6], days[3] }
async function fromMet(place) {
  const j = await getJson(`https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${place.lat}&lon=${place.lon}`);
  const series = j?.properties?.timeseries ?? [];
  if (!series.length) throw new Error("empty forecast");
  const at = (s) => new Date(s.time);
  const sym = (s) => s.data?.next_1_hours?.summary?.symbol_code ?? s.data?.next_6_hours?.summary?.symbol_code ?? s.data?.next_12_hours?.summary?.symbol_code;
  const nowS = series.find((s) => at(s).getTime() > Date.now() - 3600e3) ?? series[0];
  const d = nowS.data.instant.details, nowSym = sym(nowS);
  const now = {
    temp: d.air_temperature, feels: feelsLike(d.air_temperature, d.relative_humidity, d.wind_speed),
    humidity: d.relative_humidity, wind: (d.wind_speed ?? 0) * 3.6, kind: kindOf(nowSym), night: /_night$/.test(nowSym ?? ""),
    rain: nowS.data?.next_1_hours?.details?.precipitation_amount ?? null,
  };
  const start = series.indexOf(nowS);
  const hours = series.slice(start + 1, start + 7).map((s) => ({ label: hour2(at(s)), temp: s.data.instant.details.air_temperature, kind: kindOf(sym(s)), night: /_night$/.test(sym(s) ?? "") }));
  const byDay = new Map();
  for (const s of series) {
    const t = at(s), k = dayKey(t);
    if (!byDay.has(k)) byDay.set(k, { date: t, min: Infinity, max: -Infinity, noon: null, any: null });
    const g = byDay.get(k), v = s.data.instant.details.air_temperature;
    g.min = Math.min(g.min, v); g.max = Math.max(g.max, v);
    g.any ??= sym(s);
    if (t.getHours() >= 11 && t.getHours() <= 14 && !g.noon) g.noon = sym(s);
  }
  const all = [...byDay.values()];
  const today = all[0];
  const days = all.slice(1, 4).map((g) => ({ label: DAYS[g.date.getDay()], max: g.max, min: g.min, kind: kindOf(g.noon ?? g.any) }));
  return { now: { ...now, max: today?.max, min: today?.min }, hours, days, source: "MET Norway" };
}

async function fromOpenMeteo(place) {
  const q = "current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day"
    + "&hourly=temperature_2m,weather_code,is_day&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=4&forecast_hours=8";
  const j = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}&${q}`);
  if (j.error) throw new Error(j.reason ?? "Open-Meteo error");
  const c = j.current;
  const now = {
    temp: c.temperature_2m, feels: c.apparent_temperature, humidity: c.relative_humidity_2m, wind: c.wind_speed_10m,
    kind: kindOfWmo(c.weather_code), night: c.is_day === 0, rain: null,
    max: j.daily.temperature_2m_max[0], min: j.daily.temperature_2m_min[0],
  };
  const hours = j.hourly.time.slice(1, 7).map((t, i) => ({ label: t.slice(11, 13), temp: j.hourly.temperature_2m[i + 1], kind: kindOfWmo(j.hourly.weather_code[i + 1]), night: j.hourly.is_day[i + 1] === 0 }));
  const days = j.daily.time.slice(1, 4).map((t, i) => ({ label: DAYS[new Date(`${t}T12:00:00`).getDay()], max: j.daily.temperature_2m_max[i + 1], min: j.daily.temperature_2m_min[i + 1], kind: kindOfWmo(j.daily.weather_code[i + 1]) }));
  return { now, hours, days, source: "Open-Meteo" };
}

function ago(ms) {
  const m = Math.floor((Date.now() - ms) / 60000);
  return m < 1 ? "now" : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}

export default class Weather extends View {
  init(_props, cx) {
    this.place = null; this.wx = null; this.at = 0; this.error = null; this.busy = false;
    try {
      const saved = JSON.parse(localStorage.getItem("weather") ?? "null");
      if (saved?.wx) Object.assign(this, { place: saved.place, wx: saved.wx, at: saved.at ?? 0, placeAt: saved.placeAt ?? 0 });
    } catch {}
    if (checking()) return;
    this.refresh(cx, true);
    cx.timer.every(60000, (cx) => this.refresh(cx, false));
  }

  refresh(cx, force) {
    if (this.busy) return;
    if (!force && (!window()?.active || Date.now() - this.at < WEATHER_MS)) return;
    if (force && this.wx && Date.now() - this.at < WEATHER_MS) return; // a restart within 15 min shows what it had
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        if (!this.place || Date.now() - (this.placeAt ?? 0) > PLACE_MS) { this.place = await locate(); this.placeAt = Date.now(); }
        let wx;
        try { wx = await fromMet(this.place); } catch { wx = await fromOpenMeteo(this.place); }
        this.wx = wx; this.at = Date.now(); this.error = null;
        try { localStorage.setItem("weather", JSON.stringify({ place: this.place, placeAt: this.placeAt, wx: this.wx, at: this.at })); } catch {}
      } catch (e) {
        this.error = String(e?.message ?? e);
      } finally {
        this.busy = false;
        cx.notify();
      }
    });
  }

  render() {
    const t = theme(), wx = this.wx;
    const shell = v_flex().id("vnh-weather").size_full().px(16).py(9).gap(5).text_color(t.muted);
    if (!wx) return shell.justify_center().child(div().text_size(11.5).text_color(t.dim).child(this.error ? "Weather unavailable" : "Finding the weather…"));
    const look = KINDS[wx.now.kind] ?? KINDS.cloudy;
    const icon = (k, night, size, color) => svg(`mods/vnh-weather/${(KINDS[k] ?? KINDS.cloudy)[night ? "night" : "day"]}.svg`).size(size).flex_none().text_color(color);
    const days = wx.days.map((d) => `${d.label} ${(KINDS[d.kind] ?? KINDS.cloudy).text.toLowerCase()} ${deg(d.max)}/${deg(d.min)}`).join(" · ");
    const tip = `Feels ${deg(wx.now.feels)} · humidity ${Math.round(wx.now.humidity ?? 0)}% · wind ${Math.round(wx.now.wind ?? 0)} km/h\n${days}\n${wx.source} · location from your IP · ${ago(this.at)} · click for the full forecast`;
    return shell.cursor_pointer().tooltip(tip)
      .on_click((_e, cx) => cx.open_url(`https://www.yr.no/en/forecast/daily-table/${this.place.lat},${this.place.lon}`))
      .child(h_flex().items_center().gap(7)
        .child(icon(wx.now.kind, wx.now.night, 16, t.foreground))
        .child(div().flex_none().text_size(15).font_semibold().text_color(t.foreground).child(deg(wx.now.temp)))
        .child(div().flex_1().min_w(0).truncate().text_size(12).child(`${look.text} · ${this.place.city}`))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(`${deg(wx.now.max)} / ${deg(wx.now.min)}`)))
      .child(h_flex().justify_between().text_size(10.5).text_color(t.dim)
        // Four hours fit the sidebar's width; the rest is in the tooltip's days and on yr.no.
        .children(wx.hours.slice(0, 4).map((h) => h_flex().items_center().gap(3)
          .child(div().child(h.label))
          .child(icon(h.kind, h.night, 11, t.dim))
          .child(div().text_color(t.muted).child(deg(h.temp))))));
  }
}

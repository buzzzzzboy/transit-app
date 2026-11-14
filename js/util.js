/** Shared helpers: Asia/Taipei time, walking, labels, clustering. */

export const TZ = "Asia/Taipei";
export const EBUS_URL = "https://ebus.tycg.gov.tw/ebus/graphql";
export const NOMINATIM_REVERSE = "https://nominatim.openstreetmap.org/reverse";
export const NOMINATIM_SEARCH = "https://nominatim.openstreetmap.org/search";

export const WALK_M_PER_MIN = 80;
export const WALK_FACTOR = 1.3;
export const NEAR_BUS_RADIUS_M = 500;
export const NEAR_TRA_RADIUS_M = 3000;
export const HOME_STOP_RADIUS_M = 600;
export const CLUSTER_M = 30;
export const MAX_NEAR_STOPS = 5;
export const MAX_HOME_OPTIONS = 3;
export const HOME_STORAGE_KEY = "transit.home";

// TRA CarClass codes. Unknown codes display as "其他(code)" and are not guessed.
export const CAR_CLASS = {
  "1100": "自強號",
  "1101": "太魯閣號",
  "1102": "太魯閣號",
  "1103": "普悠瑪號",
  "1104": "普悠瑪號",
  "1106": "自強號",
  "1107": "自強號",
  "1108": "自強號",
  "1109": "自強號",
  "110A": "自強號",
  "110B": "自強號",
  "110C": "自強號",
  "110D": "自強號",
  "110E": "自強號",
  "110F": "自強號",
  "110G": "自強號",
  "110H": "自強號",
  "110K": "自強號",
  "1110": "莒光號",
  "1111": "莒光號",
  "1112": "莒光號",
  "1114": "復興號",
  "1115": "復興號",
  "1120": "復興號",
  "1130": "區間車",
  "1131": "區間車",
  "1132": "區間快",
  "1140": "普通車",
  "1150": "普通車",
};

export function zonedParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const g = (t) => parts.find((p) => p.type === t).value;
  return {
    year: g("year"),
    month: g("month"),
    day: g("day"),
    hour: g("hour"),
    minute: g("minute"),
    second: g("second"),
  };
}

export function todayStr(date = new Date()) {
  const p = zonedParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

export function todayYmd(date = new Date()) {
  const p = zonedParts(date);
  return `${p.year}${p.month}${p.day}`;
}

export function parseHHMM(text, refDate = new Date()) {
  const m = String(text || "").trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) throw new Error(`時間格式錯誤：${text}（請用 HH:MM）`);
  let h = Number(m[1]);
  const mi = Number(m[2]);
  const s = Number(m[3] || 0);
  if (mi > 59 || s > 59) throw new Error(`時間格式錯誤：${text}`);
  let dayAdd = 0;
  if (h >= 24) {
    dayAdd = Math.floor(h / 24);
    h = h % 24;
  } else if (h > 23) {
    throw new Error(`時間格式錯誤：${text}`);
  }
  const p = zonedParts(refDate);
  const iso = `${p.year}-${p.month}-${p.day}T${pad2(h)}:${pad2(mi)}:${pad2(s)}+08:00`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`時間格式錯誤：${text}`);
  if (dayAdd) d.setTime(d.getTime() + dayAdd * 86400000);
  return d;
}

export function fmtClock(date) {
  const p = zonedParts(date);
  if (p.second !== "00") return `${p.hour}:${p.minute}:${p.second}`;
  return `${p.hour}:${p.minute}`;
}

export function fmtHHMMSS(text) {
  const raw = String(text || "").trim();
  const m = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return raw;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const s = Number(m[3] || 0);
  if (s) return `${pad2(h)}:${pad2(mi)}:${pad2(s)}`;
  return `${pad2(h)}:${pad2(mi)}`;
}

export function fmtDateTime(date) {
  const p = zonedParts(date);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

export function addMinutes(date, mins) {
  return new Date(date.getTime() + Number(mins) * 60000);
}

export function pad2(n) {
  return String(n).padStart(2, "0");
}

export function haversineM(lat1, lon1, lat2, lon2) {
  const r = 6371000;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dphi = ((lat2 - lat1) * Math.PI) / 180;
  const dlmb = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dphi / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dlmb / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Return { pathM, minutes } using straight-line × 1.3 at 80 m/min. */
export function walkFromStraight(straightM) {
  const path = Number(straightM) * WALK_FACTOR;
  if (path < 1) return { pathM: 0, minutes: 0 };
  const minutes = Math.max(1, Math.ceil(path / WALK_M_PER_MIN));
  return { pathM: Math.round(path), minutes };
}

export function carClassName(code) {
  if (!code) return "列車";
  return CAR_CLASS[code] || `其他(${code})`;
}

export function directionLabel(departure, destination, goBack) {
  const dep = departure || "";
  const dest = destination || "";
  let towards = goBack === 2 ? dep : dest;
  towards = towards || (goBack === 2 ? "起點" : "終點");
  if (dep && dest && dep === dest) {
    return `往${towards}（${goBack === 2 ? "返程" : "去程"}）`;
  }
  return `往${towards}`;
}

export function liveTag(kind) {
  return (
    {
      live: "即時",
      scheduled: "時刻表",
      headway: "班距",
      origin_sched: "班表（起站發車）",
    }[kind] || kind
  );
}

export function etaDisplay(node) {
  if (!node) return null;
  const etas = node.etas || [];
  const come = String(node.comeTime || "").trim();
  const bits = [];
  if (etas.length) {
    for (const e of etas.slice(0, 2)) {
      const t = e.etaTime;
      const last = e.isLast ? "（末班）" : "";
      if (t == null) continue;
      const label = t <= 0 ? "即將進站" : `${Number(t)}分`;
      bits.push(label + last);
    }
    if (bits.length) return bits.join("、");
  }
  if (come === "即將進站" || /^\d+\s*分/.test(come) || /^\d{1,2}:\d{2}/.test(come)) {
    return come;
  }
  return null;
}

export function comeMinutes(come, now) {
  const text = String(come || "").trim();
  if (text === "即將進站") return 0;
  const m = text.match(/^(\d+)\s*分/);
  if (m) return Number(m[1]);
  let dt;
  try {
    dt = parseHHMM(text, now);
  } catch {
    return null;
  }
  const delta = (dt.getTime() - now.getTime()) / 1000;
  if (delta < -120) return null;
  return Math.max(0, Math.round(delta / 60));
}

export function synthEtas(node, now = new Date()) {
  const et = Array.isArray(node?.etas) ? node.etas.slice() : [];
  if (et.length) return et;
  const mins = comeMinutes(node?.comeTime || "", now);
  if (mins == null) return [];
  return [{ etaTime: mins, busId: node?.comeBusId || "", isLast: false }];
}

/** Merge same-name stops within CLUSTER_M metres (opposite sides stay separate). */
export function clusterStops(stops) {
  const groups = [];
  const sorted = (stops || []).slice().sort((a, b) => (a.distance || 0) - (b.distance || 0));
  for (const s of sorted) {
    let placed = false;
    for (const g of groups) {
      if (g.name !== s.name) continue;
      if (s.lat == null || g.lat == null) continue;
      if (haversineM(g.lat, g.lon, s.lat, s.lon) <= CLUSTER_M) {
        g.ids.push(s.id);
        const seen = new Set(g.routes.map((r) => `${r.name}\0${r.goBack}`));
        for (const r of s.routes || []) {
          const key = `${r.name}\0${r.goBack}`;
          if (!seen.has(key)) {
            g.routes.push(r);
            seen.add(key);
          }
        }
        if ((s.distance || 0) < (g.distance || 0)) {
          g.distance = s.distance;
          g.lat = s.lat;
          g.lon = s.lon;
        }
        placed = true;
        break;
      }
    }
    if (!placed) {
      groups.push({
        id: s.id,
        ids: [s.id],
        name: s.name,
        lat: s.lat,
        lon: s.lon,
        distance: s.distance || 0,
        routes: (s.routes || []).slice(),
      });
    }
  }
  groups.sort((a, b) => a.distance - b.distance);
  return groups;
}

export function routesIndex(routes) {
  const byName = new Map();
  for (const r of routes || []) {
    const list = byName.get(r.name) || [];
    list.push(r);
    byName.set(r.name, list);
  }
  return byName;
}

export function xnoOf(route) {
  return Number(route.id);
}

export function upcomingOriginTimes(scheduleRows, goBack, after) {
  const times = [];
  const cutoff = new Date(after);
  cutoff.setMilliseconds(0);
  cutoff.setTime(cutoff.getTime() - (cutoff.getSeconds() * 1000) - 30000);
  for (const row of scheduleRows || []) {
    if (row.goBack !== goBack) continue;
    const t = row.scheduleTime;
    if (!t) continue;
    let dt;
    try {
      dt = parseHHMM(t, after);
    } catch {
      continue;
    }
    if (dt >= cutoff) times.push(fmtHHMMSS(t));
  }
  return times;
}

export function formatHeadways(headways, goBack) {
  const out = [];
  for (const h of headways || []) {
    if (h.goBack !== goBack) continue;
    const lo = h.lowerLimit;
    const hi = h.upperLimit;
    const start = h.startTime || "？";
    const end = h.endTime || "？";
    let span;
    if (lo != null && hi != null) {
      span = lo === hi ? `${lo}分鐘一班` : `${lo}–${hi}分鐘一班`;
    } else {
      span = "班距資料不完整";
    }
    out.push(`${fmtHHMMSS(start)}–${fmtHHMMSS(end)} 約${span}`);
  }
  return out;
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

export function finiteNumber(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) throw new Error("無效數字");
  return x;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function loadHome() {
  try {
    const raw = localStorage.getItem(HOME_STORAGE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!Number.isFinite(obj.lat) || !Number.isFinite(obj.lon)) return null;
    if (obj.lat < -90 || obj.lat > 90 || obj.lon < -180 || obj.lon > 180) return null;
    return {
      lat: obj.lat,
      lon: obj.lon,
      label: obj.label || `${obj.lat.toFixed(6)}, ${obj.lon.toFixed(6)}`,
    };
  } catch {
    return null;
  }
}

export function saveHome(home) {
  if (!home) {
    localStorage.removeItem(HOME_STORAGE_KEY);
    return;
  }
  localStorage.setItem(
    HOME_STORAGE_KEY,
    JSON.stringify({
      lat: finiteNumber(home.lat),
      lon: finiteNumber(home.lon),
      label: home.label || "",
      savedAt: new Date().toISOString(),
    }),
  );
}

export function uniqueBy(list, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const k = keyFn(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

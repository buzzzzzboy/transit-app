/** Load slimmed TRA station list and daily timetables from ./data/ (no CORS). */

import { haversineM, parseHHMM } from "./util.js";

let stationsCache = null;
const timetableCache = new Map();

export async function getStations() {
  if (stationsCache) return stationsCache;
  const res = await fetch("./data/tra-stations.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(`無法載入台鐵車站資料（HTTP ${res.status}）`);
  const obj = await res.json();
  stationsCache = obj.stations || [];
  return stationsCache;
}

export async function getTimetable(ymd) {
  if (timetableCache.has(ymd)) return timetableCache.get(ymd);
  const res = await fetch(`./data/tra-${ymd}.json`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`無法載入 ${ymd} 台鐵時刻表（HTTP ${res.status}）`);
  const obj = await res.json();
  const trips = (obj.trains || []).map(loadTrain).filter((t) => t.ordered.length);
  const packed = { date: obj.date || ymd, updated: obj.updated, trips };
  timetableCache.set(ymd, packed);
  return packed;
}

function loadTrain(t) {
  const ordered = [];
  const stops = {};
  for (const s of t.stops || []) {
    if (!s.code) continue;
    ordered.push(String(s.code));
    stops[String(s.code)] = {
      code: String(s.code),
      arr: s.arr || "",
      dep: s.dep || "",
    };
  }
  return {
    number: String(t.no || ""),
    carClass: String(t.type || ""),
    stops,
    ordered,
    destCode: ordered.length ? ordered[ordered.length - 1] : "",
  };
}

export function nextAfter(trip, code) {
  const i = trip.ordered.indexOf(code);
  if (i < 0 || i + 1 >= trip.ordered.length) return null;
  return trip.ordered[i + 1];
}

export function trainsFromStation(trips, stationCode, after) {
  const out = [];
  for (const trip of trips) {
    const st = trip.stops[stationCode];
    if (!st || !st.dep) continue;
    if (nextAfter(trip, stationCode) == null) continue;
    let depDt;
    try {
      depDt = parseHHMM(st.dep, after);
    } catch {
      continue;
    }
    if (depDt >= after) out.push({ depDt, trip, stop: st });
  }
  out.sort((a, b) => a.depDt - b.depDt);
  return out;
}

export function stationsWithin(stations, lat, lon, radiusM) {
  const out = [];
  for (const st of stations) {
    if (st.lat == null || st.lon == null) continue;
    const d = haversineM(lat, lon, st.lat, st.lon);
    if (d <= radiusM) out.push({ dist: d, station: st });
  }
  out.sort((a, b) => a.dist - b.dist);
  return out;
}

export function nearestStation(stations, lat, lon) {
  let best = null;
  let bestD = Infinity;
  for (const st of stations) {
    if (st.lat == null || st.lon == null) continue;
    const d = haversineM(lat, lon, st.lat, st.lon);
    if (d < bestD) {
      bestD = d;
      best = st;
    }
  }
  return best ? { dist: bestD, station: best } : null;
}

export function nameMap(stations) {
  const m = new Map();
  for (const s of stations) m.set(s.code, s.name);
  return m;
}

/** Group upcoming departures by the next station's code vs this station (north / south / other). */
export function groupByDirection(deps, stationCode) {
  const groups = { north: [], south: [], other: [] };
  for (const item of deps) {
    const nxt = nextAfter(item.trip, stationCode);
    try {
      if (nxt != null && Number(nxt) < Number(stationCode)) groups.north.push(item);
      else if (nxt != null && Number(nxt) > Number(stationCode)) groups.south.push(item);
      else groups.other.push(item);
    } catch {
      groups.other.push(item);
    }
  }
  return groups;
}

export function directionTitle(items, stationCode, nameOf, fallback) {
  const nexts = [];
  const seen = new Set();
  for (const item of items) {
    const nxt = nextAfter(item.trip, stationCode);
    const nm = nxt ? nameOf.get(nxt) || nxt : null;
    if (nm && !seen.has(nm)) {
      seen.add(nm);
      nexts.push(nm);
    }
    if (nexts.length >= 3) break;
  }
  if (nexts.length) return `往${nexts.join("／")}方向`;
  return fallback;
}

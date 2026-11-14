/** Taoyuan ebus GraphQL client. The API sends Access-Control-Allow-Origin: *, so the browser can call it directly. */

import { EBUS_URL, finiteNumber, haversineM, sleep, todayStr } from "./util.js";

const ROUTES_KEY = "transit.ebus.routes";
const DETAILS_KEY = "transit.ebus.details";

export async function ebusGraphql(query, { timeout = 20000, retries = 1 } = {}) {
  let last = null;
  for (let i = 0; i <= retries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(EBUS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ query }),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`ebus 回應不是 JSON（HTTP ${res.status}）`);
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ebus GraphQL`);
      }
      if (data.errors && data.data == null) {
        const msg = Array.isArray(data.errors)
          ? data.errors.map((e) => e.message || String(e)).join("；")
          : "未知錯誤";
        throw new Error(`ebus GraphQL 錯誤：${msg}`);
      }
      return data.data || {};
    } catch (e) {
      last = e;
      if (i < retries) await sleep(400);
    } finally {
      clearTimeout(timer);
    }
  }
  throw last;
}

export async function fetchNearStations(lat, lon, radius) {
  const la = finiteNumber(lat);
  const lo = finiteNumber(lon);
  const rad = Math.round(finiteNumber(radius));
  const data = await ebusGraphql(
    `
    query {
      nearStations(location: {lat: ${la}, lon: ${lo}, radius: ${rad}}, lang: "zh") {
        edges {
          distance
          node {
            id name lat lon
            routes {
              edges {
                orderNo goBack
                node { name departure destination }
              }
            }
          }
        }
      }
    }
    `,
    { timeout: 20000 },
  );
  const edges = data?.nearStations?.edges || [];
  const stops = [];
  for (const e of edges) {
    const node = e.node || {};
    const routes = [];
    for (const re of node.routes?.edges || []) {
      const rn = re.node || {};
      routes.push({
        orderNo: re.orderNo,
        goBack: re.goBack,
        name: rn.name,
        departure: rn.departure,
        destination: rn.destination,
      });
    }
    let dist = e.distance;
    if ((dist == null || dist === 0) && node.lat != null && node.lon != null) {
      dist = haversineM(la, lo, node.lat, node.lon);
    }
    stops.push({
      id: node.id,
      name: node.name || "",
      lat: node.lat,
      lon: node.lon,
      distance: dist || 0,
      routes,
    });
  }
  return stops;
}

function readDayCache(key, day) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (obj && obj.cacheDate === day) return obj;
  } catch {
    /* ignore quota / parse errors */
  }
  return null;
}

function writeDayCache(key, day, payload) {
  try {
    localStorage.setItem(key, JSON.stringify({ cacheDate: day, ...payload }));
  } catch {
    /* quota — keep going with in-memory data */
  }
}

let routesMemory = null;

export async function ensureRoutes(day = todayStr()) {
  if (routesMemory && routesMemory.day === day) return routesMemory.routes;
  const cached = readDayCache(ROUTES_KEY, day);
  if (cached?.routes?.length) {
    routesMemory = { day, routes: cached.routes };
    return cached.routes;
  }
  const data = await ebusGraphql(
    `
    query {
      routes(lang: "zh") {
        edges { node { id name departure destination seq opType routeGroup } }
      }
    }
    `,
    { timeout: 25000 },
  );
  const routes = (data?.routes?.edges || []).map((e) => e.node).filter(Boolean);
  if (!routes.length) throw new Error("無法取得桃園公車路線列表");
  routesMemory = { day, routes };
  writeDayCache(ROUTES_KEY, day, { routes });
  return routes;
}

let detailsMemory = { day: null, routes: {} };

export function loadRouteDetails(day = todayStr()) {
  if (detailsMemory.day === day) return detailsMemory.routes;
  const cached = readDayCache(DETAILS_KEY, day);
  const routes = cached?.routes || {};
  detailsMemory = { day, routes };
  return routes;
}

function persistDetails(day, details) {
  detailsMemory = { day, routes: details };
  writeDayCache(DETAILS_KEY, day, { routes: details });
}

export async function fetchRouteDetails(xnos, day, existing) {
  const details = existing || loadRouteDetails(day);
  const needed = [];
  const seen = new Set();
  for (const x of xnos || []) {
    const k = String(x);
    if (seen.has(k)) continue;
    seen.add(k);
    if (!details[k] || !details[k].stations) needed.push(Number(x));
  }
  if (!needed.length) return details;

  const batch = 12;
  for (let i = 0; i < needed.length; i += batch) {
    const chunk = needed.slice(i, i + batch);
    const parts = chunk.map(
      (xno, j) => `
        r${j}: route(xno: ${Number(xno)}, lang: "zh") {
          id name departure destination opType isCycled
          stations {
            edges { orderNo goBack node { id name lat lon } }
          }
        }
        s${j}: dailySchedule(xno: ${Number(xno)}, date: "${day}") {
          ... on DailyTimeTableConnection {
            edges { node { id goBack scheduleTime } }
          }
          ... on DailyHeadwayConnection {
            edges { node { id goBack peakType startTime endTime upperLimit lowerLimit } }
          }
        }
      `,
    );
    const data = await ebusGraphql(`query {\n${parts.join("\n")}\n}`, { timeout: 30000 });
    for (let j = 0; j < chunk.length; j++) {
      const xno = chunk[j];
      const rt = data[`r${j}`] || {};
      const sched = data[`s${j}`] || {};
      const stations = [];
      for (const e of rt.stations?.edges || []) {
        const node = e.node || {};
        stations.push({
          orderNo: e.orderNo,
          goBack: e.goBack,
          id: node.id,
          name: node.name,
          lat: node.lat,
          lon: node.lon,
        });
      }
      const scheduleRows = [];
      const headways = [];
      for (const e of sched.edges || []) {
        const n = e.node || {};
        if ("scheduleTime" in n) {
          scheduleRows.push({ goBack: n.goBack, scheduleTime: n.scheduleTime });
        } else if ("startTime" in n || "upperLimit" in n) {
          headways.push({
            goBack: n.goBack,
            peakType: n.peakType,
            startTime: n.startTime,
            endTime: n.endTime,
            upperLimit: n.upperLimit,
            lowerLimit: n.lowerLimit,
          });
        }
      }
      details[String(xno)] = {
        id: rt.id || String(xno),
        name: rt.name,
        departure: rt.departure,
        destination: rt.destination,
        isCycled: rt.isCycled,
        stations,
        schedule: scheduleRows,
        headways,
      };
    }
  }
  persistDetails(day, details);
  return details;
}

export async function fetchLiveEstimateTimes(xnos) {
  const out = new Map();
  if (!xnos?.length) return out;
  const uniq = uniqueInts(xnos);
  const batch = 15;
  for (let i = 0; i < uniq.length; i += batch) {
    const chunk = uniq.slice(i, i + batch);
    const parts = chunk.map(
      (xno, j) => `
        e${j}: route(xno: ${xno}, lang: "zh") {
          estimateTimes(first: 400) {
            edges {
              node {
                id sid comeTime comeBusId goBack
                isSuspended isOperationDay isConstruction isEvent
                etas { etaTime busId isLast }
              }
            }
          }
        }
      `,
    );
    const data = await ebusGraphql(`query {\n${parts.join("\n")}\n}`, { timeout: 25000 });
    for (let j = 0; j < chunk.length; j++) {
      const xno = chunk[j];
      const rt = data[`e${j}`] || {};
      const edges = rt.estimateTimes?.edges || [];
      out.set(xno, edges.map((e) => e.node || {}));
    }
  }
  return out;
}

/** Live ETAs for [xno, stationId, goBack]. More efficient than whole-route estimates. */
export async function fetchStationEstimates(targets) {
  const out = new Map();
  if (!targets?.length) return out;
  const uniq = [];
  const seen = new Set();
  for (const t of targets) {
    const key = `${t[0]}|${t[1]}|${t[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(t);
  }
  const batch = 40;
  for (let i = 0; i < uniq.length; i += batch) {
    const chunk = uniq.slice(i, i + batch);
    const items = chunk
      .map(([x, s, g]) => `{xno: ${Number(x)}, stationId: ${Number(s)}, goBack: ${Number(g)}}`)
      .join(", ");
    const data = await ebusGraphql(
      `
      query {
        stationEstimates(targets: [${items}]) {
          edges {
            node {
              id sid xno comeTime comeBusId goBack
              isSuspended isOperationDay isConstruction isEvent
              etas { etaTime busId isLast }
            }
          }
        }
      }
      `,
      { timeout: 20000 },
    );
    for (const e of data?.stationEstimates?.edges || []) {
      const n = e.node || {};
      const xno = Number(n.xno);
      const sid = Number(n.id);
      const gb = Number(n.goBack);
      if (!Number.isFinite(xno) || !Number.isFinite(sid) || !Number.isFinite(gb)) continue;
      out.set(`${xno}|${sid}|${gb}`, n);
    }
  }
  return out;
}

function uniqueInts(list) {
  const out = [];
  const seen = new Set();
  for (const x of list) {
    const n = Number(x);
    if (!Number.isFinite(n) || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

export function liveKey(xno, sid, goBack) {
  return `${xno}|${sid}|${goBack}`;
}

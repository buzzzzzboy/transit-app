/** Nearby lookup and home trip planning — ported from transit.py. */

import {
  HOME_STOP_RADIUS_M,
  MAX_HOME_OPTIONS,
  MAX_NEAR_STOPS,
  NEAR_BUS_RADIUS_M,
  NEAR_TRA_RADIUS_M,
  addMinutes,
  carClassName,
  clusterStops,
  directionLabel,
  etaDisplay,
  fmtClock,
  fmtHHMMSS,
  haversineM,
  liveTag,
  parseHHMM,
  routesIndex,
  synthEtas,
  todayStr,
  todayYmd,
  upcomingOriginTimes,
  formatHeadways,
  walkFromStraight,
  xnoOf,
} from "./util.js";
import {
  ensureRoutes,
  fetchLiveEstimateTimes,
  fetchNearStations,
  fetchRouteDetails,
  fetchStationEstimates,
  liveKey,
  loadRouteDetails,
} from "./ebus.js";
import {
  directionTitle,
  getStations,
  getTimetable,
  groupByDirection,
  nameMap,
  nearestStation,
  stationsWithin,
  trainsFromStation,
} from "./tra.js";

function withDistance(stops, lat, lon) {
  return (stops || []).map((s) => {
    let d = s.distance;
    if ((d == null || d === 0) && s.lat != null && s.lon != null) {
      d = haversineM(lat, lon, s.lat, s.lon);
    }
    return { ...s, distance: d || 0 };
  });
}

function routeNamesOf(clusters) {
  const s = new Set();
  for (const g of clusters) {
    for (const r of g.routes || []) {
      if (r.name) s.add(r.name);
    }
  }
  return s;
}

function settleErrors(results) {
  const values = [];
  const errors = [];
  for (const [label, settled] of results) {
    if (settled.status === "fulfilled") values.push(settled.value);
    else {
      values.push(null);
      const msg = settled.reason?.message || String(settled.reason || "未知錯誤");
      errors.push(`${label}：${msg}`);
    }
  }
  return { values, errors };
}

/**
 * Nearby bus stops (≈500 m, 5 closest) with live ETAs, plus TRA stations within 3 km.
 */
export async function queryNearby(lat, lon, { home = null, now = new Date() } = {}) {
  const queryDt = now;
  const day = todayStr(queryDt);
  const ymd = todayYmd(queryDt);

  const jobs = await Promise.allSettled([
    fetchNearStations(lat, lon, NEAR_BUS_RADIUS_M),
    ensureRoutes(day),
    getStations(),
    getTimetable(ymd),
  ]);
  const { values, errors } = settleErrors([
    ["附近公車站查詢失敗", jobs[0]],
    ["公車路線表載入失敗", jobs[1]],
    ["台鐵車站資料載入失敗", jobs[2]],
    ["台鐵時刻表載入失敗", jobs[3]],
  ]);
  const originStops = withDistance(values[0] || [], lat, lon);
  const routes = values[1] || [];
  const traStations = values[2] || [];
  const timetable = values[3];

  const byName = routesIndex(routes);
  const clusters = clusterStops(originStops);
  const top = clusters.slice(0, MAX_NEAR_STOPS);

  const clusterRouteRefs = [];
  for (const g of top) {
    const refs = [];
    const seen = new Set();
    for (const edge of g.routes || []) {
      const matches = byName.get(edge.name || "") || [];
      for (const meta of matches) {
        const xn = xnoOf(meta);
        const key = `${xn}|${edge.goBack}`;
        if (seen.has(key)) continue;
        seen.add(key);
        refs.push({ meta, edge, xn });
      }
    }
    clusterRouteRefs.push(refs);
  }

  const estTargets = [];
  for (let i = 0; i < top.length; i++) {
    const g = top[i];
    for (const { xn, edge } of clusterRouteRefs[i]) {
      if (edge.goBack == null) continue;
      for (const sid of (g.ids || []).slice(0, 2)) {
        if (sid != null) estTargets.push([xn, Number(sid), Number(edge.goBack)]);
      }
    }
  }

  let liveMap = new Map();
  try {
    liveMap = await fetchStationEstimates(estTargets);
  } catch (e) {
    errors.push(`公車即時到站載入失敗：${e.message || e}`);
  }

  const needSched = [];
  for (let i = 0; i < top.length; i++) {
    const g = top[i];
    for (const { xn, edge } of clusterRouteRefs[i]) {
      let found = false;
      for (const sid of (g.ids || []).slice(0, 2)) {
        if (sid == null || edge.goBack == null) continue;
        const node = liveMap.get(liveKey(xn, Number(sid), Number(edge.goBack)));
        if (node && etaDisplay(node)) {
          found = true;
          break;
        }
      }
      if (!found) needSched.push(xn);
    }
  }

  let details = loadRouteDetails(day);
  if (needSched.length) {
    try {
      details = await fetchRouteDetails(needSched, day, details);
    } catch (e) {
      errors.push(`公車班表／站序載入失敗：${e.message || e}`);
    }
  }

  const busStops = top.map((g, i) => {
    const walk = walkFromStraight(g.distance || 0);
    const refs = (clusterRouteRefs[i] || [])
      .slice()
      .sort((a, b) => {
        const na = a.edge.name || "";
        const nb = b.edge.name || "";
        if (na !== nb) return na.localeCompare(nb, "zh-Hant");
        return (a.edge.goBack || 0) - (b.edge.goBack || 0);
      })
      .map(({ meta, edge, xn }) => {
        const goback = edge.goBack;
        const dlabel = directionLabel(
          meta.departure || edge.departure,
          meta.destination || edge.destination,
          goback,
        );
        let node = null;
        if (goback != null) {
          for (const sid of g.ids || []) {
            if (sid == null) continue;
            const n = liveMap.get(liveKey(xn, Number(sid), Number(goback)));
            if (n) {
              node = n;
              if (etaDisplay(n)) break;
            }
          }
        }
        const liveS = node ? etaDisplay(node) : null;
        const flags = [];
        if (node) {
          if (node.isOperationDay === false) flags.push("今日停駛");
          else if (node.isSuspended && !liveS) flags.push("暫停或已過末班");
          if (node.isConstruction) flags.push("施工");
          if (node.isEvent) flags.push("活動交管");
        }
        let kind = null;
        let text = "";
        if (liveS) {
          kind = "live";
          text = liveS;
        } else if (node && node.isOperationDay === false) {
          kind = "stopped";
          text = "今日停駛";
        } else {
          const det = details[String(xn)] || {};
          const sched = det.schedule || [];
          const head = det.headways || [];
          let isFirst = false;
          const sts = (det.stations || []).filter((s) => s.goBack === goback);
          if (sts.length) {
            const first = sts.reduce((a, b) =>
              (a.orderNo || 0) <= (b.orderNo || 0) ? a : b,
            );
            isFirst = (g.ids || []).includes(first.id);
          }
          if (isFirst && sched.length) {
            const times = upcomingOriginTimes(sched, goback, queryDt);
            if (times.length) {
              kind = "scheduled";
              text = `本站發車 ${times.slice(0, 4).join("、")}`;
            } else {
              kind = "none";
              text = "目前無即時資料，今日剩餘班表已無本站發車";
            }
          } else if (sched.length) {
            const times = upcomingOriginTimes(sched, goback, queryDt);
            if (times.length) {
              kind = "origin_sched";
              text = `${times.slice(0, 4).join("、")}（本站時刻未知，不估計）`;
            } else {
              kind = "none";
              text = "目前無即時資料，也沒有剩餘的起站發車班表";
            }
          } else if (head.length) {
            kind = "headway";
            text = formatHeadways(head, goback).slice(0, 3).join("；");
          } else {
            kind = "none";
            text = "目前無即時資料，也沒有班表";
          }
        }
        return {
          name: edge.name,
          direction: dlabel,
          kind,
          text,
          flags,
          tag: kind === "live" || kind === "scheduled" || kind === "origin_sched" || kind === "headway"
            ? liveTag(kind === "live" ? "live" : kind === "scheduled" ? "scheduled" : kind)
            : null,
        };
      });
    return {
      name: g.name,
      straightM: Math.round(g.distance || 0),
      walk,
      routes: refs,
    };
  });

  const nearbyTra = stationsWithin(traStations, lat, lon, NEAR_TRA_RADIUS_M);
  const names = nameMap(traStations);
  let homeTraCode = null;
  if (home) {
    const nearest = nearestStation(traStations, home.lat, home.lon);
    if (nearest) homeTraCode = nearest.station.code;
  }
  const trips = timetable?.trips || [];
  const traStops = nearbyTra.map(({ dist, station: st }) => {
    const walk = walkFromStraight(dist);
    const deps = trips.length ? trainsFromStation(trips, st.code, queryDt) : [];
    const groups = groupByDirection(deps, st.code);
    const dirs = [];
    for (const [key, fallback] of [
      ["north", "站碼較小方向（多為北上）"],
      ["south", "站碼較大方向（多為南下）"],
      ["other", "其他方向"],
    ]) {
      const items = groups[key];
      if (!items.length) continue;
      dirs.push({
        title: directionTitle(items, st.code, names, fallback),
        tag: liveTag("scheduled"),
        trains: items.slice(0, 3).map(({ depDt, trip, stop }) => {
          const destName = names.get(trip.destCode) || trip.destCode;
          let extra = null;
          if (
            homeTraCode &&
            trip.stops[homeTraCode] &&
            trip.ordered.indexOf(homeTraCode) > trip.ordered.indexOf(st.code)
          ) {
            const arr = trip.stops[homeTraCode].arr;
            const homeName = names.get(homeTraCode) || homeTraCode;
            extra = `${fmtHHMMSS(arr)} 到${homeName}`;
          }
          const miss = depDt < addMinutes(queryDt, walk.minutes);
          return {
            dep: fmtClock(depDt),
            type: carClassName(trip.carClass),
            number: trip.number,
            dest: destName,
            extra,
            miss,
          };
        }),
      });
    }
    return {
      name: st.name,
      code: st.code,
      straightM: Math.round(dist),
      walk,
      dirs,
      noTimetable: !trips.length,
      noTrains: trips.length > 0 && !dirs.length,
    };
  });

  return { queryDt, busStops, traStops, errors, rawStopCount: originStops.length };
}

function parseWindow(arriveBy, windowSpec, queryDt) {
  let windowStart = queryDt;
  let windowEnd = null;
  let modeDesc = "現在出發（不限到家時間）";
  if (windowSpec) {
    const [a, b] = String(windowSpec).split("-");
    if (!a || !b) throw new Error("時段請用 HH:MM-HH:MM");
    windowStart = parseHHMM(a.trim(), queryDt);
    windowEnd = parseHHMM(b.trim(), queryDt);
    if (windowEnd < windowStart) throw new Error("到家時段結束時間早於開始時間");
    modeDesc = `希望 ${fmtClock(windowStart)}–${fmtClock(windowEnd)} 到家`;
  } else if (arriveBy) {
    windowEnd = parseHHMM(String(arriveBy).trim(), queryDt);
    modeDesc = `希望 ${fmtClock(windowEnd)} 前到家，現在出發`;
  }
  return { windowStart, windowEnd, modeDesc };
}

function inWindow(opt, windowSpec, arriveBy, windowStart, windowEnd) {
  if (windowSpec && windowEnd) return opt.arriveHome >= windowStart && opt.arriveHome <= windowEnd;
  if (arriveBy && windowEnd) return opt.arriveHome <= windowEnd;
  return true;
}

/**
 * Top options from current location to a user-set home (never hardcoded).
 */
export async function planHome(lat, lon, home, { arriveBy = null, window: windowSpec = null, now = new Date() } = {}) {
  if (!home || !Number.isFinite(home.lat) || !Number.isFinite(home.lon)) {
    throw new Error("尚未設定住家位置");
  }
  const queryDt = now;
  const day = todayStr(queryDt);
  const ymd = todayYmd(queryDt);
  const { windowStart, windowEnd, modeDesc } = parseWindow(arriveBy, windowSpec, queryDt);
  const HOME_LAT = home.lat;
  const HOME_LON = home.lon;

  const jobs = await Promise.allSettled([
    fetchNearStations(lat, lon, Math.max(NEAR_BUS_RADIUS_M, 800)),
    fetchNearStations(HOME_LAT, HOME_LON, HOME_STOP_RADIUS_M),
    ensureRoutes(day),
    getStations(),
    getTimetable(ymd),
  ]);
  const { values, errors } = settleErrors([
    ["出發地公車站查詢失敗", jobs[0]],
    ["住家附近公車站查詢失敗", jobs[1]],
    ["公車路線表載入失敗", jobs[2]],
    ["台鐵車站資料載入失敗", jobs[3]],
    ["台鐵時刻表載入失敗", jobs[4]],
  ]);
  const originStops = withDistance(values[0] || [], lat, lon);
  const homeStopsRaw = withDistance(values[1] || [], HOME_LAT, HOME_LON);
  const routes = values[2] || [];
  const traStations = values[3] || [];
  const timetable = values[4];

  const byName = routesIndex(routes);
  const originClusters = clusterStops(originStops);
  const homeClusters = clusterStops(homeStopsRaw);
  const commonNames = new Set(
    [...routeNamesOf(originClusters)].filter((n) => routeNamesOf(homeClusters).has(n)),
  );
  const xnos = [];
  for (const name of commonNames) {
    for (const meta of byName.get(name) || []) xnos.push(xnoOf(meta));
  }

  let details = loadRouteDetails(day);
  if (xnos.length) {
    try {
      details = await fetchRouteDetails(xnos, day, details);
    } catch (e) {
      errors.push(`公車站序／班表載入失敗：${e.message || e}`);
    }
  }

  const homeById = new Map();
  for (const g of homeClusters) {
    for (const sid of g.ids || []) homeById.set(sid, g);
  }

  function pairOnRoute(xn, goback, originIds, originName, originLat, originLon) {
    const det = details[String(xn)];
    if (!det) return null;
    const sts = (det.stations || [])
      .filter((s) => s.goBack === goback)
      .slice()
      .sort((a, b) => (a.orderNo || 0) - (b.orderNo || 0));
    if (!sts.length) return null;
    const idset = new Set(originIds);
    let boardIdx = -1;
    let boardSt = null;
    for (let i = 0; i < sts.length; i++) {
      if (idset.has(sts[i].id)) {
        boardIdx = i;
        boardSt = sts[i];
        break;
      }
    }
    if (!boardSt) {
      for (let i = 0; i < sts.length; i++) {
        const s = sts[i];
        if (s.name === originName && s.lat != null && originLat != null) {
          if (haversineM(originLat, originLon, s.lat, s.lon) <= 60) {
            boardIdx = i;
            boardSt = s;
            break;
          }
        }
      }
    }
    if (!boardSt) return null;
    const alightCandidates = [];
    for (let j = 0; j < sts.length; j++) {
      if (j <= boardIdx) continue;
      const s = sts[j];
      let hg = homeById.get(s.id);
      if (!hg && s.lat != null) {
        const dhome = haversineM(HOME_LAT, HOME_LON, s.lat, s.lon);
        if (dhome <= HOME_STOP_RADIUS_M) {
          hg = { name: s.name, ids: [s.id], lat: s.lat, lon: s.lon, distance: dhome };
        }
      }
      if (!hg) continue;
      alightCandidates.push({ j, s, hg });
    }
    if (!alightCandidates.length) return null;
    const alightWalk = (item) => {
      let d = item.hg.distance;
      if (d == null && item.hg.lat != null) d = haversineM(HOME_LAT, HOME_LON, item.hg.lat, item.hg.lon);
      else if (d == null) d = haversineM(HOME_LAT, HOME_LON, item.s.lat, item.s.lon);
      return walkFromStraight(d || 0);
    };
    alightCandidates.sort((a, b) => alightWalk(a).minutes - alightWalk(b).minutes);
    const picked = alightCandidates[0];
    return { boardSt, alightSt: picked.s, hg: picked.hg, walk: alightWalk(picked) };
  }

  const candidateXnos = [];
  for (const g of originClusters) {
    for (const edge of g.routes || []) {
      for (const meta of byName.get(edge.name || "") || []) {
        const xn = xnoOf(meta);
        if (pairOnRoute(xn, edge.goBack, g.ids, g.name, g.lat, g.lon)) candidateXnos.push(xn);
      }
    }
  }

  let live = new Map();
  try {
    live = await fetchLiveEstimateTimes([...new Set(candidateXnos)]);
  } catch (e) {
    errors.push(`公車即時到站載入失敗：${e.message || e}`);
  }

  const options = [];

  for (const g of originClusters) {
    const walk = walkFromStraight(g.distance || 0);
    const ready = addMinutes(queryDt, walk.minutes);
    for (const edge of g.routes || []) {
      const name = edge.name;
      const goback = edge.goBack;
      for (const meta of byName.get(name || "") || []) {
        const xn = xnoOf(meta);
        const paired = pairOnRoute(xn, goback, g.ids, g.name, g.lat, g.lon);
        if (!paired) continue;
        const { boardSt, alightSt, walk: homeWalk } = paired;
        const dlabel = directionLabel(meta.departure, meta.destination, goback);
        const liveNodes = live.get(xn) || [];
        const bySid = new Map();
        for (const n of liveNodes) {
          if (n.goBack !== goback) continue;
          const id = Number(n.id);
          if (Number.isFinite(id)) bySid.set(id, n);
        }
        const boardNode = boardSt.id != null ? bySid.get(Number(boardSt.id)) : null;
        const alightNode = alightSt.id != null ? bySid.get(Number(alightSt.id)) : null;
        if (!boardNode || !alightNode) continue;
        const boardEtas = synthEtas(boardNode, queryDt);
        const alightEtas = synthEtas(alightNode, queryDt);
        const alightByBus = new Map();
        for (const e of alightEtas) {
          const bid = e.busId || "";
          if (bid && !alightByBus.has(bid)) alightByBus.set(bid, e);
        }
        for (const be of boardEtas) {
          const bid = be.busId || "";
          const ae = alightByBus.get(bid);
          if (!ae) continue;
          if (be.etaTime == null || ae.etaTime == null) continue;
          const bmin = Number(be.etaTime);
          const amin = Number(ae.etaTime);
          if (amin < bmin) continue;
          const boardDt = addMinutes(queryDt, Math.max(0, bmin));
          if (boardDt < ready) continue;
          const alightDt = addMinutes(queryDt, Math.max(0, amin));
          const arrive = addMinutes(alightDt, homeWalk.minutes);
          const boardTxt = bmin <= 0 ? "即將進站" : `${bmin}分`;
          const alightTxt = amin <= 0 ? "即將進站" : `${amin}分`;
          options.push({
            arriveHome: arrive,
            leaveAt: ready,
            kind: "bus",
            source: "live",
            title: `公車 ${name} ${dlabel}　約 ${fmtClock(arrive)} 到家`,
            tag: liveTag("live"),
            detail:
              `步行 ${walk.minutes} 分至${g.name}　→　` +
              `${fmtClock(boardDt)} 發車（目前顯示 ${boardTxt}到站）　→　` +
              `${fmtClock(alightDt)} 到${alightSt.name}（目前顯示 ${alightTxt}）　→　` +
              `步行 ${homeWalk.minutes} 分到家（約 ${homeWalk.pathM} 公尺）`,
            sortArrive: arrive.getTime(),
            sortLeave: boardDt.getTime(),
            sortName: name || "",
          });
        }
      }
    }
  }

  const names = nameMap(traStations);
  const homeTraHit = nearestStation(traStations, HOME_LAT, HOME_LON);
  const homeTra = homeTraHit?.station || null;
  const HOME_TRA_CODE = homeTra ? homeTra.code : null;
  let pzStraight = 0;
  let pzWalk = { pathM: 0, minutes: 6 };
  if (homeTra) {
    pzStraight = haversineM(HOME_LAT, HOME_LON, homeTra.lat, homeTra.lon);
    pzWalk = walkFromStraight(pzStraight);
  }

  const nearbyTra = stationsWithin(traStations, lat, lon, NEAR_TRA_RADIUS_M);
  const trips = timetable?.trips || [];

  for (const { dist, station: st } of nearbyTra) {
    if (HOME_TRA_CODE && st.code === HOME_TRA_CODE) {
      const direct = walkFromStraight(haversineM(lat, lon, HOME_LAT, HOME_LON));
      if (dist <= 800 || direct.minutes <= 15) {
        const arrive = addMinutes(queryDt, direct.minutes);
        options.push({
          arriveHome: arrive,
          leaveAt: queryDt,
          kind: "walk",
          source: "estimated_walk",
          title: `步行　約 ${fmtClock(arrive)} 到家`,
          tag: "推估步行（直線×1.3，80公尺/分）",
          detail: `目前位置離住家或${st.name}站不遠，可不搭車，步行約 ${direct.pathM} 公尺、${direct.minutes} 分鐘到家`,
          sortArrive: arrive.getTime(),
          sortLeave: queryDt.getTime(),
          sortName: "walk",
        });
      }
      continue;
    }
    const walk = walkFromStraight(dist);
    const ready = addMinutes(queryDt, walk.minutes);
    if (!trips.length || !HOME_TRA_CODE) continue;
    for (const { depDt, trip, stop } of trainsFromStation(trips, st.code, ready)) {
      if (!trip.stops[HOME_TRA_CODE]) continue;
      const iHome = trip.ordered.indexOf(HOME_TRA_CODE);
      const iHere = trip.ordered.indexOf(st.code);
      if (iHome < 0 || iHere < 0 || iHome <= iHere) continue;
      const pzStop = trip.stops[HOME_TRA_CODE];
      let pzArr;
      try {
        pzArr = parseHHMM(pzStop.arr || pzStop.dep, queryDt);
      } catch {
        continue;
      }
      if (pzArr < depDt) continue;
      const arrive = addMinutes(pzArr, pzWalk.minutes);
      const typ = carClassName(trip.carClass);
      const destName = names.get(trip.destCode) || trip.destCode;
      const homeName = names.get(HOME_TRA_CODE) || HOME_TRA_CODE;
      options.push({
        arriveHome: arrive,
        leaveAt: ready,
        kind: "train",
        source: "scheduled",
        title: `台鐵 ${typ} ${trip.number} 往${destName}　約 ${fmtClock(arrive)} 到家`,
        tag: liveTag("scheduled"),
        detail:
          `步行 ${walk.minutes} 分至${st.name}站　→　` +
          `${fmtClock(depDt)} 發車　→　` +
          `${fmtHHMMSS(pzStop.arr)} 到${homeName}站　→　` +
          `步行 ${pzWalk.minutes} 分到家（約 ${pzWalk.pathM} 公尺）`,
        sortArrive: arrive.getTime(),
        sortLeave: depDt.getTime(),
        sortName: trip.number,
      });
    }
  }

  // Transfer via other TRA stations near home (e.g. 中壢 when trains skip 平鎮),
  // same idea as transit.py, but the hub is not hardcoded.
  const prelim = options.filter((o) => inWindow(o, windowSpec, arriveBy, windowStart, windowEnd));
  const needTransfer = prelim.length < MAX_HOME_OPTIONS;
  let horizon = addMinutes(queryDt, 90);
  if (windowEnd) horizon = new Date(Math.min(horizon.getTime(), windowEnd.getTime()));

  const transferHubs = homeTra
    ? stationsWithin(traStations, HOME_LAT, HOME_LON, NEAR_TRA_RADIUS_M)
        .filter(({ station }) => station.code !== HOME_TRA_CODE)
        .slice(0, 2)
    : [];

  const skipTrains = [];
  if (needTransfer && trips.length && nearbyTra.length && transferHubs.length && HOME_TRA_CODE) {
    for (const { dist, station: st } of nearbyTra) {
      if (st.code === HOME_TRA_CODE || transferHubs.some((h) => h.station.code === st.code)) continue;
      const walk = walkFromStraight(dist);
      const ready = addMinutes(queryDt, walk.minutes);
      for (const { depDt, trip } of trainsFromStation(trips, st.code, ready)) {
        if (depDt > horizon) continue;
        const codes = trip.ordered;
        for (const hub of transferHubs) {
          const hubCode = hub.station.code;
          if (!codes.includes(st.code) || !codes.includes(hubCode)) continue;
          if (codes.indexOf(hubCode) <= codes.indexOf(st.code)) continue;
          if (codes.includes(HOME_TRA_CODE) && codes.indexOf(HOME_TRA_CODE) > codes.indexOf(st.code)) {
            continue;
          }
          skipTrains.push({ dist, st, walkMin: walk.minutes, depDt, trip, hub });
        }
      }
    }
  }
  const skipLimited = skipTrains.slice(0, 6);

  if (skipLimited.length) {
    for (const { hub } of skipLimited) {
      // fetch once per unique hub
    }
    const uniqueHubs = [];
    const seenHub = new Set();
    for (const row of skipLimited) {
      if (seenHub.has(row.hub.station.code)) continue;
      seenHub.add(row.hub.station.code);
      uniqueHubs.push(row.hub);
    }
    const hubStopsMap = new Map();
    const zlXnosAll = [];
    for (const hub of uniqueHubs) {
      try {
        const raw = await fetchNearStations(hub.station.lat, hub.station.lon, 500);
        const zlStops = clusterStops(withDistance(raw, hub.station.lat, hub.station.lon));
        hubStopsMap.set(hub.station.code, zlStops);
        const zlNames = new Set(
          [...routeNamesOf(zlStops)].filter((n) => routeNamesOf(homeClusters).has(n)),
        );
        for (const name of zlNames) {
          for (const meta of byName.get(name) || []) zlXnosAll.push(xnoOf(meta));
        }
      } catch (e) {
        errors.push(`${hub.station.name}轉乘公車站查詢失敗：${e.message || e}`);
      }
    }
    const zlXnos = [...new Set(zlXnosAll)];
    let zlLive = new Map();
    if (zlXnos.length) {
      try {
        details = await fetchRouteDetails(zlXnos, day, details);
        zlLive = await fetchLiveEstimateTimes(zlXnos);
      } catch (e) {
        errors.push(`轉乘公車資料失敗：${e.message || e}`);
      }
    }
    for (const { st, walkMin, depDt, trip, hub } of skipLimited) {
      const zlStop = trip.stops[hub.station.code];
      if (!zlStop) continue;
      let zlArr;
      try {
        zlArr = parseHHMM(zlStop.arr || zlStop.dep, queryDt);
      } catch {
        continue;
      }
      const typ = carClassName(trip.carClass);
      const destName = names.get(trip.destCode) || trip.destCode;
      const readyBus = addMinutes(zlArr, 3);
      const zlStops = hubStopsMap.get(hub.station.code) || [];
      const zlNames = new Set(
        [...routeNamesOf(zlStops)].filter((n) => routeNamesOf(homeClusters).has(n)),
      );
      for (const hg of homeClusters) {
        for (const zg of zlStops) {
          for (const edge of zg.routes || []) {
            if (!zlNames.has(edge.name)) continue;
            const goback = edge.goBack;
            for (const meta of byName.get(edge.name || "") || []) {
              const xn = xnoOf(meta);
              const det = details[String(xn)] || {};
              const sts = (det.stations || [])
                .filter((s) => s.goBack === goback)
                .slice()
                .sort((a, b) => (a.orderNo || 0) - (b.orderNo || 0));
              const zid = new Set(zg.ids || []);
              const hid = new Set(hg.ids || []);
              const bidx = sts.findIndex((s) => zid.has(s.id));
              const aidx = sts.findIndex((s) => hid.has(s.id));
              if (bidx < 0 || aidx < 0 || aidx <= bidx) continue;
              const boardSt = sts[bidx];
              const alightSt = sts[aidx];
              const nodes = new Map();
              for (const n of zlLive.get(xn) || []) {
                if (n.goBack === goback && n.id != null) {
                  const id = Number(n.id);
                  if (Number.isFinite(id)) nodes.set(id, n);
                }
              }
              const bn = nodes.get(Number(boardSt.id));
              const an = nodes.get(Number(alightSt.id));
              if (!bn || !an) continue;
              const bBy = new Map();
              for (const e of synthEtas(bn, queryDt)) if (e.busId) bBy.set(e.busId, e);
              const aBy = new Map();
              for (const e of synthEtas(an, queryDt)) if (e.busId) aBy.set(e.busId, e);
              for (const [bid, be] of bBy) {
                const ae = aBy.get(bid);
                if (!ae || be.etaTime == null || ae.etaTime == null) continue;
                const boardBus = addMinutes(queryDt, Number(be.etaTime));
                if (boardBus < readyBus) continue;
                const alightDt = addMinutes(queryDt, Number(ae.etaTime));
                let dhome = hg.distance;
                if (dhome == null) dhome = haversineM(HOME_LAT, HOME_LON, hg.lat, hg.lon);
                const hw = walkFromStraight(dhome || 0);
                const arrive = addMinutes(alightDt, hw.minutes);
                const dlabel = directionLabel(meta.departure, meta.destination, goback);
                options.push({
                  arriveHome: arrive,
                  leaveAt: addMinutes(queryDt, walkMin),
                  kind: "train+bus",
                  source: "scheduled+live",
                  title: `台鐵 ${typ} ${trip.number} 往${destName} 轉 公車 ${edge.name} ${dlabel}　約 ${fmtClock(arrive)} 到家`,
                  tag: "時刻表+即時",
                  detail:
                    `步行 ${walkMin} 分至${st.name}站　→　${fmtClock(depDt)} 發車　→　` +
                    `${fmtHHMMSS(zlStop.arr)} 到${hub.station.name}站（轉乘預留 3 分）　→　` +
                    `${fmtClock(boardBus)} 於${zg.name}搭 ${edge.name}　→　` +
                    `${fmtClock(alightDt)} 到${alightSt.name}　→　步行 ${hw.minutes} 分到家`,
                  sortArrive: arrive.getTime(),
                  sortLeave: depDt.getTime(),
                  sortName: trip.number,
                });
              }
            }
          }
        }
      }
    }
  }

  const filtered = options.filter((o) => inWindow(o, windowSpec, arriveBy, windowStart, windowEnd));
  filtered.sort((a, b) => a.sortArrive - b.sortArrive || a.sortLeave - b.sortLeave || String(a.sortName).localeCompare(String(b.sortName)));
  const unique = [];
  const seenSig = new Set();
  for (const o of filtered) {
    const sig = `${o.kind}|${fmtClock(o.arriveHome)}|${(o.title || "").slice(0, 48)}`;
    if (seenSig.has(sig)) continue;
    seenSig.add(sig);
    unique.push(o);
  }
  const topOpts = unique.slice(0, MAX_HOME_OPTIONS);

  const soonest = [];
  if (!topOpts.length && options.length) {
    const all = options.slice().sort((a, b) => a.sortArrive - b.sortArrive || a.sortLeave - b.sortLeave);
    const seen = new Set();
    for (const o of all) {
      const sig = `${o.kind}|${fmtClock(o.arriveHome)}|${(o.title || "").slice(0, 48)}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      soonest.push(o);
      if (soonest.length >= 3) break;
    }
  }

  const homeStopCards = homeClusters.slice(0, 8).map((g) => {
    let d = g.distance;
    if (d == null && g.lat != null) d = haversineM(HOME_LAT, HOME_LON, g.lat, g.lon);
    const walk = walkFromStraight(d || 0);
    const rnames = [...new Set((g.routes || []).map((r) => r.name).filter(Boolean))].sort().slice(0, 8);
    return { name: g.name, walk, routes: rnames };
  });

  return {
    queryDt,
    modeDesc,
    homeLabel: home.label || `${HOME_LAT.toFixed(6)}, ${HOME_LON.toFixed(6)}`,
    options: topOpts,
    soonest,
    homeStops: homeStopCards,
    homeTra: homeTra
      ? {
          name: homeTra.name,
          code: homeTra.code,
          straightM: Math.round(pzStraight),
          walk: pzWalk,
        }
      : null,
    errors,
  };
}

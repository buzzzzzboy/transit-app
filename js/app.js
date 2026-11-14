/** App shell: geolocation, tabs, rendering, auto-refresh. */

import {
  escapeHtml,
  fmtDateTime,
  loadHome,
  saveHome,
  todayStr,
} from "./util.js";
import { reverseGeocode, searchAddress } from "./geo.js";
import { queryNearby, planHome } from "./plan.js";

const $ = (id) => document.getElementById(id);

const state = {
  tab: "nearby",
  lat: null,
  lon: null,
  accuracy: null,
  place: null,
  locError: null,
  updatedAt: null,
  loading: false,
  nearby: null,
  homeResult: null,
  homeError: null,
  refreshTimer: null,
};

function toast(msg) {
  if (window.Smartisan && typeof window.Smartisan.toast === "function") {
    window.Smartisan.toast(msg);
  } else {
    console.info(msg);
  }
}

function icon(id, cls = "s-icon") {
  return `<svg class="${cls}" aria-hidden="true"><use href="#${id}"></use></svg>`;
}

function chip(kind, label) {
  if (!label) return "";
  const cls =
    kind === "live"
      ? "s-chip s-chip--blue"
      : kind === "origin_sched"
        ? "s-chip s-chip--yellow"
        : kind === "scheduled" || kind === "headway" || kind === "schedlive"
          ? "s-chip s-chip--grey"
          : "s-chip";
  return `<span class="${cls}">${escapeHtml(label)}</span>`;
}

function setTab(name) {
  state.tab = name;
  for (const btn of document.querySelectorAll(".s-bottom-nav [data-tab]")) {
    if (btn.getAttribute("data-tab") === name) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  }
  for (const panel of document.querySelectorAll("[data-panel]")) {
    panel.hidden = panel.getAttribute("data-panel") !== name;
  }
  const titles = { nearby: "大眾運輸", home: "回家", settings: "設定" };
  $("app-title").textContent = titles[name] || "大眾運輸";
  if (name === "home") {
    renderHomeSettingsHint();
    if (loadHome() && state.lat != null && !state.homeResult && !state.loading) {
      refreshHome();
    } else {
      renderHome();
    }
  }
  if (name === "settings") renderSettings();
}

function updateStatusStrip() {
  const el = $("status-strip");
  const bits = [];
  if (state.place) bits.push(escapeHtml(state.place));
  else if (state.lat != null) bits.push(`${state.lat.toFixed(5)}, ${state.lon.toFixed(5)}`);
  else if (state.locError) bits.push(escapeHtml(state.locError));
  else bits.push("定位中…");
  if (state.updatedAt) {
    bits.push(`更新於 ${fmtDateTime(state.updatedAt).slice(11)}（Asia/Taipei）`);
  }
  el.innerHTML = bits.join("<br>");
}

function getLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("這個瀏覽器不支援定位"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        });
      },
      (err) => {
        let msg = "目前無法取得位置";
        if (err && err.code === 1) msg = "沒有定位權限，請允許位置存取，或到設定頁改以座標指定住家";
        else if (err && err.code === 3) msg = "定位逾時，請再試一次";
        reject(new Error(msg));
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 },
    );
  });
}

async function refreshAll({ relocate = true } = {}) {
  if (state.loading) return;
  state.loading = true;
  $("btn-refresh").disabled = true;
  try {
    if (relocate || state.lat == null) {
      try {
        const loc = await getLocation();
        state.lat = loc.lat;
        state.lon = loc.lon;
        state.accuracy = loc.accuracy;
        state.locError = null;
        reverseGeocode(loc.lat, loc.lon).then((place) => {
          state.place = place;
          updateStatusStrip();
        });
      } catch (e) {
        state.locError = e.message || String(e);
        updateStatusStrip();
        if (state.lat == null) {
          renderNearbyError(state.locError);
          renderHome();
          return;
        }
      }
    }
    updateStatusStrip();
    if (state.tab === "home") await refreshHome();
    else await refreshNearby();
  } finally {
    state.loading = false;
    $("btn-refresh").disabled = false;
    updateStatusStrip();
  }
}

async function refreshNearby() {
  if (state.lat == null) return;
  $("nearby-root").innerHTML = loadingBlock("正在查詢附近站牌與班次…");
  try {
    const data = await queryNearby(state.lat, state.lon, { home: loadHome(), now: new Date() });
    state.nearby = data;
    state.updatedAt = data.queryDt;
    renderNearby();
  } catch (e) {
    renderNearbyError(e.message || String(e));
  }
}

async function refreshHome() {
  const home = loadHome();
  if (!home) {
    state.homeResult = null;
    renderHome();
    return;
  }
  if (state.lat == null) {
    renderHome();
    return;
  }
  $("home-results").innerHTML = loadingBlock("正在規劃回家班次…");
  const mode = document.querySelector('input[name="arrive-mode"]:checked')?.value || "now";
  let arriveBy = null;
  let windowSpec = null;
  try {
    if (mode === "by") {
      arriveBy = $("arrive-by").value.trim();
      if (!arriveBy) throw new Error("請輸入希望到家的時刻（HH:MM）");
    } else if (mode === "window") {
      const a = $("window-start").value.trim();
      const b = $("window-end").value.trim();
      if (!a || !b) throw new Error("請輸入到家時段的開始與結束（HH:MM）");
      windowSpec = `${a}-${b}`;
    }
    const data = await planHome(state.lat, state.lon, home, {
      arriveBy,
      window: windowSpec,
      now: new Date(),
    });
    state.homeResult = data;
    state.homeError = null;
    state.updatedAt = data.queryDt;
    renderHome();
  } catch (e) {
    state.homeError = e.message || String(e);
    state.homeResult = null;
    renderHome();
  }
}

function loadingBlock(text) {
  return `<div class="s-empty" style="padding:48px 24px">
    <div class="s-empty__title">${escapeHtml(text)}</div>
    <div class="s-empty__desc">即時到站來自桃園公車 ebus，台鐵使用預先下載的時刻表</div>
  </div>`;
}

function renderNearbyError(msg) {
  $("nearby-root").innerHTML = `<div class="s-empty">
    <div class="s-empty__title">查詢失敗</div>
    <div class="s-empty__desc">${escapeHtml(msg)}</div>
    <button type="button" class="s-btn s-btn--sm" id="retry-nearby">再試一次</button>
  </div>`;
  $("retry-nearby")?.addEventListener("click", () => refreshAll({ relocate: true }));
}

function renderNearby() {
  const data = state.nearby;
  if (!data) {
    $("nearby-root").innerHTML = loadingBlock("正在查詢附近站牌與班次…");
    return;
  }
  const parts = [];
  parts.push(`<div class="s-list-group">
    <div class="s-list-group__body">
      <div class="s-list-group__header">附近公車站　約 500 公尺內最近 ${data.busStops.length} 站</div>`);
  if (!data.busStops.length) {
    parts.push(`<div class="s-list"><div class="s-list-item s-list-item--plain"><div class="s-list-item__text">
      <span class="s-list-item__title">附近 500 公尺內沒有查到桃園公車站</span>
      <span class="s-list-item__subtitle">本工具的公車即時資料以桃園 ebus 為主</span>
    </div></div></div>`);
  } else {
    for (const stop of data.busStops) {
      parts.push(`<div class="s-list stop-card">
        <div class="s-list-item">
          <div class="s-list-item__text">
            <span class="s-list-item__title">${escapeHtml(stop.name)}</span>
            <span class="s-list-item__subtitle">直線約 ${stop.straightM} 公尺，步行約 ${stop.walk.pathM} 公尺、${stop.walk.minutes} 分鐘</span>
          </div>
        </div>`);
      if (!stop.routes.length) {
        parts.push(`<div class="eta-row"><span class="eta-muted">沒有對得到路線資料</span></div>`);
      }
      for (const r of stop.routes) {
        const tagKind = r.kind === "live" ? "live" : r.kind === "origin_sched" ? "origin_sched" : r.kind && r.kind !== "none" && r.kind !== "stopped" ? "scheduled" : "";
        const etaClass = r.kind === "live" ? "eta-live" : "eta-text";
        const flags = r.flags.length ? `<span class="eta-flag">${escapeHtml(r.flags.join("、"))}</span>` : "";
        parts.push(`<div class="eta-row">
          <div class="eta-main">
            <div class="eta-name">${escapeHtml(r.name)} ${escapeHtml(r.direction)}</div>
            <div class="${etaClass}">${r.tag ? chip(tagKind || "scheduled", r.tag) : ""} <span>${escapeHtml(r.text)}</span> ${flags}</div>
          </div>
        </div>`);
      }
      parts.push(`</div>`);
    }
  }
  parts.push(`</div></div>`);

  parts.push(`<div class="s-list-group">
    <div class="s-list-group__body">
      <div class="s-list-group__header">附近台鐵　3 公里內</div>`);
  if (!data.traStops.length) {
    parts.push(`<div class="s-list"><div class="s-list-item s-list-item--plain"><div class="s-list-item__text">
      <span class="s-list-item__title">附近 3 公里內沒有台鐵車站</span>
    </div></div></div>`);
  } else {
    for (const st of data.traStops) {
      parts.push(`<div class="s-list stop-card">
        <div class="s-list-item">
          <div class="s-list-item__text">
            <span class="s-list-item__title">${escapeHtml(st.name)}站（${escapeHtml(st.code)}）</span>
            <span class="s-list-item__subtitle">直線約 ${st.straightM} 公尺，步行約 ${st.walk.pathM} 公尺、${st.walk.minutes} 分鐘</span>
          </div>
        </div>`);
      if (st.noTimetable) {
        parts.push(`<div class="eta-row"><span class="eta-muted">時刻表無法載入。請確認本站已包含 ./data/tra-YYYYMMDD.json，或等待每日更新。</span></div>`);
      } else if (st.noTrains) {
        parts.push(`<div class="eta-row"><span class="eta-muted">今日已無由本站開出的班次（時刻表）。</span></div>`);
      }
      for (const dir of st.dirs) {
        parts.push(`<div class="eta-row dir-head">${escapeHtml(dir.title)} ${chip("scheduled", dir.tag)}</div>`);
        for (const t of dir.trains) {
          const miss = t.miss ? `<span class="eta-warn">步行可能來不及</span>` : "";
          const extra = t.extra ? `<span class="eta-extra">${escapeHtml(t.extra)}</span>` : "";
          parts.push(`<div class="eta-row train-row">
            <span class="train-time">${escapeHtml(t.dep)}</span>
            <span class="train-meta">${escapeHtml(t.type)} ${escapeHtml(t.number)}　往${escapeHtml(t.dest)}</span>
            ${extra}${miss}
          </div>`);
        }
      }
      parts.push(`</div>`);
    }
  }
  parts.push(`</div></div>`);

  if (data.errors.length) {
    parts.push(`<div class="s-list-group"><div class="s-list-group__desc notice">${data.errors.map((e) => escapeHtml(e)).join("<br>")}</div></div>`);
  }
  $("nearby-root").innerHTML = parts.join("\n");
}

function renderHomeSettingsHint() {
  // no-op; renderHome covers it
}

function renderHome() {
  const home = loadHome();
  $("home-current").textContent = home ? `目的地：${home.label}` : "尚未設定住家";
  const results = $("home-results");
  if (!home) {
    results.innerHTML = `<div class="s-empty">
      <div class="s-empty__title">還沒有住家位置</div>
      <div class="s-empty__desc">住家只存在這個瀏覽器裡，不會寫進公開的程式碼。請到設定頁儲存。</div>
      <button type="button" class="s-btn s-btn--sm" data-go-settings>前往設定</button>
    </div>`;
    results.querySelector("[data-go-settings]")?.addEventListener("click", () => setTab("settings"));
    return;
  }
  if (state.lat == null) {
    results.innerHTML = `<div class="s-empty">
      <div class="s-empty__title">還不能規劃行程</div>
      <div class="s-empty__desc">${escapeHtml(state.locError || "正在取得目前位置…")}</div>
    </div>`;
    return;
  }
  if (state.homeError && !state.homeResult) {
    results.innerHTML = `<div class="s-empty">
      <div class="s-empty__title">規劃失敗</div>
      <div class="s-empty__desc">${escapeHtml(state.homeError)}</div>
    </div>`;
    return;
  }
  const data = state.homeResult;
  if (!data) {
    results.innerHTML = loadingBlock("正在規劃回家班次…");
    return;
  }
  const parts = [];
  parts.push(`<div class="s-list-group">
    <div class="s-list-group__body">
      <div class="s-list-group__header">建議行程　依到家時間排序，最多 3 筆　·　${escapeHtml(data.modeDesc)}</div>`);
  const list = data.options.length ? data.options : null;
  if (!list) {
    parts.push(`<div class="s-list"><div class="s-list-item s-list-item--plain"><div class="s-list-item__text">
      <span class="s-list-item__title">目前沒有符合條件、且到家時間可核實的行程</span>
      <span class="s-list-item__subtitle">公車若只有起站發車班表、沒有即時到站，不會臆測中途站到達時間。台鐵使用當日時刻表（非即時誤點）。</span>
    </div></div></div>`);
    if (data.soonest.length) {
      parts.push(`<div class="s-list-group__header">不限到家時段的最近可核實班次</div>`);
      parts.push(optionsList(data.soonest));
    }
  } else {
    parts.push(optionsList(list));
  }
  parts.push(`</div></div>`);

  if (data.homeStops.length) {
    parts.push(`<div class="s-list-group"><div class="s-list-group__body">
      <div class="s-list-group__header">住家附近公車站　約 600 公尺內，供核對</div>
      <div class="s-list">`);
    for (const s of data.homeStops) {
      parts.push(`<div class="s-list-item">
        <div class="s-list-item__text">
          <span class="s-list-item__title">${escapeHtml(s.name)}</span>
          <span class="s-list-item__subtitle">步行約 ${s.walk.pathM} 公尺、${s.walk.minutes} 分鐘　路線：${escapeHtml(s.routes.join("、") || "—")}</span>
        </div>
      </div>`);
    }
    parts.push(`</div></div></div>`);
  }
  if (data.homeTra) {
    parts.push(`<div class="s-list-group"><div class="s-list-group__desc">
      住家附近台鐵：${escapeHtml(data.homeTra.name)}站（${escapeHtml(data.homeTra.code)}）　直線約 ${data.homeTra.straightM} 公尺，步行約 ${data.homeTra.walk.pathM} 公尺、${data.homeTra.walk.minutes} 分鐘
    </div></div>`);
  }
  if (data.errors.length) {
    parts.push(`<div class="s-list-group"><div class="s-list-group__desc notice">${data.errors.map((e) => escapeHtml(e)).join("<br>")}</div></div>`);
  }
  results.innerHTML = parts.join("\n");
}

function optionsList(opts) {
  const rows = opts
    .map((o, i) => {
      const kind = o.source === "live" ? "live" : o.source === "scheduled+live" ? "schedlive" : "scheduled";
      return `<div class="s-list trip-card">
        <div class="s-list-item trip-head">
          <div class="s-list-item__text">
            <span class="s-list-item__title">${i + 1}. ${escapeHtml(o.title)}</span>
            <span class="trip-tag">${chip(kind, o.tag)}</span>
          </div>
        </div>
        <div class="eta-row trip-detail">${escapeHtml(o.detail)}</div>
      </div>`;
    })
    .join("");
  return rows;
}

function renderSettings() {
  const home = loadHome();
  $("home-label-preview").textContent = home
    ? `${home.label}（${home.lat.toFixed(6)}, ${home.lon.toFixed(6)}）`
    : "尚未設定。住家只存在這個瀏覽器的 localStorage，不會寫進公開專案。";
  if (home) {
    $("home-lat").value = String(home.lat);
    $("home-lon").value = String(home.lon);
    if (!$("home-address").value) $("home-address").value = home.label || "";
  }
}

function syncArriveMode() {
  const mode = document.querySelector('input[name="arrive-mode"]:checked')?.value || "now";
  $("arrive-by-fields").hidden = mode !== "by";
  $("window-fields").hidden = mode !== "window";
}

function bind() {
  for (const btn of document.querySelectorAll(".s-bottom-nav [data-tab]")) {
    btn.addEventListener("click", () => setTab(btn.getAttribute("data-tab")));
  }
  $("btn-refresh").addEventListener("click", () => refreshAll({ relocate: true }));
  $("btn-plan").addEventListener("click", () => {
    setTab("home");
    refreshHome();
  });
  for (const radio of document.querySelectorAll('input[name="arrive-mode"]')) {
    radio.addEventListener("change", syncArriveMode);
  }
  syncArriveMode();

  $("btn-use-location").addEventListener("click", async () => {
    try {
      const loc = state.lat != null ? { lat: state.lat, lon: state.lon } : await getLocation();
      $("home-lat").value = loc.lat.toFixed(7);
      $("home-lon").value = loc.lon.toFixed(7);
      const place = await reverseGeocode(loc.lat, loc.lon);
      if (place) $("home-address").value = place;
      toast("已填入目前位置，請按儲存");
    } catch (e) {
      toast(e.message || "無法取得目前位置");
    }
  });

  $("btn-search-address").addEventListener("click", () => doAddressSearch());
  $("home-address").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      doAddressSearch();
    }
  });

  $("btn-save-home").addEventListener("click", () => {
    try {
      const lat = Number($("home-lat").value);
      const lon = Number($("home-lon").value);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("請填入有效的緯度、經度");
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) throw new Error("經緯度超出範圍");
      const label = $("home-address").value.trim() || `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
      saveHome({ lat, lon, label });
      renderSettings();
      toast("住家已儲存在這個瀏覽器");
      state.homeResult = null;
    } catch (e) {
      toast(e.message || String(e));
    }
  });

  $("btn-clear-home").addEventListener("click", () => {
    saveHome(null);
    $("home-lat").value = "";
    $("home-lon").value = "";
    $("home-address").value = "";
    $("address-results").innerHTML = "";
    renderSettings();
    state.homeResult = null;
    toast("已清除住家");
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopTimer();
    else startTimer();
  });
}

async function doAddressSearch() {
  const q = $("home-address").value.trim();
  const box = $("address-results");
  if (!q) {
    box.innerHTML = "";
    toast("請輸入地址或地名");
    return;
  }
  box.innerHTML = `<div class="s-list-item s-list-item--plain"><div class="s-list-item__text"><span class="s-list-item__subtitle">搜尋中…</span></div></div>`;
  try {
    const hits = await searchAddress(q, 5);
    if (!hits.length) {
      box.innerHTML = `<div class="s-list-item s-list-item--plain"><div class="s-list-item__text"><span class="s-list-item__subtitle">找不到符合的地址，也可直接填經緯度</span></div></div>`;
      return;
    }
    box.innerHTML = hits
      .map(
        (h, i) => `<button type="button" class="s-list-item" data-pressable data-hit="${i}">
          <div class="s-list-item__text">
            <span class="s-list-item__title">${escapeHtml(h.label)}</span>
            <span class="s-list-item__subtitle">${escapeHtml(h.displayName)}</span>
          </div>
        </button>`,
      )
      .join("");
    box.querySelectorAll("[data-hit]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const h = hits[Number(btn.getAttribute("data-hit"))];
        $("home-lat").value = h.lat.toFixed(7);
        $("home-lon").value = h.lon.toFixed(7);
        $("home-address").value = h.label;
        toast("已填入搜尋結果，請按儲存");
      });
    });
  } catch (e) {
    box.innerHTML = `<div class="s-list-item s-list-item--plain"><div class="s-list-item__text"><span class="s-list-item__subtitle">${escapeHtml(e.message || "地址搜尋失敗（Nominatim 可能暫時無法使用）")}</span></div></div>`;
  }
}

function startTimer() {
  stopTimer();
  state.refreshTimer = setInterval(() => {
    if (document.hidden || state.loading) return;
    if (state.tab === "settings") return;
    refreshAll({ relocate: false });
  }, 30000);
}

function stopTimer() {
  if (state.refreshTimer) {
    clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }
}

function maybeShowIosTip() {
  const standalone = window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (!isIos || standalone) return;
  if (localStorage.getItem("transit.hideIosTip")) return;
  const el = $("ios-tip");
  if (!el) return;
  el.hidden = false;
  el.querySelector("[data-dismiss]")?.addEventListener("click", () => {
    el.hidden = true;
    localStorage.setItem("transit.hideIosTip", "1");
  });
}

function registerSw() {
  if (!("serviceWorker" in navigator)) return;
  const swUrl = new URL("./sw.js", window.location.href);
  navigator.serviceWorker.register(swUrl.href).catch(() => {});
}

bind();
maybeShowIosTip();
registerSw();
setTab("nearby");
updateStatusStrip();
refreshAll({ relocate: true }).finally(() => startTimer());

// Expose a tiny hook for tests (does not hardcode home).
window.__transit = {
  getState: () => ({ ...state }),
  setTab,
  refreshHome,
  refreshAll,
  today: todayStr,
};

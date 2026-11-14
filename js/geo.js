/** Nominatim geocoding. Browser cannot set User-Agent; failures are non-fatal. */

import { NOMINATIM_REVERSE, NOMINATIM_SEARCH } from "./util.js";

async function nominatimGet(url, timeout = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function reverseGeocode(lat, lon) {
  const qs = new URLSearchParams({
    lat: Number(lat).toFixed(7),
    lon: Number(lon).toFixed(7),
    format: "jsonv2",
    "accept-language": "zh-TW",
    zoom: "16",
  });
  try {
    const obj = await nominatimGet(`${NOMINATIM_REVERSE}?${qs}`, 6000);
    const addr = obj.address || {};
    const parts = [
      addr.city || addr.county || addr.state,
      addr.suburb || addr.town || addr.city_district || addr.district,
      addr.village || addr.neighbourhood || addr.quarter,
      addr.road,
    ];
    const label = parts.filter(Boolean).join("");
    return label || obj.display_name || null;
  } catch {
    return null;
  }
}

export async function searchAddress(query, limit = 5) {
  const q = String(query || "").trim();
  if (!q) return [];
  const qs = new URLSearchParams({
    q,
    format: "jsonv2",
    "accept-language": "zh-TW",
    countrycodes: "tw",
    limit: String(limit),
    addressdetails: "1",
  });
  const arr = await nominatimGet(`${NOMINATIM_SEARCH}?${qs}`, 8000);
  if (!Array.isArray(arr)) return [];
  return arr
    .map((hit) => ({
      lat: Number(hit.lat),
      lon: Number(hit.lon),
      label: formatHit(hit),
      displayName: hit.display_name || "",
    }))
    .filter((h) => Number.isFinite(h.lat) && Number.isFinite(h.lon));
}

function formatHit(hit) {
  const addr = hit.address || {};
  const parts = [
    addr.city || addr.county || addr.state,
    addr.suburb || addr.town || addr.city_district || addr.district,
    addr.village || addr.neighbourhood,
    addr.road,
    addr.house_number,
  ].filter(Boolean);
  const short = parts.join("");
  return short || hit.display_name || `${hit.lat}, ${hit.lon}`;
}

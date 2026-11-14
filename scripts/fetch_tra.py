#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Download and slim TRA station list + daily timetables into /data/.

Used by the GitHub Actions workflow and for local previews. No third-party
dependencies; stdlib only. Writes:

  data/tra-stations.json
  data/tra-YYYYMMDD.json   (today and tomorrow, Asia/Taipei)

Each timetable keeps only train number, car class (type), and per-stop
arrival/departure times so the files stay small enough for GitHub Pages.
"""

from __future__ import annotations

import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Asia/Taipei")
ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"

TRA_LIST_URL = (
    "https://ods.railway.gov.tw/tra-ods-web/ods/download/dataResource/"
    "railway_schedule/JSON/list"
)
TRA_STATIONS_URL = (
    "https://ods.railway.gov.tw/tra-ods-web/ods/download/dataResource/"
    "0518b833e8964d53bfea3f7691aea0ee"
)
USER_AGENT = "TaoyuanTransitPWA/1.0 (https://github.com; TRA open-data mirror for a personal transit PWA)"
HTTP_TIMEOUT = 60
KEEP_DAYS = 3


def now_tpe() -> datetime:
    return datetime.now(TZ)


def http_get(url: str, timeout: int = HTTP_TIMEOUT) -> bytes:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": USER_AGENT, "Accept": "*/*"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code} GET {url}") from e
    except Exception as e:
        raise RuntimeError(f"無法連線 {url}：{e}") from e


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    tmp.replace(path)


def slim_stations(raw: list) -> dict:
    stations = []
    for s in raw:
        gps = (s.get("gps") or "").replace(",", " ").split()
        if len(gps) < 2:
            continue
        try:
            lat, lon = float(gps[0]), float(gps[1])
        except ValueError:
            continue
        name = s.get("stationName") or s.get("name")
        code = s.get("stationCode")
        if not code or not name:
            continue
        stations.append({"code": str(code), "name": name, "lat": lat, "lon": lon})
    return {"updated": now_tpe().strftime("%Y-%m-%d"), "stations": stations}


def slim_timetable(obj: dict, ymd: str) -> dict:
    trains = []
    for t in obj.get("TrainInfos") or []:
        stops = []
        for info in t.get("TimeInfos") or []:
            code = info.get("Station")
            if not code:
                continue
            stops.append(
                {
                    "code": str(code),
                    "arr": (info.get("ARRTime") or "").strip(),
                    "dep": (info.get("DEPTime") or "").strip(),
                }
            )
        if not stops:
            continue
        trains.append(
            {
                "no": str(t.get("Train") or ""),
                "type": str(t.get("CarClass") or ""),
                "stops": stops,
            }
        )
    return {
        "date": ymd,
        "updated": obj.get("UpdateTime") or now_tpe().strftime("%Y-%m-%d %H:%M:%S"),
        "trains": trains,
    }


def parse_tra_list(html: str) -> dict[str, str]:
    pairs = re.findall(r'href="([^"]+)"[^>]*>\s*(\d{8}\.json)\s*<', html, flags=re.I)
    out: dict[str, str] = {}
    for href, name in pairs:
        if href.startswith("http"):
            out[name] = href
        else:
            out[name] = urllib.parse.urljoin("https://ods.railway.gov.tw", href)
    return out


def fetch_timetable(ymd: str, listing: dict[str, str]) -> dict:
    url = listing.get(f"{ymd}.json")
    if not url:
        raise RuntimeError(f"台鐵開放資料找不到 {ymd}.json 時刻表")
    raw = http_get(url, timeout=90)
    obj = json.loads(raw.decode("utf-8"))
    if not isinstance(obj, dict) or "TrainInfos" not in obj:
        raise RuntimeError(f"台鐵時刻表格式異常（{ymd}）")
    return slim_timetable(obj, ymd)


def cleanup_old(today: datetime) -> None:
    cutoff = (today - timedelta(days=KEEP_DAYS)).strftime("%Y%m%d")
    for p in DATA.glob("tra-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9].json"):
        ymd = p.stem.split("-", 1)[1]
        if ymd < cutoff:
            try:
                p.unlink()
                print(f"已刪除過期檔 {p.name}")
            except OSError as e:
                print(f"無法刪除 {p.name}：{e}", file=sys.stderr)


def main() -> int:
    DATA.mkdir(parents=True, exist_ok=True)
    today = now_tpe()
    days = [
        today.strftime("%Y%m%d"),
        (today + timedelta(days=1)).strftime("%Y%m%d"),
    ]
    errors: list[str] = []

    print(f"抓取台鐵車站與時刻表（Asia/Taipei {today.strftime('%Y-%m-%d %H:%M')}）")
    try:
        raw = http_get(TRA_STATIONS_URL, timeout=60)
        stations = json.loads(raw.decode("utf-8"))
        if not isinstance(stations, list) or not stations:
            raise RuntimeError("台鐵車站資料格式異常")
        slim = slim_stations(stations)
        dest = DATA / "tra-stations.json"
        write_json(dest, slim)
        print(f"  車站 {len(slim['stations'])} 筆 → {dest}")
    except Exception as e:
        errors.append(f"車站資料：{e}")
        print(f"  車站資料失敗：{e}", file=sys.stderr)

    listing: dict[str, str] = {}
    try:
        html = http_get(TRA_LIST_URL, timeout=30).decode("utf-8", "replace")
        listing = parse_tra_list(html)
        print(f"  時刻表清單 {len(listing)} 個檔案")
    except Exception as e:
        errors.append(f"時刻表清單：{e}")
        print(f"  時刻表清單失敗：{e}", file=sys.stderr)

    for ymd in days:
        dest = DATA / f"tra-{ymd}.json"
        try:
            slim = fetch_timetable(ymd, listing)
            write_json(dest, slim)
            print(f"  {ymd} 車次 {len(slim['trains'])} 筆 → {dest}")
        except Exception as e:
            errors.append(f"{ymd}：{e}")
            print(f"  {ymd} 失敗：{e}", file=sys.stderr)
            # Fall back to an already-written file if this run failed mid-way.
            if dest.exists():
                print(f"  保留既有 {dest.name}")

    cleanup_old(today)

    if errors and not (DATA / f"tra-{days[0]}.json").exists():
        print("今日時刻表寫入失敗。", file=sys.stderr)
        return 1
    if errors:
        print("部分日期失敗，但已寫入可使用的檔案。", file=sys.stderr)
        return 0
    print("完成。")
    return 0


if __name__ == "__main__":
    sys.exit(main())

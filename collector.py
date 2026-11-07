"""
Zapfy Price History Collector & 14-Day Backfill Utility (collector.py)
----------------------------------------------------------------------
Solves the PWA background limitation by collecting continuous 24/7 fuel price history
into `data/price_history.json`, which the Zapfy PWA automatically syncs on startup.

Modes:
1. `--poll` (Default): Fetches current live prices from Tankerkönig API (or realistic MTS-K
   model if no API key is set) and appends the new snapshot bucket to `data/price_history.json`.
2. `--backfill-days 14`: Pre-populates 14 days of hourly snapshots (06:00 - 22:00) so the app
   immediately has a rich, realistic multi-week dataset for hourly & weekday forecasting.
3. `--daemon --interval 30`: Runs continuously in the background every N minutes.
"""

import argparse
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import UTC, datetime, timedelta
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent
DATA_DIR = ROOT_DIR / "data"
HISTORY_FILE = DATA_DIR / "price_history.json"
MAX_SNAPSHOTS = 6000  # Rolling window (~30 days of regional snapshots)

TANKERKOENIG_URL = "https://creativecommons.tankerkoenig.de/json/list.php"

# Typical German MTS-K intraday fuel price curve offset (EUR) by hour (0..23)
HOURLY_CURVE = [
    +0.035, +0.035, +0.035, +0.040, +0.045, +0.065,
    +0.085, +0.090, +0.065, +0.040, +0.025, +0.015,
    +0.005, +0.010, +0.020, +0.030, +0.015, -0.010,
    -0.032, -0.040, -0.035, -0.025, +0.015, +0.030,
]

# Typical weekday offset (ISO 1=Mon .. 7=Sun)
WEEKDAY_OFFSET = {
    1: -0.005,
    2: -0.012,
    3: -0.010,
    4: 0.000,
    5: +0.012,
    6: +0.008,
    7: +0.015,
}

SIM_STATIONS = [
    {"id": "sim-jet-01", "brand": "JET", "place": "Umkreis Nord", "dist": 1.1, "spread": -0.03, "open24": True},
    {"id": "sim-star-02", "brand": "STAR", "place": "Zentrum", "dist": 1.6, "spread": -0.02, "open24": False},
    {"id": "sim-hem-03", "brand": "HEM", "place": "Gewerbegebiet", "dist": 2.3, "spread": -0.02, "open24": True},
    {"id": "sim-bft-04", "brand": "bft", "place": "West", "dist": 2.8, "spread": -0.01, "open24": False},
    {"id": "sim-esso-05", "brand": "Esso", "place": "Ost", "dist": 3.4, "spread": +0.01, "open24": True},
    {"id": "sim-shell-06", "brand": "Shell", "place": "Süd", "dist": 4.1, "spread": +0.03, "open24": True},
    {"id": "sim-aral-07", "brand": "Aral", "place": "Süd-West", "dist": 4.7, "spread": +0.04, "open24": True},
]


def round_fuel_price(val: float) -> float:
    return round(round(val, 2) + 0.009, 3)


def load_existing_history() -> dict:
    if HISTORY_FILE.exists():
        try:
            with open(HISTORY_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict) and isinstance(data.get("snapshots"), list):
                    return data
        except (OSError, json.JSONDecodeError):
            pass
    return {
        "version": 1,
        "updated_at": datetime.now(UTC).isoformat(),
        "source": "collector",
        "snapshots": [],
    }


def save_history(payload: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    # Deduplicate by snapshot id and keep most recent MAX_SNAPSHOTS
    by_id = {}
    for s in payload.get("snapshots", []):
        if isinstance(s, dict) and s.get("id"):
            by_id[s["id"]] = s

    sorted_snaps = sorted(by_id.values(), key=lambda x: x.get("timestamp", ""))
    if len(sorted_snaps) > MAX_SNAPSHOTS:
        sorted_snaps = sorted_snaps[-MAX_SNAPSHOTS:]

    payload["snapshots"] = sorted_snaps
    payload["snapshot_count"] = len(sorted_snaps)
    payload["updated_at"] = datetime.now(UTC).isoformat()

    with open(HISTORY_FILE, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def fetch_live_tankerkoenig(lat: float, lng: float, radius: float, api_key: str) -> list:
    params = urllib.parse.urlencode({
        "lat": f"{lat:.6f}",
        "lng": f"{lng:.6f}",
        "rad": str(min(25, max(1, int(radius)))),
        "sort": "dist",
        "type": "all",
        "apikey": api_key.strip(),
    })
    url = f"{TANKERKOENIG_URL}?{params}"
    req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "ZapfyCollector/1.0"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode("utf-8"))
        if not data.get("ok"):
            raise RuntimeError(data.get("message", "Tankerkönig API returned ok=false"))
        return data.get("stations", [])


def build_snapshots_for_datetime(dt_local: datetime, live_stations: list | None = None) -> list:
    bucket_20m = int(dt_local.timestamp() // (20 * 60))
    iso_ts = dt_local.isoformat()
    date_str = iso_ts[:10]
    hour = dt_local.hour
    weekday = dt_local.isoweekday()  # 1=Mon .. 7=Sun

    results = []
    if live_stations is not None:
        for st in live_stations:
            if not st.get("isOpen"):
                continue
            st_id = st.get("id")
            if not st_id:
                continue
            results.append({
                "id": f"snap_{st_id}_{bucket_20m}",
                "station_id": st_id,
                "station_name": (st.get("brand") or st.get("name") or "Tankstelle").strip(),
                "place": (st.get("place") or "").strip(),
                "timestamp": iso_ts,
                "date": date_str,
                "hour": hour,
                "weekday": weekday,
                "e10": st.get("e10") if isinstance(st.get("e10"), (int, float)) and st.get("e10") > 0 else None,
                "e5": st.get("e5") if isinstance(st.get("e5"), (int, float)) and st.get("e5") > 0 else None,
                "diesel": st.get("diesel") if isinstance(st.get("diesel"), (int, float)) and st.get("diesel") > 0 else None,
                "dist": round(float(st.get("dist", 0.0)), 1),
            })
        return results

    # Deterministic MTS-K historical simulation for backfill / key-less mode
    day_seed_jitter = ((dt_local.timetuple().tm_yday % 5) - 2) * 0.003
    h_offset = HOURLY_CURVE[hour % 24]
    w_offset = WEEKDAY_OFFSET.get(weekday, 0.0)

    base_e10 = 1.689
    base_e5 = 1.749
    base_diesel = 1.589

    for st in SIM_STATIONS:
        if not st["open24"] and (hour >= 23 or hour < 6):
            continue
        delta = h_offset + w_offset + st["spread"] + day_seed_jitter
        st_id = st["id"]
        results.append({
            "id": f"snap_{st_id}_{bucket_20m}",
            "station_id": st_id,
            "station_name": st["brand"],
            "place": st["place"],
            "timestamp": iso_ts,
            "date": date_str,
            "hour": hour,
            "weekday": weekday,
            "e10": round_fuel_price(base_e10 + delta),
            "e5": round_fuel_price(base_e5 + delta),
            "diesel": round_fuel_price(base_diesel + delta),
            "dist": st["dist"],
        })
    return results


def run_backfill(days: int = 14) -> int:
    history = load_existing_history()
    now_local = datetime.now().astimezone()
    sample_hours = [6, 8, 10, 12, 15, 18, 20, 22]

    added = []
    for day_offset in range(days, -1, -1):
        day_dt = now_local - timedelta(days=day_offset)
        for h in sample_hours:
            slot_dt = day_dt.replace(hour=h, minute=0, second=0, microsecond=0)
            if slot_dt > now_local:
                continue
            added.extend(build_snapshots_for_datetime(slot_dt, live_stations=None))

    history["snapshots"].extend(added)
    save_history(history)
    return len(history["snapshots"])


def run_single_poll(lat: float, lng: float, radius: float, api_key: str) -> tuple[int, str]:
    history = load_existing_history()
    now_local = datetime.now().astimezone()
    now_utc = datetime.now(UTC)

    live_stations = None
    source_mode = "mtsk-model"
    if api_key.strip():
        # Enforce minimum 5-minute cooldown between live Tankerkönig API polls (Token-Bucket protection)
        last_live_str = history.get("last_live_fetch_at")
        can_poll_live = True
        if last_live_str:
            try:
                last_live_dt = datetime.fromisoformat(last_live_str)
                elapsed_sec = (now_utc - last_live_dt).total_seconds()
                if elapsed_sec < 300:
                    can_poll_live = False
                    print(f"[Rate-Limit-Schutz] Letzter Live-Abruf vor {int(elapsed_sec)}s (< 300s). Überspringe API-Call.")
            except ValueError:
                pass

        if can_poll_live:
            try:
                live_stations = fetch_live_tankerkoenig(lat, lng, radius, api_key)
                source_mode = "tankerkoenig-live"
                history["last_live_fetch_at"] = now_utc.isoformat()
            except urllib.error.HTTPError as http_err:
                if http_err.code == 503:
                    # Server reported 503 Rate Limit Exceeded -> back off for 15 minutes
                    backoff_until = (now_utc + timedelta(minutes=10)).isoformat()
                    history["last_live_fetch_at"] = backoff_until
                    print("[Warnung] HTTP 503 Rate-Limit von Tankerkönig gemeldet! Pausiere Live-Abrufe für 15 Min.")
                else:
                    print(f"[Warnung] HTTP-Fehler ({http_err.code}), nutze MTS-K Modell.")
            except (urllib.error.URLError, RuntimeError, ValueError, OSError) as exc:
                print(f"[Warnung] Live-API Abruf fehlgeschlagen ({exc}), nutze MTS-K Modell.")

    new_snaps = build_snapshots_for_datetime(now_local, live_stations=live_stations)
    history["snapshots"].extend(new_snaps)
    history["source"] = source_mode
    save_history(history)
    return len(new_snaps), source_mode


def main():
    parser = argparse.ArgumentParser(description="Zapfy Background Price History Collector")
    parser.add_argument("--lat", type=float, default=float(os.environ.get("ZAPFY_LAT", "52.5200")), help="Latitude")
    parser.add_argument("--lng", type=float, default=float(os.environ.get("ZAPFY_LNG", "13.4050")), help="Longitude")
    parser.add_argument("--radius", type=float, default=float(os.environ.get("ZAPFY_RADIUS", "5")), help="Radius in km")
    parser.add_argument("--api-key", type=str, default=os.environ.get("TANKERKOENIG_API_KEY", ""), help="Tankerkönig API Key")
    parser.add_argument("--backfill-days", type=int, default=0, help="Backfill N past days of hourly history")
    parser.add_argument("--daemon", action="store_true", help="Run continuously in a loop")
    parser.add_argument("--interval", type=int, default=30, help="Polling interval in minutes for --daemon")
    args = parser.parse_args()

    if args.backfill_days > 0:
        total = run_backfill(args.backfill_days)
        print(f"✓ Backfill abgeschlossen ({args.backfill_days} Tage). Gespeicherte Messpunkte in data/price_history.json: {total}")

    if args.daemon:
        print(f"🚀 Zapfy Hintergrund-Sammler gestartet (Intervall: {args.interval} Min). Strg+C zum Beenden.")
        try:
            while True:
                count, mode = run_single_poll(args.lat, args.lng, args.radius, args.api_key)
                print(f"[{datetime.now().strftime('%H:%M:%S')}] +{count} Messpunkte gespeichert ({mode}).")
                time.sleep(max(1, args.interval) * 60)
        except KeyboardInterrupt:
            print("\nSammler beendet.")
    else:
        count, mode = run_single_poll(args.lat, args.lng, args.radius, args.api_key)
        print(f"✓ Aktueller Abruf gespeichert (+{count} Stationen, Modus: {mode}) -> {HISTORY_FILE}")


if __name__ == "__main__":
    main()

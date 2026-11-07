# AI Fast-Lookup & Token-Optimierungs-Index 🧠⚡

> **Zweck dieses Dokuments:** Hochkomprimierter Leitfaden für KI-Coding-Agenten.
> 🛑 **REGEL FÜR DIE KI:** Lies niemals ganze Source-Dateien komplett ein! Nutze diesen Index mit `read_file(StartLine, EndLine)`.

---

## 1. Quick Task Dispatcher (Aufgabe -> Datei & Zeilen)

| Fachliche Aufgabe / Thema | Primäre Datei | Relevante Zeilen | Verbundene Dateien |
| :--- | :--- | :--- | :--- |
| **GPS-Ortung, Token-Bucket Rate-Limiter & Live-API** | [`js/fuel_api.js`](file:///d:/Dev/Zapfy/js/fuel_api.js) | **10–290** (`checkAndConsumeToken`, `getCachedApiResponse`, `fetchStations`) | `js/app.js`: `refreshGpsAndFetchPrices` |
| **Öffnungszeiten & 1-Tap Google Maps Deep-Links** | [`js/fuel_api.js`](file:///d:/Dev/Zapfy/js/fuel_api.js) | **310–435** (`fetchStationDetail`, `pickTodayOpeningEntry`, `getGoogleMapsLinks`) | `js/app.js`: `renderStationsList` |
| **MTS-K Tageszeit-Kurve & 14-Tage-Standort-Historie** | [`js/fuel_api.js`](file:///d:/Dev/Zapfy/js/fuel_api.js) | **440–600** (`getTypicalHourlyOffset`, `generateSimulatedStations`, `buildLocation14DayHistory`) | `js/app.js`: `fetchPricesForCurrentLocation` |
| **Hintergrund-Sammler & 14-Tage Backfill (Python)** | [`collector.py`](file:///d:/Dev/Zapfy/collector.py) | **1–276** (`run_backfill`, `run_single_poll`) | `data/price_history.json` |
| **Tankstellen-Sortierung, Auto-Radius & Smart-Umweg** | [`js/price_engine.js`](file:///d:/Dev/Zapfy/js/price_engine.js) | **13–190** (`formatPriceParts`, `rankStations`) | `js/app.js`: `renderAll`, `renderStationsList` |
| **Statistik, Tageszeit-Chart & Tank-Empfehlung** | [`js/price_engine.js`](file:///d:/Dev/Zapfy/js/price_engine.js) | **195–364** (`computeForecastAndStats`) | `js/app.js`: `renderForecastAndStatsTab` |
| **IndexedDB Preis-Snapshots, Details & Settings** | [`js/db.js`](file:///d:/Dev/Zapfy/js/db.js) | **15–350** (`saveSnapshotsBatch`, `getAllStationDetailsMap`, `exportAllData`, `importAllData`) | `docs/DATA_MODEL.md` |
| **Backup, Restore & CSV-Preishistorie** | [`js/export_service.js`](file:///d:/Dev/Zapfy/js/export_service.js) | **10–130** (`backupAndShare`, `exportSnapshotsCsv`, `escapeCsv`) | `js/app.js`: Export-Handler |
| **Touch-Swipe Navigation & 3 Tabs** | [`js/app.js`](file:///d:/Dev/Zapfy/js/app.js) | **255–310** (`initSwipeNavigation`, `switchTabByIndex`) | `index.html`: `.tabs-viewport`, `.tabs-track` |
| **Radar-Liste & 1-Zeilen-Prognose (Tab 1, Clean UI)** | [`js/app.js`](file:///d:/Dev/Zapfy/js/app.js) | **555–730** (`renderRadarForecastBar`, `renderStationsList`) | [`styles.css`](file:///d:/Dev/Zapfy/styles.css): `.radar-forecast-bar`, `.station-card` |
| **Single-Screen Layout & 3D Tactile Design** | [`styles.css`](file:///d:/Dev/Zapfy/styles.css) | **1–135**, **315–490** (`.app-shell`, `.station-card`, `.btn-gmaps-route`) | `index.html` |

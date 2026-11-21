# AI Fast-Lookup & Token-Optimierungs-Index 🧠⚡

> **Zweck dieses Dokuments:** Hochkomprimierter Leitfaden für KI-Coding-Agenten.
> 🛑 **REGEL FÜR DIE KI:** Lies niemals ganze Source-Dateien komplett ein! Nutze diesen Index mit `read_file(StartLine, EndLine)`.

---

## 1. Quick Task Dispatcher (Aufgabe -> Datei & Zeilen)

| Fachliche Aufgabe / Thema | Primäre Datei | Relevante Zeilen | Verbundene Dateien |
| :--- | :--- | :--- | :--- |
| **GPS-Ortung, Makro-Fahrtrichtung, Rate-Limiter, Watcher & Live-API** | [`js/fuel_api.js`](file:///d:/Dev/Zapfy/js/fuel_api.js) | **10–595** (`updateAndComputeMacroHeading`, `checkAndConsumeToken`, `startLocationWatch`, `fetchStations`, `fetchStationsAtPoint`) | `js/app.js`: `refreshGpsAndFetchPrices`, `handleDriveGpsTick` |
| **Öffnungszeiten, ETA-Prüfung & 1-Tap Google Maps Deep-Links (+ Waypoints)** | [`js/fuel_api.js`](file:///d:/Dev/Zapfy/js/fuel_api.js) | **615–890** (`fetchStationDetail`, `pickTodayOpeningEntry`, `evaluateOpenAtTime`, `getGoogleMapsLinks`) | `js/app.js`: `renderStationsList` |
| **MTS-K Tageszeit-Kurve & 14-Tage-Standort-Historie** | [`js/fuel_api.js`](file:///d:/Dev/Zapfy/js/fuel_api.js) | **890–1060** (`getTypicalHourlyOffset`, `generateSimulatedStations`, `buildLocation14DayHistory`) | `js/app.js`: `fetchPricesForCurrentLocation` |
| **Routen-Korridor, OSRM, Google-Maps-Parser & Kurzlink-Expansion** | [`js/route_service.js`](file:///d:/Dev/Zapfy/js/route_service.js) | **1–799** (`parseGoogleMapsInput`, `expandShortLink`, `buildGeocodeCandidates`, `fetchDrivingRoute`, `projectPointOntoRoute`, `fetchRouteCorridorStations`) | `js/app.js`: `planRouteFromInput`, `handleDriveGpsTick` |
| **Cloudflare Worker für Google-Maps-Kurzlinks** | [`cloudflare-worker/maps-resolver.js`](file:///d:/Dev/Zapfy/cloudflare-worker/maps-resolver.js) | **1–329** (`fetch`, `extractCoordsFromMapsUrl`, `extractMetaFromHtml`, `unwrapConsentUrl`) | `js/route_service.js`: `expandShortLink` |
| **Hintergrund-Sammler & 14-Tage Backfill (Python)** | [`collector.py`](file:///d:/Dev/Zapfy/collector.py) | **1–276** (`run_backfill`, `run_single_poll`) | `data/price_history.json` |
| **Dynamischer Smart-Radius, Voraus-Korridor, ETA-Routen-Ranking & Pareto-Filter** | [`js/price_engine.js`](file:///d:/Dev/Zapfy/js/price_engine.js) | **13–575** (`formatPriceParts`, `rankStations`, `rankRouteStations`) | `js/app.js`: `renderAll`, `renderStationsList` |
| **Statistik, Tageszeit-Chart & Tank-Empfehlung** | [`js/price_engine.js`](file:///d:/Dev/Zapfy/js/price_engine.js) | **576–780** (`computeForecastAndStats`) | `js/app.js`: `renderForecastAndStatsTab` |
| **IndexedDB Preis-Snapshots, Details & Settings** | [`js/db.js`](file:///d:/Dev/Zapfy/js/db.js) | **15–350** (`saveSnapshotsBatch`, `getAllStationDetailsMap`, `exportAllData`, `importAllData`) | `docs/DATA_MODEL.md` |
| **Backup, Restore & CSV-Preishistorie** | [`js/export_service.js`](file:///d:/Dev/Zapfy/js/export_service.js) | **10–130** (`backupAndShare`, `exportSnapshotsCsv`, `escapeCsv`) | `js/app.js`: Export-Handler |
| **Touch-Swipe Navigation & 3 Tabs** | [`js/app.js`](file:///d:/Dev/Zapfy/js/app.js) | **650–705** (`initSwipeNavigation`, `switchTabByIndex`) | `index.html`: `.tabs-viewport`, `.tabs-track` |
| **Car-Cockpit UX: Hero-Karte, Drive-HUD, ETA-Status & Nachtmodus** | [`js/app.js`](file:///d:/Dev/Zapfy/js/app.js) | **1105–1805** (`formatOpenStatusHtml`, `applyTheme`, `handleMarkTanked`, `renderStationsList`, `renderDriveHud`) | [`styles.css`](file:///d:/Dev/Zapfy/styles.css): `.thumb-dock`, `.station-card.is-hero`, `.drive-hud-panel` |
| **Routen-Modus, Maps-Übernahme & Schnellziele** | [`js/app.js`](file:///d:/Dev/Zapfy/js/app.js) | **2015–2320** (`handleIncomingDestinationParams`, `planRouteToDestination`, `clearActiveRoute`) | `js/route_service.js`, `manifest.json` |
| **Single-Screen Layout, Dark Cockpit & Route Bottom-Sheet** | [`styles.css`](file:///d:/Dev/Zapfy/styles.css) | **7–205**, **208–530**, **890–1310**, **2796–3218** (`html.theme-dark`, `.thumb-dock`, `.route-bar`, `.route-sheet`) | `index.html` |
| **Produkt-Roadmap (Thema 1–3)** | [`docs/ROADMAP.md`](file:///d:/Dev/Zapfy/docs/ROADMAP.md) | **1–45** (`Route`, `Sprach-Beifahrer`, `Tanken & Laden`) | — |

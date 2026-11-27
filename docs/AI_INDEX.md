# AI Fast-Lookup & Token-Optimierungs-Index 🧠⚡

> **Zweck dieses Dokuments:** Hochkomprimierter Leitfaden für KI-Coding-Agenten.
> 🛑 **REGEL FÜR DIE KI:** Lies niemals ganze Source-Dateien komplett ein! Nutze diesen Index mit `read_file(StartLine, EndLine)`.

---

## 1. Quick Task Dispatcher (Aufgabe -> Datei & Zeilen)

| Fachliche Aufgabe / Thema | Primäre Datei | Relevante Zeilen | Verbundene Dateien |
| :--- | :--- | :--- | :--- |
| **GPS-Ortung, Makro-Fahrtrichtung, Rate-Limiter, Watcher & Live-API** | [`js/fuel_api.js`](file:///d:/Dev/Zapfy/js/fuel_api.js) | **10–595** (`updateAndComputeMacroHeading`, `checkAndConsumeToken`, `startLocationWatch`, `fetchStations`, `fetchStationsAtPoint`) | `js/app.js`: `refreshGpsAndFetchPrices`, `handleDriveGpsTick` |
| **Öffnungszeiten, ETA-Prüfung & 1-Tap Google Maps Deep-Links (+ Waypoints)** | [`js/fuel_api.js`](file:///d:/Dev/Zapfy/js/fuel_api.js) | **615–890** (`fetchStationDetail`, `pickTodayOpeningEntry`, `evaluateOpenAtTime`, `getGoogleMapsLinks`) | `js/app.js`: `renderStationsList` |
| **MTS-K Tageszeit-Simulationsmodell & Demo-Fallback** | [`js/fuel_api.js`](file:///d:/Dev/Zapfy/js/fuel_api.js) | **890–985** (`getTypicalHourlyOffset`, `generateSimulatedStations`) | `js/app.js`: `fetchPricesForCurrentLocation` |
| **Routen-Korridor, OSRM, Google-Maps-Parser & Kurzlink-Expansion** | [`js/route_service.js`](file:///d:/Dev/Zapfy/js/route_service.js) | **1–799** (`parseGoogleMapsInput`, `expandShortLink`, `buildGeocodeCandidates`, `fetchDrivingRoute`, `projectPointOntoRoute`, `fetchRouteCorridorStations`) | `js/app.js`: `planRouteFromInput`, `handleDriveGpsTick` |
| **Cloudflare Worker für Google-Maps-Kurzlinks** | [`cloudflare-worker/maps-resolver.js`](file:///d:/Dev/Zapfy/cloudflare-worker/maps-resolver.js) | **1–329** (`fetch`, `extractCoordsFromMapsUrl`, `extractMetaFromHtml`, `unwrapConsentUrl`) | `js/route_service.js`: `expandShortLink` |
| **Dynamischer Smart-Radius, Voraus-Korridor, ETA-Routen-Ranking & Pareto-Filter** | [`js/price_engine.js`](file:///d:/Dev/Zapfy/js/price_engine.js) | **13–567** (`formatPriceParts`, `rankStations`, `rankRouteStations`) | `js/app.js`: `renderAll`, `renderStationsList` |
| **IndexedDB Details-Cache, Favoriten & Settings/Backup** | [`js/db.js`](file:///d:/Dev/Zapfy/js/db.js) | **15–248** (`getAllStationDetailsMap`, `exportAllData`, `importAllData`) | `docs/DATA_MODEL.md` |
| **Backup & Restore (JSON)** | [`js/export_service.js`](file:///d:/Dev/Zapfy/js/export_service.js) | **10–73** (`backupAndShare`, `restoreFromJsonFile`) | `js/app.js`: Backup-Handler |
| **Touch-Swipe Navigation & 2 Tabs (`Preise` / `Setup`)** | [`js/app.js`](file:///d:/Dev/Zapfy/js/app.js) | **597–645** (`initSwipeNavigation`, `switchTabByIndex`) | `index.html`: `.tabs-viewport`, `.tabs-track` |
| **Car-Cockpit UX: Hero-Karte, Drive-HUD, ETA-Status & Nachtmodus** | [`js/app.js`](file:///d:/Dev/Zapfy/js/app.js) | **1033–1745** (`formatOpenStatusHtml`, `applyTheme`, `handleMarkTanked`, `renderStationsList`, `renderDriveHud`) | [`styles.css`](file:///d:/Dev/Zapfy/styles.css): `.thumb-dock`, `.station-card.is-hero`, `.drive-hud-panel` |
| **Routen-Modus, Maps-Übernahme & Schnellziele** | [`js/app.js`](file:///d:/Dev/Zapfy/js/app.js) | **1747–2040** (`handleIncomingDestinationParams`, `planRouteToDestination`, `clearActiveRoute`) | `js/route_service.js`, `manifest.json` |
| **Single-Screen Layout, Dark Cockpit & Route Bottom-Sheet** | [`styles.css`](file:///d:/Dev/Zapfy/styles.css) | **7–205**, **208–530**, **890–1310**, **2360–2664** (`html.theme-dark`, `.thumb-dock`, `.route-bar`, `.route-sheet`) | `index.html` |
| **Produkt-Roadmap (Thema 1–3)** | [`docs/ROADMAP.md`](file:///d:/Dev/Zapfy/docs/ROADMAP.md) | **1–45** (`Route`, `Sprach-Beifahrer`, `Tanken & Laden`) | — |

# AI Agent Guidelines & Token-Optimization · Zapfy ⛽📱

> **Mandatory AI Instruction:** When handling coding, debugging, or enhancement requests in this workspace, **always consult [`docs/AI_INDEX.md`](file:///d:/Dev/Zapfy/docs/AI_INDEX.md) first**.
> Do NOT read entire source files (`js/app.js`, `js/db.js`, `js/fuel_api.js`, `js/price_engine.js`, `js/export_service.js`, `styles.css`) into context. Jump directly to the exact line ranges documented in the index using `read_file(StartLine, EndLine)`.

---

## 1. Documentation Map
- **Token-Spar-Index & Zeilen-Ranges:** [`docs/AI_INDEX.md`](file:///d:/Dev/Zapfy/docs/AI_INDEX.md)
- **Gesamtarchitektur & Car-UX PWA:** [`docs/ARCHITECTURE.md`](file:///d:/Dev/Zapfy/docs/ARCHITECTURE.md)
- **IndexedDB Schema & Backup-Format:** [`docs/DATA_MODEL.md`](file:///d:/Dev/Zapfy/docs/DATA_MODEL.md)

---

## 2. Invarianten für dieses Projekt
1. **Zero-Build Vanilla PWA:** Reines modernes Vanilla JS (ES Modules), HTML5 und CSS3. Kein Node.js, kein NPM, kein Webpack, kein Vite oder fremder Bundler.
2. **Echtzeit-Daten & Offline-Resilienz:** Bezieht Live-Preise über die offizielle Tankerkönig-API (MTS-K Bundeskartellamt) und fällt ohne API-Key oder ohne Netz nahtlos auf ein deterministisches MTS-K Tageszeit-Simulationsmodell zurück.
3. **1-Tap Google Maps Handover (Auto-optimiert):** Keine fummelige eingebettete Zweitkarte. Stattdessen große, kontrastreiche 3D-Karten mit direkter 1-Tap-Übergabe (`🧭 Route starten` & `📍 Pin`) an die laufende Google-Maps-App.
4. **Persistenter Speicher & Statistik:** Nutzt `IndexedDB` + `navigator.storage.persist()` zur lokalen Aufzeichnung von Preis-Snapshots für Tageszeit- und Wochentags-Prognosen.
5. **C:\ Drive Schutz:** Keine großen temporären Builds oder Caches auf `C:\` schreiben (`C:\` hat akuten Platzmangel). Projekt bleibt auf `D:\Dev\Zapfy`.
6. **Mobile First UI (Shiftly Design System):** Vollbildfähige Standalone-PWA (`100dvh`, Zero Body Scroll) mit Safe-Area-Insets, 3D Tactile Depth und horizontalen Swipe-Tabs.
7. **Sprache:** UI ist Deutsch (`de-DE`), Code/Kommentare/Identifier sind strikt Englisch.
8. **PowerShell 5.1 Kompatibilität:** Host-Shell nutzt ausschließlich Windows PowerShell 5.1 (`powershell.exe`).
9. **Git:** Niemals eigenmächtig `git commit` oder `git push` ausführen, es sei denn der Anwender weist dies explizit an.

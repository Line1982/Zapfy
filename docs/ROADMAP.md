# Zapfy Produkt-Roadmap ⛽⚡🚗

> Übersicht über beschlossene, plattformübergreifende Erweiterungen für die Zapfy Zero-Build PWA (**Android + iOS**).

---

## 1. 🛣️ Tank-Stopp auf meiner Route + Google-Maps-Übernahme & Zwischenstopp
- **Status:** 🚧 In Umsetzung (Thema 1)
- **Plattform:** Android & iOS (100 % Vanilla PWA)
- **Kernfunktionen:**
  - Ziel-Übernahme direkt aus Google Maps (Android `share_target`, iOS/Android 1-Tap Zwischenablage-Parser, optionaler iOS Apple-Kurzbefehl via `?dest=`, plus eigene Schnellziele & Adresssuche).
  - Echte Straßenroute über OSRM (`router.project-osrm.org` + Backup + Offline-Fallback) mit Rate-Limit-schonender Tankerkönig-Korridor-Abfrage (max. 3 Calls + 5-Minuten-Cache + Demo-Modus).
  - Geometrische Korridor-Projektion (`in X km voraus`, `+X,X km Umweg`) und Live-GPS-Fortschritts-Fusion mit automatischem Ausblenden bereits passierter Tankstellen.
  - Nahtloser Rückfall auf die Makro-Fahrtrichtungserkennung beim Beenden der Route oder Erreichen des Ziels.
  - **1-Tap Google Maps Zwischenstopp:** Übergibt Ziel + gewählte Tankstelle als `waypoints` direkt an Google Maps (und projiziert damit automatisch auf Android Auto & Apple CarPlay).

---

## 2. 🔊 Augenfreier „Sprach-Beifahrer“ über Auto-Audio
- **Status:** 📋 Geplant (Thema 2)
- **Plattform:** Android & iOS (Bluetooth, Android Auto Audio, Apple CarPlay Audio)
- **Kernfunktionen:**
  - Optionale Web Speech API (`speechSynthesis`, de-DE) während aktivem Drive-Mode oder aktiver Route.
  - Meldet sich nur bei echten Schnäppchen voraus (z. B. ≥ 4 ct unter Schnitt oder neuer Bestpreis entlang der Strecke, mit Anti-Spam-Cooldown pro Tankstelle).
  - Zero-Ablenkung ohne Blick aufs Display.

---

## 3. ⚡ „Tanken & Laden“ (`E10 / E5 / Diesel / ⚡ CCS`)
- **Status:** 📋 Geplant (Thema 3)
- **Plattform:** Android & iOS (100 % Vanilla PWA)
- **Kernfunktionen:**
  - Einheitliche Stations-Abstraktion (Tankstelle oder Schnellladepunkt).
  - Open Charge Map + persönliches 1–3-Ladekarten-/Ad-hoc-Tarifprofil (perspektivisch ergänzbar durch Mobilithek-AFIR-Collector für Live-Belegung & Ad-hoc-Preise).
  - Identische Smart-Umweg- und Google-Maps-Zwischenstopp-Logik für E-Autos und Hybride (oft 15–20 € Ersparnis pro Ladestopp neben der Autobahn).

# Zapfy ⛽📱

**Günstigste Tankstellen im Umkreis & entlang deiner Route · 1-Tap Google Maps Übergabe · Spar-Konto**

Zapfy ist eine schnelle, für die Nutzung im Auto optimierte Smartphone-PWA im **Shiftly 3D-Tactile-Design**. Beim Öffnen ermittelt die App deinen aktuellen GPS-Standort, holt die Echtzeit-Tankstellenpreise im Umkreis oder entlang einer geplanten Route ab, sortiert die besten Deals ganz nach oben und übergibt dein Ziel per 1-Tap direkt an Google Maps.

---

## ✨ Hauptfunktionen

1. **GPS-Umkreisradar, Route-Korridor & Smart-Ranking (Tab 1: `Preise`)**
   - Automatische GPS-Standortbestimmung beim Öffnen (`navigator.geolocation`) inkl. Drive-Mode-Nachführung und Fokus-Cockpit (**Drive-HUD**).
   - **Route-Korridor-Modus:** Ziel, Adresse, PLZ oder Google-Maps-Link einfügen und Tankstellen entlang der Strecke (mit ETA-Öffnungszeiten-Check) vergleichen.
   - Sofort-Umschaltung zwischen **Smart**, **Preis** und **Nähe** im unteren Daumen-Dock sowie Tag-/Nacht-Cockpit.
   - Die beste Option wird als **#1 Hero-Karte** hervorgehoben – inklusive Netto-Ersparnis nach Umwegkosten (`Smart-Umweg`), Vergleich mit deiner **Haus-und-Hof-Tankstelle** und `✓ Hier getankt` für dein Spar-Konto.

2. **1-Tap Google Maps Übergabe (Perfekt während aktiver Navigation)**
   - **🧭 Route starten:** Übergibt die exakten GPS-Koordinaten der Tankstelle direkt an die Google-Maps-App zur sofortigen Zielführung (`travelmode=driving`).
   - **📍 Pin:** Öffnet den Pin in Google Maps, um die Lage direkt neben deiner aktuellen Route zu prüfen oder als Zwischenstopp hinzuzufügen.

3. **Fahrzeugprofil, Spar-Konto & MTS-K (Tab 2: `Setup`)**
   - Konfiguration von Kraftstoff (**Super E10**, **Super E5**, **Diesel**), Tankgröße, Ø Verbrauch, Stamm-Tankstelle, Maps-Kurzlink-Resolver und Backup/Restore.
   - Integriertes **🏆 Mein Spar-Konto** mit Gesamtersparnis, Ø pro Tankstopp, Rückgängig-Funktion und Reset.
   - Unterstützt die offizielle, kostenlose **Tankerkönig API** (Echtzeit-Daten der Markttransparenzstelle für Kraftstoffe des Bundeskartellamts). Ohne API-Key läuft Zapfy automatisch im realistischen **Simulationsmodus**.

---

## 🚀 Lokaler Start & Installation auf dem Handy

Starte den lokalen Entwicklungsserver mit Python 3:

```bash
python dev_server.py
```

- **Am PC testen:** `http://localhost:8080`
- **Auf dem Handy:** Im WLAN die angezeigte LAN-IP öffnen oder per GitHub Pages (HTTPS) als Vollbild-PWA zum Home-Bildschirm hinzufügen.

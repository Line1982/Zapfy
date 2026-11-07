# Zapfy ⛽📱

**Günstigste Tankstellen im Umkreis · 1-Tap Google Maps Übergabe · Intelligente Preisprognose**

Zapfy ist eine schnelle, für die Nutzung im Auto optimierte Smartphone-PWA im **Shiftly 3D-Tactile-Design**. Beim Öffnen ermittelt die App deinen aktuellen GPS-Standort, holt die Echtzeit-Tankstellenpreise im Umkreis ab, sortiert die günstigsten Tankstellen ganz nach oben und übergibt dein Ziel per 1-Tap direkt an Google Maps.

---

## ✨ Hauptfunktionen

1. **GPS-Umkreisradar & Günstigste zuerst (Tab 1: `Preise`)**
   - Automatische GPS-Standortbestimmung beim Öffnen (`navigator.geolocation`).
   - Sofort-Umschaltung zwischen **Super E10**, **Super E5** und **Diesel** sowie Suchradius (**3 km, 5 km, 10 km, 15 km**).
   - Die günstigste geöffnete Tankstelle wird als **#1 Preis-Sieger** in Smaragdgrün ganz oben hervorgehoben – inklusive exakter Mehrkosten-Anzeige (`+4 ct (+2,00 €)`) bei allen teureren Stationen.

2. **1-Tap Google Maps Übergabe (Perfekt während aktiver Navigation)**
   - **🧭 Route starten (Maps):** Übergibt die exakten GPS-Koordinaten der Tankstelle direkt an die Google-Maps-App zur sofortigen Zielführung (`travelmode=driving`).
   - **📍 Pin:** Öffnet den Pin in Google Maps, um die Lage direkt neben deiner aktuellen Route zu prüfen oder als Zwischenstopp hinzuzufügen.

3. **Statistische Erfassung & Tageszeit-/Wochentags-Prognose (Tab 2: `Prognose`)**
   - Speichert bei jedem App-Öffnen automatisch Preis-Snapshots in `IndexedDB` (`navigator.storage.persist()`).
   - Kombiniert deine lokal gesammelten Preisdaten mit der deutschen **MTS-K Tageszeitkurve** und zeigt dir sofort:
     - **🔥 Jetzt tanken!** (z. B. im Abend-Tiefpreisfenster 18:00–20:30 Uhr oder unter deinem historischen Schnitt)
     - **⏳ Besser warten!** (z. B. während der morgendlichen Preisspitze mit konkreter €-Ersparnis-Prognose für den Abend)

4. **Offizielle MTS-K Datenqualität (Tankerkönig API) + Sofort-Demomodus (Tab 3: `Setup`)**
   - Unterstützt die offizielle, kostenlose **Tankerkönig API** (Echtzeit-Daten der Markttransparenzstelle für Kraftstoffe des Bundeskartellamts).
   - Solange noch kein API-Key eingetragen ist, läuft Zapfy automatisch im realistischen **Simulationsmodus**, sodass alle Funktionen sofort getestet werden können.

---

## 🚀 Lokaler Start & Installation auf dem Handy

Starte den lokalen Entwicklungsserver mit Python 3:

```bash
python dev_server.py
```

- **Am PC testen:** `http://localhost:8080`
- **Auf dem Handy:** Im WLAN die angezeigte LAN-IP öffnen oder per GitHub Pages (HTTPS) als Vollbild-PWA zum Home-Bildschirm hinzufügen.

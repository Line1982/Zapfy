# Systemarchitektur · Zapfy ⛽📱

> **Zweck dieses Dokuments:** Beschreibt die Systemarchitektur, Datenflüsse und das Auto-optimierte UX-Konzept von *Zapfy*.
> 💡 *Für gezielte Code-Navigation:* Siehe [`docs/AI_INDEX.md`](file:///d:/Dev/Zapfy/docs/AI_INDEX.md).

---

## 1. Architektur-Prinzipien & Philosophie

1. **Zero-Build Vanilla PWA (Shiftly Design-DNA):**
   - Reines modernes Vanilla JavaScript (ES6+ Modules), HTML5 und CSS3 ohne Build-Pipeline.
   - 3D Tactile Depth Design (`100dvh` Single-Screen App-Shell, Swipe-Tabs, mehrschichtige Schatten und vertiefte Wells).

2. **Offizielle MTS-K Datenqualität (Tankerkönig API) + Simulations-Fallback:**
   - Nutzt die offizielle Creative-Commons-Schnittstelle von **Tankerkönig** (Markttransparenzstelle für Kraftstoffe des Bundeskartellamts) für Echtzeit-Preise in Deutschland.
   - Integrierter **Demo-/Simulationsmodus** auf Basis der realen MTS-K Tageszeitkurve, damit die App sofort ohne API-Key getestet werden kann.

3. **Auto-optimierte 1-Tap Google Maps Übergabe:**
   - Bewusster Verzicht auf eine fummelige eingebettete Zweitkarte.
   - Stattdessen stehen die günstigsten Tankstellen mit riesiger Preisanzeige (`1,68⁹ €`) ganz oben und bieten zwei direkte Google-Maps-Aktionen:
     - `🧭 Route starten (Maps)`: Startet sofort die Turn-by-Turn-Navigation (`google.com/maps/dir/?api=1&destination=lat,lng&travelmode=driving`).
     - `📍 Pin`: Öffnet den exakten Pin in Google Maps, um die Lage relativ zur aktiven Route zu prüfen oder als Zwischenstopp einzufügen.

4. **Lokale Langzeit-Statistik & Preisprognose (`IndexedDB`):**
   - Bei jedem Öffnen und Aktualisieren speichert Zapfy automatisch die aktuellen Stationspreise (in 20-Minuten-Buckets dedupliziert) lokal auf dem Gerät.
   - Kombiniert die eigenen Messwerte mit dem MTS-K Tageszeitmodell zu einer klaren Empfehlung (`🔥 Jetzt tanken!` vs. `⏳ Besser bis 18–20 Uhr warten`).

5. **Priorisierte Sortierung & Ruhige Statusanzeige:**
   - **Platz 0 (Ganz oben):** Die blau markierte **Smart-Umweg-Karte** (falls sich 1–4 km Weiterfahrt nach Spritkosten-Abzug netto rentiert) steht immer an oberster Stelle.
   - **Plätze 1..N:** Danach folgen ausnahmslos alle Tankstellen (offen wie geschlossen) strikt sortiert von der **günstigsten zur teuersten**.
   - **Ruhige Öffnungszeiten:** Dezent in der Meta-Zeile als `● Offen (24h)`, `● Bis 22:00` bzw. `○ Öffnet 08:00` / `○ Geschlossen`. Beim Antippen einer Karte wird die Öffnungszeit frisch von der API geladen und 7 Tage lokal im IndexedDB-Cache persistiert.

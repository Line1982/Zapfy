# Datenmodell & IndexedDB Schema · Zapfy 🗄️⛽

Zapfy speichert alle Daten lokal im Browser über `IndexedDB` (`zapfy_db`, Version `2`) mit aktivem `navigator.storage.persist()`-Schutz.

---

## 1. Object Stores

### 1.1 `price_snapshots` (`keyPath: 'id'`, Legacy)
Historischer Object Store aus v1/v2.2 (bleibt aus Schema-Kompatibilität in IndexedDB Version `2` erhalten, wird ab v2.3 nicht mehr aktiv beschrieben oder exportiert).

### 1.2 `station_details` (`keyPath: 'id'`)
Zwischenspeicher für exakte Öffnungszeiten einzelner Tankstellen (7 Tage Auto-Refresh TTL):
- `id`, `wholeDay`, `openingLabel`, `closingLabel`, `openingTimes`, `fetched_at`, `updated_iso`

### 1.3 `favorites` (`keyPath: 'id'`)
Gespeicherte Lieblingstankstellen (`★`):
- `id`, `name`, `brand`, `street`, `houseNumber`, `postCode`, `place`, `lat`, `lng`, `added_at`

### 1.4 `settings` (`keyPath: 'key'`)
Benutzereinstellungen (JSON-Backup-Format `version: 2` exportiert `favorites` & `settings`; `apiKey` wird aus Datenschutzgründen niemals mitexportiert, ältere `version: 1`-Backups bleiben beim Import kompatibel):
- `apiKey`: Persönlicher Tankerkönig API-Key (String, nur lokal gespeichert)
- `demoMode`: Simulationsmodus erzwingen (`true`/`false`)
- `tankVolume`: Tankgröße in Litern (Standard: `50`)
- `consumption`: Ø Kraftstoffverbrauch in L/100km für den Smart-Umweg-Rechner (Standard: `7.0`)
- `defaultFuel`: Standard-Kraftstoffsorte (`"e10"`, `"e5"`, `"diesel"`)
- `radiusKm`: Suchradius in km (`3`, `5`, `10`, `15`)
- `fallbackRegion`: `"lat,lng"` Fallback-Koordinaten, falls GPS im Browser deaktiviert ist
- `themeMode`: Cockpit-Farbschema (`"auto"`, `"dark"`, `"light"`)
- `savingsTotal`: Kumulierte bestätigte Ersparnis in Euro (z. B. `28.40`)
- `fillCount`: Anzahl verbuchter Tankvorgänge (`✓ Hier getankt`)
- `homeStation`: Gespeicherte Haus-und-Hof-Tankstelle für den Unterwegs-Vergleich (`{ id, name, brand, street, houseNumber, postCode, place, lat, lng, set_at }` oder `null`)

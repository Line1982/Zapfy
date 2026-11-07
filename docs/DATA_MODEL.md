# Datenmodell & IndexedDB Schema · Zapfy 🗄️⛽

Zapfy speichert alle Daten lokal im Browser über `IndexedDB` (`zapfy_db`, Version `2`) mit aktivem `navigator.storage.persist()`-Schutz.

---

## 1. Object Stores

### 1.1 `price_snapshots` (`keyPath: 'id'`)
Speichert historische Preisbeobachtungen (automatisch bei jedem App-Abruf erfasst, dedupliziert auf 20-Minuten-Zeitfenster pro Station):
- `id`: `"snap_<station_id>_<bucket20m>"`
- `station_id`: UUID der Tankstelle
- `station_name`: Markenname / Bezeichnung (z. B. `"JET"`)
- `place`: Ort
- `timestamp`: ISO-8601 Zeitstempel
- `date`: `"YYYY-MM-DD"` (lokales Kalenderdatum)
- `hour`: Stunde `0..23` (Index `hour`)
- `weekday`: ISO-Wochentag `1..7` (Mo=1 .. So=7, Index `weekday`)
- `e10`, `e5`, `diesel`: Preis in Euro (z. B. `1.689`)
- `dist`: Entfernung in km zum Abrufzeitpunkt

### 1.2 `station_details` (`keyPath: 'id'`)
Zwischenspeicher für exakte Öffnungszeiten einzelner Tankstellen (7 Tage Auto-Refresh TTL):
- `id`, `wholeDay`, `openingLabel`, `closingLabel`, `openingTimes`, `fetched_at`, `updated_iso`

### 1.3 `favorites` (`keyPath: 'id'`)
Gespeicherte Lieblingstankstellen (`★`):
- `id`, `name`, `brand`, `street`, `houseNumber`, `postCode`, `place`, `lat`, `lng`, `added_at`

### 1.4 `settings` (`keyPath: 'key'`)
Benutzereinstellungen (Hinweis: `apiKey` wird bei JSON-Backups aus Datenschutzgründen niemals mitexportiert):
- `apiKey`: Persönlicher Tankerkönig API-Key (String, nur lokal gespeichert)
- `demoMode`: Simulationsmodus erzwingen (`true`/`false`)
- `tankVolume`: Tankgröße in Litern (Standard: `50`)
- `defaultFuel`: Standard-Kraftstoffsorte (`"e10"`, `"e5"`, `"diesel"`)
- `radiusKm`: Suchradius in km (`3`, `5`, `10`, `15`)
- `fallbackRegion`: `"lat,lng"` Fallback-Koordinaten, falls GPS im Browser deaktiviert ist

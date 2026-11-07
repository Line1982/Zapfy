/**
 * Zapfy IndexedDB Layer (js/db.js)
 * Standalone browser database with transaction safety and persistence guarantee.
 * Stores price snapshots for statistics/forecasting, favorite stations, and user settings.
 */

const DB_NAME = 'zapfy_db';
const DB_VERSION = 2;
const STATION_DETAIL_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days auto-refresh for opening hours

class ZapfyDB {
  constructor() {
    this.db = null;
  }

  async init() {
    if (this.db) return this.db;

    if (navigator.storage && navigator.storage.persist) {
      try {
        const isPersisted = await navigator.storage.persist();
        console.info(`Zapfy Storage Persisted: ${isPersisted}`);
      } catch (err) {
        console.warn('Storage persistence request failed:', err);
      }
    }

    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;

        // Store for historical price snapshots (used for statistics & forecasting)
        if (!db.objectStoreNames.contains('price_snapshots')) {
          const snapStore = db.createObjectStore('price_snapshots', { keyPath: 'id' });
          snapStore.createIndex('timestamp', 'timestamp', { unique: false });
          snapStore.createIndex('station_id', 'station_id', { unique: false });
          snapStore.createIndex('hour', 'hour', { unique: false });
          snapStore.createIndex('weekday', 'weekday', { unique: false });
        }

        // Store for cached station details / opening hours (auto-refreshed every 7 days)
        if (!db.objectStoreNames.contains('station_details')) {
          db.createObjectStore('station_details', { keyPath: 'id' });
        }

        // Store for favorite / pinned stations
        if (!db.objectStoreNames.contains('favorites')) {
          db.createObjectStore('favorites', { keyPath: 'id' });
        }

        // Store for app settings
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };

      req.onsuccess = (e) => {
        this.db = e.target.result;
        resolve(this.db);
      };

      req.onerror = (e) => {
        console.error('IndexedDB open error:', e);
        reject(e.target.error);
      };
    });
  }

  // --- Price Snapshots CRUD ---

  async getAllSnapshots() {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('price_snapshots', 'readonly');
      const store = tx.objectStore('price_snapshots');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Saves a batch of station price snapshots from a live API or demo fetch.
   * Deduplicates snapshots within the same 20-minute bucket per station so frequent
   * refreshes don't skew hourly averages.
   */
  async saveSnapshotsBatch(stations, now = new Date()) {
    await this.init();
    if (!Array.isArray(stations) || stations.length === 0) return 0;

    const bucket20m = Math.floor(now.getTime() / (20 * 60 * 1000));
    const isoTimestamp = now.toISOString();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const hour = now.getHours();
    // Convert JS getDay() (0=Sun..6=Sat) to ISO weekday (1=Mon..7=Sun)
    const weekday = now.getDay() === 0 ? 7 : now.getDay();

    const tx = this.db.transaction('price_snapshots', 'readwrite');
    const store = tx.objectStore('price_snapshots');
    let savedCount = 0;

    for (const st of stations) {
      if (!st.isOpen) continue;
      if (typeof st.e5 !== 'number' && typeof st.e10 !== 'number' && typeof st.diesel !== 'number') {
        continue;
      }

      const id = `snap_${st.id}_${bucket20m}`;
      const record = {
        id,
        station_id: st.id,
        station_name: st.brand || st.name || 'Tankstelle',
        place: st.place || '',
        street: st.street || '',
        houseNumber: st.houseNumber || '',
        lat: typeof st.lat === 'number' ? st.lat : null,
        lng: typeof st.lng === 'number' ? st.lng : null,
        timestamp: isoTimestamp,
        date: dateStr,
        hour,
        weekday,
        e5: typeof st.e5 === 'number' ? st.e5 : null,
        e10: typeof st.e10 === 'number' ? st.e10 : null,
        diesel: typeof st.diesel === 'number' ? st.diesel : null,
        dist: typeof st.dist === 'number' ? st.dist : null
      };

      store.put(record);
      savedCount++;
    }

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(savedCount);
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Saves an array of pre-built historical snapshot records (e.g., 14-day history backfill)
   * in a single IndexedDB transaction without overwriting existing live measurements.
   */
  async saveHistoricalRecordsBatch(records) {
    await this.init();
    if (!Array.isArray(records) || records.length === 0) return 0;

    const tx = this.db.transaction('price_snapshots', 'readwrite');
    const store = tx.objectStore('price_snapshots');
    let count = 0;

    for (const rec of records) {
      if (!rec || !rec.id) continue;
      store.put(rec);
      count++;
    }

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(count);
      tx.onerror = () => reject(tx.error);
    });
  }

  async clearAllSnapshots() {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('price_snapshots', 'readwrite');
      const store = tx.objectStore('price_snapshots');
      const req = store.clear();
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  // --- Station Details (Opening Hours Cache with 7-Day Auto-Update TTL) ---

  async getAllStationDetailsMap() {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('station_details', 'readonly');
      const store = tx.objectStore('station_details');
      const req = store.getAll();
      req.onsuccess = () => {
        const map = new Map();
        const now = Date.now();
        for (const item of req.result || []) {
          const isStale = !item.fetched_at || (now - item.fetched_at > STATION_DETAIL_TTL_MS);
          map.set(item.id, { ...item, isStale });
        }
        resolve(map);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async saveStationDetail(detailRecord) {
    await this.init();
    if (!detailRecord || !detailRecord.id) return null;
    const record = {
      ...detailRecord,
      fetched_at: Date.now(),
      updated_iso: new Date().toISOString()
    };

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('station_details', 'readwrite');
      const store = tx.objectStore('station_details');
      const req = store.put(record);
      req.onsuccess = () => resolve(record);
      req.onerror = () => reject(req.error);
    });
  }

  // --- Favorites CRUD ---

  async getFavorites() {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('favorites', 'readonly');
      const store = tx.objectStore('favorites');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async toggleFavorite(station) {
    await this.init();
    const favs = await this.getFavorites();
    const exists = favs.some(f => f.id === station.id);

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('favorites', 'readwrite');
      const store = tx.objectStore('favorites');

      if (exists) {
        const req = store.delete(station.id);
        req.onsuccess = () => resolve(false);
        req.onerror = () => reject(req.error);
      } else {
        const favRecord = {
          id: station.id,
          name: station.name,
          brand: station.brand,
          street: station.street,
          houseNumber: station.houseNumber,
          postCode: station.postCode,
          place: station.place,
          lat: station.lat,
          lng: station.lng,
          added_at: new Date().toISOString()
        };
        const req = store.put(favRecord);
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
      }
    });
  }

  // --- Settings CRUD ---

  async getSetting(key, defaultValue = null) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('settings', 'readonly');
      const store = tx.objectStore('settings');
      const req = store.get(key);
      req.onsuccess = () => {
        if (req.result && req.result.value !== undefined) {
          resolve(req.result.value);
        } else {
          resolve(defaultValue);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  async setSetting(key, value) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('settings', 'readwrite');
      const store = tx.objectStore('settings');
      const req = store.put({ key, value, updated_at: new Date().toISOString() });
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  // --- Backup / Restore Core ---

  async exportAllData() {
    await this.init();
    const snapshots = await this.getAllSnapshots();
    const favorites = await this.getFavorites();
    const allSettings = await new Promise((resolve, reject) => {
      const tx = this.db.transaction('settings', 'readonly');
      const store = tx.objectStore('settings');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });

    // Exclude personal API key from exported backup files to prevent accidental credential leaks
    const settings = allSettings.filter((s) => s && s.key !== 'apiKey');

    return {
      version: 1,
      exported_at: new Date().toISOString(),
      app: 'Zapfy',
      snapshots,
      favorites,
      settings
    };
  }

  async importAllData(payload) {
    await this.init();
    if (!payload || !Array.isArray(payload.snapshots)) {
      throw new Error('Ungültiges Backup-Format: Keine Zapfy-Preisdaten gefunden.');
    }

    const tx = this.db.transaction(['price_snapshots', 'favorites', 'settings'], 'readwrite');
    const snapStore = tx.objectStore('price_snapshots');
    const favStore = tx.objectStore('favorites');
    const settingStore = tx.objectStore('settings');

    snapStore.clear();
    for (const s of payload.snapshots) {
      if (s && s.id) snapStore.put(s);
    }

    if (Array.isArray(payload.favorites)) {
      favStore.clear();
      for (const f of payload.favorites) {
        if (f && f.id) favStore.put(f);
      }
    }

    if (Array.isArray(payload.settings)) {
      for (const st of payload.settings) {
        if (!st || !st.key) continue;
        // Never overwrite an existing local API key with an empty value
        if (st.key === 'apiKey' && !String(st.value || '').trim()) continue;
        settingStore.put(st);
      }
    }

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }
}

export const db = new ZapfyDB();

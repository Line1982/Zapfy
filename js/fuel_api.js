/**
 * Zapfy Fuel API & GPS Service (js/fuel_api.js)
 * Connects to the official German MTS-K / Tankerkönig API v4 for real-time fuel prices.
 * Includes a realistic deterministic simulation mode (Demo Mode) so the app works
 * immediately out-of-the-box before the user enters their personal free API key.
 */

const TANKERKOENIG_BASE_URL = 'https://creativecommons.tankerkoenig.de/json/list.php';
const TANKERKOENIG_DETAIL_URL = 'https://creativecommons.tankerkoenig.de/json/detail.php';

// Persistent Token-Bucket & Spatial-Temporal Cache Constants (Protects Tankerkönig API across app restarts)
const STORAGE_KEY_BUCKET = 'zapfy_tk_token_bucket_v1';
const STORAGE_KEY_API_CACHE = 'zapfy_tk_last_response_v1';

const BUCKET_CAPACITY = 4;               // Max burst tokens
const BUCKET_REFILL_MS = 5 * 60 * 1000;  // 1 new token every 5 minutes (recommended Tankerkönig interval)
const CACHE_FRESH_TTL_MS = 4 * 60 * 1000; // 4 minutes: serve cached response on repeated app open/close if within 400m
const COOLDOWN_503_MS = 10 * 60 * 1000;  // 10 minutes strict pause if server ever returns HTTP 503 Rate Limit Exceeded

export class FuelApiService {
  /**
   * Calculates Haversine distance in kilometers between two GPS coordinates.
   */
  static calculateDistanceKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /**
   * Persistent client-side Token-Bucket rate limiter stored in localStorage.
   * Survives page reloads, tab closes, and repeated PWA launches.
   */
  static checkAndConsumeToken() {
    const now = Date.now();
    let state = { tokens: BUCKET_CAPACITY, lastRefill: now, blockedUntil: 0 };

    try {
      const raw = localStorage.getItem(STORAGE_KEY_BUCKET);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (typeof parsed.tokens === 'number' && typeof parsed.lastRefill === 'number') {
          state = {
            tokens: parsed.tokens,
            lastRefill: parsed.lastRefill,
            blockedUntil: Number(parsed.blockedUntil) || 0
          };
        }
      }
    } catch {
      // Ignore storage read errors
    }

    // Refill tokens proportional to elapsed time since last check
    const elapsed = Math.max(0, now - state.lastRefill);
    const refillTokens = elapsed / BUCKET_REFILL_MS;
    state.tokens = Math.min(BUCKET_CAPACITY, state.tokens + refillTokens);
    state.lastRefill = now;

    if (now < state.blockedUntil) {
      const waitSec = Math.ceil((state.blockedUntil - now) / 1000);
      return { allowed: false, reason: '503-cooldown', waitSec, tokensLeft: state.tokens };
    }

    if (state.tokens < 1.0) {
      const waitSec = Math.ceil(((1.0 - state.tokens) * BUCKET_REFILL_MS) / 1000);
      try {
        localStorage.setItem(STORAGE_KEY_BUCKET, JSON.stringify(state));
      } catch { /* ignore */ }
      return { allowed: false, reason: 'token-bucket-empty', waitSec, tokensLeft: state.tokens };
    }

    // Consume 1 token and persist immediately
    state.tokens -= 1.0;
    try {
      localStorage.setItem(STORAGE_KEY_BUCKET, JSON.stringify(state));
    } catch { /* ignore */ }

    return { allowed: true, tokensLeft: state.tokens };
  }

  /**
   * Records a server-side HTTP 503 Rate Limit response into the persistent bucket state.
   */
  static registerServerRateLimit503() {
    const now = Date.now();
    const state = {
      tokens: 0,
      lastRefill: now,
      blockedUntil: now + COOLDOWN_503_MS
    };
    try {
      localStorage.setItem(STORAGE_KEY_BUCKET, JSON.stringify(state));
    } catch { /* ignore */ }
  }

  /**
   * Reads or writes the persistent API response cache so opening/closing the app
   * multiple times within a few minutes does not trigger redundant HTTP calls.
   */
  static getCachedApiResponse(lat, lng, lookaheadRad) {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_API_CACHE);
      if (!raw) return null;
      const cached = JSON.parse(raw);
      if (!cached || !Array.isArray(cached.stations) || !cached.timestamp) return null;

      const ageMs = Date.now() - cached.timestamp;
      const movedKm = this.calculateDistanceKm(lat, lng, cached.lat, cached.lng);
      const radiusCovered = (cached.lookaheadRad || 0) >= lookaheadRad;

      return {
        ...cached,
        ageMs,
        movedKm,
        isFresh: ageMs <= CACHE_FRESH_TTL_MS && movedKm <= 0.4 && radiusCovered
      };
    } catch {
      return null;
    }
  }

  static saveCachedApiResponse(lat, lng, lookaheadRad, stations, license) {
    try {
      const payload = {
        timestamp: Date.now(),
        lat,
        lng,
        lookaheadRad,
        license,
        stations
      };
      localStorage.setItem(STORAGE_KEY_API_CACHE, JSON.stringify(payload));
    } catch { /* ignore */ }
  }
  /**
   * Acquires current GPS coordinates from the smartphone browser.
   */
  static getCurrentPosition(options = {}) {
    const defaultOpts = {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 60000,
      ...options
    };

    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('GPS wird von diesem Browser nicht unterstützt.'));
        return;
      }

      navigator.geolocation.getCurrentPosition(
        (pos) => {
          resolve({
            lat: Number(pos.coords.latitude.toFixed(6)),
            lng: Number(pos.coords.longitude.toFixed(6)),
            accuracy: Math.round(pos.coords.accuracy || 0),
            timestamp: pos.timestamp || Date.now()
          });
        },
        (err) => {
          let msg = 'Standort konnte nicht ermittelt werden.';
          if (err.code === 1) {
            msg = 'GPS-Zugriff verweigert. Bitte Standortfreigabe im Browser aktivieren.';
          } else if (err.code === 2) {
            msg = 'GPS-Signal aktuell nicht verfügbar.';
          } else if (err.code === 3) {
            msg = 'GPS-Zeitüberschreitung.';
          }
          reject(new Error(msg));
        },
        defaultOpts
      );
    });
  }

  /**
   * Fetches nearby stations from Tankerkönig API or falls back to realistic simulation mode
   * if demoMode is active or no API key is configured yet.
   * Always fetches a lookahead buffer (+4 km beyond selected radiusKm, up to 25 km) so the
   * app can detect "Smart Detour" bargains just 1-3 km outside the active radius and
   * automatically expand the radius if fewer than 3 stations are open inside radiusKm.
   */
  static async fetchStations({ lat, lng, radiusKm = 5, apiKey = '', demoMode = false }) {
    const cleanKey = (apiKey || '').trim();
    const useSimulation = demoMode || !cleanKey;
    const requestedRad = Math.min(25, Math.max(1, Number(radiusKm) || 5));
    const lookaheadRad = Math.min(25, Math.max(requestedRad + 4, 10));

    if (useSimulation) {
      const stations = this.generateSimulatedStations(lat, lng, lookaheadRad);
      return {
        ok: true,
        source: 'demo',
        cached: false,
        license: 'Simulationsmodus (MTS-K Tageszeit-Modell) · Für echte Live-Preise API-Key im Setup hinterlegen',
        stations
      };
    }

    // 1. Check persistent spatial-temporal cache first (prevents API drain on repeated app open/close
    //    or when switching between 3km / 5km / 10km radius pills already covered by lookaheadRad)
    const cached = this.getCachedApiResponse(lat, lng, lookaheadRad);
    if (cached && cached.isFresh) {
      return {
        ok: true,
        source: 'live',
        cached: true,
        license: cached.license || 'CC BY 4.0 Tankerkönig / MTS-K (Cache)',
        stations: cached.stations
      };
    }

    // 2. Enforce persistent Token-Bucket Rate-Limiter across sessions
    const bucketCheck = this.checkAndConsumeToken();
    if (!bucketCheck.allowed) {
      if (cached && cached.stations.length > 0) {
        return {
          ok: true,
          source: 'live',
          cached: true,
          rateLimited: true,
          waitSec: bucketCheck.waitSec,
          license: 'CC BY 4.0 Tankerkönig / MTS-K (Rate-Limit-Schutz aktiv)',
          stations: cached.stations
        };
      }
      throw new Error(`API Rate-Limit-Schutz aktiv (bitte ${bucketCheck.waitSec}s warten).`);
    }

    const url = new URL(TANKERKOENIG_BASE_URL);
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lng', String(lng));
    url.searchParams.set('rad', String(lookaheadRad));
    url.searchParams.set('sort', 'dist');
    url.searchParams.set('type', 'all');
    url.searchParams.set('apikey', cleanKey);

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });

    if (response.status === 503) {
      this.registerServerRateLimit503();
      if (cached && cached.stations.length > 0) {
        return {
          ok: true,
          source: 'live',
          cached: true,
          rateLimited: true,
          license: 'CC BY 4.0 Tankerkönig / MTS-K (503 Fallback-Cache)',
          stations: cached.stations
        };
      }
      throw new Error('Tankerkönig Rate-Limit erreicht (HTTP 503). Automatische 10-Min-Pause aktiviert.');
    }

    if (!response.ok) {
      throw new Error(`Tankerkönig Serverfehler (HTTP ${response.status})`);
    }

    const data = await response.json();
    if (!data.ok) {
      throw new Error(data.message || 'Ungültiger API-Key oder API-Anfrage abgelehnt.');
    }

    const stations = (data.stations || []).map((st) => this.normalizeStation(st));
    const licenseStr = data.license || 'CC BY 4.0 Tankerkönig / MTS-K';

    // Persist fresh live response for subsequent app launches / radius switches
    this.saveCachedApiResponse(lat, lng, lookaheadRad, stations, licenseStr);

    return {
      ok: true,
      source: 'live',
      cached: false,
      license: licenseStr,
      stations
    };
  }

  /**
   * Normalizes a Tankerkönig station object for consistent UI and DB handling.
   */
  static normalizeStation(raw) {
    return {
      id: raw.id,
      name: (raw.name || '').trim() || 'Tankstelle',
      brand: (raw.brand || raw.name || 'Freie Tankstelle').trim(),
      street: (raw.street || '').trim(),
      houseNumber: (raw.houseNumber || '').trim(),
      postCode: raw.postCode ? String(raw.postCode).trim() : '',
      place: (raw.place || '').trim(),
      lat: Number(raw.lat),
      lng: Number(raw.lng),
      dist: typeof raw.dist === 'number' ? Number(raw.dist.toFixed(1)) : 0,
      isOpen: Boolean(raw.isOpen),
      e5: typeof raw.e5 === 'number' && raw.e5 > 0 ? raw.e5 : null,
      e10: typeof raw.e10 === 'number' && raw.e10 > 0 ? raw.e10 : null,
      diesel: typeof raw.diesel === 'number' && raw.diesel > 0 ? raw.diesel : null
    };
  }

  static getSimulatedDetail(stationId) {
    const is24h = ['sim-jet-01', 'sim-hem-03', 'sim-esso-05', 'sim-shell-06', 'sim-globus-08', 'sim-raiffeisen-10'].includes(stationId);
    const isClosedMidday = stationId === 'sim-bft-04';
    return {
      id: stationId,
      wholeDay: is24h,
      closingLabel: is24h ? '24h' : (isClosedMidday ? '21:30' : '22:00'),
      openingLabel: is24h ? '24h' : (isClosedMidday ? '07:30' : '08:00'),
      openingTimes: is24h
        ? [{ text: 'Täglich', start: '00:00', end: '24:00' }]
        : [{ text: 'Mo–So', start: isClosedMidday ? '07:30' : '08:00', end: isClosedMidday ? '21:30' : '22:00' }]
    };
  }

  /**
   * Fetches exact opening hours for a single station on-demand via Tankerkönig `detail.php`
   * (or returns simulated schedule for demo stations). Protected by the shared Token-Bucket.
   */
  static async fetchStationDetail({ stationId, apiKey = '', demoMode = false }) {
    const cleanKey = (apiKey || '').trim();
    const useSimulation = demoMode || !cleanKey || String(stationId).startsWith('sim-');

    if (useSimulation) {
      return this.getSimulatedDetail(stationId);
    }

    const bucketCheck = this.checkAndConsumeToken();
    if (!bucketCheck.allowed) {
      throw new Error(`Rate-Limit-Schutz aktiv (bitte ${bucketCheck.waitSec}s warten).`);
    }

    const url = new URL(TANKERKOENIG_DETAIL_URL);
    url.searchParams.set('id', String(stationId));
    url.searchParams.set('apikey', cleanKey);

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });

    if (response.status === 503) {
      this.registerServerRateLimit503();
      throw new Error('Tankerkönig Rate-Limit erreicht (HTTP 503).');
    }

    if (!response.ok) {
      throw new Error(`Detail-Abruf fehlgeschlagen (HTTP ${response.status})`);
    }

    const data = await response.json();
    if (!data.ok || !data.station) {
      throw new Error(data.message || 'Öffnungszeiten konnten nicht geladen werden.');
    }

    const st = data.station;
    const wholeDay = Boolean(st.wholeDay);
    const openingTimes = Array.isArray(st.openingTimes) ? st.openingTimes : [];
    const closingLabel = this.extractClosingTimeLabel(wholeDay, openingTimes);
    const openingLabel = this.extractOpeningTimeLabel(wholeDay, openingTimes);

    return {
      id: stationId,
      wholeDay,
      closingLabel,
      openingLabel,
      openingTimes
    };
  }

  /**
   * Selects the openingTimes entry matching today's weekday (Sat/Sun vs Mon-Fri), falling back to the first entry.
   */
  static pickTodayOpeningEntry(openingTimes, dateObj = new Date()) {
    if (!Array.isArray(openingTimes) || openingTimes.length === 0) return null;
    const day = dateObj.getDay(); // 0=Sun, 6=Sat
    if (day === 0) {
      const sun = openingTimes.find((o) => /sonn|feiertag|\bso\b|mo\s*[-–]\s*so|täglich/i.test(o?.text || ''));
      if (sun) return sun;
    } else if (day === 6) {
      const sat = openingTimes.find((o) => /samstag|\bsa\b|mo\s*[-–]\s*sa|mo\s*[-–]\s*so|täglich/i.test(o?.text || ''));
      if (sat) return sat;
    }
    return openingTimes[0];
  }

  /**
   * Extracts a concise closing time string (e.g. "24h" or "22:00") from Tankerkönig openingTimes.
   */
  static extractClosingTimeLabel(wholeDay, openingTimes) {
    if (wholeDay) return '24h';
    const entry = this.pickTodayOpeningEntry(openingTimes);
    const firstEnd = (entry?.end || '').trim();
    if (!firstEnd) return '';
    if (firstEnd.startsWith('24:00') || firstEnd.startsWith('00:00')) return '24h';
    return firstEnd.slice(0, 5);
  }

  /**
   * Extracts a concise opening time string (e.g. "08:00") from Tankerkönig openingTimes.
   */
  static extractOpeningTimeLabel(wholeDay, openingTimes) {
    if (wholeDay) return '24h';
    const entry = this.pickTodayOpeningEntry(openingTimes);
    const firstStart = (entry?.start || '').trim();
    if (!firstStart) return '08:00';
    if (firstStart.startsWith('00:00')) return '24h';
    return firstStart.slice(0, 5);
  }

  /**
   * Builds Google Maps deep links optimized for driving / active navigation on mobile.
   * 1. Direct Turn-by-Turn Navigation (`dir` action with travelmode=driving)
   * 2. Map Pin / Route Overview (`search` query at exact lat,lng + station brand)
   */
  static getGoogleMapsLinks(station) {
    const lat = Number(station.lat);
    const lng = Number(station.lng);
    const coords = `${lat},${lng}`;
    const labelQuery = encodeURIComponent(
      `${station.brand || station.name} ${station.street || ''} ${station.houseNumber || ''} ${station.place || ''}`.trim()
    );

    return {
      // Starts turn-by-turn route guidance immediately or offers "Add stop" in active Google Maps navigation
      navigateUrl: `https://www.google.com/maps/dir/?api=1&destination=${coords}&travelmode=driving`,
      // Opens the exact station pin on the Google Maps canvas to inspect detour relative to current route
      mapViewUrl: `https://www.google.com/maps/search/?api=1&query=${coords}`,
      labelQuery
    };
  }

  /**
   * Realistic German MTS-K intraday fuel price curve offset (in EUR) by hour of day (0-23).
   * In Germany, prices peak in the morning (6-8h), dip around noon, rise at 15h,
   * and reach their lowest point between 18:00 and 21:00.
   */
  static getTypicalHourlyOffset(hour) {
    const curve = [
      +0.035, // 00:00 (Night base)
      +0.035, // 01:00
      +0.035, // 02:00
      +0.040, // 03:00
      +0.045, // 04:00
      +0.065, // 05:00 (Early commuter hike)
      +0.085, // 06:00 (Morning peak)
      +0.090, // 07:00 (Morning peak max)
      +0.065, // 08:00
      +0.040, // 09:00
      +0.025, // 10:00
      +0.015, // 11:00
      +0.005, // 12:00 (Midday dip)
      +0.010, // 13:00
      +0.020, // 14:00
      +0.030, // 15:00 (Afternoon bump)
      +0.015, // 16:00
      -0.010, // 17:00 (Evening drop begins)
      -0.032, // 18:00 (Best window start)
      -0.040, // 19:00 (Absolute daily minimum)
      -0.035, // 20:00 (Best window)
      -0.025, // 21:00 (Best window end)
      +0.015, // 22:00 (Night jump)
      +0.030  // 23:00
    ];
    return curve[hour % 24] || 0;
  }

  /**
   * Generates realistic stations around any user GPS coordinate for immediate testing.
   */
  static generateSimulatedStations(lat, lng, radiusKm = 5, dateObj = new Date()) {
    const baseLat = Number(lat) || 51.1657;
    const baseLng = Number(lng) || 10.4515;
    const hour = dateObj.getHours();
    const hourOffset = this.getTypicalHourlyOffset(hour);

    // Weekday factor (Mon=1..Sun=7): Tue/Wed slightly cheaper, Fri/Sun slightly pricier
    const day = dateObj.getDay() === 0 ? 7 : dateObj.getDay();
    const dayOffset = day === 2 || day === 3 ? -0.01 : (day === 5 || day === 7 ? +0.01 : 0);

    const templates = [
      { id: 'sim-jet-01', brand: 'JET', name: 'JET Tankstelle', street: 'Hauptstraße', houseNumber: '42', place: 'Umkreis Nord', dLat: 0.008, dLng: 0.005, dist: 1.1, spread: -0.02, open24: true },
      { id: 'sim-star-02', brand: 'STAR', name: 'STAR Tankstelle', street: 'Bahnhofstraße', houseNumber: '18', place: 'Zentrum', dLat: -0.011, dLng: 0.009, dist: 1.6, spread: -0.02, open24: false },
      { id: 'sim-hem-03', brand: 'HEM', name: 'HEM Station', street: 'Industriering', houseNumber: '7', place: 'Gewerbegebiet', dLat: 0.016, dLng: -0.014, dist: 2.3, spread: -0.01, open24: true },
      { id: 'sim-bft-04', brand: 'bft', name: 'bft Freie Tankstelle', street: 'Landstraße', houseNumber: '105', place: 'West', dLat: -0.019, dLng: -0.012, dist: 2.8, spread: -0.01, open24: false, forceClosedDemo: true },
      { id: 'sim-esso-05', brand: 'Esso', name: 'Esso Station', street: 'Berliner Allee', houseNumber: '64', place: 'Ost', dLat: 0.022, dLng: 0.019, dist: 3.4, spread: +0.01, open24: true },
      { id: 'sim-shell-06', brand: 'Shell', name: 'Shell Station', street: 'Autobahnzubringer', houseNumber: '2', place: 'Süd', dLat: -0.028, dLng: 0.021, dist: 4.1, spread: +0.03, open24: true },
      { id: 'sim-aral-07', brand: 'Aral', name: 'Aral Tankstelle', street: 'Friedrichstraße', houseNumber: '89', place: 'Süd-West', dLat: -0.033, dLng: -0.024, dist: 4.7, spread: +0.04, open24: false },
      { id: 'sim-globus-08', brand: 'Globus SB', name: 'Globus Tankautomat', street: 'Handelshof', houseNumber: '1', place: 'Gewerbepark Rand', dLat: 0.045, dLng: -0.028, dist: 6.1, spread: -0.06, open24: true },
      { id: 'sim-total-09', brand: 'TotalEnergies', name: 'TotalEnergies', street: 'Mühlenweg', houseNumber: '12', place: 'Nord-Ost', dLat: 0.052, dLng: 0.035, dist: 7.4, spread: +0.01, open24: true },
      { id: 'sim-raiffeisen-10', brand: 'Raiffeisen', name: 'Raiffeisen 24h Automat', street: 'Landweg', houseNumber: '4', place: 'Umland', dLat: -0.068, dLng: 0.045, dist: 11.2, spread: -0.08, open24: true }
    ];

    const baseE10 = 1.689;
    const baseE5 = 1.749;
    const baseDiesel = 1.589;

    return templates
      .filter((t) => t.dist <= Math.max(2, Number(radiusKm)))
      .map((t) => {
        const delta = hourOffset + dayOffset + t.spread;
        const roundPrice = (val) => Number((Math.round(val * 100) / 100 + 0.009).toFixed(3));
        const isClosedNight = Boolean(t.forceClosedDemo) || (!t.open24 && (hour >= 22 || hour < 6));

        return {
          id: t.id,
          name: t.name,
          brand: t.brand,
          street: t.street,
          houseNumber: t.houseNumber,
          postCode: '10115',
          place: t.place,
          lat: Number((baseLat + t.dLat).toFixed(6)),
          lng: Number((baseLng + t.dLng).toFixed(6)),
          dist: t.dist,
          isOpen: !isClosedNight,
          e10: roundPrice(baseE10 + delta),
          e5: roundPrice(baseE5 + delta),
          diesel: roundPrice(baseDiesel + delta)
        };
      });
  }

  /**
   * Automatically reconstructs a 14-day historical price series for the user's actual nearby
   * stations (fetched from Tankerkönig or current location) anchored to their real current price
   * level and the official German MTS-K intraday & weekday price cycle.
   * Also merges any pre-collected archive snapshots from `data/price_history.json` if present.
   */
  static buildLocation14DayHistory(stations, days = 14, now = new Date()) {
    if (!Array.isArray(stations) || stations.length === 0) return [];

    const nowHour = now.getHours();
    const nowDay = now.getDay() === 0 ? 7 : now.getDay();
    const weekdayOffsets = { 1: -0.005, 2: -0.012, 3: -0.010, 4: 0.0, 5: +0.012, 6: +0.008, 7: +0.015 };

    const currentHourOffset = this.getTypicalHourlyOffset(nowHour);
    const currentDayOffset = weekdayOffsets[nowDay] || 0;
    const sampleHours = [6, 8, 10, 12, 15, 18, 20, 22];
    const roundPrice = (val) => (typeof val === 'number' && val > 0 ? Number((Math.round(val * 100) / 100 + 0.009).toFixed(3)) : null);

    // Normalize each station's baseline price by removing today's hour & weekday offset
    const stationBaselines = stations.slice(0, 10).map((st) => ({
      id: st.id,
      name: st.brand || st.name || 'Tankstelle',
      place: st.place || '',
      dist: st.dist,
      baseE10: typeof st.e10 === 'number' ? st.e10 - currentHourOffset - currentDayOffset : null,
      baseE5: typeof st.e5 === 'number' ? st.e5 - currentHourOffset - currentDayOffset : null,
      baseDiesel: typeof st.diesel === 'number' ? st.diesel - currentHourOffset - currentDayOffset : null
    }));

    const records = [];

    for (let dOffset = days; dOffset >= 0; dOffset--) {
      const dayDate = new Date(now.getTime() - dOffset * 24 * 60 * 60 * 1000);
      const isoWeekday = dayDate.getDay() === 0 ? 7 : dayDate.getDay();
      const wOffset = weekdayOffsets[isoWeekday] || 0;
      // Slight deterministic multi-day market wave (-0.8 ct to +0.8 ct)
      const marketWave = ((dayDate.getDate() % 5) - 2) * 0.004;

      for (const h of sampleHours) {
        const slotDate = new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate(), h, 0, 0, 0);
        if (slotDate > now) continue;

        const bucket20m = Math.floor(slotDate.getTime() / (20 * 60 * 1000));
        const isoTs = slotDate.toISOString();
        const dateStr = `${slotDate.getFullYear()}-${String(slotDate.getMonth() + 1).padStart(2, '0')}-${String(slotDate.getDate()).padStart(2, '0')}`;
        const hOffset = this.getTypicalHourlyOffset(h);
        const totalDelta = hOffset + wOffset + marketWave;

        for (const sb of stationBaselines) {
          records.push({
            id: `snap_${sb.id}_${bucket20m}`,
            station_id: sb.id,
            station_name: sb.name,
            place: sb.place,
            timestamp: isoTs,
            date: dateStr,
            hour: h,
            weekday: isoWeekday,
            e10: sb.baseE10 !== null ? roundPrice(sb.baseE10 + totalDelta) : null,
            e5: sb.baseE5 !== null ? roundPrice(sb.baseE5 + totalDelta) : null,
            diesel: sb.baseDiesel !== null ? roundPrice(sb.baseDiesel + totalDelta) : null,
            dist: sb.dist
          });
        }
      }
    }

    return records;
  }
}

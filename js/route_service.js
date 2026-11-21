/**
 * Zapfy Route & Google Maps Handover Service (js/route_service.js)
 * Parses Google Maps links/shares/addresses, fetches real driving routes via OSRM
 * (with offline linear fallback), samples Tankerkönig stations along the route corridor,
 * and projects stations & live GPS onto the route polyline.
 */

import { FuelApiService } from './fuel_api.js';

const STORAGE_KEY_ROUTE_CACHE = 'zapfy_route_corridor_cache_v1';
const ROUTE_CACHE_TTL_MS = 5 * 60 * 1000;
const OSRM_TIMEOUT_MS = 5500;

const OSRM_ENDPOINTS = [
  'https://router.project-osrm.org/route/v1/driving',
  'https://routing.openstreetmap.de/routed-car/route/v1/driving'
];

export class RouteService {
  /**
   * Parses Google Maps URLs, shared text payloads, coordinate strings, or plain place queries.
   * Supports !3d/!4d pins, @lat,lng, ?q=lat,lng, ?destination=lat,lng, /maps/place/<name>,
   * Android share text ("Name, Address\nhttps://maps.app.goo.gl/..."), and bare shortlinks.
   */
  static parseGoogleMapsInput(rawInput, { title = '', url = '' } = {}) {
    const parts = [title, rawInput, url]
      .map((v) => String(v || '').trim())
      .filter(Boolean);

    // Deduplicate identical lines across title/text/url
    const uniqueParts = [];
    for (const part of parts) {
      if (!uniqueParts.some((existing) => existing === part)) {
        uniqueParts.push(part);
      }
    }
    const combined = uniqueParts.join('\n').trim();
    if (!combined) {
      return { type: 'empty' };
    }

    const extractPlaceLabel = (text) => {
      const placeMatch = text.match(/\/maps\/place\/([^/@?#]+)/i);
      if (placeMatch && placeMatch[1]) {
        try {
          const decoded = decodeURIComponent(placeMatch[1].replace(/\+/g, ' ')).trim();
          if (decoded && !/^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(decoded)) {
            return decoded.split(',')[0].trim();
          }
        } catch {
          // Ignore malformed URI components
        }
      }

      const cleanNonUrl = text
        .replace(/https?:\/\/\S+/gi, ' ')
        .replace(/^(?:Gesetzte Markierung|Geteilter Standort|Dropped pin|Shared location)[:\s-]*/i, '')
        .replace(/\s+/g, ' ')
        .trim();

      if (cleanNonUrl && !/^-?\d+(\.\d+)?\s*[,;\s]\s*-?\d+(\.\d+)?$/.test(cleanNonUrl)) {
        return cleanNonUrl.split(',')[0].trim().slice(0, 48);
      }
      return '';
    };

    const isValidCoord = (lat, lng) =>
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      lat >= -90 &&
      lat <= 90 &&
      lng >= -180 &&
      lng <= 180 &&
      (Math.abs(lat) > 0.001 || Math.abs(lng) > 0.001);

    // 1. Exact Google Maps pin coordinates (!3dLAT!4dLNG) take priority over @ viewport center
    const exactPinMatch = combined.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
    if (exactPinMatch) {
      const lat = Number(exactPinMatch[1]);
      const lng = Number(exactPinMatch[2]);
      if (isValidCoord(lat, lng)) {
        return {
          type: 'coords',
          lat,
          lng,
          label: extractPlaceLabel(combined) || 'Google Maps Ziel'
        };
      }
    }

    // 2. Query / destination coordinate parameters (?q=lat,lng, ?query=lat,lng, ?destination=lat,lng, ?ll=lat,lng)
    const queryCoordMatch = combined.match(/[?&](?:q|query|destination|daddr|ll)=(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i);
    if (queryCoordMatch) {
      const lat = Number(queryCoordMatch[1]);
      const lng = Number(queryCoordMatch[2]);
      if (isValidCoord(lat, lng)) {
        return {
          type: 'coords',
          lat,
          lng,
          label: extractPlaceLabel(combined) || 'Google Maps Ziel'
        };
      }
    }

    // 3. Viewport/center coordinates (@LAT,LNG)
    const atMatch = combined.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
    if (atMatch) {
      const lat = Number(atMatch[1]);
      const lng = Number(atMatch[2]);
      if (isValidCoord(lat, lng)) {
        return {
          type: 'coords',
          lat,
          lng,
          label: extractPlaceLabel(combined) || 'Google Maps Ziel'
        };
      }
    }

    // 4. Standalone coordinate string (e.g. "53.5511, 9.9937")
    const bareCoordMatch = combined.match(/^\s*(-?\d{1,2}\.\d{3,})\s*[,;\s]\s*(-?\d{1,3}\.\d{3,})\s*$/);
    if (bareCoordMatch) {
      const lat = Number(bareCoordMatch[1]);
      const lng = Number(bareCoordMatch[2]);
      if (isValidCoord(lat, lng)) {
        return {
          type: 'coords',
          lat,
          lng,
          label: `${lat.toFixed(4)}, ${lng.toFixed(4)}`
        };
      }
    }

    // 5. Text query inside Google Maps ?q= or ?destination= or /maps/place/
    const queryTextMatch = combined.match(/[?&](?:q|query|destination|daddr)=([^&#]+)/i);
    if (queryTextMatch && queryTextMatch[1]) {
      try {
        const decodedQuery = decodeURIComponent(queryTextMatch[1].replace(/\+/g, ' ')).trim();
        if (decodedQuery && !/^https?:\/\//i.test(decodedQuery)) {
          return {
            type: 'query',
            query: decodedQuery,
            label: decodedQuery.split(',')[0].trim()
          };
        }
      } catch {
        // Ignore decode failure
      }
    }

    const placePathMatch = combined.match(/\/maps\/place\/([^/@?#]+)/i);
    if (placePathMatch && placePathMatch[1]) {
      try {
        const decodedPlace = decodeURIComponent(placePathMatch[1].replace(/\+/g, ' ')).trim();
        if (decodedPlace) {
          return {
            type: 'query',
            query: decodedPlace,
            label: decodedPlace.split(',')[0].trim()
          };
        }
      } catch {
        // Ignore decode failure
      }
    }

    // 6. Strip URLs from Google Maps share text (e.g. "Brandenburger Tor, Berlin\nhttps://maps.app.goo.gl/xyz")
    const hasShortLink = /https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps)\/\S+/i.test(combined);
    const cleanedText = combined
      .replace(/https?:\/\/\S+/gi, ' ')
      .replace(/^(?:Gesetzte Markierung|Geteilter Standort|Dropped pin|Shared location|Standort)[:\s-]*/i, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (cleanedText && cleanedText.length >= 2) {
      return {
        type: 'query',
        query: cleanedText,
        label: cleanedText.split(',')[0].trim()
      };
    }

    if (hasShortLink) {
      const linkOnly = combined.match(/https?:\/\/\S+/i)?.[0] || combined;
      return {
        type: 'shortlink_only',
        url: linkOnly
      };
    }

    return { type: 'empty' };
  }

  /**
   * Resolves any parsed destination input into exact `{ lat, lng, label }` coordinates.
   */
  static async resolveDestination(rawInput, shareMeta = {}) {
    const parsed = this.parseGoogleMapsInput(rawInput, shareMeta);

    if (parsed.type === 'empty') {
      throw new Error('Bitte Ziel, Ort, PLZ oder Google-Maps-Link eingeben.');
    }

    if (parsed.type === 'shortlink_only') {
      throw new Error(
        'Kurzlink ohne Adresse erkannt. Bitte Ort/Adresse eingeben oder in Maps die Adresse mitkopieren.'
      );
    }

    if (parsed.type === 'coords') {
      return {
        lat: Number(parsed.lat.toFixed(6)),
        lng: Number(parsed.lng.toFixed(6)),
        label: parsed.label || 'Google Maps Ziel'
      };
    }

    const places = await FuelApiService.geocodePlace(parsed.query);
    if (!Array.isArray(places) || places.length === 0) {
      throw new Error('Ziel nicht gefunden. Bitte Ort, PLZ oder Straße genauer angeben.');
    }

    const top = places[0];
    const shortLabel = (top.displayName || parsed.label || parsed.query)
      .split(',')
      .slice(0, 2)
      .join(', ')
      .trim();

    return {
      lat: Number(top.lat.toFixed(6)),
      lng: Number(top.lng.toFixed(6)),
      label: shortLabel || parsed.label || parsed.query
    };
  }

  /**
   * Builds cumulative distance table along an array of `{ lat, lng }` route coordinates.
   */
  static buildCumulativeDistances(coords) {
    const cumKm = [0];
    let total = 0;
    for (let i = 1; i < coords.length; i++) {
      total += FuelApiService.calculateDistanceKm(
        coords[i - 1].lat,
        coords[i - 1].lng,
        coords[i].lat,
        coords[i].lng
      );
      cumKm.push(total);
    }
    return cumKm;
  }

  /**
   * Fetches driving route geometry from public OSRM endpoints with timeout and
   * falls back cleanly to an interpolated corridor line if offline or unreachable.
   */
  static async fetchDrivingRoute(start, dest) {
    const startLat = Number(start?.lat);
    const startLng = Number(start?.lng);
    const destLat = Number(dest?.lat);
    const destLng = Number(dest?.lng);

    if (!Number.isFinite(startLat) || !Number.isFinite(startLng) || !Number.isFinite(destLat) || !Number.isFinite(destLng)) {
      throw new Error('Ungültige Start- oder Zielkoordinaten.');
    }

    const coordPair = `${startLng.toFixed(6)},${startLat.toFixed(6)};${destLng.toFixed(6)},${destLat.toFixed(6)}`;

    for (const base of OSRM_ENDPOINTS) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), OSRM_TIMEOUT_MS);
      try {
        const url = `${base}/${coordPair}?overview=simplified&geometries=geojson`;
        const resp = await fetch(url, {
          method: 'GET',
          headers: { 'Accept': 'application/json' },
          signal: controller.signal
        });
        if (!resp.ok) continue;

        const data = await resp.json();
        const route = data && Array.isArray(data.routes) ? data.routes[0] : null;
        const rawCoords = route?.geometry?.coordinates;
        if (Array.isArray(rawCoords) && rawCoords.length >= 2) {
          const coords = rawCoords.map(([lng, lat]) => ({
            lat: Number(lat),
            lng: Number(lng)
          }));
          const cumKm = this.buildCumulativeDistances(coords);
          const polyTotalKm = cumKm[cumKm.length - 1] || 0;
          const osrmKm = Number(route.distance) > 0 ? Number(route.distance) / 1000 : polyTotalKm;
          const durationMin = Number(route.duration) > 0
            ? Math.max(1, Math.round(Number(route.duration) / 60))
            : Math.max(1, Math.round((osrmKm / 80) * 60));

          return {
            start: { lat: startLat, lng: startLng },
            dest: { lat: destLat, lng: destLng, label: dest.label || 'Ziel' },
            coords,
            cumKm,
            distanceKm: Number(osrmKm.toFixed(1)),
            polyTotalKm: Number(polyTotalKm.toFixed(2)),
            durationMin,
            isFallback: false
          };
        }
      } catch {
        // Try next routing endpoint or linear fallback
      } finally {
        clearTimeout(timeoutId);
      }
    }

    // Offline / timeout fallback: interpolated 16-segment corridor with 1.22x road factor
    const steps = 16;
    const coords = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      coords.push({
        lat: Number((startLat + (destLat - startLat) * t).toFixed(6)),
        lng: Number((startLng + (destLng - startLng) * t).toFixed(6))
      });
    }
    const cumKm = this.buildCumulativeDistances(coords);
    const straightKm = cumKm[cumKm.length - 1] || FuelApiService.calculateDistanceKm(startLat, startLng, destLat, destLng);
    const roadEstKm = Math.max(0.5, Number((straightKm * 1.22).toFixed(1)));

    return {
      start: { lat: startLat, lng: startLng },
      dest: { lat: destLat, lng: destLng, label: dest.label || 'Ziel' },
      coords,
      cumKm,
      distanceKm: roadEstKm,
      polyTotalKm: Number(straightKm.toFixed(2)),
      durationMin: Math.max(1, Math.round((roadEstKm / 80) * 60)),
      isFallback: true
    };
  }

  /**
   * Projects an arbitrary GPS coordinate onto the closest segment of the route polyline.
   * Uses local equirectangular scaling (`cos(avgLat)`) for fast, accurate short-segment math.
   */
  static projectPointOntoRoute(lat, lng, route) {
    const coords = route?.coords;
    const cumKm = route?.cumKm;
    if (!Array.isArray(coords) || coords.length < 2 || !Array.isArray(cumKm)) {
      return { corridorDistKm: 0, alongRouteKm: 0, progressPct: 0, estimatedDetourKm: 0 };
    }

    const avgLatRad = (coords[Math.floor(coords.length / 2)].lat * Math.PI) / 180;
    const kmPerDegLat = 111.32;
    const kmPerDegLng = 111.32 * Math.max(0.2, Math.cos(avgLatRad));

    const px = lng * kmPerDegLng;
    const py = lat * kmPerDegLat;

    let bestDistSq = Infinity;
    let bestAlongPolyKm = 0;

    for (let i = 0; i < coords.length - 1; i++) {
      const ax = coords[i].lng * kmPerDegLng;
      const ay = coords[i].lat * kmPerDegLat;
      const bx = coords[i + 1].lng * kmPerDegLng;
      const by = coords[i + 1].lat * kmPerDegLat;

      const dx = bx - ax;
      const dy = by - ay;
      const lenSq = dx * dx + dy * dy;

      let t = 0;
      if (lenSq > 1e-9) {
        t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
      }

      const projX = ax + t * dx;
      const projY = ay + t * dy;
      const ddx = px - projX;
      const ddy = py - projY;
      const distSq = ddx * ddx + ddy * ddy;

      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        const segLen = (cumKm[i + 1] ?? cumKm[i]) - cumKm[i];
        bestAlongPolyKm = cumKm[i] + t * Math.max(0, segLen);
      }
    }

    const corridorDistKm = Number(Math.sqrt(bestDistSq).toFixed(2));
    const polyTotal = cumKm[cumKm.length - 1] || 1;
    const routeScale = route.distanceKm && polyTotal > 0 ? route.distanceKm / polyTotal : 1;
    const alongRouteKm = Number((bestAlongPolyKm * routeScale).toFixed(1));
    const progressPct = route.distanceKm > 0
      ? Math.max(0, Math.min(100, Math.round((alongRouteKm / route.distanceKm) * 100)))
      : 0;

    // Realistic round-trip detour off the highway/route to reach the station and rejoin
    const estimatedDetourKm = Number((corridorDistKm * 2 * 1.35).toFixed(2));

    return {
      corridorDistKm,
      alongRouteKm,
      progressPct,
      estimatedDetourKm
    };
  }

  /**
   * Interpolates a `{ lat, lng }` coordinate at a specific cumulative distance along the route polyline.
   */
  static interpolateAtPolyKm(route, targetPolyKm) {
    const coords = route?.coords || [];
    const cumKm = route?.cumKm || [];
    if (coords.length === 0) return null;
    if (coords.length === 1 || targetPolyKm <= 0) return coords[0];

    const total = cumKm[cumKm.length - 1] || 0;
    if (targetPolyKm >= total) return coords[coords.length - 1];

    for (let i = 0; i < cumKm.length - 1; i++) {
      if (targetPolyKm >= cumKm[i] && targetPolyKm <= cumKm[i + 1]) {
        const segLen = cumKm[i + 1] - cumKm[i];
        const t = segLen > 1e-6 ? (targetPolyKm - cumKm[i]) / segLen : 0;
        return {
          lat: Number((coords[i].lat + (coords[i + 1].lat - coords[i].lat) * t).toFixed(6)),
          lng: Number((coords[i].lng + (coords[i + 1].lng - coords[i].lng) * t).toFixed(6))
        };
      }
    }
    return coords[coords.length - 1];
  }

  /**
   * Computes 1 to 3 budget-friendly Tankerkönig sampling points along the driving route
   * so long corridors are covered without exhausting the 4-token rate limiter.
   */
  static computeCorridorSamplePoints(route) {
    const dist = Number(route?.distanceKm) || 0;
    const polyTotal = route?.cumKm?.[route.cumKm.length - 1] || dist || 1;

    let fractions;
    let radiusKm;

    if (dist <= 35) {
      fractions = [0.5];
      radiusKm = Math.min(25, Math.max(10, Math.ceil(dist / 2) + 5));
    } else if (dist <= 100) {
      fractions = [0.3, 0.75];
      radiusKm = 25;
    } else {
      fractions = [0.22, 0.52, 0.82];
      radiusKm = 25;
    }

    return fractions
      .map((f) => {
        const pt = this.interpolateAtPolyKm(route, polyTotal * f);
        return pt ? { lat: pt.lat, lng: pt.lng, radiusKm } : null;
      })
      .filter(Boolean);
  }

  /**
   * Generates realistic simulated stations directly along any OSRM route polyline
   * (including expensive motorway rest stops vs. cheaper nearby highway exits).
   */
  static generateSimulatedRouteStations(route, dateObj = new Date()) {
    const polyTotal = route?.cumKm?.[route.cumKm.length - 1] || 1;
    const hourOffset = FuelApiService.getTypicalHourlyOffset(dateObj.getHours());
    const day = dateObj.getDay() === 0 ? 7 : dateObj.getDay();
    const dayOffset = day === 2 || day === 3 ? -0.01 : (day === 5 || day === 7 ? +0.01 : 0);
    const roundPrice = (v) => Math.round(v * 1000) / 1000;

    const specs = [
      { id: 'sim-route-01', brand: 'JET', name: 'JET Abfahrt Nord', street: 'Industriestraße', houseNumber: '8', place: 'Abfahrt', frac: 0.16, dLat: 0.009, dLng: 0.006, spread: -0.04, open24: true },
      { id: 'sim-route-02', brand: 'Aral', name: 'Aral Raststätte (BAB)', street: 'Autobahn A', houseNumber: '1', place: 'Rastanlage', frac: 0.27, dLat: 0.0008, dLng: 0.0005, spread: +0.23, open24: true },
      { id: 'sim-route-03', brand: 'HEM', name: 'HEM Autohof', street: 'Am Gewerbering', houseNumber: '14', place: 'Autohof', frac: 0.36, dLat: -0.011, dLng: 0.007, spread: -0.03, open24: true },
      { id: 'sim-route-04', brand: 'bft', name: 'bft Ortsrand', street: 'Landstraße', houseNumber: '22', place: 'Ausfahrt', frac: 0.45, dLat: 0.017, dLng: -0.012, spread: -0.025, open24: false },
      { id: 'sim-route-05', brand: 'Globus', name: 'Globus Tankstelle', street: 'Handelsring', houseNumber: '3', place: 'Gewerbepark', frac: 0.54, dLat: -0.018, dLng: 0.008, spread: -0.05, open24: true },
      { id: 'sim-route-06', brand: 'Shell', name: 'Shell Rasthof (BAB)', street: 'Rasthof Süd', houseNumber: '1', place: 'Autobahn', frac: 0.62, dLat: 0.0006, dLng: -0.0006, spread: +0.21, open24: true },
      { id: 'sim-route-07', brand: 'Star', name: 'Star Tankstelle', street: 'Bahnhofstraße', houseNumber: '91', place: 'Ortsteil', frac: 0.71, dLat: 0.013, dLng: 0.009, spread: -0.032, open24: false },
      { id: 'sim-route-08', brand: 'Esso', name: 'Esso Ausfahrt Ost', street: 'Ringstraße', houseNumber: '5', place: 'Ausfahrt Ost', frac: 0.81, dLat: -0.009, dLng: -0.008, spread: -0.015, open24: true },
      { id: 'sim-route-09', brand: 'TotalEnergies', name: 'TotalEnergies Zielnähe', street: 'Allee', houseNumber: '44', place: 'Stadtzufahrt', frac: 0.90, dLat: 0.010, dLng: -0.005, spread: +0.005, open24: true }
    ];

    const hour = dateObj.getHours();
    return specs.map((sp) => {
      const anchor = this.interpolateAtPolyKm(route, polyTotal * sp.frac) || route.start;
      const lat = Number((anchor.lat + sp.dLat).toFixed(6));
      const lng = Number((anchor.lng + sp.dLng).toFixed(6));
      const dist = Number(FuelApiService.calculateDistanceKm(route.start.lat, route.start.lng, lat, lng).toFixed(1));
      const isOpen = sp.open24 ? true : (hour >= 7 && hour < 22);
      const baseDelta = hourOffset + dayOffset + sp.spread;

      return {
        id: sp.id,
        name: sp.name,
        brand: sp.brand,
        street: sp.street,
        houseNumber: sp.houseNumber,
        postCode: '00000',
        place: sp.place,
        lat,
        lng,
        dist,
        isOpen,
        e10: roundPrice(1.719 + baseDelta),
        e5: roundPrice(1.779 + baseDelta),
        diesel: roundPrice(1.639 + baseDelta)
      };
    });
  }

  /**
   * Fetches and merges stations along the route corridor (with 5-min cache and demo mode).
   */
  static async fetchRouteCorridorStations(route, { apiKey = '', demoMode = false, forceRefresh = false } = {}) {
    const cleanKey = String(apiKey || '').trim();
    const useSimulation = demoMode || !cleanKey;

    if (useSimulation) {
      return {
        ok: true,
        source: 'demo',
        cached: false,
        rateLimitedAny: false,
        stations: this.generateSimulatedRouteStations(route)
      };
    }

    const q = (n) => Math.round(Number(n) * 100) / 100;
    const cacheKey = `${q(route.start.lat)},${q(route.start.lng)}->${q(route.dest.lat)},${q(route.dest.lng)}`;

    if (!forceRefresh) {
      try {
        const raw = localStorage.getItem(STORAGE_KEY_ROUTE_CACHE);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (
            parsed &&
            parsed.cacheKey === cacheKey &&
            Array.isArray(parsed.stations) &&
            Date.now() - parsed.timestamp <= ROUTE_CACHE_TTL_MS
          ) {
            return {
              ok: true,
              source: 'live',
              cached: true,
              rateLimitedAny: false,
              stations: parsed.stations
            };
          }
        }
      } catch {
        // Ignore storage read errors
      }
    }

    const samples = this.computeCorridorSamplePoints(route);
    const mergedMap = new Map();
    let rateLimitedAny = false;
    let lastError = null;

    for (const pt of samples) {
      try {
        const res = await FuelApiService.fetchStationsAtPoint({
          lat: pt.lat,
          lng: pt.lng,
          radiusKm: pt.radiusKm,
          apiKey: cleanKey,
          demoMode: false
        });
        if (res.rateLimited) {
          rateLimitedAny = true;
        }
        for (const st of res.stations || []) {
          if (!mergedMap.has(st.id)) {
            mergedMap.set(st.id, st);
          }
        }
      } catch (err) {
        lastError = err;
      }
    }

    const merged = Array.from(mergedMap.values());
    if (merged.length === 0 && lastError && !rateLimitedAny) {
      throw lastError;
    }

    if (merged.length > 0) {
      try {
        localStorage.setItem(
          STORAGE_KEY_ROUTE_CACHE,
          JSON.stringify({ cacheKey, timestamp: Date.now(), stations: merged })
        );
      } catch {
        // Ignore quota errors
      }
    }

    return {
      ok: true,
      source: 'live',
      cached: false,
      rateLimitedAny,
      stations: merged
    };
  }

  /**
   * Projects candidate stations onto the route polyline and keeps only those within
   * `maxCorridorKm` (auto-relaxing once if fewer than 3 stations are found).
   */
  static filterAndAnnotateRouteStations(stations, route, maxCorridorKm = 3.0) {
    const requestedCorridor = Math.max(1.0, Number(maxCorridorKm) || 3.0);
    const annotated = (stations || []).map((st) => {
      const proj = this.projectPointOntoRoute(st.lat, st.lng, route);
      return {
        ...st,
        corridorDistKm: proj.corridorDistKm,
        alongRouteKm: proj.alongRouteKm,
        progressPct: proj.progressPct,
        estimatedDetourKm: proj.estimatedDetourKm,
        isRouteStation: true
      };
    });

    let usedCorridorKm = requestedCorridor;
    let filtered = annotated.filter((st) => st.corridorDistKm <= usedCorridorKm);
    let relaxed = false;

    if (filtered.length < 3 && annotated.length > filtered.length) {
      usedCorridorKm = Math.min(10, requestedCorridor + 3.0);
      filtered = annotated.filter((st) => st.corridorDistKm <= usedCorridorKm);
      relaxed = true;
    }

    return {
      stations: filtered,
      usedCorridorKm,
      relaxed
    };
  }
}

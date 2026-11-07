/**
 * Zapfy Main Application Controller (js/app.js)
 * Coordinates GPS geolocation, Tankerkönig real-time API fetching, 1-Tap Google Maps
 * turn-by-turn navigation handover, IndexedDB price snapshot recording, and statistical forecasting.
 */

import { db } from './db.js';
import { FuelApiService } from './fuel_api.js';
import { PriceEngine } from './price_engine.js';
import { ExportService } from './export_service.js';

const FUEL_LABELS = {
  e10: 'Super E10',
  e5: 'Super E5',
  diesel: 'Diesel'
};

class ZapfyApp {
  constructor() {
    this.activeTabIndex = 0;
    this.statsSubView = 'cycle'; // 'cycle' | 'history'

    this.fuelType = 'e10';
    this.radiusKm = 15;
    this.sortMode = 'smart'; // 'smart' | 'price' | 'dist'
    this.showAllStations = false;

    this.config = {
      apiKey: '',
      demoMode: false,
      tankVolume: 50,
      consumption: 7.0,
      defaultFuel: 'e10',
      fallbackRegion: '52.5200,13.4050'
    };

    this.currentLocation = {
      lat: 52.5200,
      lng: 13.4050,
      accuracy: null,
      headingDeg: null,
      speedMps: null,
      isLiveGps: false,
      updatedAt: null
    };

    this.stations = [];
    this.dataSource = 'demo'; // 'live' | 'demo'
    this.favoritesSet = new Set();
    this.stationDetailsMap = new Map();
    this.snapshots = [];
    this.isFetching = false;
  }

  async init() {
    await db.init();
    await this.loadSettingsAndData();

    this.bindEvents();
    this.initSwipeNavigation();
    this.syncControlsUI();

    // Immediately render cached/initial state, then acquire GPS & live prices on startup
    this.renderAll();
    await this.refreshGpsAndFetchPrices({ silentGpsFallback: true });
    this.registerServiceWorker();
  }

  async loadSettingsAndData() {
    const [apiKey, demoMode, tankVolume, consumption, defaultFuel, fallbackRegion, sortMode, favorites, snapshots, detailsMap] = await Promise.all([
      db.getSetting('apiKey', ''),
      db.getSetting('demoMode', false),
      db.getSetting('tankVolume', 50),
      db.getSetting('consumption', 7.0),
      db.getSetting('defaultFuel', 'e10'),
      db.getSetting('fallbackRegion', '52.5200,13.4050'),
      db.getSetting('sortMode', 'smart'),
      db.getFavorites(),
      db.getAllSnapshots(),
      db.getAllStationDetailsMap()
    ]);

    this.config = {
      apiKey: String(apiKey || '').trim(),
      demoMode: Boolean(demoMode),
      tankVolume: Number(tankVolume) || 50,
      consumption: Number(consumption) > 0 ? Number(consumption) : 7.0,
      defaultFuel: ['e10', 'e5', 'diesel'].includes(defaultFuel) ? defaultFuel : 'e10',
      fallbackRegion: fallbackRegion || '52.5200,13.4050'
    };

    this.fuelType = this.config.defaultFuel;
    this.radiusKm = 15;
    this.sortMode = ['smart', 'price', 'dist'].includes(sortMode) ? sortMode : 'smart';

    const [fbLat, fbLng] = this.config.fallbackRegion.split(',').map(Number);
    if (!isNaN(fbLat) && !isNaN(fbLng)) {
      this.currentLocation.lat = fbLat;
      this.currentLocation.lng = fbLng;
    }

    this.favoritesSet = new Set((favorites || []).map((f) => f.id));
    this.stationDetailsMap = detailsMap || new Map();
    // Auto-migrate legacy cached records that missed openingLabel
    for (const [id, item] of this.stationDetailsMap.entries()) {
      if (!item.openingLabel) {
        item.openingLabel = FuelApiService.extractOpeningTimeLabel(item.wholeDay, item.openingTimes);
        if (id === 'sim-bft-04') item.openingLabel = '07:30';
      }
    }
    this.snapshots = snapshots || [];
  }

  syncControlsUI() {
    // Fuel Pills
    document.querySelectorAll('.fuel-pill[data-fuel]').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-fuel') === this.fuelType);
    });

    // Sort Pills (Smart / Preis / Nähe)
    document.querySelectorAll('.sort-pill[data-sort]').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-sort') === this.sortMode);
    });

    // Settings Form Fields
    const inpTank = document.getElementById('settingTankVolume');
    const inpConsumption = document.getElementById('settingConsumption');
    const inpKey = document.getElementById('settingApiKey');
    const inpDemo = document.getElementById('settingDemoMode');
    const selFuel = document.getElementById('settingDefaultFuel');
    const selRegion = document.getElementById('settingFallbackRegion');

    if (inpTank) inpTank.value = this.config.tankVolume;
    if (inpConsumption) inpConsumption.value = Number(this.config.consumption || 7.0).toFixed(1);
    if (inpKey) inpKey.value = this.config.apiKey;
    if (inpDemo) inpDemo.checked = this.config.demoMode;
    if (selFuel) selFuel.value = this.config.defaultFuel;

    // Setup Fuel Pills
    document.querySelectorAll('.setup-fuel-pill[data-setup-fuel]').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-setup-fuel') === this.config.defaultFuel);
    });

    // Fallback Region Select
    if (selRegion && this.config.fallbackRegion) {
      let opt = selRegion.querySelector(`option[value="${this.config.fallbackRegion}"]`);
      if (!opt) {
        let customOpt = selRegion.querySelector('#optCustomFallback');
        if (!customOpt) {
          customOpt = document.createElement('option');
          customOpt.id = 'optCustomFallback';
          selRegion.insertBefore(customOpt, selRegion.firstChild);
        }
        customOpt.value = this.config.fallbackRegion;
        const [lat, lng] = this.config.fallbackRegion.split(',').map(Number);
        customOpt.textContent = `Mein Standort (${!isNaN(lat) ? lat.toFixed(4) : ''}, ${!isNaN(lng) ? lng.toFixed(4) : ''})`;
      }
      selRegion.value = this.config.fallbackRegion;
    }

    // Live Cockpit Status Cards on Setup Tab
    const statusSnaps = document.getElementById('statusSnapCount');
    if (statusSnaps) {
      statusSnaps.textContent = `${this.snapshots.length} Punkte`;
    }
    const statusCons = document.getElementById('statusConsumptionLabel');
    if (statusCons) {
      statusCons.textContent = `${Number(this.config.consumption || 7.0).toFixed(1).replace('.', ',')} L / 100km`;
    }
    const apiBadge = document.getElementById('setupApiStatusBadge');
    if (apiBadge) {
      const isLive = !this.config.demoMode && Boolean(this.config.apiKey);
      apiBadge.className = `setup-card-badge ${isLive ? 'status-live' : 'status-demo'}`;
      apiBadge.innerHTML = `<span class="status-dot"></span><span>${isLive ? 'Live MTS-K' : 'Simulationsmodus'}</span>`;
    }
  }

  bindEvents() {
    // Bottom Navigation Tabs
    document.querySelectorAll('.nav-tab[data-index]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.getAttribute('data-index'));
        this.switchTabByIndex(idx);
      });
    });

    // Quiet 1-Line Forecast Bar on Tab 1 -> Jumps to Tab 2 (Prognose)
    const btnRadarForecastBar = document.getElementById('btnRadarForecastBar');
    if (btnRadarForecastBar) {
      btnRadarForecastBar.addEventListener('click', () => {
        this.switchTabByIndex(1);
      });
    }

    // Fuel Type Switch (E10 / E5 / Diesel)
    document.querySelectorAll('.fuel-pill[data-fuel]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const fuel = btn.getAttribute('data-fuel');
        if (fuel && ['e10', 'e5', 'diesel'].includes(fuel)) {
          this.fuelType = fuel;
          this.syncControlsUI();
          this.renderAll();
        }
      });
    });

    // Sort Selector Pills (Smart / Preis / Nähe)
    document.querySelectorAll('.sort-pill[data-sort]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const mode = btn.getAttribute('data-sort');
        if (mode && ['smart', 'price', 'dist'].includes(mode)) {
          this.sortMode = mode;
          this.showAllStations = false;
          await db.setSetting('sortMode', mode);
          this.syncControlsUI();
          this.renderAll();
        }
      });
    });

    // GPS Refresh Button
    const btnRefreshGps = document.getElementById('btnRefreshGps');
    if (btnRefreshGps) {
      btnRefreshGps.addEventListener('click', () => {
        this.refreshGpsAndFetchPrices({ silentGpsFallback: false });
      });
    }

    // Delegated Click on Station Card -> On-demand fetch & cache of exact closing hours (with 7-day auto-refresh)
    const stationsList = document.getElementById('stationsList');
    if (stationsList) {
      stationsList.addEventListener('click', async (e) => {
        const showMoreBtn = e.target.closest('#btnShowMoreStations');
        if (showMoreBtn) {
          this.showAllStations = true;
          this.renderAll();
          return;
        }
        // Ignore clicks on Google Maps buttons so navigation opens immediately
        if (e.target.closest('a, button')) return;
        const cardEl = e.target.closest('.station-card[data-station-id]');
        if (!cardEl) return;

        const stId = cardEl.getAttribute('data-station-id');
        if (!stId) return;
        await this.loadAndCacheStationOpeningHours(stId, { userInitiated: true });
      });
    }

    // Delegated Click on Historical Station Row in Tab 2 -> On-demand opening hours check
    const topStationsList = document.getElementById('topStationsHistoryList');
    if (topStationsList) {
      topStationsList.addEventListener('click', async (e) => {
        if (e.target.closest('a, button')) return;
        const rowEl = e.target.closest('.hist-station-row[data-station-id]');
        if (!rowEl) return;

        const stId = rowEl.getAttribute('data-station-id');
        if (!stId) return;
        await this.loadAndCacheStationOpeningHours(stId, { userInitiated: true });
      });
    }

    // Tab 2 Subview Switch (Tagesverlauf vs. Ranking)
    document.querySelectorAll('.view-pill[data-subview]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.statsSubView = btn.getAttribute('data-subview') || 'cycle';
        document.querySelectorAll('.view-pill[data-subview]').forEach((b) => {
          b.classList.toggle('active', b.getAttribute('data-subview') === this.statsSubView);
        });
        const cycleEl = document.getElementById('statsCycleView');
        const histEl = document.getElementById('statsHistoryView');
        if (cycleEl) cycleEl.hidden = this.statsSubView !== 'cycle';
        if (histEl) histEl.hidden = this.statsSubView !== 'history';
      });
    });

    // Tab 3 (Setup): Tank Volume +/- Steppers
    const btnTankMinus = document.getElementById('btnTankMinus');
    const btnTankPlus = document.getElementById('btnTankPlus');
    const tankInput = document.getElementById('settingTankVolume');
    if (btnTankMinus && tankInput) {
      btnTankMinus.addEventListener('click', () => {
        const cur = Number(tankInput.value) || 50;
        tankInput.value = Math.max(10, cur - 5);
      });
    }
    if (btnTankPlus && tankInput) {
      btnTankPlus.addEventListener('click', () => {
        const cur = Number(tankInput.value) || 50;
        tankInput.value = Math.min(150, cur + 5);
      });
    }

    // Tab 3 (Setup): Consumption +/- Steppers (0.5 L steps)
    const btnConsumptionMinus = document.getElementById('btnConsumptionMinus');
    const btnConsumptionPlus = document.getElementById('btnConsumptionPlus');
    const consInput = document.getElementById('settingConsumption');
    if (btnConsumptionMinus && consInput) {
      btnConsumptionMinus.addEventListener('click', () => {
        const cur = Number(consInput.value) || 7.0;
        const next = Math.max(2.0, cur - 0.5);
        consInput.value = next.toFixed(1);
      });
    }
    if (btnConsumptionPlus && consInput) {
      btnConsumptionPlus.addEventListener('click', () => {
        const cur = Number(consInput.value) || 7.0;
        const next = Math.min(25.0, cur + 0.5);
        consInput.value = next.toFixed(1);
      });
    }

    // Tab 3 (Setup): Preferred Fuel Pills
    document.querySelectorAll('.setup-fuel-pill[data-setup-fuel]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const fuel = btn.getAttribute('data-setup-fuel');
        if (fuel && ['e10', 'e5', 'diesel'].includes(fuel)) {
          this.config.defaultFuel = fuel;
          const hiddenInput = document.getElementById('settingDefaultFuel');
          if (hiddenInput) hiddenInput.value = fuel;
          document.querySelectorAll('.setup-fuel-pill[data-setup-fuel]').forEach((b) => {
            b.classList.toggle('active', b.getAttribute('data-setup-fuel') === fuel);
          });
        }
      });
    });

    // Settings Form Save
    const settingsForm = document.getElementById('settingsForm');
    if (settingsForm) {
      settingsForm.addEventListener('submit', (e) => this.handleSettingsSubmit(e));
    }

    // Use Current GPS Location as Fallback Button
    const btnUseCurrentGps = document.getElementById('btnUseCurrentGps');
    if (btnUseCurrentGps) {
      btnUseCurrentGps.addEventListener('click', () => this.handleUseCurrentGpsAsFallback());
    }

    // Export, Backup, Restore & Reset Buttons
    const btnExportCsv = document.getElementById('btnExportCsv');
    if (btnExportCsv) {
      btnExportCsv.addEventListener('click', () => this.handleExportCsv());
    }

    const btnBackup = document.getElementById('btnBackupShare');
    if (btnBackup) {
      btnBackup.addEventListener('click', () => this.handleBackupShare());
    }

    const btnRestore = document.getElementById('btnRestore');
    const fileRestore = document.getElementById('fileRestoreInput');
    if (btnRestore && fileRestore) {
      btnRestore.addEventListener('click', () => fileRestore.click());
      fileRestore.addEventListener('change', (e) => this.handleRestoreFile(e));
    }

    const btnClearHistory = document.getElementById('btnClearHistory');
    if (btnClearHistory) {
      btnClearHistory.addEventListener('click', () => this.handleClearHistory());
    }
  }

  initSwipeNavigation() {
    const viewport = document.getElementById('tabsViewport');
    if (!viewport) return;

    let startX = 0;
    let startY = 0;
    let isTracking = false;

    viewport.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') {
        isTracking = false;
        return;
      }
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      isTracking = true;
    }, { passive: true });

    viewport.addEventListener('touchend', (e) => {
      if (!isTracking || e.changedTouches.length !== 1) return;
      isTracking = false;

      const dx = e.changedTouches[0].clientX - startX;
      const dy = e.changedTouches[0].clientY - startY;

      if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        if (dx < 0 && this.activeTabIndex < 2) {
          this.switchTabByIndex(this.activeTabIndex + 1);
        } else if (dx > 0 && this.activeTabIndex > 0) {
          this.switchTabByIndex(this.activeTabIndex - 1);
        }
      }
    }, { passive: true });
  }

  switchTabByIndex(index) {
    const clamped = Math.max(0, Math.min(2, index));
    this.activeTabIndex = clamped;

    const track = document.getElementById('tabsTrack');
    if (track) {
      track.style.transform = `translateX(-${clamped * 33.333333}%)`;
    }

    document.querySelectorAll('.nav-tab[data-index]').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.getAttribute('data-index')) === clamped);
    });
  }

  // --- GPS & Fuel Price Fetching ---

  async refreshGpsAndFetchPrices({ silentGpsFallback = false } = {}) {
    if (this.isFetching) return;
    this.showAllStations = false;
    this.updateGpsToolbarStatus('loading', 'GPS wird geortet…');

    try {
      const coords = await FuelApiService.getCurrentPosition();
      this.currentLocation = {
        lat: coords.lat,
        lng: coords.lng,
        accuracy: coords.accuracy,
        headingDeg: coords.headingDeg ?? null,
        speedMps: coords.speedMps ?? null,
        isLiveGps: true,
        updatedAt: new Date()
      };
      this.updateGpsToolbarStatus('active', `GPS aktiv (±${coords.accuracy}m)`);
    } catch (gpsErr) {
      const [fbLat, fbLng] = (this.config.fallbackRegion || '52.5200,13.4050').split(',').map(Number);
      this.currentLocation = {
        lat: !isNaN(fbLat) ? fbLat : 52.5200,
        lng: !isNaN(fbLng) ? fbLng : 13.4050,
        accuracy: null,
        headingDeg: null,
        speedMps: null,
        isLiveGps: false,
        updatedAt: new Date()
      };
      this.updateGpsToolbarStatus('fallback', 'Fallback-Ort aktiv');
      if (!silentGpsFallback) {
        this.showToast(gpsErr.message);
      }
    }

    await this.fetchPricesForCurrentLocation();
  }

  getTravelContext() {
    return {
      lat: this.currentLocation.lat,
      lng: this.currentLocation.lng,
      headingDeg: this.currentLocation.headingDeg,
      showAll: this.showAllStations
    };
  }

  async fetchPricesForCurrentLocation() {
    this.isFetching = true;
    try {
      const res = await FuelApiService.fetchStations({
        lat: this.currentLocation.lat,
        lng: this.currentLocation.lng,
        radiusKm: 15,
        apiKey: this.config.apiKey,
        demoMode: this.config.demoMode
      });

      this.stations = res.stations || [];
      this.dataSource = res.source;

      // Save statistical price snapshots in IndexedDB + ensure 14-day history for nearby stations
      if (this.stations.length > 0) {
        const now = new Date();
        // Check if our current nearby stations already have multi-day history in IndexedDB
        const nearbyIds = new Set(this.stations.map((s) => s.id));
        const existingNearbySnaps = (this.snapshots || []).filter((s) => nearbyIds.has(s.station_id));

        if (existingNearbySnaps.length < 30) {
          const backfill14d = FuelApiService.buildLocation14DayHistory(this.stations, 14, now);
          await db.saveHistoricalRecordsBatch(backfill14d);
        }

        // Also sync any background-collected snapshots from data/price_history.json if present
        await this.syncOptionalServerHistory();

        await db.saveSnapshotsBatch(this.stations, now);
        this.snapshots = await db.getAllSnapshots();
      }

      const timeStr = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
      const fuelShort = FUEL_LABELS[this.fuelType] || 'E10';
      const routeHint = this.currentLocation.headingDeg !== null ? ' · Route' : '';
      this.updateGpsToolbarStatus('ready', `${fuelShort}${routeHint} · ${timeStr}`);
      if (res.rateLimited && res.waitSec) {
        this.showToast(`Rate-Limit-Schutz aktiv (Cache genutzt, nächster Live-Abruf in ${res.waitSec}s)`);
      }

      // Populate opening details for simulated stations if in demo mode
      if (this.dataSource === 'demo' || !this.config.apiKey) {
        for (const st of this.stations) {
          if (!this.stationDetailsMap.has(st.id) && st.id.startsWith('sim-')) {
            this.stationDetailsMap.set(st.id, FuelApiService.getSimulatedDetail(st.id));
          }
        }
      }

      // Silently ensure #1 station (and top closed station) has cached opening hours
      const rankingNow = PriceEngine.rankStations(
        this.stations,
        this.fuelType,
        this.sortMode,
        this.favoritesSet,
        this.radiusKm,
        this.config.tankVolume,
        this.config.consumption,
        this.getTravelContext()
      );
      const topFirst = rankingNow.list[0];
      if (topFirst && !this.stationDetailsMap.has(topFirst.id)) {
        this.loadAndCacheStationOpeningHours(topFirst.id, { userInitiated: false });
      }
      const firstClosed = rankingNow.list.find((s) => !s.isOpen);
      if (firstClosed && !this.stationDetailsMap.has(firstClosed.id)) {
        this.loadAndCacheStationOpeningHours(firstClosed.id, { userInitiated: false });
      }
    } catch (apiErr) {
      console.error('Fuel API Error:', apiErr);
      this.showToast(`API-Hinweis: ${apiErr.message}`);
      // Fallback to simulation so user is never left with an empty screen while driving
      const simStations = FuelApiService.generateSimulatedStations(
        this.currentLocation.lat,
        this.currentLocation.lng,
        15
      );
      this.stations = simStations;
      this.dataSource = 'demo';
      for (const st of this.stations) {
        if (!this.stationDetailsMap.has(st.id) && st.id.startsWith('sim-')) {
          this.stationDetailsMap.set(st.id, FuelApiService.getSimulatedDetail(st.id));
        }
      }
    } finally {
      this.isFetching = false;
      this.renderAll();
    }
  }

  async syncOptionalServerHistory() {
    try {
      const resp = await fetch('./data/price_history.json', { cache: 'no-store' });
      if (!resp.ok) return;
      const payload = await resp.json();
      if (payload && Array.isArray(payload.snapshots) && payload.snapshots.length > 0) {
        await db.saveHistoricalRecordsBatch(payload.snapshots);
      }
    } catch {
      // Optional background collector file not present yet — safely ignore
    }
  }

  /**
   * Loads exact opening/closing hours for a station and caches them in IndexedDB (`station_details`).
   * Automatically refreshes cached entries older than 7 days (`isStale`).
   */
  async loadAndCacheStationOpeningHours(stationId, { userInitiated = false } = {}) {
    let existing = this.stationDetailsMap.get(stationId);
    const stationObj = this.stations.find((s) => s.id === stationId);
    const isClosed = Boolean(stationObj && !stationObj.isOpen);

    // Auto-repair cached details lacking openingLabel
    if (existing && !existing.openingLabel) {
      existing.openingLabel = FuelApiService.extractOpeningTimeLabel(existing.wholeDay, existing.openingTimes);
      if (stationId === 'sim-bft-04') existing.openingLabel = '07:30';
      this.stationDetailsMap.set(stationId, existing);
      db.saveStationDetail(existing).catch(() => {});
    }

    if (existing && !existing.isStale && existing.openingLabel) {
      if (userInitiated) {
        let label;
        if (isClosed) {
          const openTime = (existing.openingLabel && existing.openingLabel !== '24h') ? existing.openingLabel : (stationId === 'sim-bft-04' ? '07:30' : '08:00');
          label = `Geschlossen · Öffnet um ${openTime} Uhr`;
        } else if (existing.closingLabel === '24h') {
          label = '24h durchgehend geöffnet';
        } else if (existing.closingLabel) {
          label = `Geöffnet bis ${existing.closingLabel} Uhr`;
        } else {
          label = 'Öffnungszeiten gespeichert';
        }
        this.showToast(label);
        this.renderAll();
      }
      return existing;
    }

    try {
      const detail = await FuelApiService.fetchStationDetail({
        stationId,
        apiKey: this.config.apiKey,
        demoMode: this.config.demoMode
      });
      if (detail) {
        const saved = await db.saveStationDetail(detail);
        this.stationDetailsMap.set(stationId, { ...saved, isStale: false });
        this.renderAll();
        if (userInitiated) {
          let msg;
          if (isClosed) {
            const openTime = (detail.openingLabel && detail.openingLabel !== '24h') ? detail.openingLabel : (stationId === 'sim-bft-04' ? '07:30' : '08:00');
            msg = `Geschlossen · Öffnet um ${openTime} Uhr`;
          } else if (detail.closingLabel === '24h') {
            msg = '24h durchgehend geöffnet';
          } else if (detail.closingLabel) {
            msg = `Geöffnet bis ${detail.closingLabel} Uhr`;
          } else {
            msg = 'Öffnungszeiten aktualisiert';
          }
          this.showToast(msg);
        }
      }
      return detail;
    } catch (err) {
      if (userInitiated) {
        this.showToast(err.message || 'Öffnungszeiten momentan nicht abrufbar');
      }
      return null;
    }
  }

  /**
   * Formats the quiet open/closed indicator for a station card (`● Offen (24h)` / `● Bis 22:00` vs `○ Öffnet 08:00` / `○ Geschlossen`).
   */
  formatOpenStatusHtml(st) {
    const detail = this.stationDetailsMap.get(st.id);
    let openingLabel = detail?.openingLabel;
    let closingLabel = detail?.closingLabel;

    // Fallback migration if cached detail was missing openingLabel
    if (detail && !openingLabel) {
      openingLabel = FuelApiService.extractOpeningTimeLabel(detail.wholeDay, detail.openingTimes);
      if (st.id === 'sim-bft-04') openingLabel = '07:30';
      detail.openingLabel = openingLabel;
    }

    // Direct simulation fallback for demo stations
    if (!openingLabel && String(st.id).startsWith('sim-')) {
      const simDet = FuelApiService.getSimulatedDetail(st.id);
      openingLabel = simDet.openingLabel;
      closingLabel = simDet.closingLabel;
    }

    if (!st.isOpen) {
      const effectiveOpen = (openingLabel && openingLabel !== '24h') ? openingLabel : (st.id === 'sim-bft-04' ? '07:30' : '08:00');
      if (effectiveOpen) {
        return `<span class="meta-status-closed">○ Öffnet ${this.escapeHtml(effectiveOpen)}</span>`;
      }
      return `<span class="meta-status-closed">○ Geschlossen</span>`;
    }

    if (closingLabel) {
      if (closingLabel === '24h') {
        return `<span class="meta-status-open">● Offen (24h)</span>`;
      }
      return `<span class="meta-status-open">● Bis ${this.escapeHtml(closingLabel)}</span>`;
    }
    return `<span class="meta-status-open">● Offen</span>`;
  }

  updateGpsToolbarStatus(stateOrIcon, text) {
    const btnEl = document.getElementById('btnRefreshGps');
    const textEl = document.getElementById('gpsStatusText');
    const isLocating = stateOrIcon === '⏳' || stateOrIcon === 'loading';
    if (btnEl) {
      btnEl.classList.toggle('is-locating', isLocating);
    }
    if (textEl && text) {
      textEl.textContent = text;
    }
  }

  // --- Rendering ---

  renderAll() {
    const ranking = PriceEngine.rankStations(
      this.stations,
      this.fuelType,
      this.sortMode,
      this.favoritesSet,
      this.radiusKm,
      this.config.tankVolume,
      this.config.consumption,
      this.getTravelContext()
    );

    const nearbyIds = new Set(this.stations.map((s) => s.id));
    const localSnapshots = nearbyIds.size > 0
      ? this.snapshots.filter((s) => nearbyIds.has(s.station_id))
      : this.snapshots;

    const forecast = PriceEngine.computeForecastAndStats(
      localSnapshots.length > 0 ? localSnapshots : this.snapshots,
      ranking,
      this.fuelType,
      this.config.tankVolume,
      new Date()
    );

    this.renderRadarForecastBar(forecast);
    this.renderStationsList(ranking);
    this.renderForecastAndStatsTab(ranking, forecast);
  }

  renderRadarForecastBar(forecast) {
    const barEl = document.getElementById('btnRadarForecastBar');
    const textEl = document.getElementById('radarForecastText');
    const metaEl = document.getElementById('radarForecastMeta');
    if (!barEl || !textEl || !metaEl) return;

    barEl.className = `radar-forecast-bar signal-${forecast.signal}`;
    textEl.textContent = forecast.headline;

    if (forecast.signal === 'wait' && forecast.potentialEveningSaving >= 0.5) {
      const savStr = forecast.potentialEveningSaving.toFixed(2).replace('.', ',');
      metaEl.textContent = `Abends −${savStr} € ›`;
    } else if (forecast.signal === 'optimal') {
      metaEl.textContent = `Bestzeit aktiv ›`;
    } else {
      metaEl.textContent = `Bestzeit 18–20h ›`;
    }
  }

  renderStationsList(ranking) {
    const container = document.getElementById('stationsList');
    if (!container) return;

    if (!ranking.list || ranking.list.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          Aktuell keine Tankstellen im erweiterten Suchkorridor gefunden.<br>
          Tippe oben links auf GPS aktualisieren.
        </div>
      `;
      return;
    }

    const cardsHtml = ranking.list.map((st) => {
      const priceFmt = PriceEngine.formatPriceParts(st.activePrice);
      const gmaps = FuelApiService.getGoogleMapsLinks(st);
      const isWinner =
        this.sortMode === 'smart'
          ? Boolean(st.isBestSmart && st.isOpen)
          : this.sortMode === 'price'
            ? Boolean(st.isCheapest && st.isOpen)
            : Boolean(st.rank === 1 && st.isOpen && (st.isBestSmart || st.isCheapest));

      const distRawStr = `${st.dist.toFixed(1).replace('.', ',')} km`;
      let distHtml = distRawStr;
      if (typeof st.relBearingDeg === 'number') {
        const aheadClass = st.routeStatus === 'ahead' ? 'is-ahead' : st.routeStatus === 'behind' ? 'is-behind' : '';
        distHtml = `<span class="meta-dist-wrap"><svg class="route-dir-svg ${aheadClass}" style="transform:rotate(${st.relBearingDeg}deg)" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg><span>${distRawStr}</span></span>`;
      }

      // Show ONLY city/place (no street address), fallback if place is missing
      const placeStr = st.place || (st.street ? st.street : 'In der Nähe');
      const openStatusHtml = this.formatOpenStatusHtml(st);

      const statusItems = [openStatusHtml];
      if (st.routeStatus === 'ahead') {
        statusItems.push(`<span class="meta-route-ahead">Auf Route</span>`);
      }

      if (st.isWorthwhileDetour) {
        const netSavStr = st.netSavingVsNearest.toFixed(2).replace('.', ',');
        statusItems.push(`<span class="meta-worthwhile">Lohnt sich: −${netSavStr} € netto</span>`);
      } else if (st.isNearestOpen && st.diffToBestNet <= 0.15) {
        statusItems.push(`<span class="meta-nearest-tag">Nächste · Optimal</span>`);
      } else if (st.isNearestOpen) {
        statusItems.push(`<span class="meta-nearest-tag">Nächste Station</span>`);
      } else if (this.sortMode === 'smart' && st.diffToBestNet > 0.15) {
        const extraNetCost = st.diffToBestNet.toFixed(2).replace('.', ',');
        statusItems.push(`<span class="meta-extra-cost">+${extraNetCost} € (${this.config.tankVolume}L)</span>`);
      } else if (st.diffToMin > 0.001) {
        const extraTankCost = (st.diffToMin * this.config.tankVolume).toFixed(2).replace('.', ',');
        statusItems.push(`<span class="meta-extra-cost">+${extraTankCost} € (${this.config.tankVolume}L)</span>`);
      }

      const statusLineHtml = statusItems.filter(Boolean).join('<span class="meta-dot">·</span>');

      // Optional top banner if #1 station is a worthwhile detour further away than the nearest station
      let topDetourBannerHtml = '';
      if (st.rank === 1 && st.isWorthwhileDetour && st.extraDistOneWay >= 0.5) {
        const netStr = st.netSavingVsNearest.toFixed(2).replace('.', ',');
        const extraDistStr = st.extraDistOneWay.toFixed(1).replace('.', ',');
        topDetourBannerHtml = `
          <div class="detour-tip-banner">
            <span style="display:inline-flex;align-items:center;gap:4px;">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="13 17 18 12 13 7"></polyline>
                <polyline points="6 17 11 12 6 7"></polyline>
              </svg>
              <span>+${extraDistStr} km lohnt sich nach Sprit-Abzug</span>
            </span>
            <span class="detour-net-pill">−${netStr} € (${this.config.tankVolume}L)</span>
          </div>
        `;
      }

      return `
        <article class="station-card ${isWinner ? 'is-winner' : ''} ${!st.isOpen ? 'is-closed' : ''}" data-station-id="${this.escapeHtml(st.id)}" title="Antippen, um genaue Schließzeit zu prüfen">
          ${topDetourBannerHtml}
          <div class="station-top-row">
            <div class="station-info">
              <div class="station-brand">${this.escapeHtml(st.brand || st.name)}</div>
              <div class="station-line-loc">
                <span class="station-place">${this.escapeHtml(placeStr)}</span>
                <span class="meta-dot">·</span>
                <span class="station-dist">${distHtml}</span>
              </div>
              <div class="station-line-status">${statusLineHtml}</div>
            </div>

            <div class="station-price-box">
              <div class="price-digits">
                <span>${priceFmt.main}</span>
                <span class="price-tenths">${priceFmt.tenths}</span>
                <span class="price-unit">€</span>
              </div>
            </div>
          </div>

          <div class="station-actions-row">
            <a href="${gmaps.navigateUrl}" target="_blank" rel="noopener noreferrer" class="btn-gmaps-route" title="Direkt in Google Maps dorthin navigieren">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polygon points="3 11 22 2 13 21 11 13 3 11"></polygon>
              </svg>
              <span>Route starten</span>
            </a>

            <a href="${gmaps.mapViewUrl}" target="_blank" rel="noopener noreferrer" class="btn-gmaps-pin" title="Pin auf Google Maps Karte zeigen">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
                <circle cx="12" cy="10" r="3"></circle>
              </svg>
              <span>Pin</span>
            </a>
          </div>
        </article>
      `;
    });

    if (ranking.hiddenCount > 0) {
      cardsHtml.push(`
        <button type="button" class="btn-show-more-stations" id="btnShowMoreStations">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
          <span>+${ranking.hiddenCount} weitere Tankstellen im Korridor zeigen</span>
        </button>
      `);
    }

    container.innerHTML = cardsHtml.join('');
  }

  renderForecastAndStatsTab(ranking, forecast) {
    const fuelTitleEl = document.getElementById('statsFuelTitle');
    if (fuelTitleEl) {
      fuelTitleEl.textContent = `${FUEL_LABELS[this.fuelType]} Prognose`;
    }

    // Recommendation Hero Banner
    const heroEl = document.getElementById('recommendationHero');
    const windowEl = document.getElementById('recBestWindow');
    const headlineEl = document.getElementById('recHeadline');
    const sublineEl = document.getElementById('recSubline');

    if (heroEl) {
      heroEl.className = `recommendation-hero signal-${forecast.signal}`;
    }
    if (windowEl) windowEl.textContent = `Bestzeit: ${forecast.bestWindowText}`;
    if (headlineEl) headlineEl.textContent = forecast.headline;
    if (sublineEl) sublineEl.textContent = forecast.subline;

    // Summary Strip
    const minEl = document.getElementById('histMinVal');
    const avgEl = document.getElementById('histAvgVal');
    const countEl = document.getElementById('histSnapCount');

    if (minEl) minEl.textContent = PriceEngine.formatPriceParts(forecast.histMin).fullText;
    if (avgEl) avgEl.textContent = PriceEngine.formatPriceParts(forecast.histAvg).fullText;
    if (countEl) countEl.textContent = String(forecast.snapshotCount);

    // 1. Hourly Bar Chart (06h - 22h)
    const hourlyGrid = document.getElementById('hourlyChartGrid');
    if (hourlyGrid) {
      const nowHour = new Date().getHours();
      hourlyGrid.innerHTML = forecast.hourlySlots.map((slot) => {
        const isCurrentBucket = Math.abs(nowHour - slot.hour) <= 1;
        const pFmt = PriceEngine.formatPriceParts(slot.price);
        return `
          <div class="hour-col ${slot.isBestWindow || slot.isLowest ? 'is-best' : ''} ${isCurrentBucket ? 'is-now' : ''}">
            <span class="hour-price-tag">${pFmt.main}⁹</span>
            <div class="hour-bar-track">
              <div class="hour-bar-fill" style="height: ${slot.barHeightPct}%;"></div>
            </div>
            <span class="hour-label">${slot.label}</span>
          </div>
        `;
      }).join('');
    }

    // 2. Weekday Trend Grid (Mo - So)
    const weekdayGrid = document.getElementById('weekdayChartGrid');
    if (weekdayGrid) {
      const minDayAvg = Math.min(...forecast.weekdayStats.map((d) => d.avg));
      weekdayGrid.innerHTML = forecast.weekdayStats.map((d) => {
        const isCheapest = Math.abs(d.avg - minDayAvg) < 0.003;
        const pFmt = PriceEngine.formatPriceParts(d.avg);
        return `
          <div class="weekday-cell ${isCheapest ? 'is-cheapest-day' : ''}">
            <span class="weekday-name">${d.label}</span>
            <span class="weekday-val">${pFmt.main}⁹</span>
          </div>
        `;
      }).join('');
    }

    // 3. Tank Cost & Intraday Swing Check (Fills bottom space with concrete Euro numbers)
    const tankTitleEl = document.getElementById('tankCheckTitle');
    const tankSpreadHintEl = document.getElementById('tankCheckSpreadHint');
    const tankGridEl = document.getElementById('tankCheckGrid');

    if (tankTitleEl) {
      tankTitleEl.textContent = `Tankfüllung-Check (${this.config.tankVolume} L)`;
    }

    if (tankGridEl) {
      const liters = this.config.tankVolume;
      const nowPrice = ranking.minPrice || forecast.histAvg || 1.659;
      const evePrice = forecast.eveningExpectedMin || nowPrice;
      const slotPrices = (forecast.hourlySlots || []).map((s) => s.price);
      const morningPeakPrice = slotPrices.length > 0 ? Math.max(...slotPrices) : nowPrice + 0.08;
      const dailySwingCents = Math.max(1, Math.round((morningPeakPrice - evePrice) * 100));
      const maxSavingEuro = Math.max(0, (morningPeakPrice - evePrice) * liters).toFixed(2).replace('.', ',');

      if (tankSpreadHintEl) {
        tankSpreadHintEl.textContent = `Ø ${dailySwingCents} ct/L Spanne (−${maxSavingEuro} €)`;
      }

      const costNow = (nowPrice * liters).toFixed(2).replace('.', ',');
      const costEve = (evePrice * liters).toFixed(2).replace('.', ',');
      const costPeak = (morningPeakPrice * liters).toFixed(2).replace('.', ',');
      const diffEve = Math.max(0, (nowPrice - evePrice) * liters).toFixed(2).replace('.', ',');

      tankGridEl.innerHTML = `
        <div class="tank-check-cell">
          <span class="tank-check-label">Jetzt (#1)</span>
          <span class="tank-check-val">${costNow} €</span>
          <span class="tank-check-sub">${PriceEngine.formatPriceParts(nowPrice).fullText}/L</span>
        </div>

        <div class="tank-check-cell is-best-cost">
          <span class="tank-check-label">Abends (19h)</span>
          <span class="tank-check-val">${costEve} €</span>
          <span class="tank-check-sub">${Number(diffEve.replace(',', '.')) > 0.1 ? `−${diffEve} € sparen` : 'Bestpreis'}</span>
        </div>

        <div class="tank-check-cell">
          <span class="tank-check-label">Morgens (07h)</span>
          <span class="tank-check-val">${costPeak} €</span>
          <span class="tank-check-sub">Teuerste Phase</span>
        </div>
      `;
    }

    // 4. Historical Station Ranking List (Tab 2: Ranking Subview)
    const topListEl = document.getElementById('topStationsHistoryList');
    if (topListEl) {
      if (!forecast.topHistoricalStations || forecast.topHistoricalStations.length === 0) {
        topListEl.innerHTML = `
          <div class="empty-state">
            Noch keine historischen Stationsdaten für ${FUEL_LABELS[this.fuelType]} erfasst.
          </div>
        `;
      } else {
        topListEl.innerHTML = forecast.topHistoricalStations.map((item, idx) => {
          const liveStation = this.stations.find((s) => s.id === item.stationId);
          const stObj = liveStation || {
            id: item.stationId,
            name: item.name,
            brand: item.name,
            place: item.place,
            street: item.street,
            houseNumber: item.houseNumber,
            lat: item.lat,
            lng: item.lng,
            dist: item.dist,
            isOpen: true
          };

          const avgFmt = PriceEngine.formatPriceParts(item.avgPrice);
          const minFmt = PriceEngine.formatPriceParts(item.minPrice);
          const gmaps = FuelApiService.getGoogleMapsLinks(stObj);
          const openStatusHtml = liveStation ? this.formatOpenStatusHtml(liveStation) : '';
          const distStr = typeof stObj.dist === 'number' && stObj.dist > 0 ? `${stObj.dist.toFixed(1).replace('.', ',')} km` : '';
          const placeStr = stObj.place || stObj.street || '';

          const metaParts = [
            openStatusHtml,
            distStr ? `<span>${this.escapeHtml(distStr)}</span>` : '',
            placeStr ? `<span>${this.escapeHtml(placeStr)}</span>` : '',
            `<span>Tief: ${minFmt.fullText}</span>`,
            `<span>${item.samples}×</span>`
          ].filter(Boolean).join(' · ');

          const stationName = liveStation ? (liveStation.brand || liveStation.name) : item.name;

          return `
            <div class="hist-station-row" data-station-id="${this.escapeHtml(item.stationId || '')}" title="Antippen, um genaue Öffnungszeiten zu prüfen">
              <div class="hist-station-left">
                <div class="hist-station-name">#${idx + 1} · ${this.escapeHtml(stationName)}</div>
                <div class="hist-station-meta">${metaParts}</div>
              </div>
              <div class="hist-station-right">
                <div class="hist-price-badge">Ø ${avgFmt.fullText}</div>
                <a href="${gmaps.mapViewUrl}" target="_blank" rel="noopener noreferrer" class="btn-gmaps-pin btn-hist-pin" title="Pin auf Google Maps Karte zeigen" onclick="event.stopPropagation();">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
                    <circle cx="12" cy="10" r="3"></circle>
                  </svg>
                  <span>Pin</span>
                </a>
              </div>
            </div>
          `;
        }).join('');
      }
    }
  }

  // --- Settings & Export Handlers ---

  async handleSettingsSubmit(e) {
    e.preventDefault();
    const tankVolume = Math.max(10, Math.min(150, Number(document.getElementById('settingTankVolume')?.value) || 50));
    const consumption = Math.max(2.0, Math.min(25.0, Number(document.getElementById('settingConsumption')?.value) || 7.0));
    const apiKey = String(document.getElementById('settingApiKey')?.value || '').trim();
    const demoMode = Boolean(document.getElementById('settingDemoMode')?.checked);
    const defaultFuel = document.getElementById('settingDefaultFuel')?.value || 'e10';
    const fallbackRegion = document.getElementById('settingFallbackRegion')?.value || '52.5200,13.4050';

    this.config = { apiKey, demoMode, tankVolume, consumption, defaultFuel, fallbackRegion };
    this.fuelType = defaultFuel;

    await Promise.all([
      db.setSetting('tankVolume', tankVolume),
      db.setSetting('consumption', consumption),
      db.setSetting('apiKey', apiKey),
      db.setSetting('demoMode', demoMode),
      db.setSetting('defaultFuel', defaultFuel),
      db.setSetting('fallbackRegion', fallbackRegion)
    ]);

    this.syncControlsUI();
    this.showToast('Einstellungen gespeichert');
    await this.refreshGpsAndFetchPrices({ silentGpsFallback: true });
    this.switchTabByIndex(0);
  }

  async handleUseCurrentGpsAsFallback() {
    const btn = document.getElementById('btnUseCurrentGps');
    const originalHtml = btn ? btn.innerHTML : '';
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span>Ortung…</span>';
    }

    try {
      let coords;
      if (this.currentLocation.isLiveGps && this.currentLocation.lat && this.currentLocation.lng) {
        coords = { lat: this.currentLocation.lat, lng: this.currentLocation.lng };
      } else {
        coords = await FuelApiService.getCurrentPosition();
        this.currentLocation.lat = coords.lat;
        this.currentLocation.lng = coords.lng;
        this.currentLocation.accuracy = coords.accuracy;
        this.currentLocation.isLiveGps = true;
        this.currentLocation.updatedAt = new Date();
      }

      const val = `${coords.lat.toFixed(4)},${coords.lng.toFixed(4)}`;
      const selRegion = document.getElementById('settingFallbackRegion');
      if (selRegion) {
        let customOpt = selRegion.querySelector('#optCustomFallback');
        if (!customOpt) {
          customOpt = document.createElement('option');
          customOpt.id = 'optCustomFallback';
          selRegion.insertBefore(customOpt, selRegion.firstChild);
        }
        customOpt.value = val;
        customOpt.textContent = `Mein Standort (${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)})`;
        selRegion.value = val;
      }

      this.config.fallbackRegion = val;
      await db.setSetting('fallbackRegion', val);

      this.showToast(`Standort als Fallback gespeichert (${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)})`);
    } catch (err) {
      this.showToast(err.message || 'GPS-Standort konnte nicht ermittelt werden.');
    } finally {
      if (btn) {
        btn.innerHTML = originalHtml;
        btn.disabled = false;
      }
    }
  }

  async handleExportCsv() {
    try {
      const count = await ExportService.exportSnapshotsCsv();
      this.showToast(`CSV exportiert (${count} Messwerte)`);
    } catch (err) {
      this.showToast('CSV-Export fehlgeschlagen');
    }
  }

  async handleBackupShare() {
    try {
      const res = await ExportService.backupAndShare();
      if (res.success) {
        this.showToast(res.method === 'share' ? 'Backup geteilt' : 'Backup heruntergeladen');
      }
    } catch (err) {
      this.showToast('Backup fehlgeschlagen');
    }
  }

  async handleRestoreFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await ExportService.restoreFromJsonFile(file);
      await this.loadSettingsAndData();
      this.syncControlsUI();
      this.renderAll();
      this.showToast('Backup erfolgreich eingelesen');
    } catch (err) {
      this.showToast(err.message || 'Fehler beim Einlesen');
    } finally {
      e.target.value = '';
    }
  }

  async handleClearHistory() {
    await db.clearAllSnapshots();
    this.snapshots = [];
    this.renderAll();
    this.showToast('Preis-Statistik zurückgesetzt');
  }

  showToast(message) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'toast-msg';
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
      el.remove();
    }, 2600);
  }

  escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch((err) => {
        console.warn('SW registration skipped:', err);
      });
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const app = new ZapfyApp();
  app.init();
});

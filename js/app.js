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

    // Drive Mode & Continuous Auto-Radar State
    this.gpsWatchId = null;
    this.lastFetchLocation = null;
    this.wakeLock = null;
    this.lastLocalUiUpdateMs = 0;

    // Car-Cockpit UX State (v2.0)
    this.hudMode = false;
    this.themeMode = 'auto'; // 'auto' | 'dark' | 'light'
    this.skippedStationIds = new Set();
    this.savingsTotal = 0;
    this.fillCount = 0;
    this.savingsUndoStack = [];
    this.resetSavingsConfirmTimer = null;

    // Home ("Haus-und-Hof") Reference Station State
    this.homeStation = null;
    this.homeStationPrice = null;
    this.homeSearchResults = [];
    this.homeSearchPlaceLabel = '';
    this.homeSearchFilter = '';
  }

  async init() {
    await db.init();
    await this.loadSettingsAndData();
    this.applyTheme();

    this.bindEvents();
    this.initSwipeNavigation();
    this.syncControlsUI();

    // Immediately render cached/initial state, then acquire GPS & live prices on startup
    this.renderAll();
    await this.refreshGpsAndFetchPrices({ silentGpsFallback: true });

    // Activate Drive Mode (continuous low-cost GPS watch + screen wake lock for car phone mount)
    this.startDriveModeWatcher();
    this.initScreenWakeLock();
    this.initVisibilityListener();

    this.registerServiceWorker();
  }

  async loadSettingsAndData() {
    const [
      apiKey, demoMode, tankVolume, consumption, defaultFuel, fallbackRegion, sortMode,
      themeMode, savingsTotal, fillCount, homeStation, favorites, snapshots, detailsMap
    ] = await Promise.all([
      db.getSetting('apiKey', ''),
      db.getSetting('demoMode', false),
      db.getSetting('tankVolume', 50),
      db.getSetting('consumption', 7.0),
      db.getSetting('defaultFuel', 'e10'),
      db.getSetting('fallbackRegion', '52.5200,13.4050'),
      db.getSetting('sortMode', 'smart'),
      db.getSetting('themeMode', 'auto'),
      db.getSetting('savingsTotal', 0),
      db.getSetting('fillCount', 0),
      db.getSetting('homeStation', null),
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
    this.themeMode = ['auto', 'dark', 'light'].includes(themeMode) ? themeMode : 'auto';
    this.savingsTotal = Math.max(0, Number(savingsTotal) || 0);
    this.fillCount = Math.max(0, Math.floor(Number(fillCount) || 0));

    const [fbLat, fbLng] = this.config.fallbackRegion.split(',').map(Number);
    if (!isNaN(fbLat) && !isNaN(fbLng)) {
      this.currentLocation.lat = fbLat;
      this.currentLocation.lng = fbLng;
    }

    this.favoritesSet = new Set((favorites || []).map((f) => f.id));
    this.homeStation = homeStation && homeStation.id ? homeStation : null;
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
    // Sort Pills (Smart / Preis / Nähe)
    document.querySelectorAll('.sort-pill[data-sort]').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-sort') === this.sortMode);
    });

    // Drive-HUD Toggle
    const hudBtn = document.getElementById('btnToggleHud');
    if (hudBtn) {
      hudBtn.classList.toggle('is-active', this.hudMode);
      hudBtn.setAttribute('aria-pressed', String(this.hudMode));
    }

    // Savings Trophy Counters
    this.renderSavingsBadge();

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

    // Savings Trophy Pill -> Jumps to Tab 2 (Prognose & Spar-Konto)
    const btnSavingsBadge = document.getElementById('btnSavingsBadge');
    if (btnSavingsBadge) {
      btnSavingsBadge.addEventListener('click', () => {
        this.switchTabByIndex(1);
      });
    }

    const btnUndoLastTanked = document.getElementById('btnUndoLastTanked');
    if (btnUndoLastTanked) {
      btnUndoLastTanked.addEventListener('click', () => this.handleUndoSavings());
    }

    const btnResetSavings = document.getElementById('btnResetSavings');
    if (btnResetSavings) {
      btnResetSavings.addEventListener('click', () => this.handleResetSavingsClick());
    }

    // Drive-HUD Focus Mode Toggle
    const btnToggleHud = document.getElementById('btnToggleHud');
    if (btnToggleHud) {
      btnToggleHud.addEventListener('click', () => {
        this.hudMode = !this.hudMode;
        this.syncControlsUI();
        this.renderAll();
      });
    }

    // Tag-/Nacht-Cockpit Toggle
    const btnToggleNight = document.getElementById('btnToggleNight');
    if (btnToggleNight) {
      btnToggleNight.addEventListener('click', async () => {
        const currentlyDark = document.documentElement.classList.contains('theme-dark');
        this.themeMode = currentlyDark ? 'light' : 'dark';
        this.applyTheme();
        await db.setSetting('themeMode', this.themeMode);
        this.showToast(currentlyDark ? 'Tag-Ansicht aktiviert' : 'Nacht-Cockpit aktiviert');
      });
    }

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

    // Delegated Click on Station Card / Hero Actions / Alternative Row
    const stationsList = document.getElementById('stationsList');
    if (stationsList) {
      stationsList.addEventListener('click', async (e) => {
        const tankedBtn = e.target.closest('#btnHeroTanked');
        if (tankedBtn) {
          await this.handleMarkTanked(
            tankedBtn.getAttribute('data-station-id'),
            Number(tankedBtn.getAttribute('data-gain')) || 0
          );
          return;
        }
        const skipBtn = e.target.closest('#btnHeroSkip');
        if (skipBtn) {
          this.handleSkipStation(skipBtn.getAttribute('data-station-id'));
          return;
        }
        const resetSkipsBtn = e.target.closest('#btnResetSkips');
        if (resetSkipsBtn) {
          this.skippedStationIds.clear();
          this.renderAll();
          return;
        }
        const showMoreBtn = e.target.closest('#btnShowMoreStations');
        if (showMoreBtn) {
          this.showAllStations = true;
          this.renderAll();
          return;
        }
        const homeToggleBtn = e.target.closest('.btn-home-toggle');
        if (homeToggleBtn) {
          const stId = homeToggleBtn.getAttribute('data-station-id');
          if (stId) {
            if (this.homeStation && this.homeStation.id === stId) {
              await this.clearHomeStation();
            } else {
              const st = this.stations.find((s) => s.id === stId);
              if (st) await this.setHomeStation(st);
            }
          }
          return;
        }
        // Ignore clicks on Google Maps buttons so navigation opens immediately
        if (e.target.closest('a, button')) return;
        const cardEl = e.target.closest('[data-station-id]');
        if (!cardEl) return;

        const stId = cardEl.getAttribute('data-station-id');
        if (!stId) return;
        await this.loadAndCacheStationOpeningHours(stId, { userInitiated: true });
      });
    }

    // Delegated Click inside Drive-HUD Panel
    const driveHudPanel = document.getElementById('driveHudPanel');
    if (driveHudPanel) {
      driveHudPanel.addEventListener('click', (e) => {
        const hudSkipBtn = e.target.closest('#btnHudSkip');
        if (hudSkipBtn) {
          this.handleSkipStation(hudSkipBtn.getAttribute('data-station-id'));
        }
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

    // Home Reference Banner -> Jump to Setup Tab
    const homeRefBanner = document.getElementById('homeRefBanner');
    if (homeRefBanner) {
      homeRefBanner.addEventListener('click', () => this.switchTabByIndex(2));
    }

    // Home Station Setup Box (Search by PLZ/City, Filter, Pick, Clear)
    const btnSearchHome = document.getElementById('btnSearchHomeStation');
    if (btnSearchHome) {
      btnSearchHome.addEventListener('click', () => this.handleSearchHomeStation());
    }
    const homeSearchInput = document.getElementById('homeStationSearchInput');
    if (homeSearchInput) {
      homeSearchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.handleSearchHomeStation();
        }
      });
    }
    const homeSetupBox = document.getElementById('homeStationSetupBox');
    if (homeSetupBox) {
      homeSetupBox.addEventListener('click', async (e) => {
        const clearBtn = e.target.closest('#btnClearHomeStation');
        if (clearBtn) {
          await this.clearHomeStation();
          return;
        }
        const pickBtn = e.target.closest('.btn-pick-home-station');
        if (pickBtn) {
          const stId = pickBtn.getAttribute('data-station-id');
          const sourceList = [...(this.homeSearchResults || []), ...this.getKnownLocalStations(), ...(this.stations || [])];
          const found = sourceList.find((s) => s.id === stId);
          if (found) {
            await this.setHomeStation(found);
          }
        }
      });
      homeSetupBox.addEventListener('input', (e) => {
        if (e.target && e.target.id === 'homeResultFilterInput') {
          this.homeSearchFilter = e.target.value || '';
          this.renderHomeSearchResults();
        }
      });
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
    this.skippedStationIds.clear();
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
      showAll: this.showAllStations,
      skippedIds: this.skippedStationIds
    };
  }

  async fetchPricesForCurrentLocation({ silent = false } = {}) {
    this.isFetching = true;
    try {
      // Fast drive / highway detection -> dynamically expand corridor to 25 km
      const isFastDrive = (typeof this.currentLocation.speedMps === 'number' && this.currentLocation.speedMps >= 14) || this.currentLocation.headingDeg !== null;
      const corridorRad = isFastDrive ? 25 : 15;

      const res = await FuelApiService.fetchStations({
        lat: this.currentLocation.lat,
        lng: this.currentLocation.lng,
        radiusKm: corridorRad,
        apiKey: this.config.apiKey,
        demoMode: this.config.demoMode
      });

      this.stations = res.stations || [];
      this.dataSource = res.source;

      // Refresh remote home station price in parallel (uses nearby station directly if in range)
      await this.refreshHomeStationPrice({ silent: true });

      // Anchor last fetch location & timestamp for smart drive-mode triggering
      this.lastFetchLocation = {
        lat: this.currentLocation.lat,
        lng: this.currentLocation.lng,
        isLiveGps: Boolean(this.currentLocation.isLiveGps),
        timestamp: Date.now()
      };

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
      if (!silent && res.rateLimited && res.waitSec) {
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
      if (!silent) {
        this.showToast(`API-Hinweis: ${apiErr.message}`);
      }
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

  // --- Auto-Radar & Drive-Mode Management ---

  startDriveModeWatcher() {
    if (this.gpsWatchId !== null) return;
    this.gpsWatchId = FuelApiService.startLocationWatch(
      (coords) => this.handleDriveGpsTick(coords),
      (err) => {
        console.warn('Drive-Mode GPS Watch Warning:', err.message);
      }
    );
  }

  stopDriveModeWatcher() {
    if (this.gpsWatchId !== null) {
      FuelApiService.stopLocationWatch(this.gpsWatchId);
      this.gpsWatchId = null;
    }
  }

  async handleDriveGpsTick(coords) {
    if (!coords || typeof coords.lat !== 'number' || typeof coords.lng !== 'number') return;

    // Suppress stationary GPS jitter (< 80 meters)
    const movedKm = FuelApiService.calculateDistanceKm(
      this.currentLocation.lat,
      this.currentLocation.lng,
      coords.lat,
      coords.lng
    );

    if (movedKm < 0.08) return;

    // Update current location with live GPS coordinates, heading, speed
    this.currentLocation = {
      lat: coords.lat,
      lng: coords.lng,
      accuracy: coords.accuracy,
      headingDeg: coords.headingDeg ?? this.currentLocation.headingDeg,
      speedMps: coords.speedMps ?? this.currentLocation.speedMps,
      isLiveGps: true,
      updatedAt: new Date()
    };

    // Stufe 1: Zero-Cost Local UI Update (re-evaluates live distances & ahead/behind status, max every 2.5s)
    const now = Date.now();
    if (now - this.lastLocalUiUpdateMs >= 2500) {
      this.lastLocalUiUpdateMs = now;
      const timeStr = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
      const fuelShort = FUEL_LABELS[this.fuelType] || 'E10';
      const routeHint = this.currentLocation.headingDeg !== null ? ' · Route' : '';
      this.updateGpsToolbarStatus('ready', `${fuelShort}${routeHint} · ${timeStr}`);
      this.renderAll();
    }

    // Stufe 2: Evaluate API-Refetch Gatekeeper
    await this.evaluateAutoApiRefetch(coords);
  }

  async evaluateAutoApiRefetch(coords) {
    if (this.isFetching) return;

    if (!this.lastFetchLocation) {
      this.lastFetchLocation = {
        lat: coords.lat,
        lng: coords.lng,
        isLiveGps: Boolean(this.currentLocation.isLiveGps),
        timestamp: Date.now()
      };
      return;
    }

    const tokenState = FuelApiService.peekTokenState();
    if (tokenState.isBlocked) return;

    // Edge-Case Fix: First true GPS fix after cold launch with fallback location -> fetch immediately for true location
    const wasFallbackLaunch = !this.lastFetchLocation.isLiveGps && this.currentLocation.isLiveGps;
    if (wasFallbackLaunch && tokenState.ready) {
      await this.fetchPricesForCurrentLocation({ silent: true });
      return;
    }

    const distSinceFetchKm = FuelApiService.calculateDistanceKm(
      this.lastFetchLocation.lat,
      this.lastFetchLocation.lng,
      coords.lat,
      coords.lng
    );
    const elapsedMs = Date.now() - this.lastFetchLocation.timestamp;

    // Trigger matrix
    const isHighwayPace = distSinceFetchKm >= 5.0;
    const isNormalDrive = distSinceFetchKm >= 2.5;
    const isLongStop = elapsedMs >= 15 * 60 * 1000;

    let shouldFetch = false;

    if (isHighwayPace) {
      // With >= 2 tokens: allow fast refetch at 3.5 min; otherwise standard 4.5 min
      const minIntervalMs = tokenState.tokens >= 2.0 ? 3.5 * 60 * 1000 : 4.5 * 60 * 1000;
      shouldFetch = elapsedMs >= minIntervalMs && tokenState.ready;
    } else if (isNormalDrive) {
      shouldFetch = elapsedMs >= 4.5 * 60 * 1000 && tokenState.ready;
    } else if (isLongStop) {
      // Stationary price refresh (rest area / traffic jam > 15 min)
      shouldFetch = tokenState.ready;
    }

    if (shouldFetch) {
      await this.fetchPricesForCurrentLocation({ silent: true });
    }
  }

  async initScreenWakeLock() {
    this.wakeLock = await FuelApiService.requestScreenWakeLock();
    if (this.wakeLock) {
      this.wakeLock.addEventListener('release', () => {
        this.wakeLock = null;
      });
    }
  }

  async releaseScreenWakeLock() {
    if (this.wakeLock && typeof this.wakeLock.release === 'function') {
      try {
        await this.wakeLock.release();
      } catch { /* ignore */ }
      this.wakeLock = null;
    }
  }

  initVisibilityListener() {
    document.addEventListener('visibilitychange', async () => {
      if (document.hidden) {
        // App put into background (e.g. driver switched to Google Maps) -> save battery
        this.stopDriveModeWatcher();
        await this.releaseScreenWakeLock();
      } else {
        // Driver returned to Zapfy -> re-acquire screen wake lock & GPS watch
        await this.initScreenWakeLock();
        this.startDriveModeWatcher();
        // Check immediate refetch if significant distance/time elapsed while in background
        if (this.currentLocation.isLiveGps) {
          await this.evaluateAutoApiRefetch(this.currentLocation);
        }
      }
    });
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

  // --- Theme, Savings & Drive-HUD Helpers ---

  applyTheme() {
    const hour = new Date().getHours();
    const systemDark = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const isDark =
      this.themeMode === 'dark'
        ? true
        : this.themeMode === 'light'
          ? false
          : (hour >= 19 || hour < 6 || systemDark);

    document.documentElement.classList.toggle('theme-dark', isDark);

    const metaTheme = document.getElementById('metaThemeColor');
    if (metaTheme) {
      metaTheme.setAttribute('content', isDark ? '#0b1120' : '#e6edf6');
    }

    const nightIcon = document.getElementById('nightToggleIcon');
    if (nightIcon) {
      nightIcon.textContent = isDark ? '☀️' : '🌙';
    }
  }

  computeStationSavingGain(st) {
    if (!st || typeof st.netSavingVsNearest !== 'number') return 0;
    return Number(Math.max(0, st.netSavingVsNearest).toFixed(2));
  }

  pushSavingsUndoSnapshot() {
    this.savingsUndoStack.push({
      prevTotal: this.savingsTotal,
      prevCount: this.fillCount
    });
    if (this.savingsUndoStack.length > 20) {
      this.savingsUndoStack.shift();
    }
  }

  async persistSavingsState() {
    await Promise.all([
      db.setSetting('savingsTotal', this.savingsTotal),
      db.setSetting('fillCount', this.fillCount)
    ]);
  }

  clearResetSavingsConfirm() {
    if (this.resetSavingsConfirmTimer) {
      clearTimeout(this.resetSavingsConfirmTimer);
      this.resetSavingsConfirmTimer = null;
    }
    const resetBtn = document.getElementById('btnResetSavings');
    if (resetBtn) {
      delete resetBtn.dataset.confirming;
      resetBtn.classList.remove('is-confirming');
      resetBtn.textContent = 'Zurücksetzen';
    }
  }

  async handleMarkTanked(stationId, savingGain) {
    const gain = Math.max(0, Number(savingGain) || 0);
    this.pushSavingsUndoSnapshot();
    this.clearResetSavingsConfirm();
    this.savingsTotal = Number((this.savingsTotal + gain).toFixed(2));
    this.fillCount += 1;

    await this.persistSavingsState();

    this.renderSavingsBadge({ bump: true });
    this.renderAll();

    const msg = gain > 0.05
      ? `🎉 +${gain.toFixed(2).replace('.', ',')} € gespart! Spar-Topf: ${this.savingsTotal.toFixed(2).replace('.', ',')} €`
      : `✓ Tankvorgang verbucht (${this.fillCount}×)`;

    this.showToast(msg, {
      actionLabel: 'Rückgängig',
      durationMs: 5000,
      onAction: () => this.handleUndoSavings()
    });
  }

  async handleUndoSavings() {
    const snapshot = this.savingsUndoStack.pop();
    if (!snapshot) return;

    this.clearResetSavingsConfirm();
    this.savingsTotal = Math.max(0, Number(snapshot.prevTotal) || 0);
    this.fillCount = Math.max(0, Math.floor(Number(snapshot.prevCount) || 0));

    await this.persistSavingsState();
    this.renderSavingsBadge({ bump: true });
    this.renderAll();
    this.showToast('✓ Letzte Spar-Konto-Änderung rückgängig');
  }

  async handleResetSavingsClick() {
    if (this.savingsTotal <= 0 && this.fillCount <= 0) return;
    const resetBtn = document.getElementById('btnResetSavings');
    if (!resetBtn) return;

    if (resetBtn.dataset.confirming !== '1') {
      resetBtn.dataset.confirming = '1';
      resetBtn.classList.add('is-confirming');
      resetBtn.textContent = 'Wirklich 0 €?';
      if (this.resetSavingsConfirmTimer) {
        clearTimeout(this.resetSavingsConfirmTimer);
      }
      this.resetSavingsConfirmTimer = setTimeout(() => {
        this.clearResetSavingsConfirm();
      }, 3500);
      return;
    }

    this.clearResetSavingsConfirm();
    this.pushSavingsUndoSnapshot();
    this.savingsTotal = 0;
    this.fillCount = 0;

    await this.persistSavingsState();
    this.renderSavingsBadge();
    this.renderAll();
    this.showToast('Spar-Konto auf 0,00 € zurückgesetzt', {
      actionLabel: 'Rückgängig',
      durationMs: 5000,
      onAction: () => this.handleUndoSavings()
    });
  }

  handleSkipStation(stationId) {
    if (!stationId) return;
    this.skippedStationIds.add(stationId);
    const { skipsReset } = this.renderAll();
    this.showToast(skipsReset ? 'Alle Tankstellen wieder eingeblendet' : 'Nächste Tankstelle ausgewählt');
  }

  renderSavingsBadge({ bump = false } = {}) {
    const totalStr = `${this.savingsTotal.toFixed(2).replace('.', ',')} €`;
    const headerEl = document.getElementById('headerSavingsTotal');
    if (headerEl) headerEl.textContent = totalStr;

    const pillEl = document.getElementById('btnSavingsBadge');
    if (pillEl && bump) {
      pillEl.classList.remove('is-bumping');
      void pillEl.offsetWidth;
      pillEl.classList.add('is-bumping');
    }

    const statsTotalEl = document.getElementById('statsSavingsTotal');
    const statsAvgEl = document.getElementById('statsSavingsAvg');
    const statsCountEl = document.getElementById('statsFillCountHint');
    if (statsTotalEl) statsTotalEl.textContent = totalStr;
    if (statsCountEl) statsCountEl.textContent = `${this.fillCount}× getankt`;
    if (statsAvgEl) {
      const avg = this.fillCount > 0 ? this.savingsTotal / this.fillCount : 0;
      statsAvgEl.textContent = `${avg.toFixed(2).replace('.', ',')} €`;
    }

    const canUndo = this.savingsUndoStack.length > 0;
    const canReset = this.savingsTotal > 0 || this.fillCount > 0;
    const actionsRow = document.getElementById('savingsActionsRow');
    const undoBtn = document.getElementById('btnUndoLastTanked');
    const resetBtn = document.getElementById('btnResetSavings');
    if (undoBtn) undoBtn.hidden = !canUndo;
    if (resetBtn) {
      resetBtn.hidden = !canReset;
      if (!canReset) this.clearResetSavingsConfirm();
    }
    if (actionsRow) actionsRow.hidden = !canUndo && !canReset;
  }

  buildDistArrowHtml(st, { size = 13 } = {}) {
    const distRawStr = `${st.dist.toFixed(1).replace('.', ',')} km`;
    if (typeof st.relBearingDeg !== 'number') {
      return `<span>${distRawStr}</span>`;
    }
    const aheadClass = st.routeStatus === 'ahead' ? 'is-ahead' : st.routeStatus === 'behind' ? 'is-behind' : '';
    return `<span class="meta-dist-wrap"><svg class="route-dir-svg ${aheadClass}" style="transform:rotate(${st.relBearingDeg}deg)" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg><span>${distRawStr}</span></span>`;
  }

  // --- Rendering ---

  renderAll() {
    let skipsReset = false;
    let ranking = PriceEngine.rankStations(
      this.stations,
      this.fuelType,
      this.sortMode,
      this.favoritesSet,
      this.radiusKm,
      this.config.tankVolume,
      this.config.consumption,
      this.getTravelContext()
    );

    if (ranking.list.length === 0 && this.skippedStationIds.size > 0 && ranking.totalRelevantCount > 0) {
      this.skippedStationIds.clear();
      skipsReset = true;
      ranking = PriceEngine.rankStations(
        this.stations,
        this.fuelType,
        this.sortMode,
        this.favoritesSet,
        this.radiusKm,
        this.config.tankVolume,
        this.config.consumption,
        this.getTravelContext()
      );
    }

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

    const listEl = document.getElementById('stationsList');
    const hudEl = document.getElementById('driveHudPanel');
    if (listEl) listEl.hidden = this.hudMode;
    if (hudEl) hudEl.hidden = !this.hudMode;

    this.renderRadarForecastBar(forecast);
    this.renderSavingsBadge();
    this.renderHomeRefBanner();
    this.renderStationsList(ranking);
    this.renderDriveHud(ranking);
    this.renderForecastAndStatsTab(ranking, forecast);
    this.renderHomeStationSetup();
    return { skipsReset };
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
      metaEl.textContent = `Bestzeit ›`;
    } else {
      metaEl.textContent = `18–20h ›`;
    }
  }

  getHomeComparison(st) {
    if (!this.homeStation || !this.homeStationPrice || !st) return null;
    if (st.id === this.homeStation.id) {
      return { isSelf: true };
    }
    const homePrice = Number(this.homeStationPrice[this.fuelType]);
    if (!Number.isFinite(homePrice) || homePrice <= 0 || !Number.isFinite(st.activePrice)) {
      return null;
    }
    const deltaEur = st.activePrice - homePrice;
    const deltaCents = deltaEur * 100;
    const tankDiffEur = deltaEur * this.config.tankVolume;
    return {
      isSelf: false,
      homePrice,
      deltaEur,
      deltaCents,
      tankDiffEur,
      isCheaper: deltaEur <= -0.005,
      isPricier: deltaEur >= 0.005
    };
  }

  buildHomeDeltaBadgeHtml(st, { compact = false } = {}) {
    const cmp = this.getHomeComparison(st);
    if (!cmp) return '';
    if (cmp.isSelf) {
      return '<span class="home-delta-badge is-home">🏠 Stamm-Tanke</span>';
    }

    const absCents = Math.abs(cmp.deltaCents);
    const centsStr = compact ? absCents.toFixed(0) : absCents.toFixed(1).replace('.', ',');
    const absTankStr = Math.abs(cmp.tankDiffEur).toFixed(2).replace('.', ',');

    if (cmp.isCheaper) {
      return `<span class="home-delta-badge is-cheaper" title="Günstiger als deine Haus-und-Hof-Tankstelle">🏠 −${centsStr} ct (−${absTankStr} €)</span>`;
    }
    if (cmp.isPricier) {
      return compact
        ? `<span class="home-delta-badge is-pricier">🏠 +${centsStr} ct</span>`
        : `<span class="home-delta-badge is-pricier">🏠 +${centsStr} ct vs. daheim</span>`;
    }
    return '<span class="home-delta-badge is-equal">🏠 = daheim</span>';
  }

  buildHeroStationHtml(st, ranking, isWinner) {
    const priceFmt = PriceEngine.formatPriceParts(st.activePrice);
    const gmaps = FuelApiService.getGoogleMapsLinks(st);
    const placeStr = st.place || (st.street ? st.street : 'In der Nähe');
    const distHtml = this.buildDistArrowHtml(st, { size: 14 });
    const openStatusHtml = this.formatOpenStatusHtml(st);
    const savingGain = this.computeStationSavingGain(st);
    const savingStr = savingGain.toFixed(2).replace('.', ',');

    let dealBadgeText = '★ Top-Empfehlung';
    let dealNeutral = false;
    if (st.isWorthwhileDetour && st.netSavingVsNearest > 0) {
      dealBadgeText = `⚡ Bester Deal · −${st.netSavingVsNearest.toFixed(2).replace('.', ',')} € netto`;
    } else if (st.isNearestOpen && st.diffToBestNet <= 0.15) {
      dealBadgeText = '⚡ Nächste · Optimal';
    } else if (savingGain > 0.25) {
      dealBadgeText = `★ Günstigste · −${savingStr} € vs. Nächste`;
    } else if (!isWinner) {
      dealBadgeText = '📍 Nächste Option';
      dealNeutral = true;
    }

    const statusItems = [];
    if (st.routeStatus === 'ahead') {
      statusItems.push(`<span class="meta-route-ahead">Auf Route</span>`);
    }
    statusItems.push(`<span>${this.escapeHtml(placeStr)}</span>`);
    if (st.extraDistOneWay >= 0.5 && st.isWorthwhileDetour) {
      statusItems.push(`<span class="meta-worthwhile">+${st.extraDistOneWay.toFixed(1).replace('.', ',')} km Umweg</span>`);
    }
    const statusLineHtml = statusItems.join('<span class="meta-dot">·</span>');

    const tankedLabel = savingGain > 0.05
      ? `✓ Hier getankt (+${savingStr} €)`
      : '✓ Hier getankt';
    const isHomeSt = Boolean(this.homeStation && this.homeStation.id === st.id);
    const homeDeltaHtml = this.buildHomeDeltaBadgeHtml(st, { compact: false });

    return `
      <article class="station-card is-hero ${isWinner ? 'is-winner' : ''} ${!st.isOpen ? 'is-closed' : ''}" data-station-id="${this.escapeHtml(st.id)}" title="Antippen, um genaue Schließzeit zu prüfen">
        <div class="hero-badge-row">
          <span class="hero-deal-pill ${dealNeutral ? 'is-neutral' : ''}">${dealBadgeText}</span>
          <span class="hero-open-label ${!st.isOpen ? 'is-closed' : ''}">${openStatusHtml}</span>
        </div>

        <div class="station-top-row">
          <div class="station-info">
            <div class="station-brand">${this.escapeHtml(st.brand || st.name)}</div>
            <div class="station-line-loc">
              <span class="station-dist">${distHtml}</span>
              <span class="meta-dot">·</span>
              <span class="station-place">${this.escapeHtml(FUEL_LABELS[this.fuelType] || 'Kraftstoff')}</span>
            </div>
            <div class="station-line-status">${statusLineHtml}</div>
            ${homeDeltaHtml ? `<div class="hero-home-delta-row">${homeDeltaHtml}</div>` : ''}
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
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="3 11 22 2 13 21 11 13 3 11"></polygon>
            </svg>
            <span>Route starten</span>
          </a>

          <button type="button" class="btn-home-toggle ${isHomeSt ? 'is-active' : ''}" data-station-id="${this.escapeHtml(st.id)}" title="${isHomeSt ? 'Als Haus-und-Hof-Tankstelle entfernen' : 'Als Haus-und-Hof-Tankstelle festlegen'}" aria-label="Als Stamm-Tankstelle festlegen">
            🏠
          </button>

          <a href="${gmaps.mapViewUrl}" target="_blank" rel="noopener noreferrer" class="btn-gmaps-pin" title="Pin auf Google Maps Karte zeigen" aria-label="Pin auf Karte zeigen">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
              <circle cx="12" cy="10" r="3"></circle>
            </svg>
          </a>
        </div>

        <div class="hero-delight-row">
          <button type="button" class="btn-hero-tanked" id="btnHeroTanked" data-station-id="${this.escapeHtml(st.id)}" data-gain="${savingGain}">
            <span>${tankedLabel}</span>
          </button>
          <button type="button" class="btn-hero-skip" id="btnHeroSkip" data-station-id="${this.escapeHtml(st.id)}" title="Diese Station überspringen und nächste anzeigen">
            <span>✕ Nächste</span>
          </button>
        </div>
      </article>
    `;
  }

  buildAltStationHtml(st) {
    const priceFmt = PriceEngine.formatPriceParts(st.activePrice);
    const gmaps = FuelApiService.getGoogleMapsLinks(st);
    const openStatusHtml = this.formatOpenStatusHtml(st);
    const distStr = `${st.dist.toFixed(1).replace('.', ',')} km`;
    const arrowDeg = typeof st.relBearingDeg === 'number' ? st.relBearingDeg : 0;
    const hasArrow = typeof st.relBearingDeg === 'number';

    let deltaHtml = '';
    if (this.sortMode === 'smart' && st.diffToBestNet > 0.15) {
      deltaHtml = `<span class="meta-extra-cost">+${st.diffToBestNet.toFixed(2).replace('.', ',')} €</span>`;
    } else if (st.diffToMin > 0.001) {
      const extraTank = (st.diffToMin * this.config.tankVolume).toFixed(2).replace('.', ',');
      deltaHtml = `<span class="meta-extra-cost">+${extraTank} €</span>`;
    }

    const isHomeSt = Boolean(this.homeStation && this.homeStation.id === st.id);
    const homeDeltaHtml = this.buildHomeDeltaBadgeHtml(st, { compact: true });

    const metaHtml = [
      `<span>${distStr}</span>`,
      openStatusHtml,
      st.routeStatus === 'ahead' ? `<span class="meta-route-ahead">Route</span>` : '',
      deltaHtml
    ].filter(Boolean).join('<span class="meta-dot">·</span>');

    return `
      <div class="station-alt-card ${!st.isOpen ? 'is-closed' : ''}" data-station-id="${this.escapeHtml(st.id)}" title="Antippen für genaue Öffnungszeiten">
        <div class="alt-dir-box">
          ${hasArrow
            ? `<svg class="route-dir-svg ${st.routeStatus === 'ahead' ? 'is-ahead' : ''}" style="transform:rotate(${arrowDeg}deg)" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>`
            : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>`
          }
        </div>

        <div class="alt-info">
          <div class="alt-brand-row">
            <span class="alt-brand">${this.escapeHtml(st.brand || st.name)}</span>
            ${homeDeltaHtml}
          </div>
          <div class="alt-meta">${metaHtml}</div>
        </div>

        <div class="alt-right">
          <div class="alt-price">
            <span>${priceFmt.main}</span>
            <span class="alt-price-tenths">${priceFmt.tenths}</span>
          </div>
          <button type="button" class="btn-home-toggle is-compact ${isHomeSt ? 'is-active' : ''}" data-station-id="${this.escapeHtml(st.id)}" title="${isHomeSt ? 'Stamm-Tankstelle entfernen' : 'Als Stamm-Tankstelle festlegen'}" aria-label="Stamm-Tankstelle festlegen">🏠</button>
          <a href="${gmaps.navigateUrl}" target="_blank" rel="noopener noreferrer" class="btn-alt-route" title="Route zu ${this.escapeHtml(st.brand || st.name)} starten" aria-label="Route starten">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="3 11 22 2 13 21 11 13 3 11"></polygon>
            </svg>
          </a>
        </div>
      </div>
    `;
  }

  renderStationsList(ranking) {
    const container = document.getElementById('stationsList');
    if (!container) return;

    if (!ranking.list || ranking.list.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          Aktuell keine Tankstellen im erweiterten Suchkorridor gefunden.<br>
          Tippe unten rechts auf das GPS-Symbol zum Aktualisieren.
        </div>
      `;
      return;
    }

    const hero = ranking.list[0];
    const isHeroWinner =
      this.sortMode === 'smart'
        ? Boolean(hero.isBestSmart && hero.isOpen)
        : this.sortMode === 'price'
          ? Boolean(hero.isCheapest && hero.isOpen)
          : Boolean(hero.isOpen && (hero.isBestSmart || hero.isCheapest));

    const parts = [this.buildHeroStationHtml(hero, ranking, isHeroWinner)];

    const alts = ranking.list.slice(1);
    if (alts.length > 0 || this.skippedStationIds.size > 0) {
      parts.push(`
        <div class="alt-section-header">
          <span class="alt-section-title">Weitere auf deiner Strecke</span>
          ${this.skippedStationIds.size > 0 ? '<button type="button" class="btn-reset-skips" id="btnResetSkips">Alle wieder zeigen</button>' : ''}
        </div>
      `);
    }

    for (const st of alts) {
      parts.push(this.buildAltStationHtml(st));
    }

    if (ranking.hiddenCount > 0) {
      parts.push(`
        <button type="button" class="btn-show-more-stations" id="btnShowMoreStations">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
          <span>+${ranking.hiddenCount} weitere Tankstellen im Korridor zeigen</span>
        </button>
      `);
    }

    container.innerHTML = parts.join('');
  }

  renderDriveHud(ranking) {
    const hudEl = document.getElementById('driveHudPanel');
    if (!hudEl) return;

    const hero = ranking.list && ranking.list[0];
    if (!hero) {
      hudEl.innerHTML = `
        <div class="empty-state">
          Keine Tankstelle für Drive-HUD verfügbar.
        </div>
      `;
      return;
    }

    const priceFmt = PriceEngine.formatPriceParts(hero.activePrice);
    const gmaps = FuelApiService.getGoogleMapsLinks(hero);
    const arrowDeg = typeof hero.relBearingDeg === 'number' ? hero.relBearingDeg : 0;
    const distStr = `${hero.dist.toFixed(1).replace('.', ',')} km`;
    const placeStr = hero.place || (hero.street ? hero.street : '');
    const routeText = hero.routeStatus === 'ahead' ? 'Auf Route voraus' : (placeStr || 'Im Korridor');
    const savingGain = this.computeStationSavingGain(hero);
    const openStatusHtml = this.formatOpenStatusHtml(hero);

    hudEl.innerHTML = `
      <div class="drive-hud-card">
        <div class="hud-top-row">
          <span class="hud-badge">🚗 DRIVE-HUD FOKUS</span>
          <span class="hud-fuel-status">${this.escapeHtml(FUEL_LABELS[this.fuelType] || '')} · ${openStatusHtml}</span>
        </div>

        <div class="hud-center">
          <div class="hud-compass-ring">
            <svg style="transform:rotate(${arrowDeg}deg)" width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="19" x2="12" y2="5"></line>
              <polyline points="5 12 12 5 19 12"></polyline>
            </svg>
          </div>
          <div class="hud-brand">${this.escapeHtml(hero.brand || hero.name)}</div>
          <div class="hud-dist-line">${distStr} · ${this.escapeHtml(routeText)}</div>

          <div class="hud-price-pill">
            <span class="hud-price-main">${priceFmt.main}</span>
            <span class="hud-price-tenths">${priceFmt.tenths}</span>
            <span class="hud-price-unit">€</span>
          </div>

          ${this.buildHomeDeltaBadgeHtml(hero, { compact: false })}
          ${savingGain > 0.25 ? `<div class="hud-saving-tag">💰 −${savingGain.toFixed(2).replace('.', ',')} € Ersparnis (${this.config.tankVolume}L)</div>` : ''}
        </div>

        <div class="hud-actions">
          <a href="${gmaps.navigateUrl}" target="_blank" rel="noopener noreferrer" class="hud-main-btn">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="3 11 22 2 13 21 11 13 3 11"></polygon>
            </svg>
            <span>NAVIGATION STARTEN</span>
          </a>

          <div class="hud-secondary-row">
            <button type="button" class="hud-skip-btn" id="btnHudSkip" data-station-id="${this.escapeHtml(hero.id)}">Nächste Tankstelle ›</button>
            <a href="${gmaps.mapViewUrl}" target="_blank" rel="noopener noreferrer" class="hud-pin-btn">📍 Pin</a>
          </div>
        </div>
      </div>
    `;
  }

  renderForecastAndStatsTab(ranking, forecast) {
    const fuelTitleEl = document.getElementById('statsFuelTitle');
    if (fuelTitleEl) {
      fuelTitleEl.textContent = `${FUEL_LABELS[this.fuelType]} Prognose`;
    }

    // Recommendation Bar (Zero visual noise)
    const heroEl = document.getElementById('recommendationHero');
    const windowEl = document.getElementById('recBestWindow');
    const headlineEl = document.getElementById('recHeadline');
    const sublineEl = document.getElementById('recSubline');

    if (heroEl) {
      heroEl.className = `forecast-status-card signal-${forecast.signal}`;
    }
    if (windowEl) windowEl.textContent = forecast.bestWindowText || '18–20h';
    if (headlineEl) headlineEl.textContent = forecast.headline;
    if (sublineEl) sublineEl.textContent = forecast.subline;

    // 1. Intraday Horizontal Timeline (Replaces intrusive vertical bars)
    const timelineContainer = document.getElementById('hourlyChartGrid');
    const hourlyHintEl = document.getElementById('hourlyChartHint');
    if (hourlyHintEl) {
      hourlyHintEl.textContent = `Bestzeit: ${forecast.bestWindowText || '18–20 Uhr'}`;
    }

    if (timelineContainer && forecast.hourlySlots?.length) {
      const now = new Date();
      const nowHour = now.getHours();
      const nowMin = now.getMinutes();

      // Timeline Scale: 06:00 to 22:00 = 16 hours = 960 minutes
      const startHour = 6;
      const endHour = 22;
      const totalMinutes = (endHour - startHour) * 60; // 960
      const currentMinutesFromStart = Math.max(0, Math.min(totalMinutes, (nowHour - startHour) * 60 + nowMin));
      const nowPct = Math.max(2, Math.min(98, (currentMinutesFromStart / totalMinutes) * 100)).toFixed(1);

      // Best Window: 17:00 to 21:00 (68.75% to 93.75%)
      const bestStartPct = (((17 - startHour) * 60) / totalMinutes * 100).toFixed(1);
      const bestWidthPct = (((21 - 17) * 60) / totalMinutes * 100).toFixed(1);

      // Key Milestones: Morning Peak (08h), Current, Evening Low (19h)
      const morningSlot = forecast.hourlySlots.find((s) => s.hour === 8) || forecast.hourlySlots[1] || forecast.hourlySlots[0];
      const eveningSlot = forecast.hourlySlots.find((s) => s.hour === 18 || s.hour === 20) || forecast.hourlySlots[5] || { price: forecast.eveningExpectedMin || 1.659 };
      const currentSlot = forecast.hourlySlots.find((s) => Math.abs(s.hour - nowHour) <= 1) || { price: ranking.minPrice || morningSlot.price };

      const mPriceFmt = PriceEngine.formatPriceParts(morningSlot.price);
      const cPriceFmt = PriceEngine.formatPriceParts(currentSlot.price);
      const ePriceFmt = PriceEngine.formatPriceParts(eveningSlot.price);

      timelineContainer.innerHTML = `
        <div class="timeline-track-wrap">
          <div class="timeline-track">
            <div class="timeline-best-zone" style="left: ${bestStartPct}%; width: ${bestWidthPct}%;" title="Bestpreis-Fenster"></div>
            <div class="timeline-now-pin" style="left: ${nowPct}%;">
              <span class="timeline-now-label">Jetzt</span>
              <span class="timeline-now-dot"></span>
            </div>
          </div>
          <div class="timeline-scale">
            <span>06:00</span>
            <span>12:00</span>
            <span class="text-emerald">18:00 (Tief)</span>
            <span>22:00</span>
          </div>
        </div>

        <div class="timeline-milestones">
          <div class="timeline-milestone">
            <span class="milestone-label">Morgens</span>
            <span class="milestone-price">${mPriceFmt.fullText}</span>
          </div>
          <div class="timeline-milestone is-now">
            <span class="milestone-label">Aktuell</span>
            <span class="milestone-price">${cPriceFmt.fullText}</span>
          </div>
          <div class="timeline-milestone is-best">
            <span class="milestone-label">Abends (Bestzeit)</span>
            <span class="milestone-price">${ePriceFmt.fullText}</span>
          </div>
        </div>
      `;
    }

    // 2. Weekday Trend Grid (Mo - So, streamlined & calm)
    const weekdayGrid = document.getElementById('weekdayChartGrid');
    const weekdayHintEl = document.getElementById('weekdayTrendHint');

    if (weekdayGrid && forecast.weekdayStats?.length) {
      const minDayAvg = Math.min(...forecast.weekdayStats.map((d) => d.avg));
      const cheapestDay = forecast.weekdayStats.find((d) => Math.abs(d.avg - minDayAvg) < 0.003);

      if (weekdayHintEl && cheapestDay) {
        weekdayHintEl.textContent = `${cheapestDay.label} meist am günstigsten`;
      }

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

    // 3. Historical Station Ranking List (Tab 2: Ranking Subview)
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
      this.applyTheme();
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

  showToast(message, { actionLabel = '', onAction = null, durationMs = 2600 } = {}) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const el = document.createElement('div');
    const hasAction = Boolean(actionLabel && typeof onAction === 'function');
    el.className = hasAction ? 'toast-msg has-action' : 'toast-msg';

    const textEl = document.createElement('span');
    textEl.className = 'toast-text';
    textEl.textContent = message;
    el.appendChild(textEl);

    let timerId = null;
    if (hasAction) {
      const actionBtn = document.createElement('button');
      actionBtn.type = 'button';
      actionBtn.className = 'toast-action-btn';
      actionBtn.textContent = actionLabel;
      let handled = false;
      actionBtn.addEventListener('click', () => {
        if (handled) return;
        handled = true;
        if (timerId) clearTimeout(timerId);
        el.remove();
        onAction();
      });
      el.appendChild(actionBtn);
    }

    container.appendChild(el);
    timerId = setTimeout(() => {
      el.remove();
    }, durationMs);
  }

  // --- Home ("Haus-und-Hof") Reference Station ---

  async refreshHomeStationPrice({ silent = true } = {}) {
    if (!this.homeStation || !this.homeStation.id) {
      this.homeStationPrice = null;
      return;
    }

    const inNearby = (this.stations || []).find((s) => s.id === this.homeStation.id);
    if (inNearby) {
      this.homeStationPrice = {
        status: inNearby.isOpen ? 'open' : 'closed',
        e10: inNearby.e10,
        e5: inNearby.e5,
        diesel: inNearby.diesel,
        fetchedAt: Date.now(),
        source: this.dataSource
      };
      return;
    }

    try {
      const res = await FuelApiService.fetchStationPrices({
        stationIds: [this.homeStation.id],
        apiKey: this.config.apiKey,
        demoMode: this.config.demoMode
      });
      const entry = res.prices && res.prices[this.homeStation.id];
      if (entry) {
        this.homeStationPrice = {
          status: entry.status || 'open',
          e10: typeof entry.e10 === 'number' ? entry.e10 : null,
          e5: typeof entry.e5 === 'number' ? entry.e5 : null,
          diesel: typeof entry.diesel === 'number' ? entry.diesel : null,
          fetchedAt: res.fetchedAt || Date.now(),
          source: res.source
        };
      }
    } catch (err) {
      if (!silent) {
        this.showToast(`Stamm-Tankstelle Preisabruf: ${err.message}`);
      }
    }
  }

  async setHomeStation(stationObj) {
    if (!stationObj || !stationObj.id) return;
    const cleanHome = {
      id: stationObj.id,
      name: stationObj.name || stationObj.brand || 'Stamm-Tankstelle',
      brand: stationObj.brand || stationObj.name || '',
      street: stationObj.street || '',
      houseNumber: stationObj.houseNumber || '',
      postCode: stationObj.postCode || '',
      place: stationObj.place || '',
      lat: Number(stationObj.lat) || null,
      lng: Number(stationObj.lng) || null,
      set_at: new Date().toISOString()
    };

    this.homeStation = cleanHome;
    await db.setSetting('homeStation', cleanHome);
    await this.refreshHomeStationPrice({ silent: true });
    this.renderAll();
    this.showToast(`🏠 Stamm-Tankstelle gesetzt: ${cleanHome.brand || cleanHome.name}`);
  }

  async clearHomeStation() {
    this.homeStation = null;
    this.homeStationPrice = null;
    await db.setSetting('homeStation', null);
    this.renderAll();
    this.showToast('Haus-und-Hof-Tankstelle entfernt');
  }

  getKnownLocalStations() {
    const byId = new Map();
    for (const st of this.stations || []) {
      if (st && st.id && !byId.has(st.id)) {
        byId.set(st.id, st);
      }
    }
    for (let i = (this.snapshots || []).length - 1; i >= 0; i -= 1) {
      const snap = this.snapshots[i];
      if (!snap || !snap.station_id || byId.has(snap.station_id)) continue;
      byId.set(snap.station_id, {
        id: snap.station_id,
        name: snap.station_name || 'Tankstelle',
        brand: snap.station_name || '',
        street: snap.street || '',
        houseNumber: snap.houseNumber || '',
        place: snap.place || '',
        lat: snap.lat || null,
        lng: snap.lng || null
      });
      if (byId.size >= 12) break;
    }
    return Array.from(byId.values());
  }

  renderHomeRefBanner() {
    const bannerEl = document.getElementById('homeRefBanner');
    if (!bannerEl) return;

    if (!this.homeStation) {
      bannerEl.hidden = true;
      bannerEl.innerHTML = '';
      return;
    }

    const label = this.homeStation.brand || this.homeStation.name;
    const placeStr = this.homeStation.place ? ` (${this.homeStation.place})` : '';
    const priceVal = this.homeStationPrice ? Number(this.homeStationPrice[this.fuelType]) : NaN;
    const isClosed = this.homeStationPrice && this.homeStationPrice.status === 'closed';

    let priceHtml = '<span class="home-ref-price-muted">wird geladen…</span>';
    if (isClosed) {
      priceHtml = '<span class="home-ref-price-muted">aktuell geschlossen</span>';
    } else if (Number.isFinite(priceVal) && priceVal > 0) {
      const fmt = PriceEngine.formatPriceParts(priceVal);
      const timeStr = this.homeStationPrice?.fetchedAt
        ? new Date(this.homeStationPrice.fetchedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
        : '';
      priceHtml = `<strong class="home-ref-price">${fmt.main}<sup>${fmt.tenths}</sup> €</strong>${timeStr ? ` <span class="home-ref-time">· ${timeStr}</span>` : ''}`;
    }

    bannerEl.hidden = false;
    bannerEl.innerHTML = `
      <div class="home-ref-left">
        <span class="home-ref-icon" aria-hidden="true">🏠</span>
        <span class="home-ref-name">Daheim: <strong>${this.escapeHtml(label)}</strong>${this.escapeHtml(placeStr)}</span>
      </div>
      <div class="home-ref-right">
        ${priceHtml}
      </div>
    `;
  }

  renderHomeStationSetup() {
    const badgeEl = document.getElementById('homeStationStatusBadge');
    const currentEl = document.getElementById('homeStationCurrentCard');
    const localEl = document.getElementById('homeStationLocalSuggestions');

    if (badgeEl) {
      badgeEl.textContent = this.homeStation ? 'Aktiv' : 'Nicht gesetzt';
      badgeEl.className = `setup-card-badge ${this.homeStation ? 'status-live' : ''}`;
    }

    if (currentEl) {
      if (!this.homeStation) {
        currentEl.hidden = true;
        currentEl.innerHTML = '';
      } else {
        const addr = [
          [this.homeStation.street, this.homeStation.houseNumber].filter(Boolean).join(' '),
          [this.homeStation.postCode, this.homeStation.place].filter(Boolean).join(' ')
        ].filter(Boolean).join(', ');
        const priceVal = this.homeStationPrice ? Number(this.homeStationPrice[this.fuelType]) : NaN;
        const priceStr = Number.isFinite(priceVal) && priceVal > 0
          ? `${PriceEngine.formatPriceParts(priceVal).main}${PriceEngine.formatPriceParts(priceVal).tenths} €`
          : '';

        currentEl.hidden = false;
        currentEl.innerHTML = `
          <div class="home-current-info">
            <div class="home-current-title">🏠 ${this.escapeHtml(this.homeStation.brand || this.homeStation.name)} ${priceStr ? `<span class="home-current-price">${priceStr}</span>` : ''}</div>
            <div class="home-current-addr">${this.escapeHtml(addr || 'Gespeicherte Stamm-Tankstelle')}</div>
          </div>
          <button type="button" class="btn-home-clear" id="btnClearHomeStation" title="Stamm-Tankstelle entfernen">Entfernen</button>
        `;
      }
    }

    if (localEl) {
      const known = this.getKnownLocalStations().filter((s) => !this.homeStation || s.id !== this.homeStation.id);
      if (known.length === 0) {
        localEl.hidden = true;
        localEl.innerHTML = '';
      } else {
        localEl.hidden = false;
        const chips = known.slice(0, 6).map((s) => {
          const title = s.brand || s.name;
          const place = s.place ? ` · ${s.place}` : '';
          return `<button type="button" class="home-suggestion-chip btn-pick-home-station" data-station-id="${this.escapeHtml(s.id)}">🏠 ${this.escapeHtml(title)}${this.escapeHtml(place)}</button>`;
        }).join('');
        localEl.innerHTML = `
          <div class="home-suggestions-label">Schnellwahl aus deinen letzten Stationen:</div>
          <div class="home-suggestions-wrap">${chips}</div>
        `;
      }
    }

    this.renderHomeSearchResults();
  }

  renderHomeSearchResults() {
    const resultsEl = document.getElementById('homeStationSearchResults');
    if (!resultsEl) return;

    if (!this.homeSearchResults || this.homeSearchResults.length === 0) {
      resultsEl.hidden = true;
      resultsEl.innerHTML = '';
      return;
    }

    const filterText = (this.homeSearchFilter || '').trim().toLowerCase();
    const filtered = filterText
      ? this.homeSearchResults.filter((s) => {
          const hay = `${s.brand || ''} ${s.name || ''} ${s.street || ''} ${s.place || ''}`.toLowerCase();
          return hay.includes(filterText);
        })
      : this.homeSearchResults;

    const listHtml = filtered.slice(0, 12).map((s) => {
      const isCurrent = this.homeStation && this.homeStation.id === s.id;
      const addr = [
        [s.street, s.houseNumber].filter(Boolean).join(' '),
        [s.postCode, s.place].filter(Boolean).join(' ')
      ].filter(Boolean).join(', ');
      return `
        <div class="home-search-item ${isCurrent ? 'is-selected' : ''}">
          <div class="home-search-item-info">
            <strong>${this.escapeHtml(s.brand || s.name)}</strong>
            <span>${this.escapeHtml(addr || 'Adresse unbekannt')}</span>
          </div>
          <button type="button" class="btn-pick-home-station ${isCurrent ? 'is-selected' : ''}" data-station-id="${this.escapeHtml(s.id)}">
            ${isCurrent ? '✓ Aktiv' : 'Festlegen'}
          </button>
        </div>
      `;
    }).join('');

    resultsEl.hidden = false;
    resultsEl.innerHTML = `
      <div class="home-search-meta">
        <span>Gefunden bei <strong>${this.escapeHtml(this.homeSearchPlaceLabel)}</strong> (${filtered.length})</span>
      </div>
      <input type="text" class="setting-input home-filter-input" id="homeResultFilterInput" placeholder="Ergebnisse filtern (z. B. JET, Aral, Straße)…" value="${this.escapeHtml(this.homeSearchFilter)}">
      <div class="home-search-list">
        ${listHtml || '<div class="home-search-empty">Keine Tankstelle passt zum Filter.</div>'}
      </div>
    `;
  }

  async handleSearchHomeStation() {
    const inputEl = document.getElementById('homeStationSearchInput');
    const btnEl = document.getElementById('btnSearchHomeStation');
    const query = (inputEl?.value || '').trim();
    if (!query) {
      this.showToast('Bitte PLZ, Ort oder Straße eingeben.');
      return;
    }

    if (btnEl) {
      btnEl.disabled = true;
      btnEl.textContent = 'Suche…';
    }

    try {
      const res = await FuelApiService.searchStationsByPlace({
        query,
        apiKey: this.config.apiKey,
        demoMode: this.config.demoMode
      });
      this.homeSearchResults = res.stations || [];
      this.homeSearchPlaceLabel = res.placeLabel || query;
      this.homeSearchFilter = '';
      this.renderHomeSearchResults();
      if (this.homeSearchResults.length === 0) {
        this.showToast('Keine Tankstellen in diesem Umkreis gefunden.');
      }
    } catch (err) {
      this.showToast(`Suche fehlgeschlagen: ${err.message}`);
    } finally {
      if (btnEl) {
        btnEl.disabled = false;
        btnEl.textContent = 'Suchen';
      }
    }
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

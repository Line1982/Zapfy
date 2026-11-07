/**
 * Zapfy Price Statistics & Forecast Engine (js/price_engine.js)
 * Pure domain calculation module for sorting stations, formatting fractional fuel prices
 * (e.g., 1,68⁹ €), analyzing local IndexedDB price history, and generating actionable
 * refueling recommendations ("Jetzt tanken" vs. "Besser 18–20 Uhr tanken").
 */

import { FuelApiService } from './fuel_api.js';

export class PriceEngine {
  /**
   * Formats a 3-decimal fuel price (e.g. 1.689) into parts for clean ninth-cent superscript rendering.
   */
  static formatPriceParts(price) {
    if (typeof price !== 'number' || isNaN(price) || price <= 0) {
      return { main: '—,--', tenths: '', fullText: '—,-- €', valid: false };
    }
    const fixed = price.toFixed(3); // e.g. "1.689"
    const main = fixed.slice(0, 4).replace('.', ','); // "1,68"
    const tenths = fixed.slice(4, 5); // "9"
    return {
      main,
      tenths,
      fullText: `${main}${tenths === '9' ? '⁹' : tenths} €`,
      valid: true
    };
  }

  /**
   * Calculates compass bearing in degrees [0..360) from coordinate 1 to coordinate 2.
   */
  static calculateBearingDeg(lat1, lng1, lat2, lng2) {
    const phi1 = (lat1 * Math.PI) / 180;
    const phi2 = (lat2 * Math.PI) / 180;
    const dLambda = ((lng2 - lng1) * Math.PI) / 180;
    const y = Math.sin(dLambda) * Math.cos(phi2);
    const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
    const theta = (Math.atan2(y, x) * 180) / Math.PI;
    return (theta + 360) % 360;
  }

  /**
   * Dynamically filters and ranks stations by selected fuel type ('e10', 'e5', 'diesel')
   * and sort mode ('smart', 'price', 'dist', 'fav') without requiring manual radius steps.
   *
   * Core Mechanics:
   * 1. Anchor (`nearestOpenStation`): Guarantees non-empty results whether in the city (0.8 km) or countryside (9 km).
   * 2. Curve-Resistant Heading Corridor: Uses a smooth cosine detour factor `0.85 - 0.55 * cos(deltaAngle)`
   *    when a macro travel heading is present, preferring stations ahead along the route without abrupt angle cutoffs.
   * 3. Economic Worthwhile Filter & Pareto Pruning: Eliminates stations that are further away AND more expensive,
   *    and caps the default view to the top 8 most relevant stations (`showAll` unlocks all).
   */
  static rankStations(
    stations,
    fuelType = 'e10',
    sortMode = 'smart',
    favoritesSet = new Set(),
    radiusKm = 15,
    tankLiters = 50,
    consumptionL100km = 7.0,
    travelContext = null
  ) {
    if (!Array.isArray(stations) || stations.length === 0) {
      return {
        list: [],
        hiddenCount: 0,
        totalRelevantCount: 0,
        openCount: 0,
        totalCount: 0,
        minPrice: null,
        maxPrice: null,
        avgPrice: null,
        spreadPerLiter: 0,
        smartDetour: null,
        effectiveRadiusKm: radiusKm || 5,
        autoExpanded: false,
        hasActiveHeading: false,
        headingDeg: null
      };
    }

    const effectiveTank = Math.max(10, Math.min(150, Number(tankLiters) || 50));
    const effectiveConsumption = Math.max(2.0, Math.min(25.0, Number(consumptionL100km) || 7.0));

    const hasActiveHeading = Boolean(
      travelContext &&
      typeof travelContext.headingDeg === 'number' &&
      !isNaN(travelContext.headingDeg) &&
      typeof travelContext.lat === 'number' &&
      typeof travelContext.lng === 'number'
    );
    const headingDeg = hasActiveHeading ? travelContext.headingDeg : null;
    const showAll = Boolean(travelContext && travelContext.showAll);

    const pricedAll = [];
    const unpricedAll = [];

    for (const st of stations) {
      const price = st[fuelType];
      const isFav = favoritesSet.has(st.id);
      const activePrice = typeof price === 'number' && price > 0 ? price : null;

      let bearingDeg = null;
      let relBearingDeg = null;
      let routeFactor = 1.0;
      let routeStatus = null; // 'ahead' | 'side' | 'behind' | null

      if (hasActiveHeading && typeof st.lat === 'number' && typeof st.lng === 'number' && st.dist >= 0.25) {
        bearingDeg = this.calculateBearingDeg(travelContext.lat, travelContext.lng, st.lat, st.lng);
        relBearingDeg = ((bearingDeg - headingDeg + 540) % 360) - 180; // [-180..+180]
        const absAngle = Math.abs(relBearingDeg);
        // Smooth cosine curve: 0 deg (ahead) -> 0.30x detour, 60 deg -> 0.58x, 90 deg -> 0.85x, 180 deg (behind) -> 1.40x
        routeFactor = Number((0.85 - 0.55 * Math.cos((absAngle * Math.PI) / 180)).toFixed(3));
        if (absAngle <= 50) {
          routeStatus = 'ahead';
        } else if (absAngle <= 115) {
          routeStatus = 'side';
        } else {
          routeStatus = 'behind';
        }
      }

      const effectiveRoundTripKm = Number((2 * st.dist * routeFactor).toFixed(2));
      const enriched = {
        ...st,
        activePrice,
        isFavorite: isFav,
        bearingDeg,
        relBearingDeg: relBearingDeg !== null ? Math.round(relBearingDeg) : null,
        routeFactor,
        routeStatus,
        effectiveRoundTripKm
      };

      if (activePrice !== null) {
        pricedAll.push(enriched);
      } else {
        unpricedAll.push(enriched);
      }
    }

    // 1. Identify Anchor Station (Nearest Open Station by effective distance, fallback to nearest priced)
    let nearestOpenStation = null;
    for (const st of pricedAll) {
      if (st.isOpen) {
        if (
          !nearestOpenStation ||
          st.effectiveRoundTripKm < nearestOpenStation.effectiveRoundTripKm ||
          (st.effectiveRoundTripKm === nearestOpenStation.effectiveRoundTripKm && st.activePrice < nearestOpenStation.activePrice)
        ) {
          nearestOpenStation = st;
        }
      }
    }
    if (!nearestOpenStation && pricedAll.length > 0) {
      nearestOpenStation = [...pricedAll].sort((a, b) => a.dist - b.dist)[0];
    }

    // 2. Determine dynamic base neighborhood radius around the nearest open station
    //    Ensures at least 4 open stations are included as local baseline (whether 1.5 km in city or 12 km rural)
    const dMin = nearestOpenStation ? nearestOpenStation.dist : 3.0;
    let baseRadiusKm = Math.max(3.5, Number((dMin + 2.5).toFixed(1)));
    const countOpenWithin = (rad) => pricedAll.filter((s) => s.isOpen && s.dist <= rad).length;
    for (const stepRad of [5, 7.5, 10, 15, 25]) {
      if (countOpenWithin(baseRadiusKm) >= 4) break;
      if (stepRad > baseRadiusKm && countOpenWithin(stepRad) > countOpenWithin(baseRadiusKm)) {
        baseRadiusKm = stepRad;
      }
    }

    // 3. Compute total tank + detour fuel economics for each station relative to Anchor
    const anchorTripFuelLiters = nearestOpenStation
      ? (nearestOpenStation.effectiveRoundTripKm * effectiveConsumption) / 100
      : 0;
    const anchorTotalCost = nearestOpenStation
      ? (effectiveTank + anchorTripFuelLiters) * nearestOpenStation.activePrice
      : null;

    for (const st of pricedAll) {
      const tripFuelLiters = (st.effectiveRoundTripKm * effectiveConsumption) / 100;
      const detourFuelCost = Number((tripFuelLiters * st.activePrice).toFixed(2));
      const effectiveTotalCost = Number(((effectiveTank + tripFuelLiters) * st.activePrice).toFixed(2));
      const extraDistOneWay = nearestOpenStation
        ? Math.max(0, Number(((st.effectiveRoundTripKm - nearestOpenStation.effectiveRoundTripKm) / 2).toFixed(1)))
        : 0;
      const netSavingVsNearest =
        anchorTotalCost !== null ? Number((anchorTotalCost - effectiveTotalCost).toFixed(2)) : 0;

      st.detourFuelCost = detourFuelCost;
      st.effectiveTotalCost = effectiveTotalCost;
      st.extraDistOneWay = extraDistOneWay;
      st.netSavingVsNearest = netSavingVsNearest;
      st.isNearestOpen = Boolean(nearestOpenStation && st.id === nearestOpenStation.id);
    }

    // 4. Filter: Dynamic Worthwhile Corridor + Pareto Dominance Pruning
    //    A station is Pareto-dominated if another open station is strictly closer (both raw dist and effective route dist)
    //    AND cheaper or equal in price.
    const closestThreeIds = new Set(
      [...pricedAll]
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 3)
        .map((s) => s.id)
    );

    let curatedPriced = pricedAll.filter((st) => {
      if (st.isFavorite || st.isNearestOpen) return true;
      if (sortMode === 'dist' && closestThreeIds.has(st.id)) return true;

      // Pareto check against other open stations
      if (st.isOpen) {
        const isDominated = pricedAll.some(
          (other) =>
            other.id !== st.id &&
            other.isOpen &&
            other.dist <= st.dist - 0.25 &&
            other.effectiveRoundTripKm <= st.effectiveRoundTripKm &&
            other.activePrice <= st.activePrice
        );
        // Outside immediate 1.8 km vicinity, drop strictly dominated stations
        if (isDominated && st.dist > dMin + 1.8) {
          return false;
        }
      } else if (st.dist > baseRadiusKm) {
        // Closed stations outside base neighborhood are irrelevant right now
        return false;
      }

      // Within base neighborhood radius: keep
      if (st.dist <= baseRadiusKm) {
        return true;
      }

      // Outside base neighborhood radius: only include if worthwhile net savings (>= 0.25 €)
      // or directly ahead on route with a lower price
      if (st.isOpen && st.netSavingVsNearest >= 0.25) {
        return true;
      }
      if (st.isOpen && st.routeStatus === 'ahead' && nearestOpenStation && st.activePrice < nearestOpenStation.activePrice) {
        return true;
      }

      return false;
    });

    // Safety fallback: ensure at least 4 stations if available in dataset
    if (curatedPriced.length < Math.min(4, pricedAll.length)) {
      const keptIds = new Set(curatedPriced.map((s) => s.id));
      const byDist = [...pricedAll].sort((a, b) => a.dist - b.dist);
      for (const cand of byDist) {
        if (!keptIds.has(cand.id)) {
          curatedPriced.push(cand);
          keptIds.add(cand.id);
          if (curatedPriced.length >= 4) break;
        }
      }
    }

    // 5. Compute stats (min, max, avg, best net) across the relevant corridor
    let minPrice = null;
    let maxPrice = null;
    let sumPrice = 0;
    let minEffectiveTotalCost = null;

    for (const st of curatedPriced) {
      if (minPrice === null || st.activePrice < minPrice) minPrice = st.activePrice;
      if (maxPrice === null || st.activePrice > maxPrice) maxPrice = st.activePrice;
      if (st.isOpen && (minEffectiveTotalCost === null || st.effectiveTotalCost < minEffectiveTotalCost)) {
        minEffectiveTotalCost = st.effectiveTotalCost;
      }
      sumPrice += st.activePrice;
    }

    const avgPrice = curatedPriced.length > 0 ? Number((sumPrice / curatedPriced.length).toFixed(3)) : null;

    // 6. Sort according to active sortMode ('smart' | 'price' | 'dist' | 'fav')
    curatedPriced.sort((a, b) => {
      if (sortMode === 'fav' && a.isFavorite !== b.isFavorite) {
        return a.isFavorite ? -1 : 1;
      }

      if (sortMode === 'dist') {
        if (a.effectiveRoundTripKm !== b.effectiveRoundTripKm) {
          return a.effectiveRoundTripKm - b.effectiveRoundTripKm;
        }
        return a.activePrice - b.activePrice;
      }

      if (sortMode === 'price') {
        if (a.activePrice !== b.activePrice) return a.activePrice - b.activePrice;
        return a.effectiveRoundTripKm - b.effectiveRoundTripKm;
      }

      // Default 'smart': Open stations first, then lowest effective total cost (tank + detour fuel)
      if (a.isOpen !== b.isOpen) return a.isOpen ? -1 : 1;
      if (a.effectiveTotalCost !== b.effectiveTotalCost) {
        return a.effectiveTotalCost - b.effectiveTotalCost;
      }
      return a.dist - b.dist;
    });

    const rankedAll = curatedPriced.map((st, idx) => {
      const diffToMin = minPrice !== null ? Number((st.activePrice - minPrice).toFixed(3)) : 0;
      const isCheapest = minPrice !== null && Math.abs(st.activePrice - minPrice) < 0.0005;
      const isBestSmart =
        st.isOpen && minEffectiveTotalCost !== null && Math.abs(st.effectiveTotalCost - minEffectiveTotalCost) <= 0.05;
      const diffToBestNet =
        minEffectiveTotalCost !== null ? Number((st.effectiveTotalCost - minEffectiveTotalCost).toFixed(2)) : 0;
      const isWorthwhileDetour = Boolean(
        st.isOpen && !st.isNearestOpen && st.dist > dMin + 0.5 && st.netSavingVsNearest >= 0.4
      );

      return {
        ...st,
        rank: idx + 1,
        isCheapest,
        isBestSmart,
        diffToMin,
        diffToBestNet,
        isWorthwhileDetour
      };
    });

    // 7. Apply Top-8 Cap (unless user clicked "Alle zeigen") to prevent visual overload in cities
    const MAX_VISIBLE = 8;
    const visiblePriced = showAll ? rankedAll : rankedAll.slice(0, MAX_VISIBLE);
    const hiddenCount = Math.max(0, rankedAll.length - visiblePriced.length);

    const maxDisplayedDist = visiblePriced.reduce((acc, s) => Math.max(acc, s.dist || 0), baseRadiusKm);
    const effectiveRadiusKm = Math.max(3, Math.ceil(maxDisplayedDist));
    const openCount = rankedAll.filter((s) => s.isOpen).length;

    return {
      list: visiblePriced,
      hiddenCount,
      totalRelevantCount: rankedAll.length,
      openCount,
      totalCount: rankedAll.length,
      minPrice,
      maxPrice,
      avgPrice,
      spreadPerLiter: minPrice !== null && maxPrice !== null ? Number((maxPrice - minPrice).toFixed(3)) : 0,
      smartDetour: null,
      effectiveRadiusKm,
      autoExpanded: false,
      hasActiveHeading,
      headingDeg
    };
  }

  /**
   * Computes statistical insights and an intelligent refueling prognosis combining:
   * 1. Learned local IndexedDB snapshots (station, hourly, weekday averages)
   * 2. Official German MTS-K intraday cycle knowledge (so forecasts are useful immediately on Day 1)
   */
  static computeForecastAndStats(snapshots, currentRanking, fuelType = 'e10', tankLiters = 50, now = new Date()) {
    const validSnaps = (snapshots || []).filter((s) => typeof s[fuelType] === 'number' && s[fuelType] > 0);
    const currentMin = currentRanking?.minPrice ?? null;
    const currentAvg = currentRanking?.avgPrice ?? null;
    const currentHour = now.getHours();

    // 1. Overall historical min / avg / max for selected fuelType
    let histMin = null;
    let histMax = null;
    let histSum = 0;

    // Hourly buckets (0..23)
    const hourSums = new Array(24).fill(0);
    const hourCounts = new Array(24).fill(0);

    // Weekday buckets (1=Mon..7=Sun)
    const daySums = new Array(8).fill(0);
    const dayCounts = new Array(8).fill(0);

    // Station brand ranking
    const brandMap = new Map();

    for (const s of validSnaps) {
      const p = s[fuelType];
      if (histMin === null || p < histMin) histMin = p;
      if (histMax === null || p > histMax) histMax = p;
      histSum += p;

      const h = Number(s.hour);
      if (h >= 0 && h < 24) {
        hourSums[h] += p;
        hourCounts[h]++;
      }

      const d = Number(s.weekday);
      if (d >= 1 && d <= 7) {
        daySums[d] += p;
        dayCounts[d]++;
      }

      const brandKey = (s.station_name || 'Tankstelle').trim();
      if (!brandMap.has(brandKey)) {
        brandMap.set(brandKey, { name: brandKey, sum: 0, count: 0, min: p });
      }
      const bEntry = brandMap.get(brandKey);
      bEntry.sum += p;
      bEntry.count++;
      if (p < bEntry.min) bEntry.min = p;
    }

    const histAvg = validSnaps.length > 0 ? Number((histSum / validSnaps.length).toFixed(3)) : currentAvg;

    // 2. Build 8 key intraday time slots for the UI chart (06h, 08h, 10h, 12h, 15h, 18h, 20h, 22h)
    const keyHours = [6, 8, 10, 12, 15, 18, 20, 22];
    const baseRef = histAvg || currentAvg || (fuelType === 'diesel' ? 1.589 : 1.689);
    const currentCurveOffset = FuelApiService.getTypicalHourlyOffset(currentHour);
    const normalizedBase = baseRef - currentCurveOffset;

    const hourlySlots = keyHours.map((h) => {
      // Blend learned local data with MTS-K curve if local hour bucket has data
      let slotPrice;
      let isMeasured = false;
      if (hourCounts[h] >= 1) {
        slotPrice = Number((hourSums[h] / hourCounts[h]).toFixed(3));
        isMeasured = true;
      } else {
        slotPrice = Number((normalizedBase + FuelApiService.getTypicalHourlyOffset(h)).toFixed(3));
      }
      return {
        hour: h,
        label: `${String(h).padStart(2, '0')}h`,
        price: slotPrice,
        isMeasured,
        isBestWindow: h === 18 || h === 20
      };
    });

    // Find min & max across slots for bar height scaling
    const slotPrices = hourlySlots.map((s) => s.price);
    const minSlotPrice = Math.min(...slotPrices);
    const maxSlotPrice = Math.max(...slotPrices);
    const slotRange = Math.max(0.04, maxSlotPrice - minSlotPrice);

    for (const slot of hourlySlots) {
      // Height between 24% and 100%
      const ratio = (slot.price - minSlotPrice) / slotRange;
      slot.barHeightPct = Math.round(24 + ratio * 76);
      slot.isLowest = Math.abs(slot.price - minSlotPrice) < 0.005;
    }

    // 3. Build Weekday comparison (Mo - So)
    const weekdayLabels = ['', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
    const weekdayOffsets = [0, -0.005, -0.012, -0.010, 0.0, +0.012, +0.008, +0.015];
    const weekdayStats = [];
    for (let d = 1; d <= 7; d++) {
      const hasData = dayCounts[d] > 0;
      const avg = hasData
        ? Number((daySums[d] / dayCounts[d]).toFixed(3))
        : Number((normalizedBase + weekdayOffsets[d]).toFixed(3));
      weekdayStats.push({
        day: d,
        label: weekdayLabels[d],
        avg,
        count: dayCounts[d],
        hasData
      });
    }

    // 4. Generate Smart Action Recommendation ("Jetzt tanken" vs "Warten bis 18–20 Uhr")
    const eveningExpectedMin = Number(( (currentMin || baseRef) - currentCurveOffset + FuelApiService.getTypicalHourlyOffset(19) ).toFixed(3));
    const expectedDropPerLiter = currentMin !== null ? Number(Math.max(0, currentMin - eveningExpectedMin).toFixed(3)) : 0;
    const potentialEveningSaving = Number((expectedDropPerLiter * tankLiters).toFixed(2));
    const spreadSavingNow = Number(((currentRanking?.spreadPerLiter || 0) * tankLiters).toFixed(2));

    let signal = 'good'; // 'optimal' | 'good' | 'wait'
    let headline = 'Guter Zeitpunkt zum Tanken';
    let subline = 'Preise liegen im normalen Tagesbereich.';
    let bestWindowText = '18:00 – 20:30 Uhr';

    if (currentHour >= 17 && currentHour <= 21) {
      signal = 'optimal';
      headline = 'Jetzt tanken! Abend-Tiefpreisphase aktiv';
      subline = `Zwischen 18 und 21 Uhr sind die Kraftstoffpreise erfahrungsgemäß am tiefsten.`;
    } else if (currentHour >= 5 && currentHour <= 9) {
      signal = 'wait';
      headline = 'Besser warten! Aktuell Morgen-Preisspitze';
      subline = `Abends (18–20 Uhr) sinkt der Preis um ca. ${(expectedDropPerLiter * 100).toFixed(0)} ct/L (≈ ${potentialEveningSaving.toFixed(2).replace('.', ',')} € pro ${tankLiters}L-Tank).`;
    } else if (expectedDropPerLiter >= 0.03) {
      signal = 'wait';
      headline = `Nach Möglichkeit bis 18:00 Uhr warten`;
      subline = `Prognose für heute Abend: ca. ${this.formatPriceParts(eveningExpectedMin).fullText}/L (${(expectedDropPerLiter * 100).toFixed(0)} ct/L günstiger).`;
    } else if (currentMin !== null && histAvg !== null && currentMin <= histAvg - 0.015) {
      signal = 'optimal';
      headline = 'Jetzt günstig! Unter deinem historischen Schnitt';
      subline = `Aktuelles Minimum (${this.formatPriceParts(currentMin).fullText}) liegt unter dem gespeicherten Durchschnitt (${this.formatPriceParts(histAvg).fullText}).`;
    }

    // 5. Top Cheapest Recorded Brands/Stations from History
    const topHistoricalStations = Array.from(brandMap.values())
      .map((b) => ({
        name: b.name,
        avgPrice: Number((b.sum / b.count).toFixed(3)),
        minPrice: b.min,
        samples: b.count
      }))
      .sort((a, b) => a.avgPrice - b.avgPrice)
      .slice(0, 6);

    return {
      snapshotCount: validSnaps.length,
      histMin: histMin ?? currentMin,
      histAvg: histAvg ?? currentAvg,
      histMax: histMax ?? currentRanking?.maxPrice ?? null,
      eveningExpectedMin,
      expectedDropPerLiter,
      potentialEveningSaving,
      spreadSavingNow,
      signal,
      headline,
      subline,
      bestWindowText,
      hourlySlots,
      weekdayStats,
      topHistoricalStations
    };
  }
}

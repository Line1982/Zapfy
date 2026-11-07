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
   * Filters and sorts stations by selected fuel type ('e10', 'e5', 'diesel'), active radiusKm,
   * and sort mode ('price', 'dist', 'fav').
   * Also evaluates stations in the lookahead buffer (1-4 km outside radiusKm) to detect a
   * worthwhile "Smart Detour" bargain (considering gross tank savings minus extra driving fuel cost).
   */
  static rankStations(stations, fuelType = 'e10', sortMode = 'price', favoritesSet = new Set(), radiusKm = 5, tankLiters = 50) {
    if (!Array.isArray(stations)) {
      return {
        list: [],
        openCount: 0,
        totalCount: 0,
        minPrice: null,
        maxPrice: null,
        avgPrice: null,
        spreadPerLiter: 0,
        smartDetour: null,
        effectiveRadiusKm: radiusKm,
        autoExpanded: false
      };
    }

    const activeRad = Number(radiusKm) || 5;
    let effectiveRadiusKm = activeRad;
    let autoExpanded = false;

    // Count open stations inside requested radius; auto-expand if fewer than 3 are open
    const countOpenWithin = (rad) =>
      stations.filter((s) => s.isOpen && typeof s[fuelType] === 'number' && s[fuelType] > 0 && s.dist <= rad).length;

    const radiusSteps = [3, 5, 10, 15, 25];
    if (countOpenWithin(effectiveRadiusKm) < 3) {
      for (const stepRad of radiusSteps) {
        if (stepRad > effectiveRadiusKm && countOpenWithin(stepRad) > countOpenWithin(effectiveRadiusKm)) {
          effectiveRadiusKm = stepRad;
          autoExpanded = true;
          if (countOpenWithin(effectiveRadiusKm) >= 3) break;
        }
      }
    }

    const insideStations = stations.filter((s) => s.dist <= effectiveRadiusKm);
    const outsideBufferStations = stations.filter((s) => s.dist > effectiveRadiusKm && s.dist <= effectiveRadiusKm + 4.5);

    const pricedStations = [];
    const unpricedStations = [];

    for (const st of insideStations) {
      const price = st[fuelType];
      const isFav = favoritesSet.has(st.id);
      const enriched = { ...st, activePrice: typeof price === 'number' && price > 0 ? price : null, isFavorite: isFav };

      if (enriched.activePrice !== null) {
        pricedStations.push(enriched);
      } else {
        unpricedStations.push(enriched);
      }
    }

    // Determine min, max, avg across all stations with a price (open or closed)
    let minPrice = null;
    let maxPrice = null;
    let sumPrice = 0;
    let bestInsideStation = null;
    let bestInsideOpenStation = null;

    for (const st of pricedStations) {
      if (minPrice === null || st.activePrice < minPrice || (st.activePrice === minPrice && st.dist < (bestInsideStation?.dist ?? 999))) {
        minPrice = st.activePrice;
        bestInsideStation = st;
      }
      if (st.isOpen) {
        if (!bestInsideOpenStation || st.activePrice < bestInsideOpenStation.activePrice || (st.activePrice === bestInsideOpenStation.activePrice && st.dist < bestInsideOpenStation.dist)) {
          bestInsideOpenStation = st;
        }
      }
      if (maxPrice === null || st.activePrice > maxPrice) maxPrice = st.activePrice;
      sumPrice += st.activePrice;
    }

    const avgPrice = pricedStations.length > 0 ? Number((sumPrice / pricedStations.length).toFixed(3)) : null;

    // Order strictly: Cheapest to most expensive (ascending price), open or closed
    pricedStations.sort((a, b) => {
      if (sortMode === 'fav') {
        if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
      }
      if (sortMode === 'dist') {
        if (a.dist !== b.dist) return a.dist - b.dist;
        return a.activePrice - b.activePrice;
      }
      // Standard: Cheapest first, tie-breaker: closer distance
      if (a.activePrice !== b.activePrice) return a.activePrice - b.activePrice;
      return a.dist - b.dist;
    });

    unpricedStations.sort((a, b) => a.dist - b.dist);

    const rankedPriced = pricedStations.map((st, idx) => {
      const diffToMin = minPrice !== null ? Number((st.activePrice - minPrice).toFixed(3)) : 0;
      const isCheapest = minPrice !== null && Math.abs(st.activePrice - minPrice) < 0.0005;
      return {
        ...st,
        rank: idx + 1,
        isCheapest,
        diffToMin
      };
    });

    // Check lookahead buffer (1-4.5 km beyond effectiveRadiusKm) for a "Smart Detour" bargain
    // Compare against the best open inside station (or best inside station) so net savings are genuine
    const referenceInsideStation = bestInsideOpenStation || bestInsideStation;
    const referencePrice = referenceInsideStation ? referenceInsideStation.activePrice : minPrice;

    let smartDetour = null;
    if (referenceInsideStation && referencePrice !== null) {
      let bestOutside = null;
      for (const outSt of outsideBufferStations) {
        const p = outSt[fuelType];
        // Detour target must be open and priced
        if (!outSt.isOpen || typeof p !== 'number' || p <= 0) continue;
        if (!bestOutside || p < bestOutside.activePrice || (p === bestOutside.activePrice && outSt.dist < bestOutside.dist)) {
          bestOutside = { ...outSt, activePrice: p, isFavorite: favoritesSet.has(outSt.id) };
        }
      }

      if (bestOutside && bestOutside.activePrice <= referencePrice - 0.02) {
        const extraDistOneWay = Math.max(0.5, Number((bestOutside.dist - referenceInsideStation.dist).toFixed(1)));
        const priceDiffPerLiter = Number((referencePrice - bestOutside.activePrice).toFixed(3));
        const grossSaving = Number((priceDiffPerLiter * tankLiters).toFixed(2));
        // Realistic round-trip detour fuel cost (~7.0 L / 100km consumption * 2 * extraDistOneWay)
        const detourFuelLiters = (extraDistOneWay * 2 * 7.0) / 100;
        const detourFuelCost = Number((detourFuelLiters * bestOutside.activePrice).toFixed(2));
        const netSaving = Number((grossSaving - detourFuelCost).toFixed(2));

        if (netSaving >= 0.5) {
          smartDetour = {
            station: bestOutside,
            extraDistKm: extraDistOneWay,
            outsideRadiusMarginKm: Number((bestOutside.dist - effectiveRadiusKm).toFixed(1)),
            centsCheaper: Math.round(priceDiffPerLiter * 100),
            grossSaving,
            netSaving
          };
        }
      }
    }

    const openCount = insideStations.filter((s) => s.isOpen && typeof s[fuelType] === 'number' && s[fuelType] > 0).length;

    return {
      list: [...rankedPriced, ...unpricedStations],
      openCount,
      totalCount: insideStations.length,
      minPrice,
      maxPrice,
      avgPrice,
      spreadPerLiter: minPrice !== null && maxPrice !== null ? Number((maxPrice - minPrice).toFixed(3)) : 0,
      smartDetour,
      effectiveRadiusKm,
      autoExpanded
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
      headline = '🔥 Jetzt tanken! Abend-Tiefpreisphase aktiv';
      subline = `Zwischen 18 und 21 Uhr sind die Kraftstoffpreise erfahrungsgemäß am tiefsten.`;
    } else if (currentHour >= 5 && currentHour <= 9) {
      signal = 'wait';
      headline = '⏳ Besser warten! Aktuell Morgen-Preisspitze';
      subline = `Abends (18–20 Uhr) sinkt der Preis um ca. ${(expectedDropPerLiter * 100).toFixed(0)} ct/L (≈ ${potentialEveningSaving.toFixed(2).replace('.', ',')} € pro ${tankLiters}L-Tank).`;
    } else if (expectedDropPerLiter >= 0.03) {
      signal = 'wait';
      headline = `⏳ Nach Möglichkeit bis 18:00 Uhr warten`;
      subline = `Prognose für heute Abend: ca. ${this.formatPriceParts(eveningExpectedMin).fullText}/L (${(expectedDropPerLiter * 100).toFixed(0)} ct/L günstiger).`;
    } else if (currentMin !== null && histAvg !== null && currentMin <= histAvg - 0.015) {
      signal = 'optimal';
      headline = '✅ Jetzt günstig! Unter deinem historischen Schnitt';
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

'use strict';

/**
 * Gerchik Levels Strategy
 */

const LEVEL_LOOKBACK = 120;
const LEVEL_TOUCH_MIN = 2;
const LEVEL_ZONE_PCT = 0.4;
const MIN_RR_RATIO = 3;
const TICK_BUFFER = 3;
const ENTRY_OFFSET_TICKS = 2;
const MIN_SL_PCT = 0.5;
const MAX_LEVEL_TOUCHES = 4;

class GerchikLevels {
  getName() { return 'gerchik-levels'; }

  findLevels(dailyCandles) {
    if (!dailyCandles || dailyCandles.length < 20) return [];
    const pivots = [];
    const WIN = 3;
    for (let i = WIN; i < dailyCandles.length - WIN; i++) {
      const c = dailyCandles[i];
      const bodyHigh = Math.max(c.open, c.close);
      const bodyLow = Math.min(c.open, c.close);
      let isBodyHigh = true, isBodyLow = true;
      for (let k = i - WIN; k <= i + WIN; k++) {
        if (k === i) continue;
        const kbh = Math.max(dailyCandles[k].open, dailyCandles[k].close);
        const kbl = Math.min(dailyCandles[k].open, dailyCandles[k].close);
        if (kbh > bodyHigh) isBodyHigh = false;
        if (kbl < bodyLow) isBodyLow = false;
      }
      if (isBodyHigh) pivots.push({ price: bodyHigh, type: 'high', index: i });
      if (isBodyLow) pivots.push({ price: bodyLow, type: 'low', index: i });
    }

    const pivotClusters = [];
    const pivotUsed = new Set();
    for (let i = 0; i < pivots.length; i++) {
      if (pivotUsed.has(i)) continue;
      const cluster = [pivots[i]];
      pivotUsed.add(i);
      for (let j = i + 1; j < pivots.length; j++) {
        if (pivotUsed.has(j)) continue;
        const diff = Math.abs(pivots[i].price - pivots[j].price) / pivots[i].price;
        if (diff <= LEVEL_ZONE_PCT / 100) { cluster.push(pivots[j]); pivotUsed.add(j); }
      }
      pivotClusters.push(cluster);
    }

    const levels = [];
    for (const cluster of pivotClusters) {
      const avgPrice = cluster.reduce((s, p) => s + p.price, 0) / cluster.length;
      const zone = avgPrice * (LEVEL_ZONE_PCT / 100);
      const hasHighs = cluster.some((p) => p.type === 'high');
      const hasLows = cluster.some((p) => p.type === 'low');
      let touches = 0, lastTouchIndex = 0, firstTouchIndex = dailyCandles.length;
      for (let i = 0; i < dailyCandles.length; i++) {
        const c = dailyCandles[i];
        const bodyHigh = Math.max(c.open, c.close);
        const bodyLow = Math.min(c.open, c.close);
        if (bodyLow <= avgPrice + zone && bodyHigh >= avgPrice - zone) {
          touches++;
          if (i > lastTouchIndex) lastTouchIndex = i;
          if (i < firstTouchIndex) firstTouchIndex = i;
        }
      }
      if (touches < LEVEL_TOUCH_MIN) continue;
      const zoneHigh = Math.max(...cluster.map(p => p.price), avgPrice + zone * 0.5);
      const zoneLow = Math.min(...cluster.map(p => p.price), avgPrice - zone * 0.5);
      const level = {
        price: parseFloat(avgPrice.toFixed(8)),
        zoneHigh: parseFloat(zoneHigh.toFixed(8)),
        zoneLow: parseFloat(zoneLow.toFixed(8)),
        touches, pivotCount: cluster.length, lastTouchIndex, firstTouchIndex,
        isMirror: hasHighs && hasLows,
        hasFalseBreakout: false, hasLongWicks: false, isRoundNumber: false,
        strength: 0, classification: '',
        type: hasHighs && hasLows ? 'dual' : hasHighs ? 'resistance' : 'support',
      };
      level.hasFalseBreakout = this._detectFalseBreakout(dailyCandles, level);
      level.hasLongWicks = this._detectLongWicks(dailyCandles, level);
      level.isRoundNumber = this._isRoundNumber(level.price);
      level.classification = this._classifyLevel(level);
      level.strength = this._scoreLevel(level, dailyCandles);
      levels.push(level);
    }
    levels.sort((a, b) => b.strength - a.strength);
    return levels.filter((l) => l.strength >= 2);
  }

  _classifyLevel(level) {
    if (level.isMirror) return 'mirror';
    if (level.hasFalseBreakout) return 'false_breakout';
    if (level.pivotCount >= 3) return 'multi_touch';
    return 'standard';
  }

  _scoreLevel(level, dailyCandles) {
    let score = 0;
    const pivots = level.pivotCount || 1;
    if (pivots <= 3) { score += pivots + 1; } else { score += 4; score -= (pivots - 3); }
    if (level.isMirror) score += 3;
    if (level.hasFalseBreakout) score += 2;
    if (level.hasLongWicks) score += 1;
    if (level.isRoundNumber) score += 1;
    const recency = dailyCandles.length - level.lastTouchIndex;
    if (recency <= 10) score += 1;
    if (recency > 60) score -= 1;
    return score;
  }

  _detectFalseBreakout(candles, level) {
    const zone = (level.zoneHigh - level.zoneLow) || level.price * (LEVEL_ZONE_PCT / 100);
    const upperBound = level.zoneHigh + zone * 0.5;
    const lowerBound = level.zoneLow - zone * 0.5;
    for (let i = 3; i < candles.length - 1; i++) {
      const c = candles[i], next = candles[i + 1];
      const bodyHigh = Math.max(c.open, c.close), bodyLow = Math.min(c.open, c.close);
      if (bodyHigh > upperBound && Math.max(next.open, next.close) < upperBound) return true;
      if (bodyLow < lowerBound && Math.min(next.open, next.close) > lowerBound) return true;
    }
    return false;
  }

  _detectLongWicks(candles, level) {
    const zone = level.price * (LEVEL_ZONE_PCT / 100);
    let longWickCount = 0;
    for (const c of candles) {
      const bodyHigh = Math.max(c.open, c.close), bodyLow = Math.min(c.open, c.close);
      const bodySize = bodyHigh - bodyLow || 0.0001;
      if (c.low <= level.price + zone && c.high >= level.price - zone) {
        if ((bodyLow - c.low) > bodySize || (c.high - bodyHigh) > bodySize) longWickCount++;
      }
    }
    return longWickCount >= 2;
  }

  _isRoundNumber(price) {
    if (price >= 10000) return price % 5000 === 0 || price % 1000 === 0;
    if (price >= 100) return price % 100 === 0 || price % 50 === 0;
    if (price >= 10) return price % 10 === 0 || price % 5 === 0;
    return price % 1 === 0 || price % 0.5 === 0;
  }

  detectTrend4H(candles4H) {
    if (!candles4H || candles4H.length < 20) return 'neutral';
    const recent = candles4H.slice(-20);
    let higherLows = 0, lowerHighs = 0;
    for (let i = 1; i < recent.length; i++) {
      const prevLow = Math.min(recent[i-1].open, recent[i-1].close);
      const currLow = Math.min(recent[i].open, recent[i].close);
      const prevHigh = Math.max(recent[i-1].open, recent[i-1].close);
      const currHigh = Math.max(recent[i].open, recent[i].close);
      if (currLow > prevLow) higherLows++;
      if (currHigh < prevHigh) lowerHighs++;
    }
    const total = recent.length - 1;
    if (higherLows > total * 0.55) return 'up';
    if (lowerHighs > total * 0.55) return 'down';
    return 'neutral';
  }

  check4HConfirmation(candles4H, direction) {
    const trend = this.detectTrend4H(candles4H);
    if (direction === 'long') {
      if (trend === 'up') return { confirmed: true, reduce: false };
      if (trend === 'neutral') return { confirmed: true, reduce: false };
      return { confirmed: false, reduce: true };
    }
    if (direction === 'short') {
      if (trend === 'down') return { confirmed: true, reduce: false };
      if (trend === 'neutral') return { confirmed: true, reduce: false };
      return { confirmed: false, reduce: true };
    }
    return { confirmed: true, reduce: false };
  }

  analyze4HApproach(candles4H, level) {
    if (!candles4H || candles4H.length < 5) return { approach: 'unknown' };
    const recent = candles4H.slice(-6);
    const zone = level.price * (LEVEL_ZONE_PCT / 100);
    const upperBound = level.price + zone, lowerBound = level.price - zone;
    let inZone = 0, smallBodies = 0, falseBreak = false;
    for (let i = 0; i < recent.length; i++) {
      const c = recent[i];
      const bodyHigh = Math.max(c.open, c.close), bodyLow = Math.min(c.open, c.close);
      if (bodyLow <= upperBound && bodyHigh >= lowerBound) inZone++;
      const bodySize = bodyHigh - bodyLow, range = c.high - c.low;
      if (range > 0 && bodySize / range < 0.3) smallBodies++;
      if (i < recent.length - 1) {
        const next = recent[i+1];
        if (bodyHigh > upperBound && Math.max(next.open, next.close) < upperBound) falseBreak = true;
        if (bodyLow < lowerBound && Math.min(next.open, next.close) > lowerBound) falseBreak = true;
      }
    }
    if (falseBreak) return { approach: 'false_breakout' };
    if (smallBodies >= 3) return { approach: 'base' };
    if (inZone >= 2) return { approach: 'compression' };
    return { approach: 'direct' };
  }

  findEntryPattern(candles5m, level, direction, allDailyLevels, tickSize) {
    if (!candles5m || candles5m.length < 6) return null;
    const tick = tickSize || this._estimateTickSize(level.price);
    const current = candles5m[candles5m.length - 1];
    const distToLevel = Math.abs(current.close - level.price) / level.price;
    if (distToLevel > LEVEL_ZONE_PCT / 100 * 3) return null;
    let pattern = null;
    pattern = this._checkFalseBreakoutPattern(candles5m, level, direction, tick);
    if (pattern) return this._buildSignal(pattern, level, direction, allDailyLevels, tick);
    pattern = this._checkEngulfingPattern(candles5m, level, direction, tick);
    if (pattern) return this._buildSignal(pattern, level, direction, allDailyLevels, tick);
    pattern = this._checkBouncePattern(candles5m, level, direction, tick);
    if (pattern) return this._buildSignal(pattern, level, direction, allDailyLevels, tick);
    pattern = this._checkBasePattern(candles5m, level, direction, tick);
    if (pattern) return this._buildSignal(pattern, level, direction, allDailyLevels, tick);
    return null;
  }

  _checkFalseBreakoutPattern(candles, level, direction, tick) {
    const prev = candles[candles.length - 2], curr = candles[candles.length - 1];
    if (!prev || !curr) return null;
    const zone = level.price * (LEVEL_ZONE_PCT / 100);
    if (direction === 'long') {
      if (prev.low < level.price - zone && curr.close > level.price - zone / 2 && curr.close > curr.open)
        return { type: 'false_breakout', typeRu: 'Ложный пробой', entry: curr.close };
    }
    if (direction === 'short') {
      if (prev.high > level.price + zone && curr.close < level.price + zone / 2 && curr.close < curr.open)
        return { type: 'false_breakout', typeRu: 'Ложный пробой', entry: curr.close };
    }
    return null;
  }

  _checkBouncePattern(candles, level, direction, tick) {
    const curr = candles[candles.length - 1];
    if (!curr) return null;
    const zone = level.price * (LEVEL_ZONE_PCT / 100);
    const bodyHigh = Math.max(curr.open, curr.close), bodyLow = Math.min(curr.open, curr.close);
    const bodySize = bodyHigh - bodyLow || 0.0001;
    if (direction === 'long') {
      if (curr.low <= level.price + zone && curr.low >= level.price - zone * 2 &&
          (bodyLow - curr.low) > bodySize && bodyLow > level.price - zone && curr.close >= curr.open)
        return { type: 'bounce', typeRu: 'Отскок', entry: curr.close };
    }
    if (direction === 'short') {
      if (curr.high >= level.price - zone && curr.high <= level.price + zone * 2 &&
          (curr.high - bodyHigh) > bodySize && bodyHigh < level.price + zone && curr.close <= curr.open)
        return { type: 'bounce', typeRu: 'Отскок', entry: curr.close };
    }
    return null;
  }

  _checkEngulfingPattern(candles, level, direction, tick) {
    const prev = candles[candles.length - 2], curr = candles[candles.length - 1];
    if (!prev || !curr) return null;
    const zone = level.price * (LEVEL_ZONE_PCT / 100);
    const distToLevel = Math.abs(curr.close - level.price) / level.price;
    if (distToLevel > LEVEL_ZONE_PCT / 100 * 2) return null;
    const prevBodyHigh = Math.max(prev.open, prev.close), prevBodyLow = Math.min(prev.open, prev.close);
    const currBodyHigh = Math.max(curr.open, curr.close), currBodyLow = Math.min(curr.open, curr.close);
    if (direction === 'long') {
      if (prev.close < prev.open && curr.close > curr.open &&
          currBodyHigh > prevBodyHigh && currBodyLow <= prevBodyLow && curr.low <= level.price + zone)
        return { type: 'engulfing', typeRu: 'Поглощение', entry: curr.close };
    }
    if (direction === 'short') {
      if (prev.close > prev.open && curr.close < curr.open &&
          currBodyLow < prevBodyLow && currBodyHigh >= prevBodyHigh && curr.high >= level.price - zone)
        return { type: 'engulfing', typeRu: 'Поглощение', entry: curr.close };
    }
    return null;
  }

  _checkBasePattern(candles, level, direction, tick) {
    if (candles.length < 5) return null;
    const zone = level.price * (LEVEL_ZONE_PCT / 100);
    const recent = candles.slice(-5), curr = recent[recent.length - 1];
    let smallInZone = 0, avgRange = 0;
    for (let i = 0; i < recent.length - 1; i++) {
      const c = recent[i];
      const bodyHigh = Math.max(c.open, c.close), bodyLow = Math.min(c.open, c.close);
      const bodySize = bodyHigh - bodyLow, range = c.high - c.low;
      avgRange += range;
      const nearLevel = Math.abs(c.close - level.price) / level.price <= LEVEL_ZONE_PCT / 100 * 2;
      const smallBody = range > 0 && bodySize / range < 0.4;
      if (nearLevel && smallBody) smallInZone++;
    }
    avgRange /= (recent.length - 1);
    if (smallInZone < 3) return null;
    const currBodySize = Math.abs(curr.close - curr.open);
    if (direction === 'long' && curr.close > curr.open && currBodySize > avgRange * 0.5)
      return { type: 'base', typeRu: 'База (проторговка)', entry: curr.close };
    if (direction === 'short' && curr.close < curr.open && currBodySize > avgRange * 0.5)
      return { type: 'base', typeRu: 'База (проторговка)', entry: curr.close };
    return null;
  }

  _buildSignal(pattern, level, direction, allDailyLevels, tick) {
    const buffer = tick * TICK_BUFFER;
    let stopLoss, entry;
    if (direction === 'long') {
      stopLoss = (level.zoneLow || level.price) - buffer;
      entry = (level.zoneLow || level.price) + tick * ENTRY_OFFSET_TICKS;
    } else {
      stopLoss = (level.zoneHigh || level.price) + buffer;
      entry = (level.zoneHigh || level.price) - tick * ENTRY_OFFSET_TICKS;
    }
    if (direction === 'long' && pattern.entry > entry) {
      const newSlDist = (pattern.entry - stopLoss) / pattern.entry;
      if (newSlDist >= MIN_SL_PCT / 100) entry = pattern.entry;
    }
    if (direction === 'short' && pattern.entry < entry) {
      const newSlDist = (stopLoss - pattern.entry) / pattern.entry;
      if (newSlDist >= MIN_SL_PCT / 100) entry = pattern.entry;
    }
    if (direction === 'long' && stopLoss >= entry) return null;
    if (direction === 'short' && stopLoss <= entry) return null;
    const slDistPct = Math.abs(entry - stopLoss) / entry * 100;
    if (slDistPct < MIN_SL_PCT) {
      if (direction === 'long') stopLoss = entry * (1 - MIN_SL_PCT / 100);
      else stopLoss = entry * (1 + MIN_SL_PCT / 100);
    }
    const risk = Math.abs(entry - stopLoss);
    let tp1, tp2, tp3;
    if (direction === 'long') { tp1 = entry + risk; tp2 = entry + risk * 2; tp3 = entry + risk * 3; }
    else { tp1 = entry - risk; tp2 = entry - risk * 2; tp3 = entry - risk * 3; }
    if (allDailyLevels && allDailyLevels.length > 0) {
      const nextLevel = this._findNextLevel(entry, direction, allDailyLevels);
      if (nextLevel) {
        const nextLevelDist = Math.abs(nextLevel - entry);
        if (nextLevelDist > risk * 2 && nextLevelDist < risk * 3) tp3 = nextLevel;
      }
    }
    const reward = Math.abs(tp3 - entry);
    const rr = risk > 0 ? reward / risk : 0;
    if (rr < MIN_RR_RATIO) return null;
    return {
      signal: direction, type: pattern.type, typeRu: pattern.typeRu,
      entry: parseFloat(entry.toFixed(8)), stopLoss: parseFloat(stopLoss.toFixed(8)),
      takeProfit: parseFloat(tp3.toFixed(8)),
      tp1: parseFloat(tp1.toFixed(8)), tp2: parseFloat(tp2.toFixed(8)), tp3: parseFloat(tp3.toFixed(8)),
      level: level.price, levelClassification: level.classification, levelStrength: level.strength,
      risk: parseFloat(risk.toFixed(8)), riskRewardRatio: parseFloat(rr.toFixed(2)),
      reason: `${pattern.typeRu} от ${level.type === 'support' ? 'поддержки' : level.type === 'resistance' ? 'сопротивления' : 'уровня'} ${level.price.toFixed(2)} (${this._classificationRu(level.classification)}, сила: ${level.strength})`,
    };
  }

  _classificationRu(classification) {
    const map = { 'mirror': 'зеркальный', 'false_breakout': 'с ложным пробоем', 'multi_touch': 'мульти-тач', 'standard': 'стандартный' };
    return map[classification] || classification;
  }

  _findNextLevel(entry, direction, allLevels) {
    let best = null, bestDist = Infinity;
    for (const l of allLevels) {
      if (direction === 'long' && l.price > entry) {
        const dist = l.price - entry;
        if (dist < bestDist) { bestDist = dist; best = l.price; }
      }
      if (direction === 'short' && l.price < entry) {
        const dist = entry - l.price;
        if (dist < bestDist) { bestDist = dist; best = l.price; }
      }
    }
    return best;
  }

  isLevelBroken(candle5m, level, direction) {
    const bodyClose = candle5m.close;
    const zone = level.price * (LEVEL_ZONE_PCT / 100);
    if (direction === 'long') return bodyClose < (level.zoneLow || level.price) - zone;
    if (direction === 'short') return bodyClose > (level.zoneHigh || level.price) + zone;
    return false;
  }

  isLevelWornOut(level, recentDailyCandles) {
    if (!recentDailyCandles || recentDailyCandles.length < 5) return false;
    const zone = level.price * (LEVEL_ZONE_PCT / 100);
    let recentTouches = 0;
    const lookback = Math.min(recentDailyCandles.length, 10);
    for (let i = recentDailyCandles.length - lookback; i < recentDailyCandles.length; i++) {
      const c = recentDailyCandles[i];
      if (!c) continue;
      const bodyHigh = Math.max(c.open, c.close), bodyLow = Math.min(c.open, c.close);
      if (bodyLow <= level.price + zone && bodyHigh >= level.price - zone) recentTouches++;
    }
    return recentTouches >= MAX_LEVEL_TOUCHES;
  }

  _estimateTickSize(price) {
    if (price >= 10000) return 1;
    if (price >= 1000) return 0.1;
    if (price >= 100) return 0.01;
    if (price >= 1) return 0.001;
    return 0.0001;
  }

  calculatePositionSize(balance, entry, stopLoss, riskPct) {
    const riskPercent = Math.min(Math.max(riskPct || 1, 0.5), 3);
    const riskAmount = balance * (riskPercent / 100);
    const riskPerUnit = Math.abs(entry - stopLoss);
    if (riskPerUnit <= 0) return 0;
    return riskAmount / riskPerUnit;
  }

  getOptions() {
    return {
      period: { label: 'Entry Timeframe', default: '5m', options: ['5m'] },
      dailyTf: { label: 'Levels Timeframe', default: '1d', options: ['1d'] },
      confirmTf: { label: 'Confirmation Timeframe', default: '4h', options: ['4h'] },
      riskPct: { label: 'Risk per trade (%)', default: 1, min: 0.5, max: 3 },
    };
  }

  hasEnergy5m(candles5m, level, direction) {
    if (this._checkBasePattern(candles5m, level, direction)) return true;
    if (candles5m.length < 20) return true;
    const last5 = candles5m.slice(-5);
    const last20 = candles5m.slice(-20);
    const avg5 = last5.reduce((s, c) => s + Math.abs(c.close - c.open), 0) / 5;
    const avg20 = last20.reduce((s, c) => s + Math.abs(c.close - c.open), 0) / 20;
    if (avg20 > 0 && avg5 < avg20 * 0.7) return true;
    let approaching = 0;
    for (let i = 1; i < last5.length; i++) {
      const prevDist = Math.abs(last5[i-1].close - level.price);
      const currDist = Math.abs(last5[i].close - level.price);
      if (currDist < prevDist) approaching++;
    }
    return approaching >= 2;
  }

  hasBreakoutVolume(candles5m, multiplier = 1.5) {
    const curr = candles5m[candles5m.length - 1];
    if (!curr || !curr.volume || curr.volume === 0) return true;
    if (candles5m.length < 20) return true;
    const avg20 = candles5m.slice(-20).reduce((s, c) => s + (c.volume || 0), 0) / 20;
    if (avg20 === 0) return true;
    return curr.volume >= avg20 * multiplier;
  }
}

module.exports = GerchikLevels;

GerchikLevels.detectMarketRegime = function(candles1d) {
  if (!candles1d || candles1d.length < 10) return { regime: 'unknown', atrPct: 0, change24h: 0 };
  const c = candles1d;
  const last = c[c.length - 1];
  const prev = c[c.length - 2];

  // ATR% — средний дневной диапазон за последние 14 свечей
  const atrCandles = c.slice(-14);
  const atrPct = parseFloat((atrCandles.reduce((s, x) => {
    const mid = (x.high + x.low) / 2 || x.close;
    return s + (mid > 0 ? (x.high - x.low) / mid * 100 : 0);
  }, 0) / atrCandles.length).toFixed(2));

  // 24h change
  const change24h = prev && prev.close > 0
    ? parseFloat(((last.close - prev.close) / prev.close * 100).toFixed(2))
    : 0;

  // MA5 и MA20 из close
  const closes = c.map(x => x.close);
  const ma5  = closes.slice(-5).reduce((s, v) => s + v, 0) / 5;
  const ma20 = closes.slice(-20).reduce((s, v) => s + v, 0) / Math.min(20, closes.length);
  const slope = closes.slice(-5).reduce((s, v, i, a) => i === 0 ? 0 : s + (v - a[i-1]), 0) / 4;

  let regime;
  if (ma5 > ma20 * 1.01 && slope > 0) regime = 'trend_up';
  else if (ma5 < ma20 * 0.99 && slope < 0) regime = 'trend_down';
  else regime = 'sideways';

  return { regime, atrPct, change24h, ma5: parseFloat(ma5.toFixed(2)), ma20: parseFloat(ma20.toFixed(2)), slope: parseFloat(slope.toFixed(2)) };
};

module.exports = GerchikLevels;

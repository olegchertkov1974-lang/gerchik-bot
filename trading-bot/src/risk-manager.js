'use strict';

/**
 * Risk Manager
 *
 * Enforces position sizing rules:
 *   - Max 1-3% of balance per trade
 *   - Always sets SL and TP (min 1:3 R:R)
 *   - Validates orders before submission
 */

const DEFAULT_RISK_PCT = 1;
const MIN_RR_RATIO = 3;
const MAX_RISK_PCT = 3;
const MIN_RISK_PCT = 0.5;
const MAX_CONCURRENT_POSITIONS = 3;

class RiskManager {
  constructor(options = {}) {
    this.riskPct = Math.min(Math.max(options.riskPct || DEFAULT_RISK_PCT, MIN_RISK_PCT), MAX_RISK_PCT);
    this.minRR = options.minRR || MIN_RR_RATIO;
    this.maxConcurrent = options.maxConcurrentPositions || MAX_CONCURRENT_POSITIONS;
    this.openPositions = [];
  }

  calculatePositionSize(balance, entry, stopLoss) {
    if (!balance || balance <= 0) throw new Error('Invalid balance');
    if (!entry || entry <= 0) throw new Error('Invalid entry price');
    if (!stopLoss || stopLoss <= 0) throw new Error('Invalid stop-loss');

    const riskAmount = balance * (this.riskPct / 100);
    const riskPerUnit = Math.abs(entry - stopLoss);

    if (riskPerUnit <= 0) throw new Error('Entry and stop-loss are equal');

    const size = riskAmount / riskPerUnit;

    const MAX_LEVERAGE = parseInt(process.env.LEVERAGE, 10) || 10;
    const notional = size * entry;
    const maxNotional = balance * MAX_LEVERAGE;
    let finalSize = size;
    if (notional > maxNotional) {
      finalSize = maxNotional / entry;
    }

    return {
      size: parseFloat(finalSize.toFixed(6)),
      riskAmount: parseFloat(riskAmount.toFixed(2)),
      riskPerUnit: parseFloat(riskPerUnit.toFixed(8)),
      riskPct: this.riskPct,
    };
  }

  calculateTakeProfit(entry, stopLoss, side) {
    const risk = Math.abs(entry - stopLoss);
    if (side === 'long') {
      return parseFloat((entry + risk * this.minRR).toFixed(8));
    }
    return parseFloat((entry - risk * this.minRR).toFixed(8));
  }

  validateOrder(order, pair) {
    const errors = [];

    if (!order.entry || order.entry <= 0) errors.push('Нет цены входа');
    if (!order.stopLoss || order.stopLoss <= 0) errors.push('Нет стоп-лосса');
    const tp = order.tp3 || order.takeProfit;
    if (!tp || tp <= 0) errors.push('Нет тейк-профита');
    if (!order.size || order.size <= 0) errors.push('Нет размера позиции');

    if (order.side === 'long') {
      if (order.stopLoss >= order.entry) errors.push('SL должен быть ниже входа для лонга');
      if (tp && tp <= order.entry) errors.push('TP должен быть выше входа для лонга');
    } else if (order.side === 'short') {
      if (order.stopLoss <= order.entry) errors.push('SL должен быть выше входа для шорта');
      if (tp && tp >= order.entry) errors.push('TP должен быть ниже входа для шорта');
    }

    const risk = Math.abs(order.entry - order.stopLoss);
    const reward = Math.abs((tp || 0) - order.entry);
    if (risk > 0 && reward / risk < this.minRR) {
      errors.push(`R:R ${(reward / risk).toFixed(2)} ниже минимума ${this.minRR}`);
    }

    if (pair) {
      const hasPosition = this.openPositions.some((p) => p.id === pair);
      if (hasPosition) {
        errors.push(`Уже есть позиция по ${pair} (макс 1 на инструмент)`);
      }
    }

    if (this.openPositions.length >= this.maxConcurrent) {
      errors.push(`Достигнут лимит позиций (${this.maxConcurrent})`);
    }

    return { valid: errors.length === 0, errors };
  }

  addPosition(position) {
    this.openPositions.push(position);
  }

  removePosition(id) {
    this.openPositions = this.openPositions.filter((p) => p.id !== id);
  }

  getOpenPositions() {
    return [...this.openPositions];
  }
}

module.exports = RiskManager;

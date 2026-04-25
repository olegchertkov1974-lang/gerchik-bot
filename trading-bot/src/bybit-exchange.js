'use strict';

/**
 * Bybit Exchange Connector
 *
 * Handles API communication with Bybit using ccxt.
 * Loads credentials from environment variables.
 * Implements retry logic with exponential backoff.
 */

const ccxt = require('ccxt');
const logger = require('./logger');

const ALLOWED_TIMEFRAMES = ['5m', '15m', '1h', '4h', '1d'];
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY = 2000; // ms

class BybitExchange {
  constructor() {
    const apiKey = process.env.BYBIT_API_KEY;
    const apiSecret = process.env.BYBIT_API_SECRET;

    if (!apiKey || !apiSecret) {
      throw new Error(
        'BYBIT_API_KEY and BYBIT_API_SECRET must be set in environment variables. ' +
        'Create a .env file or export them. Keys must have TRADE permission only (no withdrawal).'
      );
    }

    const isDemo = process.env.BYBIT_DEMO === 'true';

    this.exchange = new ccxt.bybit({
      apiKey,
      secret: apiSecret,
      enableRateLimit: true,
      options: {
        defaultType: 'linear', // USDT perpetual
        adjustForTimeDifference: true,
        enableDemoTrading: isDemo, // ccxt built-in demo trading support
      },
      timeout: 30000,
    });

    if (isDemo) {
      // ccxt has built-in demotrading URLs (api-demo.bybit.com)
      this.exchange.urls['api'] = this.exchange.urls['demotrading'];
      logger.info('Bybit: running in DEMO TRADING mode (api-demo.bybit.com)');
    } else if (process.env.BYBIT_TESTNET === 'true') {
      this.exchange.setSandboxMode(true);
      logger.info('Bybit: running in TESTNET mode');
    }
  }

  /**
   * Validate that a trading pair is allowed.
   */
  validatePair(pair) {
    if (!pair || !pair.endsWith('/USDT')) {
      throw new Error(`Pair ${pair} is not valid. Only USDT pairs are supported.`);
    }
  }

  /**
   * Convert pair to linear perpetual symbol (e.g. BTC/USDT -> BTC/USDT:USDT).
   */
  _toLinear(pair) {
    return pair.includes(':') ? pair : `${pair}:USDT`;
  }

  /**
   * Validate timeframe.
   */
  validateTimeframe(tf) {
    if (!ALLOWED_TIMEFRAMES.includes(tf)) {
      throw new Error(`Timeframe ${tf} is not allowed. Allowed: ${ALLOWED_TIMEFRAMES.join(', ')}`);
    }
  }

  /**
   * Fetch OHLCV candles with retry.
   */
  async fetchCandles(pair, timeframe, limit = 200) {
    this.validatePair(pair);
    this.validateTimeframe(timeframe);

    return this._retry(async () => {
      const ohlcv = await this.exchange.fetchOHLCV(this._toLinear(pair), timeframe, undefined, limit);
      return ohlcv.map((c) => ({
        time: c[0],
        open: c[1],
        high: c[2],
        low: c[3],
        close: c[4],
        volume: c[5],
      }));
    }, `fetchCandles(${pair}, ${timeframe})`);
  }

  /**
   * Fetch account balance.
   */
  async fetchBalance() {
    return this._retry(async () => {
      const balance = await this.exchange.fetchBalance();
      return {
        total: balance.total && balance.total.USDT ? balance.total.USDT : 0,
        free: balance.free && balance.free.USDT ? balance.free.USDT : 0,
        used: balance.used && balance.used.USDT ? balance.used.USDT : 0,
      };
    }, 'fetchBalance');
  }

  /**
   * Разместить Limit PostOnly ордер (вход в позицию).
   * PostOnly гарантирует maker-комиссию 0.02%. Если цена ушла и ордер
   * стал бы taker — биржа его автоматически отменит.
   *
   * SL и TP ставятся ОТДЕЛЬНО после исполнения через setTradingStop().
   * Это надёжнее, чем прикреплять к ордеру (Bybit может игнорировать
   * attached SL/TP на limit ордерах).
   *
   * @param {string} pair — торговая пара
   * @param {string} side — 'buy' или 'sell'
   * @param {number} amount — объём
   * @param {number} limitPrice — цена лимитного ордера
   * @param {boolean} postOnly — PostOnly режим (по умолчанию true)
   * @returns {object} ордер с id, status, type
   */
  async placeOrder(pair, side, amount, limitPrice, postOnly = true) {
    this.validatePair(pair);

    return this._retry(async () => {
      const params = {};

      // PostOnly — гарантия maker-комиссии (ордер отменится если станет taker)
      if (postOnly && limitPrice) {
        params.timeInForce = 'PostOnly';
      }

      const orderType = limitPrice ? 'limit' : 'market';
      const price = limitPrice || undefined;

      logger.info(
        `Ордер ${orderType}${postOnly ? ' PostOnly' : ''} ${side}: ${pair} объём=${amount} цена=${limitPrice || 'market'}`
      );

      const order = await this.exchange.createOrder(
        this._toLinear(pair), orderType, side, amount, price, params
      );

      // Нормализуем статус: Bybit Demo иногда возвращает undefined
      if (!order.status) {
        order.status = order.id ? 'open' : 'canceled';
      }
      logger.info(`Ордер размещён: ${order.id} (${orderType}${postOnly ? ' PostOnly' : ''}) статус=${order.status}`);
      return order;
    }, `placeOrder(${pair}, ${side})`);
  }

  /**
   * Определить positionIdx для Bybit Trading Stop API.
   *
   * One-Way mode (BYBIT_HEDGE_MODE не задан или false):
   *   positionIdx = 0 — единственная позиция на инструмент.
   *
   * Hedge mode (BYBIT_HEDGE_MODE=true):
   *   positionIdx = 1 — Long, positionIdx = 2 — Short.
   *   Если side не передан — fallback на 0 (лучше чем неверный индекс).
   *
   * @param {string} [side] — 'long' | 'short' | 'buy' | 'sell'
   * @returns {number}
   */
  _positionIdx(side) {
    const isHedge = process.env.BYBIT_HEDGE_MODE === 'true';
    if (!isHedge) return 0;
    const s = (side || '').toLowerCase();
    if (s === 'long' || s === 'buy') return 1;
    if (s === 'short' || s === 'sell') return 2;
    logger.warn('_positionIdx: hedge mode включён, но side не передан — используем 0');
    return 0;
  }

  /**
   * Установить/обновить SL и TP на открытой позиции через Bybit Trading Stop API.
   *
   * Используется:
   * 1. После исполнения лимитного ордера — установка SL/TP
   * 2. Перенос SL в безубыток после 1R
   *
   * SL — Stop Market (гарантия исполнения).
   * TP — Limit (maker-комиссия).
   *
   * tpslMode: "Partial" + tpSize — TP3 закрывает только остаток позиции (30%),
   * а не всю позицию целиком. Если tpSize не передан — используется "Full".
   *
   * @param {string} pair  — торговая пара
   * @param {object} opts  — { stopLoss, takeProfit, tpSize, side }
   *   side    — 'long'|'short' — нужен для Hedge mode (positionIdx)
   *   tpSize  — объём для TP ордера; если задан, tpslMode='Partial'
   */
  async setTradingStop(pair, opts = {}) {
    this.validatePair(pair);
    const rawSymbol = pair.replace('/', '');  // BTCUSDT

    return this._retry(async () => {
      const params = {
        category:    'linear',
        symbol:      rawSymbol,
        positionIdx: this._positionIdx(opts.side),
      };

      if (opts.stopLoss) {
        params.stopLoss    = String(opts.stopLoss);
        params.slTriggerBy = 'LastPrice';
      }

      // ВАЖНО: tpslMode=Partial не работает корректно — SL/TP не устанавливаются.
      // Используем Full: SL защищает позицию целиком, TP закрывает весь остаток.
      // К моменту TP3 бот уже закрыл TP1 (30%) и TP2 (40%) программно.
      params.tpslMode = 'Full';

      if (opts.takeProfit) {
        params.takeProfit  = String(opts.takeProfit);
        params.tpTriggerBy = 'LastPrice';
      }

      if (opts.trailingStop) {
        params.trailingStop = String(opts.trailingStop);
        if (opts.activePrice) params.activePrice = String(opts.activePrice);
      }

      if (opts.trailingStop) {
        params.trailingStop = String(opts.trailingStop);
        if (opts.activePrice) params.activePrice = String(opts.activePrice);
      }

      if (opts.trailingStop) {
        params.trailingStop = String(opts.trailingStop);
        if (opts.activePrice) params.activePrice = String(opts.activePrice);
      }

      if (opts.trailingStop) {
        params.trailingStop = String(opts.trailingStop);
        if (opts.activePrice) params.activePrice = String(opts.activePrice);
      }

      logger.info(
        `setTradingStop ${pair}: SL=${opts.stopLoss || '—'} TP=${opts.takeProfit || '—'}  tpSize=${opts.tpSize || '—'} tpslMode=${params.tpslMode || '—'}  positionIdx=${params.positionIdx}`
      );

      try {
        const response = await this.exchange.privatePostV5PositionTradingStop(params);
        const retCode = Number(response?.retCode ?? response?.ret_code ?? 0);

        if (retCode !== 0) {
          throw new Error(`setTradingStop: retCode=${retCode} msg=${response?.retMsg || response?.ret_msg || '?'}`);
        }

        logger.info(`setTradingStop ${pair}: OK`);
        return response;
      } catch (err) {
        // "zero position" / "not modified" — позиция уже закрыта или SL/TP уже установлены
        if (err.message.includes('zero position') || err.message.includes('not modified')) {
          logger.warn(`setTradingStop ${pair}: ${err.message} (позиция закрыта или SL/TP уже установлены)`);
          return null;
        }
        throw err;
      }
    }, `setTradingStop(${pair})`);
  }

  /**
   * Закрыть позицию рыночным ордером.
   */
  async closePosition(pair, side, amount) {
    this.validatePair(pair);
    const closeSide = side === 'long' ? 'sell' : 'buy';

    return this._retry(async () => {
      logger.info(`Закрытие ${side} позиции: ${pair} объём=${amount}`);
      const order = await this.exchange.createOrder(this._toLinear(pair), 'market', closeSide, amount, undefined, {
        reduceOnly: true,
      });
      logger.info(`Позиция закрыта: ${order.id}`);
      return order;
    }, `closePosition(${pair})`);
  }

  /**
   * Получить минимальный лот и шаг для пары из lotSizeFilter.
   * Кэширует результат, чтобы не дёргать API каждый раз.
   * @returns {{ minQty: number, stepSize: number }}
   */
  async _getLotSize(pair) {
    if (!this._lotSizeCache) this._lotSizeCache = new Map();

    if (this._lotSizeCache.has(pair)) return this._lotSizeCache.get(pair);

    try {
      await this.exchange.loadMarkets();
      const symbol = this._toLinear(pair);
      const market = this.exchange.market(symbol);
      const minQty = market.limits?.amount?.min || 0;
      const stepSize = market.precision?.amount
        ? Math.pow(10, -market.precision.amount)
        : 0.001;

      const result = { minQty, stepSize };
      this._lotSizeCache.set(pair, result);
      logger.info(`LotSize ${pair}: minQty=${minQty} stepSize=${stepSize}`);
      return result;
    } catch (err) {
      logger.warn(`_getLotSize(${pair}): ${err.message}, fallback minQty=0`);
      return { minQty: 0, stepSize: 0.001 };
    }
  }

  /**
   * Округлить объём вниз до ближайшего шага (stepSize).
   */
  _roundToStep(amount, stepSize) {
    if (!stepSize || stepSize <= 0) return amount;
    return Math.floor(amount / stepSize) * stepSize;
  }

  /**
   * Частичное закрытие позиции рыночным ордером.
   * Проверяет minQty: если объём меньше минимума — округляет вверх;
   * если минимум больше остатка — закрывает всю позицию.
   *
   * @param {string} pair — торговая пара
   * @param {string} side — 'long' или 'short'
   * @param {number} amount — объём для закрытия (часть позиции)
   * @param {string} reason — причина частичного закрытия (для лога)
   * @param {number} [remainingSize] — текущий остаток позиции (для проверки)
   */
  async closePartial(pair, side, amount, reason = '', remainingSize = 0) {
    this.validatePair(pair);
    const closeSide = side === 'long' ? 'sell' : 'buy';

    return this._retry(async () => {
      let finalAmount = amount;

      // Проверяем минимальный лот
      const { minQty, stepSize } = await this._getLotSize(pair);

      if (minQty > 0 && finalAmount < minQty) {
        const remaining = remainingSize || finalAmount;
        if (minQty >= remaining) {
          // Минимальный лот >= остатка — закрываем всё
          finalAmount = remaining;
          logger.info(`Скорректирован объём ${pair}: ${amount} → ${finalAmount} (minQty ${minQty} >= остаток, закрытие всей позиции)`);
        } else {
          // Округляем вверх до минимума
          finalAmount = minQty;
          logger.info(`Скорректирован объём ${pair}: ${amount} → ${finalAmount} (меньше minQty ${minQty})`);
        }
      }

      // Округляем до stepSize
      finalAmount = this._roundToStep(finalAmount, stepSize);
      if (finalAmount <= 0) finalAmount = minQty || amount;

      if (finalAmount !== amount) {
        logger.info(`Скорректирован объём ${pair}: ${amount} → ${finalAmount}`);
      }

      logger.info(`Частичное закрытие ${side} ${pair}: объём=${finalAmount} (${reason})`);
      const order = await this.exchange.createOrder(this._toLinear(pair), 'market', closeSide, finalAmount, undefined, {
        reduceOnly: true,
      });
      logger.info(`Частичное закрытие OK: ${order.id} avg=${order.average || '?'}`);
      return order;
    }, `closePartial(${pair})`);
  }

  /**
   * Отменить открытый ордер.
   */
  async cancelOrder(orderId, pair) {
    return this._retry(async () => {
      logger.info(`Отмена ордера ${orderId} на ${pair}`);
      await this.exchange.cancelOrder(orderId, this._toLinear(pair));
      logger.info(`Ордер ${orderId} отменён`);
    }, `cancelOrder(${pair})`);
  }

  /**
   * Проверить статус ордера (open, closed, canceled).
   */
  async fetchOrder(orderId, pair) {
    return this._retry(async () => {
      return this.exchange.fetchOpenOrder(orderId, this._toLinear(pair));
    }, `fetchOrder(${pair})`);
  }

  /**
   * Fetch 24h ticker for volume data.
   */
  async fetchTicker(pair) {
    this.validatePair(pair);
    return this._retry(async () => {
      return this.exchange.fetchTicker(this._toLinear(pair));
    }, `fetchTicker(${pair})`);
  }

  /**
   * Get open positions.
   * Без аргумента — запрашивает ВСЕ позиции через Bybit unified account API.
   * С аргументом — запрашивает конкретную пару.
   */
  async fetchOpenPositions(pair) {
    return this._retry(async () => {
      let allPositions = [];

      if (pair) {
        // Конкретная пара
        try {
          const positions = await this.exchange.fetchPositions([this._toLinear(pair)]);
          allPositions = positions;
        } catch (err) {
          logger.warn(`fetchOpenPositions(${pair}): ${err.message}`);
        }
      } else {
        // ВСЕ позиции — без фильтра по парам
        try {
          allPositions = await this.exchange.fetchPositions();
        } catch (err) {
          logger.warn(`fetchOpenPositions(all): ${err.message}`);
        }
      }

      // Filter: use Math.abs to catch both longs (positive) and shorts (negative)
      const open = allPositions.filter((p) => Math.abs(p.contracts) > 0);
      if (open.length > 0) {
        logger.info(`fetchOpenPositions: ${allPositions.length} raw, ${open.length} open`);
      }
      return open;
    }, 'fetchOpenPositions');
  }

  /**
   * Retry wrapper with exponential backoff.
   */
  async _retry(fn, label) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (error) {
        const isRetryable =
          error instanceof ccxt.NetworkError ||
          error instanceof ccxt.RequestTimeout ||
          error instanceof ccxt.ExchangeNotAvailable ||
          error instanceof ccxt.DDoSProtection;

        if (isRetryable && attempt < MAX_RETRIES) {
          const delay = BASE_RETRY_DELAY * Math.pow(2, attempt - 1);
          logger.warn(`${label}: attempt ${attempt} failed (${error.message}), retrying in ${delay}ms...`);
          await new Promise((r) => setTimeout(r, delay));
        } else {
          logger.error(`${label}: failed after ${attempt} attempts — ${error.message}`);
          throw error;
        }
      }
    }
  }


  /**
   * Установить плечо для пары.
   */
  async setLeverage(pair, leverage = 10) {
    this.validatePair(pair);
    return this._retry(async () => {
      try {
        const params = {
          category: 'linear',
          symbol: pair.replace('/', ''),
          buyLeverage: String(leverage),
          sellLeverage: String(leverage),
        };
        const response = await this.exchange.privatePostV5PositionSetLeverage(params);
        const retCode = Number(response?.retCode ?? response?.ret_code ?? 0);
        if (retCode !== 0 && retCode !== 110043) {
          throw new Error(`setLeverage: retCode=${retCode} msg=${response?.retMsg || '?'}`);
        }
        return response;
      } catch (err) {
        // 110043 = "leverage not modified" — плечо уже установлено, не ошибка
        if (err.message.includes('110043') || err.message.includes('not modified')) {
          return null;
        }
        throw err;
      }
    }, `setLeverage(${pair}, ${leverage}x)`);
  }

  // ────────────────────────────────────────────────
  //  WebSocket (ccxt.pro) — реалтайм ордера и позиции
  // ────────────────────────────────────────────────

  /**
   * Инициализировать WebSocket-подключение (ccxt.pro).
   * Вызывается один раз при старте бота.
   */
  _initWsExchange() {
    if (this._wsExchange) return;

    const apiKey = process.env.BYBIT_API_KEY;
    const apiSecret = process.env.BYBIT_API_SECRET;
    const isDemo = process.env.BYBIT_DEMO === 'true';

    this._wsExchange = new ccxt.pro.bybit({
      apiKey,
      secret: apiSecret,
      enableRateLimit: true,
      options: {
        defaultType: 'linear',
        adjustForTimeDifference: true,
        enableDemoTrading: isDemo,
      },
      timeout: 30000,
    });

    if (isDemo) {
      this._wsExchange.urls['api'] = this._wsExchange.urls['demotrading'];
    } else if (process.env.BYBIT_TESTNET === 'true') {
      this._wsExchange.setSandboxMode(true);
    }

    logger.info('Bybit WebSocket: инициализирован');
  }

  /**
   * Подписаться на обновления ордеров через WebSocket.
   * @param {function} callback — (order) => {} вызывается при каждом обновлении ордера
   */
  async startOrdersWebSocket(callback) {
    this._initWsExchange();
    this._wsOrdersRunning = true;
    logger.info('Bybit WebSocket: подписка на ордера...');

    while (this._wsOrdersRunning) {
      try {
        const orders = await this._wsExchange.watchOrders();
        for (const order of orders) {
          try {
            callback(order);
          } catch (err) {
            logger.error(`WS order callback error: ${err.message}`);
          }
        }
      } catch (err) {
        if (!this._wsOrdersRunning) break;
        logger.warn(`WS orders error: ${err.message}, reconnecting in 5s...`);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  /**
   * Подписаться на обновления позиций через WebSocket.
   * @param {function} callback — (positions) => {} вызывается при изменении позиций
   */
  async startPositionsWebSocket(callback) {
    this._initWsExchange();
    this._wsPositionsRunning = true;
    logger.info('Bybit WebSocket: подписка на позиции...');

    while (this._wsPositionsRunning) {
      try {
        const positions = await this._wsExchange.watchPositions();
        try {
          callback(positions);
        } catch (err) {
          logger.error(`WS positions callback error: ${err.message}`);
        }
      } catch (err) {
        if (!this._wsPositionsRunning) break;
        logger.warn(`WS positions error: ${err.message}, reconnecting in 5s...`);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  /**
   * Остановить WebSocket-подписки.
   */
  async stopWebSockets() {
    this._wsOrdersRunning = false;
    this._wsPositionsRunning = false;
    if (this._wsExchange) {
      try {
        await this._wsExchange.close();
      } catch (e) { /* ignore */ }
      this._wsExchange = null;
    }
    logger.info('Bybit WebSocket: остановлен');
  }

  /**
   * Получить историю исполнений (execution list) за период.
   * Используется для подсчёта комиссий.
   * @param {string} startTime — ISO timestamp
   * @param {string} endTime — ISO timestamp
   */
  async fetchExecutions(startTime, endTime) {
    return this._retry(async () => {
      const params = {
        category: 'linear',
        limit: 100,
      };
      if (startTime) params.startTime = String(new Date(startTime).getTime());
      if (endTime) params.endTime = String(new Date(endTime).getTime());

      const response = await this.exchange.privateGetV5ExecutionList(params);
      const list = response?.result?.list || [];
      return list.map(e => ({
        symbol: e.symbol,
        side: e.side,
        execType: e.execType,
        execQty: parseFloat(e.execQty || '0'),
        execPrice: parseFloat(e.execPrice || '0'),
        execFee: parseFloat(e.execFee || '0'),
        feeRate: parseFloat(e.feeRate || '0'),
        isMaker: e.isMaker === 'true' || e.isMaker === true,
        execTime: parseInt(e.execTime || '0'),
        orderId: e.orderId,
      }));
    }, 'fetchExecutions');
  }
}

module.exports = BybitExchange;

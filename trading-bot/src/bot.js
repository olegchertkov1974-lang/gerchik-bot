'use strict';

/**
 * Main Trading Bot
 *
 * Orchestrates strategy, exchange, risk management, AI filter,
 * webhook server (n8n integration), and Telegram notifications.
 * Runs via CLI — no web interface.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env'), override: true });

const fs = require('fs');
const path = require('path');
const GerchikLevels = require('../../var/strategies/gerchik-levels');
const BybitExchange = require('./bybit-exchange');
const RiskManager = require('./risk-manager');
const TelegramNotifier = require('./telegram-notifier');
const AIFilter = require('./ai-filter');
const WebhookServer = require('./webhook-server');
const TradeStore = require('./trade-store');
const logger = require('./logger');

// 50 пар для ежедневного скана волатильности (методология Герчика)
const SCAN_PAIRS = [
  'BTC/USDT',    'ETH/USDT',    'SOL/USDT',    'BNB/USDT',    'XRP/USDT',
  'DOGE/USDT',   'ADA/USDT',    'AVAX/USDT',   'LINK/USDT',   'LTC/USDT',
  'DOT/USDT',    'UNI/USDT',    'ATOM/USDT',   'NEAR/USDT',   'APT/USDT',
  'ARB/USDT',    'OP/USDT',     'INJ/USDT',    'SUI/USDT',    'TRX/USDT',
  'FTM/USDT',    'HBAR/USDT',   'ICP/USDT',    'VET/USDT',    'EOS/USDT',
  'XLM/USDT',    'ALGO/USDT',   'SAND/USDT',   'MANA/USDT',   'AXS/USDT',
  'RENDER/USDT', 'FET/USDT',    'WIF/USDT',    'SEI/USDT',    'TIA/USDT',
  'JUP/USDT',    'PYTH/USDT',   'ZRO/USDT',    'STRK/USDT',   'ETHFI/USDT',
  'ONDO/USDT',   'BLUR/USDT',   'GMX/USDT',    'PENDLE/USDT', 'AAVE/USDT',
  'MKR/USDT',    'SNX/USDT',    'CRV/USDT',    'LDO/USDT',    'EIGEN/USDT',
];

const DEFAULT_ACTIVE_PAIRS = [
  'BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'XRP/USDT',
  'DOGE/USDT', 'ADA/USDT', 'AVAX/USDT', 'LINK/USDT', 'LTC/USDT',
];

// Активные торговые пары — загружаются из .env ACTIVE_PAIRS, управляются через Telegram
let PAIRS = (process.env.ACTIVE_PAIRS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
if (!PAIRS.length) PAIRS = [...DEFAULT_ACTIVE_PAIRS];
// Герчик: 1D — уровни, 4H — подтверждение тренда, 5m — вход
const TF_LEVELS = '1d';     // таймфрейм для построения уровней
const TF_CONFIRM = '4h';    // таймфрейм для подтверждения тренда
const TF_ENTRY = '5m';      // таймфрейм для паттернов входа
const VOLUME_THRESHOLD = parseFloat(process.env.VOLUME_THRESHOLD) || 1000000;
const AI_FILTER_ENABLED = process.env.AI_FILTER_ENABLED !== 'false';
const AI_MIN_CONFIDENCE = parseInt(process.env.AI_MIN_CONFIDENCE, 10) || 60;
const ORDER_SAFETY_TTL_MS = 30 * 60 * 1000; // страховочный таймаут 30 мин
const MAX_ORDER_ATTEMPTS = 2;                // макс попыток на один сетап
const BREAKEVEN_ENABLED = true;
const DAILY_LOSS_LIMIT_PCT = parseFloat(process.env.DAILY_LOSS_LIMIT_PCT) || 0; // 0 = выключено

// ── Интервалы (мс) ──
const INTERVAL_1M = 60 * 1000;              // базовый цикл — 1 минута
const INTERVAL_5M = 5 * 60 * 1000;          // поиск входа — каждые 5 минут
const INTERVAL_4H = 4 * 60 * 60 * 1000;     // фильтр тренда — каждые 4 часа
const INTERVAL_1D = 24 * 60 * 60 * 1000;    // уровни — раз в сутки

class TradingBot {
  constructor() {
    this.strategy = new GerchikLevels();
    this.exchange = new BybitExchange();
    this.riskManager = new RiskManager({
      riskPct: parseFloat(process.env.RISK_PCT) || 1,
      minRR: parseFloat(process.env.MIN_RR) || 3,
      maxConcurrentPositions: parseInt(process.env.MAX_POSITIONS, 10) || 3,
    });
    this.notifier = new TelegramNotifier();
    this.aiFilter = new AIFilter();
    this.webhook = new WebhookServer(this);
    this.tradeStore = new TradeStore();
    this.running = false;
    this.paused = false;
    this.positions = new Map(); // pair -> position info (макс 1 на инструмент)
    this._pendingOrders = new Map(); // orderId -> { pair, position, signal, sizing, createdAt, attempts, level, direction }
    this._pendingSLSetup = new Map(); // pair -> { pos, resolve } — ждём WS подтверждения позиции
    this._orderAttempts = new Map(); // pair -> количество попыток на текущий сетап
    this._dailyLevels = new Map();  // pair -> массив уровней с 1D
    this._lastReportDate = null;    // дата последнего отправленного отчёта (YYYY-MM-DD)

    // ── Расписание задач (timestamp последнего выполнения) ──
    this._lastLevelUpdate = 0;      // 1D уровни
    this._last4HUpdate = 0;         // 4H тренд (кэш)
    this._last5mScan = 0;           // 5m поиск входа
    this._lastBreakevenCheck = 0;   // безубыток (1m)
    this._4hTrendCache = new Map(); // pair -> { trend, confirmation, approach, candles, updatedAt }
    this._marketRegime = null;
    this._marketRegimeUpdatedAt = 0;
    this._consecutiveLosses = 0;
    this._botState = 'ACTIVE'; // ACTIVE | RECOVERY | BUILD_UP | PAUSE
    this._recoveryWins = 0;
    this._buildUpWins = 0;

    // Дневная статистика по ордерам (сбрасывается в отчёте)
    this._dayStats = this._loadDayStats();

    // Конфиг бота (стартовый баланс, дата начала — не перезаписывается)
    this._botConfig = this._loadBotConfig();

    // Мьютекс: orderId → Promise. Предотвращает двойную обработку одного fill
    // когда WS и REST polling одновременно видят исполненный ордер.
    this._processingOrders = new Map();

    // Скан волатильности
    this._lastVolatilityScanKey = null; // 'YYYY-MM-DD_H' — защита от двойного запуска
    this._volatilityReport = null;      // последний отчёт {top10, timestamp, utcHour}
  }

  async start() {
    logger.info('=== Gerchik Levels Trading Bot starting ===');
    logger.info(`Пары: ${PAIRS.join(', ')}`);
    logger.info(`Таймфреймы: ${TF_LEVELS} (уровни), ${TF_CONFIRM} (тренд), ${TF_ENTRY} (вход)`);
    logger.info(`Расписание: 1D раз/сутки | 4H каждые 4ч | 5m каждые 5мин | безубыток 1мин`);
    logger.info(`Мин объём: ${VOLUME_THRESHOLD}`);
    logger.info(`AI фильтр: ${AI_FILTER_ENABLED && this.aiFilter.enabled ? 'ВКЛ' : 'ВЫКЛ'}`);
    logger.info(`n8n webhook: ${this.webhook.n8nWebhookUrl || 'не настроен'}`);

    this.running = true;

    // Start webhook server for n8n
    this.webhook.start();

    // Start Telegram command polling
    this.notifier.setBot(this);
    this.notifier.startPolling();

    // Sync open positions from Bybit
    await this._syncPositionsFromExchange();

    // Установить плечо 10x на все пары
    await this._setLeverageAll();

    // Graceful shutdown
    const shutdown = () => this.stop();
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    try {
      await this.notifier.sendMessage(
        '🤖 <b>Бот запущен (Герчик)</b>\n' +
        `Пары: ${PAIRS.join(', ')}\n` +
        `ТФ: ${TF_LEVELS} уровни | ${TF_CONFIRM} тренд | ${TF_ENTRY} вход\n` +
        `Расписание: 1D/сутки | 4H/4ч | 5m/5мин | BE/1мин | WS ордера\n` +
        `AI: ${AI_FILTER_ENABLED && this.aiFilter.enabled ? 'ВКЛ' : 'ВЫКЛ'}\n` +
        `Риск: ${this.riskManager.riskPct}% | Макс 1 позиция на инструмент`
      );
    } catch (e) {
      logger.warn(`Ошибка Telegram при старте: ${e.message}`);
    }

    // Notify n8n
    await this.webhook.pushToN8n('bot_started', {
      pairs: PAIRS,
      timeframes: [TF_LEVELS, TF_CONFIRM, TF_ENTRY],
      riskPct: this.riskManager.riskPct,
    });

    // ── Первичная загрузка данных ──
    logger.info('Первичная загрузка 1D уровней...');
    await this._updateDailyLevels();
    this._lastLevelUpdate = Date.now();

    logger.info('Первичная загрузка 4H трендов...');
    await this._update4HTrends();
    this._last4HUpdate = Date.now();

    // ── WebSocket для ордеров и позиций ──
    this._startWebSockets();

    // ── Основной цикл — 1 минута ──
    logger.info('Основной цикл запущен (интервал 1 мин)');
    while (this.running) {
      if (!this.paused) {
        try {
          await this._scheduledTick();
        } catch (err) {
          logger.error(`Tick error: ${err.message}`);
          await this.notifier.notifyError(err);
          await this.webhook.pushToN8n('error', { message: err.message });
        }
      }

      if (this.running) {
        // Ждём до начала следующей минуты (выровнено по часам)
        const sleepMs = this._msUntilNextMinute();
        logger.debug(`Сон ${(sleepMs / 1000).toFixed(0)}с до следующей минуты`);
        await new Promise((r) => setTimeout(r, sleepMs));
      }
    }
  }

  // ────────────────────────────────────────────────
  //  УТИЛИТЫ РАСПИСАНИЯ
  // ────────────────────────────────────────────────

  /**
   * Миллисекунды до начала следующей минуты (+ 2с буфер на закрытие свечи).
   */
  _updateBotState() {
    if (this._consecutiveLosses >= 5 && this._botState !== 'PAUSE') {
      this._botState = 'PAUSE';
      this._recoveryWins = 0;
      this._buildUpWins = 0;
      logger.info('Режим ПАУЗА: 5 стопов подряд');
      this.notifier.sendMessage('⛔ Пауза: 5 стопов подряд. Вход остановлен.').catch(() => {});
    } else if (this._consecutiveLosses >= 3 && this._botState === 'ACTIVE') {
      this._botState = 'RECOVERY';
      this._recoveryWins = 0;
      logger.info('Режим RECOVERY: 3+ стопа, риск 50%');
      this.notifier.sendMessage('⚠️ Режим восстановления: риск снижен до 50%.').catch(() => {});
    }
    if (this._botState === 'RECOVERY' && this._recoveryWins >= 2) {
      this._botState = 'BUILD_UP';
      this._buildUpWins = 0;
      logger.info('Режим BUILD-UP: 2 победы в RECOVERY — риск 75%');
      this.notifier.sendMessage('📈 Режим BUILD-UP: рынок возвращается. Риск 75%.').catch(() => {});
    }
    if (this._botState === 'BUILD_UP' && this._buildUpWins >= 2) {
      this._botState = 'ACTIVE';
      this._buildUpWins = 0;
      this._consecutiveLosses = 0;
      logger.info('Режим АКТИВЕН: подтверждено — полный риск 100%');
      this.notifier.sendMessage('🟢 Бот полностью активен. Риск 100%.').catch(() => {});
    }
  }

  _msUntilNextMinute() {
    const now = Date.now();
    const nextMin = Math.ceil(now / 60000) * 60000 + 2000; // +2с буфер
    return Math.max(nextMin - now, 5000); // минимум 5с
  }

  /**
   * Проверить, закрылась ли новая 5m свеча с последнего сканирования.
   */
  _is5mCandleClosed() {
    const now = Date.now();
    const current5mSlot = Math.floor(now / INTERVAL_5M);
    const last5mSlot = Math.floor(this._last5mScan / INTERVAL_5M);
    return current5mSlot > last5mSlot;
  }

  /**
   * Проверить, закрылась ли новая 4H свеча.
   * 4H свечи закрываются в 00:00, 04:00, 08:00, 12:00, 16:00, 20:00 UTC.
   */
  _is4HCandleClosed() {
    const now = Date.now();
    const current4HSlot = Math.floor(now / INTERVAL_4H);
    const last4HSlot = Math.floor(this._last4HUpdate / INTERVAL_4H);
    return current4HSlot > last4HSlot;
  }

  /**
   * Проверить, наступил ли новый день (для обновления 1D уровней).
   */
  _isNewDay() {
    const now = Date.now();
    const currentDaySlot = Math.floor(now / INTERVAL_1D);
    const lastDaySlot = Math.floor(this._lastLevelUpdate / INTERVAL_1D);
    return currentDaySlot > lastDaySlot;
  }

  // ────────────────────────────────────────────────
  //  WebSocket (реалтайм ордера/позиции)
  // ────────────────────────────────────────────────

  /**
   * Запустить WebSocket подписки на ордера и позиции.
   */
  _startWebSockets() {
    // WS ордера — обработка fill/cancel в реалтайме
    this.exchange.startOrdersWebSocket((order) => {
      this._handleWsOrder(order);
    }).catch(err => {
      logger.error(`WS orders fatal: ${err.message}`);
    });

    // WS позиции — детекция закрытия SL/TP
    this.exchange.startPositionsWebSocket((positions) => {
      this._handleWsPositions(positions);
    }).catch(err => {
      logger.error(`WS positions fatal: ${err.message}`);
    });

    logger.info('WebSocket подписки запущены (ордера + позиции)');
  }

  /**
   * Обработка WS-события ордера (fill, cancel).
   */
  _handleWsOrder(order) {
    const orderId = order.id;
    const pending = this._pendingOrders.get(orderId);
    if (!pending) return; // не наш ордер или уже обработан

    if (order.status === 'closed') {
      // Мьютекс: если fill уже обрабатывается (WS или polling) — пропускаем.
      // Это предотвращает двойной вызов setTradingStop на одну позицию.
      if (this._processingOrders.has(orderId)) {
        logger.warn(`WS: ордер ${orderId} уже обрабатывается — пропуск дублирующего события`);
        return;
      }
      const promise = this._onOrderFilled(orderId, pending, order);
      this._processingOrders.set(orderId, promise);
      promise
        .catch(err => logger.error(`WS onOrderFilled error: ${err.message}`))
        .finally(() => this._processingOrders.delete(orderId));
    } else if (order.status === 'canceled') {
      this._pendingOrders.delete(orderId);
      if (pending.attemptKey) {
        const attempts = (this._orderAttempts.get(pending.attemptKey) || 0) + 1;
        this._orderAttempts.set(pending.attemptKey, attempts);
      }
      logger.info(`WS: ордер ${orderId} отменён биржей (PostOnly?)`);
      const _sideRu = pending.signal && pending.signal.signal === 'long' ? 'ЛОНГ' : 'ШОРТ';
      const _emoji = pending.signal && pending.signal.signal === 'long' ? '🟢' : '🔴';
      this.notifier.sendMessage(
        `❌ <b>Ордер отменён биржей (PostOnly)</b>
` +
        `${_emoji} ${_sideRu} ${pending.pair}
` +
        `Цена ушла от уровня — ордер не выставлен`
      ).catch(() => {});
    }
  }

  /**
   * Обработка исполненного ордера (вызывается из WS или polling).
   */
  async _onOrderFilled(orderId, pending, order) {
    this._pendingOrders.delete(orderId);

    // Захватываем реальную цену fill (может отличаться от запланированной)
    const fillPrice = order.average || order.price || pending.position.entry;
    if (fillPrice && fillPrice !== pending.position.entry) {
      logger.info(`${pending.pair}: реальный fill ${fillPrice} (план: ${pending.position.entry})`);
      pending.position.entry = fillPrice;
    }

    this.positions.set(pending.pair, pending.position);
    this.riskManager.addPosition(pending.position);

    await this._setPositionStopLossAndTakeProfit(pending.pair, pending.position);

    // Верификация через 10 сек: проверить SL/TP, TP1/TP2 на случай если всё не успело выставиться
    setTimeout(() => {
      this._verifyPositionState(pending.pair).catch(err =>
        logger.warn(`${pending.pair}: ошибка верификации позиции: ${err.message}`)
      );
    }, 10000);

    await this.notifier.notifyTrade({
      ...pending.signal,
      positionSize: pending.sizing.size,
      riskAmount: pending.sizing.riskAmount,
      riskPct: pending.sizing.riskPct,
    });
    await this.webhook.pushToN8n('trade_opened', pending.position);
    this.trackOrderFilled();
    logger.info(`Ордер исполнен: ${orderId} — ${pending.pair}`);
  }

  /**
   * Обработка WS-события позиций (детекция закрытия по SL/TP).
   */
  _handleWsPositions(wsPositions) {
    // Создаём Set пар, которые всё ещё открыты на бирже
    const openPairsOnExchange = new Set();
    for (const p of wsPositions) {
      const contracts = Math.abs(parseFloat(p.contracts || p.info?.size || 0));
      if (contracts > 0) {
        const pair = p.symbol ? p.symbol.replace(':USDT', '') : '';
        openPairsOnExchange.add(pair);

        // WS триггер: если эта пара ждёт выставления SL — немедленно резолвим
        if (this._pendingSLSetup.has(pair)) {
          const pending = this._pendingSLSetup.get(pair);
          this._pendingSLSetup.delete(pair);
          logger.info(`${pair}: WS подтвердил позицию (${contracts} контр.) — выставляем SL немедленно`);
          pending.resolve('ws');
        }
      }
    }

    if (this.positions.size === 0) return;

    // Проверяем, исчезли ли наши позиции
    for (const [posKey] of this.positions) {
      const pair = posKey.split(':')[0];
      if (!openPairsOnExchange.has(pair)) {
        // Позиция закрыта — обработаем в следующем _detectClosedPositions()
        logger.info(`WS: позиция ${pair} исчезла с биржи — будет обработана в следующем цикле`);
      }
    }
  }

  /**
   * Sync open positions from Bybit on startup so bot doesn't lose track after restart.
   */
  async _syncPositionsFromExchange() {
    try {
      const openPositions = await this.exchange.fetchOpenPositions();
      logger.info(`Sync: found ${openPositions.length} open positions on exchange`);

      if (openPositions.length === 0) {
        return;
      }

      for (const pos of openPositions) {
        // Log raw position data for debugging
        logger.info(`Sync raw: symbol=${pos.symbol} side=${pos.side} contracts=${pos.contracts} entryPrice=${pos.entryPrice}`);

        // pos.symbol is like 'BTC/USDT:USDT', extract base pair
        let pair = pos.symbol ? pos.symbol.replace(':USDT', '') : null;
        // Fallback: try info.symbol (e.g. 'BTCUSDT' -> 'BTC/USDT')
        if (!pair && pos.info?.symbol) {
          const raw = pos.info.symbol;
          const base = raw.replace('USDT', '');
          pair = `${base}/USDT`;
        }

        if (!pair || !PAIRS.includes(pair)) {
          logger.warn(`Sync: skipping unrecognized pair ${pair || pos.symbol}`);
          continue;
        }

        const side = pos.side === 'long' ? 'long' : 'short';
        // Use absolute value — shorts have negative contracts
        const size = Math.abs(pos.contracts || parseFloat(pos.info?.size || '0'));
        const posKey = pair; // макс 1 позиция на инструмент

        const entryPrice = pos.entryPrice || parseFloat(pos.info?.avgPrice || '0');
        const stopLossPrice = pos.stopLossPrice || parseFloat(pos.info?.stopLoss || '0');
        const takeProfitPrice = pos.takeProfitPrice || parseFloat(pos.info?.takeProfit || '0');

        // Определяем, был ли SL перенесён в безубыток
        const isBreakeven = stopLossPrice > 0 && Math.abs(stopLossPrice - entryPrice) / entryPrice < 0.001;

        // Для синхронизированных позиций восстанавливаем TP уровни из risk
        const syncRisk = stopLossPrice > 0 ? Math.abs(entryPrice - stopLossPrice) : 0;
        let syncTp1 = 0, syncTp2 = 0, syncTp3 = takeProfitPrice;
        if (syncRisk > 0) {
          if (side === 'long') {
            syncTp1 = entryPrice + syncRisk * 1;
            syncTp2 = entryPrice + syncRisk * 2;
            syncTp3 = entryPrice + syncRisk * 3;
          } else {
            syncTp1 = entryPrice - syncRisk * 1;
            syncTp2 = entryPrice - syncRisk * 2;
            syncTp3 = entryPrice - syncRisk * 3;
          }
        }

        const position = {
          id: posKey,
          side,
          entry: entryPrice,
          stopLoss: stopLossPrice,
          takeProfit: takeProfitPrice || syncTp3,
          tp1: syncTp1,
          tp2: syncTp2,
          tp3: syncTp3 || takeProfitPrice,
          _tp1Hit: isBreakeven, // если безубыток — скорее всего TP1 уже был
          _tp2Hit: false,
          _tp3Hit: false,
          _originalSize: size,
          _originalSL: stopLossPrice,
          size,
          orderId: 'synced',
          entryReason: 'Синхронизирована с биржи после рестарта',
          openedAt: pos.info?.createdTime ? new Date(parseInt(pos.info.createdTime)).toISOString() : (pos.timestamp ? new Date(pos.timestamp).toISOString() : new Date().toISOString()),
          _breakevenMoved: isBreakeven,
          _partialPnl: 0,
          _partialCloses: [],
        };

        this.positions.set(posKey, position);
        this.riskManager.addPosition(position);
        logger.info(`Synced position: ${side} ${pair} size=${size} entry=${position.entry}`);
      }

      logger.info(`Synced ${this.positions.size} positions from exchange`);

      if (this.positions.size > 0) {
        try {
          await this.notifier.sendMessage(
            `🔄 <b>Синхронизация</b>\nНайдено позиций на бирже: ${this.positions.size}`
          );
        } catch (e) { /* ignore */ }
      }
    } catch (err) {
      logger.error(`Failed to sync positions: ${err.message}`);
    }
  }

  /**
   * Установить плечо 10x на все пары при старте.
   */
  async _setLeverageAll() {
    const leverage = parseInt(process.env.LEVERAGE, 10) || 10;
    logger.info(`Установка плеча ${leverage}x на ${PAIRS.length} пар...`);
    let ok = 0, fail = 0;
    for (const pair of PAIRS) {
      try {
        await this.exchange.setLeverage(pair, leverage);
        ok++;
      } catch (err) {
        // 110043 = leverage not modified — OK
        if (!err.message.includes('110043')) {
          logger.warn(`setLeverage(${pair}): ${err.message}`);
          fail++;
        } else {
          ok++;
        }
      }
    }
    logger.info(`Плечо ${leverage}x установлено: ${ok} ок, ${fail} ошибок`);
  }

  /**
   * Проверка лимитных ордеров по методологии Герчика.
   *
   * Ордер живёт пока жив уровень. Отмена по 4 условиям:
   * 1. Пробой уровня — закрытие 5m свечи телом за уровнем (главный триггер)
   * 2. Противоположный сигнал — на 5m появился паттерн в другую сторону
   * 3. Смена контекста на 4H — новая свеча изменила тренд
   * 4. Страховочный таймаут — 30 мин (6 свечей 5m)
   *
   * Частичное исполнение:
   * - < 50% — закрываем рыночным, сделка не ведётся
   * - >= 50% — торгуем исполненным объёмом, остаток отменяем
   */
  async _checkPendingOrders() {
    for (const [orderId, pending] of [...this._pendingOrders]) {
      try {
        // Мьютекс: WS уже обрабатывает этот fill — пропускаем REST polling.
        if (this._processingOrders.has(orderId)) {
          logger.debug(`Polling: ордер ${orderId} обрабатывается WS — пропуск`);
          continue;
        }

        const order = await this.exchange.fetchOrder(orderId, pending.pair);

        // === ИСПОЛНЕН ===
        if (order.status === 'closed') {
          // Повторная проверка после await: WS мог успеть взять мьютекс пока мы ждали fetchOrder
          if (this._processingOrders.has(orderId)) {
            logger.warn(`Polling: ордер ${orderId} захвачен WS во время fetchOrder — пропуск`);
            continue;
          }

          const promise = this._onOrderFilled(orderId, pending, order);
          this._processingOrders.set(orderId, promise);
          await promise.finally(() => this._processingOrders.delete(orderId));
          continue;
        }

        // === ЧАСТИЧНОЕ ИСПОЛНЕНИЕ ===
        if (order.filled > 0 && order.remaining > 0) {
          const fillRatio = order.filled / (order.filled + order.remaining);
          if (fillRatio >= 0.5) {
            // >= 50% — торгуем исполненным объёмом, остаток отменяем
            this._pendingOrders.delete(orderId);
            await this.exchange.cancelOrder(orderId, pending.pair);

            pending.position.size = order.filled;
            this.positions.set(pending.pair, pending.position);
            this.riskManager.addPosition(pending.position);

            // SL/TP на исполненный объём
            await this._setPositionStopLossAndTakeProfit(pending.pair, pending.position);

            pending.sizing.size = order.filled;
            await this.notifier.notifyTrade({
              ...pending.signal,
              positionSize: order.filled,
              riskAmount: pending.sizing.riskAmount,
            });
            logger.info(`Частичное исполнение ${(fillRatio * 100).toFixed(0)}%: ${orderId} — торгуем ${order.filled}`);
            continue;
          }
          // < 50% — будет закрыт ниже при отмене
        }

        // === УЖЕ ОТМЕНЁН (PostOnly отклонён биржей или вручную) ===
        if (order.status === 'canceled') {
          this._pendingOrders.delete(orderId);

          // Увеличиваем счётчик попыток
          if (pending.attemptKey) {
            const attempts = (this._orderAttempts.get(pending.attemptKey) || 0) + 1;
            this._orderAttempts.set(pending.attemptKey, attempts);
            logger.info(`Ордер отменён биржей (PostOnly?): ${orderId}, попытка ${attempts}`);
          } else {
            logger.info(`Ордер отменён: ${orderId}`);
          }
          continue;
        }

        // === ПРОВЕРКА 4 УСЛОВИЙ ОТМЕНЫ ПО ГЕРЧИКУ ===
        let cancelReason = null;

        // Получаем последние 5m свечи (нужны для условий 1 и 2)
        let candles5m = null;
        try {
          candles5m = await this.exchange.fetchCandles(pending.pair, TF_ENTRY, 10);
        } catch (e) {
          logger.warn(`Ошибка получения 5m свечей для ${pending.pair}: ${e.message}`);
        }

        // 1. ПРОБОЙ УРОВНЯ — главный триггер
        //    Свеча 5m закрылась телом за уровнем → уровень сломан → немедленная отмена
        if (!cancelReason && pending.level && pending.direction && candles5m && candles5m.length > 0) {
          const lastCandle = candles5m[candles5m.length - 1];
          if (this.strategy.isLevelBroken(lastCandle, pending.level, pending.direction)) {
            cancelReason = `Пробой уровня ${pending.level.price.toFixed(2)} (5m свеча закрылась за уровнем) — уровень сломан`;
          }
        }

        // 2. ПРОТИВОПОЛОЖНЫЙ СИГНАЛ — на 5m появился паттерн входа в другую сторону
        //    Текущий ордер теряет смысл
        if (!cancelReason && pending.level && pending.direction && candles5m && candles5m.length >= 6) {
          const oppositeDir = pending.direction === 'long' ? 'short' : 'long';
          const dailyData = this._dailyLevels.get(pending.pair);
          const dailyLevels = dailyData ? dailyData.levels : [];

          const oppositeSignal = this.strategy.findEntryPattern(
            candles5m, pending.level, oppositeDir, dailyLevels
          );
          if (oppositeSignal) {
            cancelReason = `Противоположный сигнал: ${oppositeSignal.typeRu} ${oppositeDir.toUpperCase()} на 5m`;
          }
        }

        // 3. СМЕНА КОНТЕКСТА НА 4H — новая свеча изменила тренд
        //    Если при размещении ордера тренд совпадал, а теперь нет
        if (!cancelReason && pending.direction) {
          const cached4H = this._4hTrendCache.get(pending.pair);
          if (cached4H) {
            const currentTrend = cached4H.trend;
            const trendConflict =
              (pending.direction === 'long' && currentTrend === 'down') ||
              (pending.direction === 'short' && currentTrend === 'up');

            if (trendConflict) {
              cancelReason = `Смена контекста 4H: тренд стал ${currentTrend}, конфликтует с ${pending.direction}`;
            }
          }
        }

        // 4. СТРАХОВОЧНЫЙ ТАЙМАУТ — 30 минут (6 свечей 5m)
        //    Если ничего не сработало и ордер не исполнился — цена ушла в рейндж
        if (!cancelReason && Date.now() - pending.createdAt > ORDER_SAFETY_TTL_MS) {
          cancelReason = `Страховочный таймаут 30 мин — цена ушла в рейндж, сетап потерял актуальность`;
        }

        // === ОТМЕНА ===
        if (cancelReason) {
          this._pendingOrders.delete(orderId);

          // Частично исполнен < 50%? Закрываем рыночным, сделка не ведётся
          if (order.filled > 0) {
            const fillRatio = order.filled / (order.filled + order.remaining);
            if (fillRatio < 0.5) {
              try {
                await this.exchange.cancelOrder(orderId, pending.pair);
                await this.exchange.closePosition(pending.pair, pending.direction, order.filled);

                logger.info(
                  `ЧАСТИЧНОЕ ИСПОЛНЕНИЕ <50% ${pending.pair}: ` +
                  `исполнено ${order.filled} из ${order.filled + order.remaining} (${(fillRatio * 100).toFixed(0)}%) | ` +
                  `закрыто рыночным, сделка не ведётся | причина отмены: ${cancelReason}`
                );

                await this.notifier.sendMessage(
                  `⚠️ <b>Частичное исполнение <50%</b>\n` +
                  `${pending.pair} — исполнено ${(fillRatio * 100).toFixed(0)}% (${order.filled})\n` +
                  `Позиция закрыта рыночным ордером, сделка не ведётся\n` +
                  `Причина отмены: ${cancelReason}`
                );
              } catch (e) {
                logger.error(`Ошибка закрытия частичной позиции ${pending.pair}: ${e.message}`);
              }
            }
          } else {
            await this.exchange.cancelOrder(orderId, pending.pair);
          }

          // Счётчик попыток
          if (pending.attemptKey) {
            const attempts = (this._orderAttempts.get(pending.attemptKey) || 0) + 1;
            this._orderAttempts.set(pending.attemptKey, attempts);
          }

          const sideRu = pending.direction === 'long' ? 'ЛОНГ' : 'ШОРТ';
          await this.notifier.sendMessage(
            `⏰ <b>Ордер отменён</b>\n` +
            `${pending.direction === 'long' ? '🟢' : '🔴'} ${sideRu} ${pending.pair}\n` +
            `Уровень: <code>${pending.level ? pending.level.price.toFixed(2) : '?'}</code>\n\n` +
            `Причина: ${cancelReason}`
          );
          // Трекинг причин отмены для отчёта
          if (cancelReason.includes('Пробой уровня')) this.trackOrderCancelled('level_break');
          else if (cancelReason.includes('таймаут')) this.trackOrderCancelled('timeout');
          else if (cancelReason.includes('контекст')) this.trackOrderCancelled('context_change');
          else if (cancelReason.includes('Противоположный')) this.trackOrderCancelled('opposite_signal');
          else this.trackOrderCancelled('other');

          logger.info(`Ордер ${orderId} отменён: ${cancelReason}`);
        }
      } catch (err) {
        logger.error(`_checkPendingOrders ошибка ${orderId}: ${err.message}`);
        if (err.message.includes('not found') || err.message.includes('does not exist')) {
          this._pendingOrders.delete(orderId);
        }
      }
    }
  }

  /**
   * Детекция позиций, закрытых биржей (SL/TP на стороне Bybit).
   *
   * Определяет причину закрытия: стоп, тейк, или безубыток.
   * Сохраняет сделку в БД, отправляет уведомление, запускает AI анализ.
   */
  async _detectClosedPositions() {
    if (this.positions.size === 0) return;

    try {
      const exchangePositions = await this.exchange.fetchOpenPositions();
      const exchangePairs = new Set(
        exchangePositions.map((p) => p.symbol ? p.symbol.replace(':USDT', '') : '')
      );

      for (const [posKey, pos] of [...this.positions]) {
        const pair = posKey.split(':')[0];
        if (exchangePairs.has(pair)) continue;

        // Позиция исчезла с биржи — закрыта по SL/TP
        this.positions.delete(posKey);
        this.riskManager.removePosition(posKey);

        // Определяем причину закрытия и PnL
        let closeReason = 'Закрыта на бирже';
        let closeType = 'unknown'; // 'tp', 'sl', 'breakeven', 'liquidation', 'manual', 'unknown'
        let exitPrice = 0;
        let pnlEstimate = 0;

        try {
          // ── Шаг 1: получаем исполнения за последние 10 минут ──
          // Фильтруем ТОЛЬКО execType='Trade' — реальные рыночные исполнения.
          // Это исключает: Funding, BustTrade, Delivery, Settlement и другие
          // системные записи, которые имеют ту же сторону но не являются закрытием.
          let closeExec = null;
          try {
            const executions = await this.exchange.fetchExecutions(
              new Date(Date.now() - 10 * 60 * 1000).toISOString(),
              new Date().toISOString()
            );
            const rawSymbol = pair.replace('/', '');
            const closeSide = pos.side === 'long' ? 'Sell' : 'Buy';

            // Допустимые типы исполнений при закрытии:
            //   Trade        — рыночное/лимитное исполнение (SL, TP, ручное)
            //   AdlTrade     — Auto-Deleveraging (ADL)
            //   BustTrade    — ликвидация
            const CLOSE_EXEC_TYPES = new Set(['Trade', 'AdlTrade', 'BustTrade']);

            const closeExecs = executions.filter(e =>
              e.symbol === rawSymbol &&
              e.side   === closeSide &&
              e.execQty > 0 &&
              CLOSE_EXEC_TYPES.has(e.execType)
            );

            if (closeExecs.length > 0) {
              // Берём последнее исполнение по времени
              closeExec = closeExecs.reduce((latest, e) =>
                e.execTime > latest.execTime ? e : latest
              );
              exitPrice = closeExec.execPrice;
              logger.info(
                `${pair}: исполнение закрытия: execType=${closeExec.execType}` +
                ` side=${closeExec.side} qty=${closeExec.execQty} price=${exitPrice}` +
                ` time=${new Date(closeExec.execTime).toISOString()}`
              );
            } else {
              logger.warn(`${pair}: исполнений закрытия (Trade/AdlTrade/BustTrade) не найдено за 10 мин`);
            }
          } catch (execErr) {
            logger.warn(`${pair}: не удалось получить executions: ${execErr.message}`);
          }

          // ── Шаг 2: fallback на ticker если executions не дали результат ──
          if (!exitPrice) {
            const ticker = await this.exchange.fetchTicker(pair);
            exitPrice = ticker.last || ticker.close || 0;
            logger.info(`${pair}: цена закрытия из ticker (fallback): ${exitPrice}`);
          }

          // ── Шаг 3: PnL остатка + накопленный PnL от TP1/TP2 ──
          if (pos.side === 'long') {
            pnlEstimate = (exitPrice - pos.entry) * pos.size;
          } else {
            pnlEstimate = (pos.entry - exitPrice) * pos.size;
          }
          pnlEstimate += (pos._partialPnl || 0);

          // ── Шаг 4: определяем тип закрытия ──

          // Приоритет 1: execType напрямую говорит о ликвидации/ADL
          if (closeExec?.execType === 'BustTrade') {
            closeReason = `Ликвидация (BustTrade) @ ${exitPrice}`;
            closeType = 'liquidation';
          } else if (closeExec?.execType === 'AdlTrade') {
            closeReason = `Auto-Deleveraging (ADL) @ ${exitPrice}`;
            closeType = 'adl';

          // Приоритет 2: сопоставляем цену с уровнями SL/TP
          // Допуск ±0.5% — учитываем проскальзывание при высокой волатильности
          } else if (pos.side === 'long') {
            if (pos.takeProfit && exitPrice >= pos.takeProfit * 0.995) {
              closeReason = `Закрыта по Take Profit (${pos.takeProfit})`;
              closeType = 'tp';
            } else if (pos._breakevenMoved && pos.stopLoss === pos.entry && exitPrice <= pos.entry * 1.005) {
              closeReason = `Закрыта по безубытку (SL = вход ${pos.entry})`;
              closeType = 'breakeven';
            } else if (pos.stopLoss && exitPrice <= pos.stopLoss * 1.005) {
              closeReason = `Закрыта по Stop Loss (${pos.stopLoss})`;
              closeType = 'sl';
            } else {
              // Цена не совпала ни с SL ни с TP — возможно ручное закрытие
              closeReason = `Закрыта вручную или по неизвестной причине @ ${exitPrice}`;
              closeType = 'manual';
              logger.warn(
                `${pair}: причина закрытия не определена. exitPrice=${exitPrice}` +
                ` entry=${pos.entry} SL=${pos.stopLoss} TP=${pos.takeProfit}` +
                ` execType=${closeExec?.execType || 'n/a'}`
              );
            }
          } else {
            if (pos.takeProfit && exitPrice <= pos.takeProfit * 1.005) {
              closeReason = `Закрыта по Take Profit (${pos.takeProfit})`;
              closeType = 'tp';
            } else if (pos._breakevenMoved && pos.stopLoss === pos.entry && exitPrice >= pos.entry * 0.995) {
              closeReason = `Закрыта по безубытку (SL = вход ${pos.entry})`;
              closeType = 'breakeven';
            } else if (pos.stopLoss && exitPrice >= pos.stopLoss * 0.995) {
              closeReason = `Закрыта по Stop Loss (${pos.stopLoss})`;
              closeType = 'sl';
            } else {
              closeReason = `Закрыта вручную или по неизвестной причине @ ${exitPrice}`;
              closeType = 'manual';
              logger.warn(
                `${pair}: причина закрытия не определена. exitPrice=${exitPrice}` +
                ` entry=${pos.entry} SL=${pos.stopLoss} TP=${pos.takeProfit}` +
                ` execType=${closeExec?.execType || 'n/a'}`
              );
            }
          }
        } catch (e) {
          logger.warn(`_detectClosedPositions: ошибка получения цены ${pair}: ${e.message}`);
        }

        // Длительность позиции
        const durationMs = pos.openedAt ? Date.now() - new Date(pos.openedAt).getTime() : 0;
        const durationMin = Math.round(durationMs / 60000);
        const durationStr = durationMin < 60
          ? `${durationMin}м`
          : `${Math.floor(durationMin / 60)}ч ${durationMin % 60}м`;

        // R:R реализованный
        const risk = Math.abs(pos.entry - (pos._originalSL || pos.stopLoss));
        const realizedRR = risk > 0 ? (pnlEstimate / (risk * pos.size)).toFixed(1) : '?';

        // === ЛОГИРОВАНИЕ (Раздел 10 Герчика) ===
        const sideRu = pos.side === 'long' ? 'ЛОНГ' : 'ШОРТ';
        const closeIcon = closeType === 'tp' ? '✅' : closeType === 'breakeven' ? '🔒' : closeType === 'sl' ? '🛑' : '⬜';
        if (closeType === 'sl') {
          this._consecutiveLosses++;
        } else if (closeType === 'tp') {
          this._consecutiveLosses = 0;
          if (this._botState === 'RECOVERY') this._recoveryWins++;
          else if (this._botState === 'BUILD_UP') this._buildUpWins++;
        } else if (closeType === 'breakeven') {
          this._consecutiveLosses = 0;
        }
        this._updateBotState();

        // Информация о частичных закрытиях
        const partials = pos._partialCloses || [];
        const partialsStr = partials.length > 0
          ? partials.map(p => `${p.tp}: ${p.size} по ${p.price} (${p.pnl > 0 ? '+' : ''}${p.pnl})`).join(' | ')
          : 'нет';

        logger.info(
          `СДЕЛКА ЗАКРЫТА ${pair} ${sideRu} | ` +
          `результат: ${closeType} | PnL: ${pnlEstimate.toFixed(2)} USDT (${realizedRR}R) | ` +
          `вход: ${pos.entry} | выход: ${exitPrice} | ` +
          `SL: ${pos.stopLoss} | TP1: ${pos.tp1} TP2: ${pos.tp2} TP3: ${pos.tp3} | ` +
          `размер: ${pos.size}/${pos._originalSize || pos.size} | длительность: ${durationStr} | ` +
          `частичные: ${partialsStr} | ` +
          `причина закрытия: ${closeReason}`
        );

        // === УВЕДОМЛЕНИЕ В TELEGRAM ===
        const sideIcon = pos.side === 'long' ? '🟢' : '🔴';
        const pnlIcon = pnlEstimate > 0 ? '💰' : pnlEstimate < 0 ? '💸' : '🔒';

        let partialsMsg = '';
        if (partials.length > 0) {
          partialsMsg = '\n<b>Частичные закрытия:</b>\n' +
            partials.map(p => `  ${p.tp}: <code>${p.size}</code> по <code>${p.price}</code> (${p.pnl > 0 ? '+' : ''}${p.pnl} USDT)`).join('\n') +
            '\n';
        }

        const msg =
          `${closeIcon} <b>Позиция закрыта</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `${sideIcon} <b>${sideRu}</b> ${pair}\n\n` +
          `Вход: <code>${pos.entry}</code>\n` +
          `Выход: <code>${exitPrice || '?'}</code>\n` +
          `TP1: <code>${pos.tp1}</code> ${pos._tp1Hit ? '✅' : '❌'} | TP2: <code>${pos.tp2}</code> ${pos._tp2Hit ? '✅' : '❌'} | TP3: <code>${pos.tp3}</code> ${pos._tp3Hit ? '✅' : '❌'}\n` +
          `Размер: <code>${pos.size}/${pos._originalSize || pos.size}</code>\n` +
          partialsMsg +
          `\n${pnlIcon} PnL итого: <code>${pnlEstimate.toFixed(2)} USDT (${realizedRR}R)</code>\n` +
          `Длительность: ${durationStr}\n\n` +
          `Причина: ${closeReason}`;

        await this.notifier.sendMessage(msg);

        // === СОХРАНЕНИЕ В БД ===
        const closedAt = new Date().toISOString();
        const trade = {
          pair,
          timeframe: TF_ENTRY,
          side: pos.side,
          entry: pos.entry,
          exitPrice: exitPrice || 0,
          stopLoss: pos.stopLoss,
          takeProfit: pos.takeProfit,
          originalSL: pos._originalSL || pos.stopLoss,
          size: pos._originalSize || pos.size,
          pnl: parseFloat(pnlEstimate.toFixed(2)),
          realizedRR: realizedRR,
          closeType: closeType,
          breakevenMoved: !!pos._breakevenMoved,
          tp1Hit: !!pos._tp1Hit,
          tp2Hit: !!pos._tp2Hit,
          tp3Hit: !!pos._tp3Hit,
          partialCloses: JSON.stringify(pos._partialCloses || []),
          levelPrice: pos._levelPrice || null,
          levelClassification: pos._levelClassification || null,
          levelStrength: pos._levelStrength || null,
          entryPattern: pos._entryPattern || null,
          entryReason: pos.entryReason || '',
          exitReason: closeReason,
          duration: durationStr,
          openedAt: pos.openedAt || null,
          closedAt,
        };
        this.tradeStore.saveTrade(trade);

        // === AI АНАЛИЗ ПОСЛЕ ЗАКРЫТИЯ ===
        if (AI_FILTER_ENABLED && this.aiFilter.enabled) {
          try {
            const analysis = await this.aiFilter.analyzeTrade(trade);
            if (analysis) {
              this.tradeStore.saveAnalysis(closedAt, analysis);
              await this.notifier.sendMessage(
                `📊 <b>AI анализ сделки</b> ${pair}\n` +
                `Оценка: ${analysis.grade || '—'}\n` +
                `Уроки: ${(analysis.lessons || []).join('; ') || '—'}\n` +
                `Совет: ${analysis.improvement || '—'}`
              );
            }
          } catch (aiErr) {
            logger.warn(`AI анализ сделки ${pair}: ${aiErr.message}`);
          }
        }

        await this.webhook.pushToN8n('trade_closed', {
          pair, side: pos.side, closeType, reason: closeReason,
          pnl: pnlEstimate, realizedRR, exitPrice, duration: durationStr,
          breakevenMoved: !!pos._breakevenMoved,
        });
      }
    } catch (err) {
      logger.error(`_detectClosedPositions ошибка: ${err.message}`);
    }
  }

  // ────────────────────────────────────────────────
  //  ДНЕВНОЙ ФИНАНСОВЫЙ ОТЧЁТ
  // ────────────────────────────────────────────────

  _getBotConfigPath() {
    return path.resolve(__dirname, '..', 'data', 'bot-config.json');
  }

  _getDayStatsPath() {
    return path.resolve(__dirname, '..', 'data', 'day-stats.json');
  }

  _loadBotConfig() {
    const cfgPath = this._getBotConfigPath();
    try {
      if (fs.existsSync(cfgPath)) {
        return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      }
    } catch (e) {
      logger.warn(`Ошибка чтения bot-config.json: ${e.message}`);
    }
    return null; // будет инициализирован при первом тике
  }

  _saveBotConfig(config) {
    const cfgPath = this._getBotConfigPath();
    const dir = path.dirname(cfgPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2));
    this._botConfig = config;
  }

  _loadDayStats() {
    const p = this._getDayStatsPath();
    try {
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      }
    } catch (e) { /* ignore */ }
    return this._emptyDayStats();
  }

  _saveDayStats() {
    const p = this._getDayStatsPath();
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(this._dayStats, null, 2));
  }

  _emptyDayStats() {
    return {
      date: new Date().toISOString().slice(0, 10),
      balanceStart: 0,
      ordersPlaced: 0,
      ordersFilled: 0,
      ordersCancelled: 0,
      cancelReasons: { levelBreak: 0, timeout: 0, contextChange: 0, oppositeSignal: 0 },
      marginFailures: 0,
      totalFees: 0,
      makerFees: 0,
      takerFees: 0,
    };
  }

  /**
   * Инициализация конфига при первом запуске (сохраняет стартовый баланс).
   */
  async _initBotConfigIfNeeded(balance) {
    if (this._botConfig) return;

    const config = {
      startDate: '2026-03-30',
      startBalance: balance.total,
      peakBalance: balance.total,
      totalFees: 0,
    };
    this._saveBotConfig(config);
    logger.info(`Bot config initialized: startBalance=${config.startBalance}, startDate=${config.startDate}`);
  }

  /**
   * Обновить пиковый баланс (для расчёта просадки).
   */
  _updatePeakBalance(currentBalance) {
    if (!this._botConfig) return;
    if (currentBalance > this._botConfig.peakBalance) {
      this._botConfig.peakBalance = currentBalance;
      this._saveBotConfig(this._botConfig);
    }
  }

  /**
   * Трекинг ордеров для дневного отчёта.
   */
  trackOrderPlaced() {
    this._dayStats.ordersPlaced++;
    this._saveDayStats();
  }

  trackOrderFilled() {
    this._dayStats.ordersFilled++;
    this._saveDayStats();
  }

  trackOrderCancelled(reason) {
    this._dayStats.ordersCancelled++;
    if (reason === 'level_break') this._dayStats.cancelReasons.levelBreak++;
    else if (reason === 'timeout') this._dayStats.cancelReasons.timeout++;
    else if (reason === 'context_change') this._dayStats.cancelReasons.contextChange++;
    else if (reason === 'opposite_signal') this._dayStats.cancelReasons.oppositeSignal++;
    this._saveDayStats();
  }

  /**
   * Проверить, пора ли отправить ежедневный отчёт (17:00 UTC).
   */
  async _checkDailyReport() {
    const now = new Date();
    const utcHour = now.getUTCHours();
    const utcMinute = now.getUTCMinutes();
    const todayStr = now.toISOString().slice(0, 10);

    // Отправляем отчёт в 17:00-17:01 UTC (20:00 по Москве)
    if (utcHour === 17 && utcMinute < 2 && this._lastReportDate !== todayStr) {
      this._lastReportDate = todayStr;
      try {
        await this._generateAndSendDailyReport(todayStr);
      } catch (err) {
        logger.error(`Ошибка ежедневного отчёта: ${err.message}`);
      }
    }
  }

  /**
   * Генерация и отправка ежедневного отчёта.
   */
  async _generateAndSendDailyReport(dateStr) {
    logger.info('Генерация ежедневного отчёта...');

    const balance = await this.exchange.fetchBalance();
    const currentBalance = balance.total;

    // Баланс на начало дня
    const dayStart = this._dayStats.balanceStart || currentBalance;

    // Сделки за день из БД
    const todayTrades = this.tradeStore.getTradesToday(dateStr);
    const closedTrades = todayTrades.filter(t => t.exit_price);
    const openedTrades = todayTrades;

    let tp = 0, sl = 0, be = 0, totalPnl = 0;
    let rrValues = [];
    for (const t of closedTrades) {
      const pnl = t.pnl || 0;
      totalPnl += pnl;
      if (t.close_type === 'tp') tp++;
      else if (t.close_type === 'sl') sl++;
      else if (t.close_type === 'breakeven') be++;
      if (t.realized_rr) rrValues.push(parseFloat(t.realized_rr));
    }
    const wins = closedTrades.filter(t => (t.pnl || 0) > 0).length;
    const winRate = closedTrades.length > 0 ? ((wins / closedTrades.length) * 100).toFixed(1) : '0.0';
    const avgRR = rrValues.length > 0
      ? (rrValues.reduce((s, v) => s + v, 0) / rrValues.length).toFixed(2)
      : '—';

    // Комиссии из Bybit execution list
    let fees = { total: 0, maker: 0, taker: 0 };
    try {
      const startOfDay = `${dateStr}T00:00:00Z`;
      const endOfDay = `${dateStr}T23:59:59Z`;
      const executions = await this.exchange.fetchExecutions(startOfDay, endOfDay);
      for (const e of executions) {
        const fee = Math.abs(e.execFee);
        fees.total += fee;
        if (e.isMaker) fees.maker += fee;
        else fees.taker += fee;
      }
    } catch (err) {
      logger.warn(`Не удалось получить комиссии: ${err.message}`);
      fees = { total: this._dayStats.totalFees, maker: this._dayStats.makerFees, taker: this._dayStats.takerFees };
    }

    // Накопительная статистика
    const allTrades = this.tradeStore.getAllTrades();
    const allClosed = allTrades.filter(t => t.exit_price);
    const allWins = allClosed.filter(t => (t.pnl || 0) > 0).length;
    const allPnl = allClosed.reduce((s, t) => s + (t.pnl || 0), 0);
    const allRR = allClosed
      .filter(t => t.realized_rr)
      .map(t => parseFloat(t.realized_rr));
    const allAvgRR = allRR.length > 0
      ? (allRR.reduce((s, v) => s + v, 0) / allRR.length).toFixed(2)
      : '—';

    const startDate = this._botConfig?.startDate || '2026-03-30';
    const startBalance = this._botConfig?.startBalance || currentBalance;
    const peakBalance = this._botConfig?.peakBalance || currentBalance;
    const drawdown = peakBalance > 0 ? ((peakBalance - currentBalance) / peakBalance * 100) : 0;
    const daysSinceStart = Math.max(1, Math.ceil((Date.now() - new Date(startDate).getTime()) / (24 * 60 * 60 * 1000)));

    const bestTrade = allClosed.length > 0
      ? Math.max(...allClosed.map(t => t.pnl || 0))
      : 0;
    const worstTrade = allClosed.length > 0
      ? Math.min(...allClosed.map(t => t.pnl || 0))
      : 0;

    // Сохраняем общие комиссии в конфиг
    if (this._botConfig) {
      this._botConfig.totalFees = (this._botConfig.totalFees || 0) + fees.total;
      this._saveBotConfig(this._botConfig);
    }

    const report = {
      date: dateStr,
      balance: {
        current: currentBalance,
        dayStart: dayStart,
        change: currentBalance - dayStart,
        changePct: dayStart > 0 ? ((currentBalance - dayStart) / dayStart * 100) : 0,
      },
      trades: {
        opened: openedTrades.length,
        closed: closedTrades.length,
        tp, sl, be,
        pnl: totalPnl,
      },
      fees,
      orders: {
        placed: this._dayStats.ordersPlaced,
        filled: this._dayStats.ordersFilled,
        cancelled: this._dayStats.ordersCancelled,
        cancelReasons: { ...this._dayStats.cancelReasons },
        marginFailures: this._dayStats.marginFailures || 0,
      },
      daily: {
        netPnl: totalPnl - fees.total,
        winRate,
        avgRR,
      },
      cumulative: {
        startDate,
        days: daysSinceStart,
        startBalance,
        currentBalance,
        totalPnl: currentBalance - startBalance,
        totalPnlPct: startBalance > 0 ? ((currentBalance - startBalance) / startBalance * 100) : 0,
        totalTrades: allTrades.length,
        openPositions: this.positions.size,
        winRate: allClosed.length > 0 ? ((allWins / allClosed.length) * 100).toFixed(1) : '0.0',
        avgRR: allAvgRR,
        maxDrawdown: drawdown,
        totalFees: this._botConfig?.totalFees || fees.total,
        bestTrade,
        worstTrade,
        tradesPerDay: allTrades.length / daysSinceStart,
      },
    };

    await this.notifier.sendDailyReport(report);
    logger.info(`Ежедневный отчёт за ${dateStr} отправлен`);

    // Сбрасываем дневные счётчики
    this._dayStats = this._emptyDayStats();
    this._dayStats.balanceStart = currentBalance; // баланс на начало следующего дня
    this._saveDayStats();
    this._dailyLossNotified = false; // сброс флага дневного лимита
  }

  stop() {
    logger.info('Bot stopping...');
    this.running = false;
    this.notifier.stopPolling();
    this.webhook.stop();
    this.tradeStore.close();
    this.exchange.stopWebSockets().catch(() => {});
    this.notifier.sendMessage('🛑 <b>Бот остановлен</b>').catch(() => {});
    this.webhook.pushToN8n('bot_stopped', {}).catch(() => {});
  }

  /**
   * Основной цикл — выполняется каждую минуту.
   * Задачи запускаются по расписанию:
   *   - Каждую минуту: безубыток (если есть позиции), проверка ордеров, детекция закрытий
   *   - Каждые 5 минут (после закрытия 5m свечи): поиск входа
   *   - Каждые 4 часа (после закрытия 4H свечи): обновление тренда
   *   - Раз в сутки (после 00:00 UTC): обновление 1D уровней
   */
  async _scheduledTick() {
    const now = Date.now();
    const utcTime = new Date().toISOString().slice(11, 16);

    // ── Баланс (раз в 5 минут, не каждую минуту) ──
    let balance = this._cachedBalance;
    if (!balance || this._is5mCandleClosed()) {
      balance = await this.exchange.fetchBalance();
      this._cachedBalance = balance;
      logger.info(`Баланс: ${balance.free} USDT свободно (всего: ${balance.total})`);

      // Инициализация конфига бота при первом тике
      await this._initBotConfigIfNeeded(balance);
      this._updatePeakBalance(balance.total);

      if (!this._dayStats.balanceStart) {
        this._dayStats.balanceStart = balance.total;
        this._saveDayStats();
      }
    }

    // ── КАЖДУЮ МИНУТУ ──

    // Проверка ежедневного отчёта (17:00 UTC)
    await this._checkDailyReport();

    // Проверка лимитных ордеров (fallback к WS — polling на случай пропуска)
    await this._checkPendingOrders();

    // Детекция закрытых позиций (SL/TP на бирже)
    await this._detectClosedPositions();

    // Тейк-профиты (TP1/TP2/TP3) и безубыток — каждую минуту если есть позиции
    if (this.positions.size > 0) {
      await this._checkTakeProfitLevels();
      this._lastBreakevenCheck = now;
    }

    // ── ДВАЖДЫ В ДЕНЬ: скан волатильности 06:00 UTC (09 МСК) и 12:00 UTC (15 МСК) ──
    {
      const _vH = new Date().getUTCHours();
      const _vM = new Date().getUTCMinutes();
      if ((_vH === 6 || _vH === 12) && _vM === 0) {
        const _vK = `${new Date().toISOString().slice(0, 10)}_${_vH}`;
        if (this._lastVolatilityScanKey !== _vK) {
          this._lastVolatilityScanKey = _vK;
          const _msk = _vH + 3;
          logger.info(`[${utcTime}] ═══ Скан волатильности ${_vH}:00 UTC = ${_msk}:00 МСК ═══`);
          this._volatilityScan().catch(e => logger.error(`VolatilityScan: ${e.message}`));
        }
      }
    }

    // ── РАЗ В СУТКИ: 1D уровни (после 00:00 UTC) ──
    if (this._isNewDay()) {
      logger.info(`[${utcTime}] ═══ Обновление 1D уровней (новый день) ═══`);
      await this._updateDailyLevels();
      this._lastLevelUpdate = now;
    }

    // ── КАЖДЫЕ 4 ЧАСА: тренд 4H (после закрытия 4H свечи) ──
    if (this._is4HCandleClosed()) {
      logger.info(`[${utcTime}] ═══ Обновление 4H трендов (закрытие 4H свечи) ═══`);
      await this._update4HTrends();
      this._last4HUpdate = now;
    }

    // ── КАЖДЫЕ 5 МИНУТ: поиск входа на 5m (после закрытия 5m свечи) ──
    if (this._is5mCandleClosed()) {
      logger.info(`[${utcTime}] ─── Сканирование 5m входов (закрытие 5m свечи) ───`);
      this._last5mScan = now;

      // ── Режим рынка BTC (каждые 4 часа) ──
      if (now - this._marketRegimeUpdatedAt > 4 * 60 * 60 * 1000) {
        try {
          const btc1d = await this.exchange.fetchCandles('BTC/USDT', '1d', 25);
          this._marketRegime = GerchikLevels.detectMarketRegime(btc1d);
          this._marketRegimeUpdatedAt = now;
          const r = this._marketRegime;
          logger.info(`Режим рынка BTC: ${r.regime} | ATR: ${r.atrPct}% | Изменение 24ч: ${r.change24h}%`);
          try {
            const fs = require('fs');
            fs.writeFileSync('/opt/trading-bot/trading-bot/data/market-regime.json', JSON.stringify({
              ...this._marketRegime,
              updatedAt: new Date().toISOString(),
              consecutiveLosses: this._consecutiveLosses,
              botState: this._botState,
              recoveryWins: this._recoveryWins,
              buildUpWins: this._buildUpWins
            }));
          } catch (_) {}
        } catch (e) {
          logger.warn(`Не удалось обновить режим рынка: ${e.message}`);
        }
      }

      const CONCURRENCY = 10;
      for (let i = 0; i < PAIRS.length; i += CONCURRENCY) {
        const batch = PAIRS.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(pair =>
          this._processPairGerchik(pair, balance).catch(err =>
            logger.error(`Ошибка ${pair}: ${err.message}`)
          )
        ));
      }

      await this.webhook.pushToN8n('tick_complete', {
        balance,
        openPositions: this.positions.size,
        timestamp: new Date().toISOString(),
      });
    } else {
      // Не 5m граница — логируем что ждём
      const msTo5m = INTERVAL_5M - (now % INTERVAL_5M);
      const secTo5m = Math.round(msTo5m / 1000);
      logger.debug(`[${utcTime}] Ожидание закрытия 5m свечи через ${secTo5m}с | позиций: ${this.positions.size} | ордеров: ${this._pendingOrders.size}`);
    }
  }

  /**
   * Обновить 4H тренды для всех пар (кэш).
   */
  async _update4HTrends() {
    let updated = 0;
    for (const pair of PAIRS) {
      try {
        const candles4H = await this.exchange.fetchCandles(pair, TF_CONFIRM, 50);
        if (!candles4H || candles4H.length < 20) {
          logger.warn(`${pair}: недостаточно 4H свечей (${candles4H?.length || 0})`);
          continue;
        }

        const trend = this.strategy.detectTrend4H(candles4H);

        this._4hTrendCache.set(pair, {
          trend,
          candles: candles4H,
          updatedAt: Date.now(),
        });
        updated++;

        logger.info(`${pair}: 4H тренд = ${trend}`);
      } catch (err) {
        logger.error(`${pair}: ошибка обновления 4H тренда: ${err.message}`);
      }
    }
    logger.info(`4H тренды обновлены: ${updated}/${PAIRS.length} пар`);
  }

  /**
   * Обновить дневные уровни для всех пар.
   */
  async _updateDailyLevels() {
    for (const pair of PAIRS) {
      try {
        const dailyCandles = await this.exchange.fetchCandles(pair, TF_LEVELS, 120);
        if (!dailyCandles || dailyCandles.length < 30) {
          logger.warn(`${pair}: недостаточно дневных свечей (${dailyCandles?.length || 0})`);
          continue;
        }

        const levels = this.strategy.findLevels(dailyCandles);
        this._dailyLevels.set(pair, { levels, candles: dailyCandles });

        // Логирование найденных уровней
        for (const l of levels) {
          logger.info(
            `${pair} уровень: ${l.price.toFixed(2)} | ${l.classification} | ` +
            `сила: ${l.strength} | касаний: ${l.touches} | ` +
            `тип: ${l.type}${l.isMirror ? ' (зеркальный)' : ''}${l.hasFalseBreakout ? ' (лож.пробой)' : ''}`
          );
        }

        logger.info(`${pair}: найдено ${levels.length} уровней на 1D (из ${dailyCandles.length} свечей)`);
      } catch (err) {
        logger.error(`${pair}: ошибка обновления уровней: ${err.message}`);
      }
    }

    // Итого по всем парам
    let totalLevels = 0;
    for (const [pair, data] of this._dailyLevels) {
      totalLevels += data.levels.length;
    }
    logger.info(`Обновление уровней завершено: ${totalLevels} уровней по ${this._dailyLevels.size} парам`);
  }


  /**
   * Ежедневный скан волатильности 50 пар (методология Герчика).
   * Запускается в 06:00 UTC и 12:00 UTC.
   */
  async _volatilityScan() {
    const results = [];

    for (const pair of SCAN_PAIRS) {
      try {
        const candles = await this.exchange.fetchCandles(pair, '1d', 16);
        if (!candles || candles.length < 5) continue;

        const currentPrice = candles[candles.length - 1].close;
        if (!currentPrice || currentPrice <= 0) continue;

        // ATR14
        const slice14 = candles.slice(-15);
        const trs = slice14.map((c, i) => {
          if (i === 0) return c.high - c.low;
          const prev = slice14[i - 1];
          return Math.max(
            c.high - c.low,
            Math.abs(c.high - prev.close),
            Math.abs(c.low - prev.close)
          );
        });
        const atr14 = trs.reduce((a, b) => a + b, 0) / trs.length;
        const atrPct = (atr14 / currentPrice) * 100;

        // Вчерашний диапазон %
        const yesterday = candles[candles.length - 2];
        const rangePct = yesterday
          ? ((yesterday.high - yesterday.low) / yesterday.close) * 100
          : 0;

        // Объём вчера vs средний за 14 дней
        const avgVol = slice14.reduce((s, c) => s + (c.volume || 0), 0) / slice14.length;
        const volRatio = avgVol > 0 && yesterday ? yesterday.volume / avgVol : 1;

        // Есть ли уровень в радиусе 1% от цены
        const pairLevels = this._dailyLevels.get(pair);
        const hasNearLevel = pairLevels
          ? pairLevels.levels.some(l => Math.abs(l.price - currentPrice) / currentPrice < 0.01)
          : false;

        // Composite score: ATR + диапазон + объём + близость уровня
        const score =
          atrPct * 0.4 +
          rangePct * 0.3 +
          Math.min(volRatio, 5) * 0.5 +
          (hasNearLevel ? 1.5 : 0);

        results.push({ pair, atrPct, rangePct, volRatio, hasNearLevel, score, price: currentPrice });
      } catch (err) {
        logger.debug(`volatilityScan ${pair}: ${err.message}`);
      }
    }

    results.sort((a, b) => b.score - a.score);
    const top10 = results.slice(0, 10);

    this._volatilityReport = {
      top10,
      all: results,
      timestamp: new Date().toISOString(),
      utcHour: new Date().getUTCHours(),
    };

    logger.info(
      `Скан волатильности завершён: ${results.length} пар. ` +
      `Топ-3: ${top10.slice(0, 3).map(r => `${r.pair}(${r.atrPct.toFixed(1)}%)`).join(', ')}`
    );

    await this.notifier.sendVolatilityReport(this._volatilityReport, PAIRS, this.positions);
  }

  /** Получить список активных торговых пар. */
  getPairs() {
    return [...PAIRS];
  }

  /**
   * Добавить пару в активные (макс 10 выбранных пользователем).
   * Позиционные пары (locked) не считаются в лимит.
   */
  addActivePair(pair) {
    const selectedPairs = PAIRS.filter(p => !this.positions.has(p));
    if (selectedPairs.length >= 10 && !PAIRS.includes(pair)) {
      return { error: 'Уже 10 активных пар. Сначала убери одну.' };
    }
    if (!PAIRS.includes(pair)) {
      PAIRS.push(pair);
      this._saveActivePairs();
      this._onboardNewPair(pair).catch(e => logger.error(`onboard ${pair}: ${e.message}`));
      logger.info(`Пара добавлена в активные: ${pair}`);
    }
    return { ok: true };
  }

  /**
   * Убрать пару из активных.
   * Нельзя убрать если есть открытая позиция.
   */
  removeActivePair(pair) {
    if (this.positions.has(pair)) {
      return { error: `${pair}: открытая позиция — нельзя убрать` };
    }
    const idx = PAIRS.indexOf(pair);
    if (idx !== -1) {
      PAIRS.splice(idx, 1);
      this._saveActivePairs();
      logger.info(`Пара убрана из активных: ${pair}`);
    }
    return { ok: true };
  }

  /** Сохранить активные пары в .env (только незаблокированные позицией). */
  _saveActivePairs() {
    const selected = PAIRS.filter(p => !this.positions.has(p));
    this.notifier._updateEnv('ACTIVE_PAIRS', selected.join(','));
    logger.debug(`ACTIVE_PAIRS -> ${selected.join(', ')}`);
  }

  /** Загрузить данные для новой пары (уровни, 4H тренд, плечо). */
  async _onboardNewPair(pair) {
    logger.info(`Onboard новой пары: ${pair}`);
    try {
      const dailyCandles = await this.exchange.fetchCandles(pair, '1d', 120);
      if (dailyCandles && dailyCandles.length >= 30) {
        const levels = this.strategy.findLevels(dailyCandles);
        this._dailyLevels.set(pair, { levels, candles: dailyCandles });
        logger.info(`${pair}: загружено ${levels.length} уровней`);
      }
      const candles4H = await this.exchange.fetchCandles(pair, '4h', 50);
      if (candles4H && candles4H.length >= 20) {
        const trend = this.strategy.detectTrend4H(candles4H);
        this._4hTrendCache.set(pair, { trend, candles: candles4H, updatedAt: Date.now() });
        logger.info(`${pair}: 4H тренд = ${trend}`);
      }
      const lev = parseInt(process.env.LEVERAGE, 10) || 10;
      await this.exchange.setLeverage(pair, lev);
      logger.info(`${pair}: плечо ${lev}x установлено`);
    } catch (err) {
      logger.error(`_onboardNewPair ${pair}: ${err.message}`);
    }
  }

  /**
   * Мультитаймфреймовый анализ одной пары по методологии Герчика.
   * 1D → уровни, 4H → тренд и поведение, 5m → паттерн входа.
   */
  async _processPairGerchik(pair, balance) {
    // 1. Проверяем: есть ли уже позиция по этому инструменту (макс 1)
    if (this.positions.has(pair)) {
      logger.debug(`${pair}: уже есть открытая позиция — пропуск`);
      return;
    }

    // 2. Проверяем: есть ли активный лимитный ордер по этой паре
    for (const [, pending] of this._pendingOrders) {
      if (pending.pair === pair) {
        logger.debug(`${pair}: есть ожидающий ордер — пропуск`);
        return;
      }
    }

    // 3. Получаем дневные уровни (кэшированные)
    const dailyData = this._dailyLevels.get(pair);
    if (!dailyData || !dailyData.levels || dailyData.levels.length === 0) {
      logger.debug(`${pair}: нет уровней на 1D — пропуск`);
      return;
    }

    const { levels: dailyLevels, candles: dailyCandles } = dailyData;

    // 4. Фильтр объёма
    const ticker = await this.exchange.fetchTicker(pair);
    if (ticker.quoteVolume && ticker.quoteVolume < VOLUME_THRESHOLD) {
      logger.debug(`${pair}: объём ${ticker.quoteVolume} ниже порога ${VOLUME_THRESHOLD}`);
      return;
    }

    // 5. Получаем 4H данные из кэша (обновляются каждые 4H)
    const cached4H = this._4hTrendCache.get(pair);
    if (!cached4H || !cached4H.candles || cached4H.candles.length < 20) {
      logger.debug(`${pair}: нет 4H данных в кэше`);
      return;
    }
    const candles4H = cached4H.candles;

    // 6. Получаем 5m свечи для поиска паттерна входа
    const candles5m = await this.exchange.fetchCandles(pair, TF_ENTRY, 50);
    if (!candles5m || candles5m.length < 10) {
      logger.debug(`${pair}: недостаточно 5m свечей`);
      return;
    }

    const currentPrice = candles5m[candles5m.length - 1].close;

    // Логируем ближайший уровень для наглядности
    if (dailyLevels.length > 0) {
      const nearest = dailyLevels.reduce((best, l) =>
        Math.abs(l.price - currentPrice) < Math.abs(best.price - currentPrice) ? l : best
      );
      const nearDist = ((currentPrice - nearest.price) / nearest.price * 100).toFixed(2);
      logger.info(`${pair}: цена ${currentPrice.toFixed(2)}, ближайший уровень ${nearest.price.toFixed(2)} (${nearDist}%), всего уровней: ${dailyLevels.length}`);
    }

    // 7. Ищем ближайший активный уровень к текущей цене
    for (const level of dailyLevels) {
      // Фильтр: изношенный уровень (4+ касаний за последние дни)
      if (this.strategy.isLevelWornOut(level, dailyCandles.slice(-10))) {
        logger.debug(`${pair}: уровень ${level.price.toFixed(2)} изношен (4+ касаний) — пропуск`);
        continue;
      }

      // Фильтр: глубокие ложные пробои на уровне (хвосты >30% ATR за 20 свечей 1D)
      if (level.hasDeepFalseBreakouts) {
        logger.debug(`${pair}: уровень ${level.price.toFixed(2)} — глубокие ложные пробои — пропуск`);
        continue;
      }

      // Определяем направление: цена выше уровня — лонг (отскок от поддержки),
      // цена ниже — шорт (отскок от сопротивления)
      let direction = null;
      const distPct = (currentPrice - level.price) / level.price;

      if (level.type === 'support' || level.type === 'dual') {
        if (distPct >= -0.005 && distPct <= 0.01) direction = 'long';
      }
      if (level.type === 'resistance' || level.type === 'dual') {
        if (distPct <= 0.005 && distPct >= -0.01) direction = 'short';
      }

      if (!direction) continue;

      // 8. Проверка тренда на 4H
      const trend4H = this.strategy.detectTrend4H(candles4H);
      const confirmation = this.strategy.check4HConfirmation(candles4H, direction);
      if (!confirmation.confirmed) {
        const counterTrendAllowed = level.isMirror ? level.strength >= 6 : level.strength >= 8;
        if (!counterTrendAllowed) {
          logger.info(`${pair}: 4H тренд [${trend4H}] противоречит ${direction} — уровень ${level.price.toFixed(2)} (${level.classification}, сила ${level.strength}) не прошёл порог контртренда — пропуск`);
          continue;
        }
      }

      // 9. Анализ поведения на 4H при подходе к уровню
      const approach = this.strategy.analyze4HApproach(candles4H, level);
      logger.info(`${pair}: уровень ${level.price.toFixed(2)} в зоне! 4H тренд: ${trend4H}, подход: ${approach.approach}, направление: ${direction}`);

      // 10. Проверка энергии на 5m (база или подход на малых барах)
      if (!this.strategy.hasEnergy5m(candles5m, level, direction)) {
        logger.info(`${pair}: нет энергии на 5m у уровня ${level.price.toFixed(2)} (${direction}) — пропуск`);
        continue;
      }

      // 11. Поиск паттерна входа на 5m
      const signal = this.strategy.findEntryPattern(candles5m, level, direction, dailyLevels);

      if (!signal) {
        logger.info(`${pair}: нет паттерна на 5m у уровня ${level.price.toFixed(2)} (${direction}) — ожидание`);
        continue;
      }

      // ── Фильтр по режиму рынка BTC ──
      const _regime = this._marketRegime?.regime || 'sideways';
      if (_regime === 'sideways' && signal.type !== 'false_breakout') {
        logger.info(`${pair}: боковик — только ложный пробой (сигнал: ${signal.type}) — пропуск`);
        continue;
      }
      if (_regime === 'trend_up' && direction === 'short' && signal.type !== 'false_breakout') {
        logger.info(`${pair}: тренд вверх — шорты пропущены (не ложный пробой)`);
        continue;
      }
      if (_regime === 'trend_down' && direction === 'long' && signal.type !== 'false_breakout') {
        logger.info(`${pair}: тренд вниз — лонги пропущены (не ложный пробой)`);
        continue;
      }

      // 11.5 Проверка объёма с учётом типа паттерна
      if (signal.type === 'breakout') {
        if (!this.strategy.hasBreakoutVolume(candles5m, 1.5)) {
          logger.info(`${pair}: слабый объём на пробое (${signal.type}) у уровня ${level.price.toFixed(2)} — пропуск`);
          continue;
        }
      } else if (signal.type === 'false_breakout') {
        // ложный пробой по Герчику не требует повышенного объёма — пропускаем проверку
      } else {
        if (!this.strategy.hasBreakoutVolume(candles5m, 1.0)) {
          logger.info(`${pair}: объём ниже среднего (${signal.type}) у уровня ${level.price.toFixed(2)} — пропуск`);
          continue;
        }
      }

      // ── Динамический риск по серии стопов ──
      if (this._botState === 'PAUSE') {
        logger.info(`${pair}: пауза — ${this._consecutiveLosses} стопов подряд, вход пропущен`);
        continue;
      }
      if (this._botState === 'RECOVERY') signal._riskMultiplier = 0.5;
      if (this._botState === 'BUILD_UP') signal._riskMultiplier = 0.75;

      // Проверка макс попыток на этот сетап
      const attemptKey = `${pair}:${level.price.toFixed(2)}:${direction}`;
      const attempts = this._orderAttempts.get(attemptKey) || 0;
      if (attempts >= MAX_ORDER_ATTEMPTS) {
        logger.info(`${pair}: исчерпаны попытки (${attempts}/${MAX_ORDER_ATTEMPTS}) для уровня ${level.price.toFixed(2)} — пропуск`);
        continue;
      }

      // Уменьшаем размер вдвое при противоречии на 4H
      signal._reduce = confirmation.reduce;
      signal._4hTrend = this.strategy.detectTrend4H(candles4H);
      signal._4hApproach = approach.approach;
      signal._levelData = level;
      signal.pair = pair;
      signal.timeframe = TF_ENTRY;

      logger.info(
        `${pair}: СИГНАЛ ${direction.toUpperCase()} | ${signal.typeRu} | ` +
        `уровень ${level.price.toFixed(2)} (${level.classification}, сила ${level.strength}) | ` +
        `4H тренд: ${signal._4hTrend} | подход: ${signal._4hApproach}`
      );

      // Переходим к открытию позиции
      await this._checkEntry(pair, signal, dailyLevels, balance, attemptKey);
      return; // один сигнал за тик на пару
    }
  }

  /**
   * Мониторинг трёх уровней тейк-профита:
   *   TP1 (1R) — закрываем 40%, SL → безубыток
   *   TP2 (2R) — закрываем 40%
   *   TP3 (3R) — закрываем оставшиеся 20% (или SL на бирже)
   */
  async _checkTakeProfitLevels() {
    for (const [pair, pos] of this.positions) {
      try {
        const ticker = await this.exchange.fetchTicker(pair);
        const currentPrice = ticker.last || ticker.close;
        if (!currentPrice) continue;

        const risk = Math.abs(pos.entry - (pos._originalSL || pos.stopLoss));
        if (risk <= 0) continue;

        const profit = pos.side === 'long'
          ? currentPrice - pos.entry
          : pos.entry - currentPrice;
        const profitR = profit / risk;

        const sideRu = pos.side === 'long' ? 'ЛОНГ' : 'ШОРТ';
        const sideIcon = pos.side === 'long' ? '🟢' : '🔴';

        // ── TP1: 1R — закрываем 40%, SL → безубыток ──
        if (!pos._tp1Hit && pos.tp1) {
          const tp1Hit = pos.side === 'long'
            ? currentPrice >= pos.tp1
            : currentPrice <= pos.tp1;

          if (tp1Hit) {
            const closeSize = parseFloat((pos._originalSize * 0.4).toFixed(6));
            if (closeSize > 0) {
              try {
                const closeOrder = await this.exchange.closePartial(pair, pos.side, closeSize, 'TP1 (1R, 40%)', pos.size);
                const closePrice = closeOrder.average || currentPrice;
                const partialPnl = pos.side === 'long'
                  ? (closePrice - pos.entry) * closeSize
                  : (pos.entry - closePrice) * closeSize;

                pos._tp1Hit = true;
                pos.size = parseFloat((pos.size - closeSize).toFixed(6));
                pos._partialPnl += partialPnl;
                pos._partialCloses.push({
                  tp: 'TP1', size: closeSize, price: closePrice,
                  pnl: parseFloat(partialPnl.toFixed(2)), time: new Date().toISOString(),
                });

                // SL → безубыток
                const oldSL = pos.stopLoss;
                const breakevenSL = pos.entry;
                try {
                  // tp3 валиден только если цена ещё не прошла его
                  const validTp3 = pos.tp3 && (
                    (pos.side === 'long'  && pos.tp3 > currentPrice) ||
                    (pos.side === 'short' && pos.tp3 < currentPrice)
                  );
                  await this.exchange.setTradingStop(pair, {
                    stopLoss:   breakevenSL,
                    ...(validTp3 ? { takeProfit: pos.tp3 } : {}),
                    tpSize:     pos.size,  // остаток после закрытия TP1 (60%)
                    side:       pos.side,
                  });
                  pos.stopLoss = breakevenSL;
                  pos._breakevenMoved = true;
                } catch (slErr) {
                  logger.warn(`${pair}: TP1 hit, но SL в безубыток не удался: ${slErr.message}`);
                }

                logger.info(
                  `TP1 HIT ${pair} ${sideRu}: закрыто 40% (${closeSize}) по ${closePrice} | ` +
                  `PnL=${partialPnl.toFixed(2)} | SL ${oldSL}→${pos.entry} | остаток=${pos.size}`
                );

                await this.notifier.sendMessage(
                  `🎯 <b>TP1 достигнут (1R)</b>\n` +
                  `${sideIcon} <b>${sideRu}</b> ${pair}\n` +
                  `━━━━━━━━━━━━━━━━━━\n` +
                  `Закрыто: <code>40% (${closeSize})</code> по <code>${closePrice}</code>\n` +
                  `PnL: <code>${partialPnl.toFixed(2)} USDT</code>\n` +
                  `🔒 SL → безубыток: <code>${pos.entry}</code>\n` +
                  `Остаток: <code>${pos.size}</code>\n` +
                  `Следующий: TP2 (2R) = <code>${pos.tp2}</code>`
                );
              } catch (err) {
                logger.error(`${pair}: TP1 частичное закрытие ошибка: ${err.message}`);
              }
            }
          }
        }

        // ── TP2: 2R — закрываем 40% ──
        if (pos._tp1Hit && !pos._tp2Hit && pos.tp2) {
          const tp2Hit = pos.side === 'long'
            ? currentPrice >= pos.tp2
            : currentPrice <= pos.tp2;

          if (tp2Hit) {
            const closeSize = parseFloat((pos._originalSize * 0.4).toFixed(6));
            const actualClose = Math.min(closeSize, pos.size);
            if (actualClose > 0) {
              try {
                const closeOrder = await this.exchange.closePartial(pair, pos.side, actualClose, 'TP2 (2R, 40%)', pos.size);
                const closePrice = closeOrder.average || currentPrice;
                const partialPnl = pos.side === 'long'
                  ? (closePrice - pos.entry) * actualClose
                  : (pos.entry - closePrice) * actualClose;

                pos._tp2Hit = true;
                pos.size = parseFloat((pos.size - actualClose).toFixed(6));
                pos._partialPnl += partialPnl;
                pos._partialCloses.push({
                  tp: 'TP2', size: actualClose, price: closePrice,
                  pnl: parseFloat(partialPnl.toFixed(2)), time: new Date().toISOString(),
                });

                // Трейлинг 1.5% на остаток 20%: пробуем native Bybit API
                const trailDist = parseFloat((currentPrice * 0.015).toFixed(8));
                try {
                  await this.exchange.setTradingStop(pair, {
                    stopLoss:     pos.stopLoss,
                    trailingStop: trailDist,
                    activePrice:  currentPrice,
                    side:         pos.side,
                  });
                  pos._nativeTrailing = true;
                } catch (e) {
                  logger.warn(`${pair}: native trailing не удался (${e.message}), активируем программный`);
                }
                pos._trailingActive  = true;
                pos._trailingExtreme = currentPrice;

                logger.info(
                  `TP2 HIT ${pair} ${sideRu}: закрыто 40% (${actualClose}) по ${closePrice} | ` +
                  `PnL=${partialPnl.toFixed(2)} | остаток=${pos.size}`
                );
                logger.info(`TP2 достигнут — трейлинг 1.5% активирован на 20% позиции ${pair}`);

                await this.notifier.sendMessage(
                  `🎯🎯 <b>TP2 достигнут (2R)</b>\n` +
                  `${sideIcon} <b>${sideRu}</b> ${pair}\n` +
                  `━━━━━━━━━━━━━━━━━━\n` +
                  `Закрыто: <code>40% (${actualClose})</code> по <code>${closePrice}</code>\n` +
                  `PnL: <code>${partialPnl.toFixed(2)} USDT</code>\n` +
                  `Остаток: <code>${pos.size}</code>\n` +
                  `🔔 Трейлинг 1.5% активирован на 20%`
                );
              } catch (err) {
                logger.error(`${pair}: TP2 частичное закрытие ошибка: ${err.message}`);
              }
            }
          }
        }

        // ── Trailing stop (программный fallback после TP2) ──
        if (pos._tp2Hit && !pos._tp3Hit && pos._trailingActive && !pos._nativeTrailing) {
          if (pos.side === 'long') {
            if (currentPrice > pos._trailingExtreme) pos._trailingExtreme = currentPrice;
            if (currentPrice <= pos._trailingExtreme * (1 - 0.015)) {
              try {
                await this.exchange.closePartial(pair, pos.side, pos.size, 'trailing 1.5%', pos.size);
                pos._tp3Hit = true;
                pos._trailingActive = false;
                const rollback = ((pos._trailingExtreme - currentPrice) / pos._trailingExtreme * 100).toFixed(2);
                logger.info(`Trailing triggered ${pair}: закрыт остаток ${pos.size} по ${currentPrice}`);
                await this.notifier.sendMessage(
                  `🔔 <b>Трейлинг сработал</b>\n` +
                  `${sideIcon} <b>${sideRu}</b> ${pair}\n` +
                  `Закрыт остаток: <code>${pos.size}</code> по <code>${currentPrice}</code>\n` +
                  `Откат от максимума: ${rollback}%`
                );
              } catch (err) { logger.error(`${pair}: trailing close: ${err.message}`); }
            }
          } else {
            if (currentPrice < pos._trailingExtreme) pos._trailingExtreme = currentPrice;
            if (currentPrice >= pos._trailingExtreme * (1 + 0.015)) {
              try {
                await this.exchange.closePartial(pair, pos.side, pos.size, 'trailing 1.5%', pos.size);
                pos._tp3Hit = true;
                pos._trailingActive = false;
                const growth = ((currentPrice - pos._trailingExtreme) / pos._trailingExtreme * 100).toFixed(2);
                logger.info(`Trailing triggered ${pair}: закрыт остаток ${pos.size} по ${currentPrice}`);
                await this.notifier.sendMessage(
                  `🔔 <b>Трейлинг сработал</b>\n` +
                  `${sideIcon} <b>${sideRu}</b> ${pair}\n` +
                  `Закрыт остаток: <code>${pos.size}</code> по <code>${currentPrice}</code>\n` +
                  `Рост от минимума: ${growth}%`
                );
              } catch (err) { logger.error(`${pair}: trailing close: ${err.message}`); }
            }
          }
        }

        // TP3 обрабатывается биржей через SL/TP (setTradingStop) или _detectClosedPositions

      } catch (err) {
        logger.error(`_checkTakeProfitLevels ${pair}: ${err.message}`);
      }
    }
  }

  /**
   * Установить SL (Stop Market) и TP (Limit) на позиции через Bybit Trading Stop API.
   * Вызывается после исполнения лимитного ордера.
   *
   * SL — Stop Market (гарантия исполнения, не проскользнёт).
   * TP — Limit (maker-комиссия 0.02%).
   *
   * tpslMode=Partial + tpSize=pos.size: TP3 закрывает только текущий остаток позиции,
   * а не всю позицию целиком. Это страховка на случай, если TP1/TP2 боту не удалось
   * закрыть вовремя (gap, проскальзывание, таймаут).
   */
  /**
   * Верификация состояния позиции через 10 сек после открытия.
   * Проверяет: SL/TP на бирже, пройденные TP1/TP2.
   */
  async _verifyPositionState(pair) {
    const pos = this.positions.get(pair);
    if (!pos) return; // позиция уже закрыта

    logger.info(`${pair}: верификация состояния позиции (10с после открытия)...`);

    // Получаем актуальные данные с биржи
    const openPositions = await this.exchange.fetchOpenPositions(pair);
    const symbol = pair.replace('/', '');
    const exPos = openPositions.find(p =>
      p.symbol?.includes(symbol) || p.symbol?.includes(pair.split('/')[0])
    );

    if (!exPos || Math.abs(parseFloat(exPos.contracts || exPos.info?.size || 0)) === 0) {
      logger.info(`${pair}: верификация — позиция не найдена на бирже (уже закрыта?)`);
      return;
    }

    const currentPrice = parseFloat(exPos.markPrice || exPos.info?.markPrice || exPos.entryPrice || 0);
    const slOnExchange = parseFloat(exPos.stopLossPrice || exPos.info?.stopLoss || 0);
    const tpOnExchange = parseFloat(exPos.takeProfitPrice || exPos.info?.takeProfit || 0);

    // ── 1. Проверяем SL/TP ──
    if (slOnExchange === 0 || tpOnExchange === 0) {
      logger.warn(`${pair}: верификация — SL=${slOnExchange} TP=${tpOnExchange} не выставлены, исправляем...`);
      try {
        const tp = pos.tp3 || pos.takeProfit;
        const result = await this.exchange.setTradingStop(pair, {
          stopLoss:   pos.stopLoss,
          takeProfit: tp,
          tpSize:     pos.size,
          side:       pos.side,
        });
        if (result !== null) {
          logger.info(`${pair}: верификация — SL/TP выставлены принудительно`);
          await this.notifier.sendMessage(
            `🔧 <b>Верификация SL/TP</b>\n${pair}\nSL: <code>${pos.stopLoss}</code> | TP3: <code>${tp}</code>\n<i>Выставлены через 10с после открытия</i>`
          );
        } else {
          logger.warn(`${pair}: верификация — setTradingStop вернул null`);
        }
      } catch (err) {
        logger.error(`${pair}: верификация — ошибка setTradingStop: ${err.message}`);
      }
    } else {
      logger.info(`${pair}: верификация — SL=${slOnExchange} TP=${tpOnExchange} в порядке`);
    }

    if (!currentPrice) return; // нет цены — не проверяем TP

    // ── 2. Проверяем TP1 ──
    if (!pos._tp1Hit && pos.tp1) {
      const tp1Passed = pos.side === 'long'
        ? currentPrice >= pos.tp1
        : currentPrice <= pos.tp1;

      if (tp1Passed) {
        logger.warn(`${pair}: верификация — цена ${currentPrice} уже прошла TP1=${pos.tp1}, запускаем TP1 логику...`);
        const closeSize = parseFloat((pos._originalSize * 0.4).toFixed(6));
        if (closeSize > 0) {
          try {
            const closeOrder = await this.exchange.closePartial(pair, pos.side, closeSize, 'TP1-verify (1R, 40%)', pos.size);
            const closePrice = closeOrder.average || currentPrice;
            const partialPnl = pos.side === 'long'
              ? (closePrice - pos.entry) * closeSize
              : (pos.entry - closePrice) * closeSize;

            pos._tp1Hit = true;
            pos.size = parseFloat((pos.size - closeSize).toFixed(6));
            pos._partialPnl += partialPnl;
            pos._partialCloses.push({
              tp: 'TP1', size: closeSize, price: closePrice,
              pnl: parseFloat(partialPnl.toFixed(2)), time: new Date().toISOString(),
            });

            // SL → безубыток
            const breakevenSL = pos.entry;
            const validTp3 = pos.tp3 && (
              (pos.side === 'long'  && pos.tp3 > currentPrice) ||
              (pos.side === 'short' && pos.tp3 < currentPrice)
            );
            try {
              await this.exchange.setTradingStop(pair, {
                stopLoss:   breakevenSL,
                ...(validTp3 ? { takeProfit: pos.tp3 } : {}),
                tpSize:     pos.size,
                side:       pos.side,
              });
              pos.stopLoss = breakevenSL;
              pos._breakevenMoved = true;
            } catch (slErr) {
              logger.warn(`${pair}: верификация TP1 — SL в безубыток не удался: ${slErr.message}`);
            }

            const sideIcon = pos.side === 'long' ? '🟢' : '🔴';
            const sideRu = pos.side === 'long' ? 'ЛОНГ' : 'ШОРТ';
            await this.notifier.sendMessage(
              `🎯 <b>TP1 (верификация)</b>\n${sideIcon} <b>${sideRu}</b> ${pair}\n` +
              `Закрыто: <code>40% (${closeSize})</code> по <code>${closePrice}</code>\n` +
              `PnL: <code>${partialPnl.toFixed(2)} USDT</code>\n` +
              `🔒 SL → безубыток: <code>${pos.entry}</code>`
            );
          } catch (err) {
            logger.error(`${pair}: верификация TP1 — ошибка: ${err.message}`);
          }
        }
      }
    }

    // ── 3. Проверяем TP2 ──
    if (pos._tp1Hit && !pos._tp2Hit && pos.tp2) {
      const tp2Passed = pos.side === 'long'
        ? currentPrice >= pos.tp2
        : currentPrice <= pos.tp2;

      if (tp2Passed) {
        logger.warn(`${pair}: верификация — цена ${currentPrice} уже прошла TP2=${pos.tp2}, запускаем TP2 логику...`);
        const closeSize = parseFloat((pos._originalSize * 0.4).toFixed(6));
        const actualClose = Math.min(closeSize, pos.size);
        if (actualClose > 0) {
          try {
            const closeOrder = await this.exchange.closePartial(pair, pos.side, actualClose, 'TP2-verify (2R, 40%)', pos.size);
            const closePrice = closeOrder.average || currentPrice;
            const partialPnl = pos.side === 'long'
              ? (closePrice - pos.entry) * actualClose
              : (pos.entry - closePrice) * actualClose;

            pos._tp2Hit = true;
            pos.size = parseFloat((pos.size - actualClose).toFixed(6));
            pos._partialPnl += partialPnl;
            pos._partialCloses.push({
              tp: 'TP2', size: actualClose, price: closePrice,
              pnl: parseFloat(partialPnl.toFixed(2)), time: new Date().toISOString(),
            });

            const validTp3 = pos.tp3 && (
              (pos.side === 'long'  && pos.tp3 > currentPrice) ||
              (pos.side === 'short' && pos.tp3 < currentPrice)
            );
            try {
              await this.exchange.setTradingStop(pair, {
                stopLoss:   pos.stopLoss,
                ...(validTp3 ? { takeProfit: pos.tp3 } : {}),
                tpSize:     pos.size,
                side:       pos.side,
              });
            } catch (e) { /* ok */ }

            const sideIcon = pos.side === 'long' ? '🟢' : '🔴';
            const sideRu = pos.side === 'long' ? 'ЛОНГ' : 'ШОРТ';
            await this.notifier.sendMessage(
              `🎯🎯 <b>TP2 (верификация)</b>\n${sideIcon} <b>${sideRu}</b> ${pair}\n` +
              `Закрыто: <code>40% (${actualClose})</code> по <code>${closePrice}</code>\n` +
              `PnL: <code>${partialPnl.toFixed(2)} USDT</code>\n` +
              `Остаток: <code>${pos.size}</code>`
            );
          } catch (err) {
            logger.error(`${pair}: верификация TP2 — ошибка: ${err.message}`);
          }
        }
      }
    }

    logger.info(`${pair}: верификация завершена`);
  }

    async _setPositionStopLossAndTakeProfit(pair, pos) {
    const tp = pos.tp3 || pos.takeProfit;
    const WS_TIMEOUT_MS = 5000; // ждём WS событие 5 сек, потом REST fallback
    const MAX_ATTEMPTS = 6;
    const DELAYS_MS = [500, 1000, 2000, 4000, 8000];

    // ── Шаг 1: ждём WS подтверждения позиции (быстрый путь) ──
    const wsTriggered = await new Promise((resolve) => {
      // Регистрируем ожидание WS события
      this._pendingSLSetup.set(pair, { pos, resolve });

      // Fallback: если WS не ответил за WS_TIMEOUT_MS — используем REST
      setTimeout(() => {
        if (this._pendingSLSetup.has(pair)) {
          this._pendingSLSetup.delete(pair);
          logger.warn(`${pair}: WS не ответил за ${WS_TIMEOUT_MS}мс — переключаемся на REST polling`);
          resolve('timeout');
        }
      }, WS_TIMEOUT_MS);
    });

    logger.info(`${pair}: триггер SL = ${wsTriggered}, выставляем SL/TP...`);

    // ── Шаг 2: выставляем SL/TP (с retry если REST fallback) ──
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        // При REST fallback начиная со 2-й попытки — проверяем наличие позиции
        if (wsTriggered === 'timeout' && attempt > 1) {
          const positions = await this.exchange.fetchOpenPositions(pair);
          const symbol = pair.replace('/', '');
          const openPos = positions.find(p =>
            p.symbol?.includes(symbol) || p.symbol?.includes(pair.split('/')[0])
          );
          const posSize = parseFloat(openPos?.contracts || openPos?.info?.size || '0');
          if (!openPos || posSize === 0) {
            const delay = DELAYS_MS[attempt - 2] || DELAYS_MS[DELAYS_MS.length - 1];
            logger.warn(`${pair}: позиция ещё не появилась на бирже, попытка ${attempt}/${MAX_ATTEMPTS}, ждём ${delay}мс...`);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          logger.info(`${pair}: позиция подтверждена (${posSize} контр.), выставляем SL/TP (попытка ${attempt})...`);
        }

        // Выставляем SL/TP
        const result = await this.exchange.setTradingStop(pair, {
          stopLoss:   pos.stopLoss,
          takeProfit: tp,
          tpSize:     pos.size,
          side:       pos.side,
        });

        if (result === null) {
          const delay = DELAYS_MS[attempt - 1] || DELAYS_MS[DELAYS_MS.length - 1];
          if (attempt < MAX_ATTEMPTS) {
            logger.warn(`${pair}: setTradingStop вернул null (zero position), попытка ${attempt}/${MAX_ATTEMPTS}, повтор через ${delay}мс...`);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          const msg = `${pair}: НЕ УДАЛОСЬ выставить SL/TP после ${MAX_ATTEMPTS} попыток. Позиция открыта БЕЗ стоп-лосса!`;
          logger.error(msg);
          await this.notifier.sendMessage(`⚠️ <b>КРИТИЧНО: SL не установлен!</b>\n${pair}\nSL: <code>${pos.stopLoss}</code> TP: <code>${tp}</code>\nВыставьте стоп-лосс вручную!`);
          return;
        }

        logger.info(`${pair}: SL=${pos.stopLoss} TP3=${tp} (tpSize=${pos.size}) установлены [триггер=${wsTriggered}] | TP1=${pos.tp1} TP2=${pos.tp2}`);
        return;

      } catch (err) {
        const delay = DELAYS_MS[attempt - 1] || DELAYS_MS[DELAYS_MS.length - 1];
        if (attempt < MAX_ATTEMPTS) {
          logger.warn(`${pair}: ошибка setTradingStop (попытка ${attempt}/${MAX_ATTEMPTS}): ${err.message}, повтор через ${delay}мс...`);
          await new Promise(r => setTimeout(r, delay));
        } else {
          logger.error(`${pair}: ошибка setTradingStop после ${MAX_ATTEMPTS} попыток: ${err.message}`);
          await this.notifier.sendMessage(`⚠️ <b>КРИТИЧНО: SL не установлен!</b>\n${pair}\nОшибка: ${err.message}\nВыставьте стоп-лосс вручную!`);
        }
      }
    }
  }

  /**
   * Перенос SL в безубыток через Bybit Trading Stop API.
   * Вызывается после прохождения 1R в прибыль.
   *
   * Используем setTradingStop — надёжнее editOrder, работает с Bybit v5.
   */
  async _updateStopLossOnExchange(pair, pos) {
    try {
      // ВАЖНО: Bybit сбрасывает TP если не передать его вместе с SL
      const tp = pos.tp3 || pos.takeProfit;
      await this.exchange.setTradingStop(pair, {
        stopLoss:   pos.stopLoss,
        takeProfit: tp || undefined,
        tpSize:     tp ? pos.size : undefined,
        side:       pos.side,
      });
      logger.info(`${pair}: SL обновлён на ${pos.stopLoss} через setTradingStop`);
    } catch (err) {
      logger.warn(`${pair}: не удалось обновить SL на бирже: ${err.message}`);
    }
  }

  /**
   * Открытие позиции по сигналу Герчика.
   * Limit PostOnly ордер, 1-2 тика от зоны.
   */
  async _checkEntry(pair, entrySignal, dailyLevels, balance, attemptKey) {
    // ── Дневной лимит убытка ──
    if (DAILY_LOSS_LIMIT_PCT > 0 && this._dayStats.balanceStart > 0) {
      const dailyPnlPct = (balance.total - this._dayStats.balanceStart) / this._dayStats.balanceStart * 100;
      if (dailyPnlPct <= -DAILY_LOSS_LIMIT_PCT) {
        if (!this._dailyLossNotified) {
          this._dailyLossNotified = true;
          logger.warn(`Дневной лимит убытка: ${dailyPnlPct.toFixed(2)}% (лимит -${DAILY_LOSS_LIMIT_PCT}%). Торговля остановлена.`);
          await this.notifier.sendMessage(
            `🛑 <b>Дневной лимит убытка достигнут</b>\n` +
            `P&L сегодня: <code>${dailyPnlPct.toFixed(2)}%</code>\n` +
            `Лимит: <code>-${DAILY_LOSS_LIMIT_PCT}%</code>\n` +
            `Новые позиции заблокированы до следующего дня.`
          );
        }
        return;
      }
    }

    // ── AI фильтр ──
    if (AI_FILTER_ENABLED && this.aiFilter.enabled) {
      try {
        const candles5m = await this.exchange.fetchCandles(pair, TF_ENTRY, 50);

        // Режим рынка
        const regime = await this.aiFilter.detectMarketRegime(pair, candles5m || []);
        logger.info(`${pair} режим рынка: ${regime.regime} (${regime.strength || '?'}%) — ${regime.suggestion}`);

        // Валидация сигнала AI
        const aiResult = await this.aiFilter.validateSignal(entrySignal, candles5m || [], dailyLevels);

        await this.webhook.pushToN8n('signal_pending', {
          pair,
          signal: entrySignal,
          aiResult,
          regime,
          levels: dailyLevels.slice(0, 5),
        });

        if (!aiResult.approved || aiResult.confidence < AI_MIN_CONFIDENCE) {
          logger.info(`${pair}: AI отклонил (${aiResult.confidence}%) — ${aiResult.reason}`);
          await this.notifier.sendMessage(
            `🤖 <b>AI ОТКЛОНИЛ</b> ${entrySignal.signal.toUpperCase()} ${pair}\n` +
            `Уверенность: ${aiResult.confidence}%\n` +
            `Причина: ${aiResult.reason}`
          );
          return;
        }

        logger.info(`${pair}: AI одобрил (${aiResult.confidence}%) — ${aiResult.reason}`);
        entrySignal._aiReason = aiResult.reason;
        entrySignal._aiConfidence = aiResult.confidence;
        entrySignal._regime = regime;
      } catch (aiErr) {
        logger.warn(`${pair}: AI фильтр ошибка: ${aiErr.message} — продолжаем без AI`);
      }
    }

    // ── Размер позиции ──
    // ВАЖНО: используем balance.total (equity), НЕ balance.free (с учётом плеча)
    const sizing = this.riskManager.calculatePositionSize(
      balance.total,
      entrySignal.entry,
      entrySignal.stopLoss
    );

    // Уменьшаем вдвое при противоречии 4H
    if (entrySignal._reduce) {
      sizing.size = parseFloat((sizing.size / 2).toFixed(6));
      sizing.riskAmount = parseFloat((sizing.riskAmount / 2).toFixed(2));
      logger.info(`${pair}: размер уменьшен вдвое (противоречие 4H) → ${sizing.size}`);
    }

    if (entrySignal._riskMultiplier && entrySignal._riskMultiplier < 1) {
      const mult = entrySignal._riskMultiplier;
      sizing.size = parseFloat((sizing.size * mult).toFixed(6));
      sizing.riskAmount = parseFloat((sizing.riskAmount * mult).toFixed(2));
      logger.info(`${pair}: риск ${mult * 100}% (режим ${this._botState}) → ${sizing.size}`);
    }

    // ── Проверка SL на правильной стороне от entry ──
    if (entrySignal.signal === 'long' && entrySignal.stopLoss >= entrySignal.entry) {
      logger.warn(`${pair}: SL ${entrySignal.stopLoss} >= entry ${entrySignal.entry} для LONG — невалидный сигнал, пропуск`);
      return;
    }
    if (entrySignal.signal === 'short' && entrySignal.stopLoss <= entrySignal.entry) {
      logger.warn(`${pair}: SL ${entrySignal.stopLoss} <= entry ${entrySignal.entry} для SHORT — невалидный сигнал, пропуск`);
      return;
    }

    // ── Валидация ──
    const order = {
      side: entrySignal.signal,
      entry: entrySignal.entry,
      stopLoss: entrySignal.stopLoss,
      takeProfit: entrySignal.takeProfit,
      size: sizing.size,
    };

    const validation = this.riskManager.validateOrder(order, pair);
    if (!validation.valid) {
      const reason = validation.errors.join('; ');
      logger.info(`ПРОПУСК ${pair}: ордер отклонён риск-менеджером — ${reason}`);
      await this.webhook.pushToN8n('order_rejected', { signal: entrySignal, errors: validation.errors });
      return;
    }

    // ── Логирование параметров ордера (Раздел 10 Герчика) ──
    const levelData = entrySignal._levelData;
    logger.info(
      `ОРДЕР ${pair} ${entrySignal.signal.toUpperCase()} | ` +
      `паттерн: ${entrySignal.typeRu} | ` +
      `уровень: ${levelData ? `${levelData.price.toFixed(2)} (${levelData.classification}, сила ${levelData.strength})` : '?'} | ` +
      `entry: ${entrySignal.entry} | SL: ${entrySignal.stopLoss} | TP1: ${entrySignal.tp1} TP2: ${entrySignal.tp2} TP3: ${entrySignal.tp3} | ` +
      `R:R: 1:${entrySignal.riskRewardRatio} | ` +
      `размер: ${sizing.size} | риск: ${sizing.riskAmount} USDT (${sizing.riskPct}%) | ` +
      `PostOnly: да | 4H тренд: ${entrySignal._4hTrend || '?'} | подход: ${entrySignal._4hApproach || '?'}` +
      (entrySignal._reduce ? ' | РАЗМЕР x0.5 (противоречие 4H)' : '') +
      (entrySignal._aiConfidence ? ` | AI: ${entrySignal._aiConfidence}%` : '')
    );

    // ── Исполнение: Limit PostOnly ──
    try {
      const result = await this.exchange.placeOrder(
        pair,
        entrySignal.signal === 'long' ? 'buy' : 'sell',
        sizing.size,
        entrySignal.entry, // limit price
        true // postOnly
      );

      const position = {
        id: pair,
        side: entrySignal.signal,
        entry: entrySignal.entry,
        stopLoss: entrySignal.stopLoss,
        takeProfit: entrySignal.takeProfit, // = TP3 для совместимости
        tp1: entrySignal.tp1 || entrySignal.takeProfit,
        tp2: entrySignal.tp2 || entrySignal.takeProfit,
        tp3: entrySignal.tp3 || entrySignal.takeProfit,
        _tp1Hit: false,  // TP1 достигнут — закрыто 40%, SL → безубыток
        _tp2Hit: false,  // TP2 достигнут — закрыто 40%
        _tp3Hit: false,  // TP3 достигнут — закрыто 20% (или SL на бирже)
        _originalSize: sizing.size, // начальный размер позиции
        _originalSL: entrySignal.stopLoss,
        size: sizing.size,
        orderId: result.id,
        entryReason: entrySignal.reason,
        openedAt: new Date().toISOString(),
        _breakevenMoved: false,
        // Данные уровня для логирования при закрытии
        _levelPrice: levelData ? levelData.price : null,
        _levelClassification: levelData ? levelData.classification : null,
        _levelStrength: levelData ? levelData.strength : null,
        _entryPattern: entrySignal.type || null,
        // PnL от частичных закрытий
        _partialPnl: 0,
        _partialCloses: [], // [{tp, size, price, pnl, time}]
      };

      // Limit ордер — ждём исполнения
      // Защита от undefined: если ордер размещён (есть id) — всегда ждём исполнения
      // Без этого при status=undefined код ошибочно трактует ордер как мгновенно исполненный
      if (result.status === 'canceled') {
        logger.warn(`${pair}: ордер отклонён биржей сразу (PostOnly rejected?) — отмена входа`);
        return;
      }
      if (result.status === 'open' || result.status === 'new' || result.type === 'limit' || result.id) {
        this.trackOrderPlaced();
        this._pendingOrders.set(result.id, {
          pair,
          position,
          signal: entrySignal,
          sizing,
          createdAt: Date.now(),
          attemptKey,
          level: entrySignal._levelData,
          direction: entrySignal.signal,
        });

        const sideRu = entrySignal.signal === 'long' ? 'ЛОНГ' : 'ШОРТ';
        const levelInfo = entrySignal._levelData;

        await this.notifier.sendMessage(
          `⏳ <b>Лимитный ордер (PostOnly)</b>\n` +
          `${entrySignal.signal === 'long' ? '🟢' : '🔴'} <b>${sideRu}</b> ${pair}\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `Цена: <code>${entrySignal.entry}</code>\n` +
          `SL: <code>${entrySignal.stopLoss}</code>\n` +
          `TP1 (1R, 40%): <code>${entrySignal.tp1}</code> | TP2 (2R, 40%): <code>${entrySignal.tp2}</code> | TP3 (3R, 30%): <code>${entrySignal.tp3}</code>\n` +
          `R:R: <code>1:${entrySignal.riskRewardRatio}</code>\n` +
          `Размер: <code>${sizing.size}</code> | Риск: <code>${sizing.riskAmount} USDT</code>\n\n` +
          `📐 Уровень: ${levelInfo ? `${levelInfo.price.toFixed(2)} (${this.strategy._classificationRu(levelInfo.classification)}, сила ${levelInfo.strength})` : entrySignal.level}\n` +
          `Паттерн: <b>${entrySignal.typeRu}</b>\n` +
          `4H тренд: ${entrySignal._4hTrend || '?'} | подход: ${entrySignal._4hApproach || '?'}\n` +
          `Отмена: пробой уровня или 30 мин` +
          (entrySignal._aiConfidence ? `\n\n🤖 AI (${entrySignal._aiConfidence}%): ${entrySignal._aiReason}` : '')
        );

        logger.info(`Лимитный ордер размещён: ${result.id} — ожидание исполнения`);
        return;
      }

      // Мгновенное исполнение — устанавливаем SL/TP через Trading Stop API
      this.positions.set(pair, position);
      this.riskManager.addPosition(position);

      // SL (Stop Market) + TP (Limit) через setTradingStop
      await this._setPositionStopLossAndTakeProfit(pair, position);

      await this.notifier.notifyTrade({
        ...entrySignal,
        positionSize: sizing.size,
        riskAmount: sizing.riskAmount,
        riskPct: sizing.riskPct,
      });
      await this.webhook.pushToN8n('trade_opened', position);
      logger.info(`${pair}: ${entrySignal.signal} вход — ${entrySignal.reason}`);
    } catch (err) {
      const isMarginError = /ab not enough|insufficient.*balance|insufficient.*margin|not enough.*balance|not enough.*margin/i.test(err.message);
      if (isMarginError) {
        this._dayStats.marginFailures = (this._dayStats.marginFailures || 0) + 1;
        this._saveDayStats();
        logger.warn(`${pair}: ордер не открыт — недостаточно маржи (всего сегодня: ${this._dayStats.marginFailures})`);
        await this.notifier.sendMessage(
          `💰 <b>Недостаточно маржи</b>
` +
          `${pair} — ордер не размещён
` +
          `<i>${err.message}</i>

` +
          `Сегодня пропущено по марже: <b>${this._dayStats.marginFailures}</b>`
        );
      } else {
        logger.error(`Ошибка размещения ордера ${pair}: ${err.message}`);
        await this.notifier.notifyError(err);
        await this.webhook.pushToN8n('order_error', { pair, error: err.message });
      }
    }
  }
}

// --- CLI entry point ---
if (require.main === module) {
  const bot = new TradingBot();
  bot.start().catch((err) => {
    logger.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}

module.exports = TradingBot;

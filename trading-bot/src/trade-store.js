'use strict';

/**
 * Trade Store — SQLite database for trade history and AI analysis.
 */

const path = require('path');
const logger = require('./logger');

const Database = require('better-sqlite3');

const DB_PATH = path.resolve(__dirname, '..', 'data', 'trades.db');

class TradeStore {
  constructor() {
    const fs = require('fs');
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pair TEXT NOT NULL,
        timeframe TEXT,
        side TEXT NOT NULL,
        entry REAL NOT NULL,
        exit_price REAL,
        stop_loss REAL,
        take_profit REAL,
        original_sl REAL,
        size REAL,
        pnl REAL,
        realized_rr TEXT,
        close_type TEXT,
        breakeven_moved INTEGER DEFAULT 0,
        level_price REAL,
        level_classification TEXT,
        level_strength INTEGER,
        entry_pattern TEXT,
        entry_reason TEXT,
        exit_reason TEXT,
        duration TEXT,
        opened_at TEXT,
        closed_at TEXT NOT NULL DEFAULT (datetime('now')),
        ai_grade TEXT,
        ai_lessons TEXT,
        ai_improvement TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_trades_pair ON trades(pair);
      CREATE INDEX IF NOT EXISTS idx_trades_closed ON trades(closed_at);
    `);

    this._migrate();
    logger.info(`TradeStore: database at ${DB_PATH}`);
  }

  _migrate() {
    const columns = this.db.pragma('table_info(trades)').map(c => c.name);
    const migrations = [
      { col: 'original_sl', sql: 'ALTER TABLE trades ADD COLUMN original_sl REAL' },
      { col: 'breakeven_moved', sql: 'ALTER TABLE trades ADD COLUMN breakeven_moved INTEGER DEFAULT 0' },
      { col: 'level_price', sql: 'ALTER TABLE trades ADD COLUMN level_price REAL' },
      { col: 'level_classification', sql: 'ALTER TABLE trades ADD COLUMN level_classification TEXT' },
      { col: 'level_strength', sql: 'ALTER TABLE trades ADD COLUMN level_strength INTEGER' },
      { col: 'entry_pattern', sql: 'ALTER TABLE trades ADD COLUMN entry_pattern TEXT' },
      { col: 'entry_reason', sql: 'ALTER TABLE trades ADD COLUMN entry_reason TEXT' },
      { col: 'exit_reason', sql: 'ALTER TABLE trades ADD COLUMN exit_reason TEXT' },
      { col: 'duration', sql: 'ALTER TABLE trades ADD COLUMN duration TEXT' },
      { col: 'opened_at', sql: 'ALTER TABLE trades ADD COLUMN opened_at TEXT' },
      { col: 'realized_rr', sql: 'ALTER TABLE trades ADD COLUMN realized_rr TEXT' },
      { col: 'close_type', sql: 'ALTER TABLE trades ADD COLUMN close_type TEXT' },
      { col: 'tp1_hit', sql: 'ALTER TABLE trades ADD COLUMN tp1_hit INTEGER DEFAULT 0' },
      { col: 'tp2_hit', sql: 'ALTER TABLE trades ADD COLUMN tp2_hit INTEGER DEFAULT 0' },
      { col: 'tp3_hit', sql: 'ALTER TABLE trades ADD COLUMN tp3_hit INTEGER DEFAULT 0' },
      { col: 'partial_closes', sql: 'ALTER TABLE trades ADD COLUMN partial_closes TEXT' },
    ];
    for (const m of migrations) {
      if (!columns.includes(m.col)) {
        try { this.db.exec(m.sql); logger.info(`TradeStore migration: added column '${m.col}'`); }
        catch (err) { logger.warn(`TradeStore migration '${m.col}': ${err.message}`); }
      }
    }
  }

  saveTrade(trade) {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO trades (pair, timeframe, side, entry, exit_price, stop_loss,
          take_profit, original_sl, size, pnl, realized_rr, close_type, breakeven_moved,
          tp1_hit, tp2_hit, tp3_hit, partial_closes,
          level_price, level_classification, level_strength, entry_pattern,
          entry_reason, exit_reason, duration, opened_at, closed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        trade.pair, trade.timeframe, trade.side, trade.entry,
        trade.exitPrice, trade.stopLoss, trade.takeProfit,
        trade.originalSL || trade.stopLoss,
        trade.size, trade.pnl, trade.realizedRR || null, trade.closeType || null,
        trade.breakevenMoved ? 1 : 0,
        trade.tp1Hit ? 1 : 0, trade.tp2Hit ? 1 : 0, trade.tp3Hit ? 1 : 0,
        trade.partialCloses || null,
        trade.levelPrice || null, trade.levelClassification || null,
        trade.levelStrength || null, trade.entryPattern || null,
        trade.entryReason, trade.exitReason, trade.duration,
        trade.openedAt || null, trade.closedAt
      );
    } catch (err) { logger.error(`TradeStore save error: ${err.message}`); }
  }

  saveAnalysis(closedAt, analysis) {
    try {
      const stmt = this.db.prepare(`UPDATE trades SET ai_grade = ?, ai_lessons = ?, ai_improvement = ? WHERE closed_at = ?`);
      stmt.run(analysis.grade, JSON.stringify(analysis.lessons || []), analysis.improvement || '', closedAt);
    } catch (err) { logger.error(`TradeStore analysis save error: ${err.message}`); }
  }

  getRecentTrades(limit = 20) {
    return this.db.prepare('SELECT * FROM trades ORDER BY id DESC LIMIT ?').all(limit);
  }

  getStats() {
    const row = this.db.prepare(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) as losses,
        COALESCE(SUM(pnl), 0) as total_pnl,
        COALESCE(AVG(pnl), 0) as avg_pnl,
        SUM(CASE WHEN tp1_hit = 1 THEN 1 ELSE 0 END) as tp1_hits,
        SUM(CASE WHEN tp2_hit = 1 THEN 1 ELSE 0 END) as tp2_hits,
        SUM(CASE WHEN tp3_hit = 1 THEN 1 ELSE 0 END) as tp3_hits
      FROM trades
    `).get();
    return row;
  }

  getTradesToday(dateStr) {
    return this.db.prepare(`SELECT * FROM trades WHERE closed_at >= ? AND closed_at < date(?, '+1 day') ORDER BY id`).all(dateStr, dateStr);
  }

  getAllTrades() {
    return this.db.prepare('SELECT * FROM trades ORDER BY id').all();
  }

  close() { this.db.close(); }
}

module.exports = TradeStore;

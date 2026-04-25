'use strict';
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'data', 'trades.db');
const app = express();

app.use(express.static(__dirname));

app.get('/api/stats', (req, res) => {
  let db;
  try {
    db = new Database(DB_PATH, { readonly: true });
    const rows = db.prepare("SELECT * FROM trades WHERE exit_price IS NOT NULL ORDER BY closed_at").all();

    const closed = rows.filter(r => r.pnl != null);
    const wins   = closed.filter(r => r.pnl > 0);
    const losses = closed.filter(r => r.pnl < 0);
    const bes    = closed.filter(r => r.pnl === 0);
    const total  = closed.length;

    const sumWins   = wins.reduce((s, r) => s + r.pnl, 0);
    const sumLosses = Math.abs(losses.reduce((s, r) => s + r.pnl, 0));
    const netPnl    = closed.reduce((s, r) => s + r.pnl, 0);
    const pf        = sumLosses > 0 ? sumWins / sumLosses : Infinity;
    const wr        = total > 0 ? wins.length / total * 100 : 0;
    const expectancy = total > 0 ? netPnl / total : 0;

    // Max drawdown
    let cum = 0, peak = 0, maxDd = 0;
    for (const r of closed) {
      cum += r.pnl;
      if (cum > peak) peak = cum;
      const dd = peak - cum;
      if (dd > maxDd) maxDd = dd;
    }

    // Sharpe (annualized by trade count)
    let sharpe = 0;
    if (total >= 10) {
      const mean = netPnl / total;
      const variance = closed.reduce((s, r) => s + Math.pow(r.pnl - mean, 2), 0) / total;
      const std = Math.sqrt(variance);
      sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;
    }

    // TP hit rates
    const tp1 = closed.filter(r => r.tp1_hit).length;
    const tp2 = closed.filter(r => r.tp2_hit).length;
    const tp3 = closed.filter(r => r.tp3_hit).length;
    const trailing = closed.filter(r => r.close_type === 'trailing').length;
    const be  = closed.filter(r => r.breakeven_moved).length;

    // By level type
    const levelMap = {};
    for (const r of closed) {
      const lt = r.level_classification || 'unknown';
      if (!levelMap[lt]) levelMap[lt] = { wins: 0, losses: 0, pnl: 0, rr: [] };
      if (r.pnl > 0) levelMap[lt].wins++;
      else if (r.pnl < 0) levelMap[lt].losses++;
      levelMap[lt].pnl += r.pnl;
      const rr = parseFloat(r.realized_rr);
      if (!isNaN(rr)) levelMap[lt].rr.push(rr);
    }
    const byLevel = Object.entries(levelMap).map(([type, s]) => {
      const n = s.wins + s.losses;
      return {
        type,
        count: n,
        winRate: n > 0 ? s.wins / n * 100 : 0,
        avgRR: s.rr.length > 0 ? s.rr.reduce((a, b) => a + b, 0) / s.rr.length : 0,
        netPnl: s.pnl,
      };
    });

    // Top 10 pairs by PF
    const pairMap = {};
    for (const r of closed) {
      const p = r.pair;
      if (!pairMap[p]) pairMap[p] = { wins: 0, losses: 0, count: 0 };
      pairMap[p].count++;
      if (r.pnl > 0) pairMap[p].wins += r.pnl;
      else if (r.pnl < 0) pairMap[p].losses += Math.abs(r.pnl);
    }
    const topPairs = Object.entries(pairMap)
      .map(([pair, s]) => ({
        pair,
        count: s.count,
        pf: s.losses > 0 ? s.wins / s.losses : s.wins > 0 ? 9999 : 0,
        netPnl: s.wins - s.losses,
      }))
      .sort((a, b) => b.pf - a.pf)
      .slice(0, 10);

    // PnL by hour UTC
    const hourMap = {};
    for (const r of closed) {
      const ca = r.closed_at || '';
      if (ca.length >= 13) {
        const h = parseInt(ca.substring(11, 13), 10);
        if (!isNaN(h)) {
          if (!hourMap[h]) hourMap[h] = { pnl: 0, count: 0 };
          hourMap[h].pnl += r.pnl;
          hourMap[h].count++;
        }
      }
    }
    const byHour = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      pnl: hourMap[h] ? hourMap[h].pnl : 0,
      count: hourMap[h] ? hourMap[h].count : 0,
    }));

    // Close type breakdown
    const ctMap = {};
    for (const r of closed) {
      const ct = r.close_type || '?';
      if (!ctMap[ct]) ctMap[ct] = { count: 0, pnl: 0 };
      ctMap[ct].count++;
      ctMap[ct].pnl += r.pnl;
    }
    const byCloseType = Object.entries(ctMap)
      .map(([type, s]) => ({ type, count: s.count, pnl: s.pnl }))
      .sort((a, b) => b.pnl - a.pnl);

    // Equity curve
    let cumPnl = 0;
    const equity = closed.map(r => {
      cumPnl += r.pnl;
      return { time: r.closed_at, pnl: parseFloat(cumPnl.toFixed(4)) };
    });

    // Last 20 trades
    const last20 = closed.slice(-20).reverse().map(r => ({
      pair: r.pair,
      side: r.side,
      entry: r.entry_price,
      exit: r.exit_price,
      pnl: r.pnl,
      rr: r.realized_rr,
      duration: r.duration,
      closeType: r.close_type,
      closedAt: r.closed_at,
    }));

    res.json({
      summary: {
        total, wins: wins.length, losses: losses.length, breakevens: bes.length,
        winRate: parseFloat(wr.toFixed(2)),
        profitFactor: isFinite(pf) ? parseFloat(pf.toFixed(3)) : 9999,
        netPnl: parseFloat(netPnl.toFixed(4)),
        expectancy: parseFloat(expectancy.toFixed(4)),
        maxDrawdown: parseFloat(maxDd.toFixed(4)),
        sharpe: parseFloat(sharpe.toFixed(3)),
      },
      tpHits: { tp1, tp2, tp3, trailing, breakeven: be, total },
      byLevel,
      topPairs,
      byHour,
      byCloseType,
      equity,
      last20,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (db) db.close();
  }
});

const PORT = 3002;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Dashboard running on http://0.0.0.0:${PORT}`);
});

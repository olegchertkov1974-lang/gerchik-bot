'use strict';

const path = require('path');
const fs   = require('fs');

const dateArg    = process.argv[2];
const reportDate = dateArg || new Date().toISOString().slice(0, 10);

const DB_PATH     = path.resolve(__dirname, '..', 'data', 'trades.db');
const REPORTS_DIR = path.resolve(__dirname, '..', 'reports');

if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

const Database = require('better-sqlite3');
const db = new Database(DB_PATH, { readonly: true });

const trades = db.prepare(
  `SELECT * FROM trades WHERE date(closed_at) = ? ORDER BY closed_at ASC`
).all(reportDate);

db.close();

// helpers
const fmt = n  => (n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2));
const pct = (n, t) => t > 0 ? `${(n / t * 100).toFixed(0)}%` : '0%';
const lessons = raw => { try { return JSON.parse(raw)[0] || ''; } catch { return ''; } };

// симуляция PnL при новом сплите (s1, s2, s3) vs текущего (0.3, 0.4, 0.3)
function simulateSplit(trades, s1, s2, s3) {
  return trades.reduce((total, t) => {
    const partials = (() => { try { return JSON.parse(t.partial_closes || '[]'); } catch { return []; } })();
    const tp1pnl = partials.filter(p => p.tp === 'TP1').reduce((s, p) => s + p.pnl, 0);
    const tp2pnl = partials.filter(p => p.tp === 'TP2').reduce((s, p) => s + p.pnl, 0);
    const remainPnl = (t.pnl || 0) - tp1pnl - tp2pnl;

    const newTp1  = t.tp1_hit ? tp1pnl * (s1 / 0.3) : 0;
    const newTp2  = t.tp2_hit ? tp2pnl * (s2 / 0.4) : 0;
    const newRem  = remainPnl * (s3 / 0.3);
    return total + newTp1 + newTp2 + newRem;
  }, 0);
}

// фактический средний сплит из partial_closes
function calcActualSplit(trades) {
  let tp1sum = 0, tp2sum = 0, tp3sum = 0, origSum = 0;
  for (const t of trades) {
    if (!t.size || t.size <= 0) continue;
    const partials = (() => { try { return JSON.parse(t.partial_closes || '[]'); } catch { return []; } })();
    const tp1s = partials.filter(p => p.tp === 'TP1').reduce((s, p) => s + p.size, 0);
    const tp2s = partials.filter(p => p.tp === 'TP2').reduce((s, p) => s + p.size, 0);
    tp1sum += tp1s; tp2sum += tp2s;
    tp3sum += Math.max(0, t.size - tp1s - tp2s);
    origSum += t.size;
  }
  if (origSum === 0) return { tp1: 30, tp2: 40, tp3: 30 };
  return {
    tp1: Math.round(tp1sum / origSum * 100),
    tp2: Math.round(tp2sum / origSum * 100),
    tp3: Math.round(tp3sum / origSum * 100),
  };
}

// planned pnl если сделка закрылась бы по TP
function plannedPnl(t) {
  const sl = t.original_sl || t.stop_loss;
  const riskDist = Math.abs(t.entry - sl);
  const tpDist   = Math.abs(t.take_profit - t.entry);
  if (riskDist <= 0 || tpDist <= 0) return t.pnl;

  const plannedRR  = tpDist / riskDist;
  const actualRR   = parseFloat(t.realized_rr);
  if (!actualRR || isNaN(actualRR) || actualRR === 0) return t.pnl;

  const riskAmount = Math.abs(t.pnl) / Math.abs(actualRR);
  return riskAmount * plannedRR;
}

// block 1
const totalPnl  = trades.reduce((s, t) => s + (t.pnl || 0), 0);
const closeTypes = {};
for (const t of trades) closeTypes[t.close_type || 'unknown'] = (closeTypes[t.close_type || 'unknown'] || 0) + 1;

// block 2
const wins    = trades.filter(t => t.pnl > 0).length;
const losses  = trades.filter(t => t.pnl <= 0).length;
const winRate = trades.length > 0 ? (wins / trades.length * 100).toFixed(1) : '0';

// block 3
const validRR    = trades.filter(t => t.realized_rr && !isNaN(parseFloat(t.realized_rr)));
const avgRR      = validRR.length > 0
  ? (validRR.reduce((s, t) => s + parseFloat(t.realized_rr), 0) / validRR.length).toFixed(2)
  : 'N/A';
const rrReached3 = validRR.filter(t => parseFloat(t.realized_rr) >= 3).length;

// block 4
const tp1 = trades.filter(t => t.tp1_hit).length;
const tp2 = trades.filter(t => t.tp2_hit).length;
const tp3 = trades.filter(t => t.tp3_hit).length;

// block 5
const patternMap = {};
for (const t of trades) {
  const p = t.entry_pattern || 'unknown';
  if (!patternMap[p]) patternMap[p] = { wins: 0, total: 0, pnl: 0 };
  patternMap[p].total++;
  patternMap[p].pnl += t.pnl || 0;
  if (t.pnl > 0) patternMap[p].wins++;
}

// block 6
const pairMap = {};
for (const t of trades) {
  if (!pairMap[t.pair]) pairMap[t.pair] = { pnl: 0, trades: 0 };
  pairMap[t.pair].pnl    += t.pnl || 0;
  pairMap[t.pair].trades += 1;
}
const sortedPairs = Object.entries(pairMap).sort((a, b) => b[1].pnl - a[1].pnl);
const topPairs    = sortedPairs.slice(0, 3);
const worstPairs  = [...sortedPairs].reverse().slice(0, 3);

// block 7
const grades = { A: 0, B: 0, C: 0, D: 0 };
for (const t of trades) if (grades[t.ai_grade] !== undefined) grades[t.ai_grade]++;
const graded = Object.values(grades).reduce((s, v) => s + v, 0);

// block 8
const byPnl      = [...trades].sort((a, b) => b.pnl - a.pnl);
const bestTrade  = byPnl[0];
const worstTrade = byPnl[byPnl.length - 1];

// block 9: потенциал TP
const tpPotentialPnl = trades.reduce((s, t) => s + plannedPnl(t), 0);
const missed         = tpPotentialPnl - totalPnl;

const groupRows = [
  ['✅ TP (план)',  trades.filter(t => t.close_type === 'tp')],
  ['🛑 SL',        trades.filter(t => t.close_type === 'sl')],
  ['🔁 Breakeven', trades.filter(t => t.close_type === 'breakeven')],
  ['✋ Manual',     trades.filter(t => t.close_type === 'manual')],
];

// build markdown
const L = [];

L.push(`# Дневной дашборд — ${reportDate}`);
L.push(`_Сгенерирован: ${new Date().toISOString().replace('T',' ').slice(0,19)} UTC_`);
L.push('');

L.push('## 💰 1. Итог дня');
L.push('| PnL | Сделок | По SL | По TP |');
L.push('|-----|--------|-------|-------|');
L.push(`| **${fmt(totalPnl)} USDT** | ${trades.length} | ${closeTypes.sl || 0} | ${closeTypes.tp || 0} |`);
L.push('');

L.push('## 📊 2. Статистика');
L.push('| Wins | Losses | Win Rate | Всего |');
L.push('|------|--------|----------|-------|');
L.push(`| ${wins} \u2705 | ${losses} \u274c | **${winRate}%** | ${trades.length} |`);
L.push('');

L.push('## \u2696\ufe0f 3. R:R факт vs цель (цель 3:1)');
L.push('| Средний R:R | Достигли \u22653:1 | Не достигли |');
L.push('|-------------|---------------|-------------|');
L.push(`| **${avgRR}** | ${rrReached3} (${pct(rrReached3, trades.length)}) | ${trades.length - rrReached3} (${pct(trades.length - rrReached3, trades.length)}) |`);
L.push('');

L.push('## \ud83c\udfaf 4. TP1 / TP2 / TP3');
L.push('| TP1 | TP2 | TP3 |');
L.push('|-----|-----|-----|');
L.push(`| ${tp1} (${pct(tp1, trades.length)}) | ${tp2} (${pct(tp2, trades.length)}) | ${tp3} (${pct(tp3, trades.length)}) |`);
L.push('');

L.push('## \ud83d\udd0d 5. Паттерны входа');
L.push('| Паттерн | Сделок | Win Rate | PnL |');
L.push('|---------|--------|----------|-----|');
for (const [p, s] of Object.entries(patternMap).sort((a, b) => b[1].total - a[1].total)) {
  L.push(`| ${p} | ${s.total} | ${pct(s.wins, s.total)} | ${fmt(s.pnl)} |`);
}
L.push('');

L.push('## \ud83d\udcb9 6. Пары');
L.push('**Топ прибыльных:**');
L.push('| Пара | Сделок | PnL |');
L.push('|------|--------|-----|');
for (const [pair, s] of topPairs) L.push(`| ${pair} | ${s.trades} | ${fmt(s.pnl)} |`);
L.push('');
L.push('**Худшие:**');
L.push('| Пара | Сделок | PnL |');
L.push('|------|--------|-----|');
for (const [pair, s] of worstPairs) L.push(`| ${pair} | ${s.trades} | ${fmt(s.pnl)} |`);
L.push('');

L.push('## \ud83e\udd16 7. AI-оценки качества входов');
L.push('| A \u2b50 | B \ud83d\udc4d | C \u26a0\ufe0f | D \u274c | Доля A+B |');
L.push('|-----|------|------|-----|----------|');
L.push(`| ${grades.A} | ${grades.B} | ${grades.C} | ${grades.D} | **${pct(grades.A + grades.B, graded)}** |`);
L.push('');

L.push('## \ud83c\udfc6 8. Лучшая и худшая сделка');
if (bestTrade) {
  L.push(`**\ud83d\udfe2 Лучшая:** \`${bestTrade.pair}\` ${bestTrade.side.toUpperCase()} | Вход: ${bestTrade.entry} | PnL: **${fmt(bestTrade.pnl)}** | R:R: ${bestTrade.realized_rr} | Оценка: ${bestTrade.ai_grade}`);
  const l = lessons(bestTrade.ai_lessons);
  if (l) L.push(`> ${l}`);
  L.push('');
}
if (worstTrade && worstTrade.id !== bestTrade?.id) {
  L.push(`**\ud83d\udd34 Худшая:** \`${worstTrade.pair}\` ${worstTrade.side.toUpperCase()} | Вход: ${worstTrade.entry} | PnL: **${fmt(worstTrade.pnl)}** | R:R: ${worstTrade.realized_rr} | Оценка: ${worstTrade.ai_grade}`);
  const l = lessons(worstTrade.ai_lessons);
  if (l) L.push(`> ${l}`);
}
L.push('');

// block 10 data — split simulation
const actualSplit = calcActualSplit(trades);
const scenarios = [
  { label: '🔧 Настроенный 30/40/30', s1: 0.3,  s2: 0.4,  s3: 0.3  },
  { label: '40 / 60 / 0',             s1: 0.4,  s2: 0.6,  s3: 0    },
  { label: '50 / 50 / 0',             s1: 0.5,  s2: 0.5,  s3: 0    },
  { label: '45 / 55 / 0',             s1: 0.45, s2: 0.55, s3: 0    },
  { label: '60 / 40 / 0',             s1: 0.6,  s2: 0.4,  s3: 0    },
  { label: '40 / 40 / 20',            s1: 0.4,  s2: 0.4,  s3: 0.2  },
];

L.push('## \ud83c\udfae 10. Симуляция сплита TP1/TP2/TP3');
L.push('');
L.push(`_Настроенный сплит в боте: TP1 30% / TP2 40% / TP3 30% (строки 1728/1795 bot.js)_`);
L.push(`_Реально доходит до TP: TP1 ${pct(tp1, trades.length)} / TP2 ${pct(tp2, trades.length)} / TP3 ${pct(tp3, trades.length)} сделок_`);
L.push(`_Объём что фактически дошёл до TP1/TP2: ${actualSplit.tp1}% / ${actualSplit.tp2}% от всего задеплоенного объёма_`);
L.push('');
L.push('| Сплит TP1/TP2/TP3 | PnL дня | vs текущего |');
L.push('|-------------------|---------|-------------|');
const baselinePnl = simulateSplit(trades, 0.3, 0.4, 0.3);
L.push('');
L.push('**Что было бы если изменить сплит:**');
for (const sc of scenarios) {
  const simPnl = simulateSplit(trades, sc.s1, sc.s2, sc.s3);
  const diff   = simPnl - baselinePnl;
  const marker = sc.s3 === 0.3 ? '' : diff > 0 ? ' \u2b06\ufe0f' : ' \u2b07\ufe0f';
  L.push(`| ${sc.label} | **${fmt(simPnl)}** | ${fmt(diff)}${marker} |`);
}
L.push('');
L.push('_Допущение: при изменении сплита PnL каждого TP масштабируется линейно по размеру_');
L.push('_TP3=0 означает что объём TP3 перераспределяется в TP1/TP2 — финальный остаток не торгуется_');
L.push('');

L.push('## \ud83d\udcc8 9. Потенциал — если все сделки закрылись бы по TP');
L.push('| Реальный PnL | Потенциал по TP | Недополучено |');
L.push('|-------------|-----------------|--------------|');
L.push(`| **${fmt(totalPnl)} USDT** | **${fmt(tpPotentialPnl)} USDT** | **${fmt(missed)} USDT** |`);
L.push('');
L.push('| Тип закрытия | Сделок | Реальный PnL | Потенциал по TP | Разница |');
L.push('|--------------|--------|-------------|-----------------|---------|');
for (const [label, group] of groupRows) {
  if (group.length === 0) continue;
  const real = group.reduce((s, t) => s + (t.pnl || 0), 0);
  const plan = group.reduce((s, t) => s + plannedPnl(t), 0);
  L.push(`| ${label} | ${group.length} | ${fmt(real)} | ${fmt(plan)} | ${fmt(plan - real)} |`);
}
L.push('');
L.push('_planned\\_RR = |TP - entry| / |original\\_SL - entry|_');
L.push('');

L.push('---');
L.push(`_gerchik-bot · ${reportDate} · auto-generated_`);

const report = L.join('\n');
const outPath = path.join(REPORTS_DIR, `${reportDate}.md`);
fs.writeFileSync(outPath, report, 'utf8');
console.log(`Report saved: ${outPath}`);

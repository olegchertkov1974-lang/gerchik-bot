#!/usr/bin/env node
/**
 * Ежедневный отбор топ-20 пар по ATR14d% x log10(vol24h)
 * Запускается в 09:00 МСК (06:00 UTC) через cron
 */

require('dotenv').config({ path: '/opt/trading-bot/trading-bot/.env', override: true });

const fs   = require('fs');
const B    = require('/opt/trading-bot/trading-bot/src/bybit-exchange');

const ENV_PATH = '/opt/trading-bot/trading-bot/.env';

const PAIR_POOL = [
  'BTC/USDT','ETH/USDT','SOL/USDT','BNB/USDT','XRP/USDT','ADA/USDT','DOGE/USDT',
  'AVAX/USDT','LINK/USDT','DOT/USDT','NEAR/USDT','LTC/USDT','ATOM/USDT','TRX/USDT',
  'HYPE/USDT','TAO/USDT','AAVE/USDT','AXS/USDT','TRUMP/USDT','ZEC/USDT','XMR/USDT',
  'ORDI/USDT','SUI/USDT','ARB/USDT','CRV/USDT','APT/USDT','TON/USDT','WIF/USDT',
  'ALGO/USDT','HBAR/USDT','XLM/USDT','WLD/USDT','VIRTUAL/USDT','FARTCOIN/USDT',
  'ENA/USDT','DYDX/USDT','IP/USDT','MOVR/USDT','SAND/USDT','POL/USDT',
  'STRK/USDT','TIA/USDT','JUP/USDT','ZRO/USDT','SEI/USDT','STX/USDT',
  'ONDO/USDT','RENDER/USDT','PYTH/USDT','BLUR/USDT'
];

const TOP_N    = 20;
const ATR_DAYS = 14;

async function calcScore(exchange, symbol) {
  try {
    const ohlcv = await exchange.fetchOHLCV(symbol, '1d', undefined, ATR_DAYS + 2);
    if (!ohlcv || ohlcv.length < ATR_DAYS) return null;

    const candles = ohlcv.slice(-ATR_DAYS);
    let atrPctSum = 0;
    for (const [, , high, low, close] of candles) {
      const mid = (high + low) / 2 || close;
      if (mid > 0) atrPctSum += (high - low) / mid * 100;
    }
    const atrPct = atrPctSum / candles.length;

    const ticker = await exchange.fetchTicker(symbol);
    const vol24h = ticker.quoteVolume || 0;
    if (vol24h < 5000000) return null;

    const score = atrPct * Math.log10(vol24h);
    return {
      symbol,
      atrPct: +atrPct.toFixed(2),
      vol24h: Math.round(vol24h / 1e6) + 'M',
      score: +score.toFixed(2)
    };
  } catch (e) {
    return null;
  }
}

function updateEnvPairs(newPairs) {
  let env = fs.readFileSync(ENV_PATH, 'utf8');
  const line = 'ACTIVE_PAIRS=' + newPairs.join(',');
  if (/^ACTIVE_PAIRS=/m.test(env)) {
    env = env.replace(/^ACTIVE_PAIRS=.*/m, line);
  } else {
    env += '\n' + line;
  }
  fs.writeFileSync(ENV_PATH, env, 'utf8');
}

(async () => {
  const b = new B();
  await b.exchange.loadMarkets();

  console.log('[select-pairs] Считаем скоры для ' + PAIR_POOL.length + ' пар...');

  const results = [];
  for (const symbol of PAIR_POOL) {
    const r = await calcScore(b.exchange, symbol);
    if (r) { results.push(r); process.stdout.write('.'); }
    else    { process.stdout.write('x'); }
  }
  console.log('');

  results.sort((a, b) => b.score - a.score);
  const top   = results.slice(0, TOP_N);
  const pairs = top.map(r => r.symbol);

  const today = new Date().toLocaleDateString('ru-RU');
  console.log('\n[select-pairs] Топ-' + TOP_N + ' пар на ' + today + ':');
  top.forEach((r, i) => {
    const idx = String(i + 1).padStart(2);
    console.log('  ' + idx + '. ' + r.symbol.padEnd(14) + ' ATR14d=' + r.atrPct + '%  vol=' + r.vol24h + '  score=' + r.score);
  });

  updateEnvPairs(pairs);
  console.log('\n[select-pairs] ACTIVE_PAIRS обновлён в .env');

  const { execSync } = require('child_process');
  execSync('pm2 restart gerchik-bot --update-env', { stdio: 'inherit' });
  console.log('[select-pairs] Бот перезапущен.');
})();

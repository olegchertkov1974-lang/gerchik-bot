'use strict';

/**
 * Webhook Server for n8n integration.
 */

const http = require('http');
const logger = require('./logger');

class WebhookServer {
  constructor(bot) {
    this.bot = bot;
    this.port = parseInt(process.env.WEBHOOK_PORT, 10) || 3001;
    this.host = process.env.WEBHOOK_HOST || '127.0.0.1';
    this.secret = process.env.WEBHOOK_SECRET || '';
    this.n8nWebhookUrl = process.env.N8N_WEBHOOK_URL || '';
    this.server = null;
  }

  start() {
    this.server = http.createServer((req, res) => this._handleRequest(req, res));
    this.server.listen(this.port, this.host, () => {
      logger.info(`Webhook server listening on ${this.host}:${this.port}`);
    });
  }

  stop() {
    if (this.server) { this.server.close(); logger.info('Webhook server stopped'); }
  }

  async _handleRequest(req, res) {
    if (this.secret) {
      const auth = req.headers['x-webhook-secret'] || '';
      if (auth !== this.secret) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    const url = req.url.split('?')[0];
    try {
      if (req.method === 'GET' && url === '/status') return this._sendJson(res, await this._getStatus());
      if (req.method === 'GET' && url === '/positions') return this._sendJson(res, this._getPositions());
      if (req.method === 'GET' && url === '/levels') return this._sendJson(res, await this._getLevels(req));
      if (req.method === 'POST' && url === '/command') {
        const body = await this._readBody(req);
        return this._sendJson(res, await this._handleCommand(body));
      }
      if (req.method === 'POST' && url === '/ai-override') {
        const body = await this._readBody(req);
        return this._sendJson(res, this._handleAIOverride(body));
      }
      if (req.method === 'GET' && url === '/stats') return this._sendJson(res, this._getStats());
      if (req.method === 'GET' && url === '/trades') return this._sendJson(res, this._getTrades(req));

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err) {
      logger.error(`Webhook error: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  async _getStatus() {
    let balance = { total: 0, free: 0 };
    try { balance = await this.bot.exchange.fetchBalance(); } catch (_) {}
    return { running: this.bot.running, positions: this.bot.positions.size, balance, uptime: process.uptime(), aiEnabled: this.bot.aiFilter ? this.bot.aiFilter.enabled : false };
  }

  _getPositions() {
    const positions = [];
    for (const [key, pos] of this.bot.positions) positions.push({ key, ...pos });
    return { count: positions.length, positions };
  }

  async _getLevels(req) {
    const params = new URL(req.url, `http://${req.headers.host}`).searchParams;
    const pair = params.get('pair') || 'BTC/USDT';
    const tf = params.get('timeframe') || '1h';
    const candles = await this.bot.exchange.fetchCandles(pair, tf, 200);
    const levels = this.bot.strategy._findLevels(candles);
    const atr = this.bot.strategy._calculateATR(candles, 14);
    const currentPrice = candles[candles.length - 1].close;
    return { pair, timeframe: tf, currentPrice, atr, levels };
  }

  async _handleCommand(body) {
    const { command } = body;
    switch (command) {
      case 'pause': this.bot.paused = true; logger.info('Bot paused via webhook'); return { ok: true, message: 'Bot paused' };
      case 'resume': this.bot.paused = false; logger.info('Bot resumed via webhook'); return { ok: true, message: 'Bot resumed' };
      case 'stop': this.bot.stop(); return { ok: true, message: 'Bot stopped' };
      case 'daily_report': { const stats = this.bot.tradeStore.getStats(); await this.bot.notifier.notifyDailySummary(stats); return { ok: true, stats }; }
      case 'close_all':
        for (const [key, pos] of this.bot.positions) {
          const pair = key.split(':')[0];
          try { await this.bot.exchange.closePosition(pair, pos.side, pos.size); this.bot.riskManager.removePosition(key); this.bot.positions.delete(key); logger.info(`Closed ${key} via webhook`); }
          catch (err) { logger.error(`Failed to close ${key}: ${err.message}`); }
        }
        return { ok: true, message: 'All positions closed' };
      case 'force_scan':
        try { await this.bot._tick(); return { ok: true, message: 'Scan complete' }; }
        catch (err) { return { ok: false, message: err.message }; }
      default: return { ok: false, message: `Unknown command: ${command}` };
    }
  }

  _handleAIOverride(body) {
    const { posKey, approved, reason } = body;
    if (this.bot._pendingSignals && this.bot._pendingSignals.has(posKey)) {
      const pending = this.bot._pendingSignals.get(posKey);
      pending.aiOverride = { approved, reason };
      logger.info(`AI override for ${posKey}: ${approved ? 'APPROVED' : 'REJECTED'} — ${reason}`);
      return { ok: true, message: `Override applied for ${posKey}` };
    }
    return { ok: false, message: `No pending signal for ${posKey}` };
  }

  _getStats() {
    if (this.bot.tradeStore) return this.bot.tradeStore.getStats();
    return { total: 0, wins: 0, losses: 0, total_pnl: 0 };
  }

  _getTrades(req) {
    const params = new URL(req.url, `http://${req.headers.host}`).searchParams;
    const limit = parseInt(params.get('limit'), 10) || 20;
    if (this.bot.tradeStore) return { trades: this.bot.tradeStore.getRecentTrades(limit) };
    return { trades: [] };
  }

  async pushToN8n(event, data) {
    if (!this.n8nWebhookUrl) return;
    const payload = JSON.stringify({ event, timestamp: new Date().toISOString(), data });
    return new Promise((resolve) => {
      const url = new URL(this.n8nWebhookUrl);
      const isHttps = url.protocol === 'https:';
      const transport = isHttps ? require('https') : http;
      const req = transport.request(
        { hostname: url.hostname, port: url.port || (isHttps ? 443 : 80), path: url.pathname, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, timeout: 10000 },
        (res) => { let body = ''; res.on('data', (chunk) => (body += chunk)); res.on('end', () => { logger.debug(`n8n webhook response: ${res.statusCode}`); resolve(body); }); }
      );
      req.on('error', (err) => { logger.error(`n8n webhook error: ${err.message}`); resolve(null); });
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.write(payload);
      req.end();
    });
  }

  _sendJson(res, data) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); }

  _readBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(new Error('Invalid JSON body')); } });
    });
  }
}

module.exports = WebhookServer;

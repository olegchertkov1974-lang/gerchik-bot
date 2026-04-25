'use strict';

/**
 * OpenRouter AI Filter
 */

const https = require('https');
const logger = require('./logger');

class AIFilter {
  constructor() {
    this.apiKey = process.env.OPENROUTER_API_KEY;
    this.model = process.env.OPENROUTER_MODEL || 'anthropic/claude-3.5-sonnet';
    this.enabled = !!this.apiKey;

    if (!this.enabled) {
      logger.warn('AI Filter disabled: OPENROUTER_API_KEY not set');
    }
  }

  async validateSignal(signal, candles, levels) {
    if (!this.enabled) return { approved: true, confidence: 0, reason: 'AI filter disabled' };

    const last10 = candles.slice(-10).map((c) => ({
      o: c.open.toFixed(2), h: c.high.toFixed(2), l: c.low.toFixed(2), c: c.close.toFixed(2), v: Math.round(c.volume),
    }));

    const topLevels = levels.slice(0, 5).map((l) => ({ price: l.price.toFixed(2), type: l.type, touches: l.touches }));

    const prompt = `Ты криптотрейдинг-аналитик. Оцени торговый сигнал.

Сигнал: ${signal.signal.toUpperCase()} ${signal.type} на ${signal.pair || 'unknown'}
Вход: ${signal.entry}, SL: ${signal.stopLoss}, TP: ${signal.takeProfit}
R:R: 1:${signal.riskRewardRatio}
Причина: ${signal.reason}

Последние 10 свечей (OHLCV):
${JSON.stringify(last10)}

Ключевые уровни:
${JSON.stringify(topLevels)}

Ответь СТРОГО одной строкой валидного JSON без каких-либо пояснений, markdown, текста до или после:
{"approved": true/false, "confidence": 0-100, "reason": "краткое объяснение на русском языке"}`;

    try {
      const response = await this._request(prompt);
      const parsed = JSON.parse(response);
      logger.info(`AI filter: ${parsed.approved ? 'APPROVED' : 'REJECTED'} (${parsed.confidence}%) — ${parsed.reason}`);
      return parsed;
    } catch (err) {
      logger.error(`AI filter error: ${err.message}`);
      return { approved: true, confidence: 0, reason: `AI error: ${err.message}` };
    }
  }

  async detectMarketRegime(pair, candles) {
    if (!this.enabled) return { regime: 'unknown', suggestion: 'AI disabled' };

    const last20 = candles.slice(-20).map((c) => ({
      o: c.open.toFixed(2), h: c.high.toFixed(2), l: c.low.toFixed(2), c: c.close.toFixed(2), v: Math.round(c.volume),
    }));

    const prompt = `Определи рыночный режим для ${pair}. Ответь ТОЛЬКО валидным JSON: {"regime": "trending_up"|"trending_down"|"ranging"|"volatile", "strength": 0-100, "suggestion": "краткий совет для стратегии по уровням на русском языке"}

Последние 20 свечей (OHLCV):
${JSON.stringify(last20)}

ВАЖНО: поле "suggestion" должно быть на русском языке.`;

    try {
      const response = await this._request(prompt);
      return JSON.parse(response);
    } catch (err) {
      logger.error(`Market regime detection error: ${err.message}`);
      return { regime: 'unknown', suggestion: `Error: ${err.message}` };
    }
  }

  async analyzeTrade(trade) {
    if (!this.enabled) return null;
    const prompt = `Проанализируй завершённую криптосделку. Ответь ТОЛЬКО валидным JSON: {"grade": "A/B/C/D/F", "lessons": ["урок1", "урок2"], "improvement": "один ключевой совет на будущее"}

Сделка:
- Пара: ${trade.pair}
- Направление: ${trade.side}
- Вход: ${trade.entry}, Выход: ${trade.exitPrice}
- SL: ${trade.stopLoss}, TP: ${trade.takeProfit}
- Результат: ${trade.pnl > 0 ? 'ПРИБЫЛЬ' : 'УБЫТОК'} ${trade.pnl} USDT
- Причина входа: ${trade.entryReason}
- Причина выхода: ${trade.exitReason}
- Длительность: ${trade.duration}

ВАЖНО: все поля должны быть на русском языке.`;
    try {
      const response = await this._request(prompt);
      return JSON.parse(response);
    } catch (err) {
      logger.error(`Trade analysis error: ${err.message}`);
      return null;
    }
  }

  async _request(prompt) {
    const payload = JSON.stringify({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500,
      temperature: 0.1,
    });

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: 'openrouter.ai',
          path: '/api/v1/chat/completions',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Length': Buffer.byteLength(payload),
          },
          timeout: 30000,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            if (res.statusCode !== 200) {
              return reject(new Error(`OpenRouter ${res.statusCode}: ${data.slice(0, 200)}`));
            }
            try {
              const json = JSON.parse(data);
              const content = json.choices && json.choices[0] && json.choices[0].message ? json.choices[0].message.content : '';
              const jsonMatch = content.match(/\{[\s\S]*\}/);
              if (jsonMatch) { resolve(jsonMatch[0]); } else { reject(new Error('No JSON in AI response')); }
            } catch (e) { reject(new Error(`Parse error: ${e.message}`)); }
          });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('OpenRouter request timeout')); });
      req.write(payload);
      req.end();
    });
  }
}

module.exports = AIFilter;

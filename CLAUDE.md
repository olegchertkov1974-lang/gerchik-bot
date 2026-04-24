# CLAUDE.md

## Проект
Торговые боты для Bybit. Бэктест → бот → testnet → mainnet.

## Стек
- Python 3.11+, ccxt, pandas, ta-lib
- Telegram алерты (python-telegram-bot)
- Docker для деплоя

## Критические правила
- НИКОГДА не хардкодить API ключи — только .env
- НИКОГДА не читать .env — только создавать .env.example
- Первый деплой ВСЕГДА на testnet
- Максимальный drawdown по умолчанию 15%

## Команды
- pip install -r requirements.txt --break-system-packages
- python backtest.py --strategy strategy.json
- python bot.py --testnet
- pytest tests/ -v

## Структура
- strategies/ — JSON стратегии
- bots/ — сгенерированные боты
- backtests/ — HTML отчёты
- scripts/ — утилиты

## Стиль кода
- Docstrings на русском
- Type hints обязательны
- logging вместо print

---
name: deploy-bot
description: Генерация и деплой торгового бота на testnet
---

1. Проверь наличие бэктеста (Sharpe > 0.5)
2. Запусти: python scripts/generate_bot.py --testnet
3. Проверь .env.example (НЕ читай .env)
4. Задеплой на testnet
5. Отправь алерт в Telegram о запуске

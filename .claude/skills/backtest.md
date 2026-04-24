---
name: backtest
description: Бэктест торговой стратегии на исторических данных Bybit
---

1. Прими стратегию (текст или JSON)
2. Запусти: python scripts/backtest.py --strategy strategy.json
3. Проверь метрики: Sharpe > 0.5, drawdown < 30%, trades > 30
4. Сгенерируй HTML-отчёт с equity curve
5. Верни summary с ключевыми метриками

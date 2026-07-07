# Scarlett Paper Trader

## What this is

A fully simulated crypto trading experiment that runs itself. Every five minutes it records live prices from CoinSpot for BTC, ETH, SOL, XRP and DOGE, then lets six different trading strategies act on those prices with pretend money. Each strategy started with a virtual $10,000 AUD. Nothing here can touch a real account: there are no exchange keys, no logins, and no way to place an actual trade. It is an evidence-gathering tool, not a trading bot.

## Why it exists

Before risking a single real dollar on automated trading, this system answers the only question that matters: does any strategy actually beat just buying and holding? One of the strategies is exactly that: buy BTC and ETH on day one and never touch them again. It is the benchmark. If the active strategies cannot beat the boring one after fees and spreads over 60 to 90 days, that is the answer, and it will have cost nothing to learn.

## The strategies

Buy & Hold is the benchmark described above. Daily DCA buys a small fixed amount every day regardless of price. SMA Crossover watches a fast moving average against a slow one and trades confirmed crossovers. Momentum buys confirmed strength and exits when the trend fades or a stop loss hits. Mean Reversion buys unusually stretched pullbacks and sells into recovery.

Profit Lock is the more defensive active strategy. It only enters when the composite signal is stronger than the normal buy threshold, takes partial profit early, uses a trailing protection rule once a position is green, and blocks immediate re-entry after a sell. The goal is to reduce fee bleed and stop the simulator from selling lower in a weak moment, then buying back almost immediately at a higher price.

All simulated fills are deliberately pessimistic: buys happen at the ask price, sells at the bid, and CoinSpot's 0.1% market order fee is charged on every trade. Most paper-trading tools skip these costs, which is exactly how bad strategies get mistaken for good ones.

## Anti-churn risk controls

The simulator now keeps short-term trade memory per strategy and coin:

- Minimum hold time before non-emergency loss exits.
- Cooldown after every sell before the same strategy can buy the same coin again.
- Longer cooldown after a loss sell.
- Stronger signal required to re-buy above the last sell price.
- Two-tick confirmation before ordinary sell signals are allowed through.
- Hard stop loss, early partial profit lock, second profit lock, and trailing profit protection.

These controls do not make trading safe or profitable. They make the paper experiment more realistic by reducing impulsive churn, spread loss, and repeated buy/sell reversals that would be especially expensive in live markets.

## How it runs

A scheduled Netlify function fires every five minutes, fetches prices, stores them, and gives each strategy the chance to trade. The dashboard can also run one tick manually. All history lives in Netlify Blobs. The dashboard at the site's root address reads that data and shows equity curves, open positions, per-coin signals, and a trade log with the reason for every trade. Strategies that need price history will make no trades until enough data exists for their indicators; that is expected behaviour, not a fault.

## Honest limitations

The price feed only starts collecting from the day the site goes live, so early results mean very little; judge nothing before four weeks and prefer the full 90 days. Deploying a code change restarts nothing and loses no data, but a gap in Netlify's scheduler or a CoinSpot outage will leave small holes in the history. Results in a simulator also flatter real trading: live markets add slippage, failed orders, liquidity gaps, and emotional execution risk that no simulation fully captures. None of this is financial advice.

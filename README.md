# Scarlett Paper Trader

## What this is

A fully simulated crypto trading experiment that runs itself. Every five minutes it records live prices from CoinSpot for BTC, ETH, SOL, XRP and DOGE, then lets five different trading strategies act on those prices with pretend money. Each strategy started with a virtual $10,000 AUD. Nothing here can touch a real account — there are no exchange keys, no logins, and no way to place an actual trade. It is an evidence-gathering tool, not a trading bot.

## Why it exists

Before risking a single real dollar on automated trading, this system answers the only question that matters: does any strategy actually beat just buying and holding? One of the five strategies is exactly that — buy BTC and ETH on day one and never touch them again. It is the benchmark. If the clever strategies can't beat the boring one after fees and spreads over 60 to 90 days, that is the answer, and it will have cost nothing to learn.

## The five strategies

Buy & Hold is the benchmark described above. Daily DCA buys a small fixed amount every day regardless of price. SMA Crossover watches a fast moving average against a slow one and trades the crossovers. Momentum buys when the last 24 hours have been strongly positive and exits when the trend fades or a stop loss hits. Mean Reversion buys when price drops unusually far below its recent average and sells when it recovers.

All simulated fills are deliberately pessimistic: buys happen at the ask price, sells at the bid, and CoinSpot's 0.1% market order fee is charged on every trade. Most paper-trading tools skip these costs, which is exactly how bad strategies get mistaken for good ones.

## How it runs

A scheduled Netlify function fires every five minutes, fetches prices, stores them, and gives each strategy the chance to trade. All history lives in Netlify Blobs. The dashboard at the site's root address reads that data and shows equity curves, open positions, and a full trade log with the reason for every trade. Strategies that need price history (most of them) will make no trades for the first 6 to 24 hours — that is expected behaviour, not a fault.

## Honest limitations

The price feed only starts collecting from the day the site goes live, so early results mean very little; judge nothing before four weeks and prefer the full 90 days. Deploying a code change restarts nothing and loses no data, but a gap in Netlify's scheduler or a CoinSpot outage will leave small holes in the history. Results in a simulator also flatter real trading — live markets add slippage and failed orders that no simulation fully captures. And none of this is financial advice.

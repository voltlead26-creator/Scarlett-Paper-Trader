# Scarlett Crypto Research — July 2026 Deep Dives

**Generated 2026-07-17. All prices delayed/approximate snapshots at research date — never live. Not financial advice. Paper-trade first.**

## Critical engine constraint

Scarlett prices markets from CoinSpot's public latest-prices endpoint, which returns only ~17 AUD order-book markets (btc, eth, sol, xrp, ada, doge, ltc, trx, eos, gas, powr, ans, str, rfox, rhoc, usdt, btc_usdt). CoinSpot lists ~483 coins for instant-buy, but those are **not priceable by the engine**.

**Tradeable inside Scarlett today: SOL, XRP, ETH only** (of the 18 researched coins).
Everything else requires a new price source (CoinGecko/CMC adapter) before any strategy can touch it. See `engine_todo` in `watchlist.json`.

## Core 12 — surge ranking

| # | Coin | Approx px (USD) | Off ATH | Dated catalyst | Value capture | Moat | Floor | Scarlett |
|---|------|-----------------|---------|----------------|---------------|------|-------|----------|
| 1 | HYPE | 65–72 | ~10% | FOMO app; ETFs; HIP-3/4 | Strong (buybacks) | Med | High risk | ✗ |
| 2 | TAO | 213–289 | ~70% | **Aug** ETF decision | Weak | Weak | High risk | ✗ |
| 3 | SOL | 77–88 | ~74% | Alpenglow **Q3** + ETF | Weak-med | Med-strong | Med | **✓** |
| 4 | ONDO | 0.32–0.37 | ~79% | DTCC **Oct** | Weak | Med | Med | ✗ |
| 5 | KAS | 0.028–0.030 | ~85% | Kasplex L2 **Aug** | None | Weak | High risk | ✗ |
| 6 | ENA | 0.07–0.083 | ~70% | BlackRock/Aladdin | Med | Med (peg) | High risk | ✗ |
| 7 | RNDR | 1.45–1.52 | ~87% | Salad 60k GPUs | Weak | Med | Med | verify |
| 8 | INJ | 4.90–5.17 | ~35% | Vulcan live; DC summit fired | Strong (burn) | Med | Med | ✗ |
| 9 | LINK | 7.90–8.51 | ~85% | DTCC **Q4** + SWIFT | Weak | **Strong** | Med | ✗ |
| 10 | XRP | 1.06–1.14 | ~70% | **CLARITY Act** vote | Weak-med | Med | Binary | **✓** |
| 11 | JUP | 0.20–0.22 | ~89% | SOL flow-through + buybacks | Strong | Med (SOL-only) | Med-high | ✗ |
| 12 | ETH | 1600–1920 | ~55% | Glamsterdam **Q3** + staking ETFs | Med | **Strongest** | **Lowest** | **✓** |

## Up-and-comers (business-quality tiers, price excluded)

- **Tier 2 (real traction, unresolved economics):** PLUME (SEC transfer agent, Apollo/WisdomTree/Etherfi contracts, $645M AUM vs $115M FDV), KAITO (only one that invoices customers)
- **Tier 3 (funded options, not businesses):** FF (Anchorage fUSD is the one underwritable piece; peg + trust + unlock risks stack)
- **Tier 4 (structures without durable revenue):** IO (one $8M deal), MON ($400M TVL, <$3k/day fees, 30%+ 2026 unlocks), ASTER (incentive-bought volume, already faded)

## Strategy implications for Scarlett

1. **Universe filter:** strategies should trade only `tradeable_on_scarlett: true` symbols until a CoinGecko adapter exists. That's SOL, XRP, ETH — conveniently a beta ladder: ETH (lowest risk) → SOL (mid) → XRP (event-binary).
2. **Event risk:** XRP is pinned to a legislative binary (CLARITY Act, late Jul/Aug). Momentum/scalper strategies will get chopped in its $1.00–1.20 range; a breakout strategy suits it better.
3. **Correlation:** SOL and (if ever added) JUP are the same bet at different betas. Do not hold both as 'diversification'.
4. **Catalyst calendar (dated):** Aug — TAO ETF decision, KAS Kasplex L2, PLUME airdrop close · Q3 — SOL Alpenglow, ETH Glamsterdam · Q4 — LINK DTCC · Oct — ONDO DTCC full launch.
5. **Spread tax:** instant-buy spreads (1–3%) mean small-cap signals need >2x the edge of order-book signals to clear costs. The engine's simulated fills will overstate real returns on any instant-buy-only coin.

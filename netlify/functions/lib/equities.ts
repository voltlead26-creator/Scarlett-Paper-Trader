/**
 * Equity price adapter — Yahoo Finance chart endpoint, no API key.
 * Simulated money only; nothing here can place a real trade.
 *
 * Markets are hard-separated by key prefix so symbols can never collide with
 * each other or with CoinSpot crypto tickers:
 *   Nasdaq:  nq:nvda, nq:mu, ...   (USD, US regular session ~23:30–06:00 AEST)
 *   ASX:     asx:bhp, asx:cba, ... (AUD, ASX session 10:00–16:00 AEST)
 *
 * Constraints (by design):
 * - Quotes are delayed up to ~15–20 min. Equity symbols are excluded from the
 *   micro-scalper and only traded by swing-style strategies.
 * - A symbol only produces ticks while its home market's regular session is
 *   live, detected by quote freshness — which also handles market holidays
 *   in both countries without any hardcoded calendar.
 * - Yahoo returns no order book; a synthetic spread of ±0.03% around the
 *   last price is applied so round-trip cost modelling stays conservative.
 * - Currency note: Nasdaq prices are USD, ASX and crypto are AUD. Each paper
 *   position's P&L is internally consistent, but cross-market totals mix
 *   currencies and should be read directionally, not as one portfolio number.
 */
import type { Tick } from './paperEngine';

export interface EquityMarket {
  prefix: string;        // key prefix, e.g. 'nq:'
  label: string;         // human-readable market name
  yahooSuffix: string;   // appended to symbol for Yahoo lookups
  currency: 'USD' | 'AUD';
  symbols: readonly string[];
}

export const EQUITY_MARKETS: readonly EquityMarket[] = [
  {
    prefix: 'nq:',
    label: 'Nasdaq',
    yahooSuffix: '',
    currency: 'USD',
    // July 2026 research report — Tier A/B names (research/watchlist.json + report §9.1)
    symbols: ['CEG', 'ISRG', 'MU', 'SYM', 'NVDA', 'AMD'],
  },
  {
    prefix: 'asx:',
    label: 'ASX',
    yahooSuffix: '.AX',
    currency: 'AUD',
    // Liquidity-selected blue chips, NOT research-report-backed — replace as research develops
    symbols: ['BHP', 'CBA', 'CSL', 'WES', 'MQG', 'WDS'],
  },
] as const;

export const isEquity = (coin: string) => EQUITY_MARKETS.some((m) => coin.startsWith(m.prefix));
export const equityMarketOf = (coin: string): EquityMarket | null =>
  EQUITY_MARKETS.find((m) => coin.startsWith(m.prefix)) ?? null;

const SYNTHETIC_HALF_SPREAD = 0.0003; // ±0.03% => ~0.06% spread
const MAX_QUOTE_AGE_SECONDS = 20 * 60; // stale quote => that market is closed

interface ChartMeta {
  regularMarketPrice?: number;
  regularMarketTime?: number;
  marketState?: string;
}

async function fetchOne(yahooSymbol: string): Promise<Tick | null> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1m&range=1d`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (paper-trading research; simulated only)' } },
    );
    if (!res.ok) return null;
    const json = await res.json() as { chart?: { result?: Array<{ meta?: ChartMeta }> } };
    const meta = json.chart?.result?.[0]?.meta;
    const price = Number(meta?.regularMarketPrice);
    const qt = Number(meta?.regularMarketTime);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(qt)) return null;
    const now = Math.floor(Date.now() / 1000);
    // Freshness gate doubles as a per-market hours + holiday gate: outside the
    // regular session regularMarketTime stops advancing.
    if (now - qt > MAX_QUOTE_AGE_SECONDS) return null;
    if (meta?.marketState && meta.marketState !== 'REGULAR') return null;
    return {
      t: now,
      bid: price * (1 - SYNTHETIC_HALF_SPREAD),
      ask: price * (1 + SYNTHETIC_HALF_SPREAD),
    };
  } catch { return null; }
}

/** Returns ticks keyed as `<prefix><lowercase symbol>` for every symbol whose home market has a live regular-session quote. */
export async function fetchEquityTicks(): Promise<Record<string, Tick>> {
  const jobs: Array<Promise<readonly [string, Tick | null]>> = [];
  for (const m of EQUITY_MARKETS) {
    for (const s of m.symbols) {
      jobs.push(fetchOne(`${s}${m.yahooSuffix}`).then((tick) => [`${m.prefix}${s.toLowerCase()}`, tick] as const));
    }
  }
  const out: Record<string, Tick> = {};
  for (const [key, tick] of await Promise.all(jobs)) {
    if (tick) out[key] = tick;
  }
  return out;
}

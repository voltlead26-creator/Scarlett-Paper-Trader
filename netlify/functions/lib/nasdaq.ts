/**
 * Nasdaq equity price adapter — Yahoo Finance chart endpoint, no API key.
 * Simulated money only; nothing here can place a real trade.
 *
 * Constraints (by design):
 * - Quotes are delayed up to ~15 min. Equity symbols are therefore excluded
 *   from the micro-scalper and only traded by swing-style strategies.
 * - Symbols only produce ticks while the US regular session is live
 *   (detected by quote freshness, which also handles market holidays).
 * - Yahoo returns no order book; a synthetic spread of ±0.03% around the
 *   last price is applied so round-trip cost modelling stays conservative.
 */
import type { Tick } from './paperEngine';

export const EQUITY_PREFIX = 'nq:';
export const isEquity = (coin: string) => coin.startsWith(EQUITY_PREFIX);

/** July 2026 research report — Tier A/B Nasdaq names (see research/watchlist.json + report §9.1). */
export const EQUITY_SYMBOLS = ['CEG', 'ISRG', 'MU', 'SYM', 'NVDA', 'AMD'] as const;

const SYNTHETIC_HALF_SPREAD = 0.0003; // ±0.03% => ~0.06% spread, worse than typical live spreads on these names
const MAX_QUOTE_AGE_SECONDS = 10 * 60; // stale quote => treat market as closed for that symbol

interface ChartMeta {
  regularMarketPrice?: number;
  regularMarketTime?: number;
  marketState?: string;
}

async function fetchOne(symbol: string): Promise<Tick | null> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (paper-trading research; simulated only)' } },
    );
    if (!res.ok) return null;
    const json = await res.json() as { chart?: { result?: Array<{ meta?: ChartMeta }> } };
    const meta = json.chart?.result?.[0]?.meta;
    const price = Number(meta?.regularMarketPrice);
    const qt = Number(meta?.regularMarketTime);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(qt)) return null;
    const now = Math.floor(Date.now() / 1000);
    // Freshness gate doubles as a market-hours + holiday gate: outside the
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

/** Returns ticks keyed as `nq:<lowercase symbol>` for every symbol with a live regular-session quote. */
export async function fetchEquityTicks(): Promise<Record<string, Tick>> {
  const out: Record<string, Tick> = {};
  const results = await Promise.all(EQUITY_SYMBOLS.map(async (s) => [s, await fetchOne(s)] as const));
  for (const [s, tick] of results) {
    if (tick) out[`${EQUITY_PREFIX}${s.toLowerCase()}`] = tick;
  }
  return out;
}

/**
 * Scarlett Paper Trader — Cloudflare Worker Collector
 *
 * Runs on a 1-minute cron trigger (free tier).
 * Fetches prices from CoinSpot + enriched market data from CoinGecko.
 * Computes composite signals including volume, momentum, ATH distance,
 * 7-day trend, Fear & Greed sentiment, and trending status.
 * Stores everything in Cloudflare KV and triggers the Netlify paper engine.
 *
 * NO exchange credentials. NO real trades. Simulated money only.
 */

export interface Env {
  PAPER_KV: KVNamespace;
  NETLIFY_TICK_URL: string;
}

const COINSPOT_TO_GECKO: Record<string, string> = {
  btc: 'bitcoin', eth: 'ethereum', sol: 'solana', xrp: 'ripple',
  doge: 'dogecoin', ada: 'cardano', ltc: 'litecoin', trx: 'tron',
  eos: 'eos', powr: 'power-ledger',
};
const COINS    = Object.keys(COINSPOT_TO_GECKO);
const GECKO_IDS = Object.values(COINSPOT_TO_GECKO).join(',');

interface CoinspotPrice { bid: number; ask: number }
interface GeckoMarket {
  id: string; symbol: string;
  current_price: number; total_volume: number; market_cap: number;
  price_change_percentage_1h_in_currency: number | null;
  price_change_percentage_24h_in_currency: number | null;
  price_change_percentage_7d_in_currency: number | null;
  ath_change_percentage: number | null;
  sparkline_in_7d: { price: number[] };
}
interface MarketContext { fearGreed: number | null; trendingSymbols: string[] }
export interface EnrichedTick {
  t: number;
  coinspot: Record<string, CoinspotPrice>;
  gecko: Record<string, GeckoMarket>;
  market: MarketContext;
}

async function fetchCoinspot(): Promise<Record<string, CoinspotPrice> | null> {
  try {
    const r = await fetch('https://www.coinspot.com.au/pubapi/v2/latest', {
      cf: { cacheTtl: 30, cacheEverything: false },
    });
    if (!r.ok) return null;
    const j = await r.json<{ status: string; prices: Record<string, { bid: string; ask: string }> }>();
    if (j.status !== 'ok') return null;
    const out: Record<string, CoinspotPrice> = {};
    for (const c of COINS) {
      const p = j.prices[c];
      if (p) out[c] = { bid: Number(p.bid), ask: Number(p.ask) };
    }
    return Object.keys(out).length >= 2 ? out : null;
  } catch { return null; }
}

async function fetchGeckoMarkets(): Promise<Record<string, GeckoMarket> | null> {
  try {
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=aud&ids=${GECKO_IDS}&order=market_cap_desc&sparkline=true&price_change_percentage=1h,24h,7d&per_page=20`;
    const r   = await fetch(url, {
      headers: { 'User-Agent': 'ScarlettPaperTrader/4.0' },
      cf: { cacheTtl: 55 },
    });
    if (!r.ok) return null;
    const markets = await r.json<GeckoMarket[]>();
    const out: Record<string, GeckoMarket> = {};
    for (const m of markets) {
      const cs = Object.entries(COINSPOT_TO_GECKO).find(([, g]) => g === m.id);
      if (cs) out[cs[0]] = m;
    }
    return out;
  } catch { return null; }
}

async function fetchMarketContext(): Promise<MarketContext> {
  const ctx: MarketContext = { fearGreed: null, trendingSymbols: [] };
  try {
    const [fgRes, trendRes] = await Promise.allSettled([
      fetch('https://api.alternative.me/fng/?limit=1'),
      fetch('https://api.coingecko.com/api/v3/search/trending', {
        headers: { 'User-Agent': 'ScarlettPaperTrader/4.0' },
        cf: { cacheTtl: 300 },
      }),
    ]);
    if (fgRes.status === 'fulfilled' && fgRes.value.ok) {
      const fg = await fgRes.value.json<{ data: { value: string }[] }>();
      ctx.fearGreed = Number(fg.data[0]?.value ?? null);
    }
    if (trendRes.status === 'fulfilled' && trendRes.value.ok) {
      const tr = await trendRes.value.json<{ coins: { item: { symbol: string } }[] }>();
      ctx.trendingSymbols = tr.coins.map((c) => c.item.symbol.toLowerCase());
    }
  } catch { /* non-fatal */ }
  return ctx;
}

function linearSlope(ys: number[]): number {
  if (ys.length < 2) return 0;
  const n = ys.length, mx = (n - 1) / 2;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  const num = ys.reduce((s, y, i) => s + (i - mx) * (y - my), 0);
  const den = ys.reduce((s, _, i) => s + (i - mx) ** 2, 0);
  const slope = den === 0 ? 0 : num / den;
  return slope / (Math.abs(my) || 1);
}

function rsi(prices: number[], period = 14): number | null {
  if (prices.length < period + 1) return null;
  const changes = prices.slice(-period - 1).map((p, i, a) => i === 0 ? 0 : p - a[i - 1]).slice(1);
  let gains = 0, losses = 0;
  for (const d of changes) { if (d > 0) gains += d; else losses -= d; }
  if (losses === 0) return 100;
  return 100 - 100 / (1 + gains / losses);
}

function detectScalperPattern(spark: number[]): string | null {
  if (spark.length < 15) return null;
  const last6 = spark.slice(-6);
  let consec = 0;
  for (let i = 1; i < last6.length; i++) if (last6[i] > last6[i - 1]) consec++; else consec = 0;
  if (consec >= 3) return 'burst ×3 consecutive up';
  if (spark.length >= 3) {
    const [pprev, prev, curr] = spark.slice(-3);
    const drop = (pprev - prev) / pprev;
    if (drop > 0.004 && curr > prev) return `drop-fade after ${(drop * 100).toFixed(2)}% fall`;
  }
  const r = rsi(spark);
  if (r !== null && r < 30 && spark[spark.length - 1] > spark[spark.length - 2]) return `RSI oversold ${r.toFixed(1)}`;
  return null;
}

interface CoinSignal {
  coin: string; score: number;
  momentum1h: number; momentum24h: number; momentum7d: number;
  volumeScore: number; athDistancePct: number; trendScore: number;
  isTrending: boolean; fearGreed: number | null;
  scalperSignal: string | null; sparkline: number[];
}

function computeSignals(
  coinspotPrices: Record<string, CoinspotPrice>,
  geckoMarkets: Record<string, GeckoMarket>,
  ctx: MarketContext
): CoinSignal[] {
  const volumes  = Object.values(geckoMarkets).map((m) => m.total_volume).filter(Boolean);
  const medVol   = volumes.length ? volumes.sort((a, b) => a - b)[Math.floor(volumes.length / 2)] : 1;
  const fgFactor = ctx.fearGreed == null ? 0
    : ctx.fearGreed < 30 ? 0.1 * (30 - ctx.fearGreed) / 30
    : ctx.fearGreed > 70 ? -0.1 * (ctx.fearGreed - 70) / 30
    : 0;

  const signals: CoinSignal[] = [];
  for (const coin of COINS) {
    const cs = coinspotPrices[coin], gm = geckoMarkets[coin];
    if (!cs || !gm) continue;
    const spark    = gm.sparkline_in_7d?.price ?? [];
    const recent12 = spark.slice(-12);
    const m1h  = (gm.price_change_percentage_1h_in_currency  ?? 0) / 100;
    const m24h = (gm.price_change_percentage_24h_in_currency ?? 0) / 100;
    const m7d  = (gm.price_change_percentage_7d_in_currency  ?? 0) / 100;
    const athDist  = Math.abs(gm.ath_change_percentage ?? 0) / 100;
    const volScore = medVol > 0 ? Math.min(gm.total_volume / medVol, 3) / 3 : 0;
    const trendSlope = linearSlope(spark.slice(-24));
    const isTrending = ctx.trendingSymbols.includes(gm.symbol.toLowerCase());
    const score =
      0.30 * m1h + 0.25 * m24h + 0.15 * m7d +
      0.12 * trendSlope + 0.08 * (volScore - 0.5) +
      0.05 * Math.min(athDist, 0.5) / 0.5 +
      0.03 * (isTrending ? 1 : 0) + fgFactor;
    signals.push({
      coin, score, momentum1h: m1h, momentum24h: m24h, momentum7d: m7d,
      volumeScore: volScore, athDistancePct: athDist * 100, trendScore: trendSlope,
      isTrending, fearGreed: ctx.fearGreed,
      scalperSignal: detectScalperPattern(recent12), sparkline: recent12,
    });
  }
  return signals.sort((a, b) => b.score - a.score);
}

const KV_LATEST   = 'scarlett:latest';
const KV_SIGNALS  = 'scarlett:signals';
const KV_HIST_PFX = 'scarlett:hist:';
const MAX_HIST    = 288;

async function appendKVHistory(kv: KVNamespace, coin: string, entry: { t: number; mid: number; vol: number }) {
  const key  = `${KV_HIST_PFX}${coin}`;
  const raw  = await kv.get(key);
  const hist: typeof entry[] = raw ? JSON.parse(raw) : [];
  hist.push(entry);
  while (hist.length > MAX_HIST) hist.shift();
  await kv.put(key, JSON.stringify(hist), { expirationTtl: 60 * 60 * 36 });
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const t = Math.floor(Date.now() / 1000);
    const [coinspot, geckoRaw, marketCtx] = await Promise.all([
      fetchCoinspot(), fetchGeckoMarkets(), fetchMarketContext(),
    ]);
    if (!coinspot || !geckoRaw) {
      console.log(`[${new Date(t * 1000).toISOString()}] data fetch failed; skipping tick`);
      return;
    }
    const signals = computeSignals(coinspot, geckoRaw, marketCtx);
    const tick: EnrichedTick = { t, coinspot, gecko: geckoRaw, market: marketCtx };
    await env.PAPER_KV.put(KV_LATEST,  JSON.stringify({ tick, signals }), { expirationTtl: 300 });
    await env.PAPER_KV.put(KV_SIGNALS, JSON.stringify(signals),          { expirationTtl: 300 });
    for (const sig of signals) {
      const cs = coinspot[sig.coin];
      if (cs) await appendKVHistory(env.PAPER_KV, sig.coin, { t, mid: (cs.bid + cs.ask) / 2, vol: geckoRaw[sig.coin]?.total_volume ?? 0 });
    }
    if (env.NETLIFY_TICK_URL) {
      try {
        await fetch(env.NETLIFY_TICK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ t, signals: signals.slice(0, 10) }),
        });
      } catch (e) { console.error('Netlify notify failed:', e); }
    }
    const top3 = signals.slice(0, 3).map((s) => `${s.coin.toUpperCase()}(${s.score.toFixed(3)})`).join(' ');
    console.log(`[${new Date(t * 1000).toISOString()}] ok | F&G=${marketCtx.fearGreed} | top: ${top3}`);
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url  = new URL(request.url);
    const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
    if (url.pathname === '/latest') {
      const raw = await env.PAPER_KV.get(KV_LATEST);
      return new Response(raw ?? JSON.stringify({ error: 'no data yet' }), { status: raw ? 200 : 404, headers: cors });
    }
    if (url.pathname === '/signals') {
      const raw = await env.PAPER_KV.get(KV_SIGNALS);
      return new Response(raw ?? JSON.stringify({ error: 'no data yet' }), { status: raw ? 200 : 404, headers: cors });
    }
    if (url.pathname === '/history') {
      const coin = url.searchParams.get('coin') ?? 'btc';
      const raw  = await env.PAPER_KV.get(`${KV_HIST_PFX}${coin}`);
      return new Response(raw ?? '[]', { headers: cors });
    }
    return new Response(JSON.stringify({ routes: ['/latest', '/signals', '/history?coin=btc'] }), { headers: cors });
  },
};

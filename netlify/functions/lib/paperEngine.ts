/**
 * Paper Trading Engine v4 — CoinSpot public prices, simulated money only.
 * No exchange keys exist anywhere in this system. Nothing here can place a real trade.
 *
 * v4: Accepts enriched signals from Cloudflare Worker (1-min cron with CoinGecko
 * market data, volume, trend slope, Fear & Greed, trending status).
 * Falls back to internal signal computation when Cloudflare signals are absent.
 * All 10 CoinSpot coins traded based on composite multi-variable scores.
 */
import { getStore } from '@netlify/blobs';

export const COINS = ['btc','eth','sol','xrp','doge','ada','ltc','trx','eos','powr'] as const;
export type Coin = (typeof COINS)[number];
export type Ticks = Partial<Record<Coin, Tick>>;

const FEE           = 0.001;
export const START_CASH = 10000;
const TICKS_PER_DAY = 288;
const RECENT_CAP    = TICKS_PER_DAY * 8;
const TRADES_CAP    = 600;
const EQUITY_CAP    = 2400;
const DUST          = 5;
const STATE_VERSION = 4;

const SC_ALLOC    = 80;
const SC_TARGET   = 0.008;
const SC_STOP     = 0.005;
const SC_MAX_HOLD = 12;
const SC_MAX_OPEN = 5;

export interface Tick    { t: number; bid: number; ask: number }
export interface Trade   { t: number; strategy: string; coin: Coin; side: 'buy'|'sell'; units: number; price: number; fee: number; cashAfter: number; reason: string }
export interface Position { units: number; entry: number; entryTick?: number }
export interface StratState {
  cash: number; startCash: number;
  positions: Partial<Record<Coin, Position>>;
  trades: Trade[]; equity: [number,number][];
  realisedPnl: number; wins: number; losses: number;
}
export interface PaperState {
  version: number; startedAt: number; lastTick: number;
  tickCount: number; strategies: Record<string, StratState>;
}

export interface CoinSignal {
  coin: string; score: number;
  momentum1h: number; momentum24h: number; momentum7d: number;
  volumeScore: number; athDistancePct: number; trendScore: number;
  isTrending: boolean; fearGreed: number | null;
  scalperSignal: string | null; sparkline: number[];
}

export const STRATEGY_IDS = ['hold','dca','sma','momentum','meanrev','scalper'] as const;

export const STRATEGY_META: Record<string, { name: string; blurb: string }> = {
  hold:     { name: 'Buy & Hold',     blurb: 'Benchmark. 50/50 BTC/ETH at first tick, never trades again.' },
  dca:      { name: 'Daily DCA',      blurb: 'Long book. Daily buy into top-ranked coins by composite score.' },
  sma:      { name: 'SMA Crossover',  blurb: 'Day book. 1-hour vs 6-hour moving average crossover on all coins.' },
  momentum: { name: 'Momentum',       blurb: 'Day book. Buys top composite-score coins; exits on score reversal or 3% stop.' },
  meanrev:  { name: 'Mean Reversion', blurb: 'Day book. Buys coins with strong negative 7d momentum for reversion; exits at +2% or 5% stop.' },
  scalper:  { name: 'Scalper',        blurb: `Micro day-trading on 1-min data. Three pattern triggers: momentum burst, candle-drop fade, RSI oversold. $${SC_ALLOC} AUD per trade, exits at ${SC_TARGET*100}% profit, ${SC_STOP*100}% stop, or ${SC_MAX_HOLD} ticks.` },
};

const store  = () => getStore('paper-trading');
const dayKey = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const mid    = (k: Tick)   => (k.bid + k.ask) / 2;

export async function fetchPrices(): Promise<Ticks | null> {
  try {
    const res  = await fetch('https://www.coinspot.com.au/pubapi/v2/latest');
    if (!res.ok) return null;
    const json = await res.json() as { status: string; prices: Record<string, { bid: string; ask: string }> };
    if (json.status !== 'ok') return null;
    const t = Math.floor(Date.now() / 1000);
    const out: Ticks = {};
    const s = store();
    for (const c of COINS) {
      const p   = json.prices[c];
      const bid = p ? Number(p.bid) : NaN;
      const ask = p ? Number(p.ask) : NaN;
      if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
        out[c] = { t, bid, ask };
      } else {
        const recent = await s.get(`recent:${c}`, { type: 'json' }) as Tick[] | null;
        if (recent?.length) out[c] = { ...recent[recent.length - 1], t };
      }
    }
    if (!out.btc || !out.eth) return null;
    return out;
  } catch { return null; }
}

function freshStrat(cash: number): StratState {
  return { cash, startCash: cash, positions: {}, trades: [], equity: [], realisedPnl: 0, wins: 0, losses: 0 };
}

export function freshState(now: number): PaperState {
  const strategies: Record<string, StratState> = {};
  strategies.hold     = freshStrat(START_CASH * 0.15);
  strategies.dca      = freshStrat(START_CASH * 0.15);
  strategies.sma      = freshStrat(START_CASH * 0.10);
  strategies.momentum = freshStrat(START_CASH * 0.10);
  strategies.meanrev  = freshStrat(START_CASH * 0.10);
  strategies.scalper  = freshStrat(START_CASH * 0.40);
  return { version: STATE_VERSION, startedAt: now, lastTick: 0, tickCount: 0, strategies };
}

export async function loadState(): Promise<PaperState | null> {
  const s = await store().get('state', { type: 'json' }) as PaperState | null;
  if (s && s.version !== STATE_VERSION) return null;
  return s;
}
export async function saveState(s: PaperState)  { await store().setJSON('state', s); }
export async function loadRecent(coin: Coin): Promise<Tick[]> {
  return (await store().get(`recent:${coin}`, { type: 'json' }) as Tick[] | null) ?? [];
}
export async function loadDay(coin: Coin, day: string): Promise<Tick[]> {
  return (await store().get(`hist:${coin}:${day}`, { type: 'json' }) as Tick[] | null) ?? [];
}

async function appendHistory(coin: Coin, tick: Tick, recent: Tick[]) {
  const s = store();
  recent.push(tick);
  while (recent.length > RECENT_CAP) recent.shift();
  await s.setJSON(`recent:${coin}`, recent);
  const dk  = dayKey(tick.t);
  const day = (await s.get(`hist:${coin}:${dk}`, { type: 'json' }) as Tick[] | null) ?? [];
  day.push(tick);
  await s.setJSON(`hist:${coin}:${dk}`, day);
}

function buy(st: StratState, id: string, coin: Coin, tick: Tick, cashToSpend: number, reason: string, entryTick?: number) {
  const spend = Math.min(cashToSpend, st.cash);
  if (spend < DUST) return;
  const fee   = spend * FEE;
  const units = (spend - fee) / tick.ask;
  st.cash -= spend;
  const pos = st.positions[coin];
  if (pos) {
    pos.entry = (pos.entry * pos.units + tick.ask * units) / (pos.units + units);
    pos.units += units;
  } else {
    st.positions[coin] = { units, entry: tick.ask, entryTick };
  }
  st.trades.push({ t: tick.t, strategy: id, coin, side: 'buy', units, price: tick.ask, fee, cashAfter: st.cash, reason });
  while (st.trades.length > TRADES_CAP) st.trades.shift();
}

function sellAll(st: StratState, id: string, coin: Coin, tick: Tick, reason: string) {
  const pos = st.positions[coin];
  if (!pos || pos.units <= 0) return;
  const gross = pos.units * tick.bid;
  const fee   = gross * FEE;
  const net   = gross - fee;
  const pnl   = net - pos.units * pos.entry;
  st.cash += net;
  st.realisedPnl += pnl;
  if (pnl >= 0) st.wins += 1; else st.losses += 1;
  st.trades.push({ t: tick.t, strategy: id, coin, side: 'sell', units: pos.units, price: tick.bid, fee, cashAfter: st.cash, reason });
  while (st.trades.length > TRADES_CAP) st.trades.shift();
  delete st.positions[coin];
}

function equityOf(st: StratState, ticks: Ticks): number {
  let eq = st.cash;
  for (const c of COINS) {
    const pos = st.positions[c];
    if (pos) eq += pos.units * (ticks[c]?.bid ?? pos.entry);
  }
  return eq;
}

const smaOf = (xs: number[], n: number): number | null => {
  if (xs.length < n) return null;
  let s = 0;
  for (let i = xs.length - n; i < xs.length; i++) s += xs[i];
  return s / n;
};

function internalSignal(coin: Coin, recents: Record<Coin, Tick[]>, ticks: Ticks): CoinSignal | null {
  if (!ticks[coin]) return null;
  const xs   = recents[coin].map(mid);
  const curr = xs[xs.length - 1] ?? 0;

  let momentum24h = 0;
  if (xs.length >= TICKS_PER_DAY + 1) momentum24h = curr / xs[xs.length - 1 - TICKS_PER_DAY] - 1;
  let momentum1h  = 0;
  if (xs.length >= 13) momentum1h = curr / xs[xs.length - 13] - 1;

  const fast = smaOf(xs, 12), slow = smaOf(xs, 72);
  const fp   = xs.length > 1 ? smaOf(xs.slice(0,-1), 12) : null;
  const sp   = xs.length > 1 ? smaOf(xs.slice(0,-1), 72) : null;
  let smaSignal = 0;
  if (fast != null && slow != null && fp != null && sp != null) {
    if (fp <= sp && fast > slow)  smaSignal =  1;
    if (fp >= sp && fast < slow)  smaSignal = -1;
  }

  let zscore: number | null = null;
  if (xs.length >= TICKS_PER_DAY) {
    const win  = xs.slice(-TICKS_PER_DAY);
    const mean = win.reduce((a, b) => a + b, 0) / win.length;
    const sd   = Math.sqrt(win.reduce((a, b) => a + (b - mean) ** 2, 0) / win.length);
    if (sd > 0) zscore = (curr - mean) / sd;
  }

  const last6 = xs.slice(-6);
  let consec = 0, scalperSig: string | null = null;
  for (let i = 1; i < last6.length; i++) if (last6[i] > last6[i-1]) consec++; else consec = 0;
  if (consec >= 3) scalperSig = 'burst ×3 consecutive up';

  const score = 0.35 * momentum1h + 0.30 * momentum24h + 0.20 * smaSignal + 0.15 * (zscore == null ? 0 : -Math.min(Math.max(zscore, -3), 3) / 3);

  return { coin, score, momentum1h, momentum24h, momentum7d: 0, volumeScore: 0.5, athDistancePct: 0, trendScore: 0, isTrending: false, fearGreed: null, scalperSignal: scalperSig, sparkline: xs.slice(-12) };
}

function runStrategies(state: PaperState, ticks: Ticks, recents: Record<Coin, Tick[]>, externalSignals: CoinSignal[] | null) {
  const S         = state.strategies;
  const available = COINS.filter((c) => ticks[c]);

  const sigMap: Record<string, CoinSignal> = {};
  if (externalSignals?.length) for (const s of externalSignals) sigMap[s.coin] = s;
  for (const c of available) {
    if (!sigMap[c]) { const s = internalSignal(c, recents, ticks); if (s) sigMap[c] = s; }
  }

  const ranked = available.filter((c) => sigMap[c]).sort((a, b) => (sigMap[b]?.score ?? 0) - (sigMap[a]?.score ?? 0));

  const hold = S.hold;
  if (hold.trades.length === 0 && ticks.btc && ticks.eth) {
    buy(hold, 'hold', 'btc', ticks.btc, hold.cash / 2, 'benchmark initial 50%');
    buy(hold, 'hold', 'eth', ticks.eth, hold.cash,     'benchmark initial 50%');
  }

  const dca = S.dca;
  if (state.tickCount % TICKS_PER_DAY === 0 && dca.cash > DUST) {
    const daily   = Math.min(30, dca.cash);
    const targets = ranked.slice(0, 3).filter((c) => (sigMap[c]?.score ?? 0) > 0);
    const buys    = targets.length ? targets : (['btc','eth'] as Coin[]).filter((c) => ticks[c]);
    for (const c of buys)
      buy(dca, 'dca', c, ticks[c]!, daily / buys.length,
          `DCA top-ranked ${c.toUpperCase()} score=${(sigMap[c]?.score ?? 0).toFixed(3)}`);
  }

  const smaSt = S.sma;
  for (const c of available) {
    const xs = recents[c].map(mid);
    const fast = smaOf(xs, 12), slow = smaOf(xs, 72);
    const fp   = xs.length > 1 ? smaOf(xs.slice(0,-1), 12) : null;
    const sp   = xs.length > 1 ? smaOf(xs.slice(0,-1), 72) : null;
    if (fast == null || slow == null || fp == null || sp == null) continue;
    const inPos = Boolean(smaSt.positions[c]);
    const nOpen = Object.keys(smaSt.positions).length;
    if (!inPos && fp <= sp && fast > slow && nOpen < 4)
      buy(smaSt, 'sma', c, ticks[c]!, smaSt.cash / Math.max(1, 4 - nOpen), `golden cross ${c.toUpperCase()}`);
    else if (inPos && fp >= sp && fast < slow)
      sellAll(smaSt, 'sma', c, ticks[c]!, `death cross ${c.toUpperCase()}`);
  }

  const mom    = S.momentum;
  const topMom = new Set(ranked.slice(0, 3));
  for (const c of available) {
    const pos = mom.positions[c], sig = sigMap[c];
    const nOpen = Object.keys(mom.positions).length;
    if (!pos && topMom.has(c) && (sig?.score ?? 0) > 0.01 && nOpen < 3)
      buy(mom, 'momentum', c, ticks[c]!, mom.cash / Math.max(1, 3 - nOpen),
          `top-3 score=${(sig?.score ?? 0).toFixed(3)} m1h=${((sig?.momentum1h ?? 0)*100).toFixed(2)}%`);
    else if (pos) {
      const dd = ticks[c]!.bid / pos.entry - 1;
      if ((sig?.score ?? 0) < -0.02) sellAll(mom, 'momentum', c, ticks[c]!, `score negative ${(sig?.score ?? 0).toFixed(3)}`);
      else if (dd < -0.03) sellAll(mom, 'momentum', c, ticks[c]!, 'stop loss -3%');
    }
  }

  const mr      = S.meanrev;
  const bottom3 = ranked.slice(-3).filter((c) => (sigMap[c]?.momentum7d ?? 0) < -0.05);
  for (const c of available) {
    const pos = mr.positions[c], sig = sigMap[c];
    const nOpen = Object.keys(mr.positions).length;
    if (!pos && bottom3.includes(c) && nOpen < 3)
      buy(mr, 'meanrev', c, ticks[c]!, mr.cash / Math.max(1, 3 - nOpen),
          `mean-rev 7d=${((sig?.momentum7d ?? 0)*100).toFixed(1)}% oversold`);
    else if (pos) {
      const dd = ticks[c]!.bid / pos.entry - 1;
      if (dd > 0.02)       sellAll(mr, 'meanrev', c, ticks[c]!, 'reversion +2% hit');
      else if (dd < -0.05) sellAll(mr, 'meanrev', c, ticks[c]!, 'stop -5%');
    }
  }

  const sc = S.scalper;
  for (const c of available) {
    const pos = sc.positions[c];
    if (!pos) continue;
    const tick = ticks[c]!, pnlPct = tick.bid / pos.entry - 1;
    const age  = state.tickCount - (pos.entryTick ?? state.tickCount);
    const gp   = pos.units * (tick.bid - pos.entry);
    if (pnlPct >= SC_TARGET)    sellAll(sc, 'scalper', c, tick, `target +${(pnlPct*100).toFixed(2)}% ≈ $${gp.toFixed(2)}`);
    else if (pnlPct <= -SC_STOP) sellAll(sc, 'scalper', c, tick, `stop −${(Math.abs(pnlPct)*100).toFixed(2)}% ≈ $${gp.toFixed(2)}`);
    else if (age >= SC_MAX_HOLD) sellAll(sc, 'scalper', c, tick, `time exit ${age}t (${(pnlPct*100).toFixed(2)}% ≈ $${gp.toFixed(2)})`);
  }
  if (Object.keys(sc.positions).length < SC_MAX_OPEN && sc.cash >= SC_ALLOC) {
    for (const c of available) {
      if (sc.positions[c] || Object.keys(sc.positions).length >= SC_MAX_OPEN || sc.cash < SC_ALLOC) continue;
      const sig = sigMap[c]?.scalperSignal;
      if (sig) buy(sc, 'scalper', c, ticks[c]!, SC_ALLOC, `scalp: ${sig}`, state.tickCount);
    }
  }

  if (state.tickCount % 12 === 0) {
    const t = ticks.btc!.t;
    for (const id of STRATEGY_IDS) {
      const st = S[id]; if (!st) continue;
      st.equity.push([t, Number(equityOf(st, ticks).toFixed(2))]);
      while (st.equity.length > EQUITY_CAP) st.equity.shift();
    }
  }
}

export async function runTick(externalSignals?: CoinSignal[]): Promise<{ ok: boolean; detail: string }> {
  const ticks = await fetchPrices();
  if (!ticks?.btc) return { ok: false, detail: 'CoinSpot price fetch failed; tick skipped' };

  const now = ticks.btc.t;
  let state = await loadState();
  if (!state) state = freshState(now);
  if (state.lastTick && now - state.lastTick < 240) return { ok: false, detail: 'tick throttled (ran <4 min ago)' };

  const recents = {} as Record<Coin, Tick[]>;
  for (const c of COINS) recents[c] = await loadRecent(c);
  for (const c of COINS) { const tk = ticks[c]; if (tk) await appendHistory(c, tk, recents[c]); }

  runStrategies(state, ticks, recents, externalSignals ?? null);
  state.lastTick  = now;
  state.tickCount += 1;
  await saveState(state);
  return { ok: true, detail: `tick ${state.tickCount} @ ${new Date(now * 1000).toISOString()} [${externalSignals?.length ? 'CF-enriched' : 'internal'}]` };
}

export async function currentSignals(ticks: Ticks): Promise<CoinSignal[]> {
  const recents = {} as Record<Coin, Tick[]>;
  for (const c of COINS) recents[c] = await loadRecent(c);
  return COINS.filter((c) => ticks[c]).map((c) => internalSignal(c, recents, ticks)).filter(Boolean) as CoinSignal[];
}

export function summarise(state: PaperState, ticks: Ticks) {
  const out: Record<string, unknown> = {};
  for (const id of STRATEGY_IDS) {
    const st = state.strategies[id]; if (!st) continue;
    const eq = equityOf(st, ticks);
    out[id] = {
      ...STRATEGY_META[id],
      cash: Number(st.cash.toFixed(2)), startCash: Number(st.startCash.toFixed(2)),
      equity: Number(eq.toFixed(2)),
      returnPct: Number(((eq / st.startCash - 1) * 100).toFixed(2)),
      realisedPnl: Number(st.realisedPnl.toFixed(2)),
      wins: st.wins, losses: st.losses,
      openPositions: Object.fromEntries(
        Object.entries(st.positions).map(([c, p]) =>
          [c, { units: p!.units, entry: p!.entry, markToBid: ticks[c as Coin]?.bid ?? p!.entry, entryTick: p!.entryTick }])
      ),
      trades: st.trades.slice(-50).reverse(),
      equityHistory: st.equity,
    };
  }
  return out;
}

// Paper Trading Engine v2 — CoinSpot public prices, simulated money only.
// No exchange keys exist anywhere in this system. Nothing here can place a real trade.
//
// v2 fixes: coin list matches what CoinSpot's public API actually serves; missing
// coins no longer abort the tick; per-strategy startCash restores honest returns;
// `hold` restored as an untouched benchmark; day strategies trade distinct signals
// again (entries on transitions, not every tick); signals exposed for the dashboard.
import { getStore } from '@netlify/blobs';

export const COINS = ['btc', 'eth', 'sol', 'xrp', 'doge', 'ada', 'ltc', 'trx', 'eos', 'powr'] as const;
export type Coin = (typeof COINS)[number];
export type Ticks = Partial<Record<Coin, Tick>>;

const FEE = 0.001; // CoinSpot market order fee, 0.1% per side
export const START_CASH = 10000; // virtual AUD total across all strategies
const TICKS_PER_DAY = 288; // 5-minute cadence
const RECENT_CAP = TICKS_PER_DAY * 8;
const TRADES_CAP = 400;
const EQUITY_CAP = 2400; // hourly snapshots ≈ 100 days
const DUST = 5;
const STATE_VERSION = 2;

export interface Tick { t: number; bid: number; ask: number }
export interface Trade {
  t: number; strategy: string; coin: Coin; side: 'buy' | 'sell';
  units: number; price: number; fee: number; cashAfter: number; reason: string;
}
export interface Position { units: number; entry: number }
export interface StratState {
  cash: number;
  startCash: number;
  positions: Partial<Record<Coin, Position>>;
  trades: Trade[];
  equity: [number, number][];
  realisedPnl: number;
  wins: number;
  losses: number;
}
export interface PaperState {
  version: number;
  startedAt: number;
  lastTick: number;
  tickCount: number;
  strategies: Record<string, StratState>;
}

export const STRATEGY_IDS = ['hold', 'dca', 'sma', 'momentum', 'meanrev'] as const;

export const STRATEGY_META: Record<string, { name: string; blurb: string }> = {
  hold: { name: 'Buy & Hold', blurb: 'Benchmark. 50/50 BTC/ETH at first tick, never trades again. Every other strategy must beat this to justify existing.' },
  dca: { name: 'Daily DCA', blurb: 'Long book. Buys a small amount daily, tilted toward coins with positive 24h momentum; falls back to BTC/ETH when nothing qualifies.' },
  sma: { name: 'SMA Crossover', blurb: 'Day book. 1-hour vs 6-hour moving average per coin; enters on golden cross, exits on death cross.' },
  momentum: { name: 'Momentum', blurb: 'Day book. Buys strong 24h movers, exits when momentum turns negative or a 3% stop hits.' },
  meanrev: { name: 'Mean Reversion', blurb: 'Day book. Buys 2+ standard deviations below the 24h mean, exits on reversion or a 5% stop.' },
};

const store = () => getStore('paper-trading');
const dayKey = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const mid = (k: Tick) => (k.bid + k.ask) / 2;

// Returns whatever coins are available this tick; falls back to the most recent
// stored tick for coins momentarily missing. Requires BTC and ETH (fresh or stored)
// or the tick is skipped. Never aborts because a minor coin is absent.
export async function fetchPrices(): Promise<Ticks | null> {
  try {
    const res = await fetch('https://www.coinspot.com.au/pubapi/v2/latest');
    if (!res.ok) return null;
    const json = (await res.json()) as { status: string; prices: Record<string, { bid: string; ask: string }> };
    if (json.status !== 'ok') return null;
    const t = Math.floor(Date.now() / 1000);
    const out: Ticks = {};
    const s = store();
    for (const c of COINS) {
      const p = json.prices[c];
      const bid = p ? Number(p.bid) : NaN;
      const ask = p ? Number(p.ask) : NaN;
      if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
        out[c] = { t, bid, ask };
      } else {
        const recent = (await s.get(`recent:${c}`, { type: 'json' })) as Tick[] | null;
        if (recent && recent.length) out[c] = { ...recent[recent.length - 1], t };
        // else: coin simply unavailable this tick — strategies skip it
      }
    }
    if (!out.btc || !out.eth) return null;
    return out;
  } catch {
    return null;
  }
}

function freshStrat(cash: number): StratState {
  return { cash, startCash: cash, positions: {}, trades: [], equity: [], realisedPnl: 0, wins: 0, losses: 0 };
}

export function freshState(now: number): PaperState {
  const strategies: Record<string, StratState> = {};
  // 50/50 split between the day-trading book and the long-hold book
  const dayIds = ['sma', 'momentum', 'meanrev'];
  const longIds = ['hold', 'dca'];
  for (const id of dayIds) strategies[id] = freshStrat((START_CASH * 0.5) / dayIds.length);
  for (const id of longIds) strategies[id] = freshStrat((START_CASH * 0.5) / longIds.length);
  return { version: STATE_VERSION, startedAt: now, lastTick: 0, tickCount: 0, strategies };
}

export async function loadState(): Promise<PaperState | null> {
  const s = (await store().get('state', { type: 'json' })) as PaperState | null;
  if (s && s.version !== STATE_VERSION) return null; // pre-v2 state was never validly populated
  return s;
}
export async function saveState(s: PaperState) {
  await store().setJSON('state', s);
}
export async function loadRecent(coin: Coin): Promise<Tick[]> {
  return ((await store().get(`recent:${coin}`, { type: 'json' })) as Tick[] | null) ?? [];
}
export async function loadDay(coin: Coin, day: string): Promise<Tick[]> {
  return ((await store().get(`hist:${coin}:${day}`, { type: 'json' })) as Tick[] | null) ?? [];
}

async function appendHistory(coin: Coin, tick: Tick, recent: Tick[]) {
  const s = store();
  recent.push(tick);
  while (recent.length > RECENT_CAP) recent.shift();
  await s.setJSON(`recent:${coin}`, recent);
  const dk = dayKey(tick.t);
  const day = ((await s.get(`hist:${coin}:${dk}`, { type: 'json' })) as Tick[] | null) ?? [];
  day.push(tick);
  await s.setJSON(`hist:${coin}:${dk}`, day);
}

function buy(st: StratState, id: string, coin: Coin, tick: Tick, cashToSpend: number, reason: string) {
  const spend = Math.min(cashToSpend, st.cash);
  if (spend < DUST) return;
  const fee = spend * FEE;
  const units = (spend - fee) / tick.ask;
  st.cash -= spend;
  const pos = st.positions[coin];
  if (pos) {
    pos.entry = (pos.entry * pos.units + tick.ask * units) / (pos.units + units);
    pos.units += units;
  } else {
    st.positions[coin] = { units, entry: tick.ask };
  }
  st.trades.push({ t: tick.t, strategy: id, coin, side: 'buy', units, price: tick.ask, fee, cashAfter: st.cash, reason });
  while (st.trades.length > TRADES_CAP) st.trades.shift();
}

function sellAll(st: StratState, id: string, coin: Coin, tick: Tick, reason: string) {
  const pos = st.positions[coin];
  if (!pos || pos.units <= 0) return;
  const gross = pos.units * tick.bid;
  const fee = gross * FEE;
  const net = gross - fee;
  const pnl = net - pos.units * pos.entry;
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
    if (pos) eq += pos.units * (ticks[c]?.bid ?? pos.entry); // conservative mark when a coin is momentarily unpriced
  }
  return eq;
}

const smaOf = (xs: number[], n: number) => {
  if (xs.length < n) return null;
  let s = 0;
  for (let i = xs.length - n; i < xs.length; i++) s += xs[i];
  return s / n;
};

export interface Signal { coin: Coin; momentum24: number | null; smaSignal: number; zscore: number | null; score: number }

export function computeSignals(recents: Record<Coin, Tick[]>, ticks: Ticks): Record<string, Signal> {
  const scores: Record<string, Signal> = {};
  for (const c of COINS) {
    if (!ticks[c]) continue;
    const xs = recents[c] ? recents[c].map(mid) : [];
    let momentum24: number | null = null;
    if (xs.length >= TICKS_PER_DAY + 1) momentum24 = xs[xs.length - 1] / xs[xs.length - 1 - TICKS_PER_DAY] - 1;

    const fast = smaOf(xs, 12);
    const slow = smaOf(xs, 72);
    const fastPrev = xs.length > 1 ? smaOf(xs.slice(0, -1), 12) : null;
    const slowPrev = xs.length > 1 ? smaOf(xs.slice(0, -1), 72) : null;
    let smaSignal = 0;
    if (fast != null && slow != null && fastPrev != null && slowPrev != null) {
      if (fastPrev <= slowPrev && fast > slow) smaSignal = 1;
      else if (fastPrev >= slowPrev && fast < slow) smaSignal = -1;
    }

    let zscore: number | null = null;
    if (xs.length >= TICKS_PER_DAY) {
      const win = xs.slice(-TICKS_PER_DAY);
      const mean = win.reduce((a, b) => a + b, 0) / win.length;
      const sd = Math.sqrt(win.reduce((a, b) => a + (b - mean) ** 2, 0) / win.length);
      if (sd > 0) zscore = (xs[xs.length - 1] - mean) / sd;
    }

    const zComponent = zscore == null ? 0 : -Math.min(Math.max(zscore, -5), 5) / 5;
    const score = 0.5 * (momentum24 ?? 0) + 0.3 * smaSignal + 0.2 * zComponent;
    scores[c] = { coin: c, momentum24, smaSignal, zscore, score };
  }
  return scores;
}

// Each strategy trades its OWN signal component. The composite score is for the
// dashboard's signals panel; using it to drive all three day strategies would make
// them identical and the comparison meaningless.
function runStrategies(state: PaperState, ticks: Ticks, recents: Record<Coin, Tick[]>) {
  const S = state.strategies;
  const signals = computeSignals(recents, ticks);
  const available = COINS.filter((c) => ticks[c]);

  // ---- LONG BOOK ----
  // hold: pure benchmark — 50/50 BTC/ETH on first tick (liquid, tight spreads), then untouched forever
  const hold = S.hold;
  if (hold.trades.length === 0 && ticks.btc && ticks.eth) {
    buy(hold, 'hold', 'btc', ticks.btc, hold.cash / 2, 'benchmark initial 50%');
    buy(hold, 'hold', 'eth', ticks.eth, hold.cash, 'benchmark initial 50%');
  }

  // dca: daily buys tilted toward positive momentum, falling back to BTC/ETH
  const dca = S.dca;
  if (state.tickCount % TICKS_PER_DAY === 0 && dca.cash > DUST) {
    const daily = Math.min(55, dca.cash);
    const tilted = available.filter((c) => (signals[c]?.momentum24 ?? 0) > 0.01).slice(0, 3);
    const targets = tilted.length ? tilted : (['btc', 'eth'] as Coin[]).filter((c) => ticks[c]);
    for (const c of targets) buy(dca, 'dca', c, ticks[c]!, daily / targets.length, tilted.length ? 'DCA tilt: positive momentum' : 'DCA fallback BTC/ETH');
  }

  // ---- DAY BOOK ---- (entries on transitions only; max 3 concurrent positions each)
  const maxAlloc = (st: StratState) => st.cash / Math.max(1, 3 - Object.keys(st.positions).length);

  const smaSt = S.sma;
  for (const c of available) {
    const sig = signals[c];
    if (!sig) continue;
    const inPos = Boolean(smaSt.positions[c]);
    if (!inPos && sig.smaSignal === 1 && Object.keys(smaSt.positions).length < 3) {
      buy(smaSt, 'sma', c, ticks[c]!, maxAlloc(smaSt), `golden cross ${c.toUpperCase()}`);
    } else if (inPos && sig.smaSignal === -1) {
      sellAll(smaSt, 'sma', c, ticks[c]!, `death cross ${c.toUpperCase()}`);
    }
  }

  const mom = S.momentum;
  for (const c of available) {
    const m = signals[c]?.momentum24;
    if (m == null) continue;
    const pos = mom.positions[c];
    if (!pos && m > 0.015 && Object.keys(mom.positions).length < 3) {
      buy(mom, 'momentum', c, ticks[c]!, maxAlloc(mom), `24h momentum +${(m * 100).toFixed(2)}%`);
    } else if (pos) {
      const dd = ticks[c]!.bid / pos.entry - 1;
      if (m < 0) sellAll(mom, 'momentum', c, ticks[c]!, 'momentum turned negative');
      else if (dd < -0.03) sellAll(mom, 'momentum', c, ticks[c]!, 'stop loss -3%');
    }
  }

  const mr = S.meanrev;
  for (const c of available) {
    const z = signals[c]?.zscore;
    if (z == null) continue;
    const pos = mr.positions[c];
    if (!pos && z < -2 && Object.keys(mr.positions).length < 3) {
      buy(mr, 'meanrev', c, ticks[c]!, maxAlloc(mr), `z-score ${z.toFixed(2)} below mean`);
    } else if (pos) {
      const dd = ticks[c]!.bid / pos.entry - 1;
      if (z >= 0) sellAll(mr, 'meanrev', c, ticks[c]!, 'reverted to mean');
      else if (dd < -0.05) sellAll(mr, 'meanrev', c, ticks[c]!, 'stop loss -5%');
    }
  }

  if (state.tickCount % 12 === 0) {
    const t = ticks.btc!.t;
    for (const id of STRATEGY_IDS) {
      const st = S[id];
      st.equity.push([t, Number(equityOf(st, ticks).toFixed(2))]);
      while (st.equity.length > EQUITY_CAP) st.equity.shift();
    }
  }
}

export async function runTick(): Promise<{ ok: boolean; detail: string }> {
  const ticks = await fetchPrices();
  if (!ticks || !ticks.btc) return { ok: false, detail: 'CoinSpot price fetch failed (BTC/ETH unavailable); tick skipped' };

  const now = ticks.btc.t;
  let state = await loadState();
  if (!state) state = freshState(now);

  if (state.lastTick && now - state.lastTick < 240) {
    return { ok: false, detail: 'tick throttled (ran <4 min ago)' };
  }

  const recents = {} as Record<Coin, Tick[]>;
  for (const c of COINS) recents[c] = await loadRecent(c);
  for (const c of COINS) {
    const tk = ticks[c];
    if (tk) await appendHistory(c, tk, recents[c]);
  }

  runStrategies(state, ticks, recents);
  state.lastTick = now;
  state.tickCount += 1;
  await saveState(state);
  return { ok: true, detail: `tick ${state.tickCount} @ ${new Date(now * 1000).toISOString()}` };
}

export async function currentSignals(ticks: Ticks): Promise<Record<string, Signal>> {
  const recents = {} as Record<Coin, Tick[]>;
  for (const c of COINS) recents[c] = await loadRecent(c);
  return computeSignals(recents, ticks);
}

export function summarise(state: PaperState, ticks: Ticks) {
  const out: Record<string, unknown> = {};
  for (const id of STRATEGY_IDS) {
    const st = state.strategies[id];
    const eq = equityOf(st, ticks);
    out[id] = {
      ...STRATEGY_META[id],
      cash: Number(st.cash.toFixed(2)),
      startCash: Number(st.startCash.toFixed(2)),
      equity: Number(eq.toFixed(2)),
      returnPct: Number(((eq / st.startCash - 1) * 100).toFixed(2)),
      realisedPnl: Number(st.realisedPnl.toFixed(2)),
      wins: st.wins,
      losses: st.losses,
      openPositions: Object.fromEntries(
        Object.entries(st.positions).map(([c, p]) => [c, { units: p!.units, entry: p!.entry, markToBid: ticks[c as Coin]?.bid ?? p!.entry }])
      ),
      trades: st.trades.slice(-40).reverse(),
      equityHistory: st.equity,
    };
  }
  return out;
}

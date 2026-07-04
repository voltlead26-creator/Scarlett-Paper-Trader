// Paper Trading Engine — CoinSpot public prices, simulated money only.
// No exchange keys exist anywhere in this system. Nothing here can place a real trade.
import { getStore } from '@netlify/blobs';

export const COINS = ['btc', 'eth', 'sol', 'xrp', 'doge'] as const;
export type Coin = (typeof COINS)[number];

const TRADE_COINS: Coin[] = ['btc', 'eth'];
const FEE = 0.001; // CoinSpot market order fee, 0.1% per side
const START_CASH = 10000; // virtual AUD per strategy
const TICKS_PER_DAY = 288; // 5-minute cadence
const RECENT_CAP = TICKS_PER_DAY * 8;
const TRADES_CAP = 400;
const EQUITY_CAP = 2400; // hourly snapshots ≈ 100 days

export interface Tick { t: number; bid: number; ask: number }
export interface Trade {
  t: number; strategy: string; coin: Coin; side: 'buy' | 'sell';
  units: number; price: number; fee: number; cashAfter: number; reason: string;
}
export interface Position { units: number; entry: number }
export interface StratState {
  cash: number;
  positions: Partial<Record<Coin, Position>>;
  trades: Trade[];
  equity: [number, number][]; // [epochSec, liquidationValue]
  realisedPnl: number;
  wins: number;
  losses: number;
}
export interface PaperState {
  startedAt: number;
  lastTick: number;
  tickCount: number;
  strategies: Record<string, StratState>;
}

export const STRATEGY_IDS = ['hold', 'dca', 'sma', 'momentum', 'meanrev'] as const;

export const STRATEGY_META: Record<string, { name: string; blurb: string }> = {
  hold: { name: 'Buy & Hold', blurb: 'Benchmark. 50/50 BTC/ETH at first tick, never trades again. Every other strategy must beat this to justify existing.' },
  dca: { name: 'Daily DCA', blurb: 'Buys ~$110 of BTC/ETH each day regardless of price until cash runs out.' },
  sma: { name: 'SMA Crossover', blurb: '1-hour vs 6-hour moving average on BTC and ETH. Buys on golden cross, sells on death cross.' },
  momentum: { name: 'Momentum', blurb: 'Buys when 24h return exceeds +1.5%, exits when momentum turns negative or price drops 3% from entry.' },
  meanrev: { name: 'Mean Reversion', blurb: 'Buys when price is 2+ standard deviations below its 24h mean, exits at the mean or on a 5% stop.' },
};

const store = () => getStore('paper-trading');
const dayKey = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const mid = (k: Tick) => (k.bid + k.ask) / 2;

export async function fetchPrices(): Promise<Record<Coin, Tick> | null> {
  try {
    const res = await fetch('https://www.coinspot.com.au/pubapi/v2/latest');
    if (!res.ok) return null;
    const json = (await res.json()) as { status: string; prices: Record<string, { bid: string; ask: string }> };
    if (json.status !== 'ok') return null;
    const t = Math.floor(Date.now() / 1000);
    const out = {} as Record<Coin, Tick>;
    for (const c of COINS) {
      const p = json.prices[c];
      if (!p) return null;
      const bid = Number(p.bid);
      const ask = Number(p.ask);
      if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return null;
      out[c] = { t, bid, ask };
    }
    return out;
  } catch {
    return null;
  }
}

function freshStrat(): StratState {
  return { cash: START_CASH, positions: {}, trades: [], equity: [], realisedPnl: 0, wins: 0, losses: 0 };
}

export function freshState(now: number): PaperState {
  const strategies: Record<string, StratState> = {};
  for (const id of STRATEGY_IDS) strategies[id] = freshStrat();
  return { startedAt: now, lastTick: 0, tickCount: 0, strategies };
}

export async function loadState(): Promise<PaperState | null> {
  return (await store().get('state', { type: 'json' })) as PaperState | null;
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

// ---- trade primitives: buy at ask, sell at bid, fee both sides ----
function buy(st: StratState, id: string, coin: Coin, tick: Tick, cashToSpend: number, reason: string) {
  const spend = Math.min(cashToSpend, st.cash);
  if (spend < 10) return; // ignore dust orders
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

function equityOf(st: StratState, ticks: Record<Coin, Tick>): number {
  let eq = st.cash;
  for (const c of COINS) {
    const pos = st.positions[c];
    if (pos) eq += pos.units * ticks[c].bid;
  }
  return eq;
}

const sma = (xs: number[], n: number) => {
  if (xs.length < n) return null;
  let s = 0;
  for (let i = xs.length - n; i < xs.length; i++) s += xs[i];
  return s / n;
};

// ---- strategy logic, one tick ----
function runStrategies(state: PaperState, ticks: Record<Coin, Tick>, recents: Record<Coin, Tick[]>) {
  const S = state.strategies;
  const mids: Record<string, number[]> = {};
  for (const c of TRADE_COINS) mids[c] = recents[c].map(mid);

  // 1) Buy & Hold benchmark — one-shot
  const hold = S.hold;
  if (hold.trades.length === 0 && hold.cash >= START_CASH - 1) {
    buy(hold, 'hold', 'btc', ticks.btc, hold.cash / 2, 'benchmark initial 50%');
    buy(hold, 'hold', 'eth', ticks.eth, hold.cash, 'benchmark initial 50%');
  }

  // 2) Daily DCA
  const dca = S.dca;
  if (state.tickCount % TICKS_PER_DAY === 0 && dca.cash > 20) {
    const daily = Math.min(110, dca.cash);
    buy(dca, 'dca', 'btc', ticks.btc, daily / 2, 'daily DCA');
    buy(dca, 'dca', 'eth', ticks.eth, Math.min(daily / 2, dca.cash), 'daily DCA');
  }

  // 3) SMA crossover (fast 1h=12 ticks vs slow 6h=72 ticks), per coin with half the book each
  const smaSt = S.sma;
  for (const c of TRADE_COINS) {
    const xs = mids[c];
    const fast = sma(xs, 12);
    const slow = sma(xs, 72);
    const fastPrev = sma(xs.slice(0, -1), 12);
    const slowPrev = sma(xs.slice(0, -1), 72);
    if (fast == null || slow == null || fastPrev == null || slowPrev == null) continue;
    const inPos = Boolean(smaSt.positions[c]);
    if (!inPos && fastPrev <= slowPrev && fast > slow) {
      const other = TRADE_COINS.find((x) => x !== c) as Coin;
      const spend = smaSt.positions[other] ? smaSt.cash : smaSt.cash / 2;
      buy(smaSt, 'sma', c, ticks[c], spend, `golden cross ${c.toUpperCase()}`);
    } else if (inPos && fastPrev >= slowPrev && fast < slow) {
      sellAll(smaSt, 'sma', c, ticks[c], `death cross ${c.toUpperCase()}`);
    }
  }

  // 4) Momentum: 24h lookback
  const mom = S.momentum;
  for (const c of TRADE_COINS) {
    const xs = mids[c];
    if (xs.length < TICKS_PER_DAY + 1) continue;
    const ret24 = xs[xs.length - 1] / xs[xs.length - 1 - TICKS_PER_DAY] - 1;
    const pos = mom.positions[c];
    if (!pos && ret24 > 0.015) {
      buy(mom, 'momentum', c, ticks[c], mom.cash / 2, `24h momentum +${(ret24 * 100).toFixed(2)}%`);
    } else if (pos) {
      const drawdown = ticks[c].bid / pos.entry - 1;
      if (ret24 < 0) sellAll(mom, 'momentum', c, ticks[c], 'momentum turned negative');
      else if (drawdown < -0.03) sellAll(mom, 'momentum', c, ticks[c], 'stop loss -3%');
    }
  }

  // 5) Mean reversion: z-score vs 24h window
  const mr = S.meanrev;
  for (const c of TRADE_COINS) {
    const xs = mids[c];
    if (xs.length < TICKS_PER_DAY) continue;
    const win = xs.slice(-TICKS_PER_DAY);
    const mean = win.reduce((a, b) => a + b, 0) / win.length;
    const sd = Math.sqrt(win.reduce((a, b) => a + (b - mean) ** 2, 0) / win.length);
    if (sd <= 0) continue;
    const z = (xs[xs.length - 1] - mean) / sd;
    const pos = mr.positions[c];
    if (!pos && z < -2) {
      buy(mr, 'meanrev', c, ticks[c], mr.cash / 2, `z-score ${z.toFixed(2)} below mean`);
    } else if (pos) {
      const drawdown = ticks[c].bid / pos.entry - 1;
      if (z >= 0) sellAll(mr, 'meanrev', c, ticks[c], 'reverted to mean');
      else if (drawdown < -0.05) sellAll(mr, 'meanrev', c, ticks[c], 'stop loss -5%');
    }
  }

  // equity snapshots hourly
  if (state.tickCount % 12 === 0) {
    for (const id of STRATEGY_IDS) {
      const st = S[id];
      st.equity.push([ticks.btc.t, Number(equityOf(st, ticks).toFixed(2))]);
      while (st.equity.length > EQUITY_CAP) st.equity.shift();
    }
  }
}

export async function runTick(): Promise<{ ok: boolean; detail: string }> {
  const ticks = await fetchPrices();
  if (!ticks) return { ok: false, detail: 'CoinSpot price fetch failed; tick skipped' };

  const now = ticks.btc.t;
  let state = await loadState();
  if (!state) state = freshState(now);

  // guard: min 4 minutes between ticks (scheduler + manual overlap)
  if (state.lastTick && now - state.lastTick < 240) {
    return { ok: false, detail: 'tick throttled (ran <4 min ago)' };
  }

  const recents = {} as Record<Coin, Tick[]>;
  for (const c of COINS) {
    recents[c] = await loadRecent(c);
  }
  for (const c of COINS) await appendHistory(c, ticks[c], recents[c]);

  runStrategies(state, ticks, recents);
  state.lastTick = now;
  state.tickCount += 1;
  await saveState(state);
  return { ok: true, detail: `tick ${state.tickCount} @ ${new Date(now * 1000).toISOString()}` };
}

export function summarise(state: PaperState, ticks: Record<Coin, Tick>) {
  const out: Record<string, unknown> = {};
  for (const id of STRATEGY_IDS) {
    const st = state.strategies[id];
    const eq = equityOf(st, ticks);
    out[id] = {
      ...STRATEGY_META[id],
      cash: Number(st.cash.toFixed(2)),
      equity: Number(eq.toFixed(2)),
      returnPct: Number(((eq / START_CASH - 1) * 100).toFixed(2)),
      realisedPnl: Number(st.realisedPnl.toFixed(2)),
      wins: st.wins,
      losses: st.losses,
      openPositions: Object.fromEntries(
        Object.entries(st.positions).map(([c, p]) => [c, { units: p!.units, entry: p!.entry, markToBid: ticks[c as Coin].bid }])
      ),
      trades: st.trades.slice(-40).reverse(),
      equityHistory: st.equity,
    };
  }
  return out;
}

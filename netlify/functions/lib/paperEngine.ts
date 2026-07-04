// Paper Trading Engine — CoinSpot public prices, simulated money only.
// No exchange keys exist anywhere in this system. Nothing here can place a real trade.
import { getStore } from '@netlify/blobs';

export const COINS = [
  'btc','eth','sol','xrp','doge','zec','avax','dash','hype','comp','epic','link','inj','nmr','near','mnt','dfi','dot','sui','arb','rndr','tao'
] as const;
export type Coin = (typeof COINS)[number];

const TRADE_COINS: Coin[] = [...COINS];
const FEE = 0.001; // CoinSpot market order fee, 0.1% per side
export const START_CASH = 10000; // virtual AUD total across all strategies
const TICKS_PER_DAY = 288; // 5-minute cadence
const RECENT_CAP = TICKS_PER_DAY * 8;
const TRADES_CAP = 400;
const EQUITY_CAP = 2400; // hourly snapshots ≈ 100 days
const DUST = 5; // lower dust cutoff to allow many small buys

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
  hold: { name: 'Buy & Hold', blurb: 'Benchmark. Allocates the starting cash evenly across the tracked coins and holds unless signals indicate repositioning.' },
  dca: { name: 'Daily DCA', blurb: 'Opportunistic DCA: daily buys into long-hold candidates when they show persistent positive signals.' },
  sma: { name: 'SMA Crossover', blurb: 'Fast vs slow simple moving average cross strategy applied per coin; enters on golden cross, exits on death cross.' },
  momentum: { name: 'Momentum', blurb: 'Buys coins showing strong 24h momentum, exits when momentum weakens or a stop loss hits.' },
  meanrev: { name: 'Mean Reversion', blurb: 'Buys coins when price is significantly below their recent mean and exits on reversion or stop loss.' },
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
    const s = store();
    for (const c of COINS) {
      const p = json.prices[c];
      if (p) {
        const bid = Number(p.bid);
        const ask = Number(p.ask);
        if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) {
          // try fallback to most recent stored tick
          const recent = (await s.get(`recent:${c}`, { type: 'json' })) as Tick[] | null;
          if (recent && recent.length) out[c] = { ...recent[recent.length - 1], t };
          else return null;
        } else {
          out[c] = { t, bid, ask };
        }
      } else {
        // coin missing from CoinSpot response: fallback to stored recent tick if available
        const recent = (await s.get(`recent:${c}`, { type: 'json' })) as Tick[] | null;
        if (recent && recent.length) out[c] = { ...recent[recent.length - 1], t };
        else return null;
      }
    }
    return out;
  } catch {
    return null;
  }
}

function freshStrat(cash: number): StratState {
  return { cash, positions: {}, trades: [], equity: [], realisedPnl: 0, wins: 0, losses: 0 };
}

export function freshState(now: number): PaperState {
  const strategies: Record<string, StratState> = {};
  // split START_CASH 50/50 between day-trading and long-hold
  const dayIds = ['sma', 'momentum', 'meanrev'];
  const longIds = ['hold', 'dca'];
  const dayTotal = START_CASH * 0.5;
  const longTotal = START_CASH * 0.5;
  for (const id of dayIds) strategies[id] = freshStrat(dayTotal / dayIds.length);
  for (const id of longIds) strategies[id] = freshStrat(longTotal / longIds.length);
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
  if (spend < DUST) return; // ignore dust orders
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

export function computeSignals(recents: Record<Coin, Tick[]>, ticks: Record<Coin, Tick>) {
  // returns per-coin components and composite score
  const scores: Record<string, { coin: Coin; momentum24: number | null; smaSignal: number; zscore: number | null; score: number }> = {} as any;
  for (const c of TRADE_COINS) {
    const xs = recents[c] ? recents[c].map(mid) : [];
    const last = xs.length ? xs[xs.length - 1] : null;

    // momentum: 24h lookback
    let mom: number | null = null;
    if (xs.length >= TICKS_PER_DAY + 1) {
      mom = xs[xs.length - 1] / xs[xs.length - 1 - TICKS_PER_DAY] - 1;
    }

    // SMA signal
    const fast = sma(xs, 12);
    const slow = sma(xs, 72);
    const fastPrev = xs.length > 1 ? sma(xs.slice(0, -1), 12) : null;
    const slowPrev = xs.length > 1 ? sma(xs.slice(0, -1), 72) : null;
    let smaSignal = 0;
    if (fast != null && slow != null && fastPrev != null && slowPrev != null) {
      if (fastPrev <= slowPrev && fast > slow) smaSignal = 1;
      else if (fastPrev >= slowPrev && fast < slow) smaSignal = -1;
    }

    // z-score vs 24h window
    let z: number | null = null;
    if (xs.length >= TICKS_PER_DAY) {
      const win = xs.slice(-TICKS_PER_DAY);
      const mean = win.reduce((a, b) => a + b, 0) / win.length;
      const sd = Math.sqrt(win.reduce((a, b) => a + (b - mean) ** 2, 0) / win.length);
      if (sd > 0) z = (xs[xs.length - 1] - mean) / sd;
    }

    // composite score: weights tuned for day trading relevance
    const w_mom = 0.5, w_sma = 0.3, w_z = 0.2;
    const momVal = mom ?? 0;
    const zVal = z ?? 0;
    // transform z so that negative z (price below mean) increases buy score
    const zScoreComponent = -Math.min(Math.max(zVal, -5), 5) / 5; // in [-1,1]

    const score = w_mom * momVal + w_sma * smaSignal + w_z * zScoreComponent;

    scores[c] = { coin: c, momentum24: mom, smaSignal, zscore: z, score } as any;
  }
  return scores;
}

// ---- strategy logic, one tick ----
function runStrategies(state: PaperState, ticks: Record<Coin, Tick>, recents: Record<Coin, Tick[]>) {
  const S = state.strategies;
  const signals = computeSignals(recents, ticks);

  // decide day-trade candidates
  const dayCandidates = Object.values(signals)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6) // top N
    .filter((s) => s.score > 0.15);

  // decide long-hold candidates
  const longCandidates = Object.values(signals)
    .sort((a, b) => (b.momentum24 ?? 0) - (a.momentum24 ?? 0))
    .slice(0, 5)
    .filter((s) => (s.momentum24 ?? 0) > 0 || (s.score > 0.1));

  // DAY-TRADING: allocate from sma, momentum, meanrev strategies (each has its own cash)
  const dayStratIds: (keyof typeof STRATEGY_META)[] = ['sma', 'momentum', 'meanrev'];
  for (const id of dayStratIds) {
    const st = S[id];
    if (!st) continue;
    // compute positive scores for selected candidates
    const positives = dayCandidates.map((c) => ({ coin: c.coin as Coin, score: Math.max(c.score, 0) }));
    const totalScore = positives.reduce((a, b) => a + b.score, 0);
    if (totalScore <= 0) {
      // consider selling if positions exist and score turned negative
      for (const [coinStr, pos] of Object.entries(st.positions)) {
        const coin = coinStr as Coin;
        const s = signals[coin];
        if (!s || s.score < 0) sellAll(st, id, coin, ticks[coin], `exit negative score ${s ? s.score.toFixed(3) : 'n/a'}`);
      }
      continue;
    }
    // per-tick cap: spend at most 50% of cash
    const cap = st.cash * 0.5;
    for (const p of positives) {
      const alloc = (p.score / totalScore) * cap;
      if (alloc >= DUST) buy(st, id, p.coin, ticks[p.coin], alloc, `day-trade allocation based on score ${p.score.toFixed(3)}`);
    }
    // also evaluate stop-losses for existing positions in this strategy
    for (const [coinStr, pos] of Object.entries(st.positions)) {
      const coin = coinStr as Coin;
      const entry = pos!.entry;
      const drawdown = ticks[coin].bid / entry - 1;
      if (drawdown < -0.05) sellAll(st, id, coin, ticks[coin], 'stop loss -5%');
    }
  }

  // LONG-HOLD: hold and dca strategies act as the long book
  const longStratIds: (keyof typeof STRATEGY_META)[] = ['hold', 'dca'];
  for (const id of longStratIds) {
    const st = S[id];
    if (!st) continue;
    // buy top longCandidates if not already held
    const candidates = longCandidates.map((c) => c.coin as Coin);
    const notHeld = candidates.filter((c) => !st.positions[c]);
    if (notHeld.length) {
      const per = Math.min(st.cash / notHeld.length, st.cash * 0.5);
      for (const c of notHeld) {
        buy(st, id, c, ticks[c], per, `long-hold entry ${c.toUpperCase()}`);
      }
    }
    // opportunistic DCA on daily ticks for dca strategy
    if (id === 'dca' && state.tickCount % TICKS_PER_DAY === 0 && st.cash > DUST) {
      for (const c of candidates) {
        // buy only if persistent positive momentum
        const s = signals[c];
        if (s && (s.momentum24 ?? 0) > 0.01) buy(st, id, c, ticks[c], Math.min(110 / candidates.length, st.cash), 'opportunistic DCA');
      }
    }
    // long-hold exit rules: exit if strong negative momentum or large stop-loss
    for (const [coinStr, pos] of Object.entries(st.positions)) {
      const coin = coinStr as Coin;
      const s = signals[coin];
      const entry = pos!.entry;
      const drawdown = ticks[coin].bid / entry - 1;
      if (s && (s.momentum24 ?? 0) < -0.05) sellAll(st, id, coin, ticks[coin], 'long exit: negative momentum');
      else if (drawdown < -0.10) sellAll(st, id, coin, ticks[coin], 'long stop loss -10%');
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

export { computeSignals };

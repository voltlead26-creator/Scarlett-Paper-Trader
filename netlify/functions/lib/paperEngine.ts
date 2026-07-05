// Paper Trading Engine v3 — CoinSpot public prices, simulated money only.
// No exchange keys exist anywhere in this system. Nothing here can place a real trade.
import { getStore } from '@netlify/blobs';

export const COINS = ['btc', 'eth', 'sol', 'xrp', 'doge', 'ada', 'ltc', 'trx', 'eos', 'powr'] as const;
export type Coin = (typeof COINS)[number];
export type Ticks = Partial<Record<Coin, Tick>>;

const FEE          = 0.001;  // CoinSpot market order 0.1% per side
export const START_CASH = 10000;
const TICKS_PER_DAY = 288;   // 5-min cadence
const RECENT_CAP    = TICKS_PER_DAY * 8;
const TRADES_CAP    = 600;
const EQUITY_CAP    = 2400;
const DUST          = 5;
const STATE_VERSION = 3;     // bump forces clean reset from v2

// ─── scalper tunables ────────────────────────────────────────────────────────────────────────────────
const SC_ALLOC      = 80;    // AUD per scalp entry
const SC_TARGET     = 0.008; // 0.8% profit target to exit
const SC_STOP       = 0.005; // 0.5% stop loss
const SC_MAX_HOLD   = 12;    // ticks before time-exit (~60 min at 5-min cadence)
const SC_MAX_OPEN   = 5;     // concurrent scalp positions across all coins
// ────────────────────────────────────────────────────────────────────────────────

export interface Tick { t: number; bid: number; ask: number }
export interface Trade {
  t: number; strategy: string; coin: Coin; side: 'buy' | 'sell';
  units: number; price: number; fee: number; cashAfter: number; reason: string;
}
export interface Position { units: number; entry: number; entryTick?: number }
export interface StratState {
  cash: number; startCash: number;
  positions: Partial<Record<Coin, Position>>;
  trades: Trade[];
  equity: [number, number][];
  realisedPnl: number; wins: number; losses: number;
}
export interface PaperState {
  version: number; startedAt: number; lastTick: number;
  tickCount: number; strategies: Record<string, StratState>;
}

export const STRATEGY_IDS = ['hold', 'dca', 'sma', 'momentum', 'meanrev', 'scalper'] as const;

export const STRATEGY_META: Record<string, { name: string; blurb: string }> = {
  hold:     { name: 'Buy & Hold',      blurb: 'Benchmark. 50/50 BTC/ETH at first tick, never trades again. Every other strategy must beat this to justify existing.' },
  dca:      { name: 'Daily DCA',       blurb: 'Long book. Small daily buy tilted toward positive-momentum coins; falls back to BTC/ETH when nothing qualifies.' },
  sma:      { name: 'SMA Crossover',   blurb: 'Day book. 1-hour vs 6-hour moving average; enters on golden cross, exits on death cross.' },
  momentum: { name: 'Momentum',        blurb: 'Day book. Buys strong 24h movers; exits when momentum turns negative or a 3% stop hits.' },
  meanrev:  { name: 'Mean Reversion',  blurb: 'Day book. Buys 2+ standard deviations below the 24h mean; exits on reversion or a 5% stop.' },
  scalper:  { name: 'Scalper',
    blurb: `Micro day-trading. Watches 5-min candles for three short-term patterns: momentum bursts (3 consecutive higher closes in the last 6 ticks), candle-drop fades (a single tick fell >0.4% and is now recovering), and oversold RSI on a 14-tick window. Each position is ~$${SC_ALLOC} AUD, exits at ${SC_TARGET * 100}% profit, ${SC_STOP * 100}% stop, or after ${SC_MAX_HOLD} ticks (~1 hour) — whichever comes first. Targeting $1–3 simulated gains per trade; shows you what actually works at this cadence.` },
};

const store  = () => getStore('paper-trading');
const dayKey = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const mid    = (k: Tick)   => (k.bid + k.ask) / 2;

export async function fetchPrices(): Promise<Ticks | null> {
  try {
    const res  = await fetch('https://www.coinspot.com.au/pubapi/v2/latest');
    if (!res.ok) return null;
    const json = (await res.json()) as { status: string; prices: Record<string, { bid: string; ask: string }> };
    if (json.status !== 'ok') return null;
    const t   = Math.floor(Date.now() / 1000);
    const out: Ticks = {};
    const s   = store();
    for (const c of COINS) {
      const p   = json.prices[c];
      const bid = p ? Number(p.bid) : NaN;
      const ask = p ? Number(p.ask) : NaN;
      if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
        out[c] = { t, bid, ask };
      } else {
        const recent = (await s.get(`recent:${c}`, { type: 'json' })) as Tick[] | null;
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
  const s = (await store().get('state', { type: 'json' })) as PaperState | null;
  if (s && s.version !== STATE_VERSION) return null;
  return s;
}
export async function saveState(s: PaperState)       { await store().setJSON('state', s); }
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
  const dk  = dayKey(tick.t);
  const day = ((await s.get(`hist:${coin}:${dk}`, { type: 'json' })) as Tick[] | null) ?? [];
  day.push(tick);
  await s.setJSON(`hist:${coin}:${dk}`, day);
}

function buy(st: StratState, id: string, coin: Coin, tick: Tick, cashToSpend: number, reason: string, entryTick?: number) {
  const spend = Math.min(cashToSpend, st.cash);
  if (spend < DUST) return;
  const fee   = spend * FEE;
  const units = (spend - fee) / tick.ask;
  st.cash    -= spend;
  const pos   = st.positions[coin];
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
  st.cash    += net;
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

const smaOf = (xs: number[], n: number) => {
  if (xs.length < n) return null;
  let s = 0;
  for (let i = xs.length - n; i < xs.length; i++) s += xs[i];
  return s / n;
};

function rsi14(xs: number[]): number | null {
  if (xs.length < 15) return null;
  const slice = xs.slice(-15);
  let gains = 0, losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const d = slice[i] - slice[i - 1];
    if (d > 0) gains  += d;
    else       losses -= d;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function scalperSignal(xs: number[]): string | null {
  if (xs.length < 15) return null;
  const last6 = xs.slice(-6);
  const prev  = xs[xs.length - 2];
  const curr  = xs[xs.length - 1];

  // 1. Momentum burst: 3+ consecutive higher closes in last 6 ticks
  let consec = 0;
  for (let i = 1; i < last6.length; i++) if (last6[i] > last6[i - 1]) consec++; else consec = 0;
  if (consec >= 3) return 'burst ×3 consecutive up';

  // 2. Candle-drop fade: prev tick dropped >0.4%, curr tick recovering
  if (xs.length >= 3) {
    const pprev   = xs[xs.length - 3];
    const dropPct = (pprev - prev) / pprev;
    if (dropPct > 0.004 && curr > prev) return `drop-fade recovery after ${(dropPct * 100).toFixed(2)}% fall`;
  }

  // 3. RSI oversold: RSI < 30, current tick up from previous
  const r = rsi14(xs);
  if (r !== null && r < 30 && curr > prev) return `RSI oversold ${r.toFixed(1)} + uptick`;

  return null;
}

export interface Signal {
  coin: Coin; momentum24: number | null; smaSignal: number;
  zscore: number | null; score: number; scalperSignal: string | null;
}

export function computeSignals(recents: Record<Coin, Tick[]>, ticks: Ticks): Record<string, Signal> {
  const scores: Record<string, Signal> = {};
  for (const c of COINS) {
    if (!ticks[c]) continue;
    const xs = recents[c] ? recents[c].map(mid) : [];

    let momentum24: number | null = null;
    if (xs.length >= TICKS_PER_DAY + 1)
      momentum24 = xs[xs.length - 1] / xs[xs.length - 1 - TICKS_PER_DAY] - 1;

    const fast      = smaOf(xs, 12);
    const slow      = smaOf(xs, 72);
    const fastPrev  = xs.length > 1 ? smaOf(xs.slice(0, -1), 12) : null;
    const slowPrev  = xs.length > 1 ? smaOf(xs.slice(0, -1), 72) : null;
    let smaSignal   = 0;
    if (fast != null && slow != null && fastPrev != null && slowPrev != null) {
      if (fastPrev <= slowPrev && fast > slow)  smaSignal =  1;
      if (fastPrev >= slowPrev && fast < slow)  smaSignal = -1;
    }

    let zscore: number | null = null;
    if (xs.length >= TICKS_PER_DAY) {
      const win  = xs.slice(-TICKS_PER_DAY);
      const mean = win.reduce((a, b) => a + b, 0) / win.length;
      const sd   = Math.sqrt(win.reduce((a, b) => a + (b - mean) ** 2, 0) / win.length);
      if (sd > 0) zscore = (xs[xs.length - 1] - mean) / sd;
    }

    const zComponent = zscore == null ? 0 : -Math.min(Math.max(zscore, -5), 5) / 5;
    const score      = 0.5 * (momentum24 ?? 0) + 0.3 * smaSignal + 0.2 * zComponent;
    scores[c] = { coin: c, momentum24, smaSignal, zscore, score, scalperSignal: scalperSignal(xs) };
  }
  return scores;
}

function runStrategies(state: PaperState, ticks: Ticks, recents: Record<Coin, Tick[]>) {
  const S         = state.strategies;
  const signals   = computeSignals(recents, ticks);
  const available = COINS.filter((c) => ticks[c]);

  // ── LONG BOOK ────────────────────────────────────────────────────────────────────────────────────
  const hold = S.hold;
  if (hold.trades.length === 0 && ticks.btc && ticks.eth) {
    buy(hold, 'hold', 'btc', ticks.btc, hold.cash / 2, 'benchmark initial 50%');
    buy(hold, 'hold', 'eth', ticks.eth, hold.cash,     'benchmark initial 50%');
  }

  const dca = S.dca;
  if (state.tickCount % TICKS_PER_DAY === 0 && dca.cash > DUST) {
    const daily   = Math.min(30, dca.cash);
    const tilted  = available.filter((c) => (signals[c]?.momentum24 ?? 0) > 0.01).slice(0, 3);
    const targets = tilted.length ? tilted : (['btc', 'eth'] as Coin[]).filter((c) => ticks[c]);
    for (const c of targets)
      buy(dca, 'dca', c, ticks[c]!, daily / targets.length,
          tilted.length ? 'DCA tilt: positive momentum' : 'DCA fallback BTC/ETH');
  }

  // ── DAY BOOK ───────────────────────────────────────────────────────────────────────────────────
  const maxAlloc = (st: StratState) => st.cash / Math.max(1, 3 - Object.keys(st.positions).length);

  const smaSt = S.sma;
  for (const c of available) {
    const sig  = signals[c];
    if (!sig) continue;
    const inPos = Boolean(smaSt.positions[c]);
    if (!inPos && sig.smaSignal === 1 && Object.keys(smaSt.positions).length < 3)
      buy(smaSt, 'sma', c, ticks[c]!, maxAlloc(smaSt), `golden cross ${c.toUpperCase()}`);
    else if (inPos && sig.smaSignal === -1)
      sellAll(smaSt, 'sma', c, ticks[c]!, `death cross ${c.toUpperCase()}`);
  }

  const mom = S.momentum;
  for (const c of available) {
    const m   = signals[c]?.momentum24;
    if (m == null) continue;
    const pos = mom.positions[c];
    if (!pos && m > 0.015 && Object.keys(mom.positions).length < 3)
      buy(mom, 'momentum', c, ticks[c]!, maxAlloc(mom), `24h momentum +${(m * 100).toFixed(2)}%`);
    else if (pos) {
      const dd = ticks[c]!.bid / pos.entry - 1;
      if (m < 0)           sellAll(mom, 'momentum', c, ticks[c]!, 'momentum turned negative');
      else if (dd < -0.03) sellAll(mom, 'momentum', c, ticks[c]!, 'stop loss -3%');
    }
  }

  const mr = S.meanrev;
  for (const c of available) {
    const z   = signals[c]?.zscore;
    if (z == null) continue;
    const pos = mr.positions[c];
    if (!pos && z < -2 && Object.keys(mr.positions).length < 3)
      buy(mr, 'meanrev', c, ticks[c]!, maxAlloc(mr), `z-score ${z.toFixed(2)} below mean`);
    else if (pos) {
      const dd = ticks[c]!.bid / pos.entry - 1;
      if (z >= 0)          sellAll(mr, 'meanrev', c, ticks[c]!, 'reverted to mean');
      else if (dd < -0.05) sellAll(mr, 'meanrev', c, ticks[c]!, 'stop loss -5%');
    }
  }

  // ── SCALPER ──────────────────────────────────────────────────────────────────────────────────
  const sc = S.scalper;

  // Exit pass first — frees cash before trying new entries
  for (const c of available) {
    const pos = sc.positions[c];
    if (!pos) continue;
    const tick     = ticks[c]!;
    const pnlPct   = tick.bid / pos.entry - 1;
    const age      = state.tickCount - (pos.entryTick ?? state.tickCount);
    const grossPnl = pos.units * (tick.bid - pos.entry);
    if (pnlPct >= SC_TARGET)
      sellAll(sc, 'scalper', c, tick, `target hit +${(pnlPct * 100).toFixed(2)}% ≈ $${grossPnl.toFixed(2)}`);
    else if (pnlPct <= -SC_STOP)
      sellAll(sc, 'scalper', c, tick, `stop −${(Math.abs(pnlPct) * 100).toFixed(2)}% ≈ $${grossPnl.toFixed(2)}`);
    else if (age >= SC_MAX_HOLD)
      sellAll(sc, 'scalper', c, tick, `time exit after ${age} ticks (${(pnlPct * 100).toFixed(2)}% ≈ $${grossPnl.toFixed(2)})`);
  }

  // Entry pass
  if (Object.keys(sc.positions).length < SC_MAX_OPEN && sc.cash >= SC_ALLOC) {
    for (const c of available) {
      if (sc.positions[c]) continue;
      if (Object.keys(sc.positions).length >= SC_MAX_OPEN) break;
      const sig = signals[c]?.scalperSignal;
      if (!sig) continue;
      if (sc.cash < SC_ALLOC) break;
      buy(sc, 'scalper', c, ticks[c]!, SC_ALLOC, `scalp: ${sig}`, state.tickCount);
    }
  }

  // Hourly equity snapshot
  if (state.tickCount % 12 === 0) {
    const t = ticks.btc!.t;
    for (const id of STRATEGY_IDS) {
      const st = S[id];
      if (!st) continue;
      st.equity.push([t, Number(equityOf(st, ticks).toFixed(2))]);
      while (st.equity.length > EQUITY_CAP) st.equity.shift();
    }
  }
}

export async function runTick(): Promise<{ ok: boolean; detail: string }> {
  const ticks = await fetchPrices();
  if (!ticks?.btc) return { ok: false, detail: 'CoinSpot price fetch failed; tick skipped' };

  const now   = ticks.btc.t;
  let state   = await loadState();
  if (!state) state = freshState(now);

  if (state.lastTick && now - state.lastTick < 240)
    return { ok: false, detail: 'tick throttled (ran <4 min ago)' };

  const recents = {} as Record<Coin, Tick[]>;
  for (const c of COINS) recents[c] = await loadRecent(c);
  for (const c of COINS) { const tk = ticks[c]; if (tk) await appendHistory(c, tk, recents[c]); }

  runStrategies(state, ticks, recents);
  state.lastTick  = now;
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
    if (!st) continue;
    const eq = equityOf(st, ticks);
    out[id] = {
      ...STRATEGY_META[id],
      cash: Number(st.cash.toFixed(2)),
      startCash: Number(st.startCash.toFixed(2)),
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

/**
 * Paper Trading Engine v9 - CoinSpot public prices, simulated money only.
 * No exchange keys exist anywhere in this system. Nothing here can place a real trade.
 *
 * v9: Focuses the experiment on three defined strategies only:
 * Long Hold, Mean Reversion Bounce, and Active Micro-Scalper.
 */
import { getStore } from '@netlify/blobs';
import { fetchEquityTicks, isEquity } from './equities';

export type Coin = string;
export type Ticks = Partial<Record<Coin, Tick>>;

const FEE = 0.001;
export const START_CASH = 10000;
const TICKS_PER_DAY = 288;
const RECENT_CAP = TICKS_PER_DAY * 8;
const TRADES_CAP = 1200;
const EQUITY_CAP = 2400;
const DUST = 5;
const STATE_VERSION = 12;

const SMA_FAST = 12;
const SMA_SLOW = 72;
const ACTIVE_MIN_SETUP_SCORE = 0.002;
const ALT_RISK_OFF_SCORE = ACTIVE_MIN_SETUP_SCORE + 0.012;

const MR_MAX_OPEN = 4;
const MR_TAKE_PROFIT = 0.012;
const MR_STOP = 0.025;
const MR_MAX_HOLD = 24;

const SC_ALLOC = 80;
const SC_TARGET = 0.0035;
const SC_STOP = 0.004;
const SC_MAX_HOLD = 12;
const SC_MAX_OPEN = 5;
const SC_DAILY_TRADE_CAP = 250;
const SC_MIN_NET_PROFIT_AUD = 0.02;

const ACTIVE_MIN_HISTORY_TICKS = 36;
const MAX_ACTIVE_SPREAD_PCT = 0.010;
const MAX_SCALP_SPREAD_PCT = 0.0012;
const MIN_SCALP_NET_EDGE = 0.00025;
const MAX_DAILY_DRAWDOWN = 0.035;
const MAX_TOTAL_DRAWDOWN = 0.12;

export interface Tick { t: number; bid: number; ask: number }
export interface Trade { t: number; strategy: string; coin: Coin; side: 'buy'|'sell'; units: number; price: number; fee: number; cashAfter: number; reason: string }
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

export const STRATEGY_IDS = ['hold','meanrev','scalper'] as const;

export const STRATEGY_META: Record<string, { name: string; blurb: string }> = {
  hold: {
    name: 'Long Hold',
    blurb: 'Long-term benchmark. Buys BTC and ETH equally at the first tick and holds through short-term volatility without trading again.',
  },
  meanrev: {
    name: 'Mean Reversion Bounce',
    blurb: 'Buys an oversold move only after a rebound has begun, then exits at a small profit, a defined time limit, or a protected stop.',
  },
  scalper: {
    name: 'Active Micro-Scalper',
    blurb: `High-activity micro day-trading across every CoinSpot market with a valid public bid/ask. Targets 50-150 trades/day with a ${SC_DAILY_TRADE_CAP}/day safety cap. $${SC_ALLOC} AUD entries exit only when net profit is positive after fees and spread, or at the protected stop/time exit. Rebuying higher after a loss remains blocked unless the setup is materially stronger.`,
  },
};

const store = () => getStore('paper-trading');
const dayKey = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const mid = (k: Tick) => (k.bid + k.ask) / 2;
const isMajor = (coin: Coin) => coin === 'btc' || coin === 'eth' || isEquity(coin);
const tickCoins = (ticks: Ticks): Coin[] => Object.keys(ticks).filter((c) => Boolean(ticks[c]));

export async function fetchPrices(): Promise<Ticks | null> {
  try {
    const res = await fetch('https://www.coinspot.com.au/pubapi/v2/latest');
    if (!res.ok) return null;
    const json = await res.json() as { status: string; prices: Record<string, { bid: string; ask: string }> };
    if (json.status !== 'ok') return null;
    const t = Math.floor(Date.now() / 1000);
    const out: Ticks = {};
    for (const [rawCoin, p] of Object.entries(json.prices)) {
      const coin = rawCoin.toLowerCase();
      const bid = Number(p?.bid);
      const ask = Number(p?.ask);
      if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0 && ask >= bid) out[coin] = { t, bid, ask };
    }
    if (!out.btc || !out.eth) return null;
    return out;
  } catch { return null; }
}

function freshStrat(cash: number): StratState {
  return { cash, startCash: cash, positions: {}, trades: [], equity: [], realisedPnl: 0, wins: 0, losses: 0 };
}

export function freshState(now: number): PaperState {
  return {
    version: STATE_VERSION,
    startedAt: now,
    lastTick: 0,
    tickCount: 0,
    strategies: {
      hold: freshStrat(START_CASH * 0.40),
      meanrev: freshStrat(START_CASH * 0.30),
      scalper: freshStrat(START_CASH * 0.30),
    },
  };
}

export async function loadState(): Promise<PaperState | null> {
  const s = await store().get('state', { type: 'json' }) as PaperState | null;
  if (s && s.version !== STATE_VERSION) return null;
  return s;
}
export async function saveState(s: PaperState) { await store().setJSON('state', s); }
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
  const dk = dayKey(tick.t);
  const day = (await s.get(`hist:${coin}:${dk}`, { type: 'json' }) as Tick[] | null) ?? [];
  day.push(tick);
  await s.setJSON(`hist:${coin}:${dk}`, day);
}

function buy(st: StratState, id: string, coin: Coin, tick: Tick, cashToSpend: number, reason: string, entryTick?: number) {
  const spend = Math.min(cashToSpend, st.cash);
  if (spend < DUST) return;
  const fee = spend * FEE;
  const units = (spend - fee) / tick.ask;
  st.cash -= spend;
  const pos = st.positions[coin];
  if (pos) {
    pos.entry = (pos.entry * pos.units + tick.ask * units) / (pos.units + units);
    pos.units += units;
    pos.entryTick = Math.min(pos.entryTick ?? entryTick ?? 0, entryTick ?? 0);
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
  for (const c of Object.keys(st.positions)) {
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

function spreadPct(tick: Tick): number { return (tick.ask - tick.bid) / tick.bid; }
function hasMatureHistory(recents: Record<Coin, Tick[]>, coin: Coin): boolean { return (recents[coin]?.length ?? 0) >= ACTIVE_MIN_HISTORY_TICKS; }
function roundTripCostPct(tick: Tick): number { return spreadPct(tick) + FEE * 2; }
function netPositionProfitAud(pos: Position, tick: Tick): number { return pos.units * tick.bid * (1 - FEE) - pos.units * pos.entry; }
function positionMovePct(pos: Position, tick: Tick): number { return tick.bid / pos.entry - 1; }
function tradesToday(st: StratState, now: number): number {
  const today = dayKey(now);
  return st.trades.filter((tr) => dayKey(tr.t) === today).length;
}
function tickMomentum(recents: Record<Coin, Tick[]>, coin: Coin, lookback: number): number {
  const xs = recents[coin]?.map(mid) ?? [];
  if (xs.length < lookback + 1) return 0;
  return xs[xs.length - 1] / xs[xs.length - 1 - lookback] - 1;
}

function marketRegime(recents: Record<Coin, Tick[]>, ticks: Ticks): 'supportive' | 'neutral' | 'risk_off' {
  const btcXs = recents.btc?.map(mid) ?? [];
  const ethXs = recents.eth?.map(mid) ?? [];
  if (btcXs.length < SMA_SLOW || ethXs.length < SMA_SLOW || !ticks.btc || !ticks.eth) return 'neutral';
  const btcSlow = smaOf(btcXs, SMA_SLOW);
  const ethSlow = smaOf(ethXs, SMA_SLOW);
  const btcM1h = tickMomentum(recents, 'btc', 12);
  const ethM1h = tickMomentum(recents, 'eth', 12);
  const btcBear = btcSlow != null && mid(ticks.btc) < btcSlow && btcM1h < 0;
  const ethBear = ethSlow != null && mid(ticks.eth) < ethSlow && ethM1h < 0;
  if (btcBear && ethBear) return 'risk_off';
  if (!btcBear && !ethBear && btcM1h >= 0 && ethM1h >= 0) return 'supportive';
  return 'neutral';
}

function strategyDrawdownBlocked(st: StratState, ticks: Ticks): boolean {
  const eq = equityOf(st, ticks);
  if (eq <= st.startCash * (1 - MAX_TOTAL_DRAWDOWN)) return true;
  const today = dayKey(ticks.btc?.t ?? Math.floor(Date.now() / 1000));
  const firstToday = st.equity.find(([t]) => dayKey(t) === today)?.[1];
  return Boolean(firstToday && eq <= firstToday * (1 - MAX_DAILY_DRAWDOWN));
}

function lastSell(st: StratState, coin: Coin): Trade | null {
  for (let i = st.trades.length - 1; i >= 0; i--) {
    const tr = st.trades[i];
    if (tr.coin === coin && tr.side === 'sell') return tr;
  }
  return null;
}
function recentStopCount(st: StratState, coin: Coin, now: number, seconds: number): number {
  return st.trades.filter((tr) => tr.coin === coin && tr.side === 'sell' && now - tr.t <= seconds && /stop/i.test(tr.reason)).length;
}
function cooldownSeconds(reason: string): number {
  if (/stop/i.test(reason)) return 60 * 60;
  if (/target|profit|harvest/i.test(reason)) return 15 * 60;
  if (/time exit/i.test(reason)) return 30 * 60;
  if (/negative|death cross|failed/i.test(reason)) return 45 * 60;
  return 30 * 60;
}
function blockedByCooldown(st: StratState, coin: Coin, tick: Tick, nextSetupScore: number): string | null {
  const last = lastSell(st, coin);
  if (!last) return null;
  const recentStops = recentStopCount(st, coin, tick.t, 24 * 60 * 60);
  if (recentStops >= 5) return 'blocked: 5 stop-outs on same coin in 24h';
  const elapsed = tick.t - last.t;
  const cooldown = recentStops >= 3 ? 30 * 60 : cooldownSeconds(last.reason);
  if (elapsed < cooldown) return `blocked: cooldown active after ${last.reason}`;
  const lastWasLossExit = /stop|negative|death cross|failed|time exit/i.test(last.reason);
  if (lastWasLossExit && tick.ask > last.price && nextSetupScore < ACTIVE_MIN_SETUP_SCORE + 0.008) {
    return 'blocked: no re-buy higher after losing exit without stronger setup';
  }
  return null;
}
function activeEntryBlockReason(st: StratState, coin: Coin, tick: Tick, recents: Record<Coin, Tick[]>, ticks: Ticks, regime: string, setupScore: number): string | null {
  if (!hasMatureHistory(recents, coin)) return 'blocked: less than 3h history';
  if (isEquity(coin)) {
    const rec = recents[coin];
    const prev = rec && rec.length >= 2 ? rec[rec.length - 2] : null;
    if (prev && tick.t - prev.t > 20 * 60) return 'blocked: gapped equity history (session open transition)';
  }
  const sp = spreadPct(tick);
  if (sp > MAX_ACTIVE_SPREAD_PCT) return `blocked: spread ${(sp * 100).toFixed(2)}% too wide`;
  if (regime === 'risk_off' && !isMajor(coin) && setupScore < ALT_RISK_OFF_SCORE) return `blocked: altcoin risk-off setup too weak (${setupScore.toFixed(3)})`;
  if (strategyDrawdownBlocked(st, ticks)) return 'blocked: strategy drawdown protection active';
  return blockedByCooldown(st, coin, tick, setupScore);
}

function internalSignal(coin: Coin, recents: Record<Coin, Tick[]>, ticks: Ticks): CoinSignal | null {
  if (!ticks[coin]) return null;
  const xs = recents[coin]?.map(mid) ?? [];
  const curr = xs[xs.length - 1] ?? 0;
  const momentum24h = xs.length >= TICKS_PER_DAY + 1 ? curr / xs[xs.length - 1 - TICKS_PER_DAY] - 1 : 0;
  const momentum1h = xs.length >= 13 ? curr / xs[xs.length - 13] - 1 : 0;

  const fast = smaOf(xs, SMA_FAST), slow = smaOf(xs, SMA_SLOW);
  const fp = xs.length > 1 ? smaOf(xs.slice(0, -1), SMA_FAST) : null;
  const sp = xs.length > 1 ? smaOf(xs.slice(0, -1), SMA_SLOW) : null;
  let smaSignal = 0;
  if (fast != null && slow != null && fp != null && sp != null) {
    if (fp <= sp && fast > slow) smaSignal = 1;
    if (fp >= sp && fast < slow) smaSignal = -1;
  }

  let zscore: number | null = null;
  if (xs.length >= TICKS_PER_DAY) {
    const win = xs.slice(-TICKS_PER_DAY);
    const mean = win.reduce((a, b) => a + b, 0) / win.length;
    const sd = Math.sqrt(win.reduce((a, b) => a + (b - mean) ** 2, 0) / win.length);
    if (sd > 0) zscore = (curr - mean) / sd;
  }

  const last6 = xs.slice(-6);
  let consec = 0, scalperSig: string | null = null;
  for (let i = 1; i < last6.length; i++) if (last6[i] > last6[i - 1]) consec++; else consec = 0;
  const m2 = xs.length >= 3 ? curr / xs[xs.length - 3] - 1 : 0;
  const m3 = xs.length >= 4 ? curr / xs[xs.length - 4] - 1 : 0;
  const wasDrop = xs.length >= 5 ? xs[xs.length - 2] / xs[xs.length - 5] - 1 < -0.003 : false;
  const bounced = xs.length >= 2 ? curr > xs[xs.length - 2] : false;
  if (consec >= 2 && m3 > 0) scalperSig = 'micro burst x2 up';
  else if (wasDrop && bounced) scalperSig = 'candle-drop fade bounce';
  else if (m2 > 0.0015) scalperSig = 'micro momentum edge';

  const score = 0.35 * momentum1h + 0.30 * momentum24h + 0.20 * smaSignal + 0.15 * (zscore == null ? 0 : -Math.min(Math.max(zscore, -3), 3) / 3);
  return { coin, score, momentum1h, momentum24h, momentum7d: 0, volumeScore: 0.5, athDistancePct: 0, trendScore: 0, isTrending: false, fearGreed: null, scalperSignal: scalperSig, sparkline: xs.slice(-12) };
}

function minScalpTakeProfitPct(tick: Tick, pos: Position): number {
  const minCashPct = SC_MIN_NET_PROFIT_AUD / Math.max(DUST, pos.units * pos.entry);
  return Math.max(SC_TARGET, roundTripCostPct(tick) + minCashPct);
}

function runStrategies(state: PaperState, ticks: Ticks, recents: Record<Coin, Tick[]>, externalSignals: CoinSignal[] | null) {
  const S = state.strategies;
  const available = tickCoins(ticks);
  const regime = marketRegime(recents, ticks);
  const sigMap: Record<string, CoinSignal> = {};
  if (externalSignals?.length) for (const s of externalSignals) sigMap[s.coin] = s;
  for (const c of available) if (!sigMap[c]) {
    const signal = internalSignal(c, recents, ticks);
    if (signal) sigMap[c] = signal;
  }

  const hold = S.hold;
  if (hold.trades.length === 0 && ticks.btc && ticks.eth) {
    buy(hold, 'hold', 'btc', ticks.btc, hold.cash / 2, 'long hold initial 50% BTC allocation');
    buy(hold, 'hold', 'eth', ticks.eth, hold.cash, 'long hold initial 50% ETH allocation');
  }

  const mr = S.meanrev;
  if (!strategyDrawdownBlocked(mr, ticks)) {
    for (const c of available) {
      const pos = mr.positions[c], sig = sigMap[c];
      const nOpen = Object.keys(mr.positions).length;
      const tick = ticks[c]!;
      const score = sig?.score ?? 0;
      const move = pos ? positionMovePct(pos, tick) : 0;
      const m2 = tickMomentum(recents, c, 2);
      const m12 = tickMomentum(recents, c, 12);
      const age = pos ? state.tickCount - (pos.entryTick ?? state.tickCount) : 0;
      const block = activeEntryBlockReason(mr, c, tick, recents, ticks, regime, score);
      const bounceSetup = m12 < -0.008 && m2 > 0.0005 && score < 0.015;
      if (!pos && !block && bounceSetup && nOpen < MR_MAX_OPEN) {
        const spend = Math.min(mr.cash / Math.max(1, MR_MAX_OPEN - nOpen), mr.startCash * 0.10);
        buy(mr, 'meanrev', c, tick, spend, `oversold bounce entry m12=${(m12 * 100).toFixed(2)}% m2=${(m2 * 100).toFixed(2)}%`, state.tickCount);
      } else if (pos) {
        if (move >= MR_TAKE_PROFIT && netPositionProfitAud(pos, tick) > 0) sellAll(mr, 'meanrev', c, tick, `bounce profit ${(move * 100).toFixed(2)}%`);
        else if (move <= -Math.max(MR_STOP, roundTripCostPct(tick) + 0.012)) sellAll(mr, 'meanrev', c, tick, `bounce failed stop ${(move * 100).toFixed(2)}%`);
        else if (age >= MR_MAX_HOLD) sellAll(mr, 'meanrev', c, tick, `time exit ${age}t; free capital`);
      }
    }
  }

  const sc = S.scalper;
  if (!strategyDrawdownBlocked(sc, ticks)) {
    for (const c of available) {
      const pos = sc.positions[c];
      if (!pos) continue;
      const tick = ticks[c]!;
      const pnlPct = positionMovePct(pos, tick);
      const age = state.tickCount - (pos.entryTick ?? state.tickCount);
      const netProfit = netPositionProfitAud(pos, tick);
      const takeProfitPct = minScalpTakeProfitPct(tick, pos);
      if (netProfit >= SC_MIN_NET_PROFIT_AUD && pnlPct >= takeProfitPct) {
        sellAll(sc, 'scalper', c, tick, `micro profit +${(pnlPct * 100).toFixed(2)}% net=$${netProfit.toFixed(2)}`);
      } else if (pnlPct <= -Math.max(SC_STOP, roundTripCostPct(tick) + 0.0015)) {
        sellAll(sc, 'scalper', c, tick, `protected stop ${(pnlPct * 100).toFixed(2)}% net=$${netProfit.toFixed(2)}`);
      } else if (age >= SC_MAX_HOLD) {
        sellAll(sc, 'scalper', c, tick, `time exit ${age}t (${(pnlPct * 100).toFixed(2)}% net=$${netProfit.toFixed(2)})`);
      }
    }

    const todayTrades = tradesToday(sc, ticks.btc!.t);
    if (todayTrades < SC_DAILY_TRADE_CAP && Object.keys(sc.positions).length < SC_MAX_OPEN && sc.cash >= SC_ALLOC) {
      for (const c of available) {
        if (isEquity(c)) continue;
        if (sc.positions[c] || Object.keys(sc.positions).length >= SC_MAX_OPEN || sc.cash < SC_ALLOC || tradesToday(sc, ticks.btc!.t) >= SC_DAILY_TRADE_CAP) continue;
        const tick = ticks[c]!;
        const sig = sigMap[c];
        const sp = spreadPct(tick);
        const setupScore = Math.max(sig?.score ?? 0, tickMomentum(recents, c, 2) * 4, tickMomentum(recents, c, 3) * 3);
        const netEdge = SC_TARGET - roundTripCostPct(tick);
        const block = activeEntryBlockReason(sc, c, tick, recents, ticks, regime, setupScore);
        const activeSetup = Boolean(sig?.scalperSignal) && setupScore > ACTIVE_MIN_SETUP_SCORE * 4;
        if (!block && sp <= MAX_SCALP_SPREAD_PCT && netEdge >= MIN_SCALP_NET_EDGE && activeSetup) {
          buy(sc, 'scalper', c, tick, SC_ALLOC,
            `active micro-scalp: ${sig?.scalperSignal}; spread=${(sp * 100).toFixed(2)}%; plannedNetEdge=${(netEdge * 100).toFixed(2)}%; regime=${regime}; dailyTrades=${todayTrades}/${SC_DAILY_TRADE_CAP}`,
            state.tickCount);
        }
      }
    }
  }

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

export async function runTick(externalSignals?: CoinSignal[]): Promise<{ ok: boolean; detail: string }> {
  const ticks = await fetchPrices();
  if (!ticks?.btc) return { ok: false, detail: 'CoinSpot price fetch failed; tick skipped' };
  const equityTicks = await fetchEquityTicks();
  for (const [k, v] of Object.entries(equityTicks)) ticks[k] = v;

  const now = ticks.btc.t;
  let state = await loadState();
  if (!state) state = freshState(now);
  if (state.lastTick && now - state.lastTick < 240) return { ok: false, detail: 'tick throttled (ran <4 min ago)' };

  const recents = {} as Record<Coin, Tick[]>;
  const coins = tickCoins(ticks);
  for (const c of coins) recents[c] = await loadRecent(c);
  for (const c of coins) {
    const tk = ticks[c];
    if (tk) await appendHistory(c, tk, recents[c] ?? []);
  }

  runStrategies(state, ticks, recents, externalSignals ?? null);
  state.lastTick = now;
  state.tickCount += 1;
  await saveState(state);
  return { ok: true, detail: `tick ${state.tickCount} @ ${new Date(now * 1000).toISOString()} [${externalSignals?.length ? 'CF-enriched' : 'internal'}]` };
}

export async function currentSignals(ticks: Ticks): Promise<CoinSignal[]> {
  const recents = {} as Record<Coin, Tick[]>;
  const coins = tickCoins(ticks);
  for (const c of coins) recents[c] = await loadRecent(c);
  return coins.map((c) => internalSignal(c, recents, ticks)).filter(Boolean) as CoinSignal[];
}

export function summarise(state: PaperState, ticks: Ticks) {
  const out: Record<string, unknown> = {};
  const holdEq = state.strategies.hold ? equityOf(state.strategies.hold, ticks) : 0;
  const holdReturnPct = state.strategies.hold && state.strategies.hold.startCash > 0
    ? (holdEq / state.strategies.hold.startCash - 1) * 100
    : 0;
  for (const id of STRATEGY_IDS) {
    const st = state.strategies[id];
    if (!st) continue;
    const eq = equityOf(st, ticks);
    const returnPct = (eq / st.startCash - 1) * 100;
    out[id] = {
      ...STRATEGY_META[id],
      cash: Number(st.cash.toFixed(2)),
      startCash: Number(st.startCash.toFixed(2)),
      equity: Number(eq.toFixed(2)),
      returnPct: Number(returnPct.toFixed(2)),
      benchmarkStatus: id === 'hold' ? 'long-hold benchmark' : (returnPct >= holdReturnPct ? 'beating long-hold benchmark' : 'underperforming long-hold benchmark'),
      realisedPnl: Number(st.realisedPnl.toFixed(2)),
      wins: st.wins,
      losses: st.losses,
      openPositions: Object.fromEntries(Object.entries(st.positions).map(([c, p]) => [c, { units: p!.units, entry: p!.entry, markToBid: ticks[c]?.bid ?? p!.entry, entryTick: p!.entryTick }])),
      trades: st.trades.slice().reverse(),
      tradeCount: st.trades.length,
      equityHistory: st.equity,
    };
  }
  return out;
}

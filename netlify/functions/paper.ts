import { getStore } from '@netlify/blobs';

type Coin = 'btc' | 'eth' | 'sol' | 'xrp' | 'doge';
type Side = 'buy' | 'sell';

type Price = {
  bid: number;
  ask: number;
};

type PricePoint = Price & {
  t: number;
  mid: number;
};

type Position = {
  units: number;
  entry: number;
  entryCost: number;
  entryTick: number;
  peakBid: number;
};

type Trade = {
  t: number;
  coin: Coin;
  side: Side;
  units: number;
  price: number;
  fee: number;
  reason: string;
  strategy: string;
};

type RiskMemory = {
  lastSellTick?: number;
  lastSellPrice?: number;
  lastSellWasLoss?: boolean;
  pendingSellTicks?: number;
  lastDecisionReason?: string;
};

type StrategyState = {
  name: string;
  blurb: string;
  cash: number;
  startCash: number;
  realisedPnl: number;
  wins: number;
  losses: number;
  openPositions: Partial<Record<Coin, Position>>;
  trades: Trade[];
  equityHistory: [number, number][];
  memory: Partial<Record<Coin, RiskMemory>>;
};

type Signal = {
  coin: Coin;
  momentum24: number | null;
  smaSignal: number;
  zscore: number | null;
  score: number;
  scalperSignal: string | null;
};

type StoredState = {
  initialised: boolean;
  startedAt: number;
  lastTick?: number;
  tickCount: number;
  prices: Record<Coin, Price>;
  history: Record<Coin, PricePoint[]>;
  strategies: Record<string, StrategyState>;
  signals: Record<Coin, Signal>;
};

type HandlerEvent = {
  httpMethod?: string;
  path?: string;
  rawUrl?: string;
  headers?: Record<string, string | undefined>;
  body?: string | null;
};

const COINS: Coin[] = ['btc', 'eth', 'sol', 'xrp', 'doge'];
const STORE_NAME = 'paper-trader';
const STATE_KEY = 'state';
const START_CASH = 10_000;
const FEE_RATE = 0.001;
const MAX_HISTORY = 600;
const EQUITY_SNAPSHOT_TICKS = 12;

const RISK = {
  minHoldTicks: 6,
  rebuyCooldownTicks: 12,
  lossRebuyCooldownTicks: 36,
  confirmSellTicks: 2,
  reentryScorePremium: 0.12,
  hardStopLossPct: -0.018,
  profitTakePct: 0.012,
  secondProfitTakePct: 0.022,
  trailingGivebackPct: 0.007,
};

const STRATEGY_META: Record<string, Pick<StrategyState, 'name' | 'blurb'>> = {
  hold: {
    name: 'Buy & Hold',
    blurb: 'Benchmark: buys BTC and ETH once and does not trade the noise.',
  },
  dca: {
    name: 'Daily DCA',
    blurb: 'Adds a small amount once a day, independent of short term signals.',
  },
  sma: {
    name: 'SMA Crossover',
    blurb: 'Trades when the fast moving average confirms a trend change.',
  },
  momentum: {
    name: 'Momentum',
    blurb: 'Buys confirmed strength, then protects gains with profit locks and trailing exits.',
  },
  meanrev: {
    name: 'Mean Reversion',
    blurb: 'Buys unusually stretched pullbacks and exits into recovery.',
  },
  scalper: {
    name: 'Profit Lock',
    blurb: 'A conservative short-hold strategy that banks partial profits early and avoids immediate re-buys after losses.',
  },
};

const json = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  },
  body: JSON.stringify(body),
});

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const avg = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;

function newStrategy(id: string): StrategyState {
  return {
    ...STRATEGY_META[id],
    cash: START_CASH,
    startCash: START_CASH,
    realisedPnl: 0,
    wins: 0,
    losses: 0,
    openPositions: {},
    trades: [],
    equityHistory: [],
    memory: {},
  };
}

function newState(now: number): StoredState {
  return {
    initialised: true,
    startedAt: now,
    tickCount: 0,
    prices: Object.fromEntries(COINS.map((c) => [c, { bid: 0, ask: 0 }])) as Record<Coin, Price>,
    history: Object.fromEntries(COINS.map((c) => [c, []])) as Record<Coin, PricePoint[]>,
    strategies: Object.fromEntries(Object.keys(STRATEGY_META).map((id) => [id, newStrategy(id)])) as Record<string, StrategyState>,
    signals: {} as Record<Coin, Signal>,
  };
}

async function getState(): Promise<StoredState> {
  const store = getStore(STORE_NAME);
  const existing = await store.get(STATE_KEY, { type: 'json' }) as StoredState | null;
  if (existing?.initialised) {
    existing.prices ??= Object.fromEntries(COINS.map((c) => [c, { bid: 0, ask: 0 }])) as Record<Coin, Price>;
    existing.history ??= Object.fromEntries(COINS.map((c) => [c, []])) as Record<Coin, PricePoint[]>;
    existing.strategies ??= {};
    existing.signals ??= {} as Record<Coin, Signal>;
    for (const coin of COINS) {
      existing.history[coin] ??= [];
      existing.signals[coin] ??= computeSignal(coin, existing.history[coin]);
    }
    for (const id of Object.keys(STRATEGY_META)) {
      existing.strategies[id] ??= newStrategy(id);
      existing.strategies[id].memory ??= {};
      existing.strategies[id].equityHistory ??= [];
    }
    return existing;
  }
  return newState(Math.floor(Date.now() / 1000));
}

async function saveState(state: StoredState) {
  await getStore(STORE_NAME).setJSON(STATE_KEY, state);
}

function parseCoinSpotPrices(raw: any): Record<Coin, Price> {
  const source = raw?.prices ?? raw?.rate ?? raw;
  const prices: Partial<Record<Coin, Price>> = {};
  for (const coin of COINS) {
    const item = source?.[coin] ?? source?.[coin.toUpperCase()];
    const bid = Number(item?.bid ?? item?.sell ?? item?.last);
    const ask = Number(item?.ask ?? item?.buy ?? item?.last);
    if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
      prices[coin] = { bid, ask };
    }
  }
  if (COINS.some((coin) => !prices[coin])) {
    throw new Error('CoinSpot response did not include all required bid/ask prices.');
  }
  return prices as Record<Coin, Price>;
}

async function fetchPrices(): Promise<Record<Coin, Price>> {
  const response = await fetch('https://www.coinspot.com.au/pubapi/latest');
  if (!response.ok) throw new Error(`CoinSpot price fetch failed: HTTP ${response.status}`);
  return parseCoinSpotPrices(await response.json());
}

function computeSignal(coin: Coin, history: PricePoint[]): Signal {
  const latest = history.at(-1);
  const mids = history.map((p) => p.mid);
  const price = latest?.mid ?? 0;
  const p12 = history.at(-13)?.mid;
  const p24h = history.at(-289)?.mid;
  const shortMomentum = p12 ? (price - p12) / p12 : 0;
  const momentum24 = p24h ? (price - p24h) / p24h : null;
  const fast = mids.length >= 12 ? avg(mids.slice(-12)) : 0;
  const slow = mids.length >= 48 ? avg(mids.slice(-48)) : 0;
  const smaSignal = fast && slow ? (fast > slow * 1.001 ? 1 : fast < slow * 0.999 ? -1 : 0) : 0;
  const window = mids.slice(-48);
  const mean = avg(window);
  const variance = avg(window.map((v) => (v - mean) ** 2));
  const stdev = Math.sqrt(variance);
  const zscore = window.length >= 24 && stdev > 0 ? (price - mean) / stdev : null;

  let score = 0;
  score += clamp(shortMomentum * 10, -0.18, 0.18);
  score += momentum24 == null ? 0 : clamp(momentum24 * 5, -0.22, 0.22);
  score += smaSignal * 0.10;
  if (zscore != null) score += zscore < -1.2 ? 0.08 : zscore > 1.4 ? -0.08 : 0;

  return {
    coin,
    momentum24,
    smaSignal,
    zscore,
    score,
    scalperSignal: score > 0.22 ? 'profit-lock candidate' : null,
  };
}

function markPosition(position: Position, bid: number) {
  position.peakBid = Math.max(position.peakBid ?? position.entry, bid);
}

function positionReturn(position: Position, bid: number) {
  return (bid * (1 - FEE_RATE) - position.entry * (1 + FEE_RATE)) / (position.entry * (1 + FEE_RATE));
}

function positionEquity(strategy: StrategyState, prices: Record<Coin, Price>) {
  return Object.entries(strategy.openPositions).reduce((sum, [coin, position]) => {
    if (!position) return sum;
    return sum + position.units * prices[coin as Coin].bid * (1 - FEE_RATE);
  }, 0);
}

function outputStrategy(strategy: StrategyState, prices: Record<Coin, Price>) {
  const openPositions = Object.fromEntries(Object.entries(strategy.openPositions).map(([coin, position]) => {
    if (!position) return [coin, position];
    return [coin, {
      units: position.units,
      entry: position.entry,
      markToBid: prices[coin as Coin].bid,
      entryTick: position.entryTick,
    }];
  }));
  const equity = strategy.cash + positionEquity(strategy, prices);
  return {
    ...strategy,
    equity,
    returnPct: ((equity - strategy.startCash) / strategy.startCash) * 100,
    openPositions,
    trades: strategy.trades.slice(-200),
    equityHistory: strategy.equityHistory.slice(-240),
  };
}

function getMemory(strategy: StrategyState, coin: Coin): RiskMemory {
  strategy.memory[coin] ??= {};
  return strategy.memory[coin]!;
}

function canBuy(strategy: StrategyState, coin: Coin, signal: Signal, price: Price, tick: number, baseThreshold: number) {
  if (strategy.openPositions[coin]) return false;
  const memory = getMemory(strategy, coin);
  const sinceSell = memory.lastSellTick == null ? Infinity : tick - memory.lastSellTick;
  const cooldown = memory.lastSellWasLoss ? RISK.lossRebuyCooldownTicks : RISK.rebuyCooldownTicks;
  if (sinceSell < cooldown) {
    memory.lastDecisionReason = `blocked_rebuy_cooldown_${cooldown - sinceSell}_ticks`;
    return false;
  }
  if (memory.lastSellPrice && price.ask > memory.lastSellPrice && signal.score < baseThreshold + RISK.reentryScorePremium) {
    memory.lastDecisionReason = 'blocked_weak_higher_reentry';
    return false;
  }
  return signal.score >= baseThreshold;
}

function buy(strategyId: string, strategy: StrategyState, coin: Coin, price: Price, tick: number, reason: string, allocationPct: number) {
  const gross = Math.min(strategy.cash, strategy.startCash * allocationPct);
  if (gross < 25) return;
  const fee = gross * FEE_RATE;
  const net = gross - fee;
  const units = net / price.ask;
  strategy.cash -= gross;
  strategy.openPositions[coin] = {
    units,
    entry: price.ask,
    entryCost: gross,
    entryTick: tick,
    peakBid: price.bid,
  };
  strategy.trades.push({ t: Math.floor(Date.now() / 1000), coin, side: 'buy', units, price: price.ask, fee, reason, strategy: strategyId });
}

function sell(strategyId: string, strategy: StrategyState, coin: Coin, price: Price, tick: number, reason: string, portion = 1) {
  const position = strategy.openPositions[coin];
  if (!position) return;
  const units = position.units * portion;
  const gross = units * price.bid;
  const fee = gross * FEE_RATE;
  const proceeds = gross - fee;
  const costBasis = position.entryCost * portion;
  const pnl = proceeds - costBasis;
  strategy.cash += proceeds;
  strategy.realisedPnl += pnl;
  if (pnl >= 0) strategy.wins += 1;
  else strategy.losses += 1;
  position.units -= units;
  position.entryCost -= costBasis;
  strategy.trades.push({ t: Math.floor(Date.now() / 1000), coin, side: 'sell', units, price: price.bid, fee, reason, strategy: strategyId });

  const memory = getMemory(strategy, coin);
  memory.lastSellTick = tick;
  memory.lastSellPrice = price.bid;
  memory.lastSellWasLoss = pnl < 0;
  memory.pendingSellTicks = 0;

  if (position.units <= 0.00000001 || portion >= 0.999) {
    delete strategy.openPositions[coin];
  }
}

function guardedSellReason(strategy: StrategyState, coin: Coin, signal: Signal, price: Price, tick: number, rawReason: string) {
  const position = strategy.openPositions[coin];
  if (!position) return null;
  markPosition(position, price.bid);
  const heldTicks = tick - position.entryTick;
  const ret = positionReturn(position, price.bid);
  const trailingGiveback = (price.bid - position.peakBid) / position.peakBid;
  if (ret <= RISK.hardStopLossPct) return 'hard_stop_loss';
  if (ret >= RISK.secondProfitTakePct) return 'second_profit_lock';
  if (ret >= RISK.profitTakePct && rawReason === 'profit_lock') return 'early_profit_lock';
  if (ret > 0.006 && trailingGiveback <= -RISK.trailingGivebackPct) return 'trailing_profit_protection';
  if (heldTicks < RISK.minHoldTicks && ret < 0) {
    getMemory(strategy, coin).lastDecisionReason = 'blocked_min_hold_loss_exit';
    return null;
  }
  if (signal.score > -0.08 && signal.smaSignal >= 0) {
    getMemory(strategy, coin).pendingSellTicks = 0;
    return null;
  }
  const memory = getMemory(strategy, coin);
  memory.pendingSellTicks = (memory.pendingSellTicks ?? 0) + 1;
  if (memory.pendingSellTicks < RISK.confirmSellTicks) {
    memory.lastDecisionReason = 'sell_signal_unconfirmed';
    return null;
  }
  return rawReason;
}

function tradeHold(strategy: StrategyState, prices: Record<Coin, Price>, tick: number) {
  if (tick > 1 || Object.keys(strategy.openPositions).length > 0) return;
  buy('hold', strategy, 'btc', prices.btc, tick, 'benchmark_initial_btc', 0.45);
  buy('hold', strategy, 'eth', prices.eth, tick, 'benchmark_initial_eth', 0.45);
}

function tradeDca(strategy: StrategyState, prices: Record<Coin, Price>, tick: number) {
  if (tick % 288 !== 1) return;
  const coin = COINS[Math.floor(tick / 288) % COINS.length];
  buy('dca', strategy, coin, prices[coin], tick, 'daily_dca', 0.02);
}

function tradeSma(strategy: StrategyState, signals: Record<Coin, Signal>, prices: Record<Coin, Price>, tick: number) {
  for (const coin of COINS) {
    const signal = signals[coin];
    const position = strategy.openPositions[coin];
    if (!position && signal.smaSignal > 0 && canBuy(strategy, coin, signal, prices[coin], tick, 0.12)) {
      buy('sma', strategy, coin, prices[coin], tick, 'sma_confirmed_uptrend', 0.12);
    } else if (position) {
      const reason = guardedSellReason(strategy, coin, signal, prices[coin], tick, 'sma_confirmed_downtrend');
      if (reason) sell('sma', strategy, coin, prices[coin], tick, reason);
    }
  }
}

function tradeMomentum(strategy: StrategyState, signals: Record<Coin, Signal>, prices: Record<Coin, Price>, tick: number) {
  const candidates = COINS
    .map((coin) => signals[coin])
    .filter((signal) => (signal.momentum24 ?? 0) > 0.008 && signal.smaSignal >= 0)
    .sort((a, b) => b.score - a.score);
  for (const signal of candidates.slice(0, 2)) {
    if (canBuy(strategy, signal.coin, signal, prices[signal.coin], tick, 0.16)) {
      buy('momentum', strategy, signal.coin, prices[signal.coin], tick, 'confirmed_momentum_entry', 0.10);
    }
  }
  for (const coin of COINS) {
    if (!strategy.openPositions[coin]) continue;
    const reason = guardedSellReason(strategy, coin, signals[coin], prices[coin], tick, 'momentum_faded');
    if (reason) sell('momentum', strategy, coin, prices[coin], tick, reason);
  }
}

function tradeMeanReversion(strategy: StrategyState, signals: Record<Coin, Signal>, prices: Record<Coin, Price>, tick: number) {
  for (const coin of COINS) {
    const signal = signals[coin];
    if (!strategy.openPositions[coin] && (signal.zscore ?? 0) < -1.25 && canBuy(strategy, coin, signal, prices[coin], tick, 0.02)) {
      buy('meanrev', strategy, coin, prices[coin], tick, 'oversold_reversion_entry', 0.08);
    }
    if (strategy.openPositions[coin]) {
      const rawReason = (signal.zscore ?? 0) > -0.15 ? 'mean_reversion_recovered' : 'profit_lock';
      const reason = guardedSellReason(strategy, coin, signal, prices[coin], tick, rawReason);
      if (reason) sell('meanrev', strategy, coin, prices[coin], tick, reason);
    }
  }
}

function tradeProfitLock(strategy: StrategyState, signals: Record<Coin, Signal>, prices: Record<Coin, Price>, tick: number) {
  const candidates = COINS
    .map((coin) => signals[coin])
    .filter((signal) => signal.score >= 0.22 && signal.smaSignal >= 0)
    .sort((a, b) => b.score - a.score);
  for (const signal of candidates.slice(0, 2)) {
    if (canBuy(strategy, signal.coin, signal, prices[signal.coin], tick, 0.22)) {
      buy('scalper', strategy, signal.coin, prices[signal.coin], tick, 'profit_lock_entry', 0.07);
    }
  }
  for (const coin of COINS) {
    const position = strategy.openPositions[coin];
    if (!position) continue;
    const ret = positionReturn(position, prices[coin].bid);
    const rawReason = ret >= RISK.profitTakePct ? 'profit_lock' : 'signal_softened';
    const reason = guardedSellReason(strategy, coin, signals[coin], prices[coin], tick, rawReason);
    if (!reason) continue;
    const portion = reason === 'early_profit_lock' && position.units > 0 ? 0.5 : 1;
    sell('scalper', strategy, coin, prices[coin], tick, reason, portion);
  }
}

function runStrategies(state: StoredState) {
  const { strategies, signals, prices, tickCount } = state;
  tradeHold(strategies.hold, prices, tickCount);
  tradeDca(strategies.dca, prices, tickCount);
  tradeSma(strategies.sma, signals, prices, tickCount);
  tradeMomentum(strategies.momentum, signals, prices, tickCount);
  tradeMeanReversion(strategies.meanrev, signals, prices, tickCount);
  tradeProfitLock(strategies.scalper, signals, prices, tickCount);

  if (tickCount % EQUITY_SNAPSHOT_TICKS === 0) {
    const now = Math.floor(Date.now() / 1000);
    for (const strategy of Object.values(strategies)) {
      strategy.equityHistory.push([now, strategy.cash + positionEquity(strategy, prices)]);
      strategy.equityHistory = strategy.equityHistory.slice(-240);
      strategy.trades = strategy.trades.slice(-300);
    }
  }
}

async function runTick() {
  const state = await getState();
  const now = Math.floor(Date.now() / 1000);
  const prices = await fetchPrices();
  state.tickCount += 1;
  state.lastTick = now;
  state.prices = prices;
  for (const coin of COINS) {
    state.history[coin] ??= [];
    state.history[coin].push({ ...prices[coin], mid: (prices[coin].bid + prices[coin].ask) / 2, t: now });
    state.history[coin] = state.history[coin].slice(-MAX_HISTORY);
    state.signals[coin] = computeSignal(coin, state.history[coin]);
  }
  runStrategies(state);
  await saveState(state);
  return state;
}

function publicState(state: StoredState) {
  return {
    initialised: true,
    startedAt: state.startedAt,
    lastTick: state.lastTick,
    tickCount: state.tickCount,
    prices: state.prices,
    signals: state.signals,
    strategies: Object.fromEntries(Object.entries(state.strategies).map(([id, strategy]) => [id, outputStrategy(strategy, state.prices)])),
  };
}

async function portfolio(event: HandlerEvent) {
  const token = process.env.DASHBOARD_TOKEN;
  const apiKey = process.env.COINSPOT_API_KEY;
  const apiSecret = process.env.COINSPOT_API_SECRET;
  if (!apiKey || !apiSecret) return json(200, { configured: false, note: 'Read-only CoinSpot portfolio view is not configured.' });
  if (token && event.headers?.['x-dashboard-token'] !== token) return json(401, { error: 'Dashboard token required.' });
  return json(200, { configured: false, note: 'CoinSpot portfolio passthrough is disabled in this simulator function.' });
}

function routeFromEvent(event: HandlerEvent) {
  const path = event.path ?? '';
  if (path.includes('/portfolio')) return 'portfolio';
  if (path.includes('/tick')) return 'tick';
  return 'state';
}

function isScheduledEvent(event: HandlerEvent) {
  const headers = event.headers ?? {};
  return event.httpMethod === undefined
    || headers['x-nf-event'] === 'schedule'
    || headers['x-netlify-event'] === 'schedule'
    || event.body === '{}';
}

export const config = {
  schedule: '*/5 * * * *',
};

export const handler = async (event: HandlerEvent) => {
  try {
    const route = routeFromEvent(event);
    if (route === 'portfolio') return portfolio(event);
    if (route === 'tick' || isScheduledEvent(event)) {
      const state = await runTick();
      return json(200, publicState(state));
    }
    const state = await getState();
    if (!state.lastTick) {
      return json(200, { initialised: false, note: 'No paper-trading data yet. Run the first tick to seed live prices.' });
    }
    return json(200, publicState(state));
  } catch (error) {
    return json(500, { error: error instanceof Error ? error.message : String(error) });
  }
};
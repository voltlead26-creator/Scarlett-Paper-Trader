import { useEffect, useMemo, useState } from 'react';

const COLORS: Record<string, string> = {
  hold: '#2B2521',
  dca: '#8A7B6C',
  sma: '#C8442B',
  momentum: '#E0883C',
  meanrev: '#5B7B6C',
};

interface StratView {
  name: string; blurb: string; cash: number; startCash: number; equity: number; returnPct: number;
  realisedPnl: number; wins: number; losses: number;
  openPositions: Record<string, { units: number; entry: number; markToBid: number }>;
  trades: { t: number; coin: string; side: string; units: number; price: number; fee: number; reason: string; strategy: string }[];
  equityHistory: [number, number][];
}

interface Signal {
  coin: string;
  momentum24?: number | null;
  smaSignal: number;
  zscore?: number | null;
  score: number;
}

interface StateResponse {
  initialised: boolean;
  note?: string;
  error?: string;
  startedAt?: number;
  lastTick?: number;
  tickCount?: number;
  prices?: Record<string, { bid: number; ask: number }>;
  strategies?: Record<string, StratView>;
  signals?: Record<string, Signal>;
}

const aud = (n: number) => n.toLocaleString('en-AU', { style: 'currency', currency: 'AUD' });
const ts = (t: number) => new Date(t * 1000).toLocaleString('en-AU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

function EquityChart({ strategies }: { strategies: Record<string, StratView> }) {
  // Books start with different cash, so plot each curve as % of its own start (100 = flat)
  const series = Object.entries(strategies)
    .filter(([, s]) => s.equityHistory.length > 1 && s.startCash > 0)
    .map(([id, s]) => ({ id, points: s.equityHistory.map(([t, v]) => [t, (v / s.startCash) * 100] as [number, number]) }));
  if (series.length === 0) {
    return <div className="chart-empty">Equity curves appear once a few hours of data exist. The collector snapshots every hour.</div>;
  }
  const all = series.flatMap((s) => s.points);
  const tMin = Math.min(...all.map((p) => p[0]));
  const tMax = Math.max(...all.map((p) => p[0]));
  const vMin = Math.min(100, ...all.map((p) => p[1])) * 0.998;
  const vMax = Math.max(100, ...all.map((p) => p[1])) * 1.002;
  const W = 900; const H = 260; const PAD = 8;
  const x = (t: number) => PAD + ((t - tMin) / Math.max(1, tMax - tMin)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - ((v - vMin) / Math.max(0.0001, vMax - vMin)) * (H - PAD * 2);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart">
      <line x1={PAD} x2={W - PAD} y1={y(100)} y2={y(100)} stroke="#2B2521" strokeDasharray="4 4" strokeOpacity="0.35" />
      <text x={W - PAD - 4} y={y(100) - 5} textAnchor="end" fontSize="11" fill="#2B2521" opacity="0.6">100% = starting cash</text>
      {series.map((s) => (
        <polyline
          key={s.id}
          fill="none"
          stroke={COLORS[s.id] ?? '#2B2521'}
          strokeWidth={s.id === 'hold' ? 2.5 : 1.6}
          points={s.points.map(([t, v]) => `${x(t)},${y(v)}`).join(' ')}
        />
      ))}
    </svg>
  );
}

function SignalsPanel({ signals, prices }: { signals?: Record<string, Signal> | null; prices?: Record<string, { bid: number; ask: number }> }) {
  if (!signals || Object.keys(signals).length === 0) return null;
  const list = Object.values(signals).slice().sort((a, b) => b.score - a.score);
  return (
    <section className="card">
      <h2>Per-coin signals</h2>
      <p className="dim">Composite score with components. Positive score → buy candidate; negative → exit candidate. Components need up to 24h of history before they populate.</p>
      <div className="signals-table">
        <table>
          <thead>
            <tr><th>Coin</th><th>Price</th><th>24h</th><th>SMA</th><th>z-score</th><th>Score</th><th>Action</th></tr>
          </thead>
          <tbody>
            {list.map((s) => (
              <tr key={s.coin}>
                <td>{s.coin.toUpperCase()}</td>
                <td>{prices?.[s.coin] ? aud(prices[s.coin].bid) : '—'}</td>
                <td className="dim">{s.momentum24 == null ? '—' : `${(s.momentum24 * 100).toFixed(2)}%`}</td>
                <td className="dim">{s.smaSignal === 1 ? 'golden' : s.smaSignal === -1 ? 'death' : '—'}</td>
                <td className="dim">{s.zscore == null ? '—' : s.zscore.toFixed(2)}</td>
                <td style={{ fontWeight: 600 }}>{s.score.toFixed(3)}</td>
                <td className={s.score > 0.15 ? 'up' : s.score < -0.1 ? 'down' : 'dim'}>
                  {s.score > 0.15 ? 'Buy candidate' : s.score < -0.1 ? 'Sell candidate' : 'Hold / Monitor'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PortfolioPanel() {
  const [state, setState] = useState<{ phase: 'idle' | 'needtoken' | 'loading' | 'ready' | 'off' | 'error'; rows?: { coin: string; balance: number; aud: number }[]; msg?: string }>({ phase: 'idle' });

  const load = async (token: string | null) => {
    setState({ phase: 'loading' });
    try {
      const res = await fetch('/paper/portfolio', token ? { headers: { 'x-dashboard-token': token } } : undefined);
      const body = await res.json();
      if (body.configured === false) { setState({ phase: 'off', msg: body.note }); return; }
      if (res.status === 401 || res.status === 403) { setState({ phase: 'needtoken', msg: body.error }); return; }
      if (!res.ok) { setState({ phase: 'error', msg: body.error ?? `HTTP ${res.status}` }); return; }
      // CoinSpot balances arrive as an array of single-key objects; flatten defensively
      const raw = body.balances?.balances ?? body.balances?.balance ?? [];
      const rows: { coin: string; balance: number; aud: number }[] = [];
      const push = (coin: string, v: any) => rows.push({ coin, balance: Number(v?.balance ?? 0), aud: Number(v?.audbalance ?? 0) });
      if (Array.isArray(raw)) for (const entry of raw) for (const [coin, v] of Object.entries(entry as object)) push(coin, v);
      else if (raw && typeof raw === 'object') for (const [coin, v] of Object.entries(raw as object)) push(coin, v);
      rows.sort((a, b) => b.aud - a.aud);
      setState({ phase: 'ready', rows });
    } catch (e) {
      setState({ phase: 'error', msg: String(e) });
    }
  };

  useEffect(() => { load(localStorage.getItem('dashToken')); }, []);

  if (state.phase === 'off') return null;

  return (
    <section className="card">
      <h2>Your real CoinSpot account (read-only)</h2>
      {state.phase === 'loading' && <p className="dim">Loading…</p>}
      {state.phase === 'needtoken' && (
        <div className="banner">
          <p>Enter your dashboard token to view real balances. {state.msg}</p>
          <button onClick={() => { const t = window.prompt('Dashboard token'); if (t) { localStorage.setItem('dashToken', t); load(t); } }}>Enter token</button>
        </div>
      )}
      {state.phase === 'error' && <div className="banner error">{state.msg}</div>}
      {state.phase === 'ready' && state.rows && (
        state.rows.filter((r) => r.balance > 0).length === 0 ? <p className="dim">No holdings returned.</p> : (
          <table>
            <thead><tr><th>Coin</th><th>Balance</th><th>Value (AUD)</th></tr></thead>
            <tbody>
              {state.rows.filter((r) => r.balance > 0).map((r) => (
                <tr key={r.coin}>
                  <td>{r.coin.toUpperCase()}</td>
                  <td>{r.balance}</td>
                  <td>{aud(r.aud)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}
      <p className="dim" style={{ marginTop: 8 }}>Read-only key: this dashboard can view your account but can never trade on it. Your paper strategies remain fully simulated.</p>
    </section>
  );
}

export default function App() {
  const [data, setData] = useState<StateResponse | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      const res = await fetch('/paper/state');
      setData(await res.json());
      setErr('');
    } catch (e) {
      setErr(String(e));
    }
  };

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 60_000);
    return () => clearInterval(id);
  }, []);

  const runTickNow = async () => {
    setBusy(true);
    await fetch('/paper/tick', { method: 'POST' }).catch(() => {});
    await refresh();
    setBusy(false);
  };

  const allTrades = useMemo(() => {
    if (!data?.strategies) return [];
    return Object.values(data.strategies)
      .flatMap((s) => s.trades)
      .sort((a, b) => b.t - a.t)
      .slice(0, 30);
  }, [data]);

  return (
    <div className="page">
      <header>
        <div>
          <h1>Scarlett Paper Trader</h1>
          <p className="sub">Simulated crypto strategies on live CoinSpot prices. No real money. No exchange keys. The point is to find out — with evidence — whether any strategy beats simply holding.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button onClick={refresh} title="Refresh data">Refresh</button>
          <button onClick={runTickNow} disabled={busy} title="Run one tick now">{busy ? 'Running…' : 'Run tick'}</button>
          {data?.lastTick ? <div className="pill">Last tick {ts(data.lastTick)} · {data.tickCount} ticks</div> : null}
        </div>
      </header>

      {err && <div className="banner error">Dashboard could not reach the API: {err}</div>}
      {data?.error && <div className="banner error">{data.error}</div>}

      {data && !data.initialised && !data.error && (
        <div className="banner">
          <p>{data.note ?? 'No data yet.'}</p>
          <button onClick={runTickNow} disabled={busy}>{busy ? 'Seeding…' : 'Run first tick now'}</button>
        </div>
      )}

      {data?.prices && (
        <section className="prices">
          {Object.entries(data.prices).map(([c, p]) => (
            <div key={c} className="price">
              <span className="coin">{c.toUpperCase()}</span>
              <span>bid {aud(p.bid)}</span>
              <span className="dim">ask {aud(p.ask)}</span>
            </div>
          ))}
        </section>
      )}

      {data?.signals && <SignalsPanel signals={data.signals} prices={data.prices} />}

      <PortfolioPanel />

      {data?.strategies && (
        <>
          <section className="card">
            <h2>Equity — each strategy as a percentage of its own starting cash</h2>
            <EquityChart strategies={data.strategies} />
            <div className="legend">
              {Object.entries(data.strategies).map(([id, s]) => (
                <span key={id}><i style={{ background: COLORS[id] }} /> {s.name}</span>
              ))}
            </div>
          </section>

          <section className="grid">
            {Object.entries(data.strategies).map(([id, s]) => (
              <div key={id} className="card strat" style={{ borderTopColor: COLORS[id] }}>
                <h3>{s.name}</h3>
                <p className="blurb">{s.blurb}</p>
                <div className="figures">
                  <div><label>Equity</label><strong>{aud(s.equity)}</strong></div>
                  <div><label>Return</label><strong className={s.returnPct >= 0 ? 'up' : 'down'}>{s.returnPct >= 0 ? '+' : ''}{s.returnPct}%</strong></div>
                  <div><label>Started with</label><strong>{aud(s.startCash)}</strong></div>
                  <div><label>Closed W/L</label><strong>{s.wins}/{s.losses}</strong></div>
                </div>
                {Object.keys(s.openPositions).length > 0 && (
                  <div className="positions">
                    {Object.entries(s.openPositions).map(([c, p]) => (
                      <span key={c}>{c.toUpperCase()} {p.units.toFixed(5)} @ {aud(p.entry)} → {aud(p.markToBid)}</span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </section>

          <section className="card">
            <h2>Recent simulated trades (all strategies)</h2>
            {allTrades.length === 0 ? (
              <p className="dim">No trades yet. Most strategies need 6–24 hours of price history before their first signal — this is expected, not broken.</p>
            ) : (
              <table>
                <thead><tr><th>When</th><th>Strategy</th><th>Side</th><th>Coin</th><th>Units</th><th>Price</th><th>Fee</th><th>Reason</th></tr></thead>
                <tbody>
                  {allTrades.map((t, i) => (
                    <tr key={i}>
                      <td>{ts(t.t)}</td>
                      <td>{t.strategy}</td>
                      <td className={t.side === 'buy' ? 'up' : 'down'}>{t.side}</td>
                      <td>{t.coin.toUpperCase()}</td>
                      <td>{t.units.toFixed(6)}</td>
                      <td>{aud(t.price)}</td>
                      <td>{aud(t.fee)}</td>
                      <td className="dim">{t.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}

      <footer>
        Prices: CoinSpot public API, 5-minute cadence, {`10 tracked coins`}. Fills simulated at ask (buy) / sell at bid with 0.1% fee per side.
        This is an experiment log, not financial advice — and results here do not predict live-trading results.
      </footer>
    </div>
  );
}

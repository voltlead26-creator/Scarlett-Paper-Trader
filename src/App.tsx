import { useEffect, useMemo, useState } from 'react';

const COLORS: Record<string, string> = {
  hold: '#2B2521',
  dca: '#8A7B6C',
  sma: '#C8442B',
  momentum: '#E0883C',
  meanrev: '#5B7B6C',
};

interface StratView {
  name: string; blurb: string; cash: number; equity: number; returnPct: number;
  realisedPnl: number; wins: number; losses: number;
  openPositions: Record<string, { units: number; entry: number; markToBid: number }>;
  trades: { t: number; coin: string; side: string; units: number; price: number; fee: number; reason: string; strategy: string }[];
  equityHistory: [number, number][];
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
}

const aud = (n: number) => n.toLocaleString('en-AU', { style: 'currency', currency: 'AUD' });
const ts = (t: number) => new Date(t * 1000).toLocaleString('en-AU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

function EquityChart({ strategies }: { strategies: Record<string, StratView> }) {
  const series = Object.entries(strategies).filter(([, s]) => s.equityHistory.length > 1);
  if (series.length === 0) {
    return <div className="chart-empty">Equity curves appear once a few hours of data exist. The collector snapshots every hour.</div>;
  }
  const all = series.flatMap(([, s]) => s.equityHistory);
  const tMin = Math.min(...all.map((p) => p[0]));
  const tMax = Math.max(...all.map((p) => p[0]));
  const vMin = Math.min(10000, ...all.map((p) => p[1])) * 0.995;
  const vMax = Math.max(10000, ...all.map((p) => p[1])) * 1.005;
  const W = 900; const H = 260; const PAD = 8;
  const x = (t: number) => PAD + ((t - tMin) / Math.max(1, tMax - tMin)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - ((v - vMin) / Math.max(1, vMax - vMin)) * (H - PAD * 2);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart">
      <line x1={PAD} x2={W - PAD} y1={y(10000)} y2={y(10000)} stroke="#2B2521" strokeDasharray="4 4" strokeOpacity="0.35" />
      <text x={W - PAD - 4} y={y(10000) - 5} textAnchor="end" fontSize="11" fill="#2B2521" opacity="0.6">$10,000 start</text>
      {series.map(([id, s]) => (
        <polyline
          key={id}
          fill="none"
          stroke={COLORS[id] ?? '#2B2521'}
          strokeWidth={id === 'hold' ? 2.5 : 1.6}
          points={s.equityHistory.map(([t, v]) => `${x(t)},${y(v)}`).join(' ')}
        />
      ))}
    </svg>
  );
}

export default function App() {
  const [data, setData] = useState<StateResponse | null>(null);
  const [err, setErr] = useState('');
  const [seeding, setSeeding] = useState(false);

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

  const seed = async () => {
    setSeeding(true);
    await fetch('/paper/tick', { method: 'POST' }).catch(() => {});
    await refresh();
    setSeeding(false);
  };

  const runTickNow = async () => {
    setSeeding(true);
    await fetch('/paper/tick', { method: 'POST' }).catch(() => {});
    await refresh();
    setSeeding(false);
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
          <button onClick={runTickNow} disabled={seeding} title="Run one tick now">{seeding ? 'Running…' : 'Run tick'}</button>
          {data?.lastTick ? <div className="pill">Last tick {ts(data.lastTick)} · {data.tickCount} ticks</div> : null}
        </div>
      </header>

      {err && <div className="banner error">Dashboard could not reach the API: {err}</div>}

      {data && !data.initialised && (
        <div className="banner">
          <p>{data.note}</p>
          <button onClick={seed} disabled={seeding}>{seeding ? 'Seeding…' : 'Run first tick now'}</button>
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

      {data?.strategies && (
        <>
          <section className="card">
            <h2>Equity — every strategy vs the $10k it started with</h2>
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
                  <div><label>Realised P&L</label><strong>{aud(s.realisedPnl)}</strong></div>
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
        Prices: CoinSpot public API, 5-minute cadence. Fills simulated at ask (buy) / bid (sell) with 0.1% fee per side.
        This is an experiment log, not financial advice — and results here do not predict live-trading results.
      </footer>
    </div>
  );
}

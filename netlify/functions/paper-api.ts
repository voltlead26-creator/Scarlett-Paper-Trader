// Paper-trading read API + manual controls. Simulated money only — no exchange keys exist.
import { COINS, currentSignals, fetchPrices, loadDay, loadRecent, loadState, runTick, summarise, type Coin } from './lib/paperEngine';
import { coinspotConfigured, myBalances } from './lib/coinspot';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export default async function handler(request: Request) {
  const url = new URL(request.url);
  const route = url.pathname;

  if (request.method === 'GET' && route === '/paper/state') {
    const [state, ticks] = await Promise.all([loadState(), fetchPrices()]);
    if (!ticks) return json({ initialised: Boolean(state), error: 'CoinSpot unreachable right now' }, 502);
    const signals = await currentSignals(ticks);
    if (!state) return json({ initialised: false, prices: ticks, signals, note: 'No ticks collected yet. Press "Run first tick now", or wait for the 5-minute scheduler.' });
    return json({
      initialised: true,
      startedAt: state.startedAt,
      lastTick: state.lastTick,
      tickCount: state.tickCount,
      prices: ticks,
      signals,
      strategies: summarise(state, ticks),
    });
  }

  if (request.method === 'GET' && route === '/paper/history') {
    const coin = (url.searchParams.get('coin') || 'btc') as Coin;
    if (!COINS.includes(coin)) return json({ error: `coin must be one of ${COINS.join(', ')}` }, 400);
    const day = url.searchParams.get('day');
    const data = day ? await loadDay(coin, day) : await loadRecent(coin);
    return json({ coin, day: day ?? 'recent-8-days', ticks: data });
  }

  // Real account balances (read-only key). Gated: requires DASHBOARD_TOKEN to match,
  // because the dashboard URL is public and real holdings must not be.
  if (request.method === 'GET' && route === '/paper/portfolio') {
    if (!coinspotConfigured()) return json({ configured: false, note: 'Add COINSPOT_API_KEY and COINSPOT_API_SECRET (read-only key) in Netlify environment variables, then redeploy.' });
    const gate = process.env.DASHBOARD_TOKEN;
    if (!gate) return json({ configured: true, error: 'DASHBOARD_TOKEN is not set. Refusing to expose real balances on a public URL without it.' }, 403);
    const supplied = request.headers.get('x-dashboard-token') ?? url.searchParams.get('token') ?? '';
    if (supplied !== gate) return json({ configured: true, error: 'Invalid or missing dashboard token.' }, 401);
    const result = await myBalances();
    if (!result.ok) return json({ configured: true, error: result.error }, 502);
    return json({ configured: true, balances: result.data });
  }

  if (request.method === 'POST' && route === '/paper/tick') {
    const result = await runTick();
    return json(result, result.ok ? 200 : 429);
  }

  return json({ error: 'Not found', route }, 404);
}

export const config = {
  path: '/paper/*',
};

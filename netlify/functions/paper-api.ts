// Paper-trading read API + manual controls. Simulated money only — no exchange keys exist.
import { COINS, fetchPrices, loadDay, loadRecent, loadState, runTick, summarise, type Coin } from './lib/paperEngine';

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
    if (!state) return json({ initialised: false, note: 'No ticks collected yet. POST /paper/tick to seed, or wait for the 5-minute scheduler.' });
    if (!ticks) return json({ initialised: true, error: 'CoinSpot unreachable right now' }, 502);
    return json({
      initialised: true,
      startedAt: state.startedAt,
      lastTick: state.lastTick,
      tickCount: state.tickCount,
      prices: ticks,
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

  if (request.method === 'POST' && route === '/paper/tick') {
    const result = await runTick();
    return json(result, result.ok ? 200 : 429);
  }

  return json({ error: 'Not found', route }, 404);
}

export const config = {
  path: '/paper/*',
};

// CoinSpot READ-ONLY API client. Requires COINSPOT_API_KEY + COINSPOT_API_SECRET
// set in Netlify environment variables. A read-only key cannot place, cancel, or
// modify orders — it can only view. No secrets appear in code or in the repo.
import { createHmac } from 'node:crypto';

const RO_BASE = 'https://www.coinspot.com.au/api/v2/ro';

export function coinspotConfigured(): boolean {
  return Boolean(process.env.COINSPOT_API_KEY && process.env.COINSPOT_API_SECRET);
}

async function roPost(path: string, extra: Record<string, unknown> = {}): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const key = process.env.COINSPOT_API_KEY;
  const secret = process.env.COINSPOT_API_SECRET;
  if (!key || !secret) return { ok: false, error: 'CoinSpot API key/secret not configured in environment variables' };

  const body = JSON.stringify({ nonce: Date.now(), ...extra });
  const sign = createHmac('sha512', secret).update(body).digest('hex');
  try {
    const res = await fetch(`${RO_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', key, sign },
      body,
    });
    const text = await res.text();
    let json: unknown;
    try { json = JSON.parse(text); } catch { return { ok: false, error: `CoinSpot returned non-JSON (HTTP ${res.status}): ${text.slice(0, 160)}` }; }
    const status = (json as { status?: string }).status;
    if (!res.ok || status !== 'ok') {
      const msg = (json as { message?: string }).message ?? `HTTP ${res.status}`;
      return { ok: false, error: `CoinSpot API error: ${msg}` };
    }
    return { ok: true, data: json };
  } catch (e) {
    return { ok: false, error: `CoinSpot unreachable: ${String(e)}` };
  }
}

export async function myBalances() {
  return roPost('/my/balances');
}

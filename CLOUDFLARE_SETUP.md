# Cloudflare Worker Setup

The Cloudflare Worker runs on a free 1-minute cron (1,440 requests/day vs the 100,000 free daily limit).
It fetches prices + CoinGecko market data, computes enriched signals, and notifies the Netlify paper engine.

## One-time setup (takes about 5 minutes)

### 1. Install Wrangler CLI

```bash
npm install -g wrangler
wrangler login
```

### 2. Create the KV namespace

```bash
wrangler kv:namespace create PAPER_KV
```

Copy the `id` it prints, then paste it into `wrangler.toml` replacing `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

### 3. Set your Netlify tick URL as a secret

```bash
wrangler secret put NETLIFY_TICK_URL
# When prompted, enter: https://your-site.netlify.app/paper/tick
```

### 4. Deploy

```bash
wrangler deploy
```

That's it. The cron starts firing every minute immediately after deploy.

## What it costs

Nothing. Cloudflare's free tier includes:
- 100,000 Worker requests per day (you use 1,440)
- 1 GB KV storage, 100,000 KV reads/day, 1,000 KV writes/day
- Scheduled triggers at any cron frequency

## What data it collects every minute

- CoinSpot live bid/ask for all 10 tracked coins
- CoinGecko: 1h, 24h, 7d price momentum; 24h volume; market cap; ATH distance; 7-day hourly sparkline (168 data points)
- Fear & Greed Index (alternative.me, cached 5 min)
- CoinGecko trending coins list (cached 5 min)

From this it computes a composite score per coin and sends the top signals to Netlify which then executes the paper strategies.

## Viewing the Worker's data directly

After deploy, hit your Worker URL:
- `https://scarlett-paper-collector.YOUR_SUBDOMAIN.workers.dev/signals` — current ranked signals
- `https://scarlett-paper-collector.YOUR_SUBDOMAIN.workers.dev/latest` — full enriched tick
- `https://scarlett-paper-collector.YOUR_SUBDOMAIN.workers.dev/history?coin=btc` — 24h of 1-min BTC data

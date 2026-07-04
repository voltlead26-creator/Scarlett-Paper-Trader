// Scheduled paper-trading tick — runs every 5 minutes on Netlify's scheduler.
// Simulated money only. This function holds no exchange credentials.
import { runTick } from './lib/paperEngine';

export default async function handler() {
  const result = await runTick();
  console.log('[paper-collector]', result.detail);
  return new Response(JSON.stringify(result), {
    headers: { 'content-type': 'application/json' },
  });
}

export const config = {
  schedule: '*/5 * * * *',
};

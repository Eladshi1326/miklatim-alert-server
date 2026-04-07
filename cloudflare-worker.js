/**
 * Cloudflare Worker - Oref API Proxy
 *
 * Forwards requests to Pikud HaOref alerts API.
 * Deploy this on Cloudflare Workers (free tier).
 *
 * Setup:
 * 1. Go to https://dash.cloudflare.com → Workers & Pages → Create
 * 2. Click "Create Worker"
 * 3. Paste this code and click "Deploy"
 * 4. Copy the worker URL (e.g., https://oref-proxy.your-name.workers.dev)
 * 5. Add it as OREF_PROXY_URL environment variable in Railway
 */

export default {
  async fetch(request) {
    const OREF_URL = 'https://www.oref.org.il/WarningMessages/alert/alerts.json';

    try {
      const response = await fetch(OREF_URL, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Referer': 'https://www.oref.org.il/',
          'X-Requested-With': 'XMLHttpRequest',
          'Accept-Language': 'he-IL,he;q=0.9',
        },
      });

      const text = await response.text();

      return new Response(text, {
        status: response.status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
};

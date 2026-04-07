/**
 * Oref API Proxy
 *
 * Simple HTTP proxy that forwards requests to Pikud HaOref alerts API.
 * Runs on Oracle Cloud Free Tier (Israel region) to bypass geo-blocking.
 *
 * Security: Only allows requests with the correct API_SECRET header.
 */

const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3001;
const API_SECRET = process.env.API_SECRET || 'CHANGE_ME_TO_RANDOM_SECRET';
const OREF_URL = 'https://www.oref.org.il/WarningMessages/alert/alerts.json';

function fetchOref() {
  return new Promise((resolve, reject) => {
    const req = https.get(OREF_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.oref.org.il/',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept-Language': 'he-IL,he;q=0.9',
      },
      timeout: 4000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

const server = http.createServer(async (req, res) => {
  // Security: check secret header
  const secret = req.headers['x-api-secret'] || '';
  if (secret !== API_SECRET) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  if (req.url === '/alerts' || req.url === '/') {
    try {
      const result = await fetchOref();
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(result.body);
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  } else if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: Math.floor(process.uptime()) }));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Oref proxy running on port ${PORT}`);
  console.log(`Secret: ${API_SECRET.substring(0, 4)}...`);
});

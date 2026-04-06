/**
 * Miklatim Alert Server v2
 *
 * Polls multiple alert sources for real-time rocket alerts in Israel.
 * When an alert comes in, sends push notifications to all users via Expo Push API.
 *
 * Sources (in priority order):
 * 1. Tzofar REST API (api.tzevaadom.co.il)
 * 2. Pikud HaOref API (oref.org.il) - requires Israeli IP
 *
 * Deploy on Railway / Render / any Node.js host.
 */

const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const http = require('http');

// ==================== CONFIG ====================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

// Alert sources
const TZOFAR_API_URL = 'https://api.tzevaadom.co.il/notifications';
const OREF_API_URL = 'https://www.oref.org.il/WarningMessages/alert/alerts.json';

// Polling interval (2 seconds - fast enough for alerts)
const POLL_INTERVAL_MS = 2000;

// Deduplication: remember alerts for 10 minutes
const DEDUP_TTL_MS = 10 * 60 * 1000;

// ==================== STATE ====================

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const seenAlerts = new Map();
let totalAlertsSent = 0;
let lastPollTime = null;
let activeSources = { tzofar: false, oref: false };
let pollCount = 0;
let errorCount = 0;

// Threat type labels
const THREAT_LABELS = {
  0: '🚀 ירי רקטות וטילים',
  1: '☢️ אירוע רדיולוגי',
  2: '🌍 רעידת אדמה',
  3: '🌊 צונאמי',
  4: '✈️ חדירת כלי טיס עוין',
  5: '☣️ חומרים מסוכנים',
  6: '🔫 חדירת מחבלים',
};

// ==================== LOGGING (minimal) ====================

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ==================== DEDUPLICATION ====================

function isDuplicate(id) {
  if (!id) return false;
  if (seenAlerts.has(id)) return true;
  seenAlerts.set(id, Date.now());
  return false;
}

// Cleanup old entries every 2 minutes
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [id, ts] of seenAlerts) {
    if (now - ts > DEDUP_TTL_MS) {
      seenAlerts.delete(id);
      cleaned++;
    }
  }
}, 120000);

// ==================== PUSH NOTIFICATIONS ====================

async function getAllPushTokens() {
  try {
    let allTokens = [];
    let offset = 0;
    const batchSize = 1000;

    while (true) {
      const { data, error } = await supabase
        .from('users')
        .select('push_token')
        .not('push_token', 'is', null)
        .neq('push_token', '')
        .range(offset, offset + batchSize - 1);

      if (error || !data || data.length === 0) break;
      allTokens = allTokens.concat(data.map(u => u.push_token).filter(Boolean));
      if (data.length < batchSize) break;
      offset += data.length;
    }

    return [...new Set(allTokens)];
  } catch (err) {
    log(`ERROR fetching tokens: ${err.message}`);
    return [];
  }
}

async function sendPushNotifications(tokens, title, body, data = {}) {
  if (!tokens.length) return;

  log(`📤 Sending push to ${tokens.length} users: "${title}" - "${body}"`);

  const BATCH_SIZE = 100;
  for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
    const batch = tokens.slice(i, i + BATCH_SIZE);
    const messages = batch.map(token => ({
      to: token,
      sound: 'default',
      title,
      body,
      data,
      channelId: 'default',
      priority: 'high',
    }));

    try {
      const response = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(messages),
      });
      const result = await response.json();
      const errors = (result.data || []).filter(r => r.status === 'error');
      if (errors.length > 0) {
        log(`  Batch: ${batch.length - errors.length} OK, ${errors.length} errors`);
      }
    } catch (err) {
      log(`  Push batch failed: ${err.message}`);
    }
  }

  totalAlertsSent++;
}

// ==================== ALERT PROCESSING ====================

async function processAlert(alertData) {
  const { notificationId, threat, isDrill, cities, time } = alertData;

  const alertId = notificationId || `alert_${time}_${(cities || []).join('_').substring(0, 50)}`;

  if (isDuplicate(alertId)) return;
  if (isDrill) {
    log(`Drill alert, skipping: ${alertId}`);
    return;
  }

  const threatLabel = THREAT_LABELS[threat] || '⚠️ התרעה';
  const citiesStr = (cities || []).join(', ');

  log(`🚨 ALERT: ${threatLabel} - ${citiesStr}`);

  // Log to Supabase
  try {
    await supabase.from('alert_history').insert({
      notification_id: alertId,
      threat_type: threat || 0,
      cities: cities || [],
      is_drill: false,
      alert_time: time ? new Date(time * 1000).toISOString() : new Date().toISOString(),
    }).then(() => {});
  } catch (_) {}

  // Send push to all users
  const tokens = await getAllPushTokens();
  await sendPushNotifications(tokens, threatLabel, citiesStr || 'היכנס למרחב מוגן!', {
    type: 'rocket_alert',
    notificationId: alertId,
    threat: threat || 0,
    cities: cities || [],
  });
}

// ==================== POLLING SOURCES ====================

/**
 * Poll Tzofar REST API
 */
async function pollTzofar() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    const response = await fetch(TZOFAR_API_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      if (!activeSources.tzofar) return; // Don't spam logs
      activeSources.tzofar = false;
      return;
    }

    const data = await response.json();
    if (!activeSources.tzofar) {
      activeSources.tzofar = true;
      log('✅ Tzofar API connected');
    }

    // Handle response format - could be array or object with notifications
    let alerts = [];
    if (Array.isArray(data)) {
      alerts = data;
    } else if (data.notifications && Array.isArray(data.notifications)) {
      alerts = data.notifications;
    } else if (data.data && Array.isArray(data.data)) {
      alerts = data.data;
    }

    for (const alert of alerts) {
      if (alert.cities && alert.cities.length > 0) {
        await processAlert({
          notificationId: alert.notificationId || alert.id || `tzofar_${Date.now()}`,
          threat: alert.threat ?? 0,
          isDrill: alert.isDrill || false,
          cities: alert.cities || [],
          time: alert.time || Math.floor(Date.now() / 1000),
        });
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') return; // Timeout, silent
    if (activeSources.tzofar) {
      activeSources.tzofar = false;
    }
  }
}

/**
 * Poll Pikud HaOref API (fallback - only works from Israeli IP)
 */
async function pollOref() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    const response = await fetch(OREF_API_URL, {
      headers: {
        'Referer': 'https://www.oref.org.il/',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0',
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      activeSources.oref = false;
      return;
    }

    const text = await response.text();
    if (!text || text.trim() === '' || text.trim() === '[]') {
      // No active alerts - this is normal
      if (!activeSources.oref) {
        activeSources.oref = true;
        log('✅ Oref API connected');
      }
      return;
    }

    if (!activeSources.oref) {
      activeSources.oref = true;
      log('✅ Oref API connected');
    }

    const cleanText = text.replace(/^\uFEFF/, '');
    const alerts = JSON.parse(cleanText);

    if (!Array.isArray(alerts)) return;

    for (const alert of alerts) {
      await processAlert({
        notificationId: alert.notificationId || `oref_${Date.now()}`,
        threat: alert.threat ?? 0,
        isDrill: alert.isDrill || false,
        cities: alert.cities || [],
        time: alert.time || Math.floor(Date.now() / 1000),
      });
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    activeSources.oref = false;
  }
}

// ==================== MAIN POLL LOOP ====================

async function poll() {
  lastPollTime = new Date().toISOString();
  pollCount++;

  // Poll both sources in parallel
  await Promise.allSettled([
    pollTzofar(),
    pollOref(),
  ]);
}

// ==================== HEALTH CHECK SERVER ====================

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'running',
      sources: activeSources,
      pollCount,
      seenAlerts: seenAlerts.size,
      totalAlertsSent,
      lastPoll: lastPollTime,
      uptime: Math.floor(process.uptime()),
    }));
  } else if (req.url === '/test-push') {
    // Manual test endpoint - send test alert to all users
    processAlert({
      notificationId: `test_${Date.now()}`,
      threat: 0,
      isDrill: false,
      cities: ['בדיקה - התעלם'],
      time: Math.floor(Date.now() / 1000),
    }).then(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sent: true }));
    }).catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// ==================== START ====================

function start() {
  log('🚀 Miklatim Alert Server v2 starting...');

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY!');
    process.exit(1);
  }

  log(`Supabase: ${SUPABASE_URL}`);
  log(`Polling interval: ${POLL_INTERVAL_MS}ms`);

  // Start HTTP server
  server.listen(PORT, () => {
    log(`Health server on port ${PORT}`);
  });

  // Start polling loop
  setInterval(poll, POLL_INTERVAL_MS);
  poll(); // First poll immediately

  // Log status every 5 minutes (minimal logging)
  setInterval(() => {
    log(`📊 Status: polls=${pollCount}, alerts=${totalAlertsSent}, sources=${JSON.stringify(activeSources)}, seen=${seenAlerts.size}`);
  }, 300000);

  // Graceful shutdown
  process.on('SIGTERM', () => {
    log('Shutting down...');
    server.close();
    process.exit(0);
  });
}

start();

/**
 * Miklatim Alert Server
 *
 * Connects to Tzofar (צבע אדום) WebSocket for real-time rocket alerts.
 * When an alert comes in, sends push notifications to all users via Expo Push API.
 * Falls back to polling Pikud HaOref API if WebSocket disconnects.
 *
 * Deploy on Railway / Render / any Node.js host.
 */

const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

// ==================== CONFIG ====================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY; // Use service role key (server-side)
const TZOFAR_WS_URL = 'wss://ws.tzevaadom.co.il/socket?platform=ANDROID';
const OREF_API_URL = 'https://www.oref.org.il/WarningMessages/alert/alerts.json';
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

// Reconnection settings
const INITIAL_RECONNECT_MS = 5000;
const MAX_RECONNECT_MS = 60000;
const KEEPALIVE_MS = 30000;

// Deduplication: remember alerts for 5 minutes
const DEDUP_TTL_MS = 5 * 60 * 1000;

// ==================== STATE ====================

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
let ws = null;
let reconnectMs = INITIAL_RECONNECT_MS;
let keepaliveInterval = null;
let fallbackInterval = null;
let usingFallback = false;

// Dedup: store seen notification IDs with timestamps
const seenAlerts = new Map();

// Threat type labels in Hebrew
const THREAT_LABELS = {
  0: '🚀 ירי רקטות וטילים',
  1: '☢️ אירוע רדיולוגי',
  2: '🌍 רעידת אדמה',
  3: '🌊 צונאמי',
  4: '✈️ חדירת כלי טיס עוין',
  5: '☣️ חומרים מסוכנים',
  6: '🔫 חדירת מחבלים',
};

// ==================== LOGGING ====================

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function logError(msg, err) {
  console.error(`[${new Date().toISOString()}] ERROR: ${msg}`, err?.message || err || '');
}

// ==================== DEDUPLICATION ====================

function isDuplicate(notificationId) {
  if (!notificationId) return false;
  if (seenAlerts.has(notificationId)) return true;
  seenAlerts.set(notificationId, Date.now());
  return false;
}

function cleanupDedup() {
  const now = Date.now();
  for (const [id, timestamp] of seenAlerts) {
    if (now - timestamp > DEDUP_TTL_MS) {
      seenAlerts.delete(id);
    }
  }
}

// Run cleanup every minute
setInterval(cleanupDedup, 60000);

// ==================== PUSH NOTIFICATIONS ====================

/**
 * Get all push tokens from Supabase
 */
async function getAllPushTokens() {
  try {
    let allTokens = [];
    let offset = 0;
    const batchSize = 1000;
    let hasMore = true;

    while (hasMore) {
      const { data, error } = await supabase
        .from('users')
        .select('push_token')
        .not('push_token', 'is', null)
        .neq('push_token', '')
        .range(offset, offset + batchSize - 1);

      if (error) {
        logError('Failed to fetch push tokens', error);
        return allTokens;
      }

      if (data && data.length > 0) {
        allTokens = allTokens.concat(data.map(u => u.push_token).filter(Boolean));
        offset += data.length;
        hasMore = data.length === batchSize;
      } else {
        hasMore = false;
      }
    }

    return [...new Set(allTokens)]; // Remove duplicates
  } catch (err) {
    logError('getAllPushTokens failed', err);
    return [];
  }
}

/**
 * Send push notifications via Expo Push API
 * Sends in batches of 100 (Expo limit)
 */
async function sendPushNotifications(tokens, title, body, data = {}) {
  if (!tokens.length) {
    log('No tokens to send to');
    return;
  }

  log(`Sending push to ${tokens.length} users: "${title}"`);

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
      // Android specific - high priority for immediate delivery
      _contentAvailable: true,
    }));

    try {
      const response = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Accept-encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(messages),
      });

      const result = await response.json();
      const errors = (result.data || []).filter(r => r.status === 'error');
      if (errors.length > 0) {
        log(`  Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length - errors.length} OK, ${errors.length} errors`);
        errors.slice(0, 3).forEach(e => log(`    Error: ${e.message}`));
      } else {
        log(`  Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} sent OK`);
      }
    } catch (err) {
      logError(`Push batch ${Math.floor(i / BATCH_SIZE) + 1} failed`, err);
    }
  }
}

// ==================== ALERT PROCESSING ====================

/**
 * Process an incoming alert and send push notifications
 */
async function processAlert(alertData) {
  try {
    const { notificationId, threat, isDrill, cities, time } = alertData;

    // Dedup check
    if (isDuplicate(notificationId)) {
      log(`Duplicate alert ${notificationId}, skipping`);
      return;
    }

    // Skip drills (optional - you might want to include them)
    if (isDrill) {
      log(`Drill alert ${notificationId}, skipping`);
      return;
    }

    const threatLabel = THREAT_LABELS[threat] || `⚠️ התרעה (סוג ${threat})`;
    const citiesStr = (cities || []).join(', ');
    const title = threatLabel;
    const body = citiesStr || 'התרעה באזורך - היכנס למרחב מוגן!';

    log(`🚨 ALERT: ${title} - ${citiesStr}`);

    // Log to Supabase for history
    try {
      await supabase.from('alert_history').insert({
        notification_id: notificationId,
        threat_type: threat,
        cities: cities || [],
        is_drill: isDrill || false,
        alert_time: time ? new Date(time * 1000).toISOString() : new Date().toISOString(),
      });
    } catch (dbErr) {
      // Don't fail if logging fails - the push is more important
      logError('Failed to log alert to DB', dbErr);
    }

    // Get all push tokens and send
    const tokens = await getAllPushTokens();
    await sendPushNotifications(tokens, title, body, {
      type: 'rocket_alert',
      notificationId,
      threat,
      cities: cities || [],
    });
  } catch (err) {
    logError('processAlert failed', err);
  }
}

// ==================== TZOFAR WEBSOCKET ====================

function connectWebSocket() {
  log(`Connecting to Tzofar WebSocket: ${TZOFAR_WS_URL}`);

  try {
    ws = new WebSocket(TZOFAR_WS_URL, {
      headers: {
        'User-Agent': 'Miklatim-AlertServer/1.0',
      },
    });

    ws.on('open', () => {
      log('✅ WebSocket connected to Tzofar');
      reconnectMs = INITIAL_RECONNECT_MS;

      // Stop fallback polling if it was running
      if (fallbackInterval) {
        clearInterval(fallbackInterval);
        fallbackInterval = null;
        usingFallback = false;
        log('Stopped fallback polling (WebSocket reconnected)');
      }

      // Start keepalive pings
      if (keepaliveInterval) clearInterval(keepaliveInterval);
      keepaliveInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      }, KEEPALIVE_MS);
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        log(`WebSocket message: ${JSON.stringify(msg).substring(0, 200)}`);

        // Tzofar sends different message types
        // ALERT type contains the actual rocket alerts
        if (msg.type === 'ALERT' && msg.data) {
          processAlert(msg.data);
        } else if (msg.cities && Array.isArray(msg.cities)) {
          // Direct alert format (some versions send this)
          processAlert(msg);
        } else if (msg.type === 'SYSTEM_MESSAGE') {
          log(`System message: ${msg.data?.text || JSON.stringify(msg.data)}`);
          // Optionally send early warnings / all-clear notifications
          if (msg.data?.text) {
            handleSystemMessage(msg.data.text);
          }
        }
      } catch (parseErr) {
        log(`Non-JSON message: ${data.toString().substring(0, 100)}`);
      }
    });

    ws.on('close', (code, reason) => {
      log(`WebSocket closed: code=${code}, reason=${reason || 'none'}`);
      cleanup();
      scheduleReconnect();
    });

    ws.on('error', (err) => {
      logError('WebSocket error', err);
      cleanup();
      scheduleReconnect();
    });

    ws.on('pong', () => {
      // Keepalive pong received - connection is alive
    });

  } catch (err) {
    logError('Failed to create WebSocket', err);
    scheduleReconnect();
  }
}

function cleanup() {
  if (keepaliveInterval) {
    clearInterval(keepaliveInterval);
    keepaliveInterval = null;
  }
}

function scheduleReconnect() {
  log(`Reconnecting in ${reconnectMs / 1000}s...`);

  // Start fallback polling if not already running
  if (!usingFallback) {
    startFallbackPolling();
  }

  setTimeout(() => {
    reconnectMs = Math.min(reconnectMs * 2, MAX_RECONNECT_MS);
    connectWebSocket();
  }, reconnectMs);
}

// ==================== SYSTEM MESSAGES ====================

async function handleSystemMessage(text) {
  // Early warning: "בדקות הקרובות ייתכן ויופעלו התרעות"
  // All clear: "האירוע הסתיים באזורים"
  if (text.includes('ייתכן ויופעלו') || text.includes('הנחיה מקדימה')) {
    log(`⚡ Early warning: ${text}`);
    const tokens = await getAllPushTokens();
    await sendPushNotifications(tokens, '⚡ הנחיה מקדימה', text, {
      type: 'early_warning',
    });
  } else if (text.includes('הסתיים') || text.includes('ירידה למרחב')) {
    log(`✅ All clear: ${text}`);
    // Optionally notify users the event is over
  }
}

// ==================== FALLBACK: PIKUD HAOREF POLLING ====================

let lastOrefAlerts = [];

async function pollOref() {
  try {
    const response = await fetch(OREF_API_URL, {
      headers: {
        'Referer': 'https://www.oref.org.il/',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0',
      },
      timeout: 5000,
    });

    if (!response.ok) {
      // API returns 404 or empty when no alerts
      return;
    }

    const text = await response.text();
    if (!text || text.trim() === '' || text.trim() === '[]') {
      lastOrefAlerts = [];
      return;
    }

    // Remove BOM if present
    const cleanText = text.replace(/^\uFEFF/, '');
    const alerts = JSON.parse(cleanText);

    if (!Array.isArray(alerts) || alerts.length === 0) {
      lastOrefAlerts = [];
      return;
    }

    // Process each alert
    for (const alert of alerts) {
      if (alert.notificationId && !isDuplicate(alert.notificationId)) {
        log(`[FALLBACK] Alert from Oref: ${JSON.stringify(alert).substring(0, 200)}`);
        await processAlert({
          notificationId: alert.notificationId || `oref_${Date.now()}`,
          threat: alert.threat || 0,
          isDrill: alert.isDrill || false,
          cities: alert.cities || [],
          time: alert.time || Math.floor(Date.now() / 1000),
        });
      }
    }

    lastOrefAlerts = alerts;
  } catch (err) {
    // Silently fail - this is a fallback, and the API might not be reachable outside Israel
    if (err.message && !err.message.includes('ENOTFOUND')) {
      logError('Oref polling error', err);
    }
  }
}

function startFallbackPolling() {
  if (fallbackInterval) return;
  usingFallback = true;
  log('⚠️ Starting fallback polling (Oref API every 3s)');
  fallbackInterval = setInterval(pollOref, 3000);
  pollOref(); // Immediately check once
}

// ==================== HEALTH CHECK HTTP SERVER ====================

const http = require('http');

const PORT = process.env.PORT || 3000;

const healthServer = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    const status = {
      status: 'running',
      websocket: ws?.readyState === WebSocket.OPEN ? 'connected' : 'disconnected',
      fallback: usingFallback ? 'polling' : 'off',
      seenAlerts: seenAlerts.size,
      uptime: Math.floor(process.uptime()),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// ==================== START ====================

function start() {
  log('🚀 Miklatim Alert Server starting...');

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    logError('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables!');
    process.exit(1);
  }

  log(`Supabase URL: ${SUPABASE_URL}`);
  log(`Push endpoint: ${EXPO_PUSH_URL}`);

  // Start HTTP health check server
  healthServer.listen(PORT, () => {
    log(`Health check server on port ${PORT}`);
  });

  // Connect to Tzofar WebSocket
  connectWebSocket();

  // Graceful shutdown
  process.on('SIGTERM', () => {
    log('SIGTERM received, shutting down...');
    if (ws) ws.close();
    if (fallbackInterval) clearInterval(fallbackInterval);
    if (keepaliveInterval) clearInterval(keepaliveInterval);
    healthServer.close();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    log('SIGINT received, shutting down...');
    if (ws) ws.close();
    process.exit(0);
  });
}

start();

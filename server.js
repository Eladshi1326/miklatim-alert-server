/**
 * Miklatim Alert Server v3
 *
 * Polls Tzofar REST API for real-time alerts in Israel.
 * Sends push notifications to admin only (for testing phase).
 * Supports ALL threat types.
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

// Admin user ID - only this user gets alerts during testing
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || '';

// Alert source
const TZOFAR_API_URL = 'https://api.tzevaadom.co.il/notifications';

// Polling interval
const POLL_INTERVAL_MS = 2000;

// Deduplication: remember alerts for 10 minutes
const DEDUP_TTL_MS = 10 * 60 * 1000;

// ==================== STATE ====================

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const seenAlerts = new Map();
let totalAlertsSent = 0;
let lastPollTime = null;
let sourceConnected = false;
let pollCount = 0;

// ALL threat type labels (Tzofar/Pikud HaOref types)
const THREAT_LABELS = {
  0: '🚀 ירי רקטות וטילים',
  1: '☢️ אירוע רדיולוגי',
  2: '🌍 רעידת אדמה',
  3: '🌊 צונאמי',
  4: '✈️ חדירת כלי טיס עוין',
  5: '☣️ חומרים מסוכנים',
  6: '🔫 חדירת מחבלים',
  7: '✈️ חדירת כלי טיס עוין',
  8: '🔥 שריפה',
  9: '🌀 אירוע חומ"ס',
  10: '✅ חזרה לשגרה',
  11: '⚠️ התראה כללית',
  12: '💣 חבלה / פיצוץ',
  13: '🛡️ היערכות',
};

// ==================== LOGGING ====================

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

setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of seenAlerts) {
    if (now - ts > DEDUP_TTL_MS) seenAlerts.delete(id);
  }
}, 120000);

// ==================== PUSH NOTIFICATIONS ====================

/**
 * Get push tokens - admin only during testing phase
 */
async function getTargetPushTokens() {
  try {
    if (ADMIN_USER_ID) {
      // Testing mode: only send to admin
      const { data, error } = await supabase
        .from('users')
        .select('push_token')
        .eq('id', ADMIN_USER_ID)
        .single();

      if (error || !data?.push_token) {
        log(`No token for admin ${ADMIN_USER_ID}`);
        return [];
      }
      return [data.push_token];
    }

    // Production mode: send to all users with tokens
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

  log(`📤 Push to ${tokens.length} user(s): "${title}" - "${body}"`);

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
        log(`  ${batch.length - errors.length} OK, ${errors.length} errors`);
      }
    } catch (err) {
      log(`  Push failed: ${err.message}`);
    }
  }

  totalAlertsSent++;
}

// ==================== ALERT PROCESSING ====================

async function processAlert(alertData) {
  const { notificationId, threat, isDrill, cities, time } = alertData;

  const alertId = notificationId || `alert_${time}_${(cities || []).join('_').substring(0, 50)}`;

  if (isDuplicate(alertId)) return;

  // Don't skip drills - show them too but label them
  const isDrillAlert = isDrill || false;
  const threatLabel = isDrillAlert
    ? `🔔 תרגיל - ${THREAT_LABELS[threat] || 'התרעה'}`
    : (THREAT_LABELS[threat] || '⚠️ התרעה');
  const citiesStr = (cities || []).join(', ');

  log(`🚨 ALERT: ${threatLabel} - ${citiesStr}`);

  // Log to Supabase
  try {
    await supabase.from('alert_history').insert({
      notification_id: alertId,
      threat_type: threat || 0,
      cities: cities || [],
      is_drill: isDrillAlert,
      alert_time: time ? new Date(time * 1000).toISOString() : new Date().toISOString(),
    });
  } catch (_) {}

  // Send push
  const tokens = await getTargetPushTokens();
  await sendPushNotifications(tokens, threatLabel, citiesStr || 'היכנס למרחב מוגן!', {
    type: 'rocket_alert',
    notificationId: alertId,
    threat: threat || 0,
    cities: cities || [],
    isDrill: isDrillAlert,
  });
}

// ==================== POLLING ====================

async function poll() {
  lastPollTime = new Date().toISOString();
  pollCount++;

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
      if (sourceConnected) {
        sourceConnected = false;
        log('⚠️ Tzofar API disconnected');
      }
      return;
    }

    const data = await response.json();
    if (!sourceConnected) {
      sourceConnected = true;
      log('✅ Tzofar API connected');
    }

    // Handle response format
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
    if (err.name !== 'AbortError' && sourceConnected) {
      sourceConnected = false;
    }
  }
}

// ==================== HEALTH CHECK SERVER ====================

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'running',
      version: 3,
      source: sourceConnected ? 'connected' : 'disconnected',
      mode: ADMIN_USER_ID ? 'admin-only' : 'all-users',
      pollCount,
      seenAlerts: seenAlerts.size,
      totalAlertsSent,
      lastPoll: lastPollTime,
      uptime: Math.floor(process.uptime()),
    }));
  } else if (req.url === '/test-push') {
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
  log('🚀 Miklatim Alert Server v3');

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY!');
    process.exit(1);
  }

  log(`Mode: ${ADMIN_USER_ID ? 'ADMIN ONLY (' + ADMIN_USER_ID + ')' : 'ALL USERS'}`);
  log(`Source: Tzofar API (${TZOFAR_API_URL})`);

  server.listen(PORT, () => {
    log(`Health server on port ${PORT}`);
  });

  setInterval(poll, POLL_INTERVAL_MS);
  poll();

  // Status log every 5 minutes
  setInterval(() => {
    log(`📊 polls=${pollCount} alerts=${totalAlertsSent} source=${sourceConnected ? 'OK' : 'DOWN'} seen=${seenAlerts.size}`);
  }, 300000);

  process.on('SIGTERM', () => {
    log('Shutting down...');
    server.close();
    process.exit(0);
  });
}

start();

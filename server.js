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

// Alert sources
const TZOFAR_API_URL = 'https://api.tzevaadom.co.il/notifications';
const OREF_ALERTS_URL = 'https://www.oref.org.il/WarningMessages/alert/alerts.json';
const OREF_HISTORY_URL = 'https://www.oref.org.il/WarningMessages/History/AlertsHistory.json';

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
let orefConnected = false;
let pollCount = 0;
let orefPollCount = 0;

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
  10: '🔴 התרעה מקדימה',
  11: '⚠️ התראה כללית',
  12: '💣 חבלה / פיצוץ',
  13: '🛡️ היערכות',
};

// Special threat types for newsFlash subtypes
const NEWSFLASH_THREAT = 10;
const END_EVENT_THREAT = 99; // custom type for "end of event"

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
  const { notificationId, threat, isDrill, cities, time, description, title } = alertData;

  const alertId = notificationId || `alert_${time}_${(cities || []).join('_').substring(0, 50)}`;

  if (isDuplicate(alertId)) return;

  const isDrillAlert = isDrill || false;
  const citiesStr = (cities || []).join(', ');

  // Determine alert subtype for cat 10 (newsFlash)
  const isEndOfEvent = threat === END_EVENT_THREAT
    || (threat === NEWSFLASH_THREAT && title && (
      title.includes('הסתיים') || title.includes('סיום') || title.includes('חזרה לשגרה')
    ))
    || (description && (
      description.includes('יכולים לצאת') || description.includes('הסתיים')
    ));

  const isEarlyWarning = !isEndOfEvent && (
    threat === NEWSFLASH_THREAT
    || (title && (title.includes('התרעה מקדימה') || title.includes('זיהוי שיגורים')))
    || (description && description.includes('זיהוי שיגורים'))
  );

  // Build push title
  let pushTitle;
  if (isEndOfEvent) {
    pushTitle = isDrillAlert ? '🔔 תרגיל - ✅ סיום אירוע' : '✅ סיום אירוע';
  } else if (isEarlyWarning) {
    pushTitle = isDrillAlert ? '🔔 תרגיל - 🔴 התרעה מקדימה' : '🔴 התרעה מקדימה';
  } else {
    pushTitle = isDrillAlert
      ? `🔔 תרגיל - ${THREAT_LABELS[threat] || 'התרעה'}`
      : (THREAT_LABELS[threat] || '⚠️ התרעה');
  }

  // Build push body
  let pushBody;
  if (isEndOfEvent) {
    pushBody = description || 'האירוע הסתיים. השוהים במרחב המוגן יכולים לצאת.';
    if (citiesStr) pushBody += `\n${citiesStr}`;
  } else if (isEarlyWarning) {
    pushBody = description || 'בעקבות זיהוי שיגורים, צפויות התרעות בדקות הקרובות';
    if (citiesStr) pushBody += `\n\nאזורים: ${citiesStr}`;
  } else {
    pushBody = citiesStr || 'היכנס למרחב מוגן!';
  }

  // Determine notification type for app navigation
  let pushType = 'rocket_alert';
  if (isEndOfEvent) pushType = 'end_of_event';
  else if (isEarlyWarning) pushType = 'early_warning';

  log(`🚨 ALERT [${pushType}]: ${pushTitle} - ${citiesStr.substring(0, 80)}`);

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

  await sendPushNotifications(tokens, pushTitle, pushBody, {
    type: pushType,
    notificationId: alertId,
    threat: threat || 0,
    cities: cities || [],
    isDrill: isDrillAlert,
    isEarlyWarning,
    isEndOfEvent,
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
      const alertTitle = alert.title || alert.name || '';
      const alertDesc = alert.desc || alert.description || alert.body || '';

      // Detect newsFlash / early warning (התרעה מקדימה)
      const isNewsFlash = alert.cat === 10 || alert.category === 10
        || alert.type === 'newsFlash' || alert.type === 'earlyWarning'
        || alertTitle.includes('התרעה מקדימה')
        || alertDesc.includes('התרעה מקדימה')
        || alertDesc.includes('זיהוי שיגורים');

      // Detect end of event (סיום אירוע)
      const isEndEvent = alertTitle.includes('הסתיים') || alertTitle.includes('סיום')
        || alertDesc.includes('יכולים לצאת') || alertDesc.includes('הסתיים')
        || alert.type === 'endOfEvent';

      if (isEndEvent) {
        const areas = alert.cities || alert.areas || [];
        await processAlert({
          notificationId: alert.notificationId || alert.id || `end_${Date.now()}`,
          threat: END_EVENT_THREAT,
          isDrill: alert.isDrill || false,
          cities: areas,
          time: alert.time || Math.floor(Date.now() / 1000),
          title: alertTitle,
          description: alertDesc || 'האירוע הסתיים. ניתן לצאת מהמרחב המוגן.',
        });
      } else if (isNewsFlash) {
        const areas = alert.cities || alert.areas || alert.zones || [];
        const description = alertDesc || 'זוהו שיגורים - היכנסו למרחב מוגן!';
        await processAlert({
          notificationId: alert.notificationId || alert.id || `newsflash_${Date.now()}`,
          threat: NEWSFLASH_THREAT,
          isDrill: alert.isDrill || false,
          cities: areas,
          time: alert.time || Math.floor(Date.now() / 1000),
          title: alertTitle,
          description,
        });
      } else if (alert.cities && alert.cities.length > 0) {
        // Regular alert (missiles, infiltration, etc.)
        await processAlert({
          notificationId: alert.notificationId || alert.id || `tzofar_${Date.now()}`,
          threat: alert.threat ?? 0,
          isDrill: alert.isDrill || false,
          cities: alert.cities || [],
          time: alert.time || Math.floor(Date.now() / 1000),
          title: alertTitle,
          description: alertDesc || undefined,
        });
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError' && sourceConnected) {
      sourceConnected = false;
    }
  }
}

// ==================== OREF API POLLING (for newsFlash / early warnings) ====================

// Pikud HaOref alert category mapping
const OREF_CATEGORY_MAP = {
  1: 0,   // missiles
  2: 1,   // radiologicalEvent
  3: 2,   // earthQuake
  4: 3,   // tsunami
  5: 4,   // hostileAircraftIntrusion
  6: 5,   // hazardousMaterials
  7: 6,   // terroristInfiltration
  10: NEWSFLASH_THREAT, // newsFlash / early warning
  13: NEWSFLASH_THREAT, // newsFlash (history format)
  14: NEWSFLASH_THREAT, // newsFlash (history format alt)
};

async function pollOref() {
  orefPollCount++;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    const response = await fetch(OREF_ALERTS_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.oref.org.il/',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept-Language': 'he-IL,he;q=0.9',
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      if (orefConnected) {
        orefConnected = false;
        log('⚠️ Oref API disconnected (status ' + response.status + ')');
      }
      return;
    }

    // Oref API sometimes returns empty string or BOM characters
    let text = await response.text();
    text = text.replace(/^\uFEFF/, '').trim();

    if (!text || text === '[]' || text === 'null') {
      if (!orefConnected) {
        orefConnected = true;
        log('✅ Oref API connected');
      }
      return;
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      return;
    }

    if (!orefConnected) {
      orefConnected = true;
      log('✅ Oref API connected');
    }

    // Oref returns either a single object or array
    const alerts = Array.isArray(data) ? data : [data];

    for (const alert of alerts) {
      const cat = parseInt(alert.cat || alert.category || '0');
      const threat = OREF_CATEGORY_MAP[cat] ?? 0;
      const isNewsFlash = threat === NEWSFLASH_THREAT;

      // Build cities/areas from Oref format
      const cities = alert.data
        ? (typeof alert.data === 'string' ? alert.data.split(',').map(s => s.trim()) : alert.data)
        : (alert.cities || []);

      if (cities.length === 0 && !isNewsFlash) continue;

      // Use Oref alert ID for dedup (also prevents Tzofar duplicate)
      const alertId = alert.id ? `oref_${alert.id}` : `oref_${cat}_${Date.now()}`;

      const alertTitle = alert.title || '';
      const alertDesc = alert.desc || '';

      // Detect end-of-event: "האירוע הסתיים", "יכולים לצאת"
      const isEndEvent = alertTitle.includes('הסתיים') || alertTitle.includes('סיום')
        || alertDesc.includes('יכולים לצאת') || alertDesc.includes('הסתיים');

      await processAlert({
        notificationId: alertId,
        threat: isEndEvent ? END_EVENT_THREAT : threat,
        isDrill: alert.isDrill || false,
        cities,
        time: Math.floor(Date.now() / 1000),
        title: alertTitle,
        description: alertDesc || alertTitle || (isNewsFlash ? 'התרעה מקדימה' : undefined),
      });
    }
  } catch (err) {
    if (err.name !== 'AbortError' && orefConnected) {
      orefConnected = false;
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
      version: 4,
      tzofar: sourceConnected ? 'connected' : 'disconnected',
      oref: orefConnected ? 'connected' : 'disconnected',
      mode: ADMIN_USER_ID ? 'admin-only' : 'all-users',
      pollCount,
      orefPollCount,
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
  } else if (req.url === '/test-early-warning') {
    processAlert({
      notificationId: `test_ew_${Date.now()}`,
      threat: NEWSFLASH_THREAT,
      isDrill: false,
      cities: ['שפלת יהודה', 'דן', 'ירקון', 'השפלה', 'שרון'],
      time: Math.floor(Date.now() / 1000),
      title: 'התרעה מקדימה',
      description: 'בעקבות זיהוי שיגורים, בדקות הקרובות צפויות להתקבל התרעות',
    }).then(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sent: true, type: 'early_warning' }));
    }).catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });
  } else if (req.url === '/test-end-event') {
    processAlert({
      notificationId: `test_end_${Date.now()}`,
      threat: END_EVENT_THREAT,
      isDrill: false,
      cities: ['תל אביב', 'ראשון לציון', 'חולון'],
      time: Math.floor(Date.now() / 1000),
      title: 'האירוע הסתיים',
      description: 'השוהים במרחב המוגן יכולים לצאת. בעת קבלת הנחיה או התרעה, יש לפעול בהתאם להנחיות פיקוד העורף.',
    }).then(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sent: true, type: 'end_of_event' }));
    }).catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });
  } else if (req.url === '/test-oref') {
    // Debug endpoint - check what Railway sees from Oref API
    (async () => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const r = await fetch(OREF_ALERTS_URL, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json',
            'Referer': 'https://www.oref.org.il/',
            'X-Requested-With': 'XMLHttpRequest',
            'Accept-Language': 'he-IL,he;q=0.9',
          },
          signal: controller.signal,
        });
        clearTimeout(timeout);
        const text = await r.text();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: r.status, contentLength: text.length, body: text.substring(0, 500) }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    })();
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// ==================== START ====================

function start() {
  log('🚀 Miklatim Alert Server v4');

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY!');
    process.exit(1);
  }

  log(`Mode: ${ADMIN_USER_ID ? 'ADMIN ONLY (' + ADMIN_USER_ID + ')' : 'ALL USERS'}`);
  log(`Sources: Tzofar (${TZOFAR_API_URL}) + Oref (${OREF_ALERTS_URL})`);

  server.listen(PORT, () => {
    log(`Health server on port ${PORT}`);
  });

  // Tzofar polling - regular alerts (every 2s)
  setInterval(poll, POLL_INTERVAL_MS);
  poll();

  // Oref polling - newsFlash / early warnings (every 2s)
  setInterval(pollOref, POLL_INTERVAL_MS);
  setTimeout(pollOref, 1000); // stagger by 1s

  // Status log every 5 minutes
  setInterval(() => {
    log(`📊 tzofar=${pollCount} oref=${orefPollCount} alerts=${totalAlertsSent} tzofar=${sourceConnected ? 'OK' : 'DOWN'} oref=${orefConnected ? 'OK' : 'DOWN'} seen=${seenAlerts.size}`);
  }, 300000);

  process.on('SIGTERM', () => {
    log('Shutting down...');
    server.close();
    process.exit(0);
  });
}

start();

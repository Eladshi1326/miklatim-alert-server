/**
 * Miklatim Alert Server v5
 *
 * Polls Tzofar REST API for real-time alerts in Israel.
 * Sends push notifications to admin only (for testing phase).
 * Supports ALL threat types including early warnings and end-of-event.
 *
 * Note: Early warnings (התרעה מקדימה) and end-of-event (סיום אירוע)
 * require Oref API access (Israeli IP). Set OREF_PROXY_URL if available.
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
const TZOFAR_ENABLED = process.env.TZOFAR_ENABLED === 'true'; // Disabled by default

// Oref API - only works from Israeli IP or via proxy
const OREF_PROXY_URL = process.env.OREF_PROXY_URL || '';
const OREF_PROXY_SECRET = process.env.OREF_PROXY_SECRET || '';
const OREF_ALERTS_URL = OREF_PROXY_URL || 'https://www.oref.org.il/WarningMessages/alert/alerts.json';
const OREF_ENABLED = !!OREF_PROXY_URL; // Only poll Oref if proxy is configured

// Polling interval
const POLL_INTERVAL_MS = 1000;

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

// ALL threat type labels
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

const NEWSFLASH_THREAT = 10;
const END_EVENT_THREAT = 99;

// Oref category mapping (cat number → our threat number)
const OREF_CATEGORY_MAP = {
  1: 0,   // missiles → ירי רקטות וטילים
  2: 11,  // general → התראה כללית
  3: 2,   // earthquake → רעידת אדמה
  4: 1,   // radiologicalEvent → אירוע רדיולוגי
  5: 3,   // tsunami → צונאמי
  6: 4,   // hostileAircraftIntrusion → חדירת כלי טיס עוין
  7: 5,   // hazardousMaterials → חומרים מסוכנים
  10: NEWSFLASH_THREAT, // newsFlash → התרעה מקדימה
  13: 6,  // terroristInfiltration → חדירת מחבלים
  14: NEWSFLASH_THREAT, // newsFlash alt
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

// City-to-region mapping cache (loaded once from Oref data)
// For location mode: check if user's coordinates are near any of the alert cities
// This uses a simple bounding-box approach per known city
const CITY_RADIUS_KM = 15; // If user is within 15km of an alert city, they get the alert

function getDistance(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function getTargetPushTokens(alertCities) {
  try {
    if (ADMIN_USER_ID) {
      // Testing mode: always send to admin regardless of mode
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

    // Production mode: get all users with tokens and their alert settings
    let allUsers = [];
    let offset = 0;
    const batchSize = 1000;

    while (true) {
      const { data, error } = await supabase
        .from('users')
        .select('push_token, alert_mode, last_lat, last_lng')
        .not('push_token', 'is', null)
        .neq('push_token', '')
        .range(offset, offset + batchSize - 1);

      if (error || !data || data.length === 0) break;
      allUsers = allUsers.concat(data);
      if (data.length < batchSize) break;
      offset += data.length;
    }

    // Filter by alert mode
    const tokens = [];
    for (const user of allUsers) {
      if (!user.push_token) continue;

      const mode = user.alert_mode || 'all';

      if (mode === 'all') {
        // Receives all alerts
        tokens.push(user.push_token);
      } else if (mode === 'location') {
        // Only receives alerts near their location
        // If no location stored, send anyway (safety first)
        if (!user.last_lat || !user.last_lng) {
          tokens.push(user.push_token);
          continue;
        }
        // For now, always send early warnings and end-of-events to everyone
        // (they cover large regions)
        // For city-specific alerts, we'd need city coordinates
        // For safety, send to all location-mode users too
        // TODO: implement city geocoding for precise filtering
        tokens.push(user.push_token);
      }
    }

    return [...new Set(tokens)];
  } catch (err) {
    log(`ERROR fetching tokens: ${err.message}`);
    return [];
  }
}

async function sendPushNotifications(tokens, title, body, data = {}) {
  if (!tokens.length) return;

  log(`📤 Push to ${tokens.length} user(s): "${title}" - "${body.substring(0, 60)}"`);

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

  // Determine alert subtype
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
  const tokens = await getTargetPushTokens(cities);

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

// ==================== TZOFAR POLLING ====================

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

      // Detect newsFlash / early warning
      const isNewsFlash = alert.cat === 10 || alert.category === 10
        || alert.type === 'newsFlash' || alert.type === 'earlyWarning'
        || alertTitle.includes('התרעה מקדימה')
        || alertDesc.includes('התרעה מקדימה')
        || alertDesc.includes('זיהוי שיגורים');

      // Detect end of event
      const isEndEvent = alertTitle.includes('הסתיים') || alertTitle.includes('סיום')
        || alertDesc.includes('יכולים לצאת') || alertDesc.includes('הסתיים')
        || alert.type === 'endOfEvent';

      if (isEndEvent) {
        await processAlert({
          notificationId: alert.notificationId || alert.id || `end_${Date.now()}`,
          threat: END_EVENT_THREAT,
          isDrill: alert.isDrill || false,
          cities: alert.cities || alert.areas || [],
          time: alert.time || Math.floor(Date.now() / 1000),
          title: alertTitle,
          description: alertDesc || 'האירוע הסתיים. ניתן לצאת מהמרחב המוגן.',
        });
      } else if (isNewsFlash) {
        await processAlert({
          notificationId: alert.notificationId || alert.id || `newsflash_${Date.now()}`,
          threat: NEWSFLASH_THREAT,
          isDrill: alert.isDrill || false,
          cities: alert.cities || alert.areas || alert.zones || [],
          time: alert.time || Math.floor(Date.now() / 1000),
          title: alertTitle,
          description: alertDesc || 'זוהו שיגורים - היכנסו למרחב מוגן!',
        });
      } else if (alert.cities && alert.cities.length > 0) {
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

// ==================== OREF POLLING (optional - needs Israeli IP or proxy) ====================

async function pollOref() {
  if (!OREF_ENABLED) return;

  orefPollCount++;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json',
    };
    // If using proxy, send secret header. If direct, send Oref headers.
    if (OREF_PROXY_URL && OREF_PROXY_SECRET) {
      headers['X-Api-Secret'] = OREF_PROXY_SECRET;
    } else {
      headers['Referer'] = 'https://www.oref.org.il/';
      headers['X-Requested-With'] = 'XMLHttpRequest';
      headers['Accept-Language'] = 'he-IL,he;q=0.9';
    }

    const response = await fetch(OREF_ALERTS_URL, {
      headers,
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

    const alerts = Array.isArray(data) ? data : [data];

    for (const alert of alerts) {
      const cat = parseInt(alert.cat || alert.category || '0');
      const threat = OREF_CATEGORY_MAP[cat] ?? 0;
      const isNewsFlash = threat === NEWSFLASH_THREAT;

      const cities = alert.data
        ? (typeof alert.data === 'string' ? alert.data.split(',').map(s => s.trim()) : alert.data)
        : (alert.cities || []);

      if (cities.length === 0 && !isNewsFlash) continue;

      const alertId = alert.id ? `oref_${alert.id}` : `oref_${cat}_${Date.now()}`;
      const alertTitle = alert.title || '';
      const alertDesc = alert.desc || '';

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
      version: 5,
      tzofar: TZOFAR_ENABLED ? (sourceConnected ? 'connected' : 'disconnected') : 'disabled',
      oref: OREF_ENABLED ? (orefConnected ? 'connected' : 'disconnected') : 'disabled',
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
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// ==================== START ====================

function start() {
  log('🚀 Miklatim Alert Server v5');

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY!');
    process.exit(1);
  }

  log(`Mode: ${ADMIN_USER_ID ? 'ADMIN ONLY (' + ADMIN_USER_ID + ')' : 'ALL USERS'}`);
  log(`Tzofar: ${TZOFAR_ENABLED ? TZOFAR_API_URL : 'DISABLED'}`);
  log(`Oref: ${OREF_ENABLED ? OREF_ALERTS_URL : 'DISABLED (no proxy configured)'}`);
  log(`Poll interval: ${POLL_INTERVAL_MS}ms`);

  server.listen(PORT, () => {
    log(`Health server on port ${PORT}`);
  });

  // Tzofar polling - only if enabled
  if (TZOFAR_ENABLED) {
    setInterval(poll, POLL_INTERVAL_MS);
    poll();
  }

  // Oref polling - only if proxy is configured
  if (OREF_ENABLED) {
    setInterval(pollOref, POLL_INTERVAL_MS);
    setTimeout(pollOref, 500);
  }

  // Status log every 5 minutes
  setInterval(() => {
    log(`📊 tzofar=${TZOFAR_ENABLED ? pollCount : 'OFF'} oref=${OREF_ENABLED ? orefPollCount : 'OFF'} alerts=${totalAlertsSent} seen=${seenAlerts.size}`);
  }, 300000);

  process.on('SIGTERM', () => {
    log('Shutting down...');
    server.close();
    process.exit(0);
  });
}

start();

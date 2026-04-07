#!/bin/bash
# Run this on the Oracle Cloud VM after SSH-ing in
# Usage: bash setup.sh YOUR_SECRET_KEY

API_SECRET=${1:-"CHANGE_ME"}

echo "=== Installing Node.js ==="
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

echo "=== Creating proxy directory ==="
sudo mkdir -p /opt/oref-proxy
sudo chown $USER:$USER /opt/oref-proxy

echo "=== Writing proxy server ==="
cat > /opt/oref-proxy/server.js << 'SERVEREOF'
const http = require('http');
const https = require('https');

const PORT = 3001;
const API_SECRET = process.env.API_SECRET || 'CHANGE_ME';
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
  console.log('Oref proxy running on port ' + PORT);
});
SERVEREOF

echo "=== Creating systemd service ==="
sudo tee /etc/systemd/system/oref-proxy.service > /dev/null << EOF
[Unit]
Description=Oref API Proxy
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=/opt/oref-proxy
Environment=API_SECRET=$API_SECRET
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

echo "=== Starting service ==="
sudo systemctl daemon-reload
sudo systemctl enable oref-proxy
sudo systemctl start oref-proxy

echo "=== Opening firewall ==="
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 3001 -j ACCEPT
sudo netfilter-persistent save 2>/dev/null || sudo iptables-save | sudo tee /etc/iptables/rules.v4 > /dev/null

echo ""
echo "=== DONE ==="
echo "Proxy running on port 3001"
echo "API Secret: $API_SECRET"
echo ""
echo "Test: curl -H 'X-Api-Secret: $API_SECRET' http://localhost:3001/health"
echo ""
echo "Add to Railway:"
echo "  OREF_PROXY_URL = http://YOUR_ORACLE_IP:3001/alerts"
echo "  OREF_PROXY_SECRET = $API_SECRET"

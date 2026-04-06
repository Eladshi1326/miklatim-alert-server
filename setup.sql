-- Create alert history table for logging alerts
CREATE TABLE IF NOT EXISTS alert_history (
  id BIGSERIAL PRIMARY KEY,
  notification_id TEXT UNIQUE,
  threat_type INTEGER DEFAULT 0,
  cities TEXT[] DEFAULT '{}',
  is_drill BOOLEAN DEFAULT false,
  alert_time TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE alert_history ENABLE ROW LEVEL SECURITY;

-- Allow read for all (users can see alert history)
CREATE POLICY "Anyone can read alerts" ON alert_history FOR SELECT USING (true);
-- Allow insert for service role only (server inserts)
CREATE POLICY "Service role can insert alerts" ON alert_history FOR INSERT WITH CHECK (true);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_alert_history_time ON alert_history(alert_time DESC);
CREATE INDEX IF NOT EXISTS idx_alert_history_notification ON alert_history(notification_id);

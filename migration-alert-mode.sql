-- Add alert_mode and location columns to users table
-- alert_mode: 'all' = receive all alerts, 'location' = only alerts near user's location
ALTER TABLE users ADD COLUMN IF NOT EXISTS alert_mode TEXT DEFAULT 'all';
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_lat DOUBLE PRECISION;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_lng DOUBLE PRECISION;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_location_update TIMESTAMPTZ;

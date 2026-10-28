-- 混雑報告（施設ID・区分・受付時刻のみ。個人を識別する情報は持たない）
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  facility_id TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('empty', 'some', 'crowded', 'unknown')),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_created ON reports (created_at);
CREATE INDEX IF NOT EXISTS idx_reports_facility_created ON reports (facility_id, created_at);

-- レート制限用（IPを日替わりソルト付きHMACで不可逆化した値。1時間で削除）
CREATE TABLE IF NOT EXISTS rate_events (
  client_key TEXT NOT NULL,
  facility_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_client_created ON rate_events (client_key, created_at);

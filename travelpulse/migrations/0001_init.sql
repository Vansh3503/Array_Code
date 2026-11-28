-- TravelPulse D1 schema

-- Every accepted location report from the iPhone.
CREATE TABLE IF NOT EXISTS pings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  nonce         TEXT    NOT NULL UNIQUE,         -- replay / duplicate protection
  received_at   INTEGER NOT NULL,                -- server time, ms epoch
  device_ts     INTEGER NOT NULL,                -- phone time, ms epoch
  tz_offset_min INTEGER,                         -- offset parsed from phone timestamp
  lat           REAL    NOT NULL,
  lon           REAL    NOT NULL,
  accuracy_m    REAL,
  battery       INTEGER,
  trigger       TEXT    NOT NULL,
  city          TEXT,
  country       TEXT,
  country_code  TEXT,
  place_ids     TEXT    NOT NULL DEFAULT '[]',   -- JSON array of geofences containing the ping
  timezone      TEXT,
  temp_c        REAL,
  weather_code  INTEGER,
  note          TEXT,
  suspect       INTEGER NOT NULL DEFAULT 0,      -- implausible jump; ignored for events
  is_test       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pings_device_ts ON pings(device_ts);

-- Detected travel events (one ping can produce several).
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ping_id     INTEGER NOT NULL,
  type        TEXT    NOT NULL,
  dedupe_key  TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  headline    TEXT    NOT NULL,
  place_id    TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);

-- Persistent cooldowns: an event key can only fire once per cooldown window.
CREATE TABLE IF NOT EXISTS event_cooldowns (
  dedupe_key TEXT PRIMARY KEY,
  last_at    INTEGER NOT NULL
);

-- Key/value state: tracker state JSON, settings (tracking_enabled).
CREATE TABLE IF NOT EXISTS kv_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- WhatsApp delivery log. Phone numbers are NOT stored, only recipient labels.
CREATE TABLE IF NOT EXISTS outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ping_id         INTEGER,
  recipient_label TEXT    NOT NULL,
  body            TEXT    NOT NULL,
  params          TEXT    NOT NULL,
  mode            TEXT    NOT NULL,
  status          TEXT    NOT NULL,   -- dry_run | sent | delivered | read | failed | retry
  wamid           TEXT,
  error           TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  is_emergency    INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status, created_at);
CREATE INDEX IF NOT EXISTS idx_outbox_wamid ON outbox(wamid);

CREATE TABLE monitor_configuration (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  schema_version INTEGER NOT NULL,
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  config_fingerprint TEXT NOT NULL,
  target_count INTEGER NOT NULL CHECK (target_count >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE monitor_target_state (
  target_id TEXT PRIMARY KEY,
  target_url TEXT NOT NULL,
  config_fingerprint TEXT NOT NULL,
  active_incident_id TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  consecutive_successes INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_successes >= 0),
  last_failure_at TEXT,
  last_failure_kind TEXT CHECK (
    last_failure_kind IS NULL OR last_failure_kind IN ('http', 'network')
  ),
  last_failure_status INTEGER,
  last_observation_at TEXT,
  last_probe_error_code TEXT,
  last_probe_status INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE monitor_incident (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  target_url TEXT NOT NULL,
  config_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  failure_kind TEXT NOT NULL CHECK (failure_kind IN ('http', 'network')),
  error_code TEXT,
  first_status INTEGER,
  latest_status INTEGER,
  latest_signal TEXT NOT NULL CHECK (latest_signal IN ('cloudflare-analytics', 'probe')),
  request_count INTEGER,
  failure_threshold INTEGER NOT NULL CHECK (failure_threshold > 0),
  recovery_threshold INTEGER NOT NULL CHECK (recovery_threshold > 0),
  first_observed_at TEXT NOT NULL,
  last_failure_at TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution_reason TEXT CHECK (
    resolution_reason IS NULL OR resolution_reason IN (
      'configuration-changed',
      'configuration-removed',
      'recovered'
    )
  )
);

CREATE UNIQUE INDEX monitor_incident_one_open_per_target
  ON monitor_incident (target_id)
  WHERE status = 'open';

CREATE INDEX monitor_incident_recency
  ON monitor_incident (opened_at DESC);

CREATE TABLE monitor_signal (
  fingerprint TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  target_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  status INTEGER,
  request_count INTEGER,
  recorded_at TEXT NOT NULL
);

CREATE INDEX monitor_signal_retention
  ON monitor_signal (recorded_at);

CREATE TABLE monitor_outbox (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  transition TEXT NOT NULL CHECK (transition IN ('opened', 'resolved')),
  event_json TEXT NOT NULL CHECK (json_valid(event_json)),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at TEXT NOT NULL,
  next_attempt_at TEXT NOT NULL,
  last_attempt_at TEXT,
  last_error_code TEXT,
  delivered_at TEXT,
  UNIQUE (incident_id, transition),
  FOREIGN KEY (incident_id) REFERENCES monitor_incident(id) ON DELETE CASCADE
);

CREATE INDEX monitor_outbox_due
  ON monitor_outbox (delivered_at, next_attempt_at, created_at);

CREATE TABLE monitor_incident_action (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (
    action IN ('acknowledged', 'snoozed', 'dismissed')
  ),
  note TEXT CHECK (
    note IS NULL OR length(note) BETWEEN 1 AND 1024
  ),
  snoozed_until TEXT,
  created_at TEXT NOT NULL,
  CHECK (
    (action = 'snoozed' AND snoozed_until IS NOT NULL)
    OR (action <> 'snoozed' AND snoozed_until IS NULL)
  ),
  FOREIGN KEY (incident_id) REFERENCES monitor_incident(id) ON DELETE CASCADE
);

CREATE INDEX monitor_incident_action_history
  ON monitor_incident_action (incident_id, created_at, id);

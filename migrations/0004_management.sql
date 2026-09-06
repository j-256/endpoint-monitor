ALTER TABLE monitor_incident ADD COLUMN revision INTEGER NOT NULL DEFAULT 1
  CHECK (revision > 0 AND revision <= 9007199254740991);

CREATE TRIGGER monitor_incident_revision AFTER UPDATE ON monitor_incident
WHEN NEW.revision = OLD.revision
BEGIN
  UPDATE monitor_incident SET revision = OLD.revision + 1 WHERE id = NEW.id;
END;

CREATE TRIGGER monitor_incident_action_revision AFTER INSERT ON monitor_incident_action
BEGIN
  UPDATE monitor_incident SET revision = revision + 1 WHERE id = NEW.incident_id;
END;

CREATE INDEX monitor_incident_management_page ON monitor_incident (status, opened_at DESC, id);
CREATE INDEX monitor_incident_management_all_page ON monitor_incident (opened_at DESC, id);
CREATE INDEX monitor_incident_target_page ON monitor_incident (target_id, opened_at DESC, id);

CREATE TABLE monitor_management_operation (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  credential_revision INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('configuration', 'triage')),
  input_json TEXT CHECK (input_json IS NULL OR json_valid(input_json)),
  preview_json TEXT NOT NULL CHECK (json_valid(preview_json)),
  configuration_revision INTEGER NOT NULL,
  incident_id TEXT,
  incident_revision INTEGER,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  retain_until TEXT NOT NULL,
  acceptance_id TEXT UNIQUE,
  applied_at TEXT,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  CHECK ((acceptance_id IS NULL AND applied_at IS NULL AND result_json IS NULL)
    OR (acceptance_id IS NOT NULL AND applied_at IS NOT NULL AND result_json IS NOT NULL))
);

CREATE INDEX monitor_management_retention ON monitor_management_operation (retain_until);
CREATE INDEX monitor_management_workspace ON monitor_management_operation (workspace_id, applied_at);

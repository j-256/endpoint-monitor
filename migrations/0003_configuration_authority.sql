ALTER TABLE monitor_configuration ADD COLUMN revision INTEGER NOT NULL DEFAULT 1
  CHECK (revision BETWEEN 1 AND 9007199254740991);
ALTER TABLE monitor_configuration ADD COLUMN updated_by TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE monitor_configuration ADD COLUMN updated_workspace TEXT NOT NULL DEFAULT 'operator';

CREATE TABLE monitor_configuration_change (
  revision INTEGER PRIMARY KEY,
  config_fingerprint TEXT NOT NULL,
  target_count INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  updated_workspace TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO monitor_configuration_change
  SELECT revision, config_fingerprint, target_count, updated_by, updated_workspace, updated_at
  FROM monitor_configuration;

CREATE TRIGGER monitor_configuration_revision_guard
BEFORE UPDATE ON monitor_configuration
WHEN NEW.revision <> OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'configuration-revision-required');
END;

CREATE TRIGGER monitor_configuration_insert_guard
BEFORE INSERT ON monitor_configuration
WHEN NEW.revision <> 1 OR EXISTS (SELECT 1 FROM monitor_configuration)
BEGIN
  SELECT RAISE(ABORT, 'configuration-revision-required');
END;

CREATE TRIGGER monitor_configuration_delete_guard
BEFORE DELETE ON monitor_configuration
BEGIN
  SELECT RAISE(ABORT, 'configuration-deletion-forbidden');
END;

CREATE TRIGGER monitor_configuration_created
AFTER INSERT ON monitor_configuration
BEGIN
  INSERT INTO monitor_configuration_change
    VALUES (NEW.revision, NEW.config_fingerprint, NEW.target_count,
      NEW.updated_by, NEW.updated_workspace, NEW.updated_at);
END;

CREATE TRIGGER monitor_configuration_changed
AFTER UPDATE ON monitor_configuration
BEGIN
  INSERT INTO monitor_configuration_change
    VALUES (NEW.revision, NEW.config_fingerprint, NEW.target_count,
      NEW.updated_by, NEW.updated_workspace, NEW.updated_at);
  -- Retain the latest 100 configuration revisions without storing old target documents
  DELETE FROM monitor_configuration_change WHERE revision <= NEW.revision - 100;
END;

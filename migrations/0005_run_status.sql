CREATE TABLE monitor_run_status (
  slot INTEGER PRIMARY KEY CHECK (slot >= 0 AND slot < 120),
  scheduled_minute INTEGER NOT NULL CHECK (scheduled_minute >= 0),
  snapshot_json TEXT NOT NULL CHECK (
    length(CAST(snapshot_json AS BLOB)) <= 16384
    AND json_valid(snapshot_json)
    AND json_type(snapshot_json, '$.checks') = 'array'
    AND json_array_length(snapshot_json, '$.checks') <= 10
  ),
  CHECK (slot = scheduled_minute % 120)
);

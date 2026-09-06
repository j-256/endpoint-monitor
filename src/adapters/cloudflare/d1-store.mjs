import {
  createIncident,
  createIncidentCloudEvent,
  reduceTargetState,
  resolveIncident,
  suppressIncident,
} from "../../core.mjs"
import {
  RESOLUTION_REASON,
  TRANSITION,
} from "../../constants.mjs"

const READ_TARGET_STATES_SQL = `
  SELECT *
  FROM monitor_target_state
  ORDER BY target_id
`
const READ_CONFIGURATION_SQL = `
  SELECT schema_version, config_json, config_fingerprint, target_count, updated_at,
    revision, updated_by, updated_workspace
  FROM monitor_configuration
  WHERE singleton_id = 1
`
export const INCIDENT_TRIAGE_FIELDS_SQL = `
  (SELECT MIN(action.created_at)
    FROM monitor_incident_action AS action
    WHERE action.incident_id = monitor_incident.id
      AND action.action = 'acknowledged') AS acknowledged_at,
  (SELECT MAX(action.snoozed_until)
    FROM monitor_incident_action AS action
    WHERE action.incident_id = monitor_incident.id
      AND action.action = 'snoozed') AS snoozed_until,
  EXISTS (
    SELECT 1
    FROM monitor_incident_action AS action
    WHERE action.incident_id = monitor_incident.id
      AND action.action = 'dismissed'
  ) AS operator_dismissed
`
const UPSERT_TARGET_STATE_SQL = `
  INSERT INTO monitor_target_state (
    target_id,
    target_url,
    config_fingerprint,
    active_incident_id,
    consecutive_failures,
    consecutive_successes,
    last_failure_at,
    last_failure_kind,
    last_failure_status,
    last_observation_at,
    last_probe_error_code,
    last_probe_status,
    created_at,
    updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (target_id) DO UPDATE SET
    target_url = excluded.target_url,
    config_fingerprint = excluded.config_fingerprint,
    active_incident_id = excluded.active_incident_id,
    consecutive_failures = excluded.consecutive_failures,
    consecutive_successes = excluded.consecutive_successes,
    last_failure_at = excluded.last_failure_at,
    last_failure_kind = excluded.last_failure_kind,
    last_failure_status = excluded.last_failure_status,
    last_observation_at = excluded.last_observation_at,
    last_probe_error_code = excluded.last_probe_error_code,
    last_probe_status = excluded.last_probe_status,
    updated_at = excluded.updated_at
`
const DELETE_TARGET_STATE_SQL = `
  DELETE FROM monitor_target_state
  WHERE target_id = ?
`
const INSERT_INCIDENT_SQL = `
  INSERT INTO monitor_incident (
    id,
    target_id,
    target_url,
    config_fingerprint,
    status,
    failure_kind,
    error_code,
    first_status,
    latest_status,
    latest_signal,
    request_count,
    failure_threshold,
    recovery_threshold,
    first_observed_at,
    last_failure_at,
    opened_at,
    resolved_at,
    resolution_reason
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`
const READ_INCIDENT_SQL = `
  SELECT *
  FROM monitor_incident
  WHERE id = ?
`
const UPDATE_INCIDENT_SQL = `
  UPDATE monitor_incident
  SET status = ?, resolved_at = ?, resolution_reason = ?
  WHERE id = ? AND status = 'open'
`
const INSERT_OUTBOX_SQL = `
  INSERT INTO monitor_outbox (
    id,
    incident_id,
    transition,
    event_json,
    created_at,
    next_attempt_at
  ) VALUES (?, ?, ?, ?, ?, ?)
`
const READ_SIGNAL_SQL = `
  SELECT fingerprint
  FROM monitor_signal
  WHERE fingerprint = ?
`
const INSERT_SIGNAL_SQL = `
  INSERT INTO monitor_signal (
    fingerprint,
    provider,
    target_id,
    observed_at,
    status,
    request_count,
    recorded_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
`
const READ_DUE_OUTBOX_SQL = `
  SELECT candidate.id, candidate.event_json, candidate.attempts
  FROM monitor_outbox AS candidate
  WHERE candidate.delivered_at IS NULL
    AND candidate.next_attempt_at <= ?
    AND (
      candidate.transition = 'opened'
      OR EXISTS (
        SELECT 1
        FROM monitor_outbox AS opened
        WHERE opened.incident_id = candidate.incident_id
          AND opened.transition = 'opened'
          AND opened.delivered_at IS NOT NULL
      )
    )
  ORDER BY candidate.created_at, candidate.id
  LIMIT ?
`
const DELIVER_OUTBOX_SQL = `
  UPDATE monitor_outbox
  SET
    attempts = attempts + 1,
    delivered_at = ?,
    last_attempt_at = ?,
    last_error_code = NULL
  WHERE id = ? AND delivered_at IS NULL
`
const FAIL_OUTBOX_SQL = `
  UPDATE monitor_outbox
  SET
    attempts = attempts + 1,
    last_attempt_at = ?,
    last_error_code = ?,
    next_attempt_at = ?
  WHERE id = ? AND delivered_at IS NULL
`
const READ_OPEN_INCIDENTS_SQL = `
  SELECT monitor_incident.*, ${INCIDENT_TRIAGE_FIELDS_SQL}
  FROM monitor_incident
  WHERE status = 'open'
  ORDER BY opened_at DESC
`
const READ_OPEN_INCIDENTS_WITHOUT_OUTBOX_SQL = `
  SELECT monitor_incident.*, ${INCIDENT_TRIAGE_FIELDS_SQL}
  FROM monitor_incident
  LEFT JOIN monitor_outbox
    ON monitor_outbox.incident_id = monitor_incident.id
    AND monitor_outbox.transition = 'opened'
  WHERE monitor_incident.status = 'open'
    AND monitor_outbox.id IS NULL
  ORDER BY monitor_incident.opened_at, monitor_incident.id
`
const READ_RECENT_INCIDENTS_SQL = `
  SELECT monitor_incident.*, ${INCIDENT_TRIAGE_FIELDS_SQL}
  FROM monitor_incident
  ORDER BY opened_at DESC
  LIMIT ?
`
const READ_PENDING_OUTBOX_COUNT_SQL = `
  SELECT COUNT(*) AS count
  FROM monitor_outbox
  WHERE delivered_at IS NULL
`
const PRUNE_SIGNALS_SQL = `
  DELETE FROM monitor_signal
  WHERE recorded_at < ?
`
const PRUNE_OUTBOX_SQL = `
  DELETE FROM monitor_outbox
  WHERE delivered_at IS NOT NULL AND delivered_at < ?
`
const PRUNE_INCIDENTS_SQL = `
  DELETE FROM monitor_incident
  WHERE status = 'resolved'
    AND resolved_at < ?
    AND NOT EXISTS (
      SELECT 1
      FROM monitor_outbox
      WHERE monitor_outbox.incident_id = monitor_incident.id
        AND monitor_outbox.delivered_at IS NULL
    )
`

function resultRows(result) {
  return Array.isArray(result?.results) ? result.results : []
}

function changedRows(result) {
  return Number(result?.meta?.changes ?? result?.meta?.rows_written ?? 0)
}

function stateFromRow(row) {
  return Object.freeze({
    activeIncidentId: row.active_incident_id,
    configFingerprint: row.config_fingerprint,
    consecutiveFailures: Number(row.consecutive_failures),
    consecutiveSuccesses: Number(row.consecutive_successes),
    lastFailureAt: row.last_failure_at,
    lastFailureKind: row.last_failure_kind,
    lastFailureStatus: row.last_failure_status === null
      ? null
      : Number(row.last_failure_status),
    lastObservationAt: row.last_observation_at,
    lastProbeErrorCode: row.last_probe_error_code,
    lastProbeStatus: row.last_probe_status === null
      ? null
      : Number(row.last_probe_status),
    targetId: row.target_id,
    targetUrl: row.target_url,
  })
}

export function incidentFromRow(row) {
  if (!row) return null
  const operatorDismissed = Number(row.operator_dismissed || 0) === 1
  return Object.freeze({
    acknowledgedAt: row.acknowledged_at || null,
    configFingerprint: row.config_fingerprint,
    errorCode: row.error_code,
    failureKind: row.failure_kind,
    failureThreshold: Number(row.failure_threshold),
    firstObservedAt: row.first_observed_at,
    firstStatus: row.first_status === null ? null : Number(row.first_status),
    id: row.id,
    lastFailureAt: row.last_failure_at,
    latestSignal: row.latest_signal,
    latestStatus: row.latest_status === null ? null : Number(row.latest_status),
    openedAt: row.opened_at,
    recoveryThreshold: Number(row.recovery_threshold),
    requestCount: row.request_count === null ? null : Number(row.request_count),
    resolutionReason: row.resolution_reason
      || (operatorDismissed ? RESOLUTION_REASON.OPERATOR_DISMISSED : null),
    resolvedAt: row.resolved_at,
    snoozedUntil: row.snoozed_until || null,
    status: row.status,
    targetId: row.target_id,
    targetUrl: row.target_url,
  })
}

function upsertStateStatement(db, state, recordedAt) {
  return db.prepare(UPSERT_TARGET_STATE_SQL).bind(
    state.targetId,
    state.targetUrl,
    state.configFingerprint,
    state.activeIncidentId,
    state.consecutiveFailures,
    state.consecutiveSuccesses,
    state.lastFailureAt,
    state.lastFailureKind,
    state.lastFailureStatus,
    state.lastObservationAt,
    state.lastProbeErrorCode,
    state.lastProbeStatus,
    recordedAt,
    recordedAt,
  )
}

function incidentInsertStatement(db, incident) {
  return db.prepare(INSERT_INCIDENT_SQL).bind(
    incident.id,
    incident.targetId,
    incident.targetUrl,
    incident.configFingerprint,
    incident.status,
    incident.failureKind,
    incident.errorCode,
    incident.firstStatus,
    incident.latestStatus,
    incident.latestSignal,
    incident.requestCount,
    incident.failureThreshold,
    incident.recoveryThreshold,
    incident.firstObservedAt,
    incident.lastFailureAt,
    incident.openedAt,
    incident.resolvedAt,
    incident.resolutionReason,
  )
}

function incidentUpdateStatement(db, incident) {
  return db.prepare(UPDATE_INCIDENT_SQL).bind(
    incident.status,
    incident.resolvedAt,
    incident.resolutionReason,
    incident.id,
  )
}

function outboxInsertStatement(db, incident, transition, createdAt) {
  const event = createIncidentCloudEvent(incident, transition)
  const nextAttemptAt = transition === TRANSITION.OPENED
    && Number.isFinite(Date.parse(incident.snoozedUntil))
    && Date.parse(incident.snoozedUntil) > Date.parse(createdAt)
    ? incident.snoozedUntil
    : createdAt
  return db.prepare(INSERT_OUTBOX_SQL).bind(
    event.id,
    incident.id,
    transition,
    JSON.stringify(event),
    createdAt,
    nextAttemptAt,
  )
}

function stateStatements(db, currentState, nextState, recordedAt) {
  if (nextState) return [upsertStateStatement(db, nextState, recordedAt)]
  if (currentState) {
    return [db.prepare(DELETE_TARGET_STATE_SQL).bind(currentState.targetId)]
  }
  return []
}

async function readIncident(db, incidentId) {
  return incidentFromRow(
    await db.prepare(READ_INCIDENT_SQL).bind(incidentId).first(),
  )
}

async function transitionStatements(
  db,
  target,
  observation,
  reduced,
  recordedAt,
  enqueueEvents,
) {
  if (!reduced.transition) return { incident: null, statements: [] }
  if (reduced.transition.kind === TRANSITION.OPENED) {
    const incident = createIncident(
      target,
      observation,
      reduced.transition.incidentId,
      recordedAt,
    )
    return {
      incident,
      statements: [
        incidentInsertStatement(db, incident),
        ...(enqueueEvents
          ? [outboxInsertStatement(db, incident, TRANSITION.OPENED, recordedAt)]
          : []),
      ],
    }
  }
  const open = await readIncident(db, reduced.transition.incidentId)
  if (!open || open.status !== "open") {
    throw new Error("Open incident is unavailable for recovery")
  }
  const incident = resolveIncident(open, recordedAt)
  return {
    incident,
    statements: [
      incidentUpdateStatement(db, incident),
      ...(enqueueEvents
        ? [outboxInsertStatement(db, incident, TRANSITION.RESOLVED, recordedAt)]
        : []),
    ],
  }
}

async function executeStatements(db, statements) {
  if (statements.length === 0) return 0
  const results = await db.batch(statements)
  return results.reduce((total, result) => total + changedRows(result), 0)
}

export async function readTargetStates(db) {
  const result = await db.prepare(READ_TARGET_STATES_SQL).all()
  return resultRows(result).map(stateFromRow)
}

export async function readStoredConfiguration(db) {
  const row = await db.prepare(READ_CONFIGURATION_SQL).first()
  if (!row) return null
  return Object.freeze({
    configFingerprint: row.config_fingerprint,
    configJson: row.config_json,
    revision: Number(row.revision),
    schemaVersion: Number(row.schema_version),
    targetCount: Number(row.target_count),
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    updatedWorkspace: row.updated_workspace,
  })
}

export async function recordObservation(
  db,
  target,
  observation,
  {
    currentState = null,
    enqueueEvents = true,
    incidentId = null,
    recordedAt,
  },
) {
  const reduced = reduceTargetState(currentState, target, observation, incidentId)
  if (!reduced.changed) {
    return Object.freeze({
      changed: false,
      incident: null,
      state: currentState,
      transition: null,
      writes: 0,
    })
  }
  const transition = await transitionStatements(
    db,
    target,
    observation,
    reduced,
    recordedAt,
    enqueueEvents,
  )
  const statements = [
    ...stateStatements(db, currentState, reduced.state, recordedAt),
    ...transition.statements,
  ]
  const writes = await executeStatements(db, statements)
  return Object.freeze({
    changed: writes > 0,
    incident: transition.incident,
    state: reduced.state,
    transition: reduced.transition,
    writes,
  })
}

export async function recordAnalyticsFailure(
  db,
  target,
  observation,
  signal,
  {
    currentState = null,
    enqueueEvents = true,
    incidentId,
    recordedAt,
  },
) {
  if (currentState?.activeIncidentId && currentState.consecutiveSuccesses === 0) {
    return Object.freeze({
      changed: false,
      duplicate: false,
      incident: null,
      state: currentState,
      transition: null,
      writes: 0,
    })
  }
  const duplicate = await db.prepare(READ_SIGNAL_SQL)
    .bind(signal.fingerprint)
    .first()
  if (duplicate) {
    return Object.freeze({
      changed: false,
      duplicate: true,
      incident: null,
      state: currentState,
      transition: null,
      writes: 0,
    })
  }
  const reduced = reduceTargetState(currentState, target, observation, incidentId)
  const transition = await transitionStatements(
    db,
    target,
    observation,
    reduced,
    recordedAt,
    enqueueEvents,
  )
  const statements = [
    db.prepare(INSERT_SIGNAL_SQL).bind(
      signal.fingerprint,
      signal.provider,
      target.id,
      observation.observedAt,
      observation.httpStatus,
      observation.requestCount,
      recordedAt,
    ),
    ...stateStatements(db, currentState, reduced.state, recordedAt),
    ...transition.statements,
  ]
  const writes = await executeStatements(db, statements)
  return Object.freeze({
    changed: writes > 0,
    duplicate: false,
    incident: transition.incident,
    state: reduced.state,
    transition: reduced.transition,
    writes,
  })
}

export async function reconcileTargetConfiguration(db, targets, recordedAt) {
  const configured = new Map(targets.map((target) => [target.id, target]))
  const states = await readTargetStates(db)
  const statements = []
  const suppressed = []
  for (const state of states) {
    const target = configured.get(state.targetId)
    if (target && target.configFingerprint === state.configFingerprint) continue
    if (state.activeIncidentId) {
      const open = await readIncident(db, state.activeIncidentId)
      if (open?.status === "open") {
        const reason = target
          ? RESOLUTION_REASON.CONFIGURATION_CHANGED
          : RESOLUTION_REASON.CONFIGURATION_REMOVED
        const incident = suppressIncident(open, recordedAt, reason)
        statements.push(incidentUpdateStatement(db, incident))
        suppressed.push(incident)
      }
    }
    statements.push(db.prepare(DELETE_TARGET_STATE_SQL).bind(state.targetId))
  }
  const writes = await executeStatements(db, statements)
  return Object.freeze({
    states: states.filter((state) => {
      const target = configured.get(state.targetId)
      return target?.configFingerprint === state.configFingerprint
    }),
    suppressed: Object.freeze(suppressed),
    writes,
  })
}

export async function readDueOutbox(db, attemptedAt, limit) {
  const result = await db.prepare(READ_DUE_OUTBOX_SQL)
    .bind(attemptedAt, limit)
    .all()
  return resultRows(result).map((row) => Object.freeze({
    attempts: Number(row.attempts),
    body: row.event_json,
    id: row.id,
  }))
}

export async function markOutboxDelivered(db, id, attemptedAt) {
  return changedRows(await db.prepare(DELIVER_OUTBOX_SQL).bind(
    attemptedAt,
    attemptedAt,
    id,
  ).run())
}

export async function markOutboxFailed(
  db,
  id,
  attemptedAt,
  errorCode,
  nextAttemptAt,
) {
  return changedRows(await db.prepare(FAIL_OUTBOX_SQL).bind(
    attemptedAt,
    errorCode,
    nextAttemptAt,
    id,
  ).run())
}

export async function enqueueUndeliveredOpenIncidents(db, recordedAt) {
  const result = await db.prepare(READ_OPEN_INCIDENTS_WITHOUT_OUTBOX_SQL).all()
  const incidents = resultRows(result).map(incidentFromRow)
  const writes = await executeStatements(
    db,
    incidents.map((incident) => (
      outboxInsertStatement(db, incident, TRANSITION.OPENED, recordedAt)
    )),
  )
  return Object.freeze({ incidents: Object.freeze(incidents), writes })
}

export async function readMonitorStatus(db, recentLimit = 20) {
  const [states, openResult, recentResult, outboxRow] = await Promise.all([
    readTargetStates(db),
    db.prepare(READ_OPEN_INCIDENTS_SQL).all(),
    db.prepare(READ_RECENT_INCIDENTS_SQL).bind(recentLimit).all(),
    db.prepare(READ_PENDING_OUTBOX_COUNT_SQL).first(),
  ])
  return Object.freeze({
    openIncidents: Object.freeze(resultRows(openResult).map(incidentFromRow)),
    pendingDeliveries: Number(outboxRow?.count || 0),
    recentIncidents: Object.freeze(resultRows(recentResult).map(incidentFromRow)),
    states: Object.freeze(states),
  })
}

export async function pruneMonitorStorage(
  db,
  signalBefore,
  deliveredBefore,
  incidentBefore,
) {
  const results = await db.batch([
    db.prepare(PRUNE_SIGNALS_SQL).bind(signalBefore),
    db.prepare(PRUNE_OUTBOX_SQL).bind(deliveredBefore),
    db.prepare(PRUNE_INCIDENTS_SQL).bind(incidentBefore),
  ])
  return Object.freeze({
    incidents: changedRows(results[2]),
    outbox: changedRows(results[1]),
    signals: changedRows(results[0]),
  })
}

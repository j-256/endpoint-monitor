import {
  INCIDENT_ACTION,
  TRANSITION,
} from "../../constants.mjs"
import {
  createIncidentCloudEvent,
  dismissIncident,
} from "../../core.mjs"
import { CloudflareApi } from "./api.mjs"
import {
  INCIDENT_TRIAGE_FIELDS_SQL,
  incidentFromRow,
} from "./d1-store.mjs"

export const INCIDENT_LIST_LIMIT = Object.freeze({
  default: 20,
  maximum: 100,
  minimum: 1,
})
export const MAXIMUM_INCIDENT_NOTE_BYTES = 1024
export const INCIDENT_HISTORY_LIMIT = 100

const INCIDENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/
const INCIDENT_COLUMNS_SQL = `
  monitor_incident.*,
  ${INCIDENT_TRIAGE_FIELDS_SQL}
`
const LIST_OPEN_INCIDENTS_SQL = `
  SELECT ${INCIDENT_COLUMNS_SQL}
  FROM monitor_incident
  WHERE monitor_incident.status = 'open'
  ORDER BY monitor_incident.opened_at DESC, monitor_incident.id
  LIMIT ?
`
const LIST_ALL_INCIDENTS_SQL = `
  SELECT ${INCIDENT_COLUMNS_SQL}
  FROM monitor_incident
  ORDER BY monitor_incident.opened_at DESC, monitor_incident.id
  LIMIT ?
`
const READ_INCIDENT_SQL = `
  SELECT ${INCIDENT_COLUMNS_SQL}
  FROM monitor_incident
  WHERE monitor_incident.id = ?
`
const READ_ACTIONS_SQL = `
  SELECT id, incident_id, action, note, snoozed_until, created_at
  FROM monitor_incident_action
  WHERE incident_id = ?
  ORDER BY created_at DESC, id DESC
  LIMIT ${INCIDENT_HISTORY_LIMIT + 1}
`
const INSERT_ACTION_SQL = `
  INSERT INTO monitor_incident_action (
    id,
    incident_id,
    action,
    note,
    snoozed_until,
    created_at
  )
  SELECT ?, monitor_incident.id, ?, NULLIF(?, ''), NULLIF(?, ''), ?
  FROM monitor_incident
  WHERE monitor_incident.id = ?
    AND monitor_incident.status = 'open'
`
const DELAY_OPEN_DELIVERY_SQL = `
  UPDATE monitor_outbox
  SET next_attempt_at = CASE
    WHEN next_attempt_at < ? THEN ?
    ELSE next_attempt_at
  END
  WHERE incident_id = ?
    AND transition = 'opened'
    AND delivered_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM monitor_incident_action
      WHERE monitor_incident_action.id = ?
    )
`
const DISMISS_INCIDENT_SQL = `
  UPDATE monitor_incident
  SET status = 'resolved', resolved_at = ?, resolution_reason = NULL
  WHERE id = ?
    AND status = 'open'
    AND EXISTS (
      SELECT 1
      FROM monitor_incident_action
      WHERE monitor_incident_action.id = ?
    )
`
const CLEAR_INCIDENT_STATE_SQL = `
  DELETE FROM monitor_target_state
  WHERE active_incident_id = ?
    AND EXISTS (
      SELECT 1
      FROM monitor_incident_action
      WHERE monitor_incident_action.id = ?
    )
`
const INSERT_RESOLVED_OUTBOX_SQL = `
  INSERT INTO monitor_outbox (
    id,
    incident_id,
    transition,
    event_json,
    created_at,
    next_attempt_at
  )
  SELECT ?, ?, 'resolved', ?, ?, ?
  FROM monitor_incident_action
  WHERE monitor_incident_action.id = ?
    AND EXISTS (
      SELECT 1
      FROM monitor_outbox AS opened
      WHERE opened.incident_id = ?
        AND opened.transition = 'opened'
    )
`

export class IncidentOperatorError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

function changedRows(result) {
  return Number(result?.meta?.changes ?? result?.meta?.rows_written ?? 0)
}

function resultRows(result) {
  return Array.isArray(result?.results) ? result.results : []
}

function incidentId(value) {
  if (typeof value !== "string" || !INCIDENT_ID_PATTERN.test(value)) {
    throw new TypeError("Incident ID is invalid")
  }
  return value
}

function incidentNote(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError("Incident note must not be empty")
  }
  const normalized = value.trim()
  if (/\p{Cc}/u.test(normalized)) {
    throw new TypeError("Incident note must not contain control characters")
  }
  if (new TextEncoder().encode(normalized).byteLength > MAXIMUM_INCIDENT_NOTE_BYTES) {
    throw new TypeError(
      `Incident note must not exceed ${MAXIMUM_INCIDENT_NOTE_BYTES} bytes`,
    )
  }
  return normalized
}

function futureTimestamp(value, now) {
  const milliseconds = typeof value === "string" && RFC3339_PATTERN.test(value)
    ? Date.parse(value)
    : Number.NaN
  if (!Number.isFinite(milliseconds) || milliseconds <= Date.parse(now)) {
    throw new TypeError("Snooze deadline must be a future timestamp")
  }
  return new Date(milliseconds).toISOString()
}

function actionFromRow(row) {
  return Object.freeze({
    action: row.action,
    createdAt: row.created_at,
    id: row.id,
    incidentId: row.incident_id,
    note: row.note,
    snoozedUntil: row.snoozed_until,
  })
}

function incidentRecord(incident, actions = [], historyTruncated = false) {
  return Object.freeze({
    ...incident,
    actions: Object.freeze(actions),
    historyTruncated,
  })
}

export function normalizeIncidentAction(action, { note = null, until = null } = {}, now) {
  if (!Object.values(INCIDENT_ACTION).includes(action)) throw new TypeError("Incident action is invalid")
  if (action !== INCIDENT_ACTION.SNOOZED && until !== null) throw new TypeError("Only snooze accepts a deadline")
  return { action, note: incidentNote(note),
    until: action === INCIDENT_ACTION.SNOOZED ? futureTimestamp(until, now) : null }
}

export function incidentActionStatements(incident, input, createdAt, actionId, guard = null) {
  const id = incidentId(incident.id)
  const normalized = normalizeIncidentAction(input.action, input, createdAt)
  const statements = [{
    sql: INSERT_ACTION_SQL + (guard ? ` AND (${guard.sql})` : ""),
    params: [actionId, normalized.action, normalized.note || "", normalized.until || "", createdAt, id,
      ...(guard?.params ?? [])],
  }]
  if (normalized.action === INCIDENT_ACTION.SNOOZED) {
    statements.push({ sql: DELAY_OPEN_DELIVERY_SQL, params: [normalized.until, normalized.until, id, actionId] })
  }
  if (normalized.action === INCIDENT_ACTION.DISMISSED) {
    const event = createIncidentCloudEvent(dismissIncident(incident, createdAt), TRANSITION.RESOLVED)
    statements.push(
      { sql: DISMISS_INCIDENT_SQL, params: [createdAt, id, actionId] },
      { sql: CLEAR_INCIDENT_STATE_SQL, params: [id, actionId] },
      { sql: INSERT_RESOLVED_OUTBOX_SQL,
        params: [event.id, id, JSON.stringify(event), createdAt, createdAt, actionId, id] },
    )
  }
  return statements
}

export class CloudflareIncidentOperator {
  constructor({
    accountId,
    apiToken,
    clock = Date.now,
    databaseId,
    fetchImpl = globalThis.fetch,
    queryImpl = null,
    randomUUID = () => crypto.randomUUID(),
  }) {
    if (typeof clock !== "function" || typeof randomUUID !== "function") {
      throw new TypeError("Incident operator dependencies are invalid")
    }
    this.api = queryImpl ? null : new CloudflareApi({ accountId, apiToken, fetchImpl })
    this.queryImpl = queryImpl
    this.clock = clock
    this.databaseId = databaseId
    this.randomUUID = randomUUID
  }

  timestamp() {
    const value = Number(this.clock())
    if (!Number.isFinite(value)) {
      throw new TypeError("Incident operation time is invalid")
    }
    return new Date(value).toISOString()
  }

  async query(queries) {
    const batch = Array.isArray(queries) ? queries : [queries]
    try {
      if (this.queryImpl) return await this.queryImpl(batch)
      return await this.api.queryD1(
        this.databaseId,
        batch.length === 1 ? batch[0] : { batch },
      )
    } catch {
      throw new IncidentOperatorError(
        "Cloudflare D1 incident request failed",
        "incident-request-failed",
      )
    }
  }

  async mutationFailed(id) {
    await this.requireOpen(id)
    throw new IncidentOperatorError(
      `Incident mutation was not recorded: ${id}`,
      "incident-mutation-failed",
    )
  }

  async list({ all = false, limit = INCIDENT_LIST_LIMIT.default } = {}) {
    if (typeof all !== "boolean"
      || !Number.isInteger(limit)
      || limit < INCIDENT_LIST_LIMIT.minimum
      || limit > INCIDENT_LIST_LIMIT.maximum) {
      throw new TypeError("Incident list options are invalid")
    }
    const [result] = await this.query({
      params: [String(limit)],
      sql: all ? LIST_ALL_INCIDENTS_SQL : LIST_OPEN_INCIDENTS_SQL,
    })
    return Object.freeze(resultRows(result).map(incidentFromRow))
  }

  async show(value) {
    const id = incidentId(value)
    const [incidentResult, actionResult] = await this.query([{
      params: [id],
      sql: READ_INCIDENT_SQL,
    }, {
      params: [id],
      sql: READ_ACTIONS_SQL,
    }])
    const incident = incidentFromRow(resultRows(incidentResult)[0])
    if (!incident) {
      throw new IncidentOperatorError(
        `Incident not found: ${id}`,
        "incident-not-found",
      )
    }
    return incidentRecord(
      incident,
      resultRows(actionResult).slice(0, INCIDENT_HISTORY_LIMIT).map(actionFromRow).reverse(),
      resultRows(actionResult).length > INCIDENT_HISTORY_LIMIT,
    )
  }

  async requireOpen(value) {
    const incident = await this.show(value)
    if (incident.status !== "open") {
      throw new IncidentOperatorError(
        `Incident is not open: ${incident.id}`,
        "incident-not-open",
      )
    }
    return incident
  }

  async perform(value, action, options = {}) {
    const open = await this.requireOpen(value)
    const actionId = this.randomUUID()
    const createdAt = this.timestamp()
    const [result] = await this.query(incidentActionStatements(open, { ...options, action }, createdAt, actionId))
    if (changedRows(result) !== 1) await this.mutationFailed(open.id)
    return this.show(open.id)
  }

  async acknowledge(value, { note = null } = {}) {
    return this.perform(value, INCIDENT_ACTION.ACKNOWLEDGED, { note })
  }

  async snooze(value, { note = null, until } = {}) {
    return this.perform(value, INCIDENT_ACTION.SNOOZED, { note, until })
  }

  async dismiss(value, { note = null } = {}) {
    return this.perform(value, INCIDENT_ACTION.DISMISSED, { note })
  }
}

import { INCIDENT_ACTION } from "../../constants.mjs"
import {
  d1ConfigurationQuery, prepareConfigurationWrite, reviewConfiguration,
} from "./configuration-authority.mjs"
import { incidentActionStatements, normalizeIncidentAction } from "./operator-incidents.mjs"
import { readConfiguration, readManagementIncident } from "./management-read.mjs"
import { MANAGEMENT_LIMITS, ManagementError, authorizeManagement } from "./management-contract.mjs"

export const MANAGEMENT_OPERATION_KIND = Object.freeze({ configuration: "configuration", triage: "triage" })
const OPEN = "open"

function conflict(message = "Reviewed state changed; review the operation again") {
  return new ManagementError("conflict", 409, message)
}

function operationRecord(row, now) {
  return {
    id: row.id, kind: row.kind, workspaceId: row.workspace_id, actorId: row.actor_id,
    credentialId: row.credential_id, credentialRevision: row.credential_revision,
    createdAt: row.created_at, expiresAt: row.expires_at, appliedAt: row.applied_at,
    retainUntil: row.retain_until,
    status: row.applied_at ? "applied" : row.expires_at <= now ? "expired" : "reviewed",
    preview: JSON.parse(row.preview_json), result: row.result_json ? JSON.parse(row.result_json) : null,
  }
}

async function operationRow(db, principal, input) {
  const row = await db.prepare(`SELECT * FROM monitor_management_operation
    WHERE id = ? AND workspace_id = ? AND actor_id = ? AND credential_id = ? AND credential_revision = ?`)
    .bind(input.planId, input.workspaceId, input.actorId, principal.id, principal.revision).first()
  if (!row) throw new ManagementError("not_found", 404, "Operation not found")
  return row
}

export async function readManagementOperation(db, principal, input, now) {
  return operationRecord(await operationRow(db, principal, input), now)
}

export async function planManagementOperation(db, principal, input, kind, now, randomUUID) {
  let normalized
  let preview
  let configurationRevision
  let incidentId = null
  let incidentRevision = null
  if (kind === MANAGEMENT_OPERATION_KIND.configuration) {
    preview = await reviewConfiguration(d1ConfigurationQuery(db), input.configuration)
    if (preview.expectedRevision !== input.expectedRevision) throw conflict()
    const prepared = await prepareConfigurationWrite(d1ConfigurationQuery(db), input.configuration, {
      expectedRevision: input.expectedRevision, expectedFingerprint: preview.expectedFingerprint,
      updatedAt: now, updatedBy: input.actorId, updatedWorkspace: input.workspaceId,
    })
    normalized = { configuration: input.configuration, expectedFingerprint: preview.expectedFingerprint }
    configurationRevision = preview.expectedRevision
    preview = { ...preview, resultingRevision: prepared.result.revision }
  } else {
    const { incident } = await readManagementIncident(db, input, now)
    if (incident.status !== OPEN || incident.revision !== input.expectedRevision) throw conflict()
    normalized = normalizeIncidentAction(input.action, input, now)
    incidentId = incident.id
    incidentRevision = incident.revision
    configurationRevision = (await readConfiguration(db))?.revision ?? 0
    preview = { ...normalized, incidentId, targetId: incident.targetId,
      incidentRevision, configurationRevision,
      effect: normalized.action === INCIDENT_ACTION.ACKNOWLEDGED ? "Records acknowledgement; does not establish recovery"
        : normalized.action === INCIDENT_ACTION.SNOOZED ? "Delays pending problem delivery; probes continue and sent messages are unchanged"
          : "Resolves this incident by operator decision, not observed recovery; persistent failures can open a new incident",
    }
  }
  const id = randomUUID()
  const expiresAt = new Date(Date.parse(now) + MANAGEMENT_LIMITS.planMilliseconds).toISOString()
  const result = await db.batch([
    db.prepare("DELETE FROM monitor_management_operation WHERE retain_until <= ?").bind(now),
    db.prepare(`INSERT INTO monitor_management_operation (id, workspace_id, actor_id,
      credential_id, credential_revision, kind, input_json, preview_json,
      configuration_revision, incident_id, incident_revision, created_at, expires_at, retain_until)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE (SELECT COUNT(*) FROM monitor_management_operation WHERE applied_at IS NULL) < ?
        AND (SELECT COUNT(*) FROM monitor_management_operation) < ? RETURNING id`)
      .bind(id, input.workspaceId, input.actorId, principal.id, principal.revision, kind,
        JSON.stringify(normalized), JSON.stringify(preview), configurationRevision, incidentId,
        incidentRevision, now, expiresAt, expiresAt, MANAGEMENT_LIMITS.pendingPlans, MANAGEMENT_LIMITS.receipts),
  ])
  if (!result[1].results.length) throw new ManagementError("capacity", 429, "Operation history capacity reached; retain receipts and retry after retention permits")
  return readManagementOperation(db, principal, { ...input, planId: id }, now)
}

export async function applyManagementOperation(db, principal, input, now, randomUUID, clock = Date.now) {
  const row = await operationRow(db, principal, input)
  authorizeManagement(principal, input.workspaceId,
    row.kind === MANAGEMENT_OPERATION_KIND.configuration ? "configure" : "triage", Date.parse(now))
  if (row.applied_at) return operationRecord(row, now)
  try {
    return await applyReviewedOperation(db, principal, input, row, now, randomUUID, clock)
  } catch (error) {
    const latest = await operationRow(db, principal, input)
    if (latest.applied_at) return operationRecord(latest, now)
    throw error
  }
}

async function applyReviewedOperation(db, principal, input, row, now, randomUUID, clock) {
  if (row.expires_at <= now) throw conflict("The review expired; review the operation again")
  const normalized = JSON.parse(row.input_json)
  const acceptanceId = randomUUID()
  const guard = {
    sql: "EXISTS (SELECT 1 FROM monitor_management_operation WHERE id = ? AND acceptance_id = ?)",
    params: [row.id, acceptanceId],
  }
  let statements
  let result
  if (row.kind === MANAGEMENT_OPERATION_KIND.configuration) {
    const prepared = await prepareConfigurationWrite(d1ConfigurationQuery(db), normalized.configuration, {
      expectedRevision: row.configuration_revision, expectedFingerprint: normalized.expectedFingerprint,
      updatedAt: now, updatedBy: input.actorId, updatedWorkspace: input.workspaceId, guard,
    })
    statements = prepared.statement ? [prepared.statement] : []
    result = prepared.result
  } else {
    const { incident } = await readManagementIncident(db, { ...input, incidentId: row.incident_id }, now)
    if (incident.status !== OPEN || incident.revision !== row.incident_revision) throw conflict()
    const actionId = randomUUID()
    statements = incidentActionStatements(incident, normalized, now, actionId, guard)
    result = { actionId, incidentId: row.incident_id, action: normalized.action, createdAt: now }
  }
  const acceptedAt = new Date(clock()).toISOString()
  authorizeManagement(principal, input.workspaceId,
    row.kind === MANAGEMENT_OPERATION_KIND.configuration ? "configure" : "triage", Date.parse(acceptedAt))
  if (row.kind === MANAGEMENT_OPERATION_KIND.triage) normalizeIncidentAction(normalized.action, normalized, acceptedAt)
  const retainUntil = new Date(Date.parse(acceptedAt) + MANAGEMENT_LIMITS.receiptMilliseconds).toISOString()
  const accepted = await db.batch([
    db.prepare(`UPDATE monitor_management_operation SET acceptance_id = ?, applied_at = ?,
      result_json = ?, retain_until = ?, input_json = NULL
      WHERE id = ? AND acceptance_id IS NULL AND expires_at > ?
        AND julianday(expires_at) > julianday('now')
        AND COALESCE((SELECT revision FROM monitor_configuration WHERE singleton_id = 1), 0) = configuration_revision
        AND (kind = 'configuration' OR EXISTS (SELECT 1 FROM monitor_incident
          WHERE id = incident_id AND revision = incident_revision AND status = 'open'))
      RETURNING id`).bind(acceptanceId, acceptedAt, JSON.stringify(result), retainUntil, row.id, acceptedAt),
    ...statements.map(({ sql, params }) => db.prepare(sql).bind(...params)),
  ])
  if (!accepted[0].results.length) {
    const latest = await operationRow(db, principal, input)
    if (latest.applied_at) return operationRecord(latest, now)
    throw conflict()
  }
  return readManagementOperation(db, principal, input, now)
}

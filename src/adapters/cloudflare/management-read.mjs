import { configuredTargets } from "../../config.mjs"
import { INCIDENT_TRIAGE_FIELDS_SQL, incidentFromRow } from "./d1-store.mjs"
import { d1ConfigurationQuery, readConfigurationAuthority } from "./configuration-authority.mjs"
import { readRuntimeSettings } from "./runtime-config.mjs"
import { executionEvidence, readRunSnapshots, targetCheckEvidence } from "./run-status.mjs"
import {
  MANAGEMENT_LIMITS, ManagementError, decodeCursor, encodeCursor,
  invalid, managementId, managementTimestamp, strictObject,
} from "./management-contract.mjs"

const INCIDENT_COLUMNS = `monitor_incident.*, ${INCIDENT_TRIAGE_FIELDS_SQL}`

export function managementDatabase(env) {
  const db = env.MONITOR_DB
  if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function") {
    throw new ManagementError("unavailable", 503, "The monitoring database is unavailable")
  }
  return db
}

export function configurationMetadata(remote) {
  if (!remote) return null
  const { configuration: _configuration, ...metadata } = remote
  return metadata
}

export async function readConfiguration(db) {
  return readConfigurationAuthority(d1ConfigurationQuery(db))
}

export async function readManagementSnapshot(env, now) {
  const db = managementDatabase(env)
  const configuration = configurationMetadata(await readConfiguration(db))
  const [pending, incidents] = await db.batch([
    db.prepare("SELECT id FROM monitor_outbox WHERE delivered_at IS NULL LIMIT ?").bind(MANAGEMENT_LIMITS.page + 1),
    db.prepare("SELECT id FROM monitor_incident WHERE status='open' LIMIT ?").bind(MANAGEMENT_LIMITS.page + 1),
  ])
  let settings = null
  try { settings = readRuntimeSettings(env) } catch { /* Configuration diagnostics never expose secret values */ }
  return {
    readAt: now, configuration,
    runtimeConfigured: settings !== null,
    enabled: settings?.enabled ?? null,
    deliveryEnabled: settings?.deliveryEnabled ?? null,
    analyticsEnabled: settings?.analyticsEnabled ?? null,
    openIncidents: { count: Math.min(incidents.results.length, MANAGEMENT_LIMITS.page), truncated: incidents.results.length > MANAGEMENT_LIMITS.page },
    pendingDeliveries: { count: Math.min(pending.results.length, MANAGEMENT_LIMITS.page), truncated: pending.results.length > MANAGEMENT_LIMITS.page },
    execution: executionEvidence(await readRunSnapshots(d1ConfigurationQuery(db)), now),
  }
}

export async function readManagementTargets(db, input, now) {
  const remote = await readConfiguration(db)
  if (!remote) return { readAt: now, configuration: null, items: [], nextCursor: null }
  const runs = await readRunSnapshots(d1ConfigurationQuery(db))
  let after = ""
  if (input.cursor !== undefined && input.cursor !== null) {
    const cursor = strictObject(decodeCursor(input.cursor), ["kind", "workspaceId", "revision", "after"])
    if (cursor.kind !== "targets" || cursor.workspaceId !== input.workspaceId) invalid()
    managementId(cursor.after)
    if (cursor.revision !== remote.revision) throw new ManagementError("conflict", 409, "Target configuration changed; restart pagination")
    after = cursor.after
  }
  const targets = remote.configuration.targets.filter((target) => target.id > after)
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  const selected = input.targetId
    ? remote.configuration.targets.filter((target) => target.id === input.targetId)
    : targets.slice(0, MANAGEMENT_LIMITS.page)
  if (input.targetId && !selected.length) throw new ManagementError("not_found", 404, "Target not found")
  const configured = new Map((await configuredTargets(remote.configuration)).map((target) => [target.id, target]))
  const states = selected.length ? (await db.prepare(`SELECT target_id, config_fingerprint,
    active_incident_id, last_observation_at, last_probe_error_code, last_probe_status
    FROM monitor_target_state WHERE target_id IN (${selected.map(() => "?").join(",")})`)
    .bind(...selected.map((target) => target.id)).all()).results : []
  const byId = new Map(states.map((state) => [state.target_id, state]))
  return {
    readAt: now, configuration: configurationMetadata(remote),
    items: selected.map((target) => {
      const state = byId.get(target.id)
      const matches = state?.config_fingerprint === configured.get(target.id).configFingerprint
      return { ...target, evidence: {
        state: !state ? "unobserved" : !matches ? "configuration_changed" : state.active_incident_id ? "incident" : "exceptional",
        observedAt: state?.last_observation_at ?? null,
        incidentId: state?.active_incident_id ?? null,
        configurationMatches: state ? matches : null,
        status: state?.last_probe_status ?? null,
        errorCode: state?.last_probe_error_code ?? null,
        check: targetCheckEvidence(runs, remote, configured.get(target.id), now),
      } }
    }),
    nextCursor: !input.targetId && targets.length > MANAGEMENT_LIMITS.page
      ? encodeCursor({ kind: "targets", workspaceId: input.workspaceId, revision: remote.revision, after: selected.at(-1).id }) : null,
  }
}

function incidentRecord(row) {
  return { ...incidentFromRow(row), revision: row.revision }
}

export async function readManagementIncidents(db, input, now) {
  const status = input.status ?? "open"
  if (!["open", "resolved", "all"].includes(status)) invalid()
  const targetId = input.targetId ?? null
  if (targetId !== null) managementId(targetId)
  const conditions = []
  const params = []
  if (status !== "all") { conditions.push("status = ?"); params.push(status) }
  if (targetId !== null) { conditions.push("target_id = ?"); params.push(targetId) }
  if (input.cursor !== undefined && input.cursor !== null) {
    const cursor = strictObject(decodeCursor(input.cursor), ["kind", "workspaceId", "status", "targetId", "openedAt", "id"])
    if (cursor.kind !== "incidents" || cursor.workspaceId !== input.workspaceId
      || cursor.status !== status || cursor.targetId !== targetId) invalid()
    managementTimestamp(cursor.openedAt)
    managementId(cursor.id)
    conditions.push("(opened_at < ? OR (opened_at = ? AND id > ?))")
    params.push(cursor.openedAt, cursor.openedAt, cursor.id)
  }
  const result = await db.prepare(`SELECT ${INCIDENT_COLUMNS} FROM monitor_incident
    ${conditions.length ? "WHERE " + conditions.join(" AND ") : ""}
    ORDER BY opened_at DESC, id LIMIT ?`).bind(...params, MANAGEMENT_LIMITS.page + 1).all()
  const items = result.results.slice(0, MANAGEMENT_LIMITS.page).map(incidentRecord)
  const last = items.at(-1)
  return { readAt: now, items, nextCursor: result.results.length > MANAGEMENT_LIMITS.page
    ? encodeCursor({ kind: "incidents", workspaceId: input.workspaceId, status, targetId, openedAt: last.openedAt, id: last.id }) : null }
}

export async function readManagementIncident(db, input, now) {
  const params = [input.incidentId]
  let condition = ""
  if (input.cursor !== undefined && input.cursor !== null) {
    const cursor = strictObject(decodeCursor(input.cursor), ["kind", "workspaceId", "incidentId", "createdAt", "id"])
    if (cursor.kind !== "history" || cursor.workspaceId !== input.workspaceId || cursor.incidentId !== input.incidentId) invalid()
    managementTimestamp(cursor.createdAt)
    managementId(cursor.id)
    condition = "AND (created_at < ? OR (created_at = ? AND id < ?))"
    params.push(cursor.createdAt, cursor.createdAt, cursor.id)
  }
  const [incident, history] = await db.batch([
    db.prepare(`SELECT ${INCIDENT_COLUMNS} FROM monitor_incident WHERE id = ?`).bind(input.incidentId),
    db.prepare(`SELECT id, action, note, snoozed_until, created_at FROM monitor_incident_action
      WHERE incident_id = ? ${condition} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .bind(...params, MANAGEMENT_LIMITS.page + 1),
  ])
  if (!incident.results[0]) throw new ManagementError("not_found", 404, "Incident not found")
  const actions = history.results.slice(0, MANAGEMENT_LIMITS.page).map((row) => ({
    id: row.id, action: row.action, note: row.note, snoozedUntil: row.snoozed_until, createdAt: row.created_at,
  }))
  const last = actions.at(-1)
  return { readAt: now, incident: incidentRecord(incident.results[0]), actions,
    nextCursor: history.results.length > MANAGEMENT_LIMITS.page
      ? encodeCursor({ kind: "history", workspaceId: input.workspaceId, incidentId: input.incidentId, createdAt: last.createdAt, id: last.id }) : null }
}

import {
  MANAGEMENT_VERSION, ManagementError, authenticateManagement, authorizeManagement,
  invalid, managementId, managementResponse, managementRevision, readManagementBody, strictObject,
} from "./management-contract.mjs"
import {
  managementDatabase, readConfiguration, readManagementIncident, readManagementIncidents,
  readManagementSnapshot, readManagementTargets,
} from "./management-read.mjs"
import { MANAGEMENT_OPERATION_KIND, applyManagementOperation, planManagementOperation, readManagementOperation } from "./management-operations.mjs"
import { ConfigurationAuthorityError } from "./configuration-authority.mjs"

const COMMANDS = Object.freeze({
  snapshot: [], configuration: [], targets: ["cursor"], target: ["targetId"],
  incidents: ["cursor", "targetId", "status"], incident: ["incidentId", "cursor"],
  configuration_plan: ["actorId", "expectedRevision", "configuration"],
  triage_plan: ["actorId", "expectedRevision", "incidentId", "action", "note", "until"],
  operation_apply: ["actorId", "planId"], operation_get: ["actorId", "planId"],
})
const REQUIRED = Object.freeze({
  target: ["targetId"], incident: ["incidentId"],
  configuration_plan: ["actorId", "expectedRevision", "configuration"],
  triage_plan: ["actorId", "expectedRevision", "incidentId", "action"],
  operation_apply: ["actorId", "planId"], operation_get: ["actorId", "planId"],
})

export async function handleManagement(request, env, { clock = Date.now, randomUUID = () => crypto.randomUUID(), logger = console } = {}) {
  try {
    const principal = await authenticateManagement(request, env, clock())
    if (request.method !== "POST") {
      const response = managementResponse({ error: { code: "method", message: "Use POST" } }, 405)
      response.headers.set("allow", "POST")
      return response
    }
    const envelope = strictObject(await readManagementBody(request), ["version", "command", "input"])
    if (envelope.version !== MANAGEMENT_VERSION || typeof envelope.command !== "string"
      || !Object.hasOwn(COMMANDS, envelope.command)) invalid()
    const command = envelope.command
    const input = strictObject(envelope.input, ["workspaceId", ...COMMANDS[command]], ["workspaceId", ...(REQUIRED[command] ?? [])])
    managementId(input.workspaceId)
    for (const field of ["actorId", "targetId", "incidentId", "planId"]) {
      if (input[field] !== undefined) managementId(input[field])
    }
    if (input.expectedRevision !== undefined) managementRevision(input.expectedRevision)
    const capability = command === "configuration_plan" ? "configure" : command === "triage_plan" ? "triage" : "read"
    authorizeManagement(principal, input.workspaceId, capability, clock())
    const now = new Date(clock()).toISOString()
    const db = managementDatabase(env)
    let result
    switch (command) {
      case "snapshot": result = await readManagementSnapshot(env, now); break
      case "configuration": result = { readAt: now, configuration: await readConfiguration(db) }; break
      case "targets": case "target": result = await readManagementTargets(db, input, now); break
      case "incidents": result = await readManagementIncidents(db, input, now); break
      case "incident": result = await readManagementIncident(db, input, now); break
      case "configuration_plan": result = await planManagementOperation(db, principal, input, MANAGEMENT_OPERATION_KIND.configuration, now, randomUUID); break
      case "triage_plan": result = await planManagementOperation(db, principal, input, MANAGEMENT_OPERATION_KIND.triage, now, randomUUID); break
      case "operation_apply": result = await applyManagementOperation(db, principal, input, now, randomUUID, clock); break
      case "operation_get": result = await readManagementOperation(db, principal, input, now); break
    }
    return managementResponse({ version: MANAGEMENT_VERSION, capabilities: principal.capabilities, result })
  } catch (error) {
    if (error instanceof ManagementError) return managementResponse({ error: { code: error.code, message: error.message } }, error.status)
    if (error instanceof ConfigurationAuthorityError && error.code === "configuration-conflict") {
      return managementResponse({ error: { code: "conflict", message: "Configuration changed; review the operation again" } }, 409)
    }
    if (error instanceof TypeError || error instanceof RangeError || (error instanceof ConfigurationAuthorityError && error.exitCode === 2)) {
      return managementResponse({ error: { code: "validation", message: "Management input is invalid or exceeds runtime capacity" } }, 400)
    }
    logger.warn(JSON.stringify({ event: "endpoint_monitor.management_failed", code: "unavailable" }))
    return managementResponse({ error: { code: "unavailable", message: "Management is unavailable; reconcile uncertain operations before acting again" } }, 503)
  }
}

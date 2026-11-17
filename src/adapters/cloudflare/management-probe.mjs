import { configuredTargets } from "../../config.mjs"
import { probeTarget } from "../../probe.mjs"
import { networkObservation } from "../../core.mjs"
import { readConfiguration } from "./management-read.mjs"
import { ManagementError, authorizeManagement } from "./management-contract.mjs"

export async function probeManagementTarget(db, principal, input, { clock, fetchImpl, logger }) {
  const remote = await readConfiguration(db)
  if (!remote || remote.revision !== input.expectedRevision) {
    throw new ManagementError("conflict", 409, "Target configuration changed; reload before probing")
  }
  const target = (await configuredTargets(remote.configuration)).find((entry) => entry.id === input.targetId)
  if (!target) throw new ManagementError("not_found", 404, "Target not found")
  authorizeManagement(principal, input.workspaceId, "probe", clock())
  const startedAt = new Date(clock()).toISOString()
  const started = performance.now()
  let timer
  try {
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve(networkObservation("timeout", startedAt)), target.timeoutMilliseconds)
    })
    const observation = await Promise.race([probeTarget(fetchImpl, target, startedAt), deadline])
    const current = await readConfiguration(db)
    try {
      authorizeManagement(principal, input.workspaceId, "probe", clock())
    } catch (error) {
      logger.warn(JSON.stringify({ event: "endpoint_monitor.diagnostic", requestId: input.requestId,
        workspaceId: input.workspaceId, targetId: target.id, outcome: "indeterminate",
        errorCode: "authority-changed", durationMilliseconds: Math.max(0, Math.round(performance.now() - started)) }))
      throw new ManagementError("indeterminate", 503, "The diagnostic ran but its result is unavailable; do not automatically repeat it")
    }
    const result = {
      requestId: input.requestId,
      targetId: target.id,
      configurationRevision: remote.revision,
      configFingerprint: remote.configFingerprint,
      targetFingerprint: target.configFingerprint,
      configurationMatches: current?.revision === remote.revision && current?.configFingerprint === remote.configFingerprint,
      startedAt,
      completedAt: new Date(clock()).toISOString(),
      durationMilliseconds: Math.max(0, Math.round(performance.now() - started)),
      outcome: observation.outcome,
      httpStatus: observation.httpStatus,
      errorCode: observation.errorCode,
    }
    const diagnostic = JSON.stringify({
      event: "endpoint_monitor.diagnostic", requestId: input.requestId,
      workspaceId: input.workspaceId, targetId: target.id,
      configurationRevision: remote.revision, configurationMatches: result.configurationMatches,
      outcome: result.outcome, errorCode: result.errorCode,
      durationMilliseconds: result.durationMilliseconds,
    })
    if (result.outcome === "failure" || !result.configurationMatches) logger.warn(diagnostic)
    else logger.info?.(diagnostic)
    return result
  } finally {
    clearTimeout(timer)
  }
}

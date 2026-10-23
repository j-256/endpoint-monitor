import { OBSERVATION_OUTCOME } from "../../constants.mjs"
import { probeTargets, summarizeProbeResults } from "../../probe.mjs"
import { intervalIsDue, probeSchedule } from "../../schedule.mjs"
import { readCloudflareAnalyticsFailures } from "./analytics.mjs"
import { CloudflareApi } from "./api.mjs"
import {
  enqueueUndeliveredOpenIncidents,
  markOutboxDelivered,
  markOutboxFailed,
  pruneMonitorStorage,
  readDueOutbox,
  readMonitorStatus,
  reconcileTargetConfiguration,
  recordAnalyticsFailure,
  recordObservation,
} from "./d1-store.mjs"
import {
  deliverHookrelayEvent,
  nextDeliveryAttempt,
} from "./delivery.mjs"
import {
  createFetchBudget,
  SubrequestBudgetError,
} from "./fetch-budget.mjs"
import {
  loadStoredConfiguration,
  readRuntimeSettings,
} from "./runtime-config.mjs"
import { CLOUDFLARE_RUNTIME_LIMITS } from "./runtime-limits.mjs"
import { handleManagement } from "./management.mjs"
import { MANAGEMENT_PATH } from "./management-contract.mjs"
import { d1ConfigurationQuery } from "./configuration-authority.mjs"
import { executionEvidence, readRunSnapshots, RUN_PHASES, targetCheckEvidence, writeRunStatus } from "./run-status.mjs"

export { CLOUDFLARE_RUNTIME_LIMITS } from "./runtime-limits.mjs"

const SAFE_ERROR_CODES = new Set([
  "invalid-scheduled-time", "invalid-runtime-time", "invalid-runtime-flag",
  "monitor-database-unavailable", "monitor-configuration-unavailable",
  "monitor-configuration-invalid", "monitor-configuration-metadata-invalid",
  "cloudflare-account-id-unavailable", "cloudflare-api-token-unavailable",
  "hookrelay-hmac-unavailable", "hookrelay-url-unavailable", "status-token-unavailable",
  "cloudflare-analytics-rows-unavailable", "cloudflare-analytics-result-truncated",
  "cloudflare-zones-failed", "cloudflare-zones-failed-invalid-json", "cloudflare-zones-invalid",
  "cloudflare-zones-pagination-invalid", "cloudflare-graphql-failed",
  "cloudflare-graphql-failed-invalid-json", "cloudflare-graphql-invalid", "run-status-invalid",
])

function timestamp(value, code) {
  const milliseconds = value instanceof Date ? value.getTime() : Number(value)
  if (!Number.isFinite(milliseconds)) {
    const error = new TypeError(code)
    error.code = code
    throw error
  }
  return new Date(milliseconds).toISOString()
}

function before(isoTime, amount, unitMilliseconds) {
  return new Date(Date.parse(isoTime) - amount * unitMilliseconds).toISOString()
}

function fixedErrorCode(error, fallback) {
  if (error instanceof SubrequestBudgetError) {
    return "subrequest-budget-exhausted"
  }
  return SAFE_ERROR_CODES.has(error?.code)
    ? error.code
    : fallback
}

function emit(logger, level, event, fields = {}) {
  const output = logger?.[level]
  if (typeof output !== "function") return
  output.call(logger, Object.freeze({ event, ...fields }))
}

function runTelemetry(logger, monotonicClock, runId) {
  const started = monotonicClock()
  let phaseStarted = started
  let phase = RUN_PHASES.CONFIGURATION
  const phaseDurationsMilliseconds = {}
  const elapsed = (since) => Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(monotonicClock() - since)))
  const diagnostics = () => ({
    runId, phase, elapsedMilliseconds: elapsed(started),
    phaseElapsedMilliseconds: phaseDurationsMilliseconds[phase] ?? elapsed(phaseStarted),
    phaseDurationsMilliseconds: { ...phaseDurationsMilliseconds },
  })
  return {
    runId,
    phaseDurationsMilliseconds,
    diagnostics,
    logger: Object.fromEntries(["log", "error"].map((level) => [level, ({ event, ...fields }) => {
      emit(logger, level, event, { ...fields, ...diagnostics() })
    }])),
    async measure(nextPhase, operation) {
      phase = nextPhase
      phaseStarted = monotonicClock()
      try { return await operation() }
      finally { phaseDurationsMilliseconds[phase] = elapsed(phaseStarted) }
    },
  }
}

function setState(states, targetId, state) {
  if (state) states.set(targetId, state)
  else states.delete(targetId)
}

function emitTransition(logger, result, signal) {
  if (!result.transition || !result.incident) return
  emit(logger, "log", "endpoint_monitor.transition", {
    failureKind: result.incident.failureKind,
    incidentId: result.incident.id,
    signal,
    status: result.incident.latestStatus,
    targetId: result.incident.targetId,
    transition: result.transition.kind,
  })
}

function deliveryFetch(env, budget) {
  if (typeof env?.HOOKRELAY?.fetch === "function") {
    return (...args) => budget.request(env.HOOKRELAY.fetch.bind(env.HOOKRELAY), ...args)
  }
  return budget.fetch
}

async function runAnalytics(
  settings,
  targets,
  states,
  latestProbes,
  runAt,
  budget,
  logger,
  summary,
  randomUUID,
) {
  const api = new CloudflareApi({
    accountId: settings.analytics.accountId,
    apiToken: settings.analytics.apiToken,
    fetchImpl: budget.fetch,
  })
  try {
    const result = await readCloudflareAnalyticsFailures(api, targets, runAt)
    summary.analyticsRows = result.rowCount
    for (const entry of result.entries) {
      const probe = latestProbes.get(entry.target.id)
      if (probe?.outcome === OBSERVATION_OUTCOME.SUCCESS
        && probe.observedAt > entry.observation.observedAt) {
        summary.analyticsStale += 1
        continue
      }
      const recorded = await recordAnalyticsFailure(
        settings.db,
        entry.target,
        entry.observation,
        entry.signal,
        {
          currentState: states.get(entry.target.id) || null,
          enqueueEvents: settings.deliveryEnabled,
          incidentId: randomUUID(),
          recordedAt: runAt,
        },
      )
      setState(states, entry.target.id, recorded.state)
      summary.analyticsMatched += 1
      summary.d1Writes += recorded.writes
      if (recorded.duplicate) summary.analyticsDuplicates += 1
      if (recorded.transition) summary.transitions += 1
      emitTransition(logger, recorded, "cloudflare-analytics")
    }
  } catch (error) {
    if (error instanceof SubrequestBudgetError) throw error
    summary.phaseErrors += 1
    emit(logger, "error", "endpoint_monitor.phase_error", {
      errorCode: fixedErrorCode(error, "cloudflare-analytics-failed"),
      phase: "cloudflare-analytics",
    })
  }
}

async function runDelivery(
  env,
  settings,
  runAt,
  budget,
  logger,
  summary,
) {
  const bridged = await enqueueUndeliveredOpenIncidents(settings.db, runAt)
  summary.d1Writes += bridged.writes
  summary.deliveryBridged = bridged.incidents.length
  const rows = await readDueOutbox(
    settings.db,
    runAt,
    CLOUDFLARE_RUNTIME_LIMITS.maximumDeliveriesPerRun,
  )
  const fetchImpl = deliveryFetch(env, budget)
  for (const row of rows) {
    const delivered = await deliverHookrelayEvent(
      fetchImpl,
      settings.delivery.url,
      settings.delivery.hmac,
      row.body,
    )
    if (delivered.ok) {
      summary.d1Writes += await markOutboxDelivered(settings.db, row.id, runAt)
      summary.deliveriesSucceeded += 1
      continue
    }
    summary.d1Writes += await markOutboxFailed(
      settings.db,
      row.id,
      runAt,
      delivered.errorCode,
      nextDeliveryAttempt(row.attempts, runAt),
    )
    summary.deliveriesFailed += 1
    emit(logger, "error", "endpoint_monitor.delivery_failed", {
      errorCode: delivered.errorCode,
      eventId: row.id,
    })
  }
}

async function runMaintenance(settings, runAt, summary) {
  const hour = 60 * 60 * 1000
  const day = 24 * hour
  const result = await pruneMonitorStorage(
    settings.db,
    before(runAt, CLOUDFLARE_RUNTIME_LIMITS.signalRetentionHours, hour),
    before(runAt, CLOUDFLARE_RUNTIME_LIMITS.deliveredOutboxRetentionDays, day),
    before(runAt, CLOUDFLARE_RUNTIME_LIMITS.incidentRetentionDays, day),
  )
  summary.d1Writes += result.signals + result.outbox + result.incidents
  summary.pruned = result.signals + result.outbox + result.incidents
}

function newSummary(scheduledAt, settings) {
  return {
    analyticsDuplicates: 0,
    analyticsMatched: 0,
    analyticsRows: 0,
    analyticsStale: 0,
    d1Writes: 0,
    deliveriesFailed: 0,
    deliveriesSucceeded: 0,
    deliveryBridged: 0,
    dueTargets: 0,
    enabled: settings.enabled,
    failedProbes: 0,
    phaseErrors: 0,
    pruned: 0,
    runStatusWrites: 0,
    scheduledAt,
    succeededProbes: 0,
    targetCount: 0,
    transitions: 0,
  }
}

async function executeScheduled(env, scheduledAt, startedAt, telemetry, { clock, fetchImpl, randomUUID }) {
  const logger = telemetry.logger
  const { settings, loaded } = await telemetry.measure(RUN_PHASES.CONFIGURATION, async () => {
    const settings = readRuntimeSettings(env)
    return { settings, loaded: settings.enabled ? await loadStoredConfiguration(settings.db) : null }
  })
  const summary = newSummary(scheduledAt, settings)
  if (!settings.enabled) {
    if (settings.db) {
      summary.runStatusWrites = await telemetry.measure(RUN_PHASES.RUN_STATUS, () => writeRunStatus(settings.db, {
        scheduledAt, startedAt, completedAt: timestamp(clock(), "invalid-runtime-time"), summary,
        runId: telemetry.runId, phaseDurationsMilliseconds: { ...telemetry.phaseDurationsMilliseconds },
      }))
      summary.d1Writes += summary.runStatusWrites
    }
    return summary
  }
  const runAt = startedAt
  const reconciliation = await telemetry.measure(RUN_PHASES.RECONCILIATION, () => reconcileTargetConfiguration(
    settings.db,
    loaded.targets,
    runAt,
  ))
  summary.d1Writes += reconciliation.writes
  summary.targetCount = loaded.targets.length
  const states = new Map(
    reconciliation.states.map((state) => [state.targetId, state]),
  )
  const schedule = probeSchedule(
    loaded.targets,
    loaded.configuration.defaults.probeIntervalMinutes,
    scheduledAt,
    CLOUDFLARE_RUNTIME_LIMITS.maximumProbesPerRun,
  )
  summary.dueTargets = schedule.due.length
  const budget = createFetchBudget(
    fetchImpl,
    CLOUDFLARE_RUNTIME_LIMITS.externalSubrequests,
  )
  const probes = await telemetry.measure(RUN_PHASES.PROBING, () => probeTargets(
    budget.fetch,
    schedule.due,
    () => timestamp(clock(), "invalid-runtime-time"),
    CLOUDFLARE_RUNTIME_LIMITS.probeConcurrency,
  ))
  const probeSummary = summarizeProbeResults(probes)
  summary.failedProbes = probeSummary.failed
  summary.succeededProbes = probeSummary.succeeded
  const latestProbes = new Map()
  await telemetry.measure(RUN_PHASES.PERSISTENCE, async () => {
    for (const entry of probes) {
      latestProbes.set(entry.target.id, entry.observation)
      const recorded = await recordObservation(
        settings.db,
        entry.target,
        entry.observation,
        {
          currentState: states.get(entry.target.id) || null,
          enqueueEvents: settings.deliveryEnabled,
          incidentId: entry.observation.outcome === OBSERVATION_OUTCOME.FAILURE
            ? randomUUID()
            : null,
          recordedAt: runAt,
        },
      )
      setState(states, entry.target.id, recorded.state)
      summary.d1Writes += recorded.writes
      if (recorded.transition) summary.transitions += 1
      emitTransition(logger, recorded, "probe")
    }
  })
  if (settings.analyticsEnabled && intervalIsDue(
    scheduledAt,
    CLOUDFLARE_RUNTIME_LIMITS.analyticsIntervalMinutes,
  )) {
    await telemetry.measure(RUN_PHASES.ANALYTICS, () => runAnalytics(
      settings,
      loaded.targets,
      states,
      latestProbes,
      runAt,
      budget,
      logger,
      summary,
      randomUUID,
    ))
  }
  if (settings.deliveryEnabled) await telemetry.measure(RUN_PHASES.DELIVERY,
    () => runDelivery(env, settings, runAt, budget, logger, summary))
  if (intervalIsDue(
    scheduledAt,
    CLOUDFLARE_RUNTIME_LIMITS.maintenanceIntervalMinutes,
  )) {
    await telemetry.measure(RUN_PHASES.MAINTENANCE, () => runMaintenance(settings, runAt, summary))
  }
  summary.runStatusWrites = await telemetry.measure(RUN_PHASES.RUN_STATUS, () => writeRunStatus(settings.db, {
    scheduledAt, startedAt: runAt, completedAt: timestamp(clock(), "invalid-runtime-time"),
    runId: telemetry.runId, phaseDurationsMilliseconds: { ...telemetry.phaseDurationsMilliseconds },
    loaded, probes, summary: { ...summary, subrequests: budget.used },
  }))
  summary.d1Writes += summary.runStatusWrites
  return { ...summary, subrequests: budget.used }
}

export async function runCloudflareScheduled(env, scheduledTime, {
  clock = Date.now,
  monotonicClock = () => performance.now(),
  fetchImpl = globalThis.fetch,
  logger = console,
  randomUUID = () => crypto.randomUUID(),
  randomRunId = () => crypto.randomUUID(),
} = {}) {
  const telemetry = runTelemetry(logger, monotonicClock, randomRunId())
  let startedAt = null
  let scheduledAt = null
  try {
    startedAt = timestamp(clock(), "invalid-runtime-time")
    scheduledAt = timestamp(scheduledTime, "invalid-scheduled-time")
    emit(telemetry.logger, "log", "endpoint_monitor.run_start", {
      scheduledAt, startedAt,
      schedulerDelayMilliseconds: Math.max(0, Date.parse(startedAt) - Date.parse(scheduledAt)),
    })
    const summary = await executeScheduled(env, scheduledAt, startedAt, telemetry, { clock, fetchImpl, randomUUID })
    const complete = Object.freeze({ ...summary, runId: telemetry.runId, startedAt,
      durationMilliseconds: telemetry.diagnostics().elapsedMilliseconds,
      phaseDurationsMilliseconds: Object.freeze({ ...telemetry.phaseDurationsMilliseconds }),
    })
    emit(telemetry.logger, "log", "endpoint_monitor.run", complete)
    return complete
  } catch (error) {
    const errorCode = fixedErrorCode(error, "runtime-failed")
    emit(telemetry.logger, "error", "endpoint_monitor.runtime_error", { errorCode, scheduledAt, startedAt })
    const safe = new Error(errorCode)
    safe.code = errorCode
    throw safe
  }
}

function responseBody(body, status, method, headers = {}) {
  return new Response(method === "HEAD" ? null : JSON.stringify(body), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
    status,
  })
}

async function tokenMatches(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false
  const encoder = new TextEncoder()
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ])
  const left = new Uint8Array(actualHash)
  const right = new Uint8Array(expectedHash)
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index]
  }
  return difference === 0
}

export async function handleCloudflareRequest(
  request,
  env,
  { clock = Date.now } = {},
) {
  const url = new URL(request.url)
  if (url.pathname === MANAGEMENT_PATH) return handleManagement(request, env, { clock })
  if (!["GET", "HEAD"].includes(request.method)) {
    return responseBody(
      { error: "method-not-allowed" },
      405,
      request.method,
      { Allow: "GET, HEAD" },
    )
  }
  if (url.pathname === "/healthz") {
    return responseBody(
      { ok: true, service: "endpoint-monitor" },
      200,
      request.method,
    )
  }
  if (url.pathname !== "/api/status") {
    return responseBody({ error: "not-found" }, 404, request.method)
  }
  let settings
  try {
    settings = readRuntimeSettings(env)
  } catch {
    return responseBody({ error: "status-unavailable" }, 503, request.method)
  }
  if (!settings.statusEnabled) {
    return responseBody({ error: "not-found" }, 404, request.method)
  }
  const authorization = request.headers.get("Authorization") || ""
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : null
  if (!await tokenMatches(token, settings.statusToken)) {
    return responseBody(
      { error: "unauthorized" },
      401,
      request.method,
      { "WWW-Authenticate": "Bearer" },
    )
  }
  try {
    const loaded = await loadStoredConfiguration(settings.db)
    const status = await readMonitorStatus(settings.db)
    const readAt = timestamp(clock(), "invalid-runtime-time")
    const runs = await readRunSnapshots(d1ConfigurationQuery(settings.db))
    const schedule = probeSchedule(
      loaded.targets,
      loaded.configuration.defaults.probeIntervalMinutes,
      timestamp(clock(), "invalid-runtime-time"),
      CLOUDFLARE_RUNTIME_LIMITS.maximumProbesPerRun,
    )
    return responseBody({
      analyticsEnabled: settings.analyticsEnabled,
      configuration: loaded.portableConfiguration,
      configurationFingerprint: loaded.configFingerprint,
      configurationRevision: loaded.revision,
      configurationUpdatedAt: loaded.updatedAt,
      deliveryEnabled: settings.deliveryEnabled,
      enabled: settings.enabled,
      readAt,
      execution: executionEvidence(runs, readAt),
      targetChecks: loaded.targets.map((target) => ({
        targetId: target.id, ...targetCheckEvidence(runs, loaded, target, readAt),
      })),
      schedule: {
        intervalMinutes: schedule.intervalMinutes,
        maximumProbesPerRun: CLOUDFLARE_RUNTIME_LIMITS.maximumProbesPerRun,
        maximumShardSize: schedule.maximumShardSize,
        targetCount: schedule.targetCount,
      },
      ...status,
    }, 200, request.method)
  } catch {
    return responseBody({ error: "status-unavailable" }, 503, request.method)
  }
}

export async function runCloudflareScheduledSafely(env, scheduledTime, options = {}) {
  return runCloudflareScheduled(env, scheduledTime, options)
}

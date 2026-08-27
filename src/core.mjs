import {
  EVENT_SOURCE,
  EVENT_TYPE,
  FAILURE_KIND,
  IMMEDIATE_HTTP_STATUSES,
  OBSERVATION_OUTCOME,
  OBSERVATION_SOURCE,
  RESOLUTION_REASON,
  TRANSITION,
} from "./constants.mjs"

const IMMEDIATE_STATUS_SET = new Set(IMMEDIATE_HTTP_STATUSES)

function timestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be a timestamp`)
  }
  return new Date(value).toISOString()
}

function targetInput(target) {
  if (!target?.id || !target?.url || !target?.configFingerprint) {
    throw new TypeError("Configured target is incomplete")
  }
  return target
}

function probeErrorCode(value) {
  if (value !== null
    && (typeof value !== "string" || !/^[a-z][a-z0-9-]*$/.test(value))) {
    throw new TypeError("Probe error code is invalid")
  }
  return value
}

export function httpObservation(target, status, observedAt, errorCode = null) {
  targetInput(target)
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new TypeError("Probe HTTP status is invalid")
  }
  const observed = timestamp(observedAt, "Probe observation time")
  const normalizedErrorCode = probeErrorCode(errorCode)
  const statusHealthy = target.expectedStatuses
    ? target.expectedStatuses.includes(status)
    : status < 500
  const healthy = statusHealthy && normalizedErrorCode === null
  return Object.freeze({
    errorCode: normalizedErrorCode,
    failureKind: healthy ? null : FAILURE_KIND.HTTP,
    httpStatus: status,
    immediate: !statusHealthy && IMMEDIATE_STATUS_SET.has(status),
    observedAt: observed,
    outcome: healthy ? OBSERVATION_OUTCOME.SUCCESS : OBSERVATION_OUTCOME.FAILURE,
    requestCount: null,
    source: OBSERVATION_SOURCE.PROBE,
  })
}

export function networkObservation(errorCode, observedAt) {
  if (probeErrorCode(errorCode) === null) {
    throw new TypeError("Probe error code is invalid")
  }
  return Object.freeze({
    errorCode,
    failureKind: FAILURE_KIND.NETWORK,
    httpStatus: null,
    immediate: false,
    observedAt: timestamp(observedAt, "Probe observation time"),
    outcome: OBSERVATION_OUTCOME.FAILURE,
    requestCount: null,
    source: OBSERVATION_SOURCE.PROBE,
  })
}

export function analyticsObservation(status, observedAt, requestCount) {
  if (!IMMEDIATE_STATUS_SET.has(status)) {
    throw new TypeError("Analytics status is not an immediate failure")
  }
  if (!Number.isFinite(requestCount) || requestCount <= 0) {
    throw new TypeError("Analytics request count must be positive")
  }
  return Object.freeze({
    errorCode: null,
    failureKind: FAILURE_KIND.HTTP,
    httpStatus: status,
    immediate: true,
    observedAt: timestamp(observedAt, "Analytics observation time"),
    outcome: OBSERVATION_OUTCOME.FAILURE,
    requestCount,
    source: OBSERVATION_SOURCE.CLOUDFLARE_ANALYTICS,
  })
}

function stateFromFailure(target, observation, previous, activeIncidentId) {
  const state = previous || {}
  return Object.freeze({
    activeIncidentId,
    configFingerprint: target.configFingerprint,
    consecutiveFailures: Math.min(
      target.failureThreshold,
      (state.consecutiveFailures || 0) + 1,
    ),
    consecutiveSuccesses: 0,
    lastFailureAt: observation.observedAt,
    lastFailureKind: observation.failureKind,
    lastFailureStatus: observation.httpStatus,
    lastObservationAt: observation.observedAt,
    lastProbeErrorCode: observation.source === OBSERVATION_SOURCE.PROBE
      ? observation.errorCode
      : state.lastProbeErrorCode || null,
    lastProbeStatus: observation.source === OBSERVATION_SOURCE.PROBE
      ? observation.httpStatus
      : state.lastProbeStatus || null,
    targetId: target.id,
    targetUrl: target.url,
  })
}

export function reduceTargetState(state, target, observation, incidentId = null) {
  targetInput(target)
  if (state && (state.targetId !== target.id
    || state.configFingerprint !== target.configFingerprint)) {
    throw new TypeError("Target state does not match the configured target")
  }
  if (observation.outcome === OBSERVATION_OUTCOME.FAILURE) {
    if (state?.activeIncidentId && state.consecutiveSuccesses === 0) {
      return Object.freeze({ changed: false, state, transition: null })
    }
    const consecutiveFailures = Math.min(
      target.failureThreshold,
      (state?.consecutiveFailures || 0) + 1,
    )
    const shouldOpen = !state?.activeIncidentId
      && (observation.immediate || consecutiveFailures >= target.failureThreshold)
    if (shouldOpen && !incidentId) {
      throw new TypeError("Opening an incident requires an ID")
    }
    const next = stateFromFailure(
      target,
      observation,
      state,
      shouldOpen ? incidentId : state?.activeIncidentId || null,
    )
    return Object.freeze({
      changed: true,
      state: next,
      transition: shouldOpen
        ? Object.freeze({ incidentId, kind: TRANSITION.OPENED })
        : null,
    })
  }
  if (observation.outcome !== OBSERVATION_OUTCOME.SUCCESS
    || observation.source !== OBSERVATION_SOURCE.PROBE) {
    throw new TypeError("Monitor observation is invalid")
  }
  if (!state) return Object.freeze({ changed: false, state: null, transition: null })
  if (!state.activeIncidentId) {
    return Object.freeze({ changed: true, state: null, transition: null })
  }
  const consecutiveSuccesses = Math.min(
    target.recoveryThreshold,
    state.consecutiveSuccesses + 1,
  )
  if (consecutiveSuccesses >= target.recoveryThreshold) {
    return Object.freeze({
      changed: true,
      state: null,
      transition: Object.freeze({
        incidentId: state.activeIncidentId,
        kind: TRANSITION.RESOLVED,
      }),
    })
  }
  return Object.freeze({
    changed: true,
    state: Object.freeze({
      ...state,
      consecutiveFailures: 0,
      consecutiveSuccesses,
      lastObservationAt: observation.observedAt,
      lastProbeErrorCode: null,
      lastProbeStatus: observation.httpStatus,
    }),
    transition: null,
  })
}

export function createIncident(target, observation, incidentId, openedAt) {
  targetInput(target)
  if (!incidentId || observation.outcome !== OBSERVATION_OUTCOME.FAILURE) {
    throw new TypeError("Incident input is invalid")
  }
  return Object.freeze({
    configFingerprint: target.configFingerprint,
    errorCode: observation.errorCode,
    failureKind: observation.failureKind,
    failureThreshold: target.failureThreshold,
    firstObservedAt: observation.observedAt,
    firstStatus: observation.httpStatus,
    id: incidentId,
    lastFailureAt: observation.observedAt,
    latestSignal: observation.source,
    latestStatus: observation.httpStatus,
    openedAt: timestamp(openedAt, "Incident opening time"),
    recoveryThreshold: target.recoveryThreshold,
    requestCount: observation.requestCount,
    resolutionReason: null,
    resolvedAt: null,
    status: "open",
    targetId: target.id,
    targetUrl: target.url,
  })
}

export function resolveIncident(incident, resolvedAt) {
  if (incident?.status !== "open") {
    throw new TypeError("Only an open incident can be resolved")
  }
  return Object.freeze({
    ...incident,
    resolutionReason: RESOLUTION_REASON.RECOVERED,
    resolvedAt: timestamp(resolvedAt, "Incident resolution time"),
    status: "resolved",
  })
}

export function suppressIncident(incident, resolvedAt, reason) {
  if (incident?.status !== "open"
    || ![
      RESOLUTION_REASON.CONFIGURATION_CHANGED,
      RESOLUTION_REASON.CONFIGURATION_REMOVED,
    ].includes(reason)) {
    throw new TypeError("Open incident and configuration resolution reason are required")
  }
  return Object.freeze({
    ...incident,
    resolutionReason: reason,
    resolvedAt: timestamp(resolvedAt, "Incident suppression time"),
    status: "resolved",
  })
}

function failureLabel(incident) {
  if (incident.latestStatus && incident.errorCode) {
    return `HTTP ${incident.latestStatus} (${incident.errorCode})`
  }
  return incident.latestStatus
    ? `HTTP ${incident.latestStatus}`
    : "a network failure"
}

export function createIncidentCloudEvent(incident, transition) {
  if (![TRANSITION.OPENED, TRANSITION.RESOLVED].includes(transition)) {
    throw new TypeError("Incident event transition is invalid")
  }
  const opened = transition === TRANSITION.OPENED
  const eventTime = opened ? incident.openedAt : incident.resolvedAt
  if (!eventTime) throw new TypeError("Incident transition time is unavailable")
  return Object.freeze({
    data: Object.freeze({
      errorCode: incident.errorCode,
      failureKind: incident.failureKind,
      failureThreshold: incident.failureThreshold,
      firstObservedAt: incident.firstObservedAt,
      firstStatus: incident.firstStatus,
      incidentId: incident.id,
      lastFailureAt: incident.lastFailureAt,
      latestSignal: incident.latestSignal,
      latestStatus: incident.latestStatus,
      openedAt: incident.openedAt,
      recoveryThreshold: incident.recoveryThreshold,
      requestCount: incident.requestCount,
      resolvedAt: incident.resolvedAt,
      schemaVersion: 1,
      state: opened ? "problem" : "recovered",
      targetId: incident.targetId,
      targetUrl: incident.targetUrl,
    }),
    id: `${incident.id}/${transition}`,
    severity: opened ? "error" : "info",
    source: EVENT_SOURCE,
    specversion: "1.0",
    subject: incident.targetId,
    time: eventTime,
    title: opened
      ? `${incident.targetId} returned ${failureLabel(incident)}`
      : `${incident.targetId} recovered from ${failureLabel(incident)}`,
    type: opened ? EVENT_TYPE.PROBLEM : EVENT_TYPE.RECOVERED,
    url: incident.targetUrl,
  })
}

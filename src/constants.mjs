export const CONFIG_SCHEMA_VERSION = 2

export const SUPPORTED_CONFIG_SCHEMA_VERSIONS = Object.freeze([1, 2])

export const DEFAULT_CONFIGURATION = Object.freeze({
  failureThreshold: 2,
  method: "GET",
  probeIntervalMinutes: 5,
  recoveryThreshold: 2,
  timeoutMilliseconds: 10000,
})

export const IMMEDIATE_HTTP_STATUSES = Object.freeze([
  520,
  521,
  522,
  523,
  524,
  525,
  526,
  530,
])

export const EVENT_SOURCE = "urn:endpoint-monitor"

export const EVENT_TYPE = Object.freeze({
  PROBLEM: "urn:endpoint-monitor:problem:v1",
  RECOVERED: "urn:endpoint-monitor:recovered:v1",
})

export const FAILURE_KIND = Object.freeze({
  HTTP: "http",
  NETWORK: "network",
})

export const OBSERVATION_OUTCOME = Object.freeze({
  FAILURE: "failure",
  SUCCESS: "success",
})

export const OBSERVATION_SOURCE = Object.freeze({
  CLOUDFLARE_ANALYTICS: "cloudflare-analytics",
  PROBE: "probe",
})

export const RESOLUTION_REASON = Object.freeze({
  CONFIGURATION_CHANGED: "configuration-changed",
  CONFIGURATION_REMOVED: "configuration-removed",
  RECOVERED: "recovered",
})

export const TRANSITION = Object.freeze({
  OPENED: "opened",
  RESOLVED: "resolved",
})

import {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_CONFIGURATION,
} from "./constants.mjs"
import { sha256Hex } from "./crypto.mjs"

const CONFIGURATION_KEYS = new Set(["defaults", "schemaVersion", "targets"])
const DEFAULT_KEYS = new Set([
  "failureThreshold",
  "method",
  "probeIntervalMinutes",
  "recoveryThreshold",
  "timeoutMilliseconds",
])
const TARGET_KEYS = new Set([
  "expectedStatuses",
  "failureThreshold",
  "id",
  "method",
  "recoveryThreshold",
  "timeoutMilliseconds",
  "url",
])
const HTTP_METHODS = new Set(["GET", "HEAD"])
const TARGET_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const MAXIMUM_TARGETS = 1000

function objectValue(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value
}

function rejectUnknownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length > 0) {
    throw new TypeError(`${label} contains unsupported field: ${unknown[0]}`)
  }
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} through ${maximum}`)
  }
  return value
}

function methodValue(value, label) {
  if (typeof value !== "string" || !HTTP_METHODS.has(value)) {
    throw new TypeError(`${label} must be GET or HEAD`)
  }
  return value
}

function targetId(value) {
  if (typeof value !== "string" || !TARGET_ID_PATTERN.test(value)) {
    throw new TypeError("Target ID must be a lower-case DNS-style label")
  }
  return value
}

function targetUrl(value) {
  if (typeof value !== "string" || value !== value.trim()) {
    throw new TypeError("Target URL must be a trimmed string")
  }
  let url
  try {
    url = new URL(value)
  } catch {
    throw new TypeError("Target URL must be an absolute HTTP or HTTPS URL")
  }
  if (!["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
    || url.hash
    || !url.hostname) {
    throw new TypeError("Target URL must be a public HTTP or HTTPS URL without credentials or a fragment")
  }
  return url.toString()
}

function expectedStatuses(value) {
  if (value === undefined) return null
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("Expected statuses must be a non-empty array")
  }
  const statuses = value.map((status) => (
    boundedInteger(status, "Expected status", 100, 599)
  ))
  if (new Set(statuses).size !== statuses.length) {
    throw new TypeError("Expected statuses must be unique")
  }
  return Object.freeze(statuses.sort((left, right) => left - right))
}

function normalizeDefaults(value = {}) {
  const defaults = objectValue(value, "Configuration defaults")
  rejectUnknownKeys(defaults, DEFAULT_KEYS, "Configuration defaults")
  return Object.freeze({
    failureThreshold: boundedInteger(
      defaults.failureThreshold ?? DEFAULT_CONFIGURATION.failureThreshold,
      "Default failure threshold",
      1,
      10,
    ),
    method: methodValue(
      defaults.method ?? DEFAULT_CONFIGURATION.method,
      "Default method",
    ),
    probeIntervalMinutes: boundedInteger(
      defaults.probeIntervalMinutes ?? DEFAULT_CONFIGURATION.probeIntervalMinutes,
      "Probe interval",
      1,
      60,
    ),
    recoveryThreshold: boundedInteger(
      defaults.recoveryThreshold ?? DEFAULT_CONFIGURATION.recoveryThreshold,
      "Default recovery threshold",
      1,
      10,
    ),
    timeoutMilliseconds: boundedInteger(
      defaults.timeoutMilliseconds ?? DEFAULT_CONFIGURATION.timeoutMilliseconds,
      "Default timeout",
      100,
      30000,
    ),
  })
}

function normalizeTarget(value, defaults) {
  const candidate = objectValue(value, "Target")
  rejectUnknownKeys(candidate, TARGET_KEYS, "Target")
  return Object.freeze({
    expectedStatuses: expectedStatuses(candidate.expectedStatuses),
    failureThreshold: boundedInteger(
      candidate.failureThreshold ?? defaults.failureThreshold,
      "Target failure threshold",
      1,
      10,
    ),
    id: targetId(candidate.id),
    method: methodValue(candidate.method ?? defaults.method, "Target method"),
    recoveryThreshold: boundedInteger(
      candidate.recoveryThreshold ?? defaults.recoveryThreshold,
      "Target recovery threshold",
      1,
      10,
    ),
    timeoutMilliseconds: boundedInteger(
      candidate.timeoutMilliseconds ?? defaults.timeoutMilliseconds,
      "Target timeout",
      100,
      30000,
    ),
    url: targetUrl(candidate.url),
  })
}

export function normalizeConfiguration(value) {
  const candidate = objectValue(value, "Endpoint Monitor configuration")
  rejectUnknownKeys(candidate, CONFIGURATION_KEYS, "Endpoint Monitor configuration")
  if (candidate.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new TypeError(`Configuration schemaVersion must be ${CONFIG_SCHEMA_VERSION}`)
  }
  if (!Array.isArray(candidate.targets) || candidate.targets.length > MAXIMUM_TARGETS) {
    throw new TypeError(`Configuration targets must be an array with at most ${MAXIMUM_TARGETS} entries`)
  }
  const defaults = normalizeDefaults(candidate.defaults)
  const targets = candidate.targets.map((target) => normalizeTarget(target, defaults))
  const ids = new Set()
  const urls = new Set()
  for (const target of targets) {
    if (ids.has(target.id)) throw new TypeError(`Duplicate target ID: ${target.id}`)
    if (urls.has(target.url)) throw new TypeError(`Duplicate target URL: ${target.url}`)
    ids.add(target.id)
    urls.add(target.url)
  }
  return Object.freeze({
    defaults,
    schemaVersion: CONFIG_SCHEMA_VERSION,
    targets: Object.freeze(targets),
  })
}

function targetFingerprintInput(target) {
  return JSON.stringify({
    expectedStatuses: target.expectedStatuses,
    failureThreshold: target.failureThreshold,
    id: target.id,
    method: target.method,
    recoveryThreshold: target.recoveryThreshold,
    timeoutMilliseconds: target.timeoutMilliseconds,
    url: target.url,
  })
}

export async function configuredTargets(configuration) {
  const normalized = normalizeConfiguration(configuration)
  return Promise.all(normalized.targets.map(async (target) => Object.freeze({
    ...target,
    configFingerprint: `sha256:${await sha256Hex(targetFingerprintInput(target))}`,
  })))
}

export function portableConfiguration(configuration) {
  const normalized = normalizeConfiguration(configuration)
  return {
    defaults: { ...normalized.defaults },
    schemaVersion: normalized.schemaVersion,
    targets: normalized.targets.map((target) => ({
      ...(target.expectedStatuses
        ? { expectedStatuses: [...target.expectedStatuses] }
        : {}),
      failureThreshold: target.failureThreshold,
      id: target.id,
      method: target.method,
      recoveryThreshold: target.recoveryThreshold,
      timeoutMilliseconds: target.timeoutMilliseconds,
      url: target.url,
    })),
  }
}

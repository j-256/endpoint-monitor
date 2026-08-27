import {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_CONFIGURATION,
  SUPPORTED_CONFIG_SCHEMA_VERSIONS,
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
const TARGET_KEYS_V2 = new Set([...TARGET_KEYS, "expect"])
const EXPECTATION_KEYS = new Set([
  "bodyIncludes",
  "contentType",
  "jsonSubset",
  "location",
])
const LOCATION_KEYS = new Set(["ignoreQuery", "url"])
const HTTP_METHODS = new Set(["GET", "HEAD"])
const MEDIA_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/
const TARGET_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const MAXIMUM_BODY_MARKER_BYTES = 1024
const MAXIMUM_JSON_SUBSET_BYTES = 4096
const MAXIMUM_JSON_SUBSET_DEPTH = 8
const MAXIMUM_TARGETS = 1000
const NON_PUBLIC_HOSTNAME_SUFFIXES = Object.freeze([
  ".example",
  ".home.arpa",
  ".internal",
  ".invalid",
  ".local",
  ".localhost",
  ".onion",
  ".test",
])

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

function publicDnsHostname(value) {
  const hostname = value.toLowerCase().replace(/\.$/, "")
  return hostname.includes(".")
    && !hostname.startsWith("[")
    && !/^\d+(?:\.\d+){3}$/.test(hostname)
    && !NON_PUBLIC_HOSTNAME_SUFFIXES.some((suffix) => (
      hostname === suffix.slice(1) || hostname.endsWith(suffix)
    ))
}

function publicUrl(value, label) {
  if (typeof value !== "string" || value !== value.trim()) {
    throw new TypeError(`${label} must be a trimmed string`)
  }
  let url
  try {
    url = new URL(value)
  } catch {
    throw new TypeError(`${label} must be an absolute HTTP or HTTPS URL`)
  }
  if (!["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
    || url.hash
    || !publicDnsHostname(url.hostname)) {
    throw new TypeError(`${label} must use a public DNS hostname without credentials or a fragment`)
  }
  return url.toString()
}

function targetUrl(value) {
  return publicUrl(value, "Target URL")
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

function encodedLength(value) {
  return new TextEncoder().encode(value).byteLength
}

function bodyMarker(value) {
  if (typeof value !== "string"
    || value.trim().length === 0
    || encodedLength(value) > MAXIMUM_BODY_MARKER_BYTES) {
    throw new TypeError("Expected body marker must be a non-empty string of at most 1024 bytes")
  }
  return value
}

function contentType(value) {
  if (typeof value !== "string") {
    throw new TypeError("Expected content type must be a media type")
  }
  const normalized = value.trim().toLowerCase()
  if (!MEDIA_TYPE_PATTERN.test(normalized)) {
    throw new TypeError("Expected content type must be a media type without parameters")
  }
  return normalized
}

function normalizeJsonValue(value, depth, seen) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value
  }
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "object" || depth > MAXIMUM_JSON_SUBSET_DEPTH) {
    throw new TypeError("Expected JSON subset must contain bounded JSON values")
  }
  if (seen.has(value)) {
    throw new TypeError("Expected JSON subset must not contain cycles")
  }
  seen.add(value)
  let normalized
  if (Array.isArray(value)) {
    normalized = Object.freeze(value.map((entry) => (
      normalizeJsonValue(entry, depth + 1, seen)
    )))
  } else {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Expected JSON subset must contain plain JSON objects")
    }
    normalized = Object.freeze(Object.fromEntries(
      Object.keys(value).sort().map((key) => [
        key,
        normalizeJsonValue(value[key], depth + 1, seen),
      ]),
    ))
  }
  seen.delete(value)
  return normalized
}

function jsonSubset(value) {
  if (value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).length === 0) {
    throw new TypeError("Expected JSON subset must be a non-empty object")
  }
  const normalized = normalizeJsonValue(value, 0, new WeakSet())
  if (encodedLength(JSON.stringify(normalized)) > MAXIMUM_JSON_SUBSET_BYTES) {
    throw new TypeError("Expected JSON subset must be at most 4096 bytes")
  }
  return normalized
}

function locationExpectation(value) {
  const candidate = objectValue(value, "Expected location")
  rejectUnknownKeys(candidate, LOCATION_KEYS, "Expected location")
  if (candidate.ignoreQuery !== undefined
    && typeof candidate.ignoreQuery !== "boolean") {
    throw new TypeError("Expected location ignoreQuery must be boolean")
  }
  return Object.freeze({
    ignoreQuery: candidate.ignoreQuery ?? false,
    url: publicUrl(candidate.url, "Expected location URL"),
  })
}

function responseExpectation(value, method, statuses) {
  if (value === undefined) return null
  const candidate = objectValue(value, "Target expectation")
  rejectUnknownKeys(candidate, EXPECTATION_KEYS, "Target expectation")
  if (Object.keys(candidate).length === 0) {
    throw new TypeError("Target expectation must contain at least one assertion")
  }
  const normalized = Object.freeze({
    ...(candidate.bodyIncludes !== undefined
      ? { bodyIncludes: bodyMarker(candidate.bodyIncludes) }
      : {}),
    ...(candidate.contentType !== undefined
      ? { contentType: contentType(candidate.contentType) }
      : {}),
    ...(candidate.jsonSubset !== undefined
      ? { jsonSubset: jsonSubset(candidate.jsonSubset) }
      : {}),
    ...(candidate.location !== undefined
      ? { location: locationExpectation(candidate.location) }
      : {}),
  })
  if (method === "HEAD"
    && (normalized.bodyIncludes !== undefined
      || normalized.jsonSubset !== undefined)) {
    throw new TypeError("HEAD targets cannot assert response bodies")
  }
  if (normalized.location
    && (!statuses || statuses.some((status) => status < 300 || status > 399))) {
    throw new TypeError("Location assertions require explicit 3xx expected statuses")
  }
  return normalized
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

function normalizeTarget(value, defaults, schemaVersion) {
  const candidate = objectValue(value, "Target")
  rejectUnknownKeys(
    candidate,
    schemaVersion === CONFIG_SCHEMA_VERSION ? TARGET_KEYS_V2 : TARGET_KEYS,
    "Target",
  )
  const method = methodValue(candidate.method ?? defaults.method, "Target method")
  const statuses = expectedStatuses(candidate.expectedStatuses)
  return Object.freeze({
    expect: responseExpectation(candidate.expect, method, statuses),
    expectedStatuses: statuses,
    failureThreshold: boundedInteger(
      candidate.failureThreshold ?? defaults.failureThreshold,
      "Target failure threshold",
      1,
      10,
    ),
    id: targetId(candidate.id),
    method,
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
  if (!SUPPORTED_CONFIG_SCHEMA_VERSIONS.includes(candidate.schemaVersion)) {
    throw new TypeError(`Configuration schemaVersion must be one of ${SUPPORTED_CONFIG_SCHEMA_VERSIONS.join(", ")}`)
  }
  if (!Array.isArray(candidate.targets) || candidate.targets.length > MAXIMUM_TARGETS) {
    throw new TypeError(`Configuration targets must be an array with at most ${MAXIMUM_TARGETS} entries`)
  }
  const defaults = normalizeDefaults(candidate.defaults)
  const targets = candidate.targets.map((target) => (
    normalizeTarget(target, defaults, candidate.schemaVersion)
  ))
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
    schemaVersion: candidate.schemaVersion,
    targets: Object.freeze(targets),
  })
}

function targetFingerprintInput(target) {
  return JSON.stringify({
    ...(target.expect ? { expect: target.expect } : {}),
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
      ...(target.expect
        ? { expect: JSON.parse(JSON.stringify(target.expect)) }
        : {}),
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

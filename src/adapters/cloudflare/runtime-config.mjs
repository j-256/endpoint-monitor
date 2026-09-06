import {
  configuredTargets,
  normalizeConfiguration,
  portableConfiguration,
} from "../../config.mjs"
import { normalizeHookrelayUrl } from "../../hookrelay.mjs"
import { readStoredConfiguration } from "./d1-store.mjs"

let cachedConfiguration = null

function runtimeError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function flag(env, name) {
  const value = env?.[name]
  if (value === undefined) return false
  if (value === true || value === "true") return true
  if (value === false || value === "false") return false
  throw runtimeError("invalid-runtime-flag")
}

function requiredString(env, name, code) {
  const value = env?.[name]
  if (typeof value !== "string" || !value) throw runtimeError(code)
  return value
}

function databaseBinding(env) {
  const db = env?.MONITOR_DB
  if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function") {
    throw runtimeError("monitor-database-unavailable")
  }
  return db
}

export function readRuntimeSettings(env) {
  const analyticsEnabled = flag(env, "CLOUDFLARE_ANALYTICS_ENABLED")
  const deliveryEnabled = flag(env, "ENDPOINT_MONITOR_DELIVERY_ENABLED")
  const enabled = flag(env, "ENDPOINT_MONITOR_ENABLED")
  const statusEnabled = flag(env, "ENDPOINT_MONITOR_STATUS_ENABLED")
  const analytics = analyticsEnabled
    ? Object.freeze({
      accountId: requiredString(
        env,
        "CLOUDFLARE_ACCOUNT_ID",
        "cloudflare-account-id-unavailable",
      ),
      apiToken: requiredString(
        env,
        "CLOUDFLARE_API_TOKEN",
        "cloudflare-api-token-unavailable",
      ),
    })
    : null
  const delivery = deliveryEnabled
    ? Object.freeze({
      hmac: requiredString(
        env,
        "ENDPOINT_MONITOR_HOOKRELAY_HMAC",
        "hookrelay-hmac-unavailable",
      ),
      url: normalizeHookrelayUrl(requiredString(
        env,
        "ENDPOINT_MONITOR_HOOKRELAY_URL",
        "hookrelay-url-unavailable",
      )),
    })
    : null
  return Object.freeze({
    analytics,
    analyticsEnabled,
    db: enabled || statusEnabled ? databaseBinding(env) : env?.MONITOR_DB || null,
    delivery,
    deliveryEnabled,
    enabled,
    statusEnabled,
    statusToken: statusEnabled
      ? requiredString(
        env,
        "ENDPOINT_MONITOR_STATUS_TOKEN",
        "status-token-unavailable",
      )
      : null,
  })
}

export async function loadStoredConfiguration(db) {
  const stored = await readStoredConfiguration(db)
  if (!stored) throw runtimeError("monitor-configuration-unavailable")
  if (cachedConfiguration?.configJson === stored.configJson) {
    return Object.freeze({
      configFingerprint: stored.configFingerprint,
      revision: stored.revision,
      configuration: cachedConfiguration.configuration,
      portableConfiguration: cachedConfiguration.portableConfiguration,
      targets: cachedConfiguration.targets,
      updatedAt: stored.updatedAt,
    })
  }
  let candidate
  try {
    candidate = JSON.parse(stored.configJson)
  } catch {
    throw runtimeError("monitor-configuration-invalid")
  }
  let configuration
  let portable
  let targets
  try {
    configuration = normalizeConfiguration(candidate)
    portable = portableConfiguration(candidate)
    targets = await configuredTargets(candidate)
  } catch {
    throw runtimeError("monitor-configuration-invalid")
  }
  if (stored.schemaVersion !== configuration.schemaVersion
    || stored.targetCount !== targets.length
    || !/^sha256:[a-f0-9]{64}$/.test(stored.configFingerprint)) {
    throw runtimeError("monitor-configuration-metadata-invalid")
  }
  cachedConfiguration = Object.freeze({
    configJson: stored.configJson,
    configuration,
    portableConfiguration: Object.freeze(portable),
    targets: Object.freeze(targets),
  })
  return Object.freeze({
    configFingerprint: stored.configFingerprint,
    revision: stored.revision,
    configuration,
    portableConfiguration: cachedConfiguration.portableConfiguration,
    targets: cachedConfiguration.targets,
    updatedAt: stored.updatedAt,
  })
}

import { lstat, readFile } from "node:fs/promises"
import path from "node:path"

import { portableConfiguration } from "./config.mjs"
import { sha256Hex } from "./crypto.mjs"

const DEFAULT_PROFILE_PATH = path.resolve(".endpoint-monitor.local.json")
const DATABASE_ID_PATTERN = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const SERVICE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const EXIT = Object.freeze({ USAGE: 2 })
const PROFILE_KEYS = new Set(["configPath", "schemaVersion", "wranglerPath"])

class OperatorError extends Error {
  constructor(message, exitCode = EXIT.USAGE) {
    super(message)
    this.exitCode = exitCode
  }
}

function dependencies(overrides = {}) {
  return {
    lstatImpl: lstat,
    readFileImpl: readFile,
    ...overrides,
  }
}

async function readJson(filename, label, overrides, privateFile) {
  const resolved = dependencies(overrides)
  let source
  try {
    if (privateFile) {
      const metadata = await resolved.lstatImpl(filename)
      if (metadata.isSymbolicLink()
        || !metadata.isFile()
        || (metadata.mode & 0o077) !== 0) {
        throw new Error("unsafe file")
      }
    }
    source = await resolved.readFileImpl(filename, "utf8")
  } catch {
    throw new OperatorError(privateFile
      ? `${label} must be a mode-0600 regular file: ${filename}`
      : `Cannot read ${label.toLowerCase()}: ${filename}`)
  }
  try {
    return JSON.parse(source)
  } catch {
    throw new OperatorError(`${label} is not valid JSON: ${filename}`)
  }
}

function validateProfile(value) {
  if (value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || value.schemaVersion !== 1
    || typeof value.configPath !== "string"
    || !path.isAbsolute(value.configPath)
    || typeof value.wranglerPath !== "string"
    || !path.isAbsolute(value.wranglerPath)
    || Object.keys(value).some((key) => !PROFILE_KEYS.has(key))) {
    throw new OperatorError("Operator profile is invalid")
  }
  return Object.freeze(value)
}

export async function loadOperatorProfile(profilePath, overrides = {}) {
  return validateProfile(await readJson(
    profilePath,
    "Operator profile",
    overrides,
    true,
  ))
}

export async function loadTargetDocument(
  configPath,
  overrides = {},
  { privateFile = false } = {},
) {
  const candidate = await readJson(
    configPath,
    "Target document",
    overrides,
    privateFile,
  )
  let portable
  try {
    portable = portableConfiguration(candidate)
  } catch (error) {
    throw new OperatorError(error.message)
  }
  const configJson = JSON.stringify(portable)
  return Object.freeze({
    candidate,
    configFingerprint: `sha256:${await sha256Hex(configJson)}`,
    configJson,
    portable,
  })
}

export async function loadOperatorTarget(profilePath, overrides = {}) {
  const profile = await loadOperatorProfile(profilePath, overrides)
  const loaded = await loadTargetDocument(
    profile.configPath,
    overrides,
    { privateFile: true },
  )
  return Object.freeze({ loaded, profile })
}

export async function loadOperatorWrangler(profile, overrides = {}) {
  return readJson(
    profile.wranglerPath,
    "Wrangler configuration",
    overrides,
    true,
  )
}

export function monitorDatabaseId(wrangler) {
  const binding = wrangler?.d1_databases?.find((entry) => entry.binding === "MONITOR_DB")
  if (!binding || !DATABASE_ID_PATTERN.test(binding.database_id || "")) {
    throw new OperatorError("Wrangler configuration has no valid MONITOR_DB binding")
  }
  return binding.database_id
}

export function monitorDatabaseName(wrangler) {
  const binding = wrangler?.d1_databases?.find((entry) => entry.binding === "MONITOR_DB")
  if (!binding || !SERVICE_NAME_PATTERN.test(binding.database_name || "")) {
    throw new OperatorError("Wrangler configuration has no valid MONITOR_DB name")
  }
  return binding.database_name
}

export function monitorWorkerName(wrangler) {
  if (!SERVICE_NAME_PATTERN.test(wrangler?.name || "")) {
    throw new OperatorError("Wrangler configuration has no valid Worker name")
  }
  return wrangler.name
}

export {
  DEFAULT_PROFILE_PATH,
  OperatorError,
}

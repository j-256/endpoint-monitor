import { portableConfiguration } from "../../config.mjs"
import { sha256Hex } from "../../crypto.mjs"
import { probeSchedule } from "../../schedule.mjs"
import { CLOUDFLARE_RUNTIME_LIMITS } from "./runtime-limits.mjs"

export const CONFIGURATION_LIMITS = Object.freeze({
  historyRevisions: 100,
  maximumBytes: 256 * 1024,
  maximumRevision: Number.MAX_SAFE_INTEGER,
})
export const CONFIGURATION_FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/
const CONFIGURATION_COLUMNS = `schema_version, config_json, config_fingerprint,
  target_count, updated_at, revision, updated_by, updated_workspace`
const READ_SQL = `SELECT ${CONFIGURATION_COLUMNS}
  FROM monitor_configuration WHERE singleton_id = 1`
const RETURNING_COLUMNS = `revision, config_fingerprint, target_count, updated_at,
  updated_by, updated_workspace`
const INSERT_SQL = `INSERT INTO monitor_configuration (
  singleton_id, schema_version, config_json, config_fingerprint, target_count,
  updated_at, updated_by, updated_workspace, revision
) SELECT 1, ?, ?, ?, ?, ?, ?, ?, 1
  WHERE NOT EXISTS (SELECT 1 FROM monitor_configuration)
RETURNING ${RETURNING_COLUMNS}`
const UPDATE_SQL = `UPDATE monitor_configuration
SET schema_version = ?, config_json = ?, config_fingerprint = ?, target_count = ?,
  updated_at = ?, updated_by = ?, updated_workspace = ?, revision = revision + 1
WHERE singleton_id = 1 AND revision = ? AND config_fingerprint <> ?
RETURNING ${RETURNING_COLUMNS}`
const IDENTITY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,127}$/

export class ConfigurationAuthorityError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message)
    this.code = code
    this.exitCode = exitCode
  }
}

function conflict() {
  return new ConfigurationAuthorityError(
    "configuration-conflict",
    "Remote configuration changed. Run config review and review the candidate again.",
  )
}

function metadata(row) {
  return Object.freeze({
    configFingerprint: row.config_fingerprint,
    revision: Number(row.revision),
    targetCount: Number(row.target_count),
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    updatedWorkspace: row.updated_workspace,
  })
}

export function validateConfigurationExpectation(revision, fingerprint) {
  if (!Number.isSafeInteger(revision) || revision < 0
    || revision >= CONFIGURATION_LIMITS.maximumRevision) {
    throw new ConfigurationAuthorityError(
      "configuration-revision-invalid",
      "--expect-revision must be a nonnegative safe integer from config review",
      2,
    )
  }
  if (!CONFIGURATION_FINGERPRINT_PATTERN.test(fingerprint || "")) {
    throw new ConfigurationAuthorityError(
      "configuration-fingerprint-invalid",
      "--expect-fingerprint must be the sha256 fingerprint from config review",
      2,
    )
  }
}

export async function configurationCandidate(candidate) {
  const portable = portableConfiguration(candidate)
  const configJson = JSON.stringify(portable)
  if (new TextEncoder().encode(configJson).byteLength > CONFIGURATION_LIMITS.maximumBytes) {
    throw new ConfigurationAuthorityError(
      "configuration-too-large",
      "Target document exceeds the Cloudflare configuration size limit",
      2,
    )
  }
  probeSchedule(
    portable.targets,
    portable.defaults.probeIntervalMinutes,
    "1970-01-01T00:00:00.000Z",
    CLOUDFLARE_RUNTIME_LIMITS.maximumProbesPerRun,
  )
  return Object.freeze({
    configFingerprint: `sha256:${await sha256Hex(configJson)}`,
    configJson,
    portable,
  })
}

export function d1ConfigurationQuery(db) {
  return async ({ sql, params = [] }) => [await db.prepare(sql).bind(...params).all()]
}

export async function readConfigurationAuthority(query) {
  const [result] = await query({ sql: READ_SQL, params: [] })
  if (!Array.isArray(result?.results) || result.results.length > 1) {
    throw new ConfigurationAuthorityError(
      "configuration-response-invalid",
      "Cloudflare D1 returned invalid configuration metadata",
    )
  }
  const row = result.results[0]
  if (!row) return null
  try {
    const loaded = await configurationCandidate(JSON.parse(row.config_json))
    if (!Number.isSafeInteger(row.revision) || row.revision < 1
      || row.schema_version !== loaded.portable.schemaVersion
      || row.target_count !== loaded.portable.targets.length
      || row.config_fingerprint !== loaded.configFingerprint) throw new Error()
    return Object.freeze({ ...metadata(row), configuration: loaded.portable })
  } catch {
    throw new ConfigurationAuthorityError(
      "configuration-stored-invalid",
      "Stored configuration is invalid or exceeds runtime capacity; preserve it for explicit recovery",
    )
  }
}

export async function reviewConfiguration(query, candidate) {
  const loaded = await configurationCandidate(candidate)
  const remote = await readConfigurationAuthority(query)
  const before = new Map((remote?.configuration.targets ?? []).map((target) => [target.id, target]))
  const after = new Map(loaded.portable.targets.map((target) => [target.id, target]))
  return Object.freeze({
    addedIds: [...after.keys()].filter((id) => !before.has(id)).sort(),
    changedIds: [...after.keys()].filter((id) => before.has(id)
      && JSON.stringify(before.get(id)) !== JSON.stringify(after.get(id))).sort(),
    defaultsChanged: JSON.stringify(remote?.configuration.defaults ?? null)
      !== JSON.stringify(loaded.portable.defaults),
    expectedFingerprint: loaded.configFingerprint,
    expectedRevision: remote?.revision ?? 0,
    remoteFingerprint: remote?.configFingerprint ?? null,
    remoteTargetCount: remote?.targetCount ?? 0,
    removedIds: [...before.keys()].filter((id) => !after.has(id)).sort(),
    targetCount: loaded.portable.targets.length,
    unchanged: loaded.configFingerprint === remote?.configFingerprint,
  })
}

export async function prepareConfigurationWrite(query, candidate, {
  expectedFingerprint,
  expectedRevision,
  updatedAt,
  updatedBy = "operator-cli",
  updatedWorkspace = "operator",
  guard = null,
}) {
  validateConfigurationExpectation(expectedRevision, expectedFingerprint)
  const loaded = await configurationCandidate(candidate)
  if (loaded.configFingerprint !== expectedFingerprint) {
    throw new ConfigurationAuthorityError(
      "configuration-candidate-changed",
      "Local candidate changed since review. Run config review again; nothing was written.",
      2,
    )
  }
  if (!IDENTITY_PATTERN.test(updatedBy) || !IDENTITY_PATTERN.test(updatedWorkspace)
    || typeof updatedAt !== "string" || !Number.isFinite(Date.parse(updatedAt))
    || new Date(updatedAt).toISOString() !== updatedAt) {
    throw new ConfigurationAuthorityError(
      "configuration-writer-invalid", "Configuration writer identity or timestamp is invalid", 2,
    )
  }
  const before = await readConfigurationAuthority(query)
  if ((before?.revision ?? 0) !== expectedRevision) throw conflict()
  if (before?.configFingerprint === loaded.configFingerprint) {
    const { configuration: _configuration, ...result } = before
    return { result: Object.freeze({ ...result, changed: false, rowsWritten: 0 }), statement: null }
  }
  const params = [
    loaded.portable.schemaVersion, loaded.configJson, loaded.configFingerprint,
    loaded.portable.targets.length, updatedAt, updatedBy, updatedWorkspace,
  ]
  if (expectedRevision > 0) params.push(expectedRevision, loaded.configFingerprint)
  return {
    statement: {
      sql: guard
        ? (expectedRevision === 0 ? INSERT_SQL : UPDATE_SQL).replace("RETURNING", `AND (${guard.sql})\nRETURNING`)
        : expectedRevision === 0 ? INSERT_SQL : UPDATE_SQL,
      params: [...params, ...(guard?.params ?? [])],
    },
    result: { revision: expectedRevision + 1, configFingerprint: expectedFingerprint,
      targetCount: loaded.portable.targets.length, updatedAt, updatedBy, updatedWorkspace, changed: true },
  }
}

export async function writeConfigurationAuthority(query, candidate, options) {
  const prepared = await prepareConfigurationWrite(query, candidate, options)
  if (!prepared.statement) return prepared.result
  const [result] = await query(prepared.statement)
  const row = result?.results?.[0]
  if (!row) throw conflict()
  if (result.results.length !== 1 || row.revision !== prepared.result.revision
    || row.config_fingerprint !== prepared.result.configFingerprint) {
    throw new ConfigurationAuthorityError(
      "configuration-outcome-unknown",
      "Configuration outcome is unverified. Inspect config remote before making another change.",
    )
  }
  return Object.freeze({
    ...metadata(row), changed: true,
    rowsWritten: Number(result.meta?.rows_written ?? result.meta?.changes ?? 0),
  })
}

import { OBSERVATION_OUTCOME } from "../../constants.mjs"
import { CLOUDFLARE_RUNTIME_LIMITS } from "./runtime-limits.mjs"

export const RUN_STATUS_LIMITS = Object.freeze({
  slots: 120,
  snapshotBytes: 16 * 1024,
  intervalMilliseconds: 60000,
  graceMilliseconds: 2 * 60000,
  maximumTargets: 1000,
})
const FINGERPRINT = /^sha256:[a-f0-9]{64}$/
const TARGET_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const ERROR_CODE = /^[a-z][a-z0-9-]{0,63}$/
const SUMMARY_LIMITS = Object.freeze({
  targetCount: RUN_STATUS_LIMITS.maximumTargets,
  dueTargets: CLOUDFLARE_RUNTIME_LIMITS.maximumProbesPerRun,
  succeededProbes: CLOUDFLARE_RUNTIME_LIMITS.maximumProbesPerRun,
  failedProbes: CLOUDFLARE_RUNTIME_LIMITS.maximumProbesPerRun,
  phaseErrors: 1,
  deliveriesFailed: CLOUDFLARE_RUNTIME_LIMITS.maximumDeliveriesPerRun,
  subrequests: CLOUDFLARE_RUNTIME_LIMITS.externalSubrequests,
})
const SUMMARY_FIELDS = Object.keys(SUMMARY_LIMITS)

function invalid() {
  const error = new Error("run-status-invalid")
  error.code = "run-status-invalid"
  throw error
}

function time(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) invalid()
  return Date.parse(value)
}

function integer(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid()
  return value
}

function checkedSnapshot(value) {
  if (!value || typeof value !== "object" || typeof value.enabled !== "boolean") invalid()
  const scheduled = time(value.scheduledAt)
  const started = time(value.startedAt)
  const completed = time(value.completedAt)
  if (scheduled < 0 || started < scheduled || completed < started) invalid()
  if (!Array.isArray(value.checks)
    || value.checks.length > CLOUDFLARE_RUNTIME_LIMITS.maximumProbesPerRun) invalid()
  if (value.enabled) {
    integer(value.configurationRevision, 1, Number.MAX_SAFE_INTEGER)
    if (!FINGERPRINT.test(value.configFingerprint)) invalid()
    integer(value.probeIntervalMinutes, 1, 60)
  } else if (value.configurationRevision !== null || value.configFingerprint !== null
    || value.probeIntervalMinutes !== null || value.checks.length) invalid()
  const summary = {}
  for (const key of SUMMARY_FIELDS) summary[key] = integer(value[key], 0, SUMMARY_LIMITS[key])
  if (summary.dueTargets !== value.checks.length
    || summary.succeededProbes + summary.failedProbes !== summary.dueTargets) invalid()
  const seen = new Set()
  const checks = value.checks.map((check) => {
    if (!check || !TARGET_ID.test(check.targetId) || seen.has(check.targetId)
      || !FINGERPRINT.test(check.configFingerprint)
      || !Object.values(OBSERVATION_OUTCOME).includes(check.outcome)
      || time(check.observedAt) < started || time(check.observedAt) > completed
      || (check.status !== null && (!Number.isInteger(check.status) || check.status < 100 || check.status > 599))
      || (check.errorCode !== null && !ERROR_CODE.test(check.errorCode))) invalid()
    seen.add(check.targetId)
    return { targetId: check.targetId, configFingerprint: check.configFingerprint,
      observedAt: check.observedAt, outcome: check.outcome, status: check.status, errorCode: check.errorCode }
  })
  if (checks.filter((check) => check.outcome === OBSERVATION_OUTCOME.SUCCESS).length !== summary.succeededProbes) invalid()
  return { scheduledAt: value.scheduledAt, startedAt: value.startedAt, completedAt: value.completedAt,
    enabled: value.enabled, configurationRevision: value.configurationRevision,
    configFingerprint: value.configFingerprint, probeIntervalMinutes: value.probeIntervalMinutes,
    ...summary, checks }
}

export async function writeRunStatus(db, { scheduledAt, startedAt, completedAt, loaded = null, probes = [], summary }) {
  const snapshot = checkedSnapshot({
    scheduledAt, startedAt, completedAt, enabled: summary.enabled,
    configurationRevision: loaded?.revision ?? null,
    configFingerprint: loaded?.configFingerprint ?? null,
    probeIntervalMinutes: loaded?.configuration.defaults.probeIntervalMinutes ?? null,
    ...Object.fromEntries(SUMMARY_FIELDS.map((key) => [key, summary[key] ?? 0])),
    checks: probes.map(({ target, observation }) => ({
      targetId: target.id, configFingerprint: target.configFingerprint,
      observedAt: observation.observedAt, outcome: observation.outcome,
      status: observation.status ?? null, errorCode: observation.errorCode ?? null,
    })),
  })
  const json = JSON.stringify(snapshot)
  if (new TextEncoder().encode(json).byteLength > RUN_STATUS_LIMITS.snapshotBytes) invalid()
  const minute = Math.floor(Date.parse(scheduledAt) / RUN_STATUS_LIMITS.intervalMilliseconds)
  const result = await db.prepare(`INSERT INTO monitor_run_status (slot, scheduled_minute, snapshot_json)
    VALUES (?, ?, ?) ON CONFLICT (slot) DO UPDATE SET
      scheduled_minute = excluded.scheduled_minute, snapshot_json = excluded.snapshot_json
    WHERE excluded.scheduled_minute > monitor_run_status.scheduled_minute`)
    .bind(minute % RUN_STATUS_LIMITS.slots, minute, json).run()
  return Number(result.meta?.changes ?? 0)
}

export async function readRunSnapshots(query) {
  const [result] = await query({
    sql: "SELECT scheduled_minute, snapshot_json FROM monitor_run_status ORDER BY scheduled_minute DESC LIMIT ?",
    params: [RUN_STATUS_LIMITS.slots],
  })
  if (!Array.isArray(result?.results) || result.results.length > RUN_STATUS_LIMITS.slots) invalid()
  return result.results.map((row) => {
    if (typeof row.snapshot_json !== "string"
      || new TextEncoder().encode(row.snapshot_json).byteLength > RUN_STATUS_LIMITS.snapshotBytes) invalid()
    let value
    try { value = JSON.parse(row.snapshot_json) } catch { invalid() }
    const snapshot = checkedSnapshot(value)
    if (Math.floor(Date.parse(snapshot.scheduledAt) / RUN_STATUS_LIMITS.intervalMilliseconds) !== row.scheduled_minute) invalid()
    return snapshot
  })
}

export function executionEvidence(snapshots, now) {
  const latest = snapshots[0] ?? null
  const { checks: _checks, ...lastRun } = latest ?? {}
  const freshUntil = latest ? new Date(Date.parse(latest.scheduledAt)
    + RUN_STATUS_LIMITS.intervalMilliseconds + RUN_STATUS_LIMITS.graceMilliseconds).toISOString() : null
  return {
    state: !latest ? "unobserved"
      : time(now) < Date.parse(latest.completedAt) || time(now) >= Date.parse(freshUntil) ? "stale" : "fresh",
    freshUntil,
    expectedIntervalSeconds: RUN_STATUS_LIMITS.intervalMilliseconds / 1000,
    retainedRunLimit: RUN_STATUS_LIMITS.slots,
    lastRun: latest ? lastRun : null,
  }
}

export function targetCheckEvidence(snapshots, remote, target, now) {
  const entries = snapshots.flatMap((run) => run.checks
    .filter((check) => check.targetId === target.id).map((check) => ({ run, check })))
    .sort((left, right) => right.check.observedAt.localeCompare(left.check.observedAt)
      || right.run.scheduledAt.localeCompare(left.run.scheduledAt))
  const entry = entries[0]
  const matches = ({ run, check }) => run.configurationRevision === remote.revision
    && run.configFingerprint === remote.configFingerprint && check.configFingerprint === target.configFingerprint
  const lastSuccess = entries.find((value) => matches(value)
    && value.check.outcome === OBSERVATION_OUTCOME.SUCCESS && Date.parse(value.run.completedAt) <= time(now))
  const freshUntil = entry ? new Date(Math.min(Date.parse(entry.check.observedAt), Date.parse(entry.run.scheduledAt))
    + entry.run.probeIntervalMinutes * RUN_STATUS_LIMITS.intervalMilliseconds
    + RUN_STATUS_LIMITS.graceMilliseconds).toISOString() : null
  const configurationMatches = entry ? matches(entry) : null
  return {
    state: !entry ? "unobserved" : !configurationMatches ? "configuration_changed"
      : time(now) < Date.parse(entry.run.completedAt) || time(now) >= Date.parse(freshUntil) ? "stale"
        : entry.check.outcome === OBSERVATION_OUTCOME.SUCCESS ? "passed" : "failed",
    observedAt: entry?.check.observedAt ?? null,
    lastSuccessAt: lastSuccess?.check.observedAt ?? null,
    freshUntil,
    scheduledAt: entry?.run.scheduledAt ?? null,
    configurationRevision: entry?.run.configurationRevision ?? null,
    configurationMatches,
    status: entry?.check.status ?? null,
    errorCode: entry?.check.errorCode ?? null,
  }
}

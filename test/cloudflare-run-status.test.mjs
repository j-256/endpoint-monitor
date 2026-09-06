import assert from "node:assert/strict"
import test from "node:test"
import { configuredTargets } from "../src/config.mjs"
import { configurationCandidate, d1ConfigurationQuery, readConfigurationAuthority, writeConfigurationAuthority } from "../src/adapters/cloudflare/configuration-authority.mjs"
import { readManagementSnapshot, readManagementTargets } from "../src/adapters/cloudflare/management-read.mjs"
import { runCloudflareScheduled, runCloudflareScheduledSafely, handleCloudflareRequest } from "../src/adapters/cloudflare/runtime.mjs"
import { executionEvidence, readRunSnapshots, RUN_STATUS_LIMITS, targetCheckEvidence, writeRunStatus } from "../src/adapters/cloudflare/run-status.mjs"
import { d1Fixture } from "./d1.fixture.mjs"

const MINUTE = 60000
const START = Date.parse("2026-09-06T10:01:00.000Z")
const iso = (value) => new Date(value).toISOString()
const configuration = { schemaVersion: 2, defaults: { probeIntervalMinutes: 1 },
  targets: [{ id: "example-health", url: "https://example.com/private?operator=private", expect: { jsonSubset: { ok: true } } }] }
const quiet = { log() {}, error() {} }

async function fixture(context) {
  const db = d1Fixture(context)
  const candidate = await configurationCandidate(configuration)
  const query = d1ConfigurationQuery(db)
  await writeConfigurationAuthority(query, configuration, {
    expectedRevision: 0, expectedFingerprint: candidate.configFingerprint, updatedAt: iso(START),
  })
  const env = { MONITOR_DB: db, ENDPOINT_MONITOR_ENABLED: true }
  const run = (at = START, options = {}) => runCloudflareScheduled(env, at, {
    clock: () => at + 1000, fetchImpl: async () => Response.json({ ok: true, private: "never retained" }),
    logger: quiet, ...options,
  })
  return { db, query, env, run }
}

test("positive checks and scheduler evidence are bounded reads, distinct from incidents and HTTP liveness", async (context) => {
  const { db, query, env, run } = await fixture(context)
  assert.equal((await readManagementSnapshot(env, iso(START))).execution.state, "unobserved")
  await run()
  const writes = db.sqlite.prepare("SELECT total_changes() AS count").get().count
  const snapshot = await readManagementSnapshot(env, iso(START + 2000))
  assert.equal(snapshot.execution.state, "fresh")
  assert.equal(snapshot.execution.lastRun.succeededProbes, 1)
  assert.equal(snapshot.openIncidents.count, 0)
  const targets = await readManagementTargets(db, { workspaceId: "example" }, iso(START + 2000))
  assert.equal(targets.items[0].evidence.check.state, "passed")
  assert.equal(targets.items[0].evidence.check.lastSuccessAt, iso(START + 1000))
  assert.equal(targets.items[0].evidence.state, "unobserved")
  const status = await handleCloudflareRequest(new Request("https://example.com/api/status", {
    headers: { authorization: "Bearer example-status-token" },
  }), { ...env, ENDPOINT_MONITOR_STATUS_ENABLED: true, ENDPOINT_MONITOR_STATUS_TOKEN: "example-status-token" }, { clock: () => START + 2000 })
  const body = await status.json()
  assert.deepEqual(body.execution, snapshot.execution)
  assert.deepEqual(body.targetChecks[0], { targetId: "example-health", ...targets.items[0].evidence.check })
  assert.equal(db.sqlite.prepare("SELECT total_changes() AS count").get().count, writes)
  const raw = db.sqlite.prepare("SELECT snapshot_json FROM monitor_run_status").get().snapshot_json
  for (const privateValue of ["https://", "operator", "never retained", "jsonSubset"]) assert.equal(raw.includes(privateValue), false)
  const runs = await readRunSnapshots(query)
  assert.equal(executionEvidence(runs, iso(START + 3 * MINUTE)).state, "stale")
  assert.equal(executionEvidence(runs, iso(START)).state, "stale")
  const remote = await readConfigurationAuthority(query)
  const [target] = await configuredTargets(configuration)
  assert.equal(targetCheckEvidence(runs, remote, target, iso(START + 3 * MINUTE)).state, "stale")
})

test("a failed check keeps a retained pass without presenting failure or a new configuration as healthy", async (context) => {
  const { db, query, run } = await fixture(context)
  await run()
  await run(START + MINUTE, { fetchImpl: async () => Response.json({ ok: false }) })
  const read = (at) => readManagementTargets(db, { workspaceId: "example" }, iso(at))
  const failed = (await read(START + MINUTE + 2000)).items[0].evidence.check
  assert.equal(failed.state, "failed")
  assert.equal(failed.lastSuccessAt, iso(START + 1000))
  assert.equal(failed.errorCode, "json-subset-mismatch")
  const changed = await configurationCandidate({ ...configuration, targets: [{ ...configuration.targets[0], url: "https://example.com/changed" }] })
  await writeConfigurationAuthority(query, changed.portable, {
    expectedRevision: 1, expectedFingerprint: changed.configFingerprint, updatedAt: iso(START + MINUTE + 3000),
  })
  const mismatch = (await read(START + MINUTE + 4000)).items[0].evidence.check
  assert.equal(mismatch.state, "configuration_changed")
  assert.equal(mismatch.configurationMatches, false)
  assert.equal(mismatch.lastSuccessAt, null)
  await run(START + 2 * MINUTE)
  assert.equal((await read(START + 2 * MINUTE + 2000)).items[0].evidence.check.state, "passed")
})

test("run slots reject duplicate and late replacements and retain independently completed minutes", async (context) => {
  const { db, query, run } = await fixture(context)
  await run(START + MINUTE)
  await run(START)
  const duplicate = await run(START + MINUTE, { fetchImpl: async () => Response.json({ ok: false }) })
  assert.equal(duplicate.runStatusWrites, 0)
  const runs = await readRunSnapshots(query)
  assert.deepEqual(runs.map((entry) => entry.scheduledAt), [iso(START + MINUTE), iso(START)])
  assert.equal(runs[0].checks[0].outcome, "success")
  const loaded = { ...(await readConfigurationAuthority(query)), targets: await configuredTargets(configuration) }
  const write = (at) => writeRunStatus(db, {
    scheduledAt: iso(at), startedAt: iso(at), completedAt: iso(at), loaded,
    probes: [], summary: { enabled: true },
  })
  for (let index = 2; index <= RUN_STATUS_LIMITS.slots; index += 1) await write(START + index * MINUTE)
  assert.equal((await readRunSnapshots(query)).length, RUN_STATUS_LIMITS.slots)
  assert.equal(await write(START), 0)
  assert.throws(() => db.sqlite.prepare("INSERT INTO monitor_run_status VALUES (120, 120, ?)")
    .run(JSON.stringify({ checks: [] })), /CHECK/)
  assert.throws(() => db.sqlite.prepare("UPDATE monitor_run_status SET snapshot_json=?")
    .run(JSON.stringify({ checks: [], body: "a".repeat(RUN_STATUS_LIMITS.snapshotBytes) })), /CHECK/)
})

test("empty and disabled runs have completion evidence without target passes; critical failures do not refresh it", async (context) => {
  const { db, env, query, run } = await fixture(context)
  await run()
  const disabled = await runCloudflareScheduled({ ...env, ENDPOINT_MONITOR_ENABLED: false }, START + MINUTE, {
    clock: () => START + MINUTE, logger: quiet, fetchImpl: () => assert.fail("Disabled probes must not run"),
  })
  assert.equal(disabled.runStatusWrites, 1)
  assert.equal((await readRunSnapshots(query))[0].enabled, false)
  const changed = await configurationCandidate({ ...configuration, targets: [] })
  await writeConfigurationAuthority(query, changed.portable, {
    expectedRevision: 1, expectedFingerprint: changed.configFingerprint, updatedAt: iso(START + MINUTE),
  })
  const empty = await run(START + 2 * MINUTE)
  assert.equal(empty.dueTargets, 0)
  assert.equal(empty.runStatusWrites, 1)
  db.sqlite.exec("CREATE TRIGGER fail_run BEFORE INSERT ON monitor_run_status BEGIN SELECT RAISE(ABORT, 'private storage detail'); END")
  const logs = []
  await assert.rejects(runCloudflareScheduledSafely(env, START + 3 * MINUTE, {
    clock: () => START + 3 * MINUTE, logger: { error: (value) => logs.push(value) },
  }), { message: "runtime-failed" })
  assert.equal(JSON.stringify(logs).includes("private storage"), false)
  assert.equal((await readRunSnapshots(query))[0].scheduledAt, iso(START + 2 * MINUTE))
  assert.equal((await readManagementSnapshot(env, iso(START + 5 * MINUTE))).execution.state, "stale")
})

test("late and changed-revision runs cannot refresh health by finishing now", async (context) => {
  const { db, query, run } = await fixture(context)
  await run(START, { clock: () => START + 10 * MINUTE })
  const snapshot = await readManagementTargets(db, { workspaceId: "example" }, iso(START + 10 * MINUTE))
  assert.equal(snapshot.items[0].evidence.check.state, "stale")
  const oldRuns = await readRunSnapshots(query)
  const remote = await readConfigurationAuthority(query)
  const [target] = await configuredTargets(configuration)
  assert.equal(targetCheckEvidence(oldRuns, { ...remote, revision: 3 }, target, iso(START + 10 * MINUTE)).state, "configuration_changed")
  assert.equal(executionEvidence(oldRuns, iso(START + 10 * MINUTE)).state, "stale")
})

test("corrupt or oversized snapshot reads fail closed and never echo stored content", async (context) => {
  const { query, run } = await fixture(context)
  await run()
  const [valid] = await query({ sql: "SELECT scheduled_minute, snapshot_json FROM monitor_run_status" })
  const row = valid.results[0]
  for (const patch of [{ snapshot_json: "private broken" }, { snapshot_json: "x".repeat(RUN_STATUS_LIMITS.snapshotBytes + 1) },
    { scheduled_minute: 0 }, { snapshot_json: JSON.stringify({ checks: [] }) },
    { snapshot_json: JSON.stringify({ ...JSON.parse(row.snapshot_json), checks: [{ targetId: "bad" }] }) }]) {
    await assert.rejects(readRunSnapshots(async () => [{ results: [{ ...row, ...patch }] }]), { message: "run-status-invalid" })
  }
  await assert.rejects(readRunSnapshots(async () => []), { message: "run-status-invalid" })
})

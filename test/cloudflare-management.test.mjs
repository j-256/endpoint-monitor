import assert from "node:assert/strict"
import test from "node:test"
import { configuredTargets } from "../src/config.mjs"
import { httpObservation } from "../src/core.mjs"
import { sha256Hex } from "../src/crypto.mjs"
import { configurationCandidate, d1ConfigurationQuery, writeConfigurationAuthority } from "../src/adapters/cloudflare/configuration-authority.mjs"
import { recordObservation } from "../src/adapters/cloudflare/d1-store.mjs"
import { handleManagement } from "../src/adapters/cloudflare/management.mjs"
import { MANAGEMENT_LIMITS, encodeCursor, readManagementBody } from "../src/adapters/cloudflare/management-contract.mjs"
import { CloudflareIncidentOperator } from "../src/adapters/cloudflare/operator-incidents.mjs"
import { handleCloudflareRequest } from "../src/adapters/cloudflare/runtime.mjs"
import { d1Fixture } from "./d1.fixture.mjs"

const HOUR_MS = 60 * 60 * 1000
const NOW = new Date().toISOString()
const TOKEN = `epm_${"a".repeat(43)}`
const PRINCIPAL = Object.freeze({ id: "example-hq", revision: 1, tokenHash: await sha256Hex(TOKEN),
  expiresAt: new Date(Date.parse(NOW) + 24 * HOUR_MS).toISOString(), workspaceIds: ["workspace-a"], capabilities: ["read", "configure", "triage"] })
const CANDIDATE = Object.freeze({ schemaVersion: 2, defaults: { failureThreshold: 1 },
  targets: [{ id: "example-health", url: "https://example.com/health" }] })

async function fixture(context, { initialize = true } = {}) {
  const db = d1Fixture(context)
  let now = Date.parse(NOW)
  let sequence = 0
  const logs = []
  const env = { MONITOR_DB: db, ENDPOINT_MONITOR_ENABLED: true, MANAGEMENT_CREDENTIALS: JSON.stringify([PRINCIPAL]) }
  if (initialize) {
    const candidate = await configurationCandidate(CANDIDATE)
    await writeConfigurationAuthority(d1ConfigurationQuery(db), CANDIDATE, {
      expectedRevision: 0, expectedFingerprint: candidate.configFingerprint, updatedAt: NOW,
    })
  }
  const run = async (command, input = {}, options = {}) => {
    const request = new Request("https://example.com/admin/api/v1", {
      method: options.method ?? "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...options.headers },
      ...(["GET", "HEAD"].includes(options.method) ? {} : { body: options.body ?? JSON.stringify({ version: 1, command, input: { workspaceId: "workspace-a", ...input } }) }),
    })
    const response = await handleManagement(request, options.env ?? env, {
      clock: () => now, randomUUID: () => `operation-${++sequence}`, logger: { warn: (value) => logs.push(value) },
    })
    return { status: response.status, body: await response.json(), headers: response.headers }
  }
  const open = async (id = "incident-one", targetId = "example-health") => {
    const [configured] = await configuredTargets(CANDIDATE)
    const target = { ...configured, id: targetId }
    return recordObservation(db, target, httpObservation(target, 520, NOW), { incidentId: id, recordedAt: NOW })
  }
  return { db, env, run, open, logs, setNow: (value) => { now = value } }
}

function result(response, status = 200) {
  assert.equal(response.status, status, JSON.stringify(response.body))
  assert.equal(response.headers.get("cache-control"), "no-store")
  return response.body.result
}

const actor = Object.freeze({ actorId: "operator-a" })
const apply = (run, plan) => run("operation_apply", { ...actor, planId: plan.id })

test("management authenticates before bodies or database work and remains separate from status auth", async (context) => {
  const { run, env } = await fixture(context)
  const unavailableDb = { ...env, MONITOR_DB: { prepare() { assert.fail("No database access") }, batch() { assert.fail("No database access") } } }
  result(await run("snapshot", {}, { env: unavailableDb, headers: { authorization: "Bearer status-token" }, body: "broken" }), 401)
  result(await run("snapshot", { workspaceId: "workspace-b" }, { env: unavailableDb }), 404)
  result(await run("configuration_plan", { ...actor, expectedRevision: 1, configuration: CANDIDATE }, {
    env: { ...unavailableDb, MANAGEMENT_CREDENTIALS: JSON.stringify([{ ...PRINCIPAL, capabilities: ["read"] }]) },
  }), 403)
  for (const credentials of ["bad", "[]", JSON.stringify([PRINCIPAL, PRINCIPAL]), "x".repeat(MANAGEMENT_LIMITS.credentialBytes + 1),
    JSON.stringify([{ ...PRINCIPAL, capabilities: ["read", "read"] }]),
    JSON.stringify([{ ...PRINCIPAL, revision: 0 }])]) {
    result(await run("snapshot", {}, { env: { ...unavailableDb, MANAGEMENT_CREDENTIALS: credentials } }), 503)
  }
  result(await run("snapshot", {}, { env: { ...unavailableDb, MANAGEMENT_CREDENTIALS: JSON.stringify([{ ...PRINCIPAL, expiresAt: NOW }]) } }), 401)
  const method = await run("snapshot", {}, { method: "GET" })
  result(method, 405)
  assert.equal(method.headers.get("allow"), "POST")
  const routed = await handleCloudflareRequest(new Request("https://example.com/admin/api/v1", { method: "POST" }), unavailableDb)
  assert.equal(routed.status, 401)
})

test("management rejects malformed, oversized, and unknown input without private error details", async (context) => {
  const { run, env, logs } = await fixture(context)
  for (const body of ["{", "[]", JSON.stringify({ version: 2, command: "snapshot", input: { workspaceId: "workspace-a" } }),
    JSON.stringify({ version: 1, command: "__proto__", input: { workspaceId: "workspace-a" } })]) {
    result(await run("snapshot", {}, { body }), 400)
  }
  for (const input of [{ workspaceId: "" }, { sql: "SELECT private" }]) result(await run("snapshot", input), 400)
  result(await run("snapshot", {}, { headers: { "content-type": "text/plain" } }), 400)
  result(await run("snapshot", {}, { headers: { "content-encoding": "gzip" } }), 400)
  result(await run("snapshot", {}, { body: "x".repeat(MANAGEMENT_LIMITS.bodyBytes + 1) }), 413)
  result(await run("snapshot", {}, { headers: { "content-length": String(MANAGEMENT_LIMITS.bodyBytes + 1) } }), 413)
  const failed = await run("snapshot", {}, { env: { ...env, MONITOR_DB: { prepare() { throw new Error("private target https://example.com/secret") }, batch() {} } } })
  result(failed, 503)
  assert.equal(JSON.stringify({ logs, body: failed.body }).includes("https://"), false)
  assert.equal(JSON.stringify({ logs, body: failed.body }).includes(TOKEN), false)
})

test("management body deadline covers a stalled stream without waiting for cancellation", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  const request = new Request("https://example.com/admin/api/v1", { method: "POST", duplex: "half",
    headers: { "content-type": "application/json" },
    body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{")) }, cancel() { return new Promise(() => {}) } }),
  })
  const body = readManagementBody(request)
  const rejected = assert.rejects(body, { code: "timeout", status: 408 })
  context.mock.timers.tick(MANAGEMENT_LIMITS.bodyMilliseconds)
  await rejected
})

test("management reads are bounded, private, and distinguish unobserved probes from health", async (context) => {
  const { db, env, run, open } = await fixture(context)
  const writes = db.sqlite.prepare("SELECT total_changes() AS count").get().count
  const snapshot = result(await run("snapshot"))
  assert.equal(snapshot.executionHealth, "unobserved")
  assert.equal(snapshot.configuration.revision, 1)
  assert.equal(snapshot.enabled, true)
  const targets = result(await run("targets"))
  assert.equal(targets.items[0].evidence.state, "unobserved")
  assert.equal(targets.readAt, NOW)
  result(await run("target", { targetId: "absent" }), 404)
  const configured = result(await run("configuration"))
  assert.equal(configured.configuration.configuration.targets[0].url, CANDIDATE.targets[0].url)
  assert.equal(db.sqlite.prepare("SELECT total_changes() AS count").get().count, writes)
  await open()
  assert.equal(result(await run("target", { targetId: "example-health" })).items[0].evidence.state, "incident")
  const changed = await configurationCandidate({ ...CANDIDATE, targets: [{ id: "example-health", url: "https://example.com/changed" }] })
  await writeConfigurationAuthority(d1ConfigurationQuery(db), changed.portable, {
    expectedRevision: 1, expectedFingerprint: changed.configFingerprint, updatedAt: NOW,
  })
  assert.equal(result(await run("targets")).items[0].evidence.state, "configuration_changed")
  assert.equal(result(await run("snapshot", {}, { env: { ...env, ENDPOINT_MONITOR_DELIVERY_ENABLED: true } })).runtimeConfigured, false)
})

test("configuration review and acceptance share the CLI authority and idempotent durable receipts", async (context) => {
  const { run, db } = await fixture(context, { initialize: false })
  const plan = result(await run("configuration_plan", { ...actor, expectedRevision: 0, configuration: CANDIDATE }))
  assert.equal(plan.status, "reviewed")
  assert.equal(plan.preview.resultingRevision, 1)
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM monitor_configuration").get().count, 0)
  const [first, second] = await Promise.all([apply(run, plan), apply(run, plan)])
  const applied = result(first)
  assert.deepEqual(result(second), applied)
  assert.equal(applied.result.revision, 1)
  assert.equal(applied.status, "applied")
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM monitor_configuration_change").get().count, 1)
  assert.equal(db.sqlite.prepare("SELECT input_json FROM monitor_management_operation WHERE id=?").get(plan.id).input_json, null)
  const noop = result(await run("configuration_plan", { ...actor, expectedRevision: 1, configuration: CANDIDATE }))
  assert.equal(result(await apply(run, noop)).result.changed, false)
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM monitor_configuration_change").get().count, 1)
  assert.deepEqual(result(await run("operation_get", { ...actor, planId: plan.id })), applied)
})

test("configuration reviews reject stale UI revisions, changed remote state, and unsafe candidates", async (context) => {
  const { run } = await fixture(context)
  result(await run("configuration_plan", { ...actor, expectedRevision: 0, configuration: CANDIDATE }), 409)
  result(await run("configuration_plan", { ...actor, expectedRevision: -1, configuration: CANDIDATE }), 400)
  result(await run("configuration_plan", { ...actor, expectedRevision: 1, configuration: { schemaVersion: 2, targets: [{ id: "local", url: "http://localhost/" }] } }), 400)
  const input = { ...actor, expectedRevision: 1, configuration: { schemaVersion: 2, targets: [] } }
  const first = result(await run("configuration_plan", input))
  const second = result(await run("configuration_plan", input))
  result(await apply(run, first))
  result(await apply(run, second), 409)
})

test("target pages preserve ordering and cursors across an unchanged configuration", async (context) => {
  const { run } = await fixture(context)
  const candidate = { schemaVersion: 2, defaults: { probeIntervalMinutes: 60 },
    targets: Array.from({ length: MANAGEMENT_LIMITS.page + 1 }, (_, index) => ({
      id: `target-${String(index).padStart(3, "0")}`, url: `https://example.com/${index}`,
    })).reverse(),
  }
  const plan = result(await run("configuration_plan", { ...actor, expectedRevision: 1, configuration: candidate }))
  result(await apply(run, plan))
  const first = result(await run("targets"))
  assert.equal(first.items.length, MANAGEMENT_LIMITS.page)
  assert.equal(first.items[0].id, "target-000")
  const second = result(await run("targets", { cursor: first.nextCursor }))
  assert.equal(second.items.length, 1)
  assert.equal(second.nextCursor, null)
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.id)).size, MANAGEMENT_LIMITS.page + 1)
})

test("configuration effect failures preserve a reviewed receipt and existing authority", async (context) => {
  const { db, run } = await fixture(context)
  const plan = result(await run("configuration_plan", { ...actor, expectedRevision: 1, configuration: { schemaVersion: 2, targets: [] } }))
  db.sqlite.exec("CREATE TRIGGER reject_configuration_audit BEFORE INSERT ON monitor_configuration_change BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
  result(await apply(run, plan), 503)
  assert.equal(result(await run("operation_get", { ...actor, planId: plan.id })).status, "reviewed")
  assert.equal(db.sqlite.prepare("SELECT revision FROM monitor_configuration").get().revision, 1)
})

test("a permitted shared workspace still cannot read another workspace's operation", async (context) => {
  const { run, env } = await fixture(context)
  const plan = result(await run("configuration_plan", { ...actor, expectedRevision: 1, configuration: CANDIDATE }))
  result(await run("operation_get", { ...actor, workspaceId: "workspace-b", planId: plan.id }, {
    env: { ...env, MANAGEMENT_CREDENTIALS: JSON.stringify([{ ...PRINCIPAL, workspaceIds: ["workspace-a", "workspace-b"] }]) },
  }), 404)
})

test("receipt scope binds actor, workspace, credential identity, revision, capabilities, and expiry", async (context) => {
  const { run, env, setNow } = await fixture(context)
  const plan = result(await run("configuration_plan", { ...actor, expectedRevision: 1, configuration: CANDIDATE }))
  result(await run("operation_get", { actorId: "other", planId: plan.id }), 404)
  result(await run("operation_get", { ...actor, workspaceId: "workspace-b", planId: plan.id }), 404)
  for (const principal of [{ ...PRINCIPAL, revision: 2 }, { ...PRINCIPAL, id: "other" }]) {
    result(await run("operation_get", { ...actor, planId: plan.id }, { env: { ...env, MANAGEMENT_CREDENTIALS: JSON.stringify([principal]) } }), 404)
  }
  result(await run("operation_apply", { ...actor, planId: plan.id }, { env: { ...env, MANAGEMENT_CREDENTIALS: JSON.stringify([{ ...PRINCIPAL, capabilities: ["read"] }]) } }), 403)
  setNow(Date.parse(plan.expiresAt))
  assert.equal(result(await run("operation_get", { ...actor, planId: plan.id })).status, "expired")
  result(await apply(run, plan), 409)
})

test("triage uses reviewed revisions, shared CLI semantics, and the existing outbox", async (context) => {
  const { run, db, open } = await fixture(context)
  await open()
  let incident = result(await run("incident", { incidentId: "incident-one" })).incident
  assert.equal(incident.revision, 1)
  for (const action of ["acknowledged", "snoozed", "dismissed"]) {
    const input = { ...actor, incidentId: incident.id, expectedRevision: incident.revision, action,
      note: "Reviewed by operator", ...(action === "snoozed" ? { until: new Date(Date.parse(NOW) + HOUR_MS).toISOString() } : {}) }
    const plan = result(await run("triage_plan", input))
    const [one, two] = await Promise.all([apply(run, plan), apply(run, plan)])
    assert.deepEqual(result(one), result(two))
    const detail = result(await run("incident", { incidentId: incident.id }))
    incident = detail.incident
    assert.equal(detail.actions[0].action, action)
    if (action === "snoozed") assert.equal(db.sqlite.prepare("SELECT next_attempt_at FROM monitor_outbox WHERE transition='opened'").get().next_attempt_at, input.until)
  }
  assert.equal(incident.status, "resolved")
  assert.equal(incident.resolutionReason, "operator-dismissed")
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM monitor_incident_action").get().count, 3)
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM monitor_outbox WHERE transition='resolved'").get().count, 1)
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM monitor_target_state").get().count, 0)
  result(await run("triage_plan", { ...actor, incidentId: incident.id, expectedRevision: incident.revision, action: "dismissed" }), 409)
})

test("CLI actions and configuration changes invalidate pending management triage", async (context) => {
  const { db, run, open } = await fixture(context)
  await open()
  const input = { ...actor, incidentId: "incident-one", expectedRevision: 1, action: "acknowledged" }
  const plan = result(await run("triage_plan", input))
  const cli = new CloudflareIncidentOperator({ queryImpl: (queries) => db.batch(queries.map(({ sql, params }) => db.prepare(sql).bind(...params))), clock: () => Date.parse(NOW), randomUUID: () => "cli-action" })
  await cli.acknowledge("incident-one")
  result(await apply(run, plan), 409)
  const next = result(await run("triage_plan", { ...input, expectedRevision: 2 }))
  const config = result(await run("configuration_plan", { ...actor, expectedRevision: 1, configuration: { schemaVersion: 2, targets: [] } }))
  result(await apply(run, config))
  result(await apply(run, next), 409)
})

test("failed domain effects roll back acceptance and lost responses reconcile durable receipts", async (context) => {
  const { run, db, open } = await fixture(context)
  await open()
  const plan = result(await run("triage_plan", { ...actor, incidentId: "incident-one", expectedRevision: 1, action: "dismissed" }))
  db.sqlite.exec("CREATE TRIGGER reject_action BEFORE INSERT ON monitor_incident_action BEGIN SELECT RAISE(ABORT, 'private failure'); END")
  result(await apply(run, plan), 503)
  assert.equal(result(await run("operation_get", { ...actor, planId: plan.id })).status, "reviewed")
  assert.equal(db.sqlite.prepare("SELECT status FROM monitor_incident").get().status, "open")
  db.sqlite.exec("DROP TRIGGER reject_action")
  const batch = db.batch.bind(db)
  let lost = false
  db.batch = async (statements) => {
    const output = await batch(statements)
    if (!lost && statements[0].sql.includes("SET acceptance_id")) { lost = true; throw new Error("lost accepted response") }
    return output
  }
  assert.equal(result(await apply(run, plan)).status, "applied")
  assert.equal(lost, true)
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM monitor_incident_action").get().count, 1)
})

test("incident and action pages are keyset-scoped and target pages detect configuration drift", async (context) => {
  const { db, run, open } = await fixture(context)
  for (let index = 0; index <= MANAGEMENT_LIMITS.page; index += 1) await open(`incident-${String(index).padStart(3, "0")}`, `target-${index}`)
  const first = result(await run("incidents"))
  assert.equal(first.items.length, MANAGEMENT_LIMITS.page)
  const second = result(await run("incidents", { cursor: first.nextCursor }))
  assert.equal(second.items.length, 1)
  assert.equal(second.nextCursor, null)
  assert.equal(new Set([...first.items, ...second.items].map((entry) => entry.id)).size, MANAGEMENT_LIMITS.page + 1)
  result(await run("incidents", { cursor: first.nextCursor, targetId: "target-0" }), 400)
  assert.equal(result(await run("incidents", { targetId: "target-0" })).items.length, 1)
  result(await run("incidents", { status: "private" }), 400)
  result(await run("targets", { cursor: "bad" }), 400)
  result(await run("targets", { cursor: encodeCursor({ kind: "targets", workspaceId: "workspace-a", revision: 0, after: "example" }) }), 409)
  for (let index = 0; index <= MANAGEMENT_LIMITS.page; index += 1) db.sqlite.prepare(`INSERT INTO monitor_incident_action
    (id, incident_id, action, created_at) VALUES (?, 'incident-000', 'acknowledged', ?)`)
    .run(`action-${String(index).padStart(3, "0")}`, NOW)
  const history = result(await run("incident", { incidentId: "incident-000" }))
  assert.equal(history.actions.length, MANAGEMENT_LIMITS.page)
  const tail = result(await run("incident", { incidentId: "incident-000", cursor: history.nextCursor }))
  assert.equal(tail.actions.length, 1)
  assert.equal(tail.nextCursor, null)
  result(await run("incident", { incidentId: "incident-001", cursor: history.nextCursor }), 400)
  result(await run("incident", { incidentId: "absent" }), 404)
  assert.equal(result(await run("snapshot")).openIncidents.truncated, true)
})

test("review storage is bounded and expiration frees only unaccepted reviews", async (context) => {
  const { db, run, setNow } = await fixture(context)
  const input = { ...actor, expectedRevision: 1, configuration: CANDIDATE }
  const kept = result(await run("configuration_plan", input))
  result(await apply(run, kept))
  for (let index = 0; index < MANAGEMENT_LIMITS.pendingPlans; index += 1) result(await run("configuration_plan", input))
  result(await run("configuration_plan", input), 429)
  setNow(Date.parse(NOW) + MANAGEMENT_LIMITS.planMilliseconds)
  result(await run("configuration_plan", input))
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM monitor_management_operation").get().count, 2)
  assert.equal(result(await run("operation_get", { ...actor, planId: kept.id })).status, "applied")
})

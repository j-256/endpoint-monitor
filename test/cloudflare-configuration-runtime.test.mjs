import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"
import { createRequire } from "node:module"
import test from "node:test"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"))
const { build } = wranglerRequire("esbuild")
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare")
const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url))
const MIGRATIONS = new URL("../migrations/", import.meta.url)
const REQUEST_TIMEOUT_MS = 5000

test("configuration authority and migration run inside workerd with real D1 bindings", { timeout: 20000 }, async (context) => {
  const migrations = await Promise.all((await readdir(MIGRATIONS))
    .filter((name) => name.endsWith(".sql")).sort()
    .map(async (name) => (await readFile(new URL(name, MIGRATIONS), "utf8"))
      .split("\n").filter((line) => !line.trim().startsWith("--")).join(" ")))
  const worker = `
    import {
      configurationCandidate, d1ConfigurationQuery, readConfigurationAuthority,
      reviewConfiguration, writeConfigurationAuthority,
    } from "./src/adapters/cloudflare/configuration-authority.mjs"
    import { runCloudflareScheduled, handleCloudflareRequest } from "./src/adapters/cloudflare/runtime.mjs"
    import { sha256Hex } from "./src/crypto.mjs"
    export default { async fetch(request, env) {
      const db = env.MONITOR_DB
      for (const migration of ${JSON.stringify(migrations)}) await db.exec(migration)
      const query = d1ConfigurationQuery(db)
      const candidate = { schemaVersion: 2, defaults: { probeIntervalMinutes: 1 },
        targets: [{id:"example-health",url:"https://example.com/health"}] }
      const reviewed = await reviewConfiguration(query, candidate)
      const initial = await writeConfigurationAuthority(query, candidate, {
        ...reviewed, updatedAt: "2026-09-06T03:17:00.000Z",
      })
      const next = {...candidate, targets:[{id:"example-health",url:"https://example.com/ready"}]}
      const nextReview = await reviewConfiguration(query, next)
      const updated = await writeConfigurationAuthority(query, next, {
        ...nextReview, updatedAt: "2026-09-06T03:18:00.000Z",
      })
      const unchanged = await writeConfigurationAuthority(query, next, {
        expectedRevision: updated.revision,
        expectedFingerprint: (await configurationCandidate(next)).configFingerprint,
        updatedAt: "2026-09-06T03:19:00.000Z",
      })
      let staleRejected = false
      try { await writeConfigurationAuthority(query, next, {
        ...nextReview, updatedAt: "2026-09-06T03:20:00.000Z",
      }) } catch(error) { staleRejected = error.code === "configuration-conflict" }
      let legacyRejected = false
      try { await db.prepare("UPDATE monitor_configuration SET config_json='{}'").run() }
      catch { legacyRejected = true }
      let rolledBack = false
      try { await db.batch([
        db.prepare("UPDATE monitor_configuration SET revision=revision+1"),
        db.prepare("DELETE FROM monitor_configuration"),
      ]) } catch { rolledBack = true }
      const remote = await readConfigurationAuthority(query)
      const probe = await runCloudflareScheduled({ MONITOR_DB: db, ENDPOINT_MONITOR_ENABLED: true },
        Date.parse("2026-09-06T03:21:00.000Z"), {
          clock: () => Date.parse("2026-09-06T03:21:00.000Z"),
          fetchImpl: async () => new Response(null, { status: 200 }),
          logger: { log() {}, warn() {}, error() {} },
        })
      const audit = await db.prepare("SELECT COUNT(*) AS count FROM monitor_configuration_change").first()
      const token = "epm_" + "a".repeat(43)
      const managementEnv = { MONITOR_DB: db, MANAGEMENT_CREDENTIALS: JSON.stringify([{
        id: "example-hq", revision: 1, tokenHash: await sha256Hex(token),
        expiresAt: new Date(Date.now() + 86400000).toISOString(), workspaceIds: ["example-workspace"],
        capabilities: ["read", "configure", "triage"],
      }]) }
      async function management(command, input = {}, clock = Date.now) {
        const response = await handleCloudflareRequest(new Request("https://example.com/admin/api/v1", {
          method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token },
          body: JSON.stringify({ version: 1, command, input: { workspaceId: "example-workspace", ...input } }),
        }), managementEnv, { clock })
        const body = await response.json()
        return { status: response.status, result: body.result, error: body.error }
      }
      const checkedAt = () => Date.parse("2026-09-06T03:21:00.000Z")
      const schedulerEvidence = await management("snapshot", {}, checkedAt)
      const targetEvidence = await management("target", { targetId: "example-health" }, checkedAt)
      const duplicateProbe = await runCloudflareScheduled({ MONITOR_DB: db, ENDPOINT_MONITOR_ENABLED: true }, checkedAt(), {
        clock: checkedAt, fetchImpl: async () => new Response(null, { status: 200 }), logger: {},
      })
      const managedPlan = await management("configuration_plan", {
        actorId: "example-operator", expectedRevision: 2,
        configuration: { ...next, targets: [{id:"example-health",url:"https://example.com/managed"}] },
      })
      const applied = await Promise.all([0,1].map(() => management("operation_apply", {
        actorId: "example-operator", planId: managedPlan.result.id,
      })))
      const failure = await runCloudflareScheduled({ MONITOR_DB: db, ENDPOINT_MONITOR_ENABLED: true },
        Date.parse("2026-09-06T03:22:00.000Z"), {
          clock: () => Date.parse("2026-09-06T03:22:00.000Z"),
          fetchImpl: async () => new Response(null, { status: 520 }),
          logger: { log() {}, warn() {}, error() {} },
        })
      const incidents = await management("incidents")
      const triagePlan = await management("triage_plan", {
        actorId: "example-operator", incidentId: incidents.result.items[0].id,
        expectedRevision: incidents.result.items[0].revision, action: "dismissed",
      })
      await db.exec("CREATE TRIGGER reject_action BEFORE INSERT ON monitor_incident_action BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;")
      const failedAction = await management("operation_apply", { actorId: "example-operator", planId: triagePlan.result.id })
      const unapplied = await management("operation_get", { actorId: "example-operator", planId: triagePlan.result.id })
      await db.exec("DROP TRIGGER reject_action;")
      const triaged = await management("operation_apply", { actorId: "example-operator", planId: triagePlan.result.id })
      const managedIncident = await management("incident", { incidentId: incidents.result.items[0].id })
      const delayedPlan = await management("configuration_plan", {
        actorId: "example-operator", expectedRevision: 3,
        configuration: { ...next, targets: [{id:"example-health",url:"https://example.com/delayed"}] },
      })
      const databaseExpiredAt = new Date(Date.now() - 60000).toISOString()
      await db.prepare("UPDATE monitor_management_operation SET expires_at=? WHERE id=?")
        .bind(databaseExpiredAt, delayedPlan.result.id).run()
      const delayedApply = await management("operation_apply", {
        actorId: "example-operator", planId: delayedPlan.result.id,
      }, () => Date.now() - 120000)
      const afterDelayed = await readConfigurationAuthority(query)
      return Response.json({ initial, updated, unchanged, staleRejected, legacyRejected,
        rolledBack, finalRevision: remote.revision, auditCount: audit.count,
        healthyProbeWrites: probe.d1Writes - probe.runStatusWrites,
        runStatusWrites: probe.runStatusWrites, succeededProbes: probe.succeededProbes,
        management: { schedulerEvidence, targetEvidence, duplicateRunWrites: duplicateProbe.runStatusWrites,
          applied, failureTransitions: failure.transitions, failedAction, unapplied, triaged, managedIncident,
          delayedApply, afterDelayedRevision: afterDelayed.revision } })
    } }
  `
  const bundle = await build({
    bundle: true, format: "esm", platform: "browser", write: false,
    stdin: { contents: worker, resolveDir: PROJECT_ROOT, sourcefile: "configuration-runtime-fixture.mjs" },
  })
  const runtime = new Miniflare(convertV4MiniflareOptions({
    cf: false, compatibilityDate: "2026-08-25", d1Databases: ["MONITOR_DB"],
    modules: true, script: bundle.outputFiles[0].text,
  }))
  context.after(() => runtime.dispose())
  const response = await fetch(await runtime.ready, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.initial.revision, 1)
  assert.equal(result.updated.revision, 2)
  assert.equal(result.unchanged.changed, false)
  assert.equal(result.unchanged.rowsWritten, 0)
  assert.equal(result.staleRejected, true)
  assert.equal(result.legacyRejected, true)
  assert.equal(result.rolledBack, true)
  assert.equal(result.finalRevision, 2)
  assert.equal(result.auditCount, 2)
  assert.equal(result.healthyProbeWrites, 0)
  assert.equal(result.runStatusWrites, 1)
  assert.equal(result.succeededProbes, 1)
  assert.equal(result.management.schedulerEvidence.result.execution.state, "fresh")
  assert.equal(result.management.targetEvidence.result.items[0].evidence.check.state, "passed")
  assert.equal(result.management.duplicateRunWrites, 0)
  assert.equal(result.management.applied[0].status, 200)
  assert.deepEqual(result.management.applied[0], result.management.applied[1])
  assert.equal(result.management.applied[0].result.result.revision, 3)
  assert.equal(result.management.failureTransitions, 1)
  assert.equal(result.management.failedAction.status, 503)
  assert.equal(result.management.unapplied.result.status, "reviewed")
  assert.equal(result.management.triaged.result.status, "applied")
  assert.equal(result.management.managedIncident.result.incident.resolutionReason, "operator-dismissed")
  assert.equal(result.management.managedIncident.result.actions.length, 1)
  assert.equal(result.management.delayedApply.status, 409)
  assert.equal(result.management.afterDelayedRevision, 3)
})

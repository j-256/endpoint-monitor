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
    import { runCloudflareScheduled } from "./src/adapters/cloudflare/runtime.mjs"
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
      return Response.json({ initial, updated, unchanged, staleRejected, legacyRejected,
        rolledBack, finalRevision: remote.revision, auditCount: audit.count,
        healthyProbeWrites: probe.d1Writes, succeededProbes: probe.succeededProbes })
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
  assert.equal(result.succeededProbes, 1)
})

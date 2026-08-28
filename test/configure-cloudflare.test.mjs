import assert from "node:assert/strict"
import {
  mkdtemp,
  readFile,
  stat,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  applyConfiguration,
  buildWranglerConfiguration,
  parseConfigureArguments,
  runConfigure,
  usage,
} from "../scripts/configure-cloudflare.mjs"
import {
  PACKAGE_MIGRATIONS_PATH,
  PACKAGE_WORKER_PATH,
} from "../src/project.mjs"

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef"
const DATABASE_ID = "01234567-89ab-cdef-0123-456789abcdef"
const CONFIGURATION = JSON.stringify({
  defaults: { probeIntervalMinutes: 5 },
  schemaVersion: 1,
  targets: [{ id: "example-home", url: "https://example.com/" }],
})
const WRANGLER_EXAMPLE = JSON.stringify({
  d1_databases: [{
    binding: "MONITOR_DB",
    database_id: "00000000-0000-0000-0000-000000000000",
    database_name: "endpoint-monitor",
  }],
  main: "src/adapters/cloudflare/worker.mjs",
  name: "endpoint-monitor",
  services: [],
  vars: {},
})

function streamFixture() {
  let output = ""
  return {
    read: () => output,
    write: (value) => {
      output += value
    },
  }
}

function dependencies(overrides = {}) {
  return {
    environment: {},
    examplePath: "wrangler.example.jsonc",
    readFileImpl: async (filename) => filename === "targets.json"
      ? CONFIGURATION
      : WRANGLER_EXAMPLE,
    stderr: streamFixture(),
    stdout: streamFixture(),
    ...overrides,
  }
}

test("Cloudflare configurator help documents mutations and required environment", async () => {
  assert.match(usage(), /^Usage: endpoint-monitor cloudflare configure/)
  assert.match(usage(), /never creates Cloudflare resources/)
  assert.match(usage(), /CLOUDFLARE_API_TOKEN/)
  assert.match(usage(), /Apply migrations/)
  for (const argv of [["--help"], ["-h"]]) {
    const deps = dependencies()
    assert.equal(await runConfigure(argv, deps), 0)
    assert.match(deps.stdout.read(), /Usage:/)
    assert.equal(deps.stderr.read(), "")
  }
})

test("Cloudflare configurator parser supports option forms and bundles", () => {
  const parsed = parseConfigureArguments([
    "-aeilt",
    "-ctargets.json",
    `--database-id=${DATABASE_ID}`,
    "--hookrelay-service",
    "hookrelay",
    "--database-name=endpoint-monitor-data",
    "-pprivate/operator.json",
    "--worker-name=endpoint-monitor-production",
  ])
  assert.equal(parsed.analytics, true)
  assert.equal(parsed.delivery, true)
  assert.equal(parsed.enabled, true)
  assert.equal(parsed.applyConfig, true)
  assert.equal(parsed.status, true)
  assert.equal(parsed.configPath, "targets.json")
  assert.equal(parsed.databaseId, DATABASE_ID)
  assert.equal(parsed.databaseName, "endpoint-monitor-data")
  assert.equal(parsed.hookrelayService, "hookrelay")
  assert.equal(parsed.operatorProfilePath, path.resolve("private/operator.json"))
  assert.equal(parsed.workerName, "endpoint-monitor-production")
})

test("Cloudflare configurator rejects missing, unknown, positional, and invalid values", async () => {
  const cases = [
    [],
    ["--config", "targets.json"],
    ["--unknown"],
    ["--config=", "--database-id", DATABASE_ID],
    ["--config", "targets.json", "--database-id", "invalid"],
    ["--config", "targets.json", "--database-id", DATABASE_ID, "extra"],
    ["--config", "targets.json", "--database-id", DATABASE_ID, "--worker-name", "Bad_Name"],
    ["--config", "targets.json", "--database-id", DATABASE_ID, "--database-name", "Bad_Name"],
    ["--config", "same.json", "--database-id", DATABASE_ID, "--output", "same.json"],
    ["--config", "targets.json", "--database-id", DATABASE_ID, "--output", "same.json", "--operator-profile", "same.json"],
  ]
  for (const argv of cases) {
    const deps = dependencies()
    assert.equal(await runConfigure(argv, deps), 2)
    assert.match(deps.stderr.read(), /^endpoint-monitor:/)
    assert.equal(deps.stdout.read(), "")
  }
})

test("Wrangler generation contains only selected public bindings", () => {
  const options = parseConfigureArguments([
    "--config",
    "targets.json",
    "--database-id",
    DATABASE_ID,
    "--analytics",
    "--enabled",
    "--hookrelay-service",
    "hookrelay",
  ])
  const generated = buildWranglerConfiguration(
    JSON.parse(WRANGLER_EXAMPLE),
    options,
    ACCOUNT_ID,
  )
  assert.equal(generated.d1_databases[0].database_id, DATABASE_ID)
  assert.equal(generated.d1_databases[0].database_name, "endpoint-monitor")
  assert.equal(generated.d1_databases[0].migrations_dir, PACKAGE_MIGRATIONS_PATH)
  assert.equal(generated.main, PACKAGE_WORKER_PATH)
  assert.deepEqual(generated.services, [{ binding: "HOOKRELAY", service: "hookrelay" }])
  assert.equal(generated.vars.CLOUDFLARE_ANALYTICS_ENABLED, "true")
  assert.equal(generated.vars.CLOUDFLARE_ACCOUNT_ID, ACCOUNT_ID)
  assert.equal("ENDPOINT_MONITOR_HOOKRELAY_HMAC" in generated.vars, false)
  assert.equal("ENDPOINT_MONITOR_HOOKRELAY_URL" in generated.vars, false)
})

test("dry run validates and reports without local or remote writes", async () => {
  let writes = 0
  let fetches = 0
  const deps = dependencies({
    environment: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
    fetchImpl: async () => {
      fetches += 1
    },
    writeFileImpl: async () => {
      writes += 1
    },
  })
  assert.equal(await runConfigure([
    "--config",
    "targets.json",
    "--database-id",
    DATABASE_ID,
    "--analytics",
    "--apply-config",
    "--dry-run",
  ], deps), 0)
  const plan = JSON.parse(deps.stdout.read())
  assert.equal(plan.applyConfig, true)
  assert.equal(plan.applied, false)
  assert.equal(plan.targetCount, 1)
  assert.match(plan.configFingerprint, /^sha256:[a-f0-9]{64}$/)
  assert.equal(writes, 0)
  assert.equal(fetches, 0)
})

test("preparation writes mode-0600 Wrangler and operator configurations", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "endpoint-monitor-configure-"))
  context.after(async () => {
    const { rm } = await import("node:fs/promises")
    await rm(directory, { force: true, recursive: true })
  })
  const outputPath = path.join(directory, "wrangler.jsonc")
  const deps = dependencies()
  assert.equal(await runConfigure([
    "--config",
    "targets.json",
    "--database-id",
    DATABASE_ID,
    "--output",
    outputPath,
  ], deps), 0)
  const generated = JSON.parse(await readFile(outputPath, "utf8"))
  const profilePath = path.join(directory, ".endpoint-monitor.local.json")
  const profile = JSON.parse(await readFile(profilePath, "utf8"))
  assert.equal(generated.d1_databases[0].database_id, DATABASE_ID)
  assert.equal("CLOUDFLARE_ACCOUNT_ID" in generated.vars, false)
  assert.equal((await stat(outputPath)).mode & 0o777, 0o600)
  assert.equal(profile.configPath, path.resolve("targets.json"))
  assert.equal(profile.wranglerPath, outputPath)
  assert.equal((await stat(profilePath)).mode & 0o777, 0o600)
})

test("D1 apply uses a parameterized idempotent configuration upsert", async () => {
  let request
  const loaded = {
    configFingerprint: `sha256:${"a".repeat(64)}`,
    configJson: CONFIGURATION,
    portable: JSON.parse(CONFIGURATION),
  }
  const rowsWritten = await applyConfiguration(
    async (url, init) => {
      request = { init, url }
      return Response.json({
        result: [{ meta: { rows_written: 1 }, success: true }],
        success: true,
      })
    },
    ACCOUNT_ID,
    "api-token",
    DATABASE_ID,
    loaded,
    "2026-08-26T03:00:00.000Z",
  )
  assert.equal(rowsWritten, 1)
  assert.equal(
    request.url,
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`,
  )
  const body = JSON.parse(request.init.body)
  assert.match(body.sql, /ON CONFLICT/)
  assert.equal(body.sql.includes(CONFIGURATION), false)
  assert.equal(body.params[1], CONFIGURATION)
  assert.equal(request.init.headers.Authorization, "Bearer api-token")
})

test("D1 apply returns fixed errors without API response details", async () => {
  const loaded = {
    configFingerprint: `sha256:${"a".repeat(64)}`,
    configJson: CONFIGURATION,
    portable: JSON.parse(CONFIGURATION),
  }
  await assert.rejects(
    applyConfiguration(
      async () => Response.json({
        errors: [{ message: "private API detail" }],
        result: null,
        success: false,
      }, { status: 403 }),
      ACCOUNT_ID,
      "api-token",
      DATABASE_ID,
      loaded,
      "2026-08-26T03:00:00.000Z",
    ),
    (error) => error.message === "Cloudflare D1 rejected configuration"
      && !error.message.includes("private API detail"),
  )
})

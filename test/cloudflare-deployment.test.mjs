import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"

import {
  PACKAGE_MIGRATIONS_PATH,
  PACKAGE_WORKER_PATH,
} from "../src/project.mjs"
import {
  accountWorkersSubdomain,
  bootstrapUsage,
  createD1Database,
  deployUsage,
  executeWrangler,
  parseBootstrapArguments,
  parseDeployArguments,
  resolveWranglerPath,
  runBootstrap,
  runDeploy,
  verifyWorkerHealth,
} from "../src/adapters/cloudflare/deployment.mjs"

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef"
const DATABASE_ID = "01234567-89ab-cdef-0123-456789abcdef"
const PROFILE_PATH = "/operator/.endpoint-monitor.local.json"
const CONFIG_PATH = "/operator/endpoint-monitor.json"
const WRANGLER_PATH = "/operator/wrangler.jsonc"
const CREDENTIALS = Object.freeze({ accountId: ACCOUNT_ID, apiToken: "api-token" })
const PROFILE = JSON.stringify({
  configPath: CONFIG_PATH,
  schemaVersion: 1,
  wranglerPath: WRANGLER_PATH,
})
const CONFIGURATION = JSON.stringify({
  schemaVersion: 1,
  targets: [{ id: "example-home", url: "https://example.com/" }],
})
const WRANGLER = JSON.stringify({
  d1_databases: [{
    binding: "MONITOR_DB",
    database_id: DATABASE_ID,
    database_name: "endpoint-monitor-data",
    migrations_dir: PACKAGE_MIGRATIONS_PATH,
  }],
  main: PACKAGE_WORKER_PATH,
  name: "endpoint-monitor-service",
  services: [{ binding: "HOOKRELAY", service: "hookrelay" }],
  vars: {
    CLOUDFLARE_ANALYTICS_ENABLED: "true",
    ENDPOINT_MONITOR_DELIVERY_ENABLED: "true",
    ENDPOINT_MONITOR_ENABLED: "true",
    ENDPOINT_MONITOR_STATUS_ENABLED: "false",
  },
  workers_dev: true,
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

function metadata() {
  return {
    isFile: () => true,
    isSymbolicLink: () => false,
    mode: 0o100600,
  }
}

function fixture(overrides = {}) {
  const hasWrangler = overrides.hasWrangler ?? false
  return {
    environment: {},
    fetchImpl: async () => {
      throw new Error("unexpected fetch")
    },
    lstatImpl: async (filename) => {
      if (filename === WRANGLER_PATH && !hasWrangler) {
        const error = new Error("missing")
        error.code = "ENOENT"
        throw error
      }
      return metadata()
    },
    readFileImpl: async (filename) => {
      if (filename === PROFILE_PATH) return PROFILE
      if (filename === CONFIG_PATH) return CONFIGURATION
      if (filename === WRANGLER_PATH && hasWrangler) return WRANGLER
      throw new Error(`unexpected file: ${filename}`)
    },
    runConfigureImpl: async () => {
      throw new Error("unexpected configure")
    },
    runWranglerImpl: async () => {
      throw new Error("unexpected Wrangler")
    },
    sleepImpl: async () => {},
    stderr: streamFixture(),
    stdout: streamFixture(),
    ...overrides,
  }
}

test("deployment commands document and parse their lifecycle", async () => {
  assert.match(bootstrapUsage(), /^Usage: endpoint-monitor cloudflare bootstrap/)
  assert.match(bootstrapUsage(), /Create or adopt one D1 database/)
  assert.match(deployUsage(), /^Usage: endpoint-monitor deploy/)
  assert.match(deployUsage(), /verifies its workers\.dev health endpoint/)

  const bootstrap = parseBootstrapArguments([
    "-aeltn",
    `-d${DATABASE_ID}`,
    "-Nmonitor-data",
    "--worker-name=monitor-service",
    "--hookrelay-service",
    "hookrelay",
    "--profile",
    PROFILE_PATH,
  ])
  assert.equal(bootstrap.analytics, true)
  assert.equal(bootstrap.databaseId, DATABASE_ID)
  assert.equal(bootstrap.databaseName, "monitor-data")
  assert.equal(bootstrap.delivery, true)
  assert.equal(bootstrap.dryRun, true)
  assert.equal(bootstrap.enabled, true)
  assert.equal(bootstrap.status, true)
  assert.equal(bootstrap.provided.has("workerName"), true)

  const deploy = parseDeployArguments(["-np", PROFILE_PATH])
  assert.equal(deploy.dryRun, true)
  assert.equal(deploy.profilePath, PROFILE_PATH)
  for (const [runner, cases] of [
    [runBootstrap, [
      ["--database-id", "invalid"],
      ["--database-name", "Bad_Name"],
      ["--worker-name="],
      ["--unknown"],
      ["extra"],
    ]],
    [runDeploy, [
      ["--profile="],
      ["--dry-run=yes"],
      ["--unknown"],
      ["extra"],
    ]],
  ]) {
    for (const argv of cases) {
      const deps = fixture()
      assert.equal(await runner(argv, deps), 2)
      assert.match(deps.stderr.read(), /^endpoint-monitor:/)
    }
  }
  for (const runner of [runBootstrap, runDeploy]) {
    const deps = fixture()
    assert.equal(await runner(["--help"], deps), 0)
    assert.match(deps.stdout.read(), /^Usage:/)
  }
})

test("Cloudflare resource APIs use fixed requests and fixed failures", async () => {
  let request
  const database = await createD1Database(async (url, init) => {
    request = { init, url }
    return Response.json({
      result: { name: "endpoint-monitor", uuid: DATABASE_ID },
      success: true,
    })
  }, CREDENTIALS, "endpoint-monitor")
  assert.deepEqual(database, { id: DATABASE_ID, name: "endpoint-monitor" })
  assert.equal(
    request.url,
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database`,
  )
  assert.equal(request.init.headers.Authorization, "Bearer api-token")
  assert.deepEqual(JSON.parse(request.init.body), { name: "endpoint-monitor" })

  const subdomain = await accountWorkersSubdomain(
    async () => Response.json({ result: { subdomain: "example-monitor" }, success: true }),
    CREDENTIALS,
  )
  assert.equal(subdomain, "example-monitor")

  for (const operation of [
    () => createD1Database(
      async () => Response.json({ errors: [{ message: "private" }], success: false }, { status: 403 }),
      CREDENTIALS,
      "endpoint-monitor",
    ),
    () => accountWorkersSubdomain(
      async () => new Response("not json", { status: 500 }),
      CREDENTIALS,
    ),
    () => createD1Database(
      async () => Response.json({ result: { name: "wrong", uuid: DATABASE_ID }, success: true }),
      CREDENTIALS,
      "endpoint-monitor",
    ),
  ]) {
    await assert.rejects(operation, (error) => (
      !error.message.includes("private") && error.exitCode === 1
    ))
  }
})

test("Wrangler resolution and execution use the installed production dependency", async () => {
  assert.equal(
    resolveWranglerPath(() => "/package/node_modules/wrangler/package.json"),
    "/package/node_modules/wrangler/bin/wrangler.js",
  )
  assert.throws(
    () => resolveWranglerPath(() => { throw new Error("missing") }),
    (error) => error.exitCode === 3,
  )
  let invocation
  await executeWrangler(["deploy", "--dry-run"], {
    cwd: "/operator",
    environment: { TEST: "true" },
    spawnImpl: (command, argumentsList, options) => {
      invocation = { argumentsList, command, options }
      const child = new EventEmitter()
      queueMicrotask(() => child.emit("close", 0, null))
      return child
    },
    wranglerPath: "/package/wrangler.js",
  })
  assert.equal(invocation.command, process.execPath)
  assert.deepEqual(invocation.argumentsList, [
    "/package/wrangler.js",
    "deploy",
    "--dry-run",
  ])
  assert.equal(invocation.options.cwd, "/operator")
  await assert.rejects(
    executeWrangler(["deploy"], {
      spawnImpl: () => {
        const child = new EventEmitter()
        queueMicrotask(() => child.emit("close", 7, null))
        return child
      },
      wranglerPath: "/package/wrangler.js",
    }),
    (error) => error.exitCode === 1 && /status 7/.test(error.message),
  )
})

test("bootstrap dry run plans a fresh project without provider or file writes", async () => {
  const deps = fixture()
  assert.equal(await runBootstrap([
    "--profile",
    PROFILE_PATH,
    "--dry-run",
  ], deps), 0)
  const plan = JSON.parse(deps.stdout.read())
  assert.equal(plan.databaseAction, "create")
  assert.equal(plan.databaseId, null)
  assert.equal(plan.targetCount, 1)
  assert.equal(plan.workerPath, PACKAGE_WORKER_PATH)
  assert.equal(plan.migrationsPath, PACKAGE_MIGRATIONS_PATH)
  assert.equal(deps.stderr.read(), "")
})

test("bootstrap creates D1, writes package configuration, and applies migrations", async () => {
  const events = []
  const deps = fixture({
    environment: {
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      CLOUDFLARE_API_TOKEN: "api-token",
    },
    fetchImpl: async () => {
      events.push("create")
      return Response.json({
        result: { name: "endpoint-monitor", uuid: DATABASE_ID },
        success: true,
      })
    },
    runConfigureImpl: async (argv) => {
      events.push(["configure", ...argv])
      return 0
    },
    runWranglerImpl: async (argv, options) => {
      events.push(["wrangler", ...argv, options.cwd])
    },
  })
  assert.equal(await runBootstrap(["--profile", PROFILE_PATH], deps), 0)
  assert.equal(events[0], "create")
  assert.deepEqual(events[1].slice(0, 3), ["configure", "--config", CONFIG_PATH])
  assert.equal(events[1].includes(DATABASE_ID), true)
  assert.deepEqual(events[2].slice(0, 5), [
    "wrangler",
    "d1",
    "migrations",
    "apply",
    "MONITOR_DB",
  ])
  assert.match(deps.stdout.read(), /Created D1 database endpoint-monitor/)
})

test("bootstrap reuses the recorded database and feature selections", async () => {
  const deps = fixture({ hasWrangler: true })
  assert.equal(await runBootstrap([
    "--profile",
    PROFILE_PATH,
    "--dry-run",
  ], deps), 0)
  const plan = JSON.parse(deps.stdout.read())
  assert.equal(plan.databaseAction, "reuse")
  assert.equal(plan.databaseId, DATABASE_ID)
  assert.equal(plan.databaseName, "endpoint-monitor-data")
  assert.equal(plan.workerName, "endpoint-monitor-service")
  assert.equal(plan.analytics, true)
  assert.equal(plan.delivery, true)
  assert.equal(plan.enabled, true)
  assert.equal(plan.status, false)
  assert.equal(plan.hookrelayService, "hookrelay")

  const mismatch = fixture({ hasWrangler: true })
  assert.equal(await runBootstrap([
    "--profile",
    PROFILE_PATH,
    "--database-id",
    "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    "--dry-run",
  ], mismatch), 2)
  assert.match(mismatch.stderr.read(), /does not match the recorded MONITOR_DB binding/)
})

test("deploy dry run bundles the package-resolved Worker without Cloudflare access", async () => {
  const calls = []
  const deps = fixture({
    hasWrangler: true,
    runWranglerImpl: async (argv, options) => calls.push({ argv, options }),
  })
  assert.equal(await runDeploy([
    "--profile",
    PROFILE_PATH,
    "--dry-run",
  ], deps), 0)
  assert.deepEqual(calls, [{
    argv: ["deploy", "--dry-run", "--config", WRANGLER_PATH],
    options: { cwd: "/operator" },
  }])
  assert.match(deps.stdout.read(), /Deployment dry run passed/)
})

test("live deploy migrates, syncs, publishes, and verifies public health", async () => {
  const wranglerCalls = []
  const fetchCalls = []
  const sleeps = []
  let healthAttempts = 0
  const deps = fixture({
    clock: () => Date.parse("2026-08-27T03:00:00.000Z"),
    environment: {
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      CLOUDFLARE_API_TOKEN: "api-token",
    },
    fetchImpl: async (url, init) => {
      fetchCalls.push({ init, url })
      if (url.endsWith(`/d1/database/${DATABASE_ID}/query`)) {
        return Response.json({
          result: [{ meta: { rows_written: 1 }, success: true }],
          success: true,
        })
      }
      if (url.endsWith("/workers/subdomain")) {
        return Response.json({ result: { subdomain: "account-name" }, success: true })
      }
      healthAttempts += 1
      return healthAttempts === 1
        ? Response.json({ ok: false }, { status: 503 })
        : Response.json({ ok: true, service: "endpoint-monitor" })
    },
    hasWrangler: true,
    runWranglerImpl: async (argv) => wranglerCalls.push(argv),
    sleepImpl: async (milliseconds) => sleeps.push(milliseconds),
  })
  assert.equal(await runDeploy(["--profile", PROFILE_PATH], deps), 0)
  assert.deepEqual(wranglerCalls[0].slice(0, 4), [
    "d1",
    "migrations",
    "apply",
    "MONITOR_DB",
  ])
  assert.deepEqual(wranglerCalls[1], ["deploy", "--config", WRANGLER_PATH])
  assert.equal(fetchCalls.some((entry) => entry.url.endsWith("/query")), true)
  assert.equal(fetchCalls.at(-1).url, "https://endpoint-monitor-service.account-name.workers.dev/healthz")
  assert.deepEqual(sleeps, [250])
  assert.match(deps.stdout.read(), /D1 rows written: 1/)
})

test("health verification retries bounded failures and rejects invalid package config", async () => {
  const sleeps = []
  let attempts = 0
  await assert.rejects(
    verifyWorkerHealth(
      async () => {
        attempts += 1
        throw new Error("private network detail")
      },
      "https://monitor.example.com/healthz",
      async (milliseconds) => sleeps.push(milliseconds),
    ),
    (error) => error.exitCode === 1
      && !error.message.includes("private network detail"),
  )
  assert.equal(attempts, 6)
  assert.deepEqual(sleeps, [250, 500, 1000, 2000, 2000])

  const invalid = fixture({
    hasWrangler: true,
    readFileImpl: async (filename) => {
      if (filename === PROFILE_PATH) return PROFILE
      if (filename === CONFIG_PATH) return CONFIGURATION
      if (filename === WRANGLER_PATH) {
        return JSON.stringify({ ...JSON.parse(WRANGLER), main: "/other/worker.mjs" })
      }
      throw new Error("unexpected file")
    },
  })
  assert.equal(await runDeploy([
    "--profile",
    PROFILE_PATH,
    "--dry-run",
  ], invalid), 2)
  assert.match(invalid.stderr.read(), /does not reference this package version/)
})

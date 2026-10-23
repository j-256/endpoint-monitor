import assert from "node:assert/strict"
import test from "node:test"

import { portableConfiguration } from "../src/config.mjs"
import { sha256Hex } from "../src/crypto.mjs"
import {
  handleCloudflareRequest,
  runCloudflareScheduled,
  runCloudflareScheduledSafely,
} from "../src/adapters/cloudflare/runtime.mjs"
import { readMonitorStatus } from "../src/adapters/cloudflare/d1-store.mjs"
import { SubrequestBudgetError } from "../src/adapters/cloudflare/fetch-budget.mjs"
import { d1Fixture } from "./d1.fixture.mjs"

const RUN_AT = "2026-08-26T03:01:00.000Z"
const RUN_MILLISECONDS = Date.parse(RUN_AT)
const HOOK_URL = "https://hooks.example.com/hook/cloudevents/abcdefghijklmnopqrstuv"
const RUN_ID = "c70ff6f9-413b-4567-a086-ff2e47c03540"

function configuration(targets = [{ id: "example-home", url: "https://example.com/" }]) {
  return {
    defaults: {
      failureThreshold: 2,
      method: "GET",
      probeIntervalMinutes: 1,
      recoveryThreshold: 2,
      timeoutMilliseconds: 10000,
    },
    schemaVersion: 1,
    targets,
  }
}

async function seedConfiguration(db, candidate) {
  const normalized = portableConfiguration(candidate)
  const configJson = JSON.stringify(normalized)
  const configFingerprint = `sha256:${await sha256Hex(configJson)}`
  db.sqlite.prepare(`
    INSERT INTO monitor_configuration (
      singleton_id,
      schema_version,
      config_json,
      config_fingerprint,
      target_count,
      updated_at
    ) VALUES (1, ?, ?, ?, ?, ?)
  `).run(
    normalized.schemaVersion,
    configJson,
    configFingerprint,
    normalized.targets.length,
    RUN_AT,
  )
  return { configFingerprint, normalized }
}

function runtimeEnv(db, overrides = {}) {
  return {
    CLOUDFLARE_ANALYTICS_ENABLED: "false",
    ENDPOINT_MONITOR_DELIVERY_ENABLED: "false",
    ENDPOINT_MONITOR_ENABLED: "true",
    ENDPOINT_MONITOR_STATUS_ENABLED: "false",
    MONITOR_DB: db,
    ...overrides,
  }
}

function loggerFixture() {
  const entries = []
  return {
    entries,
    error: (value) => entries.push({ level: "error", value }),
    log: (value) => entries.push({ level: "log", value }),
  }
}

function totalChanges(db) {
  return Number(db.sqlite.prepare("SELECT total_changes() AS count").get().count)
}

test("healthy scheduled runs write only one bounded run snapshot", async (context) => {
  const db = d1Fixture(context)
  await seedConfiguration(db, configuration())
  const before = totalChanges(db)
  const logger = loggerFixture()
  const summary = await runCloudflareScheduled(
    runtimeEnv(db),
    RUN_MILLISECONDS,
    {
      clock: () => RUN_MILLISECONDS,
      fetchImpl: async () => new Response(null, { status: 200 }),
      logger,
    },
  )
  assert.equal(summary.succeededProbes, 1)
  assert.equal(summary.failedProbes, 0)
  assert.equal(summary.d1Writes, 1)
  assert.equal(summary.runStatusWrites, 1)
  assert.equal(totalChanges(db), before + 1)
  assert.equal((await readMonitorStatus(db)).states.length, 0)
  assert.equal(logger.entries.at(-1).value.event, "endpoint_monitor.run")
})

test("healthy response validations write only one bounded run snapshot", async (context) => {
  const db = d1Fixture(context)
  await seedConfiguration(db, {
    ...configuration([{
      expect: {
        contentType: "application/json",
        jsonSubset: { ok: true },
      },
      expectedStatuses: [200],
      id: "example-health",
      url: "https://example.com/health",
    }]),
    schemaVersion: 2,
  })
  const before = totalChanges(db)
  const summary = await runCloudflareScheduled(
    runtimeEnv(db),
    RUN_MILLISECONDS,
    {
      clock: () => RUN_MILLISECONDS,
      fetchImpl: async () => Response.json({ detail: "ignored", ok: true }),
      logger: loggerFixture(),
    },
  )
  assert.equal(summary.succeededProbes, 1)
  assert.equal(summary.failedProbes, 0)
  assert.equal(summary.d1Writes, 1)
  assert.equal(summary.runStatusWrites, 1)
  assert.equal(totalChanges(db), before + 1)
})

test("response validation failures persist only fixed diagnostics", async (context) => {
  const db = d1Fixture(context)
  await seedConfiguration(db, {
    ...configuration([{
      expect: { jsonSubset: { ok: true } },
      expectedStatuses: [200],
      failureThreshold: 1,
      id: "example-health",
      url: "https://example.com/health",
    }]),
    schemaVersion: 2,
  })
  const logger = loggerFixture()
  const summary = await runCloudflareScheduled(
    runtimeEnv(db),
    RUN_MILLISECONDS,
    {
      clock: () => RUN_MILLISECONDS,
      fetchImpl: async () => Response.json({ ok: false, private: "detail" }),
      logger,
      randomUUID: () => "incident-validation",
    },
  )
  const status = await readMonitorStatus(db)
  assert.equal(summary.failedProbes, 1)
  assert.equal(summary.transitions, 1)
  assert.equal(status.openIncidents[0].errorCode, "json-subset-mismatch")
  assert.equal(status.openIncidents[0].latestStatus, 200)
  assert.equal(JSON.stringify(logger.entries).includes("private"), false)
})

test("disabled scheduled runs do not require bindings or subrequests", async () => {
  const logger = loggerFixture()
  const summary = await runCloudflareScheduled(
    { ENDPOINT_MONITOR_ENABLED: "false" },
    RUN_MILLISECONDS,
    { logger },
  )
  assert.equal(summary.enabled, false)
  assert.equal(summary.targetCount, 0)
  assert.equal("subrequests" in summary, false)
  assert.equal(logger.entries[0].value.event, "endpoint_monitor.run_start")
  assert.equal(logger.entries.at(-1).value.event, "endpoint_monitor.run")
})

test("shadow mode persists a 526 incident without delivery state", async (context) => {
  const db = d1Fixture(context)
  await seedConfiguration(db, configuration())
  const logger = loggerFixture()
  const summary = await runCloudflareScheduled(
    runtimeEnv(db),
    RUN_MILLISECONDS,
    {
      clock: () => RUN_MILLISECONDS,
      fetchImpl: async () => new Response(null, { status: 526 }),
      logger,
      randomUUID: () => "incident-shadow",
    },
  )
  const status = await readMonitorStatus(db)
  assert.equal(summary.failedProbes, 1)
  assert.equal(summary.transitions, 1)
  assert.equal(summary.d1Writes, 3)
  assert.equal(status.openIncidents[0].id, "incident-shadow")
  assert.equal(status.pendingDeliveries, 0)
  assert.equal(JSON.stringify(logger.entries).includes("https://example.com/"), false)
})

test("delivery sends and acknowledges a signed transition", async (context) => {
  const db = d1Fixture(context)
  await seedConfiguration(db, configuration())
  let deliveredRequest
  const env = runtimeEnv(db, {
    ENDPOINT_MONITOR_DELIVERY_ENABLED: "true",
    ENDPOINT_MONITOR_HOOKRELAY_HMAC: "delivery-secret",
    ENDPOINT_MONITOR_HOOKRELAY_URL: HOOK_URL,
    HOOKRELAY: {
      fetch: async (url, init) => {
        deliveredRequest = { init, url }
        return new Response(null, { status: 202 })
      },
    },
  })
  const summary = await runCloudflareScheduled(env, RUN_MILLISECONDS, {
    clock: () => RUN_MILLISECONDS,
    fetchImpl: async () => new Response(null, { status: 526 }),
    logger: loggerFixture(),
    randomUUID: () => "incident-delivered",
  })
  assert.equal(summary.deliveriesSucceeded, 1)
  assert.equal(summary.deliveriesFailed, 0)
  assert.equal(summary.subrequests, 2)
  assert.equal(deliveredRequest.url, HOOK_URL)
  assert.match(
    deliveredRequest.init.headers["X-Hookrelay-Signature-256"],
    /^sha256=[a-f0-9]{64}$/,
  )
  assert.equal((await readMonitorStatus(db)).pendingDeliveries, 0)
})

test("direct delivery failures are retried without leaking response data", async (context) => {
  const db = d1Fixture(context)
  await seedConfiguration(db, configuration())
  const logger = loggerFixture()
  const env = runtimeEnv(db, {
    ENDPOINT_MONITOR_DELIVERY_ENABLED: "true",
    ENDPOINT_MONITOR_HOOKRELAY_HMAC: "delivery-secret",
    ENDPOINT_MONITOR_HOOKRELAY_URL: HOOK_URL,
  })
  const summary = await runCloudflareScheduled(env, RUN_MILLISECONDS, {
    clock: () => RUN_MILLISECONDS,
    fetchImpl: async (url) => String(url) === HOOK_URL
      ? new Response("private response", { status: 503 })
      : new Response(null, { status: 526 }),
    logger,
    randomUUID: () => "incident-retry",
  })
  assert.equal(summary.deliveriesFailed, 1)
  assert.equal(summary.deliveriesSucceeded, 0)
  assert.equal((await readMonitorStatus(db)).pendingDeliveries, 1)
  const serialized = JSON.stringify(logger.entries)
  assert.equal(serialized.includes("private response"), false)
  assert.equal(serialized.includes(HOOK_URL), false)
})

test("enabling delivery bridges an incident opened in shadow mode", async (context) => {
  const db = d1Fixture(context)
  await seedConfiguration(db, configuration())
  const baseOptions = {
    clock: () => RUN_MILLISECONDS,
    fetchImpl: async () => new Response(null, { status: 526 }),
    logger: loggerFixture(),
    randomUUID: () => "incident-bridged",
  }
  await runCloudflareScheduled(runtimeEnv(db), RUN_MILLISECONDS, baseOptions)
  let deliveries = 0
  const enabled = runtimeEnv(db, {
    ENDPOINT_MONITOR_DELIVERY_ENABLED: "true",
    ENDPOINT_MONITOR_HOOKRELAY_HMAC: "delivery-secret",
    ENDPOINT_MONITOR_HOOKRELAY_URL: HOOK_URL,
    HOOKRELAY: {
      fetch: async () => {
        deliveries += 1
        return new Response(null, { status: 202 })
      },
    },
  })
  const summary = await runCloudflareScheduled(
    enabled,
    Date.parse("2026-08-26T03:02:00.000Z"),
    { ...baseOptions, clock: () => Date.parse("2026-08-26T03:02:00.000Z") },
  )
  assert.equal(summary.deliveryBridged, 1)
  assert.equal(summary.deliveriesSucceeded, 1)
  assert.equal(deliveries, 1)
})

test("newer successful probes suppress stale analytics failures", async (context) => {
  const db = d1Fixture(context)
  await seedConfiguration(db, configuration())
  const env = runtimeEnv(db, {
    CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    CLOUDFLARE_ANALYTICS_ENABLED: "true",
    CLOUDFLARE_API_TOKEN: "api-token",
  })
  const scheduledAt = Date.parse("2026-08-26T03:05:00.000Z")
  const summary = await runCloudflareScheduled(env, scheduledAt, {
    clock: () => scheduledAt,
    fetchImpl: async (url) => {
      const value = String(url)
      if (value === "https://example.com/") {
        return new Response(null, { status: 200 })
      }
      if (value.startsWith("https://api.cloudflare.com/client/v4/zones?")) {
        return Response.json({
          result: [{ id: "zone-example", name: "example.com" }],
          result_info: { total_pages: 1 },
          success: true,
        })
      }
      return Response.json({
        data: {
          viewer: {
            accounts: [{
              rows: [{
                count: 2,
                dimensions: {
                  clientRequestHTTPHost: "example.com",
                  clientRequestPath: "/",
                  datetimeMinute: "2026-08-26T03:00:00.000Z",
                  edgeResponseStatus: 526,
                  zoneTag: "zone-example",
                },
              }],
            }],
          },
        },
      })
    },
    logger: loggerFixture(),
  })
  assert.equal(summary.analyticsRows, 1)
  assert.equal(summary.analyticsStale, 1)
  assert.equal(summary.analyticsMatched, 0)
  assert.deepEqual((await readMonitorStatus(db)).openIncidents, [])
})

test("analytics can immediately corroborate a current failed probe", async (context) => {
  const db = d1Fixture(context)
  await seedConfiguration(db, configuration())
  const env = runtimeEnv(db, {
    CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    CLOUDFLARE_ANALYTICS_ENABLED: "true",
    CLOUDFLARE_API_TOKEN: "api-token",
  })
  const scheduledAt = Date.parse("2026-08-26T03:05:00.000Z")
  const summary = await runCloudflareScheduled(env, scheduledAt, {
    clock: () => scheduledAt,
    fetchImpl: async (url) => {
      const value = String(url)
      if (value === "https://example.com/") {
        return new Response(null, { status: 500 })
      }
      if (value.startsWith("https://api.cloudflare.com/client/v4/zones?")) {
        return Response.json({
          result: [{ id: "zone-example", name: "example.com" }],
          result_info: { total_pages: 1 },
          success: true,
        })
      }
      return Response.json({
        data: {
          viewer: {
            accounts: [{
              rows: [{
                count: 2,
                dimensions: {
                  clientRequestHTTPHost: "example.com",
                  clientRequestPath: "/",
                  datetimeMinute: "2026-08-26T03:00:00.000Z",
                  edgeResponseStatus: 526,
                  zoneTag: "zone-example",
                },
              }],
            }],
          },
        },
      })
    },
    logger: loggerFixture(),
    randomUUID: () => "incident-analytics-runtime",
  })
  assert.equal(summary.failedProbes, 1)
  assert.equal(summary.analyticsMatched, 1)
  assert.equal(summary.transitions, 1)
  assert.equal((await readMonitorStatus(db)).openIncidents[0].latestSignal, "cloudflare-analytics")
})

test("analytics API errors become bounded phase errors", async (context) => {
  const db = d1Fixture(context)
  await seedConfiguration(db, configuration())
  const logger = loggerFixture()
  const env = runtimeEnv(db, {
    CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    CLOUDFLARE_ANALYTICS_ENABLED: "true",
    CLOUDFLARE_API_TOKEN: "api-token",
  })
  const scheduledAt = Date.parse("2026-08-26T03:05:00.000Z")
  const summary = await runCloudflareScheduled(env, scheduledAt, {
    clock: () => scheduledAt,
    fetchImpl: async (url) => String(url) === "https://example.com/"
      ? new Response(null, { status: 200 })
      : new Response("private error", { status: 503 }),
    logger,
  })
  assert.equal(summary.phaseErrors, 1)
  assert.equal(summary.succeededProbes, 1)
  assert.equal(
    logger.entries.some((entry) => (
      entry.value.errorCode === "cloudflare-zones-failed"
    )),
    true,
  )
  assert.equal(JSON.stringify(logger.entries).includes("private error"), false)
})

test("hourly runs execute bounded retention maintenance", async (context) => {
  const db = d1Fixture(context)
  await seedConfiguration(db, configuration())
  const scheduledAt = Date.parse("2026-08-26T04:00:00.000Z")
  const summary = await runCloudflareScheduled(
    runtimeEnv(db),
    scheduledAt,
    {
      clock: () => scheduledAt,
      fetchImpl: async () => new Response(null, { status: 200 }),
      logger: loggerFixture(),
    },
  )
  assert.equal(summary.pruned, 0)
  assert.equal(summary.succeededProbes, 1)
  assert.equal("analytics" in summary.phaseDurationsMilliseconds, false)
})

test("health and authenticated status routes expose the intended surfaces", async (context) => {
  const db = d1Fixture(context)
  const seeded = await seedConfiguration(db, configuration())
  const env = runtimeEnv(db, {
    ENDPOINT_MONITOR_STATUS_ENABLED: "true",
    ENDPOINT_MONITOR_STATUS_TOKEN: "status-secret",
  })
  const health = await handleCloudflareRequest(
    new Request("https://monitor.example/healthz"),
    {},
  )
  assert.equal(health.status, 200)
  assert.deepEqual(await health.json(), { ok: true, service: "endpoint-monitor" })

  const unauthorized = await handleCloudflareRequest(
    new Request("https://monitor.example/api/status"),
    env,
  )
  assert.equal(unauthorized.status, 401)

  const status = await handleCloudflareRequest(
    new Request("https://monitor.example/api/status", {
      headers: { Authorization: "Bearer status-secret" },
    }),
    env,
    { clock: () => RUN_MILLISECONDS },
  )
  assert.equal(status.status, 200)
  assert.equal(status.headers.get("Cache-Control"), "no-store")
  const body = await status.json()
  assert.equal(body.configurationFingerprint, seeded.configFingerprint)
  assert.equal(body.configuration.targets[0].url, "https://example.com/")
  assert.equal(body.schedule.maximumShardSize, 1)
})

test("HTTP surface rejects unsupported, hidden, and unavailable routes", async (context) => {
  const db = d1Fixture(context)
  const method = await handleCloudflareRequest(
    new Request("https://monitor.example/healthz", { method: "POST" }),
    {},
  )
  assert.equal(method.status, 405)
  assert.equal(method.headers.get("Allow"), "GET, HEAD")

  const head = await handleCloudflareRequest(
    new Request("https://monitor.example/healthz", { method: "HEAD" }),
    {},
  )
  assert.equal(head.status, 200)
  assert.equal(await head.text(), "")

  const missing = await handleCloudflareRequest(
    new Request("https://monitor.example/"),
    {},
  )
  assert.equal(missing.status, 404)

  const hidden = await handleCloudflareRequest(
    new Request("https://monitor.example/api/status"),
    { ENDPOINT_MONITOR_STATUS_ENABLED: "false" },
  )
  assert.equal(hidden.status, 404)

  const misconfigured = await handleCloudflareRequest(
    new Request("https://monitor.example/api/status"),
    { ENDPOINT_MONITOR_STATUS_ENABLED: "true" },
  )
  assert.equal(misconfigured.status, 503)

  const unavailable = await handleCloudflareRequest(
    new Request("https://monitor.example/api/status", {
      headers: { Authorization: "Bearer status-secret" },
    }),
    runtimeEnv(db, {
      ENDPOINT_MONITOR_STATUS_ENABLED: "true",
      ENDPOINT_MONITOR_STATUS_TOKEN: "status-secret",
    }),
  )
  assert.equal(unavailable.status, 503)
})

test("configuration failures emit correlated bounded phase diagnostics before completion", async () => {
  const logger = loggerFixture()
  let elapsed = 0
  const env = { get ENDPOINT_MONITOR_ENABLED() { elapsed = 37; return "true" } }
  await assert.rejects(
    runCloudflareScheduledSafely(
      env,
      RUN_MILLISECONDS,
      { logger, clock: () => RUN_MILLISECONDS + 240000,
        monotonicClock: () => elapsed, randomRunId: () => RUN_ID },
    ),
    (error) => error.message === "monitor-database-unavailable",
  )
  assert.equal(logger.entries[0].value.event, "endpoint_monitor.run_start")
  assert.equal(logger.entries[0].value.schedulerDelayMilliseconds, 240000)
  const failure = logger.entries.at(-1).value
  assert.equal(failure.event, "endpoint_monitor.runtime_error")
  assert.equal(failure.errorCode, "monitor-database-unavailable")
  assert.equal(failure.runId, RUN_ID)
  assert.equal(failure.phase, "configuration")
  assert.equal(failure.elapsedMilliseconds, 37)
  assert.equal(failure.phaseElapsedMilliseconds, 37)
  assert.deepEqual(failure.phaseDurationsMilliseconds, { configuration: 37 })
  assert.equal(logger.entries.some(({ value }) => value.event === "endpoint_monitor.run"), false)
})

test("successful runs correlate bounded phases and measure execution independently of wall-clock changes", async (context) => {
  const db = d1Fixture(context)
  await seedConfiguration(db, configuration())
  const logger = loggerFixture()
  let elapsed = 0
  let wall = RUN_MILLISECONDS + 1000
  const originalPrepare = db.prepare.bind(db)
  db.prepare = (sql) => {
    if (sql.includes("FROM monitor_configuration")) elapsed += 19
    if (sql.includes("INSERT INTO monitor_run_status")) elapsed += 7
    return originalPrepare(sql)
  }
  const summary = await runCloudflareScheduled(runtimeEnv(db), RUN_MILLISECONDS, {
    clock: () => wall, monotonicClock: () => elapsed, logger, randomRunId: () => RUN_ID,
    fetchImpl: async () => { elapsed += 83; wall += 1000; return new Response(null, { status: 200 }) },
  })
  assert.equal(summary.runId, RUN_ID)
  assert.equal(summary.durationMilliseconds, 109)
  assert.equal(summary.phaseDurationsMilliseconds.configuration, 19)
  assert.equal(summary.phaseDurationsMilliseconds.probing, 83)
  assert.equal(summary.phaseDurationsMilliseconds["run-status"], 7)
  assert.equal(summary.runStatusWrites, 1)
  assert.equal(summary.d1Writes, 1)
  assert.equal(logger.entries.length, 2)
  assert.ok(logger.entries.every(({ value }) => value.runId === RUN_ID))
  const retained = JSON.parse(db.sqlite.prepare("SELECT snapshot_json FROM monitor_run_status").get().snapshot_json)
  assert.equal(retained.runId, RUN_ID)
  assert.equal(retained.phaseDurationsMilliseconds.configuration, 19)
  assert.equal("run-status" in retained.phaseDurationsMilliseconds, false)
  assert.equal(retained.completedAt, "2026-08-26T03:01:02.000Z")
})

test("storage failure names its phase without retaining an arbitrary error code or refreshing completion", async (context) => {
  const db = d1Fixture(context)
  await seedConfiguration(db, configuration())
  db.sqlite.exec("CREATE TRIGGER fail_run BEFORE INSERT ON monitor_run_status BEGIN SELECT RAISE(ABORT, 'private storage detail'); END")
  const logger = loggerFixture()
  await assert.rejects(runCloudflareScheduledSafely(runtimeEnv(db), RUN_MILLISECONDS, {
    logger, clock: () => RUN_MILLISECONDS, randomRunId: () => RUN_ID,
    fetchImpl: async () => new Response(null, { status: 200 }),
  }), { message: "runtime-failed" })
  assert.equal(logger.entries.at(-1).value.phase, "run-status")
  assert.equal(logger.entries.at(-1).value.runId, RUN_ID)
  assert.equal(JSON.stringify(logger.entries).includes("private storage"), false)
  assert.equal(db.sqlite.prepare("SELECT count(*) AS count FROM monitor_run_status").get().count, 0)
})

test("critical phase failures remain correlated, sanitized and incomplete", async (context) => {
  const cases = [
    { phase: "configuration", sql: "FROM monitor_configuration" },
    { phase: "reconciliation", sql: "FROM monitor_target_state" },
    { phase: "persistence", sql: "INSERT INTO monitor_target_state", status: 526 },
    { phase: "delivery", sql: "LEFT JOIN monitor_outbox", delivery: true },
    { phase: "maintenance", sql: "DELETE FROM monitor_signal", at: "2026-08-26T04:00:00.000Z" },
  ]
  for (const scenario of cases) {
    const db = d1Fixture(context)
    await seedConfiguration(db, configuration())
    const prepare = db.prepare.bind(db)
    db.prepare = (sql) => {
      if (sql.includes(scenario.sql)) {
        const error = new Error("https://private.example/secret")
        error.code = "private-api-key"
        throw error
      }
      return prepare(sql)
    }
    const at = scenario.at ? Date.parse(scenario.at) : RUN_MILLISECONDS
    const logger = loggerFixture()
    const env = runtimeEnv(db, scenario.delivery ? { ENDPOINT_MONITOR_DELIVERY_ENABLED: true,
      ENDPOINT_MONITOR_HOOKRELAY_URL: HOOK_URL, ENDPOINT_MONITOR_HOOKRELAY_HMAC: "private-hmac" } : {})
    await assert.rejects(runCloudflareScheduledSafely(env, at, {
      logger, clock: () => at, randomRunId: () => RUN_ID,
      fetchImpl: async () => new Response(null, { status: scenario.status ?? 200 }),
    }), { message: "runtime-failed" }, scenario.phase)
    const failure = logger.entries.at(-1).value
    assert.equal(failure.phase, scenario.phase)
    assert.equal(failure.runId, RUN_ID)
    assert.ok(Number.isSafeInteger(failure.phaseDurationsMilliseconds[scenario.phase]))
    assert.equal(JSON.stringify(logger.entries).includes("private"), false)
    assert.equal(logger.entries.some(({ value }) => value.event === "endpoint_monitor.run"), false)
    assert.equal(db.sqlite.prepare("SELECT count(*) AS count FROM monitor_run_status").get().count, 0)
  }
})

test("probing resource limits leave start and fixed failure evidence without a completion snapshot", async (context) => {
  const db = d1Fixture(context)
  await seedConfiguration(db, configuration())
  const logger = loggerFixture()
  await assert.rejects(runCloudflareScheduledSafely(runtimeEnv(db), RUN_MILLISECONDS, {
    logger, clock: () => RUN_MILLISECONDS, randomRunId: () => RUN_ID,
    fetchImpl: async () => { throw new SubrequestBudgetError() },
  }), { message: "subrequest-budget-exhausted" })
  assert.equal(logger.entries.at(-1).value.phase, "probing")
  assert.equal(logger.entries.at(-1).value.runId, RUN_ID)
  assert.equal(logger.entries.some(({ value }) => value.event === "endpoint_monitor.run"), false)
  assert.equal(db.sqlite.prepare("SELECT count(*) AS count FROM monitor_run_status").get().count, 0)
})

test("safe scheduled wrapper normalizes unknown and budget failures", async (context) => {
  const db = d1Fixture(context)
  await seedConfiguration(db, configuration())
  const unknownLogger = loggerFixture()
  await assert.rejects(
    runCloudflareScheduledSafely(runtimeEnv(db), RUN_MILLISECONDS, {
      clock: () => RUN_MILLISECONDS,
      fetchImpl: async () => {
        const error = new Error("private detail")
        error.name = "SubrequestBudgetError"
        throw error
      },
      logger: unknownLogger,
    }),
    (error) => error.message === "runtime-failed",
  )
  assert.equal(JSON.stringify(unknownLogger.entries).includes("private detail"), false)

  const invalidLogger = loggerFixture()
  await assert.rejects(
    runCloudflareScheduledSafely(runtimeEnv(db), "invalid", {
      logger: invalidLogger,
    }),
    (error) => error.message === "invalid-scheduled-time",
  )
})

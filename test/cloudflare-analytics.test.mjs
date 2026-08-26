import assert from "node:assert/strict"
import test from "node:test"

import {
  ANALYTICS_QUERY,
  readCloudflareAnalyticsFailures,
} from "../src/adapters/cloudflare/analytics.mjs"

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef"
const NOW = "2026-08-26T03:20:37.000Z"

function target(overrides = {}) {
  return {
    configFingerprint: "sha256:example-home",
    expectedStatuses: null,
    failureThreshold: 2,
    id: "example-home",
    method: "GET",
    recoveryThreshold: 2,
    timeoutMilliseconds: 10000,
    url: "https://www.example.com/health",
    ...overrides,
  }
}

function analyticsRow(overrides = {}) {
  return {
    count: 3,
    dimensions: {
      clientRequestHTTPHost: "www.example.com",
      clientRequestPath: "/health",
      datetimeMinute: "2026-08-26T03:15:00.000Z",
      edgeResponseStatus: 526,
      zoneTag: "zone-example",
      ...overrides,
    },
  }
}

function apiWithRows(rows, zones = [{ id: "zone-example", name: "example.com" }]) {
  const calls = { variables: null }
  return {
    accountId: ACCOUNT_ID,
    calls,
    graphql: async (_query, variables) => {
      calls.variables = variables
      return { viewer: { accounts: [{ rows }] } }
    },
    listZones: async () => zones,
  }
}

test("Cloudflare analytics maps only exact configured hostname and path", async () => {
  const api = apiWithRows([analyticsRow()])
  const result = await readCloudflareAnalyticsFailures(api, [target()], NOW)
  assert.equal(result.entries.length, 1)
  assert.equal(result.entries[0].target.id, "example-home")
  assert.equal(result.entries[0].observation.httpStatus, 526)
  assert.equal(result.entries[0].observation.requestCount, 3)
  assert.match(result.entries[0].signal.fingerprint, /^sha256:[a-f0-9]{64}$/)
  assert.deepEqual(api.calls.variables.hostnames, ["www.example.com"])
  assert.equal(api.calls.variables.end, "2026-08-26T03:18:00.000Z")
  assert.equal(api.calls.variables.start, "2026-08-26T03:03:00.000Z")
})

test("Cloudflare analytics cannot enroll external or mismatched traffic", async () => {
  const api = apiWithRows([
    analyticsRow({ zoneTag: "zone-external" }),
    analyticsRow({ clientRequestPath: "/other" }),
    analyticsRow({ clientRequestHTTPHost: "unconfigured.example.com" }),
  ], [
    { id: "zone-example", name: "example.com" },
    { id: "zone-external", name: "external.net" },
  ])
  const result = await readCloudflareAnalyticsFailures(api, [target()], NOW)
  assert.deepEqual(result.entries, [])
  assert.equal(result.rowCount, 3)
})

test("Cloudflare analytics skips targets with query strings", async () => {
  let called = false
  const api = {
    accountId: ACCOUNT_ID,
    graphql: async () => {
      called = true
    },
    listZones: async () => {
      called = true
    },
  }
  const result = await readCloudflareAnalyticsFailures(
    api,
    [target({ url: "https://www.example.com/health?deep=1" })],
    NOW,
  )
  assert.deepEqual(result, { entries: [], rowCount: 0 })
  assert.equal(called, false)
})

test("Cloudflare analytics discards malformed and irrelevant rows", async () => {
  const api = apiWithRows([
    analyticsRow({ edgeResponseStatus: 500 }),
    analyticsRow({ datetimeMinute: "invalid" }),
    analyticsRow({ clientRequestPath: "health" }),
    { ...analyticsRow(), count: 0 },
  ])
  const result = await readCloudflareAnalyticsFailures(api, [target()], NOW)
  assert.deepEqual(result.entries, [])
})

test("Cloudflare analytics preserves an exact target status contract", async () => {
  const api = apiWithRows([analyticsRow()])
  const result = await readCloudflareAnalyticsFailures(
    api,
    [target({ expectedStatuses: [200, 526] })],
    NOW,
  )
  assert.deepEqual(result.entries, [])
})

test("Cloudflare analytics rejects unavailable or truncated results", async () => {
  const unavailable = apiWithRows(null)
  await assert.rejects(
    readCloudflareAnalyticsFailures(unavailable, [target()], NOW),
    /cloudflare-analytics-rows-unavailable/,
  )

  const truncated = apiWithRows(Array.from({ length: 5000 }, analyticsRow))
  await assert.rejects(
    readCloudflareAnalyticsFailures(truncated, [target()], NOW),
    /cloudflare-analytics-result-truncated/,
  )
})

test("Cloudflare analytics query limits status, source, and configured hosts", () => {
  assert.match(ANALYTICS_QUERY, /clientRequestHTTPHost_in: \$hostnames/)
  assert.match(ANALYTICS_QUERY, /edgeResponseStatus_in: \[520, 521, 522, 523, 524, 525, 526, 530\]/)
  assert.match(ANALYTICS_QUERY, /requestSource: "eyeball"/)
  assert.match(ANALYTICS_QUERY, /clientRequestPath/)
  assert.match(ANALYTICS_QUERY, /zoneTag/)
})

test("Cloudflare analytics validates inputs, time, and deterministic ordering", async () => {
  await assert.rejects(
    readCloudflareAnalyticsFailures({}, [target()], NOW),
    /input is invalid/,
  )
  await assert.rejects(
    readCloudflareAnalyticsFailures(apiWithRows([]), [target()], "invalid"),
    /time is invalid/,
  )
  const api = apiWithRows([
    analyticsRow({
      datetimeMinute: "2026-08-26T03:16:00.000Z",
      edgeResponseStatus: 526,
    }),
    analyticsRow({
      datetimeMinute: "2026-08-26T03:15:00.000Z",
      edgeResponseStatus: 525,
    }),
  ])
  const result = await readCloudflareAnalyticsFailures(
    api,
    [target()],
    new Date(NOW),
  )
  assert.deepEqual(
    result.entries.map((entry) => entry.observation.httpStatus),
    [525, 526],
  )
})

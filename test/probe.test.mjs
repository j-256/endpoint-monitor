import assert from "node:assert/strict"
import test from "node:test"

import {
  OBSERVATION_OUTCOME,
} from "../src/constants.mjs"
import {
  MAXIMUM_VALIDATION_BODY_BYTES,
  probeTarget,
  probeTargets,
  summarizeProbeResults,
} from "../src/probe.mjs"

const OBSERVED_AT = "2026-08-26T03:00:00.000Z"

function target(id, overrides = {}) {
  return {
    configFingerprint: `sha256:${id}`,
    expect: null,
    expectedStatuses: null,
    failureThreshold: 2,
    id,
    method: "GET",
    recoveryThreshold: 2,
    timeoutMilliseconds: 10000,
    url: `https://${id}.example.com/health`,
    ...overrides,
  }
}

test("probe uses the exact URL, method, and manual redirects", async () => {
  let cancelled = false
  const fetchImpl = async (url, options) => {
    assert.equal(url, "https://example-home.example.com/health")
    assert.equal(options.method, "HEAD")
    assert.equal(options.redirect, "manual")
    assert.equal(options.headers.Accept, "*/*")
    assert.ok(options.signal instanceof AbortSignal)
    return {
      body: { cancel: async () => { cancelled = true } },
      status: 302,
    }
  }
  const observation = await probeTarget(
    fetchImpl,
    target("example-home", { method: "HEAD" }),
    OBSERVED_AT,
  )
  assert.equal(observation.outcome, OBSERVATION_OUTCOME.SUCCESS)
  assert.equal(cancelled, true)
})

test("probe maps timeout and network failures to fixed codes", async () => {
  const timeout = await probeTarget(
    async () => { throw Object.assign(new Error("private"), { name: "TimeoutError" }) },
    target("timeout"),
    OBSERVED_AT,
  )
  assert.equal(timeout.errorCode, "timeout")
  const network = await probeTarget(
    async () => { throw new Error("private") },
    target("network"),
    OBSERVED_AT,
  )
  assert.equal(network.errorCode, "network")
})

test("probe validates media types and bounded body markers", async () => {
  const configured = target("page", {
    expect: {
      bodyIncludes: "<title>Ready</title>",
      contentType: "text/html",
    },
    expectedStatuses: [200],
  })
  const success = await probeTarget(
    async () => new Response("<title>Ready</title>", {
      headers: { "Content-Type": "Text/HTML; charset=utf-8" },
      status: 200,
    }),
    configured,
    OBSERVED_AT,
  )
  assert.equal(success.outcome, OBSERVATION_OUTCOME.SUCCESS)

  const contentType = await probeTarget(
    async () => Response.json({ ready: true }),
    configured,
    OBSERVED_AT,
  )
  assert.equal(contentType.outcome, OBSERVATION_OUTCOME.FAILURE)
  assert.equal(contentType.errorCode, "content-type-mismatch")

  const marker = await probeTarget(
    async () => new Response("<title>Wrong</title>", {
      headers: { "Content-Type": "text/html" },
      status: 200,
    }),
    configured,
    OBSERVED_AT,
  )
  assert.equal(marker.errorCode, "body-marker-missing")
})

test("probe validates recursive JSON subsets without requiring exact objects", async () => {
  const configured = target("json", {
    expect: {
      contentType: "application/json",
      jsonSubset: {
        nested: { ready: true },
        versions: [1, 2],
      },
    },
    expectedStatuses: [200],
  })
  const success = await probeTarget(
    async () => Response.json({
      extra: "allowed",
      nested: { extra: 1, ready: true },
      versions: [1, 2],
    }),
    configured,
    OBSERVED_AT,
  )
  assert.equal(success.outcome, OBSERVATION_OUTCOME.SUCCESS)

  const mismatch = await probeTarget(
    async () => Response.json({ nested: { ready: false }, versions: [1, 2] }),
    configured,
    OBSERVED_AT,
  )
  assert.equal(mismatch.errorCode, "json-subset-mismatch")

  const invalid = await probeTarget(
    async () => new Response("not-json", {
      headers: { "Content-Type": "application/json" },
      status: 200,
    }),
    configured,
    OBSERVED_AT,
  )
  assert.equal(invalid.errorCode, "response-json-invalid")
})

test("probe validates normalized redirect locations and optional query ignoring", async () => {
  const configured = target("redirect", {
    expect: {
      location: {
        ignoreQuery: false,
        url: "https://new.example.com/path?probe=1",
      },
    },
    expectedStatuses: [301],
    url: "https://old.example.com/path?probe=1",
  })
  const success = await probeTarget(
    async () => new Response(null, {
      headers: { Location: "https://NEW.example.com:443/path?probe=1" },
      status: 301,
    }),
    configured,
    OBSERVED_AT,
  )
  assert.equal(success.outcome, OBSERVATION_OUTCOME.SUCCESS)

  const mismatch = await probeTarget(
    async () => new Response(null, {
      headers: { Location: "https://new.example.com/path?probe=2" },
      status: 301,
    }),
    configured,
    OBSERVED_AT,
  )
  assert.equal(mismatch.errorCode, "location-mismatch")

  const ignored = await probeTarget(
    async () => new Response(null, {
      headers: { Location: "https://new.example.com/path?different=true" },
      status: 301,
    }),
    target("redirect-query", {
      expect: {
        location: {
          ignoreQuery: true,
          url: "https://new.example.com/path",
        },
      },
      expectedStatuses: [301],
      url: "https://old.example.com/path",
    }),
    OBSERVED_AT,
  )
  assert.equal(ignored.outcome, OBSERVATION_OUTCOME.SUCCESS)

  const missing = await probeTarget(
    async () => new Response(null, { status: 301 }),
    configured,
    OBSERVED_AT,
  )
  assert.equal(missing.errorCode, "location-missing")
})

test("probe caps validation bodies and does not mask failing statuses", async () => {
  const configured = target("bounded-json", {
    expect: { jsonSubset: { ready: true } },
    expectedStatuses: [200],
  })
  const oversized = await probeTarget(
    async () => new Response("x".repeat(MAXIMUM_VALIDATION_BODY_BYTES + 1), {
      status: 200,
    }),
    configured,
    OBSERVED_AT,
  )
  assert.equal(oversized.errorCode, "response-body-too-large")

  const largePage = await probeTarget(
    async () => new Response(`ready${"x".repeat(MAXIMUM_VALIDATION_BODY_BYTES)}`, {
      status: 200,
    }),
    target("bounded-marker", {
      expect: { bodyIncludes: "ready" },
      expectedStatuses: [200],
    }),
    OBSERVED_AT,
  )
  assert.equal(largePage.outcome, OBSERVATION_OUTCOME.SUCCESS)

  let cancelled = false
  const status = await probeTarget(
    async () => ({
      body: { cancel: async () => { cancelled = true } },
      status: 500,
    }),
    target("status", {
      expect: { bodyIncludes: "ready" },
      expectedStatuses: [200],
    }),
    OBSERVED_AT,
  )
  assert.equal(status.httpStatus, 500)
  assert.equal(status.errorCode, null)
  assert.equal(cancelled, true)
})

test("probe pool preserves target order and summarizes outcomes", async () => {
  const configured = [target("one"), target("two"), target("three")]
  const results = await probeTargets(async (url) => ({
    body: null,
    status: url.includes("two") ? 526 : 200,
  }), configured, OBSERVED_AT, 2)
  assert.deepEqual(results.map((result) => result.target.id), ["one", "two", "three"])
  assert.deepEqual(summarizeProbeResults(results), { failed: 1, succeeded: 2 })
})

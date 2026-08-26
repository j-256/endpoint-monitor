import assert from "node:assert/strict"
import test from "node:test"

import {
  OBSERVATION_OUTCOME,
} from "../src/constants.mjs"
import {
  probeTarget,
  probeTargets,
  summarizeProbeResults,
} from "../src/probe.mjs"

const OBSERVED_AT = "2026-08-26T03:00:00.000Z"

function target(id, overrides = {}) {
  return {
    configFingerprint: `sha256:${id}`,
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

test("probe pool preserves target order and summarizes outcomes", async () => {
  const configured = [target("one"), target("two"), target("three")]
  const results = await probeTargets(async (url) => ({
    body: null,
    status: url.includes("two") ? 526 : 200,
  }), configured, OBSERVED_AT, 2)
  assert.deepEqual(results.map((result) => result.target.id), ["one", "two", "three"])
  assert.deepEqual(summarizeProbeResults(results), { failed: 1, succeeded: 2 })
})

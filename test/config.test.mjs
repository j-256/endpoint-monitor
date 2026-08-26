import assert from "node:assert/strict"
import test from "node:test"

import {
  configuredTargets,
  normalizeConfiguration,
  portableConfiguration,
} from "../src/config.mjs"

function configuration(overrides = {}) {
  return {
    defaults: {
      failureThreshold: 2,
      method: "GET",
      probeIntervalMinutes: 5,
      recoveryThreshold: 2,
      timeoutMilliseconds: 10000,
    },
    schemaVersion: 1,
    targets: [{ id: "example-home", url: "https://example.com" }],
    ...overrides,
  }
}

test("configuration normalization resolves defaults and canonical URLs", () => {
  const normalized = normalizeConfiguration(configuration())
  assert.deepEqual(normalized.defaults, {
    failureThreshold: 2,
    method: "GET",
    probeIntervalMinutes: 5,
    recoveryThreshold: 2,
    timeoutMilliseconds: 10000,
  })
  assert.deepEqual(normalized.targets[0], {
    expectedStatuses: null,
    failureThreshold: 2,
    id: "example-home",
    method: "GET",
    recoveryThreshold: 2,
    timeoutMilliseconds: 10000,
    url: "https://example.com/",
  })
})

test("targets support exact expected statuses and threshold overrides", () => {
  const normalized = normalizeConfiguration(configuration({
    targets: [{
      expectedStatuses: [204, 200],
      failureThreshold: 3,
      id: "example-health",
      method: "HEAD",
      recoveryThreshold: 1,
      timeoutMilliseconds: 500,
      url: "http://status.example.net:8080/health?format=short",
    }],
  }))
  assert.deepEqual(normalized.targets[0], {
    expectedStatuses: [200, 204],
    failureThreshold: 3,
    id: "example-health",
    method: "HEAD",
    recoveryThreshold: 1,
    timeoutMilliseconds: 500,
    url: "http://status.example.net:8080/health?format=short",
  })
})

test("configured target fingerprints are stable and configuration-sensitive", async () => {
  const [first] = await configuredTargets(configuration())
  const [same] = await configuredTargets(configuration())
  const [changed] = await configuredTargets(configuration({
    targets: [{ id: "example-home", method: "HEAD", url: "https://example.com" }],
  }))
  assert.match(first.configFingerprint, /^sha256:[a-f0-9]{64}$/)
  assert.equal(first.configFingerprint, same.configFingerprint)
  assert.notEqual(first.configFingerprint, changed.configFingerprint)
})

test("portable configuration contains no frozen implementation metadata", () => {
  const portable = portableConfiguration(configuration())
  assert.deepEqual(portable, {
    defaults: {
      failureThreshold: 2,
      method: "GET",
      probeIntervalMinutes: 5,
      recoveryThreshold: 2,
      timeoutMilliseconds: 10000,
    },
    schemaVersion: 1,
    targets: [{
      failureThreshold: 2,
      id: "example-home",
      method: "GET",
      recoveryThreshold: 2,
      timeoutMilliseconds: 10000,
      url: "https://example.com/",
    }],
  })
})

test("configuration rejects unsupported fields and duplicate identities", () => {
  assert.throws(
    () => normalizeConfiguration({ ...configuration(), automaticDiscovery: true }),
    /unsupported field/,
  )
  assert.throws(
    () => normalizeConfiguration(configuration({
      targets: [
        { id: "duplicate", url: "https://one.example.com/" },
        { id: "duplicate", url: "https://two.example.com/" },
      ],
    })),
    /Duplicate target ID/,
  )
  assert.throws(
    () => normalizeConfiguration(configuration({
      targets: [
        { id: "one", url: "https://same.example.com" },
        { id: "two", url: "https://same.example.com/" },
      ],
    })),
    /Duplicate target URL/,
  )
})

test("configuration rejects ambiguous or unsafe target values", () => {
  for (const target of [
    { id: "Bad_ID", url: "https://example.com/" },
    { id: "credentials", url: "https://user:pass@example.com/" },
    { id: "fragment", url: "https://example.com/#private" },
    { id: "internal", url: "http://service.internal/" },
    { id: "ipv4", url: "http://127.0.0.1/" },
    { id: "ipv6", url: "http://[::1]/" },
    { id: "localhost", url: "http://localhost/" },
    { id: "method", method: "POST", url: "https://example.com/" },
    { id: "onion", url: "http://service.onion/" },
    { id: "reserved", url: "http://service.example/" },
    { id: "single-label", url: "http://intranet/" },
    { expectedStatuses: [200, 200], id: "statuses", url: "https://example.com/" },
  ]) {
    assert.throws(() => normalizeConfiguration(configuration({ targets: [target] })))
  }
})

test("configuration accepts an empty explicit target list", () => {
  const normalized = normalizeConfiguration(configuration({ targets: [] }))
  assert.deepEqual(normalized.targets, [])
})

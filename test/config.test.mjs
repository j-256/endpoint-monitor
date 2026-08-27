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
    expect: null,
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
    expect: null,
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

  const [versionTwoWithoutExpectations] = await configuredTargets(configuration({
    schemaVersion: 2,
  }))
  assert.equal(first.configFingerprint, versionTwoWithoutExpectations.configFingerprint)

  const [validated] = await configuredTargets(configuration({
    schemaVersion: 2,
    targets: [{
      expect: { contentType: "text/html" },
      id: "example-home",
      url: "https://example.com",
    }],
  }))
  assert.notEqual(first.configFingerprint, validated.configFingerprint)
})

test("schema version 2 normalizes bounded response expectations", () => {
  const normalized = normalizeConfiguration(configuration({
    schemaVersion: 2,
    targets: [{
      expect: {
        bodyIncludes: "service ready",
        contentType: "Application/JSON",
        jsonSubset: {
          nested: { ready: true },
          ok: true,
          versions: [1, 2],
        },
      },
      expectedStatuses: [200],
      id: "example-health",
      url: "https://status.example.net/health",
    }, {
      expect: {
        location: {
          url: "https://www.example.net/path?probe=1",
        },
      },
      expectedStatuses: [301],
      id: "example-redirect",
      url: "https://old.example.net/path?probe=1",
    }],
  }))
  assert.deepEqual(normalized.targets[0].expect, {
    bodyIncludes: "service ready",
    contentType: "application/json",
    jsonSubset: {
      nested: { ready: true },
      ok: true,
      versions: [1, 2],
    },
  })
  assert.deepEqual(normalized.targets[1].expect, {
    location: {
      ignoreQuery: false,
      url: "https://www.example.net/path?probe=1",
    },
  })
})

test("portable schema version 2 retains normalized expectations", () => {
  const portable = portableConfiguration(configuration({
    schemaVersion: 2,
    targets: [{
      expect: {
        contentType: "Text/HTML",
        location: {
          ignoreQuery: true,
          url: "https://www.example.net/",
        },
      },
      expectedStatuses: [307],
      id: "example-redirect",
      url: "https://old.example.net/",
    }],
  }))
  assert.deepEqual(portable.targets[0].expect, {
    contentType: "text/html",
    location: {
      ignoreQuery: true,
      url: "https://www.example.net/",
    },
  })
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

test("configuration rejects unsafe or contradictory response expectations", () => {
  const invalidTargets = [
    { expect: {}, id: "empty", url: "https://example.com/" },
    { expect: { bodyIncludes: " " }, id: "body", url: "https://example.com/" },
    { expect: { contentType: "text/html; charset=utf-8" }, id: "type", url: "https://example.com/" },
    { expect: { jsonSubset: {} }, id: "json", url: "https://example.com/" },
    { expect: { jsonSubset: { invalid: undefined } }, id: "json-value", url: "https://example.com/" },
    { expect: { bodyIncludes: "text" }, id: "head", method: "HEAD", url: "https://example.com/" },
    {
      expect: { location: { url: "https://www.example.com/" } },
      expectedStatuses: [200],
      id: "location-status",
      url: "https://example.com/",
    },
    {
      expect: { location: { ignoreQuery: "yes", url: "https://www.example.com/" } },
      expectedStatuses: [301],
      id: "location-query",
      url: "https://example.com/",
    },
    {
      expect: { location: { url: "https://user:pass@www.example.com/" } },
      expectedStatuses: [301],
      id: "location-url",
      url: "https://example.com/",
    },
  ]
  for (const target of invalidTargets) {
    assert.throws(() => normalizeConfiguration(configuration({
      schemaVersion: 2,
      targets: [target],
    })))
  }
  assert.throws(() => normalizeConfiguration(configuration({
    schemaVersion: 1,
    targets: [{
      expect: { contentType: "text/html" },
      id: "legacy",
      url: "https://example.com/",
    }],
  })), /unsupported field/)
  assert.throws(() => normalizeConfiguration(configuration({
    schemaVersion: 3,
  })), /schemaVersion/)
})

test("configuration accepts an empty explicit target list", () => {
  const normalized = normalizeConfiguration(configuration({ targets: [] }))
  assert.deepEqual(normalized.targets, [])
})

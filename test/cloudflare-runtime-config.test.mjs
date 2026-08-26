import assert from "node:assert/strict"
import test from "node:test"

import {
  loadStoredConfiguration,
  readRuntimeSettings,
} from "../src/adapters/cloudflare/runtime-config.mjs"
import { d1Fixture } from "./d1.fixture.mjs"

const UPDATED_AT = "2026-08-26T03:00:00.000Z"
const VALID_FINGERPRINT = `sha256:${"a".repeat(64)}`

function insertConfiguration(db, configJson, overrides = {}) {
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
    overrides.schemaVersion ?? 1,
    configJson,
    overrides.configFingerprint ?? VALID_FINGERPRINT,
    overrides.targetCount ?? 0,
    UPDATED_AT,
  )
}

test("runtime settings default all optional features off", () => {
  assert.deepEqual(readRuntimeSettings({}), {
    analytics: null,
    analyticsEnabled: false,
    db: null,
    delivery: null,
    deliveryEnabled: false,
    enabled: false,
    statusEnabled: false,
    statusToken: null,
  })
})

test("runtime settings validate flags and required feature bindings", () => {
  assert.throws(
    () => readRuntimeSettings({ ENDPOINT_MONITOR_ENABLED: "yes" }),
    (error) => error.code === "invalid-runtime-flag",
  )
  assert.throws(
    () => readRuntimeSettings({
      CLOUDFLARE_ANALYTICS_ENABLED: "true",
    }),
    (error) => error.code === "cloudflare-account-id-unavailable",
  )
  assert.throws(
    () => readRuntimeSettings({
      CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
      CLOUDFLARE_ANALYTICS_ENABLED: "true",
    }),
    (error) => error.code === "cloudflare-api-token-unavailable",
  )
  assert.throws(
    () => readRuntimeSettings({
      ENDPOINT_MONITOR_DELIVERY_ENABLED: "true",
    }),
    (error) => error.code === "hookrelay-hmac-unavailable",
  )
  assert.throws(
    () => readRuntimeSettings({
      ENDPOINT_MONITOR_DELIVERY_ENABLED: "true",
      ENDPOINT_MONITOR_HOOKRELAY_HMAC: "secret",
    }),
    (error) => error.code === "hookrelay-url-unavailable",
  )
  assert.throws(
    () => readRuntimeSettings({
      ENDPOINT_MONITOR_STATUS_ENABLED: "true",
      MONITOR_DB: { batch() {}, prepare() {} },
    }),
    (error) => error.code === "status-token-unavailable",
  )
})

test("stored configuration rejects missing, invalid, and mismatched data", async (context) => {
  const empty = d1Fixture(context)
  await assert.rejects(
    loadStoredConfiguration(empty),
    (error) => error.code === "monitor-configuration-unavailable",
  )

  const invalid = d1Fixture(context)
  insertConfiguration(invalid, '{"schemaVersion":2,"targets":[]}')
  await assert.rejects(
    loadStoredConfiguration(invalid),
    (error) => error.code === "monitor-configuration-invalid",
  )

  const mismatched = d1Fixture(context)
  insertConfiguration(
    mismatched,
    '{"schemaVersion":1,"targets":[]}',
    { configFingerprint: "invalid" },
  )
  await assert.rejects(
    loadStoredConfiguration(mismatched),
    (error) => error.code === "monitor-configuration-metadata-invalid",
  )
})

test("stored configuration rejects invalid JSON from an untrusted binding", async () => {
  const db = {
    batch() {},
    prepare() {
      return {
        first: async () => ({
          config_fingerprint: VALID_FINGERPRINT,
          config_json: "not-json",
          schema_version: 1,
          target_count: 0,
          updated_at: UPDATED_AT,
        }),
      }
    },
  }
  await assert.rejects(
    loadStoredConfiguration(db),
    (error) => error.code === "monitor-configuration-invalid",
  )
})

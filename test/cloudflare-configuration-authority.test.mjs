import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import {
  configurationCandidate,
  CONFIGURATION_LIMITS,
  d1ConfigurationQuery,
  readConfigurationAuthority,
  reviewConfiguration,
  validateConfigurationExpectation,
  writeConfigurationAuthority,
} from "../src/adapters/cloudflare/configuration-authority.mjs"
import { d1Fixture } from "./d1.fixture.mjs"

const UPDATED_AT = "2026-09-06T00:00:00.000Z"
const CANDIDATE = Object.freeze({
  schemaVersion: 2,
  targets: [{ id: "example-health", url: "https://example.com/health" }],
})

test("configuration migration preserves existing target bytes and establishes a recoverable revision", async (context) => {
  const sqlite = new DatabaseSync(":memory:")
  context.after(() => sqlite.close())
  sqlite.exec(readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8"))
  const loaded = await configurationCandidate(CANDIDATE)
  sqlite.prepare(`INSERT INTO monitor_configuration
    VALUES (1,2,?,?,1,?)`).run(loaded.configJson, loaded.configFingerprint, UPDATED_AT)
  const before = sqlite.prepare("SELECT * FROM monitor_configuration").get()
  sqlite.exec(readFileSync(new URL("../migrations/0003_configuration_authority.sql", import.meta.url), "utf8"))
  const after = sqlite.prepare("SELECT * FROM monitor_configuration").get()
  for (const [key, value] of Object.entries(before)) assert.equal(after[key], value)
  assert.equal(after.revision, 1)
  assert.equal(after.updated_by, "legacy")
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM monitor_configuration_change").get().count, 1)
  assert.equal(sqlite.prepare("PRAGMA integrity_check").get().integrity_check, "ok")
})

async function save(query, candidate, expectedRevision, overrides = {}) {
  const loaded = await configurationCandidate(candidate)
  return writeConfigurationAuthority(query, candidate, {
    expectedFingerprint: loaded.configFingerprint,
    expectedRevision, updatedAt: UPDATED_AT, ...overrides,
  })
}

test("configuration review is bounded, read-only, and records exact candidate and revision", async (context) => {
  const db = d1Fixture(context)
  const query = d1ConfigurationQuery(db)
  const review = await reviewConfiguration(query, CANDIDATE)
  assert.equal(review.expectedRevision, 0)
  assert.equal(review.remoteFingerprint, null)
  assert.deepEqual(review.addedIds, ["example-health"])
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM monitor_configuration_change").get().count, 0)
  const initial = await save(query, CANDIDATE, review.expectedRevision)
  assert.equal(initial.revision, 1)
  assert.equal(initial.changed, true)
  assert.equal(initial.updatedBy, "operator-cli")
  const next = {
    schemaVersion: 2,
    defaults: { probeIntervalMinutes: 10 },
    targets: [
      { id: "example-health", url: "https://example.com/ready" },
      { id: "example-status", url: "https://example.com/status" },
    ],
  }
  const changes = await reviewConfiguration(query, next)
  assert.equal(changes.expectedRevision, 1)
  assert.deepEqual(changes.addedIds, ["example-status"])
  assert.deepEqual(changes.changedIds, ["example-health"])
  assert.deepEqual(changes.removedIds, [])
  assert.equal(changes.defaultsChanged, true)
  await save(query, next, 1, { updatedBy: "hq-actor", updatedWorkspace: "workspace-a" })
  const removed = await reviewConfiguration(query, { schemaVersion: 2, targets: [] })
  assert.deepEqual(removed.removedIds, ["example-health", "example-status"])
  const row = db.sqlite.prepare("SELECT * FROM monitor_configuration_change WHERE revision=2").get()
  assert.equal(row.updated_by, "hq-actor")
  assert.equal(row.updated_workspace, "workspace-a")
  assert.equal(JSON.stringify(row).includes("https://"), false)
})

test("unchanged configuration writes nothing and stale A-to-B-to-A reviews still conflict", async (context) => {
  const db = d1Fixture(context)
  const query = d1ConfigurationQuery(db)
  await save(query, CANDIDATE, 0)
  const before = db.sqlite.prepare("SELECT total_changes() AS count").get().count
  const noop = await save(query, CANDIDATE, 1)
  assert.equal(noop.changed, false)
  assert.equal(noop.rowsWritten, 0)
  assert.equal(db.sqlite.prepare("SELECT total_changes() AS count").get().count, before)
  await save(query, { schemaVersion: 2, targets: [] }, 1)
  await save(query, CANDIDATE, 2)
  await assert.rejects(save(query, CANDIDATE, 1), { code: "configuration-conflict" })
  assert.equal((await readConfigurationAuthority(query)).revision, 3)
})

test("concurrent initializations and updates accept only one reviewed writer", async (context) => {
  const db = d1Fixture(context)
  const query = d1ConfigurationQuery(db)
  for (const revision of [0, 1]) {
    const candidate = revision ? { schemaVersion: 2, targets: [] } : CANDIDATE
    const outcomes = await Promise.allSettled([save(query, candidate, revision), save(query, candidate, revision)])
    assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1)
    const rejected = outcomes.find((result) => result.status === "rejected")
    assert.equal(rejected.reason.code, "configuration-conflict")
  }
  assert.equal((await readConfigurationAuthority(query)).revision, 2)
})

test("legacy upserts, direct updates, replacement, deletion, and revision reuse fail closed", async (context) => {
  const db = d1Fixture(context)
  const query = d1ConfigurationQuery(db)
  await save(query, CANDIDATE, 0)
  const legacy = `INSERT INTO monitor_configuration (singleton_id, schema_version, config_json,
    config_fingerprint, target_count, updated_at) VALUES (1,2,'{}','legacy',0,'legacy')
    ON CONFLICT(singleton_id) DO UPDATE SET config_json=excluded.config_json`
  for (const sql of [
    legacy,
    "UPDATE monitor_configuration SET config_json='{}'",
    "UPDATE monitor_configuration SET revision=revision+2",
    "INSERT OR REPLACE INTO monitor_configuration SELECT * FROM monitor_configuration",
    "DELETE FROM monitor_configuration",
  ]) assert.throws(() => db.sqlite.exec(sql), /configuration-(revision-required|deletion-forbidden)/)
  assert.equal((await readConfigurationAuthority(query)).revision, 1)
})

test("configuration audit failure rolls back the candidate and revision", async (context) => {
  const db = d1Fixture(context)
  const query = d1ConfigurationQuery(db)
  await save(query, CANDIDATE, 0)
  db.sqlite.exec(`CREATE TRIGGER reject_audit BEFORE INSERT ON monitor_configuration_change
    BEGIN SELECT RAISE(ABORT, 'test audit failure'); END`)
  await assert.rejects(save(query, { schemaVersion: 2, targets: [] }, 1), /test audit failure/)
  const remote = await readConfigurationAuthority(query)
  assert.equal(remote.revision, 1)
  assert.equal(remote.targetCount, 1)
})

test("a lost accepted-write response is recovered by inspection, not an unconditional repeat", async (context) => {
  const db = d1Fixture(context)
  const query = d1ConfigurationQuery(db)
  const lostResponse = async (statement) => {
    const result = await query(statement)
    if (/^INSERT/.test(statement.sql)) throw new Error("synthetic transport interruption")
    return result
  }
  await assert.rejects(save(lostResponse, CANDIDATE, 0), /synthetic transport interruption/)
  const remote = await readConfigurationAuthority(query)
  assert.equal(remote.revision, 1)
  assert.equal(remote.configFingerprint, (await configurationCandidate(CANDIDATE)).configFingerprint)
  await assert.rejects(save(query, CANDIDATE, 0), { code: "configuration-conflict" })
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM monitor_configuration_change").get().count, 1)
})

test("configuration audit retention is bounded and never contains target documents", async (context) => {
  const db = d1Fixture(context)
  const query = d1ConfigurationQuery(db)
  for (let revision = 0; revision < CONFIGURATION_LIMITS.historyRevisions + 2; revision += 1) {
    await save(query, revision % 2 ? { schemaVersion: 2, targets: [] } : CANDIDATE, revision)
  }
  const rows = db.sqlite.prepare("SELECT * FROM monitor_configuration_change ORDER BY revision").all()
  assert.equal(rows.length, CONFIGURATION_LIMITS.historyRevisions)
  assert.equal(rows[0].revision, 3)
  assert.equal(JSON.stringify(rows).includes("example.com"), false)
})

test("review expectations and writer identity are validated before database access", async () => {
  const query = () => assert.fail("No database access allowed")
  const fingerprint = (await configurationCandidate(CANDIDATE)).configFingerprint
  for (const revision of [null, -1, 1.5, "1", Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => validateConfigurationExpectation(revision, fingerprint), { code: "configuration-revision-invalid" })
  }
  assert.throws(() => validateConfigurationExpectation(1, "bad"), { code: "configuration-fingerprint-invalid" })
  await assert.rejects(save(query, CANDIDATE, 0, { expectedFingerprint: `sha256:${"a".repeat(64)}` }), { code: "configuration-candidate-changed" })
  for (const overrides of [{ updatedAt: "invalid" }, { updatedBy: "bad\nactor" }, { updatedWorkspace: "" }]) {
    await assert.rejects(save(query, CANDIDATE, 0, overrides), { code: "configuration-writer-invalid" })
  }
})

test("Cloudflare configuration validation enforces schedule and byte capacity", async () => {
  await assert.rejects(configurationCandidate({
    schemaVersion: 2,
    defaults: { probeIntervalMinutes: 1 },
    targets: Array.from({ length: 11 }, (_, index) => ({ id: `target-${index}`, url: `https://example.com/${index}` })),
  }), /maximum/)
  await assert.rejects(configurationCandidate({
    schemaVersion: 2,
    defaults: { probeIntervalMinutes: 60 },
    targets: Array.from({ length: 500 }, (_, index) => ({
      id: `target-${index}`, url: `https://example.com/${index}`,
      expect: { bodyIncludes: "x".repeat(1000) },
    })),
  }), { code: "configuration-too-large" })
})

test("malformed database results and unverified write receipts fail explicitly", async () => {
  await assert.rejects(readConfigurationAuthority(async () => [{}]), { code: "configuration-response-invalid" })
  await assert.rejects(readConfigurationAuthority(async () => [{ results: [{ config_json: "{}" }] }]), { code: "configuration-stored-invalid" })
  let calls = 0
  const query = async () => [{ results: ++calls === 1 ? [] : [{ revision: 3 }] }]
  await assert.rejects(save(query, CANDIDATE, 0), { code: "configuration-outcome-unknown" })
})

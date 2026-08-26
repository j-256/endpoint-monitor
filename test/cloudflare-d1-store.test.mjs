import assert from "node:assert/strict"
import test from "node:test"

import {
  enqueueUndeliveredOpenIncidents,
  markOutboxDelivered,
  markOutboxFailed,
  pruneMonitorStorage,
  readDueOutbox,
  readMonitorStatus,
  readStoredConfiguration,
  readTargetStates,
  reconcileTargetConfiguration,
  recordAnalyticsFailure,
  recordObservation,
} from "../src/adapters/cloudflare/d1-store.mjs"
import {
  analyticsObservation,
  httpObservation,
  networkObservation,
} from "../src/core.mjs"
import { RESOLUTION_REASON } from "../src/constants.mjs"
import { d1Fixture } from "./d1.fixture.mjs"

const STARTED_AT = "2026-08-26T03:00:00.000Z"

function target(overrides = {}) {
  return {
    configFingerprint: "sha256:example-home",
    expectedStatuses: null,
    failureThreshold: 2,
    id: "example-home",
    method: "GET",
    recoveryThreshold: 2,
    timeoutMilliseconds: 10000,
    url: "https://example.com/",
    ...overrides,
  }
}

function totalChanges(db) {
  return Number(db.sqlite.prepare("SELECT total_changes() AS count").get().count)
}

test("ordinary healthy probes perform no D1 writes", async (context) => {
  const db = d1Fixture(context)
  const before = totalChanges(db)
  const recorded = await recordObservation(
    db,
    target(),
    httpObservation(target(), 200, STARTED_AT),
    { incidentId: "unused", recordedAt: STARTED_AT },
  )
  assert.equal(recorded.changed, false)
  assert.equal(recorded.writes, 0)
  assert.equal(totalChanges(db), before)
  assert.deepEqual(await readTargetStates(db), [])
})

test("stored configuration is a read-only runtime input", async (context) => {
  const db = d1Fixture(context)
  assert.equal(await readStoredConfiguration(db), null)
  db.sqlite.prepare(`
    INSERT INTO monitor_configuration (
      singleton_id,
      schema_version,
      config_json,
      config_fingerprint,
      target_count,
      updated_at
    ) VALUES (1, ?, ?, ?, ?, ?)
  `).run(1, '{"schemaVersion":1,"targets":[]}', "sha256:config", 0, STARTED_AT)
  assert.deepEqual(await readStoredConfiguration(db), {
    configFingerprint: "sha256:config",
    configJson: '{"schemaVersion":1,"targets":[]}',
    schemaVersion: 1,
    targetCount: 0,
    updatedAt: STARTED_AT,
  })
})

test("failure candidates exist only while exceptional", async (context) => {
  const db = d1Fixture(context)
  const configured = target()
  const failed = await recordObservation(
    db,
    configured,
    networkObservation("timeout", STARTED_AT),
    { incidentId: "unused", recordedAt: STARTED_AT },
  )
  assert.equal(failed.writes, 1)
  assert.equal((await readTargetStates(db))[0].consecutiveFailures, 1)
  const recovered = await recordObservation(
    db,
    configured,
    httpObservation(configured, 200, "2026-08-26T03:05:00.000Z"),
    {
      currentState: failed.state,
      incidentId: "unused",
      recordedAt: "2026-08-26T03:05:00.000Z",
    },
  )
  assert.equal(recovered.writes, 1)
  assert.deepEqual(await readTargetStates(db), [])
})

test("incidents and delivery events persist only on transitions", async (context) => {
  const db = d1Fixture(context)
  const configured = target()
  const opened = await recordObservation(
    db,
    configured,
    httpObservation(configured, 526, STARTED_AT),
    { incidentId: "incident-one", recordedAt: STARTED_AT },
  )
  assert.equal(opened.transition.kind, "opened")
  assert.equal(opened.writes, 3)
  assert.equal((await readDueOutbox(db, STARTED_AT, 10)).length, 1)
  const before = totalChanges(db)
  const repeated = await recordObservation(
    db,
    configured,
    httpObservation(configured, 526, "2026-08-26T03:05:00.000Z"),
    {
      currentState: opened.state,
      incidentId: "unused",
      recordedAt: "2026-08-26T03:05:00.000Z",
    },
  )
  assert.equal(repeated.writes, 0)
  assert.equal(totalChanges(db), before)
  const recovering = await recordObservation(
    db,
    configured,
    httpObservation(configured, 200, "2026-08-26T03:10:00.000Z"),
    {
      currentState: opened.state,
      incidentId: "unused",
      recordedAt: "2026-08-26T03:10:00.000Z",
    },
  )
  const resolved = await recordObservation(
    db,
    configured,
    httpObservation(configured, 200, "2026-08-26T03:15:00.000Z"),
    {
      currentState: recovering.state,
      incidentId: "unused",
      recordedAt: "2026-08-26T03:15:00.000Z",
    },
  )
  assert.equal(resolved.transition.kind, "resolved")
  assert.equal(resolved.writes, 3)
  assert.deepEqual(await readTargetStates(db), [])
  const status = await readMonitorStatus(db)
  assert.equal(status.openIncidents.length, 0)
  assert.equal(status.recentIncidents[0].resolutionReason, "recovered")
  assert.equal(status.pendingDeliveries, 2)
})

test("shadow mode records incidents without creating delivery rows", async (context) => {
  const db = d1Fixture(context)
  const configured = target()
  const opened = await recordObservation(
    db,
    configured,
    httpObservation(configured, 526, STARTED_AT),
    {
      enqueueEvents: false,
      incidentId: "incident-shadow",
      recordedAt: STARTED_AT,
    },
  )
  assert.equal(opened.writes, 2)
  assert.equal((await readMonitorStatus(db)).pendingDeliveries, 0)
  const bridged = await enqueueUndeliveredOpenIncidents(
    db,
    "2026-08-26T03:05:00.000Z",
  )
  assert.equal(bridged.writes, 1)
  assert.equal(bridged.incidents[0].id, "incident-shadow")
  assert.equal((await readMonitorStatus(db)).pendingDeliveries, 1)
  assert.deepEqual(
    await enqueueUndeliveredOpenIncidents(
      db,
      "2026-08-26T03:06:00.000Z",
    ),
    { incidents: [], writes: 0 },
  )
})

test("analytics signals are deduplicated after incident recovery", async (context) => {
  const db = d1Fixture(context)
  const configured = target()
  const observation = analyticsObservation(526, STARTED_AT, 4)
  const signal = {
    fingerprint: "sha256:signal-one",
    provider: "cloudflare",
  }
  const opened = await recordAnalyticsFailure(
    db,
    configured,
    observation,
    signal,
    { incidentId: "incident-analytics", recordedAt: STARTED_AT },
  )
  assert.equal(opened.writes, 4)
  const recovering = await recordObservation(
    db,
    configured,
    httpObservation(configured, 200, "2026-08-26T03:05:00.000Z"),
    {
      currentState: opened.state,
      incidentId: "unused",
      recordedAt: "2026-08-26T03:05:00.000Z",
    },
  )
  await recordObservation(
    db,
    configured,
    httpObservation(configured, 200, "2026-08-26T03:10:00.000Z"),
    {
      currentState: recovering.state,
      incidentId: "unused",
      recordedAt: "2026-08-26T03:10:00.000Z",
    },
  )
  const duplicate = await recordAnalyticsFailure(
    db,
    configured,
    observation,
    signal,
    {
      currentState: null,
      incidentId: "must-not-open",
      recordedAt: "2026-08-26T03:11:00.000Z",
    },
  )
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.writes, 0)
  assert.deepEqual(await readTargetStates(db), [])
})

test("configuration removal suppresses incidents without recovery events", async (context) => {
  const db = d1Fixture(context)
  const configured = target()
  await recordObservation(
    db,
    configured,
    httpObservation(configured, 526, STARTED_AT),
    { incidentId: "incident-removed", recordedAt: STARTED_AT },
  )
  const reconciled = await reconcileTargetConfiguration(
    db,
    [],
    "2026-08-26T03:05:00.000Z",
  )
  assert.equal(reconciled.suppressed.length, 1)
  assert.equal(
    reconciled.suppressed[0].resolutionReason,
    RESOLUTION_REASON.CONFIGURATION_REMOVED,
  )
  assert.deepEqual(await readTargetStates(db), [])
  assert.equal((await readMonitorStatus(db)).pendingDeliveries, 1)
})

test("outbox delivery, retry, and pruning retain bounded state", async (context) => {
  const db = d1Fixture(context)
  const configured = target()
  await recordObservation(
    db,
    configured,
    httpObservation(configured, 526, STARTED_AT),
    { incidentId: "incident-delivery", recordedAt: STARTED_AT },
  )
  const [row] = await readDueOutbox(db, STARTED_AT, 10)
  assert.equal(await markOutboxFailed(
    db,
    row.id,
    STARTED_AT,
    "http-503",
    "2026-08-26T03:01:00.000Z",
  ), 1)
  assert.equal((await readDueOutbox(db, STARTED_AT, 10)).length, 0)
  assert.equal(await markOutboxDelivered(
    db,
    row.id,
    "2026-08-26T03:01:00.000Z",
  ), 1)
  const pruned = await pruneMonitorStorage(
    db,
    "2026-08-26T03:30:00.000Z",
    "2026-08-26T03:30:00.000Z",
    "2026-08-26T03:30:00.000Z",
  )
  assert.deepEqual(pruned, { incidents: 0, outbox: 1, signals: 0 })
})

import assert from "node:assert/strict"
import test from "node:test"

import {
  enqueueUndeliveredOpenIncidents,
  markOutboxDelivered,
  readDueOutbox,
  readMonitorStatus,
  recordObservation,
} from "../src/adapters/cloudflare/d1-store.mjs"
import { runCli } from "../src/cli.mjs"
import { httpObservation } from "../src/core.mjs"
import { d1Fixture } from "./d1.fixture.mjs"

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef"
const DATABASE_ID = "01234567-89ab-cdef-0123-456789abcdef"
const PROFILE_PATH = "/private/endpoint-monitor.local.json"
const WRANGLER_PATH = "/private/wrangler.jsonc"
const OPENED_AT = "2026-08-27T03:00:00.000Z"
const PROFILE = JSON.stringify({
  configPath: "/private/targets.json",
  schemaVersion: 1,
  wranglerPath: WRANGLER_PATH,
})
const WRANGLER = JSON.stringify({
  d1_databases: [{
    binding: "MONITOR_DB",
    database_id: DATABASE_ID,
    database_name: "endpoint-monitor",
  }],
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

function remoteD1Fetch(db, requests = []) {
  return async (url, init) => {
    requests.push({ body: JSON.parse(init.body), url: String(url) })
    const body = JSON.parse(init.body)
    const queries = Array.isArray(body.batch) ? body.batch : [body]
    try {
      const result = await db.batch(queries.map((query) => (
        db.prepare(query.sql).bind(...(query.params || []))
      )))
      return Response.json({ result, success: true })
    } catch {
      return Response.json({ errors: [{ message: "private SQL detail" }] }, {
        status: 400,
      })
    }
  }
}

function target() {
  return {
    configFingerprint: "sha256:target",
    expect: null,
    expectedStatuses: null,
    failureThreshold: 2,
    id: "example-home",
    method: "GET",
    recoveryThreshold: 2,
    timeoutMilliseconds: 10000,
    url: "https://example.com/",
  }
}

async function openIncident(db, configured, incidentId = "incident-one") {
  const first = await recordObservation(
    db,
    configured,
    httpObservation(configured, 500, OPENED_AT),
    { incidentId: "unused", recordedAt: OPENED_AT },
  )
  return recordObservation(
    db,
    configured,
    httpObservation(configured, 500, "2026-08-27T03:01:00.000Z"),
    {
      currentState: first.state,
      incidentId,
      recordedAt: "2026-08-27T03:01:00.000Z",
    },
  )
}

function commandRunner(db) {
  let now = Date.parse("2026-08-27T03:02:00.000Z")
  let sequence = 0
  const requests = []
  return {
    requests,
    run: async (argv, overrides = {}) => {
      const stdout = streamFixture()
      const stderr = streamFixture()
      const status = await runCli(argv, {
        clock: () => now,
        environment: {
          CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
          CLOUDFLARE_API_TOKEN: "api-token",
        },
        fetchImpl: remoteD1Fetch(db, requests),
        lstatImpl: async () => ({
          isFile: () => true,
          isSymbolicLink: () => false,
          mode: 0o100600,
        }),
        randomUUID: () => `action-${++sequence}`,
        readFileImpl: async (filename) => filename === PROFILE_PATH
          ? PROFILE
          : WRANGLER,
        stderr,
        stdout,
        ...overrides,
      })
      return {
        stderr: stderr.read(),
        status,
        stdout: stdout.read(),
      }
    },
    setNow: (value) => {
      now = Date.parse(value)
    },
  }
}

test("incident CLI lists, shows, acknowledges, snoozes, and dismisses", async (context) => {
  const db = d1Fixture(context)
  const configured = target()
  await openIncident(db, configured)
  const commands = commandRunner(db)

  const listed = await commands.run([
    "incidents",
    "list",
    "-jp",
    PROFILE_PATH,
  ])
  assert.equal(listed.status, 0)
  const listedBody = JSON.parse(listed.stdout)
  assert.equal(listedBody.incidents.length, 1)
  assert.equal(listedBody.incidents[0].id, "incident-one")
  assert.equal("targetUrl" in listedBody.incidents[0], false)

  const shown = await commands.run([
    "incidents",
    "show",
    "incident-one",
    "-p",
    PROFILE_PATH,
  ])
  assert.equal(shown.status, 0)
  assert.match(shown.stdout, /ID\tincident-one/)
  assert.match(shown.stdout, /0 action\(s\)/)

  const acknowledged = await commands.run([
    "incidents",
    "acknowledge",
    "incident-one",
    "-jnReviewed",
    "-p",
    PROFILE_PATH,
  ])
  assert.equal(acknowledged.status, 0)
  const acknowledgedBody = JSON.parse(acknowledged.stdout)
  assert.equal(acknowledgedBody.action, "acknowledged")
  assert.equal(acknowledgedBody.incident.actions[0].note, "Reviewed")
  assert.equal(
    acknowledgedBody.incident.acknowledgedAt,
    "2026-08-27T03:02:00.000Z",
  )

  const snoozedUntil = "2026-08-27T04:00:00.000Z"
  const snoozed = await commands.run([
    "incidents",
    "snooze",
    "incident-one",
    `--until=${snoozedUntil}`,
    "--note=Maintenance window",
    "-jp",
    PROFILE_PATH,
  ])
  assert.equal(snoozed.status, 0)
  const snoozedBody = JSON.parse(snoozed.stdout)
  assert.equal(snoozedBody.action, "snoozed")
  assert.equal(snoozedBody.incident.snoozedUntil, snoozedUntil)
  assert.equal(
    db.sqlite.prepare(`
      SELECT next_attempt_at
      FROM monitor_outbox
      WHERE incident_id = 'incident-one' AND transition = 'opened'
    `).get().next_attempt_at,
    snoozedUntil,
  )

  const dismissed = await commands.run([
    "incidents",
    "dismiss",
    "incident-one",
    "-nFalse positive",
    "-jp",
    PROFILE_PATH,
  ])
  assert.equal(dismissed.status, 0)
  const dismissedBody = JSON.parse(dismissed.stdout)
  assert.equal(dismissedBody.action, "dismissed")
  assert.equal(dismissedBody.incident.status, "resolved")
  assert.equal(
    dismissedBody.incident.resolutionReason,
    "operator-dismissed",
  )
  assert.equal(dismissedBody.incident.actions.length, 3)

  const status = await readMonitorStatus(db)
  assert.equal(status.openIncidents.length, 0)
  assert.equal(status.recentIncidents[0].resolutionReason, "operator-dismissed")
  assert.equal(status.recentIncidents[0].acknowledgedAt, "2026-08-27T03:02:00.000Z")
  assert.equal(status.recentIncidents[0].snoozedUntil, snoozedUntil)
  assert.deepEqual(status.states, [])

  assert.deepEqual(
    await readDueOutbox(db, "2026-08-27T03:59:59.000Z", 10),
    [],
  )
  const [opened] = await readDueOutbox(db, snoozedUntil, 10)
  assert.equal(opened.id, "incident-one/opened")
  await markOutboxDelivered(db, opened.id, snoozedUntil)
  const [resolved] = await readDueOutbox(db, snoozedUntil, 10)
  assert.equal(resolved.id, "incident-one/resolved")
  const resolvedEvent = JSON.parse(resolved.body)
  assert.equal(resolvedEvent.data.resolutionReason, "operator-dismissed")
  assert.equal(resolvedEvent.data.state, "recovered")

  const openList = await commands.run([
    "incidents",
    "list",
    "-jp",
    PROFILE_PATH,
  ])
  assert.deepEqual(JSON.parse(openList.stdout).incidents, [])
  const history = await commands.run([
    "incidents",
    "list",
    "-ajp",
    PROFILE_PATH,
  ])
  assert.equal(JSON.parse(history.stdout).incidents[0].status, "resolved")

  const stale = await commands.run([
    "incidents",
    "acknowledge",
    "incident-one",
    "-p",
    PROFILE_PATH,
  ])
  assert.equal(stale.status, 1)
  assert.match(stale.stderr, /Incident is not open/)
})

test("dismissed persistent failures start a new threshold and can reopen", async (context) => {
  const db = d1Fixture(context)
  const configured = target()
  await openIncident(db, configured)
  const commands = commandRunner(db)
  assert.equal((await commands.run([
    "incidents",
    "dismiss",
    "incident-one",
    "-p",
    PROFILE_PATH,
  ])).status, 0)

  const candidate = await recordObservation(
    db,
    configured,
    httpObservation(configured, 500, "2026-08-27T03:05:00.000Z"),
    { incidentId: "unused", recordedAt: "2026-08-27T03:05:00.000Z" },
  )
  assert.equal(candidate.transition, null)
  const reopened = await recordObservation(
    db,
    configured,
    httpObservation(configured, 500, "2026-08-27T03:06:00.000Z"),
    {
      currentState: candidate.state,
      incidentId: "incident-two",
      recordedAt: "2026-08-27T03:06:00.000Z",
    },
  )
  assert.equal(reopened.transition.incidentId, "incident-two")
})

test("snooze deadlines survive shadow-to-delivery bridging", async (context) => {
  const db = d1Fixture(context)
  const configured = target()
  const first = await recordObservation(
    db,
    configured,
    httpObservation(configured, 500, OPENED_AT),
    {
      enqueueEvents: false,
      incidentId: "unused",
      recordedAt: OPENED_AT,
    },
  )
  await recordObservation(
    db,
    configured,
    httpObservation(configured, 500, "2026-08-27T03:01:00.000Z"),
    {
      currentState: first.state,
      enqueueEvents: false,
      incidentId: "incident-shadow",
      recordedAt: "2026-08-27T03:01:00.000Z",
    },
  )
  const commands = commandRunner(db)
  const until = "2026-08-27T04:00:00.000Z"
  assert.equal((await commands.run([
    "incidents",
    "snooze",
    "incident-shadow",
    "-u",
    until,
    "-p",
    PROFILE_PATH,
  ])).status, 0)
  assert.equal((await enqueueUndeliveredOpenIncidents(
    db,
    "2026-08-27T03:03:00.000Z",
  )).writes, 1)
  assert.deepEqual(
    await readDueOutbox(db, "2026-08-27T03:59:59.000Z", 10),
    [],
  )
  assert.equal((await readDueOutbox(db, until, 10))[0].id, "incident-shadow/opened")
})

test("incident CLI validates options and fixes provider diagnostics", async (context) => {
  const db = d1Fixture(context)
  await openIncident(db, target())
  const commands = commandRunner(db)
  const invalidCases = [
    ["incidents"],
    ["incidents", "missing"],
    ["incidents", "show"],
    ["incidents", "show", "INVALID"],
    ["incidents", "list", "--limit=0"],
    ["incidents", "show", "incident-one", "--all"],
    ["incidents", "snooze", "incident-one"],
    ["incidents", "acknowledge", "incident-one", "--until", "2027-01-01T00:00:00Z"],
  ]
  for (const argv of invalidCases) {
    const result = await commands.run(argv)
    assert.equal(result.status, 2, argv.join(" "))
    assert.match(result.stderr, /^endpoint-monitor:/)
    assert.equal(result.stdout, "")
  }

  const controlNote = await commands.run([
    "incidents",
    "acknowledge",
    "incident-one",
    "--note",
    "line\nbreak",
    "-p",
    PROFILE_PATH,
  ])
  assert.equal(controlNote.status, 2)
  assert.match(controlNote.stderr, /control characters/)

  const missingAccount = await commands.run([
    "incidents",
    "list",
    "-p",
    PROFILE_PATH,
  ], { environment: {} })
  assert.equal(missingAccount.status, 2)
  assert.match(missingAccount.stderr, /CLOUDFLARE_ACCOUNT_ID/)

  const missingToken = await commands.run([
    "incidents",
    "list",
    "-p",
    PROFILE_PATH,
  ], { environment: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID } })
  assert.equal(missingToken.status, 2)
  assert.match(missingToken.stderr, /CLOUDFLARE_API_TOKEN/)

  const unavailable = await commands.run([
    "incidents",
    "list",
    "-p",
    PROFILE_PATH,
  ], {
    fetchImpl: async () => Response.json({
      errors: [{ message: "private provider detail" }],
    }, { status: 403 }),
  })
  assert.equal(unavailable.status, 1)
  assert.equal(
    unavailable.stderr,
    "endpoint-monitor: Cloudflare D1 incident request failed\n",
  )
  assert.equal(unavailable.stderr.includes("private provider detail"), false)
})

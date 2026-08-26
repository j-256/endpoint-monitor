import assert from "node:assert/strict"
import test from "node:test"

import {
  analyticsObservation,
  createIncident,
  createIncidentCloudEvent,
  httpObservation,
  networkObservation,
  reduceTargetState,
  resolveIncident,
  suppressIncident,
} from "../src/core.mjs"
import {
  EVENT_TYPE,
  OBSERVATION_OUTCOME,
  RESOLUTION_REASON,
  TRANSITION,
} from "../src/constants.mjs"

const OBSERVED_AT = "2026-08-26T03:00:00.000Z"
const RECOVERED_AT = "2026-08-26T03:10:00.000Z"

function target(overrides = {}) {
  return {
    configFingerprint: "sha256:target",
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

test("default reachability accepts client responses and rejects server responses", () => {
  assert.equal(
    httpObservation(target(), 404, OBSERVED_AT).outcome,
    OBSERVATION_OUTCOME.SUCCESS,
  )
  const failure = httpObservation(target(), 500, OBSERVED_AT)
  assert.equal(failure.outcome, OBSERVATION_OUTCOME.FAILURE)
  assert.equal(failure.immediate, false)
})

test("exact expected statuses enable application-aware checks", () => {
  const configured = target({ expectedStatuses: [200, 204] })
  assert.equal(
    httpObservation(configured, 204, OBSERVED_AT).outcome,
    OBSERVATION_OUTCOME.SUCCESS,
  )
  assert.equal(
    httpObservation(configured, 302, OBSERVED_AT).outcome,
    OBSERVATION_OUTCOME.FAILURE,
  )
})

test("an HTTP 526 opens an incident immediately", () => {
  const configured = target()
  const observation = httpObservation(configured, 526, OBSERVED_AT)
  const reduced = reduceTargetState(null, configured, observation, "incident-one")
  assert.equal(reduced.transition.kind, TRANSITION.OPENED)
  assert.equal(reduced.state.activeIncidentId, "incident-one")
  assert.equal(reduced.state.consecutiveFailures, 1)
})

test("ordinary failures require the configured threshold", () => {
  const configured = target()
  const failure = httpObservation(configured, 500, OBSERVED_AT)
  const first = reduceTargetState(null, configured, failure, "unused")
  assert.equal(first.transition, null)
  assert.equal(first.state.consecutiveFailures, 1)
  const second = reduceTargetState(
    first.state,
    configured,
    httpObservation(configured, 500, "2026-08-26T03:05:00.000Z"),
    "incident-two",
  )
  assert.equal(second.transition.kind, TRANSITION.OPENED)
  assert.equal(second.state.activeIncidentId, "incident-two")
})

test("repeated failure for an open incident performs no state change", () => {
  const configured = target()
  const opened = reduceTargetState(
    null,
    configured,
    httpObservation(configured, 526, OBSERVED_AT),
    "incident-three",
  )
  const repeated = reduceTargetState(
    opened.state,
    configured,
    httpObservation(configured, 526, "2026-08-26T03:05:00.000Z"),
    "unused",
  )
  assert.equal(repeated.changed, false)
  assert.equal(repeated.state, opened.state)
})

test("a healthy probe clears a failure candidate without retaining state", () => {
  const configured = target()
  const candidate = reduceTargetState(
    null,
    configured,
    networkObservation("timeout", OBSERVED_AT),
  )
  const healthy = reduceTargetState(
    candidate.state,
    configured,
    httpObservation(configured, 200, "2026-08-26T03:05:00.000Z"),
  )
  assert.equal(healthy.changed, true)
  assert.equal(healthy.state, null)
  assert.equal(healthy.transition, null)
})

test("two healthy probes resolve an open incident and remove state", () => {
  const configured = target()
  const opened = reduceTargetState(
    null,
    configured,
    httpObservation(configured, 526, OBSERVED_AT),
    "incident-four",
  )
  const first = reduceTargetState(
    opened.state,
    configured,
    httpObservation(configured, 200, "2026-08-26T03:05:00.000Z"),
  )
  assert.equal(first.state.consecutiveSuccesses, 1)
  const second = reduceTargetState(
    first.state,
    configured,
    httpObservation(configured, 200, RECOVERED_AT),
  )
  assert.equal(second.state, null)
  assert.deepEqual(second.transition, {
    incidentId: "incident-four",
    kind: TRANSITION.RESOLVED,
  })
})

test("analytics observations are immediate and validate request counts", () => {
  const observation = analyticsObservation(526, OBSERVED_AT, 7)
  assert.equal(observation.immediate, true)
  assert.equal(observation.requestCount, 7)
  assert.throws(() => analyticsObservation(500, OBSERVED_AT, 1))
  assert.throws(() => analyticsObservation(526, OBSERVED_AT, 0))
})

test("incidents resolve and suppress with durable reasons", () => {
  const configured = target()
  const observation = networkObservation("network", OBSERVED_AT)
  const incident = createIncident(configured, observation, "incident-five", OBSERVED_AT)
  const resolved = resolveIncident(incident, RECOVERED_AT)
  assert.equal(resolved.resolutionReason, RESOLUTION_REASON.RECOVERED)
  const suppressed = suppressIncident(
    incident,
    RECOVERED_AT,
    RESOLUTION_REASON.CONFIGURATION_REMOVED,
  )
  assert.equal(suppressed.resolutionReason, RESOLUTION_REASON.CONFIGURATION_REMOVED)
})

test("incident events use provider-neutral identity and exact target URLs", () => {
  const configured = target()
  const observation = httpObservation(configured, 526, OBSERVED_AT)
  const incident = createIncident(configured, observation, "incident-six", OBSERVED_AT)
  const opened = createIncidentCloudEvent(incident, TRANSITION.OPENED)
  assert.equal(opened.type, EVENT_TYPE.PROBLEM)
  assert.equal(opened.source, "urn:endpoint-monitor")
  assert.equal(opened.subject, configured.id)
  assert.equal(opened.url, configured.url)
  assert.equal(opened.data.targetUrl, configured.url)
  const recovered = createIncidentCloudEvent(
    resolveIncident(incident, RECOVERED_AT),
    TRANSITION.RESOLVED,
  )
  assert.equal(recovered.type, EVENT_TYPE.RECOVERED)
  assert.equal(recovered.time, RECOVERED_AT)
})

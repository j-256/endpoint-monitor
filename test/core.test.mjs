import assert from "node:assert/strict"
import test from "node:test"

import {
  analyticsObservation,
  createIncident,
  createIncidentCloudEvent,
  dismissIncident,
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
    expect: null,
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

test("response validation failures retain status and fixed error identity", () => {
  const configured = target({ expectedStatuses: [200] })
  const observation = httpObservation(
    configured,
    200,
    OBSERVED_AT,
    "json-subset-mismatch",
  )
  assert.equal(observation.outcome, OBSERVATION_OUTCOME.FAILURE)
  assert.equal(observation.httpStatus, 200)
  assert.equal(observation.errorCode, "json-subset-mismatch")
  assert.equal(observation.immediate, false)
  const incident = createIncident(
    configured,
    observation,
    "incident-validation",
    OBSERVED_AT,
  )
  assert.match(
    createIncidentCloudEvent(incident, TRANSITION.OPENED).title,
    /HTTP 200 \(json-subset-mismatch\)/,
  )
  assert.throws(() => httpObservation(
    configured,
    200,
    OBSERVED_AT,
    "Invalid_Code",
  ))
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
  const dismissed = dismissIncident(incident, RECOVERED_AT)
  assert.equal(dismissed.resolutionReason, RESOLUTION_REASON.OPERATOR_DISMISSED)
  const event = createIncidentCloudEvent(dismissed, TRANSITION.RESOLVED)
  assert.equal(event.data.state, "recovered")
  assert.equal(event.data.resolutionReason, RESOLUTION_REASON.OPERATOR_DISMISSED)
  assert.match(event.title, /incident dismissed/)
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

test("incident summaries explain validation failures without changing event data", () => {
  const explanations = {
    "body-marker-missing": "the configured body marker was not found within the inspected response body",
    "response-body-too-large": "the response exceeded the body validation limit",
    "response-body-unreadable": "the response body could not be read",
    "content-type-mismatch": "the response media type did not match the configured expectation",
    "response-json-invalid": "the response body was not valid JSON",
    "json-subset-mismatch": "the JSON response did not match the configured subset",
    "location-invalid": "the redirect location was invalid",
    "location-mismatch": "the redirect location did not match the configured expectation",
    "location-missing": "the response was missing the expected redirect location",
    "future-validation-error": "the response did not satisfy the configured check (future-validation-error)",
    "constructor": "the response did not satisfy the configured check (constructor)",
  }
  for (const [code, explanation] of Object.entries(explanations)) {
    const incident = createIncident(
      target(), httpObservation(target(), 200, OBSERVED_AT, code), "incident-summary", OBSERVED_AT,
    )
    const event = createIncidentCloudEvent(incident, TRANSITION.OPENED)
    assert.ok(event.summary.startsWith(`The endpoint returned HTTP 200, but ${explanation}.\n\n`))
    assert.ok(event.summary.includes("State: Problem\nFailure threshold: 2\nRecovery threshold: 2"))
    assert.ok(event.summary.includes(`First observed: ${OBSERVED_AT}`))
    assert.ok(event.summary.includes(`Opened: ${OBSERVED_AT}`))
    assert.ok(event.summary.includes("Failure signal: Active probe"))
    assert.ok(event.summary.endsWith("Target: https://example.com/"))
    assert.equal(event.data.errorCode, code)
    assert.equal(event.data.latestStatus, 200)
    assert.equal(event.data.targetUrl, target().url)
  }
})

test("incident summaries distinguish status failures, timeouts, and network failures", () => {
  const cases = [
    [httpObservation(target(), 503, OBSERVED_AT), "The endpoint returned HTTP 503, which did not satisfy the configured status check."],
    [networkObservation("timeout", OBSERVED_AT), "The endpoint did not respond before the configured timeout."],
    [networkObservation("network", OBSERVED_AT), "The request failed before an HTTP response was received."],
    [networkObservation("future-network-error", OBSERVED_AT), "The request failed before an HTTP response was received (future-network-error)."],
  ]
  for (const [observation, explanation] of cases) {
    const incident = createIncident(target(), observation, "incident-summary", OBSERVED_AT)
    assert.ok(createIncidentCloudEvent(incident, TRANSITION.OPENED).summary.startsWith(`${explanation}\n\n`))
  }
})

test("incident summaries retain analytics evidence without claiming a failure streak", () => {
  const incident = createIncident(
    target(), analyticsObservation(526, OBSERVED_AT, 7), "incident-analytics", OBSERVED_AT,
  )
  const event = createIncidentCloudEvent(incident, TRANSITION.OPENED)
  assert.ok(event.summary.includes("Failure signal: Cloudflare analytics\nObserved failure requests: 7"))
  assert.ok(event.summary.includes("Failure threshold: 2"))
  assert.ok(!event.summary.includes("consecutive failures"))
  const recovered = createIncidentCloudEvent(resolveIncident(incident, RECOVERED_AT), TRANSITION.RESOLVED)
  assert.ok(recovered.summary.includes("State: Recovered"))
  assert.ok(recovered.summary.includes("Failure signal: Cloudflare analytics\nObserved failure requests: 7"))
})

test("incident summaries distinguish automatic recovery from operator dismissal", () => {
  const incident = createIncident(
    target(), httpObservation(target(), 200, OBSERVED_AT, "body-marker-missing"), "incident-resolution", OBSERVED_AT,
  )
  const recovered = createIncidentCloudEvent(resolveIncident(incident, RECOVERED_AT), TRANSITION.RESOLVED)
  assert.ok(recovered.summary.startsWith("The endpoint passed the configured checks for 2 consecutive probes.\n\n"))
  assert.ok(recovered.summary.includes("State: Recovered"))
  assert.ok(recovered.summary.includes(`Resolved: ${RECOVERED_AT}`))
  assert.ok(!recovered.summary.includes("returned HTTP 200"))
  const dismissed = createIncidentCloudEvent(dismissIncident(incident, RECOVERED_AT), TRANSITION.RESOLVED)
  assert.ok(dismissed.summary.startsWith("An operator dismissed this incident. This does not confirm that the endpoint is healthy.\n\n"))
  assert.ok(dismissed.summary.includes("State: Dismissed"))
  assert.ok(!dismissed.summary.includes("passed the configured checks"))
  assert.equal(dismissed.data.resolutionReason, RESOLUTION_REASON.OPERATOR_DISMISSED)
})

test("incident summaries describe a recovery threshold of one", () => {
  const incident = createIncident(
    target({ recoveryThreshold: 1 }), networkObservation("network", OBSERVED_AT), "incident-single-probe", OBSERVED_AT,
  )
  const event = createIncidentCloudEvent(resolveIncident(incident, RECOVERED_AT), TRANSITION.RESOLVED)
  assert.ok(event.summary.startsWith("The endpoint passed the configured checks for 1 consecutive probe.\n\n"))
})

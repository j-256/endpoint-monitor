import {
  FAILURE_KIND,
  OBSERVATION_SOURCE,
  RESOLUTION_REASON,
  TRANSITION,
} from "./constants.mjs"

const VALIDATION_EXPLANATIONS = Object.freeze({
  "body-marker-missing": "the configured body marker was not found within the inspected response body",
  "response-body-too-large": "the response exceeded the body validation limit",
  "response-body-unreadable": "the response body could not be read",
  "content-type-mismatch": "the response media type did not match the configured expectation",
  "response-json-invalid": "the response body was not valid JSON",
  "json-subset-mismatch": "the JSON response did not match the configured subset",
  "location-invalid": "the redirect location was invalid",
  "location-mismatch": "the redirect location did not match the configured expectation",
  "location-missing": "the response was missing the expected redirect location",
})

function failureExplanation(incident) {
  if (incident.failureKind === FAILURE_KIND.NETWORK) {
    if (incident.errorCode === "timeout") {
      return "The endpoint did not respond before the configured timeout."
    }
    const detail = incident.errorCode && incident.errorCode !== "network"
      ? ` (${incident.errorCode})`
      : ""
    return `The request failed before an HTTP response was received${detail}.`
  }
  const response = `The endpoint returned HTTP ${incident.latestStatus}`
  if (!incident.errorCode) {
    return `${response}, which did not satisfy the configured status check.`
  }
  const explanation = Object.hasOwn(VALIDATION_EXPLANATIONS, incident.errorCode)
    ? VALIDATION_EXPLANATIONS[incident.errorCode]
    : `the response did not satisfy the configured check (${incident.errorCode})`
  return `${response}, but ${explanation}.`
}

export function createIncidentSummary(incident, transition) {
  const opened = transition === TRANSITION.OPENED
  const dismissed = !opened
    && incident.resolutionReason === RESOLUTION_REASON.OPERATOR_DISMISSED
  const probes = incident.recoveryThreshold === 1 ? "probe" : "probes"
  const explanation = opened
    ? failureExplanation(incident)
    : dismissed
      ? "An operator dismissed this incident. This does not confirm that the endpoint is healthy."
      : `The endpoint passed the configured checks for ${incident.recoveryThreshold} consecutive ${probes}.`
  const lines = [
    explanation,
    "",
    `State: ${opened ? "Problem" : dismissed ? "Dismissed" : "Recovered"}`,
    `Failure threshold: ${incident.failureThreshold}`,
    `Recovery threshold: ${incident.recoveryThreshold}`,
    `First observed: ${incident.firstObservedAt}`,
    `Opened: ${incident.openedAt}`,
  ]
  if (!opened) lines.push(`Resolved: ${incident.resolvedAt}`)
  lines.push(`Failure signal: ${incident.latestSignal === OBSERVATION_SOURCE.CLOUDFLARE_ANALYTICS
    ? "Cloudflare analytics"
    : "Active probe"}`)
  if (incident.requestCount !== null) {
    lines.push(`Observed failure requests: ${incident.requestCount}`)
  }
  lines.push(`Target: ${incident.targetUrl}`)
  return lines.join("\n")
}

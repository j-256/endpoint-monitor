import {
  OBSERVATION_OUTCOME,
} from "./constants.mjs"
import {
  httpObservation,
  networkObservation,
} from "./core.mjs"

export const MAXIMUM_VALIDATION_BODY_BYTES = 64 * 1024

const VALIDATION_ERROR = Object.freeze({
  BODY_MARKER: "body-marker-missing",
  BODY_TOO_LARGE: "response-body-too-large",
  BODY_UNREADABLE: "response-body-unreadable",
  CONTENT_TYPE: "content-type-mismatch",
  JSON_INVALID: "response-json-invalid",
  JSON_SUBSET: "json-subset-mismatch",
  LOCATION_INVALID: "location-invalid",
  LOCATION_MISMATCH: "location-mismatch",
  LOCATION_MISSING: "location-missing",
})

function networkErrorCode(error) {
  return ["AbortError", "TimeoutError"].includes(error?.name)
    ? "timeout"
    : "network"
}

async function cancelResponseBody(response) {
  try {
    await response.body?.cancel()
  } catch {}
}

function contentTypeOf(response) {
  const value = response.headers?.get?.("content-type")
  return typeof value === "string"
    ? value.split(";", 1)[0].trim().toLowerCase()
    : null
}

function locationError(response, target, expected) {
  const value = response.headers?.get?.("location")
  if (!value) return VALIDATION_ERROR.LOCATION_MISSING
  let actual
  let destination
  try {
    actual = new URL(value, target.url)
    destination = new URL(expected.url)
  } catch {
    return VALIDATION_ERROR.LOCATION_INVALID
  }
  const components = [
    "protocol",
    "username",
    "password",
    "hostname",
    "port",
    "pathname",
    "hash",
  ]
  if (components.some((component) => actual[component] !== destination[component])
    || (!expected.ignoreQuery && actual.search !== destination.search)) {
    return VALIDATION_ERROR.LOCATION_MISMATCH
  }
  return null
}

async function readResponseBody(response, marker, requireComplete) {
  const declaredLength = response.headers?.get?.("content-length")
  if (requireComplete
    && /^\d+$/.test(declaredLength || "")
    && Number(declaredLength) > MAXIMUM_VALIDATION_BODY_BYTES) {
    await cancelResponseBody(response)
    return { errorCode: VALIDATION_ERROR.BODY_TOO_LARGE, text: null }
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    return { errorCode: VALIDATION_ERROR.BODY_UNREADABLE, text: null }
  }
  const decoder = new TextDecoder()
  const reader = response.body.getReader()
  let bytes = 0
  let text = ""
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) {
        text += decoder.decode()
        return {
          errorCode: null,
          markerFound: marker === undefined ? null : text.includes(marker),
          text: requireComplete ? text : null,
        }
      }
      const remaining = MAXIMUM_VALIDATION_BODY_BYTES - bytes
      const value = chunk.value.byteLength > remaining
        ? chunk.value.subarray(0, remaining)
        : chunk.value
      bytes += value.byteLength
      text += decoder.decode(value, { stream: true })
      if (!requireComplete && marker !== undefined && text.includes(marker)) {
        try {
          await reader.cancel()
        } catch {}
        return { errorCode: null, markerFound: true, text: null }
      }
      if (chunk.value.byteLength > remaining) {
        try {
          await reader.cancel()
        } catch {}
        return requireComplete
          ? {
              errorCode: VALIDATION_ERROR.BODY_TOO_LARGE,
              markerFound: null,
              text: null,
            }
          : { errorCode: null, markerFound: false, text: null }
      }
    }
  } catch {
    try {
      await reader.cancel()
    } catch {}
    return {
      errorCode: VALIDATION_ERROR.BODY_UNREADABLE,
      markerFound: null,
      text: null,
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {}
  }
}

function jsonContains(actual, expected) {
  if (expected === null || typeof expected !== "object") {
    return Object.is(actual, expected)
  }
  if (Array.isArray(expected)) {
    return Array.isArray(actual)
      && actual.length === expected.length
      && expected.every((entry, index) => jsonContains(actual[index], entry))
  }
  return actual !== null
    && typeof actual === "object"
    && !Array.isArray(actual)
    && Object.entries(expected).every(([key, value]) => (
      Object.hasOwn(actual, key) && jsonContains(actual[key], value)
    ))
}

async function validationError(response, target) {
  const expected = target.expect
  if (!expected) return null
  if (expected.contentType
    && contentTypeOf(response) !== expected.contentType) {
    return VALIDATION_ERROR.CONTENT_TYPE
  }
  if (expected.location) {
    const errorCode = locationError(response, target, expected.location)
    if (errorCode) return errorCode
  }
  if (expected.bodyIncludes === undefined
    && expected.jsonSubset === undefined) {
    return null
  }
  const body = await readResponseBody(
    response,
    expected.bodyIncludes,
    expected.jsonSubset !== undefined,
  )
  if (body.errorCode) return body.errorCode
  if (expected.bodyIncludes !== undefined
    && !(body.markerFound ?? body.text.includes(expected.bodyIncludes))) {
    return VALIDATION_ERROR.BODY_MARKER
  }
  if (expected.jsonSubset !== undefined) {
    let parsed
    try {
      parsed = JSON.parse(body.text)
    } catch {
      return VALIDATION_ERROR.JSON_INVALID
    }
    if (!jsonContains(parsed, expected.jsonSubset)) {
      return VALIDATION_ERROR.JSON_SUBSET
    }
  }
  return null
}

export async function probeTarget(fetchImpl, target, observedAt) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("Probe fetch implementation is required")
  }
  try {
    const response = await fetchImpl(target.url, {
      headers: { Accept: "*/*" },
      method: target.method,
      redirect: "manual",
      signal: AbortSignal.timeout(target.timeoutMilliseconds),
    })
    try {
      const statusObservation = httpObservation(target, response.status, observedAt)
      if (statusObservation.outcome === OBSERVATION_OUTCOME.FAILURE) {
        return statusObservation
      }
      return httpObservation(
        target,
        response.status,
        observedAt,
        await validationError(response, target),
      )
    } finally {
      await cancelResponseBody(response)
    }
  } catch (error) {
    if (error?.name === "SubrequestBudgetError") throw error
    return networkObservation(networkErrorCode(error), observedAt)
  }
}

export async function probeTargets(fetchImpl, targets, observedAt, concurrency = 5) {
  if (!Array.isArray(targets)
    || !Number.isInteger(concurrency)
    || concurrency < 1) {
    throw new TypeError("Probe pool input is invalid")
  }
  const results = new Array(targets.length)
  let cursor = 0
  async function consume() {
    while (cursor < targets.length) {
      const index = cursor
      cursor += 1
      const target = targets[index]
      results[index] = Object.freeze({
        observation: await probeTarget(fetchImpl, target, typeof observedAt === "function" ? observedAt() : observedAt),
        target,
      })
    }
  }
  const consumers = Array.from(
    { length: Math.min(concurrency, targets.length) },
    consume,
  )
  await Promise.all(consumers)
  return Object.freeze(results)
}

export function summarizeProbeResults(results) {
  return Object.freeze(results.reduce((summary, result) => {
    if (result.observation.outcome === OBSERVATION_OUTCOME.SUCCESS) {
      summary.succeeded += 1
    } else {
      summary.failed += 1
    }
    return summary
  }, { failed: 0, succeeded: 0 }))
}

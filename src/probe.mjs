import {
  OBSERVATION_OUTCOME,
} from "./constants.mjs"
import {
  httpObservation,
  networkObservation,
} from "./core.mjs"

function networkErrorCode(error) {
  return ["AbortError", "TimeoutError"].includes(error?.name)
    ? "timeout"
    : "network"
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
    const observation = httpObservation(target, response.status, observedAt)
    try {
      await response.body?.cancel()
    } catch {}
    return observation
  } catch (error) {
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
        observation: await probeTarget(fetchImpl, target, observedAt),
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

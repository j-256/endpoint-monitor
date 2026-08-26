import {
  normalizeHookrelayUrl,
  signHookrelayPayload,
} from "../../hookrelay.mjs"
import { SubrequestBudgetError } from "./fetch-budget.mjs"

const CONTENT_TYPE = "application/cloudevents+json"
const SIGNATURE_HEADER = "X-Hookrelay-Signature-256"

function networkErrorCode(error) {
  return ["AbortError", "TimeoutError"].includes(error?.name)
    ? "timeout"
    : "network"
}

export async function deliverHookrelayEvent(fetchImpl, urlValue, secret, body) {
  if (typeof fetchImpl !== "function" || typeof body !== "string" || !body) {
    throw new TypeError("Hookrelay delivery input is invalid")
  }
  const url = normalizeHookrelayUrl(urlValue)
  const signature = await signHookrelayPayload(body, secret)
  try {
    const response = await fetchImpl(url, {
      body,
      headers: {
        "Content-Type": CONTENT_TYPE,
        [SIGNATURE_HEADER]: `sha256=${signature}`,
      },
      method: "POST",
      redirect: "manual",
    })
    try {
      await response.body?.cancel()
    } catch {}
    if (!response.ok) {
      return Object.freeze({ errorCode: `http-${response.status}`, ok: false })
    }
    return Object.freeze({ errorCode: null, ok: true })
  } catch (error) {
    if (error instanceof SubrequestBudgetError) throw error
    return Object.freeze({ errorCode: networkErrorCode(error), ok: false })
  }
}

export function nextDeliveryAttempt(attempts, attemptedAt) {
  if (!Number.isInteger(attempts) || attempts < 0) {
    throw new TypeError("Delivery attempt count is invalid")
  }
  const milliseconds = Date.parse(attemptedAt)
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError("Delivery attempt time is invalid")
  }
  const delayMinutes = Math.min(60, 2 ** Math.min(attempts, 6))
  return new Date(milliseconds + delayMinutes * 60 * 1000).toISOString()
}

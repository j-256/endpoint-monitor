import assert from "node:assert/strict"
import test from "node:test"

import {
  deliverHookrelayEvent,
  nextDeliveryAttempt,
} from "../src/adapters/cloudflare/delivery.mjs"
import { SubrequestBudgetError } from "../src/adapters/cloudflare/fetch-budget.mjs"

const BODY = JSON.stringify({
  id: "incident-one/opened",
  source: "urn:endpoint-monitor",
  specversion: "1.0",
  type: "urn:endpoint-monitor:problem:v1",
})
const HOOK_URL = "https://hooks.example.com/hook/cloudevents/abcdefghijklmnopqrstuv"

test("Hookrelay delivery signs exact structured CloudEvent bytes", async () => {
  let request
  const result = await deliverHookrelayEvent(
    async (url, init) => {
      request = { init, url }
      return new Response(null, { status: 202 })
    },
    HOOK_URL,
    "test-secret",
    BODY,
  )
  assert.deepEqual(result, { errorCode: null, ok: true })
  assert.equal(request.url, HOOK_URL)
  assert.equal(request.init.body, BODY)
  assert.equal(request.init.headers["Content-Type"], "application/cloudevents+json")
  assert.match(
    request.init.headers["X-Hookrelay-Signature-256"],
    /^sha256=[a-f0-9]{64}$/,
  )
  assert.equal(request.init.redirect, "manual")
})

test("Hookrelay delivery returns bounded failure codes", async () => {
  assert.deepEqual(
    await deliverHookrelayEvent(
      async () => new Response("private detail", { status: 503 }),
      HOOK_URL,
      "test-secret",
      BODY,
    ),
    { errorCode: "http-503", ok: false },
  )
  assert.deepEqual(
    await deliverHookrelayEvent(
      async () => {
        throw new Error("private network detail")
      },
      HOOK_URL,
      "test-secret",
      BODY,
    ),
    { errorCode: "network", ok: false },
  )
})

test("delivery retry uses bounded exponential backoff", () => {
  assert.equal(
    nextDeliveryAttempt(0, "2026-08-26T03:00:00.000Z"),
    "2026-08-26T03:01:00.000Z",
  )
  assert.equal(
    nextDeliveryAttempt(9, "2026-08-26T03:00:00.000Z"),
    "2026-08-26T04:00:00.000Z",
  )
})

test("delivery validates input, timeout, budget, and retry arguments", async () => {
  await assert.rejects(
    deliverHookrelayEvent(null, HOOK_URL, "secret", BODY),
    /input is invalid/,
  )
  assert.deepEqual(
    await deliverHookrelayEvent(
      async () => {
        const error = new Error("timeout detail")
        error.name = "TimeoutError"
        throw error
      },
      HOOK_URL,
      "secret",
      BODY,
    ),
    { errorCode: "timeout", ok: false },
  )
  await assert.rejects(
    deliverHookrelayEvent(
      async () => {
        throw new SubrequestBudgetError()
      },
      HOOK_URL,
      "secret",
      BODY,
    ),
    SubrequestBudgetError,
  )
  assert.throws(
    () => nextDeliveryAttempt(-1, "2026-08-26T03:00:00.000Z"),
    /count is invalid/,
  )
  assert.throws(() => nextDeliveryAttempt(1, "invalid"), /time is invalid/)
})

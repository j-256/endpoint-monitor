import assert from "node:assert/strict"
import test from "node:test"

import {
  createFetchBudget,
  SubrequestBudgetError,
} from "../src/adapters/cloudflare/fetch-budget.mjs"
import { probeTarget } from "../src/probe.mjs"

const TARGET = {
  configFingerprint: "sha256:example-home",
  expectedStatuses: null,
  failureThreshold: 2,
  id: "example-home",
  method: "GET",
  recoveryThreshold: 2,
  timeoutMilliseconds: 10000,
  url: "https://example.com/",
}

test("fetch budget counts calls and rejects excess work", async () => {
  const budget = createFetchBudget(async () => new Response(null, { status: 204 }), 2)
  assert.equal(budget.used, 0)
  assert.equal((await budget.fetch("https://example.com/")).status, 204)
  assert.equal((await budget.fetch("https://example.net/")).status, 204)
  assert.equal(budget.used, 2)
  assert.equal(budget.remaining, 0)
  await assert.rejects(
    budget.fetch("https://example.org/"),
    SubrequestBudgetError,
  )
})

test("probe does not turn budget exhaustion into endpoint failure", async () => {
  const budget = createFetchBudget(async () => new Response(null, { status: 200 }), 1)
  await probeTarget(budget.fetch, TARGET, "2026-08-26T03:00:00.000Z")
  await assert.rejects(
    probeTarget(budget.fetch, TARGET, "2026-08-26T03:01:00.000Z"),
    SubrequestBudgetError,
  )
})

test("fetch budget can count a service binding under the same limit", async () => {
  const budget = createFetchBudget(async () => new Response(null), 1)
  const serviceFetch = async () => new Response(null, { status: 202 })
  assert.equal(
    (await budget.request(serviceFetch, "https://hooks.example.com/")).status,
    202,
  )
  assert.equal(budget.used, 1)
  await assert.rejects(
    budget.fetch("https://example.com/"),
    SubrequestBudgetError,
  )
})

test("fetch budget validates its constructor and request implementation", async () => {
  assert.throws(() => createFetchBudget(null, 1), /input is invalid/)
  const budget = createFetchBudget(async () => new Response(null), 1)
  await assert.rejects(budget.request(null), /implementation is invalid/)
})

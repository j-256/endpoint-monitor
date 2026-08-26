import assert from "node:assert/strict"
import test from "node:test"

import { CloudflareApi } from "../src/adapters/cloudflare/api.mjs"

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef"
const API_TOKEN = "test-token"

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  })
}

test("Cloudflare API lists all active account zones", async () => {
  const requests = []
  const api = new CloudflareApi({
    accountId: ACCOUNT_ID,
    apiToken: API_TOKEN,
    fetchImpl: async (url, init) => {
      requests.push({ init, url: String(url) })
      const page = new URL(url).searchParams.get("page")
      return jsonResponse({
        result: [{ id: `zone-${page}`, name: `Example${page}.COM` }],
        result_info: { total_pages: 2 },
        success: true,
      })
    },
  })
  assert.deepEqual(await api.listZones(), [
    { id: "zone-1", name: "example1.com" },
    { id: "zone-2", name: "example2.com" },
  ])
  assert.equal(requests.length, 2)
  assert.equal(requests[0].init.headers.Authorization, `Bearer ${API_TOKEN}`)
  assert.equal(new URL(requests[0].url).searchParams.get("account.id"), ACCOUNT_ID)
  assert.equal(new URL(requests[0].url).searchParams.get("status"), "active")
})

test("Cloudflare API posts GraphQL variables without exposing response details", async () => {
  let request
  const api = new CloudflareApi({
    accountId: ACCOUNT_ID,
    apiToken: API_TOKEN,
    fetchImpl: async (url, init) => {
      request = { init, url: String(url) }
      return jsonResponse({ data: { viewer: { accounts: [] } } })
    },
  })
  const variables = { accountTag: ACCOUNT_ID }
  assert.deepEqual(
    await api.graphql("query Test { viewer { __typename } }", variables),
    { viewer: { accounts: [] } },
  )
  assert.equal(request.url, "https://api.cloudflare.com/client/v4/graphql")
  assert.deepEqual(JSON.parse(request.init.body), {
    query: "query Test { viewer { __typename } }",
    variables,
  })
})

test("Cloudflare API uses fixed errors for HTTP and payload failures", async () => {
  const unauthorized = new CloudflareApi({
    accountId: ACCOUNT_ID,
    apiToken: API_TOKEN,
    fetchImpl: async () => jsonResponse({ error: "secret detail" }, 403),
  })
  await assert.rejects(
    unauthorized.listZones(),
    (error) => error.code === "cloudflare-zones-failed"
      && error.status === 403
      && !error.message.includes("secret detail"),
  )

  const invalid = new CloudflareApi({
    accountId: ACCOUNT_ID,
    apiToken: API_TOKEN,
    fetchImpl: async () => jsonResponse({ data: null, errors: [{ message: "detail" }] }),
  })
  await assert.rejects(
    invalid.graphql("query Test { viewer { __typename } }", {}),
    (error) => error.code === "cloudflare-graphql-invalid"
      && !error.message.includes("detail"),
  )
})

test("Cloudflare API rejects incomplete configuration", () => {
  assert.throws(
    () => new CloudflareApi({ accountId: "account", apiToken: API_TOKEN }),
    /configuration is invalid/,
  )
})

test("Cloudflare API rejects invalid JSON, zone payloads, and pagination", async () => {
  const invalidJson = new CloudflareApi({
    accountId: ACCOUNT_ID,
    apiToken: API_TOKEN,
    fetchImpl: async () => new Response("not-json"),
  })
  await assert.rejects(
    invalidJson.listZones(),
    (error) => error.code === "cloudflare-zones-failed-invalid-json",
  )

  const invalidPayload = new CloudflareApi({
    accountId: ACCOUNT_ID,
    apiToken: API_TOKEN,
    fetchImpl: async () => jsonResponse({ result: {}, success: true }),
  })
  await assert.rejects(
    invalidPayload.listZones(),
    (error) => error.code === "cloudflare-zones-invalid",
  )

  const invalidPagination = new CloudflareApi({
    accountId: ACCOUNT_ID,
    apiToken: API_TOKEN,
    fetchImpl: async () => jsonResponse({
      result: [],
      result_info: { total_pages: "many" },
      success: true,
    }),
  })
  await assert.rejects(
    invalidPagination.listZones(),
    (error) => error.code === "cloudflare-zones-pagination-invalid",
  )
})

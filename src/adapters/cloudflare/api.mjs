const API_BASE_URL = "https://api.cloudflare.com/client/v4/"
const GRAPHQL_URL = `${API_BASE_URL}graphql`

function fixedApiError(code, status = null) {
  const error = new Error(code)
  error.code = code
  error.status = status
  return error
}

async function jsonResponse(response, code) {
  if (!response.ok) throw fixedApiError(code, response.status)
  try {
    return await response.json()
  } catch {
    throw fixedApiError(`${code}-invalid-json`, response.status)
  }
}

export class CloudflareApi {
  constructor({ accountId, apiToken, fetchImpl = globalThis.fetch }) {
    if (typeof accountId !== "string"
      || !/^[a-f0-9]{32}$/.test(accountId)
      || typeof apiToken !== "string"
      || !apiToken
      || typeof fetchImpl !== "function") {
      throw new TypeError("Cloudflare API configuration is invalid")
    }
    this.accountId = accountId
    this.apiToken = apiToken
    this.fetchImpl = fetchImpl
  }

  headers() {
    return {
      Authorization: `Bearer ${this.apiToken}`,
      "Content-Type": "application/json",
    }
  }

  async listZones() {
    const zones = []
    let page = 1
    while (true) {
      const url = new URL("zones", API_BASE_URL)
      url.searchParams.set("account.id", this.accountId)
      url.searchParams.set("page", String(page))
      url.searchParams.set("per_page", "50")
      url.searchParams.set("status", "active")
      const response = await this.fetchImpl(url, {
        headers: this.headers(),
        method: "GET",
      })
      const payload = await jsonResponse(response, "cloudflare-zones-failed")
      if (payload.success !== true || !Array.isArray(payload.result)) {
        throw fixedApiError("cloudflare-zones-invalid", response.status)
      }
      zones.push(...payload.result.map((zone) => ({
        id: String(zone.id || ""),
        name: String(zone.name || "").toLowerCase(),
      })).filter((zone) => zone.id && zone.name))
      const totalPages = Number(payload.result_info?.total_pages || 1)
      if (!Number.isInteger(totalPages) || totalPages < 1 || totalPages > 1000) {
        throw fixedApiError("cloudflare-zones-pagination-invalid", response.status)
      }
      if (page >= totalPages) return zones
      page += 1
    }
  }

  async graphql(query, variables) {
    const response = await this.fetchImpl(GRAPHQL_URL, {
      body: JSON.stringify({ query, variables }),
      headers: this.headers(),
      method: "POST",
    })
    const payload = await jsonResponse(response, "cloudflare-graphql-failed")
    if (!payload.data || (Array.isArray(payload.errors) && payload.errors.length > 0)) {
      throw fixedApiError("cloudflare-graphql-invalid", response.status)
    }
    return payload.data
  }
}

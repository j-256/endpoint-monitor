import { analyticsObservation } from "../../core.mjs"
import { IMMEDIATE_HTTP_STATUSES } from "../../constants.mjs"
import { sha256Hex } from "../../crypto.mjs"

const ANALYTICS_LAG_MILLISECONDS = 2 * 60 * 1000
const ANALYTICS_LOOKBACK_MILLISECONDS = 15 * 60 * 1000
const ANALYTICS_ROW_LIMIT = 5000
const PROVIDER = "cloudflare"

function analyticsError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

const ANALYTICS_QUERY = `
  query EndpointMonitorFailures(
    $accountTag: string
    $start: string
    $end: string
    $hostnames: [string]
  ) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        rows: httpRequestsAdaptiveGroups(
          limit: ${ANALYTICS_ROW_LIMIT}
          filter: {
            datetime_geq: $start
            datetime_lt: $end
            clientRequestHTTPHost_in: $hostnames
            edgeResponseStatus_in: [${IMMEDIATE_HTTP_STATUSES.join(", ")}]
            requestSource: "eyeball"
          }
        ) {
          count
          dimensions {
            clientRequestHTTPHost
            clientRequestPath
            datetimeMinute
            edgeResponseStatus
            zoneTag
          }
        }
      }
    }
  }
`

function normalizedHostname(value) {
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/\.$/, "")
    : ""
}

function analyticsWindow(now) {
  const milliseconds = now instanceof Date ? now.getTime() : Date.parse(now)
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError("Analytics time is invalid")
  }
  const endMilliseconds = Math.floor(
    (milliseconds - ANALYTICS_LAG_MILLISECONDS) / 60000,
  ) * 60000
  return Object.freeze({
    end: new Date(endMilliseconds).toISOString(),
    start: new Date(endMilliseconds - ANALYTICS_LOOKBACK_MILLISECONDS).toISOString(),
  })
}

function targetIndex(targets) {
  const index = new Map()
  for (const target of targets) {
    const url = new URL(target.url)
    if (url.search) continue
    const key = JSON.stringify([url.hostname.toLowerCase(), url.pathname])
    index.set(key, target)
  }
  return index
}

function hostnameBelongsToZone(hostname, zoneName) {
  return hostname === zoneName || hostname.endsWith(`.${zoneName}`)
}

async function signalFingerprint(row, target) {
  return `sha256:${await sha256Hex(JSON.stringify({
    hostname: row.hostname,
    observedAt: row.observedAt,
    path: row.path,
    provider: PROVIDER,
    status: row.status,
    targetId: target.id,
    zoneId: row.zoneId,
  }))}`
}

function normalizedRow(row) {
  const hostname = normalizedHostname(row?.dimensions?.clientRequestHTTPHost)
  const path = String(row?.dimensions?.clientRequestPath || "")
  const observedAt = row?.dimensions?.datetimeMinute
  const requestCount = Number(row?.count)
  const status = Number(row?.dimensions?.edgeResponseStatus)
  const zoneId = String(row?.dimensions?.zoneTag || "")
  if (!hostname
    || !path.startsWith("/")
    || !Number.isFinite(Date.parse(observedAt))
    || !Number.isFinite(requestCount)
    || requestCount <= 0
    || !IMMEDIATE_HTTP_STATUSES.includes(status)
    || !zoneId) return null
  return Object.freeze({
    hostname,
    observedAt: new Date(observedAt).toISOString(),
    path,
    requestCount,
    status,
    zoneId,
  })
}

export async function readCloudflareAnalyticsFailures(api, targets, now) {
  if (!api?.accountId || typeof api.listZones !== "function"
    || typeof api.graphql !== "function" || !Array.isArray(targets)) {
    throw new TypeError("Cloudflare analytics input is invalid")
  }
  const indexed = targetIndex(targets)
  if (indexed.size === 0) {
    return Object.freeze({ entries: Object.freeze([]), rowCount: 0 })
  }
  const hostnames = [...new Set([...indexed.keys()].map((key) => JSON.parse(key)[0]))]
    .sort()
  const window = analyticsWindow(now)
  const [zones, data] = await Promise.all([
    api.listZones(),
    api.graphql(ANALYTICS_QUERY, {
      accountTag: api.accountId,
      end: window.end,
      hostnames,
      start: window.start,
    }),
  ])
  const rows = data?.viewer?.accounts?.[0]?.rows
  if (!Array.isArray(rows)) {
    throw analyticsError("cloudflare-analytics-rows-unavailable")
  }
  if (rows.length >= ANALYTICS_ROW_LIMIT) {
    throw analyticsError("cloudflare-analytics-result-truncated")
  }
  const zoneNames = new Map(zones.map((zone) => [zone.id, zone.name]))
  const entries = []
  for (const value of rows) {
    const row = normalizedRow(value)
    if (!row) continue
    const zoneName = zoneNames.get(row.zoneId)
    if (!zoneName || !hostnameBelongsToZone(row.hostname, zoneName)) continue
    const target = indexed.get(JSON.stringify([row.hostname, row.path]))
    if (!target || target.expectedStatuses?.includes(row.status)) continue
    entries.push(Object.freeze({
      observation: analyticsObservation(
        row.status,
        row.observedAt,
        row.requestCount,
      ),
      signal: Object.freeze({
        fingerprint: await signalFingerprint(row, target),
        provider: PROVIDER,
      }),
      target,
    }))
  }
  entries.sort((left, right) => (
    left.observation.observedAt.localeCompare(right.observation.observedAt)
      || left.target.id.localeCompare(right.target.id)
      || left.observation.httpStatus - right.observation.httpStatus
  ))
  return Object.freeze({
    entries: Object.freeze(entries),
    rowCount: rows.length,
    window,
  })
}

export { ANALYTICS_QUERY }

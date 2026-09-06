import { sha256Hex } from "../../crypto.mjs"

export const MANAGEMENT_VERSION = 1
export const MANAGEMENT_PATH = "/admin/api/v1"
export const MANAGEMENT_LIMITS = Object.freeze({
  bodyBytes: 288 * 1024,
  bodyMilliseconds: 5000,
  credentialBytes: 16 * 1024,
  credentials: 20,
  workspaces: 20,
  page: 50,
  cursorBytes: 1024,
  planMilliseconds: 10 * 60 * 1000,
  receiptMilliseconds: 30 * 24 * 60 * 60 * 1000,
  pendingPlans: 100,
  receipts: 1000,
})
export const MANAGEMENT_CAPABILITIES = Object.freeze(["read", "configure", "triage"])
const ID = /^[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,127}$/
const TOKEN = /^Bearer (epm_[A-Za-z0-9_-]{43})$/

export class ManagementError extends Error {
  constructor(code, status, message) {
    super(message)
    this.code = code
    this.status = status
  }
}

export function invalid() {
  throw new ManagementError("validation", 400, "Management input is invalid")
}

export function strictObject(value, keys, required = keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))
    || required.some((key) => !Object.hasOwn(value, key))) invalid()
  return value
}

export function managementId(value) {
  if (typeof value !== "string" || !ID.test(value)) invalid()
  return value
}

export function managementRevision(value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum || value >= Number.MAX_SAFE_INTEGER) invalid()
  return value
}

export function managementTimestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) invalid()
  return value
}

function equalHash(left, right) {
  let difference = 0
  for (let index = 0; index < 64; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return difference === 0
}

export async function authenticateManagement(request, env, now) {
  const token = TOKEN.exec(request.headers.get("authorization") || "")?.[1]
  if (!token) throw new ManagementError("unauthorized", 401, "A management credential is required")
  let credentials
  try {
    const raw = env.MANAGEMENT_CREDENTIALS
    if (typeof raw !== "string" || raw.length > MANAGEMENT_LIMITS.credentialBytes) throw new Error()
    credentials = JSON.parse(raw)
    if (!Array.isArray(credentials) || !credentials.length || credentials.length > MANAGEMENT_LIMITS.credentials) throw new Error()
    for (const credential of credentials) {
      strictObject(credential, ["id", "revision", "tokenHash", "expiresAt", "workspaceIds", "capabilities"])
      managementId(credential.id)
      managementRevision(credential.revision, 1)
      managementTimestamp(credential.expiresAt)
      if (typeof credential.tokenHash !== "string" || !/^[a-f0-9]{64}$/.test(credential.tokenHash)
        || !Array.isArray(credential.workspaceIds) || !credential.workspaceIds.length || credential.workspaceIds.length > MANAGEMENT_LIMITS.workspaces
        || !Array.isArray(credential.capabilities) || !credential.capabilities.length
        || credential.capabilities.length > MANAGEMENT_CAPABILITIES.length
        || credential.capabilities.some((capability) => !MANAGEMENT_CAPABILITIES.includes(capability))
        || new Set(credential.capabilities).size !== credential.capabilities.length
        || new Set(credential.workspaceIds).size !== credential.workspaceIds.length) throw new Error()
      credential.workspaceIds.forEach(managementId)
    }
    if (new Set(credentials.map((entry) => entry.id)).size !== credentials.length
      || new Set(credentials.map((entry) => entry.tokenHash)).size !== credentials.length) throw new Error()
  } catch {
    throw new ManagementError("unconfigured", 503, "Management credentials are not configured correctly")
  }
  const digest = await sha256Hex(token)
  const principal = credentials.find((credential) => equalHash(credential.tokenHash, digest))
  if (!principal || Date.parse(principal.expiresAt) <= now) {
    throw new ManagementError("unauthorized", 401, "The management credential is invalid or expired")
  }
  return principal
}

export function authorizeManagement(principal, workspaceId, capability, now) {
  if (Date.parse(principal.expiresAt) <= now) throw new ManagementError("unauthorized", 401, "The management credential is expired")
  if (!principal.workspaceIds.includes(workspaceId)) throw new ManagementError("not_found", 404, "Workspace not found")
  if (!principal.capabilities.includes("read") || !principal.capabilities.includes(capability)) {
    throw new ManagementError("forbidden", 403, "The management credential does not permit this operation")
  }
}

export async function readManagementBody(request) {
  if (!(request.headers.get("content-type") || "").match(/^application\/json(?:\s*;|$)/i)
    || request.headers.has("content-encoding")) invalid()
  const length = request.headers.get("content-length")
  if (length && (!/^\d+$/.test(length) || Number(length) > MANAGEMENT_LIMITS.bodyBytes)) {
    throw new ManagementError("too_large", 413, "Management input exceeds the size limit")
  }
  if (!request.body) invalid()
  const reader = request.body.getReader()
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ManagementError("timeout", 408, "Management input timed out")), MANAGEMENT_LIMITS.bodyMilliseconds)
  })
  try {
    const chunks = []
    let bytes = 0
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline])
      if (done) break
      bytes += value.byteLength
      if (bytes > MANAGEMENT_LIMITS.bodyBytes) throw new ManagementError("too_large", 413, "Management input exceeds the size limit")
      chunks.push(value)
    }
    const combined = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(combined)) }
    catch { invalid() }
  } finally {
    clearTimeout(timer)
    void reader.cancel().catch(() => {})
  }
}

export function managementResponse(body, status = 200) {
  return Response.json(body, { status, headers: {
    "cache-control": "no-store", "x-content-type-options": "nosniff",
  } })
}

export function encodeCursor(value) {
  return btoa(JSON.stringify(value))
}

export function decodeCursor(value) {
  if (typeof value !== "string" || value.length > MANAGEMENT_LIMITS.cursorBytes) invalid()
  try { return JSON.parse(atob(value)) } catch { invalid() }
}

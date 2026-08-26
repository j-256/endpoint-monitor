import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"

export function isMainModule(moduleUrl, argvPath = process.argv[1]) {
  if (!argvPath) return false
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return false
  }
}

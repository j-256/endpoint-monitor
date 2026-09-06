import { CloudflareApi } from "./api.mjs"
import {
  ConfigurationAuthorityError,
  readConfigurationAuthority,
  reviewConfiguration,
  writeConfigurationAuthority,
} from "./configuration-authority.mjs"

export class CloudflareConfigurationOperator {
  constructor({ accountId, apiToken, databaseId, fetchImpl }) {
    if (typeof apiToken !== "string" || !apiToken) {
      throw new ConfigurationAuthorityError(
        "configuration-token-unavailable", "CLOUDFLARE_API_TOKEN is unavailable", 2,
      )
    }
    this.api = new CloudflareApi({ accountId, apiToken, fetchImpl })
    this.databaseId = databaseId
  }

  query = async (statement) => {
    try {
      return await this.api.queryD1(this.databaseId, statement)
    } catch {
      throw new ConfigurationAuthorityError(
        "configuration-request-failed",
        "Cloudflare D1 configuration request failed; inspect config remote before retrying a write",
      )
    }
  }

  read() {
    return readConfigurationAuthority(this.query)
  }

  review(candidate) {
    return reviewConfiguration(this.query, candidate)
  }

  write(candidate, options) {
    return writeConfigurationAuthority(this.query, candidate, options)
  }
}

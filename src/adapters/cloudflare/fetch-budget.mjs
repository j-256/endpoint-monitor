export class SubrequestBudgetError extends Error {
  constructor() {
    super("Endpoint Monitor external subrequest budget is exhausted")
    this.name = "SubrequestBudgetError"
  }
}

export function createFetchBudget(fetchImpl, limit) {
  if (typeof fetchImpl !== "function" || !Number.isInteger(limit) || limit < 1) {
    throw new TypeError("Fetch budget input is invalid")
  }
  let used = 0
  async function request(requestFetch, ...args) {
    if (typeof requestFetch !== "function") {
      throw new TypeError("Budgeted fetch implementation is invalid")
    }
    if (used >= limit) throw new SubrequestBudgetError()
    used += 1
    return requestFetch(...args)
  }
  return Object.freeze({
    fetch: (...args) => request(fetchImpl, ...args),
    get remaining() {
      return Math.max(0, limit - used)
    },
    request,
    get used() {
      return used
    },
  })
}

import {
  handleCloudflareRequest,
  runCloudflareScheduledSafely,
} from "./runtime.mjs"

export default {
  fetch(request, env) {
    return handleCloudflareRequest(request, env)
  },

  async scheduled(controller, env) {
    await runCloudflareScheduledSafely(env, controller.scheduledTime)
  },
}

# Repository guidance

Endpoint Monitor is a portable detector for explicit public HTTP and HTTPS targets. Keep the core runtime-neutral and place provider behavior behind adapters.

Never commit operator target files, deployment configuration, resource identifiers, Hookrelay routes, credentials, machine-local paths, or live incident data. Public examples use reserved example domains and synthetic identifiers only.

Use Node.js 22 or newer. Run focused tests while developing, then run `npm run check` before release; it covers tests, coverage, public-source scanning, the portfolio cover, package smoke installation, and the Cloudflare dry run.

Source code and comments use ASCII. Comments do not end in periods. Use Conventional Commits.

Healthy probes with no exceptional state must not write per-target durable state. One bounded aggregate run-status snapshot per completed scheduled minute is the explicit exception: keep fixed-capacity storage, configuration-bound check evidence, and honest freshness without a per-probe event history. Traffic and provider inventory may enrich configured targets but must never enroll targets.

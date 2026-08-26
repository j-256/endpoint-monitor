# Repository guidance

Endpoint Monitor is a portable detector for explicit public HTTP and HTTPS targets. Keep the core runtime-neutral and place provider behavior behind adapters.

Never commit operator target files, deployment configuration, resource identifiers, Hookrelay routes, credentials, machine-local paths, or live incident data. Public examples use reserved example domains and synthetic identifiers only.

Use Node.js 22 or newer. Run focused tests while developing, then run `npm test`, `npm run test:coverage`, `npm run check:publication`, and `npm run deploy:dry-run` before release.

Source code and comments use ASCII. Comments do not end in periods. Use Conventional Commits.

Healthy probes with no exceptional state must not write durable storage. Traffic and provider inventory may enrich configured targets but must never enroll targets.

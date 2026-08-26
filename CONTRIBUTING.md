# Contributing

Endpoint Monitor welcomes focused bug reports and pull requests that preserve explicit target authority, runtime portability, sparse persistence, bounded resource use, and redacted diagnostics.

Use Node.js 22 or newer and install exactly the lockfile state:

```sh
npm ci
```

Run focused tests while developing, then run the complete local gate:

```sh
npm run check
```

New behavior should include built-in Node test coverage. Cloudflare adapter changes should exercise the in-memory SQLite D1 fixture and Wrangler dry-run where applicable. A healthy target without exceptional state must continue to produce zero D1 writes.

Do not commit operator targets, live URLs, resource identifiers, generated Wrangler configuration, `.dev.vars`, Hookrelay routes, HMACs, API tokens, incident payloads, or machine-local paths. Use reserved example domains and synthetic identifiers in tests and documentation.

Keep the core provider-neutral. Provider inventory and traffic can enrich only targets already present in explicit configuration. If a change introduces an assumption about routing, redirects, paths, provider ownership, or status semantics, document it and add a rejection or boundary test.

Use Conventional Commits. Keep pull requests narrow enough that configuration, state-machine, adapter, and documentation effects can be reviewed together.

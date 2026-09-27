# Contributing

Endpoint Monitor welcomes focused bug reports and pull requests that preserve explicit target authority, runtime portability, sparse persistence, bounded resource use, and redacted diagnostics.

Use Node.js 22 or newer, plus Python 3.6 or newer on Unix for the independent watchdog tests. Prefer a maintained Python release when available. Install exactly the Node lockfile state:

```sh
npm ci
```

Run focused tests while developing, then run the complete local gate:

```sh
npm run check
```

Core and adapter behavior should include built-in Node test coverage. The standalone watchdog uses Python's built-in `unittest` through `npm run test:watchdog`. Cloudflare adapter changes should exercise the in-memory SQLite D1 fixture and Wrangler dry-run where applicable. A healthy target without exceptional state must continue to produce zero D1 writes.

Do not commit operator targets, live URLs, resource identifiers, generated Wrangler configuration, `.dev.vars`, Hookrelay routes, HMACs, API tokens, incident payloads, or machine-local paths. Use reserved example domains and synthetic identifiers in tests and documentation.

Keep the core provider-neutral. Provider inventory and traffic can enrich only targets already present in explicit configuration. If a change introduces an assumption about routing, redirects, paths, provider ownership, or status semantics, document it and add a rejection or boundary test.

Use Conventional Commits. Keep pull requests narrow enough that configuration, state-machine, adapter, and documentation effects can be reviewed together.

Maintainers prepare versions and GitHub Release archives through the documented [release procedure](docs/releases.md). Pull requests must not create tags, publish packages, deploy Workers, or include generated `dist/` contents.

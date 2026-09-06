# Architecture

Endpoint Monitor separates monitoring policy from hosting and provider integrations. The explicit configuration is the only source of target identity; all observations must map back to one configured target before they can affect state.

```text
operator configuration
        |
        v
deterministic scheduler ---> active HTTP probes
        |                         |
        |                         v
        +-----------------> observation reducer <--- optional provider signals
                                  |
                                  v
                       exceptional state + incidents
                                  |
                                  v
                         transition outbox ---> delivery adapter
```

## Runtime-neutral core

`src/config.mjs` accepts status-only schema version 1 documents and schema version 2 response expectations, resolves defaults, canonicalizes URLs, and computes target fingerprints. Target fingerprints include every behavior-affecting field so a changed target cannot inherit stale candidate or incident state.

`src/schedule.mjs` sorts targets by a stable hash of their IDs and selects a deterministic interval shard. An adapter supplies its per-run ceiling. If the busiest shard exceeds that ceiling, scheduling fails explicitly.

`src/probe.mjs` performs exact `GET` or `HEAD` requests with manual redirects and timeouts. It validates normalized redirect locations, media types, bounded text markers, and JSON subsets when configured. Text markers search a bounded prefix and stop the response read on a match; JSON validation requires a complete body within the same 64 KiB cap. Read content is discarded after validation and never returned in observations.

`src/core.mjs` is a pure incident state machine. Healthy targets without exceptional state remain absent. Ordinary failures create or advance candidates, selected edge and origin statuses open immediately, and consecutive active successes recover incidents. Provider observations can open but cannot recover incidents. Operator dismissal is an explicit resolved transition rather than a synthetic successful observation.

`src/hookrelay.mjs` validates structured CloudEvents subscription URLs and signs exact serialized bytes. Delivery transport remains an adapter responsibility.

## Adapter contract

A runtime adapter is responsible for:

- Loading one validated explicit configuration
- Calling `probeSchedule` at a stable interval and refusing over-capacity configuration
- Supplying bounded HTTP execution to `probeTargets`
- Loading exceptional target state before reduction
- Persisting state and incident changes atomically
- Creating and retrying transition delivery without duplicating events
- Reconciling configuration fingerprints and suppressing stale incidents
- Emitting bounded diagnostics without secret or URL leakage
- Applying retention to provider signals, delivered outbox rows, and resolved incidents

Provider enrichment is optional. It must filter to configured targets, validate provider ownership independently, deduplicate overlapping windows, and yield to a newer successful active probe.

## Cloudflare adapter

The Cloudflare adapter stores configuration, sparse state, incidents, immutable triage actions, provider-signal fingerprints, and an outbox in D1. A scheduled Worker runs probe, optional analytics, delivery, and hourly maintenance phases under one outbound budget. The operator CLI uses Cloudflare's authenticated D1 API. The Worker offers a versioned management contract protected by dedicated workspace-allowlisted machine credentials, independent of optional status authentication. Both management paths share configuration validation and triage statement builders.

Cloudflare analytics queries only selected failure statuses for configured hostnames with `requestSource: "eyeball"`. A result is accepted only when its zone belongs to the configured account and its hostname and path exactly match a configured target. Targets with query strings receive active probes but no analytics enrichment because the dataset exposes path separately from query.

Delivery can use a Hookrelay service binding or direct public HTTPS. Both paths share the same explicit subrequest budget. The body stored in the outbox is the body that is signed and sent, so retries preserve event identity and exact bytes. Resolved rows remain ineligible until their corresponding problem row is delivered, preserving transition order through retries and operator snoozes.

## Operator triage

Acknowledgement and snooze append immutable actions without altering incident health. Snooze also delays a pending problem delivery. Dismissal uses a transactional D1 batch to append its action, resolve the incident, clear only state tied to that incident, and create a resolved delivery row when a problem row exists. Operational readers derive the `operator-dismissed` reason from the action because the original incident-table constraint contains only automatic resolution reasons.

Incident and action mutations advance an incident revision, including actions originating in the CLI. Management reviews bind the actor, workspace, credential identity and revision, exact normalized action, incident revision, and executing configuration revision. Accepting the review and applying the shared domain statements happen in one database transaction. A unique acceptance identity gates the domain effects, so concurrent submissions cannot apply the same plan twice. Configuration management uses the same receipt protocol and the shared revision-authority statement builder. Accepted receipts retain the result after the reviewed input is discarded, allowing transport uncertainty to be reconciled without repeating effects.

Clearing state makes dismissal non-suppressive: a continuing ordinary failure must cross its threshold again, while a configured immediate failure can reopen on the next probe. Removing or changing a target remains the durable way to retire or correct a monitoring contract.

## Distribution and deployment

`@j-256/endpoint-monitor` is one deployable service package rather than two independently versioned products. The package-local `endpoint-monitor` executable controls an operator project, while absolute paths in the generated Wrangler configuration bind deployment to the Worker source and migrations from that exact package installation. Wrangler is a pinned production dependency because deployment is a supported installed-package operation.

Initialization is local-only. Bootstrap owns resource creation or adoption, private configuration generation, and migrations. Deploy owns migration reconciliation, initialization of an absent target configuration, Worker publication, and public health verification. It preserves existing online configuration without reading a local candidate. Dry-run forms preserve those phase boundaries without provider or durable writes.

An upgrade replaces the package version, reruns bootstrap to point private configuration at the new immutable assets, checks `deploy --dry-run`, and deploys. A controller from one version cannot silently publish Worker assets from another version because deploy rejects a Wrangler configuration whose Worker or migration paths do not resolve to its own package.

## Configuration changes

D1 owns the executing document. The Cloudflare configuration authority is shared by operator imports and management adapters, using the same portable domain validation and schedule ceiling. A reviewed write matches both an exact candidate fingerprint and the monotonic remote revision. Database guards reject legacy writers and revision-resetting replacement or deletion. An accepted change atomically advances its revision and appends a bounded metadata-only audit entry. An unchanged document at the reviewed revision is read-only. The local operator profile selects an import candidate and provider binding, not a competing authority.

Changing any target field changes its fingerprint. On the next scheduled invocation, the adapter resolves an open incident as `configuration-changed`, clears its sparse state, and emits no misleading recovery event. Removing a target behaves the same way with `configuration-removed`.

Saving configuration does not cancel an in-flight probe invocation or prove the new endpoint healthy. An invocation already holding the previous configuration can finish against it; subsequent scheduled reconciliation adopts the executing revision. Management target reads label exceptional evidence from another configuration as changed rather than reporting it as current health.

An incident opened with delivery disabled has no outbox row. When delivery is enabled, the adapter creates the missing problem event for every still-open incident before normal delivery. Incidents that opened and recovered entirely in shadow mode stay historical and do not alert retroactively.

## Consistency and failure behavior

D1 batches group state, incident, action, and outbox mutations for one transition. Unique indices prevent two open incidents per target and duplicate transition events. Guarded operator mutations become no-ops when automatic recovery wins a race. Scheduled invocations are expected not to overlap at normal probe timeouts, but those database constraints remain the last line of defense.

Probe network exceptions and response validation failures become fixed observation codes. Optional analytics errors become fixed error-level Observability records while active probes continue. Critical configuration, D1, scheduling, or subrequest-budget errors fail the scheduled invocation with a bounded code so platform invocation health records the failure.

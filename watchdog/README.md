# Independent watchdog

Run `endpoint_monitor_watchdog.py` from cron on Unix hosting outside Cloudflare. It reads the Worker's protected `/api/status` endpoint and submits alerts directly to Gmail SMTP over verified TLS. It requires Python 3.6 or newer with the standard library, system CA certificates, `flock`, and `SIGALRM`; prefer a maintained Python release when the host offers one. Apache, a public watchdog endpoint, Node.js, and third-party Python packages are unnecessary.

Use a native Gmail sender and native Gmail recipient to avoid custom-domain authoritative DNS or Cloudflare Email Routing in the alert path. The observer's DNS resolver, hosting, Gmail, and the receiving device are still dependencies. A daily healthy email provides a human-visible heartbeat; it cannot automatically report the complete failure of its own hosting or mail provider.

## Behavior

Run once a minute. Two consecutive unhealthy observations open an incident. Recovery requires at least two healthy observations spanning five minutes of stable observed health; any unhealthy observation restarts that window and keeps the same incident open. Samples less than 45 seconds apart do not advance health counters. A gap longer than three minutes resets consecutive-sample counters and recovery stability. Ongoing incidents produce hourly reminders, and healthy operation produces a daily heartbeat. The first heartbeat follows the second healthy sample when no incident is open.

HTTP success is insufficient. The observer validates the response time, scheduled/start/completion timestamps, the one-minute cadence and three-minute freshness deadline, enabled monitoring and delivery, nonempty targets, matching configuration evidence, and phase/delivery error counts. It ages deadlines using its own clock, tolerates up to 30 seconds of clock skew, and fails closed on redirects, malformed data, oversized responses, TLS errors, or failed requests. Keep host clocks synchronized. Individual failed target probes remain the primary monitor's responsibility.

Unreachable HTTP normally alerts in roughly one to two minutes. Missing scheduled execution normally alerts within roughly four to five minutes of the last scheduled run, including the provider's three-minute freshness allowance and observer confirmation. These estimates assume both cron schedulers run on time and Gmail accepts the notification promptly.

Notification intent is saved before SMTP submission and retried until accepted. Stable recovery before successful problem delivery becomes one recovery/outage-summary message. An additional failure before a recovery email succeeds keeps the existing incident open. Repeated stale/healthy fluctuations within the recovery window therefore produce one degraded episode instead of repeated problem/recovery emails. SMTP acknowledgment can be lost after delivery, so duplicates are possible; retries retain the same Message-ID and event ID. This is acceptance tracking, not proof of inbox receipt. Verify actual inbox placement when installing or rotating credentials.

HTTP reads have a ten-second socket timeout and a 512 KiB body cap; SMTP uses a fifteen-second socket timeout. The process has a 45-second signal deadline, and cron should also use the external timeout below to bound stalled system calls. A nonblocking lock prevents overlapping execution. Credentials/configuration must be regular, owner-readable-only files; state and logs live in an owner-only directory. JSON logs rotate at 256 KiB with three backups and contain fixed reasons, correlation IDs, counts, timings, and notification outcomes, never tokens or status bodies. Log retention depends on event volume; the bounded incident and daily evidence below survives log rotation.

## Diagnostic evidence

Run `python3 endpoint_monitor_watchdog.py report` on the observer host to read JSON evidence without configuration, credentials, network requests, mail, lock creation, or file writes. Use `-s`/`--state-dir` for a nondefault state directory. An absent state file returns a `state-unobserved` runtime error rather than an empty healthy history.

The report includes the last observation, open incident, pending notification identity, closed incidents, daily aggregates, and retention bounds. Each incident preserves the last healthy sample before failure, first and latest failure, worst failure by run age and HTTP duration, latest observation, and stable recovery. Existing incident and notification IDs survive the state upgrade. Reports from a legacy state cannot reconstruct evidence that the old observer did not store.

Closed incidents are retained for up to 90 days with a cap of 128; daily aggregates retain up to 90 UTC dates. The atomically replaced state file is capped at 1 MiB and remains mode `0600`. Retention runs on accepted or skipped checks and report reads; a report prunes only its in-memory view. Daily records count healthy/unhealthy samples, skipped samples, mail acceptance/failure, fixed reason frequencies, and maximum observed run age, scheduler delay, and sample gap. These are observation counts and maxima, not an uptime percentage or a complete execution ledger. Overlap skips are logged without writing state held by another process.

Observation diagnostics distinguish scheduled age, scheduler delay, and actual execution duration using the monitor's scheduled/start/completion timestamps. Correlate optional monitor run IDs and validated `CF-Ray` identifiers with Workers logs. HTTPS diagnostics record DNS, TCP, TLS, response-header, body-read, and total HTTP timings when those phases are reached; a failed phase can have a timing without a completed request. `dns-error`, `tls-error`, `http-timeout`, and `http-network-error` distinguish transport failures without retaining exception text. SMTP logs record total submission time and successful connection/authentication/submission phase timings. SMTP acceptance still does not prove inbox receipt.

The freshness deadline remains three minutes from scheduled time. A run starting late does not become fresh merely because it completes. A recent successful `/healthz` or HTTP status request does not establish scheduled execution. Investigate stale evidence alongside scheduler delay, execution duration, missing completion, phase errors, and provider incidents before changing grace periods.

State version 2 is written on the next `run`; reading a version-1 state migrates only the in-memory representation. Pending mail and incident context remain intact. Older observer versions cannot read version-2 state. Preserve a private pre-upgrade state copy when a rollback to older code is required; do not delete state or overwrite newer notification context as a routine recovery step.

## Installation

1. Enable `ENDPOINT_MONITOR_STATUS_ENABLED=true` on the existing Worker and install a dedicated `ENDPOINT_MONITOR_STATUS_TOKEN` Worker secret. Keep the operator's ignored Wrangler configuration aligned so a later deployment preserves the feature. The status credential grants read-only access to the complete status/configuration response; it is not a Cloudflare account token or a management credential. See [Cloudflare operation](../docs/cloudflare.md#feature-bindings).
2. Create `~/.config/endpoint-monitor-watchdog` with mode `0700`. Copy `config.example.json` to `config.json` there and replace the reserved example URL and addresses. Set the sender to the Gmail account owning the app password and the recipient to its direct native inbox. All configuration keys shown in the example are required; credential paths must be absolute or start with `~`.
3. Store the status token in `status-token` and a dedicated Gmail app password in `gmail-app-password`, using hidden input or secure file transfer. Set these files and `config.json` to mode `0600`. Keep the entire directory outside every document root. Gmail app passwords require an eligible account with 2-Step Verification; see [Google's instructions](https://support.google.com/accounts/answer/185833?hl=en). No password belongs in a command argument, crontab, source file, or log.
4. Copy the Python script to `~/.local/share/endpoint-monitor-watchdog/endpoint_monitor_watchdog.py`. Run the check below, verify a controlled alert and recovery with separate configuration/state, then add one cron entry. Use the host's actual absolute paths; cron does not have an interactive shell's PATH.

```sh
python3 ~/.local/share/endpoint-monitor-watchdog/endpoint_monitor_watchdog.py check
```

Example cron entry for a GNU `timeout` host with Python at `/bin/python3`:

```cron
* * * * * /bin/timeout -k 5s 50s /bin/python3 -B "$HOME/.local/share/endpoint-monitor-watchdog/endpoint_monitor_watchdog.py" run >/dev/null 2>&1
```

The default configuration is `${XDG_CONFIG_HOME:-$HOME/.config}/endpoint-monitor-watchdog/config.json`; default state/logs are `${XDG_STATE_HOME:-$HOME/.local/state}/endpoint-monitor-watchdog`. An unset XDG variable uses the fallback. Cron and interactive runs must use the same paths. Override with `-c/--config` and `-s/--state-dir` when needed. `check` reads the endpoint without writing state/logs or sending email; `run` advances persisted state and can notify; `report` reads private state without reading configuration. Both `-h` and `--help` describe usage and exit statuses.

Exit status is `0` for a healthy/skipped observation or successful report, `1` for unhealthy/runtime/delivery/report failure, `2` for configuration/usage errors, and `3` for an unsupported platform. A first failing sample returns `1` before the notification threshold is met. Cron suppresses console output because the rotating `watchdog.jsonl` is the diagnostic source; `state.json.lastCheckAt` establishes that the process actually ran. A storage/permission failure that prevents writing logs may only be visible through missing heartbeats, host diagnostics, or an interactive run.

## Verification and recovery

Run `python3 -B -m unittest discover -s watchdog -p 'test_*.py'` from the project root, or `npm run test:watchdog`. The tests cover stale/malformed evidence, redirects without bearer forwarding, bounded responses, notification retry and recovery ordering, overlapping execution, filesystem permissions, and CLI behavior.

For an installation drill, copy the private configuration, prefix its label with `DRILL`, and use a separate private state directory. Point the drill URL at `https://unreachable.example.invalid/api/status` for two observations at least 45 seconds apart. Verify the `PROBLEM` email in the inbox. Restore the real URL in the drill configuration and continue minute-spaced healthy checks for at least five minutes. Verify `RECOVERY`, then remove only the drill files. This exercises a real DNS failure and real mail submission without stopping production monitoring. Also verify scheduled `lastCheckAt` advances and a healthy heartbeat arrives through the real cron entry.

Inspect fixed `reason`, `errorCode`, `errorType`, and `smtpCode` fields in the rotating log. `check-completed.observation` contains sanitized run and HTTP evidence; `sampleGapSeconds` and `sampleGapExceeded` describe observer sampling, while `check-skipped` records the minimum-spacing guard. `status-credential-invalid` means the local token file needs attention; `http-401` means the Worker rejected it. `run-stale` means there is no fresh completed run, and `monitor-phase-error` or `monitor-delivery-error` identifies reported primary-monitor failures. `notification-failed` retains its event for retry. Keep the state file during troubleshooting; deleting it discards deduplication and incident context. Preserve a corrupt state file before deliberate recovery, then rerun a drill.

Rotate the Gmail app password by replacing its private file atomically and checking inbox delivery. Rotate the status credential on both the Worker and observer, then run `check`; brief authorization failures are visible during rotation. Back up the source, nonsecret configuration, and operational instructions through the operator's private recovery process. Credentials can be regenerated. Removing the single cron entry disables the observer without changing the primary monitor.

The observer runs outside Workers, but its minute-by-minute status requests add Worker CPU and D1 reads. The existing deployment's [Free-plan limitations and Paid requirement](../docs/cloudflare.md#execution-ceilings-and-free-compatibility) still apply. A small external script does not establish that the status handler fits the Workers Free CPU limit; measure the complete deployed configuration before claiming Free support.

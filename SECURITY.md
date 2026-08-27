# Security policy

## Supported versions

Security fixes are provided for the latest tagged release. Pre-release source and older tags may receive a fix only when the same change is required for the latest release.

## Reporting a vulnerability

Use GitHub private vulnerability reporting for this repository. Do not open a public issue containing a credential, private target, Hookrelay route, Worker secret, D1 contents, or exploitable request sequence.

Include the affected version or commit, impact, reproduction steps using synthetic data, and any suggested mitigation. Remove secrets and private URLs from logs and screenshots before attaching them.

## Security boundary

Configuration is trusted operator input, but target URLs are still constrained to public DNS hostnames and reject credentials, fragments, loopback, literal IP, reserved local suffix, and single-label destinations. The Cloudflare example also enables `global_fetch_strictly_public`.

The protected status response contains target URLs and incident details. Keep it disabled unless a strong bearer secret is installed. `/healthz` intentionally reveals only service identity and liveness.

Hookrelay delivery signs the exact persisted CloudEvent body with a per-subscription HMAC. The URL and HMAC are Worker secrets, never generated configuration variables. Diagnostics use fixed errors and exclude raw remote response bodies and exception messages.

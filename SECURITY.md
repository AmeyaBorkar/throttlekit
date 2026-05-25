# Security Policy

## Supported versions

ThrottleKit is pre-1.0; fixes land on the latest published minor.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅        |
| < 0.1   | ❌        |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's coordinated disclosure: on the
[repository](https://github.com/AmeyaBorkar/throttlekit), open the **Security** tab and choose
**“Report a vulnerability”** (GitHub Private Vulnerability Reporting). This opens a private advisory
visible only to the maintainers.

Please include:

- the affected version and environment (Node version, store: memory/Redis/Upstash, adapter),
- a minimal reproduction or proof of concept,
- the impact you observed, and
- any suggested remediation.

### What to expect

- **Acknowledgement** within 72 hours.
- An initial assessment and severity rating shortly after.
- A fix and a published advisory once a patch is available; we credit reporters who wish to be named.

## Scope notes

ThrottleKit is a library, not a hosted service. Threats most relevant to it:

- **Key spoofing.** The default key derivation resolves client IPs through an explicit
  trusted-proxy policy (`trustProxy`) and ignores untrusted `X-Forwarded-For` hops. Misconfiguring
  `trustProxy` (e.g. trusting all proxies behind an untrusted edge) can let clients spoof their key —
  configure it to your actual proxy topology. See the README “Trusted proxy & IPv6 aggregation”.
- **Fail mode.** On a store outage the adapters fail **open** by default (allow). For hard quotas
  set `fail: "closed"`. See the README “Resilience”.
- **PII in keys.** If you key on user identifiers, consider `hmacKeyer` to avoid storing raw PII.

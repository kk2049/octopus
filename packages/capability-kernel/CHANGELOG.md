# Changelog

All notable changes to this package are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## Unreleased

- The durable audit trail no longer records unattended, allowed and successful
  `observe`/`read` calls; the `audit` sink still receives them.
- `CapabilityService.pruneAudit(before, limit)` trims the audit trail one
  bounded page at a time (expired rows, and routine reads an earlier version
  recorded).
- Destroyed Contexts are collected after one hour by default instead of a day.

## 0.1.0 - 2026-08-15

- Initial public-package shape for attenuating capabilities, complete
  mediation, durable approvals, recovery, auditing, and SQLite persistence.

---
paths:
  - "**/*.{ts,tsx,mts,cts}"
  - "**/tsconfig*.json"
  - "**/vitest.config.*"
---

# TypeScript and tests

- The repository is ESM. Use `import`, not `require()`.
- When `import.meta.dirname` is unavailable, derive the directory with
  `fileURLToPath(import.meta.url)` and `path.dirname`.
- `@anthropic-ai/claude-agent-sdk` option `env` replaces rather than extends
  `process.env`; spread `process.env` before overrides.
- Put focused Vitest tests beside pure functions, transformations, stores, and
  other behavior that can run without an external service.
- Prefer the narrow test command documented by the nearest package. Use
  `--maxWorkers=1` on this host unless that package proves a different budget.
- New dependencies require checking the lockfile, existing repository usage,
  official API/types, maintenance, compatibility, security, license, bundle,
  runtime, and operational cost first.

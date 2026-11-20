@AGENTS.md

# Claude Code

- Project rules under `.claude/rules/` are path-scoped and load only when a
  matching file is read. Do not remove their `paths` frontmatter.
- Use `doc/README.md` to enter architecture, runbooks, deliveries, and current
  limitations on demand. Do not expand those documents into this file with
  additional `@` imports.
- Use `/context` to verify which instruction files actually loaded.
- Run `pnpm docs:check` after changing agent instructions.

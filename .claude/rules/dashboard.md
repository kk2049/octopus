---
paths:
  - "packages/dashboard-web/**/*"
  - "packages/bot/src/dashboard/**/*"
---

# Dashboard

- Browser code lives in `packages/dashboard-web`; do not reintroduce
  server-built HTML, CSS, scripts, or inline executable code.
- The server is the only authorization authority. Navigation is availability
  metadata, not permission; every request still passes the route/Cedar gate.
- Do not automatically retry, poll or refetch capability-bearing GET endpoints
  (`/api/session`, `/api/sessions`, `/api/sessions/search`,
  `/api/sessions/live`). A denial may create an approval request, so replay
  must be explicit. No Dashboard page reads them (`lib/query.test.ts`).
- Ordinary server-local GETs use the `lib/query.ts` defaults: two retries for
  network/5xx failures, focus/reconnect refetch only after the 60 s stale
  window, no refetch on mount. Egress is billed: add interval polling only
  through `pollInterval()` for a listed endpoint, never as a default.
- Untrusted content is never raw HTML. Use the shared Markdown renderer without
  `dangerouslySetInnerHTML` or `rehype-raw`.
- Server routes must be registered in Fastify and declared in `authz.ts` with
  the same route id. Unknown or half-declared routes fail closed.
- Keep authorization in `onRequest`, before body parsing. All stream refusals
  happen before `reply.hijack()`.
- Use the existing handler wrappers that return `reply`; an async handler must
  not resolve `undefined` after calling `reply.send()`.
- Do not enable `trustProxy`, CORS, session/cookie, or rate-limit plugins without
  first resolving the documented trust-model objections in the HTTP ADR.
- Read `doc/adr/0003-dashboard-react-frontend.md` or
  `doc/adr/0004-dashboard-fastify-transport.md` for the side being changed.

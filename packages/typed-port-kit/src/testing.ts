/**
 * `@claude-bot/typed-port-kit/testing` — the conformance harness and a transport
 * that lies.
 *
 * A separate entry rather than part of the package root, for the reason the
 * workspace-files memory port states: tests are not the only consumer that needs
 * these (a storybook, a demo App and a second read-only product would all wire
 * them the same way), but a production bundle must not pick them up by reaching
 * for the obvious import.
 *
 * Nothing here imports a test framework. `runPortConformance` returns findings
 * and `assertConformant` throws one error containing all of them, so the same
 * harness works from vitest, from a script, or from a conformance report.
 */

export {
  answers,
  assertConformant,
  refuses,
  runPortConformance,
  scriptedTransport,
  type ConformanceFinding,
  type PortConformanceOptions,
  type ScriptedAnswer,
  type ScriptedTransport,
  type TransportScript,
} from "./conformance.js";

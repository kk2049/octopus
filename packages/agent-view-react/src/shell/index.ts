/**
 * `@claude-bot/agent-view-react/shell` — the standard composition root.
 *
 * One component. It takes the three release documents an App already ships as
 * data, a module list, and a table of port adapters, and assembles the whole
 * browser half: registry, plan, providers, `WorkspaceShell`, default chrome and
 * the status line. A simple App's root becomes a data file plus one element.
 *
 * It is a SEPARATE entry from the package root because it is the one part of
 * this SDK that touches the transport AND the layout kernel at once — an App
 * that composes its own root imports the two narrow entries instead, and a View
 * module may import neither. Keeping the assembly here rather than in the root
 * means "which entry did this file need" stays a readable answer.
 */

export {
  StandardApp,
  type AppTransport,
  type PortAdapter,
  type PortAdapterFactory,
  type StandardAppProps,
} from "./StandardApp.js";

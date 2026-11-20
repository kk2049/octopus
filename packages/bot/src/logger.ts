/**
 * Logging utility using pino.
 */

import pino from "pino";

const level = process.env.LOG_LEVEL ?? "info";
const isDev = process.env.NODE_ENV !== "production";

const transport = isDev
  ? pino.transport({ target: "pino-pretty", options: { colorize: true } })
  : undefined;

const rootLogger = pino({ level }, transport);

export function createLogger(name: string): pino.Logger {
  return rootLogger.child({ module: name });
}

export { rootLogger as logger };

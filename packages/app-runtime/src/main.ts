import { serveChildRpc } from "@claude-bot/child-rpc";
import { AppRuntimeError, AppRuntimeService } from "./service.js";
import type { InvokeRequest, ProjectRequest } from "./types.js";

const appDir = process.argv[2];
if (!appDir) throw new Error("app-runtime requires an app directory argument");
const service = new AppRuntimeService(appDir, {
  onDiagnostic: (line) => process.stderr.write(`${line}\n`),
});

serveChildRpc({
  handle(method, params) {
    switch (method) {
      case "invoke": return service.invoke(params as InvokeRequest);
      case "project": return service.project(params as ProjectRequest);
      case "health": return service.health();
      default: throw new AppRuntimeError(`unknown runtime RPC method: ${method}`, "unknown_method");
    }
  },
  close: () => service.stop(),
  maxConcurrent: 16,
});

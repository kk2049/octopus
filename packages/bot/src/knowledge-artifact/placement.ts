import type { SelfHostingConfig } from "../config.js";

/** Trusted configuration resolves once; offline targets never trigger replacement placement. */
export function knowledgeIndexRunnerTarget(config: Pick<SelfHostingConfig, "ci_machine" | "knowledge_index">) {
  if (config.knowledge_index?.enabled === false) return null;
  const target = config.knowledge_index?.runner ?? config.ci_machine;
  return target ? { owner: target.owner, device: target.device, checkout_dir: target.checkout_dir } : null;
}

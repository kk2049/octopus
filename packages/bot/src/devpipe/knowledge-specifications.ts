import { checkSpecifications } from "../knowledge/specifications.js";
import { verifyEvidenceEvent } from "../knowledge/evidence-verification.js";
import type { LandingKnowledge } from "../store/repositories/knowledge.js";
import type { Store } from "../store/store.js";
import { originalEvidenceSource } from "./knowledge-evidence.js";
import { gitOrThrow } from "./worktree.js";

/** Same exact-candidate check for ticket and CLI: optional specifications, real files, unforged human evidence. */
export async function verifyLandingSpecifications(input: {
  repoDir: string; to: string;
  knowledge: Pick<LandingKnowledge, "specifications">; store: Store; owner?: string;
}): Promise<void> {
  if (!input.knowledge.specifications?.length) return;
  const tree = await gitOrThrow(input.repoDir, ["ls-tree", "-r", input.to]);
  const files = new Set(tree.split("\n").flatMap((line) => /^(100644|100755) blob [a-f0-9]+\t(.+)$/u.exec(line)?.[2] ?? []));
  const specs = checkSpecifications(input.knowledge, files);
  for (const spec of specs) {
    for (const event of spec.provenance.events) {
      const error = verifyEvidenceEvent(event, originalEvidenceSource(input.store, event, input.owner));
      if (error) throw new Error(`${spec.statement}: ${error} (${event.ref})`);
    }
  }
}

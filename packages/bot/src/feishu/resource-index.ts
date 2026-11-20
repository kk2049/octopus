import { createHash } from "node:crypto";
import { parseResourceUri } from "../authorization/namespace.js";
import type { AuthorizationService } from "../authorization/service.js";
import type { FeishuReferenceKind } from "./catalog.js";

const FEISHU_DOMAIN_ID = "domain:feishu:tenant";
const FEISHU_RESOURCE_OWNER = "system:feishu-tenant";

function allowedKinds(
  expected: FeishuReferenceKind | readonly FeishuReferenceKind[],
): readonly FeishuReferenceKind[] {
  return typeof expected === "string" ? [expected] : expected;
}

/**
 * Bridges typed Feishu references into the canonical authorization namespace.
 *
 * Unknown exact references are indexed on first use under the tenant system
 * domain. Existing canonical resources and aliases resolve first, so an alias
 * is rewritten before the capability kernel hashes arguments for approval.
 * The index does not grant a Feishu operation; the Feishu capability Object and
 * its owner approval remain the execution authority.
 */
export class FeishuAuthorizationResourceIndex {
  constructor(private readonly authorization: AuthorizationService) {
    this.authorization.upsertDomain({
      id: FEISHU_DOMAIN_ID,
      kind: "shared",
      title: "Feishu tenant resources",
      authority: { kind: "organization", id: "feishu-tenant" },
      historyPolicy: "all",
    });
  }

  canonicalize(
    value: string,
    expected: FeishuReferenceKind | readonly FeishuReferenceKind[],
  ): string {
    const parsed = parseResourceUri(value, "Feishu resource reference");
    const kinds = allowedKinds(expected);
    if (
      parsed.scheme !== "feishu"
      || !kinds.includes(parsed.authority as FeishuReferenceKind)
      || parsed.segments.length !== 1
    ) {
      throw new Error(
        `Feishu resource reference must be ${kinds.map((kind) => `feishu://${kind}/<id>`).join(" or ")}`,
      );
    }

    let resource = this.authorization.getResource(parsed.uri);
    if (!resource) {
      const digest = createHash("sha256").update(parsed.uri).digest("hex");
      resource = this.authorization.upsertResource({
        id: `resource:feishu:${digest}`,
        uri: parsed.uri,
        owner: FEISHU_RESOURCE_OWNER,
        domainId: FEISHU_DOMAIN_ID,
        kind: parsed.authority === "people" ? "feishu-person" : "feishu-chat",
        title: parsed.uri,
        sensitivity: "sensitive",
        externalRef: { system: "feishu-index", id: digest },
      });
    }

    const canonical = parseResourceUri(resource.uri, "canonical Feishu resource reference");
    if (
      canonical.scheme !== "feishu"
      || !kinds.includes(canonical.authority as FeishuReferenceKind)
      || canonical.segments.length !== 1
    ) {
      throw new Error("Feishu resource alias resolves to the wrong resource kind");
    }
    return canonical.uri;
  }

  get owner(): string {
    return FEISHU_RESOURCE_OWNER;
  }
}

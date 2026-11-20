/** Reproducible release evidence for the Session Plus App, as the page shows it. */

import type { AppReleaseDescriptor } from "@claude-bot/app-registry";
import { SESSION_RESOURCE_OPERATIONS } from "../session-resource/catalog.js";
import { sessionPlusContractFor } from "../session-resource/contract.js";
import { sessionPlusIdentity, type SessionPlusIdentity } from "./identity.js";

export interface SessionPlusReleaseRecord
  extends Omit<SessionPlusIdentity, "source" | "sourceSnapshotDigest" | "contract"> {
  schemaVersion: 1;
  sourceSnapshot: SessionPlusIdentity["source"] & {
    files: Array<{ path: string; sha256: string; bytes: number; href: string }>;
  };
  disclosures: Array<{ id: string; title: string; operations: string[] }>;
  attestation: NonNullable<ReleaseRecordInput["attestation"]>;
}

const DISCLOSURE_TITLES: Readonly<Record<string, string>> = Object.freeze({
  "session-metadata": "会话元数据：标题、设备、时间和消息数量",
  "workspace-labels": "工作区标签与显示路径（不含规范绝对路径）",
  "session-content": "会话正文与搜索命中片段（可能包含工具输入输出）",
  "crdt-document-content": "协作文档的标题、正文与其他成员的后续改动",
});

export interface ReleaseRecordInput {
  identity: SessionPlusIdentity;
  descriptor: AppReleaseDescriptor;
  /** How this deployment came to hold the artifact. Not a property of the bytes. */
  attestation?: { builder: string; builtAt: string; statement: string };
}

/**
 * The consent page's whole evidence payload for one release.
 *
 * Built from the DESCRIPTOR the registry validated, not from the source tree:
 * the running release may have been installed from elsewhere, and a record that
 * quietly described this checkout instead would be evidence about the wrong
 * thing. The identity is cross-checked against it for the same reason.
 */
export function sessionPlusReleaseRecord(input: ReleaseRecordInput): SessionPlusReleaseRecord {
  const { identity, descriptor } = input;
  if (
    identity.packageDigest !== descriptor.packageDigest
    || identity.permissionContractDigest !== descriptor.permissionContractDigest
    || identity.stableAppId !== descriptor.stableAppId
    || identity.publisher !== descriptor.publisher
  ) {
    throw new Error("ReleaseRecord identity does not match its descriptor");
  }
  const files = descriptor.assets.map((asset) => ({
    path: asset.name,
    sha256: asset.sha256,
    bytes: asset.bytes,
    href: `/api/session-plus/release?source=${encodeURIComponent(asset.name)}`,
  }));
  /**
   * What THIS release's ask discloses — narrowed to its own contract.
   *
   * The catalog is the union of every operation any implemented contract may
   * declare, and reading it whole would describe a release by what the build is
   * capable of rather than by what the release requests. That was invisible
   * while the widest contract and the union happened to be the same list; it
   * stopped being invisible the moment a contract existed that some releases do
   * not ask for. An unknown digest discloses nothing, which is the same
   * fail-closed answer every other consumer of that lookup gives.
   */
  const declared = new Set(
    sessionPlusContractFor(identity.publisher, identity.permissionContractDigest)?.contract.operations ?? [],
  );
  const disclosureOperations = new Map<string, string[]>();
  for (const operation of SESSION_RESOURCE_OPERATIONS) {
    if (!operation.disclosure || !declared.has(operation.id)) continue;
    const list = disclosureOperations.get(operation.disclosure) ?? [];
    list.push(operation.id);
    disclosureOperations.set(operation.disclosure, list);
  }
  return {
    schemaVersion: 1,
    stableAppId: identity.stableAppId,
    publisher: identity.publisher,
    executionProfile: "publisher-js",
    packageDigest: identity.packageDigest,
    packageHostLabel: identity.packageHostLabel,
    viewAssetDigest: identity.viewAssetDigest,
    backendCodeDigest: identity.backendCodeDigest,
    permissionContractDigest: identity.permissionContractDigest,
    recipeDigest: identity.recipeDigest,
    sourceSnapshot: { ...descriptor.source, files },
    buildInput: descriptor.buildInput,
    disclosures: [...disclosureOperations].map(([id, operations]) => ({
      id,
      title: DISCLOSURE_TITLES[id] ?? id,
      operations,
    })),
    attestation: input.attestation ?? {
      builder: "octopus:first-party",
      builtAt: new Date().toISOString(),
      statement:
        "平台从这里列出的不可变源码快照与构建输入生成并见证当前产物；本 canary 尚未附加第三方签名。",
    },
  };
}

/** The record for the package THIS CHECKOUT would publish. Used by tests and the packer. */
export function checkoutReleaseRecord(
  descriptor: AppReleaseDescriptor,
  identity: SessionPlusIdentity = sessionPlusIdentity(),
): SessionPlusReleaseRecord {
  return sessionPlusReleaseRecord({ identity, descriptor });
}

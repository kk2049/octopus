/**
 * B5: which seats a share-link visitor may take, decided on the in-repo Apps'
 * real manifests. A share link is the bare instance key, so the role cannot be
 * the visitor's choice: they may take the least-privileged member role or a
 * role with no more privilege than it, and nothing else.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSessionPlusManifest } from "../app-core/manifest.js";
import { sharedJoinPolicy } from "./app-instance.js";

const packages = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const policyOf = (pkg: string, appId: string) =>
  sharedJoinPolicy(loadSessionPlusManifest(path.join(packages, pkg, "app"), { appId }));

describe("self-service seating on the in-repo shared Apps", () => {
  it("never lets a visitor seat themselves as the Expense Intake approver", () => {
    expect(policyOf("expense-intake-view", "expense-intake")).toEqual({
      defaultRole: "submitter",
      joinable: ["submitter"],
    });
  });

  it("lets a chess visitor play black or watch, but not take white's setup powers", () => {
    expect(policyOf("chess-view", "chess")).toEqual({ defaultRole: "black", joinable: ["black", "watcher"] });
  });

  it("keeps research members and viewers joinable and the project owner creator-assigned", () => {
    expect(policyOf("research-program-view", "research-program")).toEqual({
      defaultRole: "member",
      joinable: ["member", "viewer"],
    });
    const canvas = policyOf("research-canvas-view", "research-v2");
    expect(canvas.joinable).not.toContain("owner");
    expect(canvas.joinable).toEqual(expect.arrayContaining(["editor", "researcher", "viewer"]));
  });

  it("treats roles the platform door cannot tell apart as equivalent peers", () => {
    // Coordinator and member drive exactly the same action, and the App's own
    // handler treats them the same; neither is a privilege over the other.
    expect(policyOf("meeting-room-view", "meeting-room")).toEqual({
      defaultRole: "member",
      joinable: ["coordinator", "member"],
    });
    expect(policyOf("report-space-view", "report-space")).toEqual({
      defaultRole: "member",
      joinable: ["member", "observer"],
    });
  });
});

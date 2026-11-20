import { describe, expect, it } from "vitest";
import {
  describeRelease,
  utf8Bytes,
  type AppReleaseDescriptor,
  type ReleaseSpec,
} from "@claude-bot/app-registry";
import type { SessionPlusManifest } from "../app-core/manifest.js";
import {
  DECLARED_COEXISTENCE_REASONS,
  declaredReleaseCoexistence,
} from "./declared-adapter.js";

function descriptor(): AppReleaseDescriptor {
  const assets = [{ name: "app.yaml", content: utf8Bytes("schema: 2") }];
  const spec: ReleaseSpec = {
    stableAppId: "demo-notes",
    publisher: "demo:coexistence",
    executionProfile: "publisher-js",
    permissionContractDigest: "c".repeat(64),
    assets,
    composition: { view: ["app.yaml"], backend: [] },
    source: {
      kind: "platform-hosted",
      digest: "sha256:coexistence",
      repository: "platform://coexistence-test",
      commit: "a".repeat(40),
      subdir: "packages/demo-notes",
    },
    buildInput: {
      entry: "app.yaml",
      toolchain: { builder: "coexistence-test", format: "named-assets", lockfile: "pnpm-lock.yaml" },
      lockfileHash: "d".repeat(64),
    },
  };
  return describeRelease(spec);
}

function manifest(): SessionPlusManifest {
  return {
    id: "demo-notes",
    schema: 2,
    stateScope: "account",
    stateEpoch: 4,
    stateEpochDeclared: true,
    roles: {},
    actions: {},
    agents: {},
    pageFile: "pages/main.yaml",
  };
}

describe("declared release coexistence C1-C5", () => {
  it("allows releases that share the complete state-safety contract", () => {
    const previous = { descriptor: descriptor(), manifest: manifest() };
    const candidate = {
      descriptor: { ...descriptor(), packageDigest: "f".repeat(64) },
      manifest: { ...manifest() },
    };
    expect(declaredReleaseCoexistence(previous, candidate)).toEqual({ coexist: true });
  });

  it.each([
    ["previous", false, true],
    ["candidate", true, false],
    ["both", false, false],
  ])("requires an explicit state_epoch on %s release(s)", (_side, previousDeclared, candidateDeclared) => {
    const previous = {
      descriptor: descriptor(),
      manifest: { ...manifest(), stateEpochDeclared: previousDeclared },
    };
    const candidate = {
      descriptor: { ...descriptor(), packageDigest: "f".repeat(64) },
      manifest: { ...manifest(), stateEpochDeclared: candidateDeclared },
    };
    expect(declaredReleaseCoexistence(previous, candidate)).toEqual({
      coexist: false,
      reason: DECLARED_COEXISTENCE_REASONS.stateEpochUndeclared,
    });
  });

  it.each([
    {
      criterion: "C1 permission contract",
      reason: DECLARED_COEXISTENCE_REASONS.permissionContract,
      change: (row: { descriptor: AppReleaseDescriptor; manifest: SessionPlusManifest }) => ({
        ...row,
        descriptor: { ...row.descriptor, permissionContractDigest: "e".repeat(64) },
      }),
    },
    {
      criterion: "C2 manifest schema",
      reason: DECLARED_COEXISTENCE_REASONS.manifestSchema,
      change: (row: { descriptor: AppReleaseDescriptor; manifest: SessionPlusManifest }) => ({
        ...row,
        manifest: { ...row.manifest, schema: 3 as const },
      }),
    },
    {
      criterion: "C3 state scope",
      reason: DECLARED_COEXISTENCE_REASONS.stateScope,
      change: (row: { descriptor: AppReleaseDescriptor; manifest: SessionPlusManifest }) => ({
        ...row,
        manifest: { ...row.manifest, stateScope: "shared" as const },
      }),
    },
    {
      criterion: "C4 state epoch",
      reason: DECLARED_COEXISTENCE_REASONS.stateEpoch,
      change: (row: { descriptor: AppReleaseDescriptor; manifest: SessionPlusManifest }) => ({
        ...row,
        manifest: { ...row.manifest, stateEpoch: row.manifest.stateEpoch + 1 },
      }),
    },
    {
      criterion: "C5 execution profile",
      reason: DECLARED_COEXISTENCE_REASONS.executionProfile,
      change: (row: { descriptor: AppReleaseDescriptor; manifest: SessionPlusManifest }) => ({
        ...row,
        descriptor: { ...row.descriptor, executionProfile: "declarative" as const },
      }),
    },
  ])("rejects $criterion with its exact reason", ({ reason, change }) => {
    const previous = { descriptor: descriptor(), manifest: manifest() };
    expect(declaredReleaseCoexistence(previous, change(previous))).toEqual({ coexist: false, reason });
  });
});
